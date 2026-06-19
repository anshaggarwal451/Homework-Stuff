# Compiler Optimizations

> **Why a quant dev must own this:** Your hot path is only as fast as the
> assembly the compiler emits — and you can't tune what you can't read. Knowing
> which flags to pass, which passes the optimizer runs, and crucially *what
> blocks them* (aliasing, `volatile`, separate compilation) is the difference
> between a feed handler that vectorizes and one that doesn't. And there's a
> money-losing trap: `-ffast-math` silently reorders floating-point arithmetic,
> changing prices. Senior HFT engineers read Godbolt the way others read logs.

## First principles: the as-if rule

The entire legal basis for optimization is one rule. The C++ standard's **as-if
rule** says the compiler may transform your program *however it likes* as long
as the program's **observable behavior** is preserved. Observable behavior is:

- reads and writes through `volatile` objects,
- data written to files / output at program termination,
- the prompting/input behavior of interactive devices.

Everything else — the order of your arithmetic, whether a variable lives in a
register or memory, whether a loop exists at all — is fair game. If the compiler
can *prove* a transformation doesn't change observable output, it's allowed.
This is why a function that computes a constant can be folded to a single
`mov`, and why dead code vanishes.

> Two important exceptions where the compiler gets *extra* latitude: **copy
> elision** (RVO) is permitted even though it elides observable
> constructor/destructor side effects, and **`-ffast-math`** explicitly opts you
> out of strict IEEE-754 observability for floating point.

## Optimization levels

The headline knob. Approximate, GCC/Clang semantics:

| Flag | Intent | Notes |
|:-----|:-------|:------|
| `-O0` | no optimization (default) | fastest compile, best debugging, *slow* code; every variable spilled to memory |
| `-O1` | basic | cheap passes, modest speedup |
| `-O2` | **the production default** | full optimization without aggressive code-size blowup; inlining, vectorization, CSE, etc. |
| `-O3` | aggressive | `-O2` plus more aggressive inlining and vectorization; can *bloat* code and occasionally regress (I-cache pressure) |
| `-Os` | optimize for size | `-O2` minus size-increasing passes |
| `-Oz` | optimize for size harder (Clang) | smallest code, may sacrifice speed |
| `-Ofast` | `-O3` + `-ffast-math` + relaxes standards | **breaks strict IEEE-754** — dangerous for money math |
| `-Og` | optimize for debugging | best balance when you need a debugger |

**`-O2` vs `-O3` is not a given.** `-O3`'s aggressive inlining/unrolling can
*hurt* by blowing the instruction cache or causing register spills. Benchmark
both; many HFT shops ship `-O2 -march=native` and selectively `-O3` hot
translation units.

## The key optimization passes

### Inlining

Replaces a call with the callee's body, eliminating call overhead *and* — more
importantly — exposing the callee's internals to every other pass (constant
propagation across the boundary, CSE, etc.). Inlining is the **enabler** for
most other optimizations. `inline`/`constexpr`/header-defined functions and
small functions are prime candidates; virtual calls and separately-compiled
functions are barriers (see below).

### Constant folding & propagation

Compute constant expressions at compile time and substitute known values.

```cpp
int f() { int a = 6, b = 7; return a * b; }   // folds to: return 42;
```

### Dead code elimination (DCE)

Remove code whose result is never observed.

```cpp
int g(int x) {
    int unused = expensive();   // removed if 'expensive' has no side effects
    return x + 1;
}
```

### Common subexpression elimination (CSE)

Compute a repeated expression once.

```cpp
// y*z computed twice -> compiler computes it once into a temporary.
a = y * z + 1;
b = y * z - 1;
```

### Loop-invariant code motion (LICM)

Hoist computations that don't change across iterations out of the loop.

```cpp
for (int i = 0; i < n; ++i) v[i] = x * y + i;   // x*y hoisted before the loop
```

### Strength reduction

Replace expensive operations with cheaper equivalents: multiply-by-constant →
shifts/adds, `i*4` in a loop → a running pointer increment, `% power-of-two` →
bitwise `&`.

### Loop unrolling & vectorization

Unrolling duplicates the loop body to amortize loop overhead and expose
instruction-level parallelism. Vectorization (auto-SIMD) packs multiple
iterations into one wide SIMD instruction (covered in depth in the sibling
vectorization lesson). Both are highly sensitive to whether the compiler can
prove the loop is independent — which aliasing can wreck.

### Tail-call optimization, RVO/copy elision, devirtualization

- **Tail-call optimization** reuses the current stack frame for a call in tail
  position, turning recursion into a loop.
- **RVO / copy elision** constructs a returned object directly in the caller's
  storage, skipping the copy/move entirely — *mandatory* for prvalues since
  C++17.
- **Devirtualization** — if the compiler can prove the dynamic type at a virtual
  call site (e.g. an object of known final type), it replaces the vtable
  indirection with a direct, inlinable call. `final` helps it.

## Reading the assembly: a worked example

