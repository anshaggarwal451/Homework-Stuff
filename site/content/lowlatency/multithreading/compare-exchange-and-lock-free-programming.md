# Compare-Exchange & Lock-Free Programming

> **Why a quant dev must own this:** Compare-and-swap (CAS) is the single
> instruction that makes lock-free programming possible — every lock-free stack,
> queue, and counter is ultimately a CAS in a retry loop. In HFT it's how you
> update shared state with no mutex, no syscall, and no risk that a descheduled
> thread freezes the whole system. But CAS is a minefield: weak vs strong, the
> ABA problem, and the gulf between "lock-free" and "wait-free." Getting the
> distinctions right — and knowing when *not* to go lock-free — is a senior-level
> signal.

*Standard: C++11 for `compare_exchange_*`; examples use C++17. ABA mitigation notes touch on `CMPXCHG16B` / DWCAS.*

## Compare-exchange: the conditional RMW

`compare_exchange` (CAS) atomically does: *"if this atomic currently equals
`expected`, replace it with `desired` and report success; otherwise load the
current value into `expected` and report failure."* All as one indivisible step.

```cpp
#include <atomic>
std::atomic<int> v{0};

int expected = 0;
bool ok = v.compare_exchange_strong(expected, 1);
// if v was 0: v becomes 1, ok == true,  expected unchanged (still 0)
// if v was X: v unchanged,  ok == false, expected == X (the actual value)
```

The crucial detail: **on failure, `expected` is updated to the actual value.**
That is what makes the *CAS loop* — the fundamental shape of lock-free code —
work without a separate reload:

```cpp
// Atomically apply f() to a shared value, lock-free. The canonical CAS loop.
template <class T, class F>
void atomic_update(std::atomic<T>& a, F f) {
    T old = a.load(std::memory_order_relaxed);
    T desired;
    do {
        desired = f(old);                 // compute new value from the snapshot
    } while (!a.compare_exchange_weak(old, desired,
                                      std::memory_order_release,  // on success
                                      std::memory_order_relaxed));// on failure-reload
    // loops only if someone else changed 'a' in between; 'old' is refreshed each time
}
```

If another thread changes `a` between our load and our CAS, the CAS fails,
`old` is refreshed to the new value, and we retry. Progress is guaranteed
because a CAS only fails when *someone else* made progress.

## Weak vs strong

There are two forms, and choosing wrong is a classic interview slip:

| | `compare_exchange_strong` | `compare_exchange_weak` |
|---|---|---|
| Spurious failure (fails even when value *did* match) | **Never** | **Allowed** |
| Use when | A single, un-looped CAS | Inside a retry loop |
| Codegen on LL/SC machines (ARM/POWER) | May need an inner loop → slower | Maps directly to one `LDXR`/`STXR` → faster |

`compare_exchange_weak` is allowed to fail *spuriously* — to return `false` even
though the value equalled `expected`. This sounds like a bug but it's a
performance feature: on **load-linked/store-conditional** architectures
(ARM, POWER), the store-conditional can fail for benign reasons (an interrupt,
a cache event) and *weak* lets the compiler expose that single LL/SC pair
directly instead of wrapping it in a hidden retry loop.

