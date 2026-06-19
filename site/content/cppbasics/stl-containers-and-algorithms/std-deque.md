# std::deque

> **Why a quant dev must own this:** `std::deque` is the container everyone *uses
> without knowing it* — it's the default engine under `std::stack` and
> `std::queue`, the obvious pick for a FIFO of events or messages. Its headline
> trick is **O(1) push at both ends**, which `std::vector` can't match at the
> front. But it is *not* contiguous, it has more indirection than a vector, and
> in a latency-critical path it's usually the wrong default. Interviewers love
> probing whether you actually understand its segmented layout.

## First principles: why a double-ended queue exists

`std::vector` grows cheaply at the **back** (amortized O(1)) but `push_front` is
O(n) — every element shifts up one slot. A `std::deque` ("deck", **d**ouble-**e**nded
**que**ue, `<deque>`, C++98) is designed so that **both** `push_front` and
`push_back` are **amortized O(1)**, while keeping random access `operator[]` in
O(1). It buys that with a more elaborate, *segmented* memory layout.

```cpp
#include <deque>
std::deque<int> d;
d.push_back(1);    // O(1) at the back
d.push_front(0);   // O(1) at the front  <-- vector can't do this cheaply
int x = d[5];      // O(1) random access (with extra indirection vs vector)
```

## Mechanics: segmented storage (map of chunks)

A deque is **not** one big array. It is an array of fixed-size **chunks** (a.k.a.
*blocks* / *nodes*), plus a small **map** — an array of pointers, one per chunk —
that tracks them. Elements within a chunk are contiguous; chunks themselves are
separately heap-allocated and scattered.

```text
        map (array of chunk pointers, itself heap-allocated)
        ┌────┬────┬────┬────┬────┐
        │ p0 │ p1 │ p2 │ p3 │ p4 │
        └─┬──┴─┬──┴─┬──┴─┬──┴─┬──┘
          │    │    │    │    └──────────────► (unused / reserved for growth)
          │    │    │    └──► chunk3 [ E E E E E E E E ]
          │    │    └──────► chunk2 [ E E E E E E E E ]   ← contiguous WITHIN a chunk
          │    └───────────► chunk1 [ E E E E E E E E ]
          └────────────────► chunk0 [ _ _ _ _ _ E E E ]   ← front lives mid-chunk
                                       ▲           ▲
                            growth room at front   first live element

  push_front fills chunk0 leftward; when full, allocate a new chunk and
  store its pointer in the slot left of p0. push_back grows rightward likewise.
  Only the MAP itself ever reallocates (rarely), and only it copies pointers.
```

Why this gives O(1) at both ends: growing at an end usually just writes into spare
room in the end chunk, or allocates **one** new chunk and stores its pointer in
the map. Neither touches existing elements. Compare `std::vector::push_front`,
which moves all n elements.

### Random access costs an extra indirection

`d[i]` is O(1) but not as cheap as `vector`'s. The deque must compute *which
chunk* `i` falls in and the *offset within* it — roughly `map[(start + i) /
chunk_size][(start + i) % chunk_size]`. That's an integer divide/modulo, two
dependent loads (map → chunk → element), versus a vector's single `base + i*size`
and one load. So: same big-O, larger constant, and one more potential cache miss.

### Not contiguous — no `.data()`

Because storage is split across chunks, **a deque has no `.data()` member** and
you **cannot** pass it to a C API expecting a flat buffer, hand it to a
memcpy/scatter-gather call, or treat it as a single span. This is a hard,
frequently-asked distinction from `vector`. Iterating a deque is fine (iterators
hop chunk to chunk transparently), but there is no one pointer to "the array."

### Reference/pointer vs iterator stability

A subtle, heavily-tested rule set:

| Operation | Pointers/references to existing elements | Iterators |
|---|---|---|
| `push_back` / `push_front` | **stay valid** | **all invalidated** |
| `pop_back` / `pop_front` | stay valid (except popped element) | invalidated at the popped end (others OK) |
| insert/erase in the **middle** | invalidated | invalidated |

The headline: **inserting at either end keeps pointers and references stable**
(elements never move — a new chunk just gets linked in), **but invalidates all
iterators** (the iterator must track its position in the map, which may shift).
`std::vector` is the opposite — a reallocating `push_back` invalidates *both*.
That reference stability at the ends, combined with O(1) end-growth, is sometimes
the actual reason to choose deque.

## Why it's the default for stack and queue

`std::stack` and `std::queue` are *adapters* (see [adapter
containers](./adapter-containers.md)) that wrap an underlying container; both
default to **`std::deque`**. The reasoning:

- A `queue` needs **push at one end, pop at the other** — exactly deque's O(1)
  both-ends strength, and a vector would be O(n) at one end.
- A `stack` only needs one end, but deque is a safe default that never invalidates
  references on growth and never does a giant reallocation/copy spike the way a
  growing vector does.

You can override the backing container (e.g. `std::stack<T, std::vector<T>>`) — and
for a stack, a `vector` is often *faster* on real hardware thanks to contiguity.
That trade-off is a classic interview follow-up.

## Implementation differences: chunk size

The chunk size is unspecified — implementations differ, which surprises people
benchmarking across platforms:

| Library | Chunk (block) size heuristic |
|---|---|
| **libstdc++** (GCC) | `max(512 bytes, sizeof(T))` worth of elements — i.e. bigger objects → fewer per chunk |
| **libc++** (Clang) | `max(16, 4096 / sizeof(T))` elements per block — a fixed 4 KB-ish target |
| **MSVC STL** | historically *tiny*: `max(1, 16 / sizeof(T))` elements — notoriously few-per-chunk for large `T`, hence pathological allocation behavior |

