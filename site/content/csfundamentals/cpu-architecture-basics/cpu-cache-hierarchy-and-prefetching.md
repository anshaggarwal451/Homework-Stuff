# CPU Cache Hierarchy and Prefetching

> **Why a quant dev must own this:** In an HFT hot path your bottleneck is
> almost never arithmetic — it's *waiting for memory*. A single trip to DRAM
> can cost as much as a few hundred adds. The cache hierarchy is the hardware's
> attempt to hide that latency, and your job is to design data structures and
> access patterns so the hardware wins. "Make it cache-friendly" is the single
> highest-leverage performance lever you have, and it's a near-guaranteed
> interview topic.

## The first principle: memory is a pyramid, and it's a lie

Programmers like to imagine memory as a flat array you can poke at uniformly.
The hardware spends enormous effort *maintaining that illusion* while the
physical reality is a steep hierarchy. The closer a storage level is to the
execution units, the faster and smaller and more expensive it is.

The reason the hierarchy works at all is **locality of reference**, which comes
in two flavours:

- **Temporal locality:** if you touched an address recently, you'll probably
  touch it again soon (a loop counter, a hot order-book level).
- **Spatial locality:** if you touched an address, you'll probably touch its
  neighbours soon (the next element of an array, the next field of a struct).

Caches are pure bets on locality. A program with good locality runs an order of
magnitude faster than the same algorithm with poor locality, on the *same*
hardware. Drepper's *What Every Programmer Should Know About Memory* is the
canonical demonstration of just how large that gap is.

## The levels and their approximate costs

These figures are typical/approximate for a modern x86 server core (Skylake-era
and later). Exact numbers vary by microarchitecture and clock, but the
**ratios** are what matter and they are remarkably stable.

