# Classes and Structs

> **Why a quant dev must own this:** In an HFT codebase the *layout* of a type
> is performance. A struct that fits in one cache line is read in one fetch; the
> same fields in the wrong order silently grow the type, blow past the 64-byte
> line, and add a cache miss to your hot path. The same layout rules also decide
> whether you can `memcpy` a message onto the wire or `mmap` a tick file. "What's
> `sizeof` this struct and why?" is a staple HFT interview question — the answer
> is entirely mechanical once you know the rules.

## First principles: a class is a recipe for laying out bytes

A `class` (or `struct` — see below) is a user-defined type: a blueprint that
says *which sub-objects live next to each other in memory* and *what operations
are allowed on them*. An **object** is one concrete instance of that blueprint —
a contiguous region of storage. Everything else (access control, methods,
encapsulation) is compile-time bookkeeping layered on top of that region of
bytes. Member functions are not stored *in* the object; they are ordinary
functions that receive the object's address as a hidden argument.

## `class` vs `struct`: one difference, and it's tiny

In C++ a `struct` and a `class` are the *same language feature*. The **only**
differences are defaults:

| | `struct` | `class` |
|---|---|---|
| Default member access | `public` | `private` |
| Default inheritance | `public` | `private` |

That's it. A `struct` can have methods, constructors, `private` members,
inheritance, templates — anything a `class` can. The choice is pure convention:

```cpp
struct Point { double x, y; };         // public by default — a passive aggregate

class Account {                        // private by default — an encapsulated type
    double balance_;                   // private: only the class touches it
public:
    void deposit(double amt) { balance_ += amt; }
    double balance() const { return balance_; }
};
```

