# Memory Ordering

> **Why a quant dev must own this:** Memory ordering is the deepest, most
> mis-answered question in the HFT C++ interview, and the one that decides
> whether your lock-free SPSC queue is *correct* or *subtly broken on ARM*.
> Atomics give you atomicity; *memory ordering* gives you the rules about **what
> one thread is guaranteed to see of another thread's writes, and in what
> order**. Default `seq_cst` is always correct but emits expensive fences; the
> right `acquire`/`release` pairing is correct *and* costs nothing extra on
> x86. Knowing exactly which to use — and why x86 forgives mistakes that ARM
> punishes — is core HFT competence.

*Standard: C++11 introduced the memory model and `std::memory_order`; C++17 clarified `consume`; C++20 deprecated nothing here but added `atomic_ref`. Examples are C++17/20.*

## The problem: there is no single global "now"

Intuitively you imagine all threads reading and writing one shared memory in a
single interleaved timeline. **That intuition is false.** Two things conspire
against it:

1. **The compiler reorders.** The optimizer freely moves loads and stores around
   as long as a *single thread* can't tell — it knows nothing about other
   threads unless you tell it.
2. **The hardware reorders.** Each core has store buffers and caches. A store
   may sit in this core's store buffer, invisible to other cores, long after the
   instruction "completed". Different cores can observe writes in different
   orders.

So "thread A wrote `x` before `y`" does **not** imply "thread B sees `x` updated
before `y`." Memory ordering is the formal contract that lets you *force* the
guarantees you need — and only those, so you don't over-pay.

## Happens-before: the only thing that matters

The C++ memory model is built on one relation: **happens-before**. If
evaluation A *happens-before* evaluation B, then B is guaranteed to see A's
effects. If two conflicting accesses are **not** ordered by happens-before, you
have a **data race** → undefined behaviour.

Happens-before is built from:

- **Sequenced-before:** ordinary single-thread program order.
- **Synchronizes-with:** the cross-thread edge. A `release` operation that
  stores a value *synchronizes-with* an `acquire` operation that later reads
  that value. (A mutex unlock synchronizes-with the next lock — same machinery.)

> **The whole game:** build a *synchronizes-with* edge between two threads, and
> everything sequenced-before the release in the writer becomes visible to
> everything sequenced-after the acquire in the reader. That edge is what
> `release`/`acquire` create.

## The canonical example: message passing

This is *the* example every interviewer uses. One thread fills a payload, then
flips a flag; the other waits on the flag, then reads the payload.

```cpp
#include <atomic>
#include <cassert>

int               data = 0;       // plain, non-atomic payload
std::atomic<bool> ready{false};   // the flag

void producer() {
    data = 42;                                    // (1) write payload
    ready.store(true, std::memory_order_release); // (2) RELEASE: publish
}

void consumer() {
    while (!ready.load(std::memory_order_acquire))// (3) ACQUIRE: wait for publish
        ;                                         //     (spin)
    assert(data == 42);                           // (4) GUARANTEED to hold
}
```

Why does `assert(data == 42)` never fire? The `release` store (2)
**synchronizes-with** the `acquire` load (3) that reads the value it wrote.
That edge means everything *sequenced-before* (2) in the producer — including
the plain write (1) — *happens-before* everything *sequenced-after* (3) in the
consumer, including the read (4). The non-atomic `data` is published safely
*through* the atomic flag.

```text
producer thread                 consumer thread
---------------                 ---------------
(1) data = 42                   (3) while(!ready.acquire) ...
       |  sequenced-before              |  reads the value 2 stored
       v                                v  => synchronizes-with (2)
(2) ready.store(true, release) ----->  (acquire establishes happens-before)
                                        |  sequenced-before
                                        v
                                 (4) read data  ==> sees 42, guaranteed
```

Break the pairing — make (2) `relaxed`, or (3) `relaxed` — and the edge
vanishes. The compiler/CPU may then reorder (1) after (2), or let the consumer
read stale `data`, and the assert *can* fire. On ARM it *will* fire under load;
on x86 it usually won't (which is why bugs hide — more below).

## The six memory orders

`std::memory_order` has six values. Group them by use:

