# UDP Protocol

> **Why a quant dev must own this:** Essentially every equity, futures, and
> options market-data feed on the planet is delivered as **UDP multicast**.
> When you write a feed handler, you are writing a UDP receiver — joining a
> group, draining a socket fast enough to avoid kernel drops, and reconstructing
> a clean, ordered book from a transport that guarantees *nothing*. UDP is also
> a favorite interview topic precisely because its minimalism forces you to
> articulate where reliability comes from: the application.

## First principles: UDP is "IP plus ports"

The [Internet layer](internet-layer.md) already delivers a packet to a host,
best-effort. **UDP (RFC 768)** adds the bare minimum needed to make that usable
by applications: **ports** (so the data reaches the right program) and an
**optional checksum** (so you can detect corruption). That's it. UDP is so thin
it's often described as "IP with ports." Postel's original spec is about three
pages long.

What UDP deliberately does *not* provide:

- **No reliability** — datagrams can be lost and are never retransmitted.
- **No ordering** — datagrams can arrive in a different order than sent.
- **No de-duplication** — a datagram can arrive twice.
- **No connection** — no handshake, no per-connection state.
- **No flow control or congestion control** — UDP will happily blast a slow
  receiver or a congested link into the ground.

In return you get **minimal overhead, no setup latency, preserved message
boundaries, and multicast**. UDP says: *here is your raw datagram service; if
you want guarantees, build them yourself.* For market data, that's exactly the
right trade — you want fresh data fast and you build your own (cheaper, more
appropriate) recovery on top.

## The 8-byte UDP header

The entire UDP header is **8 bytes**, four 16-bit fields, all **big-endian**:

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          Source Port          |       Destination Port        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|             Length            |           Checksum            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          Payload  ...                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **Source Port (16):** the sender's port (may be 0 if no reply is expected).
- **Destination Port (16):** used to demultiplex to the receiving socket.
- **Length (16):** length of the **UDP header + payload** in bytes (minimum 8).
- **Checksum (16):** ones'-complement checksum over a **pseudo-header** (src/dst
  IP, protocol, UDP length — borrowed from IP) **plus** the UDP header and
  payload. Over IPv4 it's *optional* (0 = not computed); over **IPv6 it's
  mandatory**. The pseudo-header lets the receiver catch a misdelivered or
  address-corrupted datagram.

Compare this 8-byte header to TCP's 20+ — that compactness, plus the absence of
ACKs and connection setup, is UDP's whole performance story.

## Datagram semantics: boundaries are preserved

This is the property that most distinguishes UDP from TCP. UDP is
**message-oriented**: one `sendto()` produces exactly one datagram, and one
`recvfrom()` returns exactly one datagram. If you send a 200-byte message, the
receiver reads a 200-byte message — never half of it, never glued to the next
one. (If your `recv` buffer is smaller than the datagram, the excess is
**discarded** and the rest of the datagram is lost — a classic bug; always size
the buffer for the max datagram.)

Contrast TCP's **byte stream**, where boundaries vanish and you must frame
messages yourself. For market data this is a gift: each exchange message is a
self-contained datagram (often several messages packed into one datagram by the
venue), and you don't need to reframe a stream.

## The consequences you must handle

Because UDP guarantees nothing about delivery, **the application owns
reliability**. In HFT terms, this is the famous pattern:

- **Sequence numbers:** every exchange feed message carries a monotonically
  increasing sequence number. The handler tracks the expected next number; a
  jump means **packet loss (a "gap")**; a repeat means a **duplicate** (drop
  it); out-of-order means **reordering** (reorder or request retransmit).
- **Gap fill / retransmission request:** on detecting a gap, the handler either
  requests a retransmit from a recovery service (often a separate TCP or UDP
  channel) or replays from a snapshot/incremental refresh.
- **A/B (line) arbitration:** exchanges send **two identical copies** of the
  feed (the A and B feeds) over independent network paths. The handler listens
  to both and takes whichever message arrives first for each sequence number —
  so a loss on one path is covered by the other. This is the primary,
  low-latency loss-recovery mechanism; gap-fill is the fallback.

> **Interview gold:** "Market data is UDP — how do you not lose data?" Answer:
> sequence numbers to detect gaps/dupes/reordering, A/B feed arbitration as the
> first line of recovery, and retransmit/snapshot for the rest. The network
> doesn't help — by design.

## Multicast and broadcast

UDP is the *only* mainstream transport that supports **multicast** (and
broadcast) — TCP is strictly unicast. That's not incidental; it's why exchanges
use UDP. A single multicast datagram is replicated by the switch/router to all
subscribers (see the [Internet Layer](internet-layer.md) multicast section), so
one send reaches thousands of receivers with no extra work by the source. The
receiver *joins* a group with `IP_ADD_MEMBERSHIP`.

## A complete, compilable UDP multicast receiver

This is the skeleton of a feed-handler input loop: create a UDP socket, allow
address reuse (so multiple processes can bind the same group/port), bind, join
the multicast group, and drain datagrams with `recvfrom`.

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstdio>
#include <cstring>
#include <cstdint>

