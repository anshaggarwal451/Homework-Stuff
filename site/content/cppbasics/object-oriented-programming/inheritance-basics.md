# Inheritance Basics

> **Why a quant dev must own this:** Inheritance is how you model "a `MarketOrder`
> *is an* `Order`" and how a base interface lets a strategy treat many concrete
> handlers uniformly. But it is also a minefield of silent bugs that cost real
> money: **object slicing** quietly drops a derived object's data when you pass
> by value, and a missing `virtual` destructor leaks or corrupts when you delete
> through a base pointer. These two are perennial HFT interview questions because
> they're easy to write and impossible to see at the call site.

## First principles: a derived object *contains* its base

Inheritance physically embeds the base class as a **subobject** at the front of
the derived object. A `Derived` is literally a `Base`'s bytes followed by
`Derived`'s own members. That layout is *why* a `Derived*` converts to a `Base*`
for free (the base subobject is right there at offset 0 in the simple
single-inheritance case) and why a `Base` reference can name the front of a
`Derived`.

```cpp
struct Base    { int a; int b; };
struct Derived : Base { int c; };   // Derived = {a, b} then {c}
```

```text
Derived object:
offset:  0        4        8        12
        +--------+--------+--------+
        |   a    |   b    |   c    |
        +--------+--------+--------+
        \____ Base subobject ____/ \_own_/
        ^
        a Base* points here (same address as the Derived* in this simple case)
```

## The three inheritance modes — and what they *mean*

The access specifier on the base (`public`/`protected`/`private`) controls two
things: how the base's members are seen *through the derived class*, and whether
outside code may treat a `Derived` *as a* `Base`.

| Inheritance | Public members of Base become | Relationship | Conversion `Derived*`→`Base*`? |
|---|---|---|---|
| `public` | public | **is-a** | yes, for everyone |
| `protected` | protected | implemented-in-terms-of | only inside Derived & its children |
| `private` | private | implemented-in-terms-of | only inside Derived |

```cpp
class Order { /* ... */ };

class LimitOrder : public Order { /* IS-A Order: usable anywhere an Order is */ };

class Throttler : private std::vector<Event> {
    // "implemented in terms of" a vector -- reuses it, but is NOT a vector
    // to the outside world. Composition is usually clearer for this.
};
```

- **`public` = is-a.** This is real subtyping: a `LimitOrder` can be used
  wherever an `Order` is expected. 95% of the inheritance you should write.
- **`private`/`protected` = implemented-in-terms-of.** You're reusing the base's
  implementation, not its interface. Almost always, **composition** (hold the
  thing as a member) expresses this more clearly — see below.

## Upcasting and the base-pointer interface

Because the base subobject is embedded, a derived object can be referred to
through a base pointer or reference at no cost. This *upcast* is implicit and
safe:

```cpp
void process(Order& o);          // works on any Order or subtype
LimitOrder lo{/*...*/};
process(lo);                     // implicit upcast: LimitOrder& -> Order&
Order* p = &lo;                  // implicit upcast: LimitOrder* -> Order*
```

This is the foundation of runtime polymorphism: a container of `Order*` (or
`std::unique_ptr<Order>`) can hold many concrete order types. *Dispatching* the
right behaviour through that base pointer requires `virtual` functions — covered
in the virtual-functions lesson of the polymorphism track; here we note only
that a polymorphic class carries a hidden **vtable pointer** (typically 8 bytes
at offset 0), which is why such a type is no longer standard-layout.

## Construction and destruction order

A derived object is built **base-first**: the base subobject's constructor runs,
then the derived members (in declaration order), then the derived constructor
body. This guarantees that when your derived constructor runs, the base part is
already a valid object you can use. **Destruction is the exact reverse**: derived
body, derived members (reverse declaration order), then the base destructor.

```cpp
struct B { B(){ std::puts("B()"); } ~B(){ std::puts("~B()"); } };
struct D : B { D(){ std::puts("D()"); } ~D(){ std::puts("~D()"); } };
// Constructing then destroying a D prints:
//   B()
//   D()
//   ~D()
//   ~B()
```

The base is initialized via the derived's [initializer list](constructor-initialization-lists.md)
(`D(int x) : B(x), ... {}`); omit it and the base's default constructor is used.

