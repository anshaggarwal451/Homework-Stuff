# std::array: Fixed-Size Array Container

> **Why a quant dev must own this:** When the size is known at compile time — a
> fixed-depth book, an N-symbol lookup table, a ring-buffer of price levels —
> `std::array` gives you a **stack-allocated, contiguous, zero-overhead** block
> with none of `std::vector`'s heap allocation, none of the C array's decay
> footguns, and full `constexpr` superpowers. In an HFT hot path, "no allocation
> and the size is in the type" is exactly what you want, and interviewers love
> probing the C-array-vs-`array`-vs-`vector` distinction.

## First principles: a class wrapper over a C array

`std::array<T, N>` is the thinnest possible class wrapper around a built-in
array `T[N]`. Conceptually:

```cpp
template <class T, std::size_t N>
struct array {
    T _elems[N];     // the only data member — a plain C array, no pointer
    // ... begin()/end()/size()/operator[]/data()/fill()/at() ...
};
```

That's the whole secret. There is **no pointer, no size field, no capacity, no
allocator** — just the elements, laid out exactly like `T[N]`. `N` is a
**non-type template parameter (NTTP)**, so the size is part of the *type*:
`std::array<int,4>` and `std::array<int,8>` are different types. That single
design choice buys most of its advantages.

## What you gain over a raw C array

A C array `T a[N]` works, but it carries decades of sharp edges. `std::array`
fixes them while compiling to identical machine code.

- **It does not decay to a pointer.** Passing a C array to a function silently
  converts it to `T*` and you lose the size. `std::array` is a real object: it
  copies by value, it knows its `.size()`, and `sizeof` is meaningful.
- **It is a proper value type.** You can copy-assign it (`a = b`), return it
  from a function, and store it in containers. C arrays can't be assigned or
  returned by value.
- **It has the container interface.** `begin/end`, range-for, `.size()`,
  `.front()/.back()`, `.data()`, `.fill()`, `.at()` (bounds-checked, throws),
  and `operator[]` (unchecked). It plugs straight into STL algorithms.
- **It is an aggregate**, so it brace-initialises like a C array — including the
  empty-brace zero-init.

```cpp
#include <array>

std::array<int, 4> a = {1, 2, 3, 4};   // aggregate init
std::array<int, 4> z{};                 // all zero-initialised
a[2] = 30;                              // unchecked, fast
int  s = a.size();                      // == 4, a compile-time constant
int* p = a.data();                      // contiguous block, C-API friendly
for (int x : a) use(x);                 // range-for just works
```

> **Aggregate-init gotcha (interview favourite):** `std::array` is an aggregate,
> so before C++17 you sometimes needed *double* braces —
> `std::array<int,3>{{1,2,3}}` — because the outer brace inits the `array` and
> the inner inits the internal C array. With C++17 brace elision the single-brace
> form `{1,2,3}` works in nearly all cases. Also note **CTAD**:
> `std::array{1,2,3}` deduces `std::array<int,3>`.

## What you gain over `std::vector`

| | `std::array<T,N>` | `std::vector<T>` | C array `T[N]` |
|---|---|---|---|
| Size known | compile time (in type) | runtime, resizable | compile time |
| Storage | inline (stack/struct) | heap-allocated buffer | inline |
| Allocation | **none** | one+ heap allocs | none |
| `sizeof` | `N * sizeof(T)` | 3 pointers (≈24 B) | `N * sizeof(T)` |
| Decays to ptr | no | n/a | **yes** |
| Bounds-checked option | `.at()` | `.at()` | none |
| `constexpr` usable | yes | no (until C++20, limited) | yes |
| Copyable by value | yes | yes (deep copy) | no |

`std::vector` owns a heap buffer reached through a pointer — every access is one
indirection away, and constructing it costs an allocation. `std::array` *is* the
data; it lives where you put it (on the stack, or inline inside another object),
so there's no pointer chase and no allocator on the critical path.

## Memory layout

```text
std::array<int, 4> a;            int v[4];   (identical)
+------+------+------+------+    +------+------+------+------+
| a[0] | a[1] | a[2] | a[3] |    | v[0] | v[1] | v[2] | v[3] |
+------+------+------+------+    +------+------+------+------+
   ^ contiguous, 16 bytes, on the stack — no pointer, no header

std::vector<int> w(4);
 stack:  +-----+-----+-----+
         | ptr | sz  | cap |   ──ptr──► heap: [w0|w1|w2|w3]
         +-----+-----+-----+
   ^ 24 bytes on stack + a separate heap allocation + one indirection
```

## It compiles to the same assembly as a C array

This is the headline claim, and it's true: the wrapper is zero-overhead under
optimization. Summing both forms:

```cpp
#include <array>
int sum_arr(const std::array<int,4>& a) {
    int s = 0; for (int x : a) s += x; return s;
}
int sum_c(const int (&a)[4]) {
    int s = 0; for (int x : a) s += x; return s;
}
```

Compiled with `-O2`, both bodies lower to the *same* instructions — and small
fixed loops like this are typically fully unrolled (and often auto-vectorized):

```x86asm
sum_arr(std::array<int,4> const&):       ; identical body to sum_c
        mov     eax, DWORD PTR [rdi]
        add     eax, DWORD PTR [rdi+4]
        add     eax, DWORD PTR [rdi+8]
        add     eax, DWORD PTR [rdi+12]
        ret
```

No size field is loaded (the loop bound is a compile-time constant), no pointer
is dereferenced beyond the array's own address. The abstraction has *literally
zero* runtime cost. (Check it yourself on Compiler Explorer — see Further
reading.)

## `constexpr`-friendliness

Because there's no allocation, a `std::array` can live entirely at compile time.
You can build lookup tables, masks, or precomputed curves with no runtime init
cost and no static-initialization-order worries:

```cpp
// C++17: a compile-time table of squares, materialised into .rodata.
constexpr auto squares = [] {
    std::array<int, 8> a{};
    for (std::size_t i = 0; i < a.size(); ++i) a[i] = int(i * i);
    return a;
}();
static_assert(squares[4] == 16);
```

## `std::to_array` (C++20) — deduce `N` from an initializer

Sometimes you want the size inferred from the data rather than restated. Plain
CTAD handles `std::array{...}`, but `std::to_array` (C++20) also handles
string literals and explicit element types cleanly, copying from a C array:

```cpp
#include <array>
auto codes = std::to_array({10, 20, 30});       // std::array<int,3>
auto name  = std::to_array("AAPL");             // std::array<char,5> (incl. '\0')
auto bytes = std::to_array<std::uint8_t>({1,2}); // explicit element type
```

## Performance & hardware reality

- **Stack-allocated and contiguous** → maximally cache-friendly. A small
  `std::array` traversed in a loop is the textbook good case for the hardware
  prefetcher and for SIMD auto-vectorization.
- **No allocation, ever.** There is no `malloc`, no allocator indirection, and
  no chance of an allocation stall in the middle of a latency-critical section.
- **Compile-time size enables unrolling/vectorization.** Because `N` is known to
  the optimizer, loop bounds are constants — the compiler can unroll fully and
  pick the right vector width, which it generally cannot do for a `vector` whose
  length is a runtime value.
- **Beware huge arrays on the stack.** `std::array<double, 1'000'000>` is 8 MB
  on the stack and will overflow it. For large-but-fixed sizes, give it static
  storage, put it on the heap, or use `vector`. The "fixed size" sweet spot is
  *small-to-moderate*.
- **`operator[]` is unchecked; `.at()` adds a branch + throw path.** In hot code
  use `operator[]` and validate the index once at the boundary.

## Quant/HFT relevance & interview gotchas

- **Fixed-depth structures.** A top-of-book with 5 price levels, a fixed set of
  venue IDs, a small per-symbol stats block — model these as
  `std::array<Level, 5>` embedded directly in the parent object: zero allocation,
  one cache line's worth of contiguous data, no pointer chase.
- **`constexpr` lookup tables.** Precompute scaling factors, bit masks, or a
  CRC table into a `constexpr std::array`; it lands in read-only data with zero
  startup cost.
- **No decay = APIs that know their size.** Passing `std::array<T,N>` (or
  `std::span`) keeps the length, eliminating the classic C bug of passing an
  array and an out-of-sync length argument.
- **Interview line:** "`std::array` is a zero-overhead wrapper over a C array;
  the size is a template parameter so it's part of the type, it never decays,
  it's `constexpr`-friendly, and it compiles to identical asm." Then contrast:
  use `vector` when the size is a *runtime* value, `array` when it's a
  *compile-time* one.
- **Don't confuse `sizeof`.** `sizeof(std::array<int,4>)` is `16`;
  `sizeof(std::vector<int>)` is the size of three pointers regardless of how
  many elements it holds.

## Key takeaways

1. `std::array<T, N>` is a **thin aggregate wrapper over `T[N]`** — just the
   elements, no pointer/size/capacity, no heap allocation.
2. The size `N` is a **non-type template parameter**, so it's part of the type:
   known at compile time, enabling unrolling, vectorization, and `constexpr`.
3. Unlike a C array it **doesn't decay**, is copyable/returnable by value, and
   has the full container interface (`size/begin/end/data/at`).
4. Unlike `std::vector` it is **stack/inline-allocated and contiguous** — pick
   `array` for compile-time sizes, `vector` for runtime ones.
5. It is genuinely **zero-overhead**: identical assembly to a C array under
   `-O2`. Watch out only for *large* arrays overflowing the stack.

## Self-check

1. What are the data members of `std::array<int,4>`, and what is its `sizeof`?
2. Why doesn't `std::array` decay to a pointer the way a C array does, and why
   does that matter for function interfaces?
3. When must you write `std::array<int,3>{{1,2,3}}` with double braces, and when
   is single-brace enough?
4. Give one case where you'd reach for `std::vector` instead of `std::array`,
   and one where the reverse is true.
5. Why can the compiler unroll/vectorize a loop over `std::array<T,N>` more
   readily than one over `std::vector<T>`?
6. What goes wrong with `std::array<double, 1'000'000> buf;` as a local?

## Further reading

- [`std::array` — cppreference](https://en.cppreference.com/w/cpp/container/array) and [`std::to_array`](https://en.cppreference.com/w/cpp/container/array/to_array)
- [Aggregate initialization — cppreference](https://en.cppreference.com/w/cpp/language/aggregate_initialization) — explains the single-vs-double brace rule.
- [Class template argument deduction (CTAD) — cppreference](https://en.cppreference.com/w/cpp/language/class_template_argument_deduction)
- Scott Meyers, *Effective STL*, Item 16 (`vector`/`string` contiguity) and the general "know your containers" theme.
- [C++ Core Guidelines — SL.con.1 (prefer `array`/`vector` to a C array)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#slcon1-prefer-using-stl-array-or-vector-instead-of-a-c-array)
- [Compiler Explorer (godbolt.org)](https://godbolt.org/) — verify the "same asm" claim yourself with `-O2`.

## Videos

- CppCon — Chandler Carruth, **"Efficiency with Algorithms, Performance with Data Structures"** (CppCon 2014) ([search](https://www.youtube.com/results?search_query=CppCon+2014+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures)) — why contiguous, allocation-free data wins.
- CppCon — **"CppCon 2016: Timur Doumler — Want fast C++? Know your hardware!"** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+know+your+hardware)) — cache locality of contiguous storage.
