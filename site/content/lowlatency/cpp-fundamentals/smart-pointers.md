# Smart Pointers

> **Why a quant dev must own this:** smart pointers are RAII for heap ownership —
> they make leaks and double-frees structurally impossible. But the wrong one in
> the wrong place is a latency landmine: `shared_ptr` carries an **atomic**
> reference count, so every copy is a locked read-modify-write that bounces a
> cache line between cores, and `make_shared` allocates a control block you might
> not want. Knowing *which* smart pointer costs *what* — and why `shared_ptr`
> usually has no business in a hot tick-processing loop — is exactly the kind of
> "do you understand ownership *and* the hardware?" question HFT interviews
> probe.

## Intuition: pointers that own

A raw `T*` says nothing about ownership: who frees it? when? is it still alive?
Smart pointers encode the answer in the type:

- **`std::unique_ptr<T>`** — *sole* ownership. Exactly one owner; freed when it
  dies. Move-only.
- **`std::shared_ptr<T>`** — *shared* ownership. A reference-counted object freed
  when the last owner dies.
- **`std::weak_ptr<T>`** — a *non-owning* observer of a `shared_ptr` that can
  detect whether the object is still alive (breaks ownership cycles).

> **Mnemonic:** *unique = one owner, shared = many owners + a counter, weak =
> watcher with no vote.*

## `unique_ptr` — the default, and it's free

`unique_ptr` is your default heap-owning type. It is **zero-overhead**: it's the
size of a raw pointer (with the default deleter), and its operations compile to
the same `new`/`delete` you'd write by hand. It cannot be copied (that would
imply two owners); it can only be *moved*, which transfers ownership and nulls
the source.

```cpp
// C++17
#include <memory>

std::unique_ptr<Order> p = std::make_unique<Order>(id, qty);  // C++14+
// std::unique_ptr<Order> q = p;          // ERROR: not copyable
std::unique_ptr<Order> q = std::move(p);  // OK: ownership moves; p is now null

// Custom deleter (e.g. a C resource). Note: a stateful/function-pointer deleter
// makes unique_ptr larger than a raw pointer.
auto fd_closer = [](int* fd){ if (fd) ::close(*fd); delete fd; };
std::unique_ptr<int, decltype(fd_closer)> handle(new int(::open("x", 0)), fd_closer);
```

Prefer **`std::make_unique`** (C++14) over `new`: it's exception-safe in
argument evaluation and never leaks if a sibling argument throws.

## `shared_ptr` — and the control block

`shared_ptr` adds shared ownership via a heap-allocated **control block** that
holds two counts:

- **strong count** (`use_count`) — how many `shared_ptr`s own the object;
  reaches 0 → the object is destroyed.
- **weak count** — how many `weak_ptr`s (plus 1 while any strong exists) watch
  it; reaches 0 → the control block itself is freed.

So a `shared_ptr` is **two pointers** (to the object and to the control block),
and dereferencing it is one extra indirection away from a raw pointer.

```text
   shared_ptr A         shared_ptr B
   +---------+          +---------+
   | obj ptr |---+   +--| obj ptr |
   | ctl ptr |-+ |   | +| ctl ptr |
   +---------+ | |   | |
              v v   v v
            +-------------------+        +-----------+
            | control block     |        |  Order    |
            |  strong = 2       |  ----> |  (object) |
            |  weak   = 0(+1)   |        +-----------+
            |  deleter, alloc   |
            +-------------------+
```

### The atomic refcount cost

The strong/weak counts are **atomic** so that `shared_ptr`s can be copied and
destroyed across threads safely. Every copy increments, every destruction
decrements — each is a `lock`-prefixed read-modify-write (e.g. `lock xadd`):

```x86asm
; shared_ptr copy: atomic increment of the strong count
        lock xadd  [rax], rdx     ; ~15-30+ cycles uncontended; far worse contended
```

The damage:

- An uncontended atomic RMW is tens of cycles — already much more than the
  *zero* of a `unique_ptr` copy (which doesn't exist) or a raw-pointer copy.
- Under **contention**, the cache line holding the count ping-pongs between
  cores' L1s (MESI invalidation traffic). If two threads each hold a copy of the
  same `shared_ptr` and keep copying/destroying, you've manufactured false-ish
  sharing on the count — a classic latency cliff.
- The control block is a **second cache line** to keep hot, and a second
  allocation unless you use `make_shared`.

> **Atomicity is on the control block, not the object.** Two threads
> incrementing the *count* is safe; two threads mutating the pointed-to *object*
> is a data race exactly as with any other pointer. `shared_ptr` gives you safe
> *ownership* across threads, not safe *access*.

## `make_shared` vs `make_unique` vs `new`

```cpp
// C++17
auto a = std::make_unique<Order>(args);   // 1 allocation (the object)
auto b = std::make_shared<Order>(args);   // 1 allocation: object + control block FUSED
std::shared_ptr<Order> c(new Order(args)); // 2 allocations: object, then control block
```

`make_shared` fuses the object and control block into **one** allocation — fewer
calls to the allocator, and the count sits adjacent to the object (one cache
line, better locality). The catch:

- **`make_shared` keeps the object's storage alive as long as any `weak_ptr`
  lives**, because the fused block can't be freed piecemeal. If you create many
  long-lived `weak_ptr`s to large objects, the *memory* (not just the control
  block) lingers. With a separate `new` + `shared_ptr`, the object is freed at
  strong-count 0 and only the small control block waits for the weak count.
- `make_shared` can't use a custom deleter or `new[]`.

Default to `make_shared` unless you need a custom deleter or you have big objects
with long-lived `weak_ptr`s.

## `weak_ptr` — breaking cycles and safe observation

Two `shared_ptr`s pointing at each other never reach strong-count 0 → a leak.
`weak_ptr` is a non-owning handle you `lock()` to *temporarily* promote to a
`shared_ptr` if the object is still alive:

```cpp
// C++17
std::shared_ptr<Node> a = std::make_shared<Node>();
std::shared_ptr<Node> b = std::make_shared<Node>();
a->next = b;                 // shared_ptr: owns
b->prev = std::weak_ptr(a);  // weak_ptr: does NOT own -> no cycle

if (auto p = b->prev.lock()) {   // promote: nullptr if 'a' already died
    use(*p);                     // 'p' keeps it alive for this scope only
}
```

`weak_ptr::lock()` is itself an atomic operation (it must check-and-bump the
strong count race-free), so it isn't free either.

## When NOT to use `shared_ptr` in the hot path

Shared ownership is *occasionally* genuinely needed (an object whose lifetime is
truly determined by multiple, independent, racing owners). It is *usually*
reached for out of laziness, and it's the wrong tool when:

- **You actually have a clear owner.** Use `unique_ptr` and pass `T&` / `T*` /
  `std::span` to non-owning users. Borrowing ≠ owning. Passing a `const
  shared_ptr&` "to be safe" still costs the indirection and invites accidental
  copies.
- **It's on the per-tick / per-message path.** The atomic refcount churn and the
  extra cache line are pure tax on the most repeated code.
- **You only want polymorphism or nullability.** Those don't require shared
  ownership; `unique_ptr<Base>` or a raw observer pointer suffices.

```text
Decision guide
  clear single owner ........................ unique_ptr (free)
  function just borrows, doesn't keep ....... T& / T* / std::span (no smart ptr)
  genuinely shared, racing lifetimes ........ shared_ptr (accept the atomics)
  observe a shared object, may have died .... weak_ptr
  hot per-tick path ......................... avoid shared_ptr entirely;
                                              own once on a cold path, borrow in the loop
```

> **Senior answer to "why not `shared_ptr` everywhere?":** atomic refcount
> traffic and an extra indirection, paid on every copy and destruction, for an
> ownership model you usually don't have. Own once, borrow many.

## Performance & hardware reality

```text
Operation                                 rough cost
  raw pointer copy ......................  ~0 (a register move)
  unique_ptr move ......................  ~0 (pointer move + null-out)
  shared_ptr copy/destroy ..............  one atomic RMW each, ~15-30+ cyc uncontended
  shared_ptr copy under contention .....  cache-line ping-pong, can be 100s of cyc
  *shared_ptr deref ....................  one extra indirection vs raw (obj ptr then obj)
  weak_ptr::lock() .....................  atomic check-and-increment
```

Numbers are order-of-magnitude and microarchitecture-dependent — measure. The
durable truth: `unique_ptr` is free, `shared_ptr` is not, and the difference is
*atomics and cache lines*, the two things HFT code budgets most carefully.

## Quant/HFT relevance & interview gotchas

- **`unique_ptr` is zero-overhead** (with the default deleter); a custom
  stateful deleter or function pointer enlarges it.
- **`shared_ptr` refcounts are atomic** → tens of cycles per copy/destroy
  uncontended, far worse contended. State *why* (thread-safe shared ownership)
  and the cost (`lock xadd` + cache-line bouncing).
- **`shared_ptr` is two pointers and an extra indirection**; `unique_ptr` is one.
- **Atomicity is on the count, not the pointee** — `shared_ptr` is not a
  synchronization primitive for the object's data.
- **`make_shared` = one fused allocation** but keeps the object's *storage*
  alive while any `weak_ptr` exists; separate `new` frees the object earlier.
- **Pass borrowed objects by reference / `span`, not by `shared_ptr`.** Taking a
  `shared_ptr` by value in a callee forces a refcount bump per call.
- **`enable_shared_from_this`** is the right way to get a `shared_ptr` to `this`;
  never construct a second `shared_ptr` from a raw `this` (double-free).
- **Don't `std::move` a `unique_ptr` on `return`** (NRVO / implicit move handles
  it).

