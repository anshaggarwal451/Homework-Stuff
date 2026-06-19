# std::vector

> **Why a quant dev must own this:** `std::vector` is the default container —
> the one you reach for 90% of the time, and the one whose *reallocation* and
> *iterator-invalidation* rules cause the most production bugs and the most
> interview follow-ups. In a hot path a stray reallocation is a multi-microsecond
> stall (an allocation plus copying/moving every element); a dangling iterator
> after a `push_back` is a silent corruption. Mastering size-vs-capacity,
> `reserve`, and growth policy is non-negotiable.

## First principles: a growable contiguous array

`std::vector<T>` is a **dynamically-sized, contiguous** sequence. The elements
live in one heap block, exactly like a C array, and the vector object itself is
three pointers:

```cpp
template <class T>
struct vector {           // conceptual layout
    T* begin_;            // start of the buffer
    T* end_;              // one past the last constructed element  → size()
    T* end_cap_;          // one past the allocated capacity        → capacity()
};
```

So `sizeof(std::vector<T>)` is ~24 bytes regardless of element count: three
pointers on the stack pointing at a heap buffer.

```text
 stack (the vector object)            heap (the buffer)
 +--------+--------+--------+
 | begin_ |  end_  |end_cap_|
 +---|----+---|----+---|----+
     |        |        |
     v        v        v
   [ e0 | e1 | e2 |  ?  |  ?  ]      capacity = 5, size = 3
   ^------- size -----^
   ^----------- capacity ----------^
```

## Size vs capacity — the central distinction

- **`size()`** = number of constructed elements you can index.
- **`capacity()`** = how many elements the current buffer can hold *before* it
  must reallocate.
- `capacity() >= size()` always; the gap is uninitialised raw storage reserved
  for future growth.

`push_back` constructs into the next free slot. When `size() == capacity()`,
there is no free slot, so the vector must **grow**: allocate a bigger buffer,
move/copy every existing element into it, destroy the old ones, and free the old
buffer. That single event is what you must learn to control.

```cpp
#include <vector>
std::vector<int> v;
v.reserve(0);                 // no-op
for (int i = 0; i < 6; ++i) {
    v.push_back(i);           // capacity grows 0→1→2→4→8 (typical libstdc++)
    // each "grow" reallocates and moves all current elements
}
// size()==6, capacity()>=6 (8 on a x2 policy)
```

## Geometric growth → amortized O(1) `push_back`

The vector doesn't grow by one slot at a time — that would make `n` pushes cost
O(n²) total. Instead it grows **geometrically**: each reallocation multiplies
capacity by a constant factor (commonly **2** in libstdc++/MSVC, **1.5** in
libc++ historically). The total work to insert *n* elements is then a geometric
series that sums to O(n), so each `push_back` is **amortized O(1)** even though
an individual one that triggers a grow is O(size).

> **Why 1.5 vs 2 — a real interview question.** With factor **2**, the new
> block is always larger than the sum of all previously freed blocks, so the
> allocator can *never reuse* the freed space for the next growth (it never
> coalesces back to a big-enough hole). A factor **below 2** (e.g. 1.5, or the
> golden ratio ~1.618) lets freed blocks eventually be reused, reducing
> fragmentation and peak memory — at the cost of slightly more frequent
> reallocations. It's a memory-vs-copy trade-off; both are valid, and the
> Standard only mandates *amortized* O(1), not a specific factor.

## `reserve` — the single most important hot-path habit

If you know (or can bound) the final size, call `reserve(n)` **once** up front.
It allocates capacity for `n` elements immediately, so subsequent `push_back`s
never reallocate, never move existing elements, and never invalidate
pointers/iterators:

```cpp
std::vector<Order> book;
book.reserve(expected_orders);    // one allocation, no growth churn
for (const auto& o : feed) book.push_back(o);   // each is true O(1), no realloc
```

Note `reserve` changes **capacity**, not **size** — it does *not* construct
elements (use `resize` for that). And `reserve` never *shrinks*.

## Iterator / pointer / reference invalidation rules

This is the rule set that catches everyone. For a `vector`:

| Operation | Invalidates |
|---|---|
| **reallocation** (`push_back`/`insert`/`resize`/`reserve` that grows past capacity) | **all** iterators, pointers, references |
| `insert`/`erase` in the middle (no realloc) | everything **at or after** the modification point |
| `push_back`/`emplace_back` with `size() < capacity()` | only `end()` (existing elements stay put) |
| `clear` | all iterators; pointers/refs to elements are now dangling |
| `pop_back` | iterator/ref to the removed (last) element and `end()` |

