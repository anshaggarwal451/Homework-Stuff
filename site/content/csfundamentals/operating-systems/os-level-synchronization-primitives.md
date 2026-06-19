# OS-Level Synchronization Primitives

> **Why a quant dev must own this:** The moment two threads touch the same data
> you need synchronization — and *every synchronization primitive is a potential
> trip into the kernel and a potential context switch.* In an HFT system,
> contention on a hot lock can inject microseconds of jitter and serialise the
> very threads you parallelised. Knowing how a mutex is *actually built* — and
> when a cheap atomic spin beats a kernel sleep — is what lets you keep the
> critical path lock-light and predictable.

## First principles: what these primitives buy you

Concurrency bugs come from two needs:

- **Mutual exclusion** — only one thread in a critical section at a time
  (mutexes, spinlocks).
- **Coordination / signalling** — threads waiting until a condition holds
  (condition variables, semaphores, barriers).

Every primitive is some combination of: an atomic test on a shared word, and a
way to *block* (sleep) when you can't proceed so you don't burn the CPU. The art
is the trade-off between **spinning** (cheap, wastes cycles) and **sleeping**
(frees the CPU, costs a context switch). HFT lives at that fault line.

## The toolbox

| Primitive | Guarantees | Blocks how | Typical use |
|---|---|---|---|
| **Mutex** | Mutual exclusion, ownership | Sleeps (via futex) | Protect a critical section |
| **Spinlock** | Mutual exclusion | Busy-waits (no sleep) | Very short sections on dedicated cores |
| **Condition variable** | Wait for a predicate | Sleeps until signalled | Producer/consumer handoff |
| **Semaphore** | Count of permits | Sleeps when count 0 | Bounded resources, signalling |
| **Read-write lock** | Many readers XOR one writer | Sleeps | Read-mostly data |
| **Barrier** | All N threads rendezvous | Sleeps until all arrive | Phase synchronization |

## How a mutex is really built: the futex

This is the question that separates people who *use* `std::mutex` from people who
*understand* it. A Linux mutex (NPTL `pthread_mutex_t`, and `std::mutex` on top
of it) is **not** a syscall per lock. It's built on the **futex** — "fast
userspace mutex" — and the key insight is the **two-path design**:

- **Fast (uncontended) path — pure userspace, no kernel.** The lock state is an
  `int` in shared memory. To lock, you do an atomic compare-and-swap (CAS):
  flip it from `0` (free) to `1` (held). If it was free, you got it — **no
  syscall, ~tens of cycles.** Unlock is an atomic store back to `0`.
- **Slow (contended) path — into the kernel.** Only if the CAS *fails* (someone
  holds it) do you call `futex(2)` with `FUTEX_WAIT`, which parks the thread on a
  kernel wait queue keyed by that address. When the owner unlocks, if anyone is
  waiting it calls `futex(FUTEX_WAKE)` to rouse a sleeper.

```text
lock():
   if CAS(state, 0 -> 1) succeeds:   return            # FAST: userspace only
   else:                                                # CONTENDED
       set state to "locked+waiters"
       futex(&state, FUTEX_WAIT, ...)   # SYSCALL: sleep in kernel

unlock():
   store state = 0
   if there were waiters:
       futex(&state, FUTEX_WAKE, 1)     # SYSCALL: wake one sleeper
```

```cpp
#include <linux/futex.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <atomic>
#include <climits>

// Thin futex wrappers — glibc has no direct futex() wrapper, so go via syscall().
static int futex_wait(std::atomic<int>* a, int expected) {
    return syscall(SYS_futex, a, FUTEX_WAIT_PRIVATE, expected, nullptr, nullptr, 0);
}
static int futex_wake(std::atomic<int>* a, int n) {
    return syscall(SYS_futex, a, FUTEX_WAKE_PRIVATE, n, nullptr, nullptr, 0);
}

// A minimal mutex: fast path in userspace, slow path sleeps in the kernel.
struct FutexMutex {
    std::atomic<int> state{0};            // 0 = free, 1 = held
    void lock() {
        int expected = 0;
        // Fast path: try to grab it with no kernel involvement.
        if (state.compare_exchange_strong(expected, 1, std::memory_order_acquire))
            return;
        // Contended: spin a little, then sleep.
        do {
            // FUTEX_WAIT only sleeps if *state still == 1, closing the race.
            futex_wait(&state, 1);
            expected = 0;
        } while (!state.compare_exchange_strong(expected, 1,
                                                std::memory_order_acquire));
    }
    void unlock() {
        state.store(0, std::memory_order_release);
        futex_wake(&state, 1);            // wake one waiter (if any)
    }
};
```