## Accessing base members; `protected`

Derived code can use any `public` or `protected` member of the base directly,
and can call a base version explicitly with the `Base::` qualifier (useful when
overriding):

```cpp
class Logged : public Order {
public:
    void cancel() {
        log("cancelling");
        Order::cancel();        // call the base version explicitly
    }
};
```

`protected` members are visible to derived classes but not to outside code.
They're a controlled crack in encapsulation: convenient for a class hierarchy,
but a derived class *can* violate the base's invariant through them, so prefer
`private` data with `protected` *functions* when you need a customisation hook.

## Name hiding — a surprise that bites

If a derived class declares *any* member with a name, it **hides every base
member of that same name**, regardless of signature. Overloads in the base
become invisible — this is *not* overriding, it's hiding.

```cpp
struct Base {
    void f(int);
    void f(double);
};
struct Derived : Base {
    void f(const char*);     // hides BOTH Base::f(int) and Base::f(double)!
};

Derived d;
d.f(42);                     // ERROR: Base::f(int) is hidden; no f(int) in scope
d.f("x");                    // OK
d.Base::f(42);               // OK with explicit qualification
// or, in Derived:  using Base::f;   // un-hides the base overloads
```

The fix is `using Base::f;` in the derived class to pull the base overloads back
into scope. Compilers can warn (`-Woverloaded-virtual` for the virtual case);
the general lexical-hiding case is easy to miss.

## Object slicing — the silent data loss

If you copy a `Derived` into a `Base` *by value*, only the base subobject is
copied. The derived members — and, for polymorphic types, the dynamic type
itself — are **sliced off**. The result is a genuine `Base`, not a maimed
`Derived`.

```cpp
struct Order      { double price = 0; };
struct IcebergOrder : Order { double hidden_qty = 0; };

void store(Order o);                 // BY VALUE -- the slicer

IcebergOrder ice{/*price*/100.0, /*hidden_qty*/500.0};
store(ice);                          // hidden_qty is SILENTLY DROPPED

std::vector<Order> book;
book.push_back(ice);                 // slices: book holds a plain Order, hidden_qty gone

Order o = ice;                       // slices on assignment too
```

Nothing warns you — the code compiles and "works", it just loses data (and any
overridden behaviour). The cure is to **pass and store polymorphic types by
reference or pointer**, never by value: `void store(const Order&)`, and a
container of `std::unique_ptr<Order>` rather than `std::vector<Order>`. To make
slicing impossible, you can `=delete` the base copy operations or make the base
abstract.

## The non-virtual destructor pitfall

If you `delete` a derived object through a base pointer and the base destructor
is **not** `virtual`, the behaviour is undefined — in practice the derived
destructor never runs, leaking whatever it owned:

```cpp
struct Base    { ~Base() {} };                 // NON-virtual destructor -- danger
struct Derived : Base { std::vector<int> big; };

Base* p = new Derived;
delete p;     // UB: ~Derived() NOT called -> 'big' leaks
```

The rule: **if a class is meant to be deleted polymorphically (through a base
pointer), give it a `virtual` destructor.** (If it's never deleted that way, a
non-virtual destructor is fine and cheaper.) The full treatment of why this
needs the vtable lives in the virtual-functions lesson; for now, memorise the
rule — it's one of the most-asked C++ interview questions.

## Composition vs inheritance

Reach for **composition** (a class *has-a* member) by default; use `public`
inheritance only for genuine is-a relationships you need polymorphically.
Composition gives you the same code reuse without coupling your interface to the
base, without slicing risk, and without the fragile-base-class problem.

```cpp
// Inheritance (private) -- "implemented in terms of": fragile, exposes base quirks
class StackBad : private std::vector<int> { /* ... */ };

// Composition -- clearer, decoupled, no surprises
class Stack {
    std::vector<int> data_;          // HAS-A vector
public:
    void push(int x) { data_.push_back(x); }
    int  pop()       { int v = data_.back(); data_.pop_back(); return v; }
};
```

