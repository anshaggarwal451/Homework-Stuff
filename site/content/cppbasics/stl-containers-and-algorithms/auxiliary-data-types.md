# Auxiliary Data Types

> **Why a quant dev must own these:** Half of a feed handler's job is *parsing
> bytes into typed values* and *returning maybe-a-result* without allocating,
> copying, or branching on error codes you forgot to check. `std::string_view`
> and `std::span` let you slice a packet with zero copies; `std::optional` and
> `std::variant` let you model "lookup miss" and "one of N message types"
> without sentinels or naked unions. These are bread-and-butter interview
> topics — and getting the *lifetime* rules wrong is a classic way to plant a
> use-after-free in a hot path.

These are the small, ubiquitous "glue" vocabulary types from `<utility>`,
`<tuple>`, `<optional>`, `<variant>`, `<string_view>`, and `<span>`. None of
them is a container in the STL sense — they don't own a sequence of elements —
but you'll touch them constantly. The unifying theme is **value semantics with
(often) zero heap allocation**: most are tiny structs that live on the stack or
inline inside a bigger object.

## `std::pair` and `std::tuple` — fixed heterogeneous bundles

`std::pair<A, B>` is just a struct with two public members, `.first` and
`.second`. `std::tuple<Ts...>` generalises it to any arity. They exist so you
can return or store several values of different types *without writing a named
struct*.

```cpp
#include <tuple>
#include <utility>
#include <string>

std::pair<int, double>      p{42, 3.14};
std::tuple<int, double, char> t{1, 2.0, 'x'};

int    a = p.first;
double d = std::get<1>(t);   // by index
int    b = std::get<int>(t); // by type (only if unique)
```

### Structured bindings (C++17) — the readable way to unpack

```cpp
auto [id, price] = p;            // id=int, price=double, both copies
auto& [x, y, z]  = t;            // bind by reference, no copy

// The canonical use: iterating a map yields pair<const Key, Value>.
for (const auto& [symbol, level] : order_book) { /* ... */ }
```

Structured bindings work on `pair`, `tuple`, `std::array`, and any aggregate
(plain struct) — so you usually get the readability of a named struct for free.

### `std::tie` and `std::apply`

`std::tie` builds a tuple of *references*, which is the classic trick for
multi-return unpacking (pre-C++17) and for writing lexicographic comparisons:

```cpp
std::tie(a, b) = std::make_pair(1, 2);   // assign through references

// One-line correct operator< : compare member-by-member, in order.
struct Quote { int px; int qty; long ts; };
bool operator<(const Quote& l, const Quote& r) {
    return std::tie(l.px, l.qty, l.ts) < std::tie(r.px, r.qty, r.ts);
}
```

`std::apply` (C++17) calls a function with a tuple's elements as its arguments —
useful for forwarding stored argument packs:

```cpp
auto args = std::make_tuple(1, 2, 3);
int sum = std::apply([](int a, int b, int c){ return a + b + c; }, args);
```

> **Style note:** prefer a *named* struct over `tuple` in any interface that
> outlives one expression. `quote.price` documents itself; `std::get<2>(t)`
> does not. Tuples shine for generic code and transient unpacking, not for APIs.

## `std::optional<T>` (C++17) — "maybe a value"

`std::optional<T>` holds either a `T` or nothing, *inline* — it's roughly `T`
plus a `bool`, **with no heap allocation**. It replaces the C-era idioms of
"return `-1`/`nullptr` to mean failure" and the anti-pattern of an out-parameter
plus a `bool` return.

```cpp
#include <optional>

std::optional<double> mid_price(const Book& b) {
    if (b.empty()) return std::nullopt;   // no value
    return (b.best_bid() + b.best_ask()) / 2.0;
}

if (auto m = mid_price(book)) {           // contextually converts to bool
    use(*m);                              // operator* — UB if disengaged!
}
double v = mid_price(book).value_or(0.0); // safe default
```

- `*o` / `o->` access the value and are **UB if empty** — guard first, or use
  `.value()` (which *throws* `std::bad_optional_access`) or `.value_or(x)`.
- Use `optional` for **expected absence** (cache miss, optional config field,
  "no quote yet"). Use exceptions or a richer result type (`std::expected`,
  C++23) for **errors that carry a reason**. `optional` says *whether*, not
  *why*.
- Storage is inline, so `sizeof(optional<T>) >= sizeof(T) + 1` (rounded for
  alignment). No indirection, cache-friendly — fine in hot code.

## `std::variant<Ts...>` (C++17) — a type-safe tagged union

