# NUMA Architecture

> **Why a quant dev must own this:** On a modern dual-socket server, *where* your
> memory lives relative to the core touching it changes its latency by ~1.5-2x —
> a remote DRAM access can cost ~150ns instead of ~100ns, plus interconnect
> contention. In HFT the hot thread that parses the NIC's packets must run on a
> core that is local both to that NIC and to the memory it touches; get the
> placement wrong and you've added tens of nanoseconds of jitter to every
> message for free. NUMA-aware thread pinning and memory allocation is standard
> practice in production trading systems — and a frequent senior interview topic.

## SMP vs NUMA: the shift that made placement matter

**SMP (Symmetric Multiprocessing):** every CPU reaches all of memory through one
shared bus/memory controller, so every access has the *same* latency — memory is
"uniform." Simple, but the single path becomes a bottleneck as you add cores.

**NUMA (Non-Uniform Memory Access):** memory is partitioned and physically
attached to specific CPUs. Each **node** (typically one socket) has its own
integrated memory controller and a bank of local DRAM. A core reaches **local**
memory directly and **remote** memory (attached to another node) across a
**socket interconnect** — Intel **UPI** (formerly QPI) or AMD **Infinity
Fabric**. Local is fast; remote is slower and shares interconnect bandwidth.

```text
      Socket 0 (NUMA node 0)                Socket 1 (NUMA node 1)
   ┌───────────────────────┐   UPI/IF    ┌───────────────────────┐
   │  cores 0..N           │<===========>│  cores N+1..M         │
   │  L3                   │ interconnect│  L3                   │
   │  Mem controller ──┐   │             │  Mem controller ──┐   │
   └───────────────────┼───┘             └───────────────────┼───┘
                  Local DRAM (node 0)               Local DRAM (node 1)

   core 0 -> node 0 DRAM : LOCAL  (~100 ns approx)
   core 0 -> node 1 DRAM : REMOTE (~1.5-2x local, + interconnect contention)
```

Why NUMA exists: integrating the memory controller onto each CPU and giving each
its own DRAM scales aggregate bandwidth with socket count, instead of choking on
one shared bus. The cost is non-uniform latency you now have to *manage*.

Modern wrinkles: a single large die can expose **multiple NUMA nodes per socket**
(AMD's CCD/CCX layout, Intel's sub-NUMA clustering / SNC), so "node" ≠ "socket" in
general. Always inspect the actual topology rather than assuming.

## The NUMA distance matrix

The kernel models relative access cost with a **distance matrix** (from the ACPI
SLIT table). By convention local is `10`; a remote node is reported relative to
that (`21` ≈ ~2.1x). `numactl --hardware` shows it:

```text
$ numactl --hardware
available: 2 nodes (0-1)
node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
node 0 size: 64323 MB
node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
node 1 size: 64509 MB
node distances:
node   0   1
  0:  10  21      <- local=10, remote=21 (~2.1x cost)
  1:  21  10
```

This is the first command you run on any new server. It tells you which logical
CPUs belong to which node and how far apart the nodes are — the raw material for
every pinning and allocation decision.

## First-touch allocation: the policy that surprises everyone

Here's the rule that trips up most engineers: on Linux the default policy is
**first-touch**. `malloc`/`mmap` reserves virtual address space but allocates
*no physical pages*. A physical page is bound to a NUMA node only when it is
**first written**, and it's placed on the node of **the core that does that first
write** — not the core that allocated it.

```cpp
// CLASSIC NUMA BUG: thread 0 (on node 0) allocates AND initializes the whole
// buffer, so every page lands on node 0. Worker threads on node 1 then make
// remote accesses for their entire half of the data.
std::vector<double> buf(N);                 // no pages yet
for (std::size_t i = 0; i < N; ++i) buf[i] = 0.0;   // first-touch: ALL on node 0
// ... later, threads pinned to node 1 hammer buf[N/2 .. N] -> all remote.

// FIX: let each worker first-touch its own region, after being pinned.
// Then page p lands on the node of the thread that will use it.
#pragma omp parallel for schedule(static)
for (std::size_t i = 0; i < N; ++i) buf[i] = 0.0;   // parallel-init = local init
```

