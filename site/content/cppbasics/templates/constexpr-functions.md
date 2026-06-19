# constexpr functions

> **Why a quant dev must own this:** The cheapest computation is the one that
> already happened — at compile time. `constexpr` lets you precompute pricing
> tables, bit masks, lookup curves, and protocol field offsets so the hot path
> ships a constant instead of a calculation. In HFT, "zero runtime cost" is not
> a slogan; it's a `constexpr` table baked into `.rodata`. Knowing exactly
> *when* evaluation happens at compile time is the interview crux.

## First principles: a function that can run at compile time

`constexpr` on a function means "**this function is *capable* of being evaluated
at compile time** — if you call it with constant arguments in a context that
demands a constant." It does **not** guarantee compile-time evaluation; it
*permits* it.

```cpp
constexpr int square(int x) { return x * x; }   // C++11

constexpr int a = square(5);   // MUST evaluate at compile time (const-eval context)
int n = read_from_socket();
int b = square(n);             // runtime call — n isn't a constant. Perfectly legal.
```

The same definition serves both worlds. A `constexpr` function is an ordinary
function that *additionally* satisfies the rules to run in a constant
expression. That dual nature is the whole point.

## `const` vs `constexpr` vs `consteval` vs `constinit`

These four keywords confuse everyone; nail the distinction.

| Keyword              | Applies to        | Meaning |
|----------------------|-------------------|---------|
| `const`              | objects           | "won't be modified through this name." Says nothing about *when* the value is known. `const int n = rand();` is fine. |
| `constexpr`          | objects, functions| Object: value known at compile time. Function: *may* run at compile time. |
| `consteval` (C++20)  | functions         | **Immediate function** — *must* run at compile time, every call. A runtime call is an error. |
| `constinit` (C++20)  | static/thread objects | Guarantees *constant initialization* (no dynamic init), killing the static-init-order fiasco. The object is **not** `const`. |

```cpp
const int     c  = compute();      // value can come from runtime
constexpr int ce = 42;             // compile-time constant, also const

consteval int id(int x) { return x; }
constexpr int ok = id(5);          // fine
// int bad = id(runtime_value);    // ERROR: consteval needs a constant

constinit int counter = ce * 2;    // statically initialised, but mutable at runtime
```

> **Mnemonic:** `const` = *read-only*. `constexpr` = *can be compile-time*.
> `consteval` = *must be compile-time*. `constinit` = *compile-time
> initialised, runtime mutable*.

## When does evaluation *actually* happen at compile time?

This is the question seniors get wrong. A `constexpr` function runs at compile
time **only in a *constant-evaluated context*** — otherwise it's an ordinary
runtime call. Contexts that *force* compile-time evaluation:

- Initializing a `constexpr` variable.
- A `static_assert` condition.
- A non-type template argument, array bound, `case` label, `enum` value.
- A `consteval` function's body (transitively).

```cpp
constexpr int f(int x) { return x + 1; }

constexpr int x = f(1);        // compile time (required)
static_assert(f(1) == 2);      // compile time (required)
int arr[f(3)];                 // compile time (array bound)

int y = f(get_runtime());      // runtime
int z = f(2);                  // UNSPECIFIED — compiler MAY fold it, isn't required to
```

That last line is the trap: `int z = f(2);` is *not* a constant-evaluated
context, so the standard doesn't *require* compile-time evaluation — though
every optimizing compiler will constant-fold it at `-O1+`. If you *need* the
guarantee, name a `constexpr` variable or use `consteval` / `std::is_constant_evaluated`.

```cpp
#include <type_traits>
constexpr double area(double r) {
    if (std::is_constant_evaluated())   // C++20 — branch on the context
        return 3.14159265358979 * r * r;   // exact constant for the table
    else
        return fast_runtime_pi() * r * r;  // a cheaper runtime approximation
}
```

> **C++23 note:** `if consteval { ... }` is the cleaner form of the
> `std::is_constant_evaluated()` idiom and avoids its well-known pitfall (you
> must never write `if constexpr (std::is_constant_evaluated())` — it's always
> `true`).