| Level | Typical size | Approx latency | Notes |
|------|-------------|----------------|-------|
| Registers | ~16 GP + vector regs | 0 cycles (it's the operand) | The only "memory" the ALU reads directly |
| L1 data cache | 32–48 KB / core | ~4–5 cycles (~1 ns) | Per-core, split I/D |
| L2 cache | 256 KB–2 MB / core | ~12–15 cycles (~3–4 ns) | Per-core (usually) |
| L3 (LLC) | tens of MB | ~40 cycles (~10–20 ns) | Shared across cores |
| DRAM (main memory) | GBs | ~60–100 ns (≈ 200+ cycles) | Off-die, much higher latency |
| NUMA-remote DRAM | GBs | ~100–150 ns | Memory on another socket |

> **The mental model to memorize:** L1 ≈ 1 ns, L3 ≈ 10–20 ns, DRAM ≈ 100 ns.
> A DRAM miss is roughly **100×** an L1 hit. If you remember nothing else,
> remember that one number — it's why "avoid the cache miss" beats almost every
> micro-optimization.

A useful related figure: **register-to-register `ADD` is ~1 cycle**, so a DRAM
miss costs on the order of *hundreds of arithmetic operations*. You are not
compute-bound; you are latency-bound.

## Cache lines: the unit of transfer

The cache does **not** move individual bytes. It moves fixed-size blocks called
**cache lines** — **64 bytes** on essentially all modern x86 (and Apple
Silicon, though some ARM cores use 128). When you read one `int`, the hardware
fetches the whole 64-byte line containing it.

This single fact explains most cache behaviour:

- Reading `a[0]` brings in `a[0..15]` (for 32-bit ints) **for free** — that's
  spatial locality cashed in. The next 15 accesses are L1 hits.
- Touching one byte of a struct pulls in the surrounding ~63 bytes whether you
  wanted them or not. Wasting those bytes wastes bandwidth and cache capacity.
- A 64-byte line is the granularity of coherence between cores, which is why
  **false sharing** (two cores writing different variables that happen to share
  a line) is so destructive. False sharing has its own dedicated lesson; just
  note here that the *line*, not the variable, is the coherence unit.

```cpp
#include <new>      // std::hardware_destructive_interference_size (C++17)
#include <cstddef>

// Portable-ish constant for the cache line size. Often 64.
constexpr std::size_t kCacheLine =
    std::hardware_destructive_interference_size; // typically 64
```

## How a cache actually finds a line: sets and ways

A cache is an array of lines organized into **sets**. A given memory address
maps to exactly one set (chosen by some middle bits of the address), and within
that set there are *N* slots called **ways** — this is an **N-way
set-associative** cache. To look something up, the hardware indexes the set,
then compares the address **tag** against all *N* ways in parallel.

```text
Physical address (simplified):
  +-------------------+--------------+-------------+
  |        tag        |  set index   | line offset |
  +-------------------+--------------+-------------+
   (identifies line)   (picks a set)  (byte within
                                        the 64B line)
```

- A typical L1 is **8-way**, L2/L3 higher (e.g. 16-way). You don't usually need
  the exact numbers; you need the *consequence*: only *N* lines whose addresses
  collide on the same set can be cached at once.
- If more than *N* hot lines map to the same set, they evict each other even
  though the cache as a whole is mostly empty — a **conflict miss**. This is why
  power-of-two strides (e.g. walking a 2D array by a large power-of-two
  row-stride) can be pathologically slow: all your accesses land in a handful of
  sets. Ostrovsky's *Gallery of Processor Cache Effects* has the classic
  demonstration of this exact effect.

### Inclusive vs exclusive

When a line lives in L1, does it *also* occupy space in L2/L3?

- **Inclusive** (older Intel LLCs): everything in L1/L2 is also in L3. Simplifies
  coherence (the LLC knows what every core caches) but "wastes" LLC capacity.
- **Exclusive** (many AMD designs): a line is in at most one level, maximizing
  effective total capacity.
- **Non-inclusive/NINE** (recent Intel): a hybrid.

For interviews, know the distinction and *why* it exists (coherence simplicity
vs effective capacity); you rarely tune against it directly.

## The three (plus one) kinds of cache miss

Classic taxonomy — the "three Cs," plus coherence:

1. **Compulsory (cold) miss:** the first time you ever touch a line. Unavoidable
   in principle, but **prefetching** can hide its latency.
2. **Capacity miss:** your working set is bigger than the cache, so lines get
   evicted before reuse. Fix: shrink the working set or **block/tile** the
   algorithm so it reuses data while it's hot.
3. **Conflict miss:** too many hot lines map to the same set (associativity
   ran out), as above. Fix: change strides/layout to spread accesses.
4. **Coherence miss:** another core invalidated your line (true or false
   sharing). Fix: separate per-core data; pad to a cache line.

## Sequential vs random: the prefetcher's playground

Modern CPUs contain **hardware prefetchers** that watch your access stream and
fetch lines *before* you ask for them, hiding compulsory-miss latency:

- **Next-line / streaming prefetcher:** detects forward (or backward) sequential
  access and pulls the following lines.
- **Stride prefetcher:** detects a constant stride (`p += k` each iteration) and
  predicts ahead.

The consequence is dramatic and is the heart of "cache-friendly" code:

- **Sequential access** (a `std::vector` walked front-to-back) trains the
  prefetcher perfectly. Effective latency approaches L1 even when the data
  starts in DRAM, because the data arrives before you need it.
- **Random access** (hash tables, linked lists, pointer graphs) defeats the
  prefetcher entirely. Every access risks a full DRAM-latency stall because the
  hardware can't predict where you'll go next. This is why **pointer chasing is
  slow**: each `node = node->next` has a *data dependency* on the load that just
  completed, so the misses **serialize** — you pay ~100 ns, *then* compute the
  next address, *then* pay another ~100 ns. There is no parallelism to hide
  behind.

```cpp
// Pointer chasing: a textbook latency trap.
long sum_list(const Node* n) {
    long s = 0;
    while (n) {           // each load of n->next may miss to DRAM,
        s += n->value;    // and the NEXT iteration cannot even start
        n  = n->next;     // until this load resolves -> misses serialize.
    }
    return s;
}
```

Contrast with a vector, where the addresses are known in advance, misses can be
*in flight simultaneously* (memory-level parallelism), and the prefetcher
front-runs you.

## The classic example: row-major vs column-major traversal

C and C++ store 2D arrays **row-major**: `m[i][j]` and `m[i][j+1]` are adjacent
in memory. Walking along a row is sequential (great); walking down a column
jumps by a full row each step (terrible — often a new cache line, and possibly a
conflict-prone power-of-two stride).

```cpp
#include <vector>
constexpr int N = 4096;
std::vector<float> m(static_cast<std::size_t>(N) * N);

// CACHE-FRIENDLY: inner loop strides by 1 element (sequential).
// Each cache line of 16 floats is fully used; prefetcher loves it.
double sum_rowmajor() {
    double s = 0;
    for (int i = 0; i < N; ++i)
        for (int j = 0; j < N; ++j)
            s += m[i * N + j];   // contiguous: m[..], m[..+1], m[..+2] ...
    return s;
}

// CACHE-HOSTILE: inner loop strides by N elements (a whole row apart).
// Each access likely touches a fresh 64B line; 15/16 of every fetched
// line is wasted, and the working set blows past L1/L2.
double sum_colmajor() {
    double s = 0;
    for (int j = 0; j < N; ++j)
        for (int i = 0; i < N; ++i)
            s += m[i * N + j];   // stride N*4 bytes between accesses
    return s;
}
```

Both loops execute the **same number of arithmetic operations** and touch the
**same data**. The only difference is *order*. The row-major version is
typically **several times faster** (Drepper and Ostrovsky measure ratios that
grow with the matrix size as it spills out of each cache level). I deliberately
quote no single magic number — the ratio depends on sizes and machine — but the
*direction* is unambiguous and is the point.

> **Interview framing:** "Same flops, different memory order, multiple-x
> difference." If you can explain *why* (cache lines + prefetcher + working-set
> size), you've demonstrated the whole topic.

