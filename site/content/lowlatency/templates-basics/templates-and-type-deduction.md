# Templates & Type Deduction

> **Why a quant dev must own this:** Templates are how low-latency C++ gets its
> speed *and* its generality at the same time — the compiler stamps out a
> specialized, fully inlined version of your code for every type, with zero
> runtime dispatch. But the deduction rules that decide *which* `T` you get are
> subtle, and getting them wrong silently copies a 4 KB order book, drops a
> `const`, or collapses a reference you wanted to keep. Deduction is also the
> single most-asked C++ template topic in HFT interviews.

(Standard: **C++17** for the core, with **C++17 CTAD** and **C++14
`decltype(auto)`** called out. Notes flag C++20 where relevant.)

## First principles: a template is a recipe, not code

A template is not a function or a class. It is a *recipe* the compiler uses to
**generate** a function or class once you supply the type arguments. Nothing is
compiled into your binary until the template is **instantiated** with concrete
types. That is the whole performance story: there is no `void*`, no virtual
call, no boxing — each instantiation is ordinary, monomorphic code the optimizer
can inline and specialize as if you'd hand-written it.

```cpp
template <class T>          // "class" and "typename" are interchangeable here
T max_of(T a, T b) {
    return a > b ? a : b;
}

int    x = max_of(3, 7);        // instantiates max_of<int>
double y = max_of(1.5, 2.5);    // instantiates max_of<double> — a *separate* function
```

`max_of<int>` and `max_of<double>` are two distinct functions in the binary.
That is why headers are full of templates: the definition must be visible at
every instantiation point.

### Function templates vs class templates

- **Function templates** deduce their arguments from the call (`max_of(3, 7)` —
  you rarely write `max_of<int>`).
- **Class templates** historically required you to *spell out* the arguments
  (`std::vector<int>`), because a class isn't "called". **CTAD** (C++17) lifted
  much of that, below.

## The deduction rules — the part that actually trips people up

Given `template <class T> void f(ParamType param);` and a call `f(expr)`, the
compiler deduces `T` *and* `ParamType` from the type of `expr`. There are three
cases, and they behave differently. This is the Scott Meyers framing, and it is
exactly what interviewers probe.

### Case 1: `ParamType` is a reference or pointer (but **not** a forwarding reference)

```cpp
template <class T> void f(T& param);
```

1. If `expr` is a reference, **ignore the reference part**.
2. Pattern-match `expr`'s type against `ParamType` to find `T`.

```cpp
int        i  = 42;
const int  ci = i;
const int& ri = i;

f(i);    // T = int,        param: int&
f(ci);   // T = const int,  param: const int&   — constness is PRESERVED
f(ri);   // T = const int,  param: const int&   — ref stripped, const kept
```

`const` is preserved by reference parameters — pass a `const` object by `T&`
and `T` becomes `const`-qualified. With `T* param` the same logic applies to
pointers.

### Case 2: `ParamType` is a forwarding reference (`T&&`)

This is the one special case (covered fully in *Perfect Forwarding*):

```cpp
template <class T> void f(T&& param);   // forwarding reference

f(i);    // i is an lvalue -> T = int&,       param: int&   (collapses)
f(42);   // 42 is an rvalue -> T = int,        param: int&&
```

**Lvalue arguments make `T` a reference type.** That is the only context where
`T` deduces to a reference — remember it.

### Case 3: `ParamType` is passed **by value** (`T param`)

```cpp
template <class T> void f(T param);   // by value -> we get a copy
```

1. If `expr` is a reference, ignore it.
2. **Then strip top-level `const`/`volatile`** (you own the copy, so its
   constness is irrelevant).

```cpp
f(ci);   // T = int   (const dropped — you have your own copy)
f(ri);   // T = int   (ref AND const dropped)
```

But **only top-level** cv-qualifiers are stripped:

```cpp
const char* const ptr = "hi";   // const pointer to const char
f(ptr);  // T = const char*  — the const on the pointer is dropped,
         //                    the const on the pointee is NOT (it's not top-level)
```

### Array and function decay

By-value parameters **decay** arrays to pointers and functions to function
pointers — exactly like C:

```cpp
const char name[] = "ESH4";
template <class T> void byval(T);  byval(name);   // T = const char*  (decays)
template <class T> void byref(T&); byref(name);   // T = const char[5] (no decay!)
```

