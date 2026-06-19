# Adapter Containers

> **Why a quant dev must own this:** Container *adapters* — `std::stack`,
> `std::queue`, `std::priority_queue` — aren't new data structures; they're thin
> wrappers that *restrict* an underlying container to a specific access pattern.
> The one that earns its keep in trading systems is `priority_queue`: a binary
> heap for scheduling timed events, simulated order arrivals, and expiries in
> O(log n). C++23 adds the *flat* adapters (`flat_set`/`flat_map`) for
> cache-friendly sorted lookup. Interviewers probe whether you know what's under
> the hood and how to pick the backing container.

## First principles: adapters restrict, they don't implement

An **adapter** takes an existing container and exposes a deliberately *narrow*
interface that enforces a discipline. You don't get iterators or random access —
you get exactly the operations the abstraction allows. The three classic adapters
(`<stack>`, `<queue>`, C++98):

| Adapter | Discipline | Default underlying container | Key ops |
|---|---|---|---|
| `std::stack` | LIFO (last in, first out) | `std::deque` | `push`, `pop`, `top` |
| `std::queue` | FIFO (first in, first out) | `std::deque` | `push`, `pop`, `front`, `back` |
| `std::priority_queue` | highest-priority out first | `std::vector` | `push`, `pop`, `top` |

The full template is e.g. `std::stack<T, Container = std::deque<T>>`. The adapter
just holds a `Container c;` member and calls its `push_back`/`pop_back`/etc. There
is no clever data structure inside `stack`/`queue` — all the work is the wrapped
container's. (`priority_queue` is the exception: it adds heap logic on top of the
container, below.)

> **Why these defaults?** `stack`/`queue` default to **`std::deque`** because it
> grows cheaply at both ends and never reallocates-and-copies existing elements
> (references stay stable) — see the [deque](./std-deque.md) lesson.
> `priority_queue` defaults to **`std::vector`** because a binary heap is laid out
> as a flat array and wants contiguity.

## Choosing / overriding the underlying container

The backing container is a template parameter, so you can swap it for one with the
right operations and performance:

```cpp
#include <stack>
#include <queue>
#include <vector>
#include <deque>

// A stack backed by vector: contiguous, cache-friendly, often faster than deque.
std::stack<int, std::vector<int>> s;     // needs back(), push_back(), pop_back()

// A queue MUST keep its default-ish backing (needs push_back + pop_front);
// std::vector lacks pop_front, so a vector-backed std::queue won't compile.
std::queue<int, std::deque<int>> q;      // deque or std::list qualify
```

The requirements:

- **`stack`** needs `back()`, `push_back()`, `pop_back()` → `vector`, `deque`, or
  `list` all work. **`vector` is usually the fastest** for a stack (contiguous).
- **`queue`** needs `front()`, `back()`, `push_back()`, `pop_front()` → `deque` or
  `list`; **not `vector`** (no `pop_front`).
- **`priority_queue`** needs random access + `push_back`/`pop_back` → `vector`
  (default) or `deque`.

> **Interview gotcha:** "Can `std::queue` be backed by `std::vector`?" — No.
> `vector` has no `pop_front`. This trips people up because `stack`-on-`vector`
> *does* work.

## priority_queue: a binary heap

A `priority_queue` keeps the **largest** element (by `Compare`, default
`std::less`) instantly reachable via `top()`. It is implemented as a **binary
heap** stored in the flat backing array — not a tree of nodes. The heap invariant:
each parent is ≥ its children. For a node at index `i` (0-based):

```text
  array:  [ 50 | 30 | 40 | 10 | 20 | 35 | 38 ]
  index:     0    1    2    3    4    5    6

  viewed as the implicit tree:
                    50            children of i: 2i+1, 2i+2
                  /    \          parent  of i: (i-1)/2
                30      40
               /  \    /  \
             10   20  35   38

  top() = a[0] = 50         (O(1) — just read the root)
  push  = append, then "sift up"   -> O(log n)
  pop   = swap root with last, drop last, "sift down" -> O(log n)
```

| Operation | Complexity |
|---|---|
| `top()` | O(1) |
| `push()` | O(log n) |
| `pop()` | O(log n) |
| build from n elements (range ctor) | O(n) |

Crucially there is **no iteration and no search**: a `priority_queue` exposes only
`top`/`push`/`pop`. You cannot inspect or modify an arbitrary element, and you
cannot iterate it in any order. If you need that, use the raw heap algorithms (next
section) or a different structure.

### Under the hood: the heap algorithms

