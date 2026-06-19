# Const and Pointers

> **Why a quant dev must own this:** `const` is how you encode contracts in the
> type system — "this function won't touch your order book", "this view of the
> market data is read-only". In a large trading codebase, const-correctness is
> what lets reviewers trust an interface at a glance and what lets the compiler
> elide copies. Pointer-and-`const` declarations are also a perennial interview
> filter: get `const int*` vs `int* const` wrong and it shows immediately.

## First principles: `const` is a promise to the type system

`const` means "this name may not be used to modify the object." It is a
*compile-time* contract checked by the compiler, not a runtime lock. Its value
is twofold: it documents intent in a machine-checked way, and it lets the
compiler reject (and sometimes optimize around) mutations.

The subtlety with pointers is that **two objects are in play** — the pointer
itself and the thing it points at — and `const` can apply to either, or both.

## Reading declarations right-to-left

The reliable trick: read a declaration from the **variable name outward, right
to left**, expanding `*` as "pointer to" and `const` as "const".

```cpp
int x = 0, y = 0;

const int*       p1 = &x;   // p1: pointer to const int
int const*       p2 = &x;   // same as p1 (const binds to int either way)
int*       const p3 = &x;   // p3: const pointer to int
const int* const p4 = &x;   // p4: const pointer to const int
```

- `const int* p1` → "`p1` is a pointer to (`int` that is `const`)". You may
  repoint `p1`, but not write through it.
- `int* const p3` → "`p3` is a (const pointer) to `int`". You may write through
  it, but not repoint it.

```cpp
*p1 = 5;     // ERROR: pointee is const
 p1 = &y;    // OK:    pointer is mutable

*p3 = 5;     // OK:    pointee is mutable
 p3 = &y;    // ERROR: pointer is const (must be initialized, can't reseat)
```

> **Mnemonic:** the `const` *binds to whatever is on its left*; if nothing is on
> its left, it binds right. So `int const*` and `const int*` are identical
> (`const` modifies `int`), while `int* const` puts `const` on the `*` —
> the pointer.

## Pointer-to-const vs const-pointer vs const-pointer-to-const

| Declaration | Repoint the pointer? | Write through it? | Spoken name |
|---|---|---|---|
| `int* p` | yes | yes | pointer to int |
| `const int* p` | **yes** | no | pointer to const int |
| `int* const p` | no | **yes** | const pointer to int |
| `const int* const p` | no | no | const pointer to const int |

The two you'll be quizzed on are the middle rows — and they're opposites.
`const int*` protects the *data*; `int* const` protects the *binding*. The first
is overwhelmingly the common one: function parameters that observe but don't
modify.

## Top-level vs low-level const

This distinction governs conversions and overload resolution.

- **Top-level const** = the object *itself* is const. For a pointer, that's the
  pointer being const (`int* const`). For any value, `const int n`.
- **Low-level const** = what a pointer/reference *refers to* is const
  (`const int*`).

```cpp
int x = 0;
const int* lo  = &x;   // low-level const  (pointee const)
int* const top = &x;   // top-level const  (pointer const)
```

Rules that fall out of this:

```cpp
int* q = nullptr;
const int* r = q;      // OK:  ADDING low-level const is always allowed
int* s = r;            // ERROR: DROPPING low-level const needs const_cast

const int ci = 42;
int ni = ci;           // OK:  top-level const is ignored when copying a value
```

Two declarations that differ only in **top-level** const are the *same type* for
overloading (a by-value `f(int)` and `f(const int)` are the same function).
Differing in **low-level** const gives genuinely different overloads
(`f(int*)` vs `f(const int*)`).

## `const` on function parameters and return values

```cpp
// Observe-only parameter: pass a pointer/reference to const.
double mid_price(const OrderBook* book);     // won't modify *book
double mid_price(const OrderBook& book);     // idiomatic: const reference

// Top-level const on a BY-VALUE param is a local-only promise; it does NOT
// change the function's type or affect the caller, so usually omit it:
int square(const int n);      // == int square(int n) to overload resolution

// Const return by value is an anti-pattern: it blocks move semantics.
const std::string make();     // BAD: prevents the result from being moved
std::string       make();     // GOOD
```

