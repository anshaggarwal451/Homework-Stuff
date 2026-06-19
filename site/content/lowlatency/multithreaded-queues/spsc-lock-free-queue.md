# SPSC Lock-Free Queue

> **Why a quant dev must own this:** This is the single most important data
> structure in low-latency C++. A correctly built single-producer/single-
> consumer ring buffer hands a message from one core to another in **tens of
> nanoseconds**, with no lock, no syscall, and no allocation. It's the wire
> between your feed handler and your strategy, between strategy and order
> gateway. Erik Rigtorp's `SPSCQueue` is the reference implementation, and the
> reasoning behind it — acquire/release ordering, cached indices, cache-line
> padding — is the bar an HFT interview holds you to.

## Problem statement

Build a **wait-free, bounded** queue for **exactly one producer thread and
exactly one consumer thread**, with **no locks**. API:

```cpp
bool push(const T& v);   // producer: enqueue; false if full
bool pop(T& out);        // consumer: dequeue; false if empty
```

No blocking, no mutex, no condition variable. When full, `push` fails; when
empty, `pop` fails — the caller decides whether to spin, back off, or do other
work. The queue is a fixed-size ring buffer.

Standard: **C++17** (`std::hardware_destructive_interference_size` is C++17; the
code is otherwise plain C++11 atomics).

## Clarifying constraints and assumptions

- **Strictly SPSC.** One producer, one consumer, *forever*. This is the entire
  reason we can be lock-free with only plain loads/stores plus two atomics — no
  CAS, no retry loop. Break SPSC and the code is simply wrong (a data race).
- **Bounded ring buffer.** Fixed capacity set at construction. No allocation on
  `push`/`pop`. We store one extra slot (capacity + 1) so we can distinguish
  full from empty without a separate count — the writer never catches the reader
  exactly.
- **The producer only writes `writeIdx_` and reads `readIdx_`; the consumer only
  writes `readIdx_` and reads `writeIdx_`.** That asymmetry is what makes the
  whole thing safe with acquire/release.
- **`T` is trivially relocatable / cheaply movable** in practice (it's a POD
  message most of the time). The reference impl copies; a move overload is a
  trivial extension.

## Approach: head/tail atomics with acquire/release

The model is a producer index (`writeIdx_`) and a consumer index (`readIdx_`)
walking a circular buffer:

```text
 capacity = 4  (we allocate 5 slots so full != empty ambiguity is avoided)

    slot:   0     1     2     3     4
          [ A ] [ B ] [   ] [   ] [   ]
            ^read           ^write
   readIdx_ = 0 (next to pop)   writeIdx_ = 2 (next to push)

 empty :  readIdx_ == writeIdx_
 full  :  (writeIdx_ + 1) % cap == readIdx_   (one slot always left unused)
```

The correctness rests on the **acquire/release** discipline (the heart of the
lesson):

- The producer **writes the data** into `slots_[w]`, then **`store`s the new
  `writeIdx_` with `memory_order_release`**. The release store publishes *all*
  prior writes (including the data) to any thread that later does an *acquire*
  load of `writeIdx_`.
- The consumer **`load`s `writeIdx_` with `memory_order_acquire`**. If it sees
  the new index, the acquire load *synchronizes-with* the producer's release
  store, which guarantees the data write is visible **before** it reads the slot.
- Symmetrically for `readIdx_`: consumer releases it, producer acquires it, so
  the producer knows a slot is truly free before overwriting.

> **The one-sentence mental model:** *release = "everything I wrote before this
> is now publishable"; acquire = "everything published before the value I just
> read is now visible to me."* The index is the flag; the data rides along
> behind it. This is the textbook release/acquire **message-passing** pattern,
> applied to a ring buffer.

Why not `seq_cst`? Sequential consistency would also be correct but inserts full
memory barriers (an `MFENCE` / `xchg` on x86 for the store side) you don't need.
Acquire/release is the *minimal* ordering that makes the data-before-index
guarantee hold. On x86-64, acquire/release loads and stores are *already* plain
`mov` instructions (the hardware is strongly ordered) — so the win is also that
the compiler doesn't insert a needless barrier. On ARM/AArch64 the distinction
is real silicon (`ldar`/`stlr` vs full `dmb`).

