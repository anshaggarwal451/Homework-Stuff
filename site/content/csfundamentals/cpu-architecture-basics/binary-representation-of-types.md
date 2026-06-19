# Binary Representation of Types

> **Why a quant dev must own this:** Prices, sizes, timestamps and PnL all live
> as bit patterns, and the gap between what you *think* a value means and what
> the CPU *stores* is where money leaks. *Signed-overflow UB can delete your
> bounds check; an implicit `int` promotion can flip a comparison; a naive
> `float` equality can reject a fill.* Knowing exactly how two's complement and
> IEEE-754 lay out in memory — and how C++ silently converts between types — is
> table stakes for both correctness and the interview.

## The foundation: an object is its bytes

Every object in C++ has an **object representation**: the sequence of
`sizeof(T)` bytes that physically store it. For the arithmetic types, the
standard (since C++20 it's mandated) interpretation is:

- **Unsigned integers**: pure binary, value = sum of set bits' weights. They
  *never* overflow in the UB sense — they wrap modulo `2^N`.
- **Signed integers**: **two's complement** (guaranteed since C++20; was merely
  near-universal before).
- **Floating point**: **IEEE-754** binary32 (`float`) / binary64 (`double`) on
  every platform you'll meet.

You can always inspect those bytes through a `char`/`unsigned char`/`std::byte`
pointer — the one blessed aliasing exception (the same trick used in the
endianness lesson). The *byte order* of those bytes is endianness; the *meaning*
of the bits is what this lesson is about.

## Two's complement: one representation, free arithmetic

For an *N*-bit signed integer, the top bit has weight `-2^(N-1)` and the rest are
positive. So an `int8_t`:

```text
bit:     7   6   5   4   3   2   1   0
weight: -128 64  32  16  8   4   2   1
```

- `0b00000001` = `1`
- `0b01111111` = `127`  (largest)
- `0b10000000` = `-128` (smallest: only the sign weight)
- `0b11111111` = `-1`   (`-128 + 127`)

To negate: **invert all bits and add one** (`-x == ~x + 1`). The killer feature:
the *same* adder hardware handles signed and unsigned addition — there's no
separate "signed add" circuit. `0xFF + 0x01 = 0x00` whether you call it
`-1 + 1 = 0` or `255 + 1 = 256 mod 256 = 0`.

Why two's complement won over sign-magnitude and one's complement:

| Scheme | Zero | `-x` cost | Add hardware |
|--------|------|-----------|--------------|
| Sign-magnitude | **two** zeros (+0, -0) | flip sign bit | needs sign handling |
| One's complement | **two** zeros | invert bits | end-around carry |
| **Two's complement** | **one** zero | invert + 1 | plain binary adder |

