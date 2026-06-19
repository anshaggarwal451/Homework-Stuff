# Efficient itoa Implementation

> **Why a quant dev must own this:** Integer-to-ASCII is one of the most
> deceptively hot routines in a trading system. Every log line, every CSV/JSON
> tick you persist, every human-readable price you format runs `itoa`. The naive
> "divide by 10, push a digit" loop is a chain of *dependent divisions* — among
> the slowest integer ops on the CPU. The fast version (the **two-digit lookup
> table**, length pre-compute, `std::to_chars`) is a classic "make the hot path
> fast" interview problem and a genuine win in feed/log formatting.

## Problem statement

Convert an integer to its decimal ASCII representation as fast as possible.
Write the characters into a caller-provided buffer (no allocation), return a
pointer/length to the result. Handle unsigned and signed; correctness on the
full range including `INT_MIN`.

The benchmark to beat: `sprintf(buf, "%d", x)` (slow — parses a format string at
runtime) and the schoolbook divide-by-10 loop (slow — serial 64-bit divisions).

## Clarifying constraints / assumptions

- **Caller owns the buffer.** Hot-path formatting never allocates. For
  `uint64_t` the max is 20 digits; `int64_t` 19 digits + sign. Size the buffer
  to 21 bytes and you're safe.
- **Base 10** (the common case). Other bases are a follow-up.
- **Signed correctness for the minimum value.** `-INT_MIN` overflows; you must
  negate in the *unsigned* domain (`0u - (unsigned)x`). This is the bug
  interviewers plant.
- **No locale, no thousands separators** on the hot path — that's formatting for
  humans, done off the critical path.
- **Output direction.** Decimal digits are produced least-significant-first by
  division, but the string reads most-significant-first — so we either write
  **backwards from the end** of the buffer, or **pre-compute the length** and
  fill forward. Both are shown.

State the `INT_MIN` and buffer-ownership assumptions explicitly — they're the
ones that separate a correct fast answer from a subtly broken one.

## Approaches and tradeoffs

### Approach 0 — `sprintf` / `std::to_string`

`sprintf` reparses `"%d"` every call and goes through locale machinery;
`std::to_string` allocates a `std::string`. Both are an order of magnitude
slower than a tuned `itoa`. Baselines to beat, not solutions.

### Approach 1 — schoolbook divide-by-10, write backwards

Repeatedly `x % 10` / `x /= 10`, emit digits into the end of the buffer, return
a pointer to the start. Correct and simple, but each iteration is a **dependent
integer division** (~20–40 cycles latency on x86, and serial because each step
needs the previous quotient). One digit per division.

### Approach 2 — two-digit lookup table (the trick to know)

Process **two digits per iteration** using `x % 100` to index a 200-byte table
of digit pairs `"00","01",...,"99"`. This **halves the number of divisions** and
turns each pair into a single 2-byte table load + store. The single most
important micro-optimization for `itoa`, used by Facebook's `folly::to`,
`fmt`, and others.

```text
table = "00010203...979899"   (200 bytes, char[100][2])
x = 12345
  x % 100 = 45 -> copy table[45] = "45"
  x /= 100 -> 123
  x % 100 = 23 -> copy table[23] = "23"
  x /= 100 -> 1
  1 < 100   -> single leading digit '1'
result: "12345"
```

### Approach 3 — length pre-compute + forward fill (branch-reduced)

First compute the digit count (via comparisons against powers of ten, or
`log10`), position the write cursor at the end, and fill **forward** in
known-length chunks. This removes the "where does the string start?" bookkeeping
and lets you write to a fixed offset — friendlier for fixed-width fields. Combine
with the two-digit table for the fastest portable scalar `itoa`.

### Approach 4 — `std::to_chars` (C++17) — *use this in real code*

`std::to_chars` is the standard, locale-free, non-allocating, *already heavily
optimized* conversion. Implementations use exactly the table/length tricks
below. **In production, reach for `std::to_chars` first** — hand-rolled `itoa`
is for interviews and the rare case where you out-measure the stdlib.

## Complexity

- **Time:** O(d), d = number of digits (≤ 20). Asymptotically trivial; the whole
  game is the **constant factor** — number of divisions and the dependency chain.
