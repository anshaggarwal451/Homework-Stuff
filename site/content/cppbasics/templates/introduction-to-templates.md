# Introduction to Templates

> **Why a quant dev must own this:** Templates are how C++ achieves
> *zero-overhead generic code* — the same `RingBuffer<Order>` and
> `RingBuffer<Quote>` with no virtual dispatch, no boxing, fully inlined. The
> entire STL, Eigen, and every serious low-latency library is templates. But
> the same mechanism causes the code bloat, the 90-second builds, and the
> 400-line error messages that define daily HFT life. You must understand the
> model: **templates are code generators.**

## First principles: a pattern, not code

A template is a **recipe the compiler uses to generate code** once it knows the
concrete types. Nothing is compiled into your binary until you *use* it with
specific types — that act is called **instantiation**.

```cpp
template <typename T>           // T is a placeholder type parameter
T max3(T a, T b, T c) {
    T m = a > b ? a : b;
    return m > c ? m : c;
}

int    x = max3(1, 2, 3);          // instantiates max3<int>
double y = max3(1.5, 0.5, 9.0);    // instantiates max3<double>  (a SEPARATE function)
```

The compiler **deduces** `T` from the arguments (see the *Type Deduction*
lesson) and stamps out one concrete function per distinct `T`. `max3<int>` and
`max3<double>` are two different functions in your object file.

## Function templates vs class templates

```cpp
// Function template — usually deduces its arguments.
template <typename T> T abs_val(T v) { return v < 0 ? -v : v; }

// Class template — pre-C++17 you spell out the type; C++17 CTAD can deduce it.
template <typename T, std::size_t N>
struct RingBuffer {
    T   data[N];
    std::size_t head = 0, tail = 0;
    void push(const T& v) { data[head++ % N] = v; }
};

RingBuffer<Order, 1024> book_events;   // a concrete type
```

Member functions of a class template are **themselves** templates and are
instantiated *on demand* — only the members you actually call get compiled.
That's why a `std::vector<T>` works for a `T` that lacks, say, `operator<`:
you just can't call `std::sort` on it.

## The three kinds of template parameter

```cpp
template <
    typename T,                          // 1. TYPE parameter
    std::size_t N,                       // 2. NON-TYPE template parameter (NTTP)
    template <class> class Allocator     // 3. TEMPLATE-TEMPLATE parameter
> class Buffer;
```

1. **Type parameters** (`typename T` / `class T`) — the common case.
2. **Non-type template parameters (NTTP)** — *values* known at compile time:
   integers, enums, pointers/references with static storage, and (C++20)
   floating-point and even literal class types. `std::array<int, 16>`'s `16` is
   an NTTP, which is why the size is part of the type and lives on the stack.
3. **Template-template parameters** — a parameter that is itself a template,
   e.g. passing a container template `Vector` rather than `Vector<int>`.

NTTPs are the workhorse of HFT generic-but-fixed-size code: `RingBuffer<T, 4096>`
bakes the capacity into the type, enabling the compiler to turn `% N` into a
mask when `N` is a power of two.

## Instantiation: on demand, per type

The compiler instantiates a template **only when and where it is used**, and
**once per distinct set of arguments** (per translation unit, then deduplicated
by the linker). Three things follow:

1. An unused template member is never compiled — errors in it stay hidden.
2. Each distinct type argument produces its own machine code (**monomorphization**).
3. Definitions must be **visible at the point of use** — which forces templates
   into headers (see below).

## Two-phase lookup (the part interviews probe)

Template definitions are checked in **two phases** (the source of the famous
`typename` and `this->` requirements):

- **Phase 1 (at definition):** names that *don't* depend on the template
  parameters are looked up and checked immediately. Syntax is validated.
- **Phase 2 (at instantiation):** **dependent** names — those that depend on
  `T` — are looked up only when `T` is known, using *argument-dependent lookup*.

Two consequences you will be asked about:

```cpp
template <typename T>
struct Derived : Base<T> {
    void f() {
        // helper();        // ERROR: non-dependent, Base<T>::helper not found in phase 1
        this->helper();     // OK: 'this->' makes it dependent -> looked up in phase 2
    }
};

template <typename T>
void g() {
    typename T::value_type x;   // 'typename' tells phase 1 that T::value_type is a TYPE
    typename T::value_type* p;  // without it, the compiler assumes a multiply!
}
```

> **Interview gotcha:** "Why do you need `typename` before `T::value_type`?"
> Because in phase 1 the compiler can't know whether the dependent name
> `T::value_type` is a type or a value, and it *defaults to assuming a value* —
> so you must disambiguate. Same story for `template` before a dependent member
> template (`p->template get<0>()`).

## Where definitions must live: headers

Because instantiation needs the full **definition** at the point of use, you
cannot split a template's declaration (header) from its definition (`.cpp`) the
way you do for ordinary functions — the linker would have nothing to stamp out.

```cpp
// ringbuffer.hpp  — the WHOLE template, definition included, lives here.
template <typename T, std::size_t N> struct RingBuffer { /* ...full body... */ };
```

Workarounds when you truly must hide a definition:

- **Explicit instantiation** in one `.cpp` (`template class RingBuffer<Order, 1024>;`)
  for a *fixed, known* set of types — limits bloat and build time.
- The old `export` keyword is **dead** (removed); don't mention it as live.

## Templates vs the preprocessor vs overloading

| Tool          | Type-safe? | Sees types? | Debuggable? | Use it for |
|---------------|:----------:|:-----------:|:-----------:|------------|
| **Templates** | yes        | yes         | yes         | generic, type-parameterised code |
| **`#define` macro** | no   | no (textual)| poorly      | conditional compilation, header guards — *not* generics |
| **Overloading** | yes      | yes         | yes         | a *small fixed* set of unrelated types/behaviours |

