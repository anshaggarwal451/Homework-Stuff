# Types and Initialization

> **Why a quant dev must own this:** Initialization is where correctness and
> latency collide. Read an uninitialized `int` and you have undefined behavior;
> zero a 4 KB buffer you never needed zeroed and you've burned cycles in the hot
> path. The rules — value vs default init, the most-vexing parse, the static
> initialization order fiasco — are the exact ground HFT interviewers probe to
> see whether you know what the machine *actually does* at object birth.

## First principles: what a type is, what initialization does

A **type** answers two questions: *how many bytes does this object occupy* and
*how do those bytes mean a value*. **Initialization** is the act of giving an
object its first value when it comes into existence. The subtlety that trips
people up: in C++ an object can come into existence *without* being given a
meaningful value at all, and reading it then is undefined behavior — not "you get
garbage," but *the compiler may assume it never happens* and miscompile around
it.

## Fundamental types and their sizes

The core scalar types and the *only* size guarantees the standard makes:

| Type | Guaranteed | Typical (LP64: Linux/macOS x86-64) |
|---|---|---|
| `char` | ≥ 8 bits, exactly 1 byte by definition | 1 byte, signedness impl-defined |
| `short` | ≥ 16 bits | 2 bytes |
| `int` | ≥ 16 bits | 4 bytes |
| `long` | ≥ 32 bits | **8** bytes (Linux), **4** on Windows |
| `long long` | ≥ 64 bits | 8 bytes |
| `bool` | — | 1 byte |
| `float` / `double` | IEEE-754 in practice | 4 / 8 bytes |
| pointer | — | 8 bytes |

The standard only guarantees `sizeof(char) <= sizeof(short) <= sizeof(int) <=
sizeof(long) <= sizeof(long long)` and the minimum widths above. *`long` is the
classic portability trap*: 8 bytes on Linux, 4 on 64-bit Windows.

### Fixed-width types — use these on the wire

For anything touching memory layout, a wire protocol, or a struct whose size
matters, reach for `<cstdint>`:

```cpp
#include <cstdint>
std::int32_t  px;     // exactly 32 bits, two's complement (C++20 mandates 2's comp)
std::uint64_t seq;    // exactly 64 bits
std::int8_t   flag;   // exactly 8 bits
// also: int_fast32_t (fastest >=32-bit), int_least16_t, intptr_t, etc.
```

`std::int32_t` means *exactly* 32 bits with no padding — precisely what you want
when a struct mirrors an exchange message. Plain `int`/`long` are for ordinary
arithmetic where you don't care about exact width.

## The many forms of initialization

C++ has an infamous number of initialization syntaxes. Here is the working set:

```cpp
int a;            // (1) default-init: for built-ins => INDETERMINATE value
int b{};          // (2) value-init (with {}) => zero-initialized => 0
int c = 0;        // (3) copy-init
int d(5);         // (4) direct-init
int e{5};         // (5) direct-list-init (braces)
int f = {5};      // (6) copy-list-init

std::vector<int> v;        // default-init: calls default ctor => empty (well-defined)
std::vector<int> w(10, 7); // direct-init: 10 elements of 7
std::vector<int> x{1,2,3}; // list-init: elements 1,2,3 (initializer_list)
```

The distinctions that matter:

- **Default-initialization** (`int a;`): for a **class type**, calls the default
  constructor — well-defined. For a **built-in / trivial** type with automatic
  or dynamic storage, the object holds an **indeterminate value** and *reading it
  is UB*.
- **Value-initialization** (`int b{};`, `T()`): zero-initializes scalars and
  value-inits members; for built-ins this means **0**. The braces are the safe
  default.
- **Zero-initialization**: what happens to objects with **static/thread storage
  duration** before any other init — they start as all-bytes-zero. (This is why
  a global `int` is 0 but a local `int` is not.)
- **Aggregate / list initialization**: `{...}` filling a struct/array member by
  member.

## `{}` uniform initialization and narrowing prevention

C++11 introduced brace-initialization with a safety property the older forms
lack: **it forbids narrowing conversions**.

```cpp
int  x = 3.9;    // OK (copy-init): silently truncates to 3
int  y(3.9);     // OK: truncates to 3
int  z{3.9};     // ERROR: narrowing conversion double -> int  (compile-time!)

std::uint8_t small{300};   // ERROR: 300 doesn't fit in 8 bits
std::uint8_t ok{200};      // OK
```

