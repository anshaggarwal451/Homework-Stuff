# Ordered Containers

> **Why a quant dev must own this:** When the *order* of keys matters — price
> levels in a book, time-sorted events, "give me the best bid ≤ X" — an ordered
> associative container is the textbook answer. `std::map`/`std::set` give you
> sorted iteration and logarithmic range queries. But they're node-based,
> heap-heavy, and cache-hostile, which is why real order books are built on
> *sorted arrays*, not `std::map`. Knowing both the abstraction and why it
> loses in the hot path is a staple HFT interview line.

## First principles: ordered means a balanced tree

A hash map throws away order to get O(1). An **ordered** container keeps every key
sorted at all times, paying O(log n) per operation in exchange for three things a
hash map cannot offer: **sorted iteration**, **range queries** (`lower_bound`,
`upper_bound`, `equal_range`), and a deterministic, comparison-defined order.

The four standard ordered containers (`<map>` / `<set>`, C++98):

| Container | Stores | Duplicate keys? | Value mapped? |
|---|---|---|---|
| `std::set` | keys | no | no |
| `std::map` | key→value | no | yes |
| `std::multiset` | keys | **yes** | no |
| `std::multimap` | key→value | **yes** | yes |

Every standard library implements these as a **self-balancing binary search
tree** — in practice a **red-black tree**. (The standard doesn't name red-black,
but its complexity *and* iterator-stability guarantees effectively require a
balanced BST; all of libstdc++, libc++, and MSVC use red-black.)

## Mechanics: the red-black tree

A binary search tree keeps the invariant *left subtree < node < right subtree*,
so lookup is a guided descent — halving the search space at each step, O(log n).
A *plain* BST can degenerate to a linked list (insert sorted data → O(n)). A
red-black tree adds colour rules and rebalances on insert/erase so the tree stays
**height-balanced** (height ≤ 2·log₂(n+1)), guaranteeing O(log n) **worst case**,
not just average.

Each element is its **own heap-allocated node** holding the key/value plus three
pointers (left, right, parent) and a colour bit:

```text
                       ┌─────────────┐
                       │  key=50 (B) │
                       │ L  P  R     │
                       └──┬───────┬──┘
              ┌───────────┘       └───────────┐
        ┌─────▼──────┐                  ┌──────▼─────┐
        │ key=30 (R) │                  │ key=70 (R) │
        └──┬──────┬──┘                  └──┬──────┬──┘
     ┌─────▼┐   ┌─▼────┐             ┌─────▼┐   ┌─▼────┐
     │20 (B)│   │40 (B)│             │60 (B)│   │80 (B)│
     └──────┘   └──────┘             └──────┘   └──────┘

  Each box is a SEPARATE heap allocation, reached by following a pointer.
  In-order traversal (20,30,40,50,60,70,80) = sorted iteration.
  A descent (50→70→60) is 3 pointer hops = up to 3 cache misses.
```

The two facts that drive performance:

1. **One heap allocation per element**, scattered across memory; ~3 pointers +
   colour of bookkeeping overhead per element.
2. **Every operation is pointer chasing** down ~log₂(n) nodes, each hop a likely
   **cache miss**. Logarithmic *comparisons* but logarithmic *cache misses* too —
   and a cache miss is ~hundreds of cycles.

### Complexity

| Operation | Complexity |
|---|---|
| `find`, `count`, `contains`, `insert`, `erase` (by key) | O(log n) |
| `lower_bound`, `upper_bound`, `equal_range` | O(log n) |
| Iterate all (in sorted order) | O(n), already sorted |
| `++it` / `--it` (in-order step) | amortized O(1) |
| `begin`/`end` | O(1) |

### Iterator and reference stability

A strong guarantee, and the usual reason to pick a node-based container:
**insert never invalidates iterators or references; erase invalidates only the
erased element.** Nodes never move, so a pointer/iterator to an element stays
valid for the element's whole lifetime regardless of other inserts/erases. (C++17
even lets you **splice** a node between containers via `extract`/`insert` with no
reallocation.)

## The `Compare` predicate and strict weak ordering

Order is defined by a comparator, default `std::less<Key>`. The full template is
`map<Key, T, Compare, Allocator>`. The comparator must impose a **strict weak
ordering**:

- **Irreflexive:** `comp(a, a)` is false.
- **Asymmetric:** if `comp(a, b)` then not `comp(b, a)`.
- **Transitive**, and transitive on equivalence.

