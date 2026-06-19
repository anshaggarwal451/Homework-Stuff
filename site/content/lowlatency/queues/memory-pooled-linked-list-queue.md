# Memory-Pooled Linked List Queue

> **Why this matters for low-latency C++:** The previous lesson identified the
> linked-list queue's worst sin — a `new` on every `enqueue` and a `delete` on
> every `dequeue`. In an HFT system, *any* call to the general allocator on the
> tick-to-trade path is unacceptable: it's slow on average and, far worse,
> *non-deterministic* — the one time `malloc` has to take a lock or hit the
> kernel is the microsecond you lose the trade. This lesson removes the
> allocator from the hot path entirely with a **free-list object pool**:
> allocate once at startup, recycle nodes forever, never touch `new` again.

All code is **C++17**. The pool technique here is the single most important
"no allocation in the hot path" pattern in the book — it reappears for messages,
orders, and events all over a trading stack.

## Problem statement

Take the singly linked FIFO from the previous lesson and make it so that, after
an initial warm-up, **no `enqueue` or `dequeue` ever calls the global allocator.**

Requirements:

- Same O(1) `enqueue` / `dequeue` / `front` interface.
- Preallocate a fixed number of nodes up front (a *slab*).
- On `dequeue`, return the node to a **free list** for reuse rather than freeing
  it.
- On `enqueue`, pop a node from the free list (allocator-free) instead of `new`.
- Construct/destroy the element `T` in place with **placement new** and an
  explicit destructor call, so the pool only deals in raw storage.

## Clarifying constraints

- **Bounded or unbounded pool?** Two policies, and you should name both:
  1. **Hard bound** — the pool is fixed; `enqueue` *fails* (returns `false` /
     throws / asserts) when empty. This is the HFT-honest choice: deterministic,
     no surprise allocation, you sized it from capacity planning.
  2. **Grow on exhaustion** — allocate another slab when the free list is empty.
     Amortizes allocation but reintroduces a rare hot-path `new`. Acceptable
     only if growth is genuinely off-path (e.g. logged and alarmed).
  We'll implement the hard-bound version and show the growth hook.
- **Thread-safety?** Single-threaded, as before. A pool shared across threads
  needs its own synchronization (or per-thread pools — usually the right answer).
- **Element lifetime?** The node's storage outlives any individual `T`. `T` is
  alive only between the placement-new in `enqueue` and the destructor call in
  `dequeue`. The pool must never assume `T` is constructed in free nodes.
- **Alignment?** The raw storage must be aligned for `T`. We use
  `std::aligned_storage`-equivalent via `alignas`.

## Approach: slab + intrusive free list

The key realization: a node is either **live** (in the queue, holding a `T` via
its `next` chain) or **free** (in the pool, available). A node is never both —
so we can **reuse the same `next` pointer** to thread the free list. No extra
memory for the pool's bookkeeping; the free list is *intrusive*.

```text
SLAB (one contiguous allocation, done once at startup):

  [ Node | Node | Node | Node | Node | Node | Node | Node ]
     ^ raw aligned storage for T + a next pointer, each

FREE LIST (intrusive, threads through unused nodes via `next`):

  free_head -> [N3] -> [N5] -> [N0] -> ... -> nullptr

LIVE QUEUE (the FIFO, same nodes, same `next` field):

  head -> [N1] -> [N4] -> [N2] -> nullptr <- tail

enqueue: pop a node off free_head, placement-new T into it, link at tail.
dequeue: destroy T, unlink from head, push the node back onto free_head.
```

Because the slab is one contiguous block, nodes start out cache-adjacent — a
bonus over the scattered `new` version, at least until recycling shuffles them.

## Complexity

| Operation | Time | Allocator calls (steady state) |
|-----------|:----:|:------------------------------:|
| construct pool (capacity N) | O(N) once | 1 (the slab) |
| `enqueue` | O(1) | **0** |
| `dequeue` | O(1) | **0** |
| `front` / `empty` / `size` | O(1) | 0 |