## Complexity and progress guarantees

- `push` / `pop`: **O(1)**, a handful of instructions. No loop, no retry.
- **Progress: wait-free.** Both operations complete in a bounded number of steps
  regardless of the other thread's scheduling — strictly stronger than
  lock-free. There is no CAS and no spin *inside* the operation. (The *caller*
  may choose to spin when the queue is full/empty, but the queue op itself is
  wait-free.)
- Space: **O(N)**, allocated once.

## A complete, annotated C++17 reference implementation

This follows Erik Rigtorp's `SPSCQueue` design: cache-line padding to kill false
sharing, and **cached copies** of the other thread's index to avoid expensive
cross-core loads.

```cpp
#include <atomic>
#include <cstddef>
#include <memory>
#include <new>        // std::hardware_destructive_interference_size (C++17)
#include <utility>
#include <vector>

#if defined(__cpp_lib_hardware_interference_size)
inline constexpr std::size_t kCacheLine =
    std::hardware_destructive_interference_size;     // 64 on x86-64
#else
inline constexpr std::size_t kCacheLine = 64;
#endif

// Wait-free SPSC ring buffer. Exactly one producer thread, one consumer thread.
template <class T>
class SpscQueue {
    const std::size_t capacity_;       // usable capacity + 1 sentinel slot
    std::vector<T>    slots_;          // size == capacity_ (one slot wasted)

    // --- Producer-owned and consumer-owned indices, each on its OWN line ---
    // writeIdx_ is written by the producer, read by the consumer.
    // readIdx_  is written by the consumer, read by the producer.
    // Putting them on separate cache lines stops the producer's writeIdx_ store
    // from invalidating the consumer's cache line (false sharing).
    alignas(kCacheLine) std::atomic<std::size_t> writeIdx_{0};
    // Cached copy of readIdx_, touched ONLY by the producer. Lets push() avoid
    // loading the consumer's (remote, frequently-dirtied) cache line every time.
    alignas(kCacheLine) std::size_t              writeIdxCachedRead_{0};

    alignas(kCacheLine) std::atomic<std::size_t> readIdx_{0};
    // Cached copy of writeIdx_, touched ONLY by the consumer.
    alignas(kCacheLine) std::size_t              readIdxCachedWrite_{0};

    // Pad the tail so the next object in memory can't false-share with us.
    char padding_[kCacheLine - sizeof(std::size_t)]{};

public:
    explicit SpscQueue(std::size_t capacity)
        : capacity_(capacity + 1), slots_(capacity + 1) {
        // +1 sentinel slot: full state is (write+1)%cap == read, so the buffer
        // is never *exactly* filled, which keeps empty (write==read) distinct.
    }

    SpscQueue(const SpscQueue&)            = delete;
    SpscQueue& operator=(const SpscQueue&) = delete;

    // PRODUCER ONLY. Returns false if the queue is full.
    bool push(const T& value) {
        // Relaxed: only the producer writes writeIdx_, so its own value is
        // trivially up to date — no synchronisation needed to read our own.
        const std::size_t w = writeIdx_.load(std::memory_order_relaxed);
        std::size_t next = w + 1;
        if (next == capacity_) next = 0;       // wrap

        // Full check against the CACHED read index first (cheap, local).
        if (next == writeIdxCachedRead_) {
            // Cache says full — refresh from the real (remote) readIdx_ ONCE.
            // acquire: synchronise with the consumer's release of readIdx_, so
            // we know the slot it freed is genuinely safe to reuse.
            writeIdxCachedRead_ = readIdx_.load(std::memory_order_acquire);
            if (next == writeIdxCachedRead_)
                return false;                  // genuinely full
        }

        slots_[w] = value;                     // 1) write the data
        // 2) PUBLISH: release store makes the data write above visible to a
        //    consumer that acquire-loads this new index.
        writeIdx_.store(next, std::memory_order_release);
        return true;
    }

    // CONSUMER ONLY. Returns false if the queue is empty; result in `out`.
    bool pop(T& out) {
        const std::size_t r = readIdx_.load(std::memory_order_relaxed);

        // Empty check against the CACHED write index first (cheap, local).
        if (r == readIdxCachedWrite_) {
            // Cache says empty — refresh from the real (remote) writeIdx_ ONCE.
            // acquire: synchronise-with the producer's release of writeIdx_, so
            // the data it wrote is visible before we read the slot below.
            readIdxCachedWrite_ = writeIdx_.load(std::memory_order_acquire);
            if (r == readIdxCachedWrite_)
                return false;                  // genuinely empty
        }

        out = std::move(slots_[r]);            // read the published data
        std::size_t next = r + 1;
        if (next == capacity_) next = 0;       // wrap
        // PUBLISH the freed slot: release store so the producer's acquire load
        // of readIdx_ sees that we are done reading slots_[r].
        readIdx_.store(next, std::memory_order_release);
        return true;
    }
};
```

