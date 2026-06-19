# CRTP

> **Why a quant dev must own this:** CRTP is how C++ does polymorphism *without
> paying for it*. You get the design benefit — a shared interface, reusable
> behavior, pluggable strategies — but the call is resolved at compile time,
> inlined, and the vtable disappears. In a hot path that dispatches per-message
> to a strategy or order-handler, a `virtual` call is an indirect branch that
> the CPU can mispredict and the optimizer can't see through; CRTP turns that
> same dispatch into a direct, inlinable `call` (or no call at all). It's also
> the backbone of policy-based design, and a near-guaranteed HFT interview topic
> the moment "virtual is too slow" comes up.

All code here is **C++17**, with a C++20 concepts comparison near the end (and
notes where C++23 `deducing this` changes the picture).

## The shape of the pattern

The **Curiously Recurring Template Pattern** is a base class template
parameterized on its *own derived class*:

```cpp
template <class Derived>
struct Base {
    // ... uses Derived ...
};

struct Widget : Base<Widget> {   // <-- the "curious recurrence": Widget passes itself
    // ...
};
```

Read it twice: `Widget` inherits from `Base<Widget>`. The base, at the point of
instantiation, *already knows the exact derived type*. That single fact is the
whole trick — because `Base` knows `Derived` statically, it can call into
`Derived`'s methods with the concrete type, and the compiler resolves everything
at compile time. No runtime type information, no vptr, no indirection.

This is sometimes described as **static polymorphism** or the **F-bounded
polymorphism** idiom.

## First principles: why the base can dispatch statically

A normal base class has no idea what derives from it, so a `virtual` call must
look up the real type at run time via the vtable. CRTP inverts this: by the time
`Base<Widget>` is instantiated, the compiler is *staring at* `Widget`. So `Base`
can downcast `this` to `Derived*` and call the derived method directly — a
**static (compile-time) downcast**, which is safe here precisely because the
template guarantees that `this` really is a `Derived`.

```cpp
template <class Derived>
struct Shape {
    // The .self() cast: turn 'this' (a Base*) into the real Derived&.
    // static_cast is safe because Derived really is the most-derived type here.
          Derived& self()       { return static_cast<      Derived&>(*this); }
    const Derived& self() const { return static_cast<const Derived&>(*this); }

    // A "virtual-like" interface, but dispatched at COMPILE TIME:
    double area() const { return self().area_impl(); }   // calls Derived::area_impl
    void   describe() const {
        // Base can compose behavior on top of the derived primitive — no vtable.
        std::printf("area = %f\n", self().area_impl());
    }
};

struct Circle : Shape<Circle> {
    double r;
    explicit Circle(double r) : r(r) {}
    double area_impl() const { return 3.141592653589793 * r * r; }  // the "override"
};

struct Square : Shape<Square> {
    double s;
    explicit Square(double s) : s(s) {}
    double area_impl() const { return s * s; }
};
```

`Shape<Circle>::area()` calls `self().area_impl()`, and because `self()` returns a
`Circle&` *at compile time*, the call binds to `Circle::area_impl` directly. The
compiler inlines it. There is no vtable in `Circle` at all.

> **The `.self()` cast is the heart of CRTP.** Memorize it: `static_cast<Derived&>(*this)`,
> with a `const` overload. Every CRTP base uses it to reach the derived type.
> It is well-defined *only because* the pattern guarantees `*this` is actually a
> `Derived` — which is also the source of CRTP's worst footgun (below).

## Static interfaces vs `virtual`

Side by side, the same "shape interface" two ways:

```cpp
// --- Runtime polymorphism ---
struct ShapeV {
    virtual double area() const = 0;       // vtable slot
    virtual ~ShapeV() = default;
};
struct CircleV : ShapeV {
    double r;
    double area() const override { return 3.14159 * r * r; }
};

// --- CRTP static polymorphism (above) ---
template <class D> struct Shape { /* area() -> self().area_impl() */ };
struct Circle : Shape<Circle> { /* area_impl() */ };
```

```text
                       virtual                    CRTP (static)
--------------------  -------------------------  --------------------------------
dispatch              run time, via vptr          compile time, direct/inlined
per-object cost       +8 bytes (vptr)             0 (no vptr)
call cost             indirect call (load vptr,   direct call, usually INLINED
                      load slot, jump); ~3-20+cy  to ~0
inlinable?            no (opaque indirect target) yes — optimizer sees the body
heterogeneous store   yes: vector<ShapeV*>        NO: Shape<Circle>, Shape<Square>
                                                  are unrelated types
binary interface      stable across TUs/plugins   header-only, recompile on change
decided by            the object at run time      the type at compile time
```

