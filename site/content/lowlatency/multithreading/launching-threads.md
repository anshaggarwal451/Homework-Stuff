# Launching Threads

> **Why a quant dev must own this:** A trading system is a fan of threads —
> feed handlers, strategy engines, order gateways, loggers, timers — each
> pinned to a core and talking to its neighbours through carefully designed
> queues. Before you can reason about lock-free queues or memory ordering you
> have to know how a thread is born, how it dies, how arguments cross the
> boundary, and what it costs. Get the lifecycle wrong and you get crashes
> (`std::terminate` on a non-joined thread), dangling references, or a feed
> handler sharing a core with a noisy logger. This is the warm-up question;
> the senior answer shows you also know `jthread`, affinity, and cost.

*Standard: C++17 for the core material, C++20 for `std::jthread` and stop tokens. Affinity uses POSIX `pthread`.*

## First principles: what a `std::thread` is

A `std::thread` is a thin, owning RAII handle to **one OS thread of
execution**. Constructing it with a callable launches that callable on a fresh
kernel-scheduled thread *eagerly* — the new thread may already be running
before the constructor returns. The `std::thread` object lives in the parent;
the actual stack and register state live in the kernel.

The single most important rule, and the one interviewers probe first:

> **Every `std::thread` must be either `join()`ed or `detach()`ed before it is
> destroyed.** If a *joinable* `std::thread` is destroyed, its destructor calls
> `std::terminate()` — the whole process dies.

This is a deliberate design choice (championed by Hans Boehm): silently
joining in the destructor could hide a hang, and silently detaching could
leave a thread reading a destroyed stack frame. The language forces you to
state your intent.

```cpp
#include <thread>
#include <cstdio>

void work() { std::puts("hello from worker"); }

int main() {
    std::thread t{work};   // OS thread launches *now*
    t.join();              // block until 'work' returns; t is no longer joinable
    // if we forgot t.join()/t.detach(), ~thread() -> std::terminate()
}
```

- **`join()`** blocks the caller until the thread finishes, then reclaims it.
  After `join()` the object is no longer joinable.
- **`detach()`** severs the handle: the thread runs on independently, the
  runtime owns its cleanup, and you lose any way to wait for it or get its
  result. Use sparingly — a detached thread that outlives the data it
  references is a classic use-after-free.

## C++20 `std::jthread`: the one you should reach for

`std::jthread` ("joining thread") fixes the footgun: its destructor **joins
automatically** (and can request cooperative cancellation first). It is a
strict superset — prefer it in any C++20 codebase.

```cpp
#include <thread>          // std::jthread (C++20)
#include <stop_token>
#include <chrono>
#include <cstdio>

void poll(std::stop_token st) {
    using namespace std::chrono_literals;
    while (!st.stop_requested()) {       // cooperative cancellation
        // ... do a unit of work ...
        std::this_thread::sleep_for(1ms);
    }
    std::puts("worker observed stop, exiting cleanly");
}

int main() {
    std::jthread jt{poll};   // first arg is auto-filled with a stop_token
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    // ~jthread(): request_stop() THEN join() — no terminate, no leak.
}
```

Two wins over `std::thread`:

1. **RAII join.** No `std::terminate` landmine; exception-safe by construction
   (an exception between launch and `join()` no longer kills the process).
2. **Cooperative cancellation.** If the callable's first parameter is a
   `std::stop_token`, `jthread` injects one and its destructor calls
   `request_stop()` before joining. You poll `stop_requested()` (or register a
   `std::stop_callback`). Note: it is *cooperative* — there is no way to forcibly
   kill a thread in standard C++, by design.

## Passing arguments — the copy-by-default trap

Arguments are **copied (decay-copied) into thread-internal storage**, then
passed to the callable. This bites people who expect reference semantics:

```cpp
#include <thread>
#include <string>
#include <functional>   // std::ref / std::cref

void by_value(std::string s);        // gets its own copy
void by_ref(std::string& s);         // wants to mutate the caller's object

int main() {
    std::string cfg = "AAPL";

    std::thread a{by_value, cfg};         // cfg is COPIED into the thread
    std::thread b{by_ref, std::ref(cfg)}; // must wrap: std::ref to bind a reference
    // std::thread c{by_ref, cfg};        // WON'T COMPILE: the internal copy
    //                                     // is an rvalue, can't bind to string&

    a.join();
    b.join();
}
```

