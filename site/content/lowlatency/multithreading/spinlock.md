# Spinlock

> **Why a quant dev must own this:** When your critical section is a handful of
> instructions and you cannot afford a syscall, you don't block — you **spin**.
> A spinlock keeps the waiting thread burning CPU in userspace, so the moment
> the lock frees it grabs it with nanosecond latency, no context switch, no
> scheduler jitter. This is exactly the trade HFT makes on a dedicated, pinned
> core. But a *naive* spinlock is a cache-coherence disaster, and the difference
> between the textbook version and the right one (test-and-test-and-set,
> `PAUSE`, backoff, correct false-sharing layout) is a favourite hard interview
> question.

*Standard: C++17/20. Uses `std::atomic`, `_mm_pause()` (x86 intrinsic), and `std::hardware_destructive_interference_size` (C++17).*

## What a spinlock is, and when to use one

A spinlock is mutual exclusion implemented by **busy-waiting**: a thread loops
on an atomic flag until it can acquire it, rather than sleeping. The entire
operation stays in userspace.

The trade against a `std::mutex`:

| | Spinlock | `std::mutex` (futex) |
|---|---|---|
| Waiter behaviour | Burns CPU spinning | Sleeps (yields the core) |
| Acquire latency (contended) | ~ns (no syscall) | ~µs (futex syscall + context switch) |
| Wastes CPU while waiting | **Yes** | No |
| Right when… | Critical section is **tiny**, contention is **low**, and you have a **spare/pinned core** | Critical section is long, or the system is oversubscribed |

> **Rule of thumb:** spin only if the expected wait is shorter than the
> ~1–5 µs a context switch costs, *and* you can afford to burn a core. If the
> holder might sleep, do I/O, or be descheduled, **never spin** — you'll burn a
> core waiting on a thread that isn't even running (the *spinning-on-a-
> preempted-holder* catastrophe). This is why you generally only spin on a
> dedicated, pinned, isolated core.

## The naive (wrong-ish) version: test-and-set

The simplest correct-but-slow spinlock hammers an atomic `exchange`
(test-and-set) in a tight loop:

```cpp
#include <atomic>

class TASLock {                       // test-and-set spinlock — CORRECT but inefficient
    std::atomic<bool> locked_{false};
public:
    void lock() {
        // exchange returns the OLD value; if it was already true, keep trying
        while (locked_.exchange(true, std::memory_order_acquire)) {
            // spin: every iteration is a LOCKED write -> see problem below
        }
    }
    void unlock() {
        locked_.store(false, std::memory_order_release);  // release publishes the crit. section
    }
};
```

The bug isn't correctness — the `acquire`/`release` pairing is right. It's
**performance under contention**: `exchange` is a `LOCK`-prefixed *write*, so
every spinning thread repeatedly **writes** the cache line. Each write forces
the line into that core's cache in Modified state, **invalidating it in every
other core** (MESI). With N spinners the line ping-pongs continuously — a
cache-coherence storm that also starves the actual holder trying to write
`unlock`.

## The right version: test-and-test-and-set (TTAS)

The fix: **spin on a read, only attempt the write when the read says you might
win.** A read leaves the line in Shared state — all spinners can read it from
their own cache with no coherence traffic — and you only issue the expensive
`LOCK exchange` when you observe the lock is free.

```cpp
#include <atomic>
#if defined(__x86_64__) || defined(_M_X64)
  #include <immintrin.h>   // _mm_pause
#endif

inline void cpu_relax() {
#if defined(__x86_64__) || defined(_M_X64)
    _mm_pause();            // x86 PAUSE: hint to the CPU we're in a spin-wait
#elif defined(__aarch64__)
    asm volatile("yield");  // ARM YIELD
#endif
}

class TTASLock {            // test-and-test-and-set spinlock
    std::atomic<bool> locked_{false};
public:
    void lock() {
        for (;;) {
            // 1) try once
            if (!locked_.exchange(true, std::memory_order_acquire))
                return;                                   // got it
            // 2) then SPIN ON A READ (cheap, line stays Shared) until it looks free
            while (locked_.load(std::memory_order_relaxed))
                cpu_relax();                              // PAUSE while waiting
        }
    }
    bool try_lock() {
        return !locked_.load(std::memory_order_relaxed)
            && !locked_.exchange(true, std::memory_order_acquire);
    }
    void unlock() {
        locked_.store(false, std::memory_order_release);
    }
};
```

This is essentially Erik Rigtorp's recommended spinlock. Two ingredients make it
good: **read-spin (TTAS)** to avoid coherence storms, and **`_mm_pause()`** in
the spin body.

