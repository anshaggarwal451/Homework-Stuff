# Linked List Based MPMC Blocking Queue

> **Why a quant dev must own this:** The moment you have a thread *pool* — N
> feed-decoder threads fanning into M strategy workers, or many workers draining
> a shared task queue — you need a queue that any thread can push to and any
> thread can pop from, safely. The mutex-backed MPMC queue is the workhorse you
> use everywhere off the latency-critical path (logging, telemetry, background
> work) and the structure interviewers use to probe whether you *really*
> understand `notify_one` vs `notify_all`, bounded vs unbounded, and — the part
> most candidates fluff — **clean shutdown**.

## Problem statement

Implement a thread-safe queue supporting **many producer threads and many
consumer threads** concurrently. Storage is a **singly linked list**. Provide:

```cpp
void push(T value);                 // any producer; may block if bounded & full
std::optional<T> pop();             // any consumer; BLOCKS until item or closed
std::optional<T> try_pop();         // never blocks; nullopt if empty
void close();                       // shutdown: wake everyone, drain, then done
```

We'll build the **unbounded** version first (the common default for a linked
list), then show the **bounded** variant and discuss when each is right.

Standard: **C++17** (compiles unchanged as C++20).

## Clarifying constraints and assumptions

- **MPMC.** Multiple threads call `push` *and* `pop` concurrently. A single
  mutex serialises all of them — that is what makes correctness easy and is also
  the scalability ceiling.
- **Bounded or unbounded?** This is the *first* question to ask the interviewer.
  Unbounded linked list → `push` never blocks but a slow consumer lets memory
  grow without bound. Bounded → `push` blocks when full, giving **backpressure**.
- **Shutdown semantics.** When the system stops, blocked consumers must be woken
  and told "no more data is coming." Without this they wait forever and the
  process won't join. This is the single most common bug in MPMC submissions.
- **Fairness.** A `std::mutex` is *not* guaranteed FIFO-fair across waiters. If
  you need fairness across producers/consumers you must build it; usually you
  don't, and saying so is the right answer.
- **Move semantics & exception safety** as in the SPSC lesson.

## Approaches and tradeoffs

```text
 Lock granularity        Pros                         Cons
 ─────────────────────── ───────────────────────────  ──────────────────────────
 Single mutex (HERE)     dead simple, obviously        all ops serialise;
                         correct, easy shutdown        no parallelism in the queue
 Two mutexes (head+tail) producers & consumers don't   subtle: empty/one-element
                         contend on the same lock      boundary needs care
 Lock-free (M&S queue)   no blocking, scales           node reclamation is hard
                                                        (hazard ptrs / RCU / ABA)
```

For a *blocking* MPMC queue the **single mutex** is the right default answer in
an interview: correct, readable, and the bottleneck (the lock) is exactly what
you'd profile before reaching for anything fancier. Mention the **two-lock**
Michael & Scott optimisation (separate `head_mutex` and `tail_mutex` so a
producer and a consumer can proceed in parallel) as the next step, and lock-free
as the endgame.

### `notify_one` vs `notify_all` — the interview crux

This is *the* question for MPMC blocking queues. The rule:

- Use **`notify_one`** when **any single waiter can make progress** and they are
  all waiting on the *same* condition. One `push` makes the queue non-empty for
  exactly one consumer, so waking one consumer is correct and cheaper (it avoids
  the **thundering herd** — N consumers all wake, all contend for the mutex,
  N-1 immediately re-sleep).
- Use **`notify_all`** when **the state change can satisfy multiple waiters**, or
  when **different waiters wait on different predicates that share one CV**, or
  at **shutdown** (everyone must wake to observe `closed_`).

```text
 Event                         Correct signal     Why
 ────────────────────────────  ─────────────────  ──────────────────────────────
 push() one item               notify_one         one consumer can take it
 pop() frees a slot (bounded)  notify_one         one producer can fit
 close()                       notify_all         every waiter must see closed_
```

