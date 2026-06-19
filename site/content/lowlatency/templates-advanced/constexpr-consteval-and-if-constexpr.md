# constexpr, consteval, and if constexpr

> **Why a quant dev must own this:** The cheapest instruction is the one that
> never executes at run time. `constexpr` and friends are the language tools for
> *shoving work into the compiler* — building lookup tables, parsing tables,
> protocol field maps, and CRC polynomials at build time so the hot path just
> *reads a baked-in answer*. Done well, a market-data decoder spends zero cycles
> computing what could have been a `static constexpr` array. Done badly, you
> silently pay that cost on every message. Interviewers probe this to see if you
> understand *when* code runs, not just *what* it does.

These keywords span standards: `constexpr` functions are **C++11**, relaxed in
**C++14**; `if constexpr` and `constexpr` lambdas are **C++17**; `consteval`,
`constinit`, and `constexpr`-friendly `std::vector`/`std::string` are **C++20**;
`constexpr std::vector` actually usable and more `<algorithm>`/`<cmath>` is
**C++23**. Each block below states what it needs.

## The mental model: three axes

People conflate three separate questions. Keep them apart:

```text
keyword       guarantees                         when it runs
------------  ---------------------------------  -----------------------------------
constexpr     *can* run at compile time          compile time IF the inputs are
  (function)  (and may run at run time too)      constant expressions; else run time
constexpr     value is a constant expression     value fixed at compile time
  (variable)
consteval     MUST run at compile time           always compile time (it's an error
  (function)  ("immediate function", C++20)      to call it where that's impossible)
constinit     guaranteed CONSTANT INITIALIZATION compile-time *init*; the object is
  (C++20)     (no dynamic init), but mutable     still a normal runtime variable
```

The crucial nuance: **`constexpr` on a function is a *permission*, not a
*command*.** It says "this function is *eligible* to run at compile time." Whether
it actually does depends on the *call site* having constant inputs.

## `constexpr` functions

A `constexpr` function can be evaluated by the compiler when called with constant
arguments, producing a value usable wherever the language demands a *constant
expression* (array sizes, template arguments, `case` labels, other `constexpr`
initializers). Called with runtime arguments, the *same function* simply runs at
run time.

```cpp
// C++14: loops, locals, multiple statements are allowed in a constexpr function.
constexpr unsigned ipow(unsigned base, unsigned exp) {
    unsigned r = 1;
    while (exp--) r *= base;        // ordinary imperative code
    return r;
}

constexpr unsigned k = ipow(10, 4);   // evaluated AT COMPILE TIME -> 10000, baked in
int n = read_int();
unsigned m = ipow(10, n);             // SAME function, run at RUN TIME (n isn't constant)

static_assert(ipow(2, 10) == 1024);   // forces compile-time eval; classic test
```

> **Interview gotcha:** "Does `constexpr` guarantee compile-time evaluation?"
> **No.** Only its use in a *constant-expression context* (or via `consteval`,
> below) forces it. `constexpr int x = f();` and `static_assert`/array-bounds do
> force it; assigning to a plain runtime variable does not. If you *need* the
> guarantee, name the result `constexpr` or wrap it.

A `constexpr` function must still be *valid* as a constant expression for at
least one argument set, and it can't do things the constant evaluator forbids
(no `reinterpret_cast`, no calling non-`constexpr` functions in the evaluated
path, no UB — which is actually a feature: **constant evaluation diagnoses UB at
compile time**).

## `constexpr` variables

A `constexpr` variable's initializer *must* be a constant expression, and the
variable is `const`. This is how you bake a value or, more usefully, a *table*:

```cpp
constexpr double kTickSize = 0.01;        // a compile-time constant
constexpr int    kMaxLevels = 32;

int book[kMaxLevels];                       // legal: array bound is a constant expr
```

`constexpr` implies `const` and (for namespace-scope variables) `inline` in
C++17, so a `constexpr` in a header is ODR-safe across translation units.

## `consteval` — immediate functions (C++20)

