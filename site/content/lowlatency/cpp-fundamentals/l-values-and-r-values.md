# L-values and R-values

> **Why a quant dev must own this:** value categories are the rulebook the
> compiler uses to decide *copy vs. move* — and in a hot path the difference is
> a `memcpy` of a million-element buffer versus a three-pointer swap. Overload
> resolution, `std::move`, perfect forwarding, and guaranteed elision all stand
> on this foundation. "What's the difference between an lvalue and an xvalue?"
> and "does `std::move` move anything?" are near-certain HFT interview
> questions, and getting them right signals you actually understand move
> semantics rather than cargo-culting `std::move` everywhere.

## First principles: an expression has a *type* and a *value category*

Every expression in C++ has two independent properties: its **type** (`int`,
`std::string`, …) and its **value category**. The value category answers two
orthogonal questions:

- **Has identity?** — does it denote a specific object with an address you could
  (in principle) take? (the standard calls this *glvalue* territory)
- **Is movable?** — may the compiler steal its resources, because nobody else
  will observe it afterwards? (this is *rvalue* territory)

```text
                 has identity?
                  yes        no
movable?  no   | lvalue  |  (n/a)   |
          yes  | xvalue  | prvalue  |

glvalue = lvalue or xvalue   (has identity)
rvalue  = xvalue or prvalue  (movable)
```

That 2x2 is the whole taxonomy. The three leaf categories are **lvalue**,
**xvalue**, and **prvalue**.

## The three leaf categories (C++17 model)

```cpp
// C++17
#include <string>
#include <utility>

std::string make();          // returns by value
std::string g;

void demo() {
    std::string s = "hi";

    s;                       // lvalue   : named object, has identity, not movable
    make();                  // prvalue  : pure value, no name, the "initializer"
    std::move(s);            // xvalue   : has identity (it's s) AND is movable
    std::move(s).size();     // operand is an xvalue
}
```

- **lvalue** ("locator value"): has identity, **not** implicitly movable.
  Named variables, `*ptr`, `arr[i]`, a function returning `T&`. You can take its
  address; it normally persists.
- **prvalue** ("pure rvalue"): the result of a computation that *initializes*
  something — a literal like `42`, `make()` returning by value, `a + b`. In
  C++17 a prvalue is not yet an object; it's an *initializer* that materializes
  into one only when needed (this is the basis of guaranteed copy elision).
- **xvalue** ("eXpiring value"): names an object whose resources may be
  reused — the result of `std::move(x)`, of `static_cast<T&&>(x)`, or of a
  function returning `T&&`. It has identity *and* is fair game to plunder.

> **Mnemonic:** *lvalue = has a name you'd reuse; rvalue = a value you'd happily
> gut.* An xvalue is the bridge: a named thing you've explicitly promised not to
> look at again.

## R-value references and overload resolution

A `T&` binds to lvalues; a `T&&` (rvalue reference, introduced in C++11) binds
to rvalues (xvalues and prvalues). This lets a type provide two overloads and
let the compiler pick based on whether the argument is expendable:

```cpp
// C++11/17
void sink(const std::string& s);   // (1) lvalue / general fallback: copies
void sink(std::string&& s);        // (2) rvalue: free to move from s

std::string a = "x";
sink(a);                           // calls (1): a is an lvalue, still needed
sink(std::string{"y"});            // calls (2): the temporary is a prvalue
sink(std::move(a));                // calls (2): a is now an xvalue
```

The canonical use is the special members:

```cpp
// C++11/17
struct Buf {
    Buf(const Buf&);               // copy ctor   : binds lvalues
    Buf(Buf&&) noexcept;           // move ctor    : binds rvalues, steals
    Buf& operator=(const Buf&);    // copy assign
    Buf& operator=(Buf&&) noexcept;// move assign
};
```

Mark move operations **`noexcept`** — containers like `std::vector` will only
*move* elements on reallocation if the move constructor is `noexcept`;
otherwise they *copy* to preserve the strong exception guarantee. A missing
`noexcept` silently turns your move-optimized type back into a copying one
during `vector` growth.

## `std::move` does not move

This is the gotcha that separates the answers. `std::move(x)` is **just a
cast** — it produces an xvalue (an rvalue reference) and generates *zero*
instructions. It does not touch `x`. The actual moving (the resource theft)
happens later, *if* the value binds to a move constructor / move assignment.

```cpp
// C++11/17 — a faithful, simplified std::move
template <class T>
constexpr std::remove_reference_t<T>&& my_move(T&& t) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(t);  // an unconditional cast
}
```

Consequences worth stating in an interview:

- `std::move` on a `const` object is useless: `const Buf&&` can't bind to
  `Buf&&`, so it falls back to the copy. **`std::move` of a `const` thing
  copies.**
- After you move *from* an object, it is in a *valid but unspecified* state — you
  may destroy or reassign it, not assume its contents.
- Returning `std::move(local)` from a function is usually **wrong**: it disables
  NRVO (see the elision lesson). Return the name plainly.

## Why this matters for moves — the payoff

Move semantics turn an O(n) deep copy into an O(1) pointer transfer for any type
that owns a heap resource.

