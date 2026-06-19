# Zero-Copy Techniques

> **Why a quant dev must own this:** Copies are latency and cache pollution you
> can't always afford. A naive "read a file and send it on a socket" loop copies
> the data **four times** and crosses the kernel boundary twice. Zero-copy
> primitives — `sendfile`, `splice`/`vmsplice`, `MSG_ZEROCOPY`, `io_uring`
> registered buffers — eliminate most of those copies by moving *page references*
> instead of *bytes*. Knowing which copies exist, how each technique removes
> them, and the threshold below which zero-copy *loses* to a plain copy is exactly
> the depth an HFT interview is looking for.

## First principles: where the copies actually are

Take the textbook server operation — read bytes from a file and write them to a
socket:

```cpp
char buf[N];
read(file_fd, buf, N);     // disk/page-cache -> user buffer
write(sock_fd, buf, N);    // user buffer -> socket buffer
```

Count the data movements:

```text
  (1) disk ──DMA──▶ page cache            (storage read, unavoidable for cold data)
  (2) page cache ──CPU copy──▶ user buf   (the read() copy)
  (3) user buf ──CPU copy──▶ socket buf   (the write() copy)
  (4) socket buf ──DMA──▶ NIC             (transmit, unavoidable)
```

Two of those four — **(2) and (3)** — are pure **CPU copies through user space**
that exist only because the API forced the bytes to visit your buffer. They burn
memory bandwidth, evict useful data from cache, and add latency. "Zero-copy" means
**deleting copies (2) and (3)** so the data goes page-cache → NIC without ever
landing in user space. (The DMA transfers (1) and (4) are physics; you don't
remove them, you just stop adding to them.)

Note this is the *file→network* framing. For *process→process* on one host, the
zero-copy answer is [shared memory](posix-shared-memory.md): both processes map
the same pages, so there's no copy at all. The two stories converge — zero-copy is
always "share or move references to pages instead of copying their contents."

## `sendfile(2)`: file → socket inside the kernel

`sendfile` hands the whole job to the kernel: it moves data from a file fd to a
socket fd without it ever entering user space. Copies (2) and (3) vanish; on
hardware with **scatter-gather DMA** the page-cache pages are handed straight to
the NIC, so the only movements are the DMAs.

```cpp
// g++ -std=c++20 -O2 sendfile_demo.cpp -o sf
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>

// Send the entire file `in_fd` over connected socket `sock` — no user-space copy.
bool send_file(int sock, int in_fd) {
    struct stat st{};
    if (fstat(in_fd, &st) < 0) { perror("fstat"); return false; }
    off_t offset = 0;
    size_t remaining = st.st_size;
    while (remaining > 0) {
        // kernel copies file->socket directly; updates offset for us
        ssize_t sent = sendfile(sock, in_fd, &offset, remaining);
        if (sent < 0) {
            if (errno == EAGAIN) continue;   // non-blocking socket: retry
            perror("sendfile"); return false;
        }
        remaining -= sent;
    }
    return true;
}
```

Limitation: the source must be a file (mmap-able), the destination a socket, and
you can't transform the bytes in flight. It's the canonical static-content fast
path (web servers, log shipping).

## `splice`/`vmsplice`/`tee`: move pages between fds via a pipe

`splice(2)` is the general primitive: it moves data between two fds where **at
least one end is a pipe**, by **transferring page references into/out of the pipe
buffer** rather than copying bytes. Chain two splices and you connect any two fds
(file→pipe→socket) with no user-space copy:

```cpp
// g++ -std=c++20 -O2 splice_demo.cpp -o splice
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>

// file -> socket, zero-copy, via an intermediate pipe (the splice idiom).
bool splice_file_to_sock(int in_fd, int sock) {
    int pipefd[2];
    if (pipe(pipefd) < 0) { perror("pipe"); return false; }
    for (;;) {
        // (a) file pages -> pipe (no copy: pipe holds references to the pages)
        ssize_t n = splice(in_fd, nullptr, pipefd[1], nullptr,
                           65536, SPLICE_F_MOVE | SPLICE_F_MORE);
        if (n < 0) { perror("splice in"); break; }
        if (n == 0) { close(pipefd[0]); close(pipefd[1]); return true; } // EOF
        // (b) pipe -> socket (still no user-space copy)
        while (n > 0) {
            ssize_t m = splice(pipefd[0], nullptr, sock, nullptr,
                              n, SPLICE_F_MOVE | SPLICE_F_MORE);
            if (m < 0) { perror("splice out"); close(pipefd[0]); close(pipefd[1]); return false; }
            n -= m;
        }
    }
    close(pipefd[0]); close(pipefd[1]);
    return false;
}
```

Relatives:

- **`vmsplice(2)`** — splice *user-space pages* into a pipe by reference (the
  kernel can grab your pages without copying), then splice the pipe onward. Lets
  user data reach a socket zero-copy, but you must not modify those pages until
  the kernel is done with them.
- **`tee(2)`** — duplicate data between two pipes without consuming it (fan-out a
  stream to two consumers).

`SPLICE_F_MOVE` asks the kernel to move pages rather than copy; it's a hint.

## `mmap` + `write`: the older trick

[`mmap`](memory-mapped-files-mmap.md) the file, then `write` the mapping to the
socket. This removes copy (2) — the file is already mapped, so `write` copies
mapped page → socket buffer (one copy instead of two). It's strictly worse than
`sendfile`/`splice` (still one copy, plus page-fault and TLB overhead) and has a
nasty corner case: if the file is truncated while mapped you can take `SIGBUS`
mid-`write`. Mentioned because legacy code uses it and interviewers ask you to
compare.

## `MSG_ZEROCOPY`: zero-copy `send` from user buffers

For sending **your own** (non-file) data — a serialized order, a constructed
packet — Linux offers `MSG_ZEROCOPY`. You enable it once, then pass the flag on
`send`/`sendmsg`. Instead of copying your buffer into the socket, the kernel
**pins your user pages** and transmits directly from them.

The catch — and the thing to say in an interview — is that completion is
**asynchronous**: `send()` returns *before* the NIC is done, so **you must not
reuse or free the buffer** until the kernel signals completion. That signal
arrives on the socket's **error queue** (`MSG_ERRQUEUE`), read with `recvmsg`,
carrying an `SO_EE_ORIGIN_ZEROCOPY` notification with a sequence number matching
your send.

```cpp
// Sketch: enable, send zero-copy, then reap completion from the error queue.
#include <sys/socket.h>
#include <linux/errqueue.h>

int one = 1;
setsockopt(sock, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof one);   // enable once

// data must stay valid & unmodified until completion is reaped:
send(sock, data, len, MSG_ZEROCOPY);

// later, drain the error queue for the completion notification:
char ctrl[256];
msghdr msg{};
msg.msg_control = ctrl; msg.msg_controllen = sizeof ctrl;
recvmsg(sock, &msg, MSG_ERRQUEUE);   // contains sock_extended_err w/ seq range
// only now is it safe to reuse `data`
```

Per the kernel docs, `MSG_ZEROCOPY` **"replaces per-byte copy cost with page
accounting and completion-notification overhead, and is generally only effective
at writes over around 10 KB."** Below that threshold the pinning + completion
bookkeeping costs *more* than just copying the bytes. That size threshold is the
heart of every zero-copy trade-off.

## `io_uring`: registered buffers and zero-copy send

`io_uring` is the modern async-I/O interface: a shared **submission queue (SQ)**
and **completion queue (CQ)** mapped between user space and the kernel, so you
batch many operations with **few or zero syscalls**. For zero-copy it adds:

- **Registered (fixed) buffers** (`io_uring_register`) — pre-pin a set of buffers
  once, so individual ops skip per-call page pinning.
