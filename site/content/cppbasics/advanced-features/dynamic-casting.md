# Dynamic Casting

> **Why a quant dev must own this:** `dynamic_cast` is the one cast that costs
> *runtime* — it walks the type hierarchy at execution time using RTTI. On a
> tick-to-trade path that is exactly the wrong tool: it is not constant-time, it
> pulls in RTTI metadata, and a `dynamic_cast` deep in a message loop is usually
> a sign that virtual dispatch or a `std::variant` should have done the job.
> Knowing *when it's safe*, *what it costs*, and *what to use instead* is a
> standard HFT interview discriminator.

## First principles: four casts, one of them runs at runtime

C++ has four named casts. Three are resolved entirely at compile time;
`dynamic_cast` is the odd one out:

| Cast | When | Cost | Use |
|---|---|---|---|
| `static_cast` | compile time | **free** | known-safe conversions, up/down-cast you *promise* is valid |
| `dynamic_cast` | **runtime** | **type-tree walk** | *checked* down/cross-cast in a polymorphic hierarchy |
| `const_cast` | compile time | free | add/remove `const`/`volatile` |
| `reinterpret_cast` | compile time | free | bit-reinterpretation (dangerous) |

`dynamic_cast<Derived*>(base_ptr)` asks a *question at runtime*: "does this
object's most-derived type actually contain a `Derived`?" If yes, it returns a
correctly-adjusted pointer; if no, it tells you so safely.

```cpp
struct Order { virtual ~Order() = default; };       // polymorphic: has a vtable
struct LimitOrder  : Order { double limit_px; };
struct MarketOrder : Order { };

void handle(Order* o) {
    if (auto* lo = dynamic_cast<LimitOrder*>(o)) {   // succeeds only if o really
        use(lo->limit_px);                            //   is a LimitOrder
    }                                                 // else lo == nullptr
}
```

## Requirement: the source type must be polymorphic

`dynamic_cast` (in its downcast/cross-cast form) **requires the source type to
be polymorphic** — it must have at least one virtual function (commonly a
`virtual` destructor). That virtual function is what gives the object a
**vtable**, and the vtable is where the runtime finds the type information it
needs.

```cpp
struct Plain { int x; };               // NO virtual functions
struct P2 : Plain {};
Plain p;
// dynamic_cast<P2*>(&p);              // ERROR: 'Plain' is not polymorphic
```

If you forget the `virtual` destructor on your base, `dynamic_cast` won't even
compile against it — and deleting through the base pointer would be UB anyway.
A polymorphic base is the price of admission.

## Pointer form vs reference form: nullptr vs `std::bad_cast`

The two forms report failure differently — this is a guaranteed gotcha:

```cpp
Order* base = new MarketOrder;

// POINTER form: returns nullptr on failure. Check it.
LimitOrder* p = dynamic_cast<LimitOrder*>(base);   // p == nullptr (not a LimitOrder)
if (!p) { /* handle: it wasn't a LimitOrder */ }

// REFERENCE form: cannot return "null reference", so it THROWS on failure.
try {
    LimitOrder& r = dynamic_cast<LimitOrder&>(*base);   // throws std::bad_cast
} catch (const std::bad_cast& e) {
    /* it wasn't a LimitOrder */
}
```

- **Pointer form** → `nullptr` on failure. The idiomatic "test-and-use" pattern
  (`if (auto* d = dynamic_cast<D*>(b))`).
- **Reference form** → throws **`std::bad_cast`** on failure (there is no null
  reference). On a hot path this drags in the entire exception machinery — yet
  another reason to keep `dynamic_cast` out of it.

An *upcast* (derived → base) never fails and never needs `dynamic_cast` —
`static_cast` or an implicit conversion does it for free. `dynamic_cast` earns
its keep only for **downcasts** and **cross-casts**.

## How it works under the hood: RTTI and `__dynamic_cast`

`dynamic_cast` is powered by **RTTI** (Run-Time Type Information). For every
polymorphic type the compiler emits a `std::type_info` object, and a pointer to
it sits in the type's **vtable** (in the Itanium ABI, just *above* the first
function-pointer slot, at offset `-1` from the vptr target). The compiler also
emits, for each polymorphic class, an **`__class_type_info`** structure
describing its base classes — effectively a node in the inheritance graph.

When you write `dynamic_cast<Derived*>(p)`, the compiler (Itanium ABI) emits a
call to the runtime helper **`__dynamic_cast`**:

