# Linked List based Queue

> **Why this matters for low-latency C++:** A queue is the single most common
> hand-off structure in a trading system — between a feed-handler thread and a
> strategy, between strategy and order gateway, inside an event loop. The
> linked-list FIFO is the textbook starting point and the structure every
> interviewer expects you to be able to write blind in 90 seconds. But it is
> also a *cautionary tale*: it has the best Big-O and nearly the worst real
> latency, because every operation touches the allocator and chases a pointer
> into cold memory. Knowing *why* is the whole point.

All code in this lesson is **C++17** (it compiles clean under C++17/20/23). We
build the textbook version first, then dissect exactly why an HFT engineer
reaches for an array instead — which sets up the next four lessons.

## Problem statement

Implement a **FIFO queue** supporting:

- `enqueue(x)` — add `x` to the back.
- `dequeue()` — remove and return the front element.
- `front()` — peek at the front without removing.
- `empty()` / `size()`.

All operations must be **O(1)** worst-case (not amortized). Use a singly linked
list of nodes with explicit `head` and `tail` pointers.

## Clarifying constraints (the questions to ask out loud)

A senior candidate front-loads the assumptions; they change the code materially:

- **Single-threaded?** Yes for this lesson. The MPSC/SPSC lock-free versions are
  a separate, much harder topic. Conflating them is a classic interview trap.
- **Element type?** Generic `template <class T>`. Be ready to discuss move-only
  types (`std::unique_ptr`), large payloads, and trivially-copyable PODs.
- **Ownership / value semantics?** The queue *owns* its elements. We store `T`
  by value inside each node, so destruction must free the whole chain.
- **What happens on `dequeue()` of an empty queue?** Undefined behaviour like
  `std::queue`, or throw? We'll make it a precondition (UB) and return by value,
  matching the STL adapter and avoiding an exception in the hot path.
- **Bounded or unbounded?** Unbounded — it grows until the allocator says no.
  That unboundedness is itself a liability in a latency system (see below).

## Approach: head + tail pointers

The only trick worth knowing is *why we keep a `tail` pointer*.

