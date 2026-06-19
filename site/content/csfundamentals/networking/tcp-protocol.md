# TCP Protocol

> **Why a quant dev must own this:** Order entry runs on TCP. When you submit
> an order, modify it, or cancel it, you cannot afford to silently lose or
> reorder a message — so the session is a TCP connection, and the latency of
> that connection is *your* latency. The single most expensive bug here is
> trivial to fix and constantly asked about: leaving **Nagle's algorithm** on,
> which can add ~40 ms to your order. Understanding the handshake, slow start,
> retransmission, and the `TCP_NODELAY`/delayed-ACK interaction is what
> separates someone who *uses* sockets from someone who can *tune the order
> path*.

## First principles: what TCP promises

**TCP (Transmission Control Protocol, RFC 9293, which obsoletes the classic
RFC 793)** turns IP's unreliable, unordered, host-to-host datagram service into
a **reliable, ordered, full-duplex byte stream between two processes**. The
contract it offers your application:

- **Reliable:** every byte you send arrives, or the connection fails — TCP
  detects loss and retransmits.
- **Ordered:** bytes are delivered to the receiver in the exact order sent.
- **Byte stream:** there are **no message boundaries** — TCP may coalesce or
  split your `send()`s arbitrarily. *You* must frame messages (length prefixes
  / delimiters).
- **Flow-controlled:** TCP won't overrun a slow receiver.
- **Congestion-controlled:** TCP backs off when the network is congested.
- **Connection-oriented:** a setup handshake establishes shared state before
  any data flows.

Every one of these guarantees has a *latency cost*, and the art of using TCP in
HFT is paying the minimum necessary for them.

## The TCP header

The TCP header is **20 bytes minimum** (up to 60 with options), all
**big-endian**:

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          Source Port          |       Destination Port        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        Sequence Number                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Acknowledgment Number                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Data  |Rsvd |C|E|U|A|P|R|S|F|                                 |
|Offset |     |W|C|R|C|S|S|Y|I|            Window Size           |
|       |     |R|E|G|K|H|T|N|N|                                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|           Checksum            |         Urgent Pointer        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Options (0..40 bytes)        |   Padding   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **Source / Destination Port (16 each):** with the IP addresses, form the
  4-tuple that identifies the connection.
- **Sequence Number (32):** byte offset of the *first* data byte in this segment
  within the stream. This is how TCP orders and tracks every byte. Initial
  values are randomized (ISN) for security.
- **Acknowledgment Number (32):** the next byte the sender *expects to receive*
  — i.e. "I have everything up to ACK−1." TCP ACKs are **cumulative**.
- **Data Offset (4):** header length in 32-bit words (5 = 20 bytes, no options).
- **Flags:** the control bits.
  - **SYN** — synchronize sequence numbers (connection setup).
  - **ACK** — the Acknowledgment field is valid.
  - **FIN** — sender is done sending (graceful close).
  - **RST** — reset/abort the connection immediately.
  - **PSH** — push: deliver buffered data to the app now.
  - **URG** — urgent pointer valid (essentially unused today).
  - **CWR/ECE** — explicit congestion notification signaling.
- **Window Size (16):** receiver's advertised free buffer space — the basis of
  **flow control** (scaled by the window-scale option, below).
- **Checksum (16):** over pseudo-header + TCP header + data (mandatory).
- **Urgent Pointer (16):** with URG; legacy.
- **Options:** MSS, window scale, SACK, timestamps (below).

### Key options

- **MSS (Maximum Segment Size):** advertised in the SYN; the largest payload
  each side will accept in one segment, typically `MTU − 40 = 1460` bytes on
  standard Ethernet. Prevents IP fragmentation.
- **Window Scale (RFC 7323):** multiplies the 16-bit window so connections can
  use windows far larger than 64 KiB — essential on high-bandwidth, high-latency
  ("long fat") links.
- **SACK (Selective ACK):** lets the receiver acknowledge non-contiguous blocks,
  so the sender retransmits *only* the missing segments rather than everything
  after the gap.
- **Timestamps:** improve RTT measurement and protect against wrapped sequence
  numbers.

## The 3-way handshake

Before any data flows, both ends synchronize sequence numbers and exchange
options. This costs **one round trip** before the first byte of payload:

```text
  Client                                   Server
    |                                         |
    |  -------- SYN (seq=x, MSS, WS) -------->|   "let's talk, my ISN is x"
    |                                         |
    |  <--- SYN+ACK (seq=y, ack=x+1) ---------|   "ok, my ISN is y, got your x"
    |                                         |
    |  -------- ACK (ack=y+1) --------------->|   "got your y; connected"
    |                                         |
    |  ===== data may now flow (both ways) ===|
```

