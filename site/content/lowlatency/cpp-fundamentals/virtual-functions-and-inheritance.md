# Virtual Functions and Inheritance

> **Why a quant dev must own this:** runtime polymorphism is convenient but it
> is *not free*. Every `virtual` call is a load-then-indirect-jump the branch
> predictor and instruction prefetcher hate, and the call can't be inlined — so
> the optimizer is blinded right at the call site. In a tick-to-trade path that
> runs millions of times a second, a stray vtable dispatch in your strategy loop
> is the difference between leading and last. Knowing exactly what the compiler
> emits, when it can *devirtualize*, and which static alternative to reach for is
> a staple HFT interview topic.

## First principles: static vs dynamic dispatch

A non-virtual call is *static dispatch*: the compiler knows at compile time
which function body runs, hard-codes its address (or inlines it), done. A
`virtual` call is *dynamic dispatch*: the function that runs is chosen at
runtime from the **dynamic type** of the object, not the static type of the
pointer/reference you call through.

```cpp
// C++17
struct Base       { virtual int f() const { return 1; } virtual ~Base() = default; };
struct Derived : Base { int f() const override { return 2; } };

int call(const Base& b) { return b.f(); }   // which f()? decided at runtime

Derived d;
call(d);                                    // returns 2, not 1
```

The compiler cannot, in general, know inside `call` whether `b` refers to a
`Base`, a `Derived`, or some `Derived2` defined in another translation unit.
That uncertainty is the entire cost.

## Mechanics & internals: the vtable and vptr

For each polymorphic class (one with at least one virtual function), the
compiler emits a per-*class* table of function pointers — the **vtable** (also
called the virtual method table). Every *object* of that class gets a hidden
pointer, the **vptr**, usually stored as the first machine word of the object,
that points at its class's vtable.

```text
            object (Derived d)              vtable for Derived (one per class)
           +-----------------+             +------------------------+
  &d  ->   | vptr            |------------>| [0] &type_info Derived |   (RTTI)
           +-----------------+             | [1] &Derived::~Derived |
           | base members... |             | [2] &Derived::f        |
           | derived members |             +------------------------+
           +-----------------+
```

A virtual call `b.f()` compiles to roughly:

```text
1. load vptr        = *(b)           ; first word of object
2. load target      = vptr[index_of_f]
3. call  target     (with b as 'this')
```

In x86-64 (Itanium ABI, as used by GCC/Clang on Linux):

```x86asm
; int call(const Base& b)  ->  return b.f();
; rdi = &b
        mov     rax, [rdi]        ; rax = vptr (load #1)
        mov     rax, [rax]        ; rax = vtable[0] = &Base::f (load #2)
        jmp     rax               ; tail-call the target (indirect branch)
```

Two dependent loads then an **indirect** jump. Contrast a non-virtual,
inlinable call which is often *zero* extra instructions.

### Single, multiple, and virtual inheritance

- **Single inheritance:** the derived vtable is an extension of the base's; the
  vptr layout is shared, and an upcast `Derived* -> Base*` is a no-op (same
  address).
- **Multiple inheritance:** the object embeds *multiple* vptrs (one per
  polymorphic base). Casting across to a second base **adjusts the `this`
  pointer** by a fixed offset, and the ABI inserts *thunks* to fix up `this`
  before the real call. More moving parts, more places to mispredict.
- **Virtual inheritance** (the diamond) adds a `vbase` offset table so the
  shared base is found indirectly. This is the heaviest layout and is rare in
  performance code — avoid it in hot structures.

> **Mnemonic:** *vptr per object, vtable per class.* A million `Derived`s share
> one vtable but each carries its own 8-byte vptr.

## The real cost in the hot path

The raw indirection — two loads and a jump — is only part of the story. The
expensive parts are:

1. **No inlining.** This is usually the dominant cost. Once the call is
   indirect, the compiler can't see the callee, so it can't inline, can't
   constant-fold across the boundary, can't keep values in registers, and must
   honor the full calling convention (spill caller-saved registers). A
   2-instruction accessor that *should* vanish becomes a real function call.
2. **Branch misprediction.** The indirect jump's target is data-dependent. If a
   loop calls through pointers of varying dynamic type, the indirect-branch
   predictor (BTB) thrashes. A mispredict on a modern x86 core is ~15-20
   cycles. A monomorphic call site (always the same target) predicts well and is
   nearly free; a polymorphic, type-shuffled one is brutal.
