# Kernel Bypass Techniques: DPDK

> **Why a quant dev must own this:** When a microsecond is the difference
> between a fill and a miss, the kernel network stack — its syscalls, its
> copies, its interrupts, its protocol code you never asked for — is pure
> overhead. Kernel bypass is how the lowest-latency shops talk to the wire: map
> the NIC's rings straight into userspace, poll them on a dedicated core, and
> run your own minimal protocol handling. DPDK is the canonical open framework
> for doing this, and "walk me through how DPDK gets a packet to your code
> without the kernel" is a flagship HFT systems-interview question.

## First principles: why bypass the kernel at all?

The previous lessons attacked the standard socket path piece by piece —
batching syscalls, removing copies, busy-polling, AF_XDP. Kernel bypass takes
the idea to its conclusion: **the kernel network stack is not on the data path
at all.** Userspace owns the NIC.

Recall everything the stock path costs for one small packet:

- a **syscall** transition into and out of the kernel (`recv`/`send`),
- a **copy** (`copy_to_user` / `copy_from_user`),
- an **interrupt** + softirq to notice the packet,
- the **protocol stack**: Ethernet/IP/UDP/TCP parsing, checksums, netfilter,
  socket lookup, queueing,
- **scheduler** involvement to wake your thread, with all its jitter.

Bypass deletes *all* of it. There is no syscall (you read NIC descriptor memory
directly), no copy (the NIC DMAs into buffers you own and read in place), no
interrupt (you poll), no kernel protocol stack (you bring your own), and no
scheduler hop (a pinned thread spins forever). What's left is close to the
hardware floor: NIC-to-application in **sub-microsecond** territory, versus the
**~5–15 µs** a kernel UDP round trip typically costs.

The price is steep and worth stating up front: **you now own everything the
kernel used to do.** ARP, IP reassembly, UDP/TCP, congestion control, retransmit
— if you need it, you write it or you license a userspace stack. And you sacrifice
a whole CPU core (often more) to the poll loop. Bypass is a trade of *engineering
effort and CPU* for *latency and determinism*.

## What DPDK actually is

DPDK (Data Plane Development Kit) is a set of userspace libraries and poll-mode
NIC drivers for building fast packet-processing applications. Its core ideas:

1. **Take the NIC away from the kernel** and map its registers and DMA rings
   into a userspace process.
2. **Poll Mode Drivers (PMDs)** that spin reading the RX ring — no interrupts.
3. **Hugepages** backing a **mempool** of packet buffers (**mbufs**), so DMA
   addresses are stable and TLB pressure is minimal.
4. **Run-to-completion on pinned lcores** managed by the **EAL** (Environment
   Abstraction Layer), with NUMA-aware allocation.
5. Lock-free **`rte_ring`** queues to pass work between cores.

Crucially, DPDK gives you the *plumbing to the wire*, not a TCP/IP stack. You
get raw Ethernet frames in and out; protocol handling is your problem.

## Mechanics, layer by layer

### Taking the NIC: UIO and VFIO

A kernel NIC driver normally owns the device. To hand it to userspace, you bind
the NIC to a generic passthrough driver — historically **UIO** (`igb_uio`,
`uio_pci_generic`), today preferably **VFIO** (`vfio-pci`).

```bash
# Bind a NIC (by PCI address) away from the kernel driver to VFIO.
dpdk-devbind.py --status
dpdk-devbind.py -b vfio-pci 0000:03:00.0
```

VFIO is the modern choice because it programs the **IOMMU**: DMA from the device
is constrained to memory the process is allowed to touch, so a buggy or hostile
userspace app (or a malicious NIC) can't DMA over arbitrary kernel memory. UIO
has no such protection — the NIC can DMA anywhere — which is why VFIO is
strongly preferred in production.

What gets mapped into the process:

- the NIC's **MMIO register space** (BARs), so the app can program queues and
  ring the **doorbell** (write the tail pointer to tell the NIC where buffers
  are),
- the **DMA descriptor rings** (RX and TX), which are just arrays in DRAM that
  the NIC and the app both read/write.

After binding, the kernel sees no network interface for that port. It's yours.

### Hugepages and the mempool of mbufs

DMA needs **physically contiguous, pinned** memory with addresses that don't
move. DPDK allocates from **hugepages** (2 MiB or 1 GiB) for three reasons:
fewer TLB entries cover the buffer pool (fewer TLB misses on the hot path),
large physically-contiguous regions are easy to get, and the pages are pinned so
DMA addresses stay valid.

