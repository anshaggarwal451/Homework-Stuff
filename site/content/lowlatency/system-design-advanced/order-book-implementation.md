# Order Book Implementation

> **Why this is *the* HFT interview problem:** the limit order book (LOB) is the
> central data structure of every electronic exchange, matching engine, and
> market-making strategy. Interviewers love it because it forces you to reason
> about data-structure choice under a brutal latency budget — adds/cancels
> arrive millions of times a second and the *median* path must be a handful of
> nanoseconds. The "textbook" answer (`std::map`) is the *wrong* answer in this
> seat, and being able to say *why*, then build the price-ladder that real
> venues use, is what separates a candidate who's read about HFT from one who
> could ship a matching engine.

All code is **C++17** (one `if constexpr`-free path; notes call out where C++20
`std::bit_cast`/`<bit>` would help).

## Problem statement

Implement a single-symbol **limit order book** supporting:

- `add(id, side, price, qty)` — insert a resting limit order.
- `cancel(id)` — remove a resting order by its id.
- `modify(id, new_qty)` — change quantity (and, in the general case, price).
- `match(side, price, qty)` — an **aggressive** (marketable) order crosses the
  book and executes against the opposite side, FIFO within each price level,
  best price first, until filled or no more crossable liquidity.
- `best_bid()` / `best_ask()` — top of book in O(1).

**Invariants of a LOB:**

```text
        ASKS (offers)  — sorted ASCENDING, lowest = best
        ...
        101.03  | qty 200  (3 orders, FIFO)
        101.02  | qty  50
  ----- best ask 101.01  | qty 100  -----   spread
  ----- best bid 101.00  | qty 300  -----
        100.99  | qty 150
        100.98  | qty 400  (5 orders, FIFO)
        ...
        BIDS    — sorted DESCENDING, highest = best
```

Within a single price level, orders rest in **time priority** (FIFO): the first
order in is the first to fill. A book is therefore *price-then-time* priority.

## Clarifying questions (say these out loud)

A senior candidate scopes before coding. The answers drive the data structure:

1. **Price domain.** Are prices integer ticks (almost always — exchanges quote
   in integer multiples of a tick size)? What is `[min_price, max_price]` and
   the tick size? *This decides whether a direct-addressed array is viable.*
2. **Dense or sparse?** Is the tradeable band small (a few thousand ticks, e.g.
   a future or an equity with circuit limits) or huge/unbounded (deep OTM
   options strikes)? Dense → array; sparse → map/hash.
3. **Market-by-order (MBO) or market-by-price (MBP)?** Do we track every
   individual order (needed for matching and for cancel-by-id), or only
   aggregated size per level (a consumer that just wants the book)?
4. **Single symbol or many?** One book per symbol; the per-symbol structure is
   what we're designing. Multi-symbol is an array/hash of these.
5. **Threading.** Single writer (one feed/matching thread per symbol) is the
   norm. I'll assume single-threaded hot path — no locks in the book itself.

I'll build the **MBO, dense integer-tick, single-symbol, single-threaded** case
— the one a matching engine or a full-book strategy uses — because it's the
hardest and subsumes the others.

## Approaches and tradeoffs

### Option A — `std::map<Price, Level>` (the textbook answer)

Two maps, `bids` (`std::greater` comparator) and `asks` (`std::less`). Best
price is `begin()`.

```text
add / cancel / match-step : O(log L)   L = number of populated levels
best bid/ask              : O(1)        (cached begin)
```

It's correct, sorted, handles sparse prices, and you can write it in five
minutes. **Why it loses in HFT:** every node is a separate red-black-tree
allocation, so the book is a pointer-chasing linked structure scattered across
the heap. Each `add`/`cancel` is a tree rebalance with a likely cache miss per
level touched. A cache miss is ~100–300 cycles; a tree of depth 10 can be a
dozen misses on the *median* path. You also can't cancel an order by id without
a separate `id -> iterator` map. It's the right answer for a backtester or a
risk system, the wrong answer for a colocated matching engine.

### Option B — sorted `std::vector` of levels

Better locality than a tree (contiguous), `O(1)` best via `back()`/`front()`,
but inserting a *new* price level is `O(L)` shifting. Fine if levels rarely
appear/disappear; the price-ladder below dominates it when prices are integers.

### Option C — direct-addressed **price ladder** (the HFT favorite)

