# Pipes and Message Queues

> **Why a quant dev must own this:** Pipes and message queues are the
> convenient, well-understood plumbing of Unix IPC — the right tool for the
> *control plane* (start/stop signals, config pushes, logging hand-off, wiring
> up child processes). They are also a trap if you reach for them on the *hot
> path*: every byte copies through the kernel and crossing the boundary costs a
> syscall. Knowing exactly where they shine and where shared memory must take
> over is a standard systems interview discriminator.

## First principles: a kernel-buffered, copy-through byte conduit

A pipe is a **unidirectional, in-kernel FIFO byte buffer** with a read end and a
write end, each exposed as a file descriptor. When you `write()` into it, the
kernel copies your bytes into a ring of pipe pages; when the reader `read()`s,
the kernel copies them out. That's **two copies and (at least) two syscalls per
message**, plus a wakeup of the sleeping peer — the same fundamental cost model
as a local socket, and the reason pipes belong on the control plane, not in a
market-data fast path (see [IPC Trade-offs](ipc-trade-offs-and-performance.md)).

```text
   writer process          KERNEL pipe buffer          reader process
   user buffer  --write()-->  [ ring of pages ]  --read()-->  user buffer
                  copy 1                            copy 2
```

There are two flavors:

- **Anonymous pipes** (`pipe(2)`) — no name in the filesystem; the only way a
  second process gets the fds is to **inherit them across `fork`**. This is how
  the shell wires `a | b`.
- **Named pipes / FIFOs** (`mkfifo(3)`) — a special file on disk that any two
  unrelated processes can `open()` by path. The data still lives only in the
  kernel buffer; the filesystem entry is just a rendezvous name.

## Anonymous pipes and the shell-plumbing idiom

`pipe(fds)` fills `fds[0]` (read end) and `fds[1]` (write end). After `fork`,
both processes hold both ends, so each side **closes the end it doesn't use** —
otherwise the reader never sees EOF (EOF arrives only when *all* write ends are
closed).

```cpp
// g++ -std=c++20 -O2 pipe_fork.cpp && ./a.out
#include <unistd.h>
#include <sys/wait.h>
#include <cstdio>
#include <cstring>

int main() {
    int fds[2];
    if (pipe(fds) < 0) { perror("pipe"); return 1; }   // fds[0]=read, fds[1]=write

    pid_t pid = fork();
    if (pid == 0) {                 // ---- child: writer ----
        close(fds[0]);              // close unused read end
        const char* msg = "hello from child\n";
        write(fds[1], msg, std::strlen(msg));
        close(fds[1]);              // closing write end signals EOF to reader
        _exit(0);
    } else {                        // ---- parent: reader ----
        close(fds[1]);              // close unused write end (critical for EOF)
        char buf[128];
        ssize_t n;
        while ((n = read(fds[0], buf, sizeof buf)) > 0)
            fwrite(buf, 1, n, stdout);   // n == 0 means EOF
        close(fds[0]);
        wait(nullptr);
    }
}
```

To reproduce `ls | wc -l`, a process `dup2`s a pipe end onto `STDIN_FILENO` /
`STDOUT_FILENO` before `exec`, so the child's standard streams *are* the pipe:

```cpp
// In the writer child, before exec: make stdout be the pipe's write end.
dup2(fds[1], STDOUT_FILENO);
close(fds[0]); close(fds[1]);
execlp("ls", "ls", nullptr);
```

## Named pipes (FIFOs)

```cpp
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

mkfifo("/tmp/feed.ctl", 0660);          // create the rendezvous name once

int wfd = open("/tmp/feed.ctl", O_WRONLY); // blocks until a reader opens it
write(wfd, "START\n", 6);

// elsewhere:
int rfd = open("/tmp/feed.ctl", O_RDONLY); // blocks until a writer opens it
```

A `O_RDONLY` open blocks until a writer appears (and vice versa) unless you pass
`O_NONBLOCK`. The data path is identical to anonymous pipes — only the discovery
mechanism differs.

## Pipe semantics you must know cold

- **Half-duplex.** A pipe carries data one direction. For bidirectional comms,
  create two pipes (or use a [Unix-domain socket](ipc-trade-offs-and-performance.md),
  which is full-duplex).
- **`PIPE_BUF` atomicity.** A `write` of `≤ PIPE_BUF` bytes (**4096 on Linux**)
  is **atomic** — it won't interleave with another writer's bytes. Larger writes
  may be split and interleaved. This matters when multiple producers share one
  pipe.
- **Capacity.** The kernel pipe buffer defaults to **64 KiB** on Linux
  (16 pages; tunable via `fcntl(fd, F_SETPIPE_SZ, …)`). A blocking `write` to a
  full pipe sleeps; a non-blocking one returns `EAGAIN`.
