# Design LFU Cache

> **Why a quant dev must own this:** LFU is the "hard mode" of cache-eviction
> interview questions — the naive answer is a heap (O(log n)), and the
> interviewer wants the **O(1)** answer. Beyond the puzzle, frequency-based
> eviction is the right policy when access *count* predicts future use better
> than recency: keep the venues, symbols, or computed values you hit *most
> often*, not most recently. Getting the O(1) structure right — three intertwined
> maps, a moving min-frequency pointer, and recency tie-breaking — is exactly the
> kind of pointer-discipline-under-pressure HFT firms probe for.

## Problem statement

Build a fixed-capacity key→value cache with both operations in **O(1)**:

- `get(key)` → return the value if present and **increment that key's access
  frequency**; else signal a miss.
- `put(key, value)` → insert or update; on update, increment frequency; if at
  capacity, **evict the least-frequently-used** entry first. **Ties** (multiple
  keys at the minimum frequency) are broken by **least-recently-used** among
  them.

This is LeetCode 460. The recency tie-break is the part candidates forget and
interviewers always ask about.

**C++ standard used here: C++17** (unchanged in C++20/23; I note where newer
standards help).

## Clarifying constraints (say these out loud)

- **Capacity** is fixed and `>= 1` (the edge case `capacity == 0` should make
  every `put` a no-op — handle it explicitly).
- **Frequency on update**: does `put` to an existing key bump frequency? Yes
  (an access). Confirm this — some variants don't count updates.
- **Tie-break policy**: among the least-frequently-used, evict the
  least-recently-used. This is the standard LFU contract.
- **Frequency overflow**: counts grow unboundedly in principle. For an interview,
  `size_t` won't overflow; for production, see the *aging* follow-up.
- **Thread-safety**: single-threaded, like LRU. Concurrent LFU is even harder
  than concurrent LRU because *every* access mutates frequency state.

## Why the heap answer isn't good enough

The obvious design: a min-heap keyed by `(frequency, last_access_time)`. `get`
bumps a key's frequency and re-heapifies; eviction pops the min. But heap
operations are **O(log n)**, and updating an arbitrary key's priority requires
finding it in the heap (an extra index) plus a sift — still log n. The
interviewer's "can you do O(1)?" rules this out. State it, then build the real
thing.

## The O(1) design: frequency buckets of recency-ordered lists

The insight that collapses LFU to O(1): **group keys by frequency, and within
each frequency keep them in recency order.**

Three structures:

1. **`key_map`**: `key → KeyInfo{ value, freq, list-iterator }`. O(1) lookup of
   everything we need about a key.
2. **`freq_map`**: `freq → doubly linked list of keys` that currently have that
   frequency. The list is ordered MRU-front, LRU-back (a "recency lane" per
   frequency).
3. **`min_freq`**: an integer tracking the **smallest frequency** any key
   currently has. This is what makes eviction O(1) — the eviction victim is the
   **LRU end (back) of `freq_map[min_freq]`**.

```text
  key_map:                          freq_map (freq -> recency list, MRU..LRU):
  +-----+----------------------+
  |  k1 | {v, freq=1, it} -----+----> freq 1: [ k1 ] <-> [ k4 ]   (LRU = k4)
  |  k4 | {v, freq=1, it} -----+          ^ min_freq = 1
  |  k2 | {v, freq=3, it} -----+----> freq 3: [ k2 ]
  |  k9 | {v, freq=5, it} -----+----> freq 5: [ k9 ]
  +-----+----------------------+

  eviction victim = back of freq_map[min_freq] = freq_map[1].back() = k4
```

### How each operation stays O(1)

- **`get(k)` / touch**: look up `k` in `key_map` (O(1)). It has frequency `f`.
  Remove it from `freq_map[f]` (O(1) splice/erase), increment its frequency to
  `f+1`, push it to the **front** of `freq_map[f+1]` (O(1)). Then the only
  subtle part: **if `freq_map[f]` is now empty AND `f == min_freq`, increment
  `min_freq`** (to `f+1`). That's the whole min-frequency maintenance — and it's
  correct precisely *because* a touch raises a key by exactly one, so when the
  current minimum lane empties, the new minimum is exactly one higher.
- **`put` new key**: if full, evict `freq_map[min_freq].back()`. Insert the new
  key with **frequency 1**, push to front of `freq_map[1]`, and **set
  `min_freq = 1`** (a brand-new key is the new global minimum).
- **`put` existing key**: update value, then do the same touch as `get`.

Every operation is a bounded number of hash lookups + list splices: **true O(1)
amortized** (amortized only over the hash maps' rehashing, which we reserve
away).

