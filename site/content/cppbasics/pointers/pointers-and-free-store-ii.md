# Pointers & Free Store II

> **Why a quant dev must own this:** In an HFT engine the rule is *no `malloc`
> in the hot path*. You meet that rule by owning the allocation machinery:
> placement-new into preallocated arenas, custom `operator new`/`delete`,
> alignment that respects cache lines and AVX, and memory pools that hand out
> objects in O(1) with zero syscalls. This lesson is the toolbox between "I can
> call `new`" and "I control exactly where every byte lives." It is also where
> interview questions get genuinely discriminating.

## Separating allocation from construction: placement `new`

Recall from the previous lesson that `new T{}` does two things — *allocate* then
*construct*. **Placement new** lets you do only the second: construct a `T` in
storage you already own, at an address you choose. No allocation happens.

```cpp
#include <new>      // for placement new, std::launder
#include <cstddef>

alignas(int) std::byte buf[sizeof(int)];      // raw storage on the stack
int* p = new (buf) int{42};                   // construct an int *in* buf
// ... use *p ...
p->~int();                                    // you must call the dtor by hand
// (for int the dtor is trivial; for a real class this is mandatory)
```

Key facts:

- Placement new returns the address you gave it; it never allocates or throws.
- It is declared in `<new>` as `void* operator new(std::size_t, void* p)` and
  simply returns `p`.
- There is **no placement `delete`** to call — you destroy by invoking the
  destructor explicitly (`p->~T()`), then reuse or release the raw storage
  yourself.
- The storage must be **suitably sized and aligned** for `T` (note `alignas`
  above), or you get UB.

Placement new is the foundation of every container's "construct-in-place"
(`std::vector::emplace_back`, `std::optional`, small-buffer optimizations) and
of arena allocators below.

## Overloading `operator new` / `operator delete`

`new T` calls a replaceable/overridable function. You can hook it globally or
per-class to route allocations through your own allocator, add instrumentation,
or enforce an arena.

```cpp
#include <cstdio>
#include <cstdlib>
#include <new>

// --- Class-scoped: every `new Order` goes through here ---
struct Order {
    int  id;
    double px;

    static void* operator new(std::size_t n) {
        void* p = std::malloc(n);
        if (!p) throw std::bad_alloc{};
        std::printf("Order::new  %zu bytes -> %p\n", n, p);
        return p;
    }
    static void operator delete(void* p, std::size_t n) noexcept { // sized
        std::printf("Order::delete %p (%zu)\n", p, n);
        std::free(p);
    }
};
```

- The **allocation** function (`operator new`) only deals in raw bytes; it does
  *not* construct. Construction still happens in the `new` expression after it
  returns.
- A class `operator new`/`delete` is found by name lookup for `new Order` and
  `delete o`. A *global* replacement (`void* operator new(std::size_t)` at
  namespace scope) intercepts **everything**, including the standard library.
- Pair the array forms too: `operator new[]` / `operator delete[]`.

### Sized `operator delete`

Since C++14 the compiler can call a **sized** deallocation function
`operator delete(void*, std::size_t)`. Knowing the size up front lets allocators
that segregate by size class skip the lookup that maps a pointer back to its
size — a real speedup. If you provide both the sized and unsized forms, the
compiler prefers the sized one. Most custom pool allocators implement the sized
version for exactly this reason.

## `nothrow` new

By default `operator new` throws `std::bad_alloc` on failure. The `nothrow`
overload returns `nullptr` instead — useful when you cannot afford exceptions
(some HFT codebases compile `-fno-exceptions`) or want explicit failure
handling.

```cpp
#include <new>
int* p = new (std::nothrow) int[1'000'000];
if (!p) { /* handle out-of-memory without an exception */ }
```

Trade-off: you must now check the return value on every call, which is exactly
the discipline exceptions were meant to remove. Use it where the no-throw
contract genuinely matters.

