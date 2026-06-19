# Bitwise Operations

> **Why a quant dev must own this:** Order flags, venue capabilities, set
> membership, fast hashing, branchless decision logic and the entire family of
> "count the bits" tricks all live in the bitwise toolbox. *In a hot path you
> often can't afford a branch or a division — but you can almost always afford
> an `AND`, a shift, or a single `POPCNT`.* Bit manipulation is also the most
> reliable warm-up question in an HFT interview: it tests whether you actually
> understand the machine underneath the language.

## First principles: an integer is a bag of bits

A fixed-width integer is just *N* bits with positional weights. A `uint32_t`
holds bits 0..31 where bit *i* contributes `2^i`. Bitwise operators don't treat
the value as a number with magnitude — they operate on each bit position
independently and in parallel. That parallelism is the whole point: one
instruction touches all 32 (or 64) lanes at once, in roughly one cycle.

There are six primitive operations, and everything else is built from them:

| Op | C++ | Truth-table behaviour | One-line intuition |
|----|-----|-----------------------|--------------------|
| AND | `a & b` | `1` iff both `1` | **mask / keep** selected bits |
| OR  | `a \| b` | `1` if either `1` | **set** selected bits |
| XOR | `a ^ b` | `1` iff bits differ | **toggle** / difference detector |
| NOT | `~a` | flips every bit | complement (one's complement) |
| left shift | `a << n` | multiply by `2^n` | pack / scale |
| right shift | `a >> n` | divide by `2^n` (unsigned) | unpack / scale down |

Note the bitwise operators (`&`, `|`, `^`) are distinct from the *logical*
operators (`&&`, `||`): the logical ones short-circuit, produce a `bool`, and
introduce branches. Mixing them up is a classic bug — `a & b` where you meant
`a && b` silently changes both semantics and codegen.

## Setting, clearing, toggling, testing a single bit

These four idioms are the bread and butter. Let `pos` be a bit index in
`[0, width)`:

```cpp
#include <cstdint>

constexpr uint32_t set_bit   (uint32_t x, unsigned pos) { return x |  (1u << pos); }
constexpr uint32_t clear_bit (uint32_t x, unsigned pos) { return x & ~(1u << pos); }
constexpr uint32_t toggle_bit(uint32_t x, unsigned pos) { return x ^  (1u << pos); }
constexpr bool     test_bit  (uint32_t x, unsigned pos) { return (x >> pos) & 1u; }
```

The pattern to internalise: **build a single-bit mask `(1u << pos)`**, then

- `| mask` to set,
- `& ~mask` to clear,
- `^ mask` to toggle,
- `& mask` (or shift down) to test.

> **The most important footgun on this whole page:** the `1` in `1u << pos`
> must be the *right width*. `1u << 40` is **undefined behaviour** because `1u`
> is a 32-bit `unsigned int` and you shifted past its width. For a 64-bit value
> you must write `uint64_t{1} << 40` (or `1ull << 40`). More on shift UB below.

## Masks: operating on several bits at once

A *mask* selects a group of bits. Extracting a bitfield is "shift down, then AND
off the high bits":

```cpp
// Extract `len` bits starting at `pos`.
constexpr uint32_t extract(uint32_t x, unsigned pos, unsigned len) {
    return (x >> pos) & ((1u << len) - 1);   // (1<<len)-1 is `len` low ones
}

// Insert `val` (already in range) into `x` at [pos, pos+len).
constexpr uint32_t insert(uint32_t x, uint32_t val, unsigned pos, unsigned len) {
    uint32_t mask = ((1u << len) - 1) << pos;
    return (x & ~mask) | ((val << pos) & mask);
}
```

`(1u << len) - 1` is the single most useful mask-building expression: it gives
you `len` low-order ones. (Watch the edge case `len == 32`: `1u << 32` is UB, so
guard it or use a wider type.)

## Arithmetic vs logical shift, and the signed-shift minefield

Right shift has two flavours and the language picks for you based on the
*operand's* type:

- **Logical shift** (`SHR` on x86): fills vacated high bits with `0`. This is
  what `>>` does on **unsigned** types.
- **Arithmetic shift** (`SAR`): replicates the sign bit, preserving sign. This
  is what `>>` does on **signed** types (since C++20, right shift of a negative
  value is well-defined and arithmetic; before C++20 it was
  implementation-defined, though every real compiler did arithmetic shift).

```cpp
uint32_t u = 0x80000000u;  u >> 1;  // 0x40000000  (logical, zero-fill)
int32_t  s = -8;           s >> 1;  // -4          (arithmetic, sign-fill)
```

The rules that *will* be tested in an interview, because they are genuine
**undefined behaviour** (the optimizer is allowed to assume they never happen):

| Expression | Verdict | Why |
|------------|---------|-----|
| `x << n` or `x >> n` with `n >= width` | **UB** | shift count out of range; `1u << 32` is UB |
| `x << n` or `x >> n` with `n < 0` | **UB** | negative shift count |
| `int{1} << 31` | **UB** (pre-C++20) | signed left-shift into/over the sign bit overflows |
| `int{-1} >> 1` | well-defined since C++20 | arithmetic right shift |
| `unsigned{0xFF} << 4` | well-defined | unsigned shift just drops overflow bits |

The signed-left-shift overflow rule is subtle: `1 << 31` overflows a 32-bit
`int` and is UB. Use **unsigned** types for all bit-twiddling; reach for signed
only when you actually want arithmetic-shift sign behaviour.

## The bit tricks worth memorising

These show up constantly and reveal whether you "see" the binary structure.

```cpp
x & (x - 1)      // clears the lowest set bit
x & (-x)         // isolates the lowest set bit (== x & (~x + 1))
x | (x + 1)      // sets the lowest clear bit
x & (x + 1)      // clears the trailing ones
(x & (x - 1)) == 0 && x != 0   // is x a power of two?
```

Why `x & (x-1)` clears the lowest set bit: subtracting 1 flips the lowest set
bit to 0 and turns all the zeros below it into ones; ANDing with the original
keeps everything above untouched and wipes the run at the bottom. Repeatedly
applying it (and counting iterations) is **Kernighan's population-count** — it
loops once per *set* bit, not once per bit:

```cpp
int popcount_kernighan(uint32_t x) {
    int n = 0;
    while (x) { x &= x - 1; ++n; }   // each pass removes one set bit
    return n;
}
```

But you should rarely write that loop today — the hardware does it in one
instruction (see below).

## C++20 `<bit>`: the standard, portable, hardware-mapped vocabulary

Before C++20 everyone reached for compiler intrinsics. Now there is a clean,
`constexpr`, portable header that maps onto the underlying instructions:

```cpp
#include <bit>
#include <cstdint>

uint32_t x = 0b0010'1100;

int  ones  = std::popcount(x);       // 3   -> POPCNT
int  ctz   = std::countr_zero(x);    // 2   -> TZCNT/BSF (count trailing zeros)
int  clz   = std::countl_zero(x);    // 26  -> LZCNT/BSR (count leading zeros)
int  cto   = std::countr_one(x);     // 0
bool p2    = std::has_single_bit(x); // false (not a power of two)
uint32_t r = std::bit_ceil(x);       // 64  (smallest power of two >= x)
uint32_t f = std::bit_floor(x);      // 32  (largest power of two <= x)
int  width = std::bit_width(x);      // 6   (== 1 + floor(log2(x)))
uint32_t rot = std::rotl(x, 4);      // rotate left -> ROL
```

| Function | Does | Typical instruction |
|----------|------|---------------------|
| `std::popcount` | count set bits | `POPCNT` |
| `std::countr_zero` | trailing zeros (index of lowest set bit) | `TZCNT` / `BSF` |
| `std::countl_zero` | leading zeros | `LZCNT` / `BSR` |
| `std::bit_width` | bits needed to represent value | derived from `LZCNT` |
| `std::rotl` / `std::rotr` | rotate (no UB at width, unlike shift) | `ROL` / `ROR` |
| `std::has_single_bit` | power-of-two test | `x & (x-1)` |

`std::rotl` is worth calling out: unlike `<<`, a rotate by the full width is
well-defined and wraps — it's the right tool for hashing and crypto-style
mixing. The pre-C++20 / non-standard equivalents are
`__builtin_popcount(ll)`, `__builtin_ctz(ll)`, `__builtin_clz(ll)` on GCC/Clang
and `_mm_popcnt_u64`, `__popcnt`, `_BitScanForward`/`_BitScanReverse` on MSVC.

> **Gotcha:** `__builtin_ctz(0)` and `__builtin_clz(0)` are **undefined** (the
> underlying `BSF`/`BSR` leave the destination unspecified for a zero input).
> `std::countr_zero(0)` is *defined* to return the width. Prefer the standard
> functions; if you must use the builtins, special-case zero.

## What the hardware actually does

The basic logic ops (`AND`/`OR`/`XOR`/`NOT`) and shifts are about as cheap as
operations get: **~1 cycle latency, fully pipelined**, several per cycle on
modern Intel/AMD because there are multiple ALU ports. They never miss cache
(they touch registers, not memory) and never mispredict (no branch). That's why
*branchless* code built from bitwise ops can beat a clean `if` in a hot loop.

The population-count and bit-scan instructions are a small step up:

- **`POPCNT`** (SSE4.2, ~2008+): counts set bits in a 16/32/64-bit register.
  Approx 3-cycle latency, 1 per cycle throughput on recent cores. It replaces a
  loop or a multi-step "SWAR" trick with one instruction.
- **`LZCNT` / `TZCNT`** (BMI1/ABM): count leading/trailing zeros, ~3-cycle
  latency. Unlike the older `BSR`/`BSF` they have defined behaviour for a zero
  input (return the width) and avoid a false dependency on the destination.
- **BMI1/BMI2** add direct hardware for the classic tricks: `BLSR`
  (`x & (x-1)`), `BLSI` (`x & -x`), `BLSMSK`, and `PEXT`/`PDEP` (parallel
  bit extract/deposit) for arbitrary-mask gather/scatter of bits.

A subtle real-world note: on several Intel generations `POPCNT`/`LZCNT`/`TZCNT`
carried a spurious *false dependency* on their destination register, which could
serialize a tight loop. Compilers learned to break it with an xor-idiom; it's a
good "have you read Agner Fog?" detail.

For counting bits across a *buffer* (not one word), the win is `VPOPCNTDQ`
(AVX-512) or library routines like the Mula/Lemire vectorized popcount, which
process many words per instruction.

## Branchless code with bitwise ops

A conditional select without a branch — useful when the branch is unpredictable
and would mispredict (~15-20 cycle penalty):

```cpp
// return cond ? a : b, branchlessly. cond must be 0 or 1.
int select(int cond, int a, int b) {
    int mask = -cond;          // 0 -> 0x00000000, 1 -> 0xFFFFFFFF
    return (a & mask) | (b & ~mask);
}

// branchless absolute value (two's complement)
int iabs(int x) {
    int s = x >> 31;           // arithmetic shift: 0 or -1
    return (x ^ s) - s;
}
```

These are textbook tricks, but in modern code prefer to **let the compiler do
it**: a plain `cond ? a : b` often compiles to `CMOV` (conditional move),
which is branchless already. Hand-rolling matters only when you've measured a
misprediction problem and confirmed the compiler isn't emitting `CMOV`. Always
check the assembly.

## Flag enums and bitmask sets

A canonical use: representing a set of independent boolean attributes in one
integer (order flags, venue capabilities, feature toggles).

```cpp
#include <cstdint>

enum class OrderFlags : uint32_t {
    None       = 0,
    PostOnly   = 1u << 0,
    Ioc        = 1u << 1,   // immediate-or-cancel
    Hidden     = 1u << 2,
    Iceberg    = 1u << 3,
    ReduceOnly = 1u << 4,
};

constexpr OrderFlags operator|(OrderFlags a, OrderFlags b) {
    return OrderFlags(uint32_t(a) | uint32_t(b));
}
constexpr bool has(OrderFlags set, OrderFlags f) {
    return (uint32_t(set) & uint32_t(f)) != 0;
}

OrderFlags f = OrderFlags::PostOnly | OrderFlags::Hidden;
bool post_only = has(f, OrderFlags::PostOnly);   // true, one AND
```

Testing membership is a single `AND` against a compile-time mask — far cheaper
than a `std::set` lookup or a chain of `bool`s, and it packs the entire flag set
into one cache-line-friendly word.

For sets over a small universe (say, "which of 64 instruments are active"), a
`uint64_t` *is* the set: union is `|`, intersection is `&`, difference is
`& ~`, membership is a shift-and-test, and cardinality is `std::popcount`. This
is the fastest possible small-set representation.

```cpp
uint64_t active = 0;
active |= (uint64_t{1} << instrument_id);          // add
bool in = (active >> instrument_id) & 1;           // contains
int  n  = std::popcount(active);                   // size
uint64_t both = active & subscribed;               // intersection
```

## `std::bitset` when the universe is bigger

For more than 64 flags with readable code, `std::bitset<N>` gives you `count()`,
`test()`, `set()`, `any()`, and the bitwise operators with bounds-checking
options. It's compact and fast, but it's a *fixed* size known at compile time
and isn't ideal when you need raw control over layout for a wire format (see the
endianness lesson — never let a `bitset`/bitfield define your on-wire bytes).
For runtime-sized bit sets, `std::vector<bool>` exists but is a quirky
specialization; many shops prefer an explicit `std::vector<uint64_t>`.