The best way to learn the optimizer is [Godbolt](https://godbolt.org/). Compile
a small function at `-O2` and read the output.

```cpp
// Sum of 0..n-1. Naively a loop; mathematically n*(n-1)/2.
int sum_to(int n) {
    int s = 0;
    for (int i = 0; i < n; ++i) s += i;
    return s;
}
```

At `-O0` this is a literal loop with memory spills. At `-O2`, GCC/Clang
recognize the closed form and emit **no loop at all** — strength reduction +
algebraic simplification collapse it to arithmetic:

```x86asm
sum_to(int):
        test    edi, edi          ; n <= 0 ?
        jle     .Lzero            ; if so, return 0
        lea     eax, [rdi-1]      ; eax = n-1
        lea     ecx, [rdi-2]      ; ecx = n-2
        imul    rax, rcx          ; (n-1)*(n-2)
        ...                       ; finish n*(n-1)/2 via shifts (no division!)
        ret
.Lzero:
        xor     eax, eax          ; return 0
        ret
```

The division by 2 becomes a shift (strength reduction), the loop becomes a
multiply (the compiler solved the series). That is the as-if rule in action:
observable result identical, work eliminated.

A vectorizable loop tells a different story:

```cpp
void scale(float* out, const float* in, float k, int n) {
    for (int i = 0; i < n; ++i) out[i] = in[i] * k;
}
```

At `-O3 -march=native` on an AVX machine the inner loop processes 8 floats per
iteration with `vmulps` on 256-bit `ymm` registers — *if* the compiler can prove
`out` and `in` don't overlap. Which brings us to the most important topic.

## What BLOCKS optimization

This is the part interviewers probe and the part that wins you cycles.

### Pointer aliasing

If two pointers *might* refer to overlapping memory, the compiler must assume a
write through one can change reads through the other — killing reordering, CSE,
and vectorization. In `scale` above, if `out == in + 1`, the iterations are
dependent. The compiler conservatively emits a runtime overlap check and a slow
scalar fallback, or refuses to vectorize.

You promise non-overlap with **`__restrict`** (a compiler extension; `restrict`
is standard in C, not C++):

```cpp
void scale(float* __restrict out, const float* __restrict in, float k, int n) {
    for (int i = 0; i < n; ++i) out[i] = in[i] * k;   // now freely vectorizes
}
```

This is one of the highest-leverage, lowest-effort optimizations in numeric
code.

### `volatile`

`volatile` forces every access to be a real load/store in program order — it
tells the optimizer "this memory has observable side effects, don't touch it."
That's correct for memory-mapped I/O, but a performance disaster if misused as a
poor-man's atomic. It blocks register caching, CSE, and reordering of those
accesses.

### Observable side effects, exceptions, and separate compilation

- A call to a function the compiler **can't see the body of** (in another `.o`)
  is an optimization barrier: it may have side effects, may modify globals, can't
  be inlined. **Link-Time Optimization (LTO)** fixes this — see below.
- **Exceptions** add hidden control-flow edges and cleanup paths that can
  inhibit some transformations and bloat code; `noexcept` lets the compiler omit
  unwinding machinery and sometimes optimize harder.
- I/O, atomics with strong ordering, and `volatile` are observable and pin the
  surrounding code.

## The flags that matter for HFT

### `-march=native`

Tells the compiler to use *every* instruction your CPU supports (AVX2, AVX-512,
BMI, FMA, …). Without it, the compiler targets a conservative baseline and won't
emit modern SIMD. The catch: the binary may **crash with SIGILL** on an older
CPU. Build per-target, or use `-march=` with an explicit microarchitecture.

### Link-Time Optimization (LTO)

`-flto` defers optimization to link time, when the *whole program* is visible.
This enables cross-translation-unit inlining and devirtualization — the
optimizer can finally inline that function from `other.cpp`. Costs longer link
times; worth it for release builds.

### Profile-Guided Optimization (PGO)

A two-pass build: compile with instrumentation, run a representative workload to
collect a profile, then recompile feeding the profile back. The compiler now
knows which branches are hot, which are cold, and lays out code accordingly
(hot paths fall through, cold paths and error handling move out of line),
inlines what's actually called, and predicts branches better. For HFT, where the
hot path is a tiny fraction of the code, PGO is one of the biggest free wins.

### The `-ffast-math` trap (read this twice)

`-ffast-math` (and `-Ofast`, which includes it) lets the compiler treat floating
point as if it obeyed real-number algebra: it permits **reassociation**
(`(a+b)+c → a+(b+c)`), assumes **no NaNs/Infs**, flushes denormals to zero, and
drops strict rounding. Floating-point addition is **not associative**, so
reassociation **changes the result**. For pricing, P&L, and risk math, that is
unacceptable — two builds can disagree on the last cents, and a sum can change
depending on how the compiler chose to vectorize it.

```cpp
double price = 0.0;
for (double cf : cashflows) price += cf;   // -ffast-math may reorder/SIMD-sum this,
                                           // changing the rounded result.
```

> **HFT rule:** never compile money math with `-ffast-math`/`-Ofast`. If you
> need fast-but-deterministic FP, use targeted intrinsics (e.g. FMA via
> `-mfma` for code where you *want* the fused rounding) and document it — don't
> flip a global flag that silently rewrites every sum in your pricer.

## Helping the optimizer

You are not a passive consumer. Give it the facts it needs:

- **`const` / `constexpr`** — promote work to compile time and enable folding.
- **`__restrict`** — promise non-aliasing; unlock vectorization.
- **`noexcept`** — drop unwinding overhead, enable move optimizations.
- **`final` / non-virtual where possible** — enable devirtualization & inlining.
- **`[[likely]]` / `[[unlikely]]`** (C++20) — steer branch layout (PGO does this
  better with real data).
- **Keep hot functions small and visible** (header/`inline`) so they inline.
- **`__builtin_expect`**, `__builtin_assume`, and `[[assume]]` (C++23) feed the
  optimizer facts it can't derive.

And always: **verify on Godbolt.** Don't assume the loop vectorized — look at
the assembly for `ymm`/`zmm` registers, count the instructions, check the
fallback wasn't taken.

## Quant/HFT relevance & interview gotchas

- **Ship `-O2`/`-O3 -march=native`, with LTO and PGO** for release. Decide
  `-O2` vs `-O3` per translation unit *by measuring* — `-O3` can regress via
  I-cache pressure.
- **Never `-Ofast`/`-ffast-math` on pricing code** — reassociation changes
  results. This is a classic "gotcha" interview question; the right answer cites
  FP non-associativity.
- **`__restrict` + `const` are your vectorization levers.** Aliasing is the #1
  reason a numeric loop fails to vectorize.
- **Read the assembly.** "How do you know it inlined / vectorized?" → "I checked
  Godbolt and looked for the call disappearing / SIMD registers."
- **`volatile` is not atomic and not a fence** — a common confusion. It blocks
  optimization without giving thread-safety.
- **Optimization can't fix algorithmic or cache problems** — the compiler won't
  change your data layout or your `O(n²)`. It optimizes *within* the as-if rule.
- **Separate compilation is an optimization barrier** unless you enable LTO —
  worth stating when asked why a cross-module call wasn't inlined.

## Key takeaways

1. The **as-if rule** lets the compiler do anything that preserves *observable
   behavior*; that's the basis of every optimization.
2. Know the levels: `-O2` is the production default; `-O3` is aggressive and can
   regress; `-Ofast`/`-ffast-math` **breaks IEEE-754** and must never touch
   money math.
3. Know the passes: inlining (the great enabler), constant folding/propagation,
   DCE, CSE, LICM, strength reduction, unrolling, vectorization, TCO, RVO/copy
   elision, devirtualization.
4. **Aliasing**, **`volatile`**, exceptions, observable side effects, and
   **separate compilation** are what *block* optimization. Use `__restrict`,
   `const`, `noexcept`, `final`, and **LTO** to remove the barriers.
5. For HFT: `-march=native`, **LTO**, **PGO**, and *verify the assembly on
   Godbolt* — never trust that an optimization happened.

## Self-check

1. State the as-if rule. What counts as "observable behavior," and which two
   things does it let the compiler do that *do* change otherwise-observable
   side effects?
2. Why might `-O3` produce *slower* code than `-O2`? Give a concrete mechanism.
3. A numeric loop refuses to vectorize. Name the most likely cause and the
   one-keyword fix.
4. Why is `-ffast-math` dangerous for a P&L summation loop? Cite the specific FP
   property involved.
5. What does LTO enable that `-O2` on a single translation unit cannot, and
   what's the cost?
6. Explain how PGO improves a typical HFT binary where the hot path is a small
   fraction of the code.

## Further reading

- [GCC Optimize Options](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html)
  — the authoritative list of every `-O` and `-f` flag.
- [Clang command-line / optimization docs](https://clang.llvm.org/docs/CommandGuide/clang.html)
  and [LLVM optimization passes](https://llvm.org/docs/Passes.html).
- [Compiler Explorer (Godbolt)](https://godbolt.org/) — the single best tool for
  reading generated assembly interactively.
- [Agner Fog's optimization manuals](https://www.agner.org/optimize/) —
  especially "Optimizing software in C++" and the instruction tables.
- Scott Meyers, *Effective Modern C++* — Item 14 (`noexcept`) and the discussion
  of how `const`/move interact with the optimizer.
- [`std::memory_order` / `volatile` — cppreference](https://en.cppreference.com/w/cpp/atomic/memory_order)
  — why `volatile` ≠ atomic.
- [The as-if rule — cppreference](https://en.cppreference.com/w/cpp/language/as_if).

## Videos

- Matt Godbolt, CppCon **"What Has My Compiler Done for Me Lately? Unbolting
  the Compiler's Lid"**
  ([search](https://www.youtube.com/results?search_query=Matt+Godbolt+what+has+my+compiler+done+for+me+lately)).
- Chandler Carruth, CppCon talks on optimization and **"Going Nowhere
  Faster"** / understanding the optimizer
  ([search](https://www.youtube.com/results?search_query=Chandler+Carruth+optimization+compiler+CppCon)).
- CppCon — **"`-ffast-math` and floating point"** / floating-point pitfalls
  ([search](https://www.youtube.com/results?search_query=CppCon+floating+point+ffast-math+pitfalls)).
