# Type Traits and Metafunctions

> **Why a quant dev must own this:** Type traits are how you move decisions from
> *runtime* (a branch, a virtual call, a cache miss) to *compile time* (the dead
> code is gone). In a hot path that processes millions of messages a second,
> "the compiler already chose the right code path for this `T`" is the
> difference between an inlined `mov` and an indirect call. Traits also power
> every serious template library you'll be asked about — `std::vector`'s
> `memcpy` fast path, `std::variant`, lock-free queues that only accept
> trivially-copyable payloads. Knowing how to *write* one, not just use one, is
> a senior signal.

All code here is **C++17** unless a block says otherwise (`concepts`,
`is_*_v` aliases, `if constexpr`); a few notes call out C++20.

## The one-sentence definition

**A metafunction is a compile-time function whose inputs and outputs are types
(or compile-time constants), expressed as a class template.** A *type trait* is
just a metafunction that answers a question about a type ("is `T` an integer?",
"strip the reference off `T`").

Where an ordinary function maps *values to values*, a metafunction maps
*types to types* or *types to constants*. There is no runtime object, no
function call — the "computation" happens entirely during compilation, and what
survives into the binary is only the type or constant it produced.

## The metafunction idiom: `::type` and `::value`

The whole convention rests on two member names. By long-standing standard-library
convention:

- a metafunction returning a **type** exposes it as a nested `::type`;
- a metafunction returning a **value** exposes it as a `static constexpr` member
  `::value`.

```cpp
#include <type_traits>

// Returns a TYPE: strip the reference off T.  std::remove_reference is exactly this.
template <class T> struct remove_ref       { using type = T; };
template <class T> struct remove_ref<T&>   { using type = T; };   // partial specialization
template <class T> struct remove_ref<T&&>  { using type = T; };

// Returns a VALUE: is T 'void'?
template <class T> struct is_void_  { static constexpr bool value = false; };
template <>        struct is_void_<void> { static constexpr bool value = true; };

static_assert(std::is_same_v<remove_ref<int&>::type, int>);
static_assert(is_void_<void>::value);
static_assert(!is_void_<int>::value);
```

The mechanism doing the work is **partial specialization**: the primary template
is the default answer, and each specialization pattern-matches a category of
type and overrides it. That is pattern matching, and it is Turing-complete — the
template instantiation engine *is* a (clumsy) functional language.

### `_t` and `_v` — the boilerplate killers

Writing `typename foo<T>::type` everywhere is noisy, and the `typename` keyword
is mandatory because `foo<T>::type` is a *dependent name* the parser can't
otherwise prove is a type. C++14 added `_t` alias templates and C++17 added
`_v` variable templates so you never spell it:

```cpp
template <class T> using  remove_ref_t = typename remove_ref<T>::type;  // C++14 style
template <class T> inline constexpr bool is_void_v = is_void_<T>::value; // C++17 style

remove_ref_t<int&> x;                    // == int, no 'typename'
static_assert(is_void_v<void>);          // no '::value'
```

The standard library ships both forms for every trait: `std::remove_reference_t`,
`std::is_integral_v`, and so on. **Use the alias forms.**

## `std::true_type` / `std::false_type` — the canonical booleans

Rather than hand-rolling `static constexpr bool value`, traits inherit from one
of two tag types. They are aliases for `std::integral_constant<bool, B>`, which
wraps a compile-time constant as a *type* that also carries a `::value`:

```cpp
// Conceptually:
template <class T, T v>
struct integral_constant {
    static constexpr T value = v;
    using value_type = T;
    using type = integral_constant;          // self
    constexpr operator T() const noexcept { return v; }   // implicit -> v
};
using true_type  = integral_constant<bool, true>;
using false_type = integral_constant<bool, false>;
```

Inheriting from them gives your trait a `::value` *and* makes it a real type you
can pass around and dispatch on:

```cpp
template <class T> struct is_pointer_      : std::false_type {};
template <class T> struct is_pointer_<T*>  : std::true_type  {};
static_assert(is_pointer_<int*>::value && !is_pointer_<int>::value);
```

The implicit conversion to `bool` is what lets `is_pointer_<T*>{}` be used in a
boolean context, and the distinct *types* `true_type`/`false_type` are what make
**tag dispatch** (below) work.

## SFINAE, `void_t`, and detecting capabilities

**SFINAE** — *Substitution Failure Is Not An Error* — is the rule that if
substituting template arguments into a candidate's signature produces an
ill-formed *type*, that candidate is silently removed from the overload set
instead of causing a hard error. This is the lever traits pull to *detect*
whether an expression is valid for a type.

`std::void_t<...>` (C++17) maps any well-formed list of types to `void`, and
that's exactly enough to build a detector:

```cpp
#include <type_traits>
#include <utility>      // std::declval

// Primary: assume T has NO member ::value_type.
template <class T, class = void>
struct has_value_type : std::false_type {};

// Specialization: only viable if 'typename T::value_type' is a valid type.
// If it isn't, substitution fails -> this specialization drops out (SFINAE) ->
// the primary above is selected. No error.
template <class T>
struct has_value_type<T, std::void_t<typename T::value_type>> : std::true_type {};

struct WithVT { using value_type = int; };
static_assert( has_value_type<std::vector<int>>::value);
static_assert( has_value_type<WithVT>::value);
static_assert(!has_value_type<int>::value);
```

You can detect *expressions*, not just nested types, with `decltype` +
`declval` (which conjures a value of any type in an unevaluated context):

```cpp
// Detect whether 'a < b' compiles for T.
template <class T, class = void>
struct is_less_comparable : std::false_type {};

template <class T>
struct is_less_comparable<
    T, std::void_t<decltype(std::declval<const T&>() < std::declval<const T&>())>>
    : std::true_type {};
```

## `enable_if` — SFINAE you steer by hand

`std::enable_if<Cond, T>` has a `::type` member equal to `T` **only when `Cond`
is true**; when false there is no `::type`, so naming `enable_if_t<Cond, T>` in a
signature is a substitution failure that prunes that overload. It is the classic
way to constrain a template before concepts existed.

```cpp
#include <type_traits>

// Two mutually-exclusive overloads selected by a trait, with NO runtime branch.
template <class T, std::enable_if_t<std::is_integral_v<T>,        int> = 0>
T parse(const char* s) { /* fast integer path */ return /*…*/ T{}; }

template <class T, std::enable_if_t<std::is_floating_point_v<T>, int> = 0>
T parse(const char* s) { /* float path */        return /*…*/ T{}; }

auto a = parse<int>("42");      // picks the integral overload
auto b = parse<double>("3.14"); // picks the floating overload
```

The `... = 0` non-type template parameter is the idiomatic placement: it doesn't
touch the function's return type or argument list, and it lets two overloads with
otherwise-identical signatures coexist (their *template* signatures differ).

> **Interview gotcha:** two `enable_if` overloads that differ only in the
> *default value* but have the *same* template parameter list are a redeclaration,
> not an overload — they'll fail to compile. The conditions must produce
> *different* template parameter lists. Put each `enable_if_t<...>` as its own
> defaulted NTTP.

## C++20 concepts — what replaces most of this

Concepts are named, composable, *readable* constraints. They subsume the common
uses of `enable_if`/`void_t` and give vastly better error messages (the compiler
says "constraint not satisfied: T is not integral" instead of a 40-line
instantiation backtrace):

```cpp
#include <concepts>   // C++20

template <std::integral T>           // requires-clause, sugared as a "type-constraint"
T parse(const char* s) { /* … */ return T{}; }

template <std::floating_point T>
T parse(const char* s) { /* … */ return T{}; }

// Custom concept from an expression requirement:
template <class T>
concept LessComparable = requires (const T& a, const T& b) {
    { a < b } -> std::convertible_to<bool>;
};
```

> **The senior answer to "SFINAE vs concepts?"** Concepts are strictly better
> for *constraining* templates: clearer syntax, subsumption-based overload
> ordering (the more-constrained candidate wins automatically, no
> mutually-exclusive bookkeeping), and dramatically better diagnostics. Reach
> for `enable_if`/`void_t` only when you're stuck on a pre-C++20 toolchain — and
> in HFT, that still happens. Traits themselves (`std::is_*`) remain useful
> *under* concepts; a concept is often just `requires`-wrapping a trait.

## `std::conditional` — choosing a type at compile time

`std::conditional_t<B, T, F>` is the ternary operator for types: it *is* `T` when
`B` is true and `F` otherwise. Useful for picking storage based on size, picking
an index type, etc.

```cpp
// Pick the smallest unsigned type that holds N bits.
template <std::size_t Bits>
using uint_for =
    std::conditional_t<(Bits <= 8),  std::uint8_t,
    std::conditional_t<(Bits <= 16), std::uint16_t,
    std::conditional_t<(Bits <= 32), std::uint32_t,
                                     std::uint64_t>>>;

static_assert(std::is_same_v<uint_for<10>, std::uint16_t>);
```

Note that *both* branches must be well-formed types — `conditional` selects, it
does not lazily evaluate. If a branch might be ill-formed, defer it behind
another metafunction's `::type`.

## Tag dispatch — selecting code without an `if`

Tag dispatch turns a *compile-time boolean* into a *type* and uses overload
resolution to pick an implementation. It's the classic pre-`if constexpr` way to
specialize a hot path, and still the cleanest when the two paths have genuinely
different *code*, not just different constants.

