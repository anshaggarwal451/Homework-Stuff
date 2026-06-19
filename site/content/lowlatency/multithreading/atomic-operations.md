# Atomic Operations

> **Why a quant dev must own this:** Atomics are how you share state between
> threads *without a lock* — the building block under every lock-free queue,
> sequence counter, and SPSC ring buffer in a trading system. They let one
> thread publish a value and another read it with no torn reads, no syscall, and
> latencies measured in nanoseconds rather than the microseconds a contended
> mutex costs. But they are sharp: get the type or the operation wrong and you
> trade a deadlock for a silent data corruption. (Memory *ordering* — the other
> half — gets its own lesson; here we nail down what atomics *are* and what they
> cost.)

*Standard: C++11 introduced `std::atomic`; C++17 added `is_always_lock_free`; C++20 added `wait`/`notify` and `atomic_ref`. Examples target C++17/20.*

## First principles: what "atomic" means

An operation on a memory location is **atomic** if it appears **indivisible** to
all other threads: no other thread can observe it half-done, and it cannot be
**torn** (split into separately-visible sub-operations). A plain `int64_t` store
on a 32-bit machine, or an unaligned store, can be torn — one thread sees the
high half updated and the low half stale. `std::atomic<T>` guarantees the store
and load happen as one indivisible unit.

That single guarantee — **no torn reads/writes, and a defined memory model** —
is what lets `std::atomic` access shared data *without* a data race. Recall a
data race (unsynchronized conflicting access, one a write) is undefined
behaviour; atomic accesses are exempt because the standard defines their
behaviour and ordering.

```cpp
#include <atomic>

std::atomic<bool>  ready{false};
std::atomic<long>  seq{0};

void writer() {
    seq.store(42);             // indivisible store
    ready.store(true);         // publish
}
bool reader() {
    return ready.load();       // indivisible load, no torn read, no data race
}
```

## The core operations

`std::atomic<T>` exposes three families:

| Operation | Methods | Semantics |
|---|---|---|
| **Load** | `load()`, `operator T` | Read the value atomically. |
| **Store** | `store(v)`, `operator=` | Write atomically. |
| **Read-modify-write (RMW)** | `fetch_add`, `fetch_sub`, `fetch_and/or/xor`, `exchange`, `compare_exchange_*` | Atomically read, compute, and write back as **one** indivisible step. |

The RMW family is the powerful part. `fetch_add` returns the *old* value and
adds atomically — this is how a correct concurrent counter works, fixing the
lost-update bug a plain `++` has:

```cpp
#include <atomic>
std::atomic<long> counter{0};

void bump() {
    for (int i = 0; i < 100'000; ++i)
        counter.fetch_add(1, std::memory_order_relaxed);  // atomic; no lost increments
    // counter += 1;  // also atomic (operator+= maps to fetch_add) — same thing
}
// With N threads the final value is EXACTLY N * 100000. No mutex, no race.
```

`exchange` atomically swaps in a new value and returns the old. `compare_exchange`
(CAS) is the conditional RMW that underpins lock-free algorithms — important
enough to get its own lesson.

> **Why a plain `++` is wrong but `fetch_add` is right:** `++x` is *three*
> separate operations (load, add, store); another thread can interleave between
> them and clobber your update. `fetch_add` fuses all three into one
> indivisible hardware operation.

## `is_lock_free` and `is_always_lock_free`

`std::atomic<T>` does **not** guarantee lock-freedom for arbitrary `T`. If `T`
is too big or oddly aligned for the hardware to handle directly, the library
falls back to a hidden internal lock — correct, but with all of a mutex's costs
(and no longer usable from a signal handler or for true lock-free progress).

```cpp
#include <atomic>
#include <iostream>

struct Big { double a, b, c; };   // 24 bytes — likely NOT lock-free

int main() {
    std::cout << std::atomic<int>::is_always_lock_free   // true on every mainstream CPU
              << std::atomic<Big>{}.is_lock_free()       // likely false: hidden mutex
              << '\n';
}
```

- **`is_lock_free()`** — runtime query: does *this* atomic use a lock?
- **`is_always_lock_free`** — `constexpr` (C++17), known at compile time. Prefer
  it; you can `static_assert` on it.