`priority_queue` is built on the `<algorithm>` heap functions, which you can also
use directly on any random-access range (e.g. a `std::vector`) when you want a heap
*without* the adapter's restrictions:

```cpp
#include <algorithm>
#include <vector>

std::vector<int> v{50, 30, 40, 10, 20};
std::make_heap(v.begin(), v.end());            // O(n): impose heap order (max-heap)
v.push_back(35); std::push_heap(v.begin(), v.end());   // sift the new last up: O(log n)
std::pop_heap(v.begin(), v.end());             // move max to the back: O(log n)
int largest = v.back(); v.pop_back();          // then remove it
```

`priority_queue::push` is essentially `c.push_back(x); std::push_heap(...)`, and
`pop` is `std::pop_heap(...); c.pop_back();`. Knowing this lets you build a heap
you *can* iterate when needed.

### Min-heap vs max-heap (the `Compare` flip)

By default `priority_queue` is a **max-heap** (`std::less` → largest on top). For a
**min-heap** (smallest on top — the usual choice for "earliest deadline first"
event scheduling), pass `std::greater`:

```cpp
#include <queue>
#include <vector>
#include <functional>   // std::greater

// Min-heap: smallest timestamp is always on top.
std::priority_queue<long, std::vector<long>, std::greater<long>> events;
events.push(1700000005);
events.push(1700000001);
events.push(1700000003);
while (!events.empty()) {
    long t = events.top();   // 1700000001, then 003, then 005
    events.pop();
}
```

> **Gotcha:** the comparator is "less-than-style", and the element it considers
> *greatest* sits on top. So `std::greater` (which makes small values "greatest"
> under the ordering) yields a **min**-heap. People reliably get this backwards in
> interviews. A custom comparator (e.g. compare event structs by timestamp) works
> the same way — define the strict weak ordering and remember top = "largest under
> Compare".

## C++23 flat adapters: cache-friendly sorted lookup

C++23 standardizes a second family of adapters — `std::flat_set`,
`std::flat_map`, `std::flat_multiset`, `std::flat_multimap` (`<flat_set>`,
`<flat_map>`). These are **container adapters over a sorted `std::vector`** (or any
random-access container you supply): they offer the `std::set`/`std::map` API but
store everything in a contiguous, sorted array instead of a red-black tree.

```cpp
#include <flat_map>     // C++23
std::flat_map<int, double> levels;   // keys kept sorted in a contiguous vector
levels.try_emplace(105, 1.0);
auto it = levels.lower_bound(102);   // O(log n) binary search over contiguous memory
```

Trade-offs versus `std::map`:

| | `std::map` (tree) | `std::flat_map` (sorted vector) |
|---|---|---|
| Lookup | O(log n), pointer-chasing, cache-cold | O(log n), **contiguous, cache-friendly** |
| Iteration | sorted, scattered nodes | sorted, **contiguous (fast)** |
| Insert/erase (middle) | O(log n) | **O(n)** (shift elements) |
| Memory per element | key/value + 3 pointers + colour | just key/value (often 2× denser) |
| Iterator/reference stability | strong (nodes pinned) | **weak** (any mutation can move/invalidate) |

So flat adapters are the standardized form of the "sorted `std::vector` beats
`std::map`" idea from the [ordered containers](./ordered-containers.md) lesson:
unbeatable for **read-mostly** lookups, poor for heavy mid-sequence churn.
Pre-C++23, **`boost::container::flat_map`/`flat_set`** give the same thing.

## Performance and hardware reality

- **`stack`/`queue`** cost exactly what their backing container costs — choose the
  backing container, not the adapter, for performance. `stack`-on-`vector` beats
  `stack`-on-`deque` on locality.
