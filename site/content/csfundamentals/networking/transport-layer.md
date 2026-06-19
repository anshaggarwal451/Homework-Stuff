# Transport Layer

> **Why a quant dev must own this:** The transport layer is where you *choose
> your trade-offs*. Market data rides **UDP** (low latency, multicast fan-out,
> no head-of-line blocking) while order entry rides **TCP** (reliable, ordered,
> a real session). Knowing exactly what each gives you — and what it costs in
> latency and overhead — is the difference between an architecture that's fast
> *and* correct and one that quietly drops fills or blocks on a stale packet.
> Ports, the 4-tuple, and demultiplexing are also bread-and-butter interview
> material.

## First principles: what the transport layer adds

The [Internet layer](internet-layer.md) delivers a packet to a *host* — one IP
address, best-effort. But a host runs dozens of programs. The transport layer's
first and most fundamental job is **multiplexing/demultiplexing**: getting data
to the right *program*, and (for some transports) turning the network's
unreliable, host-to-host datagram service into something an application can use
directly — reliable, ordered byte streams.

It sits directly below your application (the **socket** is the boundary) and
directly above IP. It is the **first end-to-end layer**: transport headers are
read only by the two endpoints, never by routers in between (the end-to-end
principle in action).

## Ports and the 4-tuple

A **port** is a 16-bit number (0–65535) that identifies an endpoint *within* a
host. The combination of IP address + port identifies a specific communication
endpoint; the OS uses ports to demultiplex incoming segments to the right
socket.

For a **connection-oriented** transport (TCP), the kernel identifies a
connection by the full **4-tuple**:

```text
( source IP, source port, destination IP, destination port )
```

Two browser tabs to the same web server share `dst IP:443` but have **different
source ports**, so their 4-tuples differ and the kernel keeps them straight.
For a connectionless transport (UDP) there's no per-connection state by default;
the socket is identified more simply (often by local IP:port), and the *sender's*
address comes back to you on each `recvfrom`.

Port ranges you should know:

- **Well-known ports (0–1023):** assigned to standard services (80 HTTP, 443
  HTTPS, 22 SSH, 53 DNS). Binding these typically needs privilege.
- **Registered (1024–49151)** and **dynamic/ephemeral (49152–65535):** the
  kernel hands out ephemeral source ports automatically when you `connect()`
  without binding. Exchange protocols use whatever ports the venue specifies.

## Demultiplexing: how a segment finds its socket

When a packet arrives, the internet layer reads the IP header's **Protocol**
field (6 = TCP, 17 = UDP) to pick the transport, then the transport layer reads
the **destination port** (and, for TCP, the whole 4-tuple) to find the matching
socket and deliver the payload. This is the entire "which program gets this
data?" mechanism — and it's why two services can share a machine: they
demultiplex by port.

## The two transports: TCP vs UDP

TCP/IP gives you exactly two mainstream transports, sitting at opposite ends of
the reliability/latency trade-off:

- **TCP** (Transmission Control Protocol, **RFC 9293**, which obsoletes the
  classic RFC 793): a **connection-oriented, reliable, ordered byte stream**
  with flow control and congestion control. You get back exactly the bytes you
  sent, in order, with no gaps — at the cost of handshakes, acknowledgments,
  retransmission delays, and head-of-line blocking.
- **UDP** (User Datagram Protocol, **RFC 768**): a **connectionless,
  unreliable, message-oriented datagram** service. It adds almost nothing to IP
  — just ports and an optional checksum. You may lose, reorder, or duplicate
  datagrams; the app deals with it. In exchange you get minimal overhead, no
  per-connection state, datagram boundaries, and multicast.

### Comparison table

| Property | TCP | UDP |
|---|---|---|
| RFC | 9293 (obsoletes 793) | 768 |
| Connection | Connection-oriented (3-way handshake) | Connectionless (no setup) |
| Reliability | Reliable (ACK + retransmit) | Unreliable (no retransmit) |
| Ordering | In-order delivery guaranteed | No ordering guarantee |
| Data model | **Byte stream** (no message boundaries) | **Datagrams** (boundaries preserved) |
| Flow control | Yes (sliding window) | No |
| Congestion control | Yes (slow start, CUBIC/BBR, …) | No (app/network must manage) |
| Header size | 20 bytes (min) + options | 8 bytes (fixed) |
| Multicast / broadcast | No (unicast only) | **Yes** |
| Head-of-line blocking | **Yes** (one lost segment stalls the stream) | No (each datagram independent) |
| Typical HFT use | **Order entry / sessions** | **Market data (multicast)** |

