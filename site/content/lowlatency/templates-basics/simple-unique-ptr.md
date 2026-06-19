# Simple unique_ptr

> **Why a quant dev must own this:** `unique_ptr` is the default owning pointer
> in modern C++ — it gives you RAII (deterministic cleanup, exception safety)
> with **provably zero overhead** over a raw pointer when the deleter is
> stateless. Implementing it from scratch forces you to confront move-only
> semantics, the rule of five, `noexcept`, and the empty-base optimization —
> the exact bundle of skills HFT interviews probe under "write me a smart
> pointer." If you can build this cleanly, you understand C++ resource
> management.

(Standard: **C++17**. Uses `noexcept`, defaulted/deleted special members, and
the empty-base optimization. C++20/23 notes flagged.)

## Problem statement

Implement a minimal `unique_ptr<T, Deleter>`:

- **Owns** a heap object and deletes it exactly once, at end of scope (RAII).
- **Move-only**: copy construction and copy assignment are deleted; ownership
  *transfers* on move.
- Supports `operator*`, `operator->`, `get()`, `release()`, `reset()`,
  `explicit operator bool`, and a swap.
- Accepts a **custom deleter** (default: `delete`), and adds **no size** when
  the deleter is stateless.

## Clarifying constraints & assumptions

- **Single object** (`T`), not arrays — the array form (`unique_ptr<T[]>`) needs
  `operator[]` and `delete[]`; mention it as a follow-up.
- **Deleter may be stateful or stateless.** Stateless (the common case) must cost
  zero extra bytes — that drives the EBO design below.
- **Exception safety:** the destructor and all ownership transfers must be
  `noexcept`. Deleters must not throw.
- **`nullptr` is a valid state** and calling the deleter on `nullptr` must be a
  no-op (`delete nullptr;` is legal and does nothing).

## Approach & tradeoffs

The naive design stores the pointer and the deleter as two members:

```cpp
T* ptr_;
Deleter del_;   // wastes a byte (padded to a word) even when Deleter is empty
```

For a stateless deleter (e.g. `std::default_delete<T>`, an empty class), that
member still occupies ≥1 byte and pads the struct — so `sizeof(unique_ptr)` would
be `2 * sizeof(void*)`. The real `std::unique_ptr` is **exactly one pointer**
for a stateless deleter. The fix is the **empty base optimization (EBO)**: a
base class of size 0 contributes 0 bytes to the derived object. We store the
deleter as a (possibly-empty) base of a compressed pair.

```text
two-member layout (stateless deleter):   [ ptr (8) ][ deleter (1) + pad (7) ]  = 16 bytes
EBO layout         (stateless deleter):   [ ptr (8) ]                          =  8 bytes  <- zero overhead
stateful deleter (e.g. fn pointer):       [ ptr (8) ][ deleter (8) ]           = 16 bytes  (unavoidable)
```

C++20 offers `[[no_unique_address]]` as a cleaner alternative to the EBO
base-class trick; we'll show the classic EBO form and note the C++20 version.

## Reference implementation