Getting `notify_one` right at shutdown is where people fall down: if you
`notify_one` on `close()`, only one of N blocked consumers wakes — the rest hang.

## Complexity and progress guarantees

- `push` / `pop` / `try_pop`: **O(1)** work inside the critical section.
- **Progress: blocking.** With a single mutex the queue is *not* lock-free —
  preempting the lock holder stalls everyone. Throughput is bounded by how fast
  one thread can take/release the lock (and the futex sleep/wake cost under
  contention).
- Space: **O(n)** items + one dummy node.

## A complete, annotated C++17 reference implementation (unbounded)

```cpp
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

// Multi-Producer / Multi-Consumer blocking queue, linked-list storage,
// UNBOUNDED. Any thread may call any method.
template <class T>
class MpmcBlockingQueue {
    struct Node {
        std::optional<T>      value;   // empty on the dummy node
        std::unique_ptr<Node> next;
    };

    mutable std::mutex      mtx_;
    std::condition_variable not_empty_;     // consumers wait here
    std::unique_ptr<Node>   head_;          // owns dummy front
    Node*                   tail_ = nullptr;
    bool                    closed_ = false;

public:
    MpmcBlockingQueue()
        : head_(std::make_unique<Node>()), tail_(head_.get()) {}

    MpmcBlockingQueue(const MpmcBlockingQueue&)            = delete;
    MpmcBlockingQueue& operator=(const MpmcBlockingQueue&) = delete;

    // Any producer. Unbounded -> never blocks waiting for space.
    // Throws std::runtime_error if pushed after close() (your policy may vary).
    void push(T value) {
        auto node = std::make_unique<Node>();      // allocate OUTSIDE the lock
        Node* new_tail = node.get();
        {
            std::lock_guard<std::mutex> lk(mtx_);
            if (closed_)
                throw std::runtime_error("push on closed queue");
            tail_->value = std::move(value);         // fill current dummy
            tail_->next  = std::move(node);          // append fresh dummy
            tail_        = new_tail;
        }
        not_empty_.notify_one();   // exactly one consumer can take this item
    }

    // Any consumer. Blocks until an item is available OR the queue is closed.
    // Returns nullopt iff the queue is closed AND fully drained.
    std::optional<T> pop() {
        std::unique_lock<std::mutex> lk(mtx_);
        not_empty_.wait(lk, [this] { return head_.get() != tail_ || closed_; });
        if (head_.get() == tail_)        // closed + empty
            return std::nullopt;
        return pop_front_locked();       // we hold the lock; safe to mutate list
    }

    // Any consumer. Never blocks.
    std::optional<T> try_pop() {
        std::lock_guard<std::mutex> lk(mtx_);
        if (head_.get() == tail_) return std::nullopt;
        return pop_front_locked();
    }

    // Shutdown: wake ALL waiters so each observes closed_ and unblocks.
    void close() {
        {
            std::lock_guard<std::mutex> lk(mtx_);
            closed_ = true;
        }
        not_empty_.notify_all();   // notify_one would strand all-but-one consumer
    }

    bool empty() const {
        std::lock_guard<std::mutex> lk(mtx_);
        return head_.get() == tail_;
    }

private:
    // PRECONDITION: caller holds mtx_ and head_ != tail_ (non-empty).
    std::optional<T> pop_front_locked() {
        std::optional<T> result = std::move(head_->value);
        head_ = std::move(head_->next);   // old front freed via RAII here
        return result;
    }
};
```

### The bounded variant — backpressure with a second CV

The single most useful evolution. Add a capacity, a count, and a second
condition variable `not_full_`. Now `push` *also* blocks (when full), and `pop`
must signal a freed slot.

