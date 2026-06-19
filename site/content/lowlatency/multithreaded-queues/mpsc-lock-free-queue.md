# MPSC Lock-Free Queue

> **Why a quant dev must own this:** Fan-in is everywhere in trading systems —
> many worker threads logging to one writer, many strategies posting orders to
> one risk gate, many threads handing work to one event loop. The
> multi-producer/single-consumer queue is the cheapest correct way to do it.
> Dmitry Vyukov's intrusive MPSC queue is *the* answer: each producer needs a
> **single atomic exchange** to enqueue, the consumer runs lock-free with no
> contention at all, and there's no allocation in the queue itself. It's a
> favourite hard interview question precisely because of one subtle
> intermediate state most candidates miss.

## Problem statement

Build a **lock-free** queue for **many producer threads and exactly one consumer
thread**. Nodes are **intrusive** — the caller embeds the link field in its own
object, so the queue does no allocation. API:

```cpp
void push(Node* n);   // any producer thread; n is caller-owned, intrusive
Node* pop();          // the single consumer thread; nullptr if "empty"
```

Standard: **C++17** (the atomics are C++11; `hardware_destructive_interference_size`
is C++17). This is Vyukov's **intrusive MPSC node-based queue** from 1024cores.

## Clarifying constraints and assumptions

- **MPSC, strictly.** Any number of producers, but **exactly one** consumer
  thread calls `pop`. That asymmetry is the whole trick: producers only need to
  coordinate with *each other* (one atomic op), and the consumer never contends
  with anyone — so the consumer side uses *no* atomics on the hot path beyond a
  single relaxed/acquire load.
- **Intrusive nodes.** The producer owns the memory of the node it pushes; the
  consumer returns ownership on `pop`. **No allocation, no reclamation problem
  inside the queue** — this neatly dodges the hazard-pointer/RCU headache that
  plagues general lock-free linked lists.
