# Advanced Constructors

> **Why a quant dev must own this:** The *special member functions* — copy,
> move, their assignment forms, and the constructors that build them — decide
> whether passing an order book around costs a deep copy or a pointer swap. In a
> hot path that's the difference between an allocation and three register moves.
> Knowing exactly *when the compiler generates, deletes, or suppresses* these
> functions, and using `=delete` to forbid copies or heap allocation, is core
> HFT C++ fluency — and a guaranteed interview topic.

This lesson assumes C++17 unless a feature is tagged otherwise. It builds on the
[Constructor Initialization Lists](constructor-initialization-lists.md) lesson.

## The cast of special members

Every class has six potentially-compiler-generated special members:

| Special member | Signature (for type `T`) |
|---|---|
| Default constructor | `T()` |
| Copy constructor | `T(const T&)` |
| Copy assignment | `T& operator=(const T&)` |
| Move constructor (C++11) | `T(T&&)` |
| Move assignment (C++11) | `T& operator=(T&&)` |
| Destructor | `~T()` |

The compiler will write these for you — *sometimes*. The rules for when are the
crux of this lesson.

## `explicit`: stop silent conversions

A single-argument (or multi-arg, all-but-one defaulted) constructor is a
**converting constructor**: it defines an implicit conversion from the argument
type to your type. That's occasionally convenient and frequently a footgun.
`explicit` disables the implicit form, requiring a direct, visible construction.

```cpp
struct Price {
    long ticks_;
    Price(long t) : ticks_(t) {}           // converting: long -> Price implicitly
};
void send(Price);
send(42);                                  // compiles! 42 silently becomes a Price

struct SafePrice {
    long ticks_;
    explicit SafePrice(long t) : ticks_(t) {}
};
void send2(SafePrice);
// send2(42);                              // ERROR: no implicit long -> SafePrice
send2(SafePrice{42});                      // OK: explicit, intent is visible
```

