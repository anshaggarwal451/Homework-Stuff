# Linked List Based SPSC Blocking Queue

> **Why a quant dev must own this:** The single-producer/single-consumer
> hand-off is the *atom* of a trading pipeline — feed handler → strategy,
> strategy → order gateway, anything → logger. The blocking, mutex-backed
> version is the one you reach for first because it's *correct by construction*
> and lets a starved consumer sleep instead of burning a core. Knowing exactly
> where the mutex and condition variable go — and why the lock-free version
> later replaces them — is a bread-and-butter HFT interview question.

## Problem statement

Implement a thread-safe queue with **exactly one producer thread and one
consumer thread**. Storage is a **singly linked list** (unbounded). The API:

```cpp
void push(T value);   // producer: enqueue, never fails (unbounded)
T    pop();           // consumer: dequeue; BLOCK if empty until an item arrives
```

"Blocking" is the defining word: when the consumer calls `pop()` on an empty
queue it must **sleep** (yield the CPU) and be woken when the producer pushes —
no busy-spinning.

We target **C++17** (the code also compiles as C++20; one C++17-vs-C++20 nuance
on cache-line size is noted below).

## Clarifying constraints and assumptions

Good candidates surface these *before* writing code:

- **SPSC, strictly.** Exactly one thread ever calls `push`, exactly one ever
  calls `pop`. This assumption is load-bearing — it's why a lock-free variant is
  even possible, and it lets the blocking version get away with a single mutex.
- **Unbounded.** A linked list grows on demand, so `push` never blocks. (That is
  also its danger — a fast producer with a slow consumer leaks memory without
  bound. Contrast with the array-based bounded queue, which applies
  *backpressure*.)
- **Ownership / move semantics.** `push` should *move* the value in;
  `pop` should *move* it out. We don't want to copy a fat `Order` struct twice.
- **Shutdown.** A real queue needs a way to wake a blocked consumer at exit
  (`close()`), or the consumer deadlocks on shutdown. We include it.
- **Exception safety.** If `T`'s move throws, the queue must stay consistent.

## Approaches and tradeoffs

There are two axes: **how you store** (linked list vs array) and **how you
synchronise** (blocking mutex+CV vs lock-free atomics). This lesson is the
linked-list + blocking corner.

```text
                 blocking (mutex + cv)        lock-free (atomics)
 linked list  ┌────────────────────────┐   ┌────────────────────────┐
              │  THIS LESSON            │   │ Michael–Scott style;    │
              │  simple, correct,       │   │ needs node reclamation  │
              │  consumer sleeps        │   │ (hazard ptrs / RCU)     │
              └────────────────────────┘   └────────────────────────┘
 array/ring   ┌────────────────────────┐   ┌────────────────────────┐
              │ bounded, backpressure,  │   │ rigtorp SPSCQueue —     │
              │ two CVs                 │   │ the fast path           │
              └────────────────────────┘   └────────────────────────┘
```

**Blocking** — one `std::mutex` guards the list; a `std::condition_variable`
lets `pop` wait when empty. Pros: trivially correct, consumer sleeps under the
OS scheduler (no wasted cycles), naturally handles unbounded growth. Cons: every
op takes the lock; under contention you pay a syscall (`futex`) on the
sleep/wake path, and the wake-up latency is microseconds — an eternity in HFT.

**Lock-free** — head/tail atomics, no mutex (covered in the *SPSC Lock-Free
Queue* lesson). Pros: no syscalls on the hot path, sub-100ns hand-off. Cons: a
*lock-free* queue cannot block — an empty `pop` must spin or return "empty", so
*you* own the back-off policy; and reclaiming popped nodes in a linked-list
lock-free design is genuinely hard (the ABA / memory-reclamation problem).

> **The senior framing:** *Blocking gives you the OS scheduler for free;
> lock-free gives you latency but makes waiting and memory reclamation your
> problem.* In HFT you start blocking, profile, and only go lock-free on the
> proven hot path.

