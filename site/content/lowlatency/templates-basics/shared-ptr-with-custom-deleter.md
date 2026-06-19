# shared_ptr with Custom Deleter

> **Why a quant dev must own this:** `shared_ptr` is the standard answer for
> *shared* ownership, and its design is a masterclass in **type erasure** and
> **atomic reference counting** — two ideas you must understand cold for HFT
> interviews and for knowing *when not to use it*. The killer detail:
> `shared_ptr<T>` does **not** encode the deleter in its type, yet it still
> calls the right deleter. How? A type-erased control block. Implementing it
> forces you to confront atomics, weak references, the aliasing constructor, and
> the real cost of every copy — a cost that, on a hot path, you usually want to
> avoid entirely.

(Standard: **C++17** — `std::atomic`, `if constexpr`, perfect forwarding. C++20
notes (`atomic<shared_ptr>`) flagged.)

## Problem statement

Implement a reference-counted `shared_ptr<T>` (plus `weak_ptr<T>`) that:

- Shares ownership; the managed object is destroyed when the **last**
  `shared_ptr` goes away; the **control block** when the last `weak_ptr` also
  goes away.
- Accepts an arbitrary **custom deleter** at construction — *without* that
  deleter's type appearing in `shared_ptr<T>`'s type.
- Uses **atomic** counts so copies/destroys across threads are safe.
- Supports the **aliasing constructor** (share ownership of A but point at a
  subobject B).

## Clarifying constraints & assumptions

- **Two counts, not one.** A *strong* count (how many `shared_ptr`s) controls the
  *object's* lifetime; a *weak* count (weak_ptrs + 1 while strong > 0) controls
  the *control block's* lifetime. You need both — a `weak_ptr` must be able to
  outlive the object yet still safely test "is it gone?".
- **Thread-safety scope.** The *reference counts* are atomic, so concurrent
  copies/destroys of distinct `shared_ptr` objects are safe. Concurrent
  *mutation of the same `shared_ptr` instance* is **not** safe (that needs
  `std::atomic<std::shared_ptr>`, C++20). State this — it's a classic gotcha.
- **Deleter type erased.** `shared_ptr<Widget>` constructed with a lambda deleter
  and another constructed with `delete` must have the *same type* so they're
  interchangeable in containers. The deleter lives behind a virtual interface in
  the control block.

## The core idea: a type-erased control block

A `shared_ptr<T>` is **two pointers**: one to the object (`T*`), one to a
**control block**. The control block holds the counts *and* the deleter — but the
control block is referred to through a **non-templated base interface**, so the
deleter's type is captured at *construction* and erased thereafter.

```text
shared_ptr<Widget>  sp                 control block (heap)
   ┌───────────────┐                   ┌──────────────────────────────┐
   │ T*   ptr_  ───┼──────────────►    │ atomic<long> strong_          │ ──► Widget object
   │ ctrl* ctrl_ ──┼──────────────►    │ atomic<long> weak_            │
   └───────────────┘                   │ virtual destroy_object()      │  <- knows the deleter
                                        │ virtual destroy_block()       │
                                        │ Deleter del_  (in derived)    │  <- TYPE captured here
                                        └──────────────────────────────┘
```

The deleter type `D` is "frozen" into a *derived* control-block class at the
point of construction; everything afterward speaks only to the virtual base. That
is why `shared_ptr<T>` needs no `D` template parameter — and why
`make_shared`/copies are uniform across deleters.

## Reference implementation

### 1. The control block — virtual base + templated derived

```cpp
#include <atomic>
#include <utility>
#include <memory>      // std::default_delete, std::allocator (concept only)

// --- non-templated base: this is all shared_ptr<T> ever talks to -----------
struct control_block_base {
    std::atomic<long> strong_{1};     // # of shared_ptr owners
    std::atomic<long> weak_{1};       // # of weak_ptr owners + 1 (the "self" weak)

    virtual void destroy_object() noexcept = 0;   // run the deleter on the object
    virtual ~control_block_base() = default;      // destroy the control block itself

    // --- strong refcount ---
    void add_strong() noexcept {
        strong_.fetch_add(1, std::memory_order_relaxed);   // just a count bump
    }
    void release_strong() noexcept {
        // acq_rel so the LAST decrementer sees all prior writes before deleting.
        if (strong_.fetch_sub(1, std::memory_order_acq_rel) == 1) {
            destroy_object();          // last strong owner -> destroy the object
            release_weak();            // drop the implicit "self" weak
        }
    }
    // --- weak refcount ---
    void add_weak() noexcept {
        weak_.fetch_add(1, std::memory_order_relaxed);
    }
    void release_weak() noexcept {
        if (weak_.fetch_sub(1, std::memory_order_acq_rel) == 1)
            delete this;               // last weak owner -> free the control block
    }
    // weak_ptr::lock(): atomically bump strong only if it's not already 0.
    bool try_add_strong() noexcept {
        long s = strong_.load(std::memory_order_relaxed);
        while (s != 0) {
            if (strong_.compare_exchange_weak(s, s + 1,
                    std::memory_order_acq_rel, std::memory_order_relaxed))
                return true;           // resurrected a live object
        }
        return false;                  // object already gone
    }
};

// --- derived block: captures the deleter's TYPE D (and the pointer) --------
template <class T, class D>
struct control_block : control_block_base {
    T* ptr_;
    [[no_unique_address]] D del_;      // C++20: zero bytes if D is stateless (e.g. default_delete)

    control_block(T* p, D d) : ptr_(p), del_(std::move(d)) {}
    void destroy_object() noexcept override { del_(ptr_); }   // <- the erased call
};
```