## Requirements relaxed across the standards

What you may write inside a `constexpr` function widened dramatically over time.

| Standard | What became allowed in a `constexpr` function |
|----------|-----------------------------------------------|
| **C++11**| Effectively a single `return` statement. No loops, no local mutation, no `if`/`switch` bodies (use `?:` and recursion). |
| **C++14**| Loops, multiple statements, local variables, mutation of locals, `if`/`switch`. The big unlock. |
| **C++17**| `constexpr` **lambdas**; `if constexpr`; `constexpr` static members inline. |
| **C++20**| `try`/`catch` (no throw at compile time), `virtual` constexpr, `dynamic_cast`/`typeid`, **`new`/`delete`** (must be freed at compile time), and therefore `constexpr` **`std::vector` / `std::string`**. `constexpr` allocation must not "leak" out of constant evaluation. |
| **C++23**| Further relaxations: `constexpr` allowed to contain non-constexpr code on paths not taken, `static constexpr` locals, `goto` lifted, etc. |

A C++14-and-later example that would be illegal in C++11:

```cpp
constexpr unsigned long long factorial(unsigned n) {   // C++14
    unsigned long long r = 1;
    for (unsigned i = 2; i <= n; ++i)   // loop — illegal in C++11
        r *= i;
    return r;
}
static_assert(factorial(10) == 3'628'800);   // computed by the compiler
```

### Constexpr containers (C++20)

Because `new`/`delete` became usable in constant evaluation, `std::vector` and
`std::string` are `constexpr` — *provided every allocation is also freed before
the constant expression ends*. You can compute with a `vector` at compile time,
then materialize a fixed `std::array` to actually store:

```cpp
#include <array>
#include <vector>

constexpr auto build_primes() {            // C++20
    std::vector<int> sieve;                // transient compile-time allocation
    for (int n = 2; n < 50; ++n) {
        bool prime = true;
        for (int p : sieve) if (n % p == 0) { prime = false; break; }
        if (prime) sieve.push_back(n);
    }
    std::array<int, 15> out{};             // freed-by-end storage
    std::copy(sieve.begin(), sieve.end(), out.begin());
    return out;                            // vector destroyed here — OK
}

constexpr auto primes = build_primes();    // baked into the binary
static_assert(primes[0] == 2 && primes[14] == 47);
```

## `constexpr` variables and `static_assert`

A `constexpr` *variable* is a typed, named compile-time constant — strictly
better than a `#define` (it has a type, scope, and respects the language). Pair
it with `static_assert` to validate invariants while the compiler is already
holding the value:

```cpp
constexpr std::size_t kCacheLine = 64;
static_assert(kCacheLine && (kCacheLine & (kCacheLine - 1)) == 0,
              "cache line must be a power of two");   // checked at compile time
```

A failed `static_assert` is a *compile error with your message* — moving a class
of bugs from 03:00 production to your build log.

## Performance & hardware reality

A `constexpr` table that is forced into a constant-evaluated context is emitted
into the binary's read-only data segment (`.rodata`) — the runtime "computes"
nothing; it loads a constant.

```cpp
// Precompute sin() at 256 points; the loop runs in the COMPILER.
constexpr std::array<double, 256> sin_table = [] {     // C++17 constexpr lambda IIFE
    std::array<double, 256> t{};
    for (int i = 0; i < 256; ++i)
        t[i] = /* a constexpr-friendly sin approximation */ poly_sin(i * (2 * 3.14159265 / 256));
    return t;
}();
```

```x86asm
; lookup compiles to a single load from .rodata — no FP unit, no call:
;   lea   rax, [rip + sin_table]
;   movsd xmm0, qword ptr [rax + rdi*8]
```

What you trade: **build time** (the compiler runs your algorithm) and
**binary size** (the table ships in the image). For HFT both are usually a
bargain against a runtime `std::sin` (tens of cycles) or a cold cache miss.

> Caution: a `constexpr`-evaluated `double` can differ in the last ULP from the
> runtime FPU result, because compile-time floating point follows the abstract
> machine, not your `-ffast-math` flags. If exact runtime/compile-time parity
> matters, validate it.