- **`priority_queue`** on a `vector` is contiguous, so sift-up/down walk a flat
  array; cache behavior is good for moderate sizes. It still does ~log n swaps per
  op, and the heap order is *not* sorted order (don't expect sorted iteration).
- **Flat adapters** turn O(log n) lookups into contiguous binary searches — the
  cache-friendly win — at the cost of O(n) inserts. Build-then-query is their sweet
  spot.

## Quant/HFT relevance & interview gotchas

- **`priority_queue` for event/order scheduling.** Discrete-event simulators,
  timer wheels' fallback, expiry queues, and "next order to fire" scheduling all
  use a min-heap keyed by timestamp. O(log n) push/pop, O(1) peek at the next
  event. Be ready to write one.
- **Flat adapters for cache locality.** When you need sorted lookup in a
  read-mostly structure (a price ladder, a static symbol table), `flat_map` /
  `boost::flat_map` beats `std::map` on the cache — a recurring HFT preference.
- **`std::greater` makes a *min*-heap** — the classic flip; explain *why* (top =
  greatest under Compare).
- **No iteration on the adapters.** `stack`/`queue`/`priority_queue` expose no
  iterators; if a question needs to inspect the contents, use the underlying heap
  algorithms or a different container.
- **`std::queue` can't be backed by `std::vector`** (no `pop_front`); `std::stack`
  can.
- **`pop()` returns `void`.** It removes the top but does **not** return it — you
  read `top()`/`front()` first, then `pop()`. (Two operations by design, partly for
  exception safety.) People write `auto x = pq.pop();` and it won't compile.

## Key takeaways

1. `std::stack`, `std::queue`, `std::priority_queue` are **adapters**: they
   restrict an underlying container's interface; they aren't standalone data
   structures.
2. Defaults: `stack`/`queue` → **`std::deque`**; `priority_queue` →
   **`std::vector`**. The backing container is a template parameter you can (and
   sometimes should) override.
3. **`std::queue` needs `pop_front`** so it can't use `vector`; **`std::stack`
   can** use `vector` and often should (contiguity).
4. `priority_queue` is a **binary heap** in a flat array: `top()` O(1),
   `push`/`pop` O(log n), build O(n), **no iteration/search**. It sits on
   `make_heap`/`push_heap`/`pop_heap`.
5. Default is a **max-heap**; pass **`std::greater`** for a **min-heap** — top is
   the element greatest under `Compare`.
6. **C++23 flat adapters** (`flat_set`/`flat_map`) wrap a **sorted vector**:
   cache-friendly O(log n) lookup, O(n) inserts, weak iterator stability — the
   standardized "sorted vector vs `std::map`" win.
7. `pop()` returns `void`; read `top()`/`front()` first.

## Self-check

1. Why does `std::queue` reject `std::vector` as its backing container while
   `std::stack` accepts it?
2. You want a `priority_queue` that always yields the *smallest* timestamp first.
   What comparator do you pass, and why does that produce a min-heap?
3. Express `priority_queue::push` and `pop` in terms of `std::push_heap` /
   `std::pop_heap` and the backing container's operations.
4. Why does `std::pop()` on these adapters return `void` rather than the removed
   element?
5. When would you choose `std::flat_map` over `std::map`, and when is that a bad
   idea?
6. You need to *iterate* the pending events while a heap is live. Why can't you do
   that with `std::priority_queue`, and what would you use instead?

## Further reading

- [`std::stack`](https://en.cppreference.com/w/cpp/container/stack), [`std::queue`](https://en.cppreference.com/w/cpp/container/queue), [`std::priority_queue`](https://en.cppreference.com/w/cpp/container/priority_queue) — cppreference
- [`std::make_heap` / `push_heap` / `pop_heap` / `sort_heap`](https://en.cppreference.com/w/cpp/algorithm/make_heap) — the algorithms under `priority_queue`
- [`std::flat_map`](https://en.cppreference.com/w/cpp/container/flat_map) and [`std::flat_set`](https://en.cppreference.com/w/cpp/container/flat_set) (C++23)
- [`boost::container::flat_map`](https://www.boost.org/doc/libs/release/doc/html/boost/container/flat_map.html) — the pre-C++23 flat adapter
- [WG21 P1222 — `std::flat_set` proposal](https://wg21.link/p1222) and [P0429 — `std::flat_map`](https://wg21.link/p0429)
- Scott Meyers, *Effective STL*, Item 1 (choose containers with care) and Items 31–32 on sorting/heap algorithms.
- [Binary heap — Wikipedia](https://en.wikipedia.org/wiki/Binary_heap) — the array layout and sift operations behind `priority_queue`.

## Videos

- Chandler Carruth — **"Efficiency with Algorithms, Performance with Data Structures"**, CppCon 2014 ([watch](https://www.youtube.com/watch?v=fHNmRkzxHWs)) — why flat, contiguous structures (heaps, flat_map) beat node-based ones.
- CppCon — **"Choosing the right STL container"** ([search](https://www.youtube.com/results?search_query=CppCon+choosing+the+right+STL+container)) — container and adapter selection in practice.
- C++ Weekly with Jason Turner — **"std::priority_queue"** ([search](https://www.youtube.com/results?search_query=C%2B%2B+Weekly+Jason+Turner+priority_queue)) — a short, focused tour of the adapter and its comparator.
