# Lambdas

> **Why a quant dev must own this:** Lambdas are the inlinable, zero-overhead
> way to pass behaviour into `std::sort`, `std::for_each`, your event loop, and
> your callbacks — *without* the heap allocation and indirect call of
> `std::function`. But a lambda that captures a local by reference and outlives
> it is a dangling pointer in your hot path: silent corruption at line rate.
> "What is a lambda, really, and what does its capture cost?" is a staple HFT
> interview question.

## First principles: a lambda is a class

A lambda is **syntactic sugar for an unnamed class with an `operator()`** — a
*closure type* — and the lambda expression creates one *instance* of it (the
*closure object*). Captures become **data members**.

```cpp
int threshold = 100;
auto over = [threshold](int x) { return x > threshold; };   // C++11
bool b = over(150);   // calls over.operator()(150)
```

The compiler desugars that to roughly:

```cpp
class __lambda_over {                 // unnamed, compiler-generated
    int threshold;                    // capture-by-value -> a member
public:
    explicit __lambda_over(int t) : threshold(t) {}
    bool operator()(int x) const { return x > threshold; }   // note: const by default
};
auto over = __lambda_over{threshold};
```

Two immediate consequences: each lambda has a **distinct, unnamable type** (hence
`auto`), and `operator()` is **`const`** unless you say `mutable`.

## Capture modes

The capture list `[...]` controls which surrounding variables become members and
how.

```cpp
int a = 1, b = 2;
[a]        // capture a by VALUE  (copies a into the closure)
[&a]       // capture a by REFERENCE (stores a reference -> beware lifetime!)
[=]        // capture everything ODR-used, by value
[&]        // capture everything ODR-used, by reference
[a, &b]    // mixed
[this]     // capture the enclosing object's 'this' POINTER (members by reference!)
[*this]    // C++17: capture a COPY of *this (safe if the object may outlive)
[x = expr] // C++14 INIT-CAPTURE: create member x initialised from expr
```

### Init-capture (C++14) — the move-into-closure idiom

Init-capture lets you create a new member with its own initializer — the only
way to **move** something into a lambda (and to capture a `unique_ptr`):

```cpp
auto p = std::make_unique<Order>();
auto task = [p = std::move(p)]() { p->submit(); };   // ownership moved into closure
```

### `[this]` vs `[*this]` — the subtle one

`[this]` (and `[=]` inside a member function, which captures `this`!) stores a
**pointer** to the enclosing object — all member access is *by reference*. If the
closure outlives the object (queued callback, deferred task), that's a dangling
`this`. C++17's `[*this]` captures a **copy** of the whole object.

```cpp
struct Strategy {
    double edge;
    auto make_callback() {
        // return [this] { use(edge); };   // DANGER if *this dies before the callback
        return [*this] { use(edge); };     // C++17: safe, captures a copy of *this
    }
};
```

## `mutable` lambdas

