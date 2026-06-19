# Array-Based MPMC Blocking Queue

> **Why a quant dev must own this:** A *bounded* queue is how you build
> **backpressure** into a pipeline — the one mechanism that stops a fast
> producer from drowning a slow consumer in unbounded memory. The array-backed
> ring buffer is the canonical bounded blocking queue: fixed memory, zero
> per-operation allocation, and predictable behaviour under load. Interviewers
> use it to test whether you can wire **two condition variables** (`not_full`,
> `not_empty`) correctly and explain *why bounding is a feature, not a
> limitation*.

## Problem statement

Implement a thread-safe, **bounded** queue for **many producers and many
consumers**, backed by a **fixed-size array used as a ring buffer**. API:

```cpp
void push(T value);              // BLOCKS while the queue is full
T    pop();                      // BLOCKS while the queue is empty
bool try_push(T value);          // false if full (no block)
std::optional<T> try_pop();      // nullopt if empty (no block)
void close();                    // shutdown: wake everyone, then drain
```

The defining properties: **fixed capacity** (set at construction), **no
allocation after construction**, and **backpressure** — `push` *blocks* when the
buffer is full instead of growing.

Standard: **C++17** (compiles unchanged as C++20).

## Clarifying constraints and assumptions

- **Bounded.** Capacity `N` is fixed up front. This is the whole point: bounded
  memory and natural backpressure.
- **MPMC.** Any thread pushes, any thread pops. A single mutex serialises
  access; this lesson is the *blocking* design (the lock-free bounded MPMC is
  the Vyukov queue — see the array-based MPSC lesson and Further reading).
- **Ring buffer indexing.** A `head` (read) and `tail` (write) index walk a
  circular array. We must distinguish *full* from *empty* — both can present as
  `head == tail`. We resolve it with an explicit **count** (simplest and
  clearest), and discuss the power-of-two index alternative.
- **Backpressure policy.** When full, do we *block* (this lesson), *drop oldest*,
  *drop newest*, or *fail fast* (`try_push`)? Name the policy explicitly; it is a
  design decision the interviewer wants to hear.
- **Shutdown.** `close()` must wake producers blocked on full *and* consumers
  blocked on empty.

## Approaches and tradeoffs

```text
 Full/empty disambiguation     Pros                       Cons
 ────────────────────────────  ─────────────────────────  ───────────────────────
 explicit count_ (THIS)        crystal clear; any capacity one extra word; +1 var
 "waste one slot" (head==tail  no count needed             loses one slot of cap;
   means empty, full = N-1)                                modular arithmetic
 power-of-2 + monotonic        mask instead of %;          capacity must be 2^k
   indices                     fast, lock-free-friendly
```

For a *blocking* queue, the explicit `count_` is the clearest correct answer.
The **power-of-two + monotonically increasing indices** trick (`index = seq &
(N-1)`) is what the lock-free versions use — mention it, because `& (N-1)` is a
single cycle whereas `%` can be a ~20-cycle division.

### Two condition variables — the heart of the design

A bounded queue has *two* wait conditions, so it needs *two* CVs:

```text
 not_full_   : producers wait here when count_ == capacity_
 not_empty_  : consumers wait here when count_ == 0

 push() : wait(not_full_)  ... store ... notify_one(not_empty_)
 pop()  : wait(not_empty_) ... load  ... notify_one(not_full_)
```

Each operation **waits on one CV and signals the other**. A `push` makes the
queue non-empty → wake exactly one consumer. A `pop` makes the queue non-full →
wake exactly one producer. `notify_one` (not `notify_all`) is correct on the
steady-state path because each event lets *exactly one* opposite-side waiter
proceed — avoiding the **thundering herd**. `close()` is the exception: it must
`notify_all` on **both** CVs so every blocked thread wakes to observe `closed_`.

## Complexity and progress guarantees

- `push` / `pop`: **O(1)** work in the critical section (one array slot
  write/read, index bump, count update). Plus possible blocking when full/empty.
- Space: **O(N)** — a single contiguous array, allocated once. **Zero**
  per-operation allocation, which is the headline advantage over the linked-list
  queue.
- **Progress: blocking.** Single mutex → not lock-free; the lock holder being
  preempted stalls everyone.

## A complete, annotated C++17 reference implementation