On x86-64: `atomic<T>` is lock-free for naturally-aligned types up to 8 bytes
always, and 16 bytes when `CMPXCHG16B` is available. Anything wider goes through
a lock. **In HFT you `static_assert(std::atomic<T>::is_always_lock_free)`** so a
hidden mutex can never sneak into a hot path.

```cpp
static_assert(std::atomic<std::uint64_t>::is_always_lock_free,
              "we require a lock-free 64-bit atomic on this target");
```

## `std::atomic<T>` vs `volatile` — the classic trap

This is the question that separates people who learned C++ in 2005 from people
who know the memory model. **`volatile` is not for threading.**

| | `volatile T` | `std::atomic<T>` |
|---|---|---|
| Prevents the *compiler* from eliding/reordering the access | Yes | Yes |
| **Atomicity** (no torn read/write) | **No** | **Yes** |
| **Inter-thread memory ordering / happens-before** | **No** | **Yes** |
| Emits memory barriers / `LOCK` as needed | No | Yes |
| Intended use | MMIO, signal-handler `sig_atomic_t`, hardware registers | Sharing data between threads |

`volatile` tells the compiler "this memory may change underneath you, don't
optimize the access away" — exactly right for a memory-mapped device register.
It says **nothing** about atomicity, says nothing to *other cores* (no cache
coherence barrier, no `LOCK`), and provides **no** ordering guarantees between
threads. Using `volatile` for inter-thread communication is a data race and is
**undefined behaviour**, even though it appears to work on x86 by luck.

> **Senior answer:** "`volatile` is for memory that changes outside the
> program's control (MMIO, hardware). `std::atomic` is for memory shared between
> threads. They are not interchangeable. If you want thread-safe sharing, the
> answer is *always* `std::atomic`, never `volatile`."

(C++20 even deprecated most compound `volatile` operations to discourage the
confusion.)

## How it maps to x86: the `LOCK` prefix

A plain aligned load/store on x86-64 is *already* atomic at the hardware level
(the bus guarantees it), so `atomic<int>` load/store often compiles to an
ordinary `MOV`. The interesting case is an **RMW**, which the hardware can't do
atomically without help — that's the **`LOCK` prefix**.

```cpp
std::atomic<long> c{0};
long old = c.fetch_add(1);   // atomic increment, returns old value
```

compiles (roughly) to:

```x86asm
; std::atomic<long>::fetch_add(1)  — needs an atomic read-modify-write
    mov     eax, 1
    lock xadd qword ptr [rdi], rax   ; LOCK XADD: atomically add 1, return old in rax
; without LOCK, "add [mem], 1" is load/add/store -> another core could interleave
```

The `LOCK` prefix makes the read-modify-write atomic by locking the cache line
(modern CPUs use **cache-line locking** via the coherence protocol, not the old
global bus lock) for the duration of the instruction. A `compare_exchange` maps
to `LOCK CMPXCHG`; `exchange` to `XCHG` (which is implicitly locked).

The cost model that matters:

```text
operation                                  rough cost (warm cache, this core owns the line)
------------------------------------------ --------------------------------------------------
atomic load / store (plain MOV)            ~same as a normal load/store, ~handful of cycles
LOCK-prefixed RMW, uncontended             ~15-25 ns (~20-40 cycles): full barrier on x86
LOCK RMW, line owned by ANOTHER core       must steal the cache line first: ~tens-hundreds ns
```

Two crucial implications:

- **An uncontended atomic RMW is cheap** (~tens of cycles) — far cheaper than a
  mutex's contended path. This is *why* lock-free designs win.
- **A contended atomic is expensive**: the cache line bounces between cores
  (MESI), and on x86 every `LOCK` RMW is also a **full memory fence**. Many
  threads hammering one atomic counter is a cache-coherence traffic jam — the
  same false/true-sharing problem you fight with mutexes. The fix is, again,
  *less sharing* (sharded counters, per-thread accumulation).

## Quant/HFT relevance & interview gotchas

- **`volatile` vs `atomic`** is *the* atomics interview question. Lead with
  "`volatile` = MMIO, not threading; `atomic` = threading." Mention that
  `volatile` gives no atomicity and no ordering.
- **`static_assert(is_always_lock_free)`** in hot-path code so a hidden mutex
  never appears. Know that x86-64 is lock-free to 8 bytes (16 with
  `CMPXCHG16B`).
