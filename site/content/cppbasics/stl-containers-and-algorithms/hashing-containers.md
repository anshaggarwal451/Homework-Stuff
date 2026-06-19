# Hashing Containers

> **Why a quant dev must own this:** Hash maps are the default "look this up by
> key" tool — symbol → instrument, order-id → order, client → position. They
> *advertise* O(1), and in interviews everyone reaches for `std::unordered_map`.
> But the standard's container is node-based, pointer-chasing, and
> cache-hostile; in a hot path it is frequently the *slowest* reasonable choice.
> Knowing exactly why — and what HFT shops use instead — is a recurring senior
> interview theme.

## First principles: what a hash table buys you

A hash table trades *order* for *speed*. Instead of keeping keys sorted (a tree,
O(log n)), it computes a **hash** of each key — an integer fingerprint — and uses
that integer to jump more-or-less directly to where the value lives. Average
lookup, insert, and erase are **amortized O(1)**, independent of element count.
The price: iteration order is unspecified, and the worst case degrades to O(n)
when hashes collide.

The four standard hashing containers (all from `<unordered_map>` /
`<unordered_set>`, C++11):

| Container | Stores | Duplicate keys? | Value mapped? |
|---|---|---|---|
| `std::unordered_set` | keys | no | no |
| `std::unordered_map` | key→value | no | yes |
| `std::unordered_multiset` | keys | **yes** | no |
| `std::unordered_multimap` | key→value | **yes** | yes |

"Unordered" is the operative word: unlike `std::map`, you get **no sorted
iteration**. If you need keys in order, you want the [ordered
containers](./ordered-containers.md).

## Mechanics: buckets, hash, chaining

The container holds an array of **buckets**. To place a key it computes
`h = Hash{}(key)` and maps that to a bucket index, in practice
`h % bucket_count()`. Each bucket holds a list of the elements that landed there
(**collisions**). The C++ standard *mandates* this design — open hashing with
**separate chaining** — by requiring that references and pointers to elements
stay valid across rehash, and that each element sit in its own node. So a
conforming `std::unordered_map` is essentially:

```text
buckets (array of pointers)         nodes (one heap allocation each)
  [0] ──────────────► (key,val) ──► (key,val) ──► nullptr
  [1] ──► nullptr
  [2] ──────────────► (key,val) ──► nullptr
  [3] ──► nullptr
  [4] ──────────────► (key,val) ──► (key,val) ──► (key,val) ──► nullptr
        ▲ bucket = hash(key) % bucket_count
        ▲ each arrow is a pointer to chase = a likely cache miss
```

Two facts fall straight out of this picture and explain almost everything about
its performance:

1. **One heap allocation per element.** Inserting builds a node somewhere on the
   heap; the buckets array only stores *pointers* to nodes. Elements are
   scattered in memory.
2. **Lookup is pointer chasing.** Hash the key, index the bucket array (one
   miss), follow the node pointer (another miss), compare keys, maybe follow the
   next node. Each hop is a likely **cache miss** — the killer on modern CPUs,
   where a miss to DRAM costs ~hundreds of cycles versus ~1 for an L1 hit.

### Load factor and rehashing

The **load factor** is `size() / bucket_count()` — average elements per bucket.
As it climbs, chains lengthen and lookups slow. When it would exceed
`max_load_factor()` (default `1.0`), the container **rehashes**: it allocates a
bigger bucket array (typically next prime or next power of two) and redistributes
every element. Rehash is O(n) and allocates — a latency spike you must not eat in
a hot path.

```cpp
#include <unordered_map>
std::unordered_map<int, double> m;
m.max_load_factor(0.7);   // rehash sooner -> shorter chains, more memory
m.reserve(1'000'000);     // pre-size bucket array for 1M elements: NO rehash later
// reserve(n) ensures the table can hold n elements without rehashing.
```

> **Interview gotcha:** `reserve` on an `unordered_map` sizes the *bucket array*
> for a target element count; it does **not** allocate the nodes. It's still the
> single most important call for avoiding mid-run rehash spikes.

### Iterator and reference invalidation

This is heavily tested. The rules (C++11, [container.requirements]):

- **Rehash** (triggered by insert, or explicit `rehash`/`reserve`) **invalidates
  all iterators**, but **never invalidates pointers or references to elements** —
  the nodes themselves don't move, only the bucket array is rebuilt.
- `erase` invalidates only iterators/references to the *erased* element.
- Insert that does **not** rehash invalidates **no** iterators at all.

So you may safely hold a `value_type*` across inserts (the node is pinned) — a
property `std::vector` cannot offer. That pointer stability is sometimes the
*reason* to choose a node-based container.

## Custom hash and equality

For a non-built-in key you supply a hash and an equality. The full template is
`unordered_map<Key, T, Hash, KeyEqual, Allocator>`.

