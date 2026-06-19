# Segmented Deque

> **Why this matters for low-latency C++:** This is how `std::deque` actually
> works, and "explain the internals of `std::deque`" is a staple senior-C++
> interview question that most candidates fumble. A segmented deque — a **map of
> fixed-size blocks** — gives you O(1) push/pop at *both* ends, O(1) random
> access, and the property `vector` can't: **references and pointers to elements
> stay valid across growth**. For HFT that pointer stability is sometimes worth
> more than raw throughput (think long-lived order objects you hand around by
> pointer). Knowing exactly where it wins and where it loses to a flat array is
> the senior judgment this lesson is about.

All code is **C++17**. We build a simplified but faithful segmented deque, then
contrast it head-to-head with `vector` and the ring buffer on cache and
allocation.

## Problem statement

Implement a **double-ended queue** with:

- `push_front(x)` / `push_back(x)` — both **O(1)** (amortized).
- `pop_front()` / `pop_back()` — both **O(1)**.
- `operator[](i)` — **O(1)** random access.
- **Stable element addresses:** a pointer/reference to an element must remain
  valid as long as that element isn't popped, even as the deque grows at either
  end. (This is `std::deque`'s headline guarantee and the reason it exists
  alongside `vector`.)

## Clarifying constraints

- **Why not just two `vector`s, or a ring buffer?** A `vector` can't push_front
  in O(1) and *reallocates* (invalidating all pointers) on growth. A ring buffer
  is great but fixed-capacity / resizing-invalidates. The deque's niche is
  *unbounded both-ends growth with stable addresses* — name that niche up front.
- **Block size?** Fixed elements per block. Real `libstdc++` uses
  `max(1, 512 / sizeof(T))` (so larger `T` ⇒ fewer per block). Bigger blocks =
  fewer allocations + better locality but more wasted slack; smaller blocks =
  more pointer indirection. We'll parameterize it.
- **The "map" (index of blocks)?** A contiguous array of block pointers. When it
  fills, *it* gets reallocated — but that only moves the *pointers*, not the
  elements, so element addresses stay stable. This indirection is the key trick.
- **Single-threaded.** As with the rest of the module.
- **Random access exactness?** `operator[]` must map a logical index to
  `(block, offset)` with arithmetic, accounting for a possibly-partial first
  block. This is the fiddly part.

## The structure: a map of fixed blocks

Two levels of indirection. A **map** (array of pointers) points at **blocks**
(fixed-size arrays of `T`). Elements live in the blocks; the map just indexes
them. Growth at either end allocates a new *block* and records its pointer in
the map; the map itself reallocates rarely, and only the *pointers* move.

```text
              map_ (array of T* block pointers)
            +-----+-----+-----+-----+-----+-----+
            |  .  |  .  | B0* | B1* | B2* |  .  |   (spare map slots both ends)
            +-----+-----+--|--+--|--+--|--+-----+
                           |     |     |
                  +--------+     |     +--------+
                  v              v              v
   block B0:  [ . | . | A | B ] [ C | D | E | F ] [ G | H | . | . ]  : B2
              first block        full middle       last block
              partially used                       partially used

  front lives at B0[2]=A,  back lives at B2[1]=H.
  push_back into B2[2]; when B2 fills, allocate a new block, store ptr in map.
  push_front into B0[1]; when B0 fills, allocate a new block "before" it.
```

Why this gives the guarantees:

- **O(1) push/pop both ends:** just bump a cursor within the end block, or
  allocate one new block and slot its pointer into the (pre-spared) map.
- **Stable addresses:** an element never moves once placed. Growing the deque
  allocates *new* blocks and may reallocate the *map of pointers*, but the
  blocks themselves (and the `T`s in them) stay put. `&deque[i]` is stable until
  popped.