A macro `MAX(a,b)` double-evaluates its arguments and ignores types; a template
`max(a,b)` is type-checked and evaluates each argument once. Overloading is the
right tool when behaviour genuinely differs per type and there are only a few;
templates win when the *logic is identical* across an open set of types.

## Concepts (C++20): a teaser

Unconstrained templates accept anything and fail deep inside on use, producing
those legendary error walls. **Concepts** constrain a parameter up front and
report a clean, local error:

```cpp
#include <concepts>

template <typename T>
concept Numeric = std::integral<T> || std::floating_point<T>;

template <Numeric T>                 // T must satisfy Numeric
T add(T a, T b) { return a + b; }

// add("x", "y");   // crisp error: constraint 'Numeric' not satisfied — not a 50-line dump
```

Concepts also subsume each other for cleaner overload selection. They're the
modern front door; the body still instantiates exactly as before.

## Code generation, bloat, and build cost — the hardware reality

Templates are **monomorphized**: one full copy of machine code per distinct
instantiation. That's *why* they're fast — everything is concrete and inlinable,
with no runtime dispatch — and *why* they bloat.

```cpp
template <typename T> T add(T a, T b) { return a + b; }
int    i = add(1, 2);
double d = add(1.0, 2.0);
```

```x86asm
; add<int>  — integer add in a GPR
add_int:
        lea     eax, [rdi + rsi]
        ret
; add<double> — a COMPLETELY SEPARATE function using the FPU
add_double:
        addsd   xmm0, xmm1
        ret
```

Two source lines, two distinct functions in the binary. Across a large code
base this multiplies: instantiating `std::vector`, `std::map`, etc. for dozens
of types inflates `.text`, pressures the instruction cache, and lengthens
compile times (the compiler re-parses and re-instantiates templates in every
translation unit that includes them).

Mitigations the senior engineer reaches for:

- **`extern template`** to suppress redundant instantiation across TUs, paired
  with one explicit instantiation.
- Factor type-independent logic into a **non-template base** (the
  "thin-template-over-fat-base" idiom) so only the thin glue is multiplied.
- Limit instantiations to the types you actually use.

> The tradeoff in one line: **templates trade binary size and build time for
> runtime speed and type safety.** For HFT that trade is almost always right.

## Quant/HFT relevance & interview gotchas

- **Zero-overhead generics:** `RingBuffer<Order>` inlines to the same code you'd
  hand-write — no `void*`, no virtual call. This is *the* reason HFT favours
  templates over runtime polymorphism in hot paths.
- **NTTP-fixed sizes** (`<T, 4096>`) put buffers on the stack and turn modulo
  into masking — measurable latency wins.
- **Build-time tax is real:** heavy template metaprogramming can push compile
  times into minutes; teams budget for it (explicit instantiation, `extern
  template`, PCH/modules).
- **Two-phase lookup trivia** (`typename`, `this->`, `template` disambiguator)
  is a favourite "did you really write templates?" filter.
- **Code bloat vs icache:** be ready to argue *when* monomorphization hurts (a
  huge template body instantiated for many types) and how you'd refactor.

## Key takeaways

1. A template is a **code generator**; nothing is emitted until **instantiation**
   with concrete arguments (on demand, per distinct type).
2. Function and class templates; class-template **members instantiate
   individually** as used.
3. Three parameter kinds: **type**, **non-type (NTTP)**, and **template-template**.
4. **Two-phase lookup** is why `typename`/`this->`/`template` disambiguators
   exist — dependent names resolve only at instantiation.
5. Definitions must be **visible at use** → templates live in headers; use
   explicit / `extern template` to control bloat.
6. **Monomorphization** gives zero-overhead speed but costs binary size and
   build time. **Concepts** (C++20) tame the error messages.

## Self-check

1. Why must a template's definition (not just its declaration) be visible where
   it's instantiated?
2. Explain why `typename T::value_type x;` needs `typename` but `int x;` doesn't.
3. What is an NTTP? Give an STL example and a reason HFT code likes them.
4. How many distinct functions does `add(1,2); add(1.0,2.0);` put in the binary,
   and why?
5. When is a macro the wrong tool and a template the right one — and vice versa?
6. Name two techniques to reduce template-induced code bloat / build time.

## Further reading

- [Templates — cppreference](https://en.cppreference.com/w/cpp/language/templates) and [Template parameters and arguments — cppreference](https://en.cppreference.com/w/cpp/language/template_parameters)
- [Dependent names & two-phase lookup — cppreference](https://en.cppreference.com/w/cpp/language/dependent_name)
- [Class template (and member instantiation) — cppreference](https://en.cppreference.com/w/cpp/language/class_template)
- [Constraints and concepts (C++20) — cppreference](https://en.cppreference.com/w/cpp/language/constraints)
- David Vandevoorde, Nicolai Josuttis & Douglas Gregor, *C++ Templates: The Complete Guide* (2nd ed.) — the definitive reference.
- [`extern template` — cppreference](https://en.cppreference.com/w/cpp/language/class_template#Explicit_instantiation) — controlling instantiation/bloat.
- [isocpp.org Super-FAQ: Templates](https://isocpp.org/wiki/faq/templates) — concise answers to the classic questions.

## Videos

- Arthur O'Dwyer — **"Back to Basics: Templates"** (CppCon 2021/2022, two parts), [search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Templates+Arthur+O%27Dwyer).
- Andreas Fertig — **"Understanding the C++ Compilation Model / Templates"**, [search](https://www.youtube.com/results?search_query=CppCon+Andreas+Fertig+templates+compilation+model).
- Jon Kalb — **"Refactoring with C++ Templates"**, [search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Templates+Jon+Kalb).