## Quant/HFT relevance & interview gotchas

- **Order/venue flags** are bitmasks: setting, clearing, and testing them is the
  single most common bit operation in an OMS hot path.
- **Fast set membership**: "is instrument *k* in my subscribed set?" is a
  shift-and-`AND` on a `uint64_t`, not a hash lookup. Intersecting two
  subscription sets is one `&`.
- **Branchless / `CMOV`**: in a price-comparison or side-selection inner loop, a
  mispredicted branch costs ~15-20 cycles; a bitmask-select or `CMOV` costs ~1.
  Know when each wins (predictable branch -> just branch; unpredictable -> go
  branchless) and that you usually let the compiler emit `CMOV`.
- **`std::popcount` for cardinality / hashing**: counting active levels, hamming
  distance between bitmaps, hash mixing — all `POPCNT`.
- **Classic interview asks:** "count set bits without a loop" (`std::popcount` /
  `POPCNT`, mention Kernighan as the portable fallback), "is it a power of two?"
  (`x && !(x & (x-1))`), "isolate the lowest set bit" (`x & -x`), "swap two ints
  without a temp" (`a^=b; b^=a; a^=b;` — then note it's a *trick*, not something
  you'd ship because it's slower and breaks if `a` and `b` alias).
- **Top gotchas to recite:** shifting by `>=` width is UB; `1 << 31` on a signed
  `int` is UB; `1u << 40` is UB (wrong width — use `1ull`); `__builtin_ctz(0)`
  is UB while `std::countr_zero(0)` is defined; `&` is not `&&`.

