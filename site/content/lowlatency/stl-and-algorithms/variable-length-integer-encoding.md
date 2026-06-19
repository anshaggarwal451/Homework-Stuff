# Variable-Length Integer Encoding

> **Why a quant dev must own this:** Wire protocols are bytes-on-the-wire and
> bandwidth costs latency. **Varints (LEB128, protobuf-style)** spend one byte
> on small numbers and grow only as the value does — most order IDs, sequence
> numbers and quantities are small, so you pay for what you use. The catch: the
> decoder is a **branchy, data-dependent loop** — the canonical example of a
> compact format that is *cheap on the wire and expensive in the pipeline.*
> Knowing both halves is the senior answer.

## Problem statement

Encode an unsigned 64-bit integer into the fewest bytes that still
self-describe their own length, and decode it back. The standard scheme is
**LEB128 / base-128 varint** (used by Protocol Buffers, DWARF, WebAssembly,
many exchange and database formats):

- Split the integer into **7-bit groups**, little-endian (least-significant
  group first).
- Each output byte carries 7 payload bits in its low bits and a **continuation
  bit** (the MSB, `0x80`): `1` means "more bytes follow", `0` means "this is the
  last byte".

So 1–127 take one byte, 128–16383 take two, … up to 10 bytes for a full
`uint64_t`. For **signed** values you first apply **zigzag** mapping so small
magnitudes (positive *or* negative) stay small.

## Clarifying constraints / assumptions

- **Unsigned base first.** Define encode/decode for `uint64_t`; layer signed on
  top via zigzag. (Plain two's-complement of a negative number sets the high
  bits, so a naive varint of `-1` is a wasteful 10 bytes — zigzag fixes that.)
- **Little-endian groups.** The 7-bit groups go LSB-first regardless of host
  endianness — varint endianness is *defined by the format*, not the CPU. (See
  the Byte Order Fallacy: deserialize by value.)
- **Max length 10 bytes** for `uint64_t` (`ceil(64/7) = 10`). The 10th byte
  carries only 1 payload bit.
- **Untrusted input on decode.** A malicious stream can set the continuation bit
  forever — you must bound the read or you overrun the buffer / spin.
- Buffer big enough on encode (caller guarantees ≥10 bytes, or we return the
  count written).

## Approaches and tradeoffs

### Why varints at all (vs fixed width)

| Encoding | 1 (small) | 1,000,000 | Self-delimiting? | Decode cost |
|---|---|---|---|---|
| Fixed `uint64` | 8 bytes | 8 bytes | yes (fixed) | 1 load, branchless |
| Fixed `uint32` | 4 bytes | 4 bytes | yes (fixed) | 1 load, branchless |
| **LEB128 varint** | **1 byte** | 3 bytes | yes (continuation bit) | **branchy loop** |

The win is space when your distribution is skewed toward small values
(sequence numbers reset daily, most quantities are lots of 1–100, message-type
tags are tiny). The cost is a serial, data-dependent decode. That is the
fundamental tradeoff: **varint trades bytes for branches.**

### Signed: zigzag vs two's-complement

ZigZag maps signed → unsigned so that small absolute values get small codes,
interleaving negatives and positives: `0→0, -1→1, 1→2, -2→3, 2→4, …`

```text
encode:  (n << 1) ^ (n >> 63)     // arithmetic shift broadcasts the sign
decode:  (u >> 1) ^ -(u & 1)
```

Without zigzag, `-1` as two's complement is `0xFFFF...F` → all groups nonzero →
**10 bytes**. With zigzag it's `1` → **1 byte**. Always zigzag signed varints.

## Complexity

- **Encode:** O(L) where L = number of output bytes (1–10). Bounded by
  `ceil(bits/7)`.
- **Decode:** O(L), one iteration per byte, terminating on the first byte with
  the continuation bit clear.
- **Space:** O(1) extra; at most 10 bytes on the wire per value.