```cpp
#include <type_traits>
#include <cstring>

// Bulk-copy N objects. If T is trivially copyable, blast it with memcpy;
// otherwise loop and copy-construct.  Decision made at COMPILE TIME.
template <class T>
void copy_impl(T* dst, const T* src, std::size_t n, std::true_type /*trivial*/) {
    std::memcpy(dst, src, n * sizeof(T));          // one path
}
template <class T>
void copy_impl(T* dst, const T* src, std::size_t n, std::false_type /*non-trivial*/) {
    for (std::size_t i = 0; i < n; ++i) dst[i] = src[i];   // the other
}

template <class T>
void copy(T* dst, const T* src, std::size_t n) {
    // Convert the trait's VALUE into a TYPE (true_type/false_type) and dispatch.
    copy_impl(dst, src, n, std::is_trivially_copyable<T>{});
}
```

This is precisely how `std::copy`/`std::vector` get their `memcpy` fast path. The
unused overload is never instantiated for a given `T`; there is no runtime test.

### `if constexpr` — the modern alternative (C++17)

For two paths that share a function body, `if constexpr` discards the
not-taken branch *at compile time*, so it needn't even be valid for the current
`T`:

```cpp
template <class T>
void copy2(T* dst, const T* src, std::size_t n) {
    if constexpr (std::is_trivially_copyable_v<T>) {
        std::memcpy(dst, src, n * sizeof(T));
    } else {
        for (std::size_t i = 0; i < n; ++i) dst[i] = src[i];
    }
}
```

`if constexpr` is usually clearer for *single-function* branching; tag dispatch
still wins when you want separate, individually-overloadable functions (e.g. ones
a user can further specialize).

## Writing your own trait, end to end

A complete, idiomatic trait: detect whether a type is "POD-like enough" to ship
through a lock-free SPSC queue (must be trivially copyable *and* fit our slot).

```cpp
#include <type_traits>
#include <cstddef>

template <class T, std::size_t SlotBytes>
struct is_queue_payload
    : std::bool_constant<                       // bool_constant<B> == integral_constant<bool,B>
          std::is_trivially_copyable_v<T> &&
          (sizeof(T) <= SlotBytes) &&
          (alignof(T) <= alignof(std::max_align_t))> {};

template <class T, std::size_t SlotBytes>
inline constexpr bool is_queue_payload_v = is_queue_payload<T, SlotBytes>::value;  // _v alias

struct Tick { std::uint64_t ts; double px; std::uint32_t qty; };

static_assert( is_queue_payload_v<Tick, 64>);    // trivially copyable, fits
static_assert(!is_queue_payload_v<std::string, 64>); // not trivially copyable
```

Now a producer can `static_assert(is_queue_payload_v<T, kSlot>)` and reject
unsafe payloads *at compile time* — the wrong type never even links.

## What the compiler actually emits

The payoff is that all of the above evaporates. Consider the tag-dispatch
`copy` for a trivially-copyable `Tick`:

```x86asm
; copy<Tick>(dst, src, n)  ->  the true_type overload is selected at compile time,
; inlined, and becomes a single call to memcpy (often further lowered to rep movs
; / SIMD). There is NO trait object, NO branch on "is trivial", NO virtual call.
        shl     rdx, 4            ; n * sizeof(Tick)  (16 bytes)
        jmp     memcpy            ; tail-call; the dispatch is gone
```

There is no `is_trivially_copyable` flag in the binary, no runtime check, no
`true_type{}` temporary — overload resolution consumed it. **Compile-time
dispatch is zero runtime cost by construction**: the only thing the trait
mechanism can ever produce is "which code got compiled."

## Latency mental model

```text
decision mechanism        when resolved     hot-path cost
------------------------  ----------------  --------------------------------
type trait + tag dispatch compile time      0  (dead code removed)
if constexpr              compile time      0  (untaken branch discarded)
C++20 concept constraint  compile time      0  (just overload selection)
runtime  if (flag)        run time          ~1 predicted branch (+mispredicts)
virtual call              run time          indirect call: load vptr, load slot,
                                            call; defeats inlining; ~3-20+ cyc
```

The whole reason traits matter in low-latency code: every row above the line is
*free at run time*, every row below costs cycles and, worse, blocks the inliner
and the optimizer from seeing through the call.

## Quant/HFT relevance & interview gotchas

- **`memcpy` fast paths.** `std::is_trivially_copyable` gates whether your ring
  buffer / serializer can blast bytes vs. element-wise copy. Get the trait wrong
  and you either corrupt non-trivial types or needlessly slow trivial ones.