The takeaway: **initialize data on the thread (and thus node) that will own it,
after that thread is pinned.** "Allocate then memset on the main thread" silently
co-locates everything on one node. This single mistake is responsible for a large
fraction of "why is my NUMA box slow?" questions.

## Controlling placement: from coarse to fine

### `numactl` / `taskset` (no code changes)

```text
# Run on node 0's CPUs, allocate memory only on node 0 (local everywhere):
numactl --cpunodebind=0 --membind=0 ./trader

# Pin to specific CPUs without touching memory policy:
taskset -c 0-7 ./trader

# Interleave pages round-robin across nodes (good for one big shared dataset
# that all nodes touch equally; trades worst-case local for balanced average):
numactl --interleave=all ./bulk_job
```

`--membind` *forces* allocation onto the named node(s) (fails/OOMs rather than
spilling remote); `--preferred` prefers a node but falls back. Interleaving is
the right call for a large dataset accessed uniformly by all nodes; local binding
is right for the partitioned, latency-sensitive case.

### libnuma — programmatic allocation

```cpp
#include <numa.h>     // link with -lnuma
#include <numaif.h>

// Allocate a buffer whose pages live on a specific node.
void* allocate_on_node(std::size_t bytes, int node) {
    if (numa_available() < 0) return nullptr;     // NUMA not present
    void* p = numa_alloc_onnode(bytes, node);     // pages bound to 'node'
    // ... use p ...
    return p;   // free later with numa_free(p, bytes)
}

// Or set a policy region with mbind(2) directly:
#include <sys/mman.h>
void bind_region(void* addr, std::size_t len, int node) {
    unsigned long nodemask = 1UL << node;
    mbind(addr, len, MPOL_BIND, &nodemask, sizeof(nodemask) * 8, MPOL_MF_MOVE);
}
```

`set_mempolicy(2)` sets a default policy for *subsequent* allocations of the
current thread; `mbind(2)` applies a policy to an existing address range (and with
`MPOL_MF_MOVE` can **migrate** already-populated pages to the target node).

### CPU pinning — the other half

Local *allocation* only pays off if the *thread* stays on the local node. Without
pinning, the scheduler may migrate your thread to another socket and turn all its
local memory into remote memory. Pin it:

```cpp
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>

// Pin the calling thread to a single logical CPU (e.g. core 2 on node 0).
int pin_to_cpu(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    return pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
    // process-wide alternative: sched_setaffinity(0, sizeof(set), &set);
}
```

For the lowest jitter, HFT systems go further: **isolate** the core from the
scheduler entirely (kernel `isolcpus=`, `nohz_full=`, `irqaffinity` to steer
interrupts away, plus `taskset`/affinity to place the hot thread), so nothing
else ever runs there. The hot thread then owns its core *and* its local memory
with no migration and no preemption.

## Putting it together: the HFT placement recipe

The whole point in trading: keep the latency-critical path **local end to end**.

1. **Find where the NIC is.** A PCIe NIC is attached to one socket's PCIe lanes,
   so its DMA'd packets land in *that node's* memory. Read its NUMA node:
   `cat /sys/class/net/eth0/device/numa_node`.
2. **Pin the feed-handler / hot thread to a core on that same node** (and
   isolate it).
3. **Allocate its buffers (order book, parse buffers, ring) on that node**
   (`numa_alloc_onnode` / `--membind`), and **first-touch them from that thread**.
4. **Steer the NIC's interrupts / RX queues to cores on that node** (`irqbalance`
   off, manual `smp_affinity`), so packet processing never crosses the
   interconnect.

