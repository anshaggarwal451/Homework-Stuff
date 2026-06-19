# IPC Trade-offs and Performance

> **Why a quant dev must own this:** "Which IPC mechanism would you use, and
> why?" is one of the most common HFT systems-design questions. The right answer
> is never a single mechanism — it's a *decision* driven by three axes: does the
> data **copy through the kernel**, does each operation cost a **syscall**, and
> does delivery require **putting a thread to sleep and waking it** (a context
> switch). Get those axes straight and you can derive the latency of any IPC
> mechanism from first principles, and explain why shared memory plus busy-poll
> wins the hot path while sockets and message queues belong on the control plane.

## The three axes that determine IPC latency

Every IPC mechanism's cost reduces to how many of these it pays per message:

1. **Kernel copies.** Does the data get copied user→kernel→user? Pipes, sockets,
   and message queues all copy **twice** through a kernel buffer. Shared memory
   copies **zero** times after setup — both processes touch the same pages.
2. **Syscalls.** Does moving each message require entering the kernel? A syscall
   is a **mode switch (~100 ns–1 µs)**, worse under speculative-execution
   mitigations. Pipes/sockets/MQs need one per op (batching amortizes it);
   shared memory needs **none** in steady state.
3. **Context switch / wakeup.** Does the receiver have to be *scheduled in*? If
   it was sleeping in `recv`/`mq_receive`, delivery costs a **context switch
   (~1–5 µs)** plus scheduler latency and cold caches. A **busy-polling** reader
   on shared memory never sleeps, so it pays none of this — it just sees the new
   value on its next spin.

```text
   slow path  (pipe/socket/MQ):
     send() ── syscall ── copy ── kernel buffer ── wakeup ── schedule ── copy ── recv()
       \____________ mode switch __________/   \_ context switch _/

   fast path (shared memory + busy-poll):
     store ──▶ same cache line ──▶ load
       (atomic release)              (atomic acquire, spinning)
```

That picture is the whole lesson: the slow path pays a mode switch and often a
context switch *per message*; the fast path pays neither.

## The big comparison table

Approximate, order-of-magnitude. "Latency" is a small-message one-way figure on a
modern Linux x86-64 box; treat ranges as guidance, not benchmarks.

| Mechanism | Kernel copies | Syscall per op | Context switch? | Approx latency | Topology | Persistence | Sync needed | Notes |
|---|---|---|---|---|---|---|---|---|
| **Shared memory + busy-poll** ([shm](posix-shared-memory.md), [lock-free ring](lock-free-ipc-patterns.md)) | 0 | none (steady state) | none | **~tens–few hundred ns** | 1:1, 1:N (broadcast ring) | tmpfs: none / file: yes | atomics/seqlock (you build it) | Fastest. No backpressure or safety from kernel. |
| **Shared memory + futex/mutex** | 0 | only to sleep/wake | only when it sleeps | ~hundreds ns–µs | 1:1, N:M | yes | process-shared mutex/cond | Zero-copy data, but sleeping costs the switch. |
| **mmap'd file** ([mmap](memory-mapped-files-mmap.md)) | 0 | on fault/`msync` | none | ~tens ns + fault | 1:N | **yes (disk)** | atomics/seqlock | Like shm but durable; great for journals. |
| **Unix-domain socket** | 2 | yes | usually | ~1–several µs | 1:1, with `SCM_RIGHTS` can pass fds | none | none (ordered) | Local sockets; can `SOCK_DGRAM`/`SOCK_STREAM`; lower overhead than TCP loopback. |
| **Loopback TCP/UDP** ([sockets](tcp-udp-system-calls.md)) | 2 | yes | usually | ~few µs | 1:1, UDP-mcast 1:N | none | none | Full stack even on loopback; UDP multicast for fan-out. |
| **Pipe / FIFO** ([pipes](pipes-and-message-queues.md)) | 2 | yes | usually | ~1–several µs | 1:1 (half-duplex) | none | none (byte stream) | Simple; `PIPE_BUF`-atomic small writes. |
| **POSIX / SysV message queue** ([MQ](pipes-and-message-queues.md)) | 2 | yes | usually | ~few µs | N:M | POSIX: until unlink | none | Message boundaries + priorities. |
| **eventfd / signals** | tiny | yes | usually | ~1 µs (eventfd) | wakeup only | none | n/a | Notification, not data transport. |