- A bare argument is **copied**, even when the target takes a reference — the
  copy is what would bind, which usually fails to compile (good) or silently
  copies (bad). Use **`std::ref` / `std::cref`** to genuinely pass a reference.
- Because it's a copy, passing a **pointer or reference to a local that the
  parent then destroys** is a dangling-reference bug — especially with
  `detach()`. The decay-copy protects the *top-level* argument, not what it
  points at.
- Member functions: pass the pointer-to-member and the object pointer:
  `std::thread{&Strategy::run, &strat, arg}`.

```cpp
// Pitfall: capturing by reference into a detached thread.
void launch() {
    int local = 42;
    std::thread{[&]{ use(local); }}.detach();  // BUG: 'local' dies when launch() returns
}                                              // the lambda reads freed stack
```

The lambda form is usually clearest for non-trivial captures, but `[&]` plus
`detach()` is the canonical use-after-free. Capture by value, or don't detach.

## Getting a result out: `std::async` / `std::future`

`std::thread` returns nothing. For a fire-and-collect computation, use
`std::async`, which hands back a `std::future` that propagates the return value
*and* any exception across the thread boundary.

```cpp
#include <future>
#include <vector>

double pnl(const std::vector<double>& fills);   // defined elsewhere

int main() {
    std::vector<double> fills = /* ... */ {};
    std::future<double> f =
        std::async(std::launch::async, pnl, std::cref(fills));
    // ... do other work concurrently ...
    double total = f.get();   // blocks; re-throws if pnl() threw
}
```

Pass `std::launch::async` explicitly — the default policy *permits* the runtime
to run it lazily on `get()` (deferred, no new thread at all), which is rarely
what you want and a common gotcha.

## What it actually costs

Threads are not free, and in HFT the cost model dictates the architecture.

```text
operation                          rough cost
---------------------------------- -------------------------------
std::thread / jthread creation     ~10-50 microseconds (syscall: clone),
                                   default stack reservation ~8 MiB (Linux)
join() of finished thread          ~1-10 microseconds
context switch (involuntary)       ~1-5 microseconds + cold caches/TLB
std::async (per call)              creation cost; libstdc++ does not pool
```

Concrete consequences for a trading stack:

- **Never create threads in the hot path.** Thread creation is a syscall
  costing tens of microseconds — eternity when your tick-to-trade budget is
  single-digit microseconds. Spin up a fixed set of long-lived worker threads
  at startup and feed them work via lock-free queues.
- **Don't oversubscribe.** More software threads than hardware cores means the
  scheduler time-slices you, injecting context switches that blow the cache and
  add jitter. Run *one busy thread per dedicated core*.
- **A blocked/sleeping thread costs cache and scheduler attention.** Hot-path
  threads typically *busy-poll* (spin) rather than block, trading a burned core
  for deterministic latency.

`std::thread::hardware_concurrency()` reports the number of hardware threads
(a *hint*, may be 0) — useful for sizing pools, but for HFT you size by your
core-pinning plan, not this number.

## Thread affinity / pinning (the teaser)

By default the OS scheduler can migrate your thread between cores. Each
migration is a disaster for latency: cold L1/L2, a TLB flush, and lost branch-
predictor state. HFT processes therefore **pin** each critical thread to a
dedicated, isolated core (`isolcpus`, `nohz_full`, IRQ steering) so it owns
that core's caches and is never preempted.

The standard library has **no portable affinity API**, so you drop to the
platform layer via `native_handle()`:

```cpp
#include <thread>
#include <pthread.h>     // Linux/POSIX
#include <sched.h>

// Pin 'th' to a single logical CPU. Returns 0 on success.
int pin_to_core(std::thread& th, int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);                          // affinity mask = {cpu}
    return pthread_setaffinity_np(th.native_handle(),
                                  sizeof(set), &set);
}
```

On Windows the analogue is `SetThreadAffinityMask`. We treat pinning in depth
in its own lesson — for now, know that *launching* a hot thread and *placing*
it are two separate, equally important steps.

## Thread-local storage