`destroy_object` is the type-erasure seam: at construction we knew `D`, so the
*derived* block's `destroy_object` calls `del_(ptr_)` with the real deleter;
`shared_ptr<T>` invokes it through the virtual base, never naming `D`.

### 2. `shared_ptr` — two pointers, count management

```cpp
template <class T> class weak_ptr;     // fwd

template <class T>
class shared_ptr {
    template <class U> friend class shared_ptr;
    template <class U> friend class weak_ptr;

    T*                  ptr_  = nullptr;   // what we point at (may differ from owned obj — aliasing)
    control_block_base* ctrl_ = nullptr;   // shared ownership bookkeeping

    shared_ptr(T* p, control_block_base* c) noexcept : ptr_(p), ctrl_(c) {}  // for weak_ptr::lock

public:
    constexpr shared_ptr() noexcept = default;
    constexpr shared_ptr(std::nullptr_t) noexcept {}

    // --- own a raw pointer with the DEFAULT deleter ---
    explicit shared_ptr(T* p)
        : ptr_(p), ctrl_(new control_block<T, std::default_delete<T>>(p, {})) {}

    // --- own a raw pointer with a CUSTOM deleter (D erased into the block) ---
    template <class D>
    shared_ptr(T* p, D d)
        : ptr_(p), ctrl_(new control_block<T, D>(p, std::move(d))) {}

    // --- copy: share, bump strong ---
    shared_ptr(const shared_ptr& o) noexcept : ptr_(o.ptr_), ctrl_(o.ctrl_) {
        if (ctrl_) ctrl_->add_strong();
    }
    // --- move: steal, no count change ---
    shared_ptr(shared_ptr&& o) noexcept
        : ptr_(std::exchange(o.ptr_, nullptr)), ctrl_(std::exchange(o.ctrl_, nullptr)) {}

    // --- aliasing constructor: share o's ownership, but point at `p` ---
    // Used for shared_ptr<Member> that keeps the parent alive.
    template <class U>
    shared_ptr(const shared_ptr<U>& o, T* p) noexcept : ptr_(p), ctrl_(o.ctrl_) {
        if (ctrl_) ctrl_->add_strong();
    }

    shared_ptr& operator=(shared_ptr o) noexcept {   // copy-and-swap (by value)
        swap(o); return *this;
    }

    ~shared_ptr() { if (ctrl_) ctrl_->release_strong(); }

    void swap(shared_ptr& o) noexcept {
        std::swap(ptr_, o.ptr_); std::swap(ctrl_, o.ctrl_);
    }
    void reset() noexcept { shared_ptr{}.swap(*this); }

    T* get() const noexcept { return ptr_; }
    T& operator*()  const noexcept { return *ptr_; }
    T* operator->() const noexcept { return ptr_; }
    long use_count() const noexcept {
        return ctrl_ ? ctrl_->strong_.load(std::memory_order_relaxed) : 0;
    }
    explicit operator bool() const noexcept { return ptr_ != nullptr; }
};
```

### 3. `weak_ptr` — observe without owning

```cpp
template <class T>
class weak_ptr {
    T*                  ptr_  = nullptr;
    control_block_base* ctrl_ = nullptr;
public:
    constexpr weak_ptr() noexcept = default;
    weak_ptr(const shared_ptr<T>& s) noexcept : ptr_(s.ptr_), ctrl_(s.ctrl_) {
        if (ctrl_) ctrl_->add_weak();          // weak count, NOT strong
    }
    weak_ptr(const weak_ptr& o) noexcept : ptr_(o.ptr_), ctrl_(o.ctrl_) {
        if (ctrl_) ctrl_->add_weak();
    }
    ~weak_ptr() { if (ctrl_) ctrl_->release_weak(); }

    bool expired() const noexcept {
        return !ctrl_ || ctrl_->strong_.load(std::memory_order_relaxed) == 0;
    }
    // lock(): atomically get a shared_ptr IF the object is still alive.
    shared_ptr<T> lock() const noexcept {
        if (ctrl_ && ctrl_->try_add_strong())
            return shared_ptr<T>(ptr_, ctrl_);  // strong already bumped by try_add_strong
        return {};
    }
};
```