- **Unbounded.** Producers never block or fail; the list grows as needed (the
  memory is the caller's). For a bounded array MPSC, see the next lesson.
- **A sentinel/stub node** is part of the queue's state from construction, so
  the list is never truly empty — this is what makes `push` a clean single
  `exchange`.
- **Ordering matters.** Producers see a *linearization point* at the
  `exchange`; the consumer must use acquire/release to see the `next` link a
  producer published.

## Approach: exchange the tail, link the predecessor

Vyukov's structure keeps a `head` (consumer end) and `tail` (producer end), plus
a permanently-present **stub** node:

```text
 push(n):
   n->next = nullptr                     (relaxed)
   prev = tail.exchange(n)               (this is the linearization point)
   prev->next = n                        (release: publishes n to consumer)

 pop():    (single consumer)
   read head, head->next
   if next != nullptr: advance head, return the freed node's payload
   else: maybe empty, maybe a producer is mid-push -> see "intermediate state"
```

The genius is **`tail.exchange(n)`**: an atomic swap that *simultaneously* makes
`n` the new tail and hands the producer the *previous* tail (`prev`). Each
producer then links itself behind its own predecessor with `prev->next = n`.
Because `exchange` is atomic, producers serialize cleanly at the tail with **one
RMW each — no CAS retry loop**. That's why this queue is so cheap on the
producer side and why it scales: producers never spin against each other.

```text
        head (consumer)                         tail (producer)
          |                                        |
        [stub] -> [A] -> [B] -> [C] -> nullptr     ^
                                       \___________/  tail points at C

  P1 push(D): prev = exchange(D)=C ; then C->next = D
  P2 push(E): prev = exchange(E)=D ; then D->next = E   (ordered by exchange)
```

### The subtle intermediate state (the interview crux)

Here is the part candidates miss. The producer does the swap and the link in
**two separate steps**:

```text
   prev = tail.exchange(n);   // step 1: n is ALREADY the tail
   /* <-- WINDOW: if this producer is preempted here, the list is "broken":
          tail points at n, but prev->next is still nullptr.
          The chain from head does NOT yet reach n. */
   prev->next = n;            // step 2: chain repaired
```

Between step 1 and step 2, **the queue is in a temporarily inconsistent state**:
`tail` already points at the new node, but the node is **not yet reachable** from
`head` because the predecessor's `next` link hasn't been written. If the
consumer's `pop` runs in this window, it will see `head->next == nullptr` even
though the queue is *not* logically empty — there's a node "in flight."

Consequences you must state out loud:

1. **`pop` is not linearizable as "empty vs non-empty" on its own.** A `nullptr`
   return can mean *truly empty* **or** *a producer is mid-push*. The correct
   contract is: `pop` returns `nullptr` to mean **"no node available right
   now"**, and the consumer should treat that as "try again." This is why the
   queue is often described as **lock-free but not wait-free for the consumer**:
   a stalled producer can make `pop` temporarily return nothing even though work
   exists.
2. **Producers are lock-free but a preempted producer blocks visibility** of its
   own (and only its own) item to the consumer — it does **not** block other
   producers (they keep exchanging the tail fine) and does **not** block the
   consumer from draining everything *before* the in-flight node.

> **The senior answer:** *Each producer's `exchange` is the linearization point
> for ordering, but the item only becomes consumer-visible after the second
> store (`prev->next = n`). The gap between them is the famous Vyukov
> intermediate state: `pop` returning `nullptr` does not prove the queue is
> empty — it proves no node is currently linked.*

## Complexity and progress guarantees

- `push`: **O(1)**, exactly **one atomic `exchange`** + two plain stores. No
  retry loop → effectively **wait-free for producers** in the common framing
  (one bounded RMW). Producers never contend on a CAS-retry.
- `pop`: **O(1)** amortized. **Lock-free**, but *not wait-free*: the
  intermediate-state window means a `pop` can fail (return `nullptr`) while a
  producer is mid-push.
- Space: **O(1)** queue overhead (head, tail, one stub). Item memory is the
  caller's (intrusive).
- **No memory reclamation problem inside the queue** — ownership passes back to
  the consumer on `pop`. The caller frees/recycles.

## A complete, annotated C++17 reference implementation

```cpp
#include <atomic>
#include <cstddef>
#include <new>       // hardware_destructive_interference_size (C++17)

#if defined(__cpp_lib_hardware_interference_size)
inline constexpr std::size_t kCacheLine =
    std::hardware_destructive_interference_size;   // 64 on x86-64
#else
inline constexpr std::size_t kCacheLine = 64;
#endif

// Intrusive MPSC node-based queue (Dmitry Vyukov).
// Many producers may call push(); EXACTLY ONE consumer thread may call pop().
// Nodes are caller-owned; embed MpscNode as a base or member of your payload.
struct MpscNode {
    std::atomic<MpscNode*> next{nullptr};   // link, written/read across threads
};

class MpscQueue {
    // tail_: producers swap into it (the hot, contended atomic). Own cache line.
    alignas(kCacheLine) std::atomic<MpscNode*> tail_;
    // head_: consumer-only walk pointer. Own cache line -> no false sharing
    // with the producers hammering tail_.
    alignas(kCacheLine) MpscNode*              head_;
    // The permanent stub keeps the list non-empty so push() is a clean exchange.
    alignas(kCacheLine) MpscNode               stub_;

public:
    MpscQueue() {
        stub_.next.store(nullptr, std::memory_order_relaxed);
        head_ = &stub_;
        tail_.store(&stub_, std::memory_order_relaxed);
    }

    MpscQueue(const MpscQueue&)            = delete;
    MpscQueue& operator=(const MpscQueue&) = delete;

    // ANY PRODUCER. Single atomic exchange + a release store. No retry loop.
    void push(MpscNode* n) {
        // The new node will be the new tail; it has no successor yet.
        n->next.store(nullptr, std::memory_order_relaxed);

        // LINEARIZATION POINT: atomically install n as tail and grab the old
        // tail (our predecessor). acq_rel: we publish n->next==nullptr (release)
        // and observe the predecessor's prior state (acquire).
        MpscNode* prev = tail_.exchange(n, std::memory_order_acq_rel);

        // *** Intermediate state window opens here ***
        // tail_ already == n, but prev->next is still its old value (nullptr if
        // prev was the last node). The chain from head_ does NOT yet reach n.

        // RELEASE store links us behind prev and PUBLISHES n (and everything we
        // wrote into the payload) to the consumer that acquire-loads ->next.
        prev->next.store(n, std::memory_order_release);
        // *** Intermediate state window closes here ***
    }

    // THE SINGLE CONSUMER ONLY. Returns the next dequeued node, or nullptr if
    // none is currently available (queue empty OR a producer is mid-push).
    MpscNode* pop() {
        MpscNode* head = head_;                       // consumer-private
        // acquire: synchronise-with the producer's release store of ->next so
        // that if we see a successor, its payload writes are visible to us.
        MpscNode* next = head->next.load(std::memory_order_acquire);

        if (head == &stub_) {
            // The current head is the stub: skip it once a real node appears.
            if (next == nullptr)
                return nullptr;                       // genuinely no node linked
            head_ = next;                             // drop the stub
            head  = next;
            next  = head->next.load(std::memory_order_acquire);
        }

        if (next != nullptr) {
            // Fast path: a successor is linked, so `head` is fully published.
            head_ = next;                             // advance consumer pointer
            return head;                              // hand ownership back
        }

        // next == nullptr but head != stub: head MIGHT be the last node, OR a
        // producer is mid-push (the intermediate state). Distinguish via tail_.
        MpscNode* tail = tail_.load(std::memory_order_acquire);
        if (head != tail)
            return nullptr;   // a producer is mid-push; node not linked yet -> retry

        // head is the only node. Re-insert the stub so the queue stays
        // non-empty (preserving the push() invariant), then return head.
        push(&stub_);                                 // re-arm the stub
        next = head->next.load(std::memory_order_acquire);
        if (next != nullptr) {
            head_ = next;
            return head;
        }
        return nullptr;   // raced with a new producer; caller retries
    }
};
```

### How the stub keeps `push` branch-free

Because a stub is always present, `tail_` is never null, so `push` is
unconditionally `exchange` + `store` — no "is the queue empty?" special case,
no CAS loop. The cost is paid on the consumer side: the consumer must skip the
stub and, when it drains the last real node, **re-insert** the stub (via
`push(&stub_)`) so the producer invariant holds for the next enqueue. That
re-arm is the messy-looking tail of `pop`, and it's exactly where the
intermediate-state reasoning shows up again.

### Memory ordering, precisely

- Producer: `tail_.exchange(n, acq_rel)` then `prev->next.store(n, release)`.
  The **release** on the `next` store is what publishes the payload; pair it
  with the consumer's **acquire** load of `next`.
- Consumer: every `head->next.load` is **acquire**, so when it observes a linked
  successor it also observes everything the producer wrote into that node before
  the release store. The `head_` walk pointer is consumer-private — no atomics.
- On **x86-64**, the `exchange` is a `lock xchg` (a full barrier, ~15–30 cycles
  uncontended, more under contention); the release/acquire stores and loads are
  plain `mov`. On **AArch64** the exchange is an `ldaxr/stlxr` loop or `swpal`.

## Low-latency optimizations

- **One RMW per push** is already the floor; you cannot beat a single
  `exchange`. The contention cost is the cache line holding `tail_` bouncing
  between producer cores — unavoidable for MPSC, but bounded.
- **Cache-line-pad `tail_`, `head_`, and `stub_` apart.** `tail_` is hammered by
  producers; `head_` is touched only by the consumer. False sharing between them
  would let producer stores stall the consumer. The `alignas(kCacheLine)` above
  separates them.
- **Intrusive = zero allocation.** The big structural win: no node pool, no
  freelist contention, no reclamation scheme. The payload *is* the node.
- **Batch drain.** The consumer can keep calling `pop` in a tight loop to drain
  everything available; amortise per-item overhead by processing in a local
  buffer.
- **`relaxed` for the producer's own `n->next` init** — it's not yet visible to
  anyone, so no ordering is needed until the release store.

## Follow-up variations interviewers ask

- **"Explain the intermediate state."** (The crux — see above.) `pop` returning
  `nullptr` ≠ empty; a producer may be between its `exchange` and its `next`
  store. The consumer must retry/spin.
- **"Is the consumer wait-free?"** No — lock-free. A preempted producer can make
  `pop` return `nullptr` even though logical work exists. Producers are
  effectively wait-free (single bounded RMW).
- **"Why no ABA / reclamation problem?"** Intrusive nodes are caller-owned;
  ownership transfers back on `pop`. The queue never frees, so there's no
  use-after-free to guard with hazard pointers/RCU.
- **"Make it bounded (array-based)."** Replace the linked list with a fixed array
  and per-slot **sequence numbers**; producers `fetch_add` a claim index. That's
  the next lesson and Vyukov's bounded MPMC, narrowed to one consumer.
- **"Add a blocking `pop`."** Layer an eventcount / futex / CV so the consumer
  sleeps when `pop` returns `nullptr` — but now you've reintroduced syscalls.
  Usually the consumer spins with `_mm_pause()` for a bounded number of tries
  first.
- **"Why `acq_rel` on the exchange and not `release`?"** The acquire half lets a
  producer observe the predecessor's published state; in practice on this
  algorithm `release` suffices for correctness of the link, but `acq_rel` is the
  conservative, clearly-correct choice and is what the canonical version uses.

## Key takeaways

1. **MPSC = many producers, one consumer.** The asymmetry lets producers
   coordinate with a **single atomic `exchange`** and lets the consumer run with
   no contention.
2. **`tail_.exchange(n)` is the linearization point**; the item becomes
   consumer-visible only after the second store `prev->next = n` (a **release**),
   paired with the consumer's **acquire** load of `next`.
3. **The intermediate state is the whole point:** between the exchange and the
   link store, the node is in the list (`tail_`) but unreachable from `head_`.
   `pop` returning `nullptr` means "no node linked right now," not necessarily
   "empty."
4. The consumer is **lock-free, not wait-free**; producers are effectively
   wait-free (one bounded RMW, no CAS loop).
5. **Intrusive, caller-owned nodes** eliminate allocation *and* the memory-
   reclamation problem that plagues general lock-free linked lists.
6. **Cache-line-pad** `tail_` (producer-hot) from `head_`/`stub_` (consumer) to
   kill false sharing.

## Self-check

1. Walk through two producers calling `push` "simultaneously." Why do they not
   need a CAS retry loop, and what serialises them?
2. The consumer calls `pop` while a producer sits between its `exchange` and its
   `prev->next = n`. What does `pop` observe and return, and why is that correct
   behaviour rather than a bug?
3. Why is the producer effectively wait-free but the consumer only lock-free?
4. What memory-reclamation hazard (hazard pointers / RCU / ABA) does the
   *intrusive* design avoid, and exactly why does it not arise here?
5. Which store publishes the node's payload to the consumer, with what memory
   order, and which load does it synchronize-with?
6. What is the stub node for, and what must `pop` do when it drains the last real
   node to keep `push` correct?

## Further reading

- Dmitry Vyukov, ["Intrusive MPSC node-based queue"](https://www.1024cores.net/home/lock-free-algorithms/queues/intrusive-mpsc-node-based-queue) — the source of this algorithm, with the intermediate-state discussion. Read it; this lesson tracks it directly.
- Dmitry Vyukov, ["Non-intrusive MPSC node-based queue"](https://www.1024cores.net/home/lock-free-algorithms/queues/non-intrusive-mpsc-node-based-queue) — the variant where the queue owns nodes; contrast the ownership/reclamation tradeoff.
- Jeff Preshing, ["Acquire and Release Semantics"](https://preshing.com/20120913/acquire-and-release-semantics/) — the exact release/acquire pairing the publish step relies on.
- [`std::atomic::exchange` — cppreference](https://en.cppreference.com/w/cpp/atomic/atomic/exchange) and [`std::memory_order` — cppreference](https://en.cppreference.com/w/cpp/atomic/memory_order).
- Anthony Williams, *C++ Concurrency in Action*, 2nd ed., Ch. 7 — lock-free queues, linearization points, and the progress guarantees vocabulary.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — separating `tail_` from `head_`.

## Videos

- Fedor Pikus — **"Live Lock-Free or Deadlock (Practical Lock-free Programming)"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+live+lock-free+or+deadlock)) — lock-free vs wait-free, linearization, exactly the vocabulary this queue needs.
- Tony Van Eerd — **"The Continuing Adventures of Lock-Free Programming"** ([search](https://www.youtube.com/results?search_query=Tony+Van+Eerd+lock-free+programming+CppCon)) — intermediate states and why "looks empty" isn't "is empty."
- Herb Sutter — **"atomic<> Weapons: The C++ Memory Model and Modern Hardware"** ([search](https://www.youtube.com/results?search_query=Herb+Sutter+atomic+weapons+memory+model)) — the acquire/release/RMW foundations.
