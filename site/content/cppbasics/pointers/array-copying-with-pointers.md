# Array Copying with Pointers

> **Why a quant dev must own this:** A feed handler copies bytes constantly —
> packets off the NIC into ring buffers, snapshots of the book, message frames
> into decode structs. Copying a few cache lines is cheap *if you pick the right
> primitive*; pick wrong and you eat a function call, a misalignment penalty, or
> blocked vectorization. "Copy this array — now make it fast" is a staple
> whiteboard task, and the right answer is rarely a hand-rolled loop.

## First principles: copying is moving bytes, with rules

Copying an array means reproducing each element into a destination. Through
pointers, the naive version is a loop that walks both ranges in lockstep:

```cpp
void copy_loop(const int* src, int* dst, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i)
        dst[i] = src[i];                 // dst[i] is *(dst + i)
}
```

Two questions decide *how* you should really copy:

1. **Are the elements trivially copyable?** If yes, the copy is "just bytes" and
   `memcpy` is legal. If no (a `std::string`, anything with a user copy
   constructor), you must run copy constructors — only `std::copy` /
   `std::uninitialized_copy` will do.
2. **Do source and destination overlap?** If they can, you need `memmove`, not
   `memcpy`.

## `std::copy`, `std::memcpy`, `std::memmove`

```cpp
#include <algorithm>   // std::copy
#include <cstring>     // std::memcpy, std::memmove

int  src[8] = {0,1,2,3,4,5,6,7};
int  dst[8];

// (1) std::copy — element-wise, runs copy assignment. Works for any copyable T.
std::copy(src, src + 8, dst);                 // [first, last) -> dst

// (2) std::memcpy — raw bytes. T must be TriviallyCopyable. NO overlap allowed.
std::memcpy(dst, src, 8 * sizeof(int));       // note: byte count, not element

// (3) std::memmove — raw bytes, overlap-SAFE (as if via a temp buffer).
std::memmove(dst, src, 8 * sizeof(int));
```

| Primitive | Element-aware? | Overlap-safe? | `T` requirement | Counts in |
|---|---|---|---|---|
| `std::copy` | yes (runs copy/assign) | no¹ | copy-assignable | elements |
| `std::memcpy` | no (bytes) | **no** (UB if overlap) | trivially copyable | bytes |
| `std::memmove` | no (bytes) | **yes** | trivially copyable | bytes |

¹ `std::copy` requires `dst` not be inside `[src, last)`; copy *backwards* with
`std::copy_backward` for a right-shift, or use `std::move`/ranges as needed.

### The overlap trap

`memcpy` with overlapping ranges is **undefined behaviour** — and on real
implementations it genuinely corrupts data, because an optimized `memcpy` may
copy forward, backward, or in large SIMD chunks in any order. Self-overlap is
common when you shift a buffer left/right (e.g. compacting a ring buffer). Use
`memmove`, which the standard defines *as if* the source were first copied to a
temporary.

```cpp
// Shift an array left by one — source and dest OVERLAP.
std::memmove(a, a + 1, (n - 1) * sizeof(int));   // correct
// std::memcpy(a, a + 1, ...);                    // UB — may garble
```

### The trivially-copyable requirement

`memcpy`/`memmove` blindly duplicate the object representation. That is correct
only for **trivially copyable** types — scalars, pointers, and aggregates of
them with no user-defined copy/move/destructor. `memcpy`-ing a `std::string`
duplicates its internal pointer, giving two strings that own the same buffer →
double free. Guard generic code:

```cpp
template <class T>
void fast_copy(const T* s, T* d, std::size_t n) {
    if constexpr (std::is_trivially_copyable_v<T>)
        std::memcpy(d, s, n * sizeof(T));
    else
        std::copy(s, s + n, d);     // runs real copy constructors/assignments
}
```

## Why `std::copy` is *not* slower

A common myth is "drop to `memcpy` for speed." In practice, for trivially
copyable types **`std::copy` is required by quality implementations to dispatch
to `memmove`** internally when it can prove contiguity and triviality — so it
emits the identical vectorized code. You get type safety and the same assembly.