The high-value rule: **take read-only inputs by `const&`** (or `const*` if null
is meaningful). It signals intent, allows callers to pass `const` objects and
temporaries, and avoids a copy.

## `const` member functions and `mutable`

A trailing `const` on a member function means "this method does not modify the
observable state of the object" — inside it, `this` is a pointer to const, so
non-`mutable` members are read-only and you may only call other `const` methods.

```cpp
class OrderBook {
    std::vector<Level> levels_;
    mutable std::size_t query_count_ = 0;   // bookkeeping, not logical state

public:
    double best_bid() const {               // const method: read-only view
        ++query_count_;                      // OK: query_count_ is mutable
        // levels_.clear();                  // ERROR: would modify state
        return levels_.front().price;
    }
};
```

- `const` member functions are what make a `const OrderBook&` usable — you can
  only call `const` methods on a const object.
- **`mutable`** carves out members that may change even in a `const` method,
  reserved for things that aren't part of the object's logical value: caches,
  mutexes, hit counters. Abusing `mutable` to fake mutability defeats the
  contract.
- Const-overloading lets a class return a read-only vs writable view:
  `const T& operator[](size_t) const;` alongside `T& operator[](size_t);`.

## `constexpr` vs `const`

They are not synonyms. `const` means *read-only*; `constexpr` means *known at
compile time* (and implies `const` for objects).

```cpp
const int     a = runtime_value();   // read-only, but value computed at RUNTIME
constexpr int b = 6 * 7;             // a compile-time constant (also const)

constexpr int square(int n) { return n * n; }   // usable in constant expressions
int arr[square(8)];                              // OK: 64 known at compile time
```

Use `constexpr` for true compile-time constants and computations (array bounds,
template args, lookup tables baked at build time — handy in HFT for precomputed
tables). Use `const` for "I won't change this" where the value may be runtime.
`constexpr` on a pointer constrains the *pointer* (top-level), so
`constexpr int* p` is a compile-time-constant address — rarely what you want for
heap data.

## West const vs east const

Purely stylistic — same meaning, different placement of the keyword.

```cpp
const int  x = 1;        // "west const": const on the left   (traditional)
int const  y = 1;        // "east const": const after the type (consistent)

const int* p;            // west
int const* q;            // east — reads cleanly right-to-left as "ptr to const int"
```

East const proponents argue it's *positionally consistent* — `const` always
modifies the thing immediately to its left — which makes pointer declarations
(`int const* const`) parse uniformly right-to-left. West const is more common in
existing code. Pick one per codebase; the compiler does not care.

## How `const` helps (and doesn't help) the optimizer

The honest version, because interviewers probe the myth:

- **A `const` *local* or a `const` global** the compiler can see is genuinely
  exploitable — it knows the value never changes and can fold/propagate it. A
  namespace-scope `const`/`constexpr` is effectively a compile-time constant.
- **`const` on a *reference/pointer parameter* helps very little for
  optimization.** `const int*` only promises *you* won't modify through *that*
  pointer; another non-const pointer (or another thread) may still mutate the
  object. So the compiler generally cannot assume the pointee is unchanged
  across a call. Its real value here is the **contract and aliasing-free intent
  for humans and the type checker**, not codegen.
- **`const_cast`-ing away const and then writing is undefined behaviour** *if*
  the underlying object was actually defined `const`. If the object was
  originally non-const and only seen through a `const` pointer, casting away and
  writing is legal but a code smell.

```cpp
const int truly_const = 5;
int* evil = const_cast<int*>(&truly_const);
*evil = 6;                 // UB: object was defined const — anything may happen
```

So: `const` is primarily a **design and safety tool**; lean on it for
correctness and API clarity, and don't expect it to magically vectorize loops —
that's what `restrict`/`std::copy`/value semantics are for.

## `const` references avoid copies

Binding a `const&` to an argument passes the object by reference (no copy) while
forbidding modification — the default way to pass anything bigger than a couple
of words:

```cpp
void process(const std::vector<Tick>& ticks);   // no copy of the vector
process(snapshot);          // pass an lvalue — bound directly
process(make_ticks());      // pass a temporary — const& extends/binds to it
```