### Using it

```cpp
struct Widget { int id; };

shared_ptr<Widget> a(new Widget{1});            // default deleter
auto closer = [](Widget* w){ /* return to pool */ delete w; };
shared_ptr<Widget> b(new Widget{2}, closer);    // CUSTOM deleter, same type as `a`

shared_ptr<Widget> v[] = { a, b };              // interchangeable: deleter not in the type
auto c = a;                                      // use_count(a) == 2 (atomic bump)

weak_ptr<Widget> w = a;                          // observe, doesn't keep it alive
if (auto s = w.lock()) { /* alive */ }           // safe upgrade

// aliasing: a shared_ptr to a member that keeps the whole Widget alive
shared_ptr<int> id(a, &a->id);                   // shares a's control block
```

`a` and `b` have the *same type* `shared_ptr<Widget>` despite different deleters
— that's the type-erasure payoff.

## Why the deleter type isn't in `shared_ptr`'s type (and the contrast)

`unique_ptr<T, D>` puts the deleter in its type — so it costs nothing (the
deleter can be a zero-size base) but the type is "infected": a
`unique_ptr<T, lambda1>` is a different type from `unique_ptr<T, lambda2>`,
which is why each lambda deleter spawns a distinct type.

`shared_ptr<T>` makes the opposite trade: the deleter is **type-erased into the
heap control block** behind a virtual call, so all `shared_ptr<T>` are one type
(uniform in containers, ABI-stable). The price is the control-block allocation
and a virtual dispatch on destruction — paid once, at the end of life, so it's
cheap. The *uniformity* is the feature.

```text
                 deleter in the type?   sizeof          allocation        copyable?
unique_ptr<T,D>  yes                     1 ptr (EBO)     none extra        no (move-only)
shared_ptr<T>    NO (erased)             2 ptrs          control block     yes (atomic refcount)
```

## The cost of an atomic refcount — the hot-path reality