The result: packet → NIC → local DRAM → local core → local order book, with the
UPI/Infinity-Fabric hop nowhere on the critical path. Crossing the interconnect
even once per message adds latency *and* jitter (interconnect contention is
variable), and tail latency is what kills you.

> **Interview gold:** "Pin the hot thread to a core on the NUMA node nearest the
> NIC, allocate and first-touch its memory on that node, and steer the NIC's
> interrupts there too — so nothing on the critical path crosses UPI." That one
> sentence demonstrates you understand NUMA *in the context that matters*.

## Huge pages + NUMA

Huge pages (see the cache lesson) and NUMA interact. A 2 MB or 1 GB page is bound
to a *single* node — you cannot split one huge page across nodes — so huge-page
placement is even more sensitive to first-touch. Pre-fault your huge-page pool
*on the owning thread/node* at startup (`numa_alloc_onnode` + touch, or
`mmap(MAP_HUGETLB)` then first-touch local). Done right you get both the TLB win
*and* locality; done carelessly you can pin a big remote huge page on the hot
path. `--membind` plus a local first-touch covers it.

## Page migration and AutoNUMA

Linux **AutoNUMA** (`/proc/sys/kernel/numa_balancing`) tries to *automatically*
migrate pages toward the nodes accessing them, sampling faults over time. It
helps general workloads but is the *wrong* tool for HFT: the sampling and
migration add unpredictable background jitter and the convergence is too slow to
trust on a latency-critical path. Production trading boxes typically **disable
numa_balancing** and place everything explicitly. Knowing to turn it *off* (and
why) is itself a signal of NUMA maturity.

## Measuring NUMA behavior

```text
# Per-node hit/miss counters: are you taking remote (numa_miss) hits?
numastat                 # system-wide
numastat -p <pid>        # per-process: numa_hit vs numa_miss vs numa_foreign

# Visualize the full topology (sockets, nodes, caches, cores, PCIe/NIC):
lstopo            # from hwloc; lstopo-no-graphics for text

# perf: count remote vs local memory accesses (event names vary by uarch)
perf stat -e node-loads,node-load-misses ./trader
perf c2c record / report   # cross-node cache-line contention
```

`numastat -p` is the go-to: a high `numa_miss` / `numa_foreign` count means your
process is hitting remote memory and you have a placement bug. `lstopo` gives you
the picture — including which node the NIC hangs off, which is exactly what you
need for the recipe above.

## Performance & hardware reality (approx)

| Access | Approx latency | Notes |
|---|---|---|
| Local DRAM | ~100 ns (~200-300 cycles) | the target for the hot path |
| Remote DRAM (1 hop) | ~1.5-2x local | + variable interconnect contention |
| Interconnect (UPI/IF) bandwidth | shared, finite | remote-heavy workloads can saturate it |
| Local vs remote distance (SLIT) | `10` vs `~21` | relative cost, not nanoseconds |
| Page migration | expensive + jittery | AutoNUMA does this in the background |

(All approximate and platform-dependent; measure on the production server — node
count, distances, and per-socket node count vary widely.)

## Quant/HFT relevance & interview gotchas

- **The recipe is the answer:** hot thread pinned (and isolated) to a core on the
  NIC's NUMA node + local allocation + local first-touch + NIC interrupts steered
  to that node. Crossing UPI on the critical path = avoidable latency *and*
  jitter.
- **First-touch is the #1 NUMA bug.** "Allocate and `memset` on the main thread,
  then hand regions to worker threads" silently puts everything on one node.
  Initialize on the owning, pinned thread.
- **Allocation locality without pinning is useless** — the scheduler will migrate
  the thread and make its memory remote. Pin *and* allocate locally; they're a
  pair.
- **Bind vs interleave:** partitioned latency-sensitive data → `--membind` local;
  one big dataset hit uniformly by all nodes → `--interleave` for balanced
  bandwidth. Know when each applies.
- **Turn AutoNUMA *off*** for deterministic latency; its background migration is
  jitter you don't want.
