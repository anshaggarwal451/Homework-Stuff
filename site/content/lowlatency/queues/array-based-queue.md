# Array based Queue

> **Why this matters for low-latency C++:** This is the queue you actually ship.
> A fixed-capacity **ring buffer** has zero per-operation allocation, a
> contiguous cache-friendly layout the prefetcher loves, and dead-flat,
> predictable latency. It's the backbone of SPSC queues, the structure under
> `boost::lockfree::spsc_queue` and Rigtorp's famous SPSC queue, and the answer
> to "implement a queue" that signals you've written real hot-path code.
> Master the modulo arithmetic and the full-vs-empty disambiguation and you own
> the most important data structure in this module.

All code is **C++17**. We build a single-threaded ring buffer; the same skeleton,
with two atomic indices and the right memory ordering, becomes the lock-free
SPSC queue in a later lesson.

## Problem statement

Implement a **fixed-capacity FIFO** backed by a single contiguous array:

- `push(x)` — add to the back; fail (or block/overwrite — your policy) when full.
- `pop()` — remove from the front.
- `front()`, `empty()`, `full()`, `size()`.
- **No allocation after construction.** All O(1) with tiny, constant work.

## Clarifying constraints

- **Capacity fixed at construction?** Yes. That's the deal that buys us
  no-allocation and predictability. (Growing it is the *next* lesson.)
- **What happens on `push` when full?** Pick a policy and state it:
  *reject* (return `false`), *overwrite oldest* (a "latest-value" ring, common
  for market-data snapshots), or *block* (only meaningful with threads). We
  implement **reject**; overwrite is a 3-line variant shown later.
- **Single-threaded?** Yes. Multi-threaded SPSC is a separate lesson (atomics +
  cache-line padding); don't conflate.
- **Power-of-two capacity?** Optional but a big deal: if capacity is a power of
  two we replace the expensive `%` with a cheap `&` mask. We'll do both and
  explain the tradeoff.
- **In-place storage of `T`?** We store raw aligned storage and placement-new
  elements, so non-default-constructible and move-only `T` work and we don't pay
  for `capacity` default constructions up front.

## The core idea: indices that wrap

Two indices walk around a fixed array. `head_` is where the next `pop` reads;
`tail_` is where the next `push` writes. When an index reaches the end of the
array it **wraps** to the front — hence "ring."

```text
capacity = 8 buffer. head=2, tail=6, size=4 (elements B C D E):

  index:   0   1   2   3   4   5   6   7
         +---+---+---+---+---+---+---+---+
         | . | . | B | C | D | E | . | . |
         +---+---+---+---+---+---+---+---+
                   ^head           ^tail (next write)

after two pops (head->4) and three pushes (tail wraps 6->7->0->1):

  index:   0   1   2   3   4   5   6   7
         +---+---+---+---+---+---+---+---+
         | H | I | . | . | D | E | F | G |   data wraps around the seam
         +---+---+---+---+---+---+---+---+
               ^tail       ^head
```

### The full-vs-empty problem (the crux of the interview)

Here's the subtlety everyone trips on. With `head` and `tail` both modulo
`capacity`, the condition `head == tail` is **ambiguous**: it means *empty* (we
just caught up) and also *full* (we wrapped all the way around). You can't tell
which from the two indices alone. Three standard fixes:

| Technique | Idea | Cost |
|-----------|------|------|
| **Keep a `size_` count** | track element count separately; empty ⟺ `size==0`, full ⟺ `size==capacity` | one extra word, one extra `++/--` per op; uses **all** slots |
| **Sacrifice one slot** | never let `tail` catch `head` from behind; full ⟺ `(tail+1)%cap == head` | wastes 1 slot; no counter; classic in lock-free SPSC where a shared counter would be a contention point |
| **Free-running indices** | let `head`/`tail` grow monotonically (never reduced mod cap); index into array via `& mask`; `size = tail - head` | needs power-of-two cap; elegant, the Rigtorp/Vyukov style |