## Quant/HFT relevance & interview gotchas

- **Precomputed tables, zero runtime cost.** Tick-size ladders, scaled-price
  conversion factors (`pow(10, n)`), CRC tables, log/exp curves — compute once
  in `constexpr`, load forever. This is the headline use case.
- **`constexpr` ≠ "runs at compile time."** Be ready to explain that
  `int z = f(2);` is *not* guaranteed compile-time; only a const-eval context
  forces it. Use `consteval` when you must forbid the runtime path entirely
  (e.g. a `format`-string validator, a compile-time hashed symbol id).
- **`consteval` for invariants:** a `consteval` symbol-to-id mapper guarantees
  no string parsing leaks into the hot path.
- **`constinit`** kills the static-initialization-order fiasco for global
  config/lookup objects without making them `const`.
- **The `std::is_constant_evaluated` trap:** inside `if constexpr` it is always
  `true`; use a plain `if` (or C++23 `if consteval`).
- **Floating-point parity:** compile-time FP ignores `-ffast-math`; mention it.

## Key takeaways

1. `constexpr` on a function means *eligible* for compile-time evaluation; the
   same definition still works at runtime.
2. Compile-time evaluation is **guaranteed only in a constant-evaluated
   context** (constexpr-var init, `static_assert`, template arg, array bound).
3. `const` = read-only; `constexpr` = may-be-compile-time; `consteval` =
   *must* be compile-time; `constinit` = const-initialised but mutable.
4. Rules relaxed over time: C++14 added loops/locals, C++17 added constexpr
   lambdas + `if constexpr`, C++20 added `new`/`delete` and constexpr
   `vector`/`string`.
5. Forced-constexpr tables live in `.rodata` — the runtime loads, never
   computes; you trade build time and binary size.
6. Watch the `is_constant_evaluated` pitfall and compile-time FP differences.

## Self-check

1. Why is `int z = square(2);` *not* guaranteed to be evaluated at compile time,
   while `constexpr int z = square(2);` is?
2. Distinguish `const`, `constexpr`, `consteval`, and `constinit` in one
   sentence each.
3. What changed in C++14 that lets you write a `for` loop inside a `constexpr`
   function?
4. How can a `std::vector` be used at compile time in C++20 without "leaking"
   allocation out of the constant expression?
5. What's wrong with `if constexpr (std::is_constant_evaluated())`?
6. When would you reach for `consteval` instead of `constexpr` in a feed
   handler?

## Further reading

- [`constexpr` specifier — cppreference](https://en.cppreference.com/w/cpp/language/constexpr) and [`consteval` — cppreference](https://en.cppreference.com/w/cpp/language/consteval)
- [`constinit` — cppreference](https://en.cppreference.com/w/cpp/language/constinit) and [`std::is_constant_evaluated` — cppreference](https://en.cppreference.com/w/cpp/types/is_constant_evaluated)
- [Constant expressions — cppreference](https://en.cppreference.com/w/cpp/language/constant_expression) — the formal "constant-evaluated context" definition.
- [`if consteval` (C++23) — cppreference](https://en.cppreference.com/w/cpp/language/if)
- Scott Meyers, *Effective Modern C++*, **Item 15** ("Use `constexpr` whenever possible").
- [P0784 — More constexpr containers](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2019/p0784r7.html) — the proposal that brought `new`/`delete` and `vector`/`string` to constexpr.
- [C++ Weekly archive — `constexpr` topics (Jason Turner)](https://www.youtube.com/c/lefticus1) — many short, accurate episodes.

## Videos

- Jason Turner — **"Practical constexpr"** / "constexpr ALL the things!" (CppCon), [search](https://www.youtube.com/results?search_query=CppCon+constexpr+ALL+the+things+Jason+Turner+Ben+Deane).
- David Stone — **"Removing Metaprogramming From C++ Using `constexpr`"** (C++Now / CppCon), [search](https://www.youtube.com/results?search_query=CppCon+constexpr+David+Stone+removing+metaprogramming).
