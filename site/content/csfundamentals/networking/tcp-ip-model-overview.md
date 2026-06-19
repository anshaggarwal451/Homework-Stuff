# TCP/IP Model Overview

> **Why a quant dev must own this:** A market-data tick or an order doesn't
> teleport from the exchange to your strategy — it descends through a stack of
> layers, each of which prepends a header, copies bytes, and burns nanoseconds.
> Understanding the four layers of TCP/IP — what each one *adds*, where the
> kernel does work you can't see, and where the socket sits — is the mental map
> that makes everything else (kernel bypass, multicast feeds, `TCP_NODELAY`,
> MTU tuning) make sense. It is also the first thing a networking-flavored HFT
> interview probes.

## First principles: why layer at all?

Networking is a hard problem stacked on top of other hard problems: turning
bits into voltages on a wire, getting a frame to the right machine on a LAN,
getting a packet across the planet through routers that have never heard of
each other, recovering from loss, and finally delivering bytes to the *right
program* on the destination host. Trying to solve all of that in one monolithic
piece of software would be unmaintainable.

The answer is **layering**: split the problem into independent strata, each
with a narrow contract. A layer uses the service of the layer below it and
offers a service to the layer above, talking to its *peer* layer on the remote
host as if it had a direct conversation. Each layer is ignorant of the details
above and below — that's the whole point. The link layer doesn't know it's
carrying TCP; TCP doesn't know whether it runs over Ethernet, Wi-Fi, or
InfiniBand.

## The four layers of TCP/IP (and how OSI maps on)

The **TCP/IP model** has four layers. The older, more academic **OSI model**
has seven. You will be asked to relate them, so memorize the mapping:

| TCP/IP (4 layers) | OSI (7 layers) | Typical protocols / units | "Address" used |
|---|---|---|---|
| **Application** | Application, Presentation, Session (5–7) | HTTP, FIX, ITCH, OUCH, DNS, TLS | — (app-defined) |
| **Transport** | Transport (4) | **TCP**, **UDP** | port (16-bit) |
| **Internet** | Network (3) | **IP** (v4/v6), ICMP, IGMP | IP address |
| **Network Access** (Link) | Data Link + Physical (1–2) | Ethernet, ARP, Wi-Fi | MAC address |

A few notes the careful candidate makes:

- TCP/IP collapses OSI's top three layers into one **Application** layer. In
  practice nobody ships a separate "presentation" or "session" layer; TLS and
  serialization live in the app.
- TCP/IP merges OSI's physical and data-link into one **Network Access** (or
  "link") layer.
- The *data unit* has a name per layer: a **segment** (TCP) or **datagram**
  (UDP) at transport, a **packet** at the internet layer, a **frame** at the
  link layer, and **bits/symbols** on the physical medium. Interviewers love
  the segment-vs-packet-vs-frame distinction.

## The hourglass: IP at the waist

The single most important structural fact about the internet is its shape.
Draw the protocol families at each layer and you get an **hourglass**: many
applications at the top (HTTP, FIX, SSH, your proprietary feed handler), many
link technologies at the bottom (Ethernet, Wi-Fi, fiber, InfiniBand), and
**exactly one protocol at the waist** — **IP**.

```text
   HTTP  FIX  ITCH  DNS  SSH  ...        many applications
        \   \   |   /   /
            TCP        UDP                two transports
              \       /
               \     /
                 IP                        <-- the narrow waist
               /     \
              /       \
        Ethernet  Wi-Fi  fiber  ...       many link layers
```

The narrow waist is a *design triumph*: anything that speaks IP can run any app
over any medium. "**Everything over IP, IP over everything.**" It also explains
why innovation at the IP layer is so slow and painful (IPv4 → IPv6 took
decades) — the waist is load-bearing for the entire internet.

## Encapsulation: headers nest like Russian dolls

When your application calls `send()`, the data travels *down* the stack. Each
layer wraps the unit it receives from above in its own header (and sometimes a
trailer), a process called **encapsulation**:

```text
Application data:                                  [          payload          ]
Transport (TCP) prepends a segment header:    [TCP hdr][          payload          ]
Internet (IP) prepends a packet header:   [IP hdr][TCP hdr][          payload          ]
Link (Ethernet) wraps with header+trailer:
   [Eth hdr][IP hdr][TCP hdr][        payload        ][Eth FCS]
   |<-- 14B -->|<- 20B ->|<- 20B ->|                  |<- 4B ->|
```

So the bytes that actually clock out onto the wire for a TCP/IPv4/Ethernet
packet look like:

```text
+-----------+---------+----------+------------------+-------+
| Ethernet  |   IP    |   TCP    |   App payload    |  FCS  |
|  header   | header  | header   |                  | (CRC) |
|  14 bytes | 20 bytes| 20 bytes |  0..1460 bytes   | 4 B   |
+-----------+---------+----------+------------------+-------+
 \_______________________ Ethernet frame _____________________/
            \________________ IP packet ________________/
                       \________ TCP segment ________/
```

On **receive**, the reverse happens — **decapsulation**. The NIC hands the
frame to the kernel; the link layer strips the Ethernet header (after checking
the FCS), the internet layer strips the IP header (and routes/reassembles), the
transport layer strips the TCP/UDP header (and demultiplexes to the right
socket using the port), and the payload finally appears in your `recv()` buffer.

> **Interview gotcha:** each header is just *more bytes on the wire*. For a
> 64-byte order message, you pay ~58 bytes of Ethernet+IP+TCP headers — nearly
> half the packet is overhead. This is why latency-sensitive shops obsess over
> header sizes and why some use UDP (8-byte transport header) instead of TCP
> (20+).

## The minimum-size packet and overhead reality

A standard Ethernet frame has a **minimum payload of 46 bytes** and a maximum
of **1500 bytes** (the MTU). With the inter-frame gap (12 bytes), preamble (7),
and start-of-frame delimiter (1), the smallest thing you can put on a classic
gigabit link is **84 bytes on the wire** even for a tiny message. The headers
are not free, and at 10/25/100 GbE the *per-packet* cost (not just per-byte)
dominates for small messages — which is exactly the regime HFT lives in.

## MTU: the largest packet that fits

The **Maximum Transmission Unit (MTU)** is the largest *layer-3 payload* (IP
packet, including the IP header) a link can carry in one frame — classically
**1500 bytes** for Ethernet. If the internet layer needs to send something
bigger, it must either **fragment** it (split into multiple packets, reassembled
at the destination — a topic for the [Internet Layer](internet-layer.md)
lesson) or rely on the transport layer to never hand it more than fits.

TCP discovers the usable size via the **MSS** (Maximum Segment Size) it
negotiates in the handshake — typically `MTU − IP header − TCP header = 1500 −
20 − 20 = 1460` bytes. **Jumbo frames** (MTU up to 9000) reduce per-packet
overhead for bulk transfer but are a deliberate, end-to-end-coordinated choice;
they don't help — and can hurt — the tiny-message latency regime.

## The socket: the app/transport boundary

Where does *your code* plug in? At the **socket** — the API boundary between the
application layer and the transport layer. A socket is the kernel's handle for
one endpoint of a communication. You create one with `socket()`, then the
kernel owns everything below it.

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>