- **Fixed files** — pre-register fds to skip per-op fd lookup.
- **`IORING_OP_SEND_ZC`** — zero-copy send with completion delivered as a normal
  CQ entry (cleaner than the `MSG_ERRQUEUE` dance), again worthwhile mainly above
  a size threshold.

io_uring's win is two-fold: it attacks the **syscall axis** (batch/submit many
ops at once, even poll without syscalls) *and*, with registered buffers + `_ZC`,
the **copy axis**. It's the convergence point of batching (see
[IPC Trade-offs](ipc-trade-offs-and-performance.md)) and zero-copy.

## DMA, page pinning, and the page cache

Underlying all of this:

- **DMA** lets the NIC/disk read and write RAM without the CPU copying byte by
  byte — that's why DMAs (1)/(4) above aren't "copies" you fight.
- **Page pinning** (`get_user_pages`) locks user pages in physical RAM so DMA can
  target them safely; this is what `MSG_ZEROCOPY`/registered buffers do, and it
  has real cost (accounting, TLB/IOMMU setup) — the reason small transfers don't
  benefit.
- The **page cache** is the shared staging area that makes `sendfile`/`splice`
  zero-copy possible: the file's pages are already in RAM and can be referenced,
  not re-copied.

## The summary table

| Technique | Removes copies | Source → dest | Async completion? | Sweet spot |
|---|---|---|---|---|
| `read`+`write` (naive) | none | any → any | no | tiny/simple |
| `mmap`+`write` | (2) only | file → socket | no | legacy; random access |
| `sendfile` | (2),(3) | **file** → socket | no | static file → socket |
| `splice`/`vmsplice` | (2),(3) | any↔any via pipe | partial | proxying, transforming pipelines |
| `MSG_ZEROCOPY` | the user→socket copy | **user buf** → socket | **yes (`MSG_ERRQUEUE`)** | **large (≳10 KB)** sends |
| `io_uring` + reg. buffers + `SEND_ZC` | copy + syscall | user/file → socket | yes (CQ) | high op-rate, large sends |
| **Kernel bypass (DPDK/RDMA)** | all | NIC ↔ user buffer | n/a | the absolute floor (forward ref) |

## Performance and hardware reality

- Eliminating copies (2)/(3) saves **memory bandwidth and cache** more than raw
  cycles; the latency win grows with payload size, which is why every zero-copy
  send technique has a **size threshold (~10 KB for `MSG_ZEROCOPY`)** below which
  a plain copy is faster.
- Zero-copy adds *fixed* costs: **page pinning**, **completion notification**, and
  the discipline of not touching the buffer until it's reaped. For the **small
  messages typical of order entry** (tens to low-hundreds of bytes), a straight
  copy usually wins — don't reach for `MSG_ZEROCOPY` on a 64-byte order.
- The ultimate zero-copy on the network is **kernel bypass**: DPDK / Solarflare
  `ef_vi` / RDMA verbs map NIC queues into user space, so packets DMA directly
  to/from your buffers with **no kernel and no copy** — the network analogue of
  [shared-memory IPC](posix-shared-memory.md). This is where serious HFT lives;
  the in-kernel primitives above are the stepping stones.
- All figures are **order-of-magnitude** and payload-, NIC-, and kernel-dependent
  — benchmark your own path before committing.

## Quant/HFT relevance & interview gotchas

- **Be able to draw the four-copy diagram** and point at which copies each
  technique removes. That single picture answers most of the question.
- **Zero-copy is not free and not always a win** — name the **size threshold** and
  the **pinning + async-completion overhead**. The mature answer says "only above
  ~10 KB."
- **`MSG_ZEROCOPY` completion is asynchronous via `MSG_ERRQUEUE`** — the buffer
  must stay alive and unmodified until reaped. Forgetting this corrupts data
  silently.
- **`sendfile` is file→socket only and can't transform bytes**; `splice` is the
  general "via a pipe" version; `vmsplice` reaches user pages.
