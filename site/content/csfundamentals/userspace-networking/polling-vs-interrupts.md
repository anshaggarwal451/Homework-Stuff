# Polling vs Interrupts

> **Why a quant dev must own this:** The choice between waiting for the NIC to
> *tell* you a packet arrived (interrupt) and *asking* it constantly (polling)
> is the single biggest lever on tail latency and jitter in a market-data
> handler. Interrupts are efficient and let a CPU sleep; polling burns a whole
> core but deletes interrupt latency, context switches, and scheduler jitter.
> HFT shops almost universally choose to burn the core. Understanding *why* — and
> when interrupts still win — is a guaranteed interview topic.

## First principles: two ways to learn that data is ready

You have a device (a NIC) that produces events (packets) asynchronously. Your
code needs to know when there's work. There are exactly two models, and
everything else is a hybrid:

- **Interrupt-driven (event-driven):** the device signals the CPU when
  something happens. The CPU is free to do other work — or idle — until then.
  *Reactive.* You pay nothing while idle, but you pay a wakeup cost on every
  event.
- **Polling (busy-wait):** the CPU repeatedly reads a status location ("is
  there a packet?") in a tight loop. *Proactive.* You pay 100% CPU all the
  time, but when data arrives you see it almost instantly with no asynchronous
  machinery.

The trade is fundamentally **efficiency vs latency/determinism**. Interrupts
optimize for "use the CPU for something useful while waiting"; polling optimizes
for "see the event the instant it happens, every time."

## The interrupt path, mechanically

When a packet arrives on an interrupt-driven NIC:

```text
wire → NIC DMAs frame into RX ring
         │
         ▼  NIC asserts IRQ line (MSI-X message)
   CPU interrupted: flush pipeline, save context, vector to ISR
         │
         ▼  driver top-half (hard IRQ): ack device, schedule work
   softirq / NAPI poll scheduled on this CPU
         │
         ▼  bottom-half: drain RX ring, build skbs, run IP/UDP stack
   data placed on socket queue → wake the blocked thread
         │
         ▼  scheduler picks the thread, restores context, returns from recv()
   YOUR code runs
```

Every box is latency *and* a source of jitter:

- **IRQ delivery + context switch into the ISR:** the CPU must stop what it's
  doing, save state, and jump to the handler — on the order of ~1 µs, and
  variable depending on what it interrupted (it might be in a non-preemptible
  region, holding a lock, or in a deep C-state).
- **softirq/NAPI scheduling:** the bottom half may run on return from IRQ, or
  be deferred to `ksoftirqd`, adding queueing delay under load.
- **Waking your thread:** the scheduler has to *choose* to run you, possibly
  migrating you to another core (blowing your cache), possibly waiting behind
  another runnable task.

That last point is the killer for HFT: interrupt-driven delivery couples your
latency to the **scheduler**, the **C-state the core was in**, and **whatever
else the CPU was doing**. The mean might be fine; the *tail* is ugly.

### Interrupt overhead and coalescing

At high packet rates, one interrupt per packet is catastrophic — at, say, 1
million packets/sec you'd take a million interrupts/sec, and the CPU spends all
its time entering/leaving ISRs instead of doing work. NICs mitigate this with
**interrupt coalescing**: hold off the interrupt until N packets have arrived or
a timer expires (`ethtool -C`, `rx-usecs`/`rx-frames`).

```bash
# Inspect / set coalescing on an interrupt-driven NIC:
ethtool -c eth0                    # show current settings
ethtool -C eth0 rx-usecs 0 rx-frames 1   # minimize latency (more IRQs)
ethtool -C eth0 rx-usecs 100             # batch ~100µs worth (more throughput)
```

Coalescing is a direct **latency-vs-throughput knob**: more batching = fewer
interrupts (efficient, higher throughput) but each packet waits longer (worse
latency). For low latency you push coalescing toward zero — at which point
you're back to paying an interrupt per packet, which is exactly the cost polling
avoids entirely.

### The livelock / interrupt-storm problem

Naive pure-interrupt processing has a pathological failure mode under overload:
as packet rate climbs, the CPU spends *more* time in interrupt context (which
preempts everything), leaving *less* time to actually process packets in the
bottom half. Past a threshold, throughput collapses toward zero even as the
NIC keeps interrupting — **receive livelock**. The system is 100% busy taking
interrupts and getting no useful work done.

## NAPI: the hybrid Linux actually uses

Linux solved livelock with **NAPI** (New API): interrupt-driven at low rates,
poll-driven at high rates. The mechanism:

1. A packet arrives; the NIC interrupts.
2. The driver's ISR **disables further RX interrupts** for that queue and
   schedules a NAPI poll.
3. The kernel then **polls** the RX ring in softirq context, draining up to a
   `budget` of packets per poll.
4. When the ring drains (no more packets), NAPI **re-enables interrupts** and
   goes back to sleep.

So under a burst, you take *one* interrupt and then poll the rest of the burst
out cheaply — getting interrupt efficiency when idle and polling throughput when
busy. NAPI is the default for every modern NIC driver. It tames livelock and
slashes interrupt count, but it does *not* remove the initial interrupt latency
nor the softirq/scheduler hop to your thread — so for the lowest, most
deterministic latency you still go further.

## Pure polling: burn a core, delete the asynchrony

The lowest-latency model removes interrupts entirely. A dedicated thread, pinned
to a dedicated core, spins reading the RX ring (or the socket) forever. There is
no IRQ, no softirq, no context switch, no scheduler decision on the data path —
the instant a descriptor flips "ready," the very next loop iteration sees it.

This is exactly what **DPDK's Poll Mode Drivers (PMDs)** do at the raw-NIC level
(see the DPDK lesson) and what **`SO_BUSY_POLL`** does at the socket level.

```c
// Busy-poll a UDP socket on a dedicated, pinned core.
// SO_BUSY_POLL makes recv() spin in the driver poll routine instead of sleeping.
#include <sys/socket.h>
#include <sched.h>

void run_busy_poll(int fd) {
    unsigned int usec = 1000;  // spin up to this long in-kernel before blocking
    setsockopt(fd, SOL_SOCKET, SO_BUSY_POLL, &usec, sizeof usec);

    // Pin this thread to an isolated core (see isolcpus / cpuset).
    cpu_set_t set; CPU_ZERO(&set); CPU_SET(3, &set);
    sched_setaffinity(0, sizeof set, &set);

    struct mmsghdr msgs[16];
    struct iovec   iov[16];
    char           bufs[16][2048];
    for (int i = 0; i < 16; ++i) {
        iov[i] = (struct iovec){ bufs[i], sizeof bufs[i] };
        msgs[i].msg_hdr = (struct msghdr){ .msg_iov = &iov[i], .msg_iovlen = 1 };
    }

    for (;;) {                         // <-- the spin: never block, never sleep
        int n = recvmmsg(fd, msgs, 16, MSG_DONTWAIT, NULL);
        for (int i = 0; i < n; ++i)
            handle(bufs[i], msgs[i].msg_len);
        // No packets? Just loop again immediately. The core stays 100% hot.
    }
}
```

At the DPDK/raw level there isn't even a syscall — the loop reads NIC descriptor
memory directly:

```c
// Conceptual pure poll loop (DPDK-style): no kernel, no syscall, no interrupt.
struct rte_mbuf* bufs[BURST];
for (;;) {
    uint16_t n = rte_eth_rx_burst(port, queue, bufs, BURST);  // just reads the ring
    for (uint16_t i = 0; i < n; ++i)
        process(bufs[i]);
    // n == 0 most iterations; we spin anyway. The core is sacrificed to latency.
}
```

### Why polling wins on latency *and* determinism

The headline number — removing ~1 µs of interrupt+wakeup latency — matters, but
the **jitter** argument is the real reason HFT polls:

- **No interrupt latency:** you don't wait for the CPU to be interruptible.
- **No context switch:** you're already running; nothing has to wake you.
- **No scheduler decision:** the OS never has to *choose* to run your thread, so
  it can't choose to run something else first.
- **No C-state exit:** the core is always busy, so it never drops into a deep
  sleep state with a multi-microsecond wakeup penalty.
- **Cache stays warm:** the same thread on the same core keeps its working set
  (the parsing code, the order book) hot in L1/L2; an interrupt-driven wakeup
  may run you on a cold core.

The result is a latency distribution that is not just lower on average but
*tight* — the p99/p99.9 tail, which is what actually loses money, collapses.
Determinism > raw mean.

## The trade-off, on one table

| Dimension | Interrupts (+ NAPI) | Pure polling (busy-wait) |
|-----------|---------------------|--------------------------|
| Idle CPU cost | ~0 (core can sleep) | 100% of a core, always |
| Mean latency to app | µs-scale (IRQ + softirq + wakeup) | sub-µs (next loop iteration) |
| Jitter / tail latency | high (scheduler, C-states, coalescing) | very low / deterministic |
| Behavior under overload | livelock risk (NAPI mitigates) | graceful — just drains faster |
| Power / thermal | low; scales with traffic | high; constant, runs hot |
| Many idle connections | excellent (pay only when active) | terrible (one core per polled queue) |
| Context switches on data path | yes | none |
| Best for | servers, bursty/idle traffic, density | low-latency trading, dedicated cores |

## Performance & hardware reality

- An interrupt + softirq + thread wakeup adds roughly **~1–5 µs** of latency
  and meaningful jitter; pure polling drives the NIC-to-app delay toward the
  hardware floor with sub-microsecond, low-variance delivery.
- **Deep C-states are a hidden tail-latency landmine.** A core in C6 can take
  *several microseconds* to wake. HFT boxes disable C-states (or keep the core
  busy via polling, which prevents entry) and often disable frequency scaling
  to avoid the ramp-up delay on the first packet after idle.
- **Polling costs a real core.** A 100%-busy spin loop burns power, generates
  heat (which can trigger throttling on neighbors), and is one fewer core for
  everything else. For a handful of latency-critical flows that's a trivial
  price; for a 10k-connection web server it's absurd — which is the whole point
  of the dichotomy.
- **NAPI is the right default for general systems** precisely because most
  traffic is bursty and most connections are idle most of the time. Polling
  only pays off when a queue is *consistently* hot and latency is paramount.

## Quant/HFT relevance & interview gotchas

- **The HFT answer is "burn a core."** Dedicate an isolated core (`isolcpus`,
  `nohz_full`, `irqaffinity` to steer IRQs *away*), pin the polling thread,
  disable C-states, and spin on the NIC. Determinism beats efficiency when a
  microsecond of jitter is a missed fill.
- **Lead with jitter, not mean.** A junior answer says "polling is faster." A
  senior answer says "polling removes the *variance* — no IRQ wait, no scheduler
  hop, no C-state exit — so the p99.9 tail is tight, and the tail is what costs
  money."
- **Know NAPI as the hybrid.** "Pure interrupts livelock under load; pure
  polling wastes a core when idle; NAPI interrupts once then polls the burst" is
  the answer that shows you understand the real Linux design, not just the
  extremes.
- **Coalescing is the knob, and it's a trap for latency.** `rx-usecs` directly
  trades latency for throughput; cranking it up for "performance" silently adds
  microseconds per packet.
- **C-states and frequency scaling** are the gotchas interviewers love: even a
  perfect poll loop is sabotaged if the *neighboring* idle cores let the package
  drop frequency, or if your core was allowed to sleep.
- **DPDK PMDs and `SO_BUSY_POLL` are the concrete instances** — be ready to
  name them as "polling in practice."

## Key takeaways

1. Interrupts are reactive and efficient (CPU sleeps until an event); polling is
   proactive and burns a core but deletes asynchronous overhead.
2. The interrupt path adds IRQ delivery, softirq, scheduler wakeup, and possible
   C-state exit — each a source of latency *and* jitter coupled to the rest of
   the system.
3. Pure interrupts can **livelock** under high packet rates; **NAPI** is the
   hybrid that interrupts once then polls the burst, and is the modern default.
4. Polling wins on **latency and especially determinism** (no IRQ wait, no
   context switch, no scheduler decision, no C-state exit, warm cache) at the
   cost of a fully consumed core and power/heat.
5. HFT chooses polling: dedicate and isolate a core, pin the thread, disable
   C-states, steer IRQs away, and spin (DPDK PMD or `SO_BUSY_POLL`).

## Self-check

1. Walk a packet through the interrupt path and name every step that adds
   latency *or* jitter before your code runs.
2. What is receive livelock, and precisely how does NAPI prevent it?
3. Why does polling improve *tail* latency even more than mean latency? List
   three sources of variance it removes.
4. What does `ethtool -C eth0 rx-usecs 100` do, and which way does it move the
   latency/throughput trade-off?
5. Your perfectly pinned busy-poll loop still shows occasional microsecond
   spikes after quiet periods. Name two CPU power-management causes and the
   fixes.
6. When is an interrupt-driven NIC the *correct* choice over polling?

## Further reading

- [NAPI — kernel networking documentation](https://docs.kernel.org/networking/napi.html) — the interrupt-then-poll model in detail.
- [`socket(7)`](https://man7.org/linux/man-pages/man7/socket.7.html) — `SO_BUSY_POLL` and busy polling semantics.
- LWN: [*Reducing latency with busy polling*](https://lwn.net/Articles/551284/) — what `SO_BUSY_POLL`/`busy_read` actually do.
- [Linux network scaling / `scaling.rst`](https://docs.kernel.org/networking/scaling.html) — RSS, RPS, and IRQ steering across cores.
- [DPDK Poll Mode Driver guide](https://doc.dpdk.org/guides/prog_guide/poll_mode_drv.html) — polling at the raw-NIC level.
- Brendan Gregg: [*Linux Performance*](https://www.brendangregg.com/linuxperf.html) — tooling for interrupts, softirqs, and CPU C-state analysis.
- `ethtool(8)` — `-c`/`-C` interrupt coalescing options.

## Videos

- CppCon — **"When a Microsecond Is an Eternity" (Carl Cook)** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — busy-polling and core isolation for HFT.
- Search: **"NAPI interrupt coalescing Linux networking"** ([search](https://www.youtube.com/results?search_query=NAPI+interrupt+coalescing+linux+networking)) — Netdev/Kernel Recipes talks on the RX path.
- Search: **"CPU C-states low latency tuning"** ([search](https://www.youtube.com/results?search_query=CPU+C-states+low+latency+tuning)) — why idle states wreck tail latency.
