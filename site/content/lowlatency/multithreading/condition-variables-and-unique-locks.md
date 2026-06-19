# Condition Variables & Unique Locks

> **Why a quant dev must own this:** Threads in a trading system constantly
> need to *wait for something to happen* — a new market message, room in a
> queue, a shutdown signal. The naive answer (a busy-spin on a flag) burns a
> core; the wrong answer (a hand-rolled wait/notify) eats wakeups and hangs in
> production at 3am. A condition variable is the canonical, correct way for a
> thread to **sleep until a condition becomes true** without burning CPU. Even
> in HFT — where the hottest paths spin instead — you need this cold for
> control threads, work queues, and every interview that asks you to build a
> bounded buffer.

*Standard: C++11 (`std::condition_variable`, `std::unique_lock`); C++20 adds CV waits on `stop_token` for clean cancellation.*

## The problem: waiting without burning a core

A consumer thread needs to wait until a producer pushes data. The temptation:

```cpp
// ANTI-PATTERN: busy-wait on an unsynchronized flag.
while (!ready) { /* spin */ }   // burns 100% of a core AND is a data race (UB)
use(data);
```

Two problems. First, it spins at full throttle, wasting a whole core. Second,
`ready` is read/written from two threads with no synchronization — a **data
race**, hence undefined behaviour (the compiler may hoist the load out of the
loop and spin forever). A condition variable solves both: it lets the waiter
**block** (yield the CPU) and provides the synchronization.

## What a condition variable is

A `std::condition_variable` is a signalling primitive that always works **in
partnership with a mutex** and a **predicate** (the actual condition you care
about). The waiter:

1. holds the mutex,
2. atomically **releases the mutex and goes to sleep**,
3. is woken by a `notify`,
4. **re-acquires the mutex** before returning.

The atomic "unlock-and-sleep" in step 2 is the whole point — it closes the race
window between checking the condition and going to sleep.

```cpp
#include <condition_variable>
#include <mutex>
#include <queue>

std::mutex              m;
std::condition_variable cv;
std::queue<int>         q;
bool                    done = false;

void producer() {
    for (int i = 0; i < 10; ++i) {
        {
            std::lock_guard<std::mutex> lk{m};
            q.push(i);                 // mutate shared state UNDER the lock
        }
        cv.notify_one();               // wake one waiter (lock not required to notify)
    }
    { std::lock_guard<std::mutex> lk{m}; done = true; }
    cv.notify_all();
}

void consumer() {
    for (;;) {
        std::unique_lock<std::mutex> lk{m};        // MUST be unique_lock
        cv.wait(lk, [] { return !q.empty() || done; });  // predicate form
        // re-acquired the lock here; predicate is guaranteed true
        if (q.empty() && done) return;             // drained + finished
        int v = q.front(); q.pop();
        lk.unlock();                               // release before processing
        process(v);
    }
}
```

## Why `unique_lock`, not `lock_guard`

`cv.wait()` must **unlock the mutex while it sleeps and re-lock on wakeup**.
That requires a lock object it can unlock and relock — `std::lock_guard` cannot
do that (it locks once in its constructor, unlocks once in its destructor, and
exposes nothing in between). `std::unique_lock` *can*: it tracks ownership and
supports `unlock()`/`lock()`, deferred locking, and timed locking. Hence the
rule:

> **A condition variable wait requires a `std::unique_lock<std::mutex>`.** Use
> `lock_guard`/`scoped_lock` for plain critical sections; use `unique_lock`
> when you wait on a CV (or need to unlock early / lock late).

`unique_lock` is marginally heavier (it stores an ownership flag), so don't use
it everywhere — only where you need the flexibility.

## The predicate, spurious wakeups, and lost wakeups

Two failure modes make the **predicate form mandatory**. Never write a bare
`cv.wait(lk)` and assume the condition holds when it returns.