If prices are integer ticks in a bounded band, **index a flat array by the tick
itself.** `levels[price - min_price]` *is* the level — no search, no tree, no
hashing. Best bid/ask are tracked incrementally as the highest/lowest occupied
slot. Within each level, an **intrusive doubly-linked list** gives O(1) FIFO
append (at tail) and O(1) unlink (cancel) when you hold the node pointer. An
`id -> Order*` hash map turns `cancel(id)` into a single lookup + unlink.

```text
add (known price)        : O(1)
cancel (by id)           : O(1)   hash lookup + intrusive unlink
modify (qty only)        : O(1)
match step               : O(1) amortized per fill + O(Δprice) to walk levels
best bid/ask             : O(1) amortized (incremental, occasionally scans)
```

This is the structure colocated systems actually run. The cost is memory
(`O(price_range)` slots, most empty) and the requirement that prices be a dense
integer grid. For an instrument whose tradeable band is, say, 4000 ticks, an
array of 4000 small `Level` structs is trivial and *blisteringly* cache-friendly
— the active region near the touch stays hot in L1/L2.

| Structure | add | cancel-by-id | best | new level | sparse OK? | locality |
|---|---|---|---|---|---|---|
| `std::map` | O(log L) | O(log L)* | O(1) | O(log L) | ✅ | ✗ pointer-chase |
| sorted vector | O(L) | O(L)* | O(1) | O(L) | ✅ | ✅ |
| **price ladder** | **O(1)** | **O(1)** | O(1) amort. | O(1) | ✗ needs dense | ✅✅ |

`*` only with an auxiliary `id -> node` map; the ladder needs the same map.

## Reference implementation — the price ladder