The whole point is the last column: zero allocator traffic on the hot path,
which converts a high-variance operation into a flat, predictable one.

## Reference implementation

```cpp
// C++17. Single-threaded FIFO with an intrusive free-list object pool.
// After construction, enqueue/dequeue make ZERO calls to the global allocator.
#include <cstddef>
#include <memory>      // std::align, placement new via <new>
#include <new>         // ::operator new / placement new
#include <utility>
#include <vector>
#include <cassert>

template <class T>
class PooledQueue {
    // A node is raw, correctly-aligned storage for one T, plus a link.
    // `next` does double duty: live-queue link AND free-list link.
    struct Node {
        alignas(T) unsigned char storage[sizeof(T)];
        Node* next;

        T*       value()       { return reinterpret_cast<T*>(storage); }
        const T* value() const { return reinterpret_cast<const T*>(storage); }
    };

    std::vector<Node> slab_;        // owns the raw node storage (one alloc)
    Node* free_head_ = nullptr;     // intrusive free list of unused nodes
    Node* head_      = nullptr;     // queue front (dequeue end)
    Node* tail_      = nullptr;     // queue back  (enqueue end)
    std::size_t size_ = 0;

    // Pop a free node, or nullptr if the pool is exhausted.
    Node* acquire() noexcept {
        Node* n = free_head_;
        if (n) free_head_ = n->next;
        return n;
    }
    // Return a node to the pool (its T must already be destroyed).
    void release(Node* n) noexcept {
        n->next = free_head_;
        free_head_ = n;
    }

public:
    // Preallocate `capacity` nodes and thread them onto the free list.
    explicit PooledQueue(std::size_t capacity) : slab_(capacity) {
        for (std::size_t i = 0; i < capacity; ++i)
            release(&slab_[i]);     // every node starts free
    }

    PooledQueue(const PooledQueue&)            = delete;
    PooledQueue& operator=(const PooledQueue&) = delete;
    // (Move is omitted for brevity: the live nodes hold raw self-pointers into
    //  slab_, so a correct move must rebase head_/tail_/free_head_. In practice
    //  pools are constructed in place and never moved — pin them at startup.)

    ~PooledQueue() {
        // Destroy only the LIVE elements; free nodes never had a T constructed.
        while (head_) {
            head_->value()->~T();
            head_ = head_->next;
        }
        // slab_ frees the raw storage automatically.
    }

    // O(1), allocation-free. Returns false if the pool is exhausted (hard bound).
    template <class... Args>
    [[nodiscard]] bool try_emplace(Args&&... args) {
        Node* n = acquire();
        if (!n) return false;                      // pool full: caller decides
        ::new (n->storage) T(std::forward<Args>(args)...);  // placement new
        n->next = nullptr;
        if (tail_) tail_->next = n;
        else       head_ = n;                      // was empty
        tail_ = n;
        ++size_;
        return true;
    }

    [[nodiscard]] bool enqueue(const T& v) { return try_emplace(v); }
    [[nodiscard]] bool enqueue(T&& v)      { return try_emplace(std::move(v)); }

    // O(1), allocation-free. Precondition: !empty().
    T dequeue() {
        Node* old = head_;
        T result = std::move(*old->value());  // move element out
        old->value()->~T();                   // explicitly destroy the T
        head_ = old->next;
        if (head_ == nullptr) tail_ = nullptr;
        release(old);                          // recycle node, NO delete
        --size_;
        return result;
    }

    T&       front()       { return *head_->value(); }
    const T& front() const { return *head_->value(); }

    bool        empty() const noexcept { return head_ == nullptr; }
    std::size_t size()  const noexcept { return size_; }
    std::size_t capacity() const noexcept { return slab_.size(); }
};
```

What to point at when you walk an interviewer through this:

- **Placement new + explicit destructor are mandatory, not optional.** The slab
  holds *raw bytes*; `T` is only alive between `::new (storage) T(...)` and
  `value()->~T()`. Skip the destructor and you leak resources held by `T` (e.g.
  a `std::string`'s heap buffer) even though the node memory is recycled.
- **The intrusive free list costs zero extra memory.** Reusing `next` is the
  elegant part — a node is live *or* free, never both, so one pointer serves
  both lists.
- **`acquire` returning `nullptr` is a feature.** The hard-bound pool makes
  exhaustion *explicit and branchable* (`[[nodiscard]] bool`), instead of a
  silent `new` that ruins your tail latency. You size the pool from capacity
  planning, not hope.
- **`alignas(T)` storage.** Without it, `reinterpret_cast<T*>(storage)` on an
  over-aligned `T` (e.g. a 64-byte-aligned cache-line type) is UB.

## Low-latency optimizations

### Pre-fault the slab at startup

`std::vector<Node>(capacity)` *allocates* the pages but the OS may not have
*mapped* them until first touch — so your first hot-path `enqueue` eats a page
fault (microseconds). Pre-touch every page during warm-up, off the critical
path:

```cpp
// Walk the slab once at startup so every page is resident before trading.
for (auto& n : slab_) { volatile unsigned char* p = n.storage; *p = *p; }
// (Or memset the slab; or mlock() it to prevent the pages being swapped out.)
```

`mlock()`/`mlockall()` to pin the pages and prevent the kernel reclaiming them
mid-session is standard practice in production HFT.

### Keep recycled nodes "hot" — LIFO free list

Our `release`/`acquire` push and pop the free list at the **head** (LIFO). That
is deliberate: the node you just freed is the most cache-hot, and handing it
straight back out on the next `enqueue` maximizes the chance it's still in L1.
A FIFO free list would do the opposite. Small win, free to take.

### Cache-line-size the node, or pad against false sharing

If this pool is ever touched by two threads (e.g. a producer pool and a consumer
returning nodes), pad nodes to a cache line (`alignas(64)`) so adjacent nodes
don't share a line and ping-pong between cores. For the single-threaded case,
*don't* pad — you'd waste cache. Know which world you're in.

### Branchless-ish enqueue

The `if (tail_) ... else ...` in `enqueue` is a predictable branch (empty is
rare in steady state), so it predicts near-perfectly — leave it. Don't
micro-optimize a branch the predictor already nails; spend the effort on the
allocation you actually eliminated.

### Growth hook (when a hard bound is unacceptable)

If you must grow, allocate a *new slab* (don't `realloc` — that would invalidate
every live `Node*`), and push its nodes onto the free list:

```cpp
std::vector<std::vector<Node>> extra_slabs_;  // keep old slabs alive

void grow(std::size_t n) {                    // OFF the hot path!
    extra_slabs_.emplace_back(n);
    for (auto& node : extra_slabs_.back()) release(&node);
}
```

Note: growing means raw `Node*` into a *new* allocation, so you must keep every
slab alive for the queue's lifetime (hence `extra_slabs_`). And you must **never
move** the slabs — pointer stability is the whole contract.

## Follow-up variations interviewers ask

- **"Why not just use `std::pmr::monotonic_buffer_resource` /
  `unsynchronized_pool_resource`?"** Great answer — the standard PMR pools
  implement exactly this idea and let you plug them into `std::list`/`std::deque`
  via `std::pmr` containers. Hand-rolling is for when you need a specific policy
  (hard bound, intrusive node) or to demonstrate you understand the mechanism.
- **"Is `reinterpret_cast<T*>(storage)` legal?"** With `alignas(T)` storage and
  having actually placement-`new`'d a `T` there, yes — you're accessing the
  object through a pointer to its real type. (Pedantically, since C++17 prefer
  `std::launder` after placement new if the compiler might assume the storage is
  unchanged; mainstream compilers are fine here, but mention `std::launder` to
  show you know the rule.)
- **"What about `std::aligned_storage`?"** It does the same job but is
  *deprecated in C++23* in favor of `alignas(T) std::byte[sizeof(T)]` — which is
  what we used. Knowing it's deprecated is a current-knowledge signal.
- **"How do you size the pool?"** From the maximum in-flight depth, not the
  total throughput. A queue that drains as fast as it fills needs capacity =
  peak burst, not total messages. Measure the high-water mark.
- **"Double-free / use-after-free risk?"** The classic pool bug is releasing a
  node twice (it ends up on the free list twice → handed out twice → two live
  `T`s in one slot). In debug builds, tag nodes or assert on double-release.

## Key takeaways

1. **An object pool removes the allocator from the hot path:** allocate one slab
   at startup, recycle nodes via an **intrusive free list**, and `enqueue` /
   `dequeue` make *zero* `new`/`delete` calls — converting variance into
   determinism.
2. **`next` does double duty** (live link and free link) because a node is live
   *xor* free — the free list costs no extra memory.
3. **Placement new + explicit `~T()`** are mandatory: the slab is raw storage,
   and `T` is alive only between those two calls. Forgetting the destructor leaks
   anything `T` owns.
4. **Hard-bound is the HFT-honest default:** exhaustion returns `false`, an
   explicit branch you control, rather than a silent latency-spiking `malloc`.
   Size the pool from the in-flight high-water mark.
5. **Warm the pool** (pre-fault / `mlock`) and use a **LIFO free list** to keep
   recycled nodes cache-hot. Don't pad nodes unless two threads share the pool.

## Self-check

1. Why can the free list reuse the node's `next` pointer instead of needing its
   own bookkeeping?
2. What exactly leaks if you skip `old->value()->~T()` in `dequeue` for
   `T = std::string`, even though the node memory is recycled?
3. Why must `grow()` allocate a *new* slab rather than resizing the existing
   `std::vector<Node>`?
4. The first `enqueue` after startup is mysteriously slow even though no `new`
   runs. What's happening, and how do you fix it?
5. Why a LIFO free list rather than FIFO for recycled nodes?
6. When is `std::launder` relevant here, and why do mainstream compilers
   usually "work" without it?

## Further reading

- [`std::pmr::unsynchronized_pool_resource` — cppreference](https://en.cppreference.com/w/cpp/memory/unsynchronized_pool_resource) and [`monotonic_buffer_resource`](https://en.cppreference.com/w/cpp/memory/monotonic_buffer_resource) — the standard-library object pools.
- [Placement new — cppreference](https://en.cppreference.com/w/cpp/language/new#Placement_new) and [`std::launder`](https://en.cppreference.com/w/cpp/utility/launder) — the lifetime rules you're leaning on.
- [`alignas` — cppreference](https://en.cppreference.com/w/cpp/language/alignas) — correct over-aligned raw storage (the modern replacement for deprecated `std::aligned_storage`).
- Pablo Halpern, ["The C++17 Polymorphic Memory Resources"](https://www.youtube.com/results?search_query=Pablo+Halpern+polymorphic+memory+resources) talk/notes — PMR pools in depth.
- [`mlock(2)` — Linux man page](https://man7.org/linux/man-pages/man2/mlock.2.html) — pinning pool pages so they're never reclaimed mid-session.
- Andrei Alexandrescu, *Modern C++ Design*, ch. 4 ("Small Object Allocation") — the classic treatment of fixed-size object pools.

## Videos

- CppCon — Pablo Halpern, **"Allocators: The Good Parts"** ([search](https://www.youtube.com/results?search_query=CppCon+Pablo+Halpern+allocators+the+good+parts)) — PMR and pool resources, the standard way to do this.
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why no allocation is allowed on the trading path.
- CppCon — Bob Steagall, **"How to Write a Custom Allocator"** ([search](https://www.youtube.com/results?search_query=CppCon+Bob+Steagall+custom+allocator)) — building pool/slab allocators from scratch.
