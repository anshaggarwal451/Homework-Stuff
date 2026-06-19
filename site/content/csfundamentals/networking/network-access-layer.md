# Network Access Layer

> **Why a quant dev must own this:** This is the layer where a market-data
> packet physically arrives — as electrical or optical symbols, framed into
> Ethernet, DMA'd into host memory by a NIC. The choices that buy or cost you
> nanoseconds at the *edge* live almost entirely here: which NIC, which switch
> (and how it forwards), jumbo vs standard MTU, kernel-bypass capture, and how
> multicast is delivered. If you can't speak fluently about Ethernet frames,
> MAC addresses, ARP, and how a NIC hands a frame to the kernel, you can't
> reason about HFT network latency at all.

## What this layer is responsible for

The **Network Access layer** (the TCP/IP name for OSI's Data Link + Physical
layers; also just called the **link layer**) has one job: **move a frame
across a single physical link to the next hop.** It does *not* know about
end-to-end delivery, routing across the internet, or which application wants the
data — that's all above it. Its scope is exactly one "wire" (one Ethernet
segment, one Wi-Fi cell, one fiber run between two ports).

It splits naturally into two concerns:

- **Physical layer:** turning bits into signals on the medium — voltage levels,
  light pulses, line coding (e.g. 64b/66b on 10GbE), clock recovery,
  serialization/deserialization (SerDes). This is the realm of cables, optics
  (SFP+/QSFP), and the PHY chip. For our purposes: it's where the *propagation
  delay* (~5 ns per meter of fiber/copper) and *serialization delay* (time to
  clock all the bits out, ~ frame_bits / line_rate) come from.
- **Data link layer:** organizing those bits into **frames**, addressing them
  to a local machine via **MAC addresses**, and detecting corruption with a
  checksum. On Ethernet this is the **MAC** (Media Access Control) sublayer.

## The Ethernet frame

Ethernet (IEEE 802.3) is the dominant link technology in data centers and
exchange colo. A frame on the wire looks like this:

```text
+----------+-----+-----------+-----------+-----------+----------------+-----+
| Preamble | SFD |  Dst MAC  |  Src MAC  | EtherType |    Payload     | FCS |
+----------+-----+-----------+-----------+-----------+----------------+-----+
|  7 bytes | 1 B |  6 bytes  |  6 bytes  |  2 bytes  |  46..1500 bytes | 4 B |
            ^^^^^ 0xAB                    ^^^^^^^^^^   ^^^^^^^^^^^^^^^^^
            start-of-frame                e.g.0x0800   the IP packet lives here
                                          =IPv4
\___ not delivered to the host ___/ \________ the "frame" the NIC sees _________/
```

Field by field:

- **Preamble (7 B) + SFD (1 B):** an alternating `10101010…` pattern for the
  receiver to lock its clock onto, ending in the Start-of-Frame Delimiter
  (`10101011`). The NIC consumes these; software never sees them.
- **Destination MAC (6 B):** who on this link should receive the frame.
- **Source MAC (6 B):** who sent it.
- **EtherType (2 B):** what's inside. `0x0800` = IPv4, `0x86DD` = IPv6,
  `0x0806` = ARP, `0x8100` = an 802.1Q VLAN tag follows. (Values ≤ 1500 mean
  the field is instead a length, per the old 802.3 framing — modern gear uses
  EtherType.) These two bytes are **big-endian** on the wire, like everything
  else in a network header — see the
  [Byte Order and Endianness](../cpu-architecture-basics/byte-order-and-endianness.md)
  lesson.
- **Payload (46–1500 B):** the encapsulated IP packet. **46 is the minimum** —
  shorter payloads are zero-padded so the frame reaches the 64-byte minimum
  needed for collision detection on legacy CSMA/CD. **1500 is the standard
  MTU.**
- **FCS (4 B):** a CRC-32 frame check sequence. The NIC computes it on transmit
  and verifies it on receive; a frame failing the CRC is dropped silently by
  hardware. This is your link-layer integrity check.

A VLAN-tagged frame inserts a 4-byte **802.1Q tag** after the source MAC
(EtherType `0x8100`, then 3 bits of priority, a VLAN ID, etc.), which is how a
single physical link carries logically separate networks — exchanges often
deliver A/B feeds or different products on different VLANs.