Every `shared_ptr` **copy** is an atomic increment; every **destroy** an atomic
decrement (with an `acq_rel` on the decrement so the last one safely publishes
the object's destruction). These are not free:

- An uncontended atomic RMW (`lock xadd` on x86) is on the order of ~15–30
  cycles — far more than the single-cycle pointer write a `unique_ptr` copy or a
  raw-pointer copy costs.
- **Under contention** — multiple cores hammering the same count — the cache line
  holding the refcount ping-pongs between caches (cache-line bouncing), and cost
  balloons into the hundreds of cycles. This is a real, measured tax in
  multi-threaded code that shares the same `shared_ptr` widely.
- The strong and weak counts often share a cache line with each other; heavy
  weak/strong traffic can false-share even when logically independent.

> **Senior rule of thumb:** pass `shared_ptr` **by `const&`**, not by value, to
> avoid a refcount round-trip per call. Better: on a hot path, hold the object
> by `unique_ptr` or by value and pass a **raw pointer / reference** for
> non-owning access. "Share ownership" is a *design* decision with a *runtime*
> price — don't pay it by reflex.

```cpp
void process(const shared_ptr<Widget>&);   // good: no refcount traffic
void process(shared_ptr<Widget>);          // bad on hot path: copy = atomic inc + dec
void process(const Widget&);               // best when you don't need ownership
```

## Low-latency optimizations & reality

- **`make_shared` fuses two allocations into one.** `shared_ptr<T>(new T)` does
  *two* allocations (object + control block); `make_shared<T>(...)` does **one**
  (object and counts in a single block) — fewer allocator round-trips and better
  locality. Caveat: that single block lives until the last *weak_ptr* dies, so a
  long-lived `weak_ptr` to a `make_shared` object keeps the *object's storage*
  reserved.
- **Pass by `const&`**; reserve copies for when you actually transfer/extend
  ownership.
- **`memory_order_relaxed` on the increment, `acq_rel` on the decrement** — the
  increment needs no ordering (you already hold a reference), but the final
  decrement must synchronize-with all prior releases before the object is
  destroyed. Getting this wrong is a textbook lock-free bug.
- **Avoid `shared_ptr` in the inner loop.** Atomic refcount traffic and the extra
  indirection are exactly what a microsecond-sensitive path can't afford. It's an
  ownership tool, not a hot-data tool.

## Follow-up variations interviewers ask

- **"Why two counts?"** → a `weak_ptr` must safely outlive the object; the weak
  count keeps the *control block* alive after the object is destroyed so
  `expired()`/`lock()` remain valid.
- **"Implement `lock()` correctly."** → CAS loop that bumps strong **only if it's
  not zero** (`try_add_strong`) — a plain `if (!expired) add_strong()` races.
- **"Why is `make_shared` one allocation, and its downside?"** → fused block;
  storage held until last weak_ptr.
- **"`enable_shared_from_this`?"** → the object stores a `weak_ptr` to its own
  control block, set up when the first `shared_ptr` is constructed.
- **"Is copying a `shared_ptr` thread-safe? Mutating the same one?"** → copies of
  *distinct* instances: yes (atomic counts). Concurrent mutation of *one*
  instance: no — needs `std::atomic<std::shared_ptr<T>>` (C++20).
- **"Memory orders on the counts?"** → relaxed inc, acq_rel dec; justify.

## Key takeaways

1. `shared_ptr<T>` is **two pointers** (object + control block); the **control
   block** holds the counts and the deleter behind a **virtual interface**.
2. The deleter's type is **erased into a derived control block at construction**,
   so it is *not* part of `shared_ptr<T>`'s type — that's why all `shared_ptr<T>`
   are interchangeable, unlike `unique_ptr<T, D>`.
3. There are **two atomic counts**: *strong* governs the object's lifetime,
   *weak* (+1 self) governs the control block's, so `weak_ptr` can safely outlive
   the object.
4. **Atomic refcount is not free** — ~tens of cycles uncontended, far more under
   contention (cache-line bouncing). Pass by `const&`, prefer `make_shared`
   (single allocation), and keep `shared_ptr` out of hot loops.
5. Get the **memory orders** right: relaxed increment, `acq_rel` decrement so the
   last release publishes the object's destruction; `lock()` is a CAS-if-nonzero.

## Self-check

1. How can `shared_ptr<Widget>` call a lambda deleter without that lambda's type
   appearing in `shared_ptr`'s type? Where is the type captured?
2. Why are there two reference counts? What is each one's lifetime contract?
3. Why must `weak_ptr::lock()` use a compare-exchange loop rather than
   `if (!expired()) add_strong()`?
4. What memory orders go on the increment and decrement of the strong count, and
   why does the *last* decrement need acquire-release?
5. What does `make_shared` save over `shared_ptr<T>(new T)`, and what is its
   one downside with long-lived `weak_ptr`s?
6. Estimate the cost of passing a `shared_ptr` by value into a hot function
   called millions of times, and give the fix.

## Further reading

- [`std::shared_ptr` — cppreference](https://en.cppreference.com/w/cpp/memory/shared_ptr) and [the aliasing constructor](https://en.cppreference.com/w/cpp/memory/shared_ptr/shared_ptr) (constructor (8)).
- [`std::weak_ptr`](https://en.cppreference.com/w/cpp/memory/weak_ptr) and [`std::make_shared`](https://en.cppreference.com/w/cpp/memory/shared_ptr/make_shared).
- [`std::enable_shared_from_this`](https://en.cppreference.com/w/cpp/memory/enable_shared_from_this) and [`std::atomic<std::shared_ptr>`](https://en.cppreference.com/w/cpp/memory/shared_ptr/atomic2) (C++20).
- Anthony Williams, *C++ Concurrency in Action*, 2nd ed. — reference counting, memory orders, and `std::atomic<shared_ptr>`.
- [`std::memory_order` — cppreference](https://en.cppreference.com/w/cpp/atomic/memory_order) — the ordering used on the counts.
- Herb Sutter, [GotW #91 "Smart Pointer Parameters"](https://herbsutter.com/2013/06/05/gotw-91-solution-smart-pointer-parameters/) — how to pass `shared_ptr`/`unique_ptr` to functions.

## Videos

- CppCon — **"Back to Basics: Smart Pointers"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Smart+Pointers)) — control block, refcounting, weak_ptr.
- CppCon — Herb Sutter, **"Leak-Freedom in C++ ... By Default"** ([search](https://www.youtube.com/results?search_query=CppCon+Herb+Sutter+Leak-Freedom+in+C%2B%2B)) — ownership models and `shared_ptr` cost.
- CppCon — Fedor Pikus, **"C++ atomics, from basic to advanced"** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+atomics+from+basic+to+advanced)) — the atomic-refcount cost model behind `shared_ptr`.