> **Rule:** **In a loop, use `weak`** (you're retrying anyway, so a spurious
> failure costs nothing and you get better codegen). **For a one-shot CAS not in
> a loop, use `strong`** (you don't want to handle spurious failure yourself).
> On x86 there's no difference in codegen (both are `LOCK CMPXCHG`); the
> distinction matters on ARM/POWER.

## The ABA problem

This is *the* lock-free trap, and the question that separates people who've read
about CAS from people who've debugged it.

CAS checks that a value is *still* `expected` — but "the value is the same" does
**not** mean "nothing happened." A pointer can change from **A → B → A**: between
your load and your CAS, another thread popped node A, did things, and pushed a
*different* node that the allocator happened to place at A's old address. Your
CAS sees `A == A`, succeeds, and **you corrupt the structure** — your saved
`next` pointer is now stale.

```text
Thread 1                         Thread 2
--------                         --------
load head -> A
save A.next -> B                 pop A     (head = B)
                                 pop B     (head = C)
                                 push A    (head = A again, A.next now points at C)
CAS(head, A -> B)  <-- SUCCEEDS because head == A,
                       but B was already freed/popped! head is now corrupt.
```

Mitigations, in order of practicality:

1. **Tagged pointers / version counters (DWCAS).** Pack a monotonically
   increasing tag next to the pointer and CAS both together
   (`std::atomic<TaggedPtr>` using x86 `CMPXCHG16B` / "double-width CAS"). The
   tag changes on every push, so A-with-tag-7 ≠ A-with-tag-9 and the stale CAS
   fails. The standard, classic fix.
2. **Hazard pointers** (Maged Michael) — readers publish the pointers they're
   using so memory can't be reclaimed underneath them.
3. **Epoch-based reclamation / RCU** — defer freeing until no thread could hold
   a reference.
4. **Don't reuse addresses** — a free-list that never returns memory to the
   allocator sidesteps it, but leaks/grows.

ABA is fundamentally a **memory-reclamation** problem: the value reused because
the *memory* was reused. That framing is the senior answer.

## A lock-free stack (Treiber stack) sketch

The textbook lock-free structure, to make CAS concrete. **Note it has the ABA
bug on `pop` — shown deliberately, with the fix called out.**

```cpp
#include <atomic>

template <class T>
class LockFreeStack {
    struct Node {
        T     value;
        Node* next;
    };
    std::atomic<Node*> head_{nullptr};

public:
    void push(const T& v) {
        Node* n = new Node{v, nullptr};
        n->next = head_.load(std::memory_order_relaxed);
        // retry until our node is linked in atomically:
        while (!head_.compare_exchange_weak(
                   n->next, n,                       // expect old head, swap in n
                   std::memory_order_release,         // publish n (and value) on success
                   std::memory_order_relaxed)) {      // on failure, n->next is refreshed
        }
    }

    bool pop(T& out) {
        Node* old = head_.load(std::memory_order_acquire);
        while (old &&
               !head_.compare_exchange_weak(
                   old, old->next,                    // <-- reads old->next: ABA-UNSAFE
                   std::memory_order_acquire,
                   std::memory_order_relaxed)) {
        }
        if (!old) return false;
        out = old->value;
        // delete old;   // <-- WHO frees this safely? Reclamation is the hard part.
        return true;     // (leaked here on purpose: needs hazard pointers / epochs)
    }
};
```

Two lessons jump out: (1) the `push` is clean and genuinely lock-free; (2) the
`pop` exposes the two real difficulties of lock-free programming — **ABA** (the
`old->next` read) and **safe reclamation** (who calls `delete`, and when). The
algorithm is the easy part; *memory reclamation is the hard part*, and it's why
production lock-free code uses hazard pointers or epoch schemes (or just a
bounded ring buffer that never frees).

## Progress guarantees: lock-free, wait-free, obstruction-free

These terms are precise, and interviewers check you don't use them loosely.

| Guarantee | Definition | Implication |
|---|---|---|
| **Blocking** (e.g. mutex) | A stalled thread can block *all* others | One descheduled holder can freeze everyone (and invites priority inversion) |
| **Obstruction-free** | A thread makes progress if it runs *in isolation* (no contention) | Weakest non-blocking class; livelock possible |
| **Lock-free** | *System-wide* progress: at least **one** thread always makes progress | No deadlock, no priority inversion; an individual thread *may* starve (its CAS keeps losing) |
| **Wait-free** | **Every** thread completes in a **bounded** number of steps | Strongest: no starvation, bounded latency; hardest to build, often slower in the common case |

Key relationships and gotchas:

- **Wait-free ⊂ Lock-free ⊂ Obstruction-free ⊂ Non-blocking.** Wait-free is
  strictly stronger.
- A **CAS-loop algorithm is lock-free, not wait-free**: a thread can lose the
  CAS race arbitrarily many times (starvation), but *some* thread always wins
  (system progresses).
- **Lock-free does not mean fast.** Under heavy contention a CAS loop can retry
  repeatedly, and each failed CAS still bounced a cache line. The win of
  lock-free is **robustness** — no thread can halt the system by being
  descheduled while holding a lock — not raw speed. Sometimes a well-designed
  lock is faster.
- **Wait-free matters for HFT tail latency:** a lock-free structure can have a
  pathological retry storm spiking your p99.99; wait-free gives a *bounded*
  worst case. This is why HFT favours **single-producer/single-consumer ring
  buffers** (which are wait-free and need no CAS at all — just acquire/release
  on head/tail indices) over general multi-producer CAS structures on the
  hottest path.

> **Senior framing:** "Lock-free guarantees the *system* progresses even if a
> thread is descheduled; wait-free additionally bounds *each* thread's steps.
> For a hot path I'd reach for a wait-free SPSC ring before a CAS-based MPMC
> queue, because bounded tail latency beats theoretical throughput."

## Hardware reality

`compare_exchange` compiles to:

```x86asm
; std::atomic<int>::compare_exchange_strong(expected, desired)
    mov     eax, [expected]      ; EAX = expected (CMPXCHG compares against EAX)
    lock cmpxchg [v], edx        ; if [v]==EAX: [v]=EDX, ZF=1; else EAX=[v], ZF=0
    ; ZF (zero flag) reports success; on failure EAX holds the actual value
```

Cost model:

```text
operation                              rough cost
-------------------------------------- ----------------------------------
LOCK CMPXCHG, uncontended (own line)   ~15-25 ns (~20-40 cycles), full fence on x86
CAS that fails + retries under load    each retry re-bounces the cache line: tens-hundreds ns
DWCAS (CMPXCHG16B)                     similar order, slightly more; needs 16-byte alignment
```

The same theme as plain atomics: **cheap uncontended, a cache-coherence traffic
jam under contention**, and on x86 every `LOCK CMPXCHG` is a full barrier. A
retry storm doesn't just waste CPU — it saturates the interconnect.

## Quant/HFT relevance & interview gotchas

- **Explain the ABA problem and frame it as a reclamation problem.** Mention
  tagged-pointer/DWCAS and hazard pointers as fixes. This is the highest-signal
  lock-free question.
- **weak in a loop, strong for one-shot.** Know *why* (spurious failure + LL/SC
  codegen on ARM); on x86 both are `LOCK CMPXCHG`.
- **Define lock-free vs wait-free precisely.** Lock-free = system progress;
  wait-free = bounded steps per thread. A CAS loop is lock-free, not wait-free.
- **"Lock-free isn't automatically faster."** It's about robustness (no
  descheduled-holder freeze, no priority inversion); under contention it can be
  slower than a good lock. Saying this shows maturity.