## Data layout: AoS vs SoA, and struct padding

How you lay out records determines how much of every fetched cache line you
actually use.

**Array of Structs (AoS)** — intuitive, but if a hot loop only reads one field,
you drag the cold fields into cache too:

```cpp
struct OrderAoS {     // 32 bytes; half a cache line
    double price;     // hot in this loop
    double size;
    uint64_t id;      // cold here
    uint64_t ts;      // cold here
};
std::vector<OrderAoS> book;

double avg_price() {                  // touches only .price, but each
    double s = 0;                     // 64B line carries 2 whole records,
    for (const auto& o : book)        // i.e. you fetch size/id/ts you
        s += o.price;                 // never read -> wasted bandwidth.
    return s;
}
```

**Struct of Arrays (SoA)** — columns are contiguous, so a single-field scan uses
100% of every cache line and vectorizes cleanly:

```cpp
struct BookSoA {
    std::vector<double>   price;   // contiguous, fully-used lines
    std::vector<double>   size;
    std::vector<uint64_t> id;
    std::vector<uint64_t> ts;
};
BookSoA book;

double avg_price(const BookSoA& b) {
    double s = 0;
    for (double p : b.price) s += p;   // pure sequential stream
    return s;
}
```

SoA is a staple of HFT and game engines precisely because hot loops touch a
*subset* of fields. The trade-off: operating on a *whole record at once* (e.g.
serializing one order) is friendlier in AoS. Choose by access pattern.

**Padding** matters too. The compiler inserts padding to satisfy alignment, and
field order changes the size:

```cpp
struct Bad  { char a; double b; char c; };  // sizeof == 24 (padding around a,c)
struct Good { double b; char a; char c; };  // sizeof == 16 (fields by size, big->small)
```