(Real glibc mutexes are more careful — three-state to avoid waking when there are
no waiters, optional spinning, robust/PI variants — but this is the essence.
Drepper's "Futexes Are Tricky" walks the full state machine; the subtle races
around `FUTEX_WAIT`'s compare-and-block are exactly why you don't roll your own
in production.)

**Why this design is brilliant for performance:** in the common, *uncontended*
case a lock costs a single atomic op and never enters the kernel. You only pay
the ~hundreds-of-ns syscall + context switch when there's *actual* contention —
which in a well-designed system is rare.

## Spinlock vs mutex: the core trade-off

A **spinlock** never sleeps — it loops on an atomic until the lock frees:

```cpp
#include <atomic>
#include <immintrin.h>   // _mm_pause

class Spinlock {
    std::atomic_flag flag = ATOMIC_FLAG_INIT;
public:
    void lock() {
        // test-and-test-and-set: spin on a plain load first to avoid hammering
        // the cache line with RMW traffic while we wait.
        while (flag.test_and_set(std::memory_order_acquire)) {
            while (flag.test(std::memory_order_relaxed))   // C++20 atomic_flag::test
                _mm_pause();                                // PAUSE: hint to CPU,
                                                            // ease SMT/bus, cut power
        }
    }
    void unlock() { flag.clear(std::memory_order_release); }
};
```

The rule of thumb: **spin if the expected wait is shorter than a context switch
(~1 µs); sleep otherwise.** Spinning wastes CPU but avoids the
switch+cold-restart tail. Sleeping frees the CPU but costs two syscalls and a
context switch. Critically:

- A spinlock on a core that *also runs the lock holder* can **livelock** the box
  — the spinner monopolises the CPU the holder needs to make progress. Spinlocks
  in userspace are only safe when the holder runs on a *different* core (or, in
  HFT, on a dedicated core that never gets preempted).
- The `PAUSE` instruction (`_mm_pause`) is mandatory in a spin loop: it tells the
  CPU you're in a spin-wait so it can avoid memory-order mis-speculation
  penalties, yield the SMT sibling's pipeline, and save power.

**Adaptive mutexes** (`PTHREAD_MUTEX_ADAPTIVE_NP`, and glibc's default spin
count) blend the two: spin briefly hoping the holder releases quickly, then fall
back to a futex sleep. Best of both for medium contention.

## Condition variables: the lost-wakeup trap

A condition variable lets a thread sleep until *another* thread signals that some
**predicate** became true. The two non-negotiable rules trip up almost everyone:

1. **A CV is always paired with a mutex**, and you must hold that mutex when you
   wait and when you change the predicate.
2. **You must re-check the predicate in a loop**, not an `if` — because of
   *spurious wakeups* and the *lost-wakeup* race.

```cpp
#include <mutex>
#include <condition_variable>
#include <queue>

std::mutex m;
std::condition_variable cv;
std::queue<int> q;
bool done = false;

void producer(int v) {
    {
        std::lock_guard<std::mutex> lk(m);   // hold mutex while mutating predicate
        q.push(v);
    }                                        // release BEFORE notify (less contention)
    cv.notify_one();
}

void consumer() {
    std::unique_lock<std::mutex> lk(m);
    // Predicate-loop overload: atomically unlocks, sleeps, re-locks, re-checks.
    // This is equivalent to: while (q.empty() && !done) cv.wait(lk);
    cv.wait(lk, [] { return !q.empty() || done; });
    if (!q.empty()) { int v = q.front(); q.pop(); /* use v */ }
}
```