This is how you can recover an array's size at compile time — take it by
reference:

```cpp
template <class T, std::size_t N>
constexpr std::size_t array_size(T (&)[N]) noexcept { return N; }   // N deduced
```

## `auto` deduction: the same rules, with one twist

`auto` deduction **is** template deduction. Mentally, `auto` plays the role of
`T` and the declaration's adornments play `ParamType`:

```cpp
auto        a = ci;   // by value     -> int           (const dropped)
const auto& b = ci;   // case 1       -> const int&
auto&&      c = i;    // forwarding   -> int&           (lvalue)
auto&&      d = 42;   // forwarding   -> int&&          (rvalue)
```

**The one twist — braced initializers.** `auto` deduces a braced list as
`std::initializer_list<T>`; template deduction *refuses* to deduce from a brace:

```cpp
auto z = {1, 2, 3};      // z : std::initializer_list<int>
auto w {42};             // C++17: int (single element). Pre-C++17: init_list<int>

template <class T> void g(T);
// g({1, 2, 3});         // ERROR: cannot deduce T from a braced-init-list
```

> **Interview gotcha:** "What is the type of `auto x = {1};`?" Answer:
> `std::initializer_list<int>`, *not* `int`. This is the single behavioral
> difference between `auto` and template deduction, and it's a favorite.

### `auto` return type and trailing return type

```cpp
auto add(int a, int b) { return a + b; }                 // C++14: deduced return
template <class A, class B>
auto mul(A a, B b) -> decltype(a * b) { return a * b; }  // trailing return type
```

Plain `auto` as a return type uses **template (by-value) deduction**, so it
strips references and `const`. If you want to *return a reference* faithfully,
you need `decltype(auto)`.

## `decltype` vs `decltype(auto)` — preserving the exact type

`decltype(expr)` reports the **declared type** of an expression, references and
all — and it has a famous subtlety:

- `decltype(var)` (a bare name) gives the declared type, e.g. `int`.
- `decltype((var))` (a parenthesized lvalue expression) gives an **lvalue
  reference**, e.g. `int&`. The extra parentheses turn a name into an
  expression.

```cpp
int v = 0;
decltype(v)   p = v;   // int
decltype((v)) q = v;   // int&   — beware the double parens!
```

`decltype(auto)` (C++14) says "deduce the type using the `decltype` rules, not
the `auto`/template rules." Use it for perfect *return-type* forwarding — a
wrapper that must return exactly what the wrapped call returns, reference and
cv-qualifiers intact:

```cpp
template <class F, class... Args>
decltype(auto) timed_call(F&& f, Args&&... args) {
    // ... start timer ...
    return std::forward<F>(f)(std::forward<Args>(args)...);  // returns f's exact type
}
```

With plain `auto` here, a wrapped function returning `int&` would be silently
copied to `int`. With `decltype(auto)`, the reference survives.

```text
                     strips ref/const?   deduces braces?   keeps value category?
auto (by value)          YES                 YES (init_list)     NO
auto&  / const auto&     ref only            n/a                 lvalue ref
auto&& (forwarding)      NO (collapses)      n/a                 YES
decltype(auto)           NO                  n/a                 YES (exact)
template <T> (by val)    YES                 NO (error)          NO
```

## CTAD — Class Template Argument Deduction (C++17)

Before C++17 you wrote the class's type arguments explicitly. CTAD lets the
constructor call deduce them, just like a function template:

```cpp
std::pair p{1, 2.5};               // std::pair<int, double>      (was: pair<int,double>)
std::vector v{1, 2, 3};            // std::vector<int>
std::lock_guard g{my_mutex};       // std::lock_guard<std::mutex> — handy in RAII guards
std::array  a{1, 2, 3};            // std::array<int, 3>          (size deduced too)
```

When the implicit deduction isn't what you want, you supply a **deduction
guide**:

```cpp
template <class T> struct Box { T value; };
Box(const char*) -> Box<std::string>;   // guide: a string literal -> Box<std::string>

Box b{"hi"};   // T = std::string, not const char*
```

> **Note (C++20):** aggregates (like `Box` above) get *implicit* CTAD without a
> guide for the simple cases, and alias templates can participate in CTAD.

## Performance & hardware reality