## Alignment-aware allocation

Some types need alignment stronger than the default the allocator guarantees
(`alignof(std::max_align_t)`, typically 16). AVX-512 wants 64-byte alignment;
you may want 64 to put an object on its own **cache line** and avoid false
sharing between threads.

```cpp
#include <cstdlib>      // std::aligned_alloc (C++17)
#include <new>          // std::align_val_t

// (1) C-style, raw bytes. size MUST be a multiple of alignment.
void* raw = std::aligned_alloc(64, 64 * 16);   // 64-byte aligned
std::free(raw);                                 // free, NOT delete

// (2) Over-aligned type: the new-expression routes to the aligned overload.
struct alignas(64) CacheLine { double a, b, c, d; };  // 32 bytes, 64-aligned
CacheLine* c = new CacheLine;        // calls operator new(size, align_val_t{64})
delete c;                            // calls the aligned operator delete

// (3) Explicit alignment without an over-aligned type:
void* q = ::operator new(256, std::align_val_t{64});
::operator delete(q, std::align_val_t{64});
```

C++17 made the language **alignment-aware**: when a type's alignment exceeds the
default, the new-expression selects the `std::align_val_t` overloads of
`operator new`/`delete` automatically. If you overload `operator new` for an
over-aligned class, provide the `align_val_t` form or you will silently
under-align. (Pre-C++17: POSIX `posix_memalign` or `_mm_malloc`.)

## Arrays vs pointers: decay

An array is **not** a pointer, but it *decays* to one in most expressions: the
name `arr` converts to `&arr[0]`, a prvalue of type `T*`. The size is lost in
the conversion.

```cpp
int a[10];
static_assert(sizeof(a) == 40);        // the ARRAY knows its bytes
int* p = a;                            // decay: p = &a[0]
// sizeof(p) == 8  -> the size did NOT travel with the pointer

void f(int arr[10]);    // LIE: the parameter is really `int* arr`
void g(int (&arr)[10]); // reference-to-array: size preserved, no decay
```

Consequences: you cannot `sizeof` an array through a pointer parameter; pass a
size alongside, or take `T(&)[N]` by reference, or — best — use `std::span<T>`
(C++20) / `std::array<T,N>` which carry their extent.

## Multi-dimensional allocation

A true 2-D array is contiguous; "an array of pointers" is not. The difference
drives both performance and how you allocate.

```cpp
// (A) Contiguous row-major: one allocation, cache-friendly, index by hand.
int rows = 100, cols = 200;
int* m = new int[rows * cols];
m[r * cols + c] = 0;                    // a[r][c]
delete[] m;

// (B) Jagged "array of pointers": rows+1 allocations, pointer chase per row.
int** jag = new int*[rows];
for (int r = 0; r < rows; ++r) jag[r] = new int[cols];
// ... delete each row, then the row array ...
for (int r = 0; r < rows; ++r) delete[] jag[r];
delete[] jag;
```

Prefer (A) for numeric work — one block, predictable stride, vectorizable. (B)
incurs an extra indirection per access and scatters rows across the heap
(prefetcher-hostile). In practice use `std::vector<int>` sized `rows*cols`, or
`std::mdspan` (C++23) for a typed multi-dimensional view over flat storage.

## Custom allocators (teaser) and arena/pool allocation

This is the part HFT interviews care about. The standard containers accept an
**Allocator** template parameter so you can replace where their elements live:

```cpp
template <class T> struct MyAlloc {     // minimal C++17 allocator skeleton
    using value_type = T;
    T*   allocate(std::size_t n);       // get n*sizeof(T) bytes
    void deallocate(T* p, std::size_t n) noexcept;
};
std::vector<Order, MyAlloc<Order>> book;
```

But the real workhorse is an **arena (bump / region) allocator**: preallocate a
big block once at startup, then "allocate" by incrementing a pointer. There is
no per-object free list, no lock, no syscall — allocation is a few instructions,
and you reset the whole region at once.

