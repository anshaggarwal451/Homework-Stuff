# Design LRU Cache

> **Why a quant dev must own this:** An LRU cache is the canonical "show me you
> understand pointers, hashing, and O(1) amortized data structures" interview
> problem — and in HFT it's not a toy. Symbol-to-instrument maps, decoded order
> book snapshots, computed greeks, and reference-data lookups all live in
> bounded caches on the hot path. The difference between a textbook
> `std::list + std::unordered_map` answer and an *intrusive, preallocated,
> zero-malloc* design is the difference between a candidate and a hire.

## Problem statement

Build a fixed-capacity key→value cache supporting two operations, both in
**O(1)** time:

- `get(key)` → return the value if present (and mark it most-recently-used), else
  signal "miss".
- `put(key, value)` → insert or update; if at capacity, **evict the
  least-recently-used** entry first.

"Recently used" is touched by *both* `get` and `put`. This is the classic
LeetCode 146 framing, but we'll answer it the way you'd want to in a trading
firm's interview.

**C++ standard used here: C++17** (works unchanged in C++20/23; I note where a
newer standard helps).

## Clarifying constraints (say these out loud)

Good candidates pin down the contract before coding:

- **Capacity** is fixed and known up front (`capacity >= 1`). This is what lets
  us preallocate.
- **Key/value types**: assume `int → int` for the reference impl, but design so
  the structure is templatable. In HFT keys are often `uint32_t` instrument IDs
  or small POD structs.
- **Thread-safety**: single-threaded is the standard assumption. Say so. A
  concurrent LRU is a *much* harder problem (sharding, or a CLOCK/2Q
  approximation) and you should flag that you know the difference.
- **What does `get` return on a miss?** `std::optional`, a sentinel, or a
  `bool found` out-param. I'll use `std::optional` for clarity and mention the
  hot-path alternative.
- **Update semantics**: `put` on an existing key updates the value *and* bumps
  recency.

## Approach: the two-data-structure invariant

A single data structure can't give you O(1) on both axes:

- A **hash map** gives O(1) lookup by key, but has no notion of order.
- A **doubly linked list** gives O(1) move-to-front and O(1) removal of any node
  *if you already hold a pointer to it* — but O(n) lookup by key.

Combine them. Keep a doubly linked list ordered most-recently-used (MRU) at the
front, least-recently-used (LRU) at the back. Keep a hash map from key to the
**list node** holding that key's value.

```text
         hash map (key -> node*)                  doubly linked list
       +-----+--------------------+       MRU front                  LRU back
       |  7  | ----------------------> [k=7] <-> [k=3] <-> [k=9] <-> [k=1]
       |  3  | -------------------------^  ^                          ^
       |  9  | ----------------------------|                          |
       |  1  | ---------------------------------------------------------
       +-----+--------------------+
```

- `get(k)`: map lookup → node; **splice** that node to the front; return value.
- `put(k,v)`: if present, update value + splice to front; else create a node at
  the front and insert into map; if size exceeds capacity, pop the **back** node
  and erase its key from the map.

Every operation is a constant number of pointer updates plus one hash operation:
**O(1) amortized** (the "amortized" is purely the hash map's rehashing, which we
kill below by reserving).

### Why the list must be *doubly* linked

Eviction removes the back node, and we must unlink it in O(1). A singly linked
list can't get the predecessor of a node without a scan. Use a **circular list
with a sentinel** node to eliminate every `nullptr` branch (head/tail special
cases) — fewer mispredicted branches in the hot path, and cleaner code.

## The textbook implementation (`std::list` + `std::unordered_map`)

This is the answer you write first to prove correctness. The trick that makes it
clean is storing a `std::list::iterator` in the map and using
`std::list::splice` to move a node to the front **without** invalidating that
iterator (list iterators are stable across splice).

