# Vectorization, SIMD, and AVX-512

> **Why a quant dev must own this:** Pricing a book of options, computing a
> rolling signal across thousands of instruments, normalizing a feed snapshot —
> these are *data-parallel* problems where one instruction can crunch 8 or 16
> values at once. SIMD is the difference between using ~12% and ~100% of a core's
> floating-point throughput. But it's also full of traps: auto-vectorization that
> silently doesn't happen, alignment faults, horizontal-reduction overhead, and
> the notorious AVX-512 frequency throttling that can make "wider" run *slower*.
> A senior quant engineer knows when SIMD wins, how to get the compiler to do it,
> and when to drop to intrinsics.

## First principles: one instruction, many data

A scalar instruction operates on one element: `c = a + b`. A **SIMD** (Single
Instruction, Multiple Data) instruction operates on a *vector* of elements packed
into a wide register — the same operation applied **lane**-by-lane in parallel:

```text
 scalar add:        a0 + b0 = c0

 SIMD add (8-wide): [a7 a6 a5 a4 a3 a2 a1 a0]
                  + [b7 b6 b5 b4 b3 b2 b1 b0]
                  = [c7 c6 c5 c4 c3 c2 c1 c0]   one instruction, 8 results
```

Each independent "slot" is a **lane**. A 256-bit register holds 8 `float`s (32b
each) or 4 `double`s (64b each); the same add instruction produces 8 (or 4)
results in roughly the time of one scalar add. That's the throughput multiplier.

**Packed vs scalar:** the same hardware can do a *scalar* op on the lowest lane
only (`addss` — add scalar single) or a *packed* op on all lanes (`addps` — add
packed single). Vectorization means getting the compiler/you to emit the packed
forms.

## The x86 SIMD register ladder

| ISA | Register | Width | floats / doubles | int8 |
|---|---|---|---|---|
| SSE/SSE2 | `xmm0..15` | 128 bit | 4 / 2 | 16 |
| AVX/AVX2 | `ymm0..15` | 256 bit | 8 / 4 | 32 |
| AVX-512 | `zmm0..31` | 512 bit | 16 / 8 | 64 |

AVX-512 also doubles the register *count* (32 vs 16) and — crucially — adds eight
**mask registers** `k0..k7` for predication (more below). `ymm` is the low half of
`zmm`; `xmm` the low quarter. Note AVX-512 is **not** universal: it's common on
Intel server parts (Skylake-SP, Ice Lake, Sapphire Rapids) but was fused off on
many Intel client chips, and AMD added it (as "double-pumped" 256b internally) in
Zen 4. Always check `cpuid` / `__builtin_cpu_supports` before using it.

## Auto-vectorization: let the compiler do it (and why it often won't)

The best SIMD code is often code you didn't write by hand: a clean loop the
compiler vectorizes. Enable it and write loops it can prove are safe.

```cpp
// Enable: -O3 (or -O2 -ftree-vectorize), and -march=native to allow AVX2/AVX-512.
// 'restrict' promises a and b don't alias c -> unblocks vectorization.
void axpy(float* __restrict c, const float* __restrict a,
          const float* __restrict b, float s, int n) {
    for (int i = 0; i < n; ++i)
        c[i] = a[i] + s * b[i];      // ideal: contiguous, no cross-iteration dep
}
```

The compiler emits packed FMA (`vfmadd...ps`) over 8 or 16 lanes with a scalar
remainder loop. What **blocks** auto-vectorization:

- **Potential aliasing.** If `c` might overlap `a`/`b`, the compiler must assume a
  write to `c[i]` changes a later `a[j]` — serial. Fix with `__restrict` (or
  `#pragma omp simd`, or pass non-overlapping types).
- **Loop-carried dependencies.** `x[i] = x[i-1] + a[i]` (a prefix sum / recurrence)
  can't be straightforwardly vectorized — each iteration needs the previous.