```bash
# Reserve hugepages (e.g. 1024 × 2MiB = 2GiB), then mount hugetlbfs.
echo 1024 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
mkdir -p /mnt/huge && mount -t hugetlbfs nodev /mnt/huge
```

On top of hugepages, DPDK builds an **`rte_mempool`** — a fixed-size pool of
objects with a fast, per-core cache for lock-free allocation. The objects are
**`rte_mbuf`s**: the DPDK packet buffer, analogous to the kernel's `sk_buff`
but far leaner. An mbuf carries:

- a **headroom** + the packet data region (the NIC DMAs the frame here),
- metadata: data length, packet length, port, RSS hash, offload flags,
- chaining pointers so a large packet can span multiple mbufs (segments).

```text
       rte_mbuf (one cache-friendly buffer from the mempool)
  ┌──────────────────────────────────────────────────────────┐
  │ struct rte_mbuf | headroom | <-- packet data -->| tailroom │
  └──────────────────────────────────────────────────────────┘
                     ^ data_off          ^ data_len
  buf_addr ---------/
  Mempool: thousands of these, per-lcore cache for lock-free get/put.
```

Allocation is just popping an mbuf off the per-core cache; freeing is pushing it
back. No syscalls, no `malloc`, no locks on the fast path.

### The EAL, lcores, and run-to-completion

The **Environment Abstraction Layer (EAL)** is DPDK's init and runtime
substrate. At startup it parses arguments (`-l` core list, `-n` memory channels,
`--socket-mem` per-NUMA-node memory), probes PCI devices, sets up hugepage
memory, and creates an **lcore** (logical core) abstraction — a thread pinned to
a specific CPU.

```bash
# Run on cores 1,2,3 (leave core 0 for the OS); 4 memory channels.
./my_app -l 1-3 -n 4 --socket-mem 1024,0 -- <app-args>
```

The dominant design is **run-to-completion**: each lcore owns one or more
RX/TX queues, and in a tight loop it receives a burst, processes it, and
transmits — all on the same core, no handoff. Alternatively, a **pipeline**
model passes mbufs between cores via `rte_ring`s. Run-to-completion has the
lowest latency (no inter-core handoff, cache stays warm); pipelines scale
specific stages.

### NUMA awareness

On a multi-socket box, accessing memory across the QPI/UPI link costs extra
latency and bandwidth. DPDK is NUMA-aware end to end: mempools, rings, and the
lcore polling a given NIC port should all live on the **same NUMA node as the
PCIe slot the NIC is plugged into**. `rte_socket_id()` and `--socket-mem` let
you place memory per node; getting this wrong silently adds cross-node latency
to every packet (see the NUMA lesson).

## The packet path: stack vs DPDK

```text
  STANDARD KERNEL PATH (RX)                 DPDK KERNEL-BYPASS PATH (RX)
  ┌──────────────────────────┐            ┌──────────────────────────┐
  │ wire → NIC               │            │ wire → NIC               │
  │   │ DMA into kernel ring  │            │   │ DMA into mbuf (UMEM- │
  │   ▼                       │            │   │   like, in hugepage) │
  │ IRQ → ISR → softirq/NAPI  │            │   ▼  NO interrupt        │
  │   ▼                       │            │ PMD polls RX ring on a   │
  │ skb alloc                 │            │ pinned lcore (spin)      │
  │   ▼                       │            │   ▼                       │
  │ Eth/IP/UDP stack,         │            │ rte_eth_rx_burst() returns│
  │ checksums, netfilter      │            │ mbuf pointers (NO copy,   │
  │   ▼                       │            │  NO syscall)              │
  │ socket queue              │            │   ▼                       │
  │   ▼  recv() syscall+COPY  │            │ YOUR code parses the      │
  │   ▼  scheduler wakeup     │            │ frame in place; YOU own   │
  │ YOUR code                 │            │ ARP/IP/UDP                │
  └──────────────────────────┘            └──────────────────────────┘
   syscall + copy + IRQ + stack + sched     poll + (no syscall/copy/IRQ/stack)
   ~5–15 µs round trip (approx)             sub-µs NIC→app (approx)
```

## A realistic DPDK RX/TX loop

The heart of a DPDK app is a poll loop that does nothing but ask the NIC "any
packets?" as fast as it can. `rte_eth_rx_burst` is non-blocking: it returns
however many packets are ready (often zero), as an array of mbuf pointers.