The MSVC case is infamous: for a large `T`, each chunk holds **one** element, so a
deque degenerates into a node-per-element list with all the allocation and
cache-miss cost that implies. Don't assume deque behaves identically across
toolchains.

## Performance and hardware reality

- **Iteration** is decent — within a chunk you stream contiguously and the
  prefetcher helps — but you take a branch/indirection at each chunk boundary, so
  it trails a flat `vector`.
- **Random access** carries the divide/modulo + double indirection above; in a
  tight indexed loop it loses to `vector`.
- **Memory** is fragmented across chunks + a map; worse spatial locality, and the
  allocator is touched on every chunk boundary crossed during growth.
- **The win is purely the O(1) front operations and end-reference-stability.** If
  you don't need those, `vector` is almost always the faster choice.

> **Rule of thumb:** reach for `deque` only when you genuinely push/pop at *both*
> ends (or need end-growth without moving existing elements). For everything else,
> default to `vector` and measure.

## Quant/HFT relevance & interview gotchas

- **Rarely in the hot path.** A deque's indirection, scattered chunks, and
  per-chunk allocation are exactly what low-latency code avoids. A bounded **ring
  buffer over a flat array** (`std::array` / preallocated `std::vector` with
  head/tail indices) gives true contiguity, zero allocation, and O(1) both-ends —
  the structure you'd actually use for a message/event queue between threads.
- **"Is `deque` contiguous? Does it have `.data()`?"** — No and no. The single
  most common gotcha; people conflate it with `vector`.
- **Iterator vs reference invalidation on `push_front`/`push_back`** — references
  survive, iterators don't. The inverse of `vector`. Know this cold.
- **`std::stack`/`std::queue` default to deque** — and you can/should sometimes
  swap in `vector` for a stack.
- **Cross-platform chunk size differs** (esp. MSVC's tiny blocks) — beware
  benchmarks that don't reproduce.
- **No `reserve`.** `std::deque` has no `reserve()` (you can't usefully pre-size a
  segmented structure the way you pre-size a vector). Another `vector`-vs-`deque`
  distinction.

## Key takeaways

1. `std::deque` gives **O(1) amortized `push_front` *and* `push_back`** plus O(1)
   random access — its reason to exist.
2. Storage is **segmented**: fixed-size **chunks** linked by a **map** (array of
   pointers). It is **not contiguous** and has **no `.data()`**.
3. Random access pays an **extra indirection** (chunk lookup + divide/modulo) over
   `vector`; iteration crosses chunk boundaries.
4. End insertion **keeps pointers/references valid but invalidates all
   iterators** — the inverse of `std::vector`.
5. It is the **default backing container for `std::stack` and `std::queue`**
   because of cheap both-ends growth.
6. **Chunk size is implementation-defined** (libstdc++ ≠ libc++ ≠ MSVC; MSVC's is
   pathologically small for large `T`).
7. In HFT it's **rarely in the hot path** — a flat ring buffer or `vector`
   usually wins on locality and allocation behavior.

## Self-check

1. Why is `std::vector::push_front` O(n) while `std::deque::push_front` is O(1)?
   What does the deque do instead of shifting?
2. After `d.push_back(x)`, which of the following stay valid: a pointer to `d[0]`,
   a reference to `d.front()`, an iterator obtained before the push? Explain.
3. You need to hand a contiguous buffer to a C `recv()`-style API. Can you use a
   `std::deque`? Why not, and what would you use?
4. How does `d[i]` translate into actual memory accesses, and why is it slower
   than `v[i]` for a vector despite both being O(1)?
5. Why might the same deque benchmark behave very differently on MSVC vs GCC?
6. For a single-producer/single-consumer message queue in a latency path, why
   would you prefer a preallocated ring buffer over `std::deque`?

## Further reading

- [`std::deque` — cppreference](https://en.cppreference.com/w/cpp/container/deque) (note the absence of `data()` and `reserve()`)
- [`std::deque` iterator-invalidation table — cppreference container reference](https://en.cppreference.com/w/cpp/container#Iterator_invalidation)
- [libstdc++ `<deque>` implementation header](https://github.com/gcc-mirror/gcc/blob/master/libstdc%2B%2B-v3/include/bits/stl_deque.h) — see `_S_buffer_size()` for the chunk-size heuristic
- [libc++ `<deque>` block-size logic](https://github.com/llvm/llvm-project/blob/main/libcxx/include/deque) — the `__block_size` computation
- [STL `std::deque` overview — Microsoft Learn](https://learn.microsoft.com/en-us/cpp/standard-library/deque-class) — and the historically small MSVC block size
- Scott Meyers, *Effective STL*, Item 1 ("Choose your containers with care") and Item 2 (beware the illusion of container-independent code) — the contiguity/`data()` distinction matters here.
- [Boost.Circular Buffer](https://www.boost.org/doc/libs/release/doc/html/circular_buffer.html) — the bounded ring-buffer alternative for the hot path.

## Videos

- Bjarne Stroustrup — **"Are Lists Evil?" / contiguous-vs-node-based containers** ([search](https://www.youtube.com/results?search_query=Bjarne+Stroustrup+are+lists+evil)) — the locality argument that motivates preferring `vector` over node/segmented containers.
- Chandler Carruth — **"Efficiency with Algorithms, Performance with Data Structures"**, CppCon 2014 ([watch](https://www.youtube.com/watch?v=fHNmRkzxHWs)) — why indirection and scattered allocations cost you on real CPUs.
- CppCon — **"std::vector and friends: choosing the right container"** ([search](https://www.youtube.com/results?search_query=CppCon+choosing+the+right+STL+container+vector+deque)) — practical container-selection guidance including deque's niche.