This is a feature, not a nuisance: a narrowing bug that would silently corrupt a
price becomes a *compile error*. Many HFT style guides mandate `{}` for exactly
this reason. The cost is that `{}` prefers an `initializer_list` constructor when
one exists, which can surprise you:

```cpp
std::vector<int> a(3);   // size 3, elements 0
std::vector<int> b{3};   // ONE element with value 3  (initializer_list wins)
```

## The most-vexing parse

If something *could* be parsed as a function declaration, C++ says it **is** one.

```cpp
struct Timer { Timer(); };

Timer t();     // NOT an object! A declaration of a function `t`
               // taking no args and returning Timer.
Timer t2{};    // an object, value-initialized  (braces disambiguate)
Timer t3;      // an object, default-initialized
```

`Widget w(Reader());` is the classic full form — it's read as a function taking a
*pointer to a function returning Reader*. The fix is always **braces**:
`Widget w{Reader{}};`. Interviewers love this one because the error message
("request for member of non-class type") is baffling until you know the rule.

## Value-init vs default-init for built-ins: the UB landmine

```cpp
int compute() {
    int sum;                 // default-init: indeterminate
    for (int i = 0; i < n; ++i) sum += data[i];  // UB: reading indeterminate `sum`
    return sum;
}
```

Reading `sum` before it's assigned is undefined behavior. Modern compilers will
warn (`-Wuninitialized`, `-Wmaybe-uninitialized`) and may *exploit* the UB —
e.g. assume the loop always runs, or delete a bounds check. The fix is `int sum
= 0;` or `int sum{};`. The same applies to members not mentioned in a
constructor's initializer list, and to `new int` (default-init, indeterminate)
vs `new int{}` (value-init, zero).

> **HFT nuance — don't over-zero.** The flip side: `{}` on a large
> `std::array<char, 65536>` writes 64 KB of zeros you may not need. A buffer
> you're about to `memcpy` *into* doesn't need zeroing first. Initialize for
> correctness, but know that value-init has a real cost and avoid zeroing
> scratch you'll immediately overwrite.

## The static initialization order fiasco

Objects with **static storage duration** in *different* translation units are
**zero-initialized**, then **dynamically initialized** in an **unspecified
order across TUs**. So if a global in `a.cpp` uses a global in `b.cpp` during its
own construction, you may read the other one *before it's constructed*:

```cpp
// config.cpp
Config g_config = load_config();      // ctor reads g_logger...

// logger.cpp
Logger g_logger;                      // ...but is g_logger constructed yet? UNSPECIFIED.
```

This is the **static initialization order fiasco**. The standard, idiom-level
fix is the **Construct-On-First-Use** pattern — a function-local static, which is
initialized the first time control passes through its declaration (and, since
C++11, thread-safely):

```cpp
Logger& logger() {
    static Logger instance;   // constructed on first call, in order of use
    return instance;
}
```

## `constinit` — guaranteeing compile-time init (C++20)

`constinit` asserts that a variable with static storage duration is
**initialized at compile time** (constant initialization), so it never
participates in the dynamic-init ordering problem and there's no run-time init
cost or guard variable:

```cpp
constinit int g_table_size = 1 << 16;   // OK: computed at compile time
// constinit int g_x = std::time(nullptr); // ERROR: not a constant initializer
```

It is *not* `const` — the value can still mutate at run time. It's a promise
about *when* it's initialized, eliminating both the fiasco and the lazy-guard
check that a function-local `static` pays on every access.

## POD, trivial, and standard-layout

These category words describe *what the compiler is allowed to do with the
bytes*, which is exactly what matters for serialization and `memcpy`:

- **Trivial type**: default constructor, copy/move, and destructor are all
  compiler-generated and do nothing special. A trivial type can be created by
  just grabbing memory; **`std::memcpy` is a valid copy**.
- **Standard-layout type**: members laid out predictably (no mixed-access-control
  reordering, no virtuals), so the layout is ABI-stable and matches a C struct —
  safe to share across a language boundary or a wire.
- **POD** ("Plain Old Data") = trivial **and** standard-layout. The term is
  deprecated in favor of the two finer-grained traits, but it's still the word
  interviewers use.

```cpp
#include <type_traits>
struct Tick { std::int64_t ts; std::int32_t px; std::int32_t qty; };
static_assert(std::is_trivial_v<Tick>);            // can memcpy
static_assert(std::is_standard_layout_v<Tick>);    // C-compatible layout
static_assert(std::is_trivially_copyable_v<Tick>); // the property memcpy needs
```