```cpp
#include <unordered_set>
#include <functional>   // std::hash
#include <string>

struct Instrument {
    std::string symbol;
    int         venue;
    bool operator==(const Instrument&) const = default;  // C++20
};

// 1) A hash functor. Combine fields; do NOT just XOR (symmetric -> collisions).
struct InstrumentHash {
    std::size_t operator()(const Instrument& i) const noexcept {
        std::size_t h = std::hash<std::string>{}(i.symbol);
        // boost::hash_combine-style mix; the constants spread the bits.
        h ^= std::hash<int>{}(i.venue) + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
        return h;
    }
};

std::unordered_set<Instrument, InstrumentHash> universe;
```

Two invariants the standard requires of you: **equal keys must hash equal**
(`a == b ⇒ hash(a) == hash(b)`), and a good hash should spread distinct keys
across the whole `size_t` range. A poor hash (e.g. returning `i.venue`) is legal
but turns every lookup into a linear scan of one giant chain.

> **Pitfall:** `std::hash<int>` is the *identity* in libstdc++ and libc++ — it
> returns the value unchanged. Combined with `% bucket_count`, sequential integer
> keys can pile into a few buckets. Mix your integer keys, or use a table that
> hashes internally.

## Heterogeneous lookup (C++20 transparent hashing)

Classic trap: a `std::unordered_map<std::string, V>` keyed by string, looked up
with a `const char*` or `std::string_view`, constructs a **temporary
`std::string`** (an allocation!) on every `find`. C++20 fixed this with
*transparent* hashing — declare a `is_transparent` member on both the hash and
the equality, and `find`/`contains`/`count` accept any type the hasher can hash:

```cpp
#include <unordered_map>
#include <string>
#include <string_view>

struct StringHash {
    using is_transparent = void;                       // enables heterogeneous lookup
    std::size_t operator()(std::string_view sv) const noexcept {
        return std::hash<std::string_view>{}(sv);
    }
};

std::unordered_map<std::string, int, StringHash, std::equal_to<>> m;
m.emplace("ESZ4", 1);

std::string_view key = "ESZ4";
auto it = m.find(key);   // C++20: NO temporary std::string constructed
```

Note you must opt in on *both* the hash (`is_transparent`) and pass a transparent
equality such as `std::equal_to<>`. This is a frequent "make this lookup
allocation-free" interview ask.

## Why `std::unordered_map` is often slow in practice

It is correct and convenient, but its design forces three costs that matter when
you care about nanoseconds:

1. **Node-per-element** → an allocation per insert and elements scattered across
   the heap. Iteration and lookup chase pointers into cold cache lines.
2. **The mandated chaining + reference stability** *prevents* the
   cache-friendliest implementations. The standard's guarantees rule out a plain
   open-addressed table that stores values inline.
3. **`% bucket_count`** uses integer division/modulo on the hot path. Some libs
   use prime bucket counts (modulo by a runtime prime — slow) to tolerate weak
   hashes; that division can cost more than the lookup logic itself.

The canonical reference for *why this hurts* is Chandler Carruth's CppCon 2014
talk: the data structure's memory layout, not its big-O, dominates real
performance.

## Open-addressing alternatives (what HFT actually uses)

When the standard container is too slow, reach for an **open-addressing flat hash
map**: keys/values live *inline* in one contiguous array; collisions are resolved
by probing nearby slots rather than chasing pointers. One allocation, dense
storage, cache-friendly. The trade: pointers/references are **not** stable across
rehash (elements move), and erase is more involved (tombstones).

| Library | Type | Notes |
|---|---|---|
| **Abseil** | `absl::flat_hash_map` / `flat_hash_set` | SwissTable; SIMD metadata probing; the modern reference |
| **Abseil** | `absl::node_hash_map` | node-based — when you *need* pointer stability |
| **robin_hood** / **ankerl::unordered_dense** | `robin_hood::unordered_map`, `ankerl::unordered_dense::map` | header-only, very fast, dense storage |
| **Boost** | `boost::unordered_flat_map` | open-addressed, std-like API |

These are typically **drop-in** for `std::unordered_map`'s common API and
routinely several times faster on lookup-heavy workloads, precisely because they
avoid the node-per-element and pointer-chasing tax above.

> The senior interview answer to "which hash map?" is not "`std::unordered_map`."
> It's: *"unordered_map when I need reference stability or it's not hot; an
> open-addressed flat map (Abseil SwissTable / ankerl) when lookup latency
> matters and I can tolerate moving elements on rehash."*

## Collisions, worst case, and hash-flooding DoS

Average O(1) assumes a good hash. An adversary who can choose keys that all hash
to one bucket forces O(n) per operation — a **hash-flooding** denial-of-service.
In a market system the "adversary" is often just *pathological real data*:
sequential order ids hitting `std::hash<int>` = identity, all landing in adjacent
buckets. Mitigations: a strong/seeded hash (SipHash-style), keep the load factor
low, and `reserve` up front so chains stay short.