The trade is stark and intentional: **CRTP buys you zero-overhead dispatch by
giving up runtime type erasure.** You can't put `Circle` and `Square` in one
`std::vector<Shape*>` because `Shape<Circle>` and `Shape<Square>` are different,
unrelated types. If you genuinely need a heterogeneous runtime collection, CRTP
is the wrong tool (or you wrap it — see below). If your set of types is known at
compile time and lives in a hot loop, CRTP is the right tool.

## CRTP for mixins (injecting behavior)

The second great use of CRTP is **mixins**: a base that implements behavior *in
terms of* a few primitives the derived class supplies. The canonical example is
deriving all comparison operators from one:

```cpp
// Mixin: give Derived all six relational ops from a single operator<.
template <class Derived>
struct Comparable {
    friend bool operator< (const Derived& a, const Derived& b) { return a.less(b); }
    friend bool operator> (const Derived& a, const Derived& b) { return b < a; }
    friend bool operator<=(const Derived& a, const Derived& b) { return !(b < a); }
    friend bool operator>=(const Derived& a, const Derived& b) { return !(a < b); }
    friend bool operator==(const Derived& a, const Derived& b) { return !(a<b) && !(b<a); }
    friend bool operator!=(const Derived& a, const Derived& b) { return  (a<b) ||  (b<a); }
};

struct Price : Comparable<Price> {
    std::int64_t ticks;
    bool less(const Price& o) const { return ticks < o.ticks; }   // the one primitive
};
// Price now has <, >, <=, >=, ==, != — all inlined, all free.
```

This is exactly how Boost.Operators worked for two decades. In C++20 the
spaceship operator `<=>` largely replaces *this specific* mixin, but the CRTP
mixin technique generalizes far beyond comparison: enable-shared-from-this,
intrusive reference counting, cloning, named-parameter builders, and so on.

`std::enable_shared_from_this<T>` in the standard library *is* CRTP:
`class Foo : public std::enable_shared_from_this<Foo>`.

## Policy-based design — the HFT-relevant form

This is where CRTP earns its keep in trading systems. You compose a strategy or
handler out of **policies** chosen at compile time, with no virtual dispatch
anywhere in the resulting object. A market-data engine that calls back into a
strategy on every tick wants that callback to be a *direct, inlined* call.

```cpp
// A feed engine that drives a Strategy via CRTP. on_tick() is resolved and
// inlined at compile time — the hot path has NO indirect call.
template <class Strategy>
class FeedEngine {
    Strategy& strat() { return static_cast<Strategy&>(*this); }   // .self()
public:
    void process(const Tick& t) {
        // Pre/post work the engine owns, bracketing the derived hook:
        ++count_;
        strat().on_tick(t);          // direct call into the concrete strategy, inlined
    }
    std::uint64_t count() const { return count_; }
private:
    std::uint64_t count_ = 0;
};

struct Momentum : FeedEngine<Momentum> {
    double ewma_ = 0.0;
    void on_tick(const Tick& t) {                 // the "override"
        ewma_ = 0.95 * ewma_ + 0.05 * t.price();  // gets inlined into process()
        if (ewma_ > t.price()) { /* send order */ }
    }
};
```

Because `process()` knows it's driving a `Momentum`, `on_tick` is inlined *into*
`process`, the `0.95/0.05` EWMA arithmetic folds in, and the whole thing becomes
straight-line code with no call at all. With `virtual`, `on_tick` would be an
indirect call the optimizer cannot inline, and the EWMA constants would never
fold across the call boundary.

You can stack policies the same way (an allocation policy, a logging policy, a
risk-check policy) — each a CRTP base — and pay zero runtime cost for the
composition.

## The assembly contrast

This is the argument that wins interviews. Take a one-line dispatch both ways.

**Virtual** — the compiler must load the vptr, load the slot, and call through it
(it cannot know the concrete type), so it cannot inline:

```x86asm
; double total = s->area();   where s is ShapeV*
        mov     rax, [rdi]          ; load vptr from the object
        call    [rax + 0]           ; INDIRECT call through vtable slot — opaque target,
                                    ; not inlinable, mispredictable on the BTB
```

**CRTP** — the concrete type is known, so the call is direct and, here, fully
inlined away to the arithmetic itself:

```x86asm
; double total = c.area();   where c is Circle (Shape<Circle>)
        movsd   xmm1, [rdi]         ; load r
        mulsd   xmm1, xmm1          ; r * r
        mulsd   xmm1, [rip + pi]    ; * pi      <-- area_impl inlined entirely; NO call
```

Same source-level abstraction; the CRTP version emitted *zero* call instructions
where the virtual version emitted an indirect one. In a loop over millions of
messages, the difference is the indirect-call latency *plus* every optimization
the inliner can now perform across what used to be a call boundary (constant
folding, vectorization, register allocation).