For a single-threaded queue, **a `size_` counter is simplest and uses every
slot** — that's what we implement. We'll note where the SPSC version prefers the
sacrificed-slot or free-running approach (to avoid a shared, contended counter).

### `%` vs. `&` — why power-of-two capacity matters

`tail_ = (tail_ + 1) % capacity_;` is correct for any capacity, but integer
**division/modulo is slow** (~20-40 cycles on x86, not pipelined like add). If
`capacity` is a power of two, then `x % capacity == x & (capacity - 1)` — a
single-cycle AND. In a hot path you round capacity up to a power of two and mask.

```text
capacity = 8 = 0b1000,  mask = 7 = 0b0111
  (tail + 1) & mask  wraps automatically:  7 & 7 = 7,  8 & 7 = 0
```

## Complexity

| Operation | Time | Allocations |
|-----------|:----:|:-----------:|
| construct (capacity N) | O(1) alloc of N slots | 1, at startup |
| `push` / `pop` | O(1), branch + a couple of ALU ops | 0 |
| `front`/`empty`/`full`/`size` | O(1) | 0 |

Not just O(1) — *small, constant, branch-predictable* O(1) with **no pointer
chasing**. This is as good as a queue gets.

## Reference implementation

```cpp
// C++17. Fixed-capacity single-threaded ring buffer. No per-op allocation.
// Capacity is rounded UP to a power of two so we wrap with a mask, not %.
#include <cstddef>
#include <new>
#include <utility>
#include <vector>
#include <cassert>

template <class T>
class RingQueue {
    static std::size_t round_up_pow2(std::size_t n) {
        if (n < 2) return 2;
        --n;
        for (std::size_t s = 1; s < sizeof(std::size_t) * 8; s <<= 1) n |= n >> s;
        return n + 1;                       // smallest power of two >= original n
    }

    std::size_t cap_;                       // power of two
    std::size_t mask_;                      // cap_ - 1, for cheap wrap
    std::size_t head_ = 0;                  // read index  (next pop)
    std::size_t tail_ = 0;                  // write index (next push)
    std::size_t size_ = 0;                  // # live elements (full/empty fix)

    // Raw, T-aligned storage. We placement-new only the live slots, so T need
    // not be default-constructible and we don't construct `cap_` Ts up front.
    struct alignas(T) Slot { unsigned char bytes[sizeof(T)]; };
    std::vector<Slot> buf_;

    T*       at(std::size_t i)       { return reinterpret_cast<T*>(buf_[i].bytes); }
    const T* at(std::size_t i) const { return reinterpret_cast<const T*>(buf_[i].bytes); }

public:
    explicit RingQueue(std::size_t capacity)
        : cap_(round_up_pow2(capacity)), mask_(cap_ - 1), buf_(cap_) {}

    RingQueue(const RingQueue&)            = delete;
    RingQueue& operator=(const RingQueue&) = delete;

    ~RingQueue() {
        // Destroy only the live elements, walking head..tail with wrap.
        for (std::size_t i = 0, idx = head_; i < size_; ++i, idx = (idx + 1) & mask_)
            at(idx)->~T();
    }

    // O(1), allocation-free. Returns false if full (reject policy).
    template <class... Args>
    [[nodiscard]] bool try_emplace(Args&&... args) {
        if (size_ == cap_) return false;            // full
        ::new (buf_[tail_].bytes) T(std::forward<Args>(args)...);  // placement new
        tail_ = (tail_ + 1) & mask_;                // cheap wrap (pow2)
        ++size_;
        return true;
    }
    [[nodiscard]] bool push(const T& v) { return try_emplace(v); }
    [[nodiscard]] bool push(T&& v)      { return try_emplace(std::move(v)); }

    // O(1), allocation-free. Precondition: !empty().
    T pop() {
        T result = std::move(*at(head_));   // move element out
        at(head_)->~T();                    // destroy in place
        head_ = (head_ + 1) & mask_;
        --size_;
        return result;
    }

    T&       front()       { return *at(head_); }   // precondition: !empty()
    const T& front() const { return *at(head_); }

    bool        empty() const noexcept { return size_ == 0; }
    bool        full()  const noexcept { return size_ == cap_; }
    std::size_t size()  const noexcept { return size_; }
    std::size_t capacity() const noexcept { return cap_; }
};
```