One zero, one adder, contiguous range. That's why it's universal — and why
`INT_MIN` is special: `-INT_MIN` overflows (there's no `+2^(N-1)`), which is
itself UB for signed types.

## Signed overflow is UB; unsigned wraps

This is the distinction interviewers love.

```cpp
unsigned u = 0xFFFFFFFFu;
u + 1;          // == 0, fully defined: wraps mod 2^32

int i = INT_MAX;
i + 1;          // UNDEFINED BEHAVIOUR — not "wraps to INT_MIN"
```

Signed overflow being UB is not pedantry — the optimizer *relies* on it. The
compiler may assume `i + 1 > i` is always true and delete a loop's bounds check,
or assume `x * 2 / 2 == x`. Real CVEs have come from a signed overflow check
that the compiler proved "can never fire" and removed. Tools: build with
`-fsanitize=undefined` to catch it, or use `-ftrapv`/`-fwrapv` to change the
policy (the latter forces wraparound, costing the optimizations).

> **Interview soundbite:** "Unsigned arithmetic is modular and well-defined;
> signed overflow is undefined behaviour the optimizer exploits. Never write a
> bounds check that depends on signed overflow wrapping."

## Integer widths: stop using `int`, use `<cstdint>`

`int`, `long`, etc. have *minimum* widths but platform-dependent actual sizes
(`long` is 64-bit on Linux/macOS, 32-bit on Windows — the LP64 vs LLP64 split).
For anything touching a wire format, a price, an ID, or a timestamp, name the
width:

```cpp
#include <cstdint>
int8_t  / uint8_t      //  8-bit
int16_t / uint16_t     // 16-bit
int32_t / uint32_t     // 32-bit
int64_t / uint64_t     // 64-bit  (e.g. nanosecond timestamps, order IDs)
int_fast32_t, int_least16_t   // "at least / fastest at least" variants
intptr_t, uintptr_t           // integer wide enough to hold a pointer
std::size_t                   // unsigned, result of sizeof; index/size type
std::ptrdiff_t                // signed pointer difference
```

`uint8_t` is almost always `unsigned char`, so beware: streaming it to
`std::cout` prints a character, not a number — cast to `unsigned` or `int`
first.

## The conversion minefield: promotion and implicit conversions

C++ silently converts operands of arithmetic operators. The two rules that bite:

**1. Integer promotion.** Any integer type *narrower than `int`* (`char`,
`short`, `bool`, `uint8_t`, `uint16_t`, bitfields) is promoted to `int` (or
`unsigned int`) before arithmetic. So:

```cpp
uint8_t a = 200, b = 100;
auto c = a + b;     // c is `int` == 300, NOT 44! both promoted to int
uint8_t d = a + b;  // now truncated back to 8 bits: 44
```

A subtler one — `~` and `<<` on small unsigned types operate after promotion to
*signed* `int`, which can produce surprising values and even UB:

```cpp
uint16_t x = 0xFFFF;
auto y = ~x;        // x promotes to int 0x0000FFFF, ~ gives int 0xFFFF0000 = -65536
```

**2. Usual arithmetic conversions / signed-unsigned mixing.** When signed and
unsigned of the same rank meet, the **signed operand converts to unsigned**.
This produces the infamous bug:

```cpp
int   i = -1;
unsigned u = 1;
if (i < u)          // FALSE! i converts to unsigned 0xFFFFFFFF == 4294967295
    /* not taken */;

for (size_t n = vec.size(); i >= 0 && something; ...) // size_t is unsigned!
// for (size_t k = vec.size() - 1; k >= 0; --k)  // INFINITE LOOP — k is unsigned
```

> **Interview gotcha:** `-1 < 1u` is **false**. Always be suspicious of any
> comparison or subtraction that mixes signed and unsigned. Turn on
> `-Wsign-compare` / `-Wconversion`. In C++20, `std::cmp_less`, `std::cmp_equal`
> et al. compare integers by *value* regardless of signedness — the correct
> fix.

```cpp
#include <utility>           // C++20
int i = -1; unsigned u = 1;
std::cmp_less(i, u);         // true — value comparison, no surprise conversion
```

## IEEE-754: how floats really look

A `float` (binary32) and `double` (binary64) split their bits into three fields:

```text
 float (32-bit):
 [ s ][   exponent (8)  ][        mantissa / fraction (23)         ]
  31    30 .......... 23  22 ................................... 0

 double (64-bit):
 [ s ][    exponent (11)     ][        mantissa (52)              ]
  63    62 ............... 52  51 ............................... 0
```

| | `float` | `double` |
|---|---------|----------|
| Total bits | 32 | 64 |
| Sign | 1 | 1 |
| Exponent | 8 (bias 127) | 11 (bias 1023) |
| Mantissa | 23 (+1 hidden) | 52 (+1 hidden) |
| Approx decimal digits | ~7 | ~15-16 |

Value of a normal number = `(-1)^s * 1.fraction * 2^(exponent - bias)`. The
leading `1.` is **implicit** (the "hidden bit") — normalized numbers always have
it, so it isn't stored, buying one extra bit of precision.

Worked example, `0.15625f`:

```text
0.15625 = 1.25 * 2^-3
 sign = 0
 exponent = -3 + 127 = 124 = 0b01111100
 mantissa: 1.25 -> fraction .25 -> 0b010000...0
 bits: 0 01111100 01000000000000000000000  = 0x3E200000
```

### Special values

The exponent field's all-zero and all-one patterns are reserved:

| Exponent | Mantissa | Meaning |
|----------|----------|---------|
| all zeros | zero | **±0** (yes, signed zero: `+0.0 == -0.0` but bits differ) |
| all zeros | non-zero | **subnormal** (denormal) — gradual underflow, no hidden bit |
| all ones | zero | **±Infinity** |
| all ones | non-zero | **NaN** (quiet or signaling) |

NaN is contagious and *unordered*: `NaN == NaN` is **false**, and so is
`NaN < x`, `NaN > x`, `NaN <= x` — every comparison with NaN is false except
`!=`. `std::isnan`, `std::isinf` test them. Subnormals fill the gap around zero
but historically incur a large slowdown on some hardware (denormals handled by
microcode) — HFT code often sets the FPU to **flush-to-zero / denormals-are-zero
(FTZ/DAZ)** to avoid that latency cliff.

### Float comparison pitfalls

```cpp
0.1 + 0.2 == 0.3;          // FALSE — neither 0.1 nor 0.3 is exactly representable
```

Never compare floats for exact equality after arithmetic. Compare with a
tolerance — but choosing it correctly needs care (absolute epsilon fails for
large magnitudes; relative epsilon fails near zero):

```cpp
#include <cmath>
#include <algorithm>
bool nearly_equal(double a, double b, double rel = 1e-9, double abs = 1e-12) {
    double diff = std::fabs(a - b);
    if (diff <= abs) return true;                       // handles near-zero
    return diff <= rel * std::max(std::fabs(a), std::fabs(b));
}
```

> **Quant reality:** because binary floats can't represent decimal prices like
> `100.07` exactly, many trading systems store prices as **scaled integers**
> (e.g. price * 10^4 as an `int64_t`) and only convert to floating point at the
> edges. This sidesteps comparison and accumulation error entirely.

## `std::bit_cast`: reinterpret bits without UB (C++20)

To view a `double`'s bits as a `uint64_t` (to byte-swap it, hash it, or print
the layout), do **not** use a `reinterpret_cast` (strict-aliasing UB) or a union
(reading an inactive member is UB in C++). Use `std::bit_cast`:

```cpp
#include <bit>
#include <cstdint>
#include <cstdio>

void show(double d) {
    uint64_t bits = std::bit_cast<uint64_t>(d);   // same size, trivially copyable
    int sign = bits >> 63;
    int exp  = (bits >> 52) & 0x7FF;
    uint64_t mant = bits & ((uint64_t{1} << 52) - 1);
    std::printf("sign=%d exp=%d (unbiased %d) mant=0x%013llx\n",
                sign, exp, exp - 1023, (unsigned long long)mant);
}
```

`std::bit_cast<To>(from)` requires `sizeof(To) == sizeof(From)` and both
trivially copyable; it's `constexpr` and compiles to a register move (or
nothing). Before C++20 the correct tool was `std::memcpy` into the target type.

## sizeof, alignof, and struct padding

Every type has a **size** (`sizeof`, in bytes — `sizeof(char) == 1` by
definition) and an **alignment** (`alignof`, the address multiple it must sit
on). Hardware requires/prefers naturally-aligned accesses; the compiler inserts
**padding** to satisfy member alignment and to make arrays of the struct keep
alignment:

```cpp
struct Bad {     // sizeof == 24 on x86-64
    char     a;  // offset 0
    // 7 bytes padding
    double   b;  // offset 8 (needs 8-byte alignment)
    char     c;  // offset 16
    // 7 bytes padding (so sizeof is a multiple of alignof==8)
};

struct Good {    // sizeof == 16 — same fields, reordered largest-first
    double   b;  // offset 0
    char     a;  // offset 8
    char     c;  // offset 9
    // 6 bytes tail padding
};
```

Rule of thumb: **order members from largest to smallest** to minimise padding.
Use `alignas(N)` to over-align (e.g. `alignas(64)` to put a hot struct on its
own cache line and avoid false sharing). The 64-byte cache line is the unit the
hardware moves between memory and the core — packing hot fields into one line is
a recurring low-latency theme (covered in the cache-hierarchy lesson). Inspect
layout with `offsetof`, `sizeof`, `alignof`, or `-Wpadded`.

Padding bytes hold **indeterminate values**, which is exactly why you must never
`memcmp` two structs for equality (padding may differ) and never blast a struct
onto the wire (padding + endianness + width — same three sins from the
endianness lesson).

## Quant/HFT relevance & interview gotchas

- **Scaled integers for prices.** Floats can't represent `0.01` exactly; use
  `int64_t` ticks and convert at the boundary. Be ready to defend this in
  interview.
- **Fixed widths everywhere.** `int64_t` nanosecond timestamps, `uint32_t`
  order IDs — never `long` (size varies by platform/ABI).
- **Signed/unsigned comparison bugs** in size/index loops are perennial:
  `vec.size()` is `size_t` (unsigned). `std::cmp_*` / `std::ssize` (C++20) are
  the modern fixes.
- **Signed overflow UB** can silently delete bounds checks — a correctness *and*
  security issue. `-fsanitize=undefined` in CI.
- **NaN poisons comparisons and sorts.** A NaN in a price feed makes
  `std::sort` violate its strict-weak-ordering contract -> UB. Filter NaNs at
  ingest; know that `x != x` is the canonical NaN test.
