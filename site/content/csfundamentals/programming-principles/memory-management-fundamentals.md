# Memory Management Fundamentals

> **Why a quant dev must own this:** A call to `malloc`/`new` in your hot path
> can take a lock, walk a free list, hit a syscall (`mmap`/`brk`), or trigger a
> page fault — any of which is a multi-microsecond stall that costs you fills.
> The defining discipline of HFT C++ is *no dynamic allocation on the hot path*:
> pre-allocate everything, then reuse it with arenas and pools. To do that
> deliberately you must understand what an allocator actually does underneath
> `new`. This is the most important systems lesson on the list.

## First principles: stack vs heap

A process gets memory in a few regions. The two you manage are the **stack** and
the **heap**.

| | Stack | Heap |
|:--|:------|:-----|
| Allocation | bump the stack pointer (one instruction) | call the allocator (`malloc`/`new`) |
| Cost | ~free (1 cycle) | ~tens to hundreds of ns, sometimes much more |
| Lifetime | tied to scope (LIFO) | until you `free`/`delete` |
| Size | small, fixed (e.g. 1–8 MB), can overflow | large, limited by RAM/address space |
| Locality | excellent (hot, contiguous) | depends — can be scattered |
| Thread safety | per-thread, no contention | global allocator may lock |

```cpp
void f() {
    int x = 42;                 // stack: SP -= 4, lives until f() returns
    int buf[1024];              // stack: 4 KB, just moves the stack pointer
    int* p = new int[1024];     // heap: calls the allocator, returns a pointer
    // ...
    delete[] p;                 // heap: returns memory to the allocator
}                               // x and buf disappear automatically (just SP += ...)
```

**The stack is nearly free and self-cleaning; the heap is expensive and manual.**
The first rule of fast code is: prefer the stack (and contiguous, pre-sized
storage) whenever the lifetime allows.

## `malloc`/`free` and `new`/`delete`

`new` is *not* the same as `malloc`. The layers:

```text
new T(args)   ==   operator new(sizeof(T))   then   construct T at that memory
                          |
                          v  (typically)
                       malloc(size)
                          |
                          v  (when it needs more from the OS)
                       brk()  /  mmap()   <- syscalls into the kernel
```

- **`malloc`/`free`** (C) allocate raw, uninitialized bytes.
- **`operator new`/`operator delete`** are the C++ raw-memory primitives;
  `operator new` typically forwards to `malloc` and throws `std::bad_alloc` on
  failure (vs `malloc` returning `nullptr`).
- The **`new` expression** does two things: calls `operator new` for storage,
  then runs the constructor. `delete` runs the destructor, then frees.

These are distinct concerns — *acquiring storage* vs *constructing an object* —
and **placement new** lets you separate them (below), which is the foundation of
every custom allocator and pool.

## What an allocator actually does

