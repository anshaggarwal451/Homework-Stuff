# Zero-Copy Networking

> **Why a quant dev must own this:** On a market-data path, the data itself is
> tiny — a single ITCH message is tens of bytes. The latency is *all overhead*:
> the syscall to read it, the `memcpy` from kernel into your buffer, the
> interrupt that woke you, the protocol code you didn't write. Zero-copy
> networking is the discipline of *deleting copies and syscalls from the hot
> path* — first inside the kernel-socket world, then beyond it. Knowing exactly
> which copies exist, and which technique removes which one, is a staple HFT
> interview drill.

## First principles: where do the copies come from?

Picture a UDP datagram arriving at a NIC and your handler waking up to read it.
On a stock Linux socket, the bytes get touched a *lot* before your code sees
them:

1. The NIC's DMA engine writes the frame into a kernel **RX ring buffer** in
   DRAM that the driver pre-allocated. (This step is already DMA — the CPU
   doesn't copy here.)
2. The NIC raises an **interrupt**; the driver's ISR runs, then schedules a
   softirq (NAPI) to process the ring.
3. The kernel wraps the frame in an **`sk_buff` (skb)** and runs it up the
   stack: Ethernet → IP → UDP, checksums, netfilter, socket demux.
4. The payload lands in the socket's receive queue.
5. Your `recv()` syscall **copies** the payload from the kernel socket buffer
   into your user-space buffer (`copy_to_user`), then returns.

So the "copies" people mean are really two kinds of cost:

- **The data copy** — `copy_to_user` on RX (and `copy_from_user` on TX). One
  `memcpy` per packet, cache-polluting, scaling with payload size.
- **The per-packet *fixed* overhead** — the syscall transition, the interrupt,
  the skb allocation, and the protocol processing. For small packets this
  *dominates*; the copy itself is almost the cheap part.

> **The senior framing:** "Zero-copy" is necessary but not sufficient. You can
> eliminate the `memcpy` and still pay a syscall and an interrupt per packet.
> The techniques below attack different costs; know which is which.

### Zero-copy ≠ kernel-bypass

Two terms get conflated. Keep them apart:

- **Zero-copy** means *no CPU `memcpy`* between the NIC's DMA buffer and the
  buffer your code reads. The kernel may still be involved.
- **Kernel-bypass** means *the kernel network stack is not on the data path at
  all* — userspace talks to the NIC's rings directly (DPDK, ef_vi). Bypass
  implies zero-copy, but you can be zero-copy *without* full bypass.

This lesson walks the spectrum from "plain sockets" toward "almost bypass,"
stopping just short of DPDK (its own lesson). The unifying trick is the same
one behind zero-copy IPC and `mmap`: **share a memory region between producer
and consumer instead of copying between them.**

## The standard path, drawn out

```text
        RX (receive)                              TX (transmit)
  ┌───────────────────────┐               ┌───────────────────────┐
  │  wire → NIC            │               │  app builds payload   │
  │      │ DMA             │               │      │ write()        │
  │      ▼                 │               │      ▼  copy_from_user │ ← COPY 1
  │  kernel RX ring        │               │  kernel socket buf    │
  │      │ IRQ + NAPI      │               │      │ IP/UDP build   │
  │      ▼                 │               │      ▼                 │
  │  skb → IP/UDP stack    │               │  skb → driver TX ring  │
  │      ▼                 │               │      │ DMA            │
  │  socket recv queue     │               │      ▼                 │
  │      │ recv()          │               │  NIC → wire           │
  │      ▼  copy_to_user   │ ← COPY 1      │                       │
  │  YOUR buffer           │               │                       │
  └───────────────────────┘               └───────────────────────┘
   per packet: 1 syscall + 1 copy + share of 1 IRQ + full protocol processing
```

Approximate budget for one small UDP datagram through this path: the data copy
is tens of nanoseconds, but the *round trip* (app → kernel → wire → kernel →
app) on the stock stack is on the order of **~5–15 µs**, dominated by syscalls,
interrupt/softirq scheduling, and protocol code — not the `memcpy`.

## Technique 1 — batch the syscalls: `recvmmsg`/`sendmmsg`

Before removing copies, amortize the *syscall*. `recvmmsg(2)` receives multiple
datagrams in one call; `sendmmsg(2)` sends multiple. The copies still happen,
but you pay one kernel transition for N packets.

```c
#include <sys/socket.h>
#include <netinet/in.h>

#define BATCH 32
struct mmsghdr msgs[BATCH];
struct iovec   iov[BATCH];
char           bufs[BATCH][2048];

for (int i = 0; i < BATCH; ++i) {
    iov[i].iov_base = bufs[i];
    iov[i].iov_len  = sizeof bufs[i];
    msgs[i].msg_hdr.msg_iov    = &iov[i];
    msgs[i].msg_hdr.msg_iovlen = 1;
}

// One syscall harvests up to BATCH datagrams already sitting in the socket queue.
int n = recvmmsg(fd, msgs, BATCH, MSG_DONTWAIT, NULL);
for (int i = 0; i < n; ++i)
    handle(bufs[i], msgs[i].msg_len);
```

This is the cheapest win and it composes with everything below. The catch:
batching trades **throughput for latency** — you only get a batch when packets
have queued up, so the *first* packet of a burst still waits. In HFT you often
prefer to read one at a time on a hot core and never let a queue form.

## Technique 2 — zero-copy RX capture: `PACKET_MMAP` / `TPACKET_V3`

`AF_PACKET` with `PACKET_MMAP` gives you a ring buffer **`mmap`'d into both the
kernel and your process**. The kernel fills frames into the shared ring; you
read them in place. No `copy_to_user` on capture.

```c
#include <linux/if_packet.h>
#include <sys/mman.h>

int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));

int ver = TPACKET_V3;
setsockopt(fd, SOL_PACKET, PACKET_VERSION, &ver, sizeof ver);

struct tpacket_req3 req = {0};
req.tp_block_size = 1 << 22;     // 4 MiB blocks
req.tp_block_nr   = 64;
req.tp_frame_size = 2048;
req.tp_frame_nr   = (req.tp_block_size / req.tp_frame_size) * req.tp_block_nr;
setsockopt(fd, SOL_PACKET, PACKET_RX_RING, &req, sizeof req);

// Map the kernel-filled ring directly into our address space.
size_t ring_bytes = (size_t)req.tp_block_size * req.tp_block_nr;
uint8_t* ring = mmap(NULL, ring_bytes, PROT_READ | PROT_WRITE,
                     MAP_SHARED | MAP_LOCKED, fd, 0);

// Walk blocks/frames in place — the payload is never copied to a private buffer.
```

This is what `tcpdump`/libpcap use under the hood for high-rate capture. It
kills the RX data copy, but the frame still traversed the kernel's packet
handling, and you're capturing *raw* frames (you do the parsing). It's the
classic "zero-copy *within* sockets" answer.

## Technique 3 — zero-copy TX: `MSG_ZEROCOPY`

On transmit, `MSG_ZEROCOPY` (a `send`/`sendmsg` flag) tells the kernel to **pin
your user pages and DMA from them directly**, skipping `copy_from_user`. Because
the kernel no longer owns a private copy, it can't tell you the send is "done"
just because `send()` returned — your buffer is still in flight. Completion is
reported asynchronously via the socket error queue (`MSG_ERRQUEUE`).

```c
int one = 1;
setsockopt(fd, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof one);

ssize_t r = send(fd, buf, len, MSG_ZEROCOPY);
// buf must stay valid & unmodified until completion arrives:
//   recvmsg(fd, &msg, MSG_ERRQUEUE)  ->  sock_extended_err with ee_origin
//   == SO_EE_ORIGIN_ZEROCOPY, and a [lo,hi] range of completed send ids.
```

The win only materializes for **large** buffers (kernel docs note a rough break-
even around tens of KiB), because pinning pages and the completion bookkeeping
have their own cost. For HFT's tiny order messages, `MSG_ZEROCOPY` usually
*loses* — the copy of 50 bytes is cheaper than page pinning. Know it exists, and
know it's a bulk-throughput tool, not a small-message latency tool.

## Technique 4 — don't sleep: `SO_BUSY_POLL`

A different overhead: the *wakeup*. Normally `recv()` blocks, the packet
arrives, an interrupt fires, the scheduler wakes your thread — microseconds of
latency and jitter. `SO_BUSY_POLL` makes the socket **spin in the driver's poll
routine** for a configured number of microseconds before sleeping, so a packet
that arrives during the spin is delivered without an interrupt or context
switch.

```c
unsigned int usec = 50;   // busy-poll up to 50 µs in the kernel before blocking
setsockopt(fd, SOL_SOCKET, SO_BUSY_POLL, &usec, sizeof usec);
// Also: /proc/sys/net/core/busy_read as a system-wide default.
```

This trades a burned core for lower, more deterministic latency — the same
bargain as full polling (see the *Polling vs Interrupts* lesson). It removes a
*wakeup*, not a *copy*; it composes with the copy-removal techniques.

## Technique 5 — the modern in-kernel zero-copy path: AF_XDP

AF_XDP is the current sweet spot between "plain sockets" and "full bypass." You
attach a small **XDP/eBPF program** to the NIC driver's RX hook (the earliest
point in the stack, before any skb is allocated) and have it `XDP_REDIRECT`
selected frames into an **`AF_XDP` socket (XSK)**.