Because `operator()` is `const`, you can't modify *by-value* captures unless you
mark the lambda `mutable`. (By-reference captures modify the referent regardless;
`mutable` is about the closure's *own* members.)

```cpp
auto counter = [n = 0]() mutable { return ++n; };   // each call increments its own n
counter(); // 1
counter(); // 2  — state lives in the closure object
```

## Generic lambdas (C++14) and template lambdas (C++20)

A lambda with `auto` parameters is a **generic lambda** — its `operator()` is
*itself* a template, instantiated per argument type:

```cpp
auto plus = [](auto a, auto b) { return a + b; };   // C++14
plus(1, 2);       // operator()<int,int>
plus(1.5, 2.5);   // operator()<double,double>
```

C++20 adds an explicit **template parameter list** when you need to *name* the
type (e.g. to constrain it, or refer to it twice):

```cpp
auto first = []<typename T>(const std::vector<T>& v) -> const T& {   // C++20
    return v.front();
};
```

## `constexpr` lambdas (C++17)

A lambda whose body satisfies the `constexpr` rules is **implicitly
`constexpr`** (C++17) and can run at compile time — perfect for building lookup
tables via an IIFE (see below).

```cpp
constexpr auto sq = [](int x) { return x * x; };   // C++17
static_assert(sq(7) == 49);                        // evaluated by the compiler
```

## Captureless lambdas convert to function pointers

A lambda that captures **nothing** has no state, so it converts implicitly to a
plain function pointer — handy for C APIs (`qsort`, pthread callbacks, signal
handlers):

```cpp
auto cmp = [](const void* a, const void* b) -> int {       // no captures
    return (*(const int*)a) - (*(const int*)b);
};
int (*fp)(const void*, const void*) = cmp;   // OK — implicit conversion
std::qsort(arr, n, sizeof(int), fp);
```

A *capturing* lambda has state and therefore **cannot** become a bare function
pointer — that's exactly why C callbacks pass a separate `void* user_data`.

## IIFE — immediately-invoked lambda for complex const init

When initializing a `const`/`constexpr` object needs several statements (a
switch, a loop), an *immediately-invoked function expression* keeps the variable
`const` without a mutable scratch object leaking into scope:

```cpp
const auto config = [&] {                  // run once, right here
    Config c;
    for (auto& kv : raw) c.apply(kv);
    c.validate();
    return c;
}();                                        // <-- the () invokes it immediately
// config is const, fully built, and the build steps are scoped away
```

## The dangling-capture bug — the HFT killer

`[&]` and `[this]` store references/pointers. If the closure escapes the scope
of what it captured — stored in a queue, returned, registered as a callback —
you have a dangling reference and **undefined behaviour**, often manifesting as
intermittent corruption that's brutal to reproduce at line rate.

```cpp
std::function<void()> make_bad() {
    int local = 42;
    return [&]() { use(local); };   // BUG: 'local' dies when make_bad returns
}                                   //      the returned closure dangles

// Fix: capture BY VALUE (or by init-capture / *this) when the closure escapes.
std::function<void()> make_good() {
    int local = 42;
    return [local]() { use(local); };   // copies 42 into the closure — safe
}
```

> **Senior rule:** `[&]` is fine for a lambda that's *consumed before the scope
> exits* (e.g. passed straight into `std::sort`). The moment a closure is
> **stored or returned**, capture by value / move / `*this`. Compilers (Clang
> `-Wdangling`, GCC) increasingly diagnose the obvious cases, but not all.

## Performance: inlining vs `std::function`

This is the reason lambdas dominate hot-path callbacks.

```cpp
std::sort(v.begin(), v.end(), [](int a, int b){ return a < b; });
```

The comparator is a **distinct type** known at the call site, so `std::sort`'s
template instantiates with it and the compiler **inlines the comparison into the
sort loop** — no call, no indirection. Hand-write the loop and you'd get the
same code.

Contrast `std::function<bool(int,int)>`: it is **type erasure** — a
heap-allocating (beyond the small-buffer optimization), virtual-dispatch wrapper.
Every call is an **indirect call** the compiler usually *cannot* inline.

```x86asm
; lambda comparator inlined into the sort's inner loop:
        cmp     eax, edx          ; the comparison, right in the loop body
        jl      .swap             ; no call instruction at all

; std::function comparator:
        mov     rdi, rbx
        call    qword ptr [rbx+OFF]   ; indirect call through the vtable/invoker
```

| Mechanism            | Storage          | Call          | Inlinable? | Hot-path verdict |
|----------------------|------------------|---------------|:----------:|------------------|
| Lambda (as template arg) | none / stack | direct        | yes        | **preferred** |
| Captureless → fn ptr | none             | indirect      | sometimes  | OK for C APIs |
| `std::function`      | heap/SBO + vtable| indirect      | rarely     | **avoid in hot loop** |

> **Interview gotcha:** "Why is passing a lambda to `std::sort` faster than
> passing a `std::function`?" Because the lambda's *type* is known at compile
> time and inlines; `std::function` type-erases, costing an indirect call and
> possibly a heap allocation. Pass lambdas via a **template parameter**, not a
> `std::function`, when latency matters.

## Quant/HFT relevance & interview gotchas

- **Inlining advantage:** lambdas in `<algorithm>` and templated callbacks
  inline to hand-written speed; `std::function` in a hot path is a measurable
  indirect-call + allocation tax — a frequent code-review reject.
- **Dangling captures** (`[&]`, `[this]`) are *the* lambda bug: a closure that
  outlives its captured local/object corrupts silently. Capture by value/move,
  or `[*this]` (C++17), when the closure escapes.
- **`[=]` captures `this` inside members** (by pointer) — a notorious surprise;
  C++20 deprecated implicit-`this` via `[=]`. Be explicit.
- **Move-into-closure** needs C++14 init-capture (`[p = std::move(p)]`) — the
  only way to put a `unique_ptr` in a lambda.
- **constexpr lambdas + IIFE** build compile-time tables (ties back to the
  `constexpr` lesson) — zero runtime cost.
- **Captureless → function pointer** is the bridge to C callbacks; capturing
  lambdas can't make that jump.

## Key takeaways

1. A lambda is an **unnamed closure class** with `operator()`; captures are its
   data members. Each lambda has a unique type — use `auto`.
2. Capture modes: `[=]`/`[&]`/`[x]`/`[&x]`/`[this]`/`[*this]` (C++17 copy) and
   **init-capture** `[x = expr]` (C++14, the move-in idiom).
3. `operator()` is **`const`** unless `mutable`; `mutable` lets you mutate
   by-value captures (the closure's own state).
4. **Generic lambdas** (`auto` params, C++14) and **template lambdas** (C++20);
   lambdas can be **`constexpr`** (C++17). **Captureless** lambdas convert to
   function pointers.
5. **Dangling captures** (`[&]`/`[this]` escaping their scope) are a severe
   hot-path bug — capture by value/move/`*this` when the closure outlives the
   source.
6. As a **template argument**, a lambda **inlines** with zero overhead;
   `std::function` type-erases (indirect call + possible heap) — avoid it in the
   hot loop.

## Self-check

1. Desugar `[n = 0]() mutable { return ++n; }` into the equivalent class. Why is
   `mutable` required?
2. What's the difference between `[this]` and `[*this]`, and when does it matter?
3. Why can a captureless lambda convert to a function pointer but a capturing one
   cannot?
4. Identify the bug: a function returns `[&]() { return localVec.size(); }`. How
   do you fix it?
5. Explain why passing a lambda to `std::sort` typically out-performs passing a
   `std::function` with the same body.
6. How do you move a `std::unique_ptr` into a lambda, and which standard
   introduced the feature?

## Further reading

- [Lambda expressions — cppreference](https://en.cppreference.com/w/cpp/language/lambda) — capture rules, `mutable`, generic/template/constexpr lambdas.
- [`std::function` — cppreference](https://en.cppreference.com/w/cpp/utility/functional/function) — the type-erasure cost you're avoiding.
- Scott Meyers, *Effective Modern C++*, **Items 31–34** (avoid default capture modes; init-capture; generic lambdas; prefer lambdas to `std::bind`).
- [Init-capture / generalized lambda capture — cppreference](https://en.cppreference.com/w/cpp/language/lambda#Lambda_capture)
- [`[*this]` capture (C++17) proposal P0018](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2016/p0018r3.html) — capturing `*this` by value.
- [CppCoreGuidelines — F.50/F.52/F.53 on lambdas & captures](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#Rf-capture-vs-overload) — when to capture by value vs reference.
- [Compiler Explorer (godbolt.org)](https://godbolt.org/) — verify the inlined-vs-`std::function` assembly yourself.

## Videos

- Scott Meyers — *Effective Modern C++* lambda items, talk **"The Universal Reference / Lambda"** material, [search](https://www.youtube.com/results?search_query=Scott+Meyers+Effective+Modern+C%2B%2B+lambdas).
- CppCon — **"Back to Basics: Lambdas"** (Nicolai Josuttis, CppCon 2021), [search](https://www.youtube.com/results?search_query=CppCon+2021+Back+to+Basics+Lambdas+Josuttis).
- CppCon — **"Lambdas from First Principles: A Whirlwind Tour of C++"** (Arthur O'Dwyer, CppCon 2019), [search](https://www.youtube.com/results?search_query=CppCon+2019+Lambdas+from+First+Principles+Arthur+O%27Dwyer).
