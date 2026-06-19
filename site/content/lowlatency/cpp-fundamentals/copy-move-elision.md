# Copy-Move Elision

> **Why a quant dev must own this:** "return by value" is the idiomatic,
> safe-by-default style — but only because the compiler can usually make it
> *free*. Copy elision and (N)RVO erase the copy and even the move, so a factory
> that returns a fat `OrderBook` by value costs nothing more than constructing it
> in place. Misunderstand the rules and you'll either fear return-by-value (and
> reach for raw pointers / out-params that fight the optimizer) or sprinkle
> `std::move` on returns and *disable* the very elision you wanted. This is a
> favorite "do you really understand C++17?" interview thread.

## Intuition: the copy that never happens

Naively, `T x = make();` looks like: construct a temporary inside `make`, copy
it out into the return slot, copy *that* into `x`. Two copies. **Copy elision**
lets the compiler construct the object *directly* in `x`'s storage, skipping the
intermediate objects entirely — so the constructor of `T` runs exactly once, in
the final location.

This is unusual: elision is the one optimization explicitly allowed to change
*observable behavior* (it can skip copy/move constructor *side effects*). The
compiler may elide even if the copy/move ctor has printf-in-it side effects.

## The two named cases

### RVO — Return Value Optimization (returning a prvalue/temporary)

```cpp
// C++17
struct Heavy { Heavy(); Heavy(const Heavy&); Heavy(Heavy&&); /* ... */ };

Heavy make() {
    return Heavy{};        // returning a temporary (prvalue): RVO
}

Heavy h = make();          // h is constructed in place; zero copies, zero moves
```

### NRVO — Named Return Value Optimization (returning a named local)

```cpp
// C++17
Heavy build() {
    Heavy h;               // a named local
    h.reserve(1024);
    return h;              // NRVO: 'h' may be constructed directly in the caller's slot
}
```

Both let the callee build the object straight into the caller's storage via the
hidden "return slot" pointer the ABI passes for return-by-value of non-trivial
types.

## The C++17 dividing line: *guaranteed* copy elision

Before C++17, elision was an *allowed but optional* optimization, and the
copy/move constructor still had to be **accessible and non-deleted** even when
elided. C++17 changed the model for **prvalues**:

- A prvalue no longer "is an object" that gets copied. It is an *initializer*
  that **materializes** directly into its destination. So when you initialize
  from a prvalue, there is *no copy/move to elide* — there was never a second
  object.

```cpp
// C++17 — guaranteed: no copy/move ctor is needed at all
struct NoMoveNoCopy {
    NoMoveNoCopy() = default;
    NoMoveNoCopy(const NoMoveNoCopy&) = delete;   // both deleted!
    NoMoveNoCopy(NoMoveNoCopy&&)      = delete;
};

NoMoveNoCopy factory() { return NoMoveNoCopy{}; } // OK in C++17 (was ill-formed pre-17)
NoMoveNoCopy x = factory();                        // OK: direct construction
```

```text
                       prvalue return (RVO)        named-local return (NRVO)
  C++14 and earlier    optional elision;           optional elision;
                       copy/move ctor must exist   copy/move ctor must exist
  C++17 and later      GUARANTEED, no ctor needed   still OPTIONAL;
                       (prvalue materializes)       copy/move ctor must exist
```

The crucial asymmetry: **RVO (prvalue) is guaranteed in C++17; NRVO (named
local) is still merely permitted.** NRVO works on every mainstream compiler in
`-O2`, but the standard doesn't force it, and certain shapes defeat it.

## When the move is chosen instead

If elision can't apply but the source is about to die, the standard mandates the
*implicit move* path before falling back to copy. The classic rule (C++11
onward, refined repeatedly): when you `return name;` and `name` is an eligible
local of the function's return type, overload resolution treats it as an
**rvalue first** — so a move is selected over a copy even though `name` is an
lvalue.

```cpp
// C++17
std::string f() {
    std::string s = "...";
    return s;     // elision (NRVO) preferred; if not, IMPLICIT MOVE, not copy
}
```

So the fallback ladder is: **(1) elide → (2) implicit move → (3) copy.** You get
the best available rung automatically.

## The anti-pattern: `return std::move(local);`

Because the language already does the right thing, an explicit `std::move` on
the return value **hurts**:

```cpp
// C++17
Heavy bad() {
    Heavy h;
    return std::move(h);   // BAD: turns the result into an xvalue expression,
}                          //      which DEFEATS NRVO -> forces an actual move
```

`return h;` is eligible for NRVO (zero ops). `return std::move(h);` is *not* the
name `h` — it's the expression `std::move(h)`, which is not a candidate for
NRVO, so you guarantee a move that you could have had for free. Most compilers
will warn (`-Wpessimizing-move`). **Rule: return the bare name.**

The one legitimate `std::move`-on-return case is when the local's type differs
from the return type (so NRVO never applied anyway) and the source must be
plundered:

```cpp
// C++17
std::unique_ptr<Base> g() {
    auto d = std::make_unique<Derived>();
    return d;              // OK: implicit move to a DIFFERENT type (Base ptr); no NRVO possible,
}                          //     language does the move for you — no std::move needed here either
```

## What defeats NRVO (so you can avoid writing it)

```cpp
// C++17 — patterns that prevent NRVO
Heavy two_paths(bool b) {
    Heavy a, c;
    return b ? a : c;      // returns one of two different locals -> no NRVO
}

Heavy from_param(Heavy h) {
    return h;              // 'h' is a PARAMETER, not a local -> no NRVO (but implicit move applies)
}

Heavy from_member(Wrapper& w) {
    return w.member;       // not a local object -> copy/move, no NRVO
}
```