The data lives in a **UMEM** — a chunk of user memory `mmap`'d and registered
with the kernel, carved into fixed frames. Four single-producer/single-consumer
rings coordinate ownership without copies:

| Ring | Direction | Meaning |
|------|-----------|---------|
| **FILL** | app → kernel | "these UMEM frames are free; put RX packets here" |
| **RX**   | kernel → app | "a packet arrived in this UMEM frame" |
| **TX**   | app → kernel | "send the packet in this UMEM frame" |
| **COMPLETION** | kernel → app | "this TX frame is sent; reuse it" |

In **zero-copy mode** (driver support required) the NIC DMAs straight into UMEM
frames and your app reads them in place — NIC-to-app with no `memcpy` and no
skb. In **copy mode** (any driver) it still works, with one copy, as a fallback.

```c
// Conceptual AF_XDP RX harvest (real apps use libxdp/libbpf helpers).
// Rings are shared memory; "consuming" is just advancing an index.
u32 idx_rx = 0;
unsigned rcvd = xsk_ring_cons__peek(&xsk->rx, BATCH, &idx_rx);
if (rcvd) {
    for (unsigned i = 0; i < rcvd; ++i) {
        const struct xdp_desc* d = xsk_ring_cons__rx_desc(&xsk->rx, idx_rx++);
        uint8_t* pkt = xsk_umem__get_data(umem_area, d->addr);  // in UMEM, no copy
        handle(pkt, d->len);
        // Hand the frame back to the kernel via the FILL ring for reuse.
    }
    xsk_ring_cons__release(&xsk->rx, rcvd);
}
```