- **Space:** O(1); fixed 200-byte table, caller's buffer.

| Approach | Divisions | Notes |
|---|---|---|
| Divide-by-10 | d (serial) | dependent `div`, slowest |
| Two-digit table | ⌈d/2⌉ | half the divisions, table load/store |
| Length-precompute + table | ⌈d/2⌉ | forward fill, fixed offsets |
| `std::to_chars` | impl-defined | fastest portable, standard |

## Complete, annotated reference implementation

C++ standard: **C++17** (`std::to_chars` and `if constexpr` are C++17; the
hand-rolled code is C++14-clean). Self-contained, no allocation.

```cpp
#include <charconv>     // std::to_chars (C++17)
#include <cstdint>
#include <cstring>      // std::memcpy
#include <system_error>

// 200-byte table of two-digit pairs: index 2*n .. 2*n+1 holds "nn".
// constexpr so it lives in .rodata, shared and cache-resident.
inline constexpr char kTwoDigits[201] =
    "00010203040506070809"
    "10111213141516171819"
    "20212223242526272829"
    "30313233343536373839"
    "40414243444546474849"
    "50515253545556575859"
    "60616263646566676869"
    "70717273747576777879"
    "80818283848586878889"
    "90919293949596979899";

// ---- Length pre-compute: number of decimal digits in an unsigned value. -----
inline unsigned digits10(std::uint64_t v) {
    // Branch-light staircase of comparisons; covers the full 64-bit range.
    unsigned n = 1;
    for (;;) {
        if (v < 10)                  return n;
        if (v < 100)                 return n + 1;
        if (v < 1000)                return n + 2;
        if (v < 10000)               return n + 3;
        v /= 10000u;                 // strip 4 digits, loop
        n += 4;
    }
}

// ---- Fastest scalar itoa: length pre-compute + two-digit table, forward fill.
// Writes exactly digits10(value) chars at `buf`. Returns one-past-the-end.
inline char* u64toa(std::uint64_t value, char* buf) {
    const unsigned len = digits10(value);
    char* p = buf + len;             // fill from the end, backwards
    // Peel two digits at a time from the low end.
    while (value >= 100) {
        const unsigned idx = static_cast<unsigned>(value % 100) * 2;
        value /= 100;
        p -= 2;
        std::memcpy(p, &kTwoDigits[idx], 2);   // one 2-byte store, no per-digit branch
    }
    if (value < 10) {                // 1 digit left
        *--p = static_cast<char>('0' + value);
    } else {                         // 2 digits left
        const unsigned idx = static_cast<unsigned>(value) * 2;
        p -= 2;
        std::memcpy(p, &kTwoDigits[idx], 2);
    }
    return buf + len;                // p == buf here; return the end cursor
}

// ---- Signed wrapper: negate in the UNSIGNED domain to survive INT64_MIN. -----
inline char* i64toa(std::int64_t value, char* buf) {
    std::uint64_t mag;
    if (value < 0) {
        *buf++ = '-';
        // 0u - (unsigned)value yields the magnitude even for INT64_MIN.
        mag = 0ull - static_cast<std::uint64_t>(value);
    } else {
        mag = static_cast<std::uint64_t>(value);
    }
    return u64toa(mag, buf);
}

// ---- The production answer: std::to_chars. Locale-free, no alloc, optimized. -
inline char* to_chars_itoa(std::int64_t value, char* buf, char* end) {
    auto [ptr, ec] = std::to_chars(buf, end, value);
    return (ec == std::errc{}) ? ptr : buf;   // ptr = one-past-last on success
}
```

Why each piece is the way it is:

- **`kTwoDigits` is `constexpr`** → it lands in read-only data, is shared across
  threads, and stays cache-resident (200 bytes ≈ 4 cache lines).
- **`digits10` pre-computes length** so `u64toa` writes into a known span and the
  `memcpy`s never need bounds bookkeeping. The 4-digits-per-loop staircase keeps
  the comparison count low.
- **`memcpy(p, &table[idx], 2)`** compiles to a single 16-bit store — no branch,
  no per-character work. This is where the two-digit trick pays off.