> **The two rules that make `min_freq` correct, memorize them:**
> (1) a fresh insert sets `min_freq = 1`;
> (2) a touch that empties `freq_map[min_freq]` raises `min_freq` by 1.
> Nothing else moves it. Eviction never lowers it (it only removes from the
> current min lane; if that empties, the *next* insert resets it to 1 anyway).

## Complete, annotated reference implementation

```cpp
#include <unordered_map>
#include <list>
#include <optional>
#include <cstddef>
#include <utility>

template <class K, class V>
class LfuCache {
public:
    explicit LfuCache(std::size_t capacity) : cap_(capacity) {
        key_map_.reserve(capacity);
    }

    std::optional<V> get(const K& key) {
        auto it = key_map_.find(key);
        if (it == key_map_.end()) return std::nullopt;
        touch(it);                                   // bump frequency
        return it->second.value;
    }

    void put(const K& key, V value) {
        if (cap_ == 0) return;                       // degenerate cache

        if (auto it = key_map_.find(key); it != key_map_.end()) {
            it->second.value = std::move(value);     // update existing
            touch(it);
            return;
        }

        if (key_map_.size() == cap_)                 // full -> evict LFU+LRU
            evict();

        // Insert brand-new key at frequency 1; it becomes the new global min.
        auto& lane = freq_map_[1];
        lane.push_front(key);                        // MRU end of freq-1 lane
        key_map_.emplace(key, KeyInfo{std::move(value), 1, lane.begin()});
        min_freq_ = 1;
    }

    std::size_t size() const noexcept { return key_map_.size(); }

private:
    // freq_map_ maps a frequency to a recency-ordered list of keys
    // (front = most recently used at this frequency, back = least recent).
    using FreqList = std::list<K>;
    using FreqIter = typename FreqList::iterator;

    struct KeyInfo {
        V         value;
        std::size_t freq;
        FreqIter  pos;        // this key's position in freq_map_[freq]
    };

    // Promote a key by one frequency level. O(1). The map iterator `it`
    // refers to an entry in key_map_.
    template <class It>
    void touch(It it) {
        KeyInfo& info = it->second;
        const std::size_t f = info.freq;

        FreqList& cur = freq_map_[f];
        cur.erase(info.pos);                         // O(1): we hold the iterator

        // If we just emptied the minimum lane, the new minimum is f+1.
        if (cur.empty()) {
            freq_map_.erase(f);                      // keep freq_map_ tidy
            if (min_freq_ == f) ++min_freq_;
        }

        FreqList& nxt = freq_map_[f + 1];
        nxt.push_front(it->first);                   // MRU end of next lane
        info.freq = f + 1;
        info.pos  = nxt.begin();
    }

    // Remove the least-frequently-used, least-recently-used key. O(1).
    void evict() {
        FreqList& lane = freq_map_[min_freq_];       // the minimum-frequency lane
        const K& victim = lane.back();               // LRU within that lane
        key_map_.erase(victim);
        lane.pop_back();
        if (lane.empty()) freq_map_.erase(min_freq_);
        // min_freq_ will be reset to 1 by the insert that follows in put().
    }

    std::size_t cap_;
    std::size_t min_freq_ = 0;
    std::unordered_map<K, KeyInfo>           key_map_;
    std::unordered_map<std::size_t, FreqList> freq_map_;
};
```

Walk through the load-bearing details:

- **`KeyInfo::pos` is a `std::list::iterator`.** `std::list` iterators are
  *stable* — they survive insertions/erasures of *other* elements — so we can
  cache a key's position and later `erase`/`splice` it in O(1). This is the same
  trick the LRU cache uses, and it's why `std::list` (not `std::vector`) is the
  right list here.
- **Eviction order is `lane.back()`**: the back of the minimum-frequency lane is
  the least-recently-used among the least-frequently-used — both tie-break rules
  satisfied in one access.
- **New keys go to `freq_map_[1]` and force `min_freq_ = 1`.** Don't forget the
  reset; it's the single most common bug. A freshly inserted key is by
  definition the least-frequently-used (frequency 1).
- **Erasing empty lanes (`freq_map_.erase(f)`)** keeps the frequency map from
  accumulating dead buckets — important if frequencies climb high over a long
  run.

### Splice instead of erase+push (a micro-optimization)

