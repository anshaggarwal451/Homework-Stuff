# Context Switching and System Calls

> **Why a quant dev must own this:** On the critical path between a packet
> arriving and your order leaving the NIC, *every microsecond of jitter is a
> fill you lose to someone faster.* Context switches and system calls are the
> two ways your hot thread loses the CPU or pays a ring transition — and both
> are far more expensive than the arithmetic they interrupt. Knowing exactly
> what they cost, and how to avoid them, is the difference between a tail
> latency you can sell and one you can't.

## Two distinct events that beginners conflate

There are two separate transitions people lump together, and HFT interviewers
love to make you tease them apart:

- **Mode switch (privilege transition):** the CPU moves from user mode
  (ring 3) to kernel mode (ring 0) and back. Triggered by a *system call*, an
  *interrupt*, or an *exception*. The *same thread* keeps running — only the
  privilege level changed. This is comparatively cheap (~tens to a few hundred
  nanoseconds).
- **Context switch:** the kernel saves one task's CPU state and loads another's,
  so a *different* thread/process now runs on the core. This is much more
  expensive — direct cost plus a long indirect tail from cold caches and TLB.

A system call always involves a mode switch; it does **not** necessarily cause a
context switch. A blocking syscall (e.g. `read()` on an empty socket) typically
does — the kernel parks you and schedules someone else. A non-blocking syscall
that completes immediately is "just" a mode switch.

## What a context switch actually saves and restores

When the scheduler decides task B should run instead of task A on a given core,
the kernel must make the core's visible state *be* B's state. The work splits
into two layers.

### The architectural CPU state

- **General-purpose registers** (`rax`, `rbx`, … `r15`), the stack pointer
  (`rsp`), the instruction pointer (`rip`), and the flags register.
- **Floating-point / SIMD state**: the `x87`/SSE/AVX register file. This is
  large (AVX-512 alone is 2 KB of `zmm` registers) so the kernel uses lazy
  and `XSAVE`/`XRSTOR`-optimised paths to avoid touching it when unused.
- **Segment registers and the FS/GS base** (`fs.base` holds the thread-local
  storage pointer on x86-64).

### The address space (the expensive part)

This is where **process switch vs thread switch** diverges sharply:

| Switch kind | Address space (`CR3`) changes? | TLB consequence |
|---|---|---|
| Thread → thread, *same* process | No — same page tables | TLB stays warm |
| Thread → thread, *different* process | Yes — `CR3` reloaded | TLB largely flushed* |
| → kernel thread and back | No user `CR3` change | Cheap |

\*With **PCID** (process-context identifiers, x86-64) the CPU can tag TLB
entries per-address-space, so a `CR3` reload need not flush everything — but
KPTI (the Meltdown mitigation) complicates this. Conceptually: switching
*between processes* reloads the page-table base register `CR3`, which on older
hardware flushes the TLB and forces a storm of page walks afterward.

The takeaway: **a switch between two threads of the same process is materially
cheaper than a switch between two processes**, because the address space (and
thus the TLB) is shared.

```text
Task A running ──► timer IRQ / blocking syscall / yield
                     │
              [enter kernel: mode switch]
                     │
        save A: GP regs, rip, rsp, flags, FP/SIMD (lazy)
                     │
        scheduler picks B (see "Process Scheduling")
                     │
        load B: registers; if different process, reload CR3
                     │     (TLB invalidated unless PCID-tagged)
              [exit kernel: mode switch]
                     │
Task B running ──► ... runs on cold caches/TLB for a while
```

## Voluntary vs involuntary switches

- **Voluntary**: the task gives up the CPU itself — it called a blocking syscall
  (`read`, `futex(FUTEX_WAIT)`, `nanosleep`, `poll`) and there's nothing to do,
  so it sleeps. Counted in `voluntary_ctxt_switches`.
- **Involuntary**: the scheduler *preempted* the task — its time slice expired,
  or a higher-priority task became runnable. Counted in
  `nonvoluntary_ctxt_switches`.

You can read both counters per process:

```bash
$ grep ctxt /proc/self/status
voluntary_ctxt_switches:        12
nonvoluntary_ctxt_switches:     3
```

For an HFT hot thread, **both numbers should be ~0 per second** once it's
spinning. A rising `nonvoluntary` count means something is preempting your
core (another runnable task, a kernel thread, an unpinned interrupt) — a red
flag you chase down with `isolcpus`/`nohz_full` (see *Process Scheduling*).

## The system-call mechanism on x86-64

A modern syscall does **not** use the old `int 0x80` software interrupt. Since
the Pentium era, x86-64 uses the dedicated `syscall`/`sysret` instruction pair,
which is much faster because it avoids the interrupt-descriptor-table lookup.

```text
user code:  mov rax, <syscall number>   ; e.g. 1 = write
            mov rdi, fd                  ; args in rdi, rsi, rdx, r10, r8, r9
            mov rsi, buf
            mov rdx, len
            syscall                      ; <-- traps into kernel
            ; return value comes back in rax
```