```text
vptr ──► [ ... , &type_info ] ─► std::type_info ─► __class_type_info graph
                                                    │  (bases, offsets, virtuality)
__dynamic_cast(p, &SrcInfo, &DstInfo, hint):
   1. find the most-derived object via the vptr
   2. WALK the recorded base-class graph from most-derived toward Dst
   3. if a unique, public path to Dst is found -> return pointer adjusted
                                                    by the recorded offset
   4. else -> return nullptr   (pointer form) / throw bad_cast (ref form)
```

The crucial fact: **step 2 is a tree/graph traversal, not a constant-time
operation.** Its cost grows with the depth and complexity of the inheritance
hierarchy (and is worse with virtual/multiple inheritance, where pointer offsets
must be adjusted). There is *no* O(1) "is-a" table mandated by the standard;
real implementations do a structured walk of the base-class metadata.

> **Mental model:** `static_cast` is "the compiler already knows the answer."
> `dynamic_cast` is "ask the running program to *prove* the relationship by
> walking the type graph." One is free; the other is a function call plus a
> search.

## Cost: `static_cast` vs `dynamic_cast` in the asm

```cpp
LimitOrder* via_static (Order* o) { return static_cast<LimitOrder*>(o); }
LimitOrder* via_dynamic(Order* o) { return dynamic_cast<LimitOrder*>(o); }
```

```x86asm
; static_cast: single-inheritance downcast is a pointer copy. FREE.
via_static:
        mov     rax, rdi          ; just returns the pointer, no check
        ret

; dynamic_cast: a real call into the runtime, which walks the type graph.
via_dynamic:
        ...
        ; sets up &Order type_info, &LimitOrder type_info, hint
        call    __dynamic_cast    ; <-- runtime traversal; may return 0
        ret
```

`static_cast` reduces to a (possibly offset-adjusting) `mov`. `dynamic_cast`
becomes a `call` to `__dynamic_cast` whose body searches the hierarchy. On a hot
path that difference — a register move versus an indirect call plus a
data-dependent search — is the whole story.

## `-fno-rtti`

You can compile with **`-fno-rtti`** to strip RTTI entirely. This:

- removes the `type_info` objects and class-graph metadata (smaller binary), and
- makes `dynamic_cast` (and `typeid` on polymorphic types) **a compile error**.

HFT and embedded builds often use `-fno-rtti` to *guarantee* no one sneaks a
runtime cast onto the hot path, and to shrink the binary. If you `-fno-rtti`,
you commit to virtual dispatch / tags / `std::variant` for all runtime type
selection.

## Cross-casting and `dynamic_cast<void*>`

Two abilities unique to `dynamic_cast`:

```cpp
struct A { virtual ~A() = default; };
struct B { virtual ~B() = default; };
struct C : A, B {};                   // multiple inheritance

A* a = new C;
// CROSS-CAST: A* -> B* across a sibling base of the same complete object.
B* b = dynamic_cast<B*>(a);           // works; static_cast CANNOT do this
```

`static_cast` can only move along a single known path; `dynamic_cast` can pivot
across the most-derived object to a *sibling* base because it locates the
complete object first via the vptr, then re-navigates. It also adjusts the
pointer by the right offset (sub-objects of a multiply-inherited class live at
different addresses).

```cpp
// dynamic_cast<void*> yields the address of the MOST-DERIVED object.
A* a = new C;
void* whole = dynamic_cast<void*>(a); // points at the C, not the A sub-object
```

`dynamic_cast<void*>` is the canonical way to recover the start address of the
complete object from a base pointer — useful for identity comparisons across
multiple inheritance.

## When a downcast is a design smell

A `dynamic_cast` in the middle of business logic usually means the type *knew
something the base interface didn't expose*. The cleaner designs:

```cpp
// SMELL: caller switches on concrete type.
if (auto* lo = dynamic_cast<LimitOrder*>(o)) lo->reprice();
else if (auto* mo = dynamic_cast<MarketOrder*>(o)) mo->convert();

// FIX 1: virtual dispatch — let the object decide.
struct Order { virtual void on_reject() = 0; virtual ~Order() = default; };
o->on_reject();                                 // one indirect call, no search

// FIX 2: the Visitor pattern for "double dispatch" over a closed set.
// FIX 3: std::variant<LimitOrder, MarketOrder> + std::visit (no inheritance,
//        no heap, no RTTI) — see the RTTI/variant lesson.
```