### Why the cached indices matter (the rigtorp insight)

Naively, `push` would `acquire`-load `readIdx_` *every call*. But `readIdx_` is
written by the *consumer* on another core — reading it pulls that cache line
across the interconnect and, worse, the consumer keeps dirtying it, so the
producer's copy is constantly invalidated. That cross-core load can cost ~tens
of nanoseconds — dominating an operation that should be a few ns.

The fix: the producer keeps a **private, non-atomic cached copy**
(`writeIdxCachedRead_`) of where it last saw the consumer. It only re-reads the
real `readIdx_` when its cache says the queue is full. While there's room, it
never touches the remote line at all. The consumer mirrors this with
`readIdxCachedWrite_`. In steady state — queue neither full nor empty — *neither
thread reads the other's hot index*, and the two cores stop fighting over those
cache lines. Rigtorp's benchmarks show this roughly doubles throughput. This is
the part interviewers love, because it shows you think in cache lines, not just
in atomics.

### Why the cache-line padding

`writeIdx_` (producer-written) and `readIdx_` (consumer-written) must live on
**different** cache lines. If they shared one, every producer store to
`writeIdx_` would invalidate the line in the consumer's cache and vice versa —
**false sharing** — turning two independent variables into a contended one.
`alignas(std::hardware_destructive_interference_size)` (64 bytes on x86-64)
guarantees the separation. The trailing `padding_` protects against false
sharing with whatever object the allocator places right after the queue.

## Performance and hardware reality

```text
 Operation                         approx cost
 ───────────────────────────────   ───────────────────────────
 same-core L1 hit                   ~4-5 cycles (~1-2 ns)
 cross-core cache line transfer     ~tens of ns (L3 / snoop)
 push()/pop() steady state          a few ns (all-local, cached idx)
 push()/pop() naive (remote load)   dominated by the cross-core load
 mutex sleep/wake (futex)           microseconds — 100-1000x worse
```

On **x86-64**, `load(acquire)` and `store(release)` compile to plain `mov` — the
TSO memory model already forbids the reorderings acquire/release prohibit, so
there is **no fence instruction**. The atomics are "free" at the instruction
level; their job is to constrain the *compiler* (block reordering and CSE) and
document intent. On **AArch64** they become `ldar`/`stlr`, which *are* distinct
(cheaper) than the full `dmb ish` barrier `seq_cst` would force — so using
acquire/release rather than `seq_cst` is a real saving there.

## Follow-up variations interviewers ask

- **"Why acquire/release and not relaxed everywhere?"** Relaxed gives no
  happens-before edge between the data write and the index publish — the
  consumer could see the new index but stale slot data. Acquire/release is the
  minimum that pairs the data with its flag.
- **"Why not `seq_cst`?"** Correct but over-strong: needless full barriers,
  measurable on ARM, and it signals you don't understand the minimum ordering.
- **"Where's the +1 slot and why?"** It keeps full (`(w+1)%cap == r`) distinct
  from empty (`w == r`) without an extra atomic counter.
- **"Add `emplace` / move / batch push."** Natural extensions; batch amortises
  the release store over many writes.