- **Signed negation in unsigned domain** (`0ull - (uint64_t)value`) is the
  `INT64_MIN`-safe idiom: `-INT64_MIN` is UB, but the unsigned subtraction wraps
  to the correct magnitude.

### Why divide-by-10 is the thing we're avoiding

```x86asm
; schoolbook:  digit = x % 10;  x /= 10;   -- per digit
        mov     rax, rdi
        mov     rcx, 10
        xor     rdx, rdx
        div     rcx           ; 64-bit DIV: ~20-40 cycle latency, NOT pipelined
        ; ...repeat d times, each DIV waiting on the previous quotient
```

The compiler turns `x / 100` (a constant divisor) into a **multiply-by-magic-
constant + shift**, not a real `div` — so the two-digit-table version isn't just
half the iterations, each iteration also avoids the expensive hardware divide.
That double win is the heart of the optimization.

## Low-latency optimizations

- **Two digits per step** (above) — the headline trick. Some implementations go
  further with a **four-digit table** (10,000 entries, 40 KB) trading L1 cache
  footprint for fewer iterations; usually *not* worth the cache pressure on a hot
  path — measure.
- **Constant-divisor division.** Dividing by `100` (a compile-time constant)
  becomes a multiply+shift. Never divide by a *runtime* base on the hot path if
  you can specialise base 10.
- **Length pre-compute → fixed-width fields.** When writing into a fixed-offset
  record (an exchange order message, a columnar log), `digits10` lets you
  right-justify with zero-padding in one pass, no shifting.
- **Branch reduction.** The per-digit `'0' + d` branch and the "where's the
  start" pointer juggling are removed by the table + length approach. What
  branches remain (the `value >= 100` loop, the final 1-vs-2-digit tail) are
  well-predicted because digit count is stable within a stream.
- **Avoid `memcpy` overhead for tiny copies** — for 2 bytes the compiler inlines
  it to a single `mov`; don't replace it with a hand loop.
