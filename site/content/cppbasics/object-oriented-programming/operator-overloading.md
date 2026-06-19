# Operator Overloading

> **Why a quant dev must own this:** HFT code is full of cheap value types —
> `Price`, `Quantity`, `Tick`, `Timestamp` — and you want them to read like the
> arithmetic they model (`bid + spread`, `qty * px`) while compiling to the same
> instructions as the raw integers underneath. Operator overloading gives you
> that, and C++20's `operator<=>` gives you all six comparisons (so the type
> drops straight into `std::set`, `std::map`, and `std::sort`) for one line. Done
> wrong, it's a maintenance and correctness hazard — interviewers probe whether
> you know the canonical forms and the taste rules.

This lesson assumes C++17, with C++20 noted for the spaceship operator.

## First principles: operators are functions with sugar

`a + b` is just a function call: `operator+(a, b)` (free) or `a.operator+(b)`
(member). Overloading lets you define that function for your own types. The
compiler does no magic — it picks an overload by ordinary overload resolution
and emits a normal call (which, for a small value type, it then inlines to
nothing). You are **not** changing precedence, associativity, arity, or the
behaviour for built-in types; you're only supplying the function for your type.

## What can and can't be overloaded

You can overload almost all operators: arithmetic (`+ - * / %`), bitwise,
comparison, `=`, `+=` and friends, `[]`, `()`, `->`, `*` (deref), `++ --`,
`<< >>`, `new`/`delete`, and (C++20) `<=>`. You **cannot** overload:

- `::` (scope), `.` (member access), `.*` (pointer-to-member), `?:` (ternary),
  `sizeof`, `alignof`, `typeid` — these are structural.
- You may technically overload `&&`, `||`, and `,` — **but you should not**:
  doing so silently destroys their built-in **short-circuit** (for `&&`/`||`)
  and **sequencing** (for `,`) guarantees, because an overloaded operator is a
  function call that evaluates *all* arguments. This is a classic trap question.

## Member vs free function — and why it matters

Some operators *must* be members; others *should* be free functions. The rule
turns on symmetry and on whether the left operand is your type.

| Operator | Must be… | Why |
|---|---|---|
| `=` `[]` `()` `->` | **member** | The standard requires it (left operand is `*this`) |
| `+ - * /` (binary) | **free** (often `friend`) | Symmetry: allows conversions on *both* operands |
| `+= -= *=` etc. | member | Modifies `*this`; left operand must be your type |
| `<<` `>>` (streams) | **free** (`friend`) | Left operand is `std::ostream`, not your type |
| `<=>` `==` (C++20) | member (often `= default`) | Can be defaulted; symmetric rewriting handles the rest |
| unary `++ -- *` `!` | member usually | Operate on `*this` |

The symmetry argument for binary `+`: if `operator+` were a *member*, the left
operand could never undergo an implicit conversion (you can't call a member on a
non-class left operand). A free function treats both operands equally:

```cpp
struct Price { long ticks; };
Price operator+(Price, Price);

Price p{100};
// p + 5      // works only if 5 -> Price is allowed AND operator+ is free/friend
// 5 + p      // a MEMBER operator+ could never make this work; a free one can
```

## Canonical forms: define `+` in terms of `+=`

The idiomatic pattern: implement the *compound assignment* (`+=`) as a member
that mutates `*this`, then implement the *binary* operator as a free function
that copies and delegates. This guarantees `a + b` and `a += b` agree and avoids
duplicated logic.

```cpp
struct Price {
    long ticks = 0;

    Price& operator+=(Price rhs) noexcept {       // member: mutate self
        ticks += rhs.ticks;
        return *this;
    }
};

// free function, returns BY VALUE (a + b yields a new value), built on +=
inline Price operator+(Price lhs, Price rhs) noexcept {
    lhs += rhs;        // lhs is a local copy (taken by value) -> mutate & return
    return lhs;
}
```

Two details that matter: binary `+` **returns by value** (it produces a new
object; returning a reference would dangle), and taking `lhs` *by value* lets the
function reuse that copy as the result — no extra temporary. For a cheap type
like `Price` this inlines to a single `add` instruction.

### Pre- vs post-increment

```cpp
struct Counter {
    int n = 0;
    Counter& operator++()    { ++n; return *this; }          // pre:  return ref
    Counter  operator++(int) { Counter old = *this;          // post: dummy int param
                               ++*this; return old; }        //       return old VALUE
};
```