The convention most teams (and the [Core Guidelines, C.2](https://isocpp.org/wiki/guidelines/#Rc-struct))
follow: use `struct` when it's a passive bundle of public data with no
invariant; use `class` when there's an invariant the type must protect.

## Access control: public, private, protected

Access specifiers govern *who may name a member*. They are a compile-time wall,
not a runtime one — they cost nothing and change nothing about layout.

- **`public`** — anyone may access. The type's interface.
- **`private`** — only the class's own members and its `friend`s. The
  implementation.
- **`protected`** — like `private`, but also accessible to *derived* classes.
  Use sparingly; it weakens encapsulation (a subclass can break your invariant).

```cpp
class Order {
public:
    void cancel();                 // interface
protected:
    void on_state_change();        // hook for subclasses
private:
    int  id_;                      // invariant: must never change after submit
    bool live_ = true;
};
```

Encapsulation is the discipline of keeping data `private` and exposing only the
operations that preserve the type's invariant. The compiler can't enforce *good*
invariants, but `private` stops outside code from reaching in and breaking them.

## The `this` pointer

Every non-static member function receives a hidden first parameter: a pointer to
the object it was called on, named `this`. Inside `Account::deposit`,
`balance_ += amt;` is shorthand for `this->balance_ += amt;`. Its type is
`Account*` (or `const Account*` in a `const` member function — which is how
`const` correctness is enforced).

```cpp
class Builder {
public:
    Builder& with_id(int id)  { id_ = id;  return *this; }   // return self by ref
    Builder& with_qty(int q)  { qty_ = q;  return *this; }   // enables chaining
private:
    int id_ = 0, qty_ = 0;
};
// Builder{}.with_id(7).with_qty(100);   // fluent interface via *this
```

`this` is the mechanism by which a member function knows *which* bytes to
operate on. There is no magic: a method call compiles to a normal call with the
address in a register (e.g. `rdi` in the System V x86-64 ABI).

## Memory layout: the rules that decide `sizeof`

Members are laid out **in declaration order**, at increasing addresses. Between
and after them the compiler inserts **padding** so that every member lands on an
address that is a multiple of its **alignment** (`alignof(T)`). The struct's own
alignment is the largest alignment of any member, and `sizeof` is rounded up to
a multiple of that alignment so arrays stay aligned.

Consider this struct on a typical x86-64 ABI (`char`=1, `int`=4, `double`=8):

```cpp
struct Bad {
    char   a;     // offset 0
    double b;     // needs 8-alignment -> 7 bytes padding before it
    int    c;     // offset 16
    char   d;     // offset 20
};                // 3 bytes tail padding -> sizeof == 24
```

```text
offset:  0      1                 8                 16        20        24
        +----+------------------+-----------------+---------+----+---------+
        | a  |  ~~ 7 pad ~~      |       b (8)     |  c (4)  | d  | ~3 pad~ |
        +----+------------------+-----------------+---------+----+---------+
        \__1_/\_______7_________/\________8________/\___4___/\_1_/\___3___/
                                                            sizeof(Bad) == 24
```

Now **reorder the fields largest-to-smallest** — same members, no padding holes:

```cpp
struct Good {
    double b;     // offset 0
    int    c;     // offset 8
    char   a;     // offset 12
    char   d;     // offset 13
};                // 2 bytes tail padding -> sizeof == 16
```

```text
offset:  0                 8         12   13   14        16
        +-----------------+---------+----+----+---------+
        |       b (8)     |  c (4)  | a  | d  | ~2 pad~ |
        +-----------------+---------+----+----+---------+
                                              sizeof(Good) == 16
```

**Same data, 24 bytes vs 16 bytes**, purely from declaration order. The rule of
thumb: declare members in *descending alignment* (8-byte, then 4, then 2, then
1) to minimise padding. This isn't micro-optimisation theatre — at scale it
decides how many objects fit in a cache line and in L1.

### Struct packing — and why you usually shouldn't

You can force the compiler to drop all padding:

```cpp
#pragma pack(push, 1)
struct Wire { char a; double b; int c; };   // sizeof == 13, no padding
#pragma pack(pop)
// GCC/Clang spelling: struct __attribute__((packed)) Wire { ... };
```

Packed structs are essential for describing a byte-exact **wire format**, but
they create *misaligned* members. On x86 a misaligned access is merely slower;
on some ARM/SIMD paths it traps. Best practice (and consistent with the
[Byte Order and Endianness](../../csfundamentals/cpu-architecture-basics/byte-order-and-endianness.md)
lesson): don't `reinterpret_cast` a packed struct over a buffer — deserialize
field by field. Reserve packing for storage description, not your in-memory
working types.

## `sizeof`, the empty class, and standard-layout

- **`sizeof(T)`** is the byte count of one object, *including padding*. It's a
  compile-time constant.
- **An empty class has `sizeof == 1`**, not 0. The standard requires every
  *most-derived* object to have a unique address; a zero-size object couldn't be
  distinguished from its neighbour in an array. (As a base class, an empty type
  can occupy zero bytes — the **Empty Base Optimization**, and in C++20
  `[[no_unique_address]]` extends this to members.)

```cpp
struct Empty {};
static_assert(sizeof(Empty) == 1);
```

- **Standard-layout** is a formal property (no virtual functions, no mixed
  access control in the data members, single source of non-static data, etc.).
  A standard-layout type has a predictable, C-compatible layout: you may
  `offsetof` its members and `memcpy` it to a C peer. `Point` above is
  standard-layout; a class with a `virtual` function is not (it gains a hidden
  vtable pointer). Check with `std::is_standard_layout_v<T>`.

## Static members: shared by all objects

A `static` data member belongs to the *class*, not to any object — there is
exactly one, and it does **not** contribute to `sizeof`. A `static` member
function has no `this` and can be called without an instance.

```cpp
class Order {
public:
    static int live_count() { return live_; }   // no 'this'
    Order()  { ++live_; }
    ~Order() { --live_; }
private:
    static inline int live_ = 0;   // C++17: define + init inline, in the header
    int id_;                       // per-object; counts toward sizeof
};
```

Before C++17 a `static` member needed a separate out-of-line definition in one
`.cpp`; `inline` (C++17) lets you define and initialise it in the header.

## `friend` and nested types

A **`friend`** declaration grants another function or class access to your
`private`/`protected` members. It's a deliberate, named exception to
encapsulation — used most often for symmetric binary operators and streaming
(see the [Operator Overloading](operator-overloading.md) lesson). Friendship is
*not* inherited and *not* transitive.

```cpp
class Price {
    long ticks_;
    friend std::ostream& operator<<(std::ostream&, Price);  // may read ticks_
};
```

A **nested type** is a type declared inside a class; it scopes a helper to its
owner and clarifies intent. It does not affect the enclosing object's layout.

```cpp
class RingBuffer {
public:
    struct Slot { uint64_t seq; char payload[56]; };   // nested, scoped to RingBuffer
};
// RingBuffer::Slot s;
```

## Quant/HFT relevance & interview gotchas

- **Pack the hot struct into a cache line.** A 64-byte line is the unit of
  memory traffic. Order members by descending alignment so the type stays small;
  if it must be exactly one line, verify with `static_assert(sizeof(T) == 64)`
  and consider `alignas(64)` to also pin it to a line boundary (which prevents a
  single object straddling two lines and prevents *false sharing* between
  threads).
- **Wire structs are a separate concern.** Use packed structs (or, better,
  by-value deserialization) for the protocol; use cache-friendly, naturally
  aligned structs for your working set. Don't conflate the two.
- **`struct` vs `class` is not a performance question** — they generate
  identical code. Anyone who claims `struct` is "faster" is confused.
- **Empty class is `sizeof 1`** is a classic warm-up. Know *why* (unique
  addresses) and know the EBO/`[[no_unique_address]]` exception.
- **A `virtual` function changes layout.** It adds a vtable pointer (usually 8
  bytes at the front), destroys standard-layout, and breaks any assumption that
  the struct matches a C or wire layout. Know this before you add `virtual` to a
  type you `memcpy`.
- **`#pragma pack` is not portable** in spelling and creates misaligned
  accesses; expect to discuss the trade-off.

## Key takeaways

1. `struct` and `class` differ *only* in default access (and default
   inheritance) — `public` vs `private`. Everything else is identical.
2. Members lay out in **declaration order**; the compiler inserts **padding** to
   satisfy each member's **alignment**, and `sizeof` rounds up to the type's
   alignment.
3. **Reordering fields largest-to-smallest minimises padding** and can
   meaningfully shrink the type — the `Bad` (24) vs `Good` (16) example.
4. An **empty class is `sizeof 1`** so distinct objects get distinct addresses;
   the Empty Base Optimization / `[[no_unique_address]]` recover the zero.
5. `static` members are per-class (not in `sizeof`); `this` is the hidden
   object-address argument to non-static methods; `friend` is a named breach of
   encapsulation.
6. **Standard-layout** types are C-compatible and `memcpy`-safe; a `virtual`
   function adds a vtable pointer and forfeits that.

## Self-check

1. What is `sizeof` a struct containing, in order, `char; int; char; double`?
   Now reorder to minimise it — what's the new `sizeof`?
2. Why is `sizeof(EmptyClass) == 1` rather than `0`? When *can* an empty type
   occupy zero bytes?
3. A teammate says "use `struct` for speed, `class` for safety." What's wrong
   with that statement?
4. You add one `virtual` method to a previously standard-layout 16-byte struct.
   What happens to `sizeof` and to `std::is_standard_layout_v`, and why?
5. Why does a `static` data member not contribute to `sizeof`? Where does its
   storage live?
6. Why is describing a wire protocol with a normal (unpacked) struct dangerous,
   and what are the two ways to do it correctly?

## Further reading

- [Classes — cppreference](https://en.cppreference.com/w/cpp/language/classes) and [`class`/`struct` keywords](https://en.cppreference.com/w/cpp/language/class)
- [Object layout & data member alignment — cppreference](https://en.cppreference.com/w/cpp/language/object) / [`alignof`](https://en.cppreference.com/w/cpp/language/alignof) / [`alignas`](https://en.cppreference.com/w/cpp/language/alignas)
- [Standard-layout types — cppreference](https://en.cppreference.com/w/cpp/named_req/StandardLayoutType) and [`std::is_standard_layout`](https://en.cppreference.com/w/cpp/types/is_standard_layout)
- [C++ Core Guidelines — C.2: use `class` if the type has an invariant; `struct` if data members can vary independently](https://isocpp.org/wiki/guidelines/#Rc-struct)
- [`[[no_unique_address]]` — cppreference](https://en.cppreference.com/w/cpp/language/attributes/no_unique_address) (C++20 EBO for members)
- Eric S. Raymond, [**The Lost Art of Structure Packing**](http://www.catb.org/esr/structure-packing/) — the definitive walkthrough of padding and reordering.
- Scott Meyers, *Effective C++*, Item 22 (declare data members `private`).

## Videos

- CppCon — **"Type Punning, Type Erasure, Type Confusion"** and layout talks; for layout/packing specifically, search **"CppCon data layout cache friendly struct"** ([search](https://www.youtube.com/results?search_query=CppCon+data+layout+cache+friendly+struct)).
- CppCon — Scott Meyers, **"CPU Caches and Why You Care"** ([search](https://www.youtube.com/results?search_query=Scott+Meyers+CPU+Caches+and+Why+You+Care)) — why struct size and order map directly to cache behaviour.
