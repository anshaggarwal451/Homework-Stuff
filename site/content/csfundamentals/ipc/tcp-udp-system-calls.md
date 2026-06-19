# TCP/UDP System Calls

> **Why a quant dev must own this:** Market data and order flow arrive over the
> network, and the boundary between your process and the wire is the Berkeley
> sockets API. Every `recv` is a syscall, a copy, and possibly a context switch
> — three things an HFT path is built to avoid. Knowing the full socket
> lifecycle, the readiness model, and the knobs (`recvmmsg`, busy-poll, hardware
> timestamping) is the difference between a feed handler that adds microseconds
> and one that adds tens of nanoseconds. This is bread-and-butter HFT interview
> territory.

## First principles: a socket is a file descriptor onto a protocol stack

On Linux everything is a file descriptor, and a socket is no exception. When you
call `socket(2)` you get an `int` that names a kernel object holding two queues —
a **receive buffer** and a **send buffer** of `struct sk_buff` (skb) chains — plus
the protocol state machine (TCP's connection state, sequence numbers, congestion
window; UDP's near-nothing). Your reads and writes copy bytes between your
user-space buffer and those kernel buffers; the kernel's networking stack and the
NIC driver move data between the kernel buffers and the hardware.

The two transports differ in exactly the way you'd expect:

- **TCP** is a reliable, ordered, connection-oriented **byte stream**. There are
  no message boundaries — `recv` may return any prefix of what was sent. You
  `connect`/`accept` first, then `send`/`recv`.
- **UDP** is an unreliable, unordered **datagram** service. Each `sendto` is one
  packet; each `recvfrom` returns exactly one datagram (truncated if your buffer
  is too small). No connection setup, no retransmission, no ordering — which is
  precisely why most low-latency multicast market-data feeds run over UDP.

## The connection-oriented (TCP) lifecycle

```text
   SERVER                                  CLIENT
   socket()                                socket()
   setsockopt(SO_REUSEADDR)
   bind(addr)
   listen(backlog)
        |                                  connect(addr) ---- SYN ---->
   accept() <---------------------------------------------- (3-way handshake)
        |  returns a NEW connected fd
   recv()/send()  <==== byte stream ====>  send()/recv()
   shutdown(SHUT_WR)  -- sends FIN -->
   close()                                 close()
```

Key points an interviewer probes:

- `listen()` does **not** block; it marks the socket passive and sizes the
  *accept queue* (completed-handshake connections waiting for `accept`). The
  `backlog` argument bounds that queue.
- `accept()` returns a **brand-new fd** for the connection; the listening fd
  keeps listening. New connection, new fd — a classic gotcha.
- `shutdown(fd, SHUT_WR)` performs a **half-close**: it sends a FIN so the peer
  sees EOF, but you can still `recv`. `close()` drops your reference to the fd
  (the connection only truly tears down when the last reference goes and any
  lingering data is flushed). They are not interchangeable.

## A connectionless (UDP) receiver

```text
   socket(AF_INET, SOCK_DGRAM)
   bind(addr)            // so the kernel knows which port delivers to you
   recvfrom() <- datagram, fills in sender address
   sendto()   -> datagram to an explicit address
```

There is no `listen`/`accept`/`connect` requirement. You *may* `connect()` a UDP
socket — it doesn't handshake, it just fixes the default peer so you can use
`send`/`recv` and the kernel filters inbound datagrams to that peer. A connected
UDP socket is also a touch faster: the route is cached.

## The core data-movement calls and their copy path

| Call | Direction | Notes |
|---|---|---|
| `read`/`write` | both | Work on any fd, including sockets. |
| `recv`/`send` | both | Like read/write but take a `flags` arg (`MSG_DONTWAIT`, `MSG_PEEK`, `MSG_WAITALL`). |
| `recvfrom`/`sendto` | both | Add a peer address — the UDP idiom. |
| `recvmsg`/`sendmsg` | both | Scatter/gather (`iovec`) **plus ancillary data** (`cmsg`): timestamps, the MSG_ZEROCOPY error queue, packet info. The most powerful form. |
| `recvmmsg`/`sendmmsg` | both | Receive/send **multiple** datagrams in **one** syscall — the batching primitive. |

The naive copy path for a single received TCP segment looks like this:

```text
NIC --DMA--> kernel skb (RX ring / socket rcv buffer)
                        |   recv() syscall: one copy
                        v
                  user buffer
```

So even in the best case `recv()` is **one syscall + one copy** kernel→user. On
the send side it's one copy user→kernel skb, then DMA to the NIC. Those copies
and the syscall boundary (mode switch, ~hundreds of ns each way, more under
Spectre/Meltdown mitigations) are the costs HFT shops fight to remove — see
[Zero-Copy Techniques](zero-copy-techniques.md) and the kernel-bypass
discussion in [IPC Trade-offs and Performance](ipc-trade-offs-and-performance.md).

## Blocking vs non-blocking, and the readiness model

By default sockets are **blocking**: `recv` on an empty socket sleeps until data
arrives. Set `O_NONBLOCK` (via `fcntl`, or `SOCK_NONBLOCK` at `socket()` time,
or per-call `MSG_DONTWAIT`) and `recv` returns immediately with `-1` /
`EAGAIN`/`EWOULDBLOCK` when there's nothing to read.

Non-blocking sockets only make sense alongside a **readiness notifier** that
tells you *which* fds are ready, so you don't spin pointlessly:

- **`select`/`poll`** — portable, O(n) in the number of fds, re-scan every call.
  Fine for dozens of fds, painful for thousands.
- **`epoll`** — Linux's scalable mechanism: you register fds once with
  `epoll_ctl`, then `epoll_wait` returns only the ready ones. O(ready), not
  O(total).

### epoll level- vs edge-triggered (a favorite interview question)

- **Level-triggered (LT, default):** `epoll_wait` keeps reporting an fd as long
  as it *is* readable. Easy to use correctly — read some, come back later.
- **Edge-triggered (ET, `EPOLLET`):** you're notified only on the *transition*
  from not-ready to ready. You **must drain the fd until `EAGAIN`**, or you'll
  miss data and stall. ET means fewer wakeups, which is why high-throughput
  servers prefer it — at the cost of stricter discipline.

## A compilable non-blocking epoll TCP echo server

```cpp
// g++ -std=c++20 -O2 epoll_server.cpp -o server
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>   // TCP_NODELAY
#include <sys/epoll.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <cstdio>
#include <cerrno>

int main() {
    int lfd = ::socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (lfd < 0) { perror("socket"); return 1; }

    int one = 1;
    // SO_REUSEADDR: rebind immediately after restart (skip TIME_WAIT lockout).
    setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(9000);
    if (bind(lfd, (sockaddr*)&addr, sizeof addr) < 0) { perror("bind"); return 1; }
    if (listen(lfd, 128) < 0) { perror("listen"); return 1; }

    int ep = epoll_create1(0);
    epoll_event ev{};
    ev.events  = EPOLLIN;                 // level-triggered listen socket
    ev.data.fd = lfd;
    epoll_ctl(ep, EPOLL_CTL_ADD, lfd, &ev);

    epoll_event events[64];
    for (;;) {
        int n = epoll_wait(ep, events, 64, -1);   // -1 = block forever
        if (n < 0) { if (errno == EINTR) continue; perror("epoll_wait"); break; }

        for (int i = 0; i < n; ++i) {
            int fd = events[i].data.fd;

            if (fd == lfd) {
                // Drain the accept queue (one LT wakeup can cover many conns).
                for (;;) {
                    int cfd = accept4(lfd, nullptr, nullptr, SOCK_NONBLOCK);
                    if (cfd < 0) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                        if (errno == EINTR) continue;
                        perror("accept4"); break;
                    }
                    int yes = 1;
                    // TCP_NODELAY: disable Nagle so small writes go out now.
                    setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof yes);
                    epoll_event cev{};
                    cev.events  = EPOLLIN | EPOLLET;   // edge-triggered clients
                    cev.data.fd = cfd;
                    epoll_ctl(ep, EPOLL_CTL_ADD, cfd, &cev);
                }
            } else {
                // Edge-triggered: read until EAGAIN or we'll lose the edge.
                char buf[4096];
                for (;;) {
                    ssize_t r = recv(fd, buf, sizeof buf, 0);
                    if (r > 0) { (void)send(fd, buf, r, MSG_NOSIGNAL); continue; }
                    if (r == 0) { close(fd); break; }          // peer closed
                    if (errno == EAGAIN || errno == EWOULDBLOCK) break;  // drained
                    if (errno == EINTR) continue;
                    close(fd); break;                          // real error
                }
            }
        }
    }
    close(lfd);
}
```

Note the errno discipline: **`EAGAIN`/`EWOULDBLOCK`** means "nothing right now,
not an error"; **`EINTR`** means a signal interrupted the call and you should
retry. Forgetting either is the most common networking bug there is.

## Batching with `recvmmsg` — the UDP feed-handler idiom

For a UDP market-data multicast feed you can amortize the syscall cost by pulling
many datagrams per call:

```cpp
// Receive up to VLEN datagrams in ONE syscall.
#include <sys/socket.h>
#include <cstring>
constexpr int VLEN  = 32;
constexpr int BUFSZ = 2048;

char     bufs[VLEN][BUFSZ];
iovec    iov[VLEN];
mmsghdr  msgs[VLEN];
std::memset(msgs, 0, sizeof msgs);
for (int i = 0; i < VLEN; ++i) {
    iov[i].iov_base = bufs[i];
    iov[i].iov_len  = BUFSZ;
    msgs[i].msg_hdr.msg_iov    = &iov[i];
    msgs[i].msg_hdr.msg_iovlen = 1;
}

// MSG_WAITFORONE: return as soon as >=1 datagram is available.
int got = recvmmsg(sock, msgs, VLEN, MSG_WAITFORONE, /*timeout=*/nullptr);
for (int i = 0; i < got; ++i)
    process(bufs[i], msgs[i].msg_len);   // msg_len = bytes in datagram i
```

One syscall instead of `got` of them. The copies still happen (one per datagram,
kernel→user), but the per-call mode-switch overhead is paid once. `sendmmsg`
does the symmetric thing on transmit.

## The setsockopt knobs that matter in HFT

| Option | Level | Effect |
|---|---|---|
| `SO_REUSEADDR` | `SOL_SOCKET` | Rebind a port still in `TIME_WAIT`; restart fast. |
| `SO_RCVBUF` / `SO_SNDBUF` | `SOL_SOCKET` | Size the kernel socket buffers. Bigger absorbs bursts; the kernel doubles your value for bookkeeping. |
| `TCP_NODELAY` | `IPPROTO_TCP` | Disable **Nagle's algorithm** so small writes are sent immediately rather than coalesced. Almost always on for latency-sensitive TCP. |
| `TCP_QUICKACK` | `IPPROTO_TCP` | Suppress delayed-ACK behavior for this segment. |
| `SO_BUSY_POLL` | `SOL_SOCKET` | Kernel **busy-polls** the NIC for new packets instead of sleeping → lower latency, burns a core. |
| `SO_TIMESTAMPING` | `SOL_SOCKET` | Ask for **hardware (NIC) timestamps** delivered as ancillary data via `recvmsg`/`MSG_ERRQUEUE`. Essential for honest tick-to-trade measurement. |
| `SO_REUSEPORT` | `SOL_SOCKET` | Multiple sockets bind the same port; kernel load-balances across them — one receive thread per core. |

## Performance and hardware reality

- A syscall is a **mode switch**, on the order of **~100 ns–1 µs** including
  modern speculative-execution mitigations. A `recv` that finds data and copies
  it is roughly that plus the copy; a `recv` that has to **sleep and be woken**
  costs a full **context switch (~1–5 µs)** plus scheduler latency and a
  cold-cache restart. This is why busy-poll exists: trade a core for never
  sleeping.
- Each `recv`/`send` is **one copy** between user and kernel buffers. At 10/40/100
  GbE line rate that copy bandwidth and the cache pollution it causes are real,
  which motivates [zero-copy](zero-copy-techniques.md) and kernel-bypass.
- **Batching** (`recvmmsg`/`sendmmsg`, or `io_uring`) is the cheap win: it cuts
  syscalls, not copies. Going further means leaving the kernel entirely
  (DPDK/Solarflare ef_vi/RDMA), a forward reference covered under
  [IPC Trade-offs](ipc-trade-offs-and-performance.md).
- These figures are **order-of-magnitude** rules of thumb; the only numbers you
  should trust are the ones you measure on your own box with your own NIC.

## Quant/HFT relevance & interview gotchas

- **UDP multicast for market data, TCP for order entry.** Know why: multicast
  fans out to many subscribers with no per-subscriber state; order entry needs
  reliability and ordering.
- **`accept` returns a new fd** — interviewers love watching candidates forget
  this and try to `recv` on the listening socket.
- **`EAGAIN` is not an error; `EINTR` means retry.** Say this out loud.
- **`shutdown` vs `close`** and the half-close — know that `SHUT_WR` sends a FIN.
- **`SIGPIPE`:** writing to a peer that closed raises `SIGPIPE` (process killed by
  default). Use `MSG_NOSIGNAL` on `send`, or ignore the signal. Same hazard as
  with [pipes](pipes-and-message-queues.md).
- **TCP has no message boundaries.** Framing is your job; a single `recv` can
  return half a message or two-and-a-half messages.
- **Edge-triggered epoll must drain to `EAGAIN`.** Forgetting is a silent stall.
- The senior move is to **minimize syscalls per packet** (batch with `recvmmsg`),
  **avoid sleeping** (busy-poll / `SO_BUSY_POLL`), and **timestamp in hardware**
  (`SO_TIMESTAMPING`) so your latency numbers aren't lies.

## Key takeaways

1. A socket is an fd onto kernel send/receive buffers; every `recv`/`send` is a
   **syscall plus a copy**, and a blocking call that sleeps adds a **context
   switch**.
2. TCP = reliable ordered byte stream (`socket→bind→listen→accept`, or
   `connect`); UDP = unreliable datagrams (`sendto`/`recvfrom`, optional
   `connect`). `accept` yields a *new* fd.
3. Non-blocking sockets (`O_NONBLOCK`) pair with a readiness notifier; **`epoll`**
   scales where `select`/`poll` don't. **Edge-triggered must drain to `EAGAIN`.**
4. Handle errno correctly: `EAGAIN`/`EWOULDBLOCK` = try later, `EINTR` = retry,
   and guard against `SIGPIPE` with `MSG_NOSIGNAL`.
5. For latency: `TCP_NODELAY`, `recvmmsg`/`sendmmsg` batching, `SO_BUSY_POLL`,
   `SO_TIMESTAMPING`, and ultimately kernel bypass.

## Self-check

1. Why must you call `accept` to get a usable connection fd, and what does the
   listening socket do afterward?
2. A single `recv` on a TCP socket returns 1400 bytes, but you sent two 1000-byte
   application messages. What went wrong with your assumptions, and how do you
   fix it?
3. With edge-triggered epoll, what bug appears if you `recv` exactly once per
   notification, and why?
4. When does `recvmmsg` actually help, and what cost does it *not* remove?
5. What does `TCP_NODELAY` disable, and when would leaving Nagle *on* be the
   right call?
6. How would you obtain a NIC hardware receive timestamp for each packet, and why
   is that better than `clock_gettime` in user space?

## Further reading

- [`socket(2)`](https://man7.org/linux/man-pages/man2/socket.2.html), [`bind(2)`](https://man7.org/linux/man-pages/man2/bind.2.html), [`listen(2)`](https://man7.org/linux/man-pages/man2/listen.2.html), [`accept(2)`](https://man7.org/linux/man-pages/man2/accept.2.html), [`connect(2)`](https://man7.org/linux/man-pages/man2/connect.2.html) — the lifecycle, on man7.org.
- [`recv(2)`](https://man7.org/linux/man-pages/man2/recv.2.html), [`send(2)`](https://man7.org/linux/man-pages/man2/send.2.html), [`recvmsg(2)`/`sendmsg(2)`](https://man7.org/linux/man-pages/man2/recvmsg.2.html), [`recvmmsg(2)`](https://man7.org/linux/man-pages/man2/recvmmsg.2.html), [`sendmmsg(2)`](https://man7.org/linux/man-pages/man2/sendmmsg.2.html).
- [`epoll(7)`](https://man7.org/linux/man-pages/man7/epoll.7.html) — level vs edge triggering explained — and [`socket(7)`](https://man7.org/linux/man-pages/man7/socket.7.html) / [`tcp(7)`](https://man7.org/linux/man-pages/man7/tcp.7.html) for every `setsockopt`.
- [Linux timestamping documentation](https://www.kernel.org/doc/html/latest/networking/timestamping.html) — software and hardware (`SO_TIMESTAMPING`) timestamps.
- W. Richard Stevens, *UNIX Network Programming, Vol. 1* (UNP) — still the definitive sockets reference.
- [The C10K problem](http://www.kegel.com/c10k.html) — Dan Kegel's classic on readiness models and why `epoll` matters.

## Videos

- CppCon — Carl Cook, **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)).
- Talks on **epoll edge- vs level-triggered and the readiness model** ([search](https://www.youtube.com/results?search_query=epoll+edge+triggered+vs+level+triggered+explained)).