Equivalence is defined as `!comp(a,b) && !comp(b,a)` — note the container uses the
*comparator*, never `operator==`. Violate strict weak ordering (e.g. a `<=` that
isn't irreflexive) and you get **undefined behavior**: corrupted trees, crashes,
infinite loops. This is a favourite trap.

```cpp
#include <map>
#include <string>

// Sort symbols descending by length, then lexicographically.
struct ByLenDesc {
    bool operator()(const std::string& a, const std::string& b) const {
        if (a.size() != b.size()) return a.size() > b.size();  // strict
        return a < b;                                          // tie-break, strict
    }
};
std::map<std::string, double, ByLenDesc> book;
```

## Range queries: lower_bound / upper_bound / equal_range

This is the *real* reason ordered containers earn their keep — answering "what's
near this key?", not just "is this key present?".

```cpp
#include <map>
std::map<int, double> levels{{100,1},{102,1},{105,1},{110,1}};

auto lo = levels.lower_bound(102);   // first key >= 102  -> points at 102
auto hi = levels.upper_bound(105);   // first key  > 105  -> points at 110
// half-open [lo, hi) = all price levels in [102, 105]
for (auto it = lo; it != hi; ++it) { /* 102, 105 */ }

auto [b, e] = levels.equal_range(105);  // [b,e) of all elements equivalent to 105
```

On a `multimap`/`multiset`, `equal_range` gives the whole run of equal keys.
Each call is a single O(log n) descent.

> **Gotcha:** the *member* `lower_bound` is O(log n) (it walks the tree). The free
> `std::lower_bound` on a `std::map`'s iterators is O(n), because map iterators
> aren't random-access. Always use the member function on associative containers.

## Transparent comparators (C++14 heterogeneous lookup)

Like the hash side, ordered containers have a temporary-key trap: looking up a
`std::map<std::string, V>` with a `const char*` constructs a temporary
`std::string` per call. C++14 added **transparent comparators** — give the
comparator an `is_transparent` member and the member `find`/`lower_bound`/… accept
*any* comparable type with no conversion:

```cpp
#include <map>
#include <string>
#include <string_view>

std::map<std::string, int, std::less<>> m;   // std::less<> IS transparent
m.emplace("AAPL", 1);

std::string_view k = "AAPL";
auto it = m.find(k);   // C++14: NO temporary std::string built
```

The trick is `std::less<>` (the void specialization) — it carries
`is_transparent` and forwards to `operator<` generically. Plain
`std::less<std::string>` is *not* transparent. Eliminating these temporaries is a
common "make this lookup allocation-free" interview ask.

## `map` vs `unordered_map`: how to choose

| Need | Choose |
|---|---|
| Sorted iteration / range queries (`lower_bound`) | **`std::map`** (ordered) |
| Pure key→value lookup, order irrelevant | **`std::unordered_map`** (or a flat hash map) |
| Worst-case O(log n) guarantee (no rehash spikes) | **`std::map`** |
| Best average-case lookup latency | hash map |
| Iterator/reference stability across inserts | both node-based ones qualify |
| Keys hard to hash but easy to order | **`std::map`** |

`unordered_map` is *average* O(1) but worst-case O(n) with rehash spikes; `map` is
a steady O(log n) with no rehash. If you don't need order, a hash map usually wins
on lookup latency. See the [hashing containers](./hashing-containers.md) lesson.

## When a sorted `std::vector` beats `std::map`

This is the senior point. For a **read-mostly** set of keys, a **sorted
`std::vector` + `std::lower_bound`** beats `std::map` decisively:

- **Contiguous storage** → binary search walks one cache line at a time, and the
  hot upper levels of the search stay resident. `std::map` scatters nodes across
  the heap; each of the log n hops is a fresh cache miss.
- **No per-node pointers/colour** → ~3–4× less memory, so more of the structure
  fits in cache.
- **Same O(log n) search**, but with a far smaller constant.

The catch: insert/erase in the middle of a sorted vector is **O(n)** (shift
elements). So the rule is: *sorted vector when lookups vastly outnumber mutations*
(build once, query often); *tree when you mutate continuously and need stable
iterators*.

```cpp
#include <vector>
#include <algorithm>
#include <utility>

std::vector<std::pair<int,double>> book;        // kept sorted by key
auto by_key = [](auto& e, int k){ return e.first < k; };

auto it = std::lower_bound(book.begin(), book.end(), 105, by_key);
if (it != book.end() && it->first == 105) { /* found */ }
```

**Boost.Container's `boost::container::flat_map` / `flat_set`** package exactly
this — a `std::map`-like API backed by a sorted vector — and **C++23's
`std::flat_map`/`std::flat_set`** standardize it (see the [adapter
containers](./adapter-containers.md) lesson).

## Quant/HFT relevance & interview gotchas

- **Order books rarely use `std::map`.** A real limit-order book uses a
  cache-friendly structure: a flat/sorted vector keyed by price, or an array
  indexed by price-tick (price ladders), precisely to avoid node-chasing. "I'd
  use `std::map` for the book" is a red flag; "I'd use a flat_map / price-indexed
  array and only reach for a tree if I need cheap arbitrary-position erase with
  stable iterators" is the senior answer.
- **`operator[]` default-inserts** on `std::map` too — `m[k]` creates the key if
  missing. Use `find`/`at`/`contains` for read-only access.
- **Comparator must be a strict weak ordering** — using `<=` (not irreflexive) is
  UB and a classic interview trap.
- **Use the *member* `lower_bound`**, not `std::lower_bound`, on a `map`/`set`.
- **Transparent comparator (`std::less<>`)** to avoid temporary-key allocations.
- **`map` for worst-case bounds, hash for average latency, sorted vector for
  read-mostly + cache locality** — be able to defend each.

## Key takeaways

1. Ordered containers keep keys **sorted** via a balanced BST (**red-black
   tree**), giving **O(log n)** worst-case ops and sorted iteration.
2. They are **node-based**: one heap allocation per element, ~3 pointers of
   overhead, and each operation is **pointer chasing** → cache misses.
3. **Insert never invalidates iterators/references; erase only the erased one** —
   strong stability, the main reason to pick a tree.
4. The `Compare` predicate must be a **strict weak ordering**; equivalence is
   `!(a<b) && !(b<a)`, never `operator==`. Violation = UB.
5. **`lower_bound`/`upper_bound`/`equal_range`** (the member versions) are the
   O(log n) range queries that justify the structure.
6. Use **`std::less<>`** for C++14 transparent, allocation-free heterogeneous
   lookup.
7. For read-mostly data, a **sorted `std::vector` + binary search** (or
   `flat_map`) beats `std::map` on cache locality — the HFT default.

## Self-check

1. Why does `std::map` guarantee O(log n) *worst case* while `std::unordered_map`
   only guarantees it *amortized average*?
2. A colleague defines `bool operator()(int a, int b){ return a <= b; }` as a map
   comparator. What goes wrong, and why?
3. What's the difference between member `lower_bound` and `std::lower_bound`
   applied to a `std::map`, in complexity terms?
4. Give a concrete workload where a sorted `std::vector` beats `std::map`, and one
   where the reverse is true.
5. How does `std::less<>` make `m.find("literal")` allocation-free for a
   `std::map<std::string,V>`?
6. You hold an iterator into a `std::map` and then insert 1000 other elements. Is
   the iterator still valid? What about for `std::vector`?

## Further reading

- [`std::map` — cppreference](https://en.cppreference.com/w/cpp/container/map) and [`std::set`](https://en.cppreference.com/w/cpp/container/set)
- [`std::map::lower_bound`](https://en.cppreference.com/w/cpp/container/map/lower_bound) and [`equal_range`](https://en.cppreference.com/w/cpp/container/map/equal_range)
- [Transparent comparators / `std::less<>`](https://en.cppreference.com/w/cpp/utility/functional/less_void) and [the *Compare* / strict-weak-ordering requirement](https://en.cppreference.com/w/cpp/named_req/Compare)
- [`boost::container::flat_map`](https://www.boost.org/doc/libs/release/doc/html/boost/container/flat_map.html) — sorted-vector-backed associative container
- Scott Meyers, *Effective STL*, Item 23 ("Consider replacing associative containers with sorted vectors") — the canonical statement of the cache argument; also Items 19–22 on associative containers.
- [Red-black tree — Wikipedia](https://en.wikipedia.org/wiki/Red%E2%80%93black_tree) — the balancing scheme the standard libraries use.
- [WG21 P0429 / P1222 — `std::flat_map` / `std::flat_set` (C++23)](https://wg21.link/p0429) — standardizing the sorted-vector approach.

## Videos

- Chandler Carruth — **"Efficiency with Algorithms, Performance with Data Structures"**, CppCon 2014 ([watch](https://www.youtube.com/watch?v=fHNmRkzxHWs)) — why node-based trees lose to contiguous storage on real hardware.
- Bjarne Stroustrup — **"Are Lists Evil?" / vector-vs-list cache lessons** ([search](https://www.youtube.com/results?search_query=Bjarne+Stroustrup+are+lists+evil+vector)) — the same node-chasing-vs-contiguous lesson, applied broadly.
- Kjell Hedström / various — **"Building an Order Book in C++"** ([search](https://www.youtube.com/results?search_query=building+a+limit+order+book+in+C%2B%2B)) — why production books avoid `std::map`.