**Why the loop and the held mutex matter (the lost-wakeup race):** suppose the
consumer checks the queue (empty), then — before it sleeps — the producer pushes
and signals. If the consumer then sleeps, the signal is *lost* and it waits
forever. `cv.wait(lk, pred)` closes this race: it atomically releases the mutex
*and* enters the wait as one operation, so a signal can't slip in between the
check and the sleep. Holding the mutex while you change the predicate *and*
signal is what makes that atomicity meaningful. Under the hood `wait()` uses a
futex; `notify` is a `FUTEX_WAKE`.

> **Interview gotcha:** "Why does `cv.wait` take a predicate?" — to handle
> spurious wakeups (the kernel may wake you with no signal) *and* to close the
> lost-wakeup window. "Why hold the mutex while signalling?" — to serialise the
> predicate change with the waiter's check.

## Semaphores and barriers (C++20)

A **counting semaphore** is a permit counter: `acquire()` decrements (blocking at
0), `release()` increments and wakes a waiter. C++20 standardised them:

```cpp
#include <semaphore>
std::counting_semaphore<4> slots{4};   // 4 permits: bound concurrency to 4
void worker() {
    slots.acquire();                   // blocks if all 4 in use
    /* ... use bounded resource ... */
    slots.release();
}
std::binary_semaphore signal{0};       // 0/1: a one-shot signalling latch
```

A **barrier** (`std::barrier`, C++20) makes N threads rendezvous: each calls
`arrive_and_wait()` and none proceeds until all N have arrived — phase
synchronization for parallel pipelines. `std::latch` is the single-use variant.

## Read-write locks

`pthread_rwlock_t` / `std::shared_mutex` (C++17) allow *many concurrent readers
XOR one exclusive writer* — a win for read-mostly data:

```cpp
#include <shared_mutex>
std::shared_mutex sm;
int read_value()  { std::shared_lock  lk(sm); /* shared: many readers */  return /*...*/0; }
void write(int v) { std::unique_lock  lk(sm); /* exclusive: one writer */ }
```

Caveat: RW locks are heavier than a plain mutex and prone to **writer
starvation** (a stream of readers can indefinitely block a waiting writer) — see
*Deadlocks, Starvation, and Livelock*. In HFT read-mostly hot data, a lock-free
or RCU-style scheme (seqlock, double-buffer) usually beats a `shared_mutex`.

## Memory ordering: locks are also fences

Synchronization primitives don't just exclude — they impose **memory ordering**.
Acquiring a lock is an *acquire* operation; releasing it is a *release*
operation. That pairing is what guarantees writes a thread made under the lock
are *visible* to the next thread that takes it. This is why the `std::atomic`
calls above use `memory_order_acquire`/`release` — and why hand-rolled
synchronization without the right fences is silently broken on a relaxed-memory
ISA. (Deep dive lives in the atomics / memory-model lessons.)

## Approximate costs

| Operation | Approx. cost |
|---|---|
| Uncontended mutex lock/unlock (futex fast path) | ~tens of cycles (one atomic, no syscall) |
| Atomic CAS / spinlock acquire (uncontended) | ~tens of cycles |
| Contended lock → `futex` sleep + wake | ~hundreds of ns + context switch (µs-scale tail) |
| `PAUSE` in a spin loop | a few cycles; reduces contention/power |

The headline: **an uncontended lock is cheap; a contended one is brutally
expensive** because it drags in a syscall and a context switch. Optimisation is
therefore mostly about *removing contention*, not making locks faster.

## Quant/HFT relevance & interview gotchas

- **Contention is poison.** On the hot path, prefer designs with *no* shared
  mutable state: single-writer queues, **lock-free SPSC ring buffers** (covered
  in the lock-free lesson), thread-local accumulation, sharding by symbol.
- **If you must lock, keep the section tiny** — copy out what you need under the
  lock and do the work outside it — so the fast futex path dominates and you
  rarely sleep.
- **Spinlocks only on dedicated cores.** A spinlock is great when the holder runs
  on another never-preempted core and sections are nanoseconds long; it's a
  livelock risk on oversubscribed cores. Always `PAUSE`.
- **Be able to explain the futex two-path design** — fast userspace CAS,
  slow-path syscall — on demand; it's a top-tier systems question.