The interesting cost isn't asymptotic — it's the **micro-architectural** cost of
that data-dependent loop, covered below.

## Complete, annotated reference implementation

C++ standard: **C++17** (the API uses `std::optional`; everything else is
C++11-clean). Header-only, no allocation.

```cpp
#include <cstdint>
#include <cstddef>
#include <optional>

// ===== Unsigned LEB128 ======================================================

// Encode `value` into `out` (must hold >= 10 bytes). Returns bytes written.
std::size_t encode_varint(std::uint64_t value, std::uint8_t* out) {
    std::size_t i = 0;
    // Emit 7 bits at a time; set the MSB (0x80) while more bits remain.
    while (value >= 0x80) {                 // >= 0x80 -> at least one more group
        out[i++] = static_cast<std::uint8_t>(value) | 0x80;  // low 7 bits + cont
        value >>= 7;
    }
    out[i++] = static_cast<std::uint8_t>(value);             // final byte, MSB=0
    return i;
}

// Decode from [p, end). On success returns the value and advances `p`.
// Returns nullopt on truncation or on an over-long (>10 byte) encoding.
std::optional<std::uint64_t>
decode_varint(const std::uint8_t*& p, const std::uint8_t* end) {
    std::uint64_t result = 0;
    int shift = 0;
    for (int i = 0; i < 10; ++i) {          // hard cap: ceil(64/7) == 10 bytes
        if (p == end) return std::nullopt;  // truncated stream
        std::uint8_t byte = *p++;
        // Splice this group's 7 payload bits into place.
        result |= static_cast<std::uint64_t>(byte & 0x7F) << shift;
        if ((byte & 0x80) == 0) return result;  // continuation clear -> done
        shift += 7;
    }
    return std::nullopt;                     // 11th byte would overflow uint64
}

// ===== Signed via ZigZag ====================================================

inline std::uint64_t zigzag_encode(std::int64_t n) {
    // Logical shift left by 1, XOR with the sign broadcast (arithmetic >> 63).
    return (static_cast<std::uint64_t>(n) << 1)
         ^ static_cast<std::uint64_t>(n >> 63);
}

inline std::int64_t zigzag_decode(std::uint64_t u) {
    // Reverse: drop the LSB tag, XOR with the negated tag bit.
    return static_cast<std::int64_t>((u >> 1) ^ (~(u & 1) + 1));
}

std::size_t encode_svarint(std::int64_t value, std::uint8_t* out) {
    return encode_varint(zigzag_encode(value), out);
}

std::optional<std::int64_t>
decode_svarint(const std::uint8_t*& p, const std::uint8_t* end) {
    auto u = decode_varint(p, end);
    if (!u) return std::nullopt;
    return zigzag_decode(*u);
}
```

Notes on the careful bits:

- `value >= 0x80` is the loop condition: keep emitting *with* the continuation
  bit while there are bits above the low 7. The final byte is written with MSB
  clear.
- The decode loop is **hard-capped at 10 iterations**. This is not optional — an
  unbounded `while (byte & 0x80)` on hostile input is a buffer overrun / DoS.
