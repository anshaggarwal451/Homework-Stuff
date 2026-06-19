# POSIX Shared Memory

> **Why a quant dev must own this:** Shared memory is *the* low-latency IPC. A
> market-data distributor writes ticks into a region in `/dev/shm`; strategy
> processes read them directly — no kernel copy, no syscall per message, just
> memory loads and stores coordinated by atomics. Every other mechanism (pipes,
> sockets, message queues) is an order of magnitude slower because it crosses the
> kernel on every message. If you can stand up a `shm_open`+`mmap` producer/
> consumer and explain the object-layout discipline, you've answered the most
> important practical IPC question an HFT interview asks.

## First principles: a named region both processes map

POSIX shared memory is a **named, kernel-managed region** that multiple processes
map into their address spaces with [`mmap`](memory-mapped-files-mmap.md). On
Linux the object lives on a **tmpfs filesystem mounted at `/dev/shm`** — RAM-backed,
so there's no disk I/O and no persistence across reboot. Once both processes have
mapped it `MAP_SHARED`, they share the *same physical pages*: a store by the
producer is visible to the consumer's load after cache coherence does its job.
**After the one-time setup there is no kernel involvement and no copy** — which is
exactly why it's the fastest IPC there is (see
[IPC Trade-offs](ipc-trade-offs-and-performance.md)).

## The modern idiom: `shm_open` + `ftruncate` + `mmap`

Three steps, in order:

1. **`shm_open("/name", …)`** — create/open the named object, returns an fd.
2. **`ftruncate(fd, size)`** — set its size (creating it leaves it zero-length;
   mapping past the end raises `SIGBUS`, so this step is mandatory).
3. **`mmap(…, MAP_SHARED, fd, 0)`** — map it into this process.

Lifecycle: the object **persists in `/dev/shm` until `shm_unlink("/name")`** is
called (and all maps are gone) — like a file, it outlives the creating process.
Names must start with `/` and contain no other slashes.

```text
   producer                         consumer
   shm_open("/md",O_CREAT|O_RDWR)   shm_open("/md",O_RDWR)
   ftruncate(fd,size)                       (already sized)
   mmap(MAP_SHARED) ─┐               ┌─ mmap(MAP_SHARED)
                     ▼               ▼
              same physical pages in /dev/shm (RAM)
   ... when done ...
   shm_unlink("/md")  // remove the name
```

## System V shm vs POSIX shm

The older System V API — `shmget` (create, integer `key_t`), `shmat` (attach),
`shmdt`, `shmctl(IPC_RMID)` — still works and you'll meet it in legacy code, but
prefer POSIX:

| | System V (`shmget`/`shmat`) | POSIX (`shm_open`/`mmap`) |
|---|---|---|
| Naming | integer `key_t` (via `ftok`) | path-like `/name` |
| Handle | `int` shmid (not an fd) | a real **fd** (composes with mmap, fstat, fd-passing) |
| Sizing | at `shmget` | `ftruncate` |
| Cleanup | `shmctl(IPC_RMID)` | `shm_unlink` |
| Inspect | `ipcs`/`ipcrm` | `ls /dev/shm` |

POSIX is fd-based, path-named, and uses the same `mmap` machinery as everything
else — strictly nicer for new code.

## Layout discipline: what you may put in shared memory

Two processes map the region at **different virtual addresses**. So a raw pointer
stored in shared memory by one process is meaningless to the other — it points
into the *writer's* address space. The rules that follow are the heart of the
topic:

- **Only trivially-copyable / standard-layout types.** No virtual functions
  (vtable pointers are per-process addresses), no `std::string`/`std::vector`
  (they hold heap pointers into the owner's address space), no `std::shared_ptr`.
- **No raw pointers between objects in the region.** Use **offsets/indices**
  relative to the region base, or a relocatable smart pointer like
  **Boost.Interprocess `offset_ptr`** (it stores the *distance* to the target, so
  it's valid in any mapping).
- **Construct in place with placement-new** so the object's bytes live in the
  shared pages, not on some process's heap.
- **Fix the layout explicitly:** `alignas`, fixed-width types, and cache-line
  padding (`alignas(64)`) so independent fields don't false-share (see
  [Lock-Free IPC Patterns](lock-free-ipc-patterns.md)).

## Synchronizing across processes

Mapping shared pages does **not** order accesses. You need one of:

- **`std::atomic` in the shared region** — works across processes because atomics
  operate on the memory itself, not on any per-process state. This is the
  lowest-latency choice and the basis of lock-free shared-memory rings.
- **A process-shared mutex/condvar** — a `pthread_mutex_t` placed *in* the shared
  region and initialized with the **`PTHREAD_PROCESS_SHARED`** attribute. Correct
  but it can sleep (futex syscall) and risks **robustness** problems: if a holder
  dies, the lock is stuck unless you use `PTHREAD_MUTEX_ROBUST`.
- **Raw `futex(2)`** — the kernel primitive both of the above build on; rarely
  used directly outside libraries.

For the hot path, HFT systems overwhelmingly use **atomics + busy-poll** and a
lock-free protocol, never a sleeping mutex.

## Compilable producer/consumer over `shm_open` + `mmap`

```cpp
// Producer: g++ -std=c++20 -O2 prod.cpp -lrt -o prod
// (consumer is the same file; pass "c" as argv[1])
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <cstdint>

struct Slot {
    std::atomic<uint32_t> ready;   // 0 = empty, 1 = published
    uint64_t              seq;      // payload: trivially copyable only
    double                price;
    uint32_t              qty;
};

constexpr const char* NAME = "/md_demo";

int main(int argc, char** argv) {
    bool producer = !(argc > 1 && argv[1][0] == 'c');

    int fd = shm_open(NAME, O_CREAT | O_RDWR, 0660);
    if (fd < 0) { perror("shm_open"); return 1; }
    if (ftruncate(fd, sizeof(Slot)) < 0) { perror("ftruncate"); return 1; }

    void* p = mmap(nullptr, sizeof(Slot), PROT_READ | PROT_WRITE,
                   MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) { perror("mmap"); return 1; }
    close(fd);
    auto* slot = static_cast<Slot*>(p);   // bytes already zeroed by ftruncate

    if (producer) {
        slot->seq   = 42;
        slot->price = 101.25;
        slot->qty   = 500;
        // release: make the payload visible BEFORE the consumer sees ready==1
        slot->ready.store(1, std::memory_order_release);
        printf("produced seq=%lu\n", slot->seq);
    } else {
        // acquire: once we observe ready==1, the payload writes are visible
        while (slot->ready.load(std::memory_order_acquire) == 0)
            ;  // busy-poll (HFT style); could pause/yield in non-critical code
        printf("consumed seq=%lu price=%.2f qty=%u\n",
               slot->seq, slot->price, slot->qty);
        shm_unlink(NAME);   // consumer cleans up the name when done
    }
    munmap(p, sizeof(Slot));
}
```

Run `./prod` then `./prod c` (in a second terminal). The **release store** of
`ready` publishes the payload; the consumer's **acquire load** establishes the
happens-before edge so it sees the price/qty. This single-slot hand-off
generalizes directly to the SPSC ring in
[Lock-Free IPC Patterns](lock-free-ipc-patterns.md). Link with `-lrt` for the
POSIX runtime on older glibc.

## The copy/syscall accounting

| Phase | Cost |
|---|---|
| Setup (`shm_open`+`ftruncate`+`mmap`) | a few syscalls, once |
| First touch of each page | a minor page fault (~µs) — pre-fault to avoid |
| Steady-state read/write | **a plain memory load/store — no syscall, no copy** |
| Synchronization | atomic (≈free on x86 for acquire/release) or futex if it must sleep |

That steady-state row is the entire reason shared memory dominates the hot path.

## Performance and hardware reality

- After warm-up, moving a message is a memory write by the producer and a memory
  read by the consumer — **tens to a few hundred nanoseconds** including the
  cache-coherence transfer of the line, far less if it stays in cache. Compare:
  a pipe/socket round trip is **single-digit microseconds** because of syscalls,
  copies, and a wakeup.
- The real costs are **cache coherence** (a line written by one core and read by
  another moves between caches — tens of ns) and **false sharing** if unrelated
  fields share a 64-byte line. Pad with `alignas(64)`.
- **Pre-fault** (`MAP_POPULATE`) and **pin** (`mlock`) the region at startup so no
  page fault lands on the critical path. Huge pages cut TLB pressure for large
  rings.
- These are **order-of-magnitude** figures; measure on your hardware and NUMA
  topology (cross-socket coherence is markedly slower).

## Quant/HFT relevance & interview gotchas

- **Shared memory + busy-poll + a lock-free ring is the canonical low-latency
  IPC.** A feed handler writes to `/dev/shm`; many strategy processes map and
  read it. State this as the default for the hot path.
- **No pointers, no `std::string`, no virtuals in the region.** Use offsets or
  `offset_ptr`. This layout discipline is the #1 thing interviewers probe — be
  ready to explain *why* (different mapping addresses per process).
- **`ftruncate` before mapping** or hit `SIGBUS`; **the object persists until
  `shm_unlink`** (orphaned `/dev/shm` objects are a real ops headache — `ls
  /dev/shm`).
- **Process-shared mutex needs `PTHREAD_PROCESS_SHARED`** and, for safety,
  `PTHREAD_MUTEX_ROBUST` so a crashed holder doesn't wedge everyone. But prefer
  atomics on the hot path.
- **Atomics work across processes** because they act on the shared bytes — a point
  worth making explicitly.
- Shared memory gives you **no kernel-mediated security or backpressure**; a buggy
  writer can corrupt every reader. Discipline and layout versioning matter.

## Key takeaways

1. POSIX shm = **`shm_open` → `ftruncate` → `mmap(MAP_SHARED)`**, backed by tmpfs
   in `/dev/shm`; both processes share the **same physical pages**, so the data
   move is **zero-copy with no per-message syscall**.
2. Prefer POSIX over System V (`shmget`/`shmat`): fd-based, path-named, same
   `mmap` machinery. The object **persists until `shm_unlink`**.
3. **Layout discipline:** only trivially-copyable/standard-layout types; **no raw
   pointers** (use offsets or `offset_ptr`), no `std::string`/`vector`, no
   virtuals; construct with placement-new; pad to cache lines.
4. Synchronize with **atomics** (release-store to publish, acquire-load to
   consume) on the hot path; `PTHREAD_PROCESS_SHARED` (robust) mutexes only off
   it.
5. Pre-fault and `mlock` at startup; this is the foundation of the
   [lock-free shared-memory ring](lock-free-ipc-patterns.md) that powers trading
   systems.

## Self-check

1. Why must you `ftruncate` the object before mapping it, and what happens if you
   forget?
2. A process stores a `std::string` in shared memory and another process reads it
   and crashes. Explain precisely why, and what you should store instead.
3. Two processes map the same object at different virtual addresses. How do you
   represent a "pointer" from one object to another inside the region?
4. Why do `std::atomic` operations work correctly across two separate processes?
5. What makes a `PTHREAD_PROCESS_SHARED` mutex risky in a crashy environment, and
   what attribute mitigates it? Why might you avoid it on the hot path anyway?
6. Walk through the release/acquire pair in the producer/consumer example: what
   would break if both used `memory_order_relaxed`?

## Further reading

- [`shm_overview(7)`](https://man7.org/linux/man-pages/man7/shm_overview.7.html) — the POSIX shared-memory model and `/dev/shm`.
- [`shm_open(3)`](https://man7.org/linux/man-pages/man3/shm_open.3.html), [`ftruncate(2)`](https://man7.org/linux/man-pages/man2/ftruncate.2.html), [`mmap(2)`](https://man7.org/linux/man-pages/man2/mmap.2.html) — the three-step idiom.
- [`pthread_mutexattr_setpshared(3)`](https://man7.org/linux/man-pages/man3/pthread_mutexattr_setpshared.3.html) and [`pthread_mutexattr_setrobust(3)`](https://man7.org/linux/man-pages/man3/pthread_mutexattr_setrobust.3.html) — process-shared, robust mutexes.
- [`sysvipc(7)`](https://man7.org/linux/man-pages/man7/sysvipc.7.html) / [`shmget(2)`](https://man7.org/linux/man-pages/man2/shmget.2.html) — the legacy System V family.
- [Boost.Interprocess](https://www.boost.org/doc/libs/release/doc/html/interprocess.html) — `offset_ptr`, managed shared-memory segments, process-shared synchronization done right.
- [`std::atomic` — cppreference](https://en.cppreference.com/w/cpp/atomic/atomic) — memory orders for the publish/consume protocol.

## Videos

- **CppCon — lock-free / shared-memory data structures in trading systems** ([search](https://www.youtube.com/results?search_query=CppCon+lock+free+shared+memory+trading+system)).
- **POSIX shared memory shm_open mmap tutorial (Linux)** ([search](https://www.youtube.com/results?search_query=posix+shared+memory+shm_open+mmap+tutorial+linux)).