- **Lock-free containers** routinely `static_assert(std::is_trivially_copyable_v<T>)`
  and `std::is_nothrow_*` — atomically swappable, no throwing destructor mid-publish.
- **`noexcept` propagation.** `std::is_nothrow_move_constructible` drives whether
  `std::vector` *moves or copies* on reallocation (the strong guarantee). Worth
  being able to explain.
- **`typename` rule.** Be ready to say *why* `typename T::type` needs the keyword
  (dependent name; the compiler can't know it's a type until instantiation).
- **`void_t` mechanics.** A favorite whiteboard task: "write a trait that detects
  whether `T` has a member `foo()`." Know the primary-template-`= void` +
  `void_t<decltype(...)>` specialization pattern cold.
- **SFINAE vs concepts** (above) — lead with concepts, mention you can fall back
  to `enable_if` on older compilers.
- **Traits are values to the optimizer, not the runtime.** Be explicit that a
  trait can *only* change which code is compiled; it cannot exist as a runtime check.
- **`std::conditional` evaluates both branches' validity.** A common trap: people
  expect short-circuiting. Both type arguments must be well-formed.

## Key takeaways

1. A **metafunction** is a class template that maps types/constants to types
   (`::type`) or constants (`::value`); traits are metafunctions answering
   yes/no questions. Prefer the `_t`/`_v` alias spellings.
2. **Partial specialization** is the pattern-matching engine; inherit from
   `std::true_type`/`false_type` (i.e. `integral_constant`) for free `::value`.
3. **SFINAE + `void_t` + `declval`** detect whether a type or expression is
   valid; `enable_if` steers overload resolution by pruning candidates.
4. **C++20 concepts** replace most `enable_if`/`void_t` constraints with readable
   syntax, subsumption ordering, and far better errors. Use them when you can.
5. **Tag dispatch** and **`if constexpr`** turn a compile-time bool into branch-free
   code selection; the untaken path is never even instantiated.
6. All of it is **zero runtime cost**: traits decide *which code exists*, not
   *what runs* — exactly the property you want in a hot path.

## Self-check

1. Why does `typename T::value_type` require the `typename` keyword, but
   `int::value_type` (hypothetically) wouldn't?
2. Implement `has_member_size<T>` (detects `T{}.size()` compiles) using `void_t`.
3. What goes wrong if you write two `enable_if` overloads that share the same
   template parameter list and differ only in the condition? How do you fix it?
4. Does `std::conditional_t<true, int, SomeBrokenType>` compile if `SomeBrokenType`
   is ill-formed? Why or why not?
5. Rewrite the tag-dispatch `copy` using `if constexpr`. When would you still
   prefer the tag-dispatch version?
6. In one sentence, why is a trait-driven dispatch faster than a `virtual` call
   in the hot path?

## Further reading

- [`<type_traits>` — cppreference](https://en.cppreference.com/w/cpp/header/type_traits) — the full catalogue, with the `_t`/`_v` aliases.
- [`std::void_t` — cppreference](https://en.cppreference.com/w/cpp/types/void_t) and [`std::enable_if` — cppreference](https://en.cppreference.com/w/cpp/types/enable_if).
- [`std::integral_constant` / `true_type` — cppreference](https://en.cppreference.com/w/cpp/types/integral_constant).
- [Constraints and concepts (C++20) — cppreference](https://en.cppreference.com/w/cpp/language/constraints).
- Walter E. Brown, ["Modern Template Metaprogramming: A Compendium"](https://www.youtube.com/results?search_query=Walter+Brown+Modern+Template+Metaprogramming+a+compendium) — the talk that popularized `void_t`.
- Vandevoorde, Josuttis & Gregor, *C++ Templates: The Complete Guide* (2nd ed.) — chapters on traits, SFINAE, and `enable_if` are the canonical reference.
- [SFINAE — cppreference](https://en.cppreference.com/w/cpp/language/sfinae) — the precise substitution rules.

## Videos

- Walter E. Brown, CppCon — **"Modern Template Metaprogramming: A Compendium, Parts I & II"** ([search](https://www.youtube.com/results?search_query=Walter+Brown+Modern+Template+Metaprogramming+a+compendium+CppCon)) — traits, `void_t`, tag dispatch from first principles.
- Arthur O'Dwyer, CppCon — **"Template Normal Programming"** ([search](https://www.youtube.com/results?search_query=Arthur+O%27Dwyer+Template+Normal+Programming+CppCon)) — demystifies `typename`, dependent names, and specialization.
- Jason Turner, **C++ Weekly** — episodes on `if constexpr` and concepts ([search](https://www.youtube.com/results?search_query=C%2B%2B+Weekly+Jason+Turner+if+constexpr+concepts)).
