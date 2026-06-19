# Packed Struct Offset Lookup

> **Why a quant dev must own this:** Every exchange feed you'll ever touch —
> NASDAQ ITCH, CME's SBE-encoded MDP 3.0, OUCH, proprietary multicast — is a
> stream of tightly packed binary messages with a fixed field layout. Decoding
> them *correctly* (alignment, padding, endianness) and *fast* (no allocation,
> no UB, branch-light) is the core of a feed handler. Getting "given this
> field→offset map, decode the message" right is a staple HFT interview
> question, and the wrong answer — `reinterpret_cast` a packed struct over the
> buffer — silently corrupts your book.

## Problem statement

You're given a **packed binary message** and its layout as a table of
`field → (offset, size, type)`. Build a reusable **offset table**, then write a
decoder that, given a raw `const std::byte*` buffer, extracts each field into a
native struct **safely and quickly**.

Concretely, take this fixed message (big-endian on the wire, no padding):

```text
field         offset  size  type             notes
-----------   ------  ----  ---------------  -------------------------------
msg_type        0      1    uint8            e.g. 'A' = Add Order
seq_num         1      8    uint64 (BE)      sequence number
timestamp       9      8    uint64 (BE)      ns since midnight
order_id       17      8    uint64 (BE)
side           25      1    char             'B' / 'S'
price          26      4    int32 (BE)       scaled by 1e4
quantity       30      4    uint32 (BE)
symbol         34      8    char[8]          space-padded ASCII
                                             total size = 42 bytes
```

The catch: **the wire layout is nothing like the natural C++ struct layout.**
That mismatch is the whole problem.

**C++ standard used here: C++20** (for `std::byte`, `std::endian`, `std::span`,
and `std::bit_cast`; I call out where C++23's `std::byteswap` cleans things up,
and the C++17 fallback).

## Clarifying constraints (say these out loud)

- **Is the layout fixed or self-describing?** Fixed-offset (ITCH-style) vs.
  templated/length-prefixed (SBE, FIX/FAST). I'll do fixed-offset and note SBE.
- **Endianness of the wire?** ITCH is big-endian; SBE is little-endian. *Never
  assume it matches the host.* x86-64 is little-endian.
- **Is the buffer guaranteed contiguous and at least `message_size` bytes?**
  Bounds are the caller's job in a hot path, but I'll show a checked variant.
- **Alignment of the buffer?** Packet payloads off a NIC ring or after an
  Ethernet/UDP header are routinely **unaligned** — `offset 1` for an 8-byte
  field is misaligned. The decoder must not assume alignment.
- **One message type or many?** Real feeds dispatch on `msg_type`. I'll decode
  one and show the dispatch shape.

## Why the naive answer is wrong

The tempting one-liner:

```cpp
struct Wire { uint8_t type; uint64_t seq; /* ... */ };   // DANGER
const Wire* m = reinterpret_cast<const Wire*>(buffer);   // three bugs in one cast
auto seq = m->seq;
```

This is wrong on **four** counts, and naming all four is the senior answer:

1. **Padding.** The compiler inserts padding so each member is naturally
   aligned. After `uint8_t type` it adds **7 bytes** of padding before
   `uint64_t seq`, so `offsetof(Wire, seq) == 8`, but the wire puts `seq` at
   offset **1**. Your struct doesn't match the bytes.
2. **Alignment / undefined behavior.** Even with `#pragma pack`, dereferencing a
   `uint64_t` at a misaligned address is UB in C++ and a fault or a slow split
   load on some ISAs.
3. **Endianness.** The wire is big-endian; your CPU is little-endian. The bytes
   reassemble into the wrong number.
4. **Strict aliasing.** Reading an object of type `Wire` through a pointer that
   doesn't actually point to a live `Wire` object violates the aliasing rules;
   the optimizer is allowed to assume it never happens.

The fix is to **deserialize each field by value**: copy the exact bytes out with
`std::memcpy` (or `std::bit_cast`), then byte-swap to native order. This is
correct on every host and, crucially, the optimizer folds it back into a single
load + `BSWAP` — you pay nothing for the correctness.

## Layout, alignment, and the packing tools