```cpp
std::vector<int> v{1,2,3};
int* p = &v[0];
v.push_back(4);     // if this reallocates, p now DANGLES — use-after-free if read
```

The senior fix: `reserve` enough up front (so no reallocation happens), or store
*indices* rather than pointers/iterators across mutations.

## Move-on-grow and the `noexcept` requirement

When a vector reallocates, it must transfer existing elements to the new buffer.
It would prefer to **move** them (cheap). But there's a catch: if a move
constructor could *throw* halfway through the transfer, the vector can't restore
its strong exception guarantee — half the elements would be moved-from and
unrecoverable. So the rule is:

> A vector will **move** elements on grow **only if** `T`'s move constructor is
> `noexcept` (or `T` is not copyable). Otherwise it falls back to **copying**
> them — potentially far slower.

```cpp
struct Slow {
    std::vector<int> data;
    Slow(Slow&&) /* not noexcept! */;   // vector will COPY these on every grow
};
struct Fast {
    std::vector<int> data;
    Fast(Fast&&) noexcept = default;     // vector MOVES these — fast
};
```

**Always mark your move constructor/assignment `noexcept`** (and `= default`
when you can). This is the most common reason a "move-only" type ends up copying
in production. Use `std::move_if_noexcept` if you implement such logic yourself.

## `emplace_back` vs `push_back`

`push_back` takes a `T` (constructing it at the call site, then moving/copying in).
`emplace_back` (C++11) forwards constructor *arguments* and constructs the
element **in place** in the vector's storage — no temporary:

```cpp
std::vector<Order> v;
v.push_back(Order{id, px, qty});   // build Order, then move it in
v.emplace_back(id, px, qty);        // construct Order directly in the buffer
```

For cheap/trivially-movable types the difference is negligible after
optimization; for types that are expensive to move, or to avoid writing the type
name, `emplace_back` wins. Note `emplace_back` returns a reference to the new
element (since C++17). One subtlety: `emplace_back` uses *direct* (not list)
initialization and can call `explicit` constructors, occasionally surprising you.

## Erase-remove idiom

`std::remove`/`remove_if` don't actually erase — they shuffle the kept elements
to the front and return an iterator to the new logical end; the tail is
unspecified. You then call `vector::erase` to drop the tail:

```cpp
#include <algorithm>
v.erase(std::remove_if(v.begin(), v.end(),
                       [](const Order& o){ return o.cancelled; }),
        v.end());                     // O(n), one pass, no per-element shift

std::erase_if(v, [](const Order& o){ return o.cancelled; });  // C++20: one call
```

C++20 added the free functions `std::erase` / `std::erase_if` so you rarely need
the two-iterator dance anymore — but interviewers still ask for it.

## `shrink_to_fit` and the `vector<bool>` trap

- **`shrink_to_fit()`** is a *non-binding request* to release unused capacity
  (it may reallocate to a smaller buffer, or do nothing). Use it after a big
  one-time shrink, never in a hot loop.
- **`std::vector<bool>` is not a real vector of `bool`.** It's a space-optimized
  bit-packed specialization: each element is a *bit*, `operator[]` returns a
  *proxy object* (not a `bool&`), `&v[0]` doesn't give you a `bool*`, and
  `data()` doesn't exist. It breaks generic code that assumes element references
  and contiguity. For an addressable byte-per-bool buffer use
  `std::vector<char>`/`std::uint8_t`, or `std::array`/`std::bitset` for fixed
  sizes. This is a classic gotcha.

## `data()` and the contiguity guarantee

The Standard guarantees a vector's elements are **contiguous**, and `data()`
returns a pointer to the first element such that `data() + i == &v[i]` for
`i < size()`. That makes `vector` directly usable with C APIs, `memcpy`, sockets,
and SIMD loads — one of the big reasons it beats node-based containers.

## Performance & hardware reality

- **Cache locality.** Contiguous storage means sequential traversal hits the
  hardware prefetcher perfectly and packs many elements per cache line. This is
  why `vector` typically **destroys `std::list`** even for workloads with "lots
  of insertions" — the constant factor from cache misses dwarfs the asymptotic
  advantage of linked lists (see the *std::list* lesson).