Smaller, denser structs fit more records per line and per cache. Order fields
**largest-to-smallest** as a default to minimize padding.

## Software prefetching — the scalpel, not the hammer

When *you* know an address you'll need soon but the hardware prefetcher can't
predict it (irregular but foreseeable access — e.g. you're about to chase into a
hash bucket whose index you just computed), you can issue an explicit prefetch:

```cpp
#include <xmmintrin.h>   // _mm_prefetch + locality hints (_MM_HINT_T0 ...)

void process(const Item* items, const int* idx, int n) {
    constexpr int kAhead = 8;            // prefetch distance (tune empirically)
    for (int i = 0; i < n; ++i) {
        if (i + kAhead < n)
            // Bring the future, hard-to-predict line toward L1 now.
            __builtin_prefetch(&items[idx[i + kAhead]], /*rw=*/0, /*locality=*/3);
            // GCC/Clang. Equivalent: _mm_prefetch(ptr, _MM_HINT_T0);
        consume(items[idx[i]]);          // by the time we get here, it's warm
    }
}
```

`__builtin_prefetch(addr, rw, locality)`: `rw=0` read / `1` write; `locality`
`0..3` is the temporal hint (3 = keep in all levels, 0 = streaming/non-temporal,
evict soon). It compiles to the x86 `PREFETCHT0/T1/T2/NTA` instructions:

```x86asm
prefetcht0  [rax]    ; fetch line into all cache levels (locality 3)
prefetchnta [rax]    ; non-temporal: into L1, hint "don't pollute L2/L3"
```

> **Honest caveat (and a great interview point):** software prefetch is
> *frequently a net loss*. The hardware prefetcher is excellent for regular
> patterns, and a wrong prefetch distance/issue costs an instruction slot and
> can evict useful data. Use it only for *irregular but predictable* access, and
> only when you've **measured** an improvement. The bigger wins are almost
> always in **layout and access order**, not in sprinkling prefetch hints.

## Quant/HFT relevance & interview gotchas

- **Design data structures around the cache, not the textbook.** A flat
  `std::vector` walked sequentially crushes a "clever" `std::list` or
  pointer-tree of the same size, because of prefetching and contiguity.
  `std::list`, `std::map` (a red-black tree of separately-allocated nodes), and
  node-based `std::unordered_map` are all **pointer-chasing latency traps**.
  Prefer contiguous containers; for maps, prefer open-addressing/flat hash maps
  (`absl::flat_hash_map`, `boost::unordered_flat_map`).
- **Hot/cold splitting:** keep the fields touched on every message together and
  dense (SoA or a tight hot struct); push rarely-used fields elsewhere so the
  hot working set fits in L1/L2.
- **Working-set sizing is a real design constraint.** "Will this fit in L2?" is
  a question you should be able to answer in bytes. A ring buffer or order book
  sized to live in L1/L2 behaves categorically differently from one that spills
  to DRAM.
- **NUMA:** on a dual-socket box, memory allocated on the *other* socket adds
  latency and bandwidth contention. Pin threads and allocate locally
  (`numactl`, `first-touch`). Interviewers love "what's NUMA and why do you
  care?"
- **Beware microbenchmarks that fit in L1.** A structure that benchmarks great
  at 1 K elements may fall off a cliff at 1 M because it no longer fits in
  cache. Always test at production working-set sizes.
- **Common gotcha:** "this loop does the same work, why is it 5× slower?" —
  answer in terms of stride, cache lines, prefetcher, and working set, not
  instruction count.
- **Don't conflate latency and bandwidth.** Sequential streaming can saturate
  memory *bandwidth* even with the prefetcher hiding *latency*; random access is
  limited by latency and memory-level parallelism (how many misses you can keep
  in flight at once).

## Key takeaways

1. Memory is a steep hierarchy: **L1 ≈ 1 ns, L2 ≈ 3–4 ns, L3 ≈ 10–20 ns, DRAM
   ≈ 100 ns**. A DRAM miss is ~100× an L1 hit and ~hundreds of `ADD`s.