## Performance & hardware reality

- A predicted indirect call is only a few cycles on its own, but it's not the
  headline cost. The real losses are: **(1) the inliner gives up** at the call
  boundary, killing constant propagation and vectorization; **(2) branch-target
  mispredicts** when the call site sees several concrete types, which flush the
  pipeline (tens of cycles); **(3)** the vtable load is an extra dependent memory
  access, occasionally a cache miss.
- **Per-object memory:** a polymorphic object carries an 8-byte vptr; a CRTP
  object carries nothing extra. Across a packed array of small objects that's
  real cache footprint.
- **Code size is the counter-pressure:** CRTP instantiates the base per derived
  type, so heavy bases multiply `.text`. Usually a fine trade in HFT (latency >
  size), but not free.
- CRTP composes with `final`: marking a derived class `final` also helps the
  *virtual* case via **devirtualization**, but CRTP needs no such help — it was
  never virtual.

## Pitfalls and gotchas

- **The `static_cast` is a loaded gun.** `Shape<Circle>` *assumes* the real object
  is a `Circle`. If you write `struct Bug : Shape<Circle> {...}` (passed the wrong
  type) the cast is UB and silently wrong. Guard it:
  ```cpp
  template <class D> struct Shape {
      Shape() { static_assert(std::is_base_of_v<Shape<D>, D>); }  // catch mismatches
  };
  ```
- **No heterogeneous containers.** `Shape<Circle>` and `Shape<Square>` share no
  common base, so `std::vector<Shape*>` is impossible. If you need one collection,
  either accept `virtual`, or **wrap CRTP objects in a type-erasing facade** (a
  `std::variant<Circle, Square>`, or a hand-rolled erased holder) at the boundary
  — keep CRTP inside the hot loop, erase only at the edge.
- **Object slicing is N/A here.** Slicing is a value-semantics hazard of *runtime*
  polymorphism (copying a `Derived` into a `Base` by value drops the derived part).
  CRTP bases aren't used as value types you copy-as-base, and there's no vtable to
  slice away — so the classic slicing bug simply doesn't arise. Be ready to *say*
  that; interviewers like the contrast.
- **Calling derived members from the base ctor is still UB-prone.** During
  `Base<D>`'s constructor the `D` subobject isn't constructed yet; `self().foo()`
  in the base constructor reads an uninitialized derived object. Don't dispatch
  into the derived from a base constructor.
- **Two-phase name lookup surprises.** In templates, references to the derived
  interface must go through `self()` / `this->`; a bare `area_impl()` in the base
  won't find the derived member.
- **Diamond / multiple CRTP bases** need care with ambiguous `self()`; give each
  mixin a distinct, unambiguous cast or use uniquely-named hooks.

## CRTP vs C++20 concepts vs `deducing this`

These are often pitched as competitors; they solve overlapping but distinct
problems.

- **Concepts (C++20)** constrain a template ("this `T` must have an `on_tick`")
  and produce great errors, but they do **not** by themselves give you a *base
  class that injects behavior*. You can replace CRTP's *static-interface checking*
  with a concept, and replace CRTP *mixins* sometimes with free function templates
  — but when you specifically want "a base that provides default behavior in terms
  of derived primitives," CRTP (or `deducing this`) is still the mechanism.
- A modern hybrid: keep CRTP for the mixin, add a concept to *document and check*
  the required derived interface:
  ```cpp
  template <class T>
  concept TickHandler = requires (T t, const Tick& k) { t.on_tick(k); };

  template <TickHandler Strategy>            // concept-constrained CRTP base
  class FeedEngine { /* ... self().on_tick(t) ... */ };
  ```
- **`deducing this` (C++23)** is the future-facing replacement for the `.self()`
  boilerplate: an explicit object parameter gives you the *derived* type directly,
  no `static_cast`:
  ```cpp
  struct Shape23 {
      template <class Self>
      double area(this const Self& self) { return self.area_impl(); }  // no CRTP base needed
  };
  ```
  This removes the cast footgun and the `Base<Derived>` recurrence for many mixin
  use cases. Where available, prefer it; CRTP remains the portable answer and the
  one you must still explain in interviews.

## Quant/HFT relevance & interview gotchas

- **"Virtual is too slow in the hot path — what do you do?"** The expected answer
  is CRTP / static polymorphism (or `std::variant` + `std::visit`): resolve
  dispatch at compile time, keep the call inlinable. Be able to say *why* —
  inlining and no indirect branch, not just "no vtable."
- **Show the asm intuition** (above). Saying "the virtual call can't be inlined,
  so the optimizer can't fold across it" is the senior point, beyond "the vptr
  costs 8 bytes."
