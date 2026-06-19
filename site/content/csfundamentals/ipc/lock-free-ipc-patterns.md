# Lock-Free IPC Patterns

> **Why a quant dev must own this:** This is the beating heart of a trading
> system. A feed handler publishes ticks into a [shared-memory](posix-shared-memory.md)
> ring; strategies consume them — with **no locks, no syscalls, and no kernel** in
> the path, just atomic loads and stores ordered by carefully chosen memory
> barriers. The single-producer/single-consumer ring buffer and the seqlock are
> the two patterns you will implement, debug, and be quizzed on more than any
> others. Getting the memory ordering and cache-line layout right is the
> difference between correct nanosecond-scale IPC and a heisenbug that costs real
> money.

## First principles: publish-then-observe without a lock

A lock makes concurrency easy by making it *exclusive*. Lock-free IPC instead
relies on **atomic operations plus memory ordering** to let a producer and a
consumer touch shared data simultaneously and still agree on what happened. The
core idea is a **publication protocol**:

1. The producer writes the **payload** into a slot.
2. The producer then **publishes** by storing an index/flag with **release**
   semantics.
3. The consumer **loads** that index/flag with **acquire** semantics.
4. Because release→acquire establishes a *happens-before* edge, once the consumer
   observes the new index, it is guaranteed to also see the payload writes that
   preceded the release.

That's the whole trick: the released atomic acts as a one-way valve — everything
the producer did *before* the release becomes visible to a consumer that *sees*
the release. No mutex, no kernel.

## The SPSC ring buffer: the workhorse

A **single-producer/single-consumer** (SPSC) bounded queue is the most important
structure in low-latency systems. One writer, one reader, a fixed-capacity ring:

```text
   capacity = 8 (power of two), mask = 7
   index & mask  -> slot

        +----+----+----+----+----+----+----+----+
        | s0 | s1 | s2 | s3 | s4 | s5 | s6 | s7 |   (ring of slots)
        +----+----+----+----+----+----+----+----+
                ^tail (consumer reads here)  ^head (producer writes here)

   empty  when head == tail
   full   when (head - tail) == capacity
```

Design decisions and *why*:

- **Power-of-two capacity + bitmask** instead of modulo: `i & (cap-1)` is one AND
  instruction; `%` is a division. Free correctness and speed.
- **Monotonically increasing indices** (don't wrap the counters, only the slot
  index via the mask): `head - tail` then directly gives the count and never
  ambiguates full-vs-empty.
- **SPSC needs no CAS.** Only the producer writes `head`; only the consumer writes
  `tail`. Each index has exactly one writer, so plain atomic load/store with the
  right ordering suffices — no read-modify-write, no retry loop. This is why SPSC
  is dramatically faster than MPMC.

### Compilable SPSC ring (shared-memory-ready layout)

```cpp
// g++ -std=c++20 -O2 spsc.cpp -o spsc
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <new>          // std::hardware_destructive_interference_size

#ifdef __cpp_lib_hardware_interference_size
constexpr std::size_t CL = std::hardware_destructive_interference_size; // usually 64
#else
constexpr std::size_t CL = 64;
#endif

template <class T, std::size_t Capacity>   // Capacity MUST be a power of two
struct SpscRing {
    static_assert((Capacity & (Capacity - 1)) == 0, "capacity must be 2^n");
    static constexpr std::size_t MASK = Capacity - 1;

    // Pad head and tail onto SEPARATE cache lines: otherwise the producer's
    // write to head invalidates the line the consumer reads tail from, and
    // vice versa -> false sharing, the classic SPSC performance killer.
    alignas(CL) std::atomic<std::uint64_t> head{0};   // next write index (producer)
    alignas(CL) std::atomic<std::uint64_t> tail{0};   // next read index  (consumer)
    alignas(CL) T buffer[Capacity];                   // trivially-copyable T only

    // ---- producer side ----
    bool try_push(const T& item) {
        const std::uint64_t h = head.load(std::memory_order_relaxed);   // we own head
        const std::uint64_t t = tail.load(std::memory_order_acquire);   // see consumer progress
        if (h - t == Capacity) return false;                            // full
        buffer[h & MASK] = item;                                        // write payload first
        head.store(h + 1, std::memory_order_release);                   // publish (release)
        return true;
    }

    // ---- consumer side ----
    bool try_pop(T& out) {
        const std::uint64_t t = tail.load(std::memory_order_relaxed);   // we own tail
        const std::uint64_t h = head.load(std::memory_order_acquire);   // see published items
        if (h == t) return false;                                       // empty
        out = buffer[t & MASK];                                         // read payload
        tail.store(t + 1, std::memory_order_release);                   // free the slot
        return true;
    }
};
```