A `variant` holds exactly one value out of a fixed set of alternatives, plus a
discriminant (the "index") tracking which one is active. It is the safe
replacement for a raw `union` + manual tag: it constructs/destroys the active
member correctly and never lets you read the wrong type silently.

```cpp
#include <variant>

using Message = std::variant<AddOrder, CancelOrder, Trade>;

Message m = parse(packet);
std::size_t which = m.index();           // 0, 1, or 2
AddOrder*  a = std::get_if<AddOrder>(&m); // nullptr if not active

// std::visit dispatches to the right overload at (effectively) a jump table:
std::visit([](auto&& msg){ handle(msg); }, m);
```

`std::visit` is the idiomatic dispatch — it's checked at compile time that you
handle every alternative. Because the alternative set is *closed and known at
compile time*, this is generally faster and more cache-predictable than virtual
dispatch over an open class hierarchy; the trade-offs versus polymorphism and
`dynamic_cast` are covered in the **RTTI / dynamic dispatch** lesson. `sizeof`
a variant is (roughly) the size of its largest alternative plus the tag — again,
no heap allocation.

## `std::string_view` (C++17) — a non-owning window onto characters

`string_view` is a `{const char* ptr; size_t len;}` pair — a **borrowed**
reference to a character range it does not own and will not free. It turns
"substring", "tokenise", and "pass a string to a function" into **zero-copy,
zero-allocation** operations.

```cpp
#include <string_view>
using namespace std::literals;

void log(std::string_view sv);   // accepts const char*, std::string, literal — no copy

std::string_view sv = "AAPL  150.25"sv;
std::string_view sym = sv.substr(0, 4);  // "AAPL" — no allocation, just ptr+len
```

### The dangling pitfall (this is *the* interview gotcha)

A `string_view` is only valid while the underlying buffer is. Outlive it and
you have a use-after-free:

```cpp
std::string make();
std::string_view bad = make();        // DANGLING: temporary string dies here
std::string_view also_bad = (s + "x");// view of a destroyed temporary

std::string_view ok(const std::string& s) { return s; } // ok *while caller's s lives*
```

Rules of thumb: **never store** a `string_view` that outlives its source;
**never return** one referring to a local or a by-value parameter; remember a
`string_view` is **not guaranteed null-terminated**, so never hand `.data()` to
a C API expecting a C-string.

## `std::span<T>` (C++20) — `string_view` for arbitrary contiguous data

`std::span<T>` is the generalisation: a `{T* ptr; size_t len;}` non-owning view
over *any* contiguous range — a C array, `std::array`, `std::vector`, or a raw
buffer. It's the right parameter type for "a contiguous block of `T`" because it
binds to all of them without copying and without a template.

```cpp
#include <span>

void process(std::span<const std::byte> packet);   // accepts vector, array, C array...

std::span<int> first_half(std::vector<int>& v) {
    return std::span{v}.subspan(0, v.size() / 2);   // no copy
}
```

`span<T, Extent>` can carry a *compile-time* extent (`std::span<int, 4>`) for
zero-overhead bounds knowledge, or `std::dynamic_extent` (the default) for a
runtime length. Same dangling discipline as `string_view`: it's a borrow.

## Memory layout at a glance

```text
pair<int,double>   [ int(4) | pad(4) | double(8) ]   = 16 B, no heap
optional<double>   [ double(8) | bool(1) | pad(7) ]   = 16 B, no heap
variant<A,B,C>     [ max(sizeof A,B,C) | index(1)..]  = inline, no heap
string_view        [ const char* (8) | size_t (8) ]   = 16 B, borrows
span<T> (dynamic)  [ T*          (8) | size_t (8) ]   = 16 B, borrows
```

The point: **none of these allocate**. `string_view` and `span` are two
pointers' worth of register-friendly data you pass by value.

| Type | Owns data? | Allocates? | Use when |
|------|:----------:|:----------:|----------|
| `pair`/`tuple` | yes (inline) | no | bundle a few heterogeneous values |
| `optional<T>` | yes (inline) | no | a value may legitimately be absent |
| `variant<Ts...>` | yes (inline) | no | exactly one of a closed type set |
| `string_view` | no | no | read-only char range, parsing |
| `span<T>` | no | no | read/write contiguous range, APIs |

## Performance & hardware reality

- **Zero-copy parsing.** Slicing a packet with `string_view`/`span` is just
  pointer arithmetic — no `memcpy`, no allocator call, no cache pollution from a
  fresh buffer. This is the single biggest reason they exist for low-latency
  code.
