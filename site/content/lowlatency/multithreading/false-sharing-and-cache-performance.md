# False Sharing & Cache Performance

> **Why a quant dev must own this:** False sharing is the silent killer of
> multithreaded performance — code that is *logically* race-free and looks
> embarrassingly parallel, yet runs slower with more threads because two cores
> are fighting over the same 64-byte cache line. In HFT, where a feed handler,
> a strategy thread, and a queue's head/tail counters all run on separate pinned
> cores, a single misaligned struct can turn a 50 ns operation into a 500 ns
> one. The fix is trivial once you see it (`alignas(64)` + padding); *seeing*
> it — and proving it with `perf c2c` — is what separates a senior engineer
> from someone who just "added more threads."

*Standard: C++17 introduces `std::hardware_destructive_interference_size`. Examples are C++17.*

## First principles: the cache line is the unit of coherence

Caches don't move bytes; they move **cache lines** — fixed-size blocks, **64
bytes** on essentially every x86-64 and modern ARM core. When a core reads one
byte, it pulls the whole 64-byte line into its L1. Crucially, **cache coherence
operates at line granularity**: the hardware tracks ownership and invalidation
*per line*, not per byte.

That's the whole root cause. The CPU has no idea your two `int`s in the same
line are logically independent — to the coherence protocol they're one
indivisible unit.

## MESI: how a written line invalidates others

Cores keep coherence with a protocol like **MESI**, where each cached line is in
one of four states:

```text
M  Modified   this core has the only, dirty copy
E  Exclusive  this core has the only, clean copy
S  Shared     multiple cores may have clean copies (reads are cheap)
I  Invalid    this copy is stale; must re-fetch before use
```

The rule that bites: **to write a line, a core must own it Exclusively, which
means invalidating every other core's copy (M/E/S → I).** So when core 0 writes
its variable and core 1 writes *its* variable in the *same line*:

```text
core 0 writes X          core 1 writes Y     (X and Y in the SAME 64B line)
-------------------      -------------------
gets line in M  -------> invalidates core1's copy (-> I)
                         core1 must RE-FETCH the line to write Y -> M
                         which invalidates core0's copy (-> I)
core0 re-fetches to write X again ... and round and round it goes
```

The line **ping-pongs** between the two cores' caches. Every "independent" write
now costs a cross-core coherence transaction — tens to hundreds of nanoseconds —
instead of an L1 hit (~1 ns). The variables are logically unshared, but they
*falsely share* a cache line. Hence **false sharing** (a.k.a. *cache-line
ping-ponging*).

> **True vs false sharing:** *True* sharing = two threads access the *same*
> variable (real contention; needs synchronization). *False* sharing = two
> threads access *different* variables that merely sit in the same line (no
> logical contention, pure hardware artifact). False sharing is the one you can
> make vanish with layout alone.

## Seeing it: the textbook example

Two threads each increment their *own* counter. Logically zero contention — but
watch where the counters live.

```cpp
#include <atomic>
#include <thread>
#include <cstdint>

struct Bad {                       // both counters in ONE 64B line -> false sharing
    std::atomic<std::uint64_t> a{0};
    std::atomic<std::uint64_t> b{0};   // sits ~8 bytes after 'a' -> same cache line
};

void hammer(std::atomic<std::uint64_t>& c) {
    for (int i = 0; i < 100'000'000; ++i)
        c.fetch_add(1, std::memory_order_relaxed);
}

int main() {
    Bad s;
    std::thread t0{hammer, std::ref(s.a)};   // core 0 writes a
    std::thread t1{hammer, std::ref(s.b)};   // core 1 writes b
    t0.join(); t1.join();
    // CORRECT result, but each fetch_add bounces the shared line between cores.
}
```

This routinely runs **several times slower** than the padded version below
(commonly observed at 3–10x on multi-socket / multi-core boxes — measure on your
own hardware; the exact factor depends on the microarchitecture). It also gets
*worse* as you add cores, the opposite of what you wanted.

## The fix: align and pad to a cache line

Force each independently-written variable onto its **own** cache line so no two
cores ever contend for the same line:

```cpp
#include <new>          // std::hardware_destructive_interference_size (C++17)
#include <atomic>
#include <cstdint>

// Prefer the standard constant; fall back to 64 if the impl doesn't expose it.
#ifdef __cpp_lib_hardware_interference_size
  constexpr std::size_t CL = std::hardware_destructive_interference_size;
#else
  constexpr std::size_t CL = 64;
#endif

struct Good {
    alignas(CL) std::atomic<std::uint64_t> a{0};   // 'a' starts a fresh line
    alignas(CL) std::atomic<std::uint64_t> b{0};   // 'b' starts a fresh line
};
// sizeof(Good) == 128: each counter owns 64 bytes. No false sharing.
```