## Complexity

- `push`: **O(1)** — one node allocation + a couple of pointer writes.
- `pop`: **O(1)** work, but may **block** (sleep) for an unbounded time waiting
  for data. That wait is not "complexity", it's *liveness*.
- Space: **O(n)** in the number of queued items, plus one dummy/sentinel node.

**Progress guarantee:** *blocking* — it is **not** lock-free. A thread holding
the mutex that is descheduled stalls the other. That is the accepted trade for
simplicity here.

## A complete, annotated C++17 reference implementation

We use the **dummy-node** (sentinel) trick from Michael & Scott: the list always
holds one extra node ahead of the real data. This means `head` and `tail` never
alias even when the queue has one element, which keeps the lock-free cousin's
invariants identical — a nice consistency across lessons.

```cpp
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

// Single-Producer / Single-Consumer blocking queue, linked-list storage.
// Exactly one thread may call push(); exactly one may call pop()/try_pop().
template <class T>
class SpscBlockingQueue {
    struct Node {
        // Stored value is optional so the sentinel/dummy node holds nothing.
        std::optional<T>      value;
        std::unique_ptr<Node> next;   // owns the rest of the list
    };

    std::mutex              mtx_;
    std::condition_variable not_empty_;     // signalled when an item is pushed
    std::unique_ptr<Node>   head_;          // owns the (dummy) front node
    Node*                   tail_ = nullptr;// raw ptr to last node (back)
    bool                    closed_ = false;// set by close() to wake consumer

public:
    SpscBlockingQueue()
        : head_(std::make_unique<Node>()), tail_(head_.get()) {
        // Start with a single dummy node: head_ == tail_ == dummy, queue empty.
    }

    // Non-copyable, non-movable: it owns synchronisation primitives.
    SpscBlockingQueue(const SpscBlockingQueue&)            = delete;
    SpscBlockingQueue& operator=(const SpscBlockingQueue&) = delete;

    // PRODUCER ONLY. Never blocks (unbounded). Strong exception safety:
    // we build the node before taking the lock, so a throwing move/alloc
    // leaves the queue untouched.
    void push(T value) {
        auto node = std::make_unique<Node>();       // new dummy-to-be
        Node* new_tail = node.get();
        {
            std::lock_guard<std::mutex> lk(mtx_);
            // Fill the CURRENT tail (old dummy) with the value, then append
            // the fresh dummy. This is the M&S sentinel maneuver.
            tail_->value = std::move(value);          // may throw -> caller's T
            tail_->next  = std::move(node);            // link new dummy
            tail_        = new_tail;                    // advance tail
        }
        not_empty_.notify_one();   // wake the (single) consumer if it sleeps
    }

    // CONSUMER ONLY. Blocks until an item is available OR the queue is closed.
    // Returns std::nullopt only if the queue is closed AND drained.
    std::optional<T> pop() {
        std::unique_lock<std::mutex> lk(mtx_);
        // Wait predicate guards against spurious wakeups: proceed only when
        // there is real data (head_ != tail_) or we've been told to close.
        not_empty_.wait(lk, [this] { return head_.get() != tail_ || closed_; });

        if (head_.get() == tail_)   // woken solely by close(): drained + closed
            return std::nullopt;

        // Detach the front data node. head_ currently owns the dummy whose
        // 'value' was filled by push(); that filled value lives in *head_.
        std::optional<T> result = std::move(head_->value);
        head_ = std::move(head_->next);   // old front node freed here (RAII)
        return result;
    }

    // CONSUMER ONLY. Non-blocking: returns nullopt immediately if empty.
    std::optional<T> try_pop() {
        std::lock_guard<std::mutex> lk(mtx_);
        if (head_.get() == tail_) return std::nullopt;
        std::optional<T> result = std::move(head_->value);
        head_ = std::move(head_->next);
        return result;
    }

    // Wake a blocked consumer at shutdown. After this, pop() drains then
    // returns nullopt instead of blocking forever.
    void close() {
        {
            std::lock_guard<std::mutex> lk(mtx_);
            closed_ = true;
        }
        not_empty_.notify_one();
    }
};
```

