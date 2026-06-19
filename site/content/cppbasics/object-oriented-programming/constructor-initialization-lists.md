# Constructor Initialization Lists

> **Why a quant dev must own this:** Constructors run on every object you build,
> and in a latency-sensitive system you build a lot of them — order books,
> message structs, fixed-capacity buffers. The member initializer list is the
> difference between *constructing a member once* and *default-constructing it
> then throwing that away to assign over it*. It's also the *only* way to give a
> `const` or reference member a value, and the source of a classic, compiler-
> warned bug: members initialize in **declaration order**, not the order you
> wrote them in the list.

## First principles: initialization is not assignment

When a constructor body `{ ... }` begins to execute, **every data member is
already constructed.** A member that isn't named in the initializer list was
either default-constructed (for class types) or left uninitialized (for trivial
types like `int`). So when you write `x_ = value;` inside the body, you are not
*initializing* `x_` — you are *assigning over* an object that already exists.

The **member initializer list** is the colon-introduced clause that runs
*before* the body and constructs each member directly with the value you give:

```cpp
class Order {
public:
    Order(int id, double px)
        : id_(id), price_(px)   // <-- member initializer list: direct init
    { /* body: all members already constructed */ }
private:
    int    id_;
    double price_;
};
```

## Why the list beats assignment-in-the-body

For trivial members (`int`, `double`, pointers) the two forms generate identical
code, so the distinction is style. For **class-type** members it is a real cost:
assignment-in-body means *construct, then assign*, doing the work twice.

```cpp
class WithList {
    std::string name_;
public:
    WithList(const std::string& n) : name_(n) {}   // one copy-construct
};

class WithAssign {
    std::string name_;
public:
    WithAssign(const std::string& n) {             // name_ first DEFAULT-constructs
        name_ = n;                                  // then COPY-ASSIGNS over it
    }
};
```

`WithAssign` runs `std::string`'s default constructor, then its copy-assignment
operator (which may free the just-allocated empty buffer and allocate again).
`WithList` runs a single copy constructor. For a `std::string`, a
`std::vector`, or any type that owns a heap allocation, that's a wasted
allocate/free pair per object — exactly the kind of overhead that adds up in a
hot constructor.

The compiler "sees" the difference clearly. With the list, the member's
constructor is the only thing emitted; with body-assign, a default constructor
*and* an assignment both appear:

```x86asm
; WithList(const std::string&): one call
        call    std::string::string(const std::string&)   ; copy-construct name_
        ret
; WithAssign(const std::string&): two calls
        call    std::string::string()                     ; default-construct name_
        call    std::string::operator=(const std::string&); then assign over it
        ret
```