## MAC addresses

A **MAC address** is a 48-bit identifier burned into (or assigned to) a NIC,
written as six hex octets: `00:1B:21:3C:4D:5E`. The first 24 bits are the
**OUI** (Organizationally Unique Identifier) identifying the vendor; the rest
are vendor-assigned. Two special cases matter:

- The **broadcast** address `FF:FF:FF:FF:FF:FF` reaches everyone on the link
  (used by ARP).
- **Multicast** MACs have the low bit of the first octet set (`01:00:5E:…` is
  the IPv4-multicast range) — the NIC can be programmed to accept specific
  multicast groups, which is the hardware basis of multicast market data.

MAC addresses are **link-local**: they are rewritten at every router hop. Your
packet's *IP* addresses stay constant end-to-end; its *MAC* addresses change to
the next-hop's MAC each time it crosses a router. (Contrast this with the
[Internet Layer](internet-layer.md), where IP addresses are end-to-end.)

## ARP: mapping IP to MAC

To send an IP packet to a host on your LAN, the link layer needs that host's
*MAC* address — but you only know its *IP* address. **ARP (Address Resolution
Protocol, RFC 826)** bridges that gap:

1. Host A wants to send to `10.0.0.7` and has no MAC for it.
2. A **broadcasts** an ARP request: "Who has `10.0.0.7`? Tell `10.0.0.3`
   (MAC `aa:..`)." Every NIC on the link receives the broadcast.
3. Host B (`10.0.0.7`) replies **unicast**: "`10.0.0.7` is at `bb:..`."
4. A caches the mapping in its **ARP cache** (`ip neigh` on Linux) so it doesn't
   re-resolve for every packet.

ARP runs *directly over Ethernet* (EtherType `0x0806`) — it is not carried in
an IP packet, which is why it's a pure link-layer protocol despite dealing in IP
addresses.

> **HFT gotcha:** a cold or expired ARP entry means your *very first* packet to
> a peer waits for an ARP round trip (and may be dropped while resolution is
> pending). Latency-sensitive systems **pre-populate static ARP entries** so the
> first order never eats an ARP stall. Same idea as pre-warming TCP connections.

## MTU and jumbo frames

The **MTU (Maximum Transmission Unit)** is the largest IP payload a link will
carry in one frame — **1500 bytes** for standard Ethernet. **Jumbo frames**
raise it to ~9000 bytes, reducing per-packet header/processing overhead for
*bulk* transfers (storage, backups, intra-cluster shuffles). For HFT's tiny
latency-critical messages, jumbo frames usually don't help and can hurt
(serialization of a big frame delays everything behind it), so the feed path
typically stays at standard MTU. Mismatched MTU across a path causes
fragmentation or black-holed packets — a classic operational footgun.

## Switches vs hubs, and forwarding latency

- A **hub** (obsolete) is a dumb repeater: it copies every bit to every port —
  one collision domain, no intelligence.
- A **switch** is a MAC-aware bridge: it learns which MAC lives on which port
  (by observing source MACs) and forwards each frame only to the port where the
  destination lives. This is the backbone of every modern LAN.

How a switch forwards a frame is *the* latency knob at this layer:

- **Store-and-forward:** the switch reads the *entire* frame, verifies the FCS,
  then forwards. Safe (drops corrupt frames) but adds latency equal to the
  serialization time of the whole frame — for a 1500-byte frame at 10 GbE,
  that's ~1.2 µs of pure switch dwell.
- **Cut-through:** the switch starts forwarding as soon as it has read the
  destination MAC (the first ~6–14 bytes), before the rest of the frame
  arrives. Latency drops to roughly the time to read the header — **tens to a
  few hundred nanoseconds** on a fast switch (e.g. Arista/Cisco low-latency
  models advertise ~350 ns and below). The trade-off: it may forward a frame
  that later fails its CRC (a "runt"/corrupt frame propagates).

> **HFT reality:** exchange colo and trading-firm LANs use **ultra-low-latency
> cut-through switches** and measure port-to-port latency in nanoseconds. The
> store-vs-cut-through distinction is a very common interview question.

## How the NIC hands a frame to the kernel

This is the part that connects the wire to your software, and it's where
kernel-bypass thinking begins. On a modern NIC:

1. The driver pre-allocates **RX descriptor rings** in host memory — circular
   arrays of buffers the NIC may write into.
2. A frame arrives. The NIC's PHY/MAC validates the FCS, then **DMA**s the frame
   directly into the next free RX buffer (no CPU involvement in the copy).
3. The NIC raises an **interrupt** to tell the CPU "you have packets." Under
   load this would cause an interrupt storm, so Linux uses **NAPI**: take one
   interrupt, then switch to **polling** the ring to drain a batch of packets,
   amortizing the per-packet interrupt cost.
4. The kernel walks up the stack — strips Ethernet, hands the IP packet to the
   internet layer, etc. — eventually copying the payload into your `recv()`
   buffer and waking your thread.

Two latency villains live here: the **interrupt + context switch** to wake your
thread, and the **copy** from kernel buffer to user buffer. Kernel bypass
(Solarflare/Xilinx Onload & ef_vi, DPDK, AF_XDP, RDMA) attacks both: it maps
the NIC rings into user space and **busy-polls** them, so the application reads
frames with no interrupt and no kernel copy. See the sibling lessons on
**polling** and **zero-copy** for the mechanics — but note that *the framing you
parse is exactly the Ethernet/IP/UDP layout described here*; bypass doesn't
change the wire format, only who reads it.

## Capturing raw frames: AF_PACKET / raw sockets

When you need to see frames *as they are on the wire* — for a packet capture,
a custom feed handler, or to implement a protocol the kernel doesn't — Linux
offers **`AF_PACKET`** sockets, which deliver entire link-layer frames
(including the Ethernet header) to user space.

```cpp
#include <sys/socket.h>
#include <linux/if_ether.h>   // ETH_P_ALL, struct ethhdr
#include <arpa/inet.h>        // ntohs
#include <unistd.h>
#include <cstdio>

int main() {
    // AF_PACKET + SOCK_RAW: receive full Ethernet frames. ETH_P_ALL = every
    // EtherType. (Requires CAP_NET_RAW / root.)
    int fd = ::socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd < 0) { perror("socket"); return 1; }

    unsigned char frame[2048];
    ssize_t n = ::recv(fd, frame, sizeof frame, 0);
    if (n < (ssize_t)sizeof(ethhdr)) return 1;

    auto* eth = reinterpret_cast<ethhdr*>(frame);
    std::printf("dst %02x:%02x:%02x:%02x:%02x:%02x  ethertype 0x%04x  len %zd\n",
                eth->h_dest[0], eth->h_dest[1], eth->h_dest[2],
                eth->h_dest[3], eth->h_dest[4], eth->h_dest[5],
                ntohs(eth->h_proto),    // EtherType is big-endian on the wire
                n);
    ::close(fd);
}
```

The `ntohs(eth->h_proto)` is the recurring theme: wire fields are big-endian,
so you convert to host order before comparing. Production capture systems use
the **`PACKET_MMAP`** ring-buffer variant of `AF_PACKET` (or libpcap, or
`AF_XDP`) to avoid a copy per frame, but the principle is the same: you receive
the raw Ethernet frame and parse the headers yourself. For comparison,
`man 7 packet` documents `AF_PACKET` in full.

## Performance & hardware reality

- **Propagation delay:** ~5 ns/meter in fiber/copper. Distance to the matching
  engine is a first-order latency term — the entire colocation business exists
  because of this.
- **Serialization delay:** time to clock a frame onto the wire = frame_bits /
  line_rate. A 64-byte frame is ~51 ns at 10 GbE, ~5 ns at 100 GbE. Faster
  links reduce serialization, not propagation.
- **Switch dwell:** cut-through ~100–350 ns; store-and-forward adds the full
  frame's serialization time. Choose cut-through for the feed path.
- **NIC choice matters enormously.** Low-latency NICs (Solarflare/Xilinx,
  NVIDIA/Mellanox ConnectX) provide kernel-bypass stacks, hardware timestamping,
  and tuned interrupt handling. Commodity NICs add microseconds.
- **Microbursts:** market data is bursty — thousands of small multicast packets
  can arrive in a sub-millisecond window (e.g. at an open or a news event).
  Switch buffers and NIC rings can overflow, dropping frames. Sizing buffers
  and reading fast enough to avoid drops is an operational discipline.