The two distinctions that matter most for HFT are **head-of-line blocking** and
**datagram vs stream**, covered below.

## The socket API mapping

The transport choice is made when you create the socket:

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <cstring>

// TCP: reliable, ordered byte stream — order entry, sessions.
int tcp_fd = ::socket(AF_INET, SOCK_STREAM, 0);   // SOCK_STREAM -> TCP

// UDP: connectionless datagrams — market data.
int udp_fd = ::socket(AF_INET, SOCK_DGRAM, 0);    // SOCK_DGRAM  -> UDP

// Both describe the endpoint with sockaddr_in (IPv4 address + port).
sockaddr_in addr{};
addr.sin_family = AF_INET;
addr.sin_port   = htons(50001);                   // ports are BIG-ENDIAN on wire
::inet_pton(AF_INET, "10.0.0.7", &addr.sin_addr); // dotted-quad -> 32-bit net order
```

Three API shapes follow from the transport semantics:

- **TCP** is connection-oriented, so you `connect()` (client) or
  `bind()`+`listen()`+`accept()` (server), then `send()`/`recv()` on the
  established stream. No address per call — the connection remembers the peer.
- **UDP** is connectionless, so you `sendto()`/`recvfrom()` and supply/receive
  the peer address on *each* call. (You *may* `connect()` a UDP socket to fix a
  default peer, but it's still datagram semantics underneath.)
- The `htons()` on the port is the recurring **endianness** contract: ports and
  addresses are big-endian on the wire (see the
  [Byte Order and Endianness](../cpu-architecture-basics/byte-order-and-endianness.md)
  lesson).

## Checksums

Both transports carry a **16-bit checksum** computed over the payload **plus a
"pseudo-header"** — a synthetic prefix containing the source/destination IP
addresses, the protocol number, and the transport length, borrowed from the IP
header. Including the pseudo-header lets the receiver detect a packet that was
misdelivered to the wrong host or with corrupted addresses. The checksum is the
ones'-complement sum of 16-bit words — weak by modern standards (the link
layer's CRC-32 FCS is far stronger) but a useful end-to-end sanity check. In
TCP the checksum is **mandatory**; in UDP over IPv4 it's technically optional
(a zero field means "not computed"), but over IPv6 it's required, and you should
never disable it on a feed where a corrupt price could be catastrophic.

## What "connection" actually means

This trips people up: there are **no wires reserved**, no circuit switched. A
TCP "connection" is purely **state held in the two endpoints' kernels** — the
4-tuple, sequence numbers, window sizes, timers. The network in between is still
just forwarding independent IP packets and has no idea a "connection" exists.
"Establishing a connection" means the two ends agree on initial sequence numbers
and options via the 3-way handshake; "the connection is open" means both kernels
maintain that shared state. UDP holds essentially none of this — every datagram
is independent — which is exactly why it's cheaper and why *you* must track
sequence numbers in the app.

## Head-of-line blocking: the HFT dealbreaker for feeds

TCP delivers a **byte stream in order**. If segment #5 is lost, segments #6, #7,
#8 may have already arrived and be sitting in the receiver's buffer — but TCP
**will not hand them to your application** until #5 is retransmitted and
arrives, because doing so would break the in-order contract. That stall is
**head-of-line (HOL) blocking**, and the wait is at least one retransmission
timeout / RTT.

For market data this is fatal: while TCP dutifully waits to recover a single
stale packet, **newer, fresher market updates are blocked behind it**. You'd
rather *see the new prices now* and detect/recover the gap separately. UDP has
no HOL blocking — each datagram is independent, so a loss affects only that one
message. This is the core reason exchanges distribute market data over **UDP
multicast** with application-level **sequence numbers** and **A/B feed
arbitration**, not over TCP.

Conversely, for **order entry** you *do* want TCP's guarantees: you cannot
silently lose or reorder an order or a fill. The latency cost of reliability is
acceptable there because correctness is non-negotiable, and the message rate per
session is far lower than a full market-data feed.

## Performance & hardware reality

- **UDP overhead is minimal:** 8-byte header, no connection state, no ACKs, no
  congestion control. Per-datagram cost is dominated by the kernel's send/recv
  path (a copy + a syscall) — which is why HFT feed handlers use batched
  receives (`recvmmsg`) or **kernel bypass** to amortize/eliminate it.
- **TCP adds latency in several places:** a 1-RTT handshake before the first
  byte; slow-start ramping the window; potential Nagle/delayed-ACK interactions;
  and retransmission/HOL stalls under loss. All are addressable (covered in the
  [TCP Protocol](tcp-protocol.md) lesson — pre-warm connections, set
  `TCP_NODELAY`, etc.) but they exist.
- **Both transports' checksum** is usually **offloaded to the NIC** in
  hardware, so it isn't a CPU cost on the fast path on modern adapters.
- **Demultiplexing scales:** millions of UDP datagrams/sec or many TCP
  connections are handled by the kernel's hash tables on the 4-tuple; RSS
  spreads flows across CPU cores via NIC hardware queues.

## Quant/HFT relevance & interview gotchas

- **"Why UDP for market data and TCP for orders?"** The canonical question.
  Answer with: HOL blocking (you can't let a stale packet block fresh prices),
  multicast fan-out, and low overhead for the feed; reliability/ordering
  non-negotiable for orders. Mention sequence numbers + A/B feeds for UDP loss
  recovery.
- **The 4-tuple** uniquely identifies a TCP connection — be able to explain how
  two connections to the same server port stay distinct (different source
  ports).
- **Datagram vs stream:** UDP preserves message boundaries; TCP does not (one
  `send` may arrive as several `recv`s and vice-versa). A TCP feed handler must
  do its own framing (length prefixes / delimiters).
- **Ports are big-endian on the wire** — `htons` or by-value parse.
- **A "connection" is endpoint state, not a network circuit.** The network just
  forwards packets.
- **UDP checksum is optional over IPv4 but you should keep it on** — a corrupt
  price is worse than a dropped one.

## Key takeaways

1. The transport layer **multiplexes/demultiplexes** to the right program via
   **ports**, and is the first **end-to-end** layer (routers ignore its
   headers).
2. A TCP connection is identified by the **4-tuple** (src IP:port, dst IP:port);
   UDP is connectionless and gives you the sender's address per `recvfrom`.
3. **TCP** = connection-oriented, reliable, ordered **byte stream** with flow &
   congestion control (RFC 9293). **UDP** = connectionless, unreliable,
   **datagram**, 8-byte header, supports **multicast** (RFC 768).
4. **`SOCK_STREAM`→TCP** (`connect`/`accept`/`send`/`recv`),
   **`SOCK_DGRAM`→UDP** (`sendto`/`recvfrom`); ports are big-endian on the wire.
5. **Head-of-line blocking** is why market data uses UDP multicast (a lost
   packet must not block fresh prices); **reliability** is why order entry uses
   TCP.
6. A "connection" is **kernel state in the two endpoints**, not a reserved
   circuit; the network just forwards independent IP packets.

## Self-check

1. What does a port identify, and what fields make up the 4-tuple that
   identifies a TCP connection?
2. Two browser tabs connect to `https://x.com` (`dst 1.2.3.4:443`). How does the
   kernel keep their data separate?