A `const&` can also bind to a **temporary** (and, as a local, extend its
lifetime), which a non-const reference cannot — one reason read-only APIs take
`const&`. The trade-off vs by-value: by-value enables moves and removes aliasing
worries for cheap-to-copy types; prefer `const&` for expensive-to-copy inputs you
only read.

## Quant/HFT relevance & interview gotchas

- **"`const int*` vs `int* const`?"** — instant filter. Answer with the
  right-to-left rule and the "adds-low-level-const is free, dropping needs
  `const_cast`" corollary.
- **Const-correctness as API design.** A feed handler exposing
  `const Book& book() const` tells the compiler and every caller the book is
  read-only through that path — cheap, self-documenting safety.
- **Don't return `const` by value** — it silently kills move semantics on the
  result.
- **`const` doesn't beat aliasing.** Be ready to explain that `const T*` is *not*
  `restrict` and usually buys no optimization on parameters.
- **`mutable` is for non-logical state** (caches/counters/mutexes), not a license
  to mutate.
- **`constexpr` ≠ `const`.** One is compile-time-known; the other is read-only.
  HFT loves `constexpr` lookup tables computed at build time.
- **`const_cast` + write on a truly-const object is UB** — a classic "is this
  legal?" trap.

## Key takeaways

1. `const` is a **compile-time read-only contract**; with pointers it can apply
   to the pointer, the pointee, or both — read declarations **right-to-left**.
2. `const int*` = mutable pointer to const data; `int* const` = const pointer to
   mutable data; `const int* const` = both fixed.
3. **Top-level** const (object itself) is ignored when copying and for
   overloading; **low-level** const (pointee) is part of the type — adding it is
   free, dropping it needs `const_cast`.
4. Take read-only inputs by **`const&`** (or `const*`); don't return `const` by
   value; mark non-mutating methods **`const`** and use **`mutable`** only for
   non-logical state.
5. **`constexpr`** = compile-time constant (implies const); **`const`** = merely
   read-only.
6. `const` is mainly a **design/safety tool**; on parameters it gives little
   optimization and **`const_cast`-then-write on a truly-const object is UB**.

## Self-check

1. State in words what each declares: `const int* a;`, `int* const b;`,
   `const int* const c;`. Which can be repointed? Which can be written through?
2. Why is `const int* r = some_int_ptr;` allowed implicitly, but `int* s = r;`
   requires a `const_cast`?
3. Are `void f(int)` and `void f(const int)` distinct overloads? Are
   `void g(int*)` and `void g(const int*)`? Explain via top-/low-level const.
4. When is `mutable` justified inside a `const` member function? Give a concrete
   member.
5. Why does `const std::string make();` harm performance compared to returning a
   plain `std::string`?
6. Does `const` on a `const int*` parameter let the compiler assume the pointee
   is unchanged across a function call? Why or why not?

## Further reading

- [`const` type qualifier](https://en.cppreference.com/w/cpp/language/cv) — cppreference (cv-qualifiers, top-/low-level).
- [`const_cast`](https://en.cppreference.com/w/cpp/language/const_cast) and the UB of modifying a truly-const object — cppreference.
- [`constexpr` specifier](https://en.cppreference.com/w/cpp/language/constexpr) — cppreference.
- [`mutable` specifier](https://en.cppreference.com/w/cpp/language/cv) and const member functions — cppreference.
- Scott Meyers, *Effective C++*, Item 3 ("Use `const` whenever possible") and *Effective Modern C++*, Item 14/15 (`noexcept`/`constexpr`).
- C++ Core Guidelines — [Con: Constants and immutability](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-const).
- Jon Kalb / "east const" discussion ([isocpp.org blog](https://isocpp.org/blog)) and Dan Saks' columns on const placement.

## Videos

- CppCon 2017 — Jason Turner & Ben Deane material on `constexpr` (e.g. **"constexpr ALL the Things!"**) ([search](https://www.youtube.com/results?search_query=CppCon+2017+Jason+Turner+Ben+Deane+constexpr+all+the+things)).
- CppCon 2016 — Arthur O'Dwyer, **"Template Normal Programming"** ([search](https://www.youtube.com/results?search_query=CppCon+2016+Arthur+O%27Dwyer+Template+Normal+Programming)) — covers const, top-/low-level, and type deduction precisely.
