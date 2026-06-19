# Garbage Collection Techniques

> **Why a quant dev must own this:** Garbage collection is *the* reason much of
> HFT is written in C++ and not Java/Go/Python. A GC can pause your program at an
> arbitrary moment to reclaim memory — and a millisecond stop-the-world pause
> during a market event is a missed fill or a blown risk limit. Interviewers ask
> "why C++ and not a managed language?" expecting you to articulate the GC
> tail-latency problem, and to know the algorithms well enough to explain how the
> alternatives (off-heap, pauseless collectors, object pools) try to dodge it.

## First principles: what GC is and the problem it solves

**Garbage collection is automatic reclamation of heap memory that is no longer
reachable by the program.** Instead of you calling `free`/`delete`, a runtime
periodically determines which objects are still in use and reclaims the rest.

The goals are real: it eliminates whole bug classes — **use-after-free**,
**double-free**, and most **memory leaks**. Manual memory management is a
notorious source of security vulnerabilities. GC trades that safety for two
costs: **throughput overhead** (the collector does work) and, far more painful
for HFT, **latency / pauses** (the collector can interrupt your program at an
unpredictable time).

## Why C++ has no garbage collector: deterministic RAII

C++ chose a different answer: **deterministic destruction via RAII**. An object's
destructor runs at a *known, deterministic* point — when it goes out of scope or
its owning smart pointer is destroyed — and that destructor frees the resource.

```cpp
{
    auto order = std::make_unique<Order>(...);   // allocated
    process(*order);
}   // <-- destructor runs HERE, deterministically; memory freed NOW, no GC needed
```

The contrast is the whole point: with GC, that memory is freed *whenever the
collector next runs* — could be now, could be in 50 ms, could be during a
volatility spike. With RAII, it's freed *exactly here*, every time. **No pauses,
no background thread, no surprise.** This determinism is precisely why C++ is the
default for latency-critical systems.

| | RAII (C++) | Tracing GC (Java/Go/C#) |
|:--|:-----------|:------------------------|
| When freed | deterministic (scope/owner end) | non-deterministic (when GC runs) |
| Pauses | none | possible stop-the-world stalls |
| Throughput cost | ~zero | collector CPU + write barriers |
| Cycles | needs `weak_ptr` to break | handled automatically |
| Tail latency | predictable | the danger zone |
| Programmer effort | manage ownership | mostly automatic |
| Bug classes | UAF/leaks possible if misused | UAF/double-free largely eliminated |

## Reference counting

The simplest scheme: each object carries a count of references to it. Increment
on copy, decrement on destruction; when the count hits zero, free immediately.

This is **`std::shared_ptr`** — C++'s opt-in, manual reference counting:

```cpp
auto a = std::make_shared<Node>();   // refcount = 1
auto b = a;                          // refcount = 2 (atomic increment)
b.reset();                           // refcount = 1
// when a is destroyed -> refcount = 0 -> Node freed immediately
```

Properties:

- **Pro:** reclamation is immediate and incremental — no big pause, freeing is
  spread out (RAII-like determinism).
- **Con — cycles leak.** If A points to B and B points to A, neither count ever
  reaches zero even when both are unreachable. Plain reference counting *cannot*
  collect cycles.
- **Con — cost.** In multithreaded code the counter must be **atomic**; every
  copy/destroy is an atomic RMW (contended, expensive, ~tens of ns), and the
  counter sits in a cache line that bounces between cores.

The C++ fix for cycles is **`std::weak_ptr`** — a non-owning reference that
doesn't bump the count, used to break the cycle (e.g. parent→child `shared_ptr`,
child→parent `weak_ptr`). It's *manual* cycle management — you decide where the
weak edge goes.

> **Interview gotcha:** "What's the flaw in reference counting, and how does
> `shared_ptr` address it?" → cycles leak; `weak_ptr` breaks them. Bonus: note
> that the control-block refcount is atomic, so `shared_ptr` copies are not free.

CPython uses reference counting as its *primary* mechanism, plus a separate
**cycle collector** to catch the cycles refcounting misses — a good illustration
that the two approaches are often combined.

## Tracing collectors

The other family *traces* reachability from a set of **roots** (globals, stack
variables, registers) and reclaims everything not reached.

### Mark-and-sweep

Two phases:

1. **Mark** — starting from the roots, traverse all reachable objects and set a
   "live" bit on each.
2. **Sweep** — walk the whole heap; anything *not* marked is garbage, return it
   to the free list.

```text
Roots --> A --> B      C       D --> E
              (live)  (garbage)
Mark:  A, B, D, E marked.   Sweep: C reclaimed.
```