```c
#include <rte_eal.h>
#include <rte_ethdev.h>
#include <rte_mbuf.h>

#define RX_BURST 32
#define PORT_ID  0

// This function runs forever on one pinned lcore. No syscalls on the hot path.
static int lcore_main(void* arg) {
    struct rte_mbuf* bufs[RX_BURST];

    for (;;) {
        // Poll the RX ring: returns 0..RX_BURST mbufs, never blocks.
        const uint16_t nb_rx =
            rte_eth_rx_burst(PORT_ID, /*queue*/0, bufs, RX_BURST);

        if (unlikely(nb_rx == 0))
            continue;                 // empty most iterations; spin again

        for (uint16_t i = 0; i < nb_rx; ++i) {
            struct rte_mbuf* m = bufs[i];

            // The frame is already in our hugepage memory. No copy needed.
            // We own protocol handling from Ethernet up:
            struct rte_ether_hdr* eth =
                rte_pktmbuf_mtod(m, struct rte_ether_hdr*);

            if (eth->ether_type == rte_cpu_to_be_16(RTE_ETHER_TYPE_IPV4)) {
                struct rte_ipv4_hdr* ip = (struct rte_ipv4_hdr*)(eth + 1);
                // ... our own UDP demux, our own ARP table, etc.
                process_market_data(ip);
            }

            rte_pktmbuf_free(m);      // return the mbuf to its mempool
        }
    }
    return 0;
}

int main(int argc, char** argv) {
    int ret = rte_eal_init(argc, argv);          // hugepages, PCI probe, lcores
    if (ret < 0) rte_panic("EAL init failed\n");

    // Create a NUMA-local mempool of mbufs for RX.
    struct rte_mempool* mp = rte_pktmbuf_pool_create(
        "MBUF_POOL", /*n*/8191, /*cache*/256, /*priv*/0,
        RTE_MBUF_DEFAULT_BUF_SIZE, rte_socket_id());

    // Configure the port: 1 RX queue, 1 TX queue, then start it.
    struct rte_eth_conf cfg = {0};
    rte_eth_dev_configure(PORT_ID, 1, 1, &cfg);
    rte_eth_rx_queue_setup(PORT_ID, 0, 1024, rte_socket_id(), NULL, mp);
    rte_eth_tx_queue_setup(PORT_ID, 0, 1024, rte_socket_id(), NULL);
    rte_eth_dev_start(PORT_ID);

    // Launch the poll loop on a dedicated lcore and burn that core forever.
    rte_eal_remote_launch(lcore_main, NULL, /*lcore*/1);
    rte_eal_mp_wait_lcore();
    return 0;
}
```

Transmit mirrors RX: allocate mbufs from the pool, fill in the frame, and call
`rte_eth_tx_burst`, which posts them to the TX ring and rings the doorbell. Note
the **batching everywhere** (`_burst` APIs) — DPDK amortizes the per-packet PCIe
and descriptor cost over a burst of mbufs, which is essential for line-rate.

What's conspicuously *missing*: no `recv`, no `socket`, no `malloc` in the loop,
no lock, no kernel. The only "API" to the NIC is reading and writing descriptor
memory and ringing a doorbell.

## You own the stack now

Because DPDK delivers raw Ethernet frames, anything above L2 is yours:

- **ARP** — you must answer and issue ARP requests to resolve MACs.
- **IP** — fragmentation/reassembly, TTL, checksums (often NIC-offloaded).
- **UDP** — trivial; this is why UDP multicast market data is the common DPDK
  use case.
- **TCP** — *hard*. Full TCP (retransmit, congestion control, reassembly) is a
  major undertaking, so shops use a userspace TCP stack (e.g. **F-Stack**,
  **mTCP**, **VPP**, or a commercial stack) on top of DPDK for order entry.

For a market-data feed handler — UDP multicast in, parse, update book — DPDK is a
natural fit because the protocol burden is small. For session-oriented order
entry over TCP, the stack burden is why many firms reach for an alternative that
keeps a TCP stack (see below).

## DPDK vs the alternatives

DPDK is the heavyweight. There's a spectrum of bypass-ish options, and the
senior move is knowing the trade-offs:

| Approach | What it does | Kernel on path? | App effort | Latency tier |
|----------|--------------|:---------------:|-----------|--------------|
| **DPDK** | full bypass; raw mbuf rings, PMDs, you own the stack | none | high (own ARP/IP/(TCP)) | sub-µs |
| **AF_XDP** | XDP redirect into a userspace UMEM socket; keeps kernel driver | bypassed via XDP | medium; still a socket | near-DPDK |
| **Solarflare Onload** | transparent socket acceleration via `LD_PRELOAD`; full userspace TCP/UDP | bypassed, but BSD-socket API | **low** (recompile-free) | sub-µs |
| **Solarflare ef_vi** | raw low-level NIC API (layer below Onload) | none | high, vendor-specific | lowest (software) |
| **Mellanox/NVIDIA VMA** | `LD_PRELOAD` socket offload over RDMA verbs | bypassed | low | sub-µs |
| **RDMA / RoCE / InfiniBand verbs** | NIC does transport in hardware; app posts work requests | none (HW transport) | medium; verbs model | very low |
| **FPGA NIC** | logic on the NIC does parse/match/trade | none (in hardware) | very high (HDL) | lowest (tick-to-trade) |

Key distinctions to articulate:

- **DPDK vs AF_XDP:** AF_XDP is lighter operationally — it keeps the kernel
  driver, lets you share the NIC with the normal stack, needs no exclusive
  device binding, and is in the mainline kernel. DPDK is faster and more
  flexible but takes the whole NIC and demands more code. AF_XDP is often
  described as "most of DPDK's win with far less operational pain."
- **DPDK vs Onload/ef_vi:** Onload is **transparent** — you `LD_PRELOAD` it and
  your existing BSD-sockets app gets userspace TCP/UDP with no code change,
  which is a huge practical advantage. `ef_vi` is the raw layer beneath it for
  when you want to hand-tune like DPDK. The trade is hardware lock-in
  (Solarflare/AMD NICs).
- **DPDK vs FPGA:** software bypass (DPDK/ef_vi) gets you sub-microsecond
  *to the application*; an **FPGA** can parse the feed, match a signal, and emit
  an order entirely in hardware — **tick-to-trade in tens to low hundreds of
  nanoseconds**, beating any software path. The cost is HDL development effort
  and inflexibility. The very lowest-latency strategies live in FPGAs; DPDK/ef_vi
  is where the fastest *software* lives.

## Performance & hardware reality

- **Order of magnitude, not a benchmark:** a kernel UDP round trip is roughly
  **~5–15 µs** through the stack; DPDK (or ef_vi) drives NIC-to-application
  toward **sub-microsecond**, with very low jitter because there's no interrupt,
  syscall, or scheduler on the path. Treat all numbers as approximate and
  hardware-dependent.
- **A whole core (at least) is gone per port.** The PMD spins at 100% forever;
  `top` shows the core pegged even with zero traffic. That's by design — it's
  the polling-vs-interrupts trade taken to the limit.
- **NUMA placement is load-bearing.** Mempool, rings, and lcore must be on the
  NIC's local node, or you pay cross-socket latency on every packet.
- **Cache and hugepages:** mbufs are laid out to be cache-friendly, hugepages
  cut TLB misses, and run-to-completion keeps the working set hot on one core.
  These micro-architectural wins are a real part of why bypass is fast, not just
  the absence of the kernel.
- **NIC offloads still help:** checksum, TSO/LRO, and RSS (to spread flows
  across queues/lcores) are used even in bypass — you program them via the PMD.
- **Operational cost is real:** dedicated NICs, hugepage reservation, IOMMU/VFIO
  setup, core isolation (`isolcpus`, `nohz_full`), disabled C-states, and a
  bespoke protocol stack. Bypass is a systems-engineering commitment, not a
  flag you flip.

## Quant/HFT relevance & interview gotchas

- **Be able to narrate the path end to end:** VFIO binds the NIC away from the
  kernel → registers + DMA rings mapped into the process → NIC DMAs frames into
  hugepage-backed mbufs → PMD on a pinned lcore polls the RX ring → your code
  parses in place → you own ARP/IP/UDP. That walk-through *is* the interview.
- **"What does DPDK delete vs the kernel?"** Syscall, copy, interrupt, protocol
  stack, scheduler hop — and crucially, jitter. Lead with the four removals.
- **"What does DPDK *not* give you?"** A protocol stack. You implement ARP/IP/UDP
  yourself, and TCP is hard enough that you'd use a userspace stack. This catches
  people who think DPDK is "fast sockets."
- **UIO vs VFIO:** VFIO uses the IOMMU for DMA safety; UIO doesn't. Knowing this
  signals real operational experience.
- **Why hugepages?** Stable pinned DMA addresses + fewer TLB misses. Why
  NUMA-local? Cross-socket access adds latency to every packet.