```cpp
#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <new>          // hardware_destructive_interference_size
#include <optional>
#include <utility>
#include <vector>

template <class T>
class ArrayMpmcBlockingQueue {
    std::vector<T>          buf_;        // ring storage, size == capacity_
    const std::size_t       cap_;
    std::size_t             head_  = 0;  // next index to POP from
    std::size_t             tail_  = 0;  // next index to PUSH into
    std::size_t             count_ = 0;  // # of items currently stored
    bool                    closed_ = false;

    mutable std::mutex      mtx_;
    std::condition_variable not_full_;   // producers block here when full
    std::condition_variable not_empty_;  // consumers block here when empty

public:
    explicit ArrayMpmcBlockingQueue(std::size_t capacity)
        : buf_(capacity), cap_(capacity) {
        // buf_ is sized once; no allocation happens on push/pop afterwards.
    }

    ArrayMpmcBlockingQueue(const ArrayMpmcBlockingQueue&)            = delete;
    ArrayMpmcBlockingQueue& operator=(const ArrayMpmcBlockingQueue&) = delete;

    // Any producer. Blocks while full. Returns false if closed before enqueue.
    bool push(T value) {
        std::unique_lock<std::mutex> lk(mtx_);
        // Wait while there is no room AND we're still open.
        not_full_.wait(lk, [this] { return count_ < cap_ || closed_; });
        if (closed_) return false;            // refuse new work after shutdown

        buf_[tail_] = std::move(value);       // store into the ring slot
        tail_ = (tail_ + 1) % cap_;           // advance write index, wrap
        ++count_;

        lk.unlock();                          // unlock BEFORE notifying
        not_empty_.notify_one();              // exactly one consumer can proceed
        return true;
    }

    // Any consumer. Blocks while empty. nullopt iff closed AND drained.
    std::optional<T> pop() {
        std::unique_lock<std::mutex> lk(mtx_);
        not_empty_.wait(lk, [this] { return count_ > 0 || closed_; });
        if (count_ == 0) return std::nullopt; // closed + empty -> done

        std::optional<T> v = std::move(buf_[head_]);
        head_ = (head_ + 1) % cap_;           // advance read index, wrap
        --count_;

        lk.unlock();
        not_full_.notify_one();               // exactly one producer can fit now
        return v;
    }

    // Non-blocking producer: false if full or closed.
    bool try_push(T value) {
        std::unique_lock<std::mutex> lk(mtx_);
        if (closed_ || count_ == cap_) return false;
        buf_[tail_] = std::move(value);
        tail_ = (tail_ + 1) % cap_;
        ++count_;
        lk.unlock();
        not_empty_.notify_one();
        return true;
    }

    // Non-blocking consumer: nullopt if empty.
    std::optional<T> try_pop() {
        std::unique_lock<std::mutex> lk(mtx_);
        if (count_ == 0) return std::nullopt;
        std::optional<T> v = std::move(buf_[head_]);
        head_ = (head_ + 1) % cap_;
        --count_;
        lk.unlock();
        not_full_.notify_one();
        return v;
    }

    // Shutdown: wake ALL waiters on BOTH conditions so each observes closed_.
    void close() {
        {
            std::lock_guard<std::mutex> lk(mtx_);
            closed_ = true;
        }
        not_full_.notify_all();   // wake producers blocked on full
        not_empty_.notify_all();  // wake consumers blocked on empty
    }

    std::size_t size() const {
        std::lock_guard<std::mutex> lk(mtx_);
        return count_;
    }
};
```

### Why an explicit `count_`

In a ring buffer, `head_ == tail_` is ambiguous: it's true both when the buffer
is **empty** (nothing written) and when it is **full** (writer wrapped all the
way around to the reader). Three standard resolutions: (1) keep an explicit
`count_` — what we did, clearest; (2) "waste one slot" so full means `(tail_+1)
% cap_ == head_` and you can never fill the last slot; (3) use monotonically
increasing 64-bit indices and compare `tail_ - head_` against capacity (the
lock-free style). The explicit count is unambiguous and supports the full
capacity, at the cost of one extra variable to keep in sync.

### Why bounded queues give backpressure (the senior point)

An unbounded queue *hides* a throughput mismatch: if the producer is faster than
the consumer, the queue silently grows until you run out of memory — and the
*first* symptom is often an OOM kill or GC-like latency cliff, far from the real
cause. A **bounded** queue *exposes* the mismatch at the source: when full,
`push` **blocks**, which throttles the producer to the consumer's rate. That
back-pressure propagates up the pipeline (a blocked decoder stops reading the
socket, TCP flow control kicks in, etc.). You trade "unbounded latency in memory
growth" for "bounded memory + visible blocking you can measure and alarm on."

> **The senior answer:** *Backpressure is not the queue failing — it is the
> queue doing its most important job: matching producer rate to consumer rate
> with bounded memory.* In a trading system you'd rather drop or block at a
> defined boundary than let a queue grow until the box dies.

## Low-latency optimizations

- **Zero per-op allocation** — the headline win. The array is allocated once;
  `push`/`pop` only move `T` and bump indices. This alone makes it preferable to
  the linked-list queue on any path you care about.
- **Power-of-two capacity → masking, not modulo.** Replace `% cap_` with
  `& (cap_ - 1)` when `cap_` is a power of two. `%` on a runtime value is a real
  division (~20+ cycles on x86); `&` is one cycle. Round capacity up to the next
  power of two in the constructor.

```cpp
// Power-of-two ring: index = pos & mask_, where mask_ = cap_ - 1.
// Requires cap_ to be a power of two (assert it in the ctor).
std::size_t idx(std::size_t pos) const noexcept { return pos & (cap_ - 1); }
```

- **False sharing.** Producer-mutated state (`tail_`) and consumer-mutated state
  (`head_`) pinging the same cache line costs you cross-core invalidations even
  through the mutex. When you split locks or go lock-free, pad them apart:

```cpp
#if defined(__cpp_lib_hardware_interference_size)
inline constexpr std::size_t kCacheLine =
    std::hardware_destructive_interference_size;   // 64 on x86-64
#else
inline constexpr std::size_t kCacheLine = 64;
#endif

struct alignas(kCacheLine) Producer { std::size_t tail{0}; /* + pad */ };
struct alignas(kCacheLine) Consumer { std::size_t head{0}; /* + pad */ };
```

- **`notify` outside the lock** to avoid waking a thread that then blocks on the
  mutex you still hold.
- **Batch operations** (`push_n` / `pop_n`) amortise the lock acquisition and
  the notify over many items — a large throughput win under contention.

## Follow-up variations interviewers ask

- **"Why two CVs, not one?"** One CV forces every operation to `notify_all` and
  every waiter to re-check on every event (thundering herd). Two CVs let you wake
  only the side that can progress, with `notify_one`.
- **"When does `notify_one` break and you need `notify_all`?"** At `close()`
  (every waiter must observe `closed_`), or if you ever multiplex both
  predicates onto one CV.
- **"Block, drop, or fail when full?"** Block = backpressure (this lesson). Drop
  oldest = ring overwrite (good for market-data snapshots where stale data is
  worthless). Drop newest / `try_push` = fail fast. Pick per use case.
- **"Make it lock-free."** The bounded array MPMC lock-free queue is **Vyukov's**
  design: a per-slot `std::atomic<size_t>` *sequence* number, producers
  `fetch_add` a ticket and CAS the slot's turn, consumers do the mirror. No
  mutex, no allocation, no node reclamation. See the array-based MPSC lock-free
  lesson and 1024cores.
- **"Bounded vs unbounded — defend your choice."** Bounded = predictable memory +
  backpressure; unbounded = never blocks producers but risks OOM. In HFT you
  almost always bound.
- **"`%` is showing up in your profile."** Power-of-two capacity + masking.

## Key takeaways

1. A bounded ring buffer = **fixed array + head/tail indices + a count**, with
   **zero per-operation allocation** — the headline advantage over linked-list
   queues.
2. It needs **two condition variables**: producers wait on `not_full_`,
   consumers wait on `not_empty_`. Each op **waits on one and signals the
   other**.
3. Use **`notify_one`** on the steady path (one event frees exactly one
   opposite-side waiter); **`notify_all` on both CVs at `close()`**.
4. **`head == tail` is ambiguous** (empty vs full). Resolve with an explicit
   `count_`, a wasted slot, or monotonic indices.
5. **Bounded = backpressure.** Blocking on full throttles a fast producer to the
   consumer's rate and bounds memory — a feature, not a limitation.
6. Optimisations: **power-of-two capacity + masking** instead of `%`, **false-
   sharing padding**, `notify` outside the lock, and batched ops.

## Self-check

1. Why is `head_ == tail_` insufficient to tell full from empty, and what three
   ways can you disambiguate it?
2. Trace a `push` and a `pop`: which CV does each *wait* on and which does each
   *signal*? Why that pairing?
3. At `close()`, why `notify_all` on **both** CVs? What hangs if you `notify_one`
   on just `not_empty_`?
4. Replace `% cap_` with a cheaper operation. What constraint does that impose on
   `cap_`, and roughly how many cycles do you save per op?
5. A colleague proposes an unbounded version "so producers never stall." Argue
   the case for keeping it bounded in a market-data ingest path.
6. Where is the only allocation in this class, and how many times does it run
   over the queue's lifetime?

## Further reading

- Anthony Williams, *C++ Concurrency in Action*, 2nd ed., Ch. 6 — bounded
  thread-safe queues and the two-condition-variable pattern.
- Erik Rigtorp, ["Optimizing a ring buffer for throughput"](https://rigtorp.se/ringbuffer/) — ring-buffer mechanics, power-of-two indexing, and false sharing; the canonical practitioner write-up.
- Dmitry Vyukov, ["Bounded MPMC queue"](https://www.1024cores.net/home/lock-free-algorithms/queues/bounded-mpmc-queue) — the lock-free destination once the mutex is the bottleneck; per-slot sequence numbers.
- [`std::condition_variable` — cppreference](https://en.cppreference.com/w/cpp/thread/condition_variable) — `wait` predicate overload, `notify_one`/`notify_all` contract.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — false-sharing padding for head/tail.
- Preshing, ["Locks Aren't Slow; Lock Contention Is"](https://preshing.com/20111118/locks-arent-slow-lock-contention-is/) — when the single mutex becomes the ceiling and you move to per-slot atomics.

## Videos

- Fedor Pikus — **"Live Lock-Free or Deadlock (Practical Lock-free Programming)"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+live+lock-free+or+deadlock)) — bounded queues, contention, and the path to lock-free.
- CppCon — **"Trading at light speed: designing low-latency systems" (David Gross)** ([search](https://www.youtube.com/results?search_query=David+Gross+trading+at+light+speed+C%2B%2B)) — where bounded queues and backpressure sit in a real trading pipeline.