- **Pass views by value.** A `string_view`/`span` is two words; it goes in
  registers. Passing `const std::string&` instead forces callers who have a
  `const char*` to construct a `std::string` (allocation!) at the call site.
- **`optional`/`variant` are inline**, so they keep data contiguous and
  cache-resident — unlike a pointer-to-heap "nullable". No indirection.
- **`variant` dispatch via `std::visit`** is typically a compile-time-generated
  jump table over a small tag: branch-predictable and free of the vtable load +
  indirect call that virtual dispatch incurs.

## Quant/HFT relevance & interview gotchas

- **Zero-copy feed parsing.** Carve fields out of a received buffer as
  `string_view`/`span` and parse by value (see the *Byte Order* lesson). No
  allocation on the critical path.
- **`optional` for lookups, not errors.** "Is there a resting order at this
  price?" → `optional<Order&>`-ish patterns (often `Order*` in practice).
  Reserve exceptions/`expected` for genuine failures with a cause.
- **`variant` + `visit` to model a message set** when the set is closed and
  hot: predictable dispatch, no vtable, everything inline.
- **The dangling-view question is near-certain.** Be ready to spot
  `string_view sv = some_temporary_string();` and explain the lifetime bug, and
  to note that `.data()` may not be null-terminated.
- **"Why is `string_view` faster than `const string&`?"** Because the caller
  may have to *materialise* a `std::string` (heap alloc) to bind the reference,
  whereas any contiguous char source converts to a view for free.
- Know that `tuple` element *layout order is unspecified* — never rely on it for
  binary layout; it is **not** a packed wire struct.

## Key takeaways

1. `pair`/`tuple` bundle heterogeneous values inline; unpack them with
   **structured bindings** (C++17). Prefer a named struct for real interfaces.
2. `std::tie` makes correct lexicographic `operator<` a one-liner; `std::apply`
   spreads a tuple into a call.
3. `optional<T>` is inline "maybe a value" — guard before `*`; it answers
   *whether*, not *why* (use exceptions/`expected` for errors).
4. `variant<Ts...>` is a type-safe tagged union; dispatch with `std::visit`.
   Inline storage, no heap, predictable dispatch.
5. `string_view` (C++17) and `span` (C++20) are **non-owning two-word views** —
   zero-copy, pass by value, and *never let them outlive their buffer*.

## Self-check

1. What does `sizeof(std::optional<char>)` look like, and why is it more than 1?
2. Why is `std::string_view sv = std::string("hi");` a bug? Fix it.
3. When would you choose `std::variant` + `std::visit` over a virtual base class?
4. Give a one-line `operator<` for a 3-field struct using `std::tie`.
5. Why can passing `std::string_view` be cheaper at the *call site* than
   `const std::string&`?
6. You have a `std::span<const std::byte>` over a network buffer. What lifetime
   invariant must hold before you use it, and why is `.data()` unsafe to treat
   as a C-string?

## Further reading

- [`std::optional` — cppreference](https://en.cppreference.com/w/cpp/utility/optional) and [`std::variant` — cppreference](https://en.cppreference.com/w/cpp/utility/variant)
- [`std::string_view` — cppreference](https://en.cppreference.com/w/cpp/string/basic_string_view) and [`std::span` — cppreference](https://en.cppreference.com/w/cpp/container/span)
- [`std::tuple` — cppreference](https://en.cppreference.com/w/cpp/utility/tuple), [structured bindings](https://en.cppreference.com/w/cpp/language/structured_binding), and [`std::apply`](https://en.cppreference.com/w/cpp/utility/apply)
- Scott Meyers, *Effective Modern C++*, Items 11–17 — value vocabulary types and move semantics that underpin these.
- [P0220 — `std::optional`](https://wg21.link/p0220) and [P0122 — `std::span`](https://wg21.link/p0122) proposals, for the design rationale.
- [Abseil Tip of the Week #1: `string_view`](https://abseil.io/tips/1) — concise lifetime guidance.
- [C++ Core Guidelines — F.24 (use `span`/`string_view` for ranges)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines)

## Videos

- CppCon — Marshall Clow, **"`string_view`: When to use it and when not to"** ([search](https://www.youtube.com/results?search_query=CppCon+Marshall+Clow+string_view+when+to+use+it)).
- CppCon — Nicolai Josuttis, **"The Nightmare of Initialization in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Josuttis+nightmare+of+initialization)) — covers `optional`/aggregate init pitfalls.
- CppCon — Barry Revzin / Jonathan Müller talks on **`std::variant` and `std::visit`** ([search](https://www.youtube.com/results?search_query=CppCon+std+variant+visit)).