AF_XDP gives you DMA-to-userspace zero-copy *while staying inside the kernel
ecosystem* — you keep the NIC driver, you can let unselected traffic pass up the
normal stack, and you don't need hugepages or exclusive NIC ownership. It is the
"90% of DPDK's win, 10% of the operational pain" option, and it's where a lot of
new low-latency tooling is converging.

## Technique 6 — `io_uring` with registered buffers

`io_uring` is a general async-I/O interface built on **two shared-memory rings**
(submission + completion) between app and kernel — itself a syscall-amortizing,
shared-ring design. With **registered buffers** (`IORING_OP_*` + pre-pinned
buffer pools) and zero-copy send (`IORING_OP_SEND_ZC`), it pushes networking
toward zero-copy without raw-NIC access. It shines for high-concurrency servers
that want batched, low-syscall I/O; it is less common on the single-flow,
sub-microsecond HFT hot path than AF_XDP or full bypass, but it's the modern
answer for everything *else* in the system.

## Putting the spectrum on one ruler

| Technique | Removes data copy? | Removes syscall/IRQ? | Kernel stack on path? | Typical use |
|-----------|:------------------:|:--------------------:|:---------------------:|-------------|
| Plain `recv`/`send` | no | no | full | baseline |
| `recvmmsg`/`sendmmsg` | no | amortizes syscall | full | bulk datagrams |
| `PACKET_MMAP` (RX) | **yes** (RX capture) | still 1 IRQ/poll | packet layer | high-rate capture |
| `MSG_ZEROCOPY` (TX) | **yes** (large sends) | no | full | bulk TX throughput |
| `SO_BUSY_POLL` | no | removes wakeup IRQ | full | low-latency sockets |
| **AF_XDP** (ZC mode) | **yes** (NIC↔UMEM) | poll, no IRQ | bypassed via XDP | modern low-latency |
| `io_uring` reg. bufs | yes (ZC ops) | amortizes both | full | async servers |
| Full bypass (DPDK/ef_vi) | yes | yes | **none** | lowest latency |

## Performance & hardware reality

- The naive `memcpy` of a 64-byte payload is ~tens of nanoseconds; the syscall
  + interrupt + protocol path around it is **microseconds**. So for small
  market-data messages, *removing the copy alone barely moves the needle* — you
  must also remove the syscall and the interrupt. This is the single most
  common misconception "zero-copy" creates.
- Zero-copy *does* matter for **large** transfers (file/storage, bulk TX),
  where copy time scales with size and competes for memory bandwidth and
  pollutes the cache. `sendfile`/`MSG_ZEROCOPY`/splice are throughput tools.
- Every avoided copy is also avoided **cache pollution**: a `copy_to_user`
  drags a fresh copy of the payload through L1/L2, evicting your hot working
  set. On a latency-critical core, that eviction can cost more than the copy
  cycles themselves (see the cache lessons).
- AF_XDP zero-copy approaches DPDK's per-packet cost (tens of nanoseconds of
  framework overhead) while still being a `socket()`; it needs driver ZC
  support and a CPU willing to poll.

## Quant/HFT relevance & interview gotchas

- **Name the copies.** A strong answer enumerates them: NIC DMA into the kernel
  ring (not a CPU copy), `copy_to_user` on RX, `copy_from_user` on TX — then
  maps each technique to the copy it removes.