- **Non-contiguous / strided / gather access.** SIMD wants contiguous loads;
  `a[idx[i]]` needs gather (slow) and often isn't auto-vectorized.
- **Reductions in strict FP.** `sum += a[i]` reorders FP additions, which changes
  results, so the compiler won't vectorize it unless you allow it
  (`-ffast-math`/`-fassociative-math` or `#pragma omp simd reduction(+:sum)`).
- **Function calls / complex control flow** in the loop body (unless inlined /
  the function is itself vectorizable).
- **Unknown trip count or misalignment** the compiler can't reason about.

Always confirm it actually happened:

```text
gcc   -O3 -march=native -fopt-info-vec-optimized  ...   # what vectorized
gcc   -O3 -march=native -fopt-info-vec-missed     ...   # what didn't, and why
clang -O3 -march=native -Rpass=loop-vectorize -Rpass-missed=loop-vectorize ...
```

> **Interview line:** "I write loops the vectorizer can prove are safe —
> contiguous, `__restrict`, no carried deps — and I check `-fopt-info-vec` rather
> than assume." That's the senior answer; reaching for intrinsics first is the
> junior one.

## Intrinsics: when you take the wheel

When auto-vectorization can't see what you can — masked logic, a custom
reduction, shuffles, gather patterns, fixed-point math — you drop to
**intrinsics** (`#include <immintrin.h>`): C functions that map ~1:1 to SIMD
instructions, with `__m128/__m256/__m512` (float), `__m256d` (double),
`__m256i` (integer) vector types.

Here is a complete, compilable AVX2 dot product — the bread-and-butter of pricing
and signal math:

```cpp
#include <immintrin.h>
#include <cstddef>

// Dot product of two float arrays using AVX2 + FMA.
// Assumes AVX2/FMA available; handles arbitrary n with a scalar tail.
float dot_avx2(const float* a, const float* b, std::size_t n) {
    __m256 acc = _mm256_setzero_ps();          // 8-lane accumulator
    std::size_t i = 0;
    for (; i + 8 <= n; i += 8) {
        __m256 va = _mm256_loadu_ps(a + i);     // unaligned load, 8 floats
        __m256 vb = _mm256_loadu_ps(b + i);
        acc = _mm256_fmadd_ps(va, vb, acc);     // acc += va*vb, fused, per lane
    }
    // Horizontal reduction: collapse 8 lanes -> 1 scalar.
    __m128 lo = _mm256_castps256_ps128(acc);    // low 128 (lanes 0..3)
    __m128 hi = _mm256_extractf128_ps(acc, 1);  // high 128 (lanes 4..7)
    __m128 s  = _mm_add_ps(lo, hi);             // 4 partial sums
    s = _mm_hadd_ps(s, s);                      // pairwise horizontal add
    s = _mm_hadd_ps(s, s);                      // -> lane 0 holds the sum
    float result = _mm_cvtss_f32(s);
    for (; i < n; ++i) result += a[i] * b[i];   // scalar tail
    return result;
}
```

Two things to internalize from this example:

- **The accumulator is a vector**, not a scalar — you sum 8 independent partial
  sums down the loop (which also breaks the FP dependency chain, like the
  multiple-accumulators trick from the out-of-order lesson), then do **one**
  horizontal reduction at the end.
- **Horizontal operations are relatively expensive** (`hadd`, `extract`,
  cross-lane shuffles) compared to vertical (lane-parallel) ones. Reduce *once,
  outside the loop*; never inside it. This vertical-good / horizontal-costly rule
  drives how you structure SIMD code.

### Multiple vector accumulators

For maximum throughput you often want *several* vector accumulators to saturate
the FMA units' latency-vs-throughput gap (an FMA is ~4-5 cycle latency but ~2/cyc
throughput, so you need ~8-10 independent FMAs in flight):