## Key takeaways

1. `AND` masks/keeps, `OR` sets, `XOR` toggles, `NOT` complements; `<<`/`>>`
   pack and scale. They are ~1-cycle, branchless, fully pipelined.
2. The four single-bit idioms — `x | (1<<p)`, `x & ~(1<<p)`, `x ^ (1<<p)`,
   `(x >> p) & 1` — and the mask `(1<<len)-1` cover most real work.
3. Shifting `>=` the width, by a negative count, or a signed left-shift that
   overflows the sign bit are all **undefined behaviour**. Do bit work in
   **unsigned** types and mind the literal's width (`1ull` for 64-bit).
4. Prefer C++20 `<bit>` (`std::popcount`, `countr_zero`, `rotl`,
   `has_single_bit`) — portable, `constexpr`, and it maps to `POPCNT`/`TZCNT`/
   `LZCNT`/`ROL`. `std::countr_zero(0)` is defined; `__builtin_ctz(0)` is not.
5. A `uint64_t` is the fastest small set; flag enums pack booleans into one
   cache-friendly word; reach for `std::bitset<N>` past 64.

## Self-check

1. Write expressions to (a) clear bit 5, (b) test whether bit 12 is set, in a
   `uint32_t`. Now do the same for bit 40 of a `uint64_t` — what changes?