- **Lost wakeup / spurious wakeup**: always `while (!pred)` (or the predicate
  overload), always hold the mutex when changing the predicate. Expect a
  whiteboard producer/consumer.
- **Don't `notify` while you don't need the lock held**, but *do* hold it while
  mutating the predicate — get this ordering right.
- **`std::mutex` is not recursive and not RT-aware by default.** For priority
  inversion you want `PTHREAD_PRIO_INHERIT`; for cross-process you want a futex
  in shared memory. Know these exist.

## Key takeaways

1. Primitives split into **mutual exclusion** (mutex, spinlock) and
   **coordination** (condition variable, semaphore, barrier); each is an atomic
   test plus a blocking mechanism.
2. A Linux/`std::mutex` is built on the **futex**: uncontended lock/unlock is a
   pure-userspace atomic CAS (no syscall); only *contention* triggers
   `FUTEX_WAIT`/`FUTEX_WAKE` and a context switch.
3. **Spin vs sleep**: spin if the wait is shorter than a context switch (~1 µs)
   and the holder is on another core; otherwise sleep. Always use `PAUSE` when
   spinning.
4. **Condition variables require a held mutex and a predicate loop** to defeat
   spurious and lost wakeups; the `wait(lk, pred)` overload encodes this.
5. C++ gives you `std::mutex`, `std::shared_mutex` (RW), `std::condition_variable`,
   `std::counting_semaphore`/`std::barrier`/`std::latch` (C++20) over these
   kernel primitives.
6. HFT rule: **contention, not lock code, is the cost** — design it out with
   single-writer / lock-free structures and keep any critical section minuscule.

## Self-check

1. Walk through what `std::mutex::lock()` does when the lock is (a) free and (b)
   held by another thread. Where, exactly, does the kernel get involved?
2. Why must you re-check the predicate in a `while` loop after `cv.wait()`
   returns? Give both reasons.
3. When is a spinlock the *right* choice and when will it livelock the machine?
4. What does the `PAUSE`/`_mm_pause` instruction do in a spin loop, and why is
   omitting it a real performance bug?
5. A `std::shared_mutex` protects a read-mostly book. What failure mode can a
   continuous stream of readers cause, and what's a lock-free alternative?
6. Why does an *uncontended* mutex cost only tens of cycles while a *contended*
   one can cost microseconds?

## Further reading

- [`futex(2)` — man7.org](https://man7.org/linux/man-pages/man2/futex.2.html) — `FUTEX_WAIT`/`FUTEX_WAKE` and the address-keyed wait queues.
- Ulrich Drepper, [**"Futexes Are Tricky"**](https://www.akkadia.org/drepper/futex.pdf) — the canonical paper on building a correct mutex on a futex.
- [`std::mutex`](https://en.cppreference.com/w/cpp/thread/mutex), [`std::condition_variable`](https://en.cppreference.com/w/cpp/thread/condition_variable), and [`std::counting_semaphore`](https://en.cppreference.com/w/cpp/thread/counting_semaphore) — cppreference.
- [`pthread_mutex_lock(3)` — man7.org](https://man7.org/linux/man-pages/man3/pthread_mutex_lock.3.html) and [`pthread_cond_wait(3)`](https://man7.org/linux/man-pages/man3/pthread_cond_wait.3.html).
- [LWN: "A futex overview and update"](https://lwn.net/Articles/360699/) — the kernel side, including `FUTEX_WAIT_PRIVATE`.
- Robert Love, *Linux System Programming*, Ch. on threading & synchronization.
- [Jeff Preshing — "Locks Aren't Slow; Lock Contention Is"](https://preshing.com/20111118/locks-arent-slow-lock-contention-is/) — the HFT-relevant framing of cost.

## Videos

- CppCon — Fedor Pikus, **"The Speed of Concurrency: Is Lock-free Faster?"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+speed+of+concurrency+lock-free+faster)) — contention costs vs lock-free, measured.
- CppCon — **"Back to Basics: Concurrency"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Concurrency)) — mutex/CV/semaphore fundamentals in modern C++.
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why hot-path locks are avoided.
