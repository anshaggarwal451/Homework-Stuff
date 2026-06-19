# Byte Order and Endianness

> **Why a quant dev must own this:** Every market-data feed, every binary
> exchange protocol (ITCH, OUCH, FIX/FAST, SBE), every `mmap`'d file and every
> packet off the wire is just a sequence of bytes. *Endianness is the contract
> that says how those bytes reassemble into numbers.* Get it wrong and your
> book is silently corrupt; reason about it sloppily in a hot path and you pay
> cycles you can't afford. This is also one of the most common low-level
> warm-up questions in HFT interviews.

## The one-sentence definition

**Endianness is the order in which the bytes of a multi-byte scalar (an `int`,
`double`, pointer, …) are stored in memory or transmitted on a wire.**

A single byte has no endianness — the question only arises once a value spans
two or more bytes.

## Big-endian vs little-endian

Take the 32-bit value `0x12345678`. It has four bytes, from most-significant
(`0x12`) to least-significant (`0x78`).

| Address | Little-endian (x86-64, ARM default) | Big-endian ("network order", older SPARC/PowerPC) |
|--------:|:-----------------------------------:|:-------------------------------------------------:|
| `base+0` | `0x78` (LSB) | `0x12` (MSB) |
| `base+1` | `0x56` | `0x34` |
| `base+2` | `0x34` | `0x56` |
| `base+3` | `0x12` (MSB) | `0x78` (LSB) |

- **Little-endian (LE):** least-significant byte at the lowest address. The
  byte order is the "reverse" of how we write the number. This is what your
  Intel/AMD desktop, almost every modern server, and ARM-in-LE-mode use.
- **Big-endian (BE):** most-significant byte first — the same order you'd read
  the hex digits left to right. This is the historical "network byte order"
  (TCP/IP headers, and many financial wire protocols).

> **Mnemonic:** *Big-endian = Big end first.* The "end" is the
> most-significant ("big") byte, and it comes first (lowest address).

### Why little-endian "feels backwards" but is convenient

A pleasant property of LE: the address of a value is the address of its
least-significant byte, so reading the first *N* bytes of a wider type gives you
its low *N* bits for free. Casting an `int32_t*` down to a `uint8_t*` and reading
`[0]` yields the low byte on LE — no arithmetic. Truncating a 64-bit to 32-bit is
"just read fewer bytes". Historically this simplified multi-precision arithmetic
and is part of why x86 stuck with it.

### Bi-endian hardware

ARM, RISC-V, MIPS and PowerPC are **bi-endian**: the byte order is selectable
(usually at boot, sometimes per-load with special instructions). In practice
you'll almost always meet them running little-endian (Linux on ARM, Apple
Silicon). "What endianness is this machine?" is therefore a runtime question,
not purely an architecture one — which is exactly what `std::endian::native`
answers.

## Seeing it with your own eyes

```cpp
#include <cstdint>
#include <cstdio>

int main() {
    uint32_t x = 0x12345678u;
    auto* p = reinterpret_cast<unsigned char*>(&x);
    for (int i = 0; i < 4; ++i)
        std::printf("byte %d @ %p = 0x%02X\n", i, (void*)(p + i), p[i]);
}
// On a little-endian box prints: 78 56 34 12
// On a big-endian box prints:    12 34 56 78
```

This `reinterpret_cast` to `unsigned char*` is the *one* aliasing exception the
standard explicitly blesses: you may always inspect any object's
representation through a `char`/`unsigned char`/`std::byte` pointer.

## Detecting endianness — the right way (C++20)

Reach for the standard library before any clever trick:

```cpp
#include <bit>     // C++20

constexpr bool is_little = (std::endian::native == std::endian::little);
constexpr bool is_big    = (std::endian::native == std::endian::big);

template <class T>
T to_native(T v) {
    if constexpr (std::endian::native == std::endian::big)
        return v;                 // already big-endian == network order
    else
        return std::byteswap(v);  // C++23
}
```

`std::endian` is a compile-time constant, so the branch is resolved by the
compiler and **costs nothing at runtime** — the dead branch is eliminated.

**Pre-C++20 alternatives** you'll still see in legacy code (and may be asked to
critique):

```cpp
// (a) union "type-pun" — technically reading an inactive member is UB in C++,
//     though every mainstream compiler does what you expect.
bool little_endian_union() {
    union { uint32_t i; uint8_t c[4]; } u{0x01020304u};
    return u.c[0] == 0x04;
}

// (b) pointer inspection — well-defined (char aliasing) and the classic answer.
bool little_endian_ptr() {
    uint32_t x = 1;
    return *reinterpret_cast<uint8_t*>(&x) == 1;
}
```