Place an `SpscRing<Tick, 1024>` in a `MAP_SHARED` region (see
[POSIX Shared Memory](posix-shared-memory.md)) and two *processes* use it exactly
the same way — atomics operate on the shared bytes, so cross-process and
cross-thread are identical. `T` must be trivially copyable (no pointers/strings/
vtables) for the same layout reasons as any shared-memory object.

### Why those exact memory orders

- **Producer `buffer[..] = item` then `head.store(release)`** — the release store
  guarantees the payload write is visible to any consumer that observes the new
  head. Reorder them and the consumer could read a slot the producer hasn't filled.
- **Consumer `head.load(acquire)` then read `buffer[..]`** — the acquire pairs
  with the producer's release; once we see the head advance, the payload is
  visible. With `relaxed` on the load the CPU/compiler could read the payload
  *before* confirming it's published — reading garbage.
- The "we own it" indices (`head` for producer, `tail` for consumer) load
  **relaxed** because no one else writes them; their *publication* uses release,
  their *observation by the other side* uses acquire.

This is the canonical release/acquire dance — the same idea introduced for the
single-slot hand-off in [POSIX Shared Memory](posix-shared-memory.md), now scaled
to a queue.

## False sharing and cache-line padding

`head` and `tail` are touched by *different* cores. If they share a 64-byte cache
line, every producer update to `head` invalidates the consumer's copy of the line
(and vice versa) — **false sharing** — forcing a coherence round trip on each
operation and destroying throughput even though the two variables are logically
independent. `alignas(std::hardware_destructive_interference_size)` (typically
64 bytes; 128 on some Intel due to adjacent-line prefetch) puts them on separate
lines. This is mandatory in any serious ring and a guaranteed interview topic.

A further optimization real implementations use: each side caches the *other*
index locally (`cached_tail` in the producer) and only re-reads the shared atomic
when its cached value says "full/empty," cutting cross-core reads further.

## The seqlock: single-writer, many-reader snapshots

Sometimes you don't want a queue of every update — you want **the latest value**,
read by many consumers, written by one. Example: publish the current top-of-book
snapshot; readers just want the freshest consistent copy. A **seqlock** is ideal
and lock-free for readers:

```cpp
#include <atomic>
#include <cstdint>

template <class T>     // T trivially copyable
struct Seqlock {
    alignas(64) std::atomic<std::uint64_t> seq{0};
    T value{};

    // single writer
    void store(const T& v) {
        const std::uint64_t s = seq.load(std::memory_order_relaxed);
        seq.store(s + 1, std::memory_order_release);   // odd => write in progress
        std::atomic_thread_fence(std::memory_order_release);
        value = v;                                     // write payload
        seq.store(s + 2, std::memory_order_release);   // even => write complete
    }

    // many readers, lock-free, retry on conflict
    T load() const {
        T out;
        std::uint64_t s0, s1;
        do {
            s0 = seq.load(std::memory_order_acquire);  // even & stable => readable
            if (s0 & 1) continue;                      // writer mid-update, retry
            std::atomic_thread_fence(std::memory_order_acquire);
            out = value;                               // optimistic read
            std::atomic_thread_fence(std::memory_order_acquire);
            s1 = seq.load(std::memory_order_relaxed);
        } while (s0 != s1);                            // changed mid-read => retry
        return out;
    }
};
```

How it works: the **sequence counter is odd while a write is in progress, even
when stable**. A reader snapshots `seq` before and after copying the value; if it
was odd or changed, a writer interfered and the reader retries. Readers never
block the writer and never block each other — perfect for a hot snapshot many
strategies poll. The cost is that readers may *retry* under heavy write
contention, so seqlocks shine when reads vastly outnumber writes (exactly the
market-data-snapshot case).

## MPSC / MPMC: when you need CAS, and the ABA problem