Single named local, declared in the function body, of the exact return type,
returned on every path — that's the NRVO-friendly shape.

## Idiomatic return-by-value patterns

```cpp
// C++17
// 1. Factory: build and return by value. Free in C++17.
OrderBook make_book(const Config& c) {
    OrderBook ob{c};
    ob.warm_up();
    return ob;             // NRVO; no std::move
}

// 2. Multiple values: return a struct / use structured bindings (C++17).
struct Quote { double bid; double ask; };
Quote top_of_book(const OrderBook& ob) {
    return { ob.best_bid(), ob.best_ask() };   // prvalue: guaranteed elision
}
auto [bid, ask] = top_of_book(ob);             // structured binding

// 3. Feeding a container: emplace/push of a prvalue, then move into the slot.
std::vector<OrderBook> books;
books.push_back(make_book(cfg));   // make_book elided into the temp, then moved into vector
```

> **Senior answer to "is return-by-value slow?":** No — in C++17 returning a
> prvalue is guaranteed zero-copy, and returning a named local is NRVO'd in
> practice; the worst realistic case is one `noexcept` move. Returning by value
> is the correct default.

## Performance & hardware reality

- Elision removes both the constructor *call* and the data copy — for a vector
  of a million doubles that's an ~8 MB `memcpy` plus an allocation/deallocation
  *gone*, not merely deferred.
- The mechanism is the ABI **return slot**: for a non-trivially-copyable return
  type the caller allocates the result's storage and passes a hidden pointer in
  a register; the callee writes through it. There is no second object to copy.
- A *move* fallback (when elision doesn't fire) is still O(1) for owning types —
  cheap, but not *nothing*; it dirties cache lines and runs the move ctor.
  Elision is strictly better, which is why defeating it matters.
- Mark move constructors `noexcept` so the implicit-move fallback (and container
  reallocation) stays on the move path rather than degrading to copy.

## Quant/HFT relevance & interview gotchas

- **C++17 guarantees elision for prvalues only** (RVO), not for named locals
  (NRVO). State that distinction precisely — it's the question's whole point.
- **`return std::move(local);` defeats NRVO.** Return the bare name. Know the
  one exception (returning a local whose type ≠ the return type, e.g.
  `unique_ptr<Derived>` as `unique_ptr<Base>` — and even there you don't need an
  explicit move).
- **The fallback ladder is elide → implicit-move → copy**, chosen for you.
- **Return-by-value is the right default**, even for fat objects; it doesn't
  fight the optimizer, it cooperates with it. Out-params and returning raw
  pointers are usually premature pessimization.
- A type with both copy and move **deleted** can still be returned as a prvalue
  in C++17 — handy for move-only/immovable singletons and `std::mutex`-holding
  factories.
- NRVO is not guaranteed, so don't rely on it for *correctness* (e.g. side
  effects in the move ctor must not be load-bearing).

## Key takeaways

1. Copy elision constructs the result **directly** in the caller's storage,
   skipping intermediate copies/moves — the one optimization allowed to drop
   side effects.
2. **RVO** = returning a prvalue/temporary; **NRVO** = returning a named local.
3. **C++17 makes prvalue elision (RVO) guaranteed** — no copy/move ctor need
   even exist; **NRVO remains optional** but happens in practice at `-O2`.
4. The automatic fallback ladder is **elide → implicit move → copy**.
5. **Never write `return std::move(local);`** — it kills NRVO; return the bare
   name.
6. Return-by-value is the correct default in modern C++; mark moves `noexcept`
   to keep the fallback cheap.

## Self-check

1. Distinguish RVO from NRVO. Which one does C++17 *guarantee*, and why is the
   other only "permitted"?
2. Why is `NoMoveNoCopy factory() { return NoMoveNoCopy{}; }` legal in C++17 but
   ill-formed in C++14?
3. What's wrong with `return std::move(local);`? What does the compiler warn?
4. Give two function shapes that defeat NRVO.
5. When elision can't apply, what does the standard pick before falling back to
   a copy, and what enables that?
6. A factory returns a 1M-element `std::vector` by value. Roughly what work does
   guaranteed elision save versus the naive double-copy model?

## Further reading

- [Copy elision — cppreference](https://en.cppreference.com/w/cpp/language/copy_elision) — RVO/NRVO rules and the C++17 guarantee, with examples.
- [P0135R1 — "Guaranteed copy elision through simplified value categories"](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2016/p0135r1.html) — the C++17 proposal that reworked prvalues.
- [Return statement — cppreference](https://en.cppreference.com/w/cpp/language/return) — the implicit-move-on-return rules and eligibility.
- Scott Meyers, *Effective Modern C++*, Item 25 ("Use `std::move` on rvalue references, `std::forward` on universal references") — covers why `return std::move(local)` is wrong.
- [Arthur O'Dwyer, "The surprising limitations of C++ NRVO"](https://quuxplusone.github.io/blog/2018/04/27/this-pointer-is-not-const/) and his elision posts — practical edge cases compilers do/don't optimize.
- [eel.is/c++draft — `[class.copy.elision]`](https://eel.is/c++draft/class.copy.elision) — the standardese for when elision is mandatory vs. permitted.

## Videos

- CppCon — **"Back to Basics: RVO and Copy Elision"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+RVO+copy+elision)) — a focused walkthrough of the cases above.
- CppCon — **Arthur O'Dwyer, talks on value categories / RVO** ([search](https://www.youtube.com/results?search_query=CppCon+Arthur+O%27Dwyer+RVO+value+categories)) — careful coverage of where NRVO does and doesn't fire.
