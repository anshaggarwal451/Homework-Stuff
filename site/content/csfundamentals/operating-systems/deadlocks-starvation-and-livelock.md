# Deadlocks, Starvation, and Livelock

> **Why a quant dev must own this:** A deadlock in a trading system isn't a slow
> path — it's a *stopped* path. Threads frozen mid-session means quotes you
> can't update and positions you can't hedge while the market moves against you.
> These bugs are intermittent, timing-dependent, and famously hard to reproduce,
> so interviewers probe whether you can *prevent them by construction* — with
> lock ordering and `std::scoped_lock` — rather than chase them after the fact.

## Three distinct liveness failures

All three mean "threads aren't making useful progress," but the mechanism
differs — and conflating them is a classic interview tell:

| Failure | What's happening | Are threads running? |
|---|---|---|
| **Deadlock** | Each thread waits forever for a resource another holds | No — all blocked |
| **Livelock** | Threads keep *reacting* to each other but none progresses | Yes — busy, but useless |
| **Starvation** | A thread is perpetually denied a resource it could use | Maybe — it's just never chosen |

## Deadlock and the four Coffman conditions

A deadlock requires **all four** of these to hold simultaneously (Coffman, 1971).
Break *any one* and deadlock is impossible — this is the framework every fix maps
back to:

1. **Mutual exclusion** — a resource is held exclusively (a mutex).
2. **Hold and wait** — a thread holds one resource while waiting for another.
3. **No preemption** — a resource can't be forcibly taken; only the holder
   releases it.
4. **Circular wait** — a cycle exists: A waits on B, B waits on A (or a longer
   ring).

```text
   Thread 1 holds mtxA, wants mtxB        Thread 2 holds mtxB, wants mtxA
        ┌─────────────┐                        ┌─────────────┐
        │  Thread 1   │ ── wants ──► mtxB ◄──── │  holds      │
        │  holds mtxA │                         │  Thread 2   │
        └──────▲──────┘ ◄── wants ── mtxA ────► └─────────────┘
               └───────────── circular wait ───────────┘   → DEADLOCK
```

### A concrete deadlock (the lock-ordering bug)

```cpp
#include <mutex>
#include <thread>

std::mutex mtxA, mtxB;

void transfer_1_to_2() {
    std::lock_guard<std::mutex> a(mtxA);   // locks A first
    std::lock_guard<std::mutex> b(mtxB);   // then B
    // ... move funds A -> B ...
}

void transfer_2_to_1() {
    std::lock_guard<std::mutex> b(mtxB);   // locks B first  <-- OPPOSITE ORDER
    std::lock_guard<std::mutex> a(mtxA);   // then A
    // ... move funds B -> A ...
}
// If thread 1 grabs A and thread 2 grabs B at the same instant, each then
// blocks forever on the other's lock. Classic AB-BA deadlock.
```

This is the single most common real deadlock: **two locks acquired in opposite
orders by different code paths.** It's timing-dependent, so it passes every test
until production load lines up the windows.

## Prevention: break a Coffman condition by construction

### 1. Lock ordering (break circular wait)

Impose a *global total order* on locks and always acquire in that order. If
everyone locks A-before-B, no cycle can form. Discipline-based, but it's the
foundation everything else builds on. Order by a stable key — address,
allocation order, or an explicit rank.

### 2. `std::scoped_lock` / `std::lock` (break hold-and-wait atomically)

The idiomatic C++ fix: lock *all* the mutexes you need **at once** with a
deadlock-avoidance algorithm so you never hold one while blocking on another.

```cpp
#include <mutex>

std::mutex mtxA, mtxB;

void transfer_safe() {
    // C++17: scoped_lock locks BOTH using std::lock's deadlock-avoidance
    // algorithm (try/back-off), then adopts ownership. Order of arguments
    // here does NOT matter — the algorithm prevents the AB-BA cycle.
    std::scoped_lock lk(mtxA, mtxB);
    // ... both held safely ...
}                                        // both released in reverse order

// Pre-C++17 equivalent:
void transfer_safe_cpp11() {
    std::lock(mtxA, mtxB);               // acquires both with no deadlock
    std::lock_guard<std::mutex> a(mtxA, std::adopt_lock);   // adopt: already locked
    std::lock_guard<std::mutex> b(mtxB, std::adopt_lock);
}
```

`std::scoped_lock` is the answer the interviewer wants for "fix this deadlock":
it acquires multiple locks together such that the AB-BA pattern can't deadlock,
*regardless of the order you pass them*. Internally it does a try-lock dance,
backing off and releasing all if it can't get them all.

### 3. `try_lock` + back-off (break hold-and-wait / no-preemption)

Grab what you can, and if you can't get everything, release and retry:

```cpp
void transfer_trylock() {
    while (true) {
        std::unique_lock<std::mutex> a(mtxA, std::try_to_lock);
        std::unique_lock<std::mutex> b(mtxB, std::try_to_lock);
        if (a.owns_lock() && b.owns_lock()) { /* work */ return; }
        // Couldn't get both: drop everything (preemption of *self*) and retry.
        // WARNING: naive immediate retry can LIVELOCK — add randomized back-off.
    }
}
```