```cpp
// C++17
#include <vector>
std::vector<double> compute();          // returns a big buffer by value

std::vector<double> v = compute();      // prvalue -> elided/moved: no element copy
std::vector<double> w = v;              // v is an lvalue: full copy of all elements
std::vector<double> u = std::move(v);   // v cast to xvalue: pointer steal, O(1)
```

```text
copy of vector<double> with 1M elements : ~8 MB memcpy + an allocation
move of the same vector                 : swap 3 pointers (data, size, capacity)
```

The value category at the call site is *exactly* what tells the compiler which
of those two it's allowed to do. Get the category right and the move happens for
free; get it wrong (e.g. an unnecessary `std::move` that pessimizes elision, or
a `const` that forces a copy) and you silently pay the memcpy.

## A subtlety: a named rvalue reference is an *lvalue*

The single most common confusion:

```cpp
// C++17
void f(std::string&& s) {       // s is declared as an rvalue reference...
    sink(s);                    // ...but here 's' is an LVALUE (it has a name!)
    sink(std::move(s));         // re-cast to xvalue to actually move
}
```

A variable's *category* depends on the expression, not its declared type. The
parameter `s` has type "rvalue reference to string", but the expression `s`
naming it is an lvalue. To pass it on as movable you must `std::move` it again.
(In a template, you'd use `std::forward` instead — see the perfect-forwarding
lesson.)

## Quant/HFT relevance & interview gotchas

- **"Does `std::move` move?"** No — it's a cast to xvalue; the move is performed
  by a later move ctor/assignment. State this crisply.
- **`std::move` of `const`** silently copies (no `const&&` move overload binds).
  Don't `std::move` a `const` thing.
- **`return std::move(local);`** pessimizes NRVO and at best is redundant; at
  worst it forces a move where elision would have done nothing. Just
  `return local;`.
- **Forgetting `noexcept` on the move ctor** makes `std::vector` copy on
  reallocation — a stealthy perf regression that benchmarks catch and code
  review often doesn't.
- **A named `T&&` is an lvalue.** Inside a function, you must `std::move`/
  `std::forward` it again to keep it movable.
- **Moved-from = valid but unspecified.** Reassign before reading. Self-move
  must not corrupt — guard or use copy-and-swap.
- In tick-handling code, prefer designs that *avoid the copy/move question
  entirely* (in-place construction, object pools, fixed buffers) — the cheapest
  move is the one you never make.

## Key takeaways

1. Every expression has a **type** *and* a **value category**; categories form a
   2x2 of *has-identity* × *movable*.
2. The leaves are **lvalue** (identity, not movable), **xvalue** (identity,
   movable), **prvalue** (no identity, movable). glvalue = lvalue|xvalue,
   rvalue = xvalue|prvalue.
3. `T&&` binds to rvalues and powers the move overloads; mark moves
   **`noexcept`** or containers will copy.
4. **`std::move` is only a cast** to xvalue — it moves nothing by itself; the
   later move operation does the work.
5. A **named** rvalue reference is an **lvalue**; `std::move` it again to keep it
   movable.
6. Correct categories convert O(n) copies into O(1) pointer steals — that's the
   entire point.

## Self-check

1. Classify each: `42`, a variable `x`, `std::move(x)`, `x + 1`, a function
   returning `int&`, a function returning `int`.
2. What does `std::move` actually compile to, and what performs the move?
3. Why does `std::move` on a `const std::string` produce a copy?
4. Inside `void f(std::string&& s)`, why is `sink(s)` a copy but
   `sink(std::move(s))` a move?
5. Your move constructor isn't marked `noexcept`. What does `std::vector` do
   differently when it grows, and why?
6. Why is `return std::move(local);` usually a pessimization?

## Further reading

- [Value categories — cppreference](https://en.cppreference.com/w/cpp/language/value_category) — the authoritative taxonomy with the exact rules.
- [`std::move` — cppreference](https://en.cppreference.com/w/cpp/utility/move) and [`std::forward` — cppreference](https://en.cppreference.com/w/cpp/utility/forward).
- Scott Meyers, *Effective Modern C++*, Items 23-25 (`std::move`/`std::forward`, universal references, avoiding overloading on universal references).
- [eel.is/c++draft — `[basic.lval]`](https://eel.is/c++draft/basic.lval) — the standardese on value categories, if you want the source of truth.
- [Thomas Becker, "C++ Rvalue References Explained"](http://thbecker.net/articles/rvalue_references/section_01.html) — a clear, classic walkthrough of rvalue refs and move semantics.
- [Reference declaration / rvalue references — cppreference](https://en.cppreference.com/w/cpp/language/reference) — `&&` binding and reference collapsing.

## Videos

- CppCon — **Klaus Iglberger, "Back to Basics: Move Semantics"** ([search](https://www.youtube.com/results?search_query=CppCon+Klaus+Iglberger+Back+to+Basics+Move+Semantics)) — the clearest end-to-end treatment of value categories and moves.
- CppCon — **"Back to Basics: lvalues, rvalues, and value categories"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+value+categories+lvalue+rvalue)).