`std::is_trivially_copyable` is the precise trait you check before
`std::memcpy`-ing or `std::bit_cast`-ing an object — the basis of fast,
copy-by-bytes serialization in feed handlers.

## Performance & hardware reality

- A local `int x = 0;` is essentially free — the zero often folds into an
  existing register move, and the optimizer drops the store entirely if `x` is
  overwritten before it's read.
- Value-initializing a large array/struct is a real `memset`. For multi-KB
  scratch buffers in a hot path, prefer leaving them uninitialized (and writing
  every byte before reading), or use a separate "zeroed once, reused" arena.
- A function-local `static` carries a thread-safe **guard variable**: the first
  call runs the constructor under a lock; every subsequent call does an acquire
  load of the guard. `constinit`/`const` globals avoid that per-access check.
- Trivially-copyable types unlock `memcpy`/`bit_cast`, which the compiler can
  turn into a few wide vector moves — far faster than field-by-field copying.

## Quant/HFT relevance & interview gotchas

- **"Local `int i;` then read it — what happens?"** Indeterminate value, reading
  it is UB; the compiler may optimize on the assumption it can't happen.
- **"Difference between `T x;` and `T x{};`?"** Default-init vs value-init; for
  built-ins the second zeroes, the first doesn't. Know that for class types both
  run a constructor.
- **`vector<int> v{3}` vs `v(3)`** — one element `3` vs three elements `0`. The
  `initializer_list` ambiguity.
- **Static init order fiasco** — name it, then give the Construct-On-First-Use
  fix and mention `constinit` for the const-init case.
- **"How do you serialize a struct quickly?"** Check
  `is_trivially_copyable`/`is_standard_layout`, then `memcpy`/`bit_cast`; never
  for types with pointers or virtuals.
- **Avoid accidental zeroing cost** in hot paths — initialize for correctness,
  not reflexively.

## Key takeaways

1. The standard guarantees only **minimum widths** and an ordering;
   use **`<cstdint>`** fixed-width types whenever layout matters (`long` is 8 on
   Linux, 4 on Windows).
2. **Default-init** leaves built-ins **indeterminate** (reading = UB);
   **value-init** (`{}`) zeroes them. Prefer `{}` for safety — it also **forbids
   narrowing**.
3. Beware the **most-vexing parse**: `T t();` is a function declaration; use `T
   t{};`.
4. The **static initialization order fiasco** afflicts cross-TU globals; fix with
   **Construct-On-First-Use** or **`constinit`** (C++20) for constant init.
5. **Trivially-copyable / standard-layout** (the old "POD") types are the ones
   you may `memcpy`/`bit_cast` — the foundation of fast serialization.
6. Initialization has a **cost**: don't zero large buffers you'll immediately
   overwrite.

## Self-check

1. What is the value of a local `int x;` before assignment, and what is the
   precise consequence of reading it?
2. Explain the difference between `std::vector<int> a(3);` and `std::vector<int>
   a{3};`.
3. Why does `Widget w();` not create a `Widget`, and how do you fix it?
4. Describe the static initialization order fiasco and two ways to avoid it.
5. What does `constinit` guarantee, and how is it different from `const`?
6. Which type trait must hold before you `std::memcpy` an object, and why is a
   type with a `std::string` member excluded?

## Further reading

- [Initialization — cppreference](https://en.cppreference.com/w/cpp/language/initialization) (the hub page; follow its links)
- [Value initialization](https://en.cppreference.com/w/cpp/language/value_initialization) · [Default initialization](https://en.cppreference.com/w/cpp/language/default_initialization) · [List initialization](https://en.cppreference.com/w/cpp/language/list_initialization) — cppreference
- [Fixed-width integer types `<cstdint>` — cppreference](https://en.cppreference.com/w/cpp/types/integer)
- [`constinit` — cppreference](https://en.cppreference.com/w/cpp/language/constinit)
- [`std::is_trivially_copyable` / `std::is_standard_layout` — cppreference](https://en.cppreference.com/w/cpp/types/is_trivially_copyable)
- [Static initialization order fiasco — isocpp.org C++ FAQ](https://isocpp.org/wiki/faq/ctors#static-init-order)
- Scott Meyers, *Effective Modern C++*, **Item 7** ("Distinguish `()` and `{}` when creating objects").

## Videos

- Nicolai Josuttis, CppCon — **"The Nightmare of Initialization in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Nicolai+Josuttis+The+Nightmare+of+Initialization+in+C%2B%2B)).
- Timur Doumler, CppCon — **"Initialization in modern C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+initialization+in+modern+C%2B%2B)).