- **SIMD for batches.** Formatting a column of millions of integers (a feed dump)
  can be vectorized: compute all digit counts, then convert with SWAR/SIMD digit
  extraction. Overkill for one value, real for bulk export. (See `fmt`'s and
  Lemire's work.)
- **`std::to_chars` is the realistic answer.** It already does the table+length
  tricks, is branch-tuned by your stdlib vendor, never allocates, and ignores
  locale. Don't ship a hand-rolled `itoa` unless a profile proves you beat it.

> Senior framing for the interview: *"I'd use `std::to_chars`; if I had to
> explain why it's fast, it's the two-digit table that halves divisions and the
> length pre-compute that removes branching — and the real cost we're killing is
> the dependent 64-bit `div`."*

## Why this is hot in feed / log formatting

- **Structured logging.** Every log line with a sequence number, order ID,
  price, or timestamp formats several integers. At millions of log lines/sec
  (even to a ring buffer or async logger), `itoa` is a measurable slice of CPU.
- **Tick persistence / CSV/JSON export.** Writing a market-data capture to disk
  is integer-formatting-bound, not I/O-bound, once you batch the writes.
- **Human-readable prices and quantities** on monitoring/risk dashboards fed off
  the hot path.

The standard low-latency pattern is to keep the *critical* path binary (no
formatting at all) and do `itoa` in an **asynchronous logger** thread — but that
thread still has to keep up with the hot path's message rate, so a fast `itoa`
keeps the log queue from backing up. (This is why high-performance loggers like
NanoLog and `spdlog` care about formatting speed.)

## Follow-up variations interviewers ask

- **"Make it correct for `INT_MIN`."** → Negate in the unsigned domain; this is
  the planted bug.
- **"Format into a fixed-width, zero-padded field."** → Use `digits10` to find
  the gap, fill leading `'0'`s, then `u64toa` — one pass, no shift.
- **"Now base 16 / arbitrary base."** → Per-digit table for hex; for arbitrary
  runtime base you lose the constant-divisor multiply trick and it gets slower.
- **"How does `std::to_chars` differ from `sprintf`?"** → No locale, no format
  parse, no allocation, returns an error-code on overflow, and is heavily
  optimized — strictly better for machine output.
- **"Convert a `double`."** → Different, much harder problem (Ryū / Grisu /
  `std::to_chars` for floats); mention you wouldn't hand-roll it.
- **"Why two digits and not three?"** → Three needs a 3000-byte table and the
  divisor (1000) still multiplies cheaply, but the table is less cache-friendly
  and `% 1000` extraction is fiddlier; two digits is the sweet spot. Four-digit
  tables exist but cost 40 KB of L1.

## Key takeaways

1. The enemy is the **dependent 64-bit `div`** in the schoolbook loop. Every
   optimization is really about doing fewer divisions and breaking the
   dependency chain.
2. The **two-digit lookup table** (`x % 100` → 200-byte table) halves the
   iterations and replaces per-digit work with one 2-byte store. Know this cold.
3. **Pre-compute the digit count** (`digits10`) to write into a known span,
   enable forward/fixed-width fills, and strip branches.
4. **Negate signed in the unsigned domain** (`0u - (unsigned)x`) so `INT_MIN`
   doesn't invoke UB — the classic correctness trap.
5. Constant-divisor division (by 10/100) becomes **multiply+shift**; never use a
   runtime base on the hot path.
6. **In real code, use `std::to_chars`** (C++17): locale-free, non-allocating,
   already doing these tricks. Hand-roll only when you out-measure it.
7. `itoa` is hot in **logging and tick/CSV/JSON export**; keep formatting off
   the critical path (async logger) but keep it fast so the queue doesn't back up.

## Self-check

1. Why does the schoolbook divide-by-10 loop dominate runtime, and what does the
   compiler do with `x / 100` that it can't do with division by a runtime base?
2. How big is the two-digit table and why `constexpr`? How many bytes does
   `kTwoDigits[idx]` copy per iteration?
3. Show why `-INT64_MIN` is UB and how `0ull - (uint64_t)value` produces the
   correct magnitude.
4. Walk `u64toa(12345, buf)`: how many loop iterations, how many `div`-class
   operations, what does the final tail branch decide?
5. When would a four-digit (40 KB) table be a *pessimization* despite fewer
   iterations?
6. Your async logger thread can't keep up with the feed and its queue grows.
   Name two `itoa`-related fixes and one structural one.

## Further reading

- [`std::to_chars` — cppreference](https://en.cppreference.com/w/cpp/utility/to_chars) — the standard, optimized, locale-free conversion; the answer for production code.
- [`<charconv>` overview — cppreference](https://en.cppreference.com/w/cpp/header/charconv) — `to_chars`/`from_chars` and their error-code contract.
- Andrei Alexandrescu, [**"Three Optimization Tips for C++"**](https://www.youtube.com/results?search_query=Andrei+Alexandrescu+three+optimization+tips+for+C%2B%2B) (and the folly `to`/`uint_to_string` source) — origin of the two-digit-table `itoa` trick.
- [`folly::to` / `folly::detail::uintToBuffer`](https://github.com/facebook/folly/blob/main/folly/Conv.h) — production two-digit-table implementation to read.
- [`fmt` library — formatting internals](https://github.com/fmtlib/fmt) — Victor Zverovich's fast integer formatting; `fmt::format_int` is a great reference.
- Daniel Lemire, [blog posts on **fast integer-to-string / number parsing**](https://lemire.me/blog/) — microbenchmarks and SIMD/SWAR variants.
- Jeaiii / James Edward Anhalt, [**fast itoa benchmarks and the magic-multiply approach**](https://github.com/jeaiii/itoa) — the current state of the art beyond the two-digit table.

## Videos

- CppCon — Andrei Alexandrescu, **"Three Optimization Tips for C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Andrei+Alexandrescu+three+optimization+tips)) — the talk that popularized the two-digit-table `itoa`.
- CppCon — Victor Zverovich, **"A modern formatting library for C++ (fmt)"** ([search](https://www.youtube.com/results?search_query=CppCon+Victor+Zverovich+fmt+formatting+library)) — how a real fast formatter converts integers.
- CppCon — **"The fastest logging in the West / NanoLog low-latency logging"** ([search](https://www.youtube.com/results?search_query=CppCon+low+latency+logging+nanolog)) — why integer formatting speed gates an async logger on the hot path.