```cpp
// C++17. Single-symbol, market-by-order, single-threaded hot path.
#include <cstdint>
#include <vector>
#include <array>
#include <unordered_map>
#include <cassert>

using Price = int32_t;   // integer ticks
using Qty   = int64_t;
using OrderId = uint64_t;

enum class Side : uint8_t { Buy, Sell };

// Intrusive node: it lives *inside* the order-pool slot, no separate list-node
// allocation. prev/next thread it into its price level's FIFO list.
struct Order {
    OrderId id;
    Qty     qty;
    Price   price;
    Side    side;
    Order*  prev = nullptr;   // intrusive FIFO links (within one level)
    Order*  next = nullptr;
};

// One price level: a FIFO list of orders + aggregated size (for fast top-of-book
// and MBP snapshots). Empty level => head == nullptr.
struct Level {
    Order* head = nullptr;    // oldest (next to fill)
    Order* tail = nullptr;    // newest (append here)
    Qty    total_qty = 0;     // sum of resting qty at this price
    uint32_t count = 0;       // number of resting orders

    void push_back(Order* o) noexcept {
        o->prev = tail; o->next = nullptr;
        (tail ? tail->next : head) = o;
        tail = o;
        total_qty += o->qty; ++count;
    }
    void unlink(Order* o) noexcept {
        (o->prev ? o->prev->next : head) = o->next;
        (o->next ? o->next->prev : tail) = o->prev;
        total_qty -= o->qty; --count;
    }
    bool empty() const noexcept { return head == nullptr; }
};

class OrderBook {
public:
    // Tradeable band [min_px, max_px] in ticks; both inclusive.
    OrderBook(Price min_px, Price max_px, std::size_t expected_orders = 1u << 20)
        : min_px_(min_px),
          levels_(static_cast<std::size_t>(max_px - min_px + 1)) {
        pool_.reserve(expected_orders);   // never reallocate in the hot path
        by_id_.reserve(expected_orders);
        // best_bid_ < best_ask_ means "empty / crossed-uninit" sentinel state.
        best_bid_ = min_px_ - 1;          // no bids
        best_ask_ = max_px_() + 1;        // no asks
    }

    void add(OrderId id, Side side, Price px, Qty qty) {
        assert(in_range(px) && qty > 0);
        Order* o = alloc(id, side, px, qty);     // O(1) pool bump
        Level& lvl = at(px);
        lvl.push_back(o);                         // O(1) FIFO append
        by_id_.emplace(id, o);                    // O(1) for cancel-by-id
        // Maintain best on the side we just touched.
        if (side == Side::Buy)  { if (px > best_bid_) best_bid_ = px; }
        else                    { if (px < best_ask_) best_ask_ = px; }
    }

    bool cancel(OrderId id) {
        auto it = by_id_.find(id);
        if (it == by_id_.end()) return false;     // unknown / already filled
        Order* o = it->second;
        Level& lvl = at(o->price);
        bool was_top = (o->side == Side::Buy ? o->price == best_bid_
                                             : o->price == best_ask_);
        lvl.unlink(o);                            // O(1) intrusive unlink
        by_id_.erase(it);
        free(o);
        if (was_top && lvl.empty()) reseat_best(o->side, o->price);
        return true;
    }

    // Quantity-only modify keeps time priority (an exchange rule for size-down);
    // size-up or price change is a cancel+add (loses priority) — see follow-ups.
    bool modify(OrderId id, Qty new_qty) {
        auto it = by_id_.find(id);
        if (it == by_id_.end()) return false;
        Order* o = it->second;
        if (new_qty <= 0) return cancel(id);
        at(o->price).total_qty += (new_qty - o->qty);
        o->qty = new_qty;                          // O(1), priority preserved
        return true;
    }

    // Aggressive order: cross the book, best-price-first, FIFO within a level.
    // Returns the filled quantity. `limit_px` bounds how far we cross.
    Qty match(Side aggressor, Price limit_px, Qty qty) {
        Qty filled = 0;
        if (aggressor == Side::Buy) {
            // Buyer lifts asks from best_ask_ upward, while price <= limit.
            while (qty > 0 && has_ask() && best_ask_ <= limit_px)
                fill_level(at(best_ask_), best_ask_, qty, filled, Side::Sell);
        } else {
            while (qty > 0 && has_bid() && best_bid_ >= limit_px)
                fill_level(at(best_bid_), best_bid_, qty, filled, Side::Buy);
        }
        return filled;
    }

    bool  has_bid()  const noexcept { return best_bid_ >= min_px_; }
    bool  has_ask()  const noexcept { return best_ask_ <= max_px_(); }
    Price best_bid() const noexcept { return best_bid_; }   // valid iff has_bid()
    Price best_ask() const noexcept { return best_ask_; }
    Qty   bid_qty()  const noexcept { return at(best_bid_).total_qty; }
    Qty   ask_qty()  const noexcept { return at(best_ask_).total_qty; }

private:
    // --- price <-> index ---------------------------------------------------
    Price max_px_() const noexcept {
        return min_px_ + static_cast<Price>(levels_.size()) - 1;
    }
    bool in_range(Price p) const noexcept { return p >= min_px_ && p <= max_px_(); }
    Level&       at(Price p)       noexcept { return levels_[p - min_px_]; }
    const Level& at(Price p) const noexcept { return levels_[p - min_px_]; }

    // --- object pool (no per-order heap allocation) ------------------------
    Order* alloc(OrderId id, Side s, Price p, Qty q) {
        Order* o;
        if (free_head_) { o = free_head_; free_head_ = free_head_->next; }
        else            { o = &pool_.emplace_back(); }   // amortized O(1)
        *o = Order{id, q, p, s, nullptr, nullptr};
        return o;
    }
    void free(Order* o) noexcept { o->next = free_head_; free_head_ = o; }

    // Fill as much of one level as `qty` allows; advance best if it empties.
    void fill_level(Level& lvl, Price px, Qty& qty, Qty& filled, Side resting) {
        while (qty > 0 && lvl.head) {
            Order* o = lvl.head;                 // FIFO: oldest first
            Qty take = (o->qty < qty) ? o->qty : qty;
            o->qty -= take; lvl.total_qty -= take;
            qty -= take; filled += take;
            // emit_trade(o->id, px, take);      // <-- report fill here
            if (o->qty == 0) {                   // fully filled -> remove
                lvl.head = o->next;
                if (lvl.head) lvl.head->prev = nullptr; else lvl.tail = nullptr;
                --lvl.count;
                by_id_.erase(o->id);
                free(o);
            }
        }
        if (lvl.empty()) reseat_best(resting, px);
    }

    // Move best_bid_/best_ask_ to the next occupied level after `from` empties.
    void reseat_best(Side s, Price from) noexcept {
        if (s == Side::Buy) {                    // bids: scan downward
            Price p = from;
            while (p >= min_px_ && at(p).empty()) --p;
            best_bid_ = p;                        // < min_px_ => empty
        } else {                                 // asks: scan upward
            Price p = from;
            while (p <= max_px_() && at(p).empty()) ++p;
            best_ask_ = p;                        // > max_px_ => empty
        }
    }

    Price min_px_;
    std::vector<Level>  levels_;                 // direct-addressed ladder
    std::vector<Order>  pool_;                   // contiguous order storage
    Order*              free_head_ = nullptr;    // intrusive free list
    std::unordered_map<OrderId, Order*> by_id_;  // O(1) cancel/modify
    Price best_bid_, best_ask_;
};
```