```cpp
#include <list>
#include <unordered_map>
#include <optional>
#include <utility>

template <class K, class V>
class LruCacheStd {
public:
    explicit LruCacheStd(std::size_t capacity) : cap_(capacity) {
        map_.reserve(capacity);           // avoid rehash on the hot path
    }

    std::optional<V> get(const K& key) {
        auto it = map_.find(key);
        if (it == map_.end()) return std::nullopt;
        // Splice the node to the front; iterator stays valid.
        order_.splice(order_.begin(), order_, it->second);
        return it->second->second;        // node is pair<K,V>
    }

    void put(const K& key, V value) {
        auto it = map_.find(key);
        if (it != map_.end()) {                       // update + promote
            it->second->second = std::move(value);
            order_.splice(order_.begin(), order_, it->second);
            return;
        }
        if (map_.size() == cap_) {                    // evict LRU (list back)
            const K& victim = order_.back().first;
            map_.erase(victim);
            order_.pop_back();
        }
        order_.emplace_front(key, std::move(value));  // new MRU
        map_.emplace(key, order_.begin());
    }

private:
    using Node = std::pair<K, V>;
    std::size_t cap_;
    std::list<Node> order_;                           // front = MRU, back = LRU
    std::unordered_map<K, typename std::list<Node>::iterator> map_;
};
```

This is correct, readable, and O(1) — and it's exactly what most candidates stop
at. The senior critique is right there in the data members: **`std::list`
heap-allocates a node per element** (every `emplace_front` is a `malloc`,
`pop_back` a `free`), and **`std::unordered_map` is a chained hash map** that
also allocates per node and scatters those nodes across the heap. On a hot path
that's two allocations per insert and a pointer-chase storm on every lookup.
That's unacceptable in HFT.

## The HFT implementation: intrusive list over a preallocated arena

The fixed capacity is a gift. We allocate **all** nodes once, in a single
contiguous `std::vector`, and refer to them by **32-bit index** instead of
pointer. The doubly linked list becomes *intrusive* — the prev/next links live
inside each node — so there's **zero per-operation allocation** and the nodes are
cache-friendly neighbors in memory.

```cpp
#include <vector>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <utility>

// Fixed-capacity LRU. Zero allocation after construction.
// Intrusive circular doubly linked list over an index-addressed node arena.
template <class K, class V>
class LruCache {
    using Index = std::uint32_t;
    static constexpr Index kNil = 0;      // slot 0 is the sentinel (never a key)

    struct Node {
        K     key{};
        V     value{};
        Index prev = kNil;
        Index next = kNil;
    };

public:
    explicit LruCache(std::uint32_t capacity)
        : cap_(capacity), nodes_(capacity + 1) {   // +1 for the sentinel
        map_.reserve(capacity);
        // Sentinel at index 0; list is empty -> it points to itself.
        nodes_[kNil].prev = kNil;
        nodes_[kNil].next = kNil;
        // Build the free list of usable slots [1 .. capacity].
        free_top_ = 1;
        for (Index i = 1; i <= capacity; ++i)
            nodes_[i].next = (i == capacity) ? kNil : i + 1;
    }

    std::optional<V> get(const K& key) {
        auto it = map_.find(key);
        if (it == map_.end()) return std::nullopt;
        const Index n = it->second;
        move_to_front(n);
        return nodes_[n].value;
    }

    void put(const K& key, V value) {
        if (auto it = map_.find(key); it != map_.end()) {  // update + promote
            const Index n = it->second;
            nodes_[n].value = std::move(value);
            move_to_front(n);
            return;
        }
        Index n;
        if (size_ == cap_) {              // full: recycle the LRU (back) node
            n = nodes_[kNil].prev;        // sentinel.prev == real tail == LRU
            map_.erase(nodes_[n].key);
            unlink(n);                    // detach from list, keep the slot
        } else {                          // take a fresh slot from free list
            n = free_top_;
            free_top_ = nodes_[n].next;
            ++size_;
        }
        nodes_[n].key   = key;
        nodes_[n].value = std::move(value);
        link_front(n);
        map_.emplace(key, n);
    }

    std::uint32_t size() const noexcept { return size_; }

private:
    // --- circular list primitives: all branch-free, O(1) ---
    void unlink(Index n) noexcept {
        nodes_[nodes_[n].prev].next = nodes_[n].next;
        nodes_[nodes_[n].next].prev = nodes_[n].prev;
    }
    void link_front(Index n) noexcept {            // insert just after sentinel
        const Index head = nodes_[kNil].next;
        nodes_[n].prev = kNil;
        nodes_[n].next = head;
        nodes_[head].prev = n;
        nodes_[kNil].next = n;
    }
    void move_to_front(Index n) noexcept {
        if (nodes_[kNil].next == n) return;        // already MRU: no work
        unlink(n);
        link_front(n);
    }

    std::uint32_t cap_;
    std::uint32_t size_ = 0;
    Index         free_top_ = kNil;                // head of free-slot list
    std::vector<Node> nodes_;                      // [0]=sentinel, [1..cap]=data
    std::unordered_map<K, Index> map_;
};
```