Prefer `++x` to `x++` for non-trivial types — post-increment must copy the old
value. The `int` parameter is a tag the language uses to distinguish the two.

## Comparisons and the spaceship operator (C++20)

Before C++20 you wrote up to six comparison operators by hand. C++20's
three-way comparison `operator<=>` lets you write **one**, and `= default`
derives a correct, member-wise lexicographic comparison from your members:

```cpp
#include <compare>
struct Quote {
    Price    price;
    long     qty;
    auto operator<=>(const Quote&) const = default;   // derives < <= > >=
    bool operator==(const Quote&) const = default;    // and == != (declare too)
};
// Now Quote works in std::set / std::map / std::sort with no extra code.
```

Notes that come up in interviews:

- Defaulting `<=>` does **not** implicitly give you `==` in all cases — declare
  `operator==` (defaulted) alongside it; the compiler then synthesises `!=`,
  `<`, `<=`, `>`, `>=` from these two.
- The **return type** signals the ordering strength: `std::strong_ordering`
  (`int`-like, substitutable), `std::weak_ordering` (equivalent but not equal,
  e.g. case-insensitive strings), or `std::partial_ordering` (floating point —
  `NaN` is unordered). For a price/qty type you want `strong_ordering`.
- You can hand-write `<=>` to compare a subset of fields or in a custom order
  while still getting all six operators for free.

## Stream insertion: `operator<<` as a friend

Output goes through a free `operator<<` whose *left* operand is the stream. It's
commonly a `friend` so it can read private members, and it returns the stream by
reference to allow chaining (`os << a << b`):

```cpp
#include <ostream>
class Order {
    int id_; long px_;
public:
    friend std::ostream& operator<<(std::ostream& os, const Order& o) {
        return os << "Order{id=" << o.id_ << ", px=" << o.px_ << '}';
    }
};
```

## Function-call, subscript, and dereference

- **`operator()`** turns an object into a *functor* — a callable that carries
  state. This is the basis of comparators and the closure type behind every
  lambda. Hot-path code often prefers a functor or lambda to a `std::function`
  because it inlines (no type erasure, no indirect call):

```cpp
struct ByPrice {
    bool operator()(const Quote& a, const Quote& b) const { return a.price < b.price; }
};
std::sort(v.begin(), v.end(), ByPrice{});   // comparator inlines fully
```

- **`operator[]`** indexes; provide `const` and non-`const` overloads. It is
  unchecked by convention — pair it with a bounds-checked `at()` (as the standard
  containers do) so callers choose speed vs safety. (C++23 allows multi-argument
  `operator[]`.)

- **`operator->`** and **`operator*`** make a class behave like a pointer — the
  machinery behind smart pointers and iterators. `operator->` is special: it's
  reapplied to its result until a raw pointer is reached.

## Conversion operators (recap)

A class can convert *to* another type via `operator T()`. Make these `explicit`
unless an implicit conversion is genuinely wanted — see the
[Advanced Constructors](advanced-constructors.md) lesson. `explicit operator
bool()` for a validity check is the common, safe case.

## Overloading `new`/`delete` (brief)

You can replace allocation for a type (or globally) by overloading
`operator new`/`operator delete`. In HFT this is how a type is bound to a custom
pool/arena allocator, or — combined with `=delete`'d `operator new` — how you
*forbid* heap allocation entirely so a type can only live on the stack or in a
pre-allocated buffer. This is a deep topic; here just know the hook exists and
that it allocates raw storage (the constructor runs separately).

## Rules of good taste

Operator overloading is a sharp tool. The Core Guidelines and Effective C++
agree on a few rules:

- **Don't surprise.** Overload an operator only when its meaning is obvious and
  matches built-in expectation (`+` adds, `<` orders). Don't use `+` to mean
  "send to socket".
- **Preserve expected relationships.** `a + b` and `a += b` must agree; `==` and
  `<` (or `<=>`) must be consistent; comparisons must be transitive.
- **Be `const`-correct and `noexcept`** where the operation can't throw — cheap
  value-type operators almost always can.
- **Never overload `&&`, `||`, `,`** — you lose short-circuit/sequencing.
- Implement binary arithmetic as **free functions** built on the member compound
  forms; return by value.

## Quant/HFT relevance & interview gotchas