- **`fetch_add` returns the OLD value** and is one indivisible op — the right
  way to build a sequence number / slot allocator. `++` on a plain int is a lost-
  update race.
- **An atomic isn't free, and contention is the cost.** One hot atomic shared by
  many cores is a cache-line bounce + (on x86) a full fence. Lock-free is fast
  precisely when *uncontended*; under contention it can be slower than you hope.
- **The default `memory_order` is `seq_cst`** (the strongest, with a full
  fence). For counters that don't order other data, `relaxed` is correct and
  cheaper — but ordering is its own lesson; don't reach for `relaxed` without
  understanding it.
- **Atomicity ≠ ordering.** `std::atomic` gives you *both* by default, but they
  are separate guarantees; being able to separate them is what the next lesson
  is about.

## Key takeaways

1. **Atomic = indivisible**: no torn reads/writes, and the access is exempt from
   the data-race UB rule because the standard defines its behaviour.
2. Operations come in three families — **load, store, RMW** (`fetch_add`,
   `exchange`, `compare_exchange`). RMW is one indivisible step; that's why
   `fetch_add` beats `++`.
3. **`std::atomic<T>` is not always lock-free** — check
   **`is_always_lock_free`** (constexpr) and `static_assert` it in hot paths; a
   too-big `T` silently falls back to an internal mutex.
4. **`volatile` is not for threading** — it gives no atomicity and no inter-
   thread ordering. Use `std::atomic` for shared data, `volatile` only for MMIO.
5. On x86-64, atomic load/store is a plain `MOV`; an atomic **RMW uses the
   `LOCK` prefix** (e.g. `LOCK XADD`) and is also a full fence — **cheap
   uncontended (~tens of cycles), expensive when the line bounces between
   cores.**

## Self-check

1. Define "torn write" and give a concrete case where a plain `int64_t` store
   could tear.
2. Why is `counter.fetch_add(1)` correct where `counter++` (on a plain int) is a
   race? What does `fetch_add` return?
3. A colleague uses `volatile bool stop;` to signal a worker thread to exit.
   Name the two distinct guarantees `volatile` fails to provide.
4. What does `is_always_lock_free` tell you that `is_lock_free()` doesn't, and
   why do you care in a hot path?
5. To what x86 instruction does `fetch_add` compile, and what does the `LOCK`
   prefix actually do at the cache level?
6. You make a global counter `std::atomic` and throughput *drops* as you add
   cores. Why, and how would you fix it?

## Further reading

- [`std::atomic` — cppreference](https://en.cppreference.com/w/cpp/atomic/atomic) and [`atomic::is_always_lock_free`](https://en.cppreference.com/w/cpp/atomic/atomic/is_always_lock_free).
- [`std::atomic::fetch_add` — cppreference](https://en.cppreference.com/w/cpp/atomic/atomic/fetch_add).
- Herb Sutter — ["atomic<> Weapons" (the canonical atomics/memory-model talk)](https://herbsutter.com/2013/02/11/atomic-weapons-the-c-memory-model-and-modern-hardware/) — slides + video; required viewing.
- Anthony Williams, *C++ Concurrency in Action, 2nd ed.* — Ch. 5 ("The C++ memory model and operations on atomic types").
- Agner Fog, [instruction tables](https://www.agner.org/optimize/instruction_tables.pdf) — latency/throughput of `LOCK XADD`, `CMPXCHG`, etc. on real microarchitectures.
- [Why `volatile` is not useful for multithreading — Arthur O'Dwyer / the cppreference `volatile` notes](https://en.cppreference.com/w/cpp/language/cv) and Linux kernel doc "[Why the volatile type class should not be used](https://www.kernel.org/doc/html/latest/process/volatile-considered-harmful.html)".

## Videos

- Herb Sutter — **"atomic<> Weapons"** (C++ and Beyond) ([search](https://www.youtube.com/results?search_query=Herb+Sutter+atomic+weapons+C%2B%2B+memory+model)) — the definitive two-part talk on atomics and the memory model.
- Fedor Pikus — **"C++ atomics, from basic to advanced. What do they really do?"** (CppCon) ([search](https://www.youtube.com/results?search_query=Fedor+Pikus+C%2B%2B+atomics+from+basic+to+advanced)) — exactly this lesson, in depth.