The cost is unavoidable: **the first application byte cannot be sent until the
handshake's third packet** (1 RTT of pure setup, before slow start even ramps).
For an order session this is why you **pre-establish and warm the connection
long before you need to trade** — you never pay the handshake on a hot order.
(TCP Fast Open can carry data in the SYN, but it's not commonly relied on for
exchange sessions.)

## Connection teardown and TIME_WAIT

Closing is a **4-way** exchange (each direction is closed independently, since
TCP is full-duplex):

```text
  A  --- FIN ---> B      A done sending
  A  <-- ACK ---  B
  A  <-- FIN ---  B      B done sending
  A  --- ACK ---> B
  A enters TIME_WAIT (~2*MSL, e.g. 60s) before fully closing.
```

The active closer sits in **TIME_WAIT** for roughly `2 × MSL` (Maximum Segment
Lifetime, commonly ~60 s total) to absorb any straggling segments and to ensure
the final ACK was received before the 4-tuple can be reused. A server that opens
and closes many short connections accumulates thousands of TIME_WAIT sockets,
exhausting ephemeral ports — which is one more reason trading sessions are
**long-lived** rather than per-message.

## Reliability: sequence, ACK, retransmission

TCP achieves reliability with **sequence numbers + cumulative ACKs +
retransmission**:

- Each byte has a sequence number; the receiver ACKs the next byte it expects.
- The sender keeps unacknowledged data buffered and starts a
  **retransmission timer (RTO)**. If the ACK doesn't arrive before the RTO
  fires, it retransmits.
- The RTO is derived from a smoothed **RTT** estimate (and its variance) — TCP
  continuously measures round-trip times to set it adaptively.
- **Fast retransmit:** rather than always waiting for the (slow) RTO, three
  **duplicate ACKs** (the receiver repeatedly ACKing the same byte because
  it keeps receiving out-of-order segments past a gap) signal a likely loss, and
  the sender retransmits the missing segment **immediately**.

This is also the source of **head-of-line blocking**: a single lost segment
stalls delivery of *all* later (already-arrived) bytes to the application until
the gap is filled — fatal for market data, acceptable for orders (see the
[Transport Layer](transport-layer.md) lesson).

## Sliding window & flow control

The receiver advertises a **Window Size** = how much buffer space it has free.
The sender may have at most that many *unacknowledged* bytes "in flight." As
ACKs come back, the window "slides" forward, allowing more data. This is **flow
control** — it stops a fast sender from overrunning a slow receiver's buffer. The
window-scale option lets this window exceed 64 KiB for high-bandwidth-delay
paths.

## Congestion control

Flow control protects the *receiver*; **congestion control** protects the
*network*. TCP maintains a separate **congestion window (cwnd)** and sends no
more than `min(cwnd, advertised window)`. The classic algorithm:

- **Slow start:** begin with a small cwnd (a few segments) and **double it every
  RTT** (exponential growth) until a threshold or loss. So a fresh connection
  cannot burst at full rate — it *ramps*, costing several RTTs to reach line
  rate.
- **Congestion avoidance:** past the threshold, grow cwnd linearly (additive
  increase) to probe gently for more bandwidth.
- **Loss as a signal:** a timeout (RTO) collapses cwnd drastically (back to slow
  start); three dup-ACKs trigger **fast recovery** (halve cwnd and continue),
  the "AIMD" (additive-increase/multiplicative-decrease) behavior.
- **Modern algorithms:** Linux defaults to **CUBIC** (window growth as a cubic
  function of time since last loss, better on high-BDP links). **BBR** (Google)
  models bottleneck bandwidth and RTT directly instead of treating loss as the
  congestion signal.

> **HFT gotcha — slow start after idle:** by default, if a connection is **idle**
> for longer than one RTO, the kernel resets cwnd back to the initial value, so
> the next burst ramps slowly again. An order session that's quiet between trades
> can therefore be *slow on the very order you care about*. Mitigations: disable
> `net.ipv4.tcp_slow_start_after_idle`, or keep the connection "warm" with
> periodic traffic.

## TCP state machine (abbreviated)

```text
            CLOSED
              | (passive open: listen)        | (active open: connect -> send SYN)
              v                                v
           LISTEN  --recv SYN/send SYN+ACK-> SYN_RCVD     SYN_SENT
              |                                  |             | recv SYN+ACK / send ACK
              |                                  |  recv ACK   v
              +----------------------------------+-------> ESTABLISHED
                                                                 |
                          (close: send FIN)                      | (recv FIN: send ACK)
                                  v                              v
                              FIN_WAIT_1 ...               CLOSE_WAIT
                                  |                              |
                              FIN_WAIT_2 / CLOSING / TIME_WAIT   LAST_ACK
                                  |                              |
                                  v                              v
                               CLOSED                         CLOSED
```