`consteval` is the *command* version: an **immediate function** that *must* be
evaluated at compile time. Every call to it is itself a constant expression; if
the compiler can't evaluate it at compile time, that's a hard error. Use it when
"this must never cost a runtime cycle" is a correctness requirement, not a hope.

```cpp
// C++20
consteval std::uint32_t fnv1a(const char* s) {     // compile-time-only hash
    std::uint32_t h = 2166136261u;
    while (*s) { h ^= static_cast<std::uint8_t>(*s++); h *= 16777619u; }
    return h;
}

constexpr auto kOrderTopic = fnv1a("ORDERS");   // OK: computed by the compiler

int main(int argc, char** argv) {
    // auto bad = fnv1a(argv[1]);   // ERROR: argv[1] isn't a constant expression.
    static_assert(fnv1a("ORDERS") == kOrderTopic);
}
```

> **`constexpr` vs `consteval` in one line:** `constexpr` = *may* run at compile
> time; `consteval` = *must*. Reach for `consteval` for things like compile-time
> string hashing, unit/dimension checks, or building a value you never want
> accidentally computed at runtime.

## `constinit` — guaranteed static initialization, but mutable (C++20)

`constinit` asserts that a variable with static (or thread) storage duration is
**constant-initialized** — no dynamic initialization at startup. It does *not*
make the variable `const`; you can still mutate it. It exists to kill the
**static initialization order fiasco** and the hidden run-time init of globals.

```cpp
// C++20
constinit int  g_counter = 0;             // initialized at compile time; mutable
constinit auto g_table   = build_table(); // ERROR unless build_table() is constexpr

void hit() { ++g_counter; }               // fine: constinit != const
```

Contrast:

```text
const       : value can't change after init; says nothing about WHEN it's init'd
constexpr   : value is a constant expression AND the object is const
constinit   : object is init'd at compile time (no dynamic init) BUT remains mutable
```

For thread-local fast paths, `constinit thread_local` guarantees the TLS slot is
constant-initialized — no first-use guard, no hidden `__cxa_guard_acquire`.

## `if constexpr` — compile-time branching (C++17)

`if constexpr (cond)` evaluates `cond` at compile time and **discards the
not-taken branch entirely** — it isn't compiled for that instantiation. Two
consequences:

1. There is **no runtime branch** — the surviving code is emitted inline.
2. The discarded branch needn't even be *valid* for the current type. This is
   what makes it the modern replacement for tag dispatch / `enable_if` in a single
   function body.

```cpp
#include <type_traits>
#include <cstring>

template <class T>
T load_field(const std::byte* p) {
    T v;
    std::memcpy(&v, p, sizeof v);                 // copy raw bytes
    if constexpr (sizeof(T) > 1) {                // discarded for 1-byte T
        v = byteswap_to_native(v);                // not even compiled when sizeof==1
    }
    return v;
}
```

Compare with a plain `if`: a runtime `if (sizeof(T) > 1)` would (a) require the
inner code to compile for *all* `T` and (b) leave a branch the optimizer must
prove away. `if constexpr` removes both problems by construction. (Modern
compilers often *do* fold a `constexpr`-known plain `if`, but `if constexpr` is
the guarantee and is required when the dead branch is ill-formed.)

## `constexpr` containers (C++20 / C++23)

C++20 made `std::vector` and `std::string` usable inside constant evaluation
(transient allocation: you may `new`/`delete` during evaluation as long as
nothing escapes). C++23 broadened the constexpr `<algorithm>`/`<cmath>` surface.
This lets you *compute* a table with full STL machinery and then freeze the
result:

```cpp
// C++20: build a 256-entry parity table at COMPILE TIME, store as a constexpr array.
#include <array>
#include <cstdint>

consteval std::array<std::uint8_t, 256> make_parity() {
    std::array<std::uint8_t, 256> t{};
    for (int i = 0; i < 256; ++i) {
        std::uint8_t p = 0, x = static_cast<std::uint8_t>(i);
        while (x) { p ^= 1; x &= x - 1; }     // count bits mod 2 (Kernighan)
        t[i] = p;
    }
    return t;
}

inline constexpr auto kParity = make_parity();   // 256 bytes baked into .rodata

bool odd_parity(std::uint8_t b) { return kParity[b]; }   // hot path: one load, no compute
```

