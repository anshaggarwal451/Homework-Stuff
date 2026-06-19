# Simple Tuple Implementation

> **Why a quant dev must own this:** `std::tuple` is the prototypical
> heterogeneous container — the thing you reach for when a function must return
> several typed values, when you forward a constructor's arguments, or when you
> build a compile-time record (a fixed-layout market-data message, a row of a
> column store). Implementing it from scratch exposes recursive templates,
> `get<I>` index resolution, the **empty base optimization**, and the fact that
> *physical layout is unspecified* — all of which matter when you care about
> bytes and cache lines. It's a classic "do you really understand templates"
> interview build.

(Standard: **C++17** — `if constexpr`, fold expressions, `std::index_sequence`,
EBO. C++20 notes flagged.)

## Problem statement

Implement `tuple<Ts...>` storing one value of each type in `Ts...`, with:

- A constructor from the elements.
- `get<I>(t)` returning a reference to the `I`-th element (compile-time `I`).
- Correct support for empty types via **EBO** (a `tuple<>` of empties should be
  size 1, a `tuple<Empty, int>` should be `sizeof(int)`).
- `tuple_size` and `tuple_element` traits (so structured bindings could work).

## Clarifying constraints & assumptions

- **`I` is compile-time** — like *Nth Argument Access*, the element type varies
  with the index, so `get` must take `I` as a template parameter, not a runtime
  argument.
- **Heterogeneous, fixed arity** — the types are baked into the tuple type.
- **Value category preserved** — `get` should return `T&` / `const T&` / `T&&`
  matching the tuple's category, and never copy.
- **Layout is *not* part of the contract.** The standard does **not** specify
  the physical order of tuple members, only that `get<I>` finds the right one.
  We'll exploit that freedom for EBO — and discuss why it bites people.

## Two classic implementation strategies

```text
strategy                what holds the data            EBO?     get<I> cost
recursive inheritance   each "layer" is a base class    natural  walk I bases (compile time)
recursive member        a `head` + nested `tail` member needs    chase .tail.tail...head
                                                        wrapper
flat / index_sequence   one base per index (modern)     natural  direct, no recursion
```

We'll build the **recursive-inheritance** version (the one most often asked,
and how older libstdc++ did it), then note the modern flat variant libc++/recent
libstdc++ actually use.

## Approach: recursive inheritance

Peel the first type `Head` off; store it; *inherit* from a `tuple<Tail...>` that
stores the rest. The recursion bottoms out at the empty `tuple<>`. Because each
layer is a base subobject, **empty `Head`s collapse to zero size via EBO** —
which a member-based design can't do without extra machinery.

```cpp
#include <cstddef>
#include <utility>
#include <type_traits>

// ---- primary template + empty base case ----------------------------------
template <class... Ts>
struct tuple {};                                  // tuple<> : empty, the recursion floor

template <class Head, class... Tail>
struct tuple<Head, Tail...> : private tuple<Tail...> {  // inherit the rest
    Head head_;

    constexpr tuple() = default;

    // Construct: initialize this layer's head, forward the rest to the base.
    template <class H, class... T,
              class = std::enable_if_t<sizeof...(T) == sizeof...(Tail)>>
    constexpr tuple(H&& h, T&&... t)
        : tuple<Tail...>(std::forward<T>(t)...),   // base gets the tail
          head_(std::forward<H>(h)) {}             // this layer gets the head

    using base = tuple<Tail...>;
    constexpr base&       tail()       noexcept { return *this; }
    constexpr const base& tail() const noexcept { return *this; }
};
```

> **EBO via `private` inheritance is doing real work here.** If `Tail...` is
> empty, `tuple<Tail...>` is `tuple<>` — an empty base — and contributes **0
> bytes**. Storing it as a *member* would force ≥1 byte and padding. This is the
> same EBO motivation as the `unique_ptr` deleter.

### `get<I>` — resolve the index at compile time

`get<I>` peels `I` layers of base class, then returns that layer's `head_`. The
index math is done with `if constexpr` recursion (clean in C++17). We need a way
to name "the type at index I" too.

