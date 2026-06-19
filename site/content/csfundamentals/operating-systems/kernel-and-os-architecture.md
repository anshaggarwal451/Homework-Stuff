# Kernel and OS Architecture

> **Why a quant dev must own this:** Every interaction with the outside world —
> reading a socket, locking memory, yielding the CPU — crosses the boundary
> between your code (user space, ring 3) and the kernel (ring 0). That crossing
> is not free: a syscall is *approx* hundreds of nanoseconds, worsened by
> Spectre/Meltdown mitigations, and a context switch through the scheduler is
> more. In HFT, latency *is* the product, so understanding what the kernel is,
> why the boundary costs what it costs, and why people bypass it entirely
> (kernel-bypass networking) is foundational. "What happens when you call
> `read()`?" is an interview classic that tests exactly this.

## First principles: what a kernel is for

A computer must run untrusted, buggy, mutually-distrustful programs on shared
hardware without letting any one of them crash the machine, read another's
memory, or monopolize the CPU. The **kernel** is the one piece of software
trusted to mediate all of that. It is the layer that:

- **arbitrates the CPU** (the scheduler decides who runs),
- **arbitrates memory** (virtual memory, page tables, isolation),
- **owns the hardware** (device drivers, interrupts),
- **provides services** to user programs through a controlled interface (system
  calls).

Everything else — your shell, your compiler, your trading engine — is **user
space**: ordinary programs that ask the kernel for help when they need a
privileged operation.

## Privilege levels: ring 0 vs ring 3

The CPU enforces the user/kernel split in hardware via **protection rings**. x86
defines rings 0–3; Linux uses just two:

- **Ring 0 (kernel mode):** full privilege. Can execute privileged instructions,
  touch any physical memory, program the MMU and devices, disable interrupts.
- **Ring 3 (user mode):** restricted. Privileged instructions trap; memory
  accesses go through the process's page tables; I/O is forbidden directly.

User code *cannot* simply jump into the kernel. The only sanctioned doorways are
**controlled transitions**: a deliberate **system call**, a **trap/exception**
(e.g. a page fault, divide-by-zero), or a hardware **interrupt**. Each switches
the CPU to ring 0 at a kernel-defined entry point — you never get to choose where
in the kernel you land.

```text
   USER SPACE (ring 3)                 KERNEL SPACE (ring 0)
  +---------------------+   syscall    +-------------------------+
  | your trading app    | -----------> | syscall entry / dispatch|
  | libc wrappers       |   (trap)     |  scheduler  | mem mgmt  |
  |                     | <----------- |  VFS/fs     | net stack |
  +---------------------+   return     |  drivers    | ...       |
        |  ^                           +-------------------------+
        |  | interrupts / faults                 |
        v  |                                      v
  +-------------------------------------------------------------+
  |                        HARDWARE                             |
  +-------------------------------------------------------------+
```

## The system-call interface

A **system call** is how user code requests a privileged service. On x86-64
Linux the libc wrapper places the syscall number in `%rax` and arguments in
`%rdi, %rsi, %rdx, %r10, %r8, %r9`, then executes the **`syscall`** instruction.
The CPU switches to ring 0, jumps to the kernel's entry handler, which dispatches
on the number, runs the service, and returns to ring 3 with the result in `%rax`.

```c
#include <unistd.h>
#include <sys/syscall.h>
#include <stdio.h>

int main() {
    // getpid via the normal libc wrapper...
    long a = getpid();
    // ...and via the raw syscall interface (same effect, no wrapper).
    long b = syscall(SYS_getpid);
    printf("getpid()=%ld  syscall(SYS_getpid)=%ld\n", a, b);
}
// Compile: cc s.c -o s && ./s
// Inspect the boundary crossings:  strace ./s   (each line is one syscall)
```

`strace` is the practical lens: it logs every user↔kernel crossing. Profiling a
hot loop and seeing unexpected `read`/`write`/`futex` syscalls is how you catch
latency leaks.

## Kernel architecture: monolithic vs microkernel vs hybrid

How much code runs in ring 0 is the defining architectural choice:

| Model | Where subsystems run | Pros | Cons | Example |
|---|---|---|---|---|
| **Monolithic** | Scheduler, MM, filesystems, drivers, net stack all in **kernel space**, one address space | Fast (no IPC between subsystems — just function calls) | Large trusted base; a driver bug can crash the kernel | **Linux** (modular monolithic), classic Unix |
| **Microkernel** | Only the bare minimum (scheduling, IPC, basic MM) in ring 0; drivers, FS, net run as **user-space servers** | Strong isolation, smaller trusted base, restartable services | Lots of message-passing IPC → overhead | MINIX, seL4, QNX |
| **Hybrid** | Mix; some servers in kernel for speed | Pragmatic blend | Blurry boundaries | Windows NT, XNU (macOS) |

**Linux is a modular monolithic kernel.** All core subsystems share one kernel
address space and call each other directly (fast), but functionality can be
loaded and unloaded at runtime as **kernel modules** (`insmod`/`rmmod`/`modprobe`,
e.g. a NIC driver), giving some of the flexibility of a microkernel without the
IPC cost.

## The major subsystems

A useful mental inventory of what lives in the Linux kernel:

- **Process scheduler** — decides which runnable task gets a CPU and for how
  long (CFS / EEVDF; plus real-time classes `SCHED_FIFO`/`SCHED_RR`). Detailed
  in the scheduling lesson.
- **Memory management** — virtual memory, page tables, the page cache, demand
  paging, swap, the OOM killer (virtual-memory lesson).
- **VFS and filesystems** — the abstraction that makes ext4, XFS, tmpfs, and
  `/proc` all answer `open`/`read`/`write`.
- **Networking stack** — sockets, TCP/IP/UDP, routing, the NIC driver path. *This
  is the one HFT works hardest to avoid* (below).
- **Device drivers** — the bulk of kernel code by line count; mediate hardware.
- **IPC, security (LSM/SELinux), timekeeping, interrupts.**

## Interrupts and softirqs (high level)

The kernel can't poll every device, so hardware signals it asynchronously via
**interrupts**. An interrupt suspends whatever's running, switches to ring 0, and
runs a short **interrupt handler** (top half). To keep that fast, deferrable work
is pushed to **softirqs/tasklets/workqueues** (bottom half) — e.g. a NIC raises
an interrupt when a packet arrives; the softirq later pushes it up the network
stack. Interrupts are a *source of jitter* on a latency-critical core, which is
why HFT operators steer IRQs away from hot cores (IRQ affinity) and rely on
**polling** instead of interrupts in the data path. The mechanics of polling vs
interrupts get their own lesson — this is the forward reference.

## The cost of crossing the boundary

This is the number that matters for HFT. A user↔kernel round trip is not just a
function call:

| Event | Approx cost | What happens |
|---|---|---|
| **System call round trip** | ~hundreds of ns (≳1 µs in bad cases) | `syscall` trap → save user state → kernel entry → service → return; worse with **Spectre/Meltdown mitigations** (KPTI page-table switch, retpolines, flushes). |
| **Context switch** | larger; ~µs | Scheduler picks another task; register save/restore; process switch reloads **CR3** and (without PCID) flushes the TLB → cold caches afterward. |
| **Interrupt** | variable | Asynchronous; injects jitter into a hot core's run. |

The headline: a syscall is *cheap relative to disk* but *enormous relative to a
nanosecond-scale trading reaction*. **Meltdown/Spectre mitigations** (notably
**KPTI**, which unmaps most of the kernel from the user page tables and so forces
a page-table switch on every syscall) roughly doubled syscall cost on affected
CPUs — a concrete reason a system designed in 2016 felt slower in 2018 on the
same hardware.

## Why kernel-bypass exists in HFT

Put the boundary cost and the network stack together and the HFT conclusion
follows directly: **every syscall and context switch is latency you can't
afford**, so in the data path you *minimize crossings* — and for networking you
*eliminate them entirely*.

- **Busy-poll in user space.** Instead of `epoll`/`read` (which sleep and wake —
  syscalls + scheduler involvement + interrupts), a hot thread spins on a memory
  location, never yielding, pinned to an isolated core. No syscall, no context
  switch, no interrupt-driven wakeup.
- **Kernel-bypass networking.** Frameworks like **DPDK**, **Solarflare/Onload**,
  and **AF_XDP** map the NIC's ring buffers directly into user space, so packets
  are read and written **without traversing the kernel network stack at all**.
  You trade the kernel's generality and safety for raw latency. (This gets its
  own dedicated lesson — here it's the motivating forward reference.)

The general principle a senior candidate states cleanly: *the fastest syscall is
the one you don't make.* You design the hot path to never touch the kernel in
steady state.

## Quant/HFT relevance & interview gotchas