```cpp
#include <cstddef>
#include <new>
#include <cstdint>

class Arena {
    std::byte*  base_;
    std::size_t cap_, off_ = 0;
public:
    explicit Arena(std::size_t cap)
        : base_(static_cast<std::byte*>(::operator new(cap))), cap_(cap) {}
    ~Arena() { ::operator delete(base_); }

    // O(1), no syscall, no lock. Bump the offset, align up, hand back a slot.
    void* allocate(std::size_t n, std::size_t align) {
        std::size_t cur  = reinterpret_cast<std::uintptr_t>(base_) + off_;
        std::size_t pad  = (align - (cur % align)) % align;
        if (off_ + pad + n > cap_) throw std::bad_alloc{};
        void* p = base_ + off_ + pad;
        off_ += pad + n;
        return p;
    }
    void reset() noexcept { off_ = 0; }   // "free" everything at once
};

// Construct an Order in the arena with placement new — zero heap traffic:
Arena a{1 << 20};                                  // 1 MiB, once
Order* o = new (a.allocate(sizeof(Order), alignof(Order))) Order{};
```

A **fixed-size pool (free-list) allocator** is the other staple: carve the block
into equal slots, thread a singly-linked free list through the unused ones, and
`allocate`/`deallocate` by pushing/popping the list head — O(1) and
fragmentation-free for that one size. This is how you recycle `Order` objects in
steady state without ever touching `malloc`.

> The HFT thesis in one line: **move all allocation to startup; in the hot path,
> hand out objects from a preallocated pool/arena with a pointer bump.** No
> `malloc`, no lock, no page fault, deterministic latency.

## `std::pmr` — polymorphic memory resources (C++17)

`std::pmr` makes custom allocation pluggable *at runtime* without templating
your whole codebase on an allocator type. A `std::pmr::memory_resource` is the
allocation strategy; `std::pmr::polymorphic_allocator` adapts it to containers.

```cpp
#include <memory_resource>
#include <vector>
#include <array>

std::array<std::byte, 1 << 16> buffer;       // 64 KiB stack arena
std::pmr::monotonic_buffer_resource pool{buffer.data(), buffer.size()};
std::pmr::vector<int> v{&pool};               // allocates from `pool`, not heap
v.reserve(1000);                              // served from the stack buffer
```

`monotonic_buffer_resource` is a bump arena; `unsynchronized_pool_resource` is a
pooled allocator. The win: `std::pmr::vector<int>` and `std::vector<int>` are
*different types*, but every `pmr` container shares one allocator type, so you
swap strategies by passing a different resource — ideal for benchmarking "heap
vs arena" without rewriting code.

## Performance & hardware reality

- **Bump allocation is ~a handful of instructions**; a general `malloc` may walk
  free lists, take a lock, and occasionally `mmap`. Determinism — not just mean
  latency — is the point: an arena has no tail-latency cliff.
- **Alignment matters for SIMD and false sharing.** Aligned loads avoid split
  cache lines; `alignas(64)` per-thread data prevents two cores fighting over
  one line.
- **Sized delete** removes a pointer→size lookup; pool allocators exploit it.
- **`reset()` beats N `free()`s.** Freeing an arena is one assignment; freeing
  thousands of objects individually is thousands of allocator operations.

## Quant/HFT relevance & interview gotchas

- **"How do you avoid `malloc` in the hot path?"** → preallocated arena/pool +
  placement new; reset between events. Be ready to write the bump allocator.
- **Over-aligned types pre/post C++17.** Know that C++17 auto-routes to
  `align_val_t` overloads, and that overloading `operator new` for an
  over-aligned class *without* the aligned form silently under-aligns.
- **`std::aligned_alloc` size must be a multiple of the alignment**, and you
  free it with `std::free`, never `delete`.