## `_mm_pause()` / the `PAUSE` instruction — why it matters

`PAUSE` (the `_mm_pause()` intrinsic, also `__builtin_ia32_pause`) is a hint to
the CPU that the current loop is a spin-wait. It earns its keep three ways:

1. **Avoids a memory-order-violation pipeline flush.** Without it, the CPU
   speculatively executes many loads of the lock variable; when the value
   finally changes, the speculation is wrong and the pipeline is flushed —
   a heavy penalty *exactly* at the moment you acquire. `PAUSE` throttles the
   speculation.
2. **Saves power / frees SMT resources.** On a hyper-threaded core, a busy
   sibling thread starves the other logical thread; `PAUSE` de-prioritizes the
   spinner so the *holder* (possibly on the sibling thread) runs faster.
3. **Reduces coherence traffic.** It inserts a short, microarchitecture-defined
   delay (tens of cycles on modern Intel, historically growing) between
   iterations.

Forgetting `PAUSE` in a spin loop is one of the most common HFT code-review
catches.

## Exponential backoff

Under heavy contention even a TTAS lock benefits from **backing off**: spin a
little, and if you keep failing, `PAUSE` progressively more before the next
attempt. This spreads out the retry attempts so they don't all collide on the
cache line simultaneously.

```cpp
void lock_with_backoff(std::atomic<bool>& locked_) {
    int delay = 1;
    while (locked_.exchange(true, std::memory_order_acquire)) {
        // back off: PAUSE an exponentially growing number of times (capped)
        for (int i = 0; i < delay; ++i) cpu_relax();
        if (delay < 1024) delay *= 2;          // cap the backoff
        // (a TTAS read-spin can be layered in here too)
    }
}
```

Backoff trades a little latency-when-uncontended for far better behaviour under
a thundering herd. Tune the cap; too much backoff hurts the fast path.

## The fairness problem and the ticket lock

A TAS/TTAS lock is **unfair**: which waiter wins next is arbitrary (whoever's
`exchange` happens to land first), so a thread can starve, and tail latency is
unpredictable — bad for p99.99. A **ticket lock** fixes fairness with two
counters, like a deli queue: you take a ticket, then spin until "now serving"
reaches your number. FIFO, no starvation.

```cpp
#include <atomic>

class TicketLock {                       // fair FIFO spinlock
    std::atomic<unsigned> next_{0};      // next ticket to hand out
    std::atomic<unsigned> serving_{0};   // ticket currently being served
public:
    void lock() {
        unsigned my = next_.fetch_add(1, std::memory_order_relaxed);  // take a ticket
        while (serving_.load(std::memory_order_acquire) != my)
            cpu_relax();                                              // wait my turn
    }
    void unlock() {
        serving_.store(serving_.load(std::memory_order_relaxed) + 1,
                       std::memory_order_release);                    // call next ticket
    }
};
```

Ticket locks give predictable, fair latency but still have all waiters spinning
on one `serving_` line (a coherence cost). Production-grade fair spinlocks
(MCS, CLH) give each waiter its *own* cache line to spin on, eliminating that —
worth knowing the names.

## False sharing: lay the lock out correctly

A spinlock word is the single hottest, most-contended cache line in your
program. If anything *else* unrelated shares its 64-byte cache line, every lock
operation needlessly bounces that neighbour's data between cores — **false
sharing**. Pad the lock to own its cache line:

```cpp
#include <new>       // std::hardware_destructive_interference_size (C++17)
#include <atomic>

#ifdef __cpp_lib_hardware_interference_size
  constexpr std::size_t CL = std::hardware_destructive_interference_size; // usually 64
#else
  constexpr std::size_t CL = 64;
#endif

struct alignas(CL) PaddedSpinLock {   // occupies its own cache line
    std::atomic<bool> locked_{false};
    char pad_[CL - sizeof(std::atomic<bool>)];   // keep neighbours off this line
    // ... lock()/unlock() as TTASLock ...
};
```

`alignas(64)` plus padding guarantees the lock word doesn't share a line with
adjacent fields. (False sharing gets its own full lesson; here just remember the
lock variable must be isolated.)

## Cost model

```text
operation                                    rough cost
-------------------------------------------- ----------------------------------
uncontended spinlock acquire+release         ~15-30 ns (one LOCK exchange + a store)
contended TAS (write-spin) per iteration     bounces the line: tens-hundreds ns EACH
contended TTAS (read-spin) per iteration     cheap: read from local cache (Shared)
PAUSE                                        ~tens of cycles delay (uarch-defined)
context switch you AVOID by spinning         ~1-5 microseconds
```