```cpp
// libstdc++/libc++ specialize std::copy: for trivially-copyable T over
// pointers/contiguous iterators it calls __builtin_memmove. Same SIMD result.
std::copy(src, src + n, dst);     // == memmove path under the hood
```

So the modern advice is: **prefer `std::copy`** (or `std::ranges::copy`); reach
for `memcpy`/`memmove` only when you're copying genuinely untyped bytes (network
buffers, serialization) or need the explicit overlap semantics of `memmove`.

## The compiler turns the loop into SIMD or `rep movs`

Look at what `copy_loop` above compiles to. With `-O3`, GCC/Clang vectorize the
trivially-copyable copy into wide SIMD stores, with a scalar tail:

```x86asm
; void copy_loop(const int* src/rdi, int* dst/rsi, size_t n/rdx)  -O3, AVX2
.loop:
        vmovdqu ymm0, YMMWORD PTR [rdi + rax]    ; load 8 ints (32 bytes)
        vmovdqu YMMWORD PTR [rsi + rax], ymm0    ; store 8 ints
        add     rax, 32
        cmp     rax, rcx
        jb      .loop
        ; ... scalar tail for the remaining < 8 elements ...
```

Alternatively, a small fixed-size copy may become a single inline `rep movsb`:

```x86asm
; std::memcpy(dst, src, 64)  ->  often just:
        mov     ecx, 64
        rep movsb            ; ERMSB: microcoded fast string copy on modern x86
```

Modern Intel/AMD implement **ERMSB** (Enhanced REP MOVSB), so `rep movsb` is
competitive with SIMD for medium/large copies and the compiler/`memcpy`
implementation chooses among scalar, SIMD, and `rep movs` based on size and
alignment. The takeaway: you usually should *not* hand-roll — the library and
optimizer already pick the best strategy.

## Pointer traversal vs index — and why aliasing blocks vectorization

Indexing `a[i]` is *defined* as `*(a + i)`, so a pointer-walking loop and an
index loop are semantically identical and compile to the same code at `-O2`. The
real performance lever is **aliasing**.

When you write `void f(const int* src, int* dst, size_t n)`, the compiler must
assume `dst` and `src` *might overlap*. To stay correct it may serialize
load→store dependencies and refuse to vectorize. `restrict` (C `restrict`,
spelled `__restrict` in C++) is your promise that they don't alias:

```cpp
// Promise: src and dst never overlap -> compiler may freely reorder/vectorize.
void copy_restrict(const int* __restrict src,
                   int* __restrict dst, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i) dst[i] = src[i];
}
```

With `__restrict` the compiler can prove no store through `dst` invalidates a
load through `src`, unlocking wider, reordered SIMD. (Standard C++ has no
`restrict` keyword — `__restrict` is a near-universal compiler extension. The
overlap-free guarantee is exactly what `std::copy` and `memcpy` document, which
is another reason they vectorize so well.)

> **Gotcha:** `__restrict` is an *unchecked promise*. If the ranges actually
> overlap, it's UB — same hazard as `memcpy` on overlap. Use it only when you
> truly know they're disjoint.

## Performance & hardware reality

- **Copy throughput is bandwidth-bound**, not instruction-bound, for large
  arrays — you saturate the memory subsystem, so SIMD vs `rep movs` matters less
  than fitting in cache.
- **Alignment**: aligned SIMD loads/stores avoid cache-line splits. Aligning hot
  buffers to 32/64 bytes lets the vectorized path use aligned moves.
- **`memcpy` is a call** unless inlined. For tiny known sizes the compiler
  inlines it (even to a couple of `mov`s); for unknown `n` it calls libc's
  hand-tuned `memcpy`, which dispatches on CPU features at runtime.
- **Non-temporal stores** (`_mm256_stream_si256`) bypass the cache for huge
  one-shot copies you won't re-read — relevant when blasting a large snapshot you
  won't touch again, harmful for data you'll reuse.

## Quant/HFT relevance & interview gotchas

- **Copying market-data buffers**: packets land in a DMA/ring buffer; you copy
  the frame you care about into a decode struct. For a POD message that's a
  single `memcpy` of `sizeof(Msg)` — fast and inlinable. Confirm the message is
  trivially copyable.