- **Cheap value types with operators.** `Price`/`Quantity` wrapping a single
  integer, with `+= -= * /` and `<=>`, give type-safe domain arithmetic that
  compiles to the same code as raw `long`s. Mark the operators `noexcept` and
  keep them inline (in the header) so they vanish into the call site.
- **`<=>` for container ordering.** A defaulted `operator<=>` (+ `==`) drops your
  type into `std::set`/`std::map`/`std::sort` for free, with the correct ordering
  strength — use `strong_ordering` for integer-backed price/qty.
- **The `&& || ,` trap is a favourite interview question.** Know that you *can*
  overload them but *mustn't*, and *why* (lost short-circuit/sequencing — the
  overload is a normal function call evaluating all operands).
- **Member-vs-free and the symmetry rule** are routinely asked: why is binary
  `+` free but `=`/`[]`/`()`/`->` must be members?
- **Functors over `std::function` on the hot path.** A custom `operator()` (or a
  lambda) inlines; `std::function` type-erases and typically does an indirect
  call and may allocate.
- **Floating-point comparison.** If a value type holds a `double`, defaulting
  `<=>` yields `partial_ordering` (because of `NaN`) — which won't satisfy the
  *strict weak ordering* `std::set`/`sort` require. Prefer integer (tick)
  representations for price exactly so ordering is total.

## Key takeaways

1. Operators are ordinary functions with syntactic sugar; overloading supplies
   the function for your type without changing precedence, arity, or built-in
   behaviour.
2. `=`, `[]`, `()`, `->` **must be members**; symmetric binary operators
   (`+`, `==`, `<<`) should be **free functions** (often `friend`) so both
   operands can convert.
3. Define binary arithmetic **in terms of the compound assignment** (`+` via
   `+=`), return **by value**, and keep it `noexcept`/inline.
4. C++20 **`operator<=>` `= default`** (plus a defaulted `==`) generates all six
   comparisons; the return type (`strong`/`weak`/`partial_ordering`) states the
   ordering strength.
5. **Never overload `&&`, `||`, `,`** — you destroy short-circuit and sequencing
   semantics. Don't surprise; keep operator meanings conventional.
6. `operator()` makes functors (inlinable comparators/lambdas); `operator[]`
   pairs with a checked `at()`; `operator->`/`*` build smart pointers and
   iterators.

## Self-check

1. Why is binary `operator+` best written as a free function while `operator+=`
   is a member? What does the symmetry buy you?
2. Why must `operator+` return by value rather than by reference?
3. You overload `operator&&`. What guarantee do callers silently lose, and why?
4. With C++20, what's the minimum you write to get `< <= > >= == !=` for a
   struct of two integers, and which ordering category do you get?
5. A `Price` wraps a `double` and defaults `<=>`. Why might it fail to work in a
   `std::set`, and how do you fix it?
6. When would you prefer a hand-written `operator()` functor over a
   `std::function` in a hot loop?

## Further reading

- [Operator overloading — cppreference](https://en.cppreference.com/w/cpp/language/operators) (canonical forms for every operator).
- [Default comparisons & `operator<=>` — cppreference](https://en.cppreference.com/w/cpp/language/default_comparisons) and [`<compare>` ordering categories](https://en.cppreference.com/w/cpp/utility/compare/strong_ordering).
- [C++ Core Guidelines — C.160/C.161/C.166/C.168: rules for sensible operator overloading](https://isocpp.org/wiki/guidelines/#Ro-conventional)
- Scott Meyers, *Effective C++*, Item 24 (declare non-member functions when conversions should apply to all parameters) and Item 23 (prefer non-member non-friend functions).
- [The spaceship operator — Modernes C++](https://www.modernescpp.com/index.php/c-20-the-three-way-comparison-operator/) — practical `<=>` walkthrough.
- The classic Stack Overflow [Operator Overloading FAQ](https://stackoverflow.com/questions/4421706/what-are-the-basic-rules-and-idioms-for-operator-overloading) — member vs free, canonical signatures, copy-and-swap.

## Videos

- CppCon — **"Back to Basics: Operator Overloading"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Operator+Overloading)) — member vs free, canonical forms, and taste rules.
- CppCon — **"Comparisons in C++20"** (Barry Revzin / spaceship talks) ([search](https://www.youtube.com/results?search_query=CppCon+C%2B%2B20+spaceship+operator+comparisons+Barry+Revzin)) — the definitive `operator<=>` deep dive.