What `syscall` does in hardware:

1. Saves `rip` → `rcx` and `rflags` → `r11` (so `sysret` can restore them).
2. Loads the kernel entry point from the **`MSR_LSTAR`** model-specific register
   (set up once at boot) into `rip`, and switches to ring 0.
3. The kernel entry stub switches to the kernel stack, saves the user registers,
   dispatches on `rax` through the syscall table, then returns via `sysret`.

The ABI matters in interviews: arguments go in `rdi, rsi, rdx, r10, r8, r9`
(note `r10`, not `rcx`, because `syscall` clobbers `rcx`), the number in `rax`,
the result back in `rax`. From C you normally let glibc wrap this; the raw
escape hatch is `syscall(2)`:

```cpp
#include <unistd.h>
#include <sys/syscall.h>   // SYS_* numbers
#include <ctime>

// Call clock_gettime via the generic syscall() wrapper — useful when glibc
// lacks a wrapper, or to prove a point about cost. Normally you'd just call
// clock_gettime() directly (which may go through the vDSO — see below).
long raw_clock(struct timespec* ts) {
    return syscall(SYS_clock_gettime, CLOCK_MONOTONIC, ts);
}
```

## The vDSO: syscalls that never trap

Some "system calls" are pure reads of kernel-maintained data — they don't need
any privileged action, just access to a value the kernel keeps current.
Trapping into the kernel for those would be wasteful. The kernel solves this
with the **vDSO** (virtual dynamic shared object): a small shared library the
kernel maps into *every* process's address space, containing user-mode
implementations of a handful of calls.

```bash
$ ldd /bin/ls | grep vdso
linux-vdso.so.1 (0x00007ffd...)   # not a real file — injected by the kernel
```

`clock_gettime`, `gettimeofday`, `time`, and `getcpu` are served from the vDSO:
the kernel publishes the current time (and a `rdtsc`-scaling factor) into a
shared page, and the vDSO code reads it **entirely in user mode** — no `syscall`
instruction, no ring transition. That turns a ~hundreds-of-nanoseconds trap into
a ~tens-of-nanoseconds function call. This is why `clock_gettime(CLOCK_MONOTONIC)`
is the *only* high-resolution clock you should reach for in a hot loop:

```cpp
#include <ctime>
// On a vDSO-enabled kernel this does NOT trap into the kernel: it reads the
// shared timekeeping page in user mode. Cheap enough for hot-path timestamps.
inline long now_ns() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);   // resolved via vDSO
    return ts.tv_sec * 1'000'000'000L + ts.tv_nsec;
}
```