- **Prefer SPSC wait-free ring buffers on the hot path** over MPMC CAS
  structures, for bounded tail latency. Reclamation is the part everyone
  underestimates — `delete` in a lock-free pop is a use-after-free waiting to
  happen.
- **`compare_exchange` takes two memory orders** (success, failure); the failure
  order can't be stronger than success and can't be `release`/`acq_rel`.

## Key takeaways

1. **CAS** atomically swaps `desired` in only if the value still equals
   `expected`; on failure it **reloads `expected`**, which powers the canonical
   **CAS retry loop** — the basis of all lock-free code.
2. **Use `compare_exchange_weak` in loops** (spurious failures are free there and
   give better ARM/POWER codegen) and **`strong` for one-shot** CAS.
3. The **ABA problem**: a value reverts A→B→A so CAS wrongly succeeds. It's
   fundamentally a **memory-reclamation** issue; fix with tagged pointers/DWCAS,
   hazard pointers, or epoch/RCU schemes.
4. The hard part of a lock-free structure (e.g. a Treiber stack) is **safe
   reclamation**, not the algorithm; never blindly `delete` in a lock-free pop.
5. **Lock-free = system-wide progress; wait-free = bounded steps per thread.** A
   CAS loop is lock-free, *not* wait-free; HFT prefers **wait-free SPSC rings**
   for bounded tail latency.
6. **Lock-free ≠ fast.** Its value is robustness; under contention a retry storm
   bounces cache lines and can lose to a good lock.

## Self-check

1. After a failed `compare_exchange`, what is the value of `expected`, and why is
   that essential to the CAS loop?
2. When do you use `weak` vs `strong`, and why does the choice matter on ARM but
   not x86?
3. Walk through an A→B→A interleaving that makes a Treiber-stack `pop` corrupt
   the structure. Why is it called a *reclamation* problem?
4. Name three ABA mitigations and the core idea of each.
5. Precisely distinguish lock-free from wait-free. Which is a plain CAS loop, and
   which does HFT prefer on the hot path?
6. Give a scenario where a mutex-based design outperforms a lock-free one.

## Further reading

- [`std::atomic::compare_exchange_weak/strong` — cppreference](https://en.cppreference.com/w/cpp/atomic/atomic/compare_exchange) — note the two memory-order arguments and the spurious-failure clause.
- Jeff Preshing — ["An Introduction to Lock-Free Programming"](https://preshing.com/20120612/an-introduction-to-lock-free-programming/) and ["Lock-Free vs Wait-Free"](https://preshing.com/20120612/an-introduction-to-lock-free-programming/) framing of progress guarantees.
- Maged Michael — ["Hazard Pointers: Safe Memory Reclamation for Lock-Free Objects"](https://erdani.org/publications/cuj-2004-12.pdf) — the canonical reclamation technique.
- Dmitry Vyukov — [1024cores.net](https://www.1024cores.net/home/lock-free-algorithms) — deep, practical lock-free algorithm writeups (and the famous MPMC queue).
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — Ch. 7 ("Designing lock-free concurrent data structures"), including a full Treiber stack with reclamation.
- Erik Rigtorp — ["Correctly implementing a spinlock / lock-free SPSC queue"](https://rigtorp.se/ringbuffer/) — why SPSC rings beat CAS structures on the hot path.

## Videos

- Fedor Pikus — **"Live Lock-Free or Deadlock (Practical Lock-Free Programming)"** (CppCon) ([search](https://www.youtube.com/results?search_query=Fedor+Pikus+Live+Lock-Free+or+Deadlock)) — CAS, ABA, and progress guarantees, hands-on.
- Tony Van Eerd — **"Lock-free by Example"** ([search](https://www.youtube.com/results?search_query=Tony+Van+Eerd+lock-free+by+example)) — building lock-free structures carefully.
- Herb Sutter — **"Lock-Free Programming (or, Juggling Razor Blades)"** ([search](https://www.youtube.com/results?search_query=Herb+Sutter+lock-free+programming+juggling+razor+blades)) — the ABA problem and reclamation, vividly.
