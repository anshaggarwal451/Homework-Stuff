# Content Scheduler

> **Why a scheduler is a hot-path data structure in HFT:** "schedule this to run
> at time *t*" is the beating heart of every trading system's plumbing — order
> time-to-live (TTL) expiries, rate-limit token refills, heartbeat/retransmit
> timers, quote re-pricing intervals, and the event loop of a market simulator
> that must replay millions of timestamped events *in order*. Get the scheduler
> wrong and either you burn CPU polling, or a timer fires late and an order sits
> stale on the book. Interviewers pose it as "build a task/content scheduler" to
> see whether you reach for a heap, know its limits, and can name the structure
> real systems use when timers number in the millions: the **timing wheel**.

All code is **C++17** (notes call out C++20 `<chrono>` niceties).

## Problem statement

Build a **scheduler** that runs *items* (tasks/events/content) either at a
specified time or by priority:

- `schedule(item, when)` — register an item to fire at time `when`.
- `poll(now)` (a.k.a. *tick*) — fire and remove all items whose time `<= now`,
  in time order.
- `cancel(handle)` — remove a not-yet-fired item.
- (optional) `reschedule(handle, when)` — move an item's deadline.

The driving loop calls `poll(now)` repeatedly (on a timer interrupt, on each
spin of an event loop, or after each simulated event). "Priority scheduling" is
the same problem with the key being a priority instead of a timestamp — a
min-heap doesn't care what the key *means*.

## Clarifying questions

1. **Time model.** Real wall-clock (a live system) or logical/simulation time
   (a backtester advancing event-to-event)? In simulation, `poll` jumps `now`
   to the next event time — there's no "wait", just "pop the earliest".
2. **How many live timers?** A handful (use a heap) or hundreds of thousands of
   per-order TTLs (use a timing wheel)? This is the whole decision.
3. **Timeout distribution.** Are deadlines clustered in a bounded near-future
   window (TTLs, heartbeats — perfect for a wheel) or arbitrarily far out
   (a heap, or a hierarchical wheel)?
4. **Cancel frequency.** In trading, *most timers are cancelled before they
   fire* (the order it guards gets filled/cancelled first), so `cancel` must be
   cheap — ideally O(1).
5. **Threading.** One scheduler thread that owns the structure (typical), or
   concurrent producers? I'll assume single-threaded ownership; producers hand
   work in over an SPSC ring.

## Approach 1 — binary min-heap (the default answer)

A min-heap keyed by deadline. `top()` is the earliest event; `poll(now)` pops
while `top().when <= now`. This is what `std::priority_queue` gives you, and it's
the right first answer.

```text
schedule        : O(log N)
poll one item   : O(log N)   (pop-min)
peek next time  : O(1)
cancel arbitrary: O(N) naive  -> O(log N) with a handle + index, or lazy delete
memory          : O(N), contiguous array  -> good locality
```

The catch for a *scheduler* specifically: **cancel**. A raw
`std::priority_queue` has no way to remove a non-top element. Two fixes:

- **Lazy (tombstone) deletion** — mark the item dead in a side table; when it
  surfaces at the top, discard it. Simple, but a flood of cancelled timers
  bloats the heap with garbage.
- **Indexed heap** — store each item's current array index in its handle and
  sift it out on cancel in O(log N). More code, no garbage. This is what you
  build when cancels are frequent (i.e. trading).

### Reference implementation — intrusive indexed min-heap

I'll skip `std::priority_queue` (no cancel, allocates nodes you don't control)
and build an indexed heap over a flat array so `cancel` and `reschedule` are
O(log N) and there's zero per-item heap allocation.

