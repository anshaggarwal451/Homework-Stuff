# Enums and Strong Enums

> **Why a quant dev must own this:** Message types, order sides, venue ids, and
> protocol tags are all enumerations — and they ride on the wire as raw
> integers. Pick the wrong enum and you get silent `int` conversions that let
> `Side::Buy` compare equal to `OrderType::Limit`, an underlying type that
> doesn't match the spec's field width, and `switch`es that quietly fall through
> on a new message type. Scoped enums are a small feature that prevents a large
> class of correctness bugs.

## First principles: a named set of integers

An enumeration is a type whose values are a fixed, named set, represented under
the hood by an integer (the **underlying type**). The whole point is to replace
magic numbers with names that carry meaning and let the type system help you. The
question C++ makes you answer is *how much* the type system helps — and that's
the difference between the old unscoped `enum` and the C++11 scoped `enum class`.

## Unscoped enums and their two leaks

```cpp
enum Color { Red, Green, Blue };   // Red=0, Green=1, Blue=2 by default

Color c = Green;
int x = c;            // (1) implicit conversion to int — no cast needed
if (c == 1) { }       // compiles! Color silently compared to int
```

The classic C-style `enum` has two design leaks:

1. **Implicit conversion to `int`.** An unscoped enumerator decays to its
   integer value anywhere an integer is expected. Convenient for array indexing,
   but it means the compiler won't stop you mixing unrelated enums or comparing
   an enum to a raw number.
2. **Name leakage.** The enumerators are injected into the *enclosing* scope, not
   namespaced under the enum's name:

```cpp
enum Side  { Buy, Sell };
enum Light { Buy, Stop };   // ERROR: redefinition of 'Buy'
```

Two unrelated enums can't both have a `Buy`/`Open`/`None`. In a large trading
codebase this collision is constant. You can give an unscoped enum an explicit
underlying type (C++11) — `enum Color : std::uint8_t { ... };` — but the two
leaks remain.

## Scoped enums (`enum class`) — the modern default

```cpp
enum class Side : std::uint8_t { Buy, Sell };   // C++11; underlying type uint8_t

Side s = Side::Buy;          // must qualify: Side::Buy
// int x = s;                // ERROR: no implicit conversion
// if (s == 0) { }           // ERROR: no comparison to int
int x = static_cast<int>(s); // explicit conversion required
```

`enum class` fixes both leaks:

1. **No implicit conversion** to (or from) the underlying integer — you must
   `static_cast`. `Side::Buy == 0` won't compile, and neither will comparing a
   `Side` to an `OrderType`.
2. **Scoped names** — enumerators live under the enum name (`Side::Buy`), so two
   enums can each have a `Buy` without colliding.

This is the right default for essentially all new code. The minor cost is
verbosity, which C++20's `using enum` relieves (below).

| | unscoped `enum` | scoped `enum class` |
|---|---|---|
| Implicit → int | **yes** (a leak) | no (must cast) |
| Names scoped | no (leak into enclosing scope) | yes (`E::Value`) |
| Explicit underlying type | C++11 optional | optional, defaults to `int` |
| Forward-declarable | only with explicit underlying type | yes |
| Default for new code | rarely | **almost always** |

## Controlling the underlying type — and why it's load-bearing

You can fix the storage type for either kind of enum:

```cpp
enum class MsgType : std::uint8_t {   // exactly one byte on the wire
    NewOrder  = 'N',
    Cancel    = 'C',
    Execution = 'E',
};
static_assert(sizeof(MsgType) == 1);
```

- For a **scoped** enum the underlying type defaults to **`int`**; if unspecified
  it is always fixed at `int`.
- For an **unscoped** enum *without* an explicit underlying type, the underlying
  type is **implementation-defined** (chosen to fit the values), which is a
  portability hazard for serialization.

When an enum mirrors a protocol field, **always pin the underlying type** to
match the spec's width (`uint8_t`, `uint16_t`, …). That makes `sizeof` exact,
keeps the value in range, and — bonus — lets you forward-declare the enum in a
header without its full definition.