[Effective C++, Item 4](https://en.cppreference.com/w/cpp/language/initializer_list)
states the rule plainly: prefer the member initializer list to assignment in the
body. (Core Guidelines [C.49](https://isocpp.org/wiki/guidelines/#Rc-initialize):
"prefer initialization to assignment in constructors.")

## The classic bug: initialization order is *declaration* order

Members are always initialized in the order they are **declared in the class**,
never the order they appear in the initializer list. If your list order
disagrees with declaration order and one member's initializer reads another, you
get use-before-init — silent garbage.

```cpp
class View {
    int  size_;       // declared FIRST  -> initialized FIRST
    int* data_;       // declared SECOND -> initialized SECOND
public:
    // BUG: looks fine, reads top-to-bottom, but...
    View(int* d, int n)
        : data_(d),                 // written first in the list
          size_(compute(d, n))      // written second
    {}
    // If compute() depended on data_ that's fine here, but consider:
    // : size_(n), data_(d + size_)  // data_ uses size_ -- OK only because
    //                               // size_ is declared first. Reorder the
    //                               // *declarations* and data_ reads garbage.
};
```

The danger case is when a member's initializer *depends on another member* and
the declaration order doesn't match your mental model:

```cpp
class Span {
    int* end_;        // declared first
    int* begin_;      // declared second
public:
    Span(int* b, int n)
        : begin_(b),                 // YOU think this runs first...
          end_(begin_ + n)           // ...so end_ uses a valid begin_.
    {}                               // WRONG: end_ is declared first, so it
                                     // runs first and reads an UNINITIALIZED
                                     // begin_. -> garbage pointer.
};
```

Both GCC (`-Wreorder`) and Clang warn when list order diverges from declaration
order — **do not silence that warning, fix the order.** The robust habit: write
the initializer list in the *same order as the declarations*, and avoid
inter-member dependencies in initializers when you can.

## `const` and reference members: the list is mandatory

A `const` member or a reference member must be given its value at the moment of
initialization — you cannot assign to either afterwards. So they *must* appear in
the initializer list (or have a default member initializer); a body assignment
won't even compile.

```cpp
class Quote {
    const int        symbol_id_;   // const: set once
    const OrderBook& book_;        // reference: must bind at init
public:
    Quote(int sym, const OrderBook& b)
        : symbol_id_(sym), book_(b) {}   // ONLY way to set these
    // Quote(...) { symbol_id_ = sym; }  // ERROR: assignment to const / unbound ref
};
```

This is the single most common reason a beginner is *forced* to learn the
initializer list.

## Default member initializers (C++11)

You can give a member a default value right at its declaration. It applies to
any constructor that doesn't override it in its list — removing duplication
across overloaded constructors.

```cpp
class Config {
    int      depth_   = 10;        // default member initializer (DMI)
    bool     enabled_ = true;
    double   tick_    = 0.01;
public:
    Config() = default;                       // uses all three defaults
    explicit Config(int d) : depth_(d) {}     // overrides depth_, keeps the rest
};
```

If a constructor's initializer list *also* names the member, the list wins for
that constructor; otherwise the DMI is used. DMIs make "all members are always
initialized" the default state, which kills a whole class of uninitialized-read
bugs. (Note: a class with DMIs is no longer an *aggregate* before C++14, and
adding a user-declared constructor changes aggregate-ness regardless.)

## Delegating constructors (C++11)

One constructor can call another of the *same class* in its initializer list,
centralising the real work in one place. The delegated-to constructor runs
fully (members initialized, body executed) before the delegating one's body.

```cpp
class Matrix {
    int rows_, cols_;
    std::vector<double> data_;
public:
    Matrix(int r, int c)
        : rows_(r), cols_(c), data_(r * c, 0.0) {}   // the "real" constructor

    Matrix() : Matrix(0, 0) {}                       // delegates -> no duplication
    explicit Matrix(int n) : Matrix(n, n) {}         // square, delegates
};
```

The one rule: a delegating constructor's list may contain *only* the delegating
call — you can't also initialize members directly in the same list.

## Base-class initialization

When a class derives from a base, the base subobject is initialized first, via
the initializer list. If you don't name the base, its default constructor is
called (a compile error if it has none).

```cpp
class Instrument {
public:
    explicit Instrument(int id) : id_(id) {}
private:
    int id_;
};

class Future : public Instrument {
    double expiry_;
public:
    Future(int id, double exp)
        : Instrument(id),   // base FIRST -- before any member of Future
          expiry_(exp) {}
};
```

The full initialization order is: **base classes (in inheritance order), then
data members (in declaration order), then the constructor body.** This pairs
with the [Inheritance Basics](inheritance-basics.md) lesson, where the symmetric
*destruction* order — reverse of construction — matters just as much.

## Expensive members and `std::move`

When a member is itself an expensive-to-build object, the initializer list lets
you build it directly from the constructor's arguments, and you can `std::move`
into it to steal rather than copy:

```cpp
class Snapshot {
    std::vector<Level> levels_;
public:
    explicit Snapshot(std::vector<Level> v)   // take by value...
        : levels_(std::move(v)) {}            // ...then move into the member
};
```

Taking the argument by value and moving is the idiomatic "sink" pattern: a
caller passing an rvalue gets one move total; a caller passing an lvalue gets
one copy then a move. No version constructs the member twice — which is exactly
what body-assignment would have done.

## Quant/HFT relevance & interview gotchas

- **Initializer list = construct once.** In a hot constructor, body-assignment
  of a heap-owning member (`std::string`, `std::vector`) costs an extra
  allocate/free per object. Always use the list for class-type members.
- **`-Wreorder` is your friend.** The declaration-order rule is *the* classic
  C++ interview trap. Expect "what does this print?" with a deliberately
  misordered list where one member reads another. Answer: garbage, because init
  order is declaration order.
- **`const`/reference members force the list** — and `const` members also
  suppress the implicitly-generated copy *assignment* operator, which surprises
  people who then can't put the type in a `std::vector` and reassign it.
- **DMIs make "always initialized" the default** — cheap insurance against the
  uninitialized-read bugs that cause non-deterministic latency and Heisenbugs.
- **Delegating constructors centralise invariants** so you validate input in one
  place — important when every constructor must uphold the same book/order
  invariant.
- **Don't make initializers depend on each other.** Even when correct, it's
  fragile: a future reorder of the *declarations* breaks it silently.

## Key takeaways

1. The member initializer list **initializes**; body statements **assign over**
   already-constructed members. For class-type members that's construct-twice
   waste — prefer the list.
2. Members initialize in **declaration order**, *not* list order. Match the two,
   and never silence `-Wreorder`.
3. `const` and **reference** members *must* be set in the initializer list (or
   via a default member initializer) — assignment won't compile.
4. **Default member initializers** (C++11) give members a value at declaration,
   used unless a constructor overrides them; they make "always initialized" the
   default.
5. **Delegating constructors** (C++11) let one constructor call another of the
   same class to avoid duplication; the list then holds *only* that call.
6. Initialization order overall is **bases, then members (declaration order),
   then body**; destruction is the exact reverse.

## Self-check

1. For a `std::string` member, what extra work does `name_ = n;` in the body do
   compared to `: name_(n)` in the list?
2. Given `int* end_;` declared before `int* begin_;`, why does
   `: begin_(b), end_(begin_ + n)` produce a garbage `end_`?
3. Which member kinds *cannot* be initialized in the constructor body at all, and
   why?
4. What is printed/ordered when base classes and members both appear — what runs
   first?
5. A delegating constructor's initializer list contains the delegated call *and*
   a member initializer. Why won't it compile?
6. When does a default member initializer get ignored?

## Further reading

- [Constructors and member initializer lists — cppreference](https://en.cppreference.com/w/cpp/language/constructor)
- [Member initialization & default member initializers — cppreference](https://en.cppreference.com/w/cpp/language/data_members#Member_initialization)
- [Delegating constructors — cppreference](https://en.cppreference.com/w/cpp/language/constructor#Delegating_constructor)
- [C++ Core Guidelines — C.47: define and initialize members in declaration order](https://isocpp.org/wiki/guidelines/#Rc-order) and [C.49: prefer initialization to assignment in constructors](https://isocpp.org/wiki/guidelines/#Rc-initialize)
- Scott Meyers, *Effective C++*, Item 4 ("Make sure that objects are initialized before they're used") — the canonical treatment of the order rule.
- [Initialization in C++ is bonkers — overview of the many init forms](https://blog.tartanllama.xyz/initialization-is-bonkers/) — useful context on direct vs copy init.

## Videos

- CppCon — **"The Nightmare of Initialization in C++"** (Nicolai Josuttis) ([search](https://www.youtube.com/results?search_query=CppCon+Nicolai+Josuttis+Nightmare+of+Initialization+in+C%2B%2B)) — the definitive tour of every initialization form and its traps.
- CppCon — **"Back to Basics: Special Member Functions"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Special+Member+Functions)) — constructors and initialization in the broader special-members picture.