The Core Guidelines are explicit: [prefer composition over inheritance unless
there is a real is-a relationship](https://isocpp.org/wiki/guidelines/#Rh-domain).

## Quant/HFT relevance & interview gotchas

- **Slicing is the silent killer.** Storing strategies/orders in a
  `std::vector<Base>` slices every derived object on insertion — data and
  behaviour gone, no warning. Use `std::vector<std::unique_ptr<Base>>` (or a
  variant) and pass derived types by reference. Expect this exact question.
- **Non-virtual base destructor = leak/UB** when deleting through the base. Know
  the rule cold, and know the exception (no polymorphic deletion → no need).
- **`virtual` costs layout and a load.** A polymorphic base adds an 8-byte
  vtable pointer and turns each virtual call into an indirect load+branch — fine
  on the cold path, something to avoid (CRTP, `std::variant`, function pointers)
  on the hot path. Don't pay for polymorphism you don't dispatch on.
- **Prefer composition.** Interviewers like "when would you use inheritance vs
  composition?" — answer: public inheritance only for is-a + polymorphism;
  composition for everything else, including code reuse.
- **Name hiding** trips people: a derived overload hides *all* same-named base
  overloads. Know `using Base::name;` as the fix.
- **Deep hierarchies are an anti-pattern** in low-latency code; they fragment
  cache layout and obscure ownership. Keep it shallow.

## Key takeaways

1. A derived object **contains** its base as a subobject at the front; that
   embedding is why upcasting `Derived*`→`Base*` is free and implicit.
2. **`public` inheritance = is-a** (real subtyping); `private`/`protected` =
   implemented-in-terms-of, which composition usually expresses better.
3. Construction is **base → members (declaration order) → body**; destruction is
   the exact reverse.
4. **Object slicing**: copying a derived into a base *by value* silently drops
   the derived part. Pass/store polymorphic types by reference or pointer.
5. **A polymorphically-deleted class needs a `virtual` destructor**, or deleting
   through the base pointer is undefined behaviour (leaks).
6. A derived member **hides** all same-named base members (not overrides);
   un-hide with `using Base::name;`. Prefer composition over inheritance.

## Self-check

1. Draw the memory layout of `struct D : B` where `B { long x; }` and
   `D { int y; }`. Where does a `B*` to a `D` point?
2. A function takes `Order` by value and a `vector<Order>` holds them. Why does
   passing an `IcebergOrder` lose `hidden_qty`, and what's the fix?
3. Why is `delete basePtr;` undefined behaviour when `~Base` is non-virtual but
   the object is really a `Derived`? When is a non-virtual destructor fine?
4. `Derived` declares `void f(const char*)` and `Base` has `f(int)`. Why does
   `d.f(42)` fail to compile, and how do you fix it without renaming?
5. Give a one-line rule for choosing `public` inheritance vs composition.
6. In what order do constructors and destructors run across a two-level
   hierarchy?

## Further reading

- [Derived classes & inheritance — cppreference](https://en.cppreference.com/w/cpp/language/derived_class)
- [Object slicing — Wikipedia](https://en.wikipedia.org/wiki/Object_slicing) and [`using`-declaration to un-hide base names — cppreference](https://en.cppreference.com/w/cpp/language/using_declaration)
- [C++ Core Guidelines — C.120/C.121/C.129: inheritance for is-a and interfaces](https://isocpp.org/wiki/guidelines/#Rh-domain) and [C.35: a base class destructor should be either public+virtual or protected+non-virtual](https://isocpp.org/wiki/guidelines/#Rc-dtor-virtual)
- Scott Meyers, *Effective C++*, Item 7 (declare destructors virtual in polymorphic base classes) and Item 33 (avoid hiding inherited names).
- [`std::is_base_of` / `std::derived_from` (C++20) — cppreference](https://en.cppreference.com/w/cpp/types/is_base_of) for compile-time relationship checks.
- Herb Sutter, *GotW* on [virtual destructors and slicing](https://herbsutter.com/gotw/) — the canonical write-ups.

## Videos

- CppCon — **"Back to Basics: Inheritance, Polymorphism, and Virtual Functions"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Inheritance+Polymorphism+Virtual+Functions)) — covers slicing and the virtual-destructor rule directly.
- CppCon — **"Inheritance Is The Base Class of Evil"** (Sean Parent) ([search](https://www.youtube.com/results?search_query=Sean+Parent+Inheritance+Is+The+Base+Class+of+Evil)) — the classic argument for composition / value semantics over inheritance.
