# Resizing Array based Queue

> **Why this matters for low-latency C++:** The fixed ring buffer is perfect
> until you can't size it ahead of time. The resizing ring buffer answers "what
> if the queue might grow unbounded?" with **amortized O(1)** operations — the
> same doubling trick that makes `std::vector::push_back` cheap. You need to be
> able to derive the amortized analysis on a whiteboard *and* explain the one
> nasty wrinkle that `vector` doesn't have: a ring buffer's elements may be
> **wrapped around the seam**, so resize isn't a plain `memcpy`. And then comes
> the senior twist — in HFT you usually *refuse* to resize at all. Knowing both
> the technique and why you'd reject it is the whole answer.

All code is **C++17**. We extend the fixed ring buffer from the previous lesson
with growth, do the amortized accounting, and then argue why you'd preallocate
instead.

## Problem statement

Implement an **unbounded FIFO** backed by a contiguous array:

- `push(x)` — never fails; grows the backing array when full.
- `pop()`, `front()`, `empty()`, `size()`.
- Growth must give **amortized O(1)** `push` (occasional O(n) reallocation,
  cheap on average).
- Optionally **shrink** when the queue empties out, to return memory.

## Clarifying constraints

- **Growth factor?** Double on full (2x) is the standard choice. We'll discuss
  why 2x vs 1.5x is a real tradeoff (memory reuse vs. fewer reallocations).
- **Shrink policy?** Usually shrink to half when size drops below a *quarter* of
  capacity (the 1/4 threshold avoids "thrashing" — repeated grow/shrink at the
  boundary). State whether you shrink at all; many implementations don't.
- **Power-of-two capacity?** Keep it, so we retain the `& mask` wrap. Doubling
  preserves power-of-two-ness for free.
- **Element type?** Generic `T`, moved (not copied) during resize. Resize must be
  exception-aware: if `T`'s move can throw, you fall back to copy for the strong
  guarantee — we'll note this.
- **Single-threaded?** Yes. A *resizing* queue is essentially impossible to make
  lock-free cheaply (the reallocation invalidates everything every other thread
  is reading) — which is a big part of why HFT avoids it.

## The wrinkle: a ring buffer's data can be wrapped

With `std::vector`, growth is trivial: elements `[0, size)` are contiguous, so
`memcpy` (or move) them into the bigger buffer and you're done. A ring buffer is
different. After wrapping, the logical order `head → tail` is **physically split**
across the end of the array:

```text
old buffer (cap=8), logically C D E F G H but PHYSICALLY wrapped:

  index:   0   1   2   3   4   5   6   7
         +---+---+---+---+---+---+---+---+
         | G | H | . | . | C | D | E | F |
         +---+---+---+---+---+---+---+---+
                       ^head           ^   (tail wrapped to 2)
   logical order: C D E F (slots 4..7) then G H (slots 0..1)
```

When we grow, we don't preserve the wrap — we **unwrap** into the new buffer so
the queue starts clean at index 0:

```text
new buffer (cap=16), unwrapped — head reset to 0, tail to size:

  index:   0   1   2   3   4   5   6   7   8 ...
         +---+---+---+---+---+---+---+---+---+--
         | C | D | E | F | G | H | . | . | . |
         +---+---+---+---+---+---+---+---+---+--
           ^head                   ^tail
```

So resize is **up to two moves**: the run `[head_, old_cap)` then the run
`[0, tail_)`. Forgetting the second run (the wrapped tail) is the classic bug.

## Amortized analysis (be ready to derive this)

Doubling means resize happens rarely, and you can prove `push` is amortized O(1)
by the **aggregate** or **accounting** method.

Aggregate: starting empty, after *n* pushes the reallocations happen at sizes
1, 2, 4, 8, …, up to *n*. The total move work is:

```text
1 + 2 + 4 + ... + n/2 + n  <  2n   (geometric series sums to < 2n)
```

So *n* pushes do `< 2n` element-moves total → **O(1) amortized per push**. The
accounting view: charge each `push` 3 units (1 to place the element, 2 banked).
When a resize moves *k* elements, each has 2 banked units saved since it was
last moved — exactly enough to pay for moving it. The bank never goes negative.