The whole point: a spinlock's acquire is ~ns vs a mutex's ~µs contended path —
*if* you spin briefly. Spin too long, or on a preempted holder, and you waste an
entire core for microseconds-to-milliseconds, far worse than blocking.

## Quant/HFT relevance & interview gotchas

- **"Write a correct, efficient spinlock."** Start with TAS, *immediately*
  upgrade to **TTAS + `_mm_pause`** and explain the cache-coherence reason. The
  naive write-spin is the trap they want you to avoid.
- **`_mm_pause()` / `PAUSE`** must be in the spin body — explain the pipeline-
  flush and SMT reasons, not just "it saves power."
- **Spin vs mutex decision:** spin only for *tiny* critical sections, *low*
  contention, on a *dedicated/pinned* core, where the holder won't be
  descheduled. Spinning on a preempted holder burns a core for nothing.
- **Fairness / ticket lock:** TAS is unfair and can starve; ticket/MCS locks
  give FIFO fairness and predictable tail latency — name-drop MCS/CLH for the
  per-waiter-cache-line refinement.
- **False sharing:** the lock word must `alignas(64)` and be padded to own its
  cache line, or it drags neighbours into the coherence storm.
- **Memory ordering:** `lock` is an **acquire**, `unlock` is a **release** —
  exactly the pairing that publishes the critical section. Getting this wrong is
  a silent correctness bug (and on x86 it'll *look* fine while being wrong on
  ARM).
- **Don't use a spinlock under oversubscription** — if there are more runnable
  threads than cores, the holder may be sleeping while you spin.

## Key takeaways

1. A spinlock **busy-waits in userspace**: ~ns contended-acquire latency, no
   syscall, no context switch — but it **burns a core** while waiting.
2. Use one only for a **tiny critical section, low contention, on a
   dedicated/pinned core** where the holder won't be descheduled. Otherwise a
   `std::mutex` is correct.
3. **Test-and-test-and-set (TTAS)** — spin on a *read*, only `exchange` when the
   read shows the lock free — avoids the cache-coherence storm that a naive
   write-spinning TAS lock causes.
4. Put **`_mm_pause()`/`PAUSE`** in the spin body (avoids the speculation
   pipeline-flush, frees SMT resources); add **exponential backoff** under heavy
   contention.
5. TAS/TTAS are **unfair** (starvation, jittery tail latency); a **ticket lock**
   gives FIFO fairness, and **MCS/CLH** locks give each waiter its own
   spin line.
6. The lock word is the hottest line in the program — **`alignas(64)` and pad
   it** to prevent false sharing. `lock` = acquire, `unlock` = release.

## Self-check

1. Why does a naive `exchange`-in-a-loop spinlock scale badly, and how does TTAS
   fix it? Explain in terms of MESI states.
2. Give three distinct things `_mm_pause()` does for a spin loop.
3. Under what exact conditions should you spin instead of using a mutex? When is
   spinning catastrophically wrong?
4. What problem does a ticket lock solve that a TTAS lock doesn't, and what cost
   does it still pay that MCS avoids?
5. Why must the lock variable be `alignas(64)` and padded?
6. Which memory orders go on `lock()` and `unlock()`, and what would go wrong
   with `relaxed` (and why might the bug hide on x86)?

## Further reading

- Erik Rigtorp — ["Correctly implementing a spinlock in C++"](https://rigtorp.se/spinlock/) — the definitive practical writeup: TTAS, `_mm_pause`, benchmarks, and the cache-coherence reasoning. Read this.
- [`std::atomic_flag` — cppreference](https://en.cppreference.com/w/cpp/atomic/atomic_flag) — the guaranteed-lock-free flag (`test_and_set`/`clear`, C++20 `test`).
- [`_mm_pause` / `PAUSE`](https://www.intel.com/content/www/us/en/docs/intrinsics-guide/index.html#text=_mm_pause) — Intel Intrinsics Guide; and the SDM entry on `PAUSE`.
- [`std::hardware_destructive_interference_size` — cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size).
- Mellor-Crummey & Scott — ["Algorithms for Scalable Synchronization on Shared-Memory Multiprocessors"](https://www.cs.rochester.edu/~scott/papers/1991_TOCS_synch.pdf) — the original MCS lock paper.
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — §5.2.2 builds a spinlock from `std::atomic_flag`.

## Videos

- Fedor Pikus — **"The Speed of Concurrency: Is Lock-free Faster?"** (CppCon) ([search](https://www.youtube.com/results?search_query=Fedor+Pikus+The+Speed+of+Concurrency+is+lock+free+faster)) — measures spinlocks vs mutexes vs lock-free under contention.
- Carl Cook — **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** (CppCon) ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why HFT spins on pinned cores.