## `using enum` — verbosity relief (C++20)

C++20 lets you pull a scoped enum's names into a scope so you can drop the
qualifier where it's unambiguous — most usefully inside a `switch`:

```cpp
const char* name(Side s) {
    switch (s) {
        using enum Side;     // C++20: Buy/Sell now visible unqualified here
        case Buy:  return "BUY";
        case Sell: return "SELL";
    }
    return "?";
}
```

You get the safety of `enum class` without `Side::` on every label.

## Enums as bit flags

A common idiom: an enum of single-bit values OR'd into a flag set. With
`enum class` the lack of implicit conversion means `|` and `&` don't work out of
the box — you either cast or (better) define typed operators once:

```cpp
enum class Perm : std::uint8_t {
    None  = 0,
    Read  = 1 << 0,
    Write = 1 << 1,
    Exec  = 1 << 2,
};

constexpr Perm operator|(Perm a, Perm b) {
    return static_cast<Perm>(static_cast<std::uint8_t>(a) |
                             static_cast<std::uint8_t>(b));
}
constexpr bool has(Perm set, Perm flag) {
    return (static_cast<std::uint8_t>(set) &
            static_cast<std::uint8_t>(flag)) != 0;
}

Perm p = Perm::Read | Perm::Write;
if (has(p, Perm::Write)) { /* ... */ }
```

The scoped enum forces you to be explicit about treating the value as bits —
which is exactly the discipline you want for a flags field. (Libraries like
`magic_enum` or a small `enable_bitmask` trait automate the operator boilerplate.)

## `switch` exhaustiveness

A `switch` over an enum is the place the compiler can help you most — *if* you
let it:

```cpp
// Compile with -Wswitch (in -Wall): warns if an enumerator is unhandled
// AND there is no `default`.
double fee(Side s) {
    switch (s) {
        case Side::Buy:  return 0.0;
        case Side::Sell: return 0.0;
        // no default: add a new enumerator later and -Wswitch flags THIS switch
    }
}
```

`-Wswitch` (part of `-Wall`) warns when a `switch` on an enum omits an
enumerator *and* has no `default`. **Deliberately omit the `default`** in
switches that should handle every case: then adding `Side::Short` next quarter
turns into a compiler warning (an error under `-Werror`) at every switch that
forgot it — instead of a silent fall-through in production. This is one of the
highest-leverage habits in protocol code.

## `std::to_underlying` — the clean cast (C++23)

Converting a scoped enum to its integer is common (logging, indexing,
serializing). The verbose `static_cast<std::underlying_type_t<E>>(e)` got a name
in C++23:

```cpp
#include <utility>   // C++23
MsgType m = MsgType::Execution;
auto raw = std::to_underlying(m);   // uint8_t value 'E', no repetition of the type
```

It deduces the underlying type for you, so a later change from `uint8_t` to
`uint16_t` doesn't silently leave a wrong cast behind. Pre-C++23, write a tiny
`to_underlying` yourself with `static_cast<std::underlying_type_t<E>>`.

## Enums in wire protocols and message types

This is where it all comes together. An exchange message header has a one-byte
type tag; you model it as a scoped enum with a pinned underlying type:

```cpp
enum class ITCHType : char {   // SoupBinTCP/ITCH-style single-char tags
    AddOrder    = 'A',
    OrderExec   = 'E',
    OrderCancel = 'X',
    Trade       = 'P',
};

void dispatch(const std::byte* msg) {
    auto type = static_cast<ITCHType>(std::to_integer<char>(msg[0]));
    switch (type) {                 // -Wswitch keeps this exhaustive
        case ITCHType::AddOrder:    /* ... */ break;
        case ITCHType::OrderExec:   /* ... */ break;
        case ITCHType::OrderCancel: /* ... */ break;
        case ITCHType::Trade:       /* ... */ break;
    }
}
```

Two rules earn their keep here: a **fixed underlying type** so the enum is
exactly the wire width, and **no implicit conversion** so a `MsgType` can never
be silently passed where a `VenueId` is expected. The explicit `static_cast` at
the deserialization boundary is the *one* place you intentionally cross from
"raw byte" to "typed value."