Note the trap: `try_lock` + immediate retry is exactly how you create a
**livelock** (next section) if two threads keep grabbing-and-releasing in
lockstep. Add randomized/exponential back-off.

### 4. Single-lock / single-writer (eliminate the second lock)

The best deadlock fix is *fewer locks*. If you never hold more than one lock at a
time, circular wait is structurally impossible. In HFT this pushes you toward
**single-writer** designs and lock-free queues where the synchronization
disappears entirely.

## Avoidance vs detection (know the taxonomy)

- **Avoidance** — at runtime, only grant a request if the system stays in a
  "safe" state. The textbook algorithm is **Banker's algorithm** (Dijkstra): it
  needs each thread to declare its maximum resource claim up front, then refuses
  allocations that *could* lead to an unsafe state. Elegant, but it requires
  knowing future demand and is too heavy for general use — *mention it, don't
  deploy it.*
- **Detection & recovery** — let deadlocks happen, periodically scan the
  resource-allocation graph for a cycle, then recover (kill/rollback a thread).
  Databases do this. General-purpose OSes mostly **ignore** deadlock (the
  "ostrich algorithm") and leave prevention to the programmer.

For application code, **prevention by lock ordering / `scoped_lock` is the only
practical answer** — which is why interviews focus there.

## Livelock: busy but going nowhere

A **livelock** is the active cousin of deadlock: threads aren't blocked, they're
*running* — but their states keep changing in response to each other so no one
progresses. The canonical image is two people in a hallway, each politely
stepping the same way to let the other pass, forever.

```cpp
// Two threads each "politely" back off when they detect the other — and
// resynchronise into the same back-off, repeating forever. CPU pegged, no work.
bool try_acquire_both(std::mutex& first, std::mutex& second) {
    while (true) {
        std::unique_lock<std::mutex> f(first, std::try_to_lock);
        if (!f.owns_lock()) continue;
        std::unique_lock<std::mutex> s(second, std::try_to_lock);
        if (s.owns_lock()) return true;
        // back off and retry — WITHOUT randomization both threads step in
        // lockstep: grab, fail, release, grab, fail... = LIVELOCK
    }
}
```

**The fix is randomness**: randomized/exponential back-off breaks the symmetry so
the threads desynchronise and one wins. (This is exactly why CSMA/CD Ethernet and
TCP use randomized exponential back-off.)

## Starvation: perpetually skipped

**Starvation** is when a thread *could* run but is never given the resource —
not because of a cycle, but because the policy keeps favouring others.