What changed and why it matters:

- **One allocation, ever** (the `nodes_` vector, plus the map's buckets which we
  `reserve`). No `malloc`/`free` in `get`/`put`. Allocation in a hot path is a
  latency spike and a source of jitter — the cardinal HFT sin.
- **Index-based links (`uint32_t`)** instead of 64-bit pointers halve the link
  footprint and make a node smaller → more nodes per cache line. They also
  survive a `vector` move/relocation, which raw pointers wouldn't.
- **Circular sentinel** removes head/tail null checks: `unlink`/`link_front` are
  straight-line, branch-free pointer arithmetic. `move_to_front` has the single
  *predictable* early-out for the common "touch the MRU again" case.
- **Free list threaded through the unused `next` field** means slot recycling is
  also O(1) with no bookkeeping container.

## Complexity

```text
operation   time              space
---------   ----              -----
get         O(1)              -
put         O(1) amortized*   -
build       O(capacity)       O(capacity) one contiguous arena + map buckets
```

\*The only non-worst-case-O(1) piece is the hash map. With `reserve(capacity)`
up front the load factor never forces a rehash, so in practice it's flat O(1).
The intrusive list operations are *true* worst-case O(1) — a bounded number of
pointer writes.

## Low-latency optimizations (the senior layer)

- **Kill the `std::unordered_map`.** It's the remaining weak link: separate
  chaining, per-node allocation, pointer-chasing on lookup, and poor cache
  behavior. Replace it with an **open-addressing flat hash map** (e.g.
  `absl::flat_hash_map`, `boost::unordered_flat_map`, `ankerl::unordered_dense`,
  or a hand-rolled linear-probing table sized to a power of two). Open addressing
  keeps the whole table in a contiguous array → one cache miss instead of a
  chain walk, and it can store the small `Index` value inline. This is usually
  the single biggest win.
- **Specialize the key.** If keys are dense small integers (instrument IDs
  0..N), skip hashing entirely: a direct-indexed array `key → Index` is a single
  load, no hash, no probe. Trade memory for a guaranteed one-load lookup.
- **Avoid `std::optional<V>` for large `V`.** Returning `std::optional<V>` copies
  the value out. On the hot path prefer `const V* get(const K&)` returning
  `nullptr` on miss (no copy, caller decides), or a `bool get(const K&, V& out)`.
- **`noexcept` everything** that can't throw — it widens inlining and lets the
  compiler omit unwind tables on the hot path.
- **Mind `move_to_front`'s common case.** In many real workloads the same hot
  keys are touched repeatedly; the `already MRU` early-out skips all the pointer
  writes. Some designs add a CLOCK-style "recently used" bit to *avoid* the
  splice entirely on `get`, trading exact-LRU for fewer writes (see follow-ups).
- **False sharing**: this structure is single-threaded by design. If you shard
  it across threads, pad each shard to its own cache line (`alignas(64)`),
  exactly as you would any concurrent structure.

## Follow-up variations interviewers ask

- **"Make it thread-safe."** Don't bolt a single mutex on — that serializes the
  hot path. The real answers: (1) **shard** by `hash(key) % N` into N independent
  caches, each with its own lock; (2) use an **approximate** policy (CLOCK / 2Q /
  segmented LRU) that needs no list splice on read, only a bit flip, so reads can
  be lock-free. State that exact-LRU + concurrency is fundamentally contended
  because every read mutates shared order.