Templates are a **compile-time** mechanism: there is **zero runtime cost** to
deduction or instantiation. The win is monomorphization — `std::sort` on your
`Order` array compiles to a tight, inlined, branch-predictable loop with the
comparator inlined, whereas a `qsort`-style `void*` + function-pointer comparator
pays an indirect call per comparison and defeats inlining. In a hot path that is
the difference between ~1–2 ns and a mispredicted indirect branch (~15–20 cycles
on a miss).

The *costs* are also compile-time: code bloat (each instantiation is separate
code — watch I-cache pressure if you instantiate the same big function across
dozens of types) and build time. Neither shows up in your latency numbers, but
both show up in your day.

## Quant/HFT relevance & interview gotchas

- **The classic trap:** `template <class T> void f(T param)` called with a
  `const std::array<Order, 4096>&` — the `const` and reference are stripped and
  you **copy the whole array** by value. Use `const T&` (or a forwarding
  reference) in any generic API touching real data.
- **"`auto` vs `decltype(auto)` return"** — know that `auto` strips, so a
  proxy-returning expression (`vector<bool>::operator[]`, an Eigen expression
  template) gets materialized/copied. `decltype(auto)` preserves it.
- **`decltype((x))` is `int&`** — the double-parens question separates people who
  memorized a rule from people who understand it.
- **Forwarding-reference lvalues make `T` a reference** — this is the foundation
  of perfect forwarding; expect to derive it on a whiteboard.
- **`auto x = {1}` is `initializer_list<int>`** — and `template f({1})` is an
  error. Two sides of the same coin.

## Key takeaways

1. A template is a recipe; the compiler **instantiates** monomorphic code per
   type — no runtime dispatch, fully inlinable.
2. Function deduction has three cases: **by-reference/pointer** (strips ref,
   keeps `const`), **forwarding reference** (`T` becomes a ref for lvalues), and
   **by value** (strips ref *and* top-level cv, decays arrays/functions).
3. `auto` follows the *same* rules, except it deduces a braced list as
   `std::initializer_list`; template deduction errors on braces.
4. `decltype(auto)` preserves the **exact** type (references, cv, value
   category) — use it for perfect return-type forwarding; plain `auto` strips.
5. **CTAD** (C++17) lets class templates deduce their arguments from the
   constructor; steer it with **deduction guides** when needed.

## Self-check

1. For `const int ci = 0;`, what is `T` in `template<class T> void f(T param)`
   called as `f(ci)`? In `f(T& param)`? In `f(T&& param)`?
2. What is the type of `auto x = {42};`? Why does `template<class T> void
   g(T); g({42});` fail to compile?
3. Explain the difference between `decltype(x)` and `decltype((x))` for a local
   `int x`.
4. Why does `template<class T, size_t N> void f(T(&)[N])` recover an array's
   size while `template<class T> void f(T arr)` cannot?
5. A wrapper does `template<class F> auto call(F&& f){ return f(); }` around a
   function returning `std::string&`. What goes wrong, and how does
   `decltype(auto)` fix it?
6. When does `T` ever deduce to a reference type, and why is that the
   cornerstone of perfect forwarding?

## Further reading

- [Template argument deduction — cppreference](https://en.cppreference.com/w/cpp/language/template_argument_deduction)
- [`auto` specifier — cppreference](https://en.cppreference.com/w/cpp/language/auto) and [`decltype` — cppreference](https://en.cppreference.com/w/cpp/language/decltype)
- [Class template argument deduction (CTAD) — cppreference](https://en.cppreference.com/w/cpp/language/class_template_argument_deduction)
- Scott Meyers, *Effective Modern C++*, Items 1–4 (template deduction, `auto`, `decltype`) — the definitive treatment this lesson tracks.
- [`decltype(auto)` — cppreference](https://en.cppreference.com/w/cpp/language/decltype) (the `decltype(auto)` placeholder).
- [Deduction guides — cppreference](https://en.cppreference.com/w/cpp/language/class_template_argument_deduction#User-defined_deduction_guides).

## Videos

- CppCon — Arthur O'Dwyer, **"Template Normal Programming"** ([search](https://www.youtube.com/results?search_query=CppCon+Arthur+O%27Dwyer+Template+Normal+Programming)) — a careful, ground-up tour of templates and deduction.
- CppCon — **"Back to Basics: Type Deduction"** (Andreas Fertig / various years) ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Type+Deduction)) — `auto`, `decltype`, and the three deduction cases.