> **Interview tip:** if you're asked to detect endianness, lead with
> `std::endian::native` (shows you know modern C++), then mention the
> `char*`-inspection trick as the portable pre-C++20 idiom, and call out that
> the *union* version is technically UB in C++ (it's legal in C). That nuance
> is exactly what separates a "knows the trivia" answer from a "knows the
> standard" answer.

## Swapping bytes efficiently

Byte-swapping is a single, cheap hardware operation. Don't hand-roll it with
shifts in a hot loop and hope the optimizer notices — name it directly:

```cpp
#include <bit>     // std::byteswap (C++23)
#include <cstdint>

uint32_t swapped = std::byteswap(0x12345678u);   // 0x78563412

// Compiler intrinsics (pre-C++23, GCC/Clang):
uint32_t a = __builtin_bswap32(0x12345678u);
uint64_t b = __builtin_bswap64(value);

// MSVC:  _byteswap_ulong / _byteswap_uint64
```

All of these compile down to the x86 **`BSWAP`** instruction (or `MOVBE`,
"move with byte-swap", which fuses the load and the swap). It is ~1 cycle,
fully pipelined, and branchless.

The POSIX networking helpers do the same job but only for the network (big-endian)
direction:

```cpp
#include <arpa/inet.h>
uint32_t net  = htonl(host);   // host  -> network (big-endian)
uint16_t host = ntohs(net16);  // network -> host
```

On a little-endian host these expand to a `BSWAP`; on a big-endian host they're
a no-op. Their weakness is that they hard-code "the other side is big-endian"
and only cover 16/32-bit — useless for a little-endian wire protocol or for
`double`. Modern code tends to prefer `std::byteswap` + an explicit policy, or
**Boost.Endian** (`boost::endian::big_uint32_buf_t`, conversion functions, and
endian-aware arithmetic types).

## The Byte Order Fallacy — the idea that makes all of this go away

Rob Pike's classic argument: **most byte-swapping code shouldn't exist.** The
moment you ask "what is *my* machine's byte order?" to parse data, you've
coupled correct parsing to the CPU — and you'll get it wrong when you port.

The data stream has a *defined* layout. To read a little-endian 32-bit field,
assemble it from its bytes by **value**, with shifts and masks — code that is
identical on every CPU:

```cpp
// Read a LITTLE-endian uint32 from a byte buffer — correct on ANY host.
uint32_t load_le32(const uint8_t* p) {
    return  uint32_t(p[0])
         | (uint32_t(p[1]) << 8)
         | (uint32_t(p[2]) << 16)
         | (uint32_t(p[3]) << 24);
}

// Read a BIG-endian uint32 (e.g. network / many exchange protocols).
uint32_t load_be32(const uint8_t* p) {
    return (uint32_t(p[0]) << 24)
         | (uint32_t(p[1]) << 16)
         | (uint32_t(p[2]) << 8)
         |  uint32_t(p[3]);
}
```

No `#ifdef`, no `std::endian` check, no UB. And the optimizer is smart: on a
matching-endian target, modern GCC/Clang recognise these patterns and fold them
into a single aligned load (plus a `BSWAP` for the mismatched case). You write
portable, intention-revealing code and *still* get the one-instruction result.

> This is the senior answer to "how do you handle endianness in your feed
> handler?": **you don't reorder the machine's memory — you define the wire
> format and deserialize each field by value.**

## A realistic example: decoding a market-data packet

Say an exchange sends a fixed binary message, big-endian, packed:

```text
offset  size  field
0       1     msg_type   (uint8)
1       8     timestamp  (uint64, ns since midnight)  big-endian
9       4     order_id   (uint32)                     big-endian
13      4     price      (int32, scaled by 1e4)       big-endian
17      4     qty        (uint32)                     big-endian
```

```cpp
struct Trade { uint64_t ts; uint32_t order_id; int32_t price; uint32_t qty; };

Trade parse(const uint8_t* b) {
    Trade t;
    t.ts       = load_be64(b + 1);
    t.order_id = load_be32(b + 9);
    t.price    = static_cast<int32_t>(load_be32(b + 13));
    t.qty      = load_be32(b + 17);
    return t;
}
```

Notice what we did **not** do: we did not `reinterpret_cast<const Trade*>(b)`.
That would be wrong on three counts — endianness (the wire is big-endian, our
CPU little-endian), **alignment** (`b+1` is almost certainly misaligned for a
`uint64_t`), and **padding** (the C++ struct isn't packed the way the wire is).
Deserialize field by field.

## Gotchas that bite in practice

- **Floating point has endianness too.** A `double` is 8 bytes; LE machines
  store them low-byte-first. IEEE-754 *bit layout* is standard, but the *byte
  order* in memory follows the platform. Swap the bytes of a `double` exactly
  like an integer (`std::bit_cast` it to a `uint64_t` first, then
  `std::byteswap`).
- **Bitfields are doubly implementation-defined** — both byte order *and*
  bit-allocation order within a unit vary by ABI. Never use C/C++ bitfields to
  describe a wire format.
- **`reinterpret_cast` over a buffer = endianness + alignment + strict-aliasing
  bugs in one line.** Use `std::memcpy` (or C++20 `std::bit_cast`) into a local,
  then byte-swap that local.
- **Mixed-endian / "middle-endian"** layouts (e.g. some legacy 32-bit floats
  stored as two swapped 16-bit words, PDP-11 heritage) still appear in old
  market-data archives. Don't assume only two possibilities exist.
- **Text/ASCII is byte-addressed and has no endianness** — but **UTF-16/UTF-32
  do**, which is why a BOM exists.

## Performance notes for the hot path

- `BSWAP`/`MOVBE` are ~1 cycle and branchless — endianness conversion is
  essentially free *per value*. The cost only matters when you do it *per
  element across millions of elements* in a tight loop, where it competes for
  ALU ports and can block auto-vectorization.
- To convert a buffer in bulk, the byte-shuffle is vectorizable: `PSHUFB`
  (SSSE3) / `VPSHUFB` (AVX2/512) reverses bytes within lanes for many values at
  once. Compilers will sometimes do this for you over a `std::array`; check the
  assembly.
- Prefer to convert **at the boundary** (when you parse the packet) rather than
  repeatedly deep in compute. Store data in native order internally.

## Key takeaways

1. Endianness = byte order of multi-byte scalars; single bytes are immune.
2. x86-64 and (in practice) ARM are **little-endian**; the network and many
   exchange protocols are **big-endian**.
3. Use **`std::endian::native`** to detect and **`std::byteswap`** to convert
   (C++23); `__builtin_bswap*` / `htonl` for older toolchains.
4. Best of all, follow the **Byte Order Fallacy**: define the wire format and
   deserialize each field by value with shifts/masks — portable *and* optimal.
5. In a feed handler, never `reinterpret_cast` a packed wire struct: endianness,
   alignment, and padding will all betray you.

## Self-check

1. On a little-endian machine, what does `*(char*)&x` give for `uint32_t x = 0x0A0B0C0D`?
2. Why is the *union* endianness trick UB in C++ but fine in C?
3. Rewrite `load_be32` to read a **little-endian** `uint16_t` instead.
4. A colleague's parser does `auto t = *(const Trade*)buffer;`. Name three
   distinct bugs.
5. Is `std::byteswap` on a `double` meaningful? How would you swap one safely?

## Further reading

- [`std::endian` — cppreference](https://en.cppreference.com/w/cpp/types/endian) and [`std::byteswap` — cppreference](https://en.cppreference.com/w/cpp/numeric/byteswap)
- Rob Pike, [**The Byte Order Fallacy**](https://commandcenter.blogspot.com/2012/04/byte-order-fallacy.html) — read this twice.
- [Boost.Endian library](https://www.boost.org/libs/endian/) — endian-aware buffer types and conversions.
- ["Endianness, and why I don't like `htons(3)` and friends"](https://www.thecodedmessage.com/posts/endianness/) — a modern critique that motivates the by-value approach.
- [Bit Manipulation with C++20 — Modernes C++](https://www.modernescpp.com/index.php/bit-manipulation-with-c-20/) — the `<bit>` header in full.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, §2.1 (byte ordering) — the canonical textbook treatment.
- `man 3 endian` (`htobe32`, `le32toh`, …) — the Linux/BSD conversion family.

## Videos

- *Computerphile* — **"Endianness Explained With an Egg"** ([search](https://www.youtube.com/results?search_query=computerphile+endianness+explained+with+an+egg)) — the clearest 10-minute intuition pump.
- CppCon — search for talks on **binary serialization / low-latency feed handlers** (e.g. Carl Cook's *"When a Microsecond Is an Eternity"*, [search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)); endianness shows up wherever parsing the wire matters. There is no dedicated CppCon talk on endianness itself.