Understand the layout rules before reaching for `#pragma pack`:

- **Alignment** of a type `T` is `alignof(T)`; an object's address must be a
  multiple of it. `alignof(uint64_t) == 8` on most ABIs.
- **Padding** is inserted (a) *between* members to align each, and (b) at the
  *end* so the struct's size is a multiple of its alignment (so arrays stay
  aligned). `sizeof(struct)` is therefore `>=` the sum of member sizes.

```cpp
#include <cstddef>   // offsetof
#include <cstdint>

struct Natural {            // natural (host) layout
    uint8_t  type;          // offset 0
    // 7 bytes padding
    uint64_t seq;           // offset 8  (NOT 1!)
    uint32_t qty;           // offset 16
    // 4 bytes padding -> sizeof == 24, alignof == 8
};
static_assert(offsetof(Natural, seq) == 8);
static_assert(sizeof(Natural)        == 24);
```

`offsetof` (from `<cstddef>`) reports the *compiler's* offset — invaluable for
*asserting* a layout, useless for *defining* the wire one. To force a no-padding
layout for an interop struct:

```cpp
#pragma pack(push, 1)
struct WirePacked {         // packing forced to 1: no internal padding
    uint8_t  type;          // offset 0
    uint64_t seq;           // offset 1  (matches the wire)
    uint32_t qty;           // offset 9
};                          // sizeof == 13
#pragma pack(pop)
static_assert(sizeof(WirePacked) == 13);
// GCC/Clang equivalent: struct __attribute__((packed)) { ... };
```

But heed the senior caveats on `#pragma pack`:

- It makes member access potentially **unaligned**, which is UB to *dereference*
  directly and is non-portable. Taking the **address** of a packed member is
  itself dangerous (the pointer has a lying alignment). GCC/Clang warn
  (`-Waddress-of-packed-member`).
- It still doesn't fix **endianness**. Packing ≠ portable serialization.
- It's an ABI/portability hazard. I treat `#pragma pack` structs as a *layout
  description for `offsetof`/`static_assert`*, not as something I dereference.

`alignas` is the opposite tool — it *increases* alignment (e.g.
`alignas(64) struct Foo` to put `Foo` on its own cache line), used for the
*native* decoded struct, not the wire one.

> **Rule of thumb:** use **`alignas`** to make your hot native structs
> cache-line friendly; use **`#pragma pack`/`offsetof`** only to *document and
> assert* a wire layout — and decode by value, never by dereference.

## The offset table

Encode the layout as data, not as a struct. A small constexpr table maps each
field to its offset and size; the decoder reads against it. This is the literal
"build an offset table" the problem asks for, and it generalizes to many message
types.

```cpp
#include <array>
#include <cstdint>
#include <string_view>

enum class Field : std::size_t {
    MsgType, SeqNum, Timestamp, OrderId, Side, Price, Quantity, Symbol, Count
};

struct FieldSpec { std::uint16_t offset; std::uint16_t size; };

// Indexed by Field. constexpr -> lives in .rodata, no runtime init.
inline constexpr std::array<FieldSpec, std::size_t(Field::Count)> kAddOrder = {{
    /* MsgType   */ { 0,  1},
    /* SeqNum    */ { 1,  8},
    /* Timestamp */ { 9,  8},
    /* OrderId   */ {17,  8},
    /* Side      */ {25,  1},
    /* Price     */ {26,  4},
    /* Quantity  */ {30,  4},
    /* Symbol    */ {34,  8},
}};
inline constexpr std::size_t kAddOrderSize = 42;
```

Keeping the layout as a `constexpr` table (rather than hard-coded literals
scattered through the decoder) means it's checkable with `static_assert`,
greppable, and reusable for both encode and decode paths.

## A complete, safe, fast decoder

The core primitive is a **load-by-value with byte-swap**. We use `std::memcpy`
into a local — the one blessed, alignment-agnostic, aliasing-clean way to read
raw bytes — then swap to native order.