3. Give four concrete differences between TCP and UDP, and name the HFT use case
   for each.
4. Explain head-of-line blocking and why it disqualifies TCP for a
   latency-sensitive market-data feed.
5. UDP preserves message boundaries; TCP does not. What must a TCP-based feed
   handler do as a result?
6. What does "establishing a connection" actually create, given that the network
   reserves no resources?

## Further reading

- [RFC 9293 — Transmission Control Protocol (TCP)](https://www.rfc-editor.org/rfc/rfc9293) — current TCP spec (obsoletes RFC 793).
- [RFC 768 — User Datagram Protocol (UDP)](https://www.rfc-editor.org/rfc/rfc768) — the entire UDP spec in ~3 pages.
- [`tcp(7)` — man7.org](https://man7.org/linux/man-pages/man7/tcp.7.html) and [`udp(7)` — man7.org](https://man7.org/linux/man-pages/man7/udp.7.html).
- [`socket(2)` — man7.org](https://man7.org/linux/man-pages/man2/socket.2.html) — `SOCK_STREAM` vs `SOCK_DGRAM`.
- Kurose & Ross, *Computer Networking: A Top-Down Approach* — the transport-layer chapter (multiplexing, reliable data transfer).
- W. Richard Stevens, *UNIX Network Programming, Vol. 1* — the definitive sockets API reference (mentioned).
- [Beej's Guide to Network Programming](https://beej.us/guide/bgnet/) — TCP vs UDP sockets, hands-on.

## Videos

- *Computerphile* — search **"TCP vs UDP / ports"** ([search](https://www.youtube.com/results?search_query=computerphile+tcp+vs+udp+ports)).
- Search **"head of line blocking explained"** for the feed-handler intuition ([search](https://www.youtube.com/results?search_query=head+of+line+blocking+tcp+explained)).
- Conference talks on **low-latency market-data feed handlers** ([search](https://www.youtube.com/results?search_query=low+latency+market+data+feed+handler+talk)).