You'll see these states in `ss -t` / `netstat`. Knowing what `TIME_WAIT`,
`CLOSE_WAIT`, and `SYN_RCVD` mean (and which side is which) is common debugging
and interview fodder.

## Nagle's algorithm and delayed ACK — the HFT killer

This is the most important practical TCP topic for trading.

**Nagle's algorithm** (RFC 896) reduces the number of tiny packets ("tinygrams")
on the network by **withholding a small send if there is already unacknowledged
data in flight**, coalescing it with later data until an ACK returns or enough
data accumulates to fill an MSS. Great for chatty interactive apps (telnet);
**terrible for an order you want on the wire *now***.

**Delayed ACK** (RFC 1122) is the receiver-side counterpart: to piggyback ACKs
on data, the receiver *delays* sending a pure ACK by up to ~40–200 ms hoping it
can bundle it.

When both are on, they **deadlock against each other**: the sender (Nagle) won't
send the next small chunk until it gets an ACK; the receiver (delayed ACK) won't
send the ACK promptly because it's waiting to piggyback. The result is a
characteristic **~40 ms stall** on small request/response exchanges — catastrophic
for order entry.

The fix is one line:

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>   // TCP_NODELAY, TCP_QUICKACK
#include <arpa/inet.h>
#include <cstring>