**Spurious wakeups.** A waiting thread may wake up *with no notification at
all* — this is allowed by the standard (and happens on real OSes; it falls out
of how futexes and POSIX condvars are implemented). So you must **re-check the
condition** on every wakeup and go back to sleep if it's false. That is exactly
what the predicate overload does:

```cpp
cv.wait(lk, pred);
// is EXACTLY equivalent to:
while (!pred()) cv.wait(lk);   // re-check on every wakeup -> survives spurious wakeups
```

**Lost wakeups.** If you `notify` *before* the consumer is asleep — or check the
condition without the lock and then sleep — the notification is lost and the
waiter sleeps forever. The discipline that prevents it:

```text
PRODUCER                              CONSUMER
--------                              --------
lock(m)                               lock(m)
mutate shared state  <-- under lock   while (!pred()) cv.wait(lk)  <-- under lock
unlock(m)                             (pred re-checked atomically wrt the mutex)
cv.notify_one()
```

The mutex serializes "mutate + would-be-notify" against "check + sleep". Because
the consumer evaluates the predicate **while holding the same mutex** the
producer mutates under, there is no gap in which a notification can slip past a
not-yet-sleeping waiter. Notifications themselves don't need the lock held, but
the **state change the predicate reads does**.

> **Mnemonic:** *mutate under the lock, notify after; always wait with a
> predicate.* Break either half and you get a lost or spurious-wakeup bug.

## `notify_one` vs `notify_all`

- **`notify_one`** wakes (at least) one waiter. Cheaper; correct when any single
  waiter can handle the event and waiters are interchangeable (e.g. a worker
  pool pulling from one queue).
- **`notify_all`** wakes everyone. Use when the state change may satisfy
  *different* waiters with different predicates, or on shutdown. Costs a
  **thundering herd**: all threads wake, contend for the one mutex, most re-check
  their predicate and go back to sleep.

When in doubt about correctness, `notify_all` is safe; for performance prefer
`notify_one` where a single wakeup suffices.

## Timed waits and C++20 cancellation

`wait_for` / `wait_until` add a timeout (also re-checking the predicate, so they
return `true` if the predicate held, `false` on timeout):

```cpp
using namespace std::chrono_literals;
std::unique_lock lk{m};
if (cv.wait_for(lk, 5ms, [] { return !q.empty(); })) {
    // got an item within 5 ms
} else {
    // timed out, predicate still false — e.g. send a heartbeat
}
```

C++20 adds `std::condition_variable_any::wait` overloads taking a
`std::stop_token`, so a `jthread` can be cleanly cancelled out of a blocking
wait — no sentinel-value hacks:

```cpp
// C++20: wakes if predicate true OR stop is requested.
cv.wait(lk, stop_token, [] { return !q.empty(); });
```

## Hardware reality: is a CV cheap?

A condition-variable wait that actually blocks is a **kernel operation** (a
futex on Linux). The relevant costs:

```text
operation                              rough cost
-------------------------------------- ----------------------------------
notify with no waiter                  cheap, often stays in userspace
notify that wakes a sleeper            futex syscall + context switch + cold caches:
                                      microseconds, plus scheduling latency
wakeup-to-running latency              ~1-20+ microseconds (scheduler dependent, jittery)
```

The takeaway for latency-critical code: **a CV trades CPU for latency and
introduces jitter**. Blocking yields the core (great for throughput / power /
control threads) but the wake-up path goes through the scheduler, so the
tail latency is microseconds and *unpredictable*. That is fatal on a
tick-to-trade path measured in nanoseconds.

So in HFT:

- **Control plane, work queues, loggers, slow consumers:** condition variables
  are the right, idiomatic tool — block and stop burning power.
- **The hot market-data path:** you do *not* block. You **busy-spin** (poll a
  lock-free SPSC queue, often with a `PAUSE` instruction) on a dedicated pinned
  core, accepting a burned core to eliminate the scheduler from the latency
  path. (See the Spinlock lesson.)

## Quant/HFT relevance & interview gotchas