int main() {
    const char* GROUP = "239.1.1.1";   // exchange multicast group
    const char* IFACE = "10.0.0.7";    // the NIC's unicast IP to receive on
    const uint16_t PORT = 30001;

    // 1. UDP socket (SOCK_DGRAM -> UDP).
    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { perror("socket"); return 1; }

    // 2. SO_REUSEADDR: lets several sockets/processes bind the same group:port
    //    (needed when multiple consumers want the same multicast feed).
    int yes = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);

    // 3. Bind. Binding to the multicast group (or INADDR_ANY) on the port lets
    //    us receive datagrams sent to that group:port.
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port   = htons(PORT);            // ports are big-endian on the wire
    local.sin_addr.s_addr = htonl(INADDR_ANY); // or inet_pton(GROUP) to filter
    if (::bind(fd, reinterpret_cast<sockaddr*>(&local), sizeof local) < 0) {
        perror("bind"); return 1;
    }

    // 4. Join the multicast group on a specific interface (IGMP join).
    ip_mreq mreq{};
    ::inet_pton(AF_INET, GROUP, &mreq.imr_multiaddr);
    ::inet_pton(AF_INET, IFACE, &mreq.imr_interface);
    if (::setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP,
                     &mreq, sizeof mreq) < 0) {
        perror("IP_ADD_MEMBERSHIP"); return 1;
    }

    // 5. (Optional but important) grow the receive buffer to survive bursts.
    int rcvbuf = 8 * 1024 * 1024;              // 8 MiB
    ::setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof rcvbuf);

    // 6. Receive loop. recvfrom returns ONE datagram per call and fills in
    //    the sender's address.
    uint8_t buf[2048];                         // size >= max datagram!
    sockaddr_in from{};
    socklen_t   fromlen = sizeof from;

    for (;;) {
        ssize_t n = ::recvfrom(fd, buf, sizeof buf, 0,
                               reinterpret_cast<sockaddr*>(&from), &fromlen);
        if (n < 0) { perror("recvfrom"); break; }

        // 'buf[0..n)' is exactly one exchange datagram; parse its sequence
        // number and messages here (by-value, big-endian — see endianness).
        char src[INET_ADDRSTRLEN];
        ::inet_ntop(AF_INET, &from.sin_addr, src, sizeof src);
        std::printf("rx %zd bytes from %s:%u\n", n, src, ntohs(from.sin_port));
    }

    ::close(fd);
}
```

A few production-relevant notes baked into the code:

- **`SO_REUSEADDR`** before `bind` lets multiple consumers (or a hot/standby
  pair) bind the same multicast group:port.
- **`imr_interface`** pins the join to a specific NIC — essential on colo boxes
  that receive the A feed on one NIC and B on another.
- **`SO_RCVBUF`** sizing is your defense against bursts (below).
- **Sender side** uses `sendto()` to a group address, optionally with
  `IP_MULTICAST_TTL` to scope it and `IP_MULTICAST_IF` to choose the egress NIC.

## SO_RCVBUF, drops, and microbursts

This is *the* operational gotcha for UDP feeds. The kernel buffers received
datagrams in a per-socket queue sized by **`SO_RCVBUF`**. If your application
doesn't `recv` fast enough during a **microburst** (a sub-millisecond storm of
packets at the open, on news, or at expiry), the queue fills and the kernel
**silently drops** further datagrams — there is no UDP flow control to slow the
sender, and no retransmission to recover. Those drops appear in your handler as
**sequence gaps**.

Defenses:

- **Increase `SO_RCVBUF`** (subject to the kernel's `net.core.rmem_max` limit)
  so the queue absorbs bursts while the app catches up.
- **Drain fast:** dedicate a busy-polling thread to `recv`; use **`recvmmsg`**
  to pull *many* datagrams per syscall, amortizing syscall overhead; or go
  **kernel bypass** (Onload/ef_vi, DPDK, AF_XDP) to eliminate the kernel queue
  and copy entirely.
- **Monitor drops:** watch `netstat -su` (`packet receive errors`,
  `RcvbufErrors`) and per-socket drop counters; rising drops = you're losing
  market data.

## Max datagram size & fragmentation

The UDP **Length** field is 16 bits, so a datagram can theoretically be up to
65,535 bytes (minus headers), assembled from multiple IP fragments. But — as the
[Internet Layer](internet-layer.md) lesson stresses — **fragmentation is
dangerous on a no-retransmit UDP feed**: lose any one IP fragment and the whole
datagram is lost at reassembly. So the practical rule is **keep each datagram
within the path MTU**: on a 1500-byte Ethernet MTU, that's a UDP payload of
**≤ 1472 bytes** (1500 − 20 IP − 8 UDP). Exchanges size their multicast packets
accordingly, often packing several small messages into one sub-MTU datagram.

## Performance & hardware reality

- **Overhead:** 8-byte header, no ACKs, no connection state. The dominant cost
  on a vanilla stack is the **syscall + kernel-to-user copy** per `recvfrom` —
  roughly on the order of **a couple of microseconds** round-trip through the
  kernel network stack on commodity hardware, which is why HFT shops batch
  (`recvmmsg`) or bypass the kernel to get into the hundreds-of-nanoseconds
  regime.
- **No congestion control** means UDP can saturate a link and induce loss for
  itself and others — fine inside a controlled exchange/colo network, dangerous
  on the open internet.
- **Checksum** is typically NIC-offloaded, so not a CPU cost on modern adapters.
- **Multicast fan-out** is done by the switch, not the source — the efficiency
  that makes one feed scale to thousands of subscribers.

## Quant/HFT relevance & interview gotchas

- **UDP multicast is the market-data transport.** Know the receiver recipe
  (`socket`, `SO_REUSEADDR`, `bind`, `IP_ADD_MEMBERSHIP`, `recvfrom`) cold.
- **The app owns reliability:** sequence numbers (detect gaps/dupes/reorder),
  **A/B feed arbitration** (primary recovery), and retransmit/snapshot
  (fallback). "The network won't recover loss — by design."
- **`SO_RCVBUF` + microbursts:** undersized buffers + a slow drain = silent
  kernel drops = sequence gaps. This is the most common real-world UDP failure
  and a favorite interview probe.
- **Datagram boundaries are preserved** (one `sendto` ↔ one `recvfrom`); an
  undersized receive buffer **truncates and loses** the rest of the datagram.
- **Avoid fragmentation:** keep datagrams ≤ ~1472 bytes on a 1500 MTU; one lost
  fragment loses the whole message.
- **Header fields are big-endian** — parse by value (see endianness).
- **Why not TCP for feeds?** No multicast, and head-of-line blocking would stall
  fresh prices behind a stale retransmit (see [Transport Layer](transport-layer.md)).

## Key takeaways

1. **UDP (RFC 768) = IP + ports + optional checksum**, with an **8-byte
   header**. No reliability, ordering, dedup, connection, flow, or congestion
   control.
2. UDP is **message-oriented**: one `sendto` ↔ one `recvfrom`, boundaries
   preserved; undersized buffers silently truncate.
3. Because UDP guarantees nothing, the **application provides reliability** via
   **sequence numbers**, **A/B feed arbitration**, and **gap-fill/snapshots**.
4. UDP uniquely supports **multicast**, the basis of efficient one-to-many feed
   distribution; receivers join with **`IP_ADD_MEMBERSHIP`**.
5. **`SO_RCVBUF` sizing + fast draining** (`recvmmsg`/kernel bypass) prevents
   silent kernel drops during **microbursts**.
6. **Avoid IP fragmentation** — keep datagrams under the path MTU
   (~1472 bytes on 1500), since a single lost fragment loses the whole datagram.

## Self-check

1. List the four fields of the UDP header and their sizes. Which is optional
   over IPv4 but mandatory over IPv6, and what does it cover?
2. You `recvfrom` into a 512-byte buffer but a 900-byte datagram arrives. What
   happens to the extra bytes?
3. A UDP feed shows sequence gaps every market open. Name the most likely cause
   and three mitigations.
4. Explain A/B feed arbitration and why it's the primary (not fallback) loss
   recovery mechanism for HFT market data.
5. Why must UDP market-data datagrams stay under the path MTU?
6. In the receiver code, what do `SO_REUSEADDR` and `imr_interface` each
   accomplish, and why do they matter in colo?

## Further reading

- [RFC 768 — User Datagram Protocol](https://www.rfc-editor.org/rfc/rfc768) — the complete ~3-page spec.
- [`udp(7)` — man7.org](https://man7.org/linux/man-pages/man7/udp.7.html) — Linux UDP socket behavior, buffers, errors.
- [`ip(7)` — man7.org](https://man7.org/linux/man-pages/man7/ip.7.html) — `IP_ADD_MEMBERSHIP`, `IP_MULTICAST_TTL`, `IP_MULTICAST_IF`.
- [`recvmmsg(2)` — man7.org](https://man7.org/linux/man-pages/man2/recvmmsg.2.html) — batched datagram receive for high-rate feeds.
- W. Richard Stevens, *UNIX Network Programming, Vol. 1* — the multicast and UDP chapters (mentioned).
- [Beej's Guide to Network Programming](https://beej.us/guide/bgnet/) — `sendto`/`recvfrom`, datagram sockets, hands-on.
- [User Datagram Protocol — Wikipedia](https://en.wikipedia.org/wiki/User_Datagram_Protocol) — header and pseudo-header reference.

## Videos

- *Computerphile* — search **"UDP / TCP vs UDP"** ([search](https://www.youtube.com/results?search_query=computerphile+udp)).
- Search **"UDP multicast market data feed handler"** for HFT-oriented talks ([search](https://www.youtube.com/results?search_query=udp+multicast+market+data+feed+handler)).
- Search **"kernel bypass Onload DPDK low latency"** for fast-receive techniques ([search](https://www.youtube.com/results?search_query=kernel+bypass+onload+dpdk+low+latency)).