## Performance & hardware reality

- An enum is just an integer — **zero runtime cost** versus the bare integer. The
  difference between `enum` and `enum class` is purely compile-time type safety;
  the generated code is identical.
- A small underlying type (`uint8_t`) makes structs and messages **more compact**,
  improving cache density when you store millions of them. But beware: a
  one-byte enum *member* may still be padded inside a struct unless the
  surrounding layout is packed.
- `switch` over a dense enum compiles to a **jump table** (one indirect branch)
  or a balanced comparison tree for sparse values; both are fast, and the
  compiler chooses. Exhaustive switches don't cost more than non-exhaustive ones.

## Quant/HFT relevance & interview gotchas

- **"`enum` vs `enum class`?"** Scoped: no implicit int conversion, scoped names,
  forward-declarable; the modern default. Be able to state both leaks of the old
  enum.
- **"Why pin the underlying type?"** Exact wire width, range safety,
  forward-declaration. Scoped enums default to `int`; unscoped without a fixed
  type are implementation-defined.
- **"How do you make adding a message type safe?"** Exhaustive `switch` with **no
  `default`** + `-Wswitch -Werror` so every unhandled case becomes a build break.
- **"Convert a scoped enum to its int?"** `std::to_underlying` (C++23) or
  `static_cast<std::underlying_type_t<E>>`.
- **Bit flags with `enum class`** require defining the operators (or a trait) —
  know why and how.
- **Gotcha:** comparing two different unscoped enums compiles via int promotion;
  with `enum class` it's a compile error. The error is the feature.

## Key takeaways

1. Unscoped `enum` has two leaks: **implicit conversion to `int`** and
   **name leakage** into the enclosing scope.
2. **`enum class`** fixes both — explicit casts only, scoped names — and is the
   right default for new code; the generated code is identical.
3. **Pin the underlying type** (`: std::uint8_t`, …) whenever the enum touches a
   wire format; scoped enums default to `int`, unscoped-unfixed is
   implementation-defined.
4. Write **exhaustive `switch`es with no `default`** and build with
   `-Wswitch -Werror` so new enumerators force you to handle them.
5. **`using enum`** (C++20) removes qualifier noise; **`std::to_underlying`**
   (C++23) is the clean enum→int conversion.
6. For bit flags, scoped enums make you define typed `|`/`&` operators — explicit
   by design.

## Self-check

1. Name the two problems with C-style `enum` that `enum class` solves.
2. What is the underlying type of `enum class E { A, B };` if unspecified? Of an
   unscoped `enum E { A, B };`?
3. Why does pinning `: std::uint8_t` matter for a message-type enum, and what
   else does it enable?
4. How do you make a `switch` over a `Side` enum break the build when a new
   `Side` is added?
5. Why don't `|` and `&` work directly on an `enum class`, and how do you enable
   them?
6. Write the C++23 one-liner to get the integer value of a scoped enum `e`.

## Further reading

- [Enumeration declaration (scoped & unscoped) — cppreference](https://en.cppreference.com/w/cpp/language/enum)
- [`std::to_underlying` — cppreference](https://en.cppreference.com/w/cpp/utility/to_underlying) and [`std::underlying_type` — cppreference](https://en.cppreference.com/w/cpp/types/underlying_type)
- [`using enum` declaration — cppreference](https://en.cppreference.com/w/cpp/language/enum#Using-enum-declaration)
- [C++ Core Guidelines: Enum.3 (prefer `enum class`) and the Enum section](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#Renum-class)
- [Enumerations — `[enum]` (C++ draft)](https://eel.is/c++draft/enum)
- [`magic_enum` — reflection for enums (Neargye)](https://github.com/Neargye/magic_enum) — names, iteration, bitset helpers.

## Videos

- Jonathan Boccara, CppCon — **"Strong types for safe code" / Back to Basics talks on type safety** ([search](https://www.youtube.com/results?search_query=CppCon+Jonathan+Boccara+strong+types)).
- CppCon — **"Back to Basics: Enums in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Enums)).