- **Reallocation is the expensive event.** It's an allocation + a full
  move/copy of every element + a free. Amortized it's cheap; *in a single hot
  call* it's a latency spike. `reserve` removes it.
- **Random access is O(1)** and trivially vectorizable. Insert/erase in the
  middle is O(n) (elements shift).
- **`size()`/`capacity()` are O(1)** pointer subtractions, not counts.

## Quant/HFT relevance & interview gotchas

- **`reserve` up front, always, on the hot path.** Size your books, message
  pools, and per-tick scratch buffers once at startup so no `push_back` ever
  reallocates during trading. An unexpected reallocation mid-burst is a textbook
  latency outlier.
- **Reuse, don't reallocate.** Keep a long-lived `vector`, `clear()` it each
  cycle (which keeps capacity), and refill — no allocator traffic.
- **`noexcept` your moves** so growth (or any vector reallocation of your type)
  moves instead of copies.
- **Never hold a pointer/iterator across a potentially-growing mutation.** Store
  an index, or `reserve` so no growth can occur.
- **Know the `vector<bool>` answer cold** — it's a near-guaranteed gotcha.
- **Default to `vector`** over `list`/`deque`/`map` unless you can articulate a
  measured reason not to; cache behaviour usually decides it.
- Be ready to explain **amortized O(1)** with the geometric-series argument and
  the **2 vs 1.5** memory/fragmentation trade-off.

## Key takeaways

1. `vector` is a **contiguous, heap-backed dynamic array**; the object is three
   pointers (`begin`/`end`/`end_cap`) → `size`, `capacity`.
2. It grows **geometrically** (×1.5–2), giving **amortized O(1) `push_back`**;
   each grow reallocates and move/copies all elements.
3. **`reserve(n)`** up front avoids reallocation and the invalidation it causes —
   the key hot-path habit.
4. **Reallocation invalidates everything**; mid-container insert/erase
   invalidates from that point on. Hold indices, not iterators, across mutations.
5. Mark moves **`noexcept`** so the vector moves on grow; know the
   **erase-remove idiom**, `shrink_to_fit` semantics, and the **`vector<bool>`**
   bit-packing trap.

## Self-check

1. What three pointers does a typical `vector` hold, and how do `size()` and
   `capacity()` derive from them?
2. Walk through why `n` `push_back`s on an empty vector total O(n), not O(n²).
3. A function does `auto* p = &v[0]; v.push_back(x); use(*p);`. When is this a
   use-after-free, and how do you fix it?
4. Why does a *non-`noexcept`* move constructor make vector growth slower?
5. Why is `std::vector<bool>` surprising? What would you use instead for a
   buffer you need to `memcpy`?
6. Give the erase-remove idiom to delete all elements equal to 0, and its C++20
   one-liner equivalent.

## Further reading

- [`std::vector` — cppreference](https://en.cppreference.com/w/cpp/container/vector) (see `reserve`, `capacity`, `data`, and the invalidation table).
- [Iterator invalidation rules — cppreference (Containers library)](https://en.cppreference.com/w/cpp/container#Iterator_invalidation)
- [`std::vector<bool>` — cppreference](https://en.cppreference.com/w/cpp/container/vector_bool) — the proxy/bit-packing specialization.
- Scott Meyers, *Effective STL*, Items 13–18 (prefer `vector`/`string`, use `reserve`, the `vector<bool>` non-container) — the canonical treatment.
- [`std::erase`/`std::erase_if` (C++20) — cppreference](https://en.cppreference.com/w/cpp/container/vector/erase2) and [`std::move_if_noexcept`](https://en.cppreference.com/w/cpp/utility/move_if_noexcept).
- [C++ Core Guidelines — Containers (SL.con)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#slcon-containers) — "use `vector` by default".

## Videos

- CppCon — Chandler Carruth, **"Efficiency with Algorithms, Performance with Data Structures"** (CppCon 2014) ([search](https://www.youtube.com/results?search_query=CppCon+2014+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures)) — the definitive "why contiguous wins" talk.
- CppCon — Bjarne Stroustrup, **"Are lists evil?"** discussion / **"Why you should avoid Linked Lists"** ([search](https://www.youtube.com/results?search_query=Stroustrup+vector+vs+list+are+lists+evil)) — vector-vs-list cache reality.