- **"node" ≠ "socket"** on modern AMD (CCX) and Intel SNC — always read the real
  topology (`numactl -H`, `lstopo`), don't assume 1 node per socket.
- **Diagnose with `numastat -p`** (numa_miss/foreign) and `lstopo`, not guesswork.

## Key takeaways

1. **NUMA**: memory is attached per-node (≈per-socket); **local** access is fast,
   **remote** crosses the **UPI/Infinity-Fabric** interconnect at ~1.5-2x latency
   plus contention. Inspect with `numactl --hardware` (CPU↔node map + distance
   matrix).
2. **First-touch** binds a page to the node of the thread that *first writes* it —
   so initialize data on the (pinned) thread that will own it, not on the main
   thread.
3. Control placement with `numactl`/`taskset` (no code), or programmatically with
   **libnuma** (`numa_alloc_onnode`) / `mbind` / `set_mempolicy`; **pin** threads
   with `pthread_setaffinity_np` / `sched_setaffinity`, and isolate cores for the
   lowest jitter.
4. **HFT recipe:** pin the hot thread to a core on the NIC's NUMA node, allocate +
   first-touch its memory there, steer NIC interrupts there — keep the critical
   path local end to end; disable AutoNUMA.
5. **Measure** with `numastat -p` (numa_miss/foreign), `lstopo` (topology), and
   `perf` node events. Huge pages bind to one node, so first-touch them locally.

## Self-check

1. On a 2-socket box, why might code that runs fine single-threaded slow down once
   you spread threads across both sockets, even with no shared writes?
2. Explain first-touch. Why does "allocate + memset on main thread, then process
   in parallel" produce a NUMA bottleneck, and what's the fix?
3. You pinned all your threads but memory is still mostly remote (`numastat` shows
   high numa_foreign). What did you forget?
4. When is `numactl --interleave=all` the right choice, and when is `--membind`
   the right choice?
5. Give the end-to-end placement recipe for an HFT feed handler reading from a NIC
   on socket 1. Which interconnect must stay off the critical path, and why does
   that matter for *tail* latency?

## Further reading

- [`numa(7)` — man7.org](https://man7.org/linux/man-pages/man7/numa.7.html) — overview of the Linux NUMA model and policies.
- [`numactl(8)`](https://man7.org/linux/man-pages/man8/numactl.8.html), [`mbind(2)`](https://man7.org/linux/man-pages/man2/mbind.2.html), [`set_mempolicy(2)`](https://man7.org/linux/man-pages/man2/set_mempolicy.2.html), and [`sched_setaffinity(2)`](https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html) — the canonical syscall/tool man pages.
- [`numa(3)` / libnuma](https://man7.org/linux/man-pages/man3/numa.3.html) — `numa_alloc_onnode`, `numa_available`, and friends.
- Ulrich Drepper, [**"What Every Programmer Should Know About Memory"**](https://lwn.net/Articles/250967/) — §5 covers NUMA in depth.
- [hwloc / `lstopo`](https://www.open-mpi.org/projects/hwloc/) — discover and visualize machine topology (nodes, caches, NIC locality).
- LWN — [**"AutoNUMA: the other approach to NUMA scheduling"**](https://lwn.net/Articles/488709/) and related kernel NUMA-balancing coverage.
- [Brendan Gregg — Linux performance](https://www.brendangregg.com/linuxperf.html) — `numastat`, `perf`, and methodology for memory locality.
- Wikipedia — [Non-uniform memory access](https://en.wikipedia.org/wiki/Non-uniform_memory_access).

## Videos

- Talk search — **"NUMA aware programming low latency"** ([search](https://www.youtube.com/results?search_query=NUMA+aware+programming+low+latency+C%2B%2B)).
- CppCon — **Carl Cook, "When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — core pinning, isolation, and locality for HFT hot paths.
- Talk search — **"thread affinity CPU pinning Linux performance"** ([search](https://www.youtube.com/results?search_query=thread+affinity+CPU+pinning+Linux+performance)).