| Order | Use on | Meaning |
|---|---|---|
| `relaxed` | load/store/RMW | Atomicity only. **No ordering** of surrounding memory ops. |
| `acquire` | load (or RMW) | No reads/writes *after* it can be reordered *before* it. Pairs with release. |
| `release` | store (or RMW) | No reads/writes *before* it can be reordered *after* it. Pairs with acquire. |
| `acq_rel` | RMW only | Both acquire and release, for a read-modify-write. |
| `consume` | load | Weaker acquire (data-dependency ordering). **Effectively unusable** — see below. |
| `seq_cst` | any | Acquire/release **plus** a single total order over all `seq_cst` ops. The **default**. |

A useful mental model of the two "one-way fences":

```text
acquire load:  nothing below may float ABOVE it.   ── load(acquire) ──
                                                    | ops stay below |
release store: nothing above may sink BELOW it.     | ops stay above |
                                                    ── store(release) ─
```

### `relaxed`

Guarantees atomicity (no torn values, no data race) but **imposes no ordering**
on any other memory operation. Correct uses are narrow: a statistics counter
nobody synchronizes on, or the increment side of a reference count (the
*decrement-to-zero* needs an acquire fence). Use it only when you have *proven*
no other data is being published through it.

```cpp
counter.fetch_add(1, std::memory_order_relaxed);  // pure tally — order doesn't matter
```

### `acquire` / `release` — the workhorse

The message-passing pattern above. This is what you use for a flag that
publishes data, for the head/tail indices of an SPSC queue, for a sequence lock.
It is exactly as strong as you need and **no stronger**.

### `seq_cst` — the safe default, and its cost

`seq_cst` adds, on top of acquire/release, a **single global total order** that
all threads agree on for all `seq_cst` operations. It is the default for
`std::atomic` (`x.store(v)` == `x.store(v, seq_cst)`) precisely because it's the
easiest to reason about. The price: it forbids reorderings that acquire/release
allow, which on most hardware means **extra fences**. On x86 a `seq_cst` *store*
compiles to an `XCHG` (or `MOV` + `MFENCE`) — a full barrier — whereas a
release store is a plain `MOV`. On ARM, `seq_cst` needs heavier barrier
instructions than acquire/release.

> **Senior rule:** *Start with `seq_cst`; profile; then weaken to
> `acquire`/`release` where you can prove the pairing is sufficient.* Never use
> `relaxed` "to be fast" without a proof — that's how subtle bugs ship.

### `consume` — don't

`consume` was meant to be a cheaper acquire that only orders operations
*data-dependent* on the loaded value (perfect for traversing a published linked
list on weakly-ordered hardware). In practice **no mainstream compiler
implements it** — they all silently promote it to `acquire` — and the committee
discourages its use. Know what it was *for* (dependency ordering, RCU-style) and
that you should write `acquire` instead.

## Fences: `std::atomic_thread_fence`

You can also separate the ordering from the atomic variable using a standalone
fence:

```cpp
#include <atomic>
std::atomic<bool> ready{false};
int data = 0;

void producer() {
    data = 42;
    std::atomic_thread_fence(std::memory_order_release);  // fence, then...
    ready.store(true, std::memory_order_relaxed);         // ...a relaxed flag
}
void consumer() {
    while (!ready.load(std::memory_order_relaxed)) ;
    std::atomic_thread_fence(std::memory_order_acquire);  // acquire fence
    assert(data == 42);                                   // still guaranteed
}
```

A release fence orders all prior writes before all subsequent atomic stores; an
acquire fence orders all subsequent reads after prior atomic loads. Fences are
slightly more general (they apply to *all* preceding/following ops, not one
variable) and occasionally let you hoist one barrier out of a loop, but
**per-operation `acquire`/`release` is the idiomatic, easier-to-get-right
default.**

## Ordering on read-modify-writes and the release sequence

An RMW (`fetch_add`, `exchange`, `compare_exchange`) takes a memory order too —
and it can be *both* an acquire and a release at once (`acq_rel`): it acquires
the value it reads and releases the value it writes. A refcount decrement is the
textbook case: the decrements can be `relaxed` *except* the final one that hits
zero, which must `acquire` so the destructor sees every prior thread's writes.

```cpp
// Refcount release: relaxed decrements, acquire fence only when it reaches zero.
if (refcount.fetch_sub(1, std::memory_order_release) == 1) {
    std::atomic_thread_fence(std::memory_order_acquire);  // sync with all releasers
    delete resource;   // now safe: every prior user's writes happen-before us
}
```

`compare_exchange` takes **two** orders — one for success, one for failure:

```cpp
// success order: acq_rel (it's an RMW that publishes); failure order: acquire (just a load)
a.compare_exchange_weak(expected, desired,
                        std::memory_order_acq_rel,    // applied if the CAS succeeds
                        std::memory_order_acquire);   // applied if it fails (load only)
```

The failure order may not be stronger than the success order, and may not be
`release`/`acq_rel` (a failed CAS only reads, so it can't release). A subtle but
important guarantee is the **release sequence**: a release store, followed by any
number of RMWs on the same variable (even `relaxed` ones), still synchronizes-
with an acquire that reads the *latest* value in that chain — which is what keeps
a chain of `fetch_add`s on a queue index correctly ordered.

## Hardware reality: x86 TSO vs ARM/POWER

This is what makes the topic dangerous, and what interviewers love.

**x86-64 is Total Store Order (TSO):** it's a *strongly* ordered architecture.
Loads are not reordered with loads, stores not with stores, and loads are not
reordered with *earlier* stores to *different* locations — with **one** allowed
relaxation: a store can be delayed in the store buffer past a *later load*
(StoreLoad reordering). Consequences:

- A plain `MOV` load is *already* an acquire load; a plain `MOV` store is
  *already* a release store. So `memory_order_acquire`/`release` **cost nothing
  extra on x86** — they emit the same instructions as `relaxed`. The ordering is
  enforced by the compiler's reordering rules, not by any instruction.
- Only `seq_cst` needs a real fence on x86 (the `XCHG`/`MFENCE` on the store
  side) to forbid that one StoreLoad relaxation.

**ARM/AArch64 and POWER are weakly ordered:** the hardware reorders aggressively
and requires explicit barrier/load-acquire/store-release instructions. Here
`acquire`/`release` emit real instructions (`LDAR`/`STLR` on AArch64), and
`relaxed` genuinely lets the hardware reorder.

```text
                 x86-64 (TSO)              AArch64 (weak)
                 ----------------------    -------------------------
load(relaxed)    MOV                       LDR
load(acquire)    MOV   (free!)             LDAR        (real barrier)
store(relaxed)   MOV                       STR
store(release)   MOV   (free!)             STLR        (real barrier)
store(seq_cst)   XCHG / MOV+MFENCE         STLR (+ DMB for full seq_cst)
```

> **The trap this creates:** code that under-specifies ordering (uses `relaxed`
> where it needed `acquire`/`release`) **runs correctly on x86** — because the
> hardware happens to provide the ordering for free — and then **fails on ARM**
> (Apple Silicon, AWS Graviton, mobile). "Works on my x86 dev box" is not a
> correctness proof. Reason from the C++ model, not from x86 behaviour.

## Putting it together: a correct SPSC publish

```cpp
#include <atomic>
#include <cstddef>

// Single-producer / single-consumer publish of a slot index.
template <class T, std::size_t N>
struct RingPublish {
    T                          buf[N];
    std::atomic<std::size_t>   write_idx{0};   // published by producer

    void push(std::size_t i, const T& v) {
        buf[i % N] = v;                                  // (a) write payload (plain)
        write_idx.store(i + 1, std::memory_order_release);// (b) RELEASE: publish index
    }
    bool try_read(std::size_t i, T& out) {
        if (write_idx.load(std::memory_order_acquire) > i) { // (c) ACQUIRE
            out = buf[i % N];                            // (d) safe: (a) happens-before (d)
            return true;
        }
        return false;
    }
};
```

The `release` store (b) synchronizes-with the `acquire` load (c); the payload
write (a) is therefore visible at (d). No mutex, no `seq_cst`, and on x86 the
atomics compile to plain `MOV`s — *this is why lock-free queues are fast.*

## Quant/HFT relevance & interview gotchas

- **Be able to draw the message-passing happens-before diagram from memory.**
  "Release publishes, acquire consumes, everything before the release is visible
  after the acquire." This is the single most-asked lock-free question.
- **`acquire`/`release` are free on x86, real instructions on ARM.** Saying this
  unprompted marks you as someone who has actually shipped on weak hardware.
- **The x86 trap:** under-ordered code (wrongful `relaxed`) passes on x86 and
  breaks on ARM. Reason from the standard, then verify on the target.
- **`seq_cst` is the default and the safe starting point;** weaken to
  acquire/release only with a proof. **`relaxed` needs a justification** — it's
  for counters/stats and the increment side of refcounts, not for publishing
  data.
- **`consume` is dead** — compilers promote it to `acquire`. Don't use it; know
  what it was for (dependency ordering / RCU).
- **A data race remains UB** even with atomics if your ordering is wrong and you
  touch the non-atomic payload without a happens-before edge.
- **x86 TSO's one relaxation is StoreLoad** — that's the only reordering a
  `seq_cst` fence is buying you back on x86.

## Key takeaways

1. There is **no single global "now"** — compiler and hardware reorder memory
   ops. **Happens-before** is the only relation that guarantees one thread sees
   another's writes; absence of it = data race = UB.
2. **Synchronizes-with** is the cross-thread edge: a **`release` store
   synchronizes-with an `acquire` load that reads it**, publishing everything
   sequenced-before the release.
3. Know the six orders: **`relaxed`** (atomic only), **`acquire`/`release`**
   (the workhorse pairing), **`acq_rel`** (RMW), **`seq_cst`** (default, total
   order, costs a fence), **`consume`** (effectively dead, write `acquire`).
4. The **canonical message-passing example** (`data` published through a
   `release`/`acquire` flag) is the pattern behind every lock-free SPSC publish.
5. **x86-64 is TSO (strong)**: `acquire`/`release` are *free* (plain `MOV`),
   only `seq_cst` needs a fence. **ARM/POWER are weak**: `acquire`/`release`
   emit real barriers (`LDAR`/`STLR`). **Under-ordered code passes on x86 and
   breaks on ARM** — reason from the model.
6. **Default to `seq_cst`, weaken with proof.** `relaxed` always needs a
   justification.

## Self-check

1. Define *happens-before* and *synchronizes-with*, and state which atomic
   operations create the latter.
2. In the message-passing example, exactly which guarantee makes
   `assert(data == 42)` safe? What breaks if the store is `relaxed`?
3. Why do `acquire`/`release` cost nothing extra on x86 but emit real
   instructions on AArch64?
4. Explain the "passes on x86, fails on ARM" failure mode and how to avoid
   shipping it.
5. Give one legitimate use of `relaxed` and one place it would be a bug.
6. What is x86's single allowed reordering under TSO, and which memory order
   forbids it?
7. Why should you not use `memory_order_consume` today?

## Further reading

- Jeff Preshing — ["An Introduction to Lock-Free Programming"](https://preshing.com/20120612/an-introduction-to-lock-free-programming/), ["Acquire and Release Semantics"](https://preshing.com/20120913/acquire-and-release-semantics/), and ["The Synchronizes-With Relation"](https://preshing.com/20130823/the-synchronizes-with-relation/) — the clearest writing on this topic anywhere.
- [`std::memory_order` — cppreference](https://en.cppreference.com/w/cpp/atomic/memory_order) — the reference, with the formal definitions.
- [`intro.races` — C++ draft](https://eel.is/c++draft/intro.races) — happens-before, synchronizes-with, data races, normatively.
- Herb Sutter — ["atomic<> Weapons"](https://herbsutter.com/2013/02/11/atomic-weapons-the-c-memory-model-and-modern-hardware/) — the canonical talk tying the model to hardware.
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — Ch. 5 (memory model and ordering) is the definitive book treatment.
- Paul McKenney et al., ["Is Parallel Programming Hard, And, If So, What Can You Do About It?"](https://mirrors.edge.kernel.org/pub/linux/kernel/people/paulmck/perfbook/perfbook.html) — memory-barriers chapter for the hardware view.
- Russ Cox — ["Hardware Memory Models"](https://research.swtch.com/hwmm) — an outstanding cross-architecture (x86 TSO vs ARM) survey.

## Videos

- Herb Sutter — **"atomic<> Weapons" (parts 1 & 2)** ([search](https://www.youtube.com/results?search_query=Herb+Sutter+atomic+weapons+memory+model)) — watch both; the definitive treatment.
- Hans Boehm — **"Using weakly ordered C++ atomics correctly"** ([search](https://www.youtube.com/results?search_query=Hans+Boehm+weakly+ordered+C%2B%2B+atomics+correctly)) — from the author of the memory model.
- Fedor Pikus — **"C++ atomics, from basic to advanced"** (CppCon) ([search](https://www.youtube.com/results?search_query=Fedor+Pikus+C%2B%2B+atomics+from+basic+to+advanced)) — covers ordering with great hardware intuition.