Simple and cycle-safe (cycles are unreachable from roots → collected). Downsides:
the sweep touches the whole heap (cost scales with heap size), it leaves the heap
**fragmented**, and the basic version is **stop-the-world** (the program must
pause so the object graph doesn't mutate mid-trace).

### Mark-compact

Like mark-and-sweep, but the reclaim phase **compacts** live objects to one end
of the heap, squeezing out the gaps. This defeats fragmentation and makes
subsequent allocation a cheap bump-pointer — but moving objects means **updating
every pointer** to them, which is expensive and requires a longer pause.

### Copying / semispace

Split the heap in two halves. Allocate only in the "from" space; when it fills,
**copy** all live objects to the "to" space (compacting as you go), then swap the
roles. Dead objects are abandoned wholesale — you never touch them.

- **Pro:** allocation is a pointer bump; collection cost scales with *live* data,
  not heap size; no fragmentation; cache-friendly compaction.
- **Con:** uses 2× the memory (half is always idle), and it moves objects.

### Tri-color marking

The abstraction that makes *concurrent/incremental* tracing safe. Color every
object:

- **White** — not yet visited (candidate garbage).
- **Gray** — visited, but its children not yet scanned (the work frontier).
- **Black** — visited and fully scanned.

The collector advances the gray frontier until none remain; surviving white
objects are garbage. The **invariant** to preserve: *no black object points to a
white object* (without an intervening gray). If the program mutates a pointer
during collection, a **write barrier** re-colors the target gray so nothing live
is missed. This lets the collector run *incrementally* or *concurrently* with the
program — the basis of low-pause collectors.

## Generational GC

The single most important optimization, built on the **weak generational
hypothesis**: *most objects die young.* Empirically, the vast majority of
allocations become garbage almost immediately (temporaries, loop locals), while
the few that survive tend to live a long time.

So segregate the heap by age:

- **Young (nursery)** generation — new objects. Collected **frequently** and
  cheaply (it's small; usually copying collection over just the live survivors).
- **Old (tenured)** generation — objects that survived several young collections,
  "promoted" up. Collected **rarely** (a full, expensive collection).

Because most garbage is in the young generation and dies fast, the frequent
young-gen collections do little work and the expensive full collection is rare.
This is how HotSpot, Go, and .NET keep average overhead low. (A **remembered
set** / write barrier tracks the rare old→young pointers so young collections
needn't scan the whole old generation.)

## Stop-the-world vs concurrent/incremental — and the dreaded pause

The latency-defining axis:

- **Stop-the-world (STW):** the program is fully paused while the collector runs.
  Simple and correct, but the pause length can be large (scales with live set).
- **Incremental:** the collector does its work in small slices interleaved with
  the program, bounding any single pause.
- **Concurrent:** the collector runs *alongside* the program on other threads,
  using write barriers (tri-color invariant) to stay correct as memory mutates.

```text
Stop-the-world:   [--- run ---][== GC PAUSE ==][--- run ---]
                                ^ everything blocks: your feed handler too

Concurrent:       [--- run + tiny barriers, GC on another core ---]
                   short, bounded pauses (often just for the final mark)
```

**The GC pause is the enemy of tail latency.** Average overhead is fine; it's the
*p99.9 / max* that kills you. A 10 ms STW pause means your strategy is *blind and
unresponsive for 10 ms* — an eternity when prices move in microseconds. You can't
schedule it, you can't predict it, and it tends to fire under *load* (high
allocation = high garbage = frequent GC) — i.e. exactly during the volatile,
high-volume moments that matter most. This is the crux of the HFT argument
against managed languages.

## Language comparison

| Runtime | Scheme |
|:--------|:-------|
| **C++** | none — RAII + `shared_ptr` (manual refcount) |
| **Java (HotSpot)** | generational tracing; collectors G1, ZGC, Shenandoah |
| **Go** | concurrent mark-sweep, tri-color, sub-ms pause target |
| **C# / .NET** | generational mark-compact, concurrent background GC |
| **Python (CPython)** | reference counting + cyclic GC for cycles |
| **JavaScript (V8)** | generational, concurrent mark-sweep/compact |

Modern collectors are impressive — **ZGC** and **Shenandoah** target sub-
millisecond pauses largely independent of heap size, and Go targets sub-ms — but
"sub-millisecond" is still hundreds of times an HFT hot-path budget, and pauses
still exist.

## The HFT angle: living with (or without) a GC

The first-choice answer is **don't have a GC** — use C++ with RAII and the
pool/arena allocation discipline from the memory-management lesson. When a shop
*is* forced into a managed language (common in Java-heavy risk/exchange-adjacent
systems), the playbook is to **starve the collector**:

- **Allocate nothing on the hot path.** No garbage → no young-gen collection.
  Pre-allocate and **reuse object pools** (the same idea as C++ pools, in Java).
- **Off-heap memory.** Store data in `ByteBuffer`/`Unsafe`/native memory the GC
  doesn't manage at all, so the heap stays tiny and quiet.
- **Tune the collector** — pick a low-pause collector (ZGC/Shenandoah), size the
  young generation, and aim to never trigger a full GC during the trading day.
- **Pauseless GC** — **Azul Zing / C4** is a concurrent compacting collector
  engineered for near-pauseless operation, used precisely so latency-sensitive
  Java can avoid STW stalls.
- Some teams even **schedule GC** during market-closed windows, or restart
  processes daily so a full GC never fires while live.

> **Interview-ready summary:** "GC trades determinism for safety. The pause —
> non-deterministic, load-correlated, and devastating to tail latency — is why we
> use C++ with RAII. If forced into Java, we'd run a low-pause collector,
> allocation-free hot paths, object pools, and off-heap data so the collector
> essentially never runs while we're live."

## Quant/HFT relevance & interview gotchas

- **"Why C++ and not Java/Go?"** The headline answer is the **GC pause** and its
  effect on tail latency, plus C++'s deterministic RAII reclamation.
- **`shared_ptr` is manual reference counting** — and it leaks cycles; `weak_ptr`
  breaks them. Also know the **atomic refcount cost** (cache-line bouncing).
- **Average overhead ≠ the problem; the pause is.** Be precise: it's the
  p99.9/max, and pauses correlate with load.
- **Generational GC + weak generational hypothesis** is the most-asked GC
  optimization — be able to state the hypothesis and why it makes young-gen
  collection cheap.
- **Tri-color marking + write barriers** is how concurrent collectors stay
  correct — the senior-level detail.
- **The escape hatches**: off-heap memory, object pools, low-pause/pauseless
  collectors (ZGC, Shenandoah, Azul C4). Name them.
- **Determinism is the deeper theme** — RAII frees *exactly here, every time*;
  that predictability, not raw speed, is the real win for latency-critical code.

## Key takeaways

1. GC = automatic reclamation of unreachable heap memory; it buys safety
   (no UAF/double-free/leaks) at the cost of **throughput overhead** and,
   critically, **non-deterministic pauses**.
2. C++ deliberately omits GC in favor of **deterministic RAII** — destructors run
   at known points, no pauses. `std::shared_ptr` is opt-in **reference counting**.
3. **Reference counting** reclaims immediately but **leaks cycles** (→ `weak_ptr`)
   and pays atomic-counter cost. **Tracing** collectors (mark-sweep, mark-compact,
   copying) reclaim from roots and handle cycles.
4. **Generational GC** exploits the **weak generational hypothesis** (most objects
   die young): cheap frequent young-gen collections, rare expensive full ones.
5. **Tri-color marking + write barriers** enable **concurrent/incremental**
   collection; the alternative is **stop-the-world** pauses.
6. **The GC pause is the HFT enemy** — non-deterministic, load-correlated, and
   measured in the tail. That's *why* HFT uses C++.
7. Forced into a GC language: **allocate nothing hot, pool objects, go off-heap,
   use a low-pause/pauseless collector**, and tune so GC never fires while live.

## Self-check

1. Why does C++ not need a garbage collector, and what mechanism replaces it?
   Why does that mechanism matter specifically for latency?
2. What is the fundamental flaw of reference counting, and how does `std::weak_ptr`
   address it? What does CPython do about it?
3. Describe mark-and-sweep. Why does the basic version need to stop the world,
   and what does it leave the heap in?
4. State the weak generational hypothesis and explain how generational GC turns
   it into a performance win.
5. What are the three colors in tri-color marking, what invariant is preserved,
   and what is a write barrier for?
6. Why is a managed language's *average* GC overhead not the main problem for
   HFT, and what *is*?
7. You must implement a strategy in Java. List four concrete techniques to keep
   the GC from causing pauses during the trading day.

## Further reading

- Richard Jones, Antony Hosking, Eliot Moss, *The Garbage Collection Handbook* —
  the definitive reference on every algorithm in this lesson.
- [`std::shared_ptr` — cppreference](https://en.cppreference.com/w/cpp/memory/shared_ptr)
  and [`std::weak_ptr` — cppreference](https://en.cppreference.com/w/cpp/memory/weak_ptr).
- [Garbage collection (computer science) — Wikipedia](https://en.wikipedia.org/wiki/Garbage_collection_(computer_science))
  and [Tracing garbage collection — Wikipedia](https://en.wikipedia.org/wiki/Tracing_garbage_collection)
  (tri-color, generational, write barriers).
- [HotSpot Garbage Collection Tuning Guide (Oracle)](https://docs.oracle.com/en/java/javase/17/gctuning/index.html)
  — generations, G1, ZGC, and tuning in practice.
- [The Go GC: latency-oriented design](https://go.dev/blog/ismmkeynote) — a clear
  account of a concurrent tri-color collector built for low pauses.
- [C++ Core Guidelines — Resource management (R)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-resource)
  — RAII and smart-pointer ownership, the C++ alternative to GC.

## Videos

- *Computerphile* — **"Garbage Collection"** intuition
  ([search](https://www.youtube.com/results?search_query=computerphile+garbage+collection)).
- CppCon — **"When a Microsecond Is an Eternity"** (Carl Cook) on why managed
  pauses are unacceptable in HFT
  ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)).
- **"Understanding Java Garbage Collection"** / low-latency Java (Gil Tene, Azul)
  ([search](https://www.youtube.com/results?search_query=Gil+Tene+understanding+latency+garbage+collection+java)).