- **Policy-based design** (Alexandrescu's *Modern C++ Design*) is the canonical
  framing; mention it. Strategy dispatch, allocation policies, risk checks — all
  composed at compile time.
- **Know the trade-off explicitly:** no heterogeneous containers, more code size,
  header coupling (recompile on change vs. a stable vtable ABI for plugins).
- **CRTP vs `std::variant`:** both give compile-time-known dispatch. `variant` +
  `visit` *does* give you a homogeneous container of a closed set of types and is
  often the better modern answer when you need that; CRTP is leaner when each call
  site knows its one concrete type.
- **`enable_shared_from_this` is CRTP** — a great "where have you seen it in the
  standard library?" answer.
- **The `static_cast` safety argument** — be ready to explain why it's
  well-defined (the template guarantees the dynamic type) and how it breaks if you
  pass the wrong `Derived`.

## Key takeaways

1. **CRTP = a base templated on its derived class** (`struct D : Base<D>`), so the
   base knows the concrete type at compile time and dispatches **statically**.
2. The **`.self()` cast** — `static_cast<Derived&>(*this)` with a const overload —
   is the mechanism; it's safe *only because* the pattern guarantees the real type.
3. It delivers **static polymorphism with zero runtime cost**: no vptr, no
   indirect call, and — crucially — the call **inlines**, unlocking further
   optimization the virtual version blocks.
4. Two big uses: **static interfaces** (virtual-like dispatch, free) and **mixins**
   (inject behavior from a derived primitive, e.g. comparisons, ref-counting).
5. In HFT it underpins **policy-based design and strategy dispatch** — the
   per-tick callback becomes a direct, inlined call with no indirect branch.
6. The cost is **no heterogeneous containers** and more code size/header coupling;
   slicing is N/A (no value-as-base copy, no vtable). Use `virtual` or
   `std::variant` when you need a runtime-heterogeneous collection.
7. **C++20 concepts** check/constrain the derived interface but don't replace the
   behavior-injection role; **C++23 `deducing this`** removes the `.self()`
   boilerplate where available.

## Self-check

1. Why can `Base<Derived>` call `Derived`'s methods without a vtable, when an
   ordinary base class cannot?
2. Write the `const` and non-`const` `self()` accessors. Why is the `static_cast`
   safe here, and exactly when does it become UB?
3. Give two reasons a `virtual` call is slower than a CRTP call beyond the 8-byte
   vptr. (Hint: one is about the *optimizer*, not the CPU.)
4. Why can't you store `Shape<Circle>` and `Shape<Square>` in one
   `std::vector<Shape*>`? What would you do if you needed a single collection?
5. Why is "object slicing" not a CRTP concern, and what *is* the analogous CRTP
   footgun involving construction?
6. When would you choose `std::variant` + `std::visit` over CRTP, and vice versa?
7. How does C++23 `deducing this` change how you'd write the `FeedEngine` example?

## Further reading

- [CRTP — cppreference](https://en.cppreference.com/w/cpp/language/crtp) and the [Standard C++ Foundation glossary entry](https://isocpp.org/wiki/faq/templates#crtp).
- Fluent C++, ["The Curiously Recurring Template Pattern (CRTP)" series](https://www.fluentcpp.com/2017/05/12/curiously-recurring-template-pattern/) — `self()`, mixins, and pitfalls in depth.
- Andrei Alexandrescu, *Modern C++ Design* — policy-based design, the origin of much of this thinking.
- [`std::enable_shared_from_this` — cppreference](https://en.cppreference.com/w/cpp/memory/enable_shared_from_this) — CRTP in the standard library.
- [Deducing `this` (P0847, C++23) — cppreference](https://en.cppreference.com/w/cpp/language/member_functions#Explicit_object_parameter) — the modern replacement for the `.self()` cast.
- Arthur O'Dwyer, ["The space of design choices for std::function-like type erasure"](https://www.youtube.com/results?search_query=Arthur+O%27Dwyer+type+erasure+CppCon) — when you *do* need runtime heterogeneity instead of CRTP.

## Videos

- Jason Turner, **C++ Weekly** — **"The Curiously Recurring Template Pattern (CRTP)"** ([search](https://www.youtube.com/results?search_query=C%2B%2B+Weekly+Jason+Turner+CRTP+curiously+recurring+template+pattern)).
- Carl Cook, CppCon — **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why hot paths avoid virtual dispatch.
- David Gross, Meeting C++ — **"Trading at light speed: designing low latency systems in C++"** ([search](https://www.youtube.com/results?search_query=David+Gross+Trading+at+light+speed)) — static dispatch and policy composition in production HFT.