- `n >> 63` on a signed `int64_t` is an **arithmetic** shift (implementation-
  defined before C++20, but universally arithmetic on real compilers; C++20
  guarantees two's complement). It broadcasts the sign bit to all 64 bits, which
  is exactly the zigzag XOR mask.
- The decoder uses `&p` by reference so it advances the cursor — the idiom for
  walking a packed message stream field by field.

### Worked example

```text
value = 300  (binary 1 0010 1100)

7-bit groups, LSB first:  low 7 = 010 1100      high = 10
byte 0 = 0xAC  (1_0101100)  continuation set, payload 0101100
byte 1 = 0x02  (0_0000010)  continuation clear, payload 0000010

decode: 0x2C  | (0x02 << 7) = 44 + 256 = 300   ✓
on the wire: AC 02   (2 bytes vs 8 for a fixed uint64)
```

## Low-latency optimizations

The decode loop is the hot spot. Each iteration has a **data-dependent branch**
(continuation bit) the predictor can't know in advance, and a serial dependency
(`shift += 7`, `result |= ...`). Strategies:

- **Specialise on the common length.** If 95% of your IDs fit in 1–2 bytes, peel
  the first iterations: read byte 0; if its MSB is clear you're done with zero
  loop overhead and a predictable branch. This is what makes real protobuf
  decoders fast — the *first byte fast path*.

  ```cpp
  // Fast path: single-byte varints (values 0..127) with one predictable branch.
  inline bool decode_varint_fast(const std::uint8_t*& p, const std::uint8_t* end,
                                 std::uint64_t& out) {
      if (p != end && (*p & 0x80) == 0) {     // hot, well-predicted case
          out = *p++;
          return true;
      }
      auto r = decode_varint(p, end);          // cold slow path
      if (!r) return false;
      out = *r; return true;
  }
  ```

- **Branch-reduced / SIMD bulk decode.** When you control the layout, formats
  like **PrefixVarint / VByte / Stream-VByte** move the length information to the
  front (a length prefix or a separate "control" stream) so the decoder reads a
  fixed number of bytes and *masks/shuffles* instead of branching per byte.
  Stream-VByte decodes 4 integers with a `PSHUFB`-driven table lookup and no
  per-element branch — far friendlier to the pipeline than LEB128. If you're
  designing the protocol, prefer these.
- **Bounded, unrolled loop.** The fixed cap of 10 lets the compiler unroll;
  combined with the first-byte fast path the common case is near-branchless.
- **Encode is cheaper than decode** and rarely the bottleneck; the conditional
  store loop predicts well because length correlates within a message stream.
- **Avoid `std::optional` in the inner loop** if profiling shows it (it's a
  branch + a tag); the `_fast` form above returns `bool` + out-param to keep the
  hot path tight.
- **Watch the serial dependency.** `result |= group << shift` chains through
  `shift`. For multi-byte values you can't parallelise within one varint, which
  is exactly why SIMD formats parallelise *across* values instead.

> Senior framing: **LEB128 is a space optimization that is a decode
> pessimization.** On a 10GbE feed where you parse millions of messages/sec, the
> per-byte branch can cost more than the bandwidth it saved. Many HFT shops
> therefore use *fixed-width* binary (SBE/ITCH style) on the latency-critical
> path and reserve varints for storage/replay where space dominates.

## Why wire protocols use it (and where they don't)

- **Protocol Buffers** field values, **DWARF** debug info, **WebAssembly**
  immediates, **Git** pack files, **LevelDB/RocksDB** keys, **Lucene** postings
  — all LEB128 because their data skews small and self-delimiting length is
  convenient.
- **SBE (Simple Binary Encoding)** and most **exchange feeds** (NASDAQ ITCH,
  CME MDP) deliberately use *fixed-width, fixed-offset* fields instead. Why?
  Because fixed offsets mean **branch-free, random-access, zero-copy** parsing —
  you can read field N without decoding fields 0..N-1. Varints force a serial
  left-to-right scan. For the lowest latency, predictability beats compactness.

That contrast — "protobuf uses varints, exchange feeds deliberately don't, and
here's why" — is a great thing to volunteer in an interview.

## Follow-up variations interviewers ask

- **"Encode a negative number."** → Show zigzag; explain the 10-byte trap of
  naive two's-complement varint.
- **"Make decode safe against malicious input."** → The 10-iteration cap;
  reject over-long encodings (an 11th byte, or a value that overflows). Also
  reject *non-canonical* encodings (trailing `0x80 00`) if your protocol
  requires canonical form.
- **"Decode is too slow, speed it up."** → First-byte fast path; then redesign
  toward Stream-VByte / a length prefix if you own the format.
- **"How many bytes will value X take?"** → `max(1, ceil(bit_width(X)/7))`;
  compute via `std::bit_width` (C++20) — useful to size buffers without encoding.
- **"Decode big-endian / most-significant-group-first varint."** → Some formats
  (e.g. MIDI, ASN.1 BER length) put the high group first; the loop changes from
  OR-with-increasing-shift to shift-left-then-OR.
- **"Is the union/`reinterpret_cast` trick usable here?"** → No — varint is
  inherently byte-by-byte; you can't just `memcpy` a wider type. (Contrast with
  fixed-width fields where `memcpy` + byteswap is the move.)