Read the table by the three axes: every row that copies twice and crosses the
kernel clusters at **microseconds**; every row that shares pages and avoids
sleeping drops to **tens-to-hundreds of nanoseconds**. The dividing line is the
kernel, not the API.

## Why shared memory wins the hot path

- **Zero copies:** the producer's store and the consumer's load hit the *same*
  physical page; the only "transfer" is the cache line migrating between cores
  via coherence — tens of nanoseconds, often less.
- **Zero syscalls in steady state:** after `mmap`, reads and writes are plain
  instructions. No mode switch per message.
- **No context switch:** a busy-polling reader is always runnable, so latency is
  bounded by "time until its next poll," not by the scheduler.

The cost is everything the kernel *was* doing for you: there's **no built-in
backpressure, no message framing, no security boundary, and no synchronization**.
You build the protocol yourself — typically a [lock-free SPSC ring or a
seqlock](lock-free-ipc-patterns.md) — and you pay a CPU core to spin. In HFT that
trade is obviously worth it.

## Why you still use sockets and message queues

Not everything is the hot path. The **control plane** — start/stop commands,
configuration pushes, health checks, order acknowledgements to a slower system,
cross-host communication — values **simplicity, safety, and ordering** over raw
latency:

- Sockets cross machine boundaries; shared memory can't.
- Message queues give you boundaries, priorities, and notification for free.
- Pipes are trivially correct and compose with `epoll`.
- The kernel provides **backpressure** (a full pipe/socket buffer blocks the
  writer) and **isolation** (a crashed reader can't corrupt the writer's memory)
  — both of which raw shared memory throws away.

The senior framing: **shared memory + busy-poll + lock-free ring for the data
plane; sockets / MQs / pipes for the control plane.**

## Batching and kernel-bypass: moving the dividing line

Two ways to cheat the syscall/copy tax without abandoning the kernel API:

- **Batching** — `recvmmsg`/`sendmmsg`, `io_uring` (one ring submission/completion
  for many ops). Cuts syscalls, not copies. Cheap, easy, still kernel-mediated.
- **Kernel bypass** — DPDK, Solarflare `ef_vi`, RDMA verbs map the NIC queues into
  user space so packets DMA straight to/from your buffers with **no kernel and no
  copy**. This is the network-facing analogue of shared-memory IPC: the ultimate
  zero-copy. Forward reference — see [Zero-Copy Techniques](zero-copy-techniques.md)
  for the in-kernel zero-copy primitives (`sendfile`, `splice`, `MSG_ZEROCOPY`)
  that sit between "naive socket" and "full bypass."

## A decision checklist

- **Same host, lowest latency, you control both ends?** → shared memory + atomics
  + busy-poll. ([shm](posix-shared-memory.md), [ring](lock-free-ipc-patterns.md))
- **Same host, need durability / a replayable journal?** → mmap'd file.
- **Need message boundaries / priorities / N:M, latency not critical?** → POSIX
  message queue.
- **Different hosts, or want kernel backpressure & isolation?** → sockets (UDP
  multicast for fan-out market data; TCP for reliable order entry).
- **Just need to wake a poll loop from another thread/signal?** → `eventfd`.
- **High packet rates but staying in-kernel?** → batch with `recvmmsg`/`io_uring`.
- **Need the absolute network floor?** → kernel bypass (DPDK/RDMA).

## Performance and hardware reality

- The constants to memorize as **orders of magnitude**: L1 hit ~1 ns, main memory
  ~100 ns, cross-core cache-line transfer ~tens of ns, syscall/mode switch
  ~100 ns–1 µs, context switch ~1–5 µs, loopback socket round trip a few µs.
- A mechanism's floor is the *sum* of the axes it triggers. Two copies + a syscall
  each way + a context switch ≈ microseconds, no matter how clever the API.
- **False sharing** and **NUMA** dominate the shared-memory case: a line ping-ponging
  between two cores, or crossing sockets, can cost far more than the "tens of ns"
  best case. Pad to cache lines and pin producer/consumer to the same NUMA node.
