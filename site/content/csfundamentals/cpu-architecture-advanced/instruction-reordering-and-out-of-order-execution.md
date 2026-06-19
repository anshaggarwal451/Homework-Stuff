# Instruction Reordering and Out-of-Order Execution

> **Why a quant dev must own this:** The CPU does *not* run your instructions in
> the order you wrote them, and neither does the compiler. Most of the time this
> is a free lunch — more work per cycle. But the moment you write lock-free code
> shared between threads, the gap between *program order* and *execution order*
> becomes the single hardest thing to reason about, and getting it wrong produces
> bugs that appear once a week in production and never under a debugger. This
> lesson is the mental model behind `std::atomic`, memory ordering, and every
> lock-free queue in an HFT stack.

## Two different reorderings — get this straight first

There are **two independent** sources of reordering, and conflating them is the
most common confusion:

1. **Compiler reordering.** The optimizer freely rearranges, eliminates, and
   fuses instructions as long as the *single-threaded observable behavior* is
   preserved ("the as-if rule"). It can hoist a load out of a loop, sink a store,
   keep a value in a register instead of writing memory, etc.
2. **Hardware reordering.** The CPU itself executes instructions out of program
   order and lets memory operations become visible to other cores in an order
   different from program order, governed by the **memory model** of the
   architecture.

You must defend against *both*. A compiler barrier (`asm volatile("" ::: "memory")`,
or `std::atomic_signal_fence`) stops the compiler but not the CPU. A hardware
fence (`mfence`) stops the CPU. `std::atomic` with the right `memory_order`
handles both at once — which is exactly why you use it.

## Out-of-order execution: what the core actually does

A modern x86 core is an out-of-order, superscalar, speculative machine. The
front-end fetches/decodes *in order*; the back-end executes *out of order*; and
results **retire in order** so the architectural state always looks sequential.
The key structures:

```text
  in order                        OUT OF ORDER                       in order
 ┌────────┐  ┌────────┐  ┌──────────┐  ┌──────────────┐  ┌────────┐  ┌────────┐
 │ Fetch  │->│ Decode │->│ Rename / │->│ Reservation  │->│Execute │->│ Retire │
 │ (+BPU) │  │ to uops│  │ Allocate │  │ Stations +   │  │ on     │  │ (ROB,  │
 └────────┘  └────────┘  │ -> ROB   │  │ Scheduler    │  │ Ports  │  │ commit)│
                          └──────────┘  └──────────────┘  └────────┘  └────────┘
```

- **Rename / Allocate:** architectural registers (`rax`, `rbx`, …) are mapped to a
  large pool of *physical* registers. This eliminates **false dependencies** —
  WAR (write-after-read) and WAW (write-after-write) hazards — that exist only
  because the ISA has few register names. Each write gets a fresh physical
  register, so independent instructions that happen to reuse `rax` don't
  serialize. Only **true** (read-after-write, RAW) dependencies remain.
- **Reorder Buffer (ROB):** tracks every in-flight instruction in program order
  so results can be *committed* in order (and squashed on misprediction/fault).
  Hundreds of entries deep on modern cores — that's the "instruction window."
- **Reservation stations / scheduler:** hold uops until their inputs are ready,
  then dispatch them to a free **execution port** — the moment operands arrive,
  regardless of program order. This is the heart of OoO.
- **Execution ports:** multiple ALUs, load units, store units, FP/vector units.
  Several uops execute *per cycle* (superscalar). Throughput is limited by port
  availability and dependency chains, not raw program order.
- **Speculation:** branches are predicted (see the branch-prediction lesson) and
  the core runs *down the guessed path*; if wrong, the ROB squashes the bad uops.

The payoff: while one instruction waits on a cache miss (~100ns), the core keeps
~hundreds of *independent* instructions flowing past it. Your job as an optimizer
is to feed it independent work and short dependency chains.

```cpp
// Long dependency chain: each add waits for the previous -> latency-bound.
double sum_serial(const double* a, int n) {
    double s = 0;
    for (int i = 0; i < n; ++i) s += a[i];      // s depends on previous s
    return s;
}
// Multiple accumulators break the chain -> the OoO core fills its ports.
double sum_unrolled(const double* a, int n) {
    double s0=0,s1=0,s2=0,s3=0;
    int i=0;
    for (; i+3<n; i+=4) { s0+=a[i]; s1+=a[i+1]; s2+=a[i+2]; s3+=a[i+3]; }
    for (; i<n; ++i) s0+=a[i];
    return (s0+s1)+(s2+s3);
}
```