## Quant/HFT relevance & interview gotchas

- **Cut-through vs store-and-forward** — know the latency difference and *why*.
  This is the single most asked link-layer HFT question.
- **Multicast is the delivery model for market data.** A switch can replicate a
  single multicast frame to many subscriber ports (fan-out) without the source
  sending N copies. The link-layer multicast MAC (`01:00:5E:…`) and IGMP
  snooping (so the switch only sends to interested ports) make this efficient.
- **Static ARP entries** to avoid first-packet ARP stalls.
- **MTU/jumbo:** know that jumbo helps bulk throughput, not small-message
  latency; MTU mismatches cause fragmentation/black holes.
- **The NIC→kernel path (DMA, rings, interrupts, NAPI)** is the *motivation* for
  kernel bypass. Be able to narrate it.
- **Frame overhead:** 14 B header + 4 B FCS + 7 B preamble + 1 B SFD + 12 B
  inter-frame gap = ~38 bytes of pure overhead around every frame. For tiny
  messages this dominates.

## Key takeaways

1. The Network Access (link) layer moves **frames across one physical link**,
   using **MAC addresses**; IP/routing live above it.
2. An **Ethernet frame** = preamble/SFD + dst MAC + src MAC + EtherType +
   payload (46–1500 B) + FCS (CRC-32). EtherType selects IPv4/IPv6/ARP/VLAN.
3. **MAC addresses are link-local** and rewritten at every router hop; **ARP
   (RFC 826)** maps an IP to a MAC via broadcast.
4. **Switches** forward by learned MAC; **cut-through** (~100s of ns) beats
   **store-and-forward** for latency — the key HFT switch decision.
5. The NIC **DMA**s frames into host **RX rings** and signals via
   **interrupts/NAPI**; the copy + interrupt + wakeup is the latency that
   **kernel bypass** removes.
6. For HFT, this layer is where you pick the NIC and switch, run **multicast**
   for market data, pin **static ARP**, and survive **microbursts**.

## Self-check

1. List the fields of an Ethernet frame in wire order, with sizes. Which fields
   does software never see?
2. What is the minimum and maximum Ethernet payload, and why is there a minimum?
3. Why are MAC addresses described as "link-local," and what changes vs. stays
   constant as a packet crosses a router?
4. Explain cut-through vs store-and-forward switching and the latency
   consequence for a 1500-byte frame at 10 GbE.
5. Walk through how a NIC delivers a received frame to the kernel, and name the
   two latency costs kernel bypass eliminates.
6. Why does an HFT shop pin static ARP entries, and what failure does that
   prevent?

## Further reading

- [RFC 826 — An Ethernet Address Resolution Protocol (ARP)](https://www.rfc-editor.org/rfc/rfc826) — the original spec.
- [`packet(7)` — man7.org](https://man7.org/linux/man-pages/man7/packet.7.html) — `AF_PACKET` raw link-layer sockets and `PACKET_MMAP`.
- [Ethernet frame — Wikipedia](https://en.wikipedia.org/wiki/Ethernet_frame) — clear field-by-field reference incl. preamble, FCS, 802.1Q.
- [IEEE 802 / 802.3 overview — Wikipedia](https://en.wikipedia.org/wiki/IEEE_802.3) — the Ethernet standards family.
- W. Richard Stevens, *TCP/IP Illustrated, Vol. 1*, chapters on the link layer and ARP (mentioned).
- [Beej's Guide to Network Programming](https://beej.us/guide/bgnet/) — practical sockets, incl. raw sockets context.
- Cloudflare / Arista engineering blogs on **low-latency switching** ([search Arista cut-through latency](https://www.youtube.com/results?search_query=arista+cut+through+switch+latency)).

## Videos

- *Computerphile* — search **"Ethernet / MAC addresses / how packets travel"** ([search](https://www.youtube.com/results?search_query=computerphile+ethernet+mac+address)).
- *Ben Eater* — **"What is a MAC address? / Ethernet basics"** ([search](https://www.youtube.com/results?search_query=ben+eater+ethernet+mac+address)).
- Conference talks on **kernel bypass / low-latency networking** ([search](https://www.youtube.com/results?search_query=kernel+bypass+low+latency+networking+talk)).
