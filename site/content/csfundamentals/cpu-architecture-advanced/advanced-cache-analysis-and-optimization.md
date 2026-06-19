# Advanced Cache Analysis and Optimization

> **Why a quant dev must own this:** Once your hot path is branch-clean and
> vectorized, the remaining latency is almost always *memory*. A main-memory
> miss costs ~100ns — hundreds of cycles in which you could have priced a dozen
> instruments. In HFT, cache behavior is the difference between a feed handler
> that keeps up and one that falls behind under a burst. This lesson builds on
> the basic cache-hierarchy lesson and goes after the second-order effects:
> associativity and conflict misses, false sharing, blocking, prefetch, TLB and
> huge pages, non-temporal stores, and how to *measure* all of it.

## A quick recap, then the map math

The basic lesson established the hierarchy: registers → L1 (~4 cycles) → L2
(~12-15 cycles) → L3/LLC (~40 cycles) → DRAM (~100ns / ~200-300 cycles), with
lines of **64 bytes** transferred as the unit. This lesson assumes that and
digs into *why* you miss even when your working set "fits."

Caches are **set-associative**. A physical (well, after translation) address is
split into three fields:

```text
  | --- tag --- | --- set index --- | --- block offset --- |
                                      \__ log2(line size) = 6 bits for 64B
                       \__ log2(number of sets)
```

- **Block offset** (low 6 bits for 64B lines): which byte within the line.
- **Set index:** which *set* the line maps to. An *N*-way cache has
  `sets = cache_size / (line_size * N)`.
- **Tag:** the rest; compared against the tags of the *N* ways in that set to
  detect a hit.

Worked example: a 32 KB, 8-way, 64-byte-line L1D has
`32768 / (64 * 8) = 64 sets`, so bits [11:6] are the set index, bits [5:0] the
offset. **Two addresses that differ only in bits above [11:6] land in the same
set.** That's the seed of conflict misses.

## Conflict misses, thrashing, and the power-of-two stride trap

A **conflict miss** happens when more than *N* hot lines map to the same set:
they evict each other even though the cache as a whole is far from full. The
classic way to trigger it is a **power-of-two stride**.

```cpp
// Walk a big matrix column-wise with a power-of-two row length.
// Many rows' elements collide in the same cache set -> thrashing.
double sum_col(const double* m, std::size_t rows, std::size_t stride) {
    double s = 0;
    for (std::size_t r = 0; r < rows; ++r)
        s += m[r * stride];   // stride = 4096 doubles == 32 KB == power of two
    return s;
}
```

If `stride * sizeof(double)` is a multiple of `sets * line_size`, every access
maps to the *same* (or few) sets. You get the latency of a cache that's
effectively only *N* lines deep, regardless of total cache size. The fix is to
**pad** array dimensions to *non*-powers-of-two (e.g. allocate a 1025-wide row,
not 1024) so successive rows spread across sets. This is why FFT and matrix
libraries pad leading dimensions.

> **Interview line:** "Powers of two are friendly to your address arithmetic and
> *hostile* to your cache associativity." Padding to a non-power-of-two stride is
> the standard remedy.

## False sharing — the multicore tax

Coherence operates at **cache-line** granularity, not variable granularity. If
two threads on different cores write two *different* variables that happen to sit
in the *same* 64-byte line, every write invalidates the other core's copy of the
whole line. The variables are logically independent but physically share a line —
**false sharing** — and it can be a 10x+ slowdown on an otherwise trivial loop.

```cpp
#include <atomic>
#include <new>     // std::hardware_destructive_interference_size (C++17)

// BAD: both counters share one 64B line -> ping-pong on every increment.
struct BadCounters {
    std::atomic<long> producer{0};
    std::atomic<long> consumer{0};
};

// GOOD: each counter gets its own line. No coherence ping-pong.
struct alignas(std::hardware_destructive_interference_size) PaddedCounter {
    std::atomic<long> v{0};
};
struct GoodCounters {
    PaddedCounter producer;
    PaddedCounter consumer;
};
```