- **"What happens when you call `read()`?"** — Walk it: libc wrapper sets up
  `%rax`+args → `syscall` traps to ring 0 → kernel VFS dispatches → may block
  (scheduler runs someone else) or copy from the page cache → return to ring 3.
  Naming the ring transition and the possible context switch is the senior tell.
- **Syscalls and context switches are latency.** Count them (`strace`/`perf`).
  Eliminate them from the hot path: pre-allocate, pre-fault, `mlock`, busy-poll.
- **Spectre/Meltdown mitigations made syscalls more expensive** (KPTI,
  retpolines). Know this is *why* the boundary cost is higher than textbook
  numbers from a decade ago.
- **Linux is modular-monolithic** — be able to contrast with microkernel and say
  why monolithic is faster (direct calls, no inter-subsystem IPC) but has a
  larger trusted base.
- **IRQs cause jitter.** On a hot core you isolate it (`isolcpus`,
  `nohz_full`), steer interrupts elsewhere (IRQ affinity), and poll rather than
  take interrupts.
- **Kernel bypass** (DPDK/Onload/AF_XDP) is the logical endpoint: the network
  data path that never enters the kernel.

## Key takeaways

1. The **kernel** (ring 0) arbitrates the CPU, memory, and hardware for
   untrusted **user-space** (ring 3) programs; the CPU enforces the split in
   hardware via protection rings.
2. User code enters the kernel only through **controlled transitions**: a
   **system call** (`syscall` instruction → trap), an exception/trap, or a
   hardware **interrupt** — never an arbitrary jump.
3. **Linux is a modular monolithic kernel**: all subsystems share one address
   space (fast direct calls) but functionality loads as **kernel modules**.
   Contrast: microkernel (servers in user space, IPC overhead) and hybrid.
4. Core subsystems: **scheduler, memory management, VFS/filesystems, network
   stack, drivers**, plus interrupts/softirqs.
5. Crossing the boundary costs: a **syscall** is *approx* hundreds of ns
   (worsened by **Spectre/Meltdown mitigations** like KPTI); a **context switch**
   is more and can flush the TLB on a process switch.
6. HFT minimizes crossings: **busy-poll in user space** and use **kernel-bypass
   networking** (DPDK/Onload/AF_XDP) so the data path never enters the kernel.

## Self-check

1. What are ring 0 and ring 3, and what are the *only* ways user code can end up
   executing in ring 0?
2. Trace what happens, step by step, when a program calls `read()` on a socket —
   include the ring transition and where a context switch might occur.
3. Why is Linux called "modular monolithic"? Contrast its performance and
   trusted-base size with a microkernel.
4. Approximately what does a system call cost, and what did Spectre/Meltdown
   mitigations (e.g. KPTI) do to that cost and why?
5. Name four major kernel subsystems and one syscall that exercises each.
6. Why does HFT use busy-polling and kernel-bypass networking instead of
   `epoll`/`read`? What boundary costs are being avoided?

## Further reading

- [`syscall(2)` — man7.org](https://man7.org/linux/man-pages/man2/syscall.2.html) and [`syscalls(2)`](https://man7.org/linux/man-pages/man2/syscalls.2.html) — the calling convention and the full table.
- [`intro(2)` — man7.org](https://man7.org/linux/man-pages/man2/intro.2.html) — overview of the system-call interface.
- Robert Love, *Linux Kernel Development*, 3rd ed. — Ch. 1–2 (intro & the kernel), Ch. 5 (System Calls), Ch. 7–8 (Interrupts & bottom halves).
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 8 (Exceptional Control Flow) — traps, interrupts, system calls.
- [Linux kernel documentation (kernel.org)](https://www.kernel.org/doc/html/latest/) — authoritative subsystem docs.
- [Meltdown and Spectre — official site](https://meltdownattack.com/) and [LWN: KPTI / "the current state of kernel page-table isolation"](https://lwn.net/Articles/741878/) — why syscalls got more expensive.
- [Brendan Gregg — Linux Performance](https://www.brendangregg.com/linuxperf.html) — tracing syscalls/context switches with real tools.

## Videos

- *CppCon* — **Carl Cook, "When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — minimizing kernel crossings in trading systems.
- *Talk search* — **"kernel bypass DPDK low latency networking"** ([search](https://www.youtube.com/results?search_query=kernel+bypass+DPDK+low+latency+networking)) — why HFT leaves the kernel network stack behind.
