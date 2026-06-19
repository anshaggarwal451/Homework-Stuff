# Type Aliasing

> **Why a quant dev must own this:** Trading code drowns in template
> instantiations, raw integral handles (order IDs, instrument IDs), and scaled
> integers that *look* identical to the compiler but mean completely different
> things — a price and a quantity are both `int64_t`. A type alias buys you
> readability and ABI stability; a *strong* type (a one-field struct, not a
> plain alias) buys you the compiler refusing to let you add a price to a
> quantity. Knowing the difference — and that `using Price = int64_t;` gives you
> *no* safety at all — is a recurring interview probe.

## First principles: an alias is a second name, not a new type

A type alias introduces a **synonym** for an existing type. It creates **zero**
new types: the alias and its target are the *same type* for every purpose the
language cares about — overload resolution, template argument deduction,
linkage, mangled names. The compiler erases the alias almost immediately; it
exists only in your source.

```cpp
using Price = long long;     // C++11 alias-declaration
typedef long long Qty;       // classic C-style typedef — identical meaning

Price p = 100;
Qty   q = 5;
p = q;                       // compiles silently: Price and Qty are both `long long`
```

That last line is the whole lesson in miniature. `Price` and `Qty` are *not*
distinct types — they are the same `long long` wearing two name tags — so the
assignment is legal and silent. Hold that thought; the entire safety section
hinges on it.

### A note on the word "aliasing"

"Aliasing" is overloaded in C++ and the two meanings are unrelated:

- **Type alias** (this lesson): giving a type a second *name* via `using` or
  `typedef`. A pure source-level convenience.
- **Memory aliasing / the strict-aliasing rule**: an optimizer rule about
  *two pointers of different types referring to the same storage*. The compiler
  assumes a `float*` and an `int*` never point at the same object, so it can
  keep values in registers across stores. Violating it (a "type pun" through
  `reinterpret_cast`) is undefined behavior. The blessed escape hatches are
  `std::memcpy`, C++20 `std::bit_cast`, and inspecting bytes through a
  `char`/`unsigned char`/`std::byte` pointer.

They share a word and nothing else. If an interviewer says "aliasing", clarify
which one — a strong answer names both.

## `typedef` vs `using`

`typedef` (C, C++98) and the `using` alias-declaration (C++11) mean exactly the
same thing for non-template aliases. Prefer `using`: it reads left-to-right
(name `=` type) and, crucially, it can be templated. `typedef` cannot.

```cpp
// These two are equivalent:
typedef std::map<std::string, int> Table;
using   Table = std::map<std::string, int>;

// `using` is dramatically clearer for hairy types — function pointers especially:
typedef int (*Handler)(int, double);          // name buried in the middle
using   Handler = int (*)(int, double);        // name up front, type after `=`

// ...and for pointer-to-member, arrays, etc., `using` keeps the name first.
using IntArray10 = int[10];
```

> **Interview one-liner:** "`using` is `typedef` that can be templated and reads
> in declaration order." That sentence covers 90% of the question.

## Alias templates — the big win over `typedef`

The decisive advantage of `using` is the **alias template**: a parameterized
alias. `typedef` is *not* a declaration that can take template parameters, so
this is impossible with `typedef`:

```cpp
template <class T>
using Vec = std::vector<T>;          // alias template (C++11)

Vec<int>    xs;                      // == std::vector<int>
Vec<double> ys;                      // == std::vector<double>
```

### Why `typedef` can't be templated

A `typedef` introduces one fixed synonym for one fixed type. There is no syntax
to bind it to template parameters. Before C++11, people simulated it with the
"typedef inside a struct" trick — and immediately hit the dependent-name
problem (next section):

```cpp
// Pre-C++11 workaround (still seen in old code / type traits):
template <class T>
struct Vec { typedef std::vector<T> type; };

Vec<int>::type xs;                   // verbose, and `type` is a dependent name
```

The alias template replaces all of that with one line. Note one subtlety: an
alias template is **never deduced** and is **transparent** — `Vec<int>` *is*
`std::vector<int>`, so it participates in template argument deduction as the
underlying type, and you cannot partially specialize an alias template.

## Dependent typedefs and `typename`

Inside a template, a name like `Container::value_type` is a **dependent name**:
the compiler can't yet know whether it names a type or a static data member,
because it depends on the template parameter. By default it assumes *not a
type*. You must say `typename` to disambiguate:

```cpp
template <class Container>
typename Container::value_type front_copy(const Container& c) {
    typename Container::value_type x = c.front();   // `typename` required
    return x;
}
```

(Since C++20 the `typename` is implied in some contexts, but write it where the
grammar still demands it.) This is why standard containers expose **member type
aliases** — `value_type`, `size_type`, `iterator`, `reference` — so generic code
can name "the element type of whatever this is" without knowing the concrete
type. Honoring those names is part of being a good citizen in the STL:

```cpp
template <class C>
void shrink_half(C& c) {
    using size_type = typename C::size_type;        // the container's own size type
    size_type n = c.size() / 2;
    c.resize(n);
}
```

The standard library's conventions worth memorizing: `value_type`,
`size_type` (an unsigned type, usually `std::size_t`), `difference_type`
(signed, for pointer subtraction), `reference`/`const_reference`, `pointer`,
`iterator`/`const_iterator`. Allocators and traits classes are *built* out of
such aliases.

## ABI-stable and readability aliases

Two everyday, legitimate uses:

```cpp
// 1. Readability / intent — name the role even when the type is "obvious":
using Timestamp = std::uint64_t;     // ns since epoch
using OrderId   = std::uint64_t;

// 2. ABI / portability seam — one place to change the underlying type:
using SeqNum = std::uint32_t;        // exchange bumped to 64-bit? change ONE line
```

The fixed-width aliases in `<cstdint>` (`std::int32_t`, `std::uint64_t`) are
themselves aliases for whatever native integer has that width on your platform —
that is precisely why you use them in wire formats: the *name* pins the size,
the *alias* maps it to the local fundamental type. Same idea applies to your own
domain types: centralize the "which underlying type" decision behind a name.

**But be honest about what this does and does not give you.** A readability
alias documents intent to *humans*. It does nothing for the *compiler*: `OrderId`
and `Timestamp` above are the same type, freely interchangeable, no diagnostic.
For machine-enforced safety you need a real distinct type.

## Strong typedefs: making a *real* new type

The fix for "everything is `int64_t` and I just added a price to a quantity" is
to wrap the underlying value in a one-member struct. This is a genuinely
distinct type, so the compiler rejects cross-assignment. This is the
**NamedType** / opaque-typedef pattern.

```cpp
// C++17. A minimal strong type.
template <class T, class Tag>
struct Strong {
    T value{};
    explicit Strong(T v) : value(v) {}     // explicit: no silent conversion in
    explicit operator T() const { return value; }
};

// Tag types are empty — they exist only to make the instantiations distinct.
struct PriceTag {};
struct QtyTag   {};
using Price = Strong<std::int64_t, PriceTag>;
using Qty   = Strong<std::int64_t, QtyTag>;

void place(Price p, Qty q);

Price p{100};
Qty   q{5};
// place(q, p);      // ERROR: Qty is not Price — the bug is caught at COMPILE time
place(p, q);         // OK
// auto x = p + q;   // ERROR: no operator+ — you opt in to exactly the ops you want
```

The `Tag` template parameter is the trick: `Strong<int64_t, PriceTag>` and
`Strong<int64_t, QtyTag>` are *different instantiations*, hence different types,
even though they share an identical layout (a single `int64_t`). The `explicit`
keywords prevent the compiler from silently converting `int64_t -> Price` or
`Price -> int64_t`, which is what would otherwise re-open the hole.

You then *opt in* to the operations that make physical sense: `Price + Price` is
a price, `Price * double` is a price, but `Price + Qty` simply doesn't compile.
Libraries like **Jonathan Boccara's `NamedType`** and **`type_safe`** provide
this with mixins (`Addable`, `Comparable`, …) so you don't hand-write operators.

> The zero-cost guarantee: `Strong<int64_t, Tag>` is a *standard-layout*,
> *trivially copyable* struct of exactly one `int64_t`. It has the same size and
> alignment as a bare `int64_t` and is passed in a register. The safety is
> entirely a compile-time fiction — **runtime cost is zero**. Verify with
> `static_assert(sizeof(Price) == sizeof(std::int64_t));` and check the asm.

## Aliases for function pointer types

Function-pointer and callback types are where `using` earns its keep — the
`typedef` form hides the name in the middle of the declaration:

```cpp
using OrderCallback = void (*)(const Order&, std::int64_t fill_px);

void register_handler(OrderCallback cb);

// Member function pointer — `using` keeps the alias name readable:
using BookMethod = void (OrderBook::*)(Price, Qty);
```

For type-erased callables prefer `std::function<void(const Order&, std::int64_t)>`
when you can tolerate the indirection/allocation, but a raw function-pointer
alias is the zero-overhead choice on a hot path.

## `typedef` vs `using` at a glance

| Aspect | `typedef` | `using` (alias-declaration) |
|---|---|---|
| Standard | C, C++98 | C++11 |
| Reading order | name buried in middle | name first, type after `=` |
| Can be templated? | **No** | **Yes** (alias templates) |
| Creates a new type? | No | No |
| Recommended in new code? | No | **Yes** |

## Alias vs strong type — what you actually get

| | Plain alias (`using`/`typedef`) | Strong type (struct wrapper) |
|---|---|---|
| New, distinct type? | No — same type | **Yes** |
| `price = qty` caught? | No (silent) | **Compile error** |
| Runtime cost | Zero | Zero (one-field POD) |
| Templatable | `using` only | Yes |
| Use for | readability, ABI seam | unit/dimension safety |