`std::hardware_destructive_interference_size` (C++17) is the portable "minimum
spacing to avoid false sharing" — typically 64 on x86, but some Intel parts
prefetch *pairs* of lines, so 128 is sometimes used in practice. If your stdlib
doesn't define it, fall back to `alignas(64)` (and document why). The
*constructive* sibling tells you the max size you can pack together for *true*
sharing (keep co-accessed data within one line).

## Cache-line alignment and structure layout

Two layout disciplines pay off constantly:

**Align hot, shared objects to a line** so they neither straddle two lines nor
false-share. `alignas(64)` on a ring-buffer slot, a per-thread counter, or a
queue node.

**Hot/cold splitting (structure splitting).** A line you load brings 64 bytes
whether you use 8 or 64. If your struct mixes a few hot fields with a lot of
cold ones, every hot access drags the cold bytes into cache and wastes
bandwidth.

```cpp
// Cold: 'symbol' and 'description' touched rarely; 'px'/'qty' touched per tick.
struct OrderHot  { int64_t px; int32_t qty; uint32_t id; };          // packs in 16B
struct OrderCold { char symbol[8]; char description[64]; /* ... */ }; // separate
// Index both by 'id'; the per-tick loop streams only OrderHot -> denser lines.
```

This is the same motivation as **AoS vs SoA** (array-of-structs vs
struct-of-arrays), revisited from the cache angle: if a loop touches only one
field across many elements, SoA puts *only that field* contiguously, so each
loaded line is 100% useful and the access is vectorizable. AoS wastes bandwidth
loading fields the loop ignores. Order books and market-data tables are prime
SoA candidates — store prices, quantities, and timestamps as parallel arrays.

## Blocking / tiling: making reuse fit in cache

When an algorithm reuses data (matrix multiply, convolution, a join), restructure
the loops so each *block* of the working set stays resident in cache while it's
reused, instead of streaming the whole array per pass.

```cpp
// Tiled matrix multiply: process BxB blocks so the working set fits in L1/L2.
void matmul_tiled(const float* A, const float* B, float* C,
                  int n, int T /* tile, e.g. 64 */) {
    for (int ii = 0; ii < n; ii += T)
      for (int jj = 0; jj < n; jj += T)
        for (int kk = 0; kk < n; kk += T)
          for (int i = ii; i < std::min(ii+T, n); ++i)
            for (int j = jj; j < std::min(jj+T, n); ++j) {
              float acc = C[i*n + j];
              for (int k = kk; k < std::min(kk+T, n); ++k)
                  acc += A[i*n + k] * B[k*n + j];
              C[i*n + j] = acc;
            }
}
```

A **cache-aware** algorithm (like this) is tuned to a specific cache size via the
tile parameter `T`. A **cache-oblivious** algorithm (e.g. recursive divide-and-
conquer matmul) achieves good locality at *every* level of the hierarchy without
knowing the sizes, by recursing until subproblems naturally fit. Know both terms;
cache-aware tiling is what you'll hand-tune in HFT, cache-oblivious is the elegant
theoretical answer.

## Prefetching

Hardware prefetchers detect sequential and simple strided access and pull lines
ahead of demand — which is why linear scans are cheap. They give up on irregular
/ pointer-chasing patterns. For those you can issue **software prefetch** hints:

```cpp
// Prefetch a few iterations ahead while chasing an irregular structure.
for (std::size_t i = 0; i < n; ++i) {
    __builtin_prefetch(&data[index[i + 8]], 0 /*read*/, 3 /*high temporal*/);
    process(data[index[i]]);
}
```

Software prefetch is a sharp tool: prefetch *too late* and it doesn't hide the
miss; *too early* and the line is evicted before use; *too much* and you pollute
the cache and waste bandwidth. The prefetch distance ("8 ahead" above) must be
tuned to the per-iteration latency and memory latency, and *measured*. Often the
best "prefetch" is restructuring to a sequential pattern the hardware handles for
free.