## Key takeaways

1. **LEB128 varint** = 7 payload bits per byte, MSB is the **continuation bit**,
   little-endian groups. 1 byte for small values, up to 10 for a `uint64_t`.
2. For signed values, **zigzag first** (`(n<<1) ^ (n>>63)`); naive
   two's-complement makes `-1` a 10-byte monster.
3. **Always cap the decode loop** at 10 bytes — unbounded continuation bits on
   hostile input are an overrun/DoS.
4. The cost model: **cheap bytes, expensive branches.** Decode is a serial,
   data-dependent loop the predictor struggles with.
5. Speed it up with a **first-byte fast path**; for real throughput move to
   **Stream-VByte / PrefixVarint** which decode many values branch-free via SIMD.
6. Exchange feeds (ITCH, SBE) deliberately choose **fixed-width** fields:
   branch-free, random-access, zero-copy beats compactness on the latency path.

## Self-check

1. How many bytes does `encode_varint(127)` produce? `128`? `16384`? Why the
   jumps?
2. Walk the bytes of `encode_svarint(-1)` and `encode_svarint(64)`. Why is
   zigzag needed before LEB128?
3. Why must the decode loop terminate after 10 iterations for `uint64_t`, and
   what attack does omitting the cap enable?
4. A stream ends mid-varint (last byte has the continuation bit set but there's
   no next byte). What does `decode_varint` return and why is that the right
   behaviour?
5. Explain why `n >> 63` produces the correct zigzag sign mask. What does the
   standard say about right-shifting signed negatives?
6. Your feed parses 5M messages/sec and the decode loop shows up hot in the
   profile. Give two distinct redesigns and their tradeoffs.

## Further reading

- [Protocol Buffers — **Encoding** (base-128 varints + zigzag)](https://protobuf.dev/programming-guides/encoding/) — the canonical spec, with the exact zigzag formulas.
- [LEB128 — Wikipedia](https://en.wikipedia.org/wiki/LEB128) — concise definition of unsigned/signed LEB128 as used in DWARF/WASM.
- Daniel Lemire et al., [**"Stream VByte: Faster Byte-Oriented Integer Compression"**](https://arxiv.org/abs/1709.08990) — the SIMD, branch-free alternative; read for the "varints are branchy" insight.
- Daniel Lemire's blog, [posts on **VByte / variable-length integer decoding** performance](https://lemire.me/blog/) — practical microbenchmarks of the branch cost.
- [`std::bit_width` — cppreference](https://en.cppreference.com/w/cpp/numeric/bit_width) (C++20) — for computing varint length without encoding.
- Rob Pike, [**The Byte Order Fallacy**](https://commandcenter.blogspot.com/2012/04/byte-order-fallacy.html) — why you decode by value, byte by byte (directly applicable to varints).

## Videos

- CppCon — **"Simple Binary Encoding (SBE) / low-latency message codecs"** ([search](https://www.youtube.com/results?search_query=CppCon+simple+binary+encoding+low+latency+market+data)) — why latency-critical feeds choose fixed-width over varint.
- Daniel Lemire — **"Fast integer compression"** talks ([search](https://www.youtube.com/results?search_query=Daniel+Lemire+fast+integer+compression+stream+vbyte)) — the SIMD branch-free decode story.
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — context on why a per-byte branch in a feed handler is expensive.