The details an interviewer is checking:

- **Wrap with `& mask_`, not `% cap_`** — only legal because we rounded capacity
  up to a power of two in the constructor. Show you know *why* the AND works
  (and that `%` would otherwise be ~20-40 cycles).
- **`size_` counter resolves full-vs-empty** unambiguously and lets us use all
  `cap_` slots. Mention the alternatives (sacrifice a slot / free-running
  indices) and why SPSC prefers them.
- **Placement new + explicit `~T()` over raw storage** — same discipline as the
  pool lesson: we don't default-construct `cap_` objects up front, and move-only
  `T` works.
- **Destructor walks only the live range** `[head_, head_+size_)` with wrap.
  Destroying the whole array would call `~T()` on slots that never held a live
  object — UB.

## Low-latency optimizations

### Power-of-two + mask (already in)

The single highest-value trick: replace `%` with `&`. If you can't make capacity
a power of two (memory-constrained), there's a branch-based wrap that's still
faster than `div`:

```cpp
// Conditional wrap without division (works for any capacity):
if (++tail_ == cap_) tail_ = 0;   // one predictable branch vs ~30-cycle div
```

The compiler predicts this branch almost perfectly (it's taken once per
`cap_` pushes), so it routinely beats `%` for non-pow2 capacities.

### Contiguous layout = the prefetcher works for you

Unlike the linked list, sequential `push`/`pop` march linearly through memory.
The hardware prefetcher recognizes the stride and pulls the next cache lines in
before you ask. Several small elements share a line, so you also get fewer
misses per element. **This is the structural reason the array queue beats the
linked queue** even though both are O(1).

### Branchless `push` for the overwrite (latest-value) policy

For a market-data "keep the newest N" ring you don't reject when full — you
overwrite the oldest and advance `head` too. That removes the `full` branch
entirely from `push`:

```cpp
// Overwrite-oldest ring: push never fails, no `full` check.
void push_overwrite(const T& v) {
    if (size_ == cap_) { at(head_)->~T(); head_ = (head_ + 1) & mask_; --size_; }
    ::new (buf_[tail_].bytes) T(v);
    tail_ = (tail_ + 1) & mask_;
    ++size_;
}
```

### False sharing (only relevant once you go SPSC)

In the single-threaded queue, `head_`, `tail_`, and `size_` living in one cache
line is *good* — one line holds all the state. The moment a *producer* and a
*consumer* run on different cores, that same co-location becomes a disaster:
every `push` invalidates the line the consumer reads `head_` from, ping-ponging
the line between cores (false sharing). The SPSC fix is to put `head_` and
`tail_` on **separate cache lines** (`alignas(64)`) and drop the shared `size_`.
Know that this is *the* difference between the single-threaded and SPSC layouts.

```text
SPSC layout (later lesson) — separate cache lines, no shared counter:

  [ alignas(64) tail_ ][ pad... ][ alignas(64) head_ ][ pad... ][ buffer... ]
     written by producer            written by consumer
```

## Follow-up variations interviewers ask

- **"Implement it lock-free for one producer, one consumer."** Replace `head_`/
  `tail_` with `std::atomic<size_t>`, drop `size_` (derive emptiness from
  comparing the two indices — the sacrificed-slot or free-running trick),
  pad them onto separate cache lines, and use `acquire`/`release` ordering. This
  is a whole lesson; the *single-threaded* version you just wrote is its
  skeleton.
- **"Why power-of-two? What's wrong with `%`?"** Division/modulo isn't pipelined
  and is ~20-40 cycles; `& (cap-1)` is one cycle. Power-of-two capacity is the
  price.