- **FTZ/DAZ** to dodge the subnormal latency cliff in pricing math.
- **Struct layout** affects both cache behaviour (hot fields per line) and wire
  parsing (never trust padding). `std::bit_cast` is the UB-free way to view bits.
- **Frequent asks:** "represent -1 in 8-bit two's complement" (`0xFF`); "what is
  `INT_MIN`/`-INT_MIN`" (the latter is UB); "why is `0.1 + 0.2 != 0.3`"; "lay
  out a `float` for 1.0" (`0x3F800000`); "is `-1 < 1u`?" (no).

## Key takeaways

1. Signed integers are **two's complement** (C++20-guaranteed): top bit has
   weight `-2^(N-1)`, `-x == ~x + 1`, one zero, one adder.
2. **Unsigned wraps** (mod `2^N`, defined); **signed overflow is UB** the
   optimizer exploits. Sanitize it; don't lean on it.
3. Use `<cstdint>` fixed widths; beware **integer promotion to `int`** and the
   **signed→unsigned** conversion that makes `-1 < 1u` false. Fix with
   `std::cmp_*` and `-Wconversion`.
4. IEEE-754: sign / biased exponent / mantissa with a hidden leading 1. Know
   the special-value encodings; **never `==` floats after arithmetic**; NaN is
   unordered (`x != x`); watch subnormals (FTZ/DAZ).
5. `std::bit_cast` (or `memcpy`) reinterprets bits without UB. `sizeof` is bytes,
   `alignof` drives **padding**; order members large→small; never `memcmp` or
   wire-serialize raw structs.

## Self-check

1. Write the 8-bit two's-complement bit patterns for `-1`, `-128`, and `127`.
   Why is `-(-128)` undefined for `int8_t` arithmetic?
2. What does `(uint8_t)200 + (uint8_t)100` evaluate to and what is its type, and
   why? What about assigning the result back to a `uint8_t`?
3. Is `-1 < 1u` true or false? Explain the conversion, and give the C++20 fix.
4. Decode the `float` bits `0x3F800000` and `0xFF800000`.
5. Why is `0.1 + 0.2 == 0.3` false, and what's a robust way to compare? Why do
   many trading systems store prices as integers instead?
6. Reorder `struct Bad { char a; double b; char c; };` to shrink it, and state
   its new `sizeof`. Why must you never `memcmp` it?

## Further reading

- [Fundamental types — cppreference](https://en.cppreference.com/w/cpp/language/types) and [fixed-width integers `<cstdint>`](https://en.cppreference.com/w/cpp/types/integer).
- [Implicit conversions — cppreference](https://en.cppreference.com/w/cpp/language/implicit_conversion) (integer promotion + usual arithmetic conversions).
- [`std::bit_cast` — cppreference](https://en.cppreference.com/w/cpp/numeric/bit_cast) and [integer comparison functions `std::cmp_*`](https://en.cppreference.com/w/cpp/utility/intcmp).
- [`std::numeric_limits` — cppreference](https://en.cppreference.com/w/cpp/types/numeric_limits) (`max`, `min`, `epsilon`, `infinity`, `quiet_NaN`).
- David Goldberg, [**What Every Computer Scientist Should Know About Floating-Point Arithmetic**](https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html) — the canonical paper.
- Bruce Dawson, [**Comparing Floating Point Numbers, 2012 Edition**](https://randomascii.wordpress.com/2012/02/25/comparing-floating-point-numbers-2012-edition/) — the practical guide to tolerances/ULPs.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, §2.2-2.4 (integer & floating-point representation).
- [What is two's complement? — Wikipedia](https://en.wikipedia.org/wiki/Two%27s_complement) and [IEEE 754 — Wikipedia](https://en.wikipedia.org/wiki/IEEE_754).

## Videos

- *Computerphile* — **"Floating Point Numbers"** ([search](https://www.youtube.com/results?search_query=computerphile+floating+point+numbers)) and **"How Computers Store Numbers / Two's Complement"** ([search](https://www.youtube.com/results?search_query=computerphile+twos+complement)).
- CppCon — **"Floating-Point <charconv>: Making Your Code 10x Faster"** and other float talks ([search](https://www.youtube.com/results?search_query=CppCon+floating+point)); also John Farrier / Fabian Giesen style "float deep dive" talks ([search](https://www.youtube.com/results?search_query=CppCon+IEEE+754+floating+point+deep+dive)).
