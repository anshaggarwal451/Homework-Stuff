# Variadic Templates

> **Why a quant dev must own this:** Variadic templates are how you write *one*
> piece of generic machinery that works for any number of typed arguments —
> `emplace`, `make_*`, type-safe logging, tuple-like records, dispatch tables —
> with **all the work done at compile time** and nothing left for the CPU to do
> at runtime. The classic C `printf`/`va_list` mechanism is type-unsafe and
> opaque to the optimizer; a variadic template is type-checked, fully inlinable,
> and the loop over arguments is *unrolled out of existence*. They are the
> bedrock of `std::tuple`, perfect forwarding, and most metaprogramming asked
> about in HFT interviews.

(Standard: **C++17** — fold expressions are the headline C++17 feature; `if
constexpr` is used too. C++11/14 recursion is shown for contrast, C++20 notes
flagged.)

## First principles: a parameter pack is a list of types/values

A **template parameter pack** stands for zero or more template arguments; a
**function parameter pack** stands for the matching function arguments. The
`...` is the syntax that both *declares* a pack and later *expands* it.

```cpp
template <class... Ts>          // Ts is a *template* parameter pack (types)
void f(Ts... args) {            // args is a *function* parameter pack (values)
    // ...
}

f();                 // Ts = {},               args = {}
f(1);                // Ts = {int},            args = {1}
f(1, 2.0, "three");  // Ts = {int,double,const char*}, args = {1,2.0,"three"}
```

Each call instantiates a *different* function with a fixed, known arity. There
is no runtime list being walked — by the time the binary exists, the pack has
been turned into N concrete arguments.

### `sizeof...` — the size of a pack

```cpp
template <class... Ts>
constexpr std::size_t count(Ts&&...) { return sizeof...(Ts); }   // compile-time
static_assert(count(1, 2.0, 'x') == 3);
```

`sizeof...(Ts)` (or `sizeof...(args)`) yields the **number of elements** as a
`constexpr std::size_t`. Note the spelling: `sizeof...`, not `sizeof`.

## Pack expansion: where the magic (and the syntax) lives

A pattern followed by `...` is **expanded**: the compiler repeats the pattern
once per pack element, comma-separated. The pattern can be arbitrarily rich —
the pack name just has to appear somewhere in it.

```cpp
template <class... Ts>
void forward_all(Ts&&... args) {
    g(std::forward<Ts>(args)...);   // expands to g(fwd<T0>(a0), fwd<T1>(a1), ...)
}

template <class... Ts>
auto make_array(Ts... xs) {
    return std::array{ static_cast<int>(xs)... };  // {cast(x0), cast(x1), ...}
}
```

The whole left-hand expression `std::forward<Ts>(args)` is the pattern; `...`
repeats *it*, keeping `Ts` and `args` in lock-step.

## Folding the pack — C++17 fold expressions

Before C++17, "do something with *every* element" meant recursion (below).
C++17 added **fold expressions**: a compact way to apply a binary operator
across a pack.

```cpp
template <class... Ts>
auto sum(Ts... xs) {
    return (xs + ...);            // unary right fold:  x0 + (x1 + (x2 + ...))
}

template <class... Ts>
bool all_true(Ts... xs) {
    return (xs && ...);           // short-circuits, all compile-time-shaped
}

template <class... Ts>
void print(const Ts&... xs) {
    ((std::cout << xs << ' '), ...);   // fold over the comma operator: do, for each
}
```

The four fold forms — memorize the bracket placement:

```text
( pack op ... )            unary right fold   x0 op (x1 op (... op xN))
( ... op pack )            unary left  fold   (((x0 op x1) op x2) ... op xN)
( pack op ... op init )    binary right fold   x0 op (... op (xN op init))
( init op ... op pack )    binary left  fold   ((init op x0) op ...) op xN
```