## TLB and huge pages

Virtual addresses are translated to physical via page tables; the **TLB**
(Translation Lookaside Buffer) caches recent translations. With standard 4 KB
pages, a 1 GB working set needs 256K translations — far more than the few hundred
to ~1.5K TLB entries — so you take **TLB misses** (a page-walk, possibly several
memory accesses) on top of cache misses.

**Huge pages** (2 MB or 1 GB on x86-64) make each TLB entry cover far more memory,
slashing TLB misses and page-walk cost for large buffers. Options:

```text
# Transparent Huge Pages (kernel-managed):
cat /sys/kernel/mm/transparent_hugepage/enabled

# Explicit, via mmap with MAP_HUGETLB (2MB pages):
mmap(NULL, len, PROT_READ|PROT_WRITE,
     MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0);
```

HFT systems frequently pre-allocate their big buffers (order books, pools) on
explicit huge pages at startup to make TLB behavior deterministic and avoid
page-walk jitter on the hot path. (Huge pages also interact with NUMA — see that
lesson.)

## Non-temporal (streaming) stores

When you write a large buffer you will *not* read back soon (logging, bulk
output, memset-like fills), pulling each line into cache first
(read-for-ownership) is pure pollution — it evicts data you *do* need.
**Non-temporal stores** bypass the cache and write straight toward memory:

```cpp
#include <immintrin.h>
// Stream 'src' to 'dst' without polluting the cache (dst must be 32B-aligned).
void stream_copy(float* dst, const float* src, std::size_t n /* multiple of 8 */) {
    for (std::size_t i = 0; i < n; i += 8) {
        __m256 v = _mm256_loadu_ps(src + i);
        _mm256_stream_ps(dst + i, v);      // VMOVNTPS: non-temporal store
    }
    _mm_sfence();   // NT stores are weakly ordered; fence before others observe them
}
```

Caveats: NT stores are most beneficial above cache size, require alignment for
the aligned forms, and are **weakly ordered** — you must `_mm_sfence()` before
another thread (or a subsequent ordered store) relies on them being visible.

## Measuring it — the only opinion that counts

Don't theorize about misses; count them.

```text
# Top-line miss rates and where the LLC misses come from:
perf stat -e cache-references,cache-misses,\
L1-dcache-loads,L1-dcache-load-misses,\
LLC-loads,LLC-load-misses,dTLB-load-misses ./app

# Find the offending instruction/line:
perf record -e LLC-load-misses ./app && perf report

# Detailed simulated profile (slow, but exact and machine-independent):
valgrind --tool=cachegrind ./app   # then cg_annotate to see per-line misses
```

`perf c2c` ("cache-to-cache") specifically diagnoses **false sharing** by showing
HITM (hit-modified) events — lines bounced between cores. That's the tool to
reach for when a multithreaded loop is mysteriously slow.

## Performance & hardware reality (approx)

| Access | Approx latency | Notes |
|---|---|---|
| L1D hit | ~4-5 cycles | the happy path |
| L2 hit | ~12-15 cycles | |
| L3 / LLC hit | ~40 cycles | shared across cores |
| DRAM (local) | ~100 ns (~200-300 cycles) | a "miss to memory" |
| DRAM (remote NUMA) | ~1.5-2x local | see NUMA lesson |
| TLB hit | ~0-1 cycle | in the translation path |
| TLB miss → page walk | ~tens of cycles+ | multiplied if the walk itself misses cache |
| False-sharing line bounce | ~tens-100+ cycles | coherence round-trip between cores |

(All approximate, microarchitecture-dependent — quote ranges, never invent exact
benchmark numbers.)

## Quant/HFT relevance & interview gotchas

- **Order-book / market-data layout is a cache problem.** Prefer SoA for the
  per-tick fields, hot/cold split rarely-touched metadata, align ring-buffer
  slots to 64 bytes, and pad shared counters with
  `hardware_destructive_interference_size`. The data structure *is* the
  performance.