Repeated `dynamic_cast`/type-switching is the textbook signal to refactor toward
a virtual method, a visitor, or a `variant`. (`dynamic_cast` is legitimately the
right tool for genuine "is this *also* a `Serializable`?" capability queries
across an open hierarchy — but that's rare on a hot path.)

## Quant/HFT relevance & interview gotchas

- **`dynamic_cast` is NOT constant time.** The most common wrong answer is "it's
  a vtable lookup, so O(1)." It's a *runtime traversal of the base-class graph*
  whose cost scales with hierarchy depth/complexity — and it's an out-of-line
  call into `__dynamic_cast`. Keep it off the tick-to-trade path.
- **Pointer form → `nullptr`; reference form → `std::bad_cast`.** The reference
  form throwing pulls in the exception path — doubly bad on the hot path.
- **It requires a polymorphic source** (≥1 virtual function). On a non-polymorphic
  type it won't compile.
- **`-fno-rtti`** strips it (and `typeid`). Many trading builds do this on
  purpose to forbid runtime casts and shrink the binary; know the consequence.
- **Prefer the alternatives on the hot path:** virtual dispatch (one indirect
  call), `std::variant` + `std::visit` (jump-table dispatch, no heap, no RTTI),
  or an explicit integer/enum type tag. Reserve `dynamic_cast` for cold,
  open-hierarchy capability queries.
- **`static_cast`-downcast is free but unchecked** — if you `static_cast` a base
  pointer to the wrong derived type, it's silent UB. `dynamic_cast` trades cost
  for safety; pick deliberately.
- **Cross-casting and `dynamic_cast<void*>`** are things `static_cast` cannot do;
  be ready to explain why (it locates the complete object via the vptr first).

## Key takeaways

1. `dynamic_cast` is the only cast that runs **at runtime**, performing a
   *checked* down-cast or cross-cast within a **polymorphic** hierarchy.
2. It **requires a polymorphic source type** (≥1 virtual function) because it
   reads the `type_info` reachable through the **vtable**.
3. **Pointer form returns `nullptr`** on failure; **reference form throws
   `std::bad_cast`** (no null reference exists).
4. Under the hood it calls **`__dynamic_cast`**, which **walks the base-class
   graph** — *not* a constant-time operation; cost grows with hierarchy
   complexity.
5. **`static_cast` is free** (compile-time, a pointer adjust); `dynamic_cast` is
   a runtime call plus a search. `-fno-rtti` removes RTTI and forbids both
   `dynamic_cast` and `typeid` on polymorphic types.
6. Frequent downcasting is a **design smell** — prefer virtual dispatch, the
   visitor pattern, or `std::variant`/`std::visit`, especially on the hot path.

## Self-check

1. Why does `dynamic_cast<Derived*>(base)` fail to compile if `Base` has no
   virtual functions?
2. What does the pointer form return on failure, and what does the reference
   form do instead? Which is worse on a hot path and why?
3. Is `dynamic_cast` O(1)? Justify your answer in terms of what
   `__dynamic_cast` actually does.
4. What can `dynamic_cast` do that `static_cast` cannot, and how does it manage
   it for multiple inheritance?
5. What does `-fno-rtti` change about `dynamic_cast` and `typeid`, and why might
   a trading firm enable it?
6. You see five `dynamic_cast`s switching on order type in a message loop. Name
   three refactors and the cost profile of each.

## Further reading

- [`dynamic_cast` — cppreference](https://en.cppreference.com/w/cpp/language/dynamic_cast)
- [`static_cast` — cppreference](https://en.cppreference.com/w/cpp/language/static_cast) (the free alternative for known-safe casts).
- [Itanium C++ ABI — RTTI Layout & `__dynamic_cast`](https://itanium-cxx-abi.github.io/cxx-abi/abi.html#rtti) — where `type_info` lives in the vtable and how the cast traverses bases.
- [`std::bad_cast` — cppreference](https://en.cppreference.com/w/cpp/types/bad_cast) and [`typeid` / RTTI — cppreference](https://en.cppreference.com/w/cpp/language/typeid).
- [C++ Core Guidelines — C.146: Use `dynamic_cast` where class hierarchy navigation is unavoidable](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#Rh-dynamic_cast).
- Scott Meyers, *More Effective C++*, Item 2 (prefer C++-style casts) — on choosing among the four casts.
- [`std::variant` — cppreference](https://en.cppreference.com/w/cpp/utility/variant) — the closed-set alternative to a downcast hierarchy.

## Videos

- Arthur O'Dwyer (CppCon) — **"The Surprising Costs of `dynamic_cast` (and how to avoid them)"** / RTTI talks ([search](https://www.youtube.com/results?search_query=CppCon+dynamic_cast+RTTI+cost)).
- Klaus Iglberger (CppCon) — **"Back to Basics: Inheritance, Polymorphism, and Virtual Functions"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Inheritance+Polymorphism+Virtual+Functions+Iglberger)) — when virtual dispatch replaces downcasting.