The loop, the bit-twiddling, all of it runs in the compiler. The binary ships
256 bytes of read-only data; `odd_parity` becomes a single indexed load. **Note:**
a `std::vector` built during constant evaluation must *not* survive to runtime in
C++20 — to persist it, copy into a fixed-size `std::array` as above (or use C++23
facilities where the result is genuinely a `constexpr std::vector`).

## Moving work to compile time for HFT

The pattern that pays off again and again:

```text
                 RUN-TIME version                COMPILE-TIME version
               ------------------------------   ------------------------------
build table    first-use init, branch guard,    consteval -> static constexpr
               cache-cold, races on init        array in .rodata; warm, shared
hot-path use   compute or branch each call      single indexed load
binary         smaller .rodata, bigger .text    bigger .rodata, smaller .text
```

Concrete HFT uses:

- **Lookup tables:** CRC/checksum tables, parity, `log`/`exp` approximations,
  scaled-price <-> integer conversions, bitcount tables. Build with `consteval`,
  store as `constexpr std::array`.
- **Parsing / dispatch tables:** map a fixed-width message-type byte to a handler
  index at compile time. A `constexpr` perfect-hash or a 256-entry jump table
  beats a chain of `if`s and is branch-predictor-friendly.
- **Protocol field offsets:** compute `(offset, size)` for each field of a binary
  exchange message once, at compile time, and index it.
- **String tags:** `consteval` hashing of topic/symbol literals so switches over
  symbols compile to integer comparisons (see `fnv1a` above).
- **Dimensional / unit checks:** validate that a price*qty computation has the
  right scaled units at compile time, zero runtime cost.

```cpp
// Compile-time price scaling: exchange sends prices scaled by 10^decimals.
template <int Decimals>
constexpr std::int64_t scale(double px) {
    constexpr std::int64_t mult = ipow(10, Decimals);   // folded to a constant
    return static_cast<std::int64_t>(px * mult + 0.5);
}
// scale<4>(123.4567) -> the '* 10000' is a literal in the emitted code.
```

## What the compiler emits

For `odd_parity`, the table is `.rodata` and the function is a single load:

```x86asm
; bool odd_parity(uint8_t b)
;   kParity is a 256-byte constexpr array placed in read-only data at link time.
        movzx   eax, dil                ; zero-extend the byte index
        movzx   eax, byte ptr [kParity + rax]   ; one indexed load — no loop, no compute
        ret
```

The bit-counting loop from `make_parity` appears *nowhere* in the binary — it ran
in the compiler. Contrast a runtime table builder: you'd see the loop in `.text`,
a guard variable, and a branch on first use.

## Pitfalls and gotchas

- **`constexpr` doesn't *force* compile-time eval.** Only constant-expression
  *contexts* (or `consteval`) do. Assigning to a runtime variable lets it run at
  run time. Use `static_assert` / a `constexpr` result to pin it.
- **Floating-point at compile time may differ subtly** from runtime (rounding
  modes, contraction). Usually fine; be wary for bit-exact reproducibility.
- **Code bloat / build time.** Heavy `constexpr` computation moves cost from
  runtime to *build* time and can inflate `.rodata`. It's a trade, not free.
- **Transient allocation rule (C++20):** containers allocated during constant
  evaluation can't leak to runtime; materialize into a fixed array.