```cpp
// ---- tuple_element: the type at index I -----------------------------------
template <std::size_t I, class T>
struct tuple_element;                                  // primary (declared)

template <std::size_t I, class Head, class... Tail>
struct tuple_element<I, tuple<Head, Tail...>>
    : tuple_element<I - 1, tuple<Tail...>> {};         // recurse, decrement I

template <class Head, class... Tail>
struct tuple_element<0, tuple<Head, Tail...>> {        // base: I == 0 -> Head
    using type = Head;
};

template <std::size_t I, class T>
using tuple_element_t = typename tuple_element<I, T>::type;

// ---- get<I>: walk I base layers, return head_ ------------------------------
template <std::size_t I, class Head, class... Tail>
constexpr auto& get(tuple<Head, Tail...>& t) noexcept {
    if constexpr (I == 0)
        return t.head_;                                // found it
    else
        return get<I - 1>(t.tail());                   // descend into the base
}

// const and rvalue overloads preserve value category:
template <std::size_t I, class Head, class... Tail>
constexpr const auto& get(const tuple<Head, Tail...>& t) noexcept {
    if constexpr (I == 0) return t.head_;
    else                  return get<I - 1>(t.tail());
}

template <std::size_t I, class Head, class... Tail>
constexpr auto&& get(tuple<Head, Tail...>&& t) noexcept {
    if constexpr (I == 0) return std::move(t.head_);   // move-from rvalue tuple
    else                  return get<I - 1>(std::move(t).tail());
}
```

`if constexpr` means only the taken branch is instantiated, so each `get<I>`
expands to a *single* member access through `I` (free) inherited subobjects —
**no runtime loop, no branch**; it compiles to one `mov`.

### `tuple_size` and verifying

```cpp
// ---- tuple_size: how many elements ----------------------------------------
template <class T> struct tuple_size;
template <class... Ts>
struct tuple_size<tuple<Ts...>>
    : std::integral_constant<std::size_t, sizeof...(Ts)> {};

template <class T>
inline constexpr std::size_t tuple_size_v = tuple_size<T>::value;

// ---- it works -------------------------------------------------------------
#include <string>
int main() {
    tuple<int, double, char> t(1, 2.5, 'x');
    static_assert(tuple_size_v<decltype(t)> == 3);
    static_assert(std::is_same_v<tuple_element_t<1, decltype(t)>, double>);

    int& r = get<0>(t);                 // reference into the tuple, no copy
    r = 99;                             // mutates the stored element
    // get<0>(t) == 99 now

    auto e = [](auto x){ return x; };   // any callable
    e(get<2>(t));                       // 'x'
}
```

## Why layout & order matter (the part interviewers love)

Two things bite people:

**1. The standard does not specify physical layout.** `get<I>` is guaranteed to
return the I-th element, but *where it sits in memory is unspecified*. In the
recursive-inheritance design above, the **last** type in the list is the
deepest base — typically the *lowest* address — so the in-memory order is often
the **reverse** of the declaration order. You must **never** `memcpy` a
`std::tuple` onto a wire or `reinterpret_cast` a buffer to a tuple and expect
declaration order. For a fixed wire format, use a `struct` (whose member order
*is* the layout) — not a tuple.

```text
tuple<A, B, C> with recursive-inheritance layout (one common realization):

   declaration order:   A , B , C
   memory order:        C , B , A      <- often REVERSED; unspecified by the standard
```

**2. Member order affects size via padding.** Even in a `struct`, ordering
members large-to-small minimizes padding; in a tuple you don't control this, and
different standard libraries lay tuples out differently. So:

- `sizeof(tuple<char, int, char>)` can differ from a hand-packed struct.
- EBO only helps for *empty* types; non-empty members still pad per the ABI.

> **Senior answer:** "A tuple is for *logical* grouping of heterogeneous values,
> not for *physical* layout control. If bytes/offsets matter — a packed
> exchange message, a column-store row — use a `struct` (or a packed struct) so
> the layout is part of the type, and never serialize a tuple by `memcpy`."

## The modern flat alternative (what libc++ actually does)

Recursive inheritance is `O(N)` instantiation depth and can pile up debug-info
and compile time for wide tuples. Modern libraries use a **flat** layout: one
base per *index*, generated from an `index_sequence`, so all leaves are siblings
rather than nested:

```cpp
template <std::size_t I, class T>
struct leaf { [[no_unique_address]] T value; };   // C++20: EBO without inheritance trick

template <class Seq, class... Ts> struct tuple_impl;
template <std::size_t... Is, class... Ts>
struct tuple_impl<std::index_sequence<Is...>, Ts...> : leaf<Is, Ts>... {};
// get<I> casts to leaf<I, T_I>& and reads .value — O(1), no recursion to descend.
```

This keeps `get<I>` a *direct* base cast (no walking), flattens instantiation,
and uses `[[no_unique_address]]` (C++20) instead of the private-base EBO trick.
Worth mentioning to show you know the production design.