- **DPDK vs AF_XDP vs ef_vi vs FPGA** is the canonical "place these on the
  latency/effort spectrum" question. The crisp answer: AF_XDP is light bypass in
  the kernel ecosystem; DPDK is full software bypass you operate yourself; Onload/
  ef_vi is vendor bypass (Onload transparent, ef_vi raw); FPGA is hardware
  tick-to-trade and the true floor.
- **The core is sacrificed on purpose.** If you describe DPDK as "efficient,"
  you've misunderstood it — it spends a core to buy determinism.

## Key takeaways

1. Kernel bypass removes the entire kernel network stack from the data path:
   **no syscall, no copy, no interrupt, no protocol stack, no scheduler hop** —
   trading CPU and engineering effort for sub-microsecond, low-jitter latency.
2. **DPDK** binds the NIC to userspace via **UIO/VFIO** (VFIO uses the IOMMU for
   DMA safety), maps the registers and DMA rings into the process, and drives
   them with **Poll Mode Drivers** that spin instead of taking interrupts.
3. Packets live in **mbufs** from a **mempool** backed by **hugepages**
   (stable DMA addresses, fewer TLB misses); the **EAL** pins **lcores** and the
   design is **run-to-completion**, all **NUMA-aware**.
4. DPDK gives you raw Ethernet frames, not a stack — **you implement ARP/IP/UDP**
   (and use a userspace TCP stack for TCP). UDP multicast market data is the
   natural fit; the hot loop is just `rte_eth_rx_burst` in a `for(;;)`.
5. Know the spectrum: **AF_XDP** (light, in-kernel-ecosystem bypass), **DPDK**
   (full software bypass you operate), **Onload/ef_vi** (vendor; transparent vs
   raw), **RDMA verbs**, and **FPGA** (hardware tick-to-trade, the true floor).

## Self-check

1. Walk a received packet from the wire to your application code under DPDK,
   naming each kernel cost that is *absent* compared to a `recv()` socket.
2. What is the difference between UIO and VFIO, and why is VFIO preferred in
   production?
3. Why must DPDK use hugepages? Give two distinct reasons.
4. DPDK delivers raw Ethernet frames. List the protocol responsibilities that
   now fall on your application, and explain why TCP in particular is a problem.
5. Place DPDK, AF_XDP, Solarflare Onload/ef_vi, and an FPGA NIC on a
   latency-vs-effort spectrum, and say what distinguishes each.
6. Why does a DPDK app peg a CPU core at 100% even with no traffic, and why is
   that considered correct rather than wasteful in HFT?
7. Your DPDK feed handler shows higher-than-expected latency on a dual-socket
   box. Name the most likely placement bug and the fix.

## Further reading

- [DPDK Programmer's Guide](https://doc.dpdk.org/guides/prog_guide/index.html) — EAL, mempool/mbuf, rings, the whole model.
- [DPDK Poll Mode Driver guide](https://doc.dpdk.org/guides/prog_guide/poll_mode_drv.html) and [Mbuf Library](https://doc.dpdk.org/guides/prog_guide/mbuf_lib.html).
- [DPDK Getting Started / Linux GSG](https://doc.dpdk.org/guides/linux_gsg/index.html) — hugepages, VFIO binding, EAL args.
- [AF_XDP — Linux Kernel documentation](https://docs.kernel.org/networking/af_xdp.html) — the lighter in-kernel bypass to compare against.
- LWN: [*Accelerating networking with AF_XDP*](https://lwn.net/Articles/750845/) and the [XDP project page](https://docs.kernel.org/networking/af_xdp.html) for context.
- Cloudflare blog: [*Kernel bypass*](https://blog.cloudflare.com/kernel-bypass/) — a clear survey of the bypass landscape.
- [RDMA verbs / `libibverbs` overview (man pages)](https://man7.org/linux/man-pages/man7/rdma_cm.7.html) and [Wikipedia: Remote direct memory access](https://en.wikipedia.org/wiki/Remote_direct_memory_access).
- [VFIO — Linux Kernel documentation](https://docs.kernel.org/driver-api/vfio.html) — IOMMU-protected userspace device access.

## Videos

- CppCon — **"When a Microsecond Is an Eternity" (Carl Cook)** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — the canonical HFT-latency talk; bypass is the backdrop.
- Search: **"DPDK overview poll mode driver mbuf"** ([search](https://www.youtube.com/results?search_query=DPDK+overview+poll+mode+driver+mbuf)) — DPDK Summit intro talks on the architecture.
- Search: **"FPGA tick to trade HFT low latency"** ([search](https://www.youtube.com/results?search_query=FPGA+tick+to+trade+HFT+low+latency)) — where hardware beats software bypass.