- **"Why `unique_lock` and not `lock_guard` with a CV?"** Because `wait()` must
  unlock-and-relock the mutex; only `unique_lock` exposes that. This is the
  single most common CV interview question.
- **"What's a spurious wakeup, and how do you handle it?"** Wakeup with no
  notify; handle it by **always waiting with a predicate** (the loop form).
  Bare `wait(lk)` is a bug.
- **"What's a lost wakeup?"** Notify fires before the waiter sleeps, or the
  predicate is checked without the lock; the discipline is *mutate the shared
  state under the same mutex the predicate reads, then notify*.
- **`notify_one` vs `notify_all`:** know the thundering-herd cost and when each
  is correct.
- **CVs block → scheduler jitter.** Perfect for control threads and the
  classic producer/consumer interview problem; **wrong for the
  nanosecond-budget hot path**, where you spin instead. Saying this unprompted
  signals real HFT awareness.
- **Don't process the item while holding the lock** — pop under the lock, then
  `unlock()` before doing the (possibly slow) work, to keep the critical section
  tiny.

## Key takeaways

1. A condition variable lets a thread **block until a predicate is true** with a
   partnered **mutex**, avoiding the busy-wait that wastes a core and races on
   the flag.
2. `cv.wait()` **requires `std::unique_lock`** because it must atomically
   unlock-and-sleep then re-lock; `lock_guard`/`scoped_lock` can't.
3. **Always use the predicate overload** (`cv.wait(lk, pred)`); it's a
   `while (!pred()) wait(lk)` loop that survives **spurious wakeups**.
4. Prevent **lost wakeups** by mutating the shared state **under the same mutex
   the predicate reads**, then notifying. Mutate-under-lock, notify-after.
5. `notify_one` is cheaper; `notify_all` is safe but risks a thundering herd.
6. A blocking CV is a **futex/syscall with microsecond, jittery wake latency** —
   ideal for control threads, **wrong for the ns-budget hot path**, where you
   **spin** instead.

## Self-check

1. Why can't you wait on a condition variable with a `std::lock_guard`?
2. Define spurious and lost wakeups, and give the one-line code discipline that
   defends against each.
3. Rewrite `while (!pred()) cv.wait(lk);` using the predicate overload and
   explain why they're equivalent.
4. When is `notify_all` necessary rather than `notify_one`, and what does it
   cost?
5. Roughly how long is the wake-up latency of a blocking CV, and why does that
   rule it out of a tick-to-trade hot path?
6. Where in a trading system *should* you use condition variables, and where
   should you spin instead?

## Further reading

- [`std::condition_variable` — cppreference](https://en.cppreference.com/w/cpp/thread/condition_variable) and [`std::unique_lock`](https://en.cppreference.com/w/cpp/thread/unique_lock).
- [`condition_variable::wait` (predicate overload) — cppreference](https://en.cppreference.com/w/cpp/thread/condition_variable/wait) — note the spurious-wakeup wording.
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — Ch. 4 ("Synchronizing concurrent operations") builds the producer/consumer with CVs and explains the predicate discipline.
- [The "lost wakeup" / why-a-mutex-is-needed explanation on cppreference notes](https://en.cppreference.com/w/cpp/thread/condition_variable) and the [POSIX `pthread_cond_wait` rationale](https://pubs.opengroup.org/onlinepubs/9699919799/functions/pthread_cond_wait.html).
- [C++20 `condition_variable_any` + `stop_token` waits — cppreference](https://en.cppreference.com/w/cpp/thread/condition_variable_any/wait).

## Videos

- Arthur O'Dwyer — **"Back to Basics: Concurrency"** (CppCon) ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Concurrency+Arthur+O%27Dwyer)) — clear treatment of CV + predicate + unique_lock.
- Rainer Grimm — **"Concurrency Patterns"** (CppCon) ([search](https://www.youtube.com/results?search_query=CppCon+Rainer+Grimm+concurrency+patterns)) — producer/consumer and the wakeup pitfalls.