> **Interview gotcha:** amortized O(1) is *not* worst-case O(1). A single `push`
> that triggers a resize of a million-element queue is a million moves — one
> ~O(n) hiccup. That distinction is the entire reason HFT is suspicious of this
> structure (next section).

| Operation | Worst-case | Amortized |
|-----------|:----------:|:---------:|
| `push` (no resize) | O(1) | O(1) |
| `push` (triggers resize) | **O(n)** | O(1) |
| `pop` | O(1) | O(1) |
| `front`/`empty`/`size` | O(1) | O(1) |

## Reference implementation

```cpp
// C++17. Unbounded, dynamically-resizing ring buffer. Amortized O(1) push.
// Doubles on full (and optionally halves on 1/4-empty). Power-of-two capacity.
#include <cstddef>
#include <new>
#include <type_traits>
#include <utility>
#include <cassert>

template <class T>
class ResizingRingQueue {
    struct alignas(T) Slot { unsigned char bytes[sizeof(T)]; };

    Slot*       buf_  = nullptr;
    std::size_t cap_  = 0;          // power of two (or 0 when empty/unallocated)
    std::size_t mask_ = 0;          // cap_ - 1
    std::size_t head_ = 0;
    std::size_t tail_ = 0;
    std::size_t size_ = 0;

    static T*       as_t(Slot* s)       { return reinterpret_cast<T*>(s->bytes); }

    static Slot* alloc_slots(std::size_t n) {
        // Raw storage only — no T constructed. operator new[], not new Slot[].
        return static_cast<Slot*>(::operator new[](n * sizeof(Slot),
                                                   std::align_val_t(alignof(T))));
    }
    static void free_slots(Slot* p) {
        ::operator delete[](p, std::align_val_t(alignof(T)));
    }

    // Grow/shrink to new_cap (a power of two >= size_). UNWRAPS into the new buf.
    void rehome(std::size_t new_cap) {
        Slot* nb = alloc_slots(new_cap);
        // Move the live elements in logical order into [0, size_) of nb.
        for (std::size_t i = 0, idx = head_; i < size_; ++i, idx = (idx + 1) & mask_) {
            ::new (nb[i].bytes) T(std::move_if_noexcept(*as_t(&buf_[idx])));
            as_t(&buf_[idx])->~T();          // destroy the old one
        }
        free_slots(buf_);
        buf_  = nb;
        cap_  = new_cap;
        mask_ = new_cap - 1;
        head_ = 0;                            // unwrapped: queue starts at 0
        tail_ = size_;                        // (size_ < new_cap, so no wrap yet)
    }

public:
    ResizingRingQueue() = default;
    explicit ResizingRingQueue(std::size_t initial_cap) { reserve(initial_cap); }

    ResizingRingQueue(const ResizingRingQueue&)            = delete;
    ResizingRingQueue& operator=(const ResizingRingQueue&) = delete;

    ~ResizingRingQueue() {
        for (std::size_t i = 0, idx = head_; i < size_; ++i, idx = (idx + 1) & mask_)
            as_t(&buf_[idx])->~T();
        free_slots(buf_);
    }

    // Pre-grow so the next `min_cap` pushes never reallocate (the HFT move).
    void reserve(std::size_t min_cap) {
        std::size_t c = cap_ ? cap_ : 1;
        while (c < min_cap) c <<= 1;          // round up to power of two
        if (c > cap_) rehome(c);
    }

    template <class... Args>
    void emplace(Args&&... args) {
        if (size_ == cap_)                    // full (also covers cap_ == 0)
            rehome(cap_ ? cap_ * 2 : 2);      // DOUBLE -> amortized O(1)
        ::new (buf_[tail_].bytes) T(std::forward<Args>(args)...);
        tail_ = (tail_ + 1) & mask_;
        ++size_;
    }
    void push(const T& v) { emplace(v); }
    void push(T&& v)      { emplace(std::move(v)); }

    T pop() {                                 // precondition: !empty()
        T result = std::move(*as_t(&buf_[head_]));
        as_t(&buf_[head_])->~T();
        head_ = (head_ + 1) & mask_;
        --size_;
        // Optional shrink: below 1/4 full -> halve (1/4 threshold avoids thrash).
        if (cap_ > 2 && size_ > 0 && size_ <= cap_ / 4)
            rehome(cap_ / 2);
        return result;
    }

    T&       front()       { return *as_t(&buf_[head_]); }
    const T& front() const { return *as_t(&const_cast<Slot&>(buf_[head_])); }

    bool        empty() const noexcept { return size_ == 0; }
    std::size_t size()  const noexcept { return size_; }
    std::size_t capacity() const noexcept { return cap_; }
};
```