> **Empty-pack rule:** a *unary* fold over an empty pack is only valid for
> `&&` (yields `true`), `||` (yields `false`), and `,` (yields `void()`). For
> everything else (e.g. `+`), use a **binary** fold with an identity:
> `(xs + ... + 0)` sums an empty pack to `0`. Interviewers love this edge.

A binary fold also lets you process each element with a side effect cleanly:

```cpp
template <class... Ts>
void log_fields(std::ostream& os, const Ts&... xs) {
    bool first = true;
    (( os << (first ? "" : ",") << xs, first = false ), ...);  // CSV row, no trailing comma
}
```

## Recursion vs fold: the pre-C++17 idiom and when you still need it

Before folds, you peeled one argument off the front and recursed, with a base
case for the empty pack:

```cpp
// C++11/14 recursion. Head/tail style.
void print() {}                                   // base case: empty pack

template <class T, class... Rest>
void print(const T& head, const Rest&... tail) {
    std::cout << head << ' ';
    print(tail...);                               // recurse on the remaining pack
}
```

This works but generates a chain of N+1 function instantiations (one per
suffix), which costs compile time and can bloat code. Modern code prefers a
fold for "apply an operator/expression to each element". You still reach for
recursion (or `if constexpr`) when the **per-element logic differs by position
or type**, or when you need to *transform* the pack into a new structure (e.g.
building a tuple). `if constexpr` (C++17) often replaces the separate base-case
overload:

```cpp
template <class T, class... Rest>
void print2(const T& head, const Rest&... tail) {
    std::cout << head;
    if constexpr (sizeof...(tail) > 0) {          // dead branch pruned at compile time
        std::cout << ' ';
        print2(tail...);
    }
}
```

## Perfect-forwarding a pack — the workhorse pattern

The single most common variadic pattern in performance code: take a pack by
forwarding reference and forward each element with `std::forward`, preserving
value category so nothing gets copied that could be moved. (See *Perfect
Forwarding* for the why.)

```cpp
template <class T, class... Args>
T make(Args&&... args) {
    return T(std::forward<Args>(args)...);   // construct T in place from the pack
}

// This is exactly the shape of std::make_unique / emplace_back:
template <class T, class... Args>
std::unique_ptr<T> my_make_unique(Args&&... args) {
    return std::unique_ptr<T>(new T(std::forward<Args>(args)...));
}
```

Note `std::forward<Args>(args)...` — the `...` expands `std::forward<Args>(args)`
as a unit, so `Args` and `args` stay paired element-by-element.

## Worked example: type-safe, allocation-free logging

A `printf` that can't lie about its format string and compiles to straight-line
code:

```cpp
#include <iostream>

template <class... Ts>
void log(std::ostream& os, const Ts&... xs) {
    os << "[LOG] ";
    ((os << xs), ...);          // fold over comma: stream each argument
    os << '\n';
}

// log(std::cerr, "order ", 42, " filled @ ", 100.25);
//   -> exactly: os<<"order "; os<<42; os<<" filled @ "; os<<100.25;
```

There is **no `va_list`, no format-string parsing at runtime, no type erasure**.
Each `operator<<` is resolved and inlined at compile time. Compare to C's
`printf("%d", x)` where a wrong specifier is undefined behavior the compiler
can't always catch.

## Compile-time codegen: the real low-latency benefit

The variadic loop is **not a loop**. `sum(a, b, c)` does not iterate — it expands
to `a + b + c`, three adds with no counter, no branch, no bounds check. This is
why variadics are everywhere in hot-path libraries:

- **No type erasure / no `void*`** — every type is known, so every call inlines.
- **No runtime arity** — `sizeof...` is `constexpr`; you can `static_assert` on
  it, pick code paths with `if constexpr`, or size a stack array exactly.
- **Move-friendly** — forwarding a pack means in-place construction
  (`emplace_back`) instead of construct-then-copy.

