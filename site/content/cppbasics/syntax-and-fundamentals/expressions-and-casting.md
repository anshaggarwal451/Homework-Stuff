# Expressions and Casting

> **Why a quant dev must own this:** A single sloppy `int`/`unsigned` comparison
> can flip a risk check; a C-style cast can silently turn a `reinterpret_cast`
> into a strict-aliasing landmine that detonates only under `-O2`. Expression
> rules — value categories, integer promotions, the four named casts — are
> where "it compiled" diverges from "it's correct," and they are bread-and-butter
> HFT interview territory.

## First principles: every expression has a type *and* a value category

When the compiler looks at an expression it asks two independent questions:

1. **What type** is the result? (`int`, `double`, `Order&`, …)
2. **What is its value category** — roughly, *does it name an object you can take
   the address of and assign to, or is it a transient value?*

Both feed into a third question — **conversions**: when operands of an operator
have different types, the language reconciles them by a fixed set of promotions
and conversions *before* the operation runs. Most "surprising" C++ behavior is
just these three machineries interacting.

## Value categories (briefly)

C++11 split the old lvalue/rvalue world into three leaves you should be able to
name:

| Category | Has identity (addressable)? | Can be moved from? | Example |
|---|---|---|---|
| **lvalue** | yes | no | a variable `x`, `*ptr`, `arr[i]` |
| **prvalue** | no | yes | `42`, `a + b`, a function returning by value |
| **xvalue** | yes | yes | `std::move(x)`, a function returning `T&&` |

The umbrella terms: **glvalue** = lvalue ∪ xvalue (things with identity);
**rvalue** = prvalue ∪ xvalue (things you can move from). You only need the
intuition here — *lvalues name storage; prvalues are pure values; xvalues are
"about-to-expire" objects you may pillage.* The deep dive belongs to the
move-semantics lesson.

## Integer promotions and the usual arithmetic conversions

Arithmetic in C++ never happens on types narrower than `int`. Before almost any
binary operation, operands undergo:

