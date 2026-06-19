# Process Scheduling

> **Why a quant dev must own this:** The scheduler decides *whether your hot
> thread is on the CPU at the exact instant a quote arrives.* If the kernel
> deschedules it for even one tick to run a cron job, a kworker, or another
> strategy, you've added microseconds — or milliseconds — of jitter to a path
> that's supposed to be deterministic. HFT systems don't tune the scheduler so
> much as **engineer it out of the critical path entirely**, and explaining how
> is a staple of low-latency interviews.

## First principles: why a scheduler exists

You have more runnable threads than CPU cores, so the OS must time-multiplex
them. The **scheduler** is the kernel code that, on each core, picks which
runnable task to run next and for how long. Its goals are in tension:

- **Throughput** — get the most useful work done.
- **Latency / responsiveness** — wake the right task quickly.
- **Fairness** — don't starve anyone.
- **Determinism** — for real-time work, *predictable* wake-up beats *fast on
  average*.

A general-purpose scheduler optimises for fairness and throughput. HFT wants
determinism, and the two goals fight — which is the whole story of this lesson.

## Mechanics: run queues, time slices, preemption

Each CPU has its own **run queue** of runnable tasks (per-CPU queues avoid a
global lock and keep cache locality; the scheduler periodically *load-balances*
tasks between them). A task is in one of a few states:

```text
        ┌─────────┐   schedule()    ┌──────────┐
        │ RUNNABLE │ ───────────────►│ RUNNING  │
        │ (on rq)  │◄─────────────── │ (on CPU) │
        └─────────┘   preempted /    └──────────┘
            ▲          slice expired       │
            │                              │ blocks (I/O, futex, sleep)
            │  event/wakeup                ▼
        ┌───────────────────────────────────────┐
        │ BLOCKED / SLEEPING (off the run queue) │
        └───────────────────────────────────────┘
```

- A **time slice** (quantum) is the max time a task runs before the scheduler
  reconsiders. When it expires, a timer interrupt fires and the kernel may
  **preempt** the task (an *involuntary* context switch — see *Context Switching
  and System Calls*).
- **Preemption** also happens immediately when a *higher-priority* task becomes
  runnable. Linux is a preemptive kernel; the `PREEMPT_RT` patch set (now largely
  mainline) makes even kernel code preemptible for hard real-time use.

## Linux scheduling classes

Linux doesn't have one scheduler — it has a stack of **scheduling classes**,
consulted in strict priority order. A class only gets the CPU if no higher class
has a runnable task.

| Class | Policy constants | Use | Priority |
|---|---|---|---|
| Stop / Deadline | `SCHED_DEADLINE` | EDF: tasks with `(runtime, deadline, period)` | Highest |
| Real-time | `SCHED_FIFO`, `SCHED_RR` | Fixed RT priority 1–99 | High |
| Fair (normal) | `SCHED_OTHER` (a.k.a. `SCHED_NORMAL`), `SCHED_BATCH` | Everyday tasks; `nice` -20…+19 | Normal |
| Idle | `SCHED_IDLE` | Only runs when nothing else can | Lowest |

So a `SCHED_FIFO` task at priority 50 will preempt **every** normal/CFS task and
run until *it* blocks or yields — which is exactly the hammer HFT reaches for,
and exactly the footgun that can lock up a core if misused.

### The fair class: CFS, now EEVDF

