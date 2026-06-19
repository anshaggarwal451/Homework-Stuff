# Array-Based MPSC Lock-Free Queue

> **Why a quant dev must own this:** The intrusive linked MPSC queue is elegant
> but unbounded and pointer-chasing. The *array-based* MPSC queue gives you the
> same many-producers/one-consumer fan-in with **fixed memory, zero allocation,
> contiguous cache-friendly storage, and built-in backpressure** — and it is a
> straight specialization of Dmitry Vyukov's celebrated bounded MPMC queue. The
> mechanism (per-slot **sequence numbers** + a `fetch_add`/CAS claim) is one of
> the most beautiful ideas in lock-free programming, and explaining it cleanly
> is a top-tier HFT interview signal.

## Problem statement

Build a **lock-free, bounded** queue for **many producers, one consumer**,
backed by a **fixed array ring buffer**. API:

```cpp
bool enqueue(T v);   // any producer; false if FULL (no block, no allocation)
bool dequeue(T& out);// the single consumer; false if EMPTY
```

No locks, no allocation, fixed capacity (power of two). Producers that find the
queue full *fail* (returning `false`) rather than block — that's the
backpressure signal. We target **C++17** (atomics are C++11;
`hardware_destructive_interference_size` is C++17). This is **Vyukov's bounded
MPMC queue, used in MPSC mode** (single consumer).

## Clarifying constraints and assumptions