## Quant/HFT relevance & interview gotchas

- **Unit mix-ups are real money.** Prices, quantities, notionals, basis points,
  nanosecond timestamps — all integral, all interchangeable to the compiler
  under plain aliases. Strong types turn "I passed qty where price was expected"
  from a production incident into a build failure, at *zero* runtime cost. This
  is one of the most defensible uses of the type system in trading code.
- **ABI-stable aliases** let one header define `using SeqNum = uint32_t;` so the
  feed handler, the order gateway, and the risk system all agree — and a
  protocol upgrade is a one-line change. Just remember it gives no *type*
  safety across those modules.
- **`using` over `typedef`, always**, in new code — and know *why*: alias
  templates. "Why can't you `typedef` a `vector<T>` factory?" is a direct
  question.
- **Don't confuse the term "aliasing."** If asked about "the aliasing rule" or
  "type punning", they mean *strict aliasing* (optimizer), not `using`. The
  safe pun is `std::memcpy` / `std::bit_cast`, never a `reinterpret_cast` to a
  differently-typed pointer.
- **Strong types are still trivially copyable.** Interviewers may worry about
  overhead; reassure them with `sizeof`, `std::is_trivially_copyable`, and the
  pass-in-register asm. The struct vanishes.
- **`explicit` is mandatory** on the strong type's constructor and conversion —
  drop it and you've rebuilt the plain-alias hole with extra steps.

## Key takeaways

1. A type alias (`using` or `typedef`) is a **second name**, never a new type;
   the alias and target are interchangeable everywhere.
2. Prefer **`using`**: it reads in declaration order and — uniquely — supports
   **alias templates** (`template<class T> using Vec = std::vector<T>;`), which
   `typedef` cannot express.
3. Inside templates, dependent member aliases like `Container::value_type`
   require **`typename`**; the STL exposes `value_type`/`size_type`/`iterator`
   precisely so generic code can name them.
4. Aliases give **readability and an ABI seam**, but **no type safety** —
   `Price` and `Qty` as aliases for `int64_t` are mutually assignable.
5. For real safety, use a **strong type**: a tagged one-field struct
   (`NamedType` pattern) that is a distinct type at compile time and free at
   runtime.
6. "Aliasing" the optimizer rule (strict aliasing / type punning) is unrelated
   to "type alias"; the safe pun is `std::memcpy` / `std::bit_cast`.

## Self-check

1. Why can `using` express `template<class T> using Vec = std::vector<T>;` but
   `typedef` cannot?
2. Given `using Price = int64_t; using Qty = int64_t;`, does `Price p = qty;`
   compile? Why is that dangerous in trading code?
3. What does `typename` do in `typename Container::value_type`, and why is it
   required?
4. In the `Strong<T, Tag>` pattern, what is the `Tag` parameter for, and why is
   `sizeof(Price) == sizeof(int64_t)`?
5. A colleague says "I fixed the strict-aliasing bug by adding a `using` alias."
   Explain why that is a category error and what actually fixes it.
6. Why are the `explicit` keywords essential on a strong type's constructor and
   conversion operator?

## Further reading

- [Type alias, alias template (`using`) — cppreference](https://en.cppreference.com/w/cpp/language/type_alias)
- [`typedef` specifier — cppreference](https://en.cppreference.com/w/cpp/language/typedef)
- [Dependent names / `typename` disambiguator — cppreference](https://en.cppreference.com/w/cpp/language/dependent_name)
- Scott Meyers, *Effective Modern C++*, **Item 9: Prefer alias declarations to `typedef`s.**
- [Jonathan Boccara — *Strong types for strong interfaces* (NamedType)](https://www.fluentcpp.com/2016/12/08/strong-types-for-strong-interfaces/) and the [`NamedType` library](https://github.com/joboccara/NamedType).
- [`type_safe` library (Jonathan Müller)](https://github.com/foonathan/type_safe) — strong typedefs with opt-in mixins.
- [The strict aliasing rule — `reinterpret_cast` / `std::bit_cast` — cppreference](https://en.cppreference.com/w/cpp/numeric/bit_cast) (for disambiguating the *other* "aliasing").
- [Member type aliases convention — `std::vector::value_type` etc. — cppreference](https://en.cppreference.com/w/cpp/container/vector)

## Videos

- Jonathan Boccara — **"Strong Types for Strong Interfaces"** ([search](https://www.youtube.com/results?search_query=Jonathan+Boccara+Strong+Types+for+Strong+Interfaces+Meeting+Cpp)).
- Björn Fahller (C++ on Sea / Meeting C++) — **"Type Safe C++? — LOL! ;-)"** ([search](https://www.youtube.com/results?search_query=Bjorn+Fahller+Type+Safe+C%2B%2B+strong+types)).