`alignas(CL)` on each member forces the next member to the start of a new line,
so the bytes between them are padding the *other* thread never touches. Two ways
to express this:

- **`alignas(64)` per hot field** (as above) — cleanest for a few fields.
- **Explicit padding array** — when you need a value plus deliberate slack:

```cpp
struct alignas(CL) PerThreadCounter {
    std::atomic<std::uint64_t> value{0};
    char pad[CL - sizeof(std::atomic<std::uint64_t>)];  // fill out the rest of the line
};
static_assert(sizeof(PerThreadCounter) == CL);
```

## `hardware_destructive_interference_size` (and its twin)

C++17 added two constants in `<new>`:

| Constant | Meaning | Use for |
|---|---|---|
| `std::hardware_destructive_interference_size` | Min byte offset so two objects **won't** false-share (≈ cache line, usually 64) | **Padding/aligning to *avoid* false sharing** |
| `std::hardware_constructive_interference_size` | Max size to keep two objects in the *same* line so they share *beneficially* | Packing data you want fetched together |

Two caveats interviewers like:

1. They're **compile-time hints**, not a guarantee about the actual runtime CPU.
   On some platforms the "destructive" value is 128 (Intel L2 adjacent-line
   prefetch can pull *two* lines), so blindly assuming 64 can still leave you
   sharing. When in doubt, measure.
2. Some toolchains warn about ABI stability when you use these in a header that
   crosses translation units / library boundaries — many codebases just hardcode
   `constexpr std::size_t CACHE_LINE = 64;` for that reason. Both approaches are
   defensible; know the trade.

## Real places false sharing hides in a trading system

- **Lock-free queue head and tail indices.** A SPSC ring buffer's producer
  writes `head_`, the consumer writes `tail_`. Put them in the same line and the
  two pinned cores ping-pong on *every* push/pop — a classic, devastating bug.
  Separate them onto distinct cache lines (this is *the* reason Rigtorp's SPSC
  queue pads its indices).
- **Per-thread statistics / counters** packed in an array indexed by thread id:
  `counters[tid]` for adjacent `tid`s land in the same line.
- **A spinlock word adjacent to the data it protects** — the hot lock line drags
  the neighbour along.
- **`std::atomic` members of a hot struct** sitting next to other frequently-
  written fields.

```cpp
// SPSC indices, correctly separated:
struct SpscIndices {
    alignas(CL) std::atomic<std::size_t> head_{0};   // written by producer
    alignas(CL) std::atomic<std::size_t> tail_{0};   // written by consumer
};   // head_ and tail_ never share a line -> no producer/consumer ping-pong
```

## How to detect it: `perf c2c` (and friends)

You usually can't *see* false sharing in the source — you must measure. The
purpose-built tool on Linux is **`perf c2c`** ("cache-to-cache"), which records
HITM events (a load that hit a *modified* line in *another* core's cache — the
signature of a line bouncing between cores):

```text
# record cache-line contention across the run:
perf c2c record -- ./your_program
# analyze: lists the hottest contended cache lines, the offending offsets,
# and which CPUs/PIDs are fighting over them:
perf c2c report -NN
```

Read it as: a hot line with **HITM** traffic and *two different variables/offsets
written by two different CPUs* on the same line = false sharing. If it's a
*single* offset, that's *true* sharing (real contention — fix the algorithm, not
the layout).

Complementary signals: `perf stat` showing high `cache-misses` /
`LLC-load-misses` that scale with thread count, or VTune's "Memory Access" /
"Contested Accesses" analysis pointing at the same lines.

## Cost model

```text
access                                   rough latency
---------------------------------------- ----------------------------------
L1 cache hit                             ~1 ns (~4 cycles)
L2 hit                                   ~3-4 ns (~12 cycles)
L3 / LLC hit                             ~10-20 ns (~40 cycles)
cache line fetched from another core     ~tens of ns (cross-core HITM)
                                        (worse across sockets / NUMA hops)
main memory (DRAM)                       ~60-100 ns
```

False sharing converts what should be a **~1 ns L1 hit** into a **~tens-of-ns
cross-core transfer** on *every* write, and the cost recurs for the life of the
hot loop. That's the whole story: it's a latency multiplier on your hottest
data.