- **Scheduler starvation**: a low-priority thread never runs because higher
  priorities are always ready (see *Process Scheduling*). Fixed by *aging*
  (gradually boosting a waiting thread's priority).
- **Writer starvation in RW locks**: with a reader-preferring `shared_mutex`, a
  continuous stream of readers can block a waiting writer indefinitely — the
  writer starves. Fixed with writer-preferring or fair (FIFO) lock policies.
- **Lock unfairness**: a thread that keeps losing the race to a hot mutex while
  others win. Ticket/queue locks (FIFO fairness) cure this at some throughput
  cost.

## Priority inversion: the scheduling-flavoured deadlock

A *high*-priority thread waits on a lock held by a *low*-priority thread; a
*medium*-priority thread then preempts the low one, so the high-priority thread
is indirectly blocked by a medium one it should outrank. This is **priority
inversion**.

> **Mars Pathfinder (1997)** famously hit this: a high-rate bus-management task
> blocked on a mutex held by a low-rate task that medium-rate tasks kept
> preempting, tripping a watchdog that reset the spacecraft. The fix, uploaded
> from Earth, was to enable **priority inheritance** on that mutex.

**Priority inheritance**: while a low-priority thread holds a lock a
high-priority thread wants, the holder *temporarily inherits* the waiter's
priority, so it can't be preempted by mediums — it finishes and releases fast.
On Linux:

```cpp
#include <pthread.h>
// Enable priority inheritance so a held lock can't cause unbounded inversion.
pthread_mutexattr_t attr;
pthread_mutexattr_init(&attr);
pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);  // PI mutex
pthread_mutex_t m;
pthread_mutex_init(&m, &attr);
```

The alternative is **priority ceiling** (the lock raises any holder to a
preset ceiling priority). Both matter in HFT when a `SCHED_FIFO` hot thread might
ever share a lock with a lower-priority helper.

## A forward note: the ABA problem

When you move to *lock-free* code to escape locks entirely, a different liveness
hazard appears: the **ABA problem** — a compare-and-swap sees a value change
from A to B and back to A and wrongly concludes nothing happened. It's not a
deadlock (lock-free code can't deadlock on a lock it doesn't take), but it's the
same family of "looks fine, silently wrong under interleaving" bug. Covered in
the lock-free lesson; flagged here so you connect the dots.

## Quant/HFT relevance & interview gotchas

- **Prevention beats cure.** State the doctrine: *global lock ordering, acquire
  multiple locks with `std::scoped_lock`, never hold a lock across a blocking
  call, and prefer single-writer / lock-free designs so the second lock never
  exists.*
- **Know the Coffman conditions and which fix breaks which** — it's the
  framework that organises every answer. ("`scoped_lock` breaks hold-and-wait by
  acquiring atomically; lock ordering breaks circular wait.")
- **Deadlock vs livelock vs starvation** — be crisp: deadlock = all blocked;
  livelock = all running, no progress; starvation = one perpetually skipped.
- **`try_lock` loops livelock without randomized back-off** — a favourite
  follow-up. Always add back-off.
- **Priority inversion + Mars Pathfinder** is the canonical war story; tie it to
  `PTHREAD_PRIO_INHERIT`. Especially relevant once you're using `SCHED_FIFO`
  (see *Process Scheduling*) — RT priorities *cause* inversion if a high thread
  shares a lock with a low one.
- **Avoid nested locks on the hot path.** Each additional lock is a chance to
  introduce an ordering bug; the safest hot path holds *zero or one* lock and
  copies data out fast.
- **Reproduce with tooling**: ThreadSanitizer (`-fsanitize=thread`) flags lock
  *order inversions* even when no deadlock fired; `gdb`'s `thread apply all bt`
  on a hung process shows the cycle; helgrind/DRD likewise.

## Key takeaways

1. **Deadlock** needs all four **Coffman conditions** (mutual exclusion,
   hold-and-wait, no preemption, circular wait); break any one and it can't
   happen.
2. The classic deadlock is **two locks acquired in opposite orders**; fix it with
   a **global lock ordering** or, idiomatically, **`std::scoped_lock` /
   `std::lock`**, which acquire multiple mutexes without deadlock regardless of
   argument order.
3. **`try_lock` + retry** can solve hold-and-wait but **livelocks** without
   randomized back-off.
4. **Avoidance** (Banker's algorithm) and **detection** exist but are impractical
   for app code — **prevention by construction** is the working answer.
5. **Livelock** = active non-progress (fix: randomness); **starvation** = a
   runnable thread perpetually skipped (fix: aging / fair locks); **writer
   starvation** is the RW-lock case.
6. **Priority inversion** (Mars Pathfinder) is fixed by **priority inheritance**
   (`PTHREAD_PRIO_INHERIT`) — critical once RT priorities (`SCHED_FIFO`) share
   locks.
7. HFT discipline: **lock ordering, `scoped_lock`, no nested locks on the hot
   path, single-writer / lock-free designs.**

## Self-check

1. List the four Coffman conditions and state which one `std::scoped_lock`
   breaks and how.
2. Rewrite the AB-BA `transfer` deadlock to be safe in two different ways.
3. A teammate "fixes" a deadlock by switching to `try_lock` in a tight retry
   loop. Under what conditions does this livelock, and what's the minimal fix?
4. Distinguish deadlock, livelock, and starvation in one sentence each, keyed on
   whether the threads are running.
5. Explain priority inversion using three threads and three priorities, and name
   the mutex attribute that prevents it on Linux.
6. Why is "single-writer, lock-free" the strongest deadlock prevention of all,
   in terms of the Coffman conditions?

## Further reading

- [`pthread_mutexattr_setprotocol(3)` — man7.org](https://man7.org/linux/man-pages/man3/pthread_mutexattr_setprotocol.3.html) — `PTHREAD_PRIO_INHERIT` / `PRIO_PROTECT`.
- [`std::scoped_lock`](https://en.cppreference.com/w/cpp/thread/scoped_lock) and [`std::lock`](https://en.cppreference.com/w/cpp/thread/lock) — cppreference; the deadlock-avoidance acquisition.
- [`pthread_mutex_lock(3)` — man7.org](https://man7.org/linux/man-pages/man3/pthread_mutex_lock.3.html) — mutex types and protocols.
- Silberschatz, Galvin & Gagne, *Operating System Concepts*, Ch. 8 (Deadlocks) — Coffman conditions, Banker's algorithm, detection.
- Mike Jones, [**"What Really Happened on Mars Rover Pathfinder"**](https://www.rapitasystems.com/blog/what-really-happened-software-mars-pathfinder-spacecraft) — the priority-inversion war story, first-hand.
- [ThreadSanitizer manual](https://github.com/google/sanitizers/wiki/ThreadSanitizerCppManual) — detecting lock-order inversions and data races.
- Anthony Williams, *C++ Concurrency in Action*, 2e, Ch. 3 — `std::lock`, lock ordering, and avoiding deadlock in practice.

## Videos

- *Computerphile* — **"Deadlock & Starvation"** ([search](https://www.youtube.com/results?search_query=computerphile+deadlock+starvation)).
- CppCon — **"Back to Basics: Concurrency"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Concurrency)) — `std::scoped_lock` and deadlock avoidance in modern C++.
- *MIT 6.004 / OS lectures* — **"Deadlock and the Coffman conditions"** ([search](https://www.youtube.com/results?search_query=deadlock+coffman+conditions+lecture)).
