# Odd one out!

> **Why a quant dev must own this:** Interviews — and worse, production
> incidents — rarely hand you a clean "explain X" prompt. They hand you a set of
> things that *look* equivalent and ask which one bites. *Spotting the one
> snippet in five that has UB, the one layout that crosses a cache line, the one
> asm sequence that serializes a pipeline is the actual job.* This capstone takes
> the six CPU Architecture Basics lessons off the page and makes you use them
> adversarially: six puzzles, each "which of these is the odd one out, and
> **why**?" Cover the answer, think, then read on.

## How to use this lesson

Each puzzle is a small set of candidates — code snippets, type layouts, asm
sequences, or hardware behaviours — that are *deliberately* similar. Exactly one
differs in a subtle, load-bearing way. For each:

1. Decide which is the odd one out **before** reading the answer.
2. Articulate the *principle*, not just the verdict — "C is UB" is half an
   answer; "C is UB because the shift count equals the operand width" is the
   whole one.
3. If you can, predict what the compiler emits. The senior move is to reach for
   [Compiler Explorer](https://godbolt.org/) and confirm.

The six puzzles map one-to-one onto the six sibling lessons (bitwise ops, binary
representation, endianness, registers & assembly, cache hierarchy, pipelining &
ILP). If a puzzle stings, that lesson is where to go back.

---

## Puzzle 1 — Bitwise operations: four "power of two" tests

Four functions claim to test "is `x` a power of two?" Three are correct (or
correct enough); one is **wrong or undefined** for at least one valid input.
Which is the odd one out?

```cpp
#include <bit>
#include <cstdint>

bool A(uint32_t x) { return x && !(x & (x - 1)); }
bool B(uint32_t x) { return std::has_single_bit(x); }
bool C(uint32_t x) { return std::popcount(x) == 1; }
bool D(uint32_t x) { return (x & (x - 1)) == 0; }
```

### Answer

**`D` is the odd one out.** It returns `true` for `x == 0`.

For a true power of two, exactly one bit is set, and `x & (x - 1)` clears the
lowest set bit, yielding `0`. But for `x == 0`, `x - 1` underflows the unsigned
type to `0xFFFFFFFF`, and `0 & 0xFFFFFFFF == 0` — so `D(0)` is `true` even though
zero is *not* a power of two. `A` guards this with the leading `x &&`; `B` and
`C` handle it by construction (`has_single_bit(0)` is `false`; `popcount(0)` is
`0`, not `1`).

> **Principle:** the `x & (x - 1)` idiom detects "at most one set bit", which
> includes zero. The power-of-two test needs the extra `x != 0`. This is the
> single most common off-by-one in bit-twiddling interviews. Note that the
> unsigned wraparound in `0 - 1` is *defined* (modular), so there's no UB here —
> just a wrong answer, which is arguably more dangerous.

A tempting "gotcha that isn't": you might suspect `A`'s `x - 1` is the problem,
but `A` short-circuits on `x == 0` and never evaluates the rest. And all four are
fine for `x == 1` (`true`, since 1 = 2⁰).

---

## Puzzle 2 — Binary representation: five comparisons, one surprising result

Each line below is a single comparison. Four evaluate the way naive intuition
expects; one quietly returns the **opposite** of what it looks like. Which?

```cpp
#include <cstdint>
#include <vector>

std::vector<int> v(3);
int      i  = -1;
unsigned u  = 1;

bool P = (-1 < 0);                      // (1)
bool Q = (i < u);                       // (2)
bool R = (v.size() > -1);               // (3)
bool S = (3.0 == 3);                    // (4)
bool T = ((char)-1 < (unsigned char)0); // (5)  assume signed char
```

### Answer

Two lines (`Q` and `R`) are *both* victims of signed→unsigned conversion, but the
one most people get wrong — the **intended odd one out** — is **`R`:
`v.size() > -1` is `false`.**

`v.size()` has type `std::size_t` (unsigned). In the usual arithmetic
conversions, when an unsigned and a signed operand of equal-or-greater rank meet,
**the signed operand converts to unsigned**. So `-1` becomes `SIZE_MAX`
(`0xFFFF...FFFF`), and `3 > SIZE_MAX` is `false`. The line *reads* as an
always-true sanity check ("size is greater than -1") and is in fact always
`false`. This pattern — comparing a `.size()` against a signed sentinel, or
looping `for (size_t k = n - 1; k >= 0; --k)` — is a perennial production bug.

`Q` (`i < u`) is the same mechanism and is also `false` (the textbook
`-1 < 1u == false`), but it *looks* suspicious, so it's the decoy that trains you
to suspect the wrong line. `P` is plain signed arithmetic (`true`). `S` promotes
the `int 3` to `double 3.0`, exactly representable, so `true` — no float trap
here. `T`: `(char)-1` and `(unsigned char)0` both promote to **`int`** first
(integer promotion to `int`, not `unsigned int`, because `int` can hold every
`unsigned char` value), giving `-1 < 0 == true` — the expected result, *not* a
sign-conversion trap, because the promotion target is signed.

> **Principle:** the danger isn't "unsigned is involved", it's "signed and
> unsigned of comparable rank meet, and the signed side silently becomes huge."
> `unsigned char`/`char` are *narrower than `int`*, so they promote to `int` and
> dodge it; `size_t`/`unsigned` are `int`-rank-or-wider, so they trigger it. Fix
> with C++20 `std::cmp_less(a, b)` / `std::ssize(v)`, and compile with
> `-Wsign-compare -Wconversion`.

---

## Puzzle 3 — Endianness: four ways to read a big-endian `uint32`

A wire protocol sends a 32-bit field in **big-endian** (network) order. Four
deserializers are below. Three produce the correct value on a typical
little-endian x86-64 host; one is **wrong, non-portable, or undefined**. Which is
the odd one out?

```cpp
#include <bit>
#include <cstdint>
#include <cstring>
#include <arpa/inet.h>

// A: assemble by value from bytes (the "Byte Order Fallacy" way)
uint32_t A(const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16)
         | (uint32_t(p[2]) << 8)  |  uint32_t(p[3]);
}

// B: memcpy then host-from-network
uint32_t B(const uint8_t* p) {
    uint32_t n; std::memcpy(&n, p, 4);
    return ntohl(n);
}

// C: reinterpret the buffer as a uint32 and byteswap
uint32_t C(const uint8_t* p) {
    return std::byteswap(*reinterpret_cast<const uint32_t*>(p));
}

// D: memcpy then byteswap on a little-endian host
uint32_t D(const uint8_t* p) {
    uint32_t n; std::memcpy(&n, p, 4);
    return std::byteswap(n);   // assumes LE host
}
```

### Answer

**`C` is the odd one out** — it commits the classic three-sins-in-one-line
mistake. `reinterpret_cast<const uint32_t*>(p)` then dereferencing is wrong on:

- **Alignment.** `p` points into a byte buffer with no guarantee of 4-byte
  alignment. A misaligned 32-bit load is UB in C++ and, on some architectures
  (and for SIMD/atomics even on x86), faults or tears. `memcpy` (in `B`/`D`)
  expresses an unaligned load *correctly* and the compiler folds it to a single
  `mov` when the target allows.
- **Strict aliasing.** Reading the bytes through a `uint32_t` lvalue that doesn't
  actually name a `uint32_t` object is undefined behaviour the optimizer may
  exploit; the blessed path is to copy through `char`/`memcpy` or `std::bit_cast`.

`A` is portable and correct on *any* host (it assembles by value — no dependence
on the machine's byte order). `B` and `D` both copy first (defined) and then
convert; `B` is portable (`ntohl` is a no-op on a BE host, a swap on LE), while
`D` hard-codes "host is little-endian" and would be *wrong on a big-endian host*
— but the puzzle specified a little-endian x86-64 host, so on *this* machine `D`
is correct. `C` is wrong on essentially every machine.

> **Principle:** never `reinterpret_cast` a byte buffer to a wider scalar. The
> bug is not (only) endianness — it's alignment + aliasing. Use `memcpy`/
> `bit_cast` into a local, or assemble by value. `D`'s sin is lesser
> (non-portable), `A`'s is none. If the trap you spotted was "`D` assumes LE",
> good instinct — but `C`'s misaligned aliasing load is the genuinely *undefined*
> one, which beats merely non-portable.

---

## Puzzle 4 — Registers & assembly: which sequence does something different?

Below are four x86-64 (Intel syntax) ways to put zero into `eax`. Three are
functionally equivalent and the canonical choices; one has a **materially
different microarchitectural side effect**. Which is the odd one out, and what's
the effect?

```x86asm
; A
xor   eax, eax
; B
mov   eax, 0
; C
sub   eax, eax
; D
and   eax, 0
```

### Answer

**`D` is the odd one out.** `and eax, 0` produces the value zero like the others,
but it is **not recognized as a zeroing idiom** and it has a **true data
dependency on the old value of `eax`**: the AND must read the previous `eax`
before it can produce the result.

`xor eax, eax` (A) and `sub eax, eax` (C) are *dependency-breaking zeroing
idioms*: the CPU's register renamer recognises that the result is unconditionally
zero regardless of the input, so it breaks the dependence on the prior `eax`,
frees that physical register early, and in many cases the op is handled at rename
with **zero execution-port cost and zero latency**. `mov eax, 0` (B) also writes
a constant independent of the old value (no false dependency), and on modern
cores is comparably cheap, though it carries an immediate and is one byte longer.
`and eax, 0` enjoys *none* of this: it occupies an ALU port and, crucially,
chains onto whatever last wrote `eax`, which can extend a dependency chain and
**limit instruction-level parallelism** (see the pipelining lesson) in a tight
loop.

As a bonus, writing the 32-bit subregister `eax` zero-extends into the full
`rax` (clearing the upper 32 bits) — true for all four — so none of them leaves a
partial-register stall. The differentiator is purely the dependency-breaking
property.

> **Principle:** `xor reg, reg` is the idiomatic zero precisely because it's
> dependency-breaking and recognised by the front-end — it's *the* answer to
> "why does the compiler emit `xor` instead of `mov 0`?" The lesson generalises:
> two instructions can compute the same value yet differ enormously in latency
> and in how they serialize the out-of-order engine. Compilers know these idioms;
> hand-written asm that uses `and reg, 0` is a red flag.

---

## Puzzle 5 — Cache hierarchy: four loops, one cache behaviour

All four loops below sum the same `N×N` `int` matrix stored **row-major** in a
contiguous array (`a[r * N + c]`). Three exhibit essentially the same, good
cache behaviour; one is dramatically slower for large `N`. Which is the odd one
out, and why?

```cpp
#include <cstdint>
constexpr int N = 4096;

long A(const int* a) {                       // row-major sweep
    long s = 0;
    for (int r = 0; r < N; ++r)
        for (int c = 0; c < N; ++c) s += a[r * N + c];
    return s;
}

long B(const int* a) {                       // linear over the flat buffer
    long s = 0;
    for (long i = 0; i < (long)N * N; ++i) s += a[i];
    return s;
}

long C(const int* a) {                       // column-major sweep
    long s = 0;
    for (int c = 0; c < N; ++c)
        for (int r = 0; r < N; ++r) s += a[r * N + c];
    return s;
}

long D(const int* a) {                       // row-major, two accumulators
    long s0 = 0, s1 = 0;
    for (int r = 0; r < N; ++r)
        for (int c = 0; c < N; c += 2) {
            s0 += a[r * N + c];
            s1 += a[r * N + c + 1];
        }
    return s0 + s1;
}
```

### Answer

**`C` is the odd one out** — the column-major sweep. It walks down a column,
which means consecutive accesses are `N * sizeof(int) = 16 KB` apart in memory.

A cache line is **64 bytes** (16 `int`s). `A`, `B`, and `D` all stride through
memory sequentially: each 64-byte line is fetched once and all 16 ints in it are
consumed before moving on (spatial locality), and the hardware **stride/streaming
prefetcher** runs ahead so the data is usually already in L1/L2 by the time the
loop needs it. `C` touches one int per line, then jumps 16 KB to the next row;
by the time it comes back to the next column, those lines have long been evicted.
For an `N` this large the working set (64 MB) dwarfs the L1/L2/L3, so `C` suffers
a near-miss on essentially every access and is bottlenecked on DRAM
(~tens of ns per access, ~hundreds of cycles) instead of L1 (~4 cycles, ~1 ns).
The order-of-magnitude slowdown is the canonical demonstration of why memory
*layout* dominates *asymptotic* operation count: all four do exactly `N²` adds.

`D` is a deliberate decoy: it changes the *computation* (two independent
accumulators, which actually helps ILP — see Puzzle 6) but the *access pattern*
is still sequential, so its cache behaviour matches `A`/`B`. Spotting that `D`
differs in arithmetic but not in cache traffic is the senior insight.

> **Principle:** complexity counts operations; the hardware counts cache lines.
> The same `O(N²)` work is fast or slow depending purely on whether you stride
> *along* cache lines (and let the prefetcher help) or *across* them. This is the
> motivation for cache-friendly layouts, blocking/tiling, and structure-of-arrays
> in market-data and matrix code.

---

## Puzzle 6 — Pipelining & ILP: four reductions, one serial chain

Each function sums an array of `double`. Three expose enough independent work for
the out-of-order engine to keep multiple FP adders busy; one is **latency-bound
by a single dependency chain** and runs several times slower despite doing the
same number of additions. Which is the odd one out? (Assume `-O2`, *not*
`-ffast-math`, so the compiler may not reassociate FP for you.)

```cpp
#include <cstddef>

double A(const double* x, size_t n) {          // single accumulator
    double s = 0.0;
    for (size_t i = 0; i < n; ++i) s += x[i];
    return s;
}

double B(const double* x, size_t n) {          // four accumulators, unrolled
    double s0=0, s1=0, s2=0, s3=0;
    size_t i = 0;
    for (; i + 4 <= n; i += 4) { s0+=x[i]; s1+=x[i+1]; s2+=x[i+2]; s3+=x[i+3]; }
    for (; i < n; ++i) s0 += x[i];
    return (s0 + s1) + (s2 + s3);
}

double C(const double* x, size_t n) {          // pairwise / tree reduction
    if (n == 1) return x[0];
    if (n == 0) return 0.0;
    return C(x, n/2) + C(x + n/2, n - n/2);
}

double D(const double* x, size_t n) {          // two accumulators
    double s0=0, s1=0;
    size_t i = 0;
    for (; i + 2 <= n; i += 2) { s0 += x[i]; s1 += x[i+1]; }
    if (i < n) s0 += x[i];
    return s0 + s1;
}
```

### Answer

**`A` is the odd one out.** It carries a single accumulator `s`, so every
iteration's `s += x[i]` depends on the previous iteration's result. That is a
**loop-carried dependency** through one `double`. FP add on modern x86 has a
**latency of ~3-4 cycles** but a **throughput of ~2 per cycle** (two FP-add
ports on recent cores). With one chain you pay the *latency* every step — a new
add can't start until the prior one retires — so the loop runs at roughly one add
per 3-4 cycles and the second adder sits idle. You're latency-bound, not
throughput-bound.

`B` (four accumulators), `C` (a tree reduction), and `D` (two accumulators) all
break the single chain into *independent* sub-chains. Independent adds can be
in flight simultaneously, so the out-of-order scheduler fills both FP-add ports
and the loop approaches the *throughput* limit — roughly the FP-add latency
divided by the number of independent accumulators, until you saturate the ports
(so ~2 accumulators already recovers most of the win on a 2-port machine; more
helps hide latency and enable vectorization). Same number of additions in every
version; the difference is purely how much independent work is exposed to the
ILP machinery.

The reason the compiler won't silently turn `A` into `B` for you: floating-point
addition is **not associative** (`(a+b)+c ≠ a+(b+c)` in general due to rounding),
so reassociating the sum changes the result. Under plain `-O2` the compiler must
preserve your association; only `-ffast-math` (or an explicit
`#pragma omp simd reduction`) frees it to reassociate and vectorize — at the cost
of bit-exact reproducibility, which is exactly why pricing/PnL code is wary of
`-ffast-math`.

> **Principle:** throughput ≠ latency. A dependency chain serializes execution at
> the *latency* of each link no matter how many execution ports exist; exposing
> independent operations (multiple accumulators, tree reductions) lets
> superscalar/out-of-order hardware run them in parallel. And the compiler can
> only restructure your FP math if you let it (`-ffast-math`), which trades
> reproducibility for speed — a real decision in quant code.

---

## Cross-puzzle synthesis: what to look for

When someone shows you "N nearly-identical things," scan for these categories —
each puzzle above is one instance:

| Category | The tell | Lesson |
|----------|----------|--------|
| **Undefined / wrong-on-edge** | edge input (0, `INT_MIN`, shift = width) breaks one case | Bitwise / Binary |
| **Silent type conversion** | signed meets unsigned of ≥`int` rank; small types promote to `int` | Binary representation |
| **Aliasing / alignment** | `reinterpret_cast` over a byte buffer; misaligned wide load | Endianness |
| **Microarchitectural idiom** | same *value*, different *dependency* / port cost (`xor` vs `and 0`) | Registers / Pipelining |
| **Access pattern** | same *ops*, different *cache-line traffic* (row vs column) | Cache hierarchy |
| **Dependency chains** | same *additions*, different *ILP* (one vs many accumulators) | Pipelining / ILP |

Notice the recurring meta-lesson: **"same result" and "same operation count" are
not "same behaviour."** Two expressions can compute the identical value and
differ by an order of magnitude in latency (Puzzle 6), by a cache miss per access
(Puzzle 5), by a false dependency (Puzzle 4), or by being *correct vs undefined*
(Puzzles 1–3). The whole point of understanding the machine beneath the language
is to see those differences without running the code — though you should always
confirm on [Compiler Explorer](https://godbolt.org/) and with a profiler.

## Quant/HFT relevance & interview gotchas

- **This is the interview format.** "Here are four implementations of `parse` /
  `sum` / `is_power_of_two` — which would you ship and why?" rewards exactly the
  reflex these puzzles drill: find the edge-case UB, the sign-conversion, the
  misaligned cast, the latency-bound chain.
- **Production failures look like Puzzle 2 and 3.** A `size()`-vs-signed
  comparison that's always false, or a `reinterpret_cast` feed parser that works
  on the dev box and tears under load, are real outage post-mortems.
- **Puzzles 5 and 6 are the hot-path optimisation playbook.** Layout for
  cache-line locality first; then break dependency chains to expose ILP and
  enable vectorization. They compound: a row-major sweep with multiple
  accumulators is both cache- and ILP-friendly.
- **Know the `xor`-zeroing answer cold** (Puzzle 4) — it's a frequent "why does
  the compiler do this?" question and a clean window into register renaming and
  dependency breaking.
- **Always offer to check the asm/profiler.** Saying "I'd confirm on godbolt and
  with `perf stat`" signals you reason from the machine, not from folklore.

## Key takeaways

1. The `x & (x - 1) == 0` idiom matches **zero too**; a power-of-two test needs
   the extra `x != 0`. Edge inputs are where "equivalent" snippets diverge.
2. Signed/unsigned comparisons go wrong when the signed operand meets an unsigned
   one of rank ≥ `int` (`size_t`, `unsigned`); types narrower than `int` promote
   to `int` and are safe. Use `std::cmp_*` / `std::ssize`.
3. Never `reinterpret_cast` a byte buffer to a wider scalar — it's an
   alignment + strict-aliasing bug, worse than a mere endianness/portability
   slip. `memcpy`/`bit_cast`/assemble-by-value instead.
4. `xor reg, reg` and `sub reg, reg` are dependency-breaking, front-end-recognised
   zeroing idioms; `and reg, 0` computes zero but keeps a false dependency and an
   ALU port — same value, worse microarchitecture.
5. Identical operation counts can mean wildly different runtimes: the column sweep
   loses to cache-line traffic; the single-accumulator sum loses to a
   loop-carried latency chain. **Layout and dependencies, not just Big-O.**

## Self-check

1. Why does `D` in Puzzle 1 wrongly return `true` for `x == 0`, and is the
   `0u - 1` it relies on undefined behaviour or defined?
2. In Puzzle 2, explain precisely why `v.size() > -1` is `false` but
   `(char)-1 < (unsigned char)0` is `true`.
3. Name the *two distinct* defects in `reinterpret_cast<const uint32_t*>(p)` from
   Puzzle 3 and the idiomatic fix for each.
4. Why does the compiler prefer `xor eax, eax` over `mov eax, 0` and over
   `and eax, 0`? What property does the first have that the last lacks?
5. All four loops in Puzzle 5 do `N²` additions. Explain, in terms of cache lines
   and the hardware prefetcher, why the column-major one is an order of magnitude
   slower for large `N`.
6. Why can't `-O2` turn the single-accumulator sum (Puzzle 6 `A`) into the
   multi-accumulator version, and what flag would let it? What is the cost of
   that flag for a PnL calculation?

## Further reading

- Sean Eron Anderson, [**Bit Twiddling Hacks**](https://graphics.stanford.edu/~seander/bithacks.html) — the source for the power-of-two and lowest-set-bit idioms in Puzzle 1.
- [`std::cmp_less` and the integer comparison functions — cppreference](https://en.cppreference.com/w/cpp/utility/intcmp) — the correct fix for Puzzle 2.
- Rob Pike, [**The Byte Order Fallacy**](https://commandcenter.blogspot.com/2012/04/byte-order-fallacy.html) — why Puzzle 3's `A` (assemble-by-value) is the right default.
- Agner Fog, [**Optimizing subroutines in assembly language**](https://www.agner.org/optimize/) and the **instruction tables** — covers dependency-breaking idioms (Puzzle 4) and FP add latency/throughput (Puzzle 6).
- Ulrich Drepper, [**What Every Programmer Should Know About Memory**](https://www.akkadia.org/drepper/cpumemory.pdf) — the definitive treatment behind Puzzle 5's cache behaviour.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, ch. 2 (representation), ch. 3 (machine code), ch. 5 (optimizing for ILP), ch. 6 (the memory hierarchy) — one book covering all six puzzles.
- [Compiler Explorer (godbolt.org)](https://godbolt.org/) — confirm every claim above by inspecting the generated assembly.

## Videos

- Matt Godbolt, *CppCon* — **"What Has My Compiler Done for Me Lately? Unbolting the Compiler's Lid"** ([search](https://www.youtube.com/results?search_query=CppCon+Matt+Godbolt+what+has+my+compiler+done+for+me+lately)) — reading asm to tell equivalent-looking code apart.
- Chandler Carruth, *CppCon* — **"Efficiency with Algorithms, Performance with Data Structures"** ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+efficiency+with+algorithms+performance+with+data+structures)) — cache and ILP intuition behind Puzzles 5 and 6.
- Carl Cook, *CppCon* — **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — the HFT framing for why every one of these distinctions matters.
