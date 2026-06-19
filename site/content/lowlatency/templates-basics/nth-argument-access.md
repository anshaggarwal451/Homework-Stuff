# Nth Argument Access

> **Why a quant dev must own this:** "Given a pack of arguments, give me the
> Nth one" is the kernel of `std::get`, `std::tuple_element`, structured
> bindings, and every compile-time dispatch table you'll build for a feed
> handler or an order router. It looks trivial and it exposes whether you
> actually understand parameter packs, `std::index_sequence`, and the
> difference between *runtime* indexing (impossible on a heterogeneous pack) and
> *compile-time* indexing (free). Interviewers use it as a fast, deep probe.

(Standard: **C++17** throughout — fold expressions, `if constexpr`,
`std::index_sequence`. A C++14 recursion variant is shown; C++20/23 notes
flagged.)

## Problem statement

Write a function (or trait) `get_nth<N>(args...)` that, given a variadic pack of
*possibly heterogeneous* arguments, returns the element at index `N`. Examples:

```cpp
get_nth<0>(10, 2.5, 'x');   // -> 10      (int)
get_nth<1>(10, 2.5, 'x');   // -> 2.5     (double)
get_nth<2>(10, 2.5, 'x');   // -> 'x'     (char)
```

The return type **depends on `N`** (it's `int`, then `double`, then `char`), so
this is fundamentally a compile-time operation.

## Clarifying constraints & assumptions

These are the questions to ask out loud before writing code:

- **Is `N` a compile-time constant?** It *must* be. The arguments are
  heterogeneous, so the return type varies with the index; a runtime `N` would
  need a single common return type (or type erasure). Pin `N` as a non-type
  template parameter `std::size_t N`.
- **Out-of-range `N`?** Best handled as a **compile-time error** — a
  `static_assert(N < sizeof...(Ts))` gives a clean diagnostic instead of a wall
  of template noise.
- **Preserve value category / avoid copies?** For a generic utility, yes — take
  the pack by forwarding reference and hand back a reference (`decltype(auto)`)
  so we don't copy a fat argument.
- **Should it work in `constexpr` context?** Mark everything `constexpr` so it
  can run at compile time.

## Approaches & tradeoffs

There are three idiomatic implementations. They produce the same result; they
differ in compile-time cost and clarity.

```text
approach                  mechanism                     compile cost    clarity
recursion (head/tail)     peel one arg, decrement N      O(N) insts      simple, classic
std::get on a tuple       pack -> tuple -> std::get<N>    leans on stdlib terse, robust
index_sequence + fold     drop N, pick the next          O(1)-ish        slick, modern
```

Runtime cost of all three is **zero** — they collapse to "return that one
argument". The choice is about template-instantiation depth and readability.

## Complexity

- **Runtime:** O(1). After instantiation, the result is a single reference/return
  — no loop, no branch. The compiler sees straight through it.
- **Compile time:** the recursion variant instantiates O(N) helper functions;
  the `std::tuple`/`index_sequence` variants are flatter. For small N
  (interview-scale) it's irrelevant; for N in the hundreds across many call
  sites, prefer the flat versions.

## Reference implementation

### Approach 1 — recursion (the one to write on a whiteboard)

Peel the head; if `N == 0` it's the answer, otherwise recurse on the tail with
`N-1`. `if constexpr` (C++17) prunes the dead branch so only one path
instantiates per step.

```cpp
#include <cstddef>
#include <utility>

template <std::size_t N, class T, class... Rest>
constexpr decltype(auto) get_nth(T&& head, Rest&&... rest) {
    static_assert(N < 1 + sizeof...(Rest), "get_nth: index out of range");
    if constexpr (N == 0) {
        return std::forward<T>(head);           // base case: this is the one
    } else {
        return get_nth<N - 1>(std::forward<Rest>(rest)...);  // drop head, recurse
    }
}
```

`decltype(auto)` (not plain `auto`) is essential: it preserves the *exact* type
and value category, so passing an lvalue back yields a reference, not a copy.
`std::forward` keeps rvalues movable on the way through.

### Approach 2 — `std::get` on a forwarded tuple

Pack the arguments into a tuple and let the standard library index it. The
subtlety is **what kind of tuple** you build:

```cpp
#include <tuple>
#include <utility>

template <std::size_t N, class... Ts>
constexpr decltype(auto) get_nth_tuple(Ts&&... args) {
    static_assert(N < sizeof...(Ts), "get_nth_tuple: index out of range");
    // forward_as_tuple builds a tuple of REFERENCES (no copies):
    return std::get<N>(std::forward_as_tuple(std::forward<Ts>(args)...));
}
```

`std::forward_as_tuple` builds a `std::tuple<Ts&&...>` of references — **no
arguments are copied or moved**, the tuple just *refers* to them. `std::get<N>`
then returns a reference into it. (Had we used `std::make_tuple`, it would
*decay and copy* every argument into the tuple — correct value, but a copy of
every element. For "just read the Nth", `forward_as_tuple` is the right tool.)
This is the terse, robust, "I trust the standard library" answer.

### Approach 3 — `index_sequence` (drop the first N, grab the next)

The metaprogramming-flavored answer: discard the first `N` arguments, then
return the front of what remains. Useful when you're already in
`index_sequence` territory (e.g. unpacking a tuple).

```cpp
#include <cstddef>
#include <utility>

namespace detail {
    // Variadic helper: ignore the first N args (matched as `...`), return the next.
    template <std::size_t... Drop, class Nth, class... Tail>
    constexpr decltype(auto) pick(std::index_sequence<Drop...>,
                                  decltype((void)Drop, std::declval<void*>())... /*ignored*/,
                                  Nth&& nth, Tail&&...) {
        return std::forward<Nth>(nth);
    }
}
```

In practice this raw form is fiddly; the clean modern realization leans on the
fact that **`std::get` already does the index math for you**, which is why
Approach 2 is what production code (and `std::tuple`'s own internals) uses. Show
Approach 3 to demonstrate you understand `index_sequence`, then say "but I'd ship
Approach 2."

### Verifying it works

```cpp
#include <cassert>
int main() {
    static_assert(get_nth<0>(10, 2.5, 'x') == 10);
    static_assert(get_nth<2>(10, 2.5, 'x') == 'x');

    int v = 7;
    get_nth<0>(v, 1, 2) = 99;     // returns int& -> we can assign through it
    assert(v == 99);              // proves no copy was made

    // get_nth<3>(10, 2.5, 'x');  // <- compile error: index out of range (static_assert)
}
```

The `get_nth<0>(v, ...) = 99;` line is the proof that `decltype(auto)` +
`std::forward` preserved an lvalue reference all the way through.

## Indexing must be compile-time — the key insight

You **cannot** write `get_nth(runtime_n, 10, 2.5, 'x')` for a heterogeneous pack,
because the return type would have to be chosen at runtime. This is the same
reason `std::get<N>` takes `N` as a template parameter, not a function argument,
and why `std::variant` exists (a runtime-tagged union *with* a common visitation
interface). If you genuinely need runtime indexing into heterogeneous data, the
answer is `std::variant` + `std::visit`, or erase to a common type — not
`get_nth`.

For a **homogeneous** pack (all the same type), runtime indexing *is* possible —
spill the pack into an array and subscript it:

```cpp
template <class T, class... Ts>
constexpr const T& get_runtime(std::size_t n, const T& first, const Ts&... rest) {
    const T* arr[] = { &first, &rest... };   // all same type T -> a real array of pointers
    return *arr[n];                          // O(1) runtime index; n may be runtime
}
```

Knowing *when* the runtime version is even legal (homogeneous only) is a strong
signal.

## Low-latency optimizations

- **Zero runtime cost already.** `get_nth<N>` compiles to "return that
  argument" — there is no loop to unroll, no branch to predict. Confirm in the
  asm: it should be a single `mov`/return with everything inlined.
- **Avoid the copy** with `forward_as_tuple` (references) over `make_tuple`
  (copies). For a pack containing a 4 KB struct, that's the difference between
  free and a `memcpy`.
- **Cap instantiation depth.** Prefer the tuple/`index_sequence` form over deep
  recursion if you index large packs in many places — it keeps compile times and
  template-instantiation memory sane.
- **`decltype(auto)`, not `auto`.** Plain `auto` would strip the reference and
  silently copy the selected element.

## Follow-up variations interviewers ask

- **"Now return the *first N* as a tuple."** → `std::make_tuple(get_nth<Is>...)`
  with an `index_sequence<Is...>` you generate via `std::make_index_sequence<N>`.
- **"Sum/transform every element."** → a fold expression
  (`(args + ...)`) — pivot to the *Variadic Templates* material.
- **"Index at *runtime*."** → only legal for a homogeneous pack (array trick);
  otherwise `std::variant` + `std::visit`, or type erasure. Saying *why* is the
  point.
- **"How does `std::get` find the right element on a real tuple?"** → recursive
  inheritance / index math — pivot to *Simple Tuple Implementation*.
- **"C++20 — can a `consteval` version force compile-time evaluation?"** → yes,
  mark it `consteval` to guarantee the index math never leaks to runtime.

## Key takeaways

1. Nth-argument access on a heterogeneous pack is **inherently compile-time** —
   `N` is a non-type template parameter because the return type depends on it.
2. Three idioms: **recursion + `if constexpr`** (whiteboard-friendly), **`std::get`
   on a `forward_as_tuple`** (ship this), and **`index_sequence`** (shows you
   know the machinery).
3. Use **`forward_as_tuple`** (references, no copies) over `make_tuple` (copies),
   and **`decltype(auto)`** + `std::forward` to preserve value category.
4. **Runtime indexing is impossible** for a heterogeneous pack; it's only legal
   for a homogeneous one (array trick), else reach for `variant` + `visit`.
5. The whole thing has **zero runtime cost** — it inlines to a single return; the
   only real tradeoff is template-instantiation depth at compile time.

## Self-check

1. Why must `N` be a template parameter rather than a function argument here?
2. What breaks if you write `auto` instead of `decltype(auto)` as the return
   type? Demonstrate with an lvalue.
3. Why does `forward_as_tuple` avoid copies where `make_tuple` does not?
4. Make `get_nth` reject out-of-range `N` with a clean error. Where does the
   `static_assert` go?
5. When *is* runtime indexing into a pack legal, and how do you implement it?
6. How would you return the first `N` arguments as a `std::tuple`?

## Further reading

- [`std::get` (tuple) — cppreference](https://en.cppreference.com/w/cpp/utility/tuple/get) and [`std::tuple_element` — cppreference](https://en.cppreference.com/w/cpp/utility/tuple/tuple_element)
- [`std::forward_as_tuple` — cppreference](https://en.cppreference.com/w/cpp/utility/tuple/forward_as_tuple) and [`std::make_tuple`](https://en.cppreference.com/w/cpp/utility/tuple/make_tuple)
- [`std::integer_sequence` / `std::index_sequence` — cppreference](https://en.cppreference.com/w/cpp/utility/integer_sequence)
- [`std::variant`](https://en.cppreference.com/w/cpp/utility/variant) and [`std::visit`](https://en.cppreference.com/w/cpp/utility/variant/visit) — the right tool when the index is genuinely runtime.
- [Parameter pack — cppreference](https://en.cppreference.com/w/cpp/language/parameter_pack) (expansion, `sizeof...`).

## Videos

- CppCon — **"Back to Basics: Templates"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Templates)) — covers packs, `index_sequence`, and tuple indexing.
- CppCon — Jason Turner, **C++ Weekly** episodes on `std::index_sequence` and `std::tuple` unpacking ([search](https://www.youtube.com/results?search_query=Jason+Turner+C%2B%2B+Weekly+index_sequence+tuple)).