2. Why is `1 << 31` undefined for a signed 32-bit `int` but `1u << 31` fine?
3. Explain why `x & (x - 1)` clears the lowest set bit, and how that yields an
   O(set-bits) population count.
4. You need `cond ? a : b` in a loop where `cond` is essentially random. What
   are your options and which is fastest, and why?
5. What does `std::countr_zero(x)` return, what instruction backs it, and how
   does it differ from `__builtin_ctz(x)` for `x == 0`?
6. Represent "subscribed instruments 0..63" as one value. Show add, contains,
   intersection, and size.

## Further reading

- [`<bit>` header — cppreference](https://en.cppreference.com/w/cpp/header/bit): `popcount`, `countl_zero`, `countr_zero`, `bit_width`, `rotl`, `has_single_bit`.
- [`std::popcount` — cppreference](https://en.cppreference.com/w/cpp/numeric/popcount) and [`std::countr_zero`](https://en.cppreference.com/w/cpp/numeric/countr_zero).
- [Bit manipulation with C++20 — Modernes C++](https://www.modernescpp.com/index.php/bit-manipulation-with-c-20/).
- Sean Eron Anderson, [**Bit Twiddling Hacks**](https://graphics.stanford.edu/~seander/bithacks.html) — the canonical reference for the tricks.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, §2.1 (information as bits) and the bit-level operations exercises.
- Agner Fog, [**Instruction tables**](https://www.agner.org/optimize/) — latencies/throughput for `POPCNT`, `LZCNT`, `BSF`/`BSR`, and the destination false-dependency note.
- [Intel 64 and IA-32 Architectures Software Developer Manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) — `POPCNT`, `LZCNT`, BMI1/BMI2 (`BLSR`, `PEXT`, `PDEP`).
- Wojciech Mula, Nathan Kurz, Daniel Lemire, [**Faster Population Counts Using AVX2**](https://arxiv.org/abs/1611.07612) — vectorized popcount over buffers.

## Videos

- *Computerphile* — **"Binary, Hexadecimal & bit manipulation"** ([search](https://www.youtube.com/results?search_query=computerphile+binary+bit+manipulation)) for the visual intuition.
- CppCon — **"Bit Manipulation"** talks ([search](https://www.youtube.com/results?search_query=CppCon+bit+manipulation)); also look for low-latency talks where branchless/`CMOV` techniques appear, e.g. Carl Cook's *"When a Microsecond Is an Eternity"* ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)).
