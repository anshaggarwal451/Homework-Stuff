# Internet Layer

> **Why a quant dev must own this:** Market data reaches you as **UDP
> multicast over IP** — and "joining a group," choosing TTL, and avoiding
> fragmentation are all *internet-layer* operations. The IP header is the
> envelope every tick and every order travels in; reading its fields (and
> knowing which are big-endian) is the price of admission to a feed handler.
> The internet layer is also the "waist" of the protocol hourglass, so it's
> where end-to-end addressing, routing, and multicast group membership are
> defined.

## First principles: what the internet layer does

The [Network Access layer](network-access-layer.md) gets a frame across **one**
link. The **Internet layer** (OSI's Network layer) gets a packet across **many**
links — from the source host to the destination host, hop by hop through
routers, possibly across the planet. Its core service is **best-effort,
connectionless, host-to-host delivery** using globally meaningful **IP
addresses**.

Three words define its contract, and each has consequences your application
must live with:

- **Best-effort:** packets may be lost, duplicated, delayed, or reordered. The
  internet layer makes no promises. (Reliability, if you want it, is the
  transport layer's or your app's job — the end-to-end principle.)
- **Connectionless:** each packet ("datagram") is routed independently; there is
  no notion of a "connection" at this layer. Two packets to the same
  destination can take different paths.
- **Host-to-host:** IP delivers to a *host* (an IP address). Getting it to the
  right *program* on that host is the transport layer's demultiplexing job
  (via ports).

## The IPv4 header

IP is defined in **RFC 791** (IPv4). The header is normally **20 bytes** (more
if options are present). Every field is **big-endian** ("network byte order"),
which is exactly why you reach for `htons`/`ntohl` or by-value parsing — see the
[Byte Order and Endianness](../cpu-architecture-basics/byte-order-and-endianness.md)
lesson.

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Version|  IHL  |   DSCP    |ECN|         Total Length          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         Identification        |Flags|     Fragment Offset     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Time to Live |    Protocol   |        Header Checksum        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Source IP Address (32 bits)                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                 Destination IP Address (32 bits)              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    Options (if IHL > 5)         |   Padding   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Field by field:

- **Version (4 bits):** `4` for IPv4.
- **IHL (4 bits):** Internet Header Length in **32-bit words**. `5` means a
  20-byte header (no options); the max is `15` → 60 bytes. You multiply by 4 to
  get bytes and to find where the payload starts.
- **DSCP (6 bits) + ECN (2 bits):** the old "Type of Service" byte. DSCP carries
  QoS/traffic-class markings; ECN signals congestion without dropping.
- **Total Length (16 bits):** the entire packet (header + payload) in bytes;
  max 65,535.
- **Identification (16 bits):** an ID shared by all fragments of one original
  datagram, so the receiver can group them for reassembly.
- **Flags (3 bits):** bit 0 reserved; **DF** (Don't Fragment); **MF** (More
  Fragments — set on all but the last fragment).
- **Fragment Offset (13 bits):** where this fragment's data sits in the original
  datagram, in **8-byte units**.
- **TTL (8 bits):** Time To Live — decremented by **1 at every router hop**;
  when it hits 0 the packet is dropped and an ICMP "time exceeded" is returned.
  Prevents routing loops; `traceroute` exploits it. **For multicast, TTL also
  bounds scope** (how many hops the group traffic may travel).
- **Protocol (8 bits):** what's in the payload — `6` = TCP, `17` = UDP, `1` =
  ICMP, `2` = IGMP. This is how the receiving host's internet layer knows which
  transport to hand the payload to.
- **Header Checksum (16 bits):** covers the IP header *only* (not the payload).
  Because TTL changes every hop, **every router recomputes this checksum** —
  cheap but nonzero work. (IPv6 dropped it entirely.)
- **Source / Destination IP (32 bits each):** the end-to-end addresses. Unlike
  MAC addresses, these **do not change** as the packet is routed.

## The IPv6 header

IPv6 (**RFC 8200**) was designed partly to make routers faster: a **fixed
40-byte header**, no per-packet checksum, no router-side fragmentation, and
optional features pushed into chained extension headers.

```text
+-------+----------------+------------------------------------+
| Ver=6 | Traffic Class  |          Flow Label                |   4 bytes
+-------+----------------+------------------------------------+
|     Payload Length     | Next Header  |    Hop Limit         |   4 bytes
+------------------------+--------------+----------------------+
|                  Source Address (128 bits)                  |  16 bytes
+-------------------------------------------------------------+
|               Destination Address (128 bits)                |  16 bytes
+-------------------------------------------------------------+
```

Key differences to be able to recite:

- **128-bit addresses** (vs 32-bit) — the headline reason IPv6 exists (IPv4
  address exhaustion).
- **No header checksum** — fewer per-router cycles; integrity is left to link
  (FCS) and transport (TCP/UDP checksum) layers.
- **`Next Header`** replaces "Protocol" and also chains optional **extension
  headers** (routing, fragmentation, etc.) instead of inline options.
- **`Hop Limit`** is just the renamed TTL.
- **Routers never fragment IPv6** — the source must use Path MTU Discovery and
  size packets to fit.

Much HFT infrastructure is still IPv4-centric, but know IPv6 cold for the
comparison question.

## Fragmentation and reassembly

If a packet is larger than a link's [MTU](network-access-layer.md), IPv4 may
**fragment** it: split the payload into pieces, each with its own IP header,
sharing the **Identification** field, with **Fragment Offset** and the **MF**
flag set so the destination can stitch them back together. Crucially,
**reassembly happens only at the final destination**, not at intermediate
routers.

Fragmentation is something you want to **avoid** on a latency- and
loss-sensitive path:

- **Loss amplification:** if any one fragment is dropped, the *entire* original
  datagram is lost — the receiver can't reassemble it. For a UDP feed with no
  retransmission, that's a guaranteed gap.
- **Reassembly cost & buffers:** the receiver must buffer fragments and run a
  reassembly timer; this is overhead and a DoS surface.
- **Order/firewall issues:** stateless devices struggle with fragments.

The practical rule for market-data and order packets: **keep every datagram
under the path MTU** (e.g. payload ≤ ~1472 bytes for a UDP datagram on a
1500-byte Ethernet MTU, after the 20-byte IP and 8-byte UDP headers). Exchanges
size their multicast messages accordingly. You can also set **DF** and rely on
**Path MTU Discovery**, but the surest path is to never exceed the MTU.

## Routing in one paragraph

Routers forward packets toward the destination IP by consulting a **routing
table** of `(prefix, next-hop)` entries and choosing the **longest-prefix
match**. At each hop the router decrements the TTL, recomputes the IPv4 header
checksum, looks up the next hop, resolves its MAC (ARP), rewrites the Ethernet
header, and forwards. Routing *protocols* (OSPF, BGP) populate those tables, but
forwarding itself — what the data plane does per packet — is the latency-
relevant part. Inside a trading data center the path is usually one or two
low-latency switch hops, not an internet-scale routing problem.

## ICMP: the control plane

**ICMP** (Internet Control Message Protocol, protocol number 1) carries error
and diagnostic messages *for* IP: "destination unreachable," "time exceeded"
(used by `traceroute`), "fragmentation needed but DF set" (essential to Path MTU
Discovery), and echo request/reply (used by `ping`). It's not a transport for
application data — it's IP talking to IP about problems.

## Multicast: the heart of market data

A normal **unicast** packet goes to one host. **Multicast** lets one sender
reach *many* receivers efficiently: the sender transmits **one** copy to a
**group address**, and the network (switches/routers) replicates it only down
paths that have interested subscribers. This fan-out — one send, N receivers,
done by the network rather than the source — is exactly why exchanges
distribute market data via **UDP multicast**.

Mechanics:

- **Group addresses (IPv4):** the **`224.0.0.0/4`** range (`224.0.0.0`–
  `239.255.255.255`) is reserved for multicast. `239.0.0.0/8` is the
  administratively-scoped (private) range exchanges typically use internally.
- **IGMP (Internet Group Management Protocol):** how a host tells its local
  router/switch "I want to receive group `239.1.2.3`." **IGMP snooping** on the
  switch then forwards that group's frames only to ports that asked — avoiding
  flooding every port.
- **TTL as scope:** the multicast packet's TTL bounds how far it propagates
  (e.g. TTL=1 stays on the local segment).
- **No reliability:** multicast is UDP — best-effort fan-out. Lost packets are
  *not* retransmitted, which is why feeds carry **sequence numbers** and firms
  run **A/B redundant feeds** and gap-fill logic.

Joining a group from C++ is an internet-layer operation done via `setsockopt`
on a UDP socket:

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <cstring>

// Join an IPv4 multicast group on a specific local interface.
bool join_group(int udp_fd, const char* group_ip, const char* local_ip) {
    ip_mreq mreq{};
    // Group to join (multicast address, e.g. "239.1.2.3").
    ::inet_pton(AF_INET, group_ip, &mreq.imr_multiaddr);
    // Which NIC to receive on (its unicast IP) — critical on multi-homed hosts.
    ::inet_pton(AF_INET, local_ip, &mreq.imr_interface);

    // IP_ADD_MEMBERSHIP triggers an IGMP join; the kernel & switch start
    // delivering this group's datagrams to this socket.
    return ::setsockopt(udp_fd, IPPROTO_IP, IP_ADD_MEMBERSHIP,
                        &mreq, sizeof mreq) == 0;
}
```

The full multicast *receiver* (socket + `SO_REUSEADDR` + `bind` +
`IP_ADD_MEMBERSHIP` + `recvfrom`) is built out in the [UDP Protocol](udp-protocol.md)
lesson. Specifying the **interface** (`imr_interface`) matters on
multi-homed colo boxes that take A and B feeds on separate NICs.

## Performance & hardware reality

- **Per-hop work:** TTL decrement + IPv4 checksum recompute + longest-prefix
  lookup + ARP/MAC rewrite. On hardware-forwarding switches this is nanoseconds;
  in a software router it's more. IPv6's checksum-free header shaves a little.
- **Fragmentation is pure downside on the feed path** — avoid it; it amplifies
  loss and adds reassembly cost.
- **Multicast fan-out is done by the switch/router, not the source** — the
  reason a single exchange feed can reach thousands of subscribers without the
  source sending thousands of copies.
- **Header overhead:** 20 bytes (IPv4) or 40 (IPv6) per packet, on top of
  Ethernet's 14+4. For a tiny order this is a large fraction of the wire bytes.

## Quant/HFT relevance & interview gotchas

- **Market data = UDP multicast over IP.** Be able to explain group addresses
  (`224.0.0.0/4` / `239/8`), IGMP join, IGMP snooping, and TTL scoping, and to
  call `IP_ADD_MEMBERSHIP` with the right interface.
- **Avoid fragmentation.** Know *why* (one lost fragment kills the whole
  datagram, fatal on a no-retransmit UDP feed) and *how* (keep datagrams ≤ path
  MTU; ~1472-byte UDP payload on 1500 MTU).
- **TTL has two jobs:** loop prevention (decrement-to-zero) and multicast scope.
- **IP addresses are end-to-end; MACs are per-hop.** A classic "what changes as
  a packet is routed?" question.
- **IPv4 vs IPv6 header diffs:** 32 vs 128-bit addresses, IPv6's fixed 40-byte
  header, no IPv6 checksum, IPv6 routers never fragment.
- **Protocol field demuxes to transport** (6=TCP, 17=UDP) — connects to the
  [Transport Layer](transport-layer.md).
- **Best-effort, connectionless** means the network won't recover loss — your
  feed handler must (sequence numbers, A/B arbitration, gap-fill).

## Key takeaways

1. The internet layer provides **best-effort, connectionless, host-to-host**
   delivery via **IP addresses** (end-to-end, unlike per-hop MACs).
2. The **IPv4 header** (20 B, RFC 791) carries TTL, Protocol (6=TCP/17=UDP),
   Identification/Flags/Offset for fragmentation, and a header-only checksum
   every router recomputes — all big-endian.
3. **IPv6** (RFC 8200): 128-bit addresses, fixed 40-byte header, no checksum,
   no router fragmentation, extension headers via `Next Header`.
4. **Fragmentation** splits over-MTU packets, reassembled only at the
   destination; **avoid it** — one lost fragment loses the whole datagram.
5. **Multicast** (`224.0.0.0/4`, IGMP, snooping, TTL scope) gives one-to-many
   fan-out done by the network — the foundation of exchange market-data feeds.
6. Joining a feed is `setsockopt(..., IP_ADD_MEMBERSHIP, ...)` on the correct
   interface; reliability is *your* job because IP is best-effort.

## Self-check

1. Decode an IPv4 header where IHL = 6, Protocol = 17, TTL = 1. Header length?
   Next layer? What happens at the first router?
2. Why does a router recompute the IPv4 header checksum at every hop, and what
   IPv6 change removes that work?
3. Explain IPv4 fragmentation and why it is dangerous on a UDP market-data feed.
   How do you avoid it?
4. What is the IPv4 multicast address range, and what is the role of IGMP and
   IGMP snooping?
5. Which header field changes per hop, and which IP-layer address stays constant
   end-to-end? Contrast with MAC addresses.
6. Name three differences between the IPv4 and IPv6 headers.

## Further reading

- [RFC 791 — Internet Protocol (IPv4)](https://www.rfc-editor.org/rfc/rfc791) — the original spec with the header diagram.
- [RFC 8200 — Internet Protocol, Version 6 (IPv6) Specification](https://www.rfc-editor.org/rfc/rfc8200) — the IPv6 header and extension headers.
- [`ip(7)` — man7.org](https://man7.org/linux/man-pages/man7/ip.7.html) — the Linux IPv4 socket interface, incl. `IP_ADD_MEMBERSHIP`, TTL, multicast options.
- [IP multicast — Wikipedia](https://en.wikipedia.org/wiki/IP_multicast) and [IGMP — Wikipedia](https://en.wikipedia.org/wiki/Internet_Group_Management_Protocol).
- W. Richard Stevens, *TCP/IP Illustrated, Vol. 1* — chapters on IP, ICMP, fragmentation, and multicast (mentioned).
- Kurose & Ross, *Computer Networking: A Top-Down Approach* — the network-layer chapters.
- [Beej's Guide to Network Programming](https://beej.us/guide/bgnet/) — practical address handling (`inet_pton`, `sockaddr_in`).

## Videos

- *Computerphile* — search **"IP addresses / how the internet routes packets"** ([search](https://www.youtube.com/results?search_query=computerphile+ip+address+routing)).
- *Ben Eater* — **"The internet / IP packets / traceroute"** ([search](https://www.youtube.com/results?search_query=ben+eater+ip+packet+traceroute)).
- Search for **"IP multicast explained"** for feed-distribution intuition ([search](https://www.youtube.com/results?search_query=ip+multicast+explained)).