3. **Cache footprint.** The vptr load, the vtable line, and the target code all
   need to be resident. Cold vtables and cold callee code add L1i/L1d misses
   right when you can least afford them.

```text
Rough cycle budget (Skylake-class core, hot caches)
  non-virtual inlined accessor ........ ~0 (folds away)
  non-virtual real call ............... ~3-5
  virtual call, well-predicted ........ ~5-7  + lost inlining
  virtual call, mispredicted target ... ~20+  + lost inlining
```

The numbers are order-of-magnitude; *measure on your hardware*. The point that
survives any benchmark: the lost optimization is usually worse than the
dispatch itself.

## Devirtualization: when the compiler turns virtual back into static

If the compiler can *prove* the dynamic type at a call site, it converts the
virtual call into a direct (and inlinable) one — **devirtualization**.

```cpp
// C++17
Derived d;
d.f();              // static type IS the dynamic type -> devirtualized, inlined

void g() {
    Derived local;
    Base& b = local;
    b.f();          // compiler sees the construction -> can devirtualize
}
```

Triggers and helpers:

- **Exact type known** (a named local, a `new Derived` whose pointer doesn't
  escape).
- **`final`** on the class or the override caps the hierarchy, letting the
  compiler conclude no further override exists (see below).
- **LTO / whole-program** widens what the compiler can see across TUs;
  *speculative devirtualization* may emit `if (type == X) inline; else
  virtual;`.
- Anonymous-namespace types (no external overrides possible) help too.

You cannot rely on it — it's a *best effort*. The reliable lever you control is
`final`.

### `final` — the cheap, explicit win

```cpp
// C++17
struct Strategy { virtual void on_tick() = 0; virtual ~Strategy() = default; };

struct MomentumStrategy final : Strategy {   // 'final' on the class
    void on_tick() override { /* ... */ }
};

void run(MomentumStrategy& s) {
    s.on_tick();   // 'final' => no further override possible => devirtualized + inlinable
}
```

Mark a class or override `final` whenever you don't intend further derivation.
It documents intent, lets the optimizer devirtualize through references of the
final type, and forbids accidental overriding. It costs nothing.

## When virtual hurts — and the static alternatives

Reach for runtime polymorphism for genuine open-ended extensibility at *cold*
boundaries (plugin loading, config-driven object graphs, rarely-called
handlers). Avoid it on the **per-tick / per-message** path. Alternatives:

### 1. CRTP (static polymorphism)

The Curiously Recurring Template Pattern gives you an overridable interface with
**zero runtime dispatch** — everything resolves and inlines at compile time.

```cpp
// C++17
template <class Derived>
struct StrategyBase {
    void on_tick(const Tick& t) {
        static_cast<Derived*>(this)->handle(t);   // resolved at compile time
    }
};

struct Momentum : StrategyBase<Momentum> {
    void handle(const Tick& t) { /* hot, fully inlinable */ }
};
```

Cost: no vptr, no indirection, full inlining. Tradeoff: the concrete type must
be known at compile time — you can't store heterogeneous `StrategyBase*`s in one
container the way you can with virtual.

### 2. `std::variant` + `std::visit` (closed set)

When the set of types is *fixed and known*, a tagged union gives you
heterogeneity without a heap or a vptr; the dispatch is a jump table the
compiler can often inline per alternative.

```cpp
// C++17
#include <variant>
using Order = std::variant<LimitOrder, MarketOrder, CancelOrder>;

void process(const Order& o) {
    std::visit([](const auto& msg) { msg.apply(); }, o);  // closed-set dispatch
}
```

Tradeoff: the type set is closed (adding a type means editing the variant), and
the object is sized to the largest alternative.

### 3. Type erasure / `function_ref` at the boundary only

Push the one unavoidable indirection to the edge (e.g. one virtual call per
batch of messages), and run the inner loop statically.

```text
Decision guide
  open set, cold path .................. virtual (it's fine)
  open set, hot path, one type/loop .... template the loop on the concrete type
  closed set, hot path ................. std::variant + std::visit
  single overridable hook, hot path .... CRTP
  capping a hierarchy you do keep ...... add 'final'
```

## Quant/HFT relevance & interview gotchas