Points the interviewer is listening for:

- **`rehome` unwraps in logical order** by walking `head_ → tail_` with `& mask_`
  and writing densely from index 0. This is the ring-buffer-specific part that
  `std::vector` never has to deal with.
- **`std::move_if_noexcept`** — if `T`'s move constructor isn't `noexcept`, this
  *copies* instead, so a throw mid-resize doesn't leave you with half-moved,
  unrecoverable state (basic exception safety). Mention it; it's a real
  difference from a naive `std::move`.
- **Double on grow, halve at 1/4** — the doubling gives amortized O(1); the *1/4*
  (not 1/2) shrink threshold is the textbook fix for grow/shrink **thrashing** at
  the boundary.
- **`reserve` is the escape hatch** — pre-grow once and the steady state never
  reallocates. This is the bridge to the HFT argument below.
- **Raw `operator new[]` with `align_val_t`** keeps `T` from being default- or
  value-constructed in unused slots and respects over-alignment.

## Why HFT usually AVOIDS resizing — and what it does instead

The amortized analysis is a beautiful average-case result, and **average case is
the wrong metric for a trading system.** Three concrete objections:

1. **The O(n) hiccup lands at the worst time.** Queues grow when the market is
   busy — bursts of messages. That's *exactly* when a resize fires, copying the
   whole (now-large) buffer mid-burst, adding a latency spike precisely when you
   can least afford one. Amortized-cheap, tail-latency-catastrophic.
2. **It calls the allocator on the hot path.** Every doubling is an
   `operator new[]` + `operator delete[]` — the very non-determinism we spent the
   pooling lesson eliminating, smuggled back in.
3. **It invalidates pointers/references and breaks any lock-free scheme.**
   `rehome` moves every element to a new address. Anything holding a reference
   into the queue dangles; any concurrent reader is reading freed memory. A
   resizing queue is effectively impossible to make lock-free.

> **The senior answer:** "I'd `reserve()` the queue to its worst-case depth at
> startup and treat it as fixed — convert the amortized-O(1)-with-spikes into
> flat-O(1)-always. If I genuinely can't bound the depth, I'd rather *drop* or
> *backpressure* than reallocate on the hot path, and I'd alarm on high-water
> mark. Resize is a general-purpose convenience, not a low-latency tool."

So the practical takeaway is inverted from the textbook: you *implement* the
resize to show you understand amortized analysis, then you *call `reserve` once
and never let it fire.* Capacity planning replaces dynamic growth.

## Low-latency optimizations

- **`reserve(worst_case_depth)` at startup, then never resize.** Measure the
  high-water mark in soak tests, size to it (plus headroom), and the
  reallocation branch becomes dead code in production. This is the whole game.
- **Pre-fault / `mlock` the buffer** after `reserve`, like the pool: bring the
  pages resident so the first hot push doesn't fault.
- **2x vs 1.5x growth** (if you *must* grow): 1.5x lets the allocator
  potentially reuse freed blocks (the sum of previous allocations can exceed the
  next request), reducing fragmentation; 2x reallocates less often. For a
  pre-reserved HFT queue it's moot, but it's a known interview discussion (Folly
  and many `vector` implementations use ~1.5x for this reason).
- **Skip the shrink entirely** in latency code — shrinking just adds another
  unpredictable reallocation to claw back memory you already paid for. Most
  hot-path queues never shrink.

## Follow-up variations interviewers ask

- **"Prove `push` is amortized O(1)."** Geometric series `1+2+4+…+n < 2n`, or the
  accounting method (3 credits per push). Have both ready.