- A singly linked list with only a `head` gives O(1) removal at the head but
  O(n) insertion at the tail (you'd walk the whole list). That's a stack-shaped
  list, useless for FIFO.
- Add a `tail` pointer and **enqueue at the tail, dequeue at the head**. Both
  ends are now O(1). The directionality matches a singly linked list perfectly:
  we only ever *follow* `next`, never need a `prev`.

```text
        head                              tail
         |                                 |
         v                                 v
       +-----+    +-----+    +-----+    +-----+
       |  A  |--->|  B  |--->|  C  |--->|  D  |--->nullptr
       +-----+    +-----+    +-----+    +-----+
        front                             back
   dequeue() pops here          enqueue() pushes here
```

Edge case to get right: when the queue becomes empty (last `dequeue`) or goes
from empty to one element (first `enqueue`), `head` and `tail` must be kept
consistent. Getting that wrong is the #1 bug in this problem.

## Complexity

| Operation | Time | Space (extra per element) |
|-----------|:----:|:-------------------------:|
| `enqueue` | O(1) | one node: `sizeof(T)` + one pointer + allocator overhead |
| `dequeue` | O(1) | — |
| `front`   | O(1) | — |
| `empty`/`size` | O(1) | — |

Big-O is perfect. The hidden constants — a heap allocation per `enqueue`, a
free per `dequeue`, and a pointer dereference into unpredictable memory on every
access — are what kill it in practice. Hold that thought.

## Reference implementation

```cpp
// C++17. A single-threaded FIFO queue backed by a singly linked list.
#include <cstddef>
#include <memory>
#include <utility>

template <class T>
class LinkedQueue {
    struct Node {
        T            value;
        Node*        next = nullptr;
        // Perfect-forward the element straight into the node — no extra copy,
        // and this supports emplace-style construction of T in place.
        template <class... Args>
        explicit Node(Args&&... args) : value(std::forward<Args>(args)...) {}
    };

    Node*       head_ = nullptr;  // dequeue end (front)
    Node*       tail_ = nullptr;  // enqueue end (back)
    std::size_t size_ = 0;

public:
    LinkedQueue() = default;

    // Rule of five: we own raw Node*, so the compiler-generated copy/move are
    // WRONG (they'd shallow-copy the pointers -> double free). Be explicit.
    LinkedQueue(const LinkedQueue&)            = delete;  // copying a queue is
    LinkedQueue& operator=(const LinkedQueue&) = delete;  // rarely what you want

    LinkedQueue(LinkedQueue&& o) noexcept
        : head_(o.head_), tail_(o.tail_), size_(o.size_) {
        o.head_ = o.tail_ = nullptr;
        o.size_ = 0;
    }
    LinkedQueue& operator=(LinkedQueue&& o) noexcept {
        if (this != &o) {
            clear();
            head_ = o.head_; tail_ = o.tail_; size_ = o.size_;
            o.head_ = o.tail_ = nullptr; o.size_ = 0;
        }
        return *this;
    }

    ~LinkedQueue() { clear(); }

    // O(1). emplace_back-style: construct T from args directly in the node.
    template <class... Args>
    void emplace(Args&&... args) {
        Node* n = new Node(std::forward<Args>(args)...);  // <-- heap alloc!
        if (tail_) tail_->next = n;   // link old back to new node
        else       head_ = n;         // queue was empty: new node is also front
        tail_ = n;                    // new node is always the back
        ++size_;
    }

    void enqueue(const T& v) { emplace(v); }
    void enqueue(T&& v)      { emplace(std::move(v)); }

    // O(1). Precondition: !empty(). Returns the front by value (moved out).
    T dequeue() {
        Node* old = head_;
        T result = std::move(old->value);
        head_ = old->next;            // advance front
        if (head_ == nullptr)         // we just removed the last element:
            tail_ = nullptr;          //   keep tail consistent!
        delete old;                   // <-- heap free!
        --size_;
        return result;                // NRVO / move, no extra copy
    }

    T&       front()       { return head_->value; }  // precondition: !empty()
    const T& front() const { return head_->value; }

    bool        empty() const noexcept { return head_ == nullptr; }
    std::size_t size()  const noexcept { return size_; }

    void clear() noexcept {
        while (head_) {
            Node* nxt = head_->next;
            delete head_;
            head_ = nxt;
        }
        tail_ = nullptr;
        size_ = 0;
    }
};
```

Things this implementation gets *right* that interviewers probe for:

- **The empty/one-element transitions.** `enqueue` checks `tail_` to decide
  whether it's also setting `head_`; `dequeue` nulls `tail_` when `head_`
  becomes null. Miss either and you get a dangling `tail_` and a crash on the
  next `enqueue`.
- **Rule of five.** The class owns raw pointers, so the default copy/move are
  wrong. Delete copy, hand-write move, hand-write the destructor. (If you used
  `std::unique_ptr<Node>` for `next` you'd get move/destroy for free — but then
  destruction recurses and can blow the stack on a long list; see follow-ups.)
- **Move semantics on the payload.** `emplace` forwards into the node;
  `dequeue` moves the value out. No gratuitous `T` copies.
- **`noexcept` where it's true.** Move ops and `clear` don't throw, which lets
  callers (and the move-assignment) reason about exception safety.

## Why an HFT engineer winces at this

The Big-O is flawless and yet this is the structure you are *least* likely to
ship in a hot path. Three reasons, in order of how much they hurt:

### 1. A heap allocation on every `enqueue`, a free on every `dequeue`

`new`/`delete` are the elephant. A general-purpose allocator call is *hundreds*
of cycles in the bad case (lock contention under threads, free-list traversal,
occasional `mmap`/`brk`), and even the fast path is dozens. Worse, it is
**non-deterministic**: tail latency spikes when the allocator has to do real
work, and tail latency is exactly what an HFT system is judged on. You cannot
have an unpredictable `malloc` on the path between a market-data tick and an
order.

```text
enqueue() cost breakdown (rough, cycles):
  link the node                 ~1-3
  operator new (fast path)      ~30-80      <-- dominates
  operator new (slow/contended) hundreds++  <-- tail latency disaster
```

### 2. Cache misses and pointer chasing

Each node is a separate allocation, so the list is **scattered across the
heap**. Walking it (or even just `dequeue`-ing front after front) is a sequence
of dependent loads to addresses the hardware prefetcher cannot predict. Every
`->next` that misses L1/L2 is tens to a few hundred cycles of stall, and they
*serialize* — the CPU can't fetch node B until it has read node A's `next`
pointer. A contiguous array, by contrast, streams in cache lines ahead of you.

```text
linked list in memory (nodes scattered, each ->next is a guess):

  heap: [..B..] ......... [..D..] ... [..A..] ...... [..C..] ...
                                       ^head            tail^
  dequeue order A->B->C->D jumps all over the address space.

array/ring buffer (contiguous, prefetcher loves it):

  [ A | B | C | D | . | . | . | . ]   one cache line holds several elements
```

### 3. Memory overhead and false economy

Each node carries a `next` pointer (8 bytes) **plus** the allocator's per-block
header and rounding (often 16+ bytes). For a queue of `int`, you might pay 32
bytes to store 4 — an 8x blow-up that also means fewer elements per cache line.

> **The senior summary:** the linked-list queue trades *one* good property
> (true O(1) with no resize copies, unbounded) for *three* bad ones (per-op
> allocation, cache-hostile layout, pointer overhead). In an interview, state
> the Big-O, then immediately volunteer these downsides — that's the signal
> you've actually written latency-sensitive code.

## Low-latency optimizations (and where they run out)

You can claw back a lot *without* changing the data structure:

- **Kill the per-op allocator** with a free-list / object pool: recycle popped
  nodes instead of `delete`-ing them, preallocate a slab up front. This removes
  the #1 cost and makes latency deterministic. It's important enough to be the
  *next entire lesson* — the **Memory-Pooled Linked List Queue**.
- **`reserve`-style pre-touch:** allocate and fault-in the pool during startup
  so the first hot-path `enqueue` doesn't take a page fault.
- **Custom allocator** (`std::pmr::monotonic_buffer_resource` or a slab
  allocator) instead of global `new` — same idea, packaged.

What you *cannot* fix while staying a linked list is the **cache layout**: even
a pooled list, once nodes have been recycled in scattered order, chases pointers
across the pool. That is the structural reason the array-based ring buffer
(lesson 3) usually wins outright for bounded queues.

> Rule of thumb on the desk: **if the queue is bounded (and it almost always
> can be), use a ring buffer. Reach for a linked list only when you genuinely
> need unbounded growth with no resize hiccup, and even then, pool the nodes.**

## Follow-up variations interviewers ask

- **"Make it a deque (push/pop both ends)."** A singly linked list can't pop the
  *back* in O(1) (no `prev`). Switch to a **doubly linked list** (extra `prev`
  pointer, more memory, same allocation problem) — or, better, a segmented deque
  (lesson 5).
- **"What if `T`'s move constructor throws?"** `dequeue` does
  `T result = std::move(old->value);` *before* `delete old;`, so if the move
  throws we haven't yet unlinked or freed — the queue is unchanged and the node
  isn't leaked. Good. But the standard answer is: require `noexcept`-movable `T`
  for hot-path use.
- **"Why not `unique_ptr<Node> next`?"** It gives you move/destroy for free and
  is exception-safe, but the destructor **recurses** down the chain — a long
  queue (millions of nodes) overflows the stack. Either keep raw pointers with a
  manual `clear()` loop (as above) or write an iterative destructor.
- **"Make `size()` O(1)."** Already done — we cache `size_`. (`std::list::size`
  was famously O(n) before C++11 for exactly this reason; the standard changed
  to require O(1).)
- **"Single-producer/single-consumer lock-free version?"** Different universe:
  you need atomics, careful memory ordering, and usually a *ring buffer* anyway.
  See the lock-free queue lessons; don't bluff it here.

## Key takeaways

1. **Head + tail pointers** make a singly linked list a true O(1) FIFO; the only
   subtlety is keeping `head`/`tail` consistent at the empty↔one-element
   boundary.
2. **Own raw pointers ⇒ rule of five.** Delete copy, hand-write move and an
   iterative destructor; don't let the compiler shallow-copy node pointers.
3. The fatal flaw is **a heap allocation per `enqueue` and free per `dequeue`** —
   slow on average, and worse, *non-deterministic* (tail-latency poison for HFT).
4. **Cache-hostile by construction:** scattered nodes mean dependent, serialized
   pointer-chasing loads the prefetcher can't help with, plus per-node pointer +
   allocator overhead.
5. **Pooling the nodes fixes the allocator** but not the cache layout; for
   bounded queues a contiguous **ring buffer** beats it on every latency metric.

## Self-check

1. Why does a singly linked list need a `tail` pointer for an O(1) FIFO, but a
   stack (LIFO) needs only `head`?
2. Walk through `enqueue` then `dequeue` on an *empty* queue. Which lines keep
   `head_` and `tail_` consistent, and what breaks if you omit the
   `if (head_ == nullptr) tail_ = nullptr;`?
3. Name the three distinct real-world costs that make this structure a poor hot-path choice, ranked by impact.
4. Why is replacing `next` with `std::unique_ptr<Node>` a trap for very long queues?
5. In `dequeue`, why do we move the value out *before* `delete old`, and how does that help if `T`'s move throws?
6. You profiled and `operator new` is your top cost. Name two changes that keep the linked list but remove the per-op allocation.

## Further reading

- [`std::queue` — cppreference](https://en.cppreference.com/w/cpp/container/queue) — the standard FIFO *adapter* (defaults to `std::deque`, not a linked list — note why).
- [`std::list` — cppreference](https://en.cppreference.com/w/cpp/container/list) — the standard doubly-linked list, and the C++11 O(1) `size()` change.
- [`std::forward_list` — cppreference](https://en.cppreference.com/w/cpp/container/forward_list) — the singly-linked node model, library-grade.
- Bjarne Stroustrup, ["Are lists evil?"](https://www.stroustrup.com/bs_faq.html#list) and his vector-vs-list benchmarks — the canonical "linked lists lose on modern hardware" argument.
- [What Every Programmer Should Know About Memory (Drepper)](https://people.freebsd.org/~lstewart/articles/cpumemory.pdf) — §3 on caches; why pointer-chasing is so expensive.
- [`std::pmr::monotonic_buffer_resource` — cppreference](https://en.cppreference.com/w/cpp/memory/monotonic_buffer_resource) — the standard tool for killing per-node allocation.

## Videos

- Bjarne Stroustrup — **"Why you should avoid Linked Lists"** ([search](https://www.youtube.com/results?search_query=Bjarne+Stroustrup+why+you+should+avoid+linked+lists)) — the famous vector-beats-list-even-for-insertion demo.
- CppCon — Chandler Carruth, **"Efficiency with Algorithms, Performance with Data Structures"** ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures)) — cache layout vs. asymptotics.
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why non-deterministic allocation is unacceptable in HFT.