```cpp
__m256 acc0 = _mm256_setzero_ps(), acc1 = _mm256_setzero_ps();
for (; i + 16 <= n; i += 16) {
    acc0 = _mm256_fmadd_ps(_mm256_loadu_ps(a+i),   _mm256_loadu_ps(b+i),   acc0);
    acc1 = _mm256_fmadd_ps(_mm256_loadu_ps(a+i+8), _mm256_loadu_ps(b+i+8), acc1);
}
acc0 = _mm256_add_ps(acc0, acc1);   // combine, then reduce as above
```

## Masking and predication (AVX-512's superpower)

Scalar code handles conditionals with branches; SIMD can't branch per lane. The
SSE/AVX approach is **select via mask**: compute both sides and blend with a
0/-1 lane mask (`_mm256_blendv_ps`, `_mm256_cmp_ps`). AVX-512 makes this
first-class with the **mask registers** `k0..k7`: a comparison produces a `k`
mask, and almost any instruction can be **predicated** on it — inactive lanes are
either left unchanged (`_mm512_mask_...`) or zeroed (`_mm512_maskz_...`):

```cpp
#include <immintrin.h>
// Clamp negatives to zero across 16 floats, branchlessly, with AVX-512 masks.
__m512 relu(__m512 x) {
    __mmask16 m = _mm512_cmp_ps_mask(x, _mm512_setzero_ps(), _CMP_GT_OQ);
    return _mm512_maskz_mov_ps(m, x);   // keep x where x>0, else 0
}
```

Masking is what makes AVX-512 elegant for irregular/predicated work and is a key
reason it can beat AVX2 on branchy data-parallel kernels — *when* it isn't
throttling the clock.

### Gather / scatter

When data isn't contiguous (`a[idx[i]]`), AVX2/AVX-512 offer **gather**
(`_mm256_i32gather_ps`) and AVX-512 adds **scatter**. They let you vectorize
indexed access, but each is internally many memory accesses — gather is typically
*much* slower than a contiguous load and frequently not worth it. Prefer
restructuring data to be contiguous (SoA — see the cache lesson) over leaning on
gather.

## The AVX-512 frequency-throttling caveat (real and important)

Wider is not automatically faster. Running 512-bit instructions — *especially*
the heavy FP/FMA ones — draws enough power that many Intel server parts
(notably Skylake-SP through Cascade Lake) **drop the core (and sometimes
package) clock frequency** while AVX-512 (and to a lesser extent AVX2) code runs,
and for a recovery window afterward. The effect (approximate, part-dependent):

- Light AVX-512 (loads/logic) — little or no downclock.
- Heavy AVX-512 (FMA-dense) — a meaningful frequency drop (historically on the
  order of ~10-40% on the worst-affected SKUs), plus a transition cost when
  entering/leaving the wide state and a recovery delay back to full clock.

Consequences that bite in HFT specifically:

- A short AVX-512 burst can **slow down the surrounding scalar code** by leaving
  the core at a reduced clock for a recovery window — so a tiny vectorized kernel
  embedded in a latency-critical scalar path can be a *net loss*.
- One thread using heavy AVX-512 can pull down the frequency of *other* cores
  sharing the package on some parts — a cross-thread interference effect that's
  poison for tail latency.
- Newer microarchitectures (Ice Lake, Sapphire Rapids; AMD Zen 4) substantially
  *reduced* this penalty, so the advice is microarchitecture-specific — **measure
  on the exact production silicon.**

> **Interview gold:** "AVX-512 throttles the clock on many Intel parts, so for a
> short kernel on a latency-critical path I'll often prefer AVX2 — but it depends
> on the exact CPU, and I'd measure end-to-end, not just the kernel." Naming this
> trade-off is a strong signal. AVX2 is frequently the sweet spot for HFT hot
> paths for exactly this reason.

Other intrinsics caveats:

- **Alignment:** `_mm256_load_ps` (aligned) faults on a non-32-byte-aligned
  pointer (`_mm512_load_ps` needs 64). `loadu`/`storeu` (unaligned) are safe and
  on modern cores nearly as fast — prefer them unless you've guaranteed alignment
  with `alignas(64)`. Aligned loads still help by avoiding cache-line splits.
- **Tail handling:** arrays rarely divide evenly by the vector width — always
  write the scalar remainder loop (or use masked loads on AVX-512).
- **Portability:** intrinsics are ISA-specific and verbose; consider
  abstractions before committing.

## Portable SIMD: `std::simd`

Hand-written intrinsics are non-portable and hard to maintain. The standard is
catching up: `std::experimental::simd` (the Parallelism TS v2, in `<experimental/simd>`
on recent libstdc++/libc++) and `std::simd` (targeted at C++26) give a portable,
typed vector abstraction that the implementation maps to the best ISA available:

```cpp
#include <experimental/simd>
namespace stdx = std::experimental;
// Width chosen by the implementation for the target (SSE/AVX/AVX-512).
float dot_simd(const float* a, const float* b, std::size_t n) {
    using V = stdx::native_simd<float>;
    V acc{0.f};
    std::size_t i = 0, W = V::size();
    for (; i + W <= n; i += W)
        acc += V{a + i, stdx::element_aligned} * V{b + i, stdx::element_aligned};
    float s = stdx::reduce(acc);           // portable horizontal reduction
    for (; i < n; ++i) s += a[i] * b[i];
    return s;
}
```

Third-party libraries (Google **Highway**, **xsimd**, **Eigen** for linear
algebra) fill the same need today and handle runtime dispatch across ISAs. Worth
mentioning that you'd reach for these rather than raw intrinsics in production
code that must run on heterogeneous hardware.

## Performance & hardware reality (approx)

| Aspect | Approx | Notes |
|---|---|---|
| Throughput ceiling | up to width× scalar | 8× (AVX2 float), 16× (AVX-512 float) — *if* memory-fed |
| FMA latency / throughput | ~4-5 cyc / ~2 per cyc | need several accumulators to saturate |
| Aligned vs unaligned load | ~same on modern cores | unaligned only pays at cache-line splits |
| Gather | many× a contiguous load | often not worth it; prefer SoA |
| Horizontal reduction | ~several cyc | do once, outside the loop |
| AVX-512 heavy-FP downclock | ~10-40% on worst SKUs (approx) | much smaller on Ice Lake+/Zen4 — *measure* |

Real workloads are frequently **memory-bandwidth bound**, not compute bound — at
which point a wider vector doesn't help because you can't feed it. Check with
`perf` (FLOPS vs bytes/sec) before assuming SIMD is the bottleneck. (All figures
approximate and microarchitecture-dependent.)

## Quant/HFT relevance & interview gotchas

- **Where SIMD wins in HFT:** batch pricing across instruments, computing signals
  / moving statistics over arrays, normalizing or rescaling a snapshot,
  fixed-point conversions, checksum/parse of feed batches. Data-parallel, hot,
  contiguous → SIMD.
- **Where it doesn't:** a single message's critical path (latency, not
  throughput) — and especially anything triggering AVX-512 downclock around
  scalar hot code. Throughput-oriented batch work, yes; the per-tick decision
  path, usually not.
- **SoA is the prerequisite.** SIMD wants contiguous, like-typed data. AoS forces
  gather. Lay data out (struct-of-arrays) *first*, then vectorize.
- **The AVX-512 throttling answer** (above) is a classic senior-vs-junior
  discriminator. So is knowing **gather is slow** and **horizontal reductions are
  costly**.
- **Don't hand-roll what `-O3 -march=native -ffast-math` plus `__restrict` already
  does** — check `-fopt-info-vec` first. Reaching for intrinsics prematurely is a
  maintainability and portability smell.