Some HFT shops go further and timestamp with **`rdtsc`/`rdtscp`** directly
(reading the CPU's cycle counter), then convert to nanoseconds offline — even
cheaper than the vDSO, but you own the invariant-TSC calibration and core-skew
problems yourself.

## Approximate costs (orders of magnitude, not benchmarks)

Treat these as the rough figures every HFT engineer carries in their head; exact
numbers depend on CPU, kernel, and mitigations:

| Operation | Approx. direct cost |
|---|---|
| Plain function call / `rdtsc` | ~1–30 cycles |
| `clock_gettime` via vDSO | ~tens of ns |
| Trivial syscall (`getpid`) round-trip | ~hundreds of ns |
| Same after KPTI/Meltdown mitigations | meaningfully worse (extra `CR3` flips) |
| Context switch (direct) | ~1–a few µs |
| Context switch (incl. indirect cache/TLB refill) | can dwarf the direct cost |

The **indirect** cost of a context switch is the killer and the part juniors
forget: when your thread resumes, its working set may have been evicted by
whatever ran in between, so the next thousands of instructions stall on L2/L3/RAM
misses and TLB refills. The "1 µs" you read about is only the bookkeeping; the
true penalty is the cold restart that follows.

> **KPTI/Meltdown note:** *Kernel page-table isolation* gives the kernel a
> separate set of page tables, so every syscall now also flips `CR3` on entry
> and exit, adding TLB pressure. On affected CPUs this roughly doubled trivial
> syscall cost. It's why "is this box patched?" is a real latency question.

## Measuring it

```bash
# How many syscalls does this program make, and which?
strace -c ./my_feed_handler            # summary count per syscall
strace -f -e trace=read,write ./app    # trace specific calls (HEAVY overhead)

# Context switches over time, per process:
pidstat -w -p <pid> 1                  # cswch/s (vol) + nvcswch/s (invol)

# Cycle-accurate: count switches and syscalls without strace's overhead:
perf stat -e context-switches,cpu-migrations ./app
perf trace ./app                       # strace-like but far cheaper
```

Note that `strace` itself adds enormous overhead (it `ptrace`s every call), so
use it to *find* surprise syscalls, never to *measure* hot-path latency — use
`perf` for that.

## Quant/HFT relevance & interview gotchas

- **Eliminate syscalls from the hot path.** Each is a mode switch (hundreds of
  ns) and may block. Pre-allocate buffers (no `malloc`→`mmap`→syscall), use
  `MSG_ZEROCOPY`/kernel-bypass (DPDK, Solarflare/Onload, `io_uring`) so packet
  I/O doesn't trap, and never log via `write()` inline — push to a queue a
  separate core drains.
- **Eliminate context switches: busy-poll.** The hot thread spins reading the
  NIC rather than calling a blocking `recv()`/`epoll_wait()` that would sleep
  it. A spinning thread pinned to an isolated core is *never* descheduled, so
  it never pays the cold-restart tail. (See *Process Scheduling* for `isolcpus`
  + `nohz_full` + `SCHED_FIFO`.)
- **Know the mode-switch vs context-switch distinction cold** — it's a classic
  screening question. "Does a system call cause a context switch?" Answer: a
  mode switch always; a context switch only if it blocks or gets preempted.
- **Timestamping**: `clock_gettime(CLOCK_MONOTONIC)` via vDSO, or `rdtscp` for
  the lowest overhead. Never `gettimeofday` for intervals (wall clock can jump);
  never a raw syscall when the vDSO path exists.
- **Thread vs process switch cost**: be ready to explain *why* same-process
  thread switches are cheaper (shared `CR3`/page tables → warm TLB). This also
  motivates threads over processes for tightly-coupled low-latency components.
- **Gotcha**: "spinning wastes a core." Correct — and in HFT that's the *point*.
  You buy a deterministic core specifically to burn it so latency is flat.

## Key takeaways

1. A **mode switch** changes privilege level (same thread); a **context switch**
   changes which thread runs. A syscall always does the former, only sometimes
   the latter.
2. A context switch saves/restores GP + FP/SIMD registers, `rip`, `rsp`, flags;
   a **process** switch additionally reloads `CR3`, invalidating the TLB
   (mitigated by PCID).
3. Switches are **voluntary** (blocked on a resource) or **involuntary**
   (preempted); watch `/proc/<pid>/status` — a hot thread should show ~0/s.
4. x86-64 syscalls use the `syscall`/`sysret` pair via `MSR_LSTAR`; the
   **vDSO** serves `clock_gettime`/`gettimeofday`/`getcpu` without trapping.
5. Rough costs: vDSO clock ~tens of ns, trivial syscall ~hundreds of ns
   (worse post-KPTI), context switch ~µs *plus* a much larger indirect
   cache/TLB-refill tail.
6. HFT strategy: **busy-poll on a pinned isolated core and keep syscalls out of
   the hot path** so you pay neither cost where it counts.

## Self-check

1. A thread calls `getpid()`. Does this cause a context switch? A mode switch?
2. Why is switching between two threads of the same process cheaper than between
   two different processes? Name the register and the hardware structure
   involved.
3. How can `clock_gettime` return without ever executing a `syscall`
   instruction? What kernel mechanism enables this?
4. You see `nonvoluntary_ctxt_switches` climbing on your pinned hot thread at
   500/s. Give two plausible causes and how you'd remove them.
5. Why did the Meltdown mitigation (KPTI) make plain syscalls slower, in terms
   of `CR3` and the TLB?
6. Why is `strace -c` a bad tool for measuring hot-path latency, and what would
   you use instead?

## Further reading

- [`syscall(2)` — man7.org](https://man7.org/linux/man-pages/man2/syscall.2.html) — the x86-64 calling convention and syscall numbers.
- [`vdso(7)` — man7.org](https://man7.org/linux/man-pages/man7/vdso.7.html) — what the vDSO provides and how it's mapped.
- [`clock_gettime(2)` — man7.org](https://man7.org/linux/man-pages/man2/clock_gettime.2.html) and [`getrusage(2)`](https://man7.org/linux/man-pages/man2/getrusage.2.html) (`ru_nvcsw`/`ru_nivcsw`).
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 8 (Exceptional Control Flow) — traps, interrupts, and context switches from first principles.
- [LWN: "KAISER: hiding the kernel from user space"](https://lwn.net/Articles/738975/) — the page-table isolation work behind KPTI and its syscall cost.
- [Brendan Gregg — "perf Examples"](https://www.brendangregg.com/perf.html) — measuring context switches and syscalls with `perf`.
- [Gabriel Krisman — "How does the Linux kernel handle a system call"](https://0xax.gitbooks.io/linux-insides/content/SysCall/) (linux-insides) — the entry-stub internals.

## Videos

- *Computerphile* — **"What Is a Context Switch?"** ([search](https://www.youtube.com/results?search_query=computerphile+context+switch)).
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why hot-path syscalls and switches are banned.
- *Brendan Gregg* — **"Linux Systems Performance"** ([search](https://www.youtube.com/results?search_query=Brendan+Gregg+Linux+Systems+Performance)) — context-switch and syscall observability in context.