## Key takeaways

1. **`unique_ptr`** = sole ownership, move-only, **zero-overhead** with the
   default deleter — your default heap owner.
2. **`shared_ptr`** = shared ownership via a heap **control block** with
   **atomic** strong/weak counts; every copy/destroy is a locked RMW and an
   extra cache line.
3. **`weak_ptr`** = non-owning observer; `lock()` promotes to `shared_ptr` if
   still alive — use it to break ownership cycles.
4. Prefer **`make_unique`/`make_shared`** over `new` (exception-safe, one fused
   allocation for `make_shared`) — but know `make_shared` keeps object storage
   alive for the lifetime of any `weak_ptr`.
5. The atomicity protects the **count**, not the **object** — `shared_ptr` is not
   thread-safe access.
6. **Keep `shared_ptr` off the hot path:** own once on a cold path with
   `unique_ptr`, borrow with `T&`/`T*`/`std::span` in the loop.

## Self-check

1. Why can a `unique_ptr` be moved but not copied, and what does the move do to
   the source?
2. What's in a `shared_ptr` control block, and why are the counts atomic?
3. Roughly what does copying a `shared_ptr` cost uncontended, and what makes it
   dramatically worse under contention?
4. Give two reasons to prefer `make_shared`, and the one situation where a plain
   `new`+`shared_ptr` frees memory sooner.
5. A function only reads an object it doesn't keep. What parameter type should it
   take, and why is `shared_ptr<T>` by value wrong?
6. Two `shared_ptr`s reference each other. What happens, and how does `weak_ptr`
   fix it?

## Further reading

- [`std::unique_ptr`](https://en.cppreference.com/w/cpp/memory/unique_ptr), [`std::shared_ptr`](https://en.cppreference.com/w/cpp/memory/shared_ptr), [`std::weak_ptr`](https://en.cppreference.com/w/cpp/memory/weak_ptr) — cppreference, including thread-safety guarantees.
- [`std::make_shared` / `std::allocate_shared`](https://en.cppreference.com/w/cpp/memory/shared_ptr/make_shared) and [`std::make_unique`](https://en.cppreference.com/w/cpp/memory/unique_ptr/make_unique) — and the control-block fusion note.
- Scott Meyers, *Effective Modern C++*, Items 18-22 (`unique_ptr`, `shared_ptr`, `weak_ptr`, `make_*`, the Pimpl idiom) — the definitive practical treatment.
- [C++ Core Guidelines — Smart pointer rules (R.20-R.37)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#Rr-smartptrparam) — including "take smart pointers as parameters only to express lifetime semantics".
- [Herb Sutter, "GotW #91: Smart Pointer Parameters"](https://herbsutter.com/2013/06/05/gotw-91-solution-smart-pointer-parameters/) — exactly when to pass by value, by ref, or by raw pointer.
- [`std::enable_shared_from_this` — cppreference](https://en.cppreference.com/w/cpp/memory/enable_shared_from_this) — the safe way to get a `shared_ptr` to `this`.

## Videos

- CppCon — **"Back to Basics: Smart Pointers" (e.g. Rainer Grimm / David Olsen editions)** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Smart+Pointers)) — ownership semantics and costs.
- CppCon — **Herb Sutter, "Leak-Freedom in C++... By Default"** ([search](https://www.youtube.com/results?search_query=CppCon+Herb+Sutter+Leak+Freedom+in+C%2B%2B+by+default)) — when to use which pointer, and the cost of `shared_ptr`.