- **False sharing is the #1 multicore surprise.** Two atomics in one struct, a
  per-thread stats array indexed `stats[thread_id]` with 8-byte entries — both
  silently false-share. Interviewers love asking you to spot and fix it.
- **"It fits in L2, why is it slow?"** → conflict misses from a power-of-two
  stride. Pad the stride.
- **Huge pages** remove TLB jitter from large pre-allocated pools — a determinism
  win, not just throughput.
- **NT stores** are right for write-only bulk output, *wrong* for anything you'll
  re-read — and you must fence them.
- **Always measure.** "I think it's a cache miss" is not an answer; `perf stat`
  with `LLC-load-misses` and `perf c2c` is.

## Key takeaways

1. Caches are **set-associative**; address bits split into tag/set-index/offset.
   More lines than ways in one set → **conflict misses**, classically triggered
   by **power-of-two strides** (pad to break them).
2. **False sharing** — independent variables in one 64B line bouncing between
   cores — is a top multicore killer; fix with
   `alignas(std::hardware_destructive_interference_size)` and diagnose with
   `perf c2c`.
3. Lay data out for the access pattern: **SoA**, **hot/cold splitting**, and
   line alignment make every loaded line useful.
4. **Blocking/tiling** keeps reused data resident (cache-aware); cache-oblivious
   recursion achieves locality without knowing sizes.
5. **Software prefetch**, **huge pages** (TLB), and **non-temporal stores** are
   targeted tools — each helps a specific pattern and hurts elsewhere; tune by
   measurement (`perf`, Cachegrind, `perf c2c`).

## Self-check

1. For a 32 KB, 8-way, 64-byte-line L1D, how many sets are there and which address
   bits index them? Why does a stride of exactly the cache size thrash?
2. Two threads increment `a.x` and `a.y` (both 8-byte members of the same struct)
   and the loop is far slower than expected. Name the effect and two fixes.
3. When is SoA strictly better than AoS, and when does it not matter?
4. You're filling a 4 GB scratch buffer you won't read back this iteration. Which
   store type, and what synchronization must you add?
5. Which `perf` events distinguish a *capacity/conflict* cache problem from a
   *false-sharing* problem?

## Further reading

- Ulrich Drepper, [**"What Every Programmer Should Know About Memory"**](https://lwn.net/Articles/250967/) — the definitive deep dive on caches, associativity, prefetch, NUMA, and TLBs.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — false sharing and the C++17 constants.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 6 (the memory hierarchy, blocking, cache-friendly code).
- Agner Fog, [Optimizing software in C++](https://www.agner.org/optimize/optimizing_cpp.pdf) — cache and memory chapters.
- [`perf` examples — Brendan Gregg](https://www.brendangregg.com/perf.html) — practical `perf stat`/`record`/`c2c` recipes.
- [Cachegrind manual (Valgrind)](https://valgrind.org/docs/manual/cg-manual.html) — exact per-line miss profiling.
- Wikipedia — [CPU cache](https://en.wikipedia.org/wiki/CPU_cache) and [Cache-oblivious algorithm](https://en.wikipedia.org/wiki/Cache-oblivious_algorithm).

## Videos

- *Mike Acton* — **"Data-Oriented Design and C++"** (CppCon) ([search](https://www.youtube.com/results?search_query=Mike+Acton+data-oriented+design+and+C%2B%2B)) — the manifesto for laying out data for the cache.
- CppCon — **Scott Meyers, "CPU Caches and Why You Care"** ([search](https://www.youtube.com/results?search_query=Scott+Meyers+CPU+caches+and+why+you+care)) — false sharing, locality, and layout, clearly explained.
- CppCon — search for **"cache-friendly data structures"** talks ([search](https://www.youtube.com/results?search_query=CppCon+cache+friendly+data+structures)).