For decades `SCHED_OTHER` used the **Completely Fair Scheduler (CFS)**. CFS
gives each task a **virtual runtime (`vruntime`)** that advances as it runs,
scaled by its `nice` weight (a low-nice/high-priority task's `vruntime` advances
*slower*, so it's picked more often). The scheduler keeps runnable tasks in a
red-black tree keyed by `vruntime` and always runs the leftmost (least-run)
task. The effect: over time everyone gets a *weighted-fair* share of the CPU,
and `nice` just tilts the weights.

Since Linux **6.6** the fair class default is **EEVDF** (Earliest Eligible
Virtual Deadline First), which adds a per-task *latency* dimension: a task can
be marked latency-sensitive (`sched_setattr` with `sched_runtime`/a latency nice)
and get scheduled sooner without grabbing more total CPU. For interviews, know:
*CFS = weighted fair sharing via `vruntime`; EEVDF refines it to also bound
wake-up latency.* Neither is appropriate for your hot thread — both will
happily deschedule it to be "fair."

### `nice` and priority

```cpp
#include <sys/resource.h>
// nice ranges -20 (most favourable) .. +19 (least). Lowering nice asks CFS to
// give this thread a larger weighted share — it does NOT make it real-time.
setpriority(PRIO_PROCESS, 0 /*self*/, -5);
```

A common junior mistake is thinking a very negative `nice` guarantees the CPU.
It doesn't — it only re-weights the fair share. To *guarantee* you run ahead of
normal work, you must change *class* to a real-time policy.

## Going real-time: `sched_setscheduler` and affinity

The HFT recipe has two ingredients: put the hot thread in a real-time class, and
**pin** it to a core nothing else uses.

```cpp
#include <pthread.h>
#include <sched.h>
#include <cstring>
#include <cstdio>

// Pin the calling thread to a single CPU and make it SCHED_FIFO.
// Requires CAP_SYS_NICE (run as root or grant the capability).
void make_realtime_pinned(int cpu) {
    // 1) Pin to one core so the scheduler never migrates us (cache/TLB stay warm).
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if (sched_setaffinity(0 /*self*/, sizeof(set), &set) != 0)
        std::perror("sched_setaffinity");

    // 2) Real-time class: FIFO means we run until WE block/yield — no time slice.
    sched_param sp{};
    sp.sched_priority = 80;                  // 1..99; leave headroom below 99
    if (sched_setscheduler(0, SCHED_FIFO, &sp) != 0)
        std::perror("sched_setscheduler");   // EPERM if you lack CAP_SYS_NICE
}
```

- **`SCHED_FIFO`**: no time slice. The task runs until it blocks, yields
  (`sched_yield`), or a *higher*-priority RT task preempts it. Two FIFO tasks at
  the same priority do **not** round-robin — the running one keeps the core.
- **`SCHED_RR`**: like FIFO but same-priority tasks round-robin on a quantum.
- **`SCHED_DEADLINE`**: you declare `(runtime, deadline, period)` and the kernel
  admits the task only if it's schedulable (EDF). Powerful for periodic work;
  rarer in HFT than raw FIFO + isolation.

> **Footgun:** a `SCHED_FIFO` thread that busy-loops and never blocks will
> monopolise its core — fine on an *isolated* core, catastrophic if it shares a
> core with a kernel thread it depends on. That's the deadlock behind the
> classic "I set SCHED_FIFO and the box froze" story. The kernel's
> `RLIMIT_RTTIME` / `sched_rt_runtime_us` throttle exists as a safety net.

### Pinning with the higher-level API

```cpp
// From pthreads, set affinity on a specific thread handle:
cpu_set_t set; CPU_ZERO(&set); CPU_SET(3, &set);
pthread_setaffinity_np(thread.native_handle(), sizeof(set), &set);
```

From the shell, `taskset -c 3 ./app` pins, and `chrt -f 80 ./app` sets
`SCHED_FIFO` priority 80 without touching code.

## CPU isolation: getting the kernel off your core

Pinning isn't enough — by default the kernel still puts *other* tasks, kernel
threads, RCU callbacks, and device interrupts on "your" core. You isolate it at
boot via kernel command-line parameters:

| Parameter | Effect |
|---|---|
| `isolcpus=2,3` | Remove cores 2,3 from the scheduler's general load-balancing; nothing lands there unless explicitly pinned |
| `nohz_full=2,3` | **Tickless** on these cores: stop the periodic 100/250/1000 Hz timer interrupt when one task runs, removing per-tick jitter |
| `rcu_nocbs=2,3` | Offload RCU callback processing off these cores |
| `irqaffinity=0,1` | Route device interrupts to the housekeeping cores, not the isolated ones |

You also steer NIC interrupts away from the hot core by writing the IRQ's
`/proc/irq/<n>/smp_affinity`, and you can confine the rest of the system to the
housekeeping cores with **cpusets** (`cgroup` cpusets) so userspace daemons can't
wander onto core 3.

> **The tickless kernel matters more than people think.** A normal core takes a
> scheduler-tick interrupt hundreds of times a second — each is a mode switch and
> a cache perturbation. `nohz_full` lets a single-task core run with the timer
> tick effectively off, removing that recurring jitter. Verify with
> `cat /proc/interrupts` that the local-timer count on your core is ~flat.

## The HFT pattern: outrun the scheduler by never yielding

Put it together and the design is counter-intuitive but standard:

```text
Boot:  isolcpus=2,3  nohz_full=2,3  rcu_nocbs=2,3  irqaffinity=0,1

Core 3 (isolated):  hot thread, SCHED_FIFO, pinned, spinning:
        while (running) {
            poll_nic();            // busy-poll — never blocks, never sleeps
            if (have_packet) process_and_send();
        }
        // Never calls a blocking syscall, so the scheduler is NEVER invoked.
        // The thread holds the core 100% of the time → zero descheduling jitter.

Cores 0,1 (housekeeping):  OS, logging, telemetry, slow-path work.
```

You deliberately **burn a whole core at 100%** so that latency is *flat*. The
scheduler is never asked to make a decision on the hot path, so it can't add
jitter. This is the inversion juniors miss: in HFT you don't make the scheduler
faster, you arrange never to call it.

## Priority inversion (the classic scheduling bug)

A low-priority task holds a lock the high-priority task needs; a medium-priority
task then preempts the low one, so the high-priority task is *indirectly* blocked
by a medium one. This sank the **Mars Pathfinder** mission (a high-rate task
stalled behind a low one). Fixes: **priority inheritance** (the lock-holder
temporarily inherits the waiter's priority — `PTHREAD_PRIO_INHERIT` mutexes) or
**priority ceiling**. Covered in depth in *Deadlocks, Starvation, and Livelock*;
mentioned here because it's a *scheduling* phenomenon.

## Quant/HFT relevance & interview gotchas

- **The full recipe**, recited confidently, is the answer they want: *isolate
  cores (`isolcpus`), make them tickless (`nohz_full`), pin the hot thread
  (`sched_setaffinity`), give it `SCHED_FIFO`, move IRQs and kernel threads off
  the core, and busy-poll so the scheduler is never invoked on the critical
  path.*
- **`nice` ≠ real-time.** Be ready to explain that `nice` only re-weights CFS
  fair shares; to preempt normal work you change *class* to `SCHED_FIFO`/`RR`.
- **`SCHED_FIFO` doesn't round-robin** equal priorities — the runner keeps the
  core until it blocks. `SCHED_RR` does. Know the difference.
- **CFS → EEVDF** since 6.6; if asked "how does Linux schedule normal tasks,"
  say weighted-fair via `vruntime` (CFS), now latency-aware EEVDF.
- **Why burn a core?** Because a spinning, pinned, FIFO thread on an isolated
  core is *never descheduled*, so it never pays the context-switch cold-restart
  tail. Determinism is worth one core.
- **NUMA**: pin the hot thread, its memory, and the NIC IRQ to the *same* NUMA
  node, or you pay cross-socket latency. `numactl --cpunodebind --membind`.
- **Gotcha**: setting `SCHED_FIFO` on a thread that *shares* a core with its own
  helper (or a kernel thread it waits on) can hang the system — always pair it
  with isolation, and know `sched_rt_runtime_us` is the throttle that saves you.

## Key takeaways

1. Linux uses **scheduling classes** in priority order: `DEADLINE` > RT
   (`FIFO`/`RR`) > fair (`SCHED_OTHER`, now **EEVDF**, formerly CFS) > `IDLE`.
2. **CFS** shares CPU weighted-fairly via `vruntime`; **`nice`** only tilts that
   weight — it is *not* a real-time guarantee.
3. To run ahead of everything, change *class* to **`SCHED_FIFO`** (no time
   slice; runs until it blocks) via `sched_setscheduler`, needing `CAP_SYS_NICE`.
4. **Pin** the hot thread with `sched_setaffinity` to keep caches/TLB warm and
   stop migration.
5. **Isolate** the core at boot — `isolcpus` + `nohz_full` (tickless) +
   `rcu_nocbs` + IRQ affinity — so nothing else, not even the timer tick,
   perturbs it.
6. The HFT endgame is to **busy-poll on that core and never invoke the
   scheduler** on the hot path: deterministic latency in exchange for one fully
   burned core.

## Self-check

1. Why does a very negative `nice` value still not guarantee your thread runs
   ahead of another `SCHED_OTHER` thread?
2. Two `SCHED_FIFO` threads have equal priority on one core. What happens? How
   does the answer change for `SCHED_RR`?
3. You pinned your hot thread to core 3 with `sched_setaffinity` but still see
   jitter every ~10 ms. Name three sources still landing on core 3 and the boot
   parameter or `/proc` knob that removes each.
4. What does `vruntime` represent in CFS, and how does `nice` affect how fast it
   advances?
5. Explain priority inversion and one kernel mechanism that prevents it.
6. Why is it *rational* for an HFT process to peg a core at 100% with a spinning
   thread instead of sleeping until data arrives?

## Further reading

- [`sched(7)` — man7.org](https://man7.org/linux/man-pages/man7/sched.7.html) — the authoritative overview of all policies and classes.
- [`sched_setscheduler(2)`](https://man7.org/linux/man-pages/man2/sched_setscheduler.2.html), [`sched_setaffinity(2)`](https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html), and [`nice(2)`](https://man7.org/linux/man-pages/man2/nice.2.html).
- [`CFS Scheduler` — kernel.org docs](https://docs.kernel.org/scheduler/sched-design-CFS.html) and the [`EEVDF` design notes](https://docs.kernel.org/scheduler/sched-eevdf.html).
- [LWN: "An EEVDF CPU scheduler for Linux"](https://lwn.net/Articles/925371/) — what changed and why.
- [`NO_HZ` / tickless kernel — kernel.org docs](https://docs.kernel.org/timers/no_hz.html) and the [CPU isolation docs](https://docs.kernel.org/admin-guide/kernel-per-CPU-kthreads.html).
- Robert Love, *Linux Kernel Development*, Ch. 4 (Process Scheduling) — run queues, priorities, preemption from the kernel's side.
- [Red Hat — "Low Latency Performance Tuning Guide"](https://access.redhat.com/articles/3720611) — `isolcpus`/`nohz_full`/IRQ-affinity in practice.

## Videos

- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — core pinning and isolation for trading.
- *Brendan Gregg* — **"Linux Systems Performance"** ([search](https://www.youtube.com/results?search_query=Brendan+Gregg+Linux+Systems+Performance)) — scheduler observability and `cpu-migrations`.
- CppCon — **"Trading at light speed: designing low latency systems in C++"** (David Gross) ([search](https://www.youtube.com/results?search_query=CppCon+trading+at+light+speed+low+latency+C%2B%2B)).