2. The unit of transfer is the **64-byte cache line**, not the byte. Spatial
   locality is "use the rest of the line you already paid for."
3. Caches are **set-associative**; too many hot lines mapping to one set cause
   **conflict misses** (watch power-of-two strides). Misses are **compulsory /
   capacity / conflict / coherence**.
4. **Sequential access trains hardware prefetchers** and exposes memory-level
   parallelism; **random access / pointer chasing serializes DRAM misses** and
   is the dominant HFT performance killer.
5. **Layout is destiny:** prefer contiguous containers, use **SoA** for
   field-scanning hot loops, order struct fields largest-to-smallest to cut
   padding, and size your working set to fit the cache you target.
6. **Software prefetch** (`__builtin_prefetch`/`_mm_prefetch`) is a scalpel for
   irregular-but-predictable access — measure it; it often hurts.

## Self-check

1. A DRAM miss costs ~100 ns. Roughly how many register-to-register `ADD`s could
   the core have retired in that time, and why does that make you "latency-bound,
   not compute-bound"?
2. You walk a 4096×4096 `float` matrix by column instead of row. Explain, in
   terms of cache lines *and* set associativity, the two distinct reasons it's
   slow.
3. Why does iterating a `std::list<int>` of N elements typically lose badly to a
   `std::vector<int>` of the same N, even though both are O(N)?
4. You have `struct Tick { uint64_t id; char side; double px; };`. What is its
   size and why? Reorder the fields to minimize it.
5. When is `__builtin_prefetch` likely to *help*, and when is it likely to
   *hurt*? Give a concrete example of each.
6. Your order book benchmarks beautifully at 10 K entries and falls off a cliff
   at 5 M. What changed, and how would you confirm it?

## Further reading

- Ulrich Drepper, [**What Every Programmer Should Know About Memory**](https://lwn.net/Articles/250967/) — the definitive long-form treatment; the cache and prefetch sections are essential.
- Igor Ostrovsky, [**Gallery of Processor Cache Effects**](http://igoro.com/archive/gallery-of-processor-cache-effects/) — short, vivid experiments (line size, associativity, false sharing) you can reproduce.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 6 (The Memory Hierarchy) — the canonical textbook chapter, including the "memory mountain."
- [Agner Fog's optimization manuals](https://www.agner.org/optimize/) — `microarchitecture.pdf` covers real cache sizes, associativity, and prefetchers per CPU.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — the standard's handle on cache-line size.
- [`_mm_prefetch` — Intel Intrinsics Guide](https://www.intel.com/content/www/us/en/docs/intrinsics-guide/index.html) and [GCC `__builtin_prefetch` docs](https://gcc.gnu.org/onlinedocs/gcc/Other-Builtins.html).
- Intel® 64 and IA-32 Architectures [Optimization Reference Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) — the prefetcher and cache-tuning chapters.
- [CPU cache — Wikipedia](https://en.wikipedia.org/wiki/CPU_cache) — solid overview of sets/ways, inclusion policies, and replacement.

## Videos

- Scott Meyers — **"CPU Caches and Why You Care"** ([search](https://www.youtube.com/results?search_query=Scott+Meyers+CPU+Caches+and+Why+You+Care)) — the classic, highly-recommended talk on exactly this material.
- Mike Acton — **"Data-Oriented Design and C++"** (CppCon) ([search](https://www.youtube.com/results?search_query=Mike+Acton+Data-Oriented+Design+and+C%2B%2B+CppCon)) — AoS vs SoA and designing for the cache, from a games angle that transfers directly to HFT.
- Timur Doumler — **"Want fast C++? Know your hardware!"** ([search](https://www.youtube.com/results?search_query=Timur+Doumler+want+fast+C%2B%2B+know+your+hardware)) — caches, lines, and layout for performance.