- **"What does a virtual call cost?"** Lead with the *lost inlining*, then the
  indirect-branch mispredict (~15-20 cycles when the target shuffles), then the
  two dependent loads. Junior answers stop at "one extra pointer dereference".
- **vptr breaks `memcpy`-ability and `constexpr`.** A polymorphic type is not
  trivially copyable and won't fit `std::is_trivially_copyable`; you can't
  `memcpy` it across a ring buffer, and the vptr is set by the constructor.
- **Calling virtuals in constructors/destructors** dispatches to the
  *current* class's version, not the derived override — classic trap.
- **`virtual` adds 8 bytes** (the vptr) and pulls the hot data members down,
  worsening cache density of arrays of objects.
- **Don't forget the virtual destructor** when deleting through a base pointer —
  but realize it makes the type polymorphic with all the costs above.
- **`final` for speed** is the answer to "how do you keep an interface but let
  the optimizer devirtualize?"
- A polymorphic object's first 8 bytes are the vptr, so `reinterpret_cast`ing a
  raw buffer onto a polymorphic type is doubly wrong (layout + you never set the
  vptr).

## Key takeaways

1. Virtual dispatch = vptr (per object) -> vtable (per class) -> indirect call.
   The real cost is **lost inlining** plus indirect-branch mispredicts, not just
   the extra load.
2. A *monomorphic* (single-target) virtual call predicts well; a
   *type-shuffled* one thrashes the BTB at ~15-20 cycles per miss.
3. The compiler **devirtualizes** when it can prove the dynamic type; `final`,
   exact types, and LTO are what make that happen.
4. Mark classes/overrides **`final`** when you don't need further derivation —
   free safety and a free optimization.
5. For hot paths prefer **CRTP** (open hook, compile-time type) or
   **`std::variant`+`std::visit`** (closed set); keep `virtual` for cold,
   open-ended boundaries.
6. `virtual` makes a type non-trivially-copyable and adds 8 bytes — bad for
   buffers and dense arrays.

## Self-check

1. Sketch the assembly for `b.f()` through a `Base&`. How many loads precede the
   call, and why is the jump *indirect*?
2. Why is the lost inlining usually a bigger cost than the indirection itself?
3. Give two situations where the compiler can legally devirtualize a call.
4. You have a fixed set of three order types processed in the hot loop. Which
   alternative to `virtual` do you choose, and what's the tradeoff?
5. Why does calling a virtual function from a base-class constructor not reach
   the derived override?
6. How many bytes does adding a first virtual function cost an otherwise-empty
   struct on x86-64, and where does it sit?

## Further reading

- [Virtual function — cppreference](https://en.cppreference.com/w/cpp/language/virtual) and [`final` specifier — cppreference](https://en.cppreference.com/w/cpp/language/final)
- [Itanium C++ ABI](https://itanium-cxx-abi.github.io/cxx-abi/abi.html) — the authoritative spec for vtable/vptr layout, thunks, and vbase offsets used by GCC/Clang.
- [Devirtualization in C++ — Jan Hubička (GCC) series](https://hubicka.blogspot.com/2014/01/devirtualization-in-c-part-1.html) — the compiler engineer's view, including speculative devirtualization and LTO.
- [`std::variant` — cppreference](https://en.cppreference.com/w/cpp/utility/variant) and [`std::visit` — cppreference](https://en.cppreference.com/w/cpp/utility/variant/visit) for closed-set dispatch.
- [Agner Fog, *Optimizing C++*](https://www.agner.org/optimize/optimizing_cpp.pdf) — § on virtual functions and indirect branches; the canonical microarchitectural treatment.
- ["The cost of dynamic (virtual calls) vs. static (CRTP) dispatch in C++" — Eli Bendersky](https://eli.thegreenplace.net/2013/12/05/the-cost-of-dynamic-virtual-calls-vs-static-crtp-dispatch-in-c) — a careful measured comparison.

## Videos

- CppCon — **Carl Cook, "When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+When+a+Microsecond+Is+an+Eternity)) — explicitly argues for keeping virtual dispatch off the hot path.
- CppCon — **"Inheritance Is Not Polymorphism / static polymorphism and CRTP"** ([search](https://www.youtube.com/results?search_query=CppCon+CRTP+static+polymorphism)) — when to replace virtual with templates.