## Low-latency optimizations & reality

- **Zero runtime cost.** `get<I>` inlines to a single member access; constructing
  a tuple is constructing its members. There is no indirection or allocation.
- **EBO removes empty-type overhead** — a `tuple` of stateless functors/tags is
  as small as its non-empty members. Verify with `sizeof`.
- **Layout is the catch.** Because order is unspecified and often reversed,
  a tuple is *not* a drop-in for a wire struct. Don't put a tuple on a hot
  serialization path expecting a known layout.
- **Compile-time cost** grows with recursion depth — prefer the flat design (or
  just use `std::tuple`, which libraries have tuned) for wide tuples.
- **Structured bindings** (`auto [a,b,c] = t;`) need `tuple_size`,
  `tuple_element`, and `get` — implementing the three traits above is exactly
  the customization point that makes your type bindable.

## Follow-up variations interviewers ask

- **"Add `get<T>` (by type, not index)."** → C++14 feature; ambiguous (ill-formed)
  if the type appears more than once. Resolve via a trait that finds the unique
  index of `T`.
- **"Make structured bindings work."** → specialize `std::tuple_size`,
  `std::tuple_element`, and provide `get` in the right namespace/found by ADL.
- **"Why is tuple layout reversed / unspecified?"** → recursive inheritance puts
  the tail deepest; the standard deliberately leaves layout free so libraries
  can optimize. Hence: never `memcpy` a tuple.
- **"Compare recursive-inheritance vs flat `index_sequence` designs."** →
  instantiation depth, `get` cost, debug info; libc++ uses flat.
- **"How would you store a heterogeneous *record* with a guaranteed layout?"** →
  a `struct` / packed struct, not a tuple.

## Key takeaways

1. A tuple is built by **recursion over the type pack**: store the head, inherit
   (or nest) the tail; `tuple<>` is the empty base case.
2. **`get<I>`** resolves the index at *compile time* (`if constexpr` recursion or
   a direct base cast) and inlines to a single member access — zero runtime cost.
3. **EBO** (private base, or C++20 `[[no_unique_address]]`) makes empty element
   types contribute **0 bytes** — the main reason the inheritance design exists.
4. **Physical layout is unspecified and often reversed** vs declaration order;
   never `memcpy`/`reinterpret_cast` a tuple as a wire format — use a `struct`.
5. `tuple_size` + `tuple_element` + `get` are the trio that powers
   `tuple_element_t`, generic unpacking, and **structured bindings**.

## Self-check

1. Why must `get` take `I` as a template parameter rather than a runtime
   argument?
2. How does private inheritance from `tuple<Tail...>` give you EBO that a member
   `tail_` would not? What `sizeof` result demonstrates it?
3. In the recursive-inheritance design, why is the in-memory order often the
   reverse of the declaration order, and why is relying on it a bug?
4. Trace `get<2>` on `tuple<int,double,char>`: which base layers are descended,
   and what does it compile to?
5. What three traits/functions must you provide for `auto [a,b,c] = t;` to work?
6. When would you choose the flat `index_sequence` design over recursive
   inheritance?

## Further reading

- [`std::tuple` — cppreference](https://en.cppreference.com/w/cpp/utility/tuple) and [`std::get` (tuple)](https://en.cppreference.com/w/cpp/utility/tuple/get)
- [`std::tuple_size`](https://en.cppreference.com/w/cpp/utility/tuple/tuple_size) and [`std::tuple_element`](https://en.cppreference.com/w/cpp/utility/tuple/tuple_element)
- [Empty base optimization — cppreference](https://en.cppreference.com/w/cpp/language/ebo) and [`[[no_unique_address]]`](https://en.cppreference.com/w/cpp/language/attributes/no_unique_address) (C++20).
- [Structured bindings — cppreference](https://en.cppreference.com/w/cpp/language/structured_binding) — the `get`/`tuple_size`/`tuple_element` customization points.
- [`std::index_sequence` — cppreference](https://en.cppreference.com/w/cpp/utility/integer_sequence) — the flat-tuple building block.

## Videos

- CppCon — **"Back to Basics: Templates"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Templates)) — recursive templates, packs, and tuple-style indexing.
- CppCon — Jason Turner, **C++ Weekly** on implementing `std::tuple` / structured bindings ([search](https://www.youtube.com/results?search_query=Jason+Turner+C%2B%2B+Weekly+implementing+tuple)).