- **MPMC algorithm, MPSC usage.** Vyukov's bounded queue is fully MPMC; using it
  with one consumer is just a usage restriction. We keep the consumer side
  general so it's correct even if you later add consumers — that's a feature, and
  the right thing to say in an interview ("I'll use the MPMC-correct algorithm
  and note it specializes to MPSC").
- **Bounded, power-of-two capacity.** Capacity `N` is fixed and a power of two so
  index = `pos & (N-1)` is a single AND, not a modulo.
- **Per-slot sequence numbers** are the heart: each slot carries an
  `std::atomic<size_t> seq` that encodes whose turn it is. This is how a slot
  signals "ready to write" vs "ready to read" *without* a global lock and
  without the linked-list intermediate-state subtlety.
- **No per-item allocation.** `T` is stored by value in the slot array,
  allocated once.
- **Producers claim a ticket** with `fetch_add` (or CAS) on a monotonically
  increasing `enqueue_pos_`; the slot's `seq` then gates publication. This is the
  array analogue of the linked queue's `exchange`.

## Approach: per-slot sequence numbers (the turnstile)

Each slot has a `seq` counter. The invariant, for a power-of-two capacity `N`
and a monotonically increasing position counter:

```text
 Slot i holds seq. For an enqueue at ticket pos (slot = pos & (N-1)):
   seq == pos            -> slot is FREE for this producer to write
   seq <  pos            -> slot still full (consumer hasn't read it) -> FULL
   seq >  pos            -> another producer already claimed; reload pos

 After writing:  seq = pos + 1     (signals "data ready for the consumer")
 After reading:  seq = pos + N      (signals "slot free for the NEXT lap")
```

The sequence number is a **per-slot turnstile**: it tells whichever thread looks
at the slot whether it's that thread's turn, *and* which lap of the ring it's
on. Producers and the consumer never need a shared lock — they synchronize
*through each slot's `seq`*. Crucially, there is **no global intermediate-state
window** like the linked MPSC: a slot is either published (`seq == pos+1`) or it
isn't, atomically.

```text
   enqueue_pos_ (producers fetch_add a ticket)
        |
        v
   [s0][s1][s2][s3][s4][s5][s6][s7]   N = 8 slots
        ^
   dequeue_pos_ (consumer; single thread here, still uses CAS-safe protocol)

   Producer P: pos = enqueue_pos_.fetch_add ... no, see code: load + CAS loop
   to claim a ticket only if the slot's seq says it's free.
```

### How a producer claims a slot

The canonical Vyukov producer does **not** blindly `fetch_add`. It loads
`enqueue_pos_`, inspects the target slot's `seq`, and only **CAS**es
`enqueue_pos_` forward if the slot is free (`seq == pos`). The `diff` of
`seq - pos` drives a three-way decision: free (CAS to claim), full (return
false), or stale (reload and retry). This avoids the "I claimed a ticket for a
slot that's still full" problem a naive `fetch_add` would create.

## Complexity and progress guarantees

- `enqueue` / `dequeue`: **O(1)** amortized; a short CAS-retry loop that only
  spins when *another* thread is actively claiming the same position.
- **Progress: lock-free.** A producer can fail its CAS only because another
  producer succeeded (system-wide progress). No thread holds a lock; a preempted
  producer cannot block others from using *other* slots.
- **Bounded, zero allocation, contiguous memory** — the array advantages.
- **Backpressure built in:** `enqueue` returns `false` when full, so the caller
  throttles or sheds — no unbounded growth.

## A complete, annotated C++17 reference implementation

```cpp
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <new>       // hardware_destructive_interference_size (C++17)
#include <utility>
#include <vector>

#if defined(__cpp_lib_hardware_interference_size)
inline constexpr std::size_t kCacheLine =
    std::hardware_destructive_interference_size;   // 64 on x86-64
#else
inline constexpr std::size_t kCacheLine = 64;
#endif

// Bounded lock-free queue (Dmitry Vyukov). MPMC-correct; used here MPSC.
// Capacity must be a power of two. No allocation after construction.
template <class T>
class BoundedMpscQueue {
    struct Cell {
        std::atomic<std::size_t> seq;   // per-slot turnstile (sequence number)
        T                        data;  // payload, stored by value
    };

    // Padding so producers (enqueue_pos_) and the consumer (dequeue_pos_) don't
    // false-share, and so the cells array doesn't false-share with the indices.
    alignas(kCacheLine) std::vector<Cell> buffer_;
    const std::size_t                     mask_;          // capacity - 1

    alignas(kCacheLine) std::atomic<std::size_t> enqueue_pos_{0}; // producer-hot
    alignas(kCacheLine) std::atomic<std::size_t> dequeue_pos_{0}; // consumer
    char pad_[kCacheLine - sizeof(std::atomic<std::size_t>)]{};

public:
    explicit BoundedMpscQueue(std::size_t capacity)
        : buffer_(capacity), mask_(capacity - 1) {
        // Capacity must be a power of two so index = pos & mask_.
        // (assert((capacity & (capacity - 1)) == 0 && capacity >= 2);)
        // Seed each slot's sequence with its own index: slot i is "free for
        // the producer whose ticket == i" on the first lap.
        for (std::size_t i = 0; i < capacity; ++i)
            buffer_[i].seq.store(i, std::memory_order_relaxed);
    }

    BoundedMpscQueue(const BoundedMpscQueue&)            = delete;
    BoundedMpscQueue& operator=(const BoundedMpscQueue&) = delete;

    // ANY PRODUCER. Returns false if the queue is full.
    bool enqueue(T v) {
        Cell* cell;
        // Snapshot the current enqueue ticket (relaxed: we re-validate via CAS).
        std::size_t pos = enqueue_pos_.load(std::memory_order_relaxed);
        for (;;) {
            cell = &buffer_[pos & mask_];
            // acquire: see the consumer's release of seq (slot freed) before we
            // decide it's writable.
            std::size_t seq = cell->seq.load(std::memory_order_acquire);
            std::intptr_t diff =
                static_cast<std::intptr_t>(seq) - static_cast<std::intptr_t>(pos);

            if (diff == 0) {
                // Slot is free for THIS ticket. Try to claim the ticket.
                // relaxed CAS: ordering for the payload is established by the
                // release store to cell->seq below.
                if (enqueue_pos_.compare_exchange_weak(
                        pos, pos + 1, std::memory_order_relaxed))
                    break;                 // claimed; pos unchanged for us
                // CAS failed: another producer won; pos was reloaded, retry.
            } else if (diff < 0) {
                // seq < pos: slot from a previous lap not yet consumed -> FULL.
                return false;
            } else {
                // seq > pos: another producer already advanced; reload & retry.
                pos = enqueue_pos_.load(std::memory_order_relaxed);
            }
        }

        cell->data = std::move(v);                       // write payload
        // PUBLISH: release store. A consumer that acquire-loads seq == pos+1
        // is guaranteed to see this payload write. seq = pos+1 means "ready".
        cell->seq.store(pos + 1, std::memory_order_release);
        return true;
    }

    // THE SINGLE CONSUMER (protocol is MPMC-safe). false if empty.
    bool dequeue(T& out) {
        Cell* cell;
        std::size_t pos = dequeue_pos_.load(std::memory_order_relaxed);
        for (;;) {
            cell = &buffer_[pos & mask_];
            std::size_t seq = cell->seq.load(std::memory_order_acquire);
            // A slot is ready to READ when seq == pos + 1 (set by enqueue).
            std::intptr_t diff =
                static_cast<std::intptr_t>(seq)
              - static_cast<std::intptr_t>(pos + 1);

            if (diff == 0) {
                if (dequeue_pos_.compare_exchange_weak(
                        pos, pos + 1, std::memory_order_relaxed))
                    break;                 // claimed this read slot
            } else if (diff < 0) {
                // seq < pos+1: producer hasn't published yet -> EMPTY.
                return false;
            } else {
                pos = dequeue_pos_.load(std::memory_order_relaxed);
            }
        }

        out = std::move(cell->data);                     // read payload
        // FREE the slot for the NEXT lap: seq = pos + N (= pos + mask_ + 1).
        // release: a producer that later acquire-loads this seq sees the slot
        // is free and our read is complete.
        cell->seq.store(pos + mask_ + 1, std::memory_order_release);
        return true;
    }
};
```

### Why this beats the linked MPSC for HFT

- **No allocation, contiguous storage.** Cells live in one array → prefetcher-
  friendly, no pointer chasing, no cache miss per node, no freelist.
- **Bounded → backpressure.** `enqueue` returns `false` when full; the producer
  decides (retry/drop/shed). The linked MPSC grows unbounded.
- **No intermediate-state ambiguity.** In the linked MPSC, `pop()==nullptr`
  could mean "producer mid-push." Here a slot's `seq` is *atomically* either
  "ready" (`pos+1`) or not — `dequeue` returning `false` cleanly means "no
  published item at the head position." The per-slot turnstile localizes the
  publication signal to the slot, eliminating the global broken-chain window.

### The sequence-number invariant, spelled out

```text
 Lifecycle of slot i (initial seq = i):
   producer with ticket pos (pos & mask == i):
        seq == pos      -> writable  -> after write: seq := pos + 1
   consumer with ticket pos (pos & mask == i):
        seq == pos + 1  -> readable  -> after read:  seq := pos + N
   ... next lap: the next producer's ticket for slot i is pos + N, and
       seq == pos + N == (next pos) -> writable again. The cycle closes.
```

Each `seq` advances monotonically by `N` per lap, so the three-way `diff`
comparison correctly classifies *which lap* a slot is on even as `pos` wraps —
this is why signed `diff` of `seq - pos` is the right test, not raw equality on
wrapped indices.

## Low-latency optimizations

- **Power-of-two capacity + mask.** `pos & mask_` is one cycle; `pos % N` would
  be a ~20-cycle division. Always size to a power of two.
- **Per-slot `seq` co-located with `data`** in the `Cell` keeps the turnstile and
  payload on the same line the thread already touches — but watch total `Cell`
  size; large `T` spreads slots across many lines (fine) while keeping each
  slot's `seq` adjacent to its own data.
- **Cache-line-pad `enqueue_pos_` and `dequeue_pos_` apart.** `enqueue_pos_` is
  hammered by all producers' CAS; `dequeue_pos_` by the consumer. Same line =
  false sharing that serializes the two ends. `alignas(kCacheLine)` separates
  them.
- **`compare_exchange_weak` in the loop** is correct and cheaper than `_strong`
  here: spurious failure just re-iterates a loop you're already in, and `weak`
  avoids an inner retry on LL/SC architectures (ARM).
- **Relaxed CAS, release publish.** The ticket CAS is `relaxed` because the
  *payload* ordering is carried by the release store to `cell->seq`; you don't
  pay for ordering twice.
- **Producer-side `fetch_add` variant.** A simpler design uses
  `enqueue_pos_.fetch_add(1)` to grab a ticket unconditionally, then waits on the
  slot's `seq` to become writable. It's even cheaper per claim but cannot fail-
  fast on "full" (the ticket is already taken), so it suits *unbounded-ish* or
  spin-until-space semantics rather than `false`-on-full backpressure. Know both
  and when each applies.

## Follow-up variations interviewers ask

- **"Relate this to Vyukov's bounded MPMC."** It *is* that queue; single consumer
  is a usage restriction. The exact same code is MPMC-correct.
- **"`fetch_add` vs CAS to claim a ticket — tradeoffs?"** CAS (shown) lets
  `enqueue` fail-fast when full. `fetch_add` is cheaper but commits you to the
  ticket, so it can't cleanly report "full" — it must spin/wait for the slot.
- **"Why signed `diff` of `seq - pos`?"** To classify free / full / stale across
  ring wraparound; raw `==` on masked indices can't tell which lap a slot is on.
- **"How is this not exposed to the linked-MPSC intermediate state?"** Because
  publication is a single atomic release store to the slot's `seq`; there's no
  two-step "swap then link." A slot is atomically ready or not.
- **"Make `enqueue` blocking."** Spin with `_mm_pause()` on `false`, or layer an
  eventcount; but you lose the clean backpressure signal.
- **"What if `T` is large/non-trivial?"** Stored by value works, but a big `T`
  bloats each `Cell`; consider storing indices/handles or small PODs (typical
  for market-data/order messages anyway).
- **"Memory reclamation?"** None needed — fixed array, no freeing, no ABA on the
  payload (the `seq` lap counter is the ABA guard on the slot itself).

## Key takeaways

1. The array-based MPSC queue is **Vyukov's bounded MPMC queue** used with one
   consumer: fixed array, power-of-two capacity, **zero allocation**,
   contiguous and cache-friendly.
2. Each slot carries a **sequence number (`seq`)** acting as a per-slot
   turnstile: `seq == pos` → writable, `seq == pos+1` → readable, advancing by
   `N` each lap.
3. Producers **claim a ticket via CAS** on `enqueue_pos_` only when the slot is
   free; the three-way **signed `diff = seq - pos`** classifies free / full /
   stale across wraparound.
4. **Publication is a single release store** to the slot's `seq`, paired with the
   reader's **acquire** load — so there is **no linked-list intermediate-state
   window**; a slot is atomically ready or not.
5. **Bounded → backpressure:** `enqueue` returns `false` when full; the caller
   throttles. No unbounded growth.
6. Optimize with **mask not modulo**, **release-publish / relaxed-CAS** (don't
   pay for ordering twice), **`compare_exchange_weak`**, and **cache-line padding**
   of the two position counters.

## Self-check

1. Write the three values of `diff = seq - pos` for the producer and say what
   each (`0`, `<0`, `>0`) means and what the producer does.
2. After a successful enqueue at ticket `pos`, what does `seq` become, and after
   the matching dequeue, what does it become — and why `pos + N` rather than back
   to `pos`?
3. Why does this design have *no* equivalent of the linked-MPSC intermediate
   state where `pop` returns `nullptr` mid-push?
4. Why is the ticket CAS `memory_order_relaxed` while the `seq` publish store is
   `release`? Where would a bug appear if you made the publish `relaxed`?
5. Contrast claiming a ticket with `fetch_add` vs CAS: which one can report
   "full," and why does the other cannot cleanly do so?
6. Which two atomics must sit on separate cache lines, and what contention do you
   create if they share one?

## Further reading

- Dmitry Vyukov, ["Bounded MPMC queue"](https://www.1024cores.net/home/lock-free-algorithms/queues/bounded-mpmc-queue) — the source algorithm with per-slot sequence numbers; this lesson is that queue. Essential reading.
- Dmitry Vyukov, ["Intrusive MPSC node-based queue"](https://www.1024cores.net/home/lock-free-algorithms/queues/intrusive-mpsc-node-based-queue) — the unbounded linked alternative; contrast allocation and the intermediate state.
- Erik Rigtorp, ["Optimizing a ring buffer for throughput"](https://rigtorp.se/ringbuffer/) — power-of-two indexing, masking, and false-sharing padding applied to ring buffers.
- Jeff Preshing, ["Acquire and Release Semantics"](https://preshing.com/20120913/acquire-and-release-semantics/) — the publish/consume pairing the `seq` store/load relies on.
- [`std::atomic::compare_exchange_weak` — cppreference](https://en.cppreference.com/w/cpp/atomic/atomic/compare_exchange) — why `weak` in a loop, and the memory-order arguments.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — separating `enqueue_pos_` and `dequeue_pos_`.

## Videos

- Fedor Pikus — **"Live Lock-Free or Deadlock (Practical Lock-free Programming)"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+live+lock-free+or+deadlock)) — CAS loops, sequence-number tricks, and progress guarantees.
- CppCon — **"Trading at light speed: designing low-latency systems" (David Gross)** ([search](https://www.youtube.com/results?search_query=David+Gross+trading+at+light+speed+C%2B%2B)) — bounded lock-free queues in a real trading pipeline.
- Timur Doumler — **"Want fast C++? Know your hardware!"** ([search](https://www.youtube.com/results?search_query=Timur+Doumler+want+fast+C%2B%2B+know+your+hardware)) — cache lines and false sharing, which decide this queue's real throughput.