int make_order_session(const char* ip, uint16_t port) {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);   // TCP

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(port);                // ports are big-endian
    ::inet_pton(AF_INET, ip, &addr.sin_addr);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) != 0)
        return -1;

    // *** ALWAYS set this on a latency-sensitive TCP session. ***
    // Disables Nagle: small sends go on the wire immediately.
    int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);

    // Optional: ask the kernel not to delay ACKs (Linux; may need re-arming).
    ::setsockopt(fd, IPPROTO_TCP, TCP_QUICKACK, &one, sizeof one);

    return fd;
}
```

> **The single most common HFT TCP interview question:** *"You send an order and
> it takes 40 ms — why?"* Answer: Nagle + delayed ACK interaction; fix with
> **`TCP_NODELAY`**. Be ready to also mention `TCP_QUICKACK` on the receive side
> and that you set `TCP_NODELAY` on **every** order-session socket.

## RTT, RTO, and QUICKACK

- **RTT** is measured continuously (helped by the timestamp option) and feeds a
  smoothed estimate; **RTO** = smoothed RTT + a multiple of its variance, with a
  floor. A spurious RTO causes a retransmit and a cwnd collapse, so a noisy path
  hurts twice.
- **`TCP_QUICKACK`** tells Linux to ACK immediately rather than delay; note it's
  not "sticky" and may need re-setting. On the order path you want ACKs prompt so
  the peer's Nagle (if any) and your RTT estimate stay tight.

## Performance & hardware reality

- **Connection setup:** 1 RTT for the handshake before the first byte. Then
  **slow start** costs several RTTs to reach full window. → **Pre-warm
  connections.**
- **Slow start after idle** silently re-ramps a quiet session → disable it or
  keep it warm.
- **Per-segment ACK/processing** and the in-order delivery requirement mean a
  single loss causes a retransmit + HOL stall (≥ 1 RTT, or an RTO if fast
  retransmit doesn't trigger).
- **Kernel path cost:** like UDP, vanilla TCP pays a syscall + copy per
  send/recv (order of microseconds round-trip through the stack). HFT shops use
  **`TCP_NODELAY`**, busy-poll receive, and increasingly **user-space /
  kernel-bypass TCP stacks** (e.g. Onload's accelerated TCP, or custom
  user-space stacks) to cut the kernel out of the order path while keeping TCP
  semantics on the wire.
- **CUBIC/BBR** matter for bulk throughput; for tiny, infrequent order messages
  the dominant terms are handshake/slow-start/Nagle, not the congestion
  algorithm.

## Quant/HFT relevance & interview gotchas

- **`TCP_NODELAY` always on** for order sessions — disable Nagle. Know the
  Nagle + delayed-ACK ~40 ms deadlock cold; it's *the* question.
- **Pre-establish and warm connections** so you never pay the 1-RTT handshake or
  slow-start ramp on a live order.
- **Disable slow-start-after-idle** (or keep the session warm) so a quiet
  session isn't slow on the next order.
- **TCP is a byte stream, not messages** — your session handler must frame (FIX
  uses a length/`SOH`-delimited format; many binary protocols length-prefix).
- **Head-of-line blocking** is why TCP is for orders, not feeds.
- **TIME_WAIT** and ephemeral-port exhaustion argue for long-lived sessions.
- **All header fields are big-endian** — parse by value (see the
  [Byte Order and Endianness](../cpu-architecture-basics/byte-order-and-endianness.md)
  lesson).
- **RST vs FIN:** FIN is graceful; RST is an abrupt abort (e.g. the exchange
  dropping your session). Know the difference when debugging disconnects.
- **`TCP_QUICKACK`** on the receive side to avoid delayed-ACK latency.

## Key takeaways

1. **TCP (RFC 9293)** provides a **reliable, ordered, full-duplex byte stream**
   over unreliable IP, via **sequence numbers, cumulative (and selective) ACKs,
   and retransmission**.
2. The **3-way handshake** costs **1 RTT** before the first byte; **slow start**
   then ramps over several RTTs → **pre-warm order connections**.
3. The header carries **seq/ack**, flags (**SYN/ACK/FIN/RST/PSH/URG**), the
   **window** (flow control), checksum, and options (**MSS, window scale, SACK,
   timestamps**) — all big-endian.
4. **Flow control** (sliding window) protects the receiver; **congestion
   control** (slow start → AIMD; CUBIC/BBR) protects the network.
5. **Nagle + delayed ACK** can deadlock into a **~40 ms stall** on small
   messages — **always set `TCP_NODELAY`** (and consider `TCP_QUICKACK`) on
   order sessions. This is the canonical HFT TCP gotcha.
6. TCP is a **stream, not messages** (you must frame), suffers **head-of-line
   blocking** (so it's for order entry, not feeds), and its kernel-path latency
   motivates **kernel-bypass / user-space TCP** stacks.

## Self-check

1. Walk through the 3-way handshake and explain exactly why the first
   application byte cannot go out before ~1 RTT.
2. You send a small order over a freshly idle TCP session and it takes 40 ms.
   Name the cause and the one-line fix.
3. What is the difference between flow control and congestion control, and which
   header field/quantity drives each?
4. Explain fast retransmit (three duplicate ACKs) versus an RTO timeout, and why
   fast retransmit is preferable.
5. Why are TCP order sessions long-lived rather than per-message? Reference
   TIME_WAIT and slow start.
6. TCP is a byte stream — what must a FIX/binary order-session handler do that a
   UDP datagram handler does not, and why?

## Further reading

- [RFC 9293 — Transmission Control Protocol (TCP)](https://www.rfc-editor.org/rfc/rfc9293) — current consolidated spec (obsoletes RFC 793).
- [RFC 896 — Congestion Control / Nagle's algorithm](https://www.rfc-editor.org/rfc/rfc896) and [RFC 1122 — Requirements for Internet Hosts](https://www.rfc-editor.org/rfc/rfc1122) (delayed ACK, host TCP requirements).
- [RFC 7323 — TCP Extensions for High Performance](https://www.rfc-editor.org/rfc/rfc7323) (window scaling, timestamps) and [RFC 2018 — TCP SACK](https://www.rfc-editor.org/rfc/rfc2018).
- [`tcp(7)` — man7.org](https://man7.org/linux/man-pages/man7/tcp.7.html) — `TCP_NODELAY`, `TCP_QUICKACK`, `tcp_slow_start_after_idle`, and every socket option.
- W. Richard Stevens, *TCP/IP Illustrated, Vol. 1* — the definitive chapters on the handshake, retransmission, and congestion control (mentioned).
- John Nagle's classic comments on Nagle's algorithm and `TCP_NODELAY` (search ["Nagle's algorithm TCP_NODELAY John Nagle"](https://www.youtube.com/results?search_query=nagle+algorithm+tcp+nodelay+john+nagle)).
- [Beej's Guide to Network Programming](https://beej.us/guide/bgnet/) — stream sockets, `connect`/`listen`/`accept`, framing.

## Videos

- *Computerphile* — search **"TCP / handshake / congestion control"** ([search](https://www.youtube.com/results?search_query=computerphile+tcp+handshake+congestion+control)).
- Search **"TCP slow start congestion control explained"** ([search](https://www.youtube.com/results?search_query=tcp+slow+start+congestion+control+explained)).
- CppCon — **"When a Microsecond Is an Eternity"** (Carl Cook) for why `TCP_NODELAY` and pre-warming matter in HFT ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)).