```cpp
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <queue>
#include <utility>

template <class T>
class BoundedMpmcBlockingQueue {
    mutable std::mutex      mtx_;
    std::condition_variable not_empty_;   // consumers wait when queue is empty
    std::condition_variable not_full_;    // producers wait when queue is full
    std::queue<T>           q_;           // any FIFO container; list-backed here
    const std::size_t       cap_;
    bool                    closed_ = false;

public:
    explicit BoundedMpmcBlockingQueue(std::size_t capacity) : cap_(capacity) {}

    // Returns false if the queue was closed before we could enqueue.
    bool push(T value) {
        std::unique_lock<std::mutex> lk(mtx_);
        // Block while full AND open. Wake on a freed slot or on close().
        not_full_.wait(lk, [this] { return q_.size() < cap_ || closed_; });
        if (closed_) return false;
        q_.push(std::move(value));
        lk.unlock();                 // unlock BEFORE notify (avoid wake-then-block)
        not_empty_.notify_one();     // one consumer can take it
        return true;
    }

    std::optional<T> pop() {
        std::unique_lock<std::mutex> lk(mtx_);
        not_empty_.wait(lk, [this] { return !q_.empty() || closed_; });
        if (q_.empty()) return std::nullopt;   // closed + drained
        std::optional<T> v = std::move(q_.front());
        q_.pop();
        lk.unlock();
        not_full_.notify_one();      // one producer can now fit
        return v;
    }

    void close() {
        {
            std::lock_guard<std::mutex> lk(mtx_);
            closed_ = true;
        }
        not_empty_.notify_all();     // wake all consumers
        not_full_.notify_all();      // AND all producers blocked on full
    }
};
```

### Why two condition variables, not one

You *could* share a single CV and `notify_all` on every state change, but that
forces every producer and consumer to wake and re-check on every operation — the
thundering herd, every time. Two CVs let you wake *only* the side that can make
progress: a `push` wakes a consumer (`not_empty_`), a `pop` wakes a producer
(`not_full_`). Targeted wakeups are the whole point.

> **Subtle correctness note:** if you *do* share one CV with two predicates, you
> **must** use `notify_all` — `notify_one` might wake a thread whose predicate
> is still false (e.g. wake a producer when you meant a consumer), and it
> immediately re-sleeps while the thread that *could* proceed never woke. This
> is the classic "lost wakeup with `notify_one` + shared CV" bug. Two CVs make
> it impossible.

## Low-latency optimizations and reality check

- **The single mutex is the ceiling.** Under genuine MPMC contention every op
  serialises and you pay a futex sleep/wake (microseconds) whenever a thread
  actually blocks. This queue belongs **off** the critical path. On the hot path
  use SPSC lock-free per producer-consumer pair, or a bounded lock-free MPMC.
- **Two-lock Michael & Scott queue.** Separate `head_mutex` (consumers) and
  `tail_mutex` (producers) so a producer and a consumer don't contend. The
  dummy node is what makes this safe — the empty case is the only place the two
  ends interact. This roughly doubles throughput for balanced producer/consumer
  load with no atomics gymnastics. Great "next step" answer.
- **Allocation off the lock.** `push` allocates the node *before* taking the
  mutex (shown above). Recycle nodes via a freelist on the hot-ish path.
- **`notify` outside the lock.** Reduces the window where a woken thread blocks
  on the mutex you still hold.
- **False sharing.** Pad `head_`/consumer state and `tail_`/producer state apart
  using `alignas(std::hardware_destructive_interference_size)` if you split to
  two locks, so the two locks don't sit on the same cache line and ping-pong.

## Follow-up variations interviewers ask

- **"`notify_one` or `notify_all` — and when does each break?"** Covered above;
  be crisp: `notify_one` per single item, `notify_all` at shutdown / shared-CV.
- **"How do you shut this down cleanly so all consumers join?"** `close()` sets
  `closed_` and `notify_all`s *every* CV. `pop` returns `nullopt` once drained.
  Producers see `closed_` and stop (`push` returns false / throws).
- **"Drain-on-close vs discard-on-close?"** Our `pop` keeps returning queued
  items until empty (drain). The alternative is to discard pending items
  immediately — name the choice and pick one deliberately.