The unrolled version exposes four independent chains; the core executes them in
parallel up to FP-add throughput. (The compiler does this for you under
`-ffast-math` since FP addition isn't associative — a real correctness nuance.)

## The memory subsystem: load/store buffers and forwarding

Memory operations get special hardware:

- **Store buffer:** stores don't go straight to cache; they sit in a buffer and
  drain to L1 later. This lets the core keep executing past a store without
  waiting for the cache. Critically, **a store can be delayed past a later load**
  in terms of when other cores see it.
- **Load buffer + memory disambiguation:** loads can execute *speculatively
  before* earlier stores whose addresses aren't yet known, betting they don't
  alias. If the bet is wrong (the store *did* target that address), the loads are
  squashed and replayed.
- **Store-to-load forwarding:** if a load reads an address still sitting in the
  store buffer, the value is forwarded directly from the buffer — the core's own
  later loads see its own earlier stores immediately, even though the store
  hasn't reached cache. (This is why a thread always sees its *own* writes in
  order, even when other threads don't.)

The store buffer is the physical reason **StoreLoad** reordering happens on x86:
a store sitting in the buffer is not yet visible to other cores, so a *later*
load can complete and become visible *before* the earlier store does.

## The x86-TSO memory model: strong, but not sequentially consistent

x86 implements **Total Store Order (TSO)** — one of the *strongest* commodity
memory models. Of the four possible reorderings between a pair of memory ops,
x86 permits exactly **one**:

| Reordering | Allowed on x86 (TSO)? |
|---|:---:|
| Load → Load (LoadLoad) | No |
| Store → Store (StoreStore) | No |
| Load → Store (LoadStore) | No |
| **Store → Load (StoreLoad)** | **Yes** |

So on x86, a store followed by a load to a *different* address can appear
reordered to other cores (because of the store buffer). Everything else stays in
program order. This is why a lot of sloppy lock-free code "works on x86" and then
breaks on ARM/POWER, which are **weakly ordered** and reorder almost everything.

> **Interview gotcha:** "x86 is strongly ordered, so I don't need atomics/fences."
> Wrong on two counts: (a) StoreLoad *is* reordered (the Dekker/Peterson and
> store-buffer litmus tests fail without a fence), and (b) the *compiler* reorders
> regardless of the hardware model. You still need `std::atomic`.

### `volatile` is NOT a fence

`volatile` tells the compiler not to elide or merge accesses to a memory location
(useful for memory-mapped I/O). It does **not** insert hardware barriers and does
**not** guarantee any cross-thread ordering or atomicity. Using `volatile` for
thread communication is a textbook bug. Use `std::atomic`.

### Hardware fences and `LOCK`

```x86asm
mfence          ; full barrier: no memory op moves across it in either direction
lfence          ; orders loads; also a speculation barrier (Spectre mitigation)
sfence          ; orders stores (matters for non-temporal/WC stores)
lock xchg ...   ; atomic RMW; LOCK-prefixed ops are implicit full barriers
```

A sequentially-consistent atomic store on x86 compiles to a plain `mov` followed
by an `mfence` (or is implemented via a `lock`-prefixed exchange); a
release-store is just a `mov` (because StoreStore/LoadStore are already ordered);
an acquire-load is a plain `mov`. That asymmetry — *most* atomic operations are
free instructions on x86, only the seq-cst store/RMW costs a fence — is worth
internalizing.

## How this connects to `std::atomic` and `memory_order`

`std::atomic` is the portable abstraction over *both* reorderings. The
`memory_order` argument says how much ordering you need; the compiler then emits
the right combination of compiler barriers and hardware fences for the target:

- `memory_order_relaxed` — atomicity only, no ordering. Cheapest.
- `memory_order_acquire` / `release` — pair them: a release-store
  "publishes" everything before it; a matching acquire-load "sees" all of it.
  This is the workhorse for lock-free producer/consumer. On x86 both are usually
  free `mov`s.
- `memory_order_seq_cst` — global total order across all seq-cst ops; the
  default, and the one that costs an `mfence`/`lock` on x86 stores.

The deep treatment lives in the lock-free / memory-ordering lessons; the point
*here* is **why** these exist: program order ≠ execution order ≠ the order other
cores observe, and `std::atomic` is how you reassert the ordering you need
without over-fencing.

## Speculation side channels: Spectre / Meltdown (high level)

Speculative, out-of-order execution is also a *security* surface. **Spectre**
trains the branch predictor so the core speculatively executes a path it
shouldn't (e.g. past a bounds check), and although the architectural result is
squashed, the speculative access leaves a **microarchitectural footprint** —
typically a cache-line that got loaded — which an attacker times to exfiltrate
data. **Meltdown** exploited speculative loads bypassing privilege checks. The
takeaway for a systems engineer: the squashed work isn't *perfectly* invisible —
it perturbs the cache/predictor state. Mitigations (KPTI, retpolines, `lfence`
speculation barriers, microcode) all cost some performance, which is why they
matter even outside security.

## Performance & hardware reality (approx)

| Mechanism | Approx | Notes |
|---|---|---|
| Instruction window (ROB) | hundreds of uops | how far ahead the core can look |
| Independent uops retired | several / cycle | superscalar width, port-limited |
| FP add latency / throughput | ~3-4 cyc latency, ~2/cyc throughput | why multiple accumulators help |
| `mfence` | ~tens of cycles | drains/serializes; avoid in hot inner loops |
| `lock`-prefixed RMW | ~tens of cycles (uncontended) | full barrier; far worse under contention |
| Acquire/Release on x86 | ~free (`mov`) | ordering is implicit in TSO |

(All approximate and microarchitecture-dependent; use `llvm-mca`, `uops.info`, or
Agner Fog's tables for specifics rather than guessing exact numbers.)

## Quant/HFT relevance & interview gotchas

- **Lock-free queues live and die here.** An SPSC ring buffer between a feed
  handler and a strategy uses release-store on publish and acquire-load on
  consume. Understanding the store buffer and TSO is what lets you prove it's
  correct *and* minimal (no needless `seq_cst`).
- **"Works on x86" is a trap.** Code validated only on Intel may break on ARM
  (Graviton, Apple Silicon) where almost everything reorders. Reason from the
  memory model, not the machine you happened to test on.
- **`volatile` ≠ atomic ≠ fence.** A frequent interview filter. `volatile` is for
  device/MMIO and signal handlers' shared flags (with care), not threads.
- **Optimize dependency chains, not instruction counts.** The OoO core hides
  latency *if you give it independent work*. A short critical path with more
  total instructions can beat a long serial chain. Multiple accumulators,
  software pipelining, and breaking false dependencies are the levers.
- **Don't over-fence.** A stray `mfence` or a `seq_cst` where `acquire/release`
  suffices serializes the core and shows up as latency. Know the minimum.
- **Speculation leaves footprints** (Spectre) — relevant for both security and
  for understanding why mitigations cost cycles.

## Key takeaways

1. There are **two** reorderings — **compiler** (as-if rule) and **hardware**
   (memory model). You must address both; `std::atomic` does both for you.
2. OoO execution: in-order fetch/decode, **register renaming** kills WAR/WAW
   hazards, the **scheduler/ports** execute uops as inputs become ready, the
   **ROB** retires in order. It hides latency by running independent work past
   stalls.
3. The **store buffer**, **load buffer + disambiguation**, and **store-to-load
   forwarding** are the memory engine — and the store buffer is *why* StoreLoad
   reordering exists.
4. **x86-TSO** is strong: only **StoreLoad** is reordered. ARM/POWER are weak.
   `volatile` is **not** a fence; use `std::atomic` + the right `memory_order`.
5. Feed the machine **independent work and short dependency chains**; don't
   over-fence. Speculation also powers **Spectre/Meltdown** side channels.

## Self-check

1. Distinguish compiler reordering from hardware reordering. Which does
   `asm volatile("" ::: "memory")` prevent, and which does `mfence` prevent?
2. What hazards does register renaming eliminate, and which remains? Why does that
   make multiple accumulators in a sum loop faster?
3. Which single reordering does x86-TSO permit, and what hardware structure causes
   it? Sketch a two-thread litmus test that exposes it.
4. Why is a release-store essentially free on x86 but a seq-cst store costs a
   fence?
5. Explain, at a high level, how Spectre extracts data even though the speculative
   instructions are architecturally squashed.

## Further reading

- Jeff Preshing — [**"Memory Reordering Caught in the Act"**](https://preshing.com/20120515/memory-reordering-caught-in-the-act/) and [**"Memory Barriers Are Like Source Control Operations"**](https://preshing.com/20120710/memory-barriers-are-like-source-control-operations/) — the clearest intros to ordering and fences.
- [`std::memory_order` — cppreference](https://en.cppreference.com/w/cpp/atomic/memory_order) — the formal model and per-order semantics.
- Paul McKenney, [**"Memory Barriers: a Hardware View for Software Hackers"**](https://www.cs.columbia.edu/~junfeng/12sp-w4118/lectures/whymb.2010.07.23a.pdf) — store buffers, invalidate queues, and why fences exist.
- Agner Fog, [**The microarchitecture of Intel, AMD and VIA CPUs**](https://www.agner.org/optimize/microarchitecture.pdf) — ROB, rename, ports, store buffers per microarchitecture.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 4-5 (processor architecture, out-of-order execution, optimizing for the pipeline).
- [uops.info](https://uops.info/) and the [Intel 64 and IA-32 Optimization Reference Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) — port usage, latencies, fence costs.
- Wikipedia — [Out-of-order execution](https://en.wikipedia.org/wiki/Out-of-order_execution), [Memory ordering](https://en.wikipedia.org/wiki/Memory_ordering), and [Spectre](https://en.wikipedia.org/wiki/Spectre_%28security_vulnerability%29).

## Videos

- CppCon — **Herb Sutter, "atomic<> Weapons: The C++ Memory Model and Modern Hardware"** ([search](https://www.youtube.com/results?search_query=Herb+Sutter+atomic+weapons+C%2B%2B+memory+model)) — the definitive talk linking hardware reordering to `std::atomic`.
- CppCon — **Fedor Pikus, "C++ atomics, from basic to advanced"** ([search](https://www.youtube.com/results?search_query=Fedor+Pikus+C%2B%2B+atomics+from+basic+to+advanced)) — OoO memory effects and lock-free correctness.
- *Computerphile / lectures* — search **"out of order execution Tomasulo"** ([search](https://www.youtube.com/results?search_query=out+of+order+execution+Tomasulo+register+renaming)) for the renaming/ROB mechanics.