### Walk-through of the tricky parts

- **The dummy node.** An empty queue is `head_ == tail_`, both pointing at one
  dummy. `push` writes the value into the *current* tail (turning the old dummy
  into a data node) and appends a *new* dummy. `pop` reads from `head_` and
  advances. This guarantees producer and consumer never touch the same node:
  the producer only ever writes `tail_`'s contents, the consumer only ever reads
  `head_`. (That separation is exactly what the lock-free SPSC version exploits
  to drop the lock entirely.)
- **`notify_one` *outside* the lock.** A classic micro-optimization: signalling
  while still holding `mtx_` can cause the woken consumer to immediately block
  again on the mutex you still hold (the "hurry up and wait" anti-pattern).
  Releasing first avoids that. It's safe here because the CV is associated with
  this mutex and `wait` re-checks its predicate.
- **The wait predicate is mandatory.** `not_empty_.wait(lk, pred)` loops until
  `pred()` is true, which defeats **spurious wakeups** (a CV may return for no
  reason) and **lost wakeups** (a `notify` that arrives before the consumer
  waits). Never write a bare `wait(lk)` for a queue.
- **`std::optional<T>` as the slot.** Lets the sentinel hold "no value" without
  requiring `T` to be default-constructible, and gives a clean `nullopt` return
  on a closed/empty queue.

## Low-latency optimizations

Even in the blocking design there's real money on the table:

- **Allocation is the enemy.** `make_unique<Node>` per `push` hits the global
  allocator — a lock and possibly a syscall, and a cache miss on a cold node.
  In a hot path, recycle nodes through a **freelist** (pop returns the node to a
  per-queue pool instead of freeing it), or use a slab/arena allocator. Better
  still, for a bounded hot path, switch to the array ring buffer where there is
  *zero* per-op allocation.
- **Hold the lock for the absolute minimum.** Notice `push` allocates the new
  node *before* taking the lock, and `notify_one` fires *after* releasing it.
  The critical section is three pointer writes.
- **False sharing.** If you keep producer-only and consumer-only state in
  separate fields (e.g. when you evolve toward lock-free), pad them onto
  different cache lines so the producer's writes don't invalidate the consumer's
  cache line:

```cpp
#include <new>      // std::hardware_destructive_interference_size (C++17)

// C++17 exposes the constant, but some libstdc++ versions warn about ABI
// instability; 64 is the safe x86-64 fallback.
#if defined(__cpp_lib_hardware_interference_size)
inline constexpr std::size_t kCacheLine =
    std::hardware_destructive_interference_size;
#else
inline constexpr std::size_t kCacheLine = 64;
#endif

struct alignas(kCacheLine) ProducerSide { /* tail-only fields */ };
struct alignas(kCacheLine) ConsumerSide { /* head-only fields */ };
```

  In the *mutex* version this matters less (the mutex serialises everything),
  but it's the right instinct and it's exactly what the lock-free SPSC lesson
  leans on.
- **Don't `notify` when no one is waiting.** Under a busy producer the consumer
  may rarely sleep; a needless `notify_one` is a cheap atomic load but not free.
  An advanced trick tracks "is the consumer parked?" to skip the notify — but
  that's where you're really telling yourself "go lock-free."

## Follow-up variations interviewers ask

- **"Make it bounded."** Add a `capacity_` and a second CV `not_full_`; `push`
  waits on `not_full_` when at capacity. That's the *array-based MPMC blocking*
  lesson's core, and the conversation about **backpressure** vs unbounded
  memory growth is the real point.
