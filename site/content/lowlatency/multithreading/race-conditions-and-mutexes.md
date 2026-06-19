# Race Conditions & Mutexes

> **Why a quant dev must own this:** The moment two threads touch the same
> bytes and at least one writes, you are one mis-step from a **data race**,
> which in C++ is *undefined behaviour* — not "a wrong number", but a program
> the compiler is free to miscompile entirely. In a trading system that means a
> silently corrupt order book or a position that drifts. Mutexes are the first,
> simplest tool to make shared state safe; knowing exactly what they cost (and
> why you avoid them on the hot path) is the difference between a correct slow
> system and a correct *fast* one.

*Standard: C++17 (`std::scoped_lock`, structured deadlock-avoidance). C++11 for `std::mutex`/`std::lock_guard`.*

## What a race condition actually is

Loosely, a **race condition** is any bug where the result depends on the
unpredictable interleaving of threads. The C++ standard pins down the dangerous
subset precisely as a **data race**:

> Two accesses to the same memory location **conflict** if at least one is a
> write. A program has a **data race** if two conflicting accesses from
> different threads are not ordered by *happens-before* (e.g. not separated by a
> mutex or an atomic), and neither is atomic. **A data race is undefined
> behaviour** — [`intro.races`](https://eel.is/c++draft/intro.races).

UB is the key word. Don't picture "the counter is off by a few". Picture the
optimizer assuming no race exists and hoisting a load out of a loop, tearing a
64-bit store into two 32-bit stores, or inventing a value. The classic demo:

```cpp
#include <thread>
#include <vector>
#include <cassert>

int counter = 0;   // plain int, shared, unsynchronized

void bump() { for (int i = 0; i < 100'000; ++i) ++counter; }  // DATA RACE -> UB

int main() {
    std::vector<std::thread> ts;
    for (int i = 0; i < 8; ++i) ts.emplace_back(bump);
    for (auto& t : ts) t.join();
    // counter is NOT reliably 800000. It is undefined behaviour.
}
```

`++counter` is a **read-modify-write**: load, add, store. Two threads can both
load `41`, both store `42`, and one increment vanishes. Worse, because it's UB,
the standard offers *no* guarantee at all — a thread sanitizer flags it, and you
must fix it, not "mostly works on x86" your way around it.

> **Atomicity vs ordering:** races are about *unsynchronized conflicting
> access*. The fix is to introduce a happens-before edge — via a mutex (this
> lesson) or via `std::atomic` (a later lesson).

## `std::mutex`: mutual exclusion

A `std::mutex` provides a **critical section**: at most one thread holds the
lock at a time, so accesses to the data it guards are serialized and no longer
conflict.

```cpp
#include <mutex>
std::mutex m;
int counter = 0;

void bump() {
    for (int i = 0; i < 100'000; ++i) {
        m.lock();
        ++counter;       // now serialized: exactly one writer at a time
        m.unlock();
    }
}
```

Two properties the standard guarantees: **mutual exclusion** (one owner) and a
**synchronizes-with** relationship — unlocking a mutex *happens-before* the next
lock of it, which is what makes the protected writes visible to the next thread.
A mutex is therefore both a lock *and* a memory barrier.

You should almost never call `lock()`/`unlock()` by hand, because an exception
(or an early `return`) between them leaks the lock and deadlocks the process.

## RAII locking: `lock_guard`, `scoped_lock`, `unique_lock`

The idiom is **RAII**: a guard object locks in its constructor and unlocks in
its destructor, so the lock is released on *every* exit path — normal,
`return`, or exception.

```cpp
#include <mutex>
std::mutex m;
int counter = 0;

void bump_safe() {
    for (int i = 0; i < 100'000; ++i) {
        std::lock_guard<std::mutex> g{m};   // locks here
        ++counter;
    }                                        // unlocks at end of scope (even if ++ threw)
}
```

| Guard | Since | What it adds |
|---|---|---|
| `std::lock_guard` | C++11 | Minimal: lock one mutex on construct, unlock on destroy. Not movable, no unlock-then-relock. |
| `std::scoped_lock` | C++17 | Like `lock_guard` but locks **one *or more*** mutexes **deadlock-free** (uses `std::lock`'s ordering). **The default choice.** |
| `std::unique_lock` | C++11 | Flexible: deferred lock, `try_lock`, manual `unlock()`/`lock()`, movable; required by `condition_variable`. Slightly heavier (tracks ownership). |

**Default to `std::scoped_lock`** in C++17+. Reach for `unique_lock` only when
you need its flexibility (notably condition variables — covered in the next
lesson). `lock_guard` is the older single-mutex tool that `scoped_lock`
subsumes.

```cpp
// scoped_lock locks BOTH accounts atomically with no deadlock risk:
void transfer(Account& a, Account& b, long amount) {
    std::scoped_lock lk{a.m, b.m};   // CTAD: deduces scoped_lock<mutex, mutex>
    a.balance -= amount;
    b.balance += amount;
}                                     // both released here
```

## Deadlock: the four conditions and how to avoid it

A deadlock is a cycle of threads each holding a lock the next one wants. The
canonical cause is **inconsistent lock ordering**:

```text
Thread 1                 Thread 2
--------                 --------
lock(A)                  lock(B)
   (wants B) ----.   .---- (wants A)
                 v   v
              <stuck forever>
```

Deadlock requires all four **Coffman conditions** simultaneously: *mutual
exclusion*, *hold-and-wait*, *no preemption*, and *circular wait*. Break any
one and you're safe. Practical rules, strongest first:

1. **Impose a global lock order.** Always acquire multiple mutexes in the same
   order (e.g. by address). This kills *circular wait* — the most reliable fix.
2. **Use `std::scoped_lock` / `std::lock`** to take several mutexes at once; it
   uses a deadlock-avoidance algorithm (try-and-back-off) so you don't have to
   hand-order them.
3. **Hold one lock at a time** where possible — the simplest design.
4. **Never call user/unknown code while holding a lock** (callbacks can re-enter
   and try to take a lock you hold → self-deadlock or order violation).
5. Prefer **`std::recursive_mutex` only as a last resort** — it usually masks a
   design flaw, and it's slower.

```cpp
// Reentrancy hazard: std::mutex is NOT recursive.
std::mutex m;
void inner() { std::lock_guard g{m}; /* ... */ }
void outer() {
    std::lock_guard g{m};
    inner();     // DEADLOCK: re-locking a non-recursive mutex you already own = UB/deadlock
}
```

## What a mutex costs

This is the part HFT cares about. A mutex is *cheap when uncontended* and
*catastrophic when contended*.

```text
scenario                              rough cost
------------------------------------- ------------------------------------
uncontended lock/unlock               ~15-25 ns (an atomic RMW, stays in userspace)
contended (must block)                syscall into kernel (futex), microseconds,
                                      plus a context switch + cold caches
cache-line bounce of the lock word    ~tens-hundreds of ns per transfer between cores
```

The mechanics: a modern `std::mutex` (e.g. glibc) is a **futex** ("fast
userspace mutex"). The uncontended path is a single atomic compare-exchange in
userspace — no syscall. Only when there's *contention* does it trap into the
kernel to sleep the waiter, and that's where microseconds and context switches
appear.

Two distinct costs to keep straight:

- **Latency of the lock itself**, dominated by the cache-line bounce: the lock
  word ping-pongs between cores' caches (MESI), each transfer costing tens to
  hundreds of nanoseconds.
- **Serialization**, i.e. Amdahl's law: the critical section runs one-at-a-time,
  so the more threads contend, the more they queue. **The fix for contention is
  almost never a faster lock — it's less sharing** (shard the data, use
  per-thread state, or design the data flow so threads don't touch the same
  bytes).

> **Priority inversion** is the nastier failure mode: a low-priority thread
> holds the lock, a high-priority hot thread spins/blocks waiting for it, and a
> medium-priority thread starves the holder. In a latency-critical path this is
> a reason to avoid blocking locks entirely.

## Quant/HFT relevance & interview gotchas

- **"Is a data race just a wrong value?"** No — it is **undefined behaviour**.
  Say "UB" out loud; it signals you understand the memory model, not just
  threads.
- **The hot path avoids mutexes.** Tick-to-trade designs use SPSC/MPMC
  **lock-free queues** and **per-thread sharded state** so the critical path
  never blocks or makes a syscall. Mutexes are fine for control-plane/config,
  not for every market message.
- **Default to `std::scoped_lock`** (C++17); know `lock_guard` is the older
  single-mutex form and `unique_lock` is for flexibility / condition variables.
- **Lock ordering** is *the* deadlock answer. Be ready to fix the A/B transfer
  deadlock by global ordering or `std::scoped_lock{a.m, b.m}`.
- **"What's the real cost of a mutex?"** Uncontended ~tens of ns (userspace
  futex fast path); contended = syscall + context switch + cold caches. The
  expensive part under contention is *serialization and cache-line bouncing*,
  not the instruction.
- **Don't hold a lock across I/O, allocation, or unknown callbacks.** Shrink the
  critical section to the few lines that truly touch shared state.
- **`std::mutex` is not recursive**; re-locking what you hold is a deadlock.

## Key takeaways

1. A **data race** (unsynchronized conflicting access, one a write, neither
   atomic) is **undefined behaviour** — the compiler may miscompile, not merely
   produce a wrong number.
2. `std::mutex` gives mutual exclusion *and* a happens-before edge
   (unlock-synchronizes-with-lock), so it both serializes and publishes writes.
3. **Always lock via RAII** — prefer **`std::scoped_lock`** (multi-mutex,
   deadlock-free); `unique_lock` for flexibility, `lock_guard` is the legacy
   single-mutex form.
4. Avoid deadlock by **consistent global lock ordering** (or `std::scoped_lock`),
   holding few locks, and never calling unknown code under a lock.
5. A mutex is **~tens of ns uncontended** (userspace futex) but costs a
   **syscall + context switch** when contended; the real enemy is serialization
   and cache-line bouncing — **on the hot path, design out the sharing** rather
   than buy a faster lock.

## Self-check

1. Precisely why is a data race worse than "the counter is occasionally wrong"?
2. Two threads run `++counter` on a plain `int`. Explain at the load/store level
   how an increment can be lost.
3. When would you choose `unique_lock` over `scoped_lock`? Over `lock_guard`?
4. Show two ways to fix the classic A↔B `transfer` deadlock.
5. Roughly what does an *uncontended* `std::mutex` lock/unlock cost, and where
   does the cost explode under contention?
6. Why is "buy a faster mutex" usually the wrong answer to a contention problem
   in a hot path?

## Further reading

- [Data races and the memory model — `intro.races` (C++ draft)](https://eel.is/c++draft/intro.races) — the normative definition.
- [`std::mutex` — cppreference](https://en.cppreference.com/w/cpp/thread/mutex), [`std::scoped_lock`](https://en.cppreference.com/w/cpp/thread/scoped_lock), [`std::lock_guard`](https://en.cppreference.com/w/cpp/thread/lock_guard), [`std::lock`](https://en.cppreference.com/w/cpp/thread/lock).
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — Ch. 3 ("Sharing data between threads") covers mutexes and deadlock avoidance thoroughly.
- Ulrich Drepper, ["Futexes Are Tricky"](https://www.akkadia.org/drepper/futex.pdf) — how Linux mutexes actually work underneath.
- [ThreadSanitizer (TSan) manual](https://clang.llvm.org/docs/ThreadSanitizer.html) — the tool that finds these races; run your tests under it.

## Videos

- Rainer Grimm / Arthur O'Dwyer — **"Back to Basics: Concurrency"** (CppCon) ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Concurrency)) — mutexes, locks, and data races for the working programmer.
- Fedor Pikus — **"The Speed of Concurrency: Is Lock-free Faster?"** (CppCon) ([search](https://www.youtube.com/results?search_query=Fedor+Pikus+The+Speed+of+Concurrency+is+lock+free+faster)) — measures what locks actually cost under contention.