- **You must manually call the destructor** for placement-new'd objects; forget
  it and a non-trivial type leaks its own resources.
- **Array-of-pointers vs flat 2-D**: the flat layout is contiguous and
  vectorizable; the jagged one pointer-chases. Classic "which is faster and why"
  cache question.
- **`std::pmr` containers are distinct types** from their default-allocator
  cousins — a subtle gotcha when assigning between them.

## Key takeaways

1. **Placement new** constructs in storage you supply — no allocation; you must
   call the destructor by hand. It underpins arenas and containers.
2. Overload **`operator new`/`delete`** (class or global) to control raw
   allocation; provide the **sized** `delete` for fast pool reclamation.
3. **`nothrow` new** returns `nullptr` instead of throwing — handy under
   `-fno-exceptions`, at the cost of manual checking.
4. C++17 is **alignment-aware**: over-aligned types route to `align_val_t`
   overloads; use `alignas`/`std::aligned_alloc` for SIMD and cache-line needs.
5. Arrays **decay** to pointers and lose their size — pass `span`/`array` or a
   reference-to-array to keep it.
6. Prefer **flat, contiguous** multi-dimensional storage over arrays-of-pointers.
7. **Arena/pool allocators** + placement new give O(1), syscall-free, lock-free
   allocation — the standard HFT pattern; `std::pmr` makes it pluggable.

## Self-check

1. What does placement `new (p) T{}` allocate? How do you destroy the object,
   and why is there no "placement delete" to call?
2. You overload `static void* Order::operator new(size_t)`. After it returns,
   what step still runs before you have a usable `Order`?
3. Why does the compiler prefer a sized `operator delete(void*, size_t)` when
   present, and which allocators benefit?
4. A class is `alignas(64)`. Which `operator new` overload does `new T` select
   in C++17, and what breaks if you only overload the plain one?
5. Contrast a flat `int[rows*cols]` with `int**` for access cost and cache
   behaviour. Which vectorizes?
6. Sketch a bump-pointer `allocate(n, align)` and explain why `reset()` is
   cheaper than freeing each object.

## Further reading

- [`operator new` / replaceable allocation functions](https://en.cppreference.com/w/cpp/memory/new/operator_new) and [`operator delete`](https://en.cppreference.com/w/cpp/memory/new/operator_delete) — cppreference (covers placement, sized, nothrow, aligned forms).
- [`std::align_val_t`](https://en.cppreference.com/w/cpp/memory/new/align_val_t) and [`std::aligned_alloc`](https://en.cppreference.com/w/cpp/memory/c/aligned_alloc) — cppreference.
- [`<memory_resource>` / `std::pmr`](https://en.cppreference.com/w/cpp/memory/memory_resource) and [`monotonic_buffer_resource`](https://en.cppreference.com/w/cpp/memory/monotonic_buffer_resource) — cppreference.
- [Array-to-pointer decay & array declarations](https://en.cppreference.com/w/cpp/language/array) — cppreference.
- C++ Core Guidelines — [R.10/R.11: avoid `new`/`delete`](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-resource).
- Pablo Halpern's `pmr` proposal background, isocpp.org articles on polymorphic allocators.

## Videos

- CppCon 2017 — Bob Steagall, **"How to Write a Custom Allocator"** ([search](https://www.youtube.com/results?search_query=CppCon+2017+Bob+Steagall+How+to+Write+a+Custom+Allocator)).
- CppCon 2017 — Pablo Halpern, **"Allocators: The Good Parts"** ([search](https://www.youtube.com/results?search_query=CppCon+2017+Pablo+Halpern+Allocators+The+Good+Parts)).
- CppCon 2018 — Arthur O'Dwyer, **"An Allocator is a Handle to a Heap"** ([search](https://www.youtube.com/results?search_query=CppCon+2018+Arthur+O%27Dwyer+An+Allocator+is+a+Handle+to+a+Heap)).