`erase` from one list + `push_front` to another is two node operations
(`std::list` nodes are heap-allocated, so that's a free + malloc). `std::list`
lets you **move** a node between lists with **zero allocation** via `splice`,
preserving the node and its iterator:

```cpp
// Inside touch(), replacing the erase + push_front:
FreqList& nxt = freq_map_[f + 1];
nxt.splice(nxt.begin(), cur, info.pos);   // move node to front of next lane,
info.freq = f + 1;                        // O(1), NO allocation, iterator valid
// info.pos is unchanged — it still names the (now-moved) node.
```

`splice` is O(1), allocates nothing, and **keeps `info.pos` valid** because the
node itself didn't move in memory, only its list membership. This is the version
you want on a hot path. (Re-fetch `cur`/check-empty in the same order as before.)

## Complexity

```text
operation   time              space
---------   ----              -----------------------------------
get         O(1) amortized*   -
put         O(1) amortized*   -
overall     -                 O(capacity): key_map + freq lists hold
                              exactly `size` keys total across all lanes
```

\*Amortized only because of the two `unordered_map`s' rehashing; the list splices
and the `min_freq` bump are worst-case O(1). With `reserve` on `key_map_` the
load factor is bounded and it's effectively flat O(1).

## LFU vs. LRU — the comparison interviewers want

```text
                LRU                          LFU
-----------     -------------------------    --------------------------------
evicts          least RECENTLY used          least FREQUENTLY used
                                             (ties -> least recently used)
structures      1 list + 1 map               2 maps + N recency lists + min_freq
state per key   position in 1 list           value, freq, position in its lane
strength        adapts fast to working-set   keeps long-term hot keys; resists
                shifts                       one-shot scan pollution
weakness        a burst of cold keys flushes new-but-hot keys can be evicted
                the hot set (scan pollution) before they prove themselves;
                                             stale high-freq keys linger ("cache
                                             pollution by history")
```

- **LRU** is simpler and adapts instantly when the working set changes — but a
  single sequential scan of cold keys evicts your entire hot set.
- **LFU** protects keys that are *consistently* hot and shrugs off one-shot
  scans — but it has the opposite failure mode: a key that was hot yesterday but
  is now cold keeps a high count and won't leave, and a genuinely-hot *new* key
  starts at frequency 1 and can be evicted before it accumulates count. The fixes
  are **aging** (decay counts over time) and **LFU-with-window** / **TinyLFU**.

## Low-latency optimizations (the senior layer)

- **Swap both `std::unordered_map`s for open-addressing flat maps** (Abseil
  `flat_hash_map`, `boost::unordered_flat_map`, `ankerl::unordered_dense`). The
  node-based `unordered_map` allocates per entry and pointer-chases on lookup;
  flat maps are contiguous → one cache miss instead of a chain walk. Biggest win,
  same as in the LRU lesson.
- **Replace `std::list` with an intrusive, arena-allocated doubly linked list.**
  `std::list` mallocs a node per key and frees on erase — exactly the per-op
  allocation HFT forbids. Preallocate `capacity` nodes in one `std::vector`,
  link them by `uint32_t` index, and `splice` becomes pure index rewiring. Use
  a **per-lane circular sentinel** (or one global node pool with per-frequency
  head indices) to kill null-branch handling. This is the same intrusive-arena
  technique from the LRU lesson, applied per frequency lane.
- **Bound the frequency map.** `freq_map_` keyed by an unbounded `size_t` can
  grow tall. If you cap frequency (saturating at, say, 255 → a `uint8_t`) and
  keep lanes in a small fixed array indexed by capped frequency, the "find the
  lane" step is a direct array index, not a hash lookup. Most workloads have few
  distinct frequencies, so a small dense vector of lanes beats a hash map.
- **Direct-index `key_map` for dense integer keys** (instrument IDs): array
  lookup, no hash, no probe — one load.
- **Avoid copying `V` out.** `std::optional<V>` copies; on the hot path return
  `const V*` (`nullptr` on miss) or fill a `V& out`.
- **`noexcept` the O(1) primitives** (`touch`, `evict`, the splice helpers) for
  better inlining and no unwind tables on the hot path.
- **`min_freq` maintenance is branch-light** — one compare and one increment per
  touch, only when the min lane empties. Don't over-engineer it.

## Follow-up variations interviewers ask

- **"Add aging / decay."** Pure LFU never forgets. Periodically halve all counts,
  or use a sliding window, or **TinyLFU** (a count-min sketch of recent
  frequencies in front of a small LRU window — used by Caffeine and many modern
  caches) to get LFU's scan resistance *and* LRU's adaptivity. Naming TinyLFU /
  W-TinyLFU here is a strong signal.
- **"Tie-break by FIFO instead of LRU."** Then within a lane you insert at one
  end and evict from the same end you'd use for FIFO — change the push/pop ends;
  the structure is identical.
- **"What if `get` shouldn't count as a use?"** Decouple the frequency bump from
  `get`; only `put`/explicit `touch` bumps. Same machinery.
- **"Make it thread-safe."** Harder than LRU because *every read* mutates
  frequency and possibly `min_freq` (shared, contended). Practical answers:
  **shard** by key, or use an **approximate** scheme (TinyLFU with a sketch that
  tolerates racy counters) so reads don't take a global lock.
- **"Why not a balanced BST / heap keyed on frequency?"** O(log n) per op and
  arbitrary-key priority updates need an index anyway — strictly worse than the
  bucket design. Use it only if you also need ordered iteration over frequencies.
- **"Frequency overflow."** Saturate the counter (cap at the max of its type) and
  combine with aging; an ever-incrementing `size_t` is fine for an interview but
  not for a multi-day process.

## Key takeaways

1. The O(1) LFU is **three structures**: `key → info`, `frequency → recency-list
   of keys`, and a `min_freq` integer. The heap answer is O(log n) — say why
   it's insufficient, then build this.
2. **Eviction = back of `freq_map[min_freq]`**: least-frequently-used, and
   least-recently-used among ties, in one O(1) access.
3. **`min_freq` moves by only two rules**: a fresh insert resets it to 1; a touch
   that empties the current min lane raises it by 1. Memorize them — the reset is
   the #1 bug.
4. Each lane is **recency-ordered** (MRU front, LRU back) to satisfy the
   tie-break; `std::list::splice` moves a key between lanes in O(1) with no
   allocation and stable iterators.
5. **LFU vs LRU**: LFU resists scan pollution and keeps long-term-hot keys but
   suffers from historical staleness and slow warm-up; LRU is the opposite.
   **TinyLFU/aging** bridges them.
6. The HFT layer is the same as LRU's: **flat open-addressing maps**,
   **intrusive arena-allocated lists**, capped/dense frequency lanes, and no
   per-operation allocation.

## Self-check

1. Why is the eviction victim specifically `freq_map[min_freq].back()` and not
   `.front()`? Which tie-break rule does the `.back()` enforce?
2. After a `get` that raises key `k` from frequency 3 to 4, under exactly what
   condition does `min_freq` change, and to what value?
3. Why must a newly inserted key set `min_freq = 1` even if the cache currently
   has keys at frequency 1 already? What goes wrong if you forget the reset?
4. Why is `std::list::splice` preferable to `erase` + `push_front` when promoting
   a key, and why does the cached iterator (`KeyInfo::pos`) stay valid across it?
5. Give a concrete access pattern where LFU outperforms LRU, and one where LRU
   outperforms LFU.
6. A long-running process shows a key with `freq == 4,000,000` that hasn't been
   accessed in hours yet never gets evicted. What policy fixes this, and name one
   production cache that implements it.

## Further reading

- [LeetCode 460 — LFU Cache](https://leetcode.com/problems/lfu-cache/) — the
  problem statement with the recency tie-break spelled out.
- Shah, Matani & Mitzenmacher, [**"An O(1) algorithm for implementing the LFU cache eviction scheme"** (PDF)](http://dhruvbird.com/lfu.pdf)
  — the original paper behind the bucket design; short and worth reading.
- [Gil Einziger et al., **TinyLFU: A Highly Efficient Cache Admission Policy** (paper)](https://arxiv.org/abs/1512.00727)
  — the count-min-sketch admission filter that fixes LFU's weaknesses.
- [Caffeine cache — design / W-TinyLFU wiki](https://github.com/ben-manes/caffeine/wiki/Efficiency)
  — a production cache combining a window-LRU with TinyLFU; excellent intuition
  and hit-rate comparisons vs. plain LRU/LFU.
- [`std::list::splice` — cppreference](https://en.cppreference.com/w/cpp/container/list/splice)
  — the O(1), non-allocating, iterator-stable move that the hot-path version uses.
- [Abseil — Swiss Tables (`flat_hash_map`) design](https://abseil.io/about/design/swisstables)
  — the open-addressing map to replace `std::unordered_map`.
- [ankerl::unordered_dense](https://github.com/martinus/unordered_dense) — a
  dense, cache-friendly hash map with benchmarks, ideal for `key_map`.

## Videos

- CppCon — **Chandler Carruth, "Efficiency with Algorithms, Performance with Data Structures"**
  ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures))
  — why node-based containers (`std::list`/`unordered_map`) lose to contiguous
  layouts; the case for the intrusive-arena rewrite.
- CppCon — **Carl Cook, "When a Microsecond Is an Eternity"**
  ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity))
  — the HFT discipline (no allocation, no jitter) behind the low-latency layer.