## Quant/HFT relevance & interview gotchas

- **"Your parallel code gets *slower* with more threads — why?"** First guess:
  **false sharing**. Be able to draw the MESI ping-pong.
- **Know the fix cold:** `alignas(std::hardware_destructive_interference_size)`
  (or `alignas(64)`) + padding so each hot, cross-core-written field owns its
  line. Bonus: mention the constant can be 128 on some Intel parts.
- **SPSC queue head/tail must be on separate lines.** This is the single most
  common real-world false-sharing bug in trading infra; cite it.
- **`perf c2c` is the detection answer.** HITM events + two offsets/CPUs on one
  line = false sharing; one offset = true sharing. Naming the tool is a strong
  signal.
- **True vs false sharing:** false sharing is fixed by *layout*; true sharing is
  fixed by *algorithm* (shard the data, per-thread accumulation, batch updates).
  Don't pad your way out of genuine contention.
- **Padding has a cost** (cache footprint, memory): pad the *hot, cross-core*
  fields, not every struct. `sizeof` doubling is fine for a few counters, not
  for a million-element array.

## Key takeaways

1. **Coherence is per cache line (64 B), not per byte.** The hardware can't tell
   that two variables in one line are logically independent.
2. **False sharing**: two cores writing *different* variables that share a line
   force the line to **ping-pong** (MESI M↔I), turning ~1 ns L1 hits into
   ~tens-of-ns cross-core transfers — and performance *degrades* with more
   threads.
3. **Fix by layout:** `alignas(64)` / `std::hardware_destructive_interference_size`
   plus padding so each hot, cross-core-written field owns its own cache line.
4. The constant is usually 64 but **can be 128** (adjacent-line prefetch) and is
   a *hint* — measure on the real target.
5. Classic HFT instance: a **SPSC queue's `head_` and `tail_` must live on
   separate lines**, or producer and consumer ping-pong on every operation.
6. **Detect with `perf c2c`** (HITM on a line, two offsets/CPUs); distinguish it
   from **true sharing** (one offset = real contention, fix the algorithm not
   the layout).

## Self-check

1. Why does the hardware treat two logically-independent variables in the same
   line as contended? At what granularity does coherence operate?
2. Walk through the MESI states as core 0 and core 1 each repeatedly write their
   own variable in a shared line.
3. Give two distinct C++ ways to put a hot field on its own cache line, and the
   `sizeof` consequence.
4. Distinguish true sharing from false sharing, and the different fix each
   requires.
5. Why might `std::hardware_destructive_interference_size` be 128 rather than 64,
   and why is it only a hint?
6. What does a `perf c2c` report show for false sharing vs true sharing?

## Further reading

- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — the constant and its caveats.
- Erik Rigtorp — ["Correctly implementing a fixed-size SPSC queue"](https://rigtorp.se/ringbuffer/) — shows exactly why head/tail indices are padded to separate cache lines.
- Ulrich Drepper — ["What Every Programmer Should Know About Memory"](https://www.akkadia.org/drepper/cpumemory.pdf) — the canonical cache/coherence reference (§3 and §6 on false sharing).
- [`perf c2c` documentation / Joe Mario, "C2C – False Sharing Detection in Linux Perf"](https://joemario.github.io/blog/2016/09/01/c2c-blog/) — how to read the report.
- Herb Sutter — ["Eliminate False Sharing"](https://www.drdobbs.com/parallel/eliminate-false-sharing/217500206) (Dr. Dobb's) — a classic walkthrough with numbers.
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — §8.2.3 ("data structures and cache contention") covers false sharing and oversubscription.

## Videos

- Timur Doumler — **"Want fast C++? Know your hardware!"** (CppCon) ([search](https://www.youtube.com/results?search_query=Timur+Doumler+want+fast+C%2B%2B+know+your+hardware)) — caches, lines, and false sharing with live demos.
- Scott Meyers — **"CPU Caches and Why You Care"** ([search](https://www.youtube.com/results?search_query=Scott+Meyers+CPU+Caches+and+Why+You+Care)) — the classic talk on cache behaviour, includes false sharing.
- Fedor Pikus — **"The Speed of Concurrency: Is Lock-free Faster?"** (CppCon) ([search](https://www.youtube.com/results?search_query=Fedor+Pikus+The+Speed+of+Concurrency+is+lock+free+faster)) — shows false sharing wrecking lock-free throughput.