```text
                       printf / va_list        variadic template
type safety            none (UB on mismatch)   full, compile-time
runtime arity scan     yes (walks the list)    none (arity is fixed per instantiation)
inlinable              no (opaque to optimizer) yes (monomorphic)
codegen                one function            one per (type list) — may bloat
```

The tradeoff is the same as all templates: **code bloat and build time**. A
variadic instantiated across hundreds of distinct type lists can blow up I-cache
and compile times. Mitigate by funneling into a small non-template core once the
types are erased at the boundary (e.g. forward into a `std::string_view` /
`std::span` sink).

## Quant/HFT relevance & interview gotchas

- **`emplace_back` is a forwarded variadic pack** — knowing *why*
  `v.emplace_back(a, b)` constructs in place while `v.push_back(T(a,b))` builds a
  temporary then moves is a staple question.
- **Empty-pack folds** — `(xs + ...)` on an empty pack is ill-formed; only
  `&&`, `||`, `,` have identities. Always reach for the binary form with an
  explicit identity in library code.
- **`sizeof...(Ts)` vs `sizeof(Ts...)`** — only the first is legal; it counts
  elements, not bytes.
- **Pattern expansion stays in lock-step** — `f(std::forward<Args>(args)...)`
  expands the *whole* sub-expression per element; expanding two packs of equal
  length together (`g(a..., b...)` is wrong, `g(pair(a,b)...)` is right) is a
  common trap.
- **Fold replaced recursion in C++17** — be ready to write both and say when
  recursion (or `if constexpr`) is still required (position/type-dependent
  per-element logic, or building a new structure).

## Key takeaways

1. A **parameter pack** holds zero-or-more types/values; `...` both declares
   and expands it; `sizeof...` gives its count as a `constexpr`.
2. **Pack expansion** repeats a *pattern* once per element — the pack name
   appears inside the pattern (`std::forward<Ts>(args)...`).
3. **Fold expressions (C++17)** apply a binary operator across a pack in four
   forms; prefer them over hand-rolled recursion for per-element work.
4. **Empty-pack unary folds** are valid only for `&&`, `||`, `,`; use a binary
   fold with an identity otherwise.
5. The pack "loop" is **unrolled at compile time** — type-safe, inlinable, no
   `va_list`, no runtime arity — at the cost of per-instantiation code bloat.

## Self-check

1. Write `product(Ts...)` that returns `1` for an empty pack and the product
   otherwise. Which fold form must you use, and why?
2. What does `(std::cout << ... << xs)` do, and how does it differ from
   `((std::cout << xs), ...)`?
3. Explain why `g(a..., b...)` does not interleave two packs. How *do* you
   process two equal-length packs together?
4. Convert this recursive `print` into a single fold expression. When could you
   *not* do that?
5. Why does `emplace_back(args...)` avoid a temporary that `push_back(T(args...))`
   creates? What pack pattern makes that possible?
6. What is the type and value of `sizeof...(Ts)` when the pack is empty?

## Further reading

- [Parameter pack — cppreference](https://en.cppreference.com/w/cpp/language/parameter_pack)
- [Fold expressions — cppreference](https://en.cppreference.com/w/cpp/language/fold)
- [`if constexpr` — cppreference](https://en.cppreference.com/w/cpp/language/if#Constexpr_if)
- [`sizeof...` operator — cppreference](https://en.cppreference.com/w/cpp/language/sizeof...)
- Scott Meyers, *Effective Modern C++*, Items 23–25 (forwarding references and forwarding packs).
- [Fold Expressions — Modernes C++ (Rainer Grimm)](https://www.modernescpp.com/index.php/fold-expressions/) — worked examples of all four forms.

## Videos

- CppCon — Andrei Alexandrescu, **"Variadic Templates are Funadic"** ([search](https://www.youtube.com/results?search_query=CppCon+Alexandrescu+Variadic+Templates+are+Funadic)) — the canonical talk on the topic.
- CppCon — **"Back to Basics: Variadic Templates"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Variadic+Templates)) — packs, expansion, and folds from scratch.