int main() {
    // AF_INET = IPv4 (Internet layer), SOCK_STREAM = TCP (Transport layer).
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 1;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(12345);          // host -> network byte order!
    ::inet_pton(AF_INET, "10.0.0.7", &addr.sin_addr);

    // connect() drives the 3-way handshake down at the transport layer;
    // the kernel builds the TCP/IP/Ethernet headers for you.
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) == 0) {
        const char msg[] = "NEW ORDER ...";
        ::send(fd, msg, sizeof msg, 0);      // your payload; kernel adds headers
        char buf[256];
        ssize_t n = ::recv(fd, buf, sizeof buf, 0);  // kernel strips headers
        (void)n;
    }
    ::close(fd);
}
```

Notice the `htons()` call: the network/transport layers use **big-endian**
("network byte order") for header fields like ports, but your x86 box is
little-endian. That contract is exactly the subject of the
[Byte Order and Endianness](../cpu-architecture-basics/byte-order-and-endianness.md)
lesson — every header field you ever read off the wire is governed by it.

The socket type maps directly onto the transport protocol:
`SOCK_STREAM` → TCP, `SOCK_DGRAM` → UDP, `SOCK_RAW` → speak IP/ICMP yourself.

## The end-to-end principle

A foundational design rule (Saltzer, Reed, Clark): **functions that can only be
fully implemented at the endpoints should live at the endpoints, not in the
network.** The network's job is to move packets, best-effort; reliability,
ordering, encryption, and integrity are the *endpoints'* responsibility (i.e.
TCP or your app), because only the endpoints know what "correct" means for the
application.

This is why the network core is "dumb" (routers just forward IP packets) and
the edges are "smart" (TCP retransmits, your feed handler does gap detection).
For HFT it has a direct corollary: if your market-data transport is UDP (which
the network treats as fire-and-forget), then **your application owns reliability
and ordering** — sequence numbers, gap-fill, A/B feed arbitration. Nobody below
you is going to recover a dropped multicast packet.

## How a send actually flows (the work you pay for)

When you `send()` on a TCP socket, the kernel typically:

1. **Copies** your bytes from user space into a kernel socket buffer (`sk_buff`).
2. The transport layer segments them, assigns sequence numbers, builds the TCP
   header (computes checksum, or offloads it to the NIC).
3. The internet layer looks up the route, builds the IP header, decrements
   nothing (it's the source), and hands it down.
4. The link layer resolves the next-hop MAC (via ARP cache), builds the
   Ethernet header.
5. The packet is placed on a NIC **transmit ring**; the NIC **DMA**s it out of
   memory and serializes it onto the wire, possibly computing the checksum/segmentation
   in hardware (TSO/checksum offload).

Each of those steps is real CPU time, cache traffic, and at least one
user↔kernel copy. The receive path adds an **interrupt** (or NAPI poll), more
copies, and a context switch to wake your thread. Roughly: a round trip through
the kernel network stack costs on the order of **a few microseconds** per
direction on commodity hardware — an eternity when your edge is measured in
hundreds of nanoseconds.

## Performance & hardware reality

- **Every layer adds latency and overhead.** Header construction, checksums,
  copies, and the interrupt/wakeup on receive all cost time. The stack is
  optimized for throughput and generality, not for the absolute lowest latency
  on tiny messages.
- This is the entire motivation for **kernel bypass** (DPDK, Solarflare/Xilinx
  Onload, ef_vi, RDMA, AF_XDP): map the NIC's rings directly into user space,
  **poll** instead of taking interrupts, and avoid the kernel copy — turning the
  "few microseconds" into "hundreds of nanoseconds". You still implement the
  *same* layering (you parse Ethernet/IP/UDP headers yourself), you just do it
  in user space without the kernel in the path. See the sibling lessons on
  **polling** and **zero-copy** for how this is done.
- **NIC offloads** (checksum, TSO/LRO, RSS) move per-packet work into hardware,
  but some (like LRO/GRO, which coalesce packets) *add* latency by batching, so
  HFT NIC configs often disable them.

## Quant/HFT relevance & interview gotchas

- **Know the layer of every protocol they name.** FIX/ITCH/OUCH = application.
  TCP/UDP = transport. IP/ICMP/IGMP = internet. Ethernet/ARP = link. Confusing
  these is an instant red flag.
- **Segment vs packet vs frame.** Be precise; the units have layer-specific
  names.
- **"Why does HFT bypass the kernel?"** Because the layered stack does real,
  copy-heavy, interrupt-driven work *per packet*, and at the small-message,
  latency-critical edge that overhead dwarfs the payload. Layering explains the
  cost; bypass removes the kernel from the path without removing the layers.
- **Header overhead is real.** For a 32-byte order, TCP/IP/Ethernet headers are
  larger than the payload. This drives protocol choice (UDP vs TCP) and framing.
- **End-to-end principle → app owns reliability on UDP feeds.** If they ask "how
  do you handle packet loss on a multicast feed?", the answer lives in *your*
  application, because the network won't help.
- **Endianness lives in headers.** Ports, IP addresses, sequence numbers are all
  big-endian on the wire; `htons`/`htonl` (or by-value parsing) bridge to your
  little-endian CPU.

## Key takeaways

1. TCP/IP has **four layers** — Network Access, Internet, Transport,
   Application — mapping onto OSI's seven; collapse OSI 1–2 into link and OSI
   5–7 into application.
2. **Encapsulation** nests headers: `Ethernet[ IP[ TCP[ payload ] ] ]`. Receive
   reverses it (decapsulation). Each header is more bytes and more work.
3. The internet is an **hourglass with IP at the waist**: many apps and many
   links, but one common network protocol.
4. The **socket** is the application/transport boundary; `SOCK_STREAM`→TCP,
   `SOCK_DGRAM`→UDP. Below it, the kernel owns the stack.
5. The **end-to-end principle** pushes reliability to the endpoints — on a UDP
   feed, *your app* owns loss recovery and ordering.
6. Every layer costs latency; understanding that cost is the *motivation* for
   **kernel bypass**, multicast feeds, and header-size obsession in HFT.

## Self-check

1. Name the four TCP/IP layers from top to bottom and the data-unit name at
   each.
2. A TCP segment over IPv4 over Ethernet: list the headers in wire order and
   their approximate sizes. How much overhead carries a 40-byte order message?
3. What protocol sits "at the waist" of the hourglass, and why is that
   architecturally significant?
4. Where exactly does the socket API sit in the layer model, and what does the
   `socket(AF_INET, SOCK_DGRAM, 0)` call select?
5. The end-to-end principle says reliability belongs at the endpoints. What is
   the direct consequence for an HFT shop consuming a UDP-multicast market-data
   feed?
6. Why does the layered kernel stack motivate kernel bypass, and what does
   bypass *not* eliminate?

## Further reading

- [RFC 1122 — Requirements for Internet Hosts (Communication Layers)](https://www.rfc-editor.org/rfc/rfc1122) — the canonical statement of the layering and host responsibilities.
- Saltzer, Reed, Clark — [**"End-to-End Arguments in System Design"**](https://web.mit.edu/Saltzer/www/publications/endtoend/endtoend.pdf) — the foundational paper.
- Kurose & Ross, *Computer Networking: A Top-Down Approach* — the standard textbook treatment of the layered model.
- W. Richard Stevens, *TCP/IP Illustrated, Vol. 1* — the definitive deep dive into the stack (mentioned throughout these lessons).
- [Beej's Guide to Network Programming](https://beej.us/guide/bgnet/) — the friendliest practical intro to sockets and the stack.
- [`socket(2)` — man7.org](https://man7.org/linux/man-pages/man2/socket.2.html) — the kernel API at the app/transport boundary.
- [The "hourglass" model — Wikipedia: Internet protocol suite](https://en.wikipedia.org/wiki/Internet_protocol_suite) — concise reference for the four-layer model and OSI mapping.

## Videos

- *Computerphile* — search for **"TCP/IP" / "OSI model"** explainers ([search](https://www.youtube.com/results?search_query=computerphile+tcp+ip+osi+model)).
- *Ben Eater* — **"Networking tutorial / how data is sent over the internet"** ([search](https://www.youtube.com/results?search_query=ben+eater+networking+tutorial+how+the+internet+works)) — superb bottom-up intuition.
- CppCon — **"When a Microsecond Is an Eternity"** (Carl Cook) for why every layer's latency matters in HFT ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)).
