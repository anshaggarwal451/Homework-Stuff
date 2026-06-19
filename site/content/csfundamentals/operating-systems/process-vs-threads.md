# Process vs Threads

> **Why a quant dev must own this:** The choice between processes and threads
> decides what your trading system *shares* and what it *isolates* — and it sets
> the floor on your latency. Threads share an address space, so passing an order
> book between them costs a pointer; processes pay a copy or a shared-memory
> dance. But threads also share faults: one bad write corrupts everyone. In an
> HFT shop you'll be expected to know exactly what a thread shares with its
> siblings, why a Linux thread is "just a process that shares more," and what a
> context switch actually costs.

## First principles: two ways to get concurrency

You have one machine and you want several streams of execution. There are two
classic answers:

- A **process** is an instance of a running program with its *own* virtual
  address space, its own file-descriptor table, its own copy of globals — a unit
  of **isolation and resource ownership**.
- A **thread** is a single flow of control *within* a process — a unit of
  **scheduling**. Multiple threads in one process share that process's address
  space and resources.

The intuition: a process is the apartment (walls, a front door, its own
plumbing); threads are the people living in it (each does their own thing, but
they share the kitchen and can read each other's mail). Spawn a second apartment
and the two are firewalled from each other; add a roommate and you get
concurrency cheaply, at the cost of trust.

## What threads share, and what they don't

This is the single most-asked interview question on this topic. Within one
process, threads **share** everything that belongs to the process and keep
**private** only what is intrinsically per-flow-of-control:

| Resource | Shared across threads? | Notes |
|---|:---:|---|
| Code / text segment | Shared | One copy of the program. |
| Global / static data, BSS | Shared | A global is visible to all threads — hence the need for locks/atomics. |
| Heap (`malloc`/`new`) | Shared | A pointer is valid in any thread. |
| Open file descriptors | Shared | Same FD table; one thread's `close()` affects all. |
| Current working dir, umask, PID | Shared | Process-level attributes. |
| Signal *dispositions* (handlers) | Shared | But signal *masks* are per-thread. |
| **Stack** | **Private** | Each thread gets its own stack (typically a few MB; `ulimit -s`). |
| **Registers / instruction pointer** | **Private** | The CPU context that gets saved on a switch. |
| **Thread-local storage (`thread_local`)** | **Private** | One instance per thread. |
| `errno` | **Private** | It's `thread_local` under the hood — a classic gotcha. |
| Kernel thread ID (TID) | **Private** | `gettid()`; the PID is shared. |

> **The mental model:** threads share *what the process owns* and privatize
> *what a CPU needs to run a single instruction stream* — the stack and the
> registers. Everything else follows from that.

Two processes share *nothing* by default. To communicate they must use explicit
IPC: pipes, sockets, signals, or — the one that matters for HFT — **shared
memory** (`shm_open` + `mmap`, or `mmap` of a file), which maps the same
physical pages into two distinct address spaces.

## The PCB, the task_struct, and the big Linux reveal

Every classic OS textbook describes a **Process Control Block (PCB)**: the
kernel's per-process bookkeeping — PID, state, register save area, page-table
pointer, FD table, credentials, accounting. On Linux this structure is
`struct task_struct` (in `include/linux/sched.h`).

Here is the part that reframes the whole topic. **On Linux there is no separate
"thread" object in the kernel.** Both a process and a thread are represented by
the same `task_struct`. What differs is *how much they share*, and that's
controlled by the flags you pass to one syscall: **`clone()`**.

- `fork()` calls `clone()` with almost nothing shared → a new address space
  (copy-on-write), new FD table copy, new everything. That's a **process**.
- Creating a thread calls `clone()` with `CLONE_VM | CLONE_FS | CLONE_FILES |
  CLONE_SIGHAND | CLONE_THREAD | CLONE_SETTLS | ...` → the new task *shares* the
  caller's address space (`CLONE_VM`), file table, signal handlers, and lives in
  the same thread group (`CLONE_THREAD`, so it shares the PID). That's a
  **thread**, what the kernel calls a **Lightweight Process (LWP)**.

So a Linux thread is "a task that shares its `CLONE_VM` address space with its
siblings." The thread's kernel-visible ID is its **TID**; all threads in a
process share one **TGID** (= the PID you see). `getpid()` returns the TGID;
`gettid()` returns the per-thread TID.

```c
// The essence of "a thread is a task with shared resources."
// (Real code uses pthreads/std::thread; clone() directly is rarely hand-written.)
#define _GNU_SOURCE
#include <sched.h>
#include <stdlib.h>

static int worker(void* arg) { /* runs in the SAME address space */ return 0; }

void spawn_thread_like(void) {
    const size_t STACK = 1 << 20;            // threads need an explicit stack
    char* stack = malloc(STACK);
    // Shared VM + files + signals + same thread group == a thread, not a process
    clone(worker, stack + STACK,             // stack grows down -> pass the top
          CLONE_VM | CLONE_FS | CLONE_FILES |
          CLONE_SIGHAND | CLONE_THREAD,
          NULL);
}
```

See `clone(2)` for the full flag list — `CLONE_VM` (share memory), `CLONE_FILES`
(share FD table), `CLONE_THREAD` (same thread group / PID), `CLONE_SETTLS` (set
up TLS).

## 1:1 vs M:N — Linux is 1:1 (NPTL)

There are two ways to map user-level threads onto kernel-schedulable entities:

- **1:1 (kernel-level threads):** every user thread is backed by one kernel
  task. The kernel scheduler sees and schedules each thread directly.
- **M:N (user-level / "green" threads):** *M* user threads multiplexed onto *N*
  kernel threads by a userspace scheduler. Cheap to create, but a blocking
  syscall can stall all M, and it can't exploit multiple cores without help.

Modern Linux uses the **1:1 model** via **NPTL** (Native POSIX Thread Library,
the pthreads implementation in glibc). Each `std::thread`/`pthread_create`
produces one kernel task via `clone()`. The upside: true parallelism across
cores and clean blocking semantics. The cost: thread creation and context
switches go through the kernel. (M:N lives on in *language* runtimes — Go
goroutines, fibers, C++ coroutines — layered on top of 1:1 OS threads.)

## Threads in idiomatic C++

```cpp
#include <thread>
#include <atomic>
#include <vector>
#include <cstdio>

std::atomic<long> g_counter{0};   // shared: lives in the process, all threads see it
thread_local long t_local = 0;    // private: one instance per thread (TLS)

void work(int id, int iters) {
    for (int i = 0; i < iters; ++i) {
        g_counter.fetch_add(1, std::memory_order_relaxed); // shared -> must be atomic
        ++t_local;                                          // private -> no sync needed
    }
    std::printf("thread %d local=%ld\n", id, t_local);
}

int main() {
    std::vector<std::thread> pool;
    for (int i = 0; i < 4; ++i) pool.emplace_back(work, i, 1'000'000);
    for (auto& t : pool) t.join();   // MUST join (or detach) before ~thread()
    std::printf("shared counter = %ld\n", g_counter.load());
}
// Compile: g++ -O2 -std=c++20 t.cpp -pthread
```

Two non-negotiables: a `std::thread` must be `join()`ed or `detach()`ed before
its destructor runs (otherwise `std::terminate`), and anything *shared* and
mutated needs an atomic or a mutex — `g_counter` would race without it. The
`thread_local` `t_local` needs no synchronization because each thread has its
own copy. See [`std::thread` on cppreference](https://en.cppreference.com/w/cpp/thread/thread).

## Performance & hardware reality

Order-of-magnitude figures (always benchmark your own box; these are *approx*):

| Operation | Approx cost | Why |
|---|---|---|
| Thread creation (`pthread_create`) | ~tens of µs | `clone()`, stack allocation, kernel bookkeeping. |
| Process creation (`fork`+`exec`) | ~hundreds of µs to ms | New address space, page-table setup, copy-on-write metadata; grows with mapped memory. |
| **Context switch (thread ↔ thread, same process)** | ~1–2 µs (often less) | Save/restore registers; **no page-table (CR3) reload**, so the TLB survives. |
| **Context switch (process ↔ process)** | larger | Address space changes → **CR3 reload flushes the TLB** (absent PCID/tagged TLB), then cold-cache refills. This is the real cost. |
| `thread_local` access | ~1 instruction | TLS via the `%fs` segment base on x86-64 — a register-relative load. |

The headline for low latency: a **same-process thread switch keeps the address
space**, so the TLB and much of the cache stay warm. A **process switch reloads
`CR3`** and (without PCID tagging) invalidates the TLB, so the first accesses
after the switch take page-table walks and cache misses. That asymmetry — not
the raw "save the registers" cost — is why threads context-switch cheaper than
processes. (For the scheduler mechanics behind *when* a switch happens, see the
sibling lessons on scheduling and context switching.)

## When to use which

- **Threads** when components must share large mutable state with the lowest
  latency — e.g. a market-data decoder thread feeding a strategy thread through
  a lock-free ring buffer in shared heap. Communication is a pointer hand-off.
- **Processes** when you want **fault and security isolation** — a crash or a
  wild pointer in one process can't corrupt another's memory. Common for
  supervisor/control-plane components, risk gateways, or untrusted plugins.
- **Processes + shared memory** is the HFT sweet spot when you want isolation
  *and* fast data sharing: separate address spaces for safety, with one
  `mmap`'d region (often hugepage-backed) for the hot data path.

## Quant/HFT relevance & interview gotchas

- **Prefer threads + shared memory in the hot path, and *pin* them.** Bind each
  hot thread to a dedicated, isolated core (`pthread_setaffinity_np` /
  `taskset`, plus kernel `isolcpus`/`nohz_full`) so it's never migrated and
  never preempted. A migration cold-starts your caches — death by L1/L2 miss.
- **Do not oversubscribe.** More runnable threads than cores forces the
  scheduler to time-slice, injecting context-switch latency and jitter into your
  critical path. The classic HFT layout is *one hot thread per core*, busy-
  polling, with housekeeping shoved onto other cores.
- **`errno` is `thread_local`** — a favorite gotcha. So is the rule that signal
  *masks* are per-thread but *handlers* are process-wide; deliver signals to a
  dedicated thread and block them on the hot threads.
- **False sharing.** Two threads writing to different variables that happen to
  sit on the *same 64-byte cache line* serialize via the coherence protocol.
  Pad/align hot per-thread data to a cache line (`alignas(64)`).
- **"Is a Linux thread a process?"** The senior answer: in the kernel both are
  `task_struct`s created by `clone()`; a thread just shares more (`CLONE_VM`,
  `CLONE_THREAD`, …) and shares the TGID. Linux is **1:1 / NPTL**.
- **Fork in a multithreaded program is treacherous** — only the calling thread
  survives in the child, and mutexes held by other threads stay locked forever.
  (See the process-creation lesson.)

## Key takeaways

1. A **process** is the unit of isolation and resource ownership (its own
   address space); a **thread** is the unit of scheduling within a process.
2. Threads **share** code, globals, heap, and FDs; they **privatize** the
   **stack**, **registers**, and **TLS** (including `errno`).
3. On Linux, processes and threads are both `task_struct`s created by
   **`clone()`** — a thread is just a task with `CLONE_VM | CLONE_THREAD | …`.
4. Linux threading is **1:1 (NPTL)**: one kernel task per user thread, giving
   true multicore parallelism.
5. A **same-process thread switch keeps the address space** (TLB/cache warm); a
   **process switch reloads `CR3`** and tends to flush the TLB — the dominant
   cost difference.
6. HFT default: **threads + shared memory, pinned to isolated cores, never
   oversubscribed**; use processes when you need crash/security isolation.

## Self-check

1. Name three things threads in a process share and three things they keep
   private. Which list does `errno` fall into, and why?
2. On Linux, what single syscall creates both processes and threads, and which
   flag is the one that makes the difference between them?
3. Why does a process-to-process context switch typically cost more than a
   thread-to-thread switch within the same process?
4. What does "Linux uses a 1:1 threading model" mean, and what's the tradeoff
   versus an M:N model?
5. You have an 8-core box and spawn 64 busy-polling worker threads for a
   latency-critical task. What goes wrong, and what's the right design?
6. Why is calling `fork()` from one thread of a multithreaded process dangerous?

## Further reading

- [`clone(2)` — man7.org](https://man7.org/linux/man-pages/man2/clone.2.html) — the flags that turn a task into a thread.
- [`pthreads(7)` — man7.org](https://man7.org/linux/man-pages/man7/pthreads.7.html) — NPTL, what's per-thread vs per-process.
- [`gettid(2)` — man7.org](https://man7.org/linux/man-pages/man2/gettid.2.html) and [`getpid(2)`](https://man7.org/linux/man-pages/man2/getpid.2.html) — TID vs TGID.
- [`std::thread` — cppreference](https://en.cppreference.com/w/cpp/thread/thread) and [`thread_local`](https://en.cppreference.com/w/cpp/keyword/thread_local).
- Robert Love, *Linux Kernel Development*, 3rd ed. — Ch. 3 (Process Management) and Ch. 4 (the `task_struct`, `clone`).
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 12 (Concurrent Programming) — processes vs threads vs I/O multiplexing.
- [LWN: "The native POSIX thread library"](https://lwn.net/Articles/) — search LWN for NPTL design articles.

## Videos

- *CppCon* — **Carl Cook, "When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why HFT pins threads and avoids the scheduler.
- *Computerphile* — **"Processes and Threads"** ([search](https://www.youtube.com/results?search_query=computerphile+processes+and+threads)) — the gentle intuition pump.