- **"Make `pop` time out."** Use `wait_for`/`wait_until` with the same predicate;
  return `nullopt` on timeout.
- **"Now make it lock-free."** Michael & Scott two-lock → fully lock-free M&S
  queue → and then the *real* problem appears: **safe memory reclamation** of
  popped nodes (hazard pointers, epoch/RCU). For bounded MPMC, the Vyukov
  bounded queue (array + per-slot sequence numbers) sidesteps reclamation
  entirely — see the array-based MPSC/MPMC lessons.
- **"Spurious wakeups?"** Predicate form of `wait`, as always.

## Key takeaways

1. A **single mutex + condition variable(s)** makes an MPMC queue correct
   trivially; the mutex is also the scalability ceiling — keep this off the hot
   path.
2. **`notify_one` for a single item, `notify_all` at shutdown.** Waking one
   consumer per `push` avoids the **thundering herd**; waking *all* at `close()`
   ensures every waiter observes `closed_` and unblocks.
3. **Bounded queues give backpressure**; unbounded linked lists can grow without
   limit under a slow consumer. Choose deliberately and say why.
4. The **bounded** variant needs **two CVs** (`not_empty_`, `not_full_`) so you
   wake only the side that can progress.
5. **Clean shutdown is the hard part**: `close()` must wake every waiter on every
   CV, and `pop` must report drained-and-closed via `nullopt`.
6. The **two-lock Michael & Scott** queue (separate head/tail mutexes) is the
   natural scalability upgrade before going fully lock-free, where node
   reclamation becomes the real difficulty.

## Self-check

1. You `notify_one()` inside `close()`. Three consumers are blocked in `pop()`.
   What happens, and how does the program misbehave at shutdown?
2. In the bounded queue, why must a shared single CV be paired with
   `notify_all`, while two CVs can each use `notify_one`?
3. Explain the thundering herd. Which line of code prevents it on the steady-state
   `push` path?
4. Why does the dummy node make the *two-lock* Michael & Scott queue feasible at
   all?
5. A teammate makes the queue unbounded "for simplicity." Under what production
   scenario does that decision take down the process, and what symptom do you see
   first?
6. Where do you allocate the new node in `push`, and where do you call `notify` —
   relative to the lock — and why each?

## Further reading

- Anthony Williams, *C++ Concurrency in Action*, 2nd ed., Ch. 6–7 — lock-based
  and then lock-free concurrent queues, including the dummy-node design used here.
- Maged Michael & Michael Scott, ["Simple, Fast, and Practical Non-Blocking and Blocking Concurrent Queue Algorithms"](https://www.cs.rochester.edu/~scott/papers/1996_PODC_queues.pdf) (PODC 1996) — the **two-lock** blocking queue and the lock-free queue, in one paper.
- [`std::condition_variable::notify_all` / `notify_one` — cppreference](https://en.cppreference.com/w/cpp/thread/condition_variable) — the contract you must reason from.
- Preshing, ["Locks Aren't Slow; Lock Contention Is"](https://preshing.com/20111118/locks-arent-slow-lock-contention-is/) — when the single mutex actually becomes the bottleneck.
- Dmitry Vyukov, ["Bounded MPMC queue"](https://www.1024cores.net/home/lock-free-algorithms/queues/bounded-mpmc-queue) — the lock-free destination once the mutex ceiling bites; read before the array-based lessons.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — padding the two locks apart.

## Videos

- Fedor Pikus — **"Live Lock-Free or Deadlock (Practical Lock-free Programming)"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+live+lock-free+or+deadlock)) — why mutex queues are the baseline and where they stop scaling.
- Anthony Williams — **"Concurrency in C++: condition variables done right"** ([search](https://www.youtube.com/results?search_query=Anthony+Williams+condition+variables+C%2B%2B+queue)) — `notify_one`/`notify_all` and shutdown.