- All figures here are **rough, hardware-dependent rules of thumb** — the only
  authority is a measurement on your own machine.

## Quant/HFT relevance & interview gotchas

- **Lead with the three axes** (copies / syscalls / context switch), then derive
  the answer. That reasoning, not a memorized ranking, is what's being tested.
- **"Shared memory is fastest" is incomplete** without "...because it's zero-copy
  and needs no syscall or wakeup in steady state — at the cost of building your
  own synchronization, backpressure, and safety."
- **Loopback TCP is not free** — it still runs the full stack and copies twice.
  Unix-domain sockets are cheaper locally; shared memory cheaper still.
- **Busy-poll trades a core for latency.** Know when that's acceptable (dedicated
  HFT box) and when it isn't (shared/cloud host).
- **Backpressure and isolation** are the hidden features you *lose* with shared
  memory — be ready to name them.
- Know the **escape hatches**: batching (`recvmmsg`/`io_uring`) and kernel bypass
  (DPDK/RDMA) for the network path.

## Key takeaways

1. IPC latency is determined by three axes: **kernel copies**, **syscalls per
   op**, and **context switch on delivery**. Count them and you can rank any
   mechanism.
2. Pipes, sockets, and message queues all pay **two copies + a syscall + usually a
   wakeup** → **microseconds**. Shared memory pays **none of these** in steady
   state → **tens-to-hundreds of nanoseconds**.
3. **Hot path = shared memory + busy-poll + lock-free ring; control plane =
   sockets / MQs / pipes.** The kernel you're avoiding was providing backpressure,
   framing, and isolation — you now own those.
4. **Batching** (`recvmmsg`, `io_uring`) cuts syscalls cheaply; **kernel bypass**
   (DPDK/RDMA) removes the kernel and copies entirely for the network path.
5. The real-world floor of shared memory is set by **cache coherence, false
   sharing, and NUMA**, not by the API — measure, pad, and pin.

## Self-check

1. Name the three axes that determine IPC latency, and assign each to "kernel
   copies," "syscalls," or "context switch."
2. Why is a loopback TCP round trip in microseconds while a busy-polled
   shared-memory hand-off is in nanoseconds, given both stay on one machine?
3. What three kernel-provided guarantees do you give up by moving to raw shared
   memory, and how do you replace each?
4. When is a sleeping (futex/mutex) synchronization acceptable on shared memory,
   and when must you busy-poll instead?
5. Your feed handler is on the same host as the strategies, but a risk monitor is
   on another machine. Which IPC for each, and why?
6. How does `io_uring` reduce the syscall axis, and how does DPDK/RDMA reduce the
   copy axis? Which axes does each *not* address?

## Further reading

- [`pipe(7)`](https://man7.org/linux/man-pages/man7/pipe.7.html), [`unix(7)`](https://man7.org/linux/man-pages/man7/unix.7.html) (Unix-domain sockets, `SCM_RIGHTS`), [`mq_overview(7)`](https://man7.org/linux/man-pages/man7/mq_overview.7.html), [`shm_overview(7)`](https://man7.org/linux/man-pages/man7/shm_overview.7.html) — the mechanisms side by side.
- [`socket(7)`](https://man7.org/linux/man-pages/man7/socket.7.html) and [`udp(7)`](https://man7.org/linux/man-pages/man7/udp.7.html) — local vs network sockets and their buffers.
- [Efficient IO with io_uring (kernel.org PDF)](https://kernel.dk/io_uring.pdf) — Jens Axboe's design doc on amortizing the syscall axis.
- ["Ringing in a new asynchronous I/O API" — LWN](https://lwn.net/Articles/776703/) — io_uring introduction.
- Paul E. McKenney, [*Is Parallel Programming Hard, And, If So, What Can You Do About It?*](https://mirrors.edge.kernel.org/pub/linux/kernel/people/paulmck/perfbook/perfbook.html) — the cost model behind cache coherence and synchronization.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832) — the order-of-magnitude table to internalize.

## Videos

- CppCon — David Gross, **"Trading at Light Speed: Designing Low-Latency Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Trading+at+Light+Speed+low+latency+C%2B%2B)).
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)).
