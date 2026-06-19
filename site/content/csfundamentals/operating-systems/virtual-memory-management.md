# Virtual Memory Management

> **Why a quant dev must own this:** Virtual memory is the layer that turns "I
> read a pointer" into "the MMU walked a four-level page table, maybe missed the
> TLB, maybe faulted into the kernel." In a hot trading loop every one of those
> is a latency landmine: a single major fault is a swap from disk; even a minor
> fault is microseconds; a TLB miss is a page-table walk. The whole art of
> low-latency memory is making the steady state take *none* of these — which is
> why `mlockall`, pre-faulting, and hugepages are interview table stakes.

## First principles: why an indirection layer at all

Programs want to believe they own a large, contiguous, private memory. Physical
RAM is finite, fragmented, and shared by every process. **Virtual memory** is
the kernel+hardware abstraction that bridges the two: each process sees a
private **virtual address space**, and the **MMU** translates virtual addresses
to **physical** addresses on every access, using per-process **page tables** the
kernel maintains.

This buys three things at once: **isolation** (process A can't name process B's
physical memory), **the illusion of more memory than you have** (back unused
pages on disk, or don't back them until touched), and **flexibility** (map
files, share pages, mark regions read-only or copy-on-write).

## Pages, frames, and the page table

Memory is managed in fixed-size chunks. The virtual space is divided into
**pages** and physical RAM into equal-size **page frames**. On x86-64 the base
page is **4 KiB**. A page table maps each used virtual page to a physical frame
(or records that it's not present).

A flat table would be enormous (2^48 / 4 KiB entries per process), so x86-64
uses a **4-level (or 5-level) hierarchical page table**. A 48-bit virtual
address is sliced into indices that walk the levels:

```text
  48-bit virtual address:
  +--------+--------+--------+--------+------------+
  | PML4   | PDPT   | PD     | PT     | page offset|
  | 9 bits | 9 bits | 9 bits | 9 bits |  12 bits   |
  +--------+--------+--------+--------+------------+
       |        |        |        |         |
   CR3-+        |        |        |         +--> byte within the 4 KiB page
       v        v        v        v
   [PML4] -> [PDPT] -> [PD] -> [PT] -> physical frame number

  Each level: 512 entries (2^9). The CPU register CR3 points at the
  top-level (PML4) table of the *current* process — switching CR3 = switching
  address spaces (this is the expensive part of a process context switch).
```

A translation that misses everything therefore costs up to **four dependent
memory loads** (a "page walk") before you even touch the data. That's why the
hardware caches translations.

## The MMU and the TLB

The **MMU** (memory management unit, on-die) performs translation. To avoid
walking the page table on every access, it caches recent virtual→physical
translations in the **TLB (Translation Lookaside Buffer)** — a small, fast,
fully/​set-associative cache (tens to a few thousand entries).

- **TLB hit:** translation is essentially free (overlaps with the access).
- **TLB miss:** the hardware page-walker performs the multi-level walk (*approx*
  tens to ~100+ cycles if the page-table lines are in cache; far worse if not).

The TLB is small, so a working set scattered across many 4 KiB pages can thrash
it — every access a miss, every miss a walk. This is the single biggest reason
hugepages matter for HFT (below).

## Demand paging, page faults, and COW

The kernel is lazy. When you `mmap` a region or grow the heap, it just records a
**VMA** (virtual memory area) — *no physical frame is allocated yet*. The frame
is materialized on first access via a **page fault**:

- **Minor fault:** the page can be satisfied without disk I/O — e.g. allocate
  and zero a fresh anonymous frame (first touch of BSS/heap), or map an
  already-cached file page. *Approx* low single-digit µs.
- **Major fault:** the data must come from disk — read a file page, or **swap
  in** a page that was evicted to swap. *Approx* hundreds of µs to milliseconds
  (it's disk I/O). **This is catastrophic in a hot path.**

**Copy-on-write (COW)** is the same machinery used cleverly: after `fork`, parent
and child *share* every physical frame, all marked read-only. The first *write*
faults, the kernel copies that one frame and remaps it writable for the writer.
So `fork` is cheap up front and pages diverge only as touched. (More in the
process-creation lesson.)

**Swapping** is demand paging in reverse: under memory pressure the kernel
evicts least-recently-used pages to a swap device to free frames. Great for
desktops, poison for latency — which is why HFT boxes often disable swap and pin
memory.

## Pinning memory: the HFT essential

You do not want the kernel paging out your order book and then taking a major
fault to bring it back mid-trade. **`mlock`/`mlockall`** locks pages into RAM so
they are never swapped:

```cpp
#include <sys/mman.h>
#include <cstdio>

int main() {
    // Lock ALL current and future pages of this process into RAM.
    // MCL_CURRENT: lock everything mapped now.
    // MCL_FUTURE : lock anything we map later too.
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        std::perror("mlockall");   // usually needs CAP_IPC_LOCK or a raised RLIMIT_MEMLOCK
        return 1;
    }
    // ... now the resident set won't be swapped out under pressure ...
    // munlockall();  // to undo
}
// Compile: g++ -O2 t.cpp && sudo ./a.out
```

But `mlock` only guarantees pages stay *resident once present* — it does **not**
fault them in for you everywhere. The robust startup recipe is **pre-fault then
lock**: allocate the arena, write one byte per 4 KiB page (forcing the minor
faults now), then `mlockall`. After that, steady-state accesses take zero faults.

```cpp
// Pre-fault an arena so the minor faults happen at startup, not in the hot path.
#include <cstddef>
constexpr std::size_t PAGE = 4096;
void prefault(volatile char* p, std::size_t bytes) {
    for (std::size_t i = 0; i < bytes; i += PAGE) p[i] = 0; // touch each page
}
```

`madvise(2)` is the cooperative tuning knob: `MADV_WILLNEED` to pre-fetch,
`MADV_DONTNEED` to drop pages, `MADV_HUGEPAGE`/`MADV_NOHUGEPAGE` to steer THP.

## Hugepages: fewer, bigger pages = TLB relief

x86-64 supports **2 MiB** and **1 GiB** pages in addition to 4 KiB. A single
TLB entry then covers 2 MiB (512×) or 1 GiB of memory, so a large working set
needs far fewer TLB entries and far fewer page-table levels to walk.

- **Explicit hugepages:** reserve via `hugetlbfs` / `vm.nr_hugepages`, then
  `mmap(..., MAP_HUGETLB, ...)`. Deterministic — what HFT systems prefer.
- **Transparent Huge Pages (THP):** the kernel opportunistically promotes 4 KiB
  pages to 2 MiB behind your back. Convenient, but the background `khugepaged`
  scanning and compaction can cause **latency spikes / jitter** — so many
  low-latency shops *disable* THP (`/sys/kernel/mm/transparent_hugepage/enabled`)
  and use explicit hugepages instead.

```c
#include <sys/mman.h>
// Anonymous mapping backed by 2 MiB hugepages (requires reserved hugepages).
void* p = mmap(nullptr, 2u*1024*1024,
               PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0);
```

## Overcommit

Linux **overcommits** by default: `mmap`/`malloc` can succeed for more virtual
memory than you have RAM+swap, on the bet that not all of it gets touched.
Touching it later when frames run out invokes the **OOM killer**, which picks a
victim process and kills it. Tunable via `vm.overcommit_memory`. For a trading
process, you generally want to *fault and lock* everything up front so there's no
surprise allocation failure (or OOM kill) during the session.

## Approximate cost ladder

Order-of-magnitude only — *always measure your own hardware*:

| Event | Approx cost | Notes |
|---|---|---|
| TLB hit + cache hit | ~0 extra | The happy path; translation overlaps the access. |
| **TLB miss → page walk** | tens to ~100+ cycles | Up to 4 dependent loads; worse if page-table lines aren't cached. |
| **Minor page fault** | ~single-digit µs | Trap to kernel, allocate+zero a frame, fix the PTE. |
| **Major page fault (swap-in / file)** | ~hundreds of µs to ms | Disk I/O. Never acceptable in the hot path. |
| **OOM kill** | fatal | Your process dies. |

The takeaway: in steady state a latency-critical thread should hit **zero**
faults and minimize TLB misses. You achieve that with pre-faulting + `mlockall`
+ hugepages.

## Quant/HFT relevance & interview gotchas

- **`mlockall(MCL_CURRENT | MCL_FUTURE)` at startup** is standard practice —
  guarantees no swap-induced major faults during trading. Needs
  `CAP_IPC_LOCK` or a raised `RLIMIT_MEMLOCK`.
- **Pre-fault everything**, then lock. `mlock` keeps resident pages resident; it
  doesn't eliminate the *first*-touch minor fault — do that during warm-up.
- **Use explicit hugepages, and consider disabling THP.** Hugepages cut TLB
  misses for big arenas; THP's background compaction is a jitter source you
  don't want surprising you mid-session.
- **Disable swap on production trading boxes** (or set swappiness very low) so a
  memory spike can't page out your hot data.
- **`fork` triggers COW faults later** — a parent and child sharing a huge arena
  will each take a fault-and-copy storm if both write to it. (Process-creation
  lesson.)
- **Know the fault taxonomy cold:** minor vs major, and that a "page fault" is
  not necessarily an error — it's the normal lazy-allocation mechanism; only
  *invalid* accesses become SIGSEGV.
- **CR3 reload on a process switch flushes the TLB** (without PCID), so even your
  warm hugepage mappings go cold across a context switch — another argument for
  pinning one hot thread per isolated core and never being preempted. (See the
  context-switching and scheduling lessons.)

## Key takeaways

1. Virtual memory gives each process a private address space; the **MMU**
   translates virtual→physical on every access using **multi-level page tables**
   (4-level on x86-64), with **CR3** pointing at the current process's top table.
2. The **TLB** caches translations; a **miss** triggers a page-table **walk**
   (several dependent loads). Hugepages cut TLB misses by covering far more
   memory per entry.
3. Memory is allocated **lazily**: a **page fault** materializes a frame on first
   touch. **Minor** faults are µs (no I/O); **major** faults are disk I/O
   (hundreds of µs+) — fatal to latency.
4. **Copy-on-write** makes `fork` cheap; **swapping** trades latency for capacity
   under pressure; **overcommit** can lead to the **OOM killer**.
5. The HFT memory recipe: **pre-fault → `mlockall(MCL_CURRENT|MCL_FUTURE)` →
   hugepages (often THP off) → no swap**, so the steady state takes zero faults.
6. Tools: `mmap` (map), `mlock`/`mlockall` (pin), `madvise` (advise),
   `/proc/self/smaps` (inspect residency and hugepage use).

## Self-check

1. A 48-bit virtual address on x86-64 walks how many page-table levels, and what
   register points at the top of the current process's table?
2. Distinguish a minor from a major page fault and give an approximate cost for
   each. Which one must never happen in a hot path, and why?
3. What exactly does `mlockall(MCL_CURRENT | MCL_FUTURE)` guarantee — and what
   does it *not* do that pre-faulting addresses?
4. How does a 2 MiB hugepage reduce TLB pressure compared with 4 KiB pages? Why
   might a low-latency shop still disable *transparent* hugepages?
5. Explain copy-on-write after `fork`. Why can a huge shared arena cause a fault
   storm if both parent and child write to it?
6. What is memory overcommit, and what happens when an overcommitted system runs
   out of frames?

## Further reading

- [`mmap(2)` — man7.org](https://man7.org/linux/man-pages/man2/mmap.2.html), [`mlock(2)`/`mlockall(2)`](https://man7.org/linux/man-pages/man2/mlock.2.html), [`madvise(2)`](https://man7.org/linux/man-pages/man2/madvise.2.html).
- [Linux kernel docs: Transparent Hugepage Support](https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html) and [HugeTLB Pages](https://www.kernel.org/doc/html/latest/admin-guide/mm/hugetlbpage.html).
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 9 (Virtual Memory) — pages, TLB, multi-level tables, COW.
- Robert Love, *Linux Kernel Development*, 3rd ed. — Ch. 12 (Memory Management) and Ch. 15 (Process Address Space).
- [LWN: hugepages / transparent hugepages](https://lwn.net/Kernel/Index/#Huge_pages) — the definitive deep dives and their latency caveats.
- [Brendan Gregg — Memory / Linux performance](https://www.brendangregg.com/linuxperf.html) — observability (page faults, swap) with real tools.

## Videos

- *CppCon* — **Carl Cook, "When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — page faults and memory pinning in trading systems.
- *Computerphile* — **"Virtual Memory" / "Paging"** ([search](https://www.youtube.com/results?search_query=computerphile+virtual+memory+paging)) — the intuition for pages, frames, and translation.