## Quant/HFT relevance & interview gotchas

- **Don't say O(1) and stop.** Say "amortized O(1) *average*, O(n) worst case,
  and the constant is dominated by cache misses." That distinction is the point.
- **Default to a flat hash map in the hot path.** `std::unordered_map` is the
  textbook answer and frequently the wrong one for latency.
- **`reserve` before a burst.** Pre-size to avoid mid-session rehash spikes; a
  rehash is an unbounded allocation + O(n) copy at the worst moment.
- **Reference stability is the one thing node-based wins.** If you hand out
  `T*`/`T&` into the map and mutate the map, you need node-based (`std::` or
  `absl::node_hash_map`) — flat maps move elements.
- **Heterogeneous lookup** (`is_transparent` + `std::string_view`) to kill the
  per-`find` `std::string` allocation is a classic "optimize this" question.
- **`operator[]` default-inserts.** `m[k]` on a missing key *creates* it (and on
  a map of values, value-initializes). Use `find`/`contains`/`at` for read-only
  access — accidental inserts are a real bug source.

## Key takeaways

1. Hashing containers give **amortized O(1) average** ops by hashing keys into
   buckets, at the cost of any ordering.
2. The standard **mandates separate chaining** → one heap node per element,
   pointer chasing, cache-unfriendly. References survive rehash; iterators do not.
3. **Load factor** drives **rehashing** (O(n), allocates). Call `reserve` to size
   the bucket array up front and avoid spikes.
4. Supply a **good custom `Hash`** (equal keys hash equal; mix the bits) and a
   matching `KeyEqual`; weak hashes degrade to O(n) chains.
5. Use **C++20 transparent hashing** (`is_transparent`, `std::equal_to<>`) for
   allocation-free heterogeneous lookup.
6. For HFT, prefer **open-addressing flat maps** (Abseil SwissTable, ankerl,
   robin_hood) — inline storage, one allocation, far better cache behavior.

## Self-check

1. Why does the standard's iterator-invalidation rule for rehash (iterators die,
   references live) force a node-based, chained implementation?
2. You look up an `unordered_map<std::string, V>` with a `string_view` 10M times
   per second. Where is the hidden cost and how do you remove it?
3. What does `reserve(n)` allocate, and what does it *not* allocate?
4. Give a key distribution that turns `std::unordered_map<int, V>` average O(1)
   into O(n) on libstdc++, and explain why.
5. When would you deliberately choose `std::unordered_map` over
   `absl::flat_hash_map`?
6. Why might two correct hash maps with identical big-O differ 5× in throughput?

## Further reading

- [`std::unordered_map` — cppreference](https://en.cppreference.com/w/cpp/container/unordered_map) and [`std::unordered_set`](https://en.cppreference.com/w/cpp/container/unordered_set)
- [Unordered associative container requirements — cppreference](https://en.cppreference.com/w/cpp/named_req/UnorderedAssociativeContainer) (the chaining/invalidation guarantees)
- [Abseil — Swiss Tables design notes](https://abseil.io/about/design/swisstables) and [the `absl` hash containers](https://abseil.io/docs/cpp/guides/container)
- [Matt Kulukundis, "Designing a Fast, Efficient, Cache-friendly Hash Table, Step by Step" — CppCon 2017](https://www.youtube.com/watch?v=ncHmEUmJZf4)
- [`std::equal_to<>` and transparent comparators — cppreference](https://en.cppreference.com/w/cpp/utility/functional/equal_to_void)
- [ankerl::unordered_dense](https://github.com/martinus/unordered_dense) and [robin_hood::unordered_map](https://github.com/martinus/robin-hood-hashing) — header-only fast hash maps
- Scott Meyers, *Effective STL*, Item 25 (familiarize yourself with the unordered containers) — and Item 7 on container choice generally.
- [Hash flooding / SipHash background](https://en.wikipedia.org/wiki/SipHash) — why production hashes are seeded.

## Videos

- Chandler Carruth — **"Efficiency with Algorithms, Performance with Data Structures"**, CppCon 2014 ([watch](https://www.youtube.com/watch?v=fHNmRkzxHWs)) — the definitive "why node-based containers lose to flat ones" talk.
- Matt Kulukundis — **"Designing a Fast, Efficient, Cache-friendly Hash Table, Step by Step"**, CppCon 2017 ([watch](https://www.youtube.com/watch?v=ncHmEUmJZf4)) — how SwissTable actually works.
- Malte Skarupke — **"Comparing Hash Tables"** ([search](https://www.youtube.com/results?search_query=Malte+Skarupke+comparing+hash+tables)) — practical benchmarks across designs.