- **"Add TTL / expiry."** Store an insertion timestamp per node; on `get`, treat
  an expired entry as a miss and evict it. A min-heap or a timer wheel handles
  proactive expiry.
- **"LRU-K / 2Q."** Evict based on the K-th most recent access rather than the
  most recent — resists cache pollution from one-shot scans (a burst of cold
  keys won't flush your hot set). 2Q is the practical approximation.
- **"Why not `std::list`?"** Now you give the allocation/cache argument above.
- **"What if capacity can grow?"** Then you lose the preallocation guarantee;
  discuss amortized vector growth vs. a node pool with chunked allocation.
- **LFU instead of LRU** — a strictly harder eviction policy; see the companion
  LFU lesson.

## Key takeaways

1. **Hash map for lookup + doubly linked list for order** is the O(1) recipe;
   the map stores *handles into the list*, never copies of order.
2. The list must be **doubly linked** so eviction can unlink the LRU node in
   O(1); a **circular sentinel** erases head/tail branches.
3. `std::list + std::unordered_map` is the correct *first* answer but allocates
   per operation and chases pointers — fine for an interview warm-up, wrong for a
   hot path.
4. The HFT answer is an **intrusive list over a preallocated index-addressed
   arena**: zero per-op allocation, compact `uint32_t` links, cache-friendly.
5. The map is the last bottleneck — swap `unordered_map` for an **open-addressing
   flat map**, or direct-index when keys are dense small integers.
6. Exact-LRU under concurrency is inherently contended (reads mutate order);
   **shard** or go **approximate** (CLOCK/2Q).

## Self-check

1. Why can't a single `std::map` (or `std::unordered_map`) alone give O(1) on
   both `get` and eviction?
2. In the `std::list` version, why is it safe to keep a `list::iterator` in the
   hash map across a `splice`? Which container's iterators would *not* survive
   the equivalent operation?
3. In the intrusive version, why use `uint32_t` indices instead of `Node*`
   pointers? Name two distinct advantages.
4. What is the purpose of the sentinel node at index 0, and how does it remove
   branches from `unlink`?
5. Your profiler shows `get` is dominated by cache misses even though the list is
   contiguous. Where are the misses coming from, and what do you change?
6. A reviewer asks you to "just add a `std::mutex`" to make it thread-safe.
   Explain why that defeats the purpose and what you'd do instead.

## Further reading

- [LeetCode 146 — LRU Cache](https://leetcode.com/problems/lru-cache/) — the
  canonical problem statement and constraints.
- [`std::list::splice` — cppreference](https://en.cppreference.com/w/cpp/container/list/splice)
  — note the iterator-stability guarantee that the textbook version relies on.
- [`std::unordered_map` — cppreference](https://en.cppreference.com/w/cpp/container/unordered_map)
  — and *why* its node-based chaining is cache-hostile.
- [Malte Skarupke — "I Wrote a Fast Hashtable"](https://probablydance.com/2017/02/26/i-wrote-the-fastest-hashtable/)
  and the open-addressing follow-ups — motivation for replacing `unordered_map`.
- [Abseil — Swiss Tables design notes (`flat_hash_map`)](https://abseil.io/about/design/swisstables)
  — the production open-addressing map.
- [ankerl::unordered_dense](https://github.com/martinus/unordered_dense) — a
  drop-in, dense, cache-friendly hash map with benchmarks.
- [The "intrusive container" idea — Boost.Intrusive rationale](https://www.boost.org/doc/libs/release/doc/html/intrusive/intrusive_vs_nontrusive.html)
  — why links-inside-the-node beats node-allocating containers for latency.

## Videos

- CppCon — **Chandler Carruth, "Efficiency with Algorithms, Performance with Data Structures"**
  ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures))
  — why contiguous, cache-friendly layouts beat node-based containers; directly
  motivates the intrusive/arena design.
- CppCon — **Carl Cook, "When a Microsecond Is an Eternity"**
  ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity))
  — the HFT mindset on allocation and jitter that makes the zero-malloc version
  non-negotiable.