`malloc` is a user-space library (glibc's ptmalloc, jemalloc, tcmalloc, …) that
manages a pool of memory it gets from the kernel in *big* chunks and hands back
in *small* pieces. Its jobs:

- **Get memory from the OS** via `brk`/`sbrk` (grow the heap segment) for small
  requests, or `mmap` (map fresh pages) for large ones. These are **syscalls** —
  expensive and a source of unpredictable latency. The allocator amortizes them
  by requesting memory in bulk and reusing it.
- **Maintain free lists** — linked lists of previously-freed blocks, so a
  subsequent `malloc` can satisfy a request without touching the kernel.
- **Bucket by size class** — group allocations into discrete sizes (e.g. 16, 32,
  48, 64 … bytes) so same-size frees can be recycled quickly and fragmentation
  is bounded.
- **Use arenas** — per-thread or per-CPU pools so concurrent threads don't all
  contend on one global lock (jemalloc and tcmalloc are built around this).
- **Track metadata** — each allocation typically carries a small header (size,
  flags) just *before* the returned pointer, so `free` knows the size. This is
  pure overhead, and it pollutes the cache line ahead of your data.

```text
What malloc(24) really hands you:

  [ header  ][  your 24 bytes (rounded up to a size class, e.g. 32)  ]
  ^metadata  ^returned pointer
   (8-16B)
```

### Alignment

Every allocation is **aligned** so any type can live there — `malloc`/`new`
guarantee alignment for the largest fundamental type (`max_align_t`, usually 16
bytes). Over-aligned types (SIMD `__m256`, cache-line-aligned structs) need
`alignas` + `std::aligned_alloc` / aligned `operator new` (C++17). Misaligned
access is slow or, on some ISAs, a fault — and matters for SIMD and for avoiding
false sharing.

## Fragmentation

Free memory that you can't use is the allocator's chronic disease.

- **Internal fragmentation** — wasted space *inside* an allocation because the
  allocator rounded your request up to a size class. Ask for 33 bytes, get 48;
  15 bytes wasted.
- **External fragmentation** — free memory exists but is split into pieces too
  small/scattered to satisfy a large request. The total is enough; no single
  contiguous run is.

```text
External fragmentation:  [used][free 16][used][free 16][used][free 16]
  48 bytes free total, but a request for 32 contiguous bytes fails.
```

Fragmentation grows with long-running, churny allocation patterns — exactly what
a process running for a full trading session does. It's a key reason HFT prefers
allocators it controls (arenas reset wholesale) over general-purpose `malloc`.

## The cost of allocation

Approximate, order-of-magnitude (varies by allocator, contention, and state):

| Scenario | Approx cost |
|:---------|:------------|
| `malloc` hits a warm free list (no lock contention) | ~tens of ns |
| `malloc` under lock contention (multithreaded) | ~hundreds of ns to µs |
| `malloc` that must `mmap`/`brk` (syscall) | ~µs |
| First touch of a fresh page → **page fault** | ~µs (kernel zeroes & maps the page) |
| Stack allocation | ~1 cycle (sub-ns) |

The killer for HFT is **variance**, not the mean. Most `malloc`s are fast, but
the *occasional* one that hits the lock, the syscall, or the page fault is a
tail-latency spike landing in your hot path at the worst moment. You cannot
bound it. So you remove it.

## Placement new: storage and construction, decoupled

`placement new` constructs an object in memory **you already own** — no
allocation happens. It's the building block for pools and arenas:

```cpp
#include <new>      // placement new, std::launder
#include <cstddef>

alignas(Trade) std::byte storage[sizeof(Trade)];   // raw, pre-allocated bytes

Trade* t = new (storage) Trade{...};   // construct IN-PLACE, no malloc
// ... use t ...
t->~Trade();                           // must call the destructor MANUALLY
```

You allocate the bytes once (here, on the stack), then construct/destruct objects
into them as many times as you like with zero allocator involvement.

## A real arena (monotonic) allocator

The simplest, fastest custom allocator: grab a big buffer once, hand out slices
by bumping a pointer, and free *everything at once* by resetting the pointer.
Allocation is a pointer add — a couple of instructions, no free list, no lock,
no syscall.

```cpp
#include <cstddef>
#include <cstdint>
#include <new>

class ArenaAllocator {
    std::byte*  buf_;
    std::size_t cap_;
    std::size_t off_ = 0;
public:
    ArenaAllocator(std::byte* buffer, std::size_t cap)
        : buf_(buffer), cap_(cap) {}

    void* allocate(std::size_t n, std::size_t align = alignof(std::max_align_t)) {
        std::size_t cur = reinterpret_cast<std::uintptr_t>(buf_ + off_);
        std::size_t pad = (align - (cur % align)) % align;   // align the cursor
        if (off_ + pad + n > cap_) return nullptr;           // out of arena
        void* p = buf_ + off_ + pad;
        off_ += pad + n;                                     // bump the pointer
        return p;                                            // O(1), no free list
    }

    void reset() { off_ = 0; }   // "free" everything in one instruction
};

// Usage: one big slab, reused every event/tick.
alignas(64) static std::byte slab[1 << 20];   // 1 MB, allocated once at startup
ArenaAllocator arena{slab, sizeof(slab)};
```

Trade-off: you can't free individual objects — only reset the whole arena. That's
perfect for per-tick / per-message scratch memory where everything dies at the
end of the cycle.

## A fixed-size object pool

When you allocate/free *one type* repeatedly (orders, market-data nodes), a pool
recycles fixed-size slots via a free list, all in pre-allocated storage:

```cpp
#include <cstddef>
#include <vector>
#include <new>

template <class T, std::size_t N>
class ObjectPool {
    union Slot { T value; Slot* next; Slot() {} ~Slot() {} };
    Slot  slots_[N];
    Slot* free_ = nullptr;
public:
    ObjectPool() {                                  // thread free list at startup
        for (std::size_t i = 0; i < N; ++i) {
            slots_[i].next = free_;
            free_ = &slots_[i];
        }
    }
    template <class... Args>
    T* acquire(Args&&... args) {                    // O(1), no malloc
        if (!free_) return nullptr;                 // pool exhausted
        Slot* s = free_;
        free_ = s->next;
        return new (&s->value) T(std::forward<Args>(args)...);  // placement new
    }
    void release(T* p) {                            // O(1), no free
        p->~T();                                    // manual destruction
        Slot* s = reinterpret_cast<Slot*>(p);
        s->next = free_;
        free_ = s;
    }
};
```

`acquire`/`release` are a pointer swap each — bounded, lock-free (per thread),
allocation-free. This is the workhorse pattern in HFT engines.

## `std::pmr`: standard polymorphic memory resources

C++17 standardized custom allocators so containers can use your arena/pool
without templating their allocator type into the container's type. Containers
take a `std::pmr::memory_resource*` at runtime:

```cpp
#include <memory_resource>
#include <vector>
#include <array>

void per_tick() {
    std::array<std::byte, 64 * 1024> buf;          // stack buffer
    std::pmr::monotonic_buffer_resource pool{buf.data(), buf.size()};

    std::pmr::vector<int> v{&pool};                // allocates FROM the stack buffer
    v.reserve(1000);
    // ... no heap allocation; the vector draws from 'buf' ...
}   // pool destroyed -> all "frees" are a no-op; buffer reclaimed with the stack
```

- **`monotonic_buffer_resource`** — arena semantics: allocate from a buffer,
  never free individually, release all at once on destruction. Fastest.
- **`unsynchronized_pool_resource` / `synchronized_pool_resource`** — pool of
  size-class chunks; recycles frees. The synchronized variant is thread-safe.
- Resources are **chainable**: a pool resource falls back to an upstream
  resource (e.g. `new_delete_resource`) when its buffer is exhausted.

`pmr` gives you arena/pool speed with standard containers and minimal code — a
pragmatic middle ground between `std::allocator` and a fully custom allocator.

## RAII and smart pointers (forward reference)

C++ has no garbage collector; instead, **RAII** (Resource Acquisition Is
Initialization) ties resource lifetime to object lifetime, so the destructor
frees automatically and deterministically. `std::unique_ptr` and
`std::shared_ptr` apply RAII to heap allocations so you rarely write a raw
`delete`. This deterministic, scope-bound reclamation is *the* C++ answer to
memory management and is covered in depth in the RAII / smart-pointer and
garbage-collection sibling lessons. The key point here: smart pointers manage
*ownership*; they do **not** make allocation cheap. `make_unique` still calls the
allocator — so they belong in the cold/setup path, not inside a hot loop.

## Drop-in allocators: jemalloc & tcmalloc

When you can't avoid general-purpose allocation, replace glibc's `malloc`:

- **tcmalloc** (Google) — thread-caching malloc; per-thread caches eliminate
  most lock contention for small allocations.
- **jemalloc** (Facebook/FreeBSD) — arena-based, excellent at controlling
  fragmentation under long-running, multithreaded churn.

Both `LD_PRELOAD` in transparently and routinely cut allocation latency and
fragmentation versus stock `malloc`. They're a free win for the *warm* path;
they still don't make allocation safe for the *hot* path.

## Quant/HFT relevance & interview gotchas

- **No allocation on the hot path.** `new`/`malloc` can lock, syscall, and
  page-fault — unbounded latency. Pre-allocate at startup; reuse via
  arenas/pools.
- **`reserve()` your vectors.** A `push_back` reallocation is an allocation +
  copy + cache-eviction spike. Size containers once, up front.
- **`std::vector` over `std::list`/node containers.** Node-per-element means an
  allocation per insert and pointer-chasing on traversal — the cache's enemy.
- **Pre-fault / lock pages.** Touch (and `mlock`) your buffers at startup so the
  first hot-path access doesn't take a page fault; consider huge pages to cut
  TLB misses.
- **Placement new + manual destruction** is the basis of pools — be ready to
  write a simple arena or pool on a whiteboard.
- **`pmr` is the modern, low-code path** to allocator control with standard
  containers — name `monotonic_buffer_resource`.
- **Smart pointers ≠ free allocation.** `make_shared`/`make_unique` still hit the
  allocator; they solve *ownership*, not *latency*.
- Know the cost ladder: stack ≈ free, warm `malloc` ≈ tens of ns, contended/
  syscall/page-fault `malloc` ≈ µs. The *variance* is what kills HFT.

## Key takeaways

1. **Stack is ~free and auto-cleaning; heap is expensive and manual.** Prefer
   the stack and pre-sized contiguous storage.
2. `new` = `operator new` (≈`malloc`, storage) + constructor. The allocator gets
   memory from the OS via `brk`/`mmap`, then recycles it via **free lists, size
   classes, and arenas**, carrying per-allocation **metadata**.
3. **Fragmentation** (internal = rounding waste; external = scattered free space)
   degrades long-running processes — a real concern over a trading session.
4. Allocation cost is ~tens of ns warm but spikes to µs on lock contention,
   syscalls, or **page faults**. HFT fears the **variance**.
5. **Placement new** decouples storage from construction; it powers **arena**
   (bump-pointer, reset-all) and **pool** (recycled fixed slots) allocators.
6. **`std::pmr`** brings arena/pool speed to standard containers
   (`monotonic_buffer_resource`); **RAII/smart pointers** give deterministic
   reclamation but don't make allocation cheap.
7. The HFT discipline: **pre-allocate everything, reuse via pools/arenas, no
   `malloc` in the hot path**, `reserve` vectors, consider jemalloc/tcmalloc for
   the warm path.

## Self-check

1. Walk through everything `new Foo(x)` does, from the expression down to the
   kernel. Where can it block?
2. Distinguish internal from external fragmentation with a concrete example of
   each.
3. Why is a stack allocation ~1 cycle while a heap allocation is tens of ns to
   microseconds? What is the allocator doing?
4. Write the two operations of a bump-pointer arena allocator and explain why
   it can't free individual objects.
5. What does placement new do, and what is the one responsibility it puts on
   *you* that `new` normally handles?
6. Your hot loop does `make_shared<Order>()` per message. Why is that a problem,
   and how would you fix it without changing the logic?
7. What does `std::pmr::monotonic_buffer_resource` do, and when is it the right
   choice over `unsynchronized_pool_resource`?

## Further reading

- [`malloc(3)` — man7.org](https://man7.org/linux/man-pages/man3/malloc.3.html)
  and [`mallopt(3)`](https://man7.org/linux/man-pages/man3/mallopt.3.html) —
  glibc allocator behavior and tuning knobs.
- [`operator new` / placement new — cppreference](https://en.cppreference.com/w/cpp/memory/new/operator_new)
  and [`<memory_resource>` (`std::pmr`) — cppreference](https://en.cppreference.com/w/cpp/header/memory_resource).
- [C++ Core Guidelines — Resource management (R)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-resource).
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 9
  (virtual memory and dynamic allocation) — the canonical treatment of how
  `malloc` and the OS interact.
- [tcmalloc design docs](https://google.github.io/tcmalloc/design.html) and
  [the jemalloc project](https://jemalloc.net/) — modern arena/thread-cache
  allocators.
- Scott Meyers, *Effective C++* — Items 49–52 on customizing `new`/`delete`.

## Videos

- CppCon — **"Local ('Arena') Memory Allocators"** (John Lakos) and
  **`std::pmr`** talks
  ([search](https://www.youtube.com/results?search_query=CppCon+pmr+arena+allocator+John+Lakos)).
- CppCon — **"When a Microsecond Is an Eternity"** (Carl Cook), which covers
  why allocation is banned on the HFT hot path
  ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)).