- **EOF and `SIGPIPE`/`EPIPE`.** Reading after all write ends close returns 0
  (EOF). **Writing when all read ends are closed raises `SIGPIPE`** — which
  *terminates your process by default*. Guard with `signal(SIGPIPE, SIG_IGN)`
  (then the `write` returns `-1`/`EPIPE`) or, for sockets, `MSG_NOSIGNAL`.

## Pipes as an event/wakeup mechanism: the self-pipe trick and eventfd

Because a pipe end is a file descriptor, it composes with `epoll`/`select`. The
classic **self-pipe trick** makes asynchronous events (signals, "stop now"
requests from another thread) wakeable inside a poll loop: a signal handler does
a single-byte `write` to the pipe; the event loop wakes because the read end
became readable.

Linux's purpose-built replacement is **`eventfd(2)`** — a kernel-maintained
64-bit counter behind a single fd, far cheaper than a pipe for pure wakeups:

```cpp
#include <sys/eventfd.h>
#include <cstdint>
int efd = eventfd(0, EFD_NONBLOCK);
uint64_t one = 1;
write(efd, &one, sizeof one);   // wake the poller
uint64_t cnt;
read(efd, &cnt, sizeof cnt);    // returns accumulated count, resets to 0
```

This is the canonical way to wake a busy [epoll loop](tcp-udp-system-calls.md)
from another thread, and it appears constantly in trading-system control planes.

## Message queues: discrete, prioritized messages

Pipes are an unstructured byte stream; **message queues preserve message
boundaries** and add priorities. Two incompatible APIs exist on Linux:

### POSIX message queues (prefer these)

`mq_open` / `mq_send` / `mq_receive`, backed by the `mqueue` virtual filesystem.
Names look like `/somequeue`. Each message has a **priority**; `mq_receive`
always returns the **highest-priority** message first. You can register
edge-triggered **notification** (`mq_notify`) via a signal or a thread — and the
queue's fd integrates with `epoll` (on Linux the descriptor is pollable).

```cpp
// g++ -std=c++20 -O2 mq_demo.cpp -lrt && ./a.out
#include <mqueue.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <cstring>
#include <cstdio>

int main() {
    mq_attr attr{};
    attr.mq_maxmsg  = 10;          // queue depth
    attr.mq_msgsize = 256;         // max bytes per message
    const char* name = "/demo_mq";

    mqd_t mq = mq_open(name, O_CREAT | O_RDWR, 0660, &attr);
    if (mq == (mqd_t)-1) { perror("mq_open"); return 1; }

    const char* m = "REBALANCE";
    // last arg is the message priority (higher = delivered first)
    if (mq_send(mq, m, std::strlen(m), /*prio=*/5) < 0) perror("mq_send");

    char buf[256];
    unsigned prio = 0;
    ssize_t n = mq_receive(mq, buf, sizeof buf, &prio);  // n bytes, prio out
    if (n >= 0) printf("got %.*s (prio %u)\n", (int)n, buf, prio);

    mq_close(mq);
    mq_unlink(name);               // remove the name; queue gone when last close
}
```

Note `-lrt` to link the POSIX realtime library. Default queue limits live in
`/proc/sys/fs/mqueue/`.

### System V message queues (legacy)

`msgget` / `msgsnd` / `msgrcv`, keyed by an integer `key_t` (often via `ftok`),
identified by an `int` id, messages tagged with a `long mtype` you can select on.
Functional but clunky: integer keys instead of paths, no fd so they **don't
compose with `epoll`**, and a global namespace (`ipcs`/`ipcrm` to inspect/clean).
For new code, prefer POSIX MQs.

## Copy semantics and where these belong

Every message-queue send/receive is, like a pipe, **two copies through the
kernel** (sender → kernel-held message → receiver) plus a syscall each way and a
wakeup. The structure (boundaries, priorities, notification) is the value-add,
not speed.

```text
   sender                                          receiver
   user buf --mq_send()--> [ kernel-held message ] --mq_receive()--> user buf
                copy 1                                   copy 2
```

| Mechanism | Boundaries? | Priorities? | Bi-dir? | Discovery | epoll-able |
|---|---|---|---|---|---|
| Anonymous pipe | No (byte stream) | No | No | inherit via `fork` | yes (fd) |
| FIFO | No (byte stream) | No | No | path (`mkfifo`) | yes (fd) |
| POSIX MQ | **Yes** | **Yes** | yes | name `/q` | yes (Linux) |
| System V MQ | Yes (`mtype`) | via `mtype` select | yes | `key_t` int | **no** |
| eventfd | counter only | — | — | inherit/fd-pass | yes |

## Performance and hardware reality

- A round trip through a pipe or MQ is **two copies + two syscalls + a wakeup**.
  Expect **single-digit microseconds** for a small message when the peer must be
  scheduled in — dominated by the **context switch (~1–5 µs)**, not the copy.
  When the reader is already spinning the syscall+copy alone can be sub-µs, but
  you're still paying the kernel crossing on every message.