- **O(1) random access:** logical index → `(block_index, offset)` by division /
  modulo by block size (with the first block's start offset folded in), then two
  dereferences (`map_[block_index][offset]`).

## Complexity

| Operation | Time | Invalidation |
|-----------|:----:|:------------:|
| `push_back` / `push_front` | amortized O(1) | iterators invalidated; **pointers/refs to existing elements: NOT** |
| `pop_back` / `pop_front` | O(1) | only the popped element |
| `operator[]` | O(1) (a div/mod + two loads) | — |
| construct | O(1) | — |

Contrast the invalidation column with `vector`: `vector::push_back` on growth
invalidates *everything*. The deque invalidates iterators but **not** pointers
or references to other elements — that's the whole point.

## Reference implementation

```cpp
// C++17. A simplified std::deque-style segmented deque: a map of fixed blocks.
// O(1) push/pop at both ends, O(1) random access, STABLE element addresses.
#include <cstddef>
#include <new>
#include <utility>
#include <vector>
#include <cassert>

template <class T, std::size_t BlockSize = (sizeof(T) < 256 ? 512 / sizeof(T) : 1)>
class SegmentedDeque {
    static_assert(BlockSize >= 1, "block must hold at least one element");

    // A block is raw, T-aligned storage for BlockSize elements (placement-new'd).
    struct Block { alignas(T) unsigned char bytes[BlockSize * sizeof(T)]; };

    std::vector<Block*> map_;   // array of block pointers (the index)
    // We address elements by a global cursor pair into the map + block.
    // first_/last_ are GLOBAL element positions: element k lives in
    //   map_[k / BlockSize][k % BlockSize], for k in [first_, last_).
    std::size_t first_ = 0;     // index of the front element (inclusive)
    std::size_t last_  = 0;     // index one past the back element (exclusive)
    std::size_t map_base_ = 0;  // global index represented by map_[0], block 0

    T* slot(std::size_t k) {                    // global k -> &element
        std::size_t g = k - map_base_;          // offset from block-0 start
        return reinterpret_cast<T*>(map_[g / BlockSize]->bytes)
             + (g % BlockSize);
    }

    Block* new_block() { return new Block; }    // one block allocation
    void   del_block(Block* b) { delete b; }

    // Ensure there is a block covering global index k; allocate if needed.
    void ensure_block_for(std::size_t k) {
        std::size_t g = k - map_base_;
        std::size_t bi = g / BlockSize;         // desired block slot in map_
        while (bi >= map_.size()) map_.push_back(new_block());   // grow back
        if (map_[bi] == nullptr) map_[bi] = new_block();
    }

public:
    SegmentedDeque() {
        // Start in the middle of one block so both ends have room to grow.
        map_.push_back(new_block());
        map_base_ = 0;
        first_ = last_ = BlockSize / 2;         // grow-room on both sides
    }

    SegmentedDeque(const SegmentedDeque&)            = delete;
    SegmentedDeque& operator=(const SegmentedDeque&) = delete;

    ~SegmentedDeque() {
        for (std::size_t k = first_; k < last_; ++k) slot(k)->~T();  // destroy live
        for (Block* b : map_) del_block(b);                          // free blocks
    }

    std::size_t size()  const noexcept { return last_ - first_; }
    bool        empty() const noexcept { return first_ == last_; }

    template <class... Args>
    void emplace_back(Args&&... args) {
        ensure_block_for(last_);                // block for the new back slot
        ::new (slot(last_)) T(std::forward<Args>(args)...);
        ++last_;
    }
    void push_back(const T& v) { emplace_back(v); }
    void push_back(T&& v)      { emplace_back(std::move(v)); }

    template <class... Args>
    void emplace_front(Args&&... args) {
        if (first_ == map_base_) {              // would underflow block 0:
            map_.insert(map_.begin(), new_block());  // prepend a block (moves
            map_base_ -= BlockSize;             //   only POINTERS in map_)
        }
        --first_;
        ::new (slot(first_)) T(std::forward<Args>(args)...);
    }
    void push_front(const T& v) { emplace_front(v); }
    void push_front(T&& v)      { emplace_front(std::move(v)); }

    void pop_back()  { assert(!empty()); --last_;  slot(last_)->~T(); }
    void pop_front() { assert(!empty()); slot(first_)->~T(); ++first_; }

    T&       back()       { return *slot(last_ - 1); }
    T&       front()      { return *slot(first_); }
    T&       operator[](std::size_t i)       { return *slot(first_ + i); }  // O(1)
    const T& operator[](std::size_t i) const {
        return *const_cast<SegmentedDeque*>(this)->slot(first_ + i);
    }
};
```

> **Note:** this is a *teaching* implementation — it favors clarity over
> production polish. A real `std::deque` keeps the map small by recentering it
> instead of unbounded `map_.push_back`, reuses emptied end blocks instead of
> leaving them allocated, and handles `map_base_` underflow more carefully. Say
> so in an interview; the goal is to demonstrate the *map-of-blocks* mechanism
> and the stability/locality consequences, not to clone libstdc++.

What earns the points:

- **Two-level indirection is the whole idea.** Map indexes blocks; blocks hold
  elements. Random access is `map_[k/B][k%B]` — O(1) via a divide and two loads.
- **Stability falls out of it.** `emplace_front` that needs a new block does
  `map_.insert(...)`, which reallocates the *pointer array* — but every existing
  `Block*` still points at the same block, so every `T`'s address is unchanged.
  That's why `&deque[i]` survives growth and `&vector[i]` does not.
- **Placement new + per-element destruction over the live range** `[first_,
  last_)` — same raw-storage discipline as the ring buffer; we don't construct
  `BlockSize` objects per block up front.
- **Block size depends on `sizeof(T)`** (the `512/sizeof(T)` heuristic), trading
  per-block slack against indirection frequency.

## Contrast with `std::vector` and the ring buffer

```text
                    push_front  random   pointer-stable   cache         alloc
                    O(1)?       access?  on growth?       locality      pattern
  vector            NO (O(n))   O(1)     NO (realloc)      BEST (flat)   1 big block, doubles
  ring buffer       n/a (FIFO)  O(1)     NO (resize)       BEST (flat)   1 block (fixed/resize)
  segmented deque   YES         O(1)     YES               GOOD (blocky) many small blocks
  linked list       O(1)        O(n)     YES               WORST         1 alloc per element
```

The deque sits between the flat array and the linked list:

- **vs `vector`:** the deque wins on push_front (O(1) vs O(n)) and pointer
  stability; `vector` wins on cache locality (one contiguous run vs scattered
  blocks) and has *less* indirection per access (one load vs map→block). For
  pure back-insertion with no stability needs, `vector`/ring buffer wins.
- **vs linked list:** the deque is *far* more cache-friendly (a whole block's
  worth of elements is contiguous, and `operator[]` is O(1)), and amortizes
  allocation across `BlockSize` elements instead of one alloc per element. It
  keeps the linked list's pointer-stability and both-ends-O(1), without the
  per-element-allocation and pointer-chasing tax.

### Cache and allocation reality

- **Allocation:** one `new` per *block*, i.e. one per `BlockSize` pushes —
  amortized, but still non-deterministic on block boundaries (and the *map*
  reallocates occasionally). Not zero-alloc. For an HFT hot path you'd pool the
  blocks (same trick as lesson 2) or preallocate the map and blocks.
- **Cache:** within a block, elements are contiguous and prefetcher-friendly.
  Across a block boundary you take an indirection through the map and jump to a
  new region — a likely cache miss every `BlockSize` elements. So a deque iterate
  is "mostly streaming, with a hiccup per block." `vector` has no hiccups; linked
  list is *all* hiccups.
- **Random access cost:** `operator[]` is O(1) but does an integer divide
  (block index) — pricier than `vector`'s single add+load. Power-of-two
  `BlockSize` lets the compiler turn the `/` and `%` into shift/mask.

> **HFT judgment:** reach for a segmented deque when you need **stable element
> addresses under both-ends growth** — e.g. a pool of long-lived order objects
> referenced by raw pointer elsewhere, where a `vector` realloc would dangle
> them. If you only push/pop one end and never hand out long-lived pointers, a
> preallocated ring buffer or `vector` will be faster and simpler. The deque is a
> *stability* tool, not a *speed* tool.

## Follow-up variations interviewers ask

- **"How does `std::deque` actually lay out memory?"** Exactly this: a map
  (array of block pointers) plus fixed-size blocks; `libstdc++` block size is
  `max(1, 512/sizeof(T))` bytes-worth. Iterators are fat (current, block-begin,
  block-end, map-node). This is the question this lesson exists to answer.
- **"Why are `std::deque` iterators so heavy / why is iterating it slower than
  `vector`?"** The fat iterator must detect block boundaries; each boundary is an
  indirection + likely cache miss. Hence `vector` iterates faster despite both
  being O(n).
- **"Is `push_back` on a deque ever O(n)?"** The *element* placement is O(1), but
  the **map** can reallocate (amortized O(1), like vector's). And `deque`
  guarantees pointer stability of *elements*, not iterators — iterators are
  invalidated by growth.
- **"Make random access branch-/divide-free."** Use a power-of-two `BlockSize`
  so `/` and `%` become shift and mask.
- **"How would you make this allocation-deterministic for HFT?"** Pool the
  blocks (free-list of `Block`s, lesson 2), preallocate the map to its max size
  (no `insert`/`push_back` mid-run), and `mlock` the lot. Now it's a
  stable-address deque with no hot-path `new`.
- **"`deque` vs `list` for a work queue?"** `deque` almost always: same O(1)
  ends, vastly better locality, O(1) index. `list` only if you need O(1)
  splice/erase-from-middle with held iterators.

## Key takeaways

1. A segmented deque is a **map (array of pointers) of fixed-size blocks** — two
   levels of indirection that buy O(1) push/pop at both ends, O(1) random access,
   and **stable element addresses across growth**.
2. **Stability is the differentiator:** growth allocates new blocks and may
   reallocate the *pointer map*, but never moves existing elements — so
   `&deque[i]` survives growth where `&vector[i]` does not.
3. **Random access** maps logical index → `(k/B, k%B)` then two loads; use a
   power-of-two block size to turn the `/`,`%` into shift/mask.
4. **Cache/alloc tradeoff:** contiguous *within* a block (good), an indirection +
   likely miss *between* blocks (a hiccup every `BlockSize` elements), and one
   `new` per block instead of per element — better than a linked list, worse than
   a flat `vector`.
5. **It's a stability tool, not a speed tool.** Use it when you hand out
   long-lived pointers/references under both-ends growth; otherwise a
   preallocated ring buffer / `vector` is faster. For HFT, pool the blocks and
   preallocate the map to kill hot-path allocation.

## Self-check

1. Draw the map-of-blocks layout for a deque of 6 elements with `BlockSize = 4`,
   showing where `front` and `back` live and the spare slots.
2. Precisely why does `&deque[i]` stay valid across a `push_back` that grows the
   deque, while `&vector[i]` does not?
3. Derive the `operator[]` index math from a logical index `i` to a
   `(block, offset)` pair, accounting for the front element not starting at
   block 0 offset 0.
4. Why are `std::deque` iterators "fat," and how does that make iteration slower
   than `vector`'s despite both being O(n)?
5. When is a segmented deque the *wrong* choice versus a preallocated ring
   buffer, and when is it the *only* right choice?
6. List the changes needed to make this deque allocation-deterministic for an
   HFT hot path.

## Further reading

- [`std::deque` — cppreference](https://en.cppreference.com/w/cpp/container/deque) — the interface and the invalidation guarantees (pointers stable, iterators not).
- [libstdc++ `std::deque` implementation](https://github.com/gcc-mirror/gcc/blob/master/libstdc%2B%2B-v3/include/bits/stl_deque.h) — the real map-of-blocks, fat iterators, and the `512/sizeof(T)` block-size rule.
- [libc++ `std::deque` implementation](https://github.com/llvm/llvm-project/blob/main/libcxx/include/deque) — a second, differently-tuned production design to compare.
- Scott Meyers, *Effective STL*, Item 1 & 4 — choosing among `vector`/`deque`/`list` and the cost of their differences.
- [Bjarne Stroustrup, "Are lists evil?"](https://www.stroustrup.com/bs_faq.html#list) — the locality argument that also explains why `deque` beats `list`.
- [What Every Programmer Should Know About Memory (Drepper)](https://people.freebsd.org/~lstewart/articles/cpumemory.pdf) — §3 caches; quantifies the per-block-boundary miss.

## Videos

- CppCon — Chandler Carruth, **"Efficiency with Algorithms, Performance with Data Structures"** ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures)) — why blocky/scattered layouts cost you and when contiguity wins.
- CppCon — Bob Steagall, **"If You Can't Open It, You Don't Own It"** / container-internals talks ([search](https://www.youtube.com/results?search_query=CppCon+Bob+Steagall+std+deque+internals)) — dissecting standard container memory layouts.
- CppCon — Timur Doumler, **"Want fast C++? Know your hardware!"** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+want+fast+c%2B%2B+know+your+hardware)) — caches, indirection, and the cost of pointer hops between blocks.