A few design points worth narrating to an interviewer:

- **The level array is direct-addressed.** `at(px)` is `levels_[px - min_px_]`
  — one subtraction and one load. No comparison tree, no hash. This is the whole
  trick.
- **Intrusive lists** mean the FIFO links live *inside* the `Order`, so an
  `add` allocates nothing (the pool already owns the storage) and a `cancel`
  unlinks in O(1) given the node — which the `by_id_` map hands us directly.
- **Best tracking is incremental.** `add` only ever pushes the touch *out*
  (cheap compare). The only scan is `reseat_best`, and only when the current
  best level *empties* — it walks to the next occupied tick. In an active book
  the next level is one or a few ticks away and almost certainly in cache, so
  amortized cost is tiny. (If you want strict O(1) even here, maintain a bitset
  of occupied levels and use a hardware `LZCNT`/`TZCNT` to find the next set bit
  — see optimizations.)

## Complexity summary

```text
add (in-band price)   : O(1)
cancel (by id)        : O(1)   hash lookup + unlink
modify (qty down)     : O(1)
match per fill        : O(1)   amortized
match overall         : O(F + ΔL)   F fills, ΔL price levels swept
best bid / ask        : O(1)   amortized (incremental + bounded reseat scan)
memory                : O(price_range) levels + O(live_orders) pool
```

## Low-latency optimizations

- **No allocation on the hot path.** The `Order` pool is `reserve`-d up front;
  `add` bumps a free-list head, `cancel` returns it. A `new`/`delete` per order
  would dominate everything else and add tail-latency jitter from the allocator.
- **Cache locality is the design.** The active region of the ladder (a few ticks
  around the touch) and the pool slots for live orders stay resident in L1/L2.
  A `std::map`'s scattered nodes miss constantly. Keep `Level` small (head/tail
  pointers + `total_qty` + `count`) so a cache line holds several adjacent
  levels — sweeping the book during a match then prefetches naturally.
- **Branch-free best updates.** The `add` update is a single predicated
  `max`/`min`. Watch out for branch mispredicts in `reseat_best`; the bitset +
  `TZCNT`/`LZCNT` variant removes the data-dependent loop entirely:

  ```cpp
  // Occupied-level bitset; find next occupied ask >= p in O(1) per word.
  // (C++20 std::countr_zero, or __builtin_ctzll in C++17.)
  Price next_ask = p + __builtin_ctzll(occupied_word >> (p - base));
  ```

- **Avoid `unordered_map` overhead.** `std::unordered_map` chains nodes and
  hashes through a function pointer; for the `by_id_` map prefer an open-
  addressed flat hash (e.g. `absl::flat_hash_map` / `ankerl::unordered_dense`)
  or, if ids are dense and monotonic, a direct array. The id map is on the
  *cancel* path, which is the majority of exchange traffic (most orders cancel,
  never fill).
- **Keep hot fields together, cold fields apart.** `qty`/`price`/links are
  touched every op; `id` only on cancel. Splitting hot/cold (SoA) can save a
  line, but profile first — for a 40-byte `Order` it's often not worth the
  complexity.
- **Single writer, no locks.** Pin one thread per symbol; the book holds no
  mutex. Publish top-of-book to consumers via an SPSC ring or a seqlock, not by
  sharing the book.

## Follow-ups interviewers ask

- **"Prices are sparse / unbounded (options chains, crypto)."** Drop the dense
  array; key levels by price in a flat hash map (`price -> Level`) for O(1)
  add/cancel, and keep a separate sorted structure *only* for "what's the next
  best price" — e.g. a small `std::set` of occupied prices, or a B-tree, or a
  two-level ladder (coarse buckets, each a small array). Many real books are
  **hybrid**: dense ladder near the touch, hash/tree for the deep tails.
- **"Many symbols."** One `OrderBook` per symbol; index them by an array slot
  (symbols are typically a dense integer id at the venue) so symbol lookup is
  also O(1). Memory: a 4000-tick ladder per symbol is small, but thousands of
  symbols add up — size the band per instrument, or share a pool.
- **"Market-by-order vs market-by-price."** MBO (above) tracks every order and
  is required to *match* and to *cancel by id*. MBP feeds (most public depth
  feeds) only carry aggregated `total_qty`/`count` per level — then you drop the
  intrusive lists and the `by_id_` map and just maintain `Level` aggregates,
  which is cheaper and all a consuming strategy needs.