```cpp
// C++17. Min-heap scheduler with O(log N) schedule/poll/cancel/reschedule.
#include <cstdint>
#include <vector>
#include <functional>
#include <utility>

using Tick = int64_t;          // nanoseconds, or logical sim time
using Handle = uint64_t;       // stable id the caller keeps to cancel/reschedule

class HeapScheduler {
    struct Node {
        Tick   when;
        Handle handle;
        std::function<void()> action;   // the "content"/task to run
    };

public:
    // Schedule `action` to fire at `when`. Returns a handle for cancel/reschedule.
    Handle schedule(Tick when, std::function<void()> action) {
        Handle h = next_handle_++;
        std::size_t idx = heap_.size();
        heap_.push_back(Node{when, h, std::move(action)});
        pos_.emplace(h, idx);           // handle -> current heap index
        sift_up(idx);
        return h;
    }

    // O(1) peek: when does the next item fire? (only valid if !empty())
    Tick next_deadline() const noexcept { return heap_.front().when; }
    bool empty() const noexcept { return heap_.empty(); }

    // Fire (and remove) every item with when <= now, earliest first.
    template <class Sink>
    void poll(Tick now, Sink&& run) {
        while (!heap_.empty() && heap_.front().when <= now) {
            Node n = std::move(heap_.front());
            remove_at(0);               // pop-min, O(log N)
            pos_.erase(n.handle);
            run(n.action);              // e.g. run(act){ act(); }  -- caller controls
        }
    }

    bool cancel(Handle h) {
        auto it = pos_.find(h);
        if (it == pos_.end()) return false;   // already fired or unknown
        remove_at(it->second);                // O(log N) sift-out
        pos_.erase(it);
        return true;
    }

    bool reschedule(Handle h, Tick when) {
        auto it = pos_.find(h);
        if (it == pos_.end()) return false;
        std::size_t i = it->second;
        Tick old = heap_[i].when;
        heap_[i].when = when;
        (when < old) ? sift_up(i) : sift_down(i);   // restore heap property
        return true;
    }

private:
    void swap_nodes(std::size_t a, std::size_t b) noexcept {
        std::swap(heap_[a], heap_[b]);
        pos_[heap_[a].handle] = a;       // keep handle->index map in sync
        pos_[heap_[b].handle] = b;
    }
    void sift_up(std::size_t i) noexcept {
        while (i > 0) {
            std::size_t p = (i - 1) / 2;
            if (heap_[p].when <= heap_[i].when) break;
            swap_nodes(i, p); i = p;
        }
    }
    void sift_down(std::size_t i) noexcept {
        std::size_t n = heap_.size();
        for (;;) {
            std::size_t l = 2*i + 1, r = 2*i + 2, m = i;
            if (l < n && heap_[l].when < heap_[m].when) m = l;
            if (r < n && heap_[r].when < heap_[m].when) m = r;
            if (m == i) break;
            swap_nodes(i, m); i = m;
        }
    }
    // Remove the node at index i: swap with last, drop, restore heap order.
    void remove_at(std::size_t i) noexcept {
        std::size_t last = heap_.size() - 1;
        if (i != last) {
            swap_nodes(i, last);
            heap_.pop_back();
            if (i < heap_.size()) {       // restore from the moved-in node
                sift_down(i);
                sift_up(i);
            }
        } else {
            heap_.pop_back();
        }
    }

    std::vector<Node> heap_;                              // contiguous, cache-friendly
    std::unordered_map<Handle, std::size_t> pos_;         // handle -> heap index
    Handle next_handle_ = 1;
};
```

Notes for the interviewer: `poll` takes a `Sink` so the caller decides whether
firing means *invoke now* or *enqueue to a worker* — and so a simulator can
advance logical time and re-collect events the fired action schedules. The
`pos_` map is what upgrades a textbook heap into a real *scheduler*: without it,
`cancel`/`reschedule` are O(N) scans.

`std::priority_queue` would be a fine answer if the prompt didn't need cancel —
but say *why* you're not using it: it exposes no element handles, can't remove
the interior, and its `std::vector` backing may reallocate at awkward times.

## Approach 2 — timing wheel (the answer when timers are many)