- **"Make it blocking."** Wrap with a CV (back to the blocking SPSC lesson) — but
  now you've reintroduced the syscall you were avoiding. Usually you'd rather the
  caller spin briefly with `_mm_pause()` / `std::this_thread::yield()`.
- **"Now MPSC / MPMC."** Multiple producers can't just `store` the index — they'd
  clobber each other. You need `fetch_add`/CAS on the index and per-slot
  sequence numbers (Vyukov). See the MPSC and array-based MPSC lessons.
- **"`false`-sharing — prove it's gone."** Show the `alignas` and the separate
  cached indices; mention `perf c2c` to measure it.

## Key takeaways

1. SPSC lock-free = a **bounded ring buffer** with a producer index and a
   consumer index; **no lock, no syscall, no allocation, wait-free O(1)**.
2. **Acquire/release is the core:** the producer **release**-stores `writeIdx_`
   *after* writing data; the consumer **acquire**-loads it *before* reading data.
   The index is the flag; data rides behind it (message passing).
3. Each thread reads its *own* index **relaxed** (it's the only writer) and the
   *other* index **acquire**.
4. **Cached copies** of the other thread's index avoid cross-core loads in steady
   state — roughly a 2x throughput win (the rigtorp trick).
5. **Cache-line-pad** `writeIdx_` and `readIdx_` apart with
   `alignas(hardware_destructive_interference_size)` to kill false sharing; pad
   the tail too.
6. On **x86-64** acquire/release are plain `mov`s (free); on **AArch64** they are
   real but cheaper than the `seq_cst` barrier — so prefer acquire/release.

## Self-check

1. The producer writes data then release-stores `writeIdx_`. If you changed that
   store to `memory_order_relaxed`, what specific bug appears, and on which
   architecture would you actually observe it?
2. Why may the producer load *its own* `writeIdx_` with `relaxed` but must load
   `readIdx_` with `acquire`?
3. Explain the cached-index optimisation: what remote operation does it
   eliminate, and in which queue states does the cache get refreshed?
4. Why allocate `capacity + 1` slots? Give the full and empty predicates.
5. Two `writeIdx_`/`readIdx_` are on the same cache line. Name the phenomenon and
   the one annotation that fixes it.
6. On x86-64 the acquire/release loads/stores emit no fence. So what work are the
   memory orders actually doing for you on that platform?

## Further reading

- Erik Rigtorp, ["A single-producer single-consumer lock-free queue (`SPSCQueue`)"](https://rigtorp.se/ringbuffer/) — *the* reference: cached indices, padding, benchmarks. Read it twice; the code here mirrors it.
- Erik Rigtorp, [`rigtorp/SPSCQueue` on GitHub](https://github.com/rigtorp/SPSCQueue) — the production-quality header.
- Jeff Preshing, ["Acquire and Release Semantics"](https://preshing.com/20120913/acquire-and-release-semantics/) and ["The Synchronizes-With Relation"](https://preshing.com/20130823/the-synchronizes-with-relation/) — the clearest explanation of the exact ordering this queue relies on.
- [`std::memory_order` — cppreference](https://en.cppreference.com/w/cpp/atomic/memory_order) — the formal acquire/release definitions.
- Anthony Williams, *C++ Concurrency in Action*, 2nd ed., Ch. 5 (the memory model) and Ch. 7 — the SPSC lock-free queue from first principles.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — the false-sharing constant.

## Videos

- Herb Sutter — **"atomic<> Weapons: The C++ Memory Model and Modern Hardware"** ([search](https://www.youtube.com/results?search_query=Herb+Sutter+atomic+weapons+memory+model)) — the definitive talk on acquire/release/seq_cst and what the hardware does.
- Fedor Pikus — **"C++ atomics, from basic to advanced"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+C%2B%2B+atomics+basic+to+advanced)) — builds exactly this kind of lock-free SPSC reasoning.
- Timur Doumler — **"Want fast C++? Know your hardware!"** ([search](https://www.youtube.com/results?search_query=Timur+Doumler+want+fast+C%2B%2B+know+your+hardware)) — cache lines, false sharing, why the cached-index trick matters.