- **`io_uring` attacks both axes** (syscalls *and* copies) — mention registered
  buffers and `IORING_OP_SEND_ZC`.
- **For tiny HFT messages, copying is often the right call.** For the network
  floor, the real answer is **kernel bypass (DPDK/RDMA)**, and **within-host the
  zero-copy answer is shared memory** — tie the lessons together.

## Key takeaways

1. The naive read+send path has **four data movements; two are pure CPU copies
   through user space** (page-cache→user, user→socket). Zero-copy deletes those
   two.
2. **`sendfile`** (file→socket) and **`splice`/`vmsplice`** (any↔any via a pipe)
   move data inside the kernel by passing **page references**, not bytes.
3. **`MSG_ZEROCOPY`** sends directly from pinned user pages but completes
   **asynchronously via `MSG_ERRQUEUE`** and only pays off **above ~10 KB**; below
   that, copying wins.
4. **`io_uring`** with registered buffers and `IORING_OP_SEND_ZC` cuts **both
   syscalls and copies** — the convergence of batching and zero-copy.
5. The ultimate network zero-copy is **kernel bypass (DPDK/RDMA)**; within a host
   it's **shared memory**. Both reduce to "share/reference pages instead of
   copying them."

## Self-check

1. In the naive `read`+`write` file-to-socket loop, exactly which of the four data
   movements are removable, and which are physics?
2. How does `splice` avoid a copy, and why does it require a pipe at one end?
3. Why must you not free or modify a `MSG_ZEROCOPY` buffer right after `send`
   returns, and how do you learn it's safe?
4. Above roughly what payload size does `MSG_ZEROCOPY` start to win, and what fixed
   costs explain that threshold?
5. Both `sendfile` and `io_uring`+`SEND_ZC` can do zero-copy transmit. What can
   `io_uring` do that `sendfile` cannot?
6. For a 96-byte order message sent thousands of times per second, would you use
   `MSG_ZEROCOPY`? Justify your answer with the cost model.

## Further reading

- [`sendfile(2)`](https://man7.org/linux/man-pages/man2/sendfile.2.html), [`splice(2)`](https://man7.org/linux/man-pages/man2/splice.2.html), [`vmsplice(2)`](https://man7.org/linux/man-pages/man2/vmsplice.2.html), [`tee(2)`](https://man7.org/linux/man-pages/man2/tee.2.html) — the kernel zero-copy plumbing.
- [MSG_ZEROCOPY — Linux kernel docs](https://www.kernel.org/doc/html/latest/networking/msg_zerocopy.html) — the SO_ZEROCOPY/MSG_ERRQUEUE protocol and the ~10 KB threshold.
- ["Zero-copy networking" — LWN](https://lwn.net/Articles/726917/) and ["Zero-copy network transmission with io_uring" — LWN](https://lwn.net/Articles/879724/) / ["io_uring zerocopy send" — LWN](https://lwn.net/Articles/900293/).
- [Efficient IO with io_uring (kernel.dk PDF)](https://kernel.dk/io_uring.pdf) — Jens Axboe on registered buffers and fixed files.
- [`io_uring_setup(2)`](https://man7.org/linux/man-pages/man2/io_uring_setup.2.html) and [`io_uring_register(2)`](https://man7.org/linux/man-pages/man2/io_uring_register.2.html) — the submission/completion ring and buffer registration.
- ["The history of zero-copy in the kernel"](https://lwn.net/Articles/726818/) — LWN context on the evolution of these interfaces.

## Videos

- **io_uring fundamentals and zero-copy** ([search](https://www.youtube.com/results?search_query=io_uring+zero+copy+registered+buffers+explained)).
- CppCon — low-latency networking and zero-copy / kernel-bypass talks ([search](https://www.youtube.com/results?search_query=CppCon+low+latency+networking+kernel+bypass+zero+copy)).