- **Ring-buffer compaction self-overlaps** → `memmove`, never `memcpy`. This is a
  favourite "find the latent bug" question.
- **`memcpy` count is bytes**, `std::copy` count is elements. Off-by-`sizeof(T)`
  errors here are classic and silent.
- **"Is `std::copy` slower than `memcpy`?"** — No, for trivially copyable types
  it dispatches to `memmove`; say so and you sound senior.
- **Don't `memcpy` non-trivial types** (`std::string`, `std::vector`) — double
  free / corrupted invariants. Know `std::is_trivially_copyable_v`.
- **Aliasing & `__restrict`**: be able to explain *why* a copy loop fails to
  vectorize when src/dst might overlap, and how `restrict` or `std::copy` fixes
  it.

## Key takeaways

1. Two questions gate the choice: **trivially copyable?** and **can ranges
   overlap?**
2. **`std::copy`** is element-aware (runs copy ctors), counts in elements, and
   for trivial `T` dispatches to `memmove` — same speed, more safety. Prefer it.
3. **`std::memcpy`** is raw bytes, no overlap (UB otherwise); **`std::memmove`**
   is the overlap-safe byte copy. Both need trivially copyable types and count
   in **bytes**.
4. Index `a[i]` and pointer `*(a+i)` loops compile identically; the real lever
   is **aliasing**, relaxed with `__restrict` (an unchecked, UB-on-overlap
   promise).
5. The compiler emits **SIMD** or **`rep movsb`/ERMSB**; large copies are
   **bandwidth-bound**. Don't hand-roll — let the library choose.
6. Never `memcpy` a non-trivial type; never `memcpy` overlapping ranges.

## Self-check

1. You shift an array left by one element in place. Which of `memcpy`/`memmove`
   is correct and why is the other UB?
2. Why does `std::memcpy(dst, src, n)` of a `std::vector<std::string>` corrupt
   memory even with no overlap?
3. A reviewer says "use `memcpy`, `std::copy` is slower." How do you correct
   them precisely?
4. `std::memcpy(dst, src, 8)` copies how many `int`s? What's the trap in that
   third argument?
5. Why might `void f(const int* s, int* d, size_t n){ for(...) d[i]=s[i]; }` not
   vectorize, and what two fixes unblock it?
6. When are non-temporal (streaming) stores a win, and when do they hurt?

## Further reading

- [`std::copy` / `std::copy_backward`](https://en.cppreference.com/w/cpp/algorithm/copy) and [`std::ranges::copy`](https://en.cppreference.com/w/cpp/algorithm/ranges/copy) — cppreference.
- [`std::memcpy`](https://en.cppreference.com/w/cpp/string/byte/memcpy) and [`std::memmove`](https://en.cppreference.com/w/cpp/string/byte/memmove) — cppreference (note the overlap rules).
- [`std::is_trivially_copyable`](https://en.cppreference.com/w/cpp/types/is_trivially_copyable) — cppreference.
- Intel® 64 and IA-32 Architectures Optimization Reference Manual — ERMSB / `REP MOVSB` guidance ([Intel](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)).
- Agner Fog, [*Optimizing software in C++*](https://www.agner.org/optimize/) — memory access, alignment, and vectorization chapters.
- C `restrict` semantics — [cppreference (C)](https://en.cppreference.com/w/c/language/restrict).

## Videos

- CppCon 2019 — Chandler Carruth, **"There Are No Zero-cost Abstractions"** ([search](https://www.youtube.com/results?search_query=CppCon+2019+Chandler+Carruth+There+Are+No+Zero-cost+Abstractions)) — touches why library copies match hand-rolled.
- CppCon 2016 — Tim Haines / **"What Has My Compiler Done for Me Lately? Unbolting the Compiler's Lid"** by Matt Godbolt ([search](https://www.youtube.com/results?search_query=CppCon+2017+Matt+Godbolt+What+Has+My+Compiler+Done+for+Me+Lately)) — reading the vectorized assembly of loops.