- **`-ffast-math` changes results** (FP reassociation, no NaN/Inf guarantees) —
  fine for many signals, dangerous for anything requiring bit-reproducibility
  (risk, settlement). Know the trade-off.

## Key takeaways

1. SIMD = one instruction over many **lanes**; widths are 128b (SSE/`xmm`), 256b
   (AVX2/`ymm`), 512b (AVX-512/`zmm`). AVX-512 adds 32 registers and **mask
   registers `k0..k7`** for predication.
2. Prefer **auto-vectorization**: `-O3 -march=native`, `__restrict`, contiguous
   access, no loop-carried deps; verify with `-fopt-info-vec` / `-Rpass`. Drop to
   **intrinsics** only for what the compiler can't see.
3. Use **vector accumulators** and do the **horizontal reduction once, outside the
   loop**; vertical ops are cheap, horizontal ops and **gather** are expensive.
4. **AVX-512 can downclock the core** (heavy FP) on many Intel parts — wider may
   be *slower* near latency-critical scalar code; AVX2 is often the HFT sweet
   spot. Measure on the real silicon.
5. For portability use **`std::simd`** / Highway / xsimd / Eigen rather than raw
   intrinsics; mind **alignment**, **scalar tails**, and that real loops are often
   **bandwidth-bound**.

## Self-check

1. A 256-bit register holds how many `float`s? `double`s? `int16_t`s? What's the
   theoretical throughput multiplier for a float add loop?
2. Name three things that block auto-vectorization, and the fix for each.
3. Why does the dot-product example use a *vector* accumulator and reduce only
   once? What's wrong with reducing inside the loop?
4. Explain the AVX-512 frequency-throttling caveat and how it can make a wider
   kernel a *net latency loss* in an HFT hot path.
5. When would you choose AVX2 over AVX-512 even though AVX-512 is available? When
   would gather be the wrong tool, and what's the data-layout alternative?

## Further reading

- [Intel Intrinsics Guide](https://www.intel.com/content/www/us/en/docs/intrinsics-guide/index.html) — searchable reference for every `_mm*` intrinsic, with latencies.
- [Intel 64 and IA-32 Optimization Reference Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) — AVX/AVX-512 usage, frequency/power behavior.
- Agner Fog, [Optimizing software in C++](https://www.agner.org/optimize/optimizing_cpp.pdf) and the [instruction tables](https://www.agner.org/optimize/instruction_tables.pdf) — per-instruction latency/throughput.
- Daniel Lemire's blog — [lemire.me/blog](https://lemire.me/blog/) — many practical SIMD posts (parsing, dot products, masks, gather pitfalls).
- [`std::experimental::simd` — cppreference](https://en.cppreference.com/w/cpp/experimental/simd) — the portable SIMD abstraction.
- [Google Highway](https://github.com/google/highway) and [xsimd](https://github.com/xtensor-stack/xsimd) — production portable-SIMD libraries with runtime dispatch.
- Wikipedia — [AVX-512](https://en.wikipedia.org/wiki/AVX-512) and [SIMD](https://en.wikipedia.org/wiki/Single_instruction,_multiple_data) — registers, ISA history, mask registers.
- [uops.info](https://uops.info/) — exact port usage and latency of SIMD instructions per microarchitecture.

## Videos

- CppCon — search **"SIMD" / "vectorization"** talks ([search](https://www.youtube.com/results?search_query=CppCon+SIMD+vectorization)) — e.g. talks on `std::simd` and Highway.
- CppCon — **Matt Godbolt / Compiler Explorer on auto-vectorization** ([search](https://www.youtube.com/results?search_query=CppCon+Matt+Godbolt+vectorization+compiler+explorer)) — seeing what the compiler emits.
- Talk search — **"AVX-512 frequency throttling downclocking"** ([search](https://www.youtube.com/results?search_query=AVX-512+frequency+throttling+downclocking)) for the power/clock trade-off in depth.