`thread_local` gives each thread its own instance of a variable — handy for
per-thread scratch buffers, RNG state, or a per-thread arena allocator, with no
locking. The cost is an extra indirection on access and per-thread
construction/destruction; don't sprinkle it on hot scalars carelessly.

```cpp
thread_local std::array<char, 4096> scratch;  // one buffer per worker thread
```

## Quant/HFT relevance & interview gotchas

- **"What happens if you forget to join?"** `std::terminate`. Then pivot to
  `std::jthread` to show you'd avoid the problem structurally.
- **"How do you pass a reference to a thread?"** `std::ref`/`std::cref` — and
  explain *why* (decay-copy of arguments). Knowing the bare-reference case
  fails to compile is the senior detail.
- **"Why not spawn a thread per market message?"** Creation is a ~tens-of-µs
  syscall and oversubscription causes context-switch jitter. The architecture
  is *fixed worker pool + pinned cores + queues*, set up at startup.
- **`detach()` is almost always wrong** in a trading process: you lose
  shutdown ordering and invite use-after-free. Prefer joinable, owned threads
  with explicit lifetimes; use a stop_token for clean teardown.
- **`std::async` default launch policy** may defer execution to `get()` —
  always pass `std::launch::async` if you mean "run it now on another thread".
- **Exceptions don't cross `std::thread`** (an escaping exception calls
  `std::terminate`); they *do* cross `std::future`. Know the difference.

## Key takeaways

1. A `std::thread` is an owning RAII handle to one OS thread; it launches
   eagerly and **must be `join`ed or `detach`ed** before destruction or you get
   `std::terminate`.
2. Prefer **`std::jthread` (C++20)** — it auto-joins (RAII, exception-safe) and
   supports cooperative cancellation via `std::stop_token`. There is no forcible
   kill in standard C++.
3. Thread arguments are **decay-copied**; use **`std::ref`/`std::cref`** for
   real references, and never bind references/pointers to soon-dead locals
   (especially with `detach`).
4. Use **`std::async` + `std::future`** to return a value or propagate an
   exception across the boundary; pass `std::launch::async` explicitly.
5. Thread creation is a **~tens-of-µs syscall** with an MiB-scale stack —
   **never spawn in the hot path**; build a fixed, **pinned** worker pool at
   startup.

## Self-check

1. You construct a joinable `std::thread` and an exception is thrown before you
   reach `join()`. What happens, and how does `jthread` fix it?
2. Why does `std::thread{f, x}` for `void f(int&)` fail to compile, and what's
   the fix?
3. What does a `std::stop_token` give you that a raw `bool` flag does not, and
   why is cancellation "cooperative"?
4. A detached thread captures a local by reference. Describe the bug and when
   it fires.
5. Why is "one thread per incoming order" the wrong design for a tick-to-trade
   path? What do you do instead?
6. What's the difference in exception behaviour between `std::thread` and
   `std::async`?

## Further reading

- [`std::thread` — cppreference](https://en.cppreference.com/w/cpp/thread/thread) and [`std::jthread` — cppreference](https://en.cppreference.com/w/cpp/thread/jthread)
- [`std::stop_token` / `std::stop_source` — cppreference](https://en.cppreference.com/w/cpp/thread/stop_token)
- [`std::async` — cppreference](https://en.cppreference.com/w/cpp/thread/async) (note the launch-policy gotcha)
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — Ch. 2 ("Managing threads") is the definitive treatment of join/detach and argument passing.
- [`pthread_setaffinity_np(3)` — man page](https://man7.org/linux/man-pages/man3/pthread_setaffinity_np.3.html) for the affinity teaser.
- [P0660 — "Stop Token and Joining Thread" proposal](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2019/p0660r10.pdf), the rationale behind `jthread`.

## Videos

- Arthur O'Dwyer — **"Back to Basics: Concurrency"** (CppCon) ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Concurrency+Arthur+O%27Dwyer)) — clean coverage of thread lifecycle and `jthread`.
- Anthony Williams — **"Concurrency in C++20 and Beyond"** ([search](https://www.youtube.com/results?search_query=Anthony+Williams+Concurrency+in+C%2B%2B20+and+Beyond)) — `jthread`, stop tokens, and more from the author of the book.