- **"Top-of-book only."** If you only need best bid/ask + size, you don't need
  the ladder at all — track four numbers and update on the relevant messages.
  This is the cheapest book and what a latency-sensitive taker often runs.
- **"Modify that increases size or changes price."** Exchange rules: a size-up
  or price change *loses time priority*, so implement it as `cancel + add`
  (re-append at the tail of the new level). Only a size-*down* keeps priority,
  which is the O(1) path above.
- **"Iceberg / hidden / pro-rata."** Iceberg orders show a display qty and
  refill from a hidden reserve when the display fills; pro-rata venues allocate
  fills proportionally to resting size rather than strictly FIFO. Both change
  `fill_level`, not the ladder.
- **"How do you snapshot the book to a consumer?"** Walk N levels out from the
  touch reading `total_qty`/`count` — O(N) and cache-friendly because levels are
  contiguous. Publish via seqlock so readers never tear or block the writer.

## Key takeaways

1. A LOB is **price-then-time priority**: sorted price levels (bids descending,
   asks ascending), FIFO within each level.
2. The HFT answer is a **direct-addressed price ladder**: a flat array indexed by
   integer tick, with an **intrusive FIFO list per level** and an
   **`id -> Order*` map** for O(1) cancel. `std::map` is correct but cache-hostile.
3. This buys **O(1) add/cancel/modify**, O(1)-amortized best, and matching that's
   O(fills + levels swept) — with **zero hot-path allocation** via an object pool.
4. The tradeoff is **memory ∝ price range** and a **dense-integer-tick**
   requirement; sparse/unbounded prices want a hash or hybrid ladder.
5. Know the variants cold: **MBO vs MBP**, **top-of-book**, **multi-symbol**, and
   that **price/size-up modify loses priority** (cancel+add) while **size-down
   keeps it** (O(1)).

## Self-check

1. Why does `cancel` need the `id -> Order*` map even though the ladder gives
   O(1) access to a price level?
2. The best-bid level empties on a cancel. Walk through exactly what
   `reseat_best` does and why its amortized cost is small in an active book.
3. A modify raises an order's quantity. Why can't you just bump `qty` in place
   and keep the order where it is? What must you do instead, and why?
4. Your instrument trades 0.01-wide ticks from \$1 to \$10,000. How many ladder
   slots is that, and is the dense array still the right call? What if it traded
   from \$0.0001 to \$1,000,000?
5. Sketch how an MBP-only depth feed simplifies this design — which two members
   disappear?
6. Why is `std::unordered_map` a questionable choice for `by_id_` in a colocated
   system, and what would you reach for instead?

## Further reading

- WK Selph, ["How to Build a Fast Limit Order Book"](https://web.archive.org/web/20110219163448/http://howtohft.wordpress.com/2011/02/15/how-to-build-a-fast-limit-order-book/) — the canonical blog post that popularized the array-of-levels + intrusive-list + id-map design.
- [QuantCup #1 — limit order book contest](https://web.archive.org/web/2018*/https://www.quantcup.org/) and the winning entries — real, fast, audited LOB implementations to study.
- Robert Almgren / Frank Kelly notes on **price-time priority** and matching mechanics (exchange microstructure).
- [`std::pmr` polymorphic allocators — cppreference](https://en.cppreference.com/w/cpp/header/memory_resource) — for a monotonic/pool resource backing the order storage.
- Erik Rigtorp, [rigtorp.se](https://rigtorp.se/) — SPSC rings and seqlocks for publishing top-of-book to consumers without locks.
- [`__builtin_ctz`/`__builtin_clz` and `<bit>` (`std::countr_zero`/`std::countl_zero`) — cppreference](https://en.cppreference.com/w/cpp/numeric/countr_zero) — the bitset "next occupied level" trick.
- CME / Nasdaq matching-engine docs and the **Nasdaq TotalView-ITCH** spec — what real add/cancel/execute messages and price-time rules look like on the wire.

## Videos

- David Gross — **"Trading at Light Speed: Designing Low-Latency Systems in C++"** (Meeting C++) ([search](https://www.youtube.com/results?search_query=David+Gross+Trading+at+light+speed+low+latency+C%2B%2B)) — data-structure and allocation choices for exactly this kind of hot path.
- Carl Cook — CppCon **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — the latency mindset the order book lives inside.
- CppCon — search for talks on **building a matching engine / limit order book in C++** ([search](https://www.youtube.com/results?search_query=CppCon+limit+order+book+matching+engine+C%2B%2B)).