```cpp
#include <cstddef>
#include <utility>      // std::exchange, std::swap, std::move
#include <type_traits>  // std::is_empty_v

// ---- Default deleter: stateless, just calls delete ------------------------
template <class T>
struct default_delete {
    void operator()(T* p) const noexcept { delete p; }   // delete nullptr is a no-op
};

// ---- Compressed pair via EBO: stores ptr + (empty-or-not) deleter ----------
// If Deleter is an empty class, we inherit from it so it contributes 0 bytes.
// We specialize on whether Deleter is empty (and not final).
template <class T, class Deleter, bool = std::is_empty_v<Deleter> && !std::is_final_v<Deleter>>
struct ptr_box;                                  // primary template (declared)

// (a) EMPTY deleter: inherit from it -> zero bytes for the deleter.
template <class T, class Deleter>
struct ptr_box<T, Deleter, true> : private Deleter {
    T* ptr_ = nullptr;
    ptr_box() = default;
    ptr_box(T* p, Deleter d) noexcept : Deleter(std::move(d)), ptr_(p) {}
    Deleter&       get_deleter()       noexcept { return *this; }
    const Deleter& get_deleter() const noexcept { return *this; }
};

// (b) NON-EMPTY (stateful) deleter: store it as a member.
template <class T, class Deleter>
struct ptr_box<T, Deleter, false> {
    T*      ptr_ = nullptr;
    Deleter del_{};
    ptr_box() = default;
    ptr_box(T* p, Deleter d) noexcept : ptr_(p), del_(std::move(d)) {}
    Deleter&       get_deleter()       noexcept { return del_; }
    const Deleter& get_deleter() const noexcept { return del_; }
};

// ---- The smart pointer -----------------------------------------------------
template <class T, class Deleter = default_delete<T>>
class unique_ptr {
    ptr_box<T, Deleter> box_;   // ptr + (possibly zero-size) deleter

    T*&       ptr()       noexcept { return box_.ptr_; }
    T* const& ptr() const noexcept { return box_.ptr_; }

public:
    using pointer      = T*;
    using element_type = T;
    using deleter_type = Deleter;

    // --- construction ---
    constexpr unique_ptr() noexcept = default;
    constexpr unique_ptr(std::nullptr_t) noexcept {}
    explicit  unique_ptr(T* p) noexcept : box_(p, Deleter{}) {}   // take ownership
    unique_ptr(T* p, Deleter d) noexcept : box_(p, std::move(d)) {}

    // --- move-only: copy is DELETED ---
    unique_ptr(const unique_ptr&)            = delete;
    unique_ptr& operator=(const unique_ptr&) = delete;

    // --- move steals the pointer, leaving the source null ---
    unique_ptr(unique_ptr&& o) noexcept
        : box_(std::exchange(o.box_.ptr_, nullptr), std::move(o.box_.get_deleter())) {}

    unique_ptr& operator=(unique_ptr&& o) noexcept {
        if (this != &o) {                           // guard against self-move
            reset(o.release());                     // free what we hold, take o's pointer
            box_.get_deleter() = std::move(o.box_.get_deleter());
        }
        return *this;
    }

    unique_ptr& operator=(std::nullptr_t) noexcept { reset(); return *this; }

    // --- destructor: the whole point — deterministic, exception-safe cleanup ---
    ~unique_ptr() { reset(); }

    // --- observers ---
    T* get() const noexcept { return ptr(); }
    Deleter&       get_deleter()       noexcept { return box_.get_deleter(); }
    const Deleter& get_deleter() const noexcept { return box_.get_deleter(); }
    explicit operator bool() const noexcept { return ptr() != nullptr; }

    // --- dereference (UB if null, exactly like the standard one) ---
    T& operator*()  const noexcept { return *ptr(); }
    T* operator->() const noexcept { return ptr(); }

    // --- modifiers ---
    T* release() noexcept {                         // give up ownership, return raw ptr
        return std::exchange(ptr(), nullptr);
    }

    void reset(T* p = nullptr) noexcept {           // replace the managed object
        T* old = std::exchange(ptr(), p);
        if (old) get_deleter()(old);                // delete the OLD one, after the swap
    }

    void swap(unique_ptr& o) noexcept {
        using std::swap;
        swap(box_.ptr_, o.box_.ptr_);
        swap(box_.get_deleter(), o.box_.get_deleter());
    }
};

template <class T, class D>
void swap(unique_ptr<T, D>& a, unique_ptr<T, D>& b) noexcept { a.swap(b); }

// ---- factory: forwards constructor args (perfect forwarding) ---------------
template <class T, class... Args>
unique_ptr<T> make_unique(Args&&... args) {
    return unique_ptr<T>(new T(std::forward<Args>(args)...));
}
```

### Why the details matter

- **`std::exchange` in `release`/move** atomically (in the single-thread sense)
  reads the old pointer and stores `nullptr`, so the moved-from object is left in
  a valid null state — the canonical move-only idiom.
- **Order in `reset`**: store the new pointer *first*, then delete the old one.
  If the deleter (or a re-entrant call) touched `*this`, it would see the new,
  consistent state. This mirrors `std::unique_ptr::reset`'s specified order.
- **`explicit operator bool`** prevents accidental conversions like `int x = up;`
  while still allowing `if (up)`.
- **`noexcept` everywhere on the ownership operations** — required for the strong
  exception guarantees that containers rely on (a throwing move would break
  `vector` reallocation).
- **Copy is `= delete`, not just private** — gives a crisp diagnostic and
  participates correctly in overload resolution.

### Using it

```cpp
struct Order { int id; double px; Order(int i, double p):id(i),px(p){} };

auto a = make_unique<Order>(1, 100.5);   // owns a heap Order
auto b = std::move(a);                   // ownership transfers; a is now null
// auto c = b;                           // COMPILE ERROR: copy deleted (good)
b->px = 101.0;                           // operator->
(*b).id;                                 // operator*
Order* raw = b.release();                // hand ownership to C code, say
delete raw;                              // ...caller now responsible
// scope end: anything still owned is deleted exactly once

// Custom (stateful) deleter — pool free, file close, etc.:
auto closer = [](std::FILE* f){ if (f) std::fclose(f); };
unique_ptr<std::FILE, decltype(closer)> file(std::fopen("md.bin","rb"), closer);
```

## RAII + zero overhead — the senior framing

**RAII** ties the lifetime of a resource to the lifetime of an object: acquire
in the constructor, release in the destructor. Because C++ guarantees the
destructor runs at scope exit — **including when an exception unwinds the
stack** — the resource is freed on *every* path out, with no `goto cleanup`, no
double-free, no leak. `unique_ptr` is RAII for heap memory.

**Zero overhead** is the second half of the claim. With a stateless deleter and
EBO, `sizeof(unique_ptr<T>) == sizeof(T*)`, and every member function is a thin,
inlinable wrapper over a raw-pointer operation. The optimizer reduces
`up->field` to a single load and the destructor to a `delete`. You pay nothing
for the safety. Verify it:

```cpp
static_assert(sizeof(unique_ptr<int>) == sizeof(int*));   // EBO did its job
```

## Low-latency optimizations & reality

- **Stateless deleter → one pointer.** Confirm with the `static_assert` above. A
  function-pointer or capturing-lambda deleter makes it two words — prefer an
  empty functor (or `std::default_delete`) on hot paths.
- **No atomics.** Unlike `shared_ptr`, `unique_ptr` has *no* reference count and
  *no* atomic operations — moves are plain pointer assignments (~1 cycle). This
  is why "use `unique_ptr` unless you genuinely share" is the rule: `shared_ptr`
  pays atomic refcount traffic (often dozens of cycles under contention).
- **Allocation is the real cost.** The pointer mechanics are free; `new` is not.
  On a hot path, prefer a pool/arena allocator (a custom deleter that returns the
  slab to the pool) over the global allocator, or avoid heap ownership entirely.
- **`[[no_unique_address]]` (C++20)** lets you store the deleter as a normal
  member and *still* get zero size if it's empty — cleaner than the EBO base
  trick:

  ```cpp
  // C++20 sketch — no ptr_box specialization needed:
  T* ptr_ = nullptr;
  [[no_unique_address]] Deleter del_{};
  ```

## Follow-up variations interviewers ask

- **"Add the array specialization `unique_ptr<T[]>`."** → `operator[]`, and the
  deleter calls `delete[]`. The default deleter must be `default_delete<T[]>`.
- **"Why is `unique_ptr` move-only but `shared_ptr` copyable?"** → unique
  ownership vs shared ownership with a reference count — pivot to *shared_ptr*.
- **"What does `make_unique` give you over `unique_ptr<T>(new T)`?"** →
  exception safety in argument evaluation order, no `new` in user code, and
  perfect forwarding of the constructor args.
- **"Prove the zero-overhead claim."** → `sizeof` `static_assert` + read the asm.
- **"Converting `unique_ptr<Derived>` to `unique_ptr<Base>`."** → a templated
  converting move constructor (when `Derived*` is convertible to `Base*`); note
  the base needs a virtual destructor.

## Key takeaways

1. `unique_ptr` = **RAII for heap memory**: deterministic, exception-safe
   single-ownership; the destructor frees on every code path.
2. It is **move-only** — copy is `= delete`; move **transfers** ownership using
   the `std::exchange(ptr, nullptr)` idiom and leaves a valid null source.
3. The **empty base optimization** (or C++20 `[[no_unique_address]]`) makes a
   stateless deleter cost **zero bytes**, so `sizeof == sizeof(T*)`.
4. `reset` stores the new pointer *before* deleting the old; all ownership ops
   are `noexcept`; deleters must not throw.
5. **No refcount, no atomics** — moves are ~1-cycle pointer writes. Use
   `unique_ptr` by default; reach for `shared_ptr` only when ownership is truly
   shared.

## Self-check

1. Why is `sizeof(unique_ptr<int>)` equal to `sizeof(int*)`, and what design
   choice makes that true? When does it become two words?
2. Walk through what `release()` and `reset(p)` do, and why `reset` deletes the
   old pointer *after* swapping in the new one.
3. Why must the destructor and move operations be `noexcept`? What relies on it?
4. Why is copy `= delete` rather than just left out? What's the difference at the
   call site?
5. What does `make_unique` provide over `unique_ptr<T>(new T(...))`?
6. How would you support `unique_ptr<T[]>`, and what changes in the deleter?

## Further reading

- [`std::unique_ptr` — cppreference](https://en.cppreference.com/w/cpp/memory/unique_ptr) and [`std::make_unique`](https://en.cppreference.com/w/cpp/memory/unique_ptr/make_unique)
- [`std::default_delete` — cppreference](https://en.cppreference.com/w/cpp/memory/default_delete)
- [`std::exchange` — cppreference](https://en.cppreference.com/w/cpp/utility/exchange) — the move-only ownership-transfer idiom.
- [Empty base optimization — cppreference](https://en.cppreference.com/w/cpp/language/ebo) and [`[[no_unique_address]]`](https://en.cppreference.com/w/cpp/language/attributes/no_unique_address) (C++20).
- Scott Meyers, *Effective Modern C++*, Items 18 & 21 (`unique_ptr`, `make_unique`).
- [RAII — cppreference](https://en.cppreference.com/w/cpp/language/raii).

## Videos

- CppCon — **"Back to Basics: Smart Pointers"** (various years) ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Smart+Pointers)) — ownership, RAII, and the rule of five.
- CppCon — Herb Sutter, **"Leak-Freedom in C++ ... By Default"** ([search](https://www.youtube.com/results?search_query=CppCon+Herb+Sutter+Leak-Freedom+in+C%2B%2B)) — when to use which owning pointer.