- This is **one to two orders of magnitude** slower than a busy-polled
  shared-memory ring, which moves data in **tens to hundreds of nanoseconds**
  with **zero kernel involvement** after setup (see
  [POSIX Shared Memory](posix-shared-memory.md) and
  [Lock-Free IPC Patterns](lock-free-ipc-patterns.md)).
- `PIPE_BUF`-atomic small writes are genuinely useful for multi-producer log
  fan-in where you want non-interleaved lines without a lock.
- These are **order-of-magnitude** figures; measure on your hardware.

## Quant/HFT relevance & interview gotchas

- **Right tool, right plane.** Pipes/FIFOs/MQs are perfect for control-plane
  messaging — "halt strategy", config reload, a supervisor reaping workers,
  structured log shipping. They are **wrong for tick data**: the per-message
  kernel crossing kills the budget.
- **EOF requires closing *all* write ends.** The #1 pipe bug: a parent that
  forgot to `close(fds[1])` and now its reader hangs forever.
- **`SIGPIPE` will kill you.** Always ignore it or handle `EPIPE`.
- **`PIPE_BUF` atomicity (4096 on Linux)** — quoting this exact guarantee is a
  reliable senior signal.
- **POSIX vs System V MQ:** POSIX MQs have paths, priorities, `mq_notify`, and an
  epoll-able fd on Linux; System V MQs are legacy and don't integrate with poll.
- **`eventfd` over the self-pipe trick** for waking a poll loop on modern Linux —
  one fd, a counter, cheaper than a pipe.

## Key takeaways

1. A pipe is a unidirectional, in-kernel byte FIFO: **two copies + two syscalls +
   a wakeup** per message. FIFOs add a filesystem name; the data path is
   identical.
2. Close unused ends after `fork`; **EOF appears only when all write ends close**.
   Reading dead pipes gives 0; writing dead pipes raises **`SIGPIPE`/`EPIPE`** —
   guard it.
3. Writes ≤ **`PIPE_BUF` (4096 on Linux)** are atomic; the pipe buffer is **64 KiB**
   by default.
4. **POSIX message queues** preserve boundaries, support priorities and
   notification, and are epoll-able; **System V** MQs are the clunky legacy.
5. For wakeups, prefer **`eventfd`**; for the hot path, prefer **shared memory** —
   pipes/MQs are control-plane tools.

## Self-check

1. Why does a reader hang if the parent forgets to close the pipe's write end
   after `fork`?
2. Two threads write 8 KiB log lines into one pipe. Can the lines interleave?
   What about 100-byte lines? Why?
3. What happens when you `write` to a pipe whose read end has been closed, and how
   do you make that not kill your process?
4. Give two concrete advantages of a POSIX message queue over an anonymous pipe.
5. Why are pipes and message queues a poor fit for a market-data fast path, and
   what would you use instead?
6. How does the self-pipe trick let a signal wake an `epoll` loop, and what is the
   modern replacement?

## Further reading

- [`pipe(2)`](https://man7.org/linux/man-pages/man2/pipe.2.html) and [`pipe(7)`](https://man7.org/linux/man-pages/man7/pipe.7.html) — capacity, `PIPE_BUF` atomicity, EOF semantics.
- [`mkfifo(3)`](https://man7.org/linux/man-pages/man3/mkfifo.3.html) and [`fifo(7)`](https://man7.org/linux/man-pages/man7/fifo.7.html) — named pipes.
- [`mq_overview(7)`](https://man7.org/linux/man-pages/man7/mq_overview.7.html), plus [`mq_open(3)`](https://man7.org/linux/man-pages/man3/mq_open.3.html), [`mq_send(3)`](https://man7.org/linux/man-pages/man3/mq_send.3.html), [`mq_receive(3)`](https://man7.org/linux/man-pages/man3/mq_receive.3.html), [`mq_notify(3)`](https://man7.org/linux/man-pages/man3/mq_notify.3.html).
- [`eventfd(2)`](https://man7.org/linux/man-pages/man2/eventfd.2.html) and [`signal-safety(7)`](https://man7.org/linux/man-pages/man7/signal-safety.7.html) — the self-pipe trick's modern replacement and why signal handlers are restricted.
- [`svipc(7)`](https://man7.org/linux/man-pages/man7/sysvipc.7.html) and [`msgget(2)`](https://man7.org/linux/man-pages/man2/msgget.2.html) — the System V message-queue family.
- W. Richard Stevens, *Advanced Programming in the UNIX Environment* (APUE), ch. 15 — pipes, FIFOs, and IPC, the canonical treatment.

## Videos

- **Unix IPC: pipes and FIFOs** explained ([search](https://www.youtube.com/results?search_query=unix+pipes+fifo+ipc+explained+fork+dup2)).
- **POSIX message queues in C/Linux** walkthrough ([search](https://www.youtube.com/results?search_query=posix+message+queue+mq_open+linux+tutorial)).