```cpp
#include <bit>          // std::endian, std::byteswap (C++23), std::bit_cast
#include <cstddef>      // std::byte
#include <cstdint>
#include <cstring>      // std::memcpy
#include <span>
#include <type_traits>

// Portable byte-swap: prefers std::byteswap (C++23), falls back to builtins.
template <class T>
[[nodiscard]] constexpr T bswap(T v) noexcept {
    static_assert(std::is_integral_v<T>);
#if defined(__cpp_lib_byteswap)
    return std::byteswap(v);
#else
    if constexpr (sizeof(T) == 1) return v;
    else if constexpr (sizeof(T) == 2) return __builtin_bswap16(v);
    else if constexpr (sizeof(T) == 4) return __builtin_bswap32(v);
    else                               return __builtin_bswap64(v);
#endif
}

// Read a big-endian integer of type T from offset `off`. Alignment-safe,
// aliasing-clean, endianness-correct, branch-free.
template <class T>
[[nodiscard]] T load_be(const std::byte* buf, std::size_t off) noexcept {
    static_assert(std::is_trivially_copyable_v<T>);
    T raw;
    std::memcpy(&raw, buf + off, sizeof(T));   // exact bytes; no UB
    if constexpr (std::endian::native == std::endian::little)
        return bswap(raw);                     // wire is BE -> swap on LE host
    else
        return raw;                            // host already BE: no-op
}
// The compiler folds memcpy+bswap into a single load (+ BSWAP on x86).
```

`std::memcpy` here compiles away entirely: GCC/Clang recognize the
fixed-size copy and emit a single (possibly unaligned) `MOV`. `std::bit_cast`
(C++20) is an alternative for the swap-of-`raw`, but `memcpy` is what handles the
*unaligned source*, so it's the right tool for reading from the buffer.

Now the decoder against the offset table:

```cpp
struct AddOrder {                  // native, host-endian decoded form
    char        msg_type;
    std::uint64_t seq_num;
    std::uint64_t timestamp;
    std::uint64_t order_id;
    char        side;
    std::int32_t  price;           // scaled by 1e4
    std::uint32_t quantity;
    char        symbol[8];
};

[[nodiscard]] AddOrder decode_add_order(std::span<const std::byte> buf) {
    // In a hot path the caller guarantees size; assert in debug.
    // (Checked variant below for untrusted input.)
    const std::byte* b = buf.data();
    constexpr auto& L = kAddOrder;

    AddOrder o;
    o.msg_type  = static_cast<char>(b[L[std::size_t(Field::MsgType)].offset]);
    o.seq_num   = load_be<std::uint64_t>(b, L[std::size_t(Field::SeqNum)].offset);
    o.timestamp = load_be<std::uint64_t>(b, L[std::size_t(Field::Timestamp)].offset);
    o.order_id  = load_be<std::uint64_t>(b, L[std::size_t(Field::OrderId)].offset);
    o.side      = static_cast<char>(b[L[std::size_t(Field::Side)].offset]);
    o.price     = static_cast<std::int32_t>(
                      load_be<std::uint32_t>(b, L[std::size_t(Field::Price)].offset));
    o.quantity  = load_be<std::uint32_t>(b, L[std::size_t(Field::Quantity)].offset);
    std::memcpy(o.symbol, b + L[std::size_t(Field::Symbol)].offset, 8); // raw ASCII
    return o;
}
```

Notes on the subtle bits:

- **`price` is signed.** Read it as `uint32_t` (byte-swap is defined on
  unsigned), then `static_cast` to `int32_t`. Casting unsigned→signed of an
  in-range value is well-defined since C++20 (two's complement is mandated); a
  direct signed byte-swap would invoke implementation-defined shifts on negative
  values — read unsigned, then cast.
- **`symbol`** is fixed-width ASCII, not a number — no swap, just `memcpy` the
  bytes. Treat it as opaque text.
- **`std::span`** gives us a bounds-aware view without owning or copying the
  buffer.

### Checked decode for untrusted input

The hot path trusts the framing; a gateway parsing raw network input must not.

```cpp
#include <optional>

[[nodiscard]] std::optional<AddOrder>
decode_add_order_checked(std::span<const std::byte> buf) {
    if (buf.size() < kAddOrderSize) return std::nullopt;  // truncated
    if (static_cast<char>(buf[0]) != 'A') return std::nullopt;
    return decode_add_order(buf);
}
```

### Dispatching on message type

```cpp
void on_message(std::span<const std::byte> buf) {
    if (buf.empty()) return;
    switch (static_cast<char>(buf[0])) {
        case 'A': handle(decode_add_order(buf)); break;
        // case 'E': decode_execute(buf); ...
        default: /* skip unknown; advance by length field */ break;
    }
}
```

## Complexity

```text
operation            time            space
------------------   -------------   -----------------------------
build offset table   compile-time    O(num_fields) in .rodata
decode one message   O(num_fields)   O(1) on the stack, no heap
load_be<T>           O(1)            one load + (at most) one BSWAP
```

Decoding is a fixed number of loads and swaps per message — **O(1) per field,
no allocation, no branches** in the unchecked path.

## Low-latency optimizations

- **Decode by value, fold to one instruction.** `memcpy`+`bswap` of a
  fixed-size POD is recognized by GCC/Clang and compiles to a single
  (possibly `MOVBE`/`BSWAP`) instruction. You write portable code and get the
  optimal load. Verify with `-O2 -S` / Compiler Explorer.
- **Don't materialize fields you don't use.** A hot strategy often needs only
  `price` and `quantity`. Read those two; skip decoding the rest. The offset
  table makes selective decode trivial — that's its real payoff over a
  monolithic struct copy.
- **Keep the native struct cache-line friendly.** Order the decoded struct's
  members big-to-small to minimize padding, and `alignas(64)` it if it lives in
  a hot per-symbol record so it doesn't straddle two cache lines.
- **Prefetch the next message.** Feed messages are sequential in the receive
  buffer; `__builtin_prefetch(b + msg_size)` while decoding the current one
  hides the next miss.
- **Branchless dispatch.** A `switch` on a dense `msg_type` becomes a jump table;
  keep handlers small and hot. For very hot single-type streams, peel that type
  out of the switch.
- **`[[nodiscard]]` + `noexcept`** on the load helpers: better inlining, no
  unwind tables, and the optimizer can hoist/merge loads freely.
- **Validate offsets at compile time.** `static_assert` that the last field's
  `offset + size == message_size`, so a layout typo fails the build, not
  production.

## A note on endianness (the one-paragraph version)

The wire defines the byte order; the host is irrelevant to *correctness*. Read
each multi-byte field **by value** and convert to native order with `bswap`
guarded by `std::endian::native`. The guard is a compile-time constant, so the
dead branch vanishes — on a matching-endian host the swap is a no-op, on x86
(little-endian) reading big-endian wire data it's a single `BSWAP`. ITCH is
big-endian; SBE is little-endian; **never** hard-code an assumption that the wire
matches your CPU. (See the companion *Byte Order and Endianness* lesson and the
Byte Order Fallacy for the full treatment.)

## Follow-up variations interviewers ask

- **"The layout is in SBE (Simple Binary Encoding)."** SBE is little-endian,
  has a message header (block length, template id, schema id, version), and
  supports optional/variable-length groups. The decoder reads the header,
  dispatches on template id, then uses a *generated* offset table per template —
  exactly this pattern, machine-generated. Mention that SBE codecs are codegen,
  not hand-rolled.
- **"Variable-length / repeating groups."** Offsets aren't constant anymore;
  you walk the message, advancing a cursor by each field's size, with a
  count-prefixed loop for groups. The "offset table" becomes a running cursor.
- **"How do you handle a field that's a price as 4-byte scaled int vs. a
  decimal-mantissa-exponent pair?"** Decode the raw integer, then apply the
  feed's scaling; keep the scale in the field spec.
- **"Bitfields for flags?"** Never trust C/C++ bitfields for wire layout —
  bit-allocation order is implementation-defined. Mask and shift explicitly.
- **"Show it's zero-copy."** The decoder reads from the receive buffer in place;
  the only "copy" is into stack locals the optimizer elides. No heap touched.
- **"Why `std::bit_cast` vs `memcpy` vs `reinterpret_cast`?"** `bit_cast`
  (C++20) is the constexpr-friendly value reinterpret for *same-size, aligned*
  reads; `memcpy` is the general unaligned/partial reader; `reinterpret_cast`
  over a buffer is the trifecta of bugs — avoid.

## Key takeaways

1. **Wire layout ≠ C++ struct layout.** Compilers insert padding for alignment;
   a natural struct's `offsetof` won't match a packed wire's offsets.
2. **Never `reinterpret_cast` a struct over a buffer** — it's padding +
   alignment + endianness + strict-aliasing UB in one line.
3. **Decode each field by value:** `std::memcpy` the exact bytes into a local
   (alignment-safe, aliasing-clean), then byte-swap to native order.
4. Treat **`#pragma pack`/`offsetof` as documentation/asserts** for the layout,
   not as something to dereference; use **`alignas`** to make your *native*
   decoded structs cache-friendly.
5. An **offset table** (constexpr, indexed by field) makes the layout data,
   enables **selective decode** of only the fields you need, and is exactly what
   SBE/ITCH codecs generate.
6. Guard byte-swaps with **`std::endian::native`** so the dead branch is
   eliminated; `memcpy`+`bswap` folds to a single `MOVBE`/`BSWAP`.

## Self-check

1. A wire message puts a `uint64_t` at offset 1. A colleague writes
   `struct M { uint8_t t; uint64_t v; };` and casts the buffer to `M*`. What is
   `offsetof(M, v)`, and why is the read wrong on *three* independent grounds?
2. Why does the decoder read `price` (an `int32`) as `uint32_t` and then cast,
   rather than byte-swapping a signed value directly?
3. What exactly does `std::memcpy(&raw, buf + off, sizeof(T))` buy you over
   `raw = *reinterpret_cast<const T*>(buf + off)`? Name both problems it solves.
4. Why is `static_assert(std::endian::native == std::endian::little)`-guarded
   swapping free at runtime?
5. Your layout `static_assert` checks `offset+size==message_size` for the last
   field but the feed adds a trailing 2-byte CRC. What breaks, and how do you fix
   the offset table?
6. You only need `price` and `quantity` from a 42-byte message. How does the
   offset-table design let you avoid decoding the other six fields, and why does
   that matter on the hot path?

## Further reading

- [`std::bit_cast` — cppreference](https://en.cppreference.com/w/cpp/numeric/bit_cast)
  and [`std::byteswap` — cppreference](https://en.cppreference.com/w/cpp/numeric/byteswap)
  — the modern, well-defined reinterpret/swap primitives.
- [`offsetof` — cppreference](https://en.cppreference.com/w/cpp/types/offsetof)
  and [`alignas` — cppreference](https://en.cppreference.com/w/cpp/language/alignas)
  — layout introspection vs. layout control.
- Rob Pike, [**The Byte Order Fallacy**](https://commandcenter.blogspot.com/2012/04/byte-order-fallacy.html)
  — read it; it's why we decode by value.
- [NASDAQ TotalView-ITCH 5.0 specification](https://www.nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NQTVITCHspecification.pdf)
  — a real fixed-offset, big-endian wire format to practice on.
- [Real Logic — Simple Binary Encoding (SBE)](https://github.com/real-logic/simple-binary-encoding)
  — the codegen'd, little-endian encoding behind CME MDP 3.0; read the design
  rationale for low-latency decoding.
- [`-Waddress-of-packed-member` — why taking the address of a packed field is dangerous (GCC docs)](https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html)
  — the alignment trap behind `#pragma pack`.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, §3.9
  (data alignment) and §2.1 (byte ordering) — the textbook grounding.

## Videos

- CppCon — **Carl Cook, "When a Microsecond Is an Eternity"**
  ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity))
  — the HFT feed-handler mindset: zero-copy, no allocation, decode on the wire.
- CppCon — **Timur Doumler, "Want fast C++? Know your hardware!"**
  ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+want+fast+C%2B%2B+know+your+hardware))
  — alignment, cache lines, and why unaligned/straddling loads cost you.
- CppCon — **David Gross, "Trading at light speed: designing low-latency systems in C++"**
  ([search](https://www.youtube.com/results?search_query=CppCon+David+Gross+trading+at+light+speed))
  — real-world packet decoding and data layout in a trading system.