- **`consteval` is contagious at the call site:** anything that forwards an
  argument into a `consteval` call must itself supply a constant — common surprise
  when wrapping. (C++23's `if consteval` and relaxed rules ease some of this.)
- **`constinit` is not `const`.** It's about *init time*, not immutability.

## Quant/HFT relevance & interview gotchas

- **"How do you build a 256-entry CRC table with no runtime cost?"** — `consteval`
  builder returning `std::array`, stored as `inline constexpr`. Know this cold.
- **`constexpr` vs `consteval` vs `constinit`** — the *may / must / init-time*
  distinction is the single most-asked C++20 question in this area.
- **`if constexpr` vs runtime `if`** — explain that the dead branch isn't compiled,
  so it can be ill-formed for the current type, and there's no branch to mispredict.
- **Static init order fiasco** — `constinit` is the modern fix for "global A
  depends on global B"; be ready to name it.
- **UB caught at compile time** — a genuinely nice property: constant evaluation
  rejects signed overflow, OOB access, etc. Mention it.
- **Don't over-`constexpr`.** Marking everything `constexpr` for taste, when
  nothing forces compile-time eval, gains nothing and can hurt build times.

## Key takeaways

1. **`constexpr` function = permission**, evaluated at compile time *only in a
   constant-expression context*, otherwise at run time. **`constexpr` variable**
   freezes a constant.
2. **`consteval` = command** (immediate function): always compile-time, error if
   it can't be. Use when zero runtime cost is a requirement.
3. **`constinit` (C++20)** guarantees constant *initialization* (no dynamic init,
   no init-order fiasco) but the object stays mutable — it is *not* `const`.
4. **`if constexpr` (C++17)** discards the untaken branch at compile time: no
   runtime branch, and the dead branch needn't be valid for the current type.
5. **Constexpr containers (C++20/23)** let you compute tables with full STL, then
   freeze results into `constexpr std::array` for the hot path.
6. The HFT payoff is **lookup/parsing/dispatch tables built at compile time** —
   the hot path does a single indexed load instead of recomputing or branching.

## Self-check

1. Does `constexpr int n = f(x);` guarantee `f` runs at compile time? Does
   `int n = f(x);`? What's the difference?
2. Convert `make_parity` to `consteval` vs `constexpr` — when does the choice
   actually matter?
3. Why can the discarded branch of `if constexpr` be ill-formed, while the
   not-taken branch of a runtime `if` cannot?
4. What does `constinit` give you that `const` and `constexpr` don't? Give a
   concrete bug it prevents.
5. You build a `std::vector` inside a `consteval` function in C++20. Why can't you
   return it for runtime use, and what do you do instead?
6. Name two HFT lookup/parsing tables you'd build at compile time, and the
   storage type you'd freeze each into.

## Further reading

- [`constexpr` specifier — cppreference](https://en.cppreference.com/w/cpp/language/constexpr).
- [`consteval` / immediate functions — cppreference](https://en.cppreference.com/w/cpp/language/consteval) and [`constinit` — cppreference](https://en.cppreference.com/w/cpp/language/constinit).
- [`if constexpr` — cppreference](https://en.cppreference.com/w/cpp/language/if#Constexpr_if).
- [Constant expressions — cppreference](https://en.cppreference.com/w/cpp/language/constant_expression) — the precise rules for what is constant-evaluable.
- Barry Revzin, ["constexpr ALL the things"](https://www.youtube.com/results?search_query=Barry+Revzin+Jason+Turner+constexpr+all+the+things+CppCon) — building real data structures at compile time.
- [Modernes C++ — constexpr / consteval / constinit](https://www.modernescpp.com/index.php/constexpr-and-consteval-functions/) — concise C++20 walkthroughs.
- Vandevoorde, Josuttis & Gregor, *C++ Templates: The Complete Guide* (2nd ed.) — compile-time programming chapters.

## Videos

- Jason Turner & Ben Deane, CppCon — **"constexpr ALL the things!"** ([search](https://www.youtube.com/results?search_query=CppCon+constexpr+all+the+things+Jason+Turner+Ben+Deane)) — the definitive deep dive on moving work to compile time.
- Jason Turner, **C++ Weekly** — **"`consteval` and `constinit`"** and **"`if constexpr`"** episodes ([search](https://www.youtube.com/results?search_query=C%2B%2B+Weekly+consteval+constinit+if+constexpr)).
- David Gross, Meeting C++ — **"Trading at light speed"** ([search](https://www.youtube.com/results?search_query=David+Gross+Trading+at+light+speed)) — real HFT examples of pushing work off the hot path.