1. **Integer promotion** — any type smaller than `int` (`char`, `short`,
   `bool`, `uint8_t`, an unscoped enum) is promoted to `int` (or `unsigned int`
   if `int` can't hold all its values).
2. **Usual arithmetic conversions** — the two (now promoted) operands are
   brought to a common type by a ranked set of rules.

```cpp
std::uint8_t a = 200, b = 100;
auto c = a + b;     // a,b promoted to int; c is int = 300 (NOT 44!)

char x = 'A';
auto y = +x;        // y is int (promotion), value 65
```

The promotion of `a + b` to `int` is why `300` doesn't wrap — but assign it back
to a `uint8_t` and it *will* truncate. Knowing the result type is `int` here is a
common interview catch.

## The signed/unsigned mixing trap

When the usual arithmetic conversions meet a signed and an unsigned operand of
the same rank, **the signed one is converted to unsigned**. Negative values wrap
to huge positives:

```cpp
int  i = -1;
unsigned u = 1;
if (i < u)              // FALSE! i converts to 4294967295u, which is > 1
    std::puts("less");

std::vector<int> v;
for (int k = 0; k < v.size() - 1; ++k) { /* ... */ }
// v.size() is size_t (unsigned). For empty v, size()-1 == SIZE_MAX.
// Loop runs ~4 billion times -> out-of-bounds -> crash.
```

This is one of the most dangerous quiet bugs in C++. Defenses:

- Compile with **`-Wsign-conversion -Wsign-compare`** and treat them as errors.
- Use **`std::ssize()`** (C++20) which returns a *signed* size, or `std::cmp_less`
  / `std::cmp_greater` (C++20) for safe cross-sign comparison.
- Pick the type deliberately: indices that can go negative are signed; bit
  patterns and sizes are unsigned — and don't mix them in one expression.

## Implicit conversions

The compiler will insert conversions silently in many places — integer↔floating,
derived→base pointer, array→pointer decay, `0`/`nullptr`→pointer, and
user-defined conversions via non-`explicit` constructors. They're convenient and
also the source of accidental precision loss (`int` ← `double`), narrowing, and
unintended overload selection. `{}`-initialization (previous lesson) and
`explicit` constructors are the tools that rein them in.

## The four named casts

C++ deliberately replaced the C cast with four narrow, greppable, intention-
revealing operators. Each says exactly what kind of conversion you're doing — so
a reviewer (and the compiler) can check it.

```cpp
// 1. static_cast — related-type conversions checked at COMPILE time:
//    numeric conversions, up/down-casts in a hierarchy (no runtime check),
//    void* -> T*, explicit invocation of conversions.
double d = 3.7;
int n = static_cast<int>(d);              // 3, intent explicit

// 2. const_cast — add/remove const/volatile ONLY. Writing through a pointer
//    that strips const off a genuinely-const object is UB.
void legacy(char*);                       // old API, won't touch the data
const char* s = "hi";
legacy(const_cast<char*>(s));             // legal IFF legacy() doesn't write

// 3. reinterpret_cast — reinterpret the bit pattern; no value change, no
//    safety. Almost all uses other than (char*)/(std::byte*) inspection
//    risk strict-aliasing UB.
auto bits = reinterpret_cast<std::uintptr_t>(&n);

// 4. dynamic_cast — runtime-checked down/cross-cast in a POLYMORPHIC
//    hierarchy; returns nullptr (pointer) or throws (reference) on failure.
//    Needs RTTI; has a runtime cost. (Full treatment in its own lesson.)
Base* bp = get();
if (auto* dp = dynamic_cast<Derived*>(bp)) { /* it really was a Derived */ }
```

Each cast is covered in depth in **its own lesson**; here, internalize *which
question each one answers*:

| Cast | Question it answers | Checked? |
|---|---|---|
| `static_cast` | "convert between related types, I know it's valid" | compile time |
| `const_cast` | "change only cv-qualification" | none (UB if you lie) |
| `reinterpret_cast` | "treat these bits as another type" | none |
| `dynamic_cast` | "is this *really* a Derived?" | **run time** (RTTI) |

## The C-style cast: the dangerous union of all four

`(T)expr` is not one thing — the compiler tries, in order: `const_cast`,
`static_cast`, `static_cast`+`const_cast`, `reinterpret_cast`,
`reinterpret_cast`+`const_cast`, and uses the first that compiles.

```cpp
const Order* p = get();
auto* q = (Order*)p;        // silently a const_cast — strips const, you can't tell
auto* r = (Order*)0x1000;   // silently a reinterpret_cast — magic-address aliasing
```

The danger is precisely that *you can't tell which cast you got*, and a refactor
can silently change it from a benign `static_cast` to a `reinterpret_cast` that
breaks aliasing. It's also **un-greppable** — you cannot search for "every
reinterpret in the codebase." This is why HFT (and Google/LLVM/Core-Guidelines)
style **bans C-style casts** outright: named casts are searchable, minimal in
scope, and force you to spell out the dangerous intent.

## `std::bit_cast` — the correct reinterpretation (C++20)

For genuine "reinterpret the bytes" — IEEE-754 hacks, hashing a float,
serialization — `reinterpret_cast` through a pointer is strict-aliasing UB.
`std::bit_cast` does it correctly and `constexpr`:

```cpp
#include <bit>      // C++20
float  f = 1.5f;
auto bits = std::bit_cast<std::uint32_t>(f);   // well-defined; same size required
float back = std::bit_cast<float>(bits);
```

It requires both types to be the same size and trivially copyable, copies the
object representation (no aliasing violation), and on `-O2` compiles to **zero
instructions** when the value is already in the right register. This replaces
both the `reinterpret_cast` hack and the old `memcpy`-into-a-local idiom.

## Sequencing and undefined behavior

The order in which sub-expressions evaluate is mostly *unsequenced*. Modifying an
object more than once, or modifying and reading it, between sequence points is
**undefined behavior**:

```cpp
int i = 0;
i = i++;            // UB (pre-C++17): two unsequenced modifications of i
a[i] = i++;         // UB: read and write of i unsequenced
f(i++, i++);        // UNSPECIFIED order of args (UB pre-C++17 for the i++ overlap)
x = ++x + x++;      // UB
```

C++17 tightened some rules (assignment's RHS is now sequenced before the LHS
store; postfix/`<<`/function-arg evaluation got firmer ordering), but the lesson
is unchanged: **never write code whose correctness depends on evaluation order.**
Don't memorize the table — write expressions with at most one side effect.

## A glimpse of the machine

```cpp
// C++20. g++ -O2 -S -masm=intel
#include <bit>
std::uint32_t float_to_bits(float f) {
    return std::bit_cast<std::uint32_t>(f);
}
```

```x86asm
float_to_bits(float):
        movd    eax, xmm0       ; just move the bits from the FP reg to GPR
        ret
```

No conversion, no memory round-trip — the "cast" is a register move. Contrast
with `static_cast<uint32_t>(f)` which would emit a `cvttss2si` (a *value*
conversion, truncating 1.5f to 1). Same syntax shape, completely different
machine semantics: that's the whole point of distinguishing the casts.

## Performance & hardware reality

- **`static_cast` numeric conversions cost what the math costs** (`cvtsi2sd`,
  `cvttss2si`, sign/zero extension). `reinterpret_cast`/`bit_cast` of
  same-size types are typically free.
- **`dynamic_cast` has real runtime cost**: it walks RTTI structures and can be
  tens of nanoseconds — *never* on the hot path. Prefer a type tag, `std::variant`,
  or a virtual call.
- **Sign-conversion and promotion can defeat vectorization or insert extra
  extends** in tight loops; keeping a loop in one consistent integer type helps
  the optimizer.
- **Strict aliasing** (`-fstrict-aliasing`, on at `-O2`) lets the optimizer
  assume differently-typed pointers don't overlap. A `reinterpret_cast` that
  lies about this produces code that's *correct at `-O0` and wrong at `-O2`* —
  the worst failure mode. `bit_cast`/`memcpy` sidestep it.

## Quant/HFT relevance & interview gotchas

- **`for (int i = 0; i < v.size() - 1; ...)`** on an empty vector — the unsigned
  underflow loop. Be able to spot and fix it (`std::ssize`, `cmp_less`).
- **"What's the type of `uint8_t + uint8_t`?"** `int`, via integer promotion.
- **"`i = i++;` — defined?"** UB before C++17; still terrible style. Know why.
- **"Why are C-style casts banned here?"** Ungreppable; silently pick
  `reinterpret_cast`/`const_cast`; a refactor can change which. Named casts are
  searchable and minimal.
- **"Reinterpret a `float` as bits — safely?"** `std::bit_cast` (C++20), not
  `reinterpret_cast` (aliasing UB).
- **"Cost of `dynamic_cast`?"** RTTI walk, not for hot paths; design it out.

## Key takeaways

1. Every expression has a **type** and a **value category** (lvalue / prvalue /
   xvalue); conversions reconcile mismatched operand types.
2. **Integer promotions** lift sub-`int` operands to `int`; the **usual
   arithmetic conversions** then find a common type — `uint8_t + uint8_t` is
   `int`.
3. **Signed/unsigned mixing** converts the signed operand to unsigned and wraps —
   a silent, dangerous bug. Use `-Wsign-conversion`, `ssize`, `cmp_*`.
4. Use the **four named casts** for intent and checkability; `dynamic_cast` is
   the only one with a runtime check (and a runtime cost).
5. **C-style casts are banned** in serious codebases because they hide which cast
   you got and aren't greppable.
6. Use **`std::bit_cast`** (C++20) for byte-reinterpretation; never depend on
   **evaluation order** (`i = i++` is UB).

## Self-check

1. What is the type and value of `a + b` where `a` and `b` are `uint8_t{200}`
   and `uint8_t{100}`? Why?
2. Explain precisely why `for (int i = 0; i < v.size() - 1; ++i)` is dangerous
   for an empty `std::vector`.
3. Which of the four named casts can `(Foo*)bar` silently expand to, and why is
   that a problem?
4. Why is `reinterpret_cast<uint32_t&>(myFloat)` undefined behavior, and what's
   the correct alternative?
5. Name the three value categories and which can be moved from.
6. Is `f(i++, i++)` well-defined in C++17? Should you ever write it?

## Further reading

- [Value categories — cppreference](https://en.cppreference.com/w/cpp/language/value_category)
- [Implicit conversions (incl. integer promotions & usual arithmetic conversions) — cppreference](https://en.cppreference.com/w/cpp/language/implicit_conversion)
- [`static_cast`](https://en.cppreference.com/w/cpp/language/static_cast) · [`reinterpret_cast`](https://en.cppreference.com/w/cpp/language/reinterpret_cast) · [`const_cast`](https://en.cppreference.com/w/cpp/language/const_cast) · [`dynamic_cast`](https://en.cppreference.com/w/cpp/language/dynamic_cast) — cppreference
- [`std::bit_cast` — cppreference](https://en.cppreference.com/w/cpp/numeric/bit_cast) and [integer comparison functions `std::cmp_less` …](https://en.cppreference.com/w/cpp/utility/intcmp)
- [Order of evaluation — cppreference](https://en.cppreference.com/w/cpp/language/eval_order)
- [C++ Core Guidelines: ES.48–ES.49 (avoid casts / use named casts)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#es48-avoid-casts)
- [What is the strict aliasing rule? — Stack Overflow canonical](https://stackoverflow.com/questions/98650/what-is-the-strict-aliasing-rule)

## Videos

- Dan Saks, CppCon/embedded talks — **"unsigned: A Guideline for Better Code" / signed-vs-unsigned** ([search](https://www.youtube.com/results?search_query=Dan+Saks+unsigned+signed+C%2B%2B)).
- Timur Doumler, CppCon — **"Type punning in modern C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+type+punning+in+modern+C%2B%2B)).
- Ben Saks, CppCon — **"Back to Basics: Type Conversions"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Type+Conversions)).