- **Don't conflate zero-copy with kernel-bypass.** Interviewers probe this. You
  can be zero-copy (`PACKET_MMAP`) and still pay an interrupt and protocol
  processing; bypass (DPDK) removes the kernel entirely.
- **For tiny messages, the syscall and IRQ dominate, not the copy.** Saying
  "we went zero-copy to save the `memcpy`" on 50-byte orders signals you
  haven't profiled. The real wins are *no syscall* and *no interrupt*.
- **`MSG_ZEROCOPY` is a throughput tool with async completion semantics** — your
  buffer is live until the error-queue notification. Mishandling that is a
  classic data-corruption bug.
- **AF_XDP is the trendy correct answer** for "modern Linux zero-copy without
  going full DPDK," and shows you track current kernel networking.
- **Shared-ring is the recurring pattern.** `PACKET_MMAP`, AF_XDP's UMEM rings,
  `io_uring`, and DPDK's rings are all the same idea as zero-copy IPC: replace
  a copy across a boundary with a memory region shared across it.

## Key takeaways

1. The stock socket path has *two* CPU copies (`copy_to_user`/`copy_from_user`)
   plus per-packet syscall, interrupt, and protocol overhead — for small
   packets the overhead, not the copy, is the latency.
2. **Zero-copy** removes the `memcpy`; **kernel-bypass** removes the whole
   stack. Bypass implies zero-copy; the reverse is not true.
3. Within sockets: `recvmmsg`/`sendmmsg` amortize syscalls, `PACKET_MMAP`
   zero-copies RX capture, `MSG_ZEROCOPY` zero-copies large TX, `SO_BUSY_POLL`
   removes the wakeup.
4. **AF_XDP** is the modern in-kernel-adjacent zero-copy path: XDP redirects
   frames into a shared UMEM the NIC DMAs into directly — near-bypass speed,
   still a socket.
5. The unifying mechanism everywhere is a **shared memory ring** between
   producer and consumer — the same trick as zero-copy IPC and `mmap`.

## Self-check

1. Name every CPU copy on the stock RX and TX socket paths. Which step is DMA,
   not a CPU copy?
2. A colleague reports "we enabled `MSG_ZEROCOPY` and our 40-byte order send got
   slower." Explain why, and when `MSG_ZEROCOPY` actually helps.
3. What does `PACKET_MMAP` eliminate, and what does it *not* eliminate, relative
   to plain `recv`?
4. Describe AF_XDP's four rings and which direction each moves. Which one do you
   use to recycle a consumed RX frame?
5. Why is "zero-copy" by itself an insufficient claim for a sub-microsecond
   market-data handler? What two other costs must you also remove?
6. How does `recvmmsg` trade latency for throughput, and why might an HFT
   handler *not* want it?

## Further reading

- [AF_XDP — The Linux Kernel documentation](https://docs.kernel.org/networking/af_xdp.html) — UMEM, the four rings, zero-copy vs copy mode.
- [`PACKET_MMAP` / TPACKET — kernel networking docs](https://docs.kernel.org/networking/packet_mmap.html) and [`packet(7)`](https://man7.org/linux/man-pages/man7/packet.7.html).
- [`recvmmsg(2)`](https://man7.org/linux/man-pages/man2/recvmmsg.2.html) and [`sendmmsg(2)`](https://man7.org/linux/man-pages/man2/sendmmsg.2.html) — batched datagram syscalls.
- [`socket(7)`](https://man7.org/linux/man-pages/man7/socket.7.html) — `SO_ZEROCOPY`, `SO_BUSY_POLL`, `SO_TIMESTAMPING`.
- LWN: [*Zero-copy networking*](https://lwn.net/Articles/726917/) (`MSG_ZEROCOPY`) and [*Accelerating networking with AF_XDP*](https://lwn.net/Articles/750845/).
- LWN: [*The rapid growth of io_uring*](https://lwn.net/Articles/810414/) — shared submission/completion rings and zero-copy ops.
- Cloudflare blog: [*Kernel bypass*](https://blog.cloudflare.com/kernel-bypass/) — a practical survey of `PACKET_MMAP`, `AF_XDP`, and full bypass.

## Videos

- Search: **"AF_XDP zero-copy networking"** ([search](https://www.youtube.com/results?search_query=AF_XDP+zero+copy+networking)) — conference talks (Netdev/Kernel Recipes) walking the UMEM ring model.
- CppCon — **"When a Microsecond Is an Eternity" (Carl Cook)** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why every syscall and copy is the enemy on an HFT path.
- Search: **"io_uring zero-copy send"** ([search](https://www.youtube.com/results?search_query=io_uring+zero+copy+send)) — modern async I/O and registered buffers.