- **"Why double instead of grow by a fixed +k?"** Fixed-increment growth makes
  *n* pushes cost `O(n²)` total (Θ(n) reallocations each moving Θ(n)). Doubling
  (geometric) is what buys amortized O(1).
- **"Why is the ring-buffer resize harder than `vector`'s?"** The wrap: live data
  is physically split across the seam, so it's up to two move-runs, and you reset
  `head=0` to unwrap.
- **"What if `T`'s move throws halfway through resize?"** `std::move_if_noexcept`
  degrades to copy for non-`noexcept`-movable `T`, preserving the originals so a
  throw leaves the source intact (basic guarantee). For the strong guarantee with
  throwing moves you'd build the new buffer fully before freeing the old.
- **"How do you size it for HFT?"** From the measured peak in-flight depth, not
  throughput — then `reserve` and freeze. Backpressure or drop beyond that;
  don't reallocate.

## Key takeaways

1. **Doubling on full gives amortized O(1)** `push` (geometric series sums to
   `<2n` moves over *n* pushes) — but a single resize is a worst-case **O(n)**
   spike.
2. A ring buffer's live data is **wrapped across the seam**, so resize must
   **unwrap** it in logical order (up to two move-runs, reset `head=0`) — the
   part `std::vector` never deals with.
3. Use **`std::move_if_noexcept`** during resize so a throwing move doesn't
   corrupt the queue; **double to grow, halve at 1/4** to avoid thrashing.
4. **HFT avoids dynamic resize:** the O(n) spike hits during bursts, it calls the
   allocator on the hot path, and it invalidates references / breaks lock-free
   schemes. Amortized-cheap is not tail-latency-safe.
5. The production pattern is **`reserve(worst_case)` once, pre-fault/`mlock`, and
   never resize** — capacity planning turns amortized-O(1)-with-spikes into
   flat-O(1)-always.

## Self-check

1. Derive that *n* `push`es do `< 2n` total element-moves under doubling. Why
   does fixed-increment (+k) growth give O(n²) instead?
2. Sketch a wrapped ring buffer and show the two move-runs `rehome` performs to
   unwrap it. Which run is the one people forget?
3. Why shrink at the *1/4* threshold rather than 1/2?
4. What does `std::move_if_noexcept` protect against during resize, and how does
   it differ from a plain `std::move`?
5. Give three reasons an HFT engineer would `reserve` and refuse to ever resize.
6. Amortized O(1) and worst-case O(1) differ here — which does a resizing queue
   give, and why does the distinction matter for tick-to-trade latency?

## Further reading

- [`std::vector` — cppreference](https://en.cppreference.com/w/cpp/container/vector) and [`vector::reserve`](https://en.cppreference.com/w/cpp/container/vector/reserve) — the canonical doubling/`reserve` model this builds on.
- [Amortized analysis — CLRS chapter notes](https://en.wikipedia.org/wiki/Amortized_analysis) — aggregate and accounting methods for the doubling proof.
- [`std::move_if_noexcept` — cppreference](https://en.cppreference.com/w/cpp/utility/move_if_noexcept) — the exception-safety tool used in `rehome`.
- Facebook Folly, [`FBVector` notes on growth factor](https://github.com/facebook/folly/blob/main/folly/docs/FBVector.md) — the real-world argument for 1.5x over 2x.
- Erik Rigtorp, ["Ring buffer"](https://rigtorp.se/ringbuffer/) — the fixed-capacity version you'd prefer in HFT (no resize at all).
- [`std::align_val_t` / aligned `operator new[]` — cppreference](https://en.cppreference.com/w/cpp/memory/new/operator_new) — allocating over-aligned raw storage correctly.

## Videos

- CppCon — Chandler Carruth, **"Efficiency with Algorithms, Performance with Data Structures"** ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures)) — why contiguous + reserve beats growth-by-pointer.
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why an amortized O(n) reallocation is unacceptable on the trading path.
- CppCon — Timur Doumler, **"Want fast C++? Know your hardware!"** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+want+fast+c%2B%2B+know+your+hardware)) — allocation, caches, and preallocation strategy.