- **"Now allow many producers/consumers."** The single mutex already makes it
  MPMC-correct — but `push`'s "no contention" assumption breaks, and you need
  to think about which waiter `notify_one` wakes. That's the *linked-list MPMC
  blocking* lesson.
- **"Remove the lock."** Leads to the SPSC ring-buffer (rigtorp). Be ready to
  explain why a *linked-list* lock-free SPSC additionally needs safe node
  reclamation, whereas the array version sidesteps it.
- **"What if `T`'s move can throw?"** We build the node before locking, so a
  throw in `push` doesn't corrupt state. In `pop`, the move out happens under
  the lock; if it throws, the item is lost but the list stays consistent — be
  ready to discuss `noexcept(T)` guarantees.
- **"Spurious wakeups — prove your code survives them."** Point at the predicate
  form of `wait`.

## Key takeaways

1. **One mutex + one condition variable** is the canonical blocking SPSC queue;
   the CV lets the consumer *sleep* instead of spinning when empty.
2. Use the **dummy/sentinel node** so producer and consumer never touch the same
   node — `head_` for reads, `tail_` for writes.
3. Always wait with a **predicate** (`wait(lk, pred)`) to defeat spurious and
   lost wakeups; never a bare `wait(lk)`.
4. Build nodes **before** locking and `notify` **after** unlocking to keep the
   critical section minimal.
5. Linked-list = **unbounded** = no backpressure: a fast producer can exhaust
   memory. Bound it (second CV) when the consumer can fall behind.
6. **Blocking trades latency for simplicity.** It is not lock-free; you go
   lock-free only on a profiled hot path, and then *you* own waiting and node
   reclamation.

## Self-check

1. Why does the dummy node guarantee the producer and consumer never write the
   same `Node`? What breaks if you remove it and the queue holds one element?
2. What two distinct failure modes does the `wait(lk, pred)` predicate protect
   against, and how does each occur?
3. Where exactly do you call `notify_one`, relative to releasing the mutex, and
   why?
4. This queue is unbounded. Describe the production failure that causes and the
   one-line API change that fixes it.
5. A candidate writes `tail_->next = std::make_unique<Node>();` *inside* the
   lock instead of before it. Is that wrong? What's the cost?
6. Why can a *lock-free* version of this exact (linked-list) queue not simply
   `delete` a popped node, and what does the array-based version do instead?

## Further reading

- Anthony Williams, *C++ Concurrency in Action*, 2nd ed., Ch. 6 (designing
  lock-based concurrent data structures) — the thread-safe queue with a dummy
  node is built up step by step here; the canonical reference.
- [`std::condition_variable` — cppreference](https://en.cppreference.com/w/cpp/thread/condition_variable) — note the predicate overload of `wait`.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — false-sharing padding, C++17.
- Maged Michael & Michael Scott, ["Simple, Fast, and Practical Non-Blocking and Blocking Concurrent Queue Algorithms"](https://www.cs.rochester.edu/~scott/papers/1996_PODC_queues.pdf) (PODC 1996) — the dummy-node lock-based queue *and* its lock-free cousin in one paper.
- Erik Rigtorp, ["Optimizing a ring buffer for throughput"](https://rigtorp.se/ringbuffer/) — start here before the lock-free lesson to see why the blocking version is the baseline you measure against.
- Preshing, ["Locks Aren't Slow; Lock Contention Is"](https://preshing.com/20111118/locks-arent-slow-lock-contention-is/) — calibrates *when* the mutex actually hurts.

## Videos

- Fedor Pikus — **"Live Lock-Free or Deadlock (Practical Lock-free Programming)"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+live+lock-free+or+deadlock)) — frames exactly why you start blocking and earn the right to go lock-free.
- Anthony Williams — **"Concurrency in C++: condition variables and thread-safe queues"** ([search](https://www.youtube.com/results?search_query=Anthony+Williams+concurrency+C%2B%2B+condition+variable+queue)) — condition variables and thread-safe queues done correctly.