The guidance ([Core Guidelines C.46](https://isocpp.org/wiki/guidelines/#Rc-explicit)):
**make single-argument constructors `explicit` by default**; drop it only when an
implicit conversion is genuinely desirable (e.g. `std::string` from `const
char*`). For value types like `Price`/`Quantity` it prevents nonsense like
`price + 5` quietly meaning "5 ticks".

## Copy constructor and copy assignment

The **copy constructor** builds a new object from an existing one; **copy
assignment** overwrites an already-built object. If your type owns a resource
(heap memory, a file handle), the compiler-generated *member-wise* copy is wrong
— it duplicates the pointer, not the pointee, leading to double-free.

```cpp
class Buffer {
    int*   data_;
    size_t n_;
public:
    explicit Buffer(size_t n) : data_(new int[n]), n_(n) {}
    ~Buffer() { delete[] data_; }

    Buffer(const Buffer& o)               // copy ctor: deep copy
        : data_(new int[o.n_]), n_(o.n_) {
        std::copy(o.data_, o.data_ + n_, data_);
    }
    Buffer& operator=(const Buffer& o) {  // copy assign: copy-and-swap is cleaner
        Buffer tmp(o);                    // reuse the copy ctor
        std::swap(data_, tmp.data_);
        std::swap(n_,   tmp.n_);
        return *this;                     // tmp's dtor frees the old buffer
    }
};
```

## Move constructor and move assignment (C++11)

A **move** transfers ownership instead of duplicating: it steals the source's
internals and leaves the source in a valid-but-empty state. For a resource-owning
type this turns an O(n) deep copy into an O(1) pointer swap.

```cpp
    Buffer(Buffer&& o) noexcept           // move ctor: steal, don't copy
        : data_(o.data_), n_(o.n_) {
        o.data_ = nullptr;                // leave source destructible
        o.n_    = 0;
    }
    Buffer& operator=(Buffer&& o) noexcept {
        delete[] data_;                   // release our own resource
        data_ = o.data_; n_ = o.n_;
        o.data_ = nullptr; o.n_ = 0;
        return *this;
    }
```

The `Buffer&&` rvalue-reference parameter binds to temporaries and to anything
you've `std::move`'d. A move on a heap-owning type is a few register writes; the
copy is `new[]` + `memcpy` + later `delete[]`.

```x86asm
; move ctor: just copy two words and zero the source -- no allocation
        mov     rax, [rsi]        ; data_  = o.data_
        mov     [rdi], rax
        mov     rcx, [rsi+8]      ; n_     = o.n_
        mov     [rdi+8], rcx
        mov     qword [rsi], 0    ; o.data_ = nullptr
        ; ...contrast with the copy ctor, which calls operator new[] + memcpy
```

### `noexcept` on moves is not optional

`std::vector` (and other containers) will only *move* your elements when
reallocating if your move constructor is `noexcept`; otherwise, to preserve the
strong exception guarantee, it **copies** them instead. A non-`noexcept` move
constructor silently turns every vector growth into deep copies — a classic
hidden performance cliff. Always mark moves `noexcept` (and use
`std::move_if_noexcept` when writing such code yourself).

## When the compiler generates (or deletes) the special members

This table is the heart of the interview question. "Generated" means
implicitly declared and defaulted; "suppressed" means *not* declared (so the
operation falls back to something else or fails); "deleted" means declared but
unusable.

| If you declare… | Default ctor | Copy ctor / assign | Move ctor / assign | Destructor |
|---|---|---|---|---|
| nothing | generated | generated | generated | generated |
| any constructor | **suppressed** | generated | generated | generated |
| copy ctor *or* copy assign | — | (the other still generated, **deprecated**) | **NOT generated** | generated |
| move ctor *or* move assign | — | **deleted** | (the other NOT generated) | generated |
| destructor | — | generated (**deprecated**) | **NOT generated** | — |

The two lines that catch everyone:

- **Declaring a destructor (or any copy op) suppresses the move operations.**
  Your type then *copies* where you expected it to move — a silent perf bug. If
  you write a destructor, decide explicitly about copy/move.
- **Declaring any move operation deletes both copy operations.** A move-only
  type (like `std::unique_ptr`) is exactly this.

This is the mechanical basis for the **Rule of Five** (if you write one of
dtor/copy/move, write or `=default`/`=delete` all five) and the **Rule of
Zero** (design so you own no raw resources, and write *none* of them — let the
members' own special members compose). The full treatment is in the rule-of-five
lesson of the resource-management track; here, internalise the generation table.

## `=default` and `=delete`: take explicit control

`=default` asks for the compiler's version (and keeps it trivial/`noexcept`
where possible). `=delete` removes a function so any use is a compile error.

```cpp
class Engine {
public:
    Engine() = default;                          // I want the default ctor back...
    Engine(int cfg);                             // ...even though I declared this one

    Engine(const Engine&)            = delete;   // forbid copying
    Engine& operator=(const Engine&) = delete;   // (Engine is a unique resource)
    Engine(Engine&&)                 = default;  // but allow moving
    Engine& operator=(Engine&&)      = default;
    ~Engine()                        = default;
};
```

`=default` on a member *out of line* (in the .cpp) is still a defaulted function
but is no longer trivial — keep defaults in the header if triviality matters.

## Conversion operators: `operator T()`

The dual of a converting constructor: a member that converts *your* type *to*
another. Like converting constructors, prefer `explicit` to avoid surprise
conversions (especially `explicit operator bool()` for "is valid" tests, which
still works in `if`/`while` contexts via *contextual conversion*).

```cpp
class Handle {
    int fd_ = -1;
public:
    explicit operator bool() const { return fd_ >= 0; }   // valid?
    // operator int() const { return fd_; }   // AVOID: implicit -> int invites bugs
};
Handle h;
if (h) { /* contextual bool conversion: OK even though explicit */ }
```

## `explicit(bool)` — conditional explicitness (C++20)

C++20 lets `explicit` take a constant boolean, so a wrapper template can be
explicit *only when* its underlying conversion is. `std::pair`/`std::tuple` use
this so they're implicitly constructible exactly when their elements are.

```cpp
template <class T>
struct Wrap {
    template <class U>
    explicit(!std::is_convertible_v<U, T>)    // implicit only if U->T is implicit
    Wrap(U&& u) : value_(std::forward<U>(u)) {}
    T value_;
};
```

## Delegating constructors (recap)

As covered in the [initializer-lists lesson](constructor-initialization-lists.md),
one constructor can delegate to another of the same class to centralise
validation — useful when several constructors must enforce the same invariant:

```cpp
class Order {
    int id_; double px_;
public:
    Order(int id, double px) : id_(validate(id)), px_(px) {}   // the validating ctor
    explicit Order(int id) : Order(id, 0.0) {}                 // delegates
};
```

## Quant/HFT relevance & interview gotchas

- **`noexcept` moves or `std::vector` deep-copies.** This is the single
  highest-leverage rule here: a non-`noexcept` move makes container reallocation
  copy your elements. Mark moves `noexcept` and `static_assert(
  std::is_nothrow_move_constructible_v<T>)` on your hot types.
- **Move to avoid copies in the hot path.** Sink arguments "by value + `std::move`",
  return by value (RVO/NRVO + move), and store move-only resources in
  `std::unique_ptr`. A move on an owning type is register-cheap; the copy isn't.
- **`=delete` to forbid heap allocation / copying.** A type that must live on the
  stack or in a pool can `=delete` `operator new`; a type representing a unique
  resource `=delete`s its copy operations. This makes a misuse a *compile* error,
  not a runtime surprise — exactly the kind of static guarantee HFT teams want.
- **Know the generation table cold.** "If I write a destructor, what happens to
  my move constructor?" → it's **not generated**, so the type silently copies.
  This is the most common special-members interview question.
- **`explicit` value types.** `Price`, `Quantity`, `Tick` should have `explicit`
  single-arg constructors so raw numbers can't silently masquerade as domain
  values.
- **A deleted/suppressed move isn't an error at the declaration** — it surfaces
  only when something tries to move and gets a copy (or a hard error). Verify
  with type traits rather than hoping.

## Key takeaways

1. There are **six special members**; the compiler generates them under precise
   rules. Knowing *when* is the whole game.
2. **Declaring a destructor or any copy operation suppresses the move
   operations** → the type silently copies. Declaring any move operation
   **deletes** both copies.
3. **Move = steal**; for resource-owning types it turns an O(n) deep copy into
   an O(1) pointer transfer. Mark moves **`noexcept`** or containers fall back to
   copying.
4. Use **`=default`** to reclaim a compiler version and **`=delete`** to forbid
   an operation (copying, heap allocation) at compile time.
5. Make single-argument **constructors and conversion operators `explicit`** by
   default; C++20 `explicit(bool)` makes it conditional.
6. **Rule of Zero** first (own no raw resources); when you must own one, follow
   the **Rule of Five** and write/`=default`/`=delete` all five deliberately.

## Self-check

1. You add a `~T()` to a class that previously had none. What happens to its
   move constructor, and what's the runtime consequence?
2. Why does a non-`noexcept` move constructor make `std::vector<T>` slower on
   reallocation?
3. Write the special-member declarations for a move-only resource type that
   forbids copying but allows moving.
4. What's the difference between a constructor being *suppressed*, *deleted*, and
   *not declared*?
5. Why prefer `explicit operator bool()` over `operator int()` for a validity
   check, and how does it still work inside `if`?
6. What does C++20 `explicit(bool)` let `std::pair` express that C++17 couldn't?

## Further reading

- [The rule of three/five/zero — cppreference](https://en.cppreference.com/w/cpp/language/rule_of_three) — the canonical generation summary.
- [Copy constructors](https://en.cppreference.com/w/cpp/language/copy_constructor), [move constructors](https://en.cppreference.com/w/cpp/language/move_constructor), [`explicit`](https://en.cppreference.com/w/cpp/language/explicit), and [converting constructors](https://en.cppreference.com/w/cpp/language/converting_constructor) — cppreference.
- Scott Meyers, *Effective Modern C++*, Items 17 (special member generation), 23–25 (`std::move`/`std::forward`/universal references), 29–30 (when move is and isn't free).
- [C++ Core Guidelines — C.20 (Rule of Zero), C.21 (all-or-none), C.66 (`noexcept` moves)](https://isocpp.org/wiki/guidelines/#Rc-zero)
- Howard Hinnant, ["Everything You Ever Wanted to Know About Move Semantics"](https://howardhinnant.github.io/) — from the author of `<utility>` move support.
- [`std::is_nothrow_move_constructible` — cppreference](https://en.cppreference.com/w/cpp/types/is_move_constructible) for verifying your moves are cheap and `noexcept`.

## Videos

- CppCon — **"Back to Basics: The Special Member Functions"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Special+Member+Functions)) — the generation table, defaulted/deleted, and Rule of Zero/Five in one talk.
- CppCon — **"Back to Basics: Move Semantics"** (Klaus Iglberger) ([search](https://www.youtube.com/results?search_query=CppCon+Klaus+Iglberger+Back+to+Basics+Move+Semantics)) — the clearest treatment of moves, `noexcept`, and when they actually fire.