- **"How do you distinguish full from empty?"** The headline question — give all
  three techniques and say which you'd use single-threaded (counter) vs. SPSC
  (sacrifice a slot / free-running indices, to avoid a contended shared
  counter).
- **"Iterate the elements in order."** Walk `head_` forward `size_` times with
  `& mask_`. Note the data may be *physically* split across the wrap seam, so a
  single `memcpy` of the live region isn't possible — you may need two.
- **"Bulk-copy out the contents."** Because of the seam, it's up to two
  contiguous runs: `[head_, end)` then `[0, tail_)`. Interviewers love this when
  asking about draining a queue efficiently.

## Key takeaways

1. A **fixed-capacity ring buffer** is the hot-path queue: contiguous,
   cache-friendly, zero per-op allocation, flat predictable latency. It beats
   the linked list despite identical O(1) because of *layout*.
2. **`head == tail` is ambiguous** (empty *or* full). Resolve it with a `size_`
   counter (single-threaded, uses all slots), a sacrificed slot, or free-running
   indices (SPSC).
3. **Round capacity up to a power of two and wrap with `& (cap-1)`** — turns a
   ~20-40 cycle `%` into a 1-cycle AND. Otherwise use a conditional-reset branch,
   never `div`.
4. **Placement-new only the live slots; destroy only `[head, head+size)`** with
   wrap in the destructor — never `~T()` over the whole array.
5. The single-threaded layout *co-locates* `head`/`tail`/`size` (good); the SPSC
   version *separates* them onto different cache lines and drops the shared
   counter to avoid **false sharing**.

## Self-check

1. Why is `head_ == tail_` insufficient to tell full from empty, and what are
   the three standard ways to disambiguate?
2. Exactly why does power-of-two capacity let you replace `%` with `&`, and how
   many cycles does that save per operation roughly?
3. Your destructor does `for (auto& s : buf_) at(&s)->~T();`. What's the bug?
4. Convert the reject-on-full `push` into an overwrite-oldest "latest value"
   ring. Which branch disappears?
5. Single-threaded, having `head_`, `tail_`, `size_` in one cache line is good;
   in SPSC it's a bug. Explain the reversal.
6. After many wraps, you want to drain the whole queue with `memcpy`. Why might
   you need *two* `memcpy`s?

## Further reading

- Erik Rigtorp, ["A single producer single consumer wait-free ring buffer"](https://rigtorp.se/ringbuffer/) — the canonical SPSC ring buffer (the threaded sequel to this lesson).
- [`boost::lockfree::spsc_queue`](https://www.boost.org/doc/libs/release/doc/html/boost/lockfree/spsc_queue.html) — a production fixed-capacity ring buffer; read the source.
- Dmitry Vyukov, ["Bounded MPMC queue"](https://www.1024cores.net/home/lock-free-algorithms/queues/bounded-mpmc-queue) — the free-running-index / sequence-number ring buffer technique.
- [`std::queue` — cppreference](https://en.cppreference.com/w/cpp/container/queue) — contrast: the STL FIFO is unbounded and allocating, not a ring.
- [Circular buffer — Wikipedia](https://en.wikipedia.org/wiki/Circular_buffer) — the full/empty disambiguation techniques laid out side by side.
- [Why is modulo slow? — division on x86 (Agner Fog instruction tables)](https://www.agner.org/optimize/instruction_tables.pdf) — the latency numbers behind "avoid `%`".

## Videos

- CppCon — Charles Frasch, **"Single Producer Single Consumer Lock-free FIFO From the Ground Up"** ([search](https://www.youtube.com/results?search_query=CppCon+Charles+Frasch+single+producer+single+consumer+lock+free+FIFO)) — builds exactly this ring buffer, then makes it lock-free.
- CppCon — Timur Doumler, **"Want fast C++? Know your hardware!"** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+want+fast+c%2B%2B+know+your+hardware)) — caches, prefetching, why contiguous wins.
- CppCon — Fedor Pikus, **"Live Lock-Free or Deadlock"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+live+lock-free+or+deadlock)) — the lock-free ring buffer and false sharing.