Multiple producers (or multiple consumers) writing the *same* index can't use a
plain store — two producers could grab the same slot. You need a
**compare-and-swap (CAS)** loop:

```cpp
std::uint64_t h = head.load(std::memory_order_relaxed);
while (!head.compare_exchange_weak(h, h + 1,
                                   std::memory_order_acq_rel,
                                   std::memory_order_relaxed)) {
    // h was reloaded with the current value; retry
}
// h is now MY reserved slot index
```

CAS brings the **ABA problem**: a thread reads value A, another changes it to B
and back to A; the first thread's CAS succeeds though the world changed
underneath it. Classic in pointer-based lock-free stacks/queues. Mitigations to
*name* (you won't implement all in an interview):

- **Tagged pointers / version counters** — pack a monotonic counter alongside the
  pointer so A-then-A is detectably different (defeats ABA cheaply).
- **Hazard pointers** — readers publish which nodes they're using so reclamation
  is deferred until safe.
- **RCU / epoch-based reclamation** — defer freeing memory until all readers have
  passed a quiescent point.

For IPC specifically, prefer to **architect around MPMC**: give each producer its
*own* SPSC ring into the consumer, rather than one shared MPMC queue. Many
trading systems do exactly this — N SPSC rings instead of one contended MPMC
queue — because SPSC's no-CAS path is so much faster and simpler to reason about.

## The LMAX Disruptor

The **LMAX Disruptor** is a famous ring-buffer design that generalizes these
ideas: a single ring with a published **sequence** that producers advance and
multiple consumers track via their own sequences (supporting dependency graphs of
consumers), pre-allocated slots (no per-message allocation), and heavy
cache-line padding. It's essentially "SPSC/seqlock thinking, productized" and is
worth citing as prior art — it popularized cache-aware lock-free queues in
finance.

## Memory barriers on x86: cheaper than you fear

x86-64 is **Total Store Order (TSO)**: loads aren't reordered with loads, stores
aren't reordered with stores, and a store is never reordered before an earlier
load... the one relaxation is that a load may be reordered *before* an earlier
store to a different address. Consequences for our code:

- **Acquire loads and release stores are essentially free on x86** — they compile
  to ordinary `MOV`s plus a compiler-only barrier (no fence instruction). The
  cost is paid in the *compiler* not reordering, not in the hardware.
- **`seq_cst` stores and any read-modify-write** (CAS, `fetch_add`,
  `XCHG`) emit a real barrier (`LOCK`-prefixed instruction / `MFENCE`) — tens of
  cycles, and they round-trip the cache line. **This is why SPSC (no RMW) crushes
  MPMC (CAS per op).**

So on x86 the dominant cost of a correct SPSC ring isn't the barriers — it's the
**cache-line coherence traffic** between producer and consumer cores (and far
worse across NUMA sockets). Correct ordering is cheap; *data locality* is the
expensive part. On weaker architectures (ARM, POWER) acquire/release *do* cost
real barrier instructions — which is one more reason to write the orderings
explicitly with `std::atomic` rather than hand-wave with `volatile` (which
provides **no** ordering or atomicity and is wrong for this).

## Performance and hardware reality

- A correct SPSC hand-off between two cores costs roughly the **cross-core
  cache-line transfer (~tens of ns)** plus a couple of nearly-free atomic ops —
  versus the **microseconds** of any kernel-mediated IPC (see
  [IPC Trade-offs](ipc-trade-offs-and-performance.md)).
- **False sharing** can multiply that by an order of magnitude; `alignas(64)` on
  the indices is non-negotiable.
- **NUMA**: pin producer and consumer to the same socket if possible — cross-socket
  coherence is markedly slower than intra-socket.
- A busy-polling consumer turns latency into "time to next poll" — bounded and
  tiny, at the cost of a dedicated core. Use `_mm_pause()` (PAUSE) in the spin to
  be hyperthread-friendly.
- These are **order-of-magnitude** figures and depend heavily on your CPU,
  topology, and message size — measure with your own harness.

## Quant/HFT relevance & interview gotchas

- **The SPSC ring in shared memory is THE core inter-thread/inter-process
  mechanism** in trading systems. Be able to write it, with correct
  release/acquire and cache-line padding, from memory.
- **SPSC needs no CAS** — each index has one writer. Saying this (and *why*) is a
  strong signal.
- **Release publishes, acquire observes.** Be able to explain the happens-before
  edge and what breaks under `relaxed`.
- **Pad `head`/`tail` to separate cache lines** — name false sharing and
  `std::hardware_destructive_interference_size`.
- **Seqlock for latest-snapshot, many readers** (top-of-book): readers are
  lock-free and retry on an odd/changed sequence; ideal when reads ≫ writes.
- **MPMC needs CAS → ABA** — name tagged pointers / hazard pointers / RCU, and
  prefer **N SPSC rings over one MPMC queue** when you can.
- **On x86, acquire/release are free; CAS/`seq_cst` are not.** The real cost is
  **cache coherence and false sharing**, not the fences. **`volatile` is not a
  concurrency tool.**

## Key takeaways

1. Lock-free IPC = atomics + memory ordering. The protocol is **write payload →
   release-store an index/flag → acquire-load it → read payload**, which
   establishes happens-before without a lock or the kernel.
2. The **SPSC ring buffer** (power-of-two capacity, mask, monotonic indices) is the
   workhorse and **needs no CAS** because each index has a single writer.
3. **Pad `head` and `tail` to separate cache lines** (`alignas(64)` /
   `hardware_destructive_interference_size`) to kill **false sharing** — the most
   common SPSC performance bug.
4. A **seqlock** (odd/even sequence counter, reader retries) gives lock-free
   latest-snapshot reads for many readers, one writer — ideal for top-of-book.
5. **MPSC/MPMC require CAS** and invite the **ABA problem** (tagged pointers /
   hazard pointers / RCU); prefer multiple SPSC rings. On x86, **acquire/release
   are nearly free; CAS and `seq_cst` are not** — the dominant cost is
   **cache-coherence traffic and NUMA**.

## Self-check

1. Walk through the release/acquire pair in `try_push`/`try_pop`. What concretely
   can go wrong if the producer's index store is `relaxed` instead of `release`?
2. Why does an SPSC ring need no CAS, while an MPSC ring does? Which line of code
   changes?
3. What is false sharing here, which two fields cause it, and how do you fix it —
   and roughly how much does it cost if you don't?
4. Explain the odd/even sequence in a seqlock. Why must the reader read `seq`
   *both* before and after copying the value?
5. What is the ABA problem, when does it arise in lock-free IPC, and name two
   mitigations.
6. On x86-64, why are acquire-load and release-store "free" but `fetch_add` is
   not, and what does that imply for SPSC vs MPMC design?

## Further reading

- [`std::atomic` and `std::memory_order` — cppreference](https://en.cppreference.com/w/cpp/atomic/memory_order) — the definitive reference for acquire/release/seq_cst.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — cache-line padding for false sharing.
- Dmitry Vyukov, [1024cores — lock-free algorithms](https://www.1024cores.net/home/lock-free-algorithms) — SPSC/MPSC/MPMC queues and the canonical bounded-queue designs.
- Paul E. McKenney, [*Is Parallel Programming Hard, And, If So, What Can You Do About It?*](https://mirrors.edge.kernel.org/pub/linux/kernel/people/paulmck/perfbook/perfbook.html) — memory ordering, RCU, hazard pointers, the full theory.
- [The LMAX Disruptor technical paper](https://lmax-exchange.github.io/disruptor/disruptor.html) — the productized cache-aware ring-buffer pattern.
- Herb Sutter, ["atomic<> Weapons" talk overview](https://herbsutter.com/2013/02/11/atomic-weapons-the-c-memory-model-and-modern-hardware/) — the C++ memory model and hardware, from the source.
- Jeff Preshing, [An Introduction to Lock-Free Programming](https://preshing.com/20120612/an-introduction-to-lock-free-programming/) — acquire/release intuition done very clearly.

## Videos

- Herb Sutter — **"atomic<> Weapons: The C++ Memory Model and Modern Hardware"** ([search](https://www.youtube.com/results?search_query=Herb+Sutter+atomic+weapons+C%2B%2B+memory+model)).
- CppCon — Fedor Pikus, **"Lock-free programming / The Speed of Concurrency"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+lock+free+concurrency)).
- CppCon — **SPSC queue / LMAX Disruptor in C++** ([search](https://www.youtube.com/results?search_query=CppCon+SPSC+lock+free+ring+buffer+disruptor)).