A heap is O(log N) per op. When you have **hundreds of thousands of timers**
(one TTL per resting order, one rate-limit timer per client, retransmit timers
per connection) and they mostly fire or cancel within a **bounded near future**,
you can do better: **O(1) insert, O(1) cancel, O(1) per-tick expiry**. This is
the **timing wheel** of Varghese & Lauck (*"Hashed and Hierarchical Timing
Wheels"*, 1987 — the paper to cite).

### The simple (single) timing wheel

Think of a circular array of `WHEEL_SIZE` buckets, one per tick of resolution,
and a "current" hand that advances each tick. A timer due in `d` ticks goes into
bucket `(current + d) % WHEEL_SIZE`. Each `tick()` advances the hand by one and
fires *everything in the bucket it lands on* — no comparisons, no sorting.

```text
   bucket:  0   1   2   3   4   5   6   7      WHEEL_SIZE = 8
          [   ][ * ][   ][** ][   ][ * ][   ][   ]
                          ^current hand
   insert(due in 3) -> bucket (current+3)%8.  tick(): fire bucket, ++current.

   insert : O(1)   compute bucket, push into intrusive list
   cancel : O(1)   intrusive unlink (you hold the node)
   tick   : O(1) amortized   walk one bucket's list, fire each
```

The bucket is an **intrusive doubly-linked list** (same trick as the order
book): the list links live inside the timer node, so insert is a push and cancel
is an unlink, both allocation-free and O(1). The limitation: a single wheel only
covers `WHEEL_SIZE` ticks into the future. Two ways to extend the range:

- **Hashed wheel** — store the number of *remaining rotations* in each node.
  A timer due in `d` ticks lands in bucket `(current+d) % WHEEL_SIZE` with
  `rounds = d / WHEEL_SIZE`. On each visit you decrement `rounds`; fire only when
  it hits zero. O(1) insert/cancel; `tick` may touch nodes that aren't due yet
  (the cost of hashing far-future timers into a small wheel).
- **Hierarchical wheels** — like a clock's seconds/minutes/hours hands. A
  coarse wheel's bucket, when it expires, *cascades* its timers down into a finer
  wheel. This is what the Linux kernel historically used for `jiffies` timers and
  what Netty/Kafka-style wheels implement. Covers an enormous range with O(1)
  amortized ops and no per-rotation rescan.

```cpp
// C++17. Single hashed timing wheel: O(1) insert/cancel, O(1)-amortized tick.
#include <array>
#include <cstdint>
#include <functional>

class TimingWheel {
    static constexpr uint32_t WHEEL_SIZE = 1u << 12;   // 4096 buckets (power of 2)
    static constexpr uint32_t MASK = WHEEL_SIZE - 1;

public:
    struct Timer {                       // intrusive node; caller-owned lifetime
        std::function<void()> action;
        uint32_t bucket = 0;             // which slot it lives in
        uint32_t rounds = 0;             // full rotations remaining before firing
        Timer* prev = nullptr;
        Timer* next = nullptr;
    };

    // Insert a timer due `ticks_from_now` ticks ahead. O(1). Caller owns *t.
    void schedule(Timer* t, uint64_t ticks_from_now) noexcept {
        uint32_t b = static_cast<uint32_t>((current_ + ticks_from_now) & MASK);
        t->bucket = b;
        t->rounds = static_cast<uint32_t>(ticks_from_now >> 12);   // / WHEEL_SIZE
        link_front(buckets_[b], t);
    }

    void cancel(Timer* t) noexcept { unlink(buckets_[t->bucket], t); }  // O(1)

    // Advance one tick: fire due timers in the current bucket, decrement rounds
    // on the rest. O(bucket occupancy); O(1) amortized across ticks.
    void tick() noexcept {
        Timer* t = buckets_[current_ & MASK];
        Timer** pp = &buckets_[current_ & MASK];
        while (t) {
            Timer* nxt = t->next;
            if (t->rounds == 0) {
                unlink_known(pp, t);     // due now -> remove and fire
                t->action();
            } else {
                --t->rounds;             // not yet -> wait another rotation
                pp = &t->next;
            }
            t = nxt;
        }
        ++current_;
    }

private:
    static void link_front(Timer*& head, Timer* t) noexcept {
        t->prev = nullptr; t->next = head;
        if (head) head->prev = t;
        head = t;
    }
    static void unlink(Timer*& head, Timer* t) noexcept {
        if (t->prev) t->prev->next = t->next; else head = t->next;
        if (t->next) t->next->prev = t->prev;
    }
    void unlink_known(Timer** pp, Timer* t) noexcept {
        *pp = t->next;
        if (t->next) t->next->prev = t->prev;
    }

    std::array<Timer*, WHEEL_SIZE> buckets_{};   // intrusive list heads
    uint64_t current_ = 0;                        // hand position (tick count)
};
```

### Heap vs wheel — when to use which

| | min-heap | timing wheel |
|---|---|---|
| insert | O(log N) | **O(1)** |
| cancel | O(log N) (indexed) | **O(1)** (intrusive) |
| fire/expire | O(log N) per item | **O(1)** amortized |
| next-deadline peek | **O(1)** | O(buckets) to find next non-empty |
| arbitrary far-future times | **natural** | needs hierarchy/rounds |
| memory | O(N), tight | O(WHEEL_SIZE + N) |
| best for | modest N, wide/unknown deadline range, a backtester's event queue | many timers, bounded near-future deadlines (TTLs, heartbeats, rate limits) |

The senior summary: **use a heap for a simulation event loop or when you have a
few, possibly far-future deadlines; use a (hierarchical) timing wheel when you
have a large population of short-lived timers** — which is exactly the HFT
order-TTL / heartbeat / retransmit case.

## Low-latency optimizations

- **No per-timer allocation.** The wheel's `Timer` is caller-owned and intrusive
  — embed it directly in the order/connection object it guards. The heap version
  should back its `std::vector` with a `reserve` (and consider a `pmr` monotonic
  resource) so `schedule` never calls the allocator on the hot path.
- **Avoid `std::function` in the tightest loops.** It can heap-allocate and
  always does an indirect call. For homogeneous timers, store a small enum/tag +
  payload and `switch`, or a function pointer + `void*` context — branch-
  predictable and no allocation. Use `std::function` only where flexibility
  beats the few-ns indirect-call cost.
- **Power-of-two wheel size** makes `% WHEEL_SIZE` a single `AND` (`& MASK`) and
  `/ WHEEL_SIZE` a shift — no division on the insert path.
- **Cache locality.** The heap is a contiguous array (good), but sift
  up/down hop by factors of two — large heaps thrash cache; another reason wheels
  win at scale, since a `tick` touches one small bucket list. Keep `Timer` nodes
  near the objects they time so firing doesn't miss.
- **Don't poll a clock in a spin loop carelessly.** Read the TSC / `steady_clock`
  once per loop iteration and pass `now` into `poll`/`tick`; don't call the clock
  per timer. In a sim, `now` is just the next event's timestamp — no clock at all.
- **Single-writer.** Let one thread own the scheduler; producers post via an SPSC
  ring. No locks inside the structure.

## Follow-ups interviewers ask

- **"Make cancel O(1) on the heap."** You can't, in general — heap cancel is
  Θ(log N). Either accept lazy/tombstone deletion (and periodically rebuild) or
  switch to a wheel, whose intrusive cancel *is* O(1). Saying this clearly scores
  points.
- **"Periodic timers."** On fire, re-insert with `when += period` (heap) or
  re-`schedule(t, period)` (wheel). Beware drift: re-arm relative to the
  *scheduled* time, not `now`, or accumulate it.
- **"Rate limiting."** A token bucket *is* a scheduler: a timer refills tokens
  every `1/rate`. Or, lazily, compute tokens from `(now - last) * rate` on demand
  and skip the timer entirely — the cheapest design when you only check on send.
- **"Order TTL / fire-and-forget cancels."** Each resting order embeds a
  `Timer`; on fill or manual cancel you `cancel()` it (O(1), intrusive); on expiry
  the wheel fires it and the action sends the cancel. This is the textbook wheel
  use case — millions of timers, almost all cancelled before they fire.
- **"Simulation event loop."** Pure logical time: a min-heap of `(timestamp,
  event)`; the loop pops the earliest, sets `now` to its time, runs it (which may
  schedule future events), repeats. No wall clock, no wheel needed — but if the
  sim has huge numbers of pending events in a bounded horizon, a wheel still wins.
- **"Ties / ordering at the same timestamp."** A heap isn't stable; add a
  monotonically increasing sequence number as a tiebreaker in the key to make
  same-time events FIFO. A wheel naturally fires a bucket in list order.
- **"How far ahead can the wheel see, and how do you find the *next* deadline?"**
  A single wheel sees `WHEEL_SIZE` ticks (or × rounds, hashed); past that you need
  hierarchy. Finding the next non-empty bucket is an O(buckets) scan unless you
  keep an occupancy bitset and use `TZCNT`/`std::countr_zero` to jump to it.

## Key takeaways

1. A scheduler is a **priority queue keyed by time**; the default
   implementation is a **binary min-heap** — O(log N) schedule/poll, O(1)
   peek-next.
2. A raw `std::priority_queue` can't `cancel`; a real scheduler needs an
   **indexed heap** (handle → array index) for O(log N) cancel/reschedule, or
   lazy tombstone deletion.
3. For **many short-lived, near-future timers** (order TTLs, heartbeats, rate
   limits) use a **timing wheel** (Varghese & Lauck): **O(1) insert/cancel** and
   **O(1)-amortized expiry** via intrusive per-bucket FIFO lists.
4. Extend a wheel's range with **rounds (hashed wheel)** or **hierarchical
   wheels** that cascade coarse buckets into fine ones.
5. Low-latency wins come from **intrusive, allocation-free nodes**, **power-of-two
   wheels** (`AND`/shift, no division), avoiding `std::function` in the hot path,
   and **single-writer** ownership. A **min-heap is still the right tool for a
   simulation event loop**.

## Self-check

1. Why does `std::priority_queue` fail as a cancellable scheduler, and what one
   auxiliary structure turns a plain heap into a cancellable one?
2. In the indexed heap, why must `swap_nodes` update `pos_`, and what breaks if
   you forget?
3. A timer is due in 10,000 ticks but `WHEEL_SIZE` is 4096. Where does it land
   and what is its `rounds`? When does it fire?
4. You have 500,000 resting orders, each with a TTL, and ~95% are cancelled
   before expiry. Heap or wheel? Justify with the per-op complexities.
5. Two events share a timestamp in a backtest and order matters. How do you make
   the heap fire them deterministically FIFO?
6. Why is a power-of-two `WHEEL_SIZE` more than a stylistic choice on the insert
   path?

## Further reading

- George Varghese & Tony Lauck, [**"Hashed and Hierarchical Timing Wheels"**](https://www.cs.columbia.edu/~nahum/w6998/papers/sosp87-timing-wheels.pdf) (SOSP '87) — the foundational paper; read §III–IV for the hashed and hierarchical variants.
- [`std::priority_queue` — cppreference](https://en.cppreference.com/w/cpp/container/priority_queue) and [`std::make_heap`/`push_heap`/`pop_heap`](https://en.cppreference.com/w/cpp/algorithm/make_heap) — the standard heap building blocks.
- [Netty `HashedWheelTimer`](https://netty.io/4.1/api/io/netty/util/HashedWheelTimer.html) — a widely deployed, well-documented production hashed timing wheel (Java, but the design transfers directly).
- [Apache Kafka's hierarchical timing wheel](https://www.confluent.io/blog/apache-kafka-purgatory-hierarchical-timing-wheels/) — a clear write-up of cascading wheels for millions of request timeouts.
- [`<chrono>` — cppreference](https://en.cppreference.com/w/cpp/header/chrono) and [`std::chrono::steady_clock`](https://en.cppreference.com/w/cpp/chrono/steady_clock) — the right clock for measuring/scheduling intervals (never `system_clock` for durations).
- [`std::countr_zero` / `__builtin_ctzll` — cppreference](https://en.cppreference.com/w/cpp/numeric/countr_zero) — for the occupancy-bitset "next non-empty bucket" trick.
- Erik Rigtorp, [rigtorp.se](https://rigtorp.se/) — SPSC queues for feeding work to a single-writer scheduler thread without locks.

## Videos

- Carl Cook — CppCon **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — the latency budget that motivates intrusive, allocation-free timers.
- David Gross — **"Trading at Light Speed: Designing Low-Latency Systems in C++"** ([search](https://www.youtube.com/results?search_query=David+Gross+Trading+at+light+speed+low+latency+C%2B%2B)) — data-structure and allocation choices for plumbing like this.
- CppCon — search for talks on **timer wheels / event scheduling in C++** ([search](https://www.youtube.com/results?search_query=CppCon+timing+wheel+timer+scheduler+C%2B%2B)).
