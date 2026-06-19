# Algorithmic Complexity

> **Why a quant dev must own this:** Big-O is the language interviewers use to
> reason about scaling, and you must speak it fluently. But the deeper, more
> valuable lesson for HFT is knowing *when Big-O lies* — when a "worse"
> asymptotic complexity wins on real hardware because of the cache, the
> constants, and the branch predictor. A linear scan over a small contiguous
> array routinely beats an O(1) hash lookup. The senior answer is always:
> *know the complexity, then measure the constant.*

## First principles: what complexity actually measures

Algorithmic complexity describes **how the cost of an algorithm grows as the
input size `n` grows** — *asymptotically*, ignoring constant factors and
lower-order terms. We care about two resources:

- **Time complexity** — number of primitive operations as a function of `n`.
- **Space complexity** — extra memory used as a function of `n` (often
  excluding the input itself, i.e. *auxiliary* space).

The point of the abstraction is portability: it lets you compare two algorithms
without running them, on any machine, before you write a line of code. The point
of *this lesson* is to also teach you its limits.

## The three notations: Big-O, Theta, Omega

These are bounds on a function `f(n)` describing the cost:

| Notation | Name | Meaning | Bounds |
|:--------:|:-----|:--------|:-------|
| `O(g)` | Big-O | `f` grows *no faster than* `g` | **upper** bound |
| `Ω(g)` | Big-Omega | `f` grows *no slower than* `g` | **lower** bound |
| `Θ(g)` | Big-Theta | `f` grows *exactly like* `g` (both bounds) | **tight** bound |

Formally, `f(n) = O(g(n))` means there exist constants `c > 0` and `n₀` such
that `f(n) ≤ c·g(n)` for all `n ≥ n₀`.

In casual speech engineers say "Big-O" but usually *mean* Theta — the tight
bound. Strictly, every algorithm is `O(2ⁿ)` (a true but useless upper bound).
The interview-correct habit: state the **tight** bound, and distinguish best /
average / worst when they differ.

> **Interview gotcha:** "What's the Big-O of quicksort?" The crisp answer:
> *average `Θ(n log n)`, worst-case `Θ(n²)`* (already-sorted input with naive
> pivot). Mentioning the worst case unprompted signals depth.

## Best, average, and worst case

The same algorithm can have wildly different costs depending on the *input*:

- **Best case** — the luckiest input (rarely interesting on its own).
- **Worst case** — the adversarial input. This is what you quote when latency
  must be *bounded* — exactly the HFT mindset (tail latency, not the mean).
- **Average case** — expected cost over a distribution of inputs.

For HFT, **worst case dominates the conversation**: a feed handler that is fast
"on average" but spikes to `O(n)` on a rehash is a system that misses fills
during the busiest microsecond of the day.

## The common complexity classes

Ordered from best to worst, with a concrete C++ example of each:

| Class | Name | Example |
|:------|:-----|:--------|
| `O(1)` | constant | `vector::operator[]`, hash lookup (amortized) |
| `O(log n)` | logarithmic | binary search, `std::map` lookup (red-black tree) |
| `O(n)` | linear | `std::find`, summing an array |
| `O(n log n)` | linearithmic | `std::sort`, merge sort, heap sort |
| `O(n²)` | quadratic | naive nested-loop pair comparison, bubble sort |
| `O(2ⁿ)` | exponential | naive recursive subset/Fibonacci enumeration |
| `O(n!)` | factorial | brute-force traveling salesman |

```cpp
#include <vector>
#include <algorithm>
#include <cstdint>

// O(1): index into contiguous storage — one address calculation, one load.
int at(const std::vector<int>& v, size_t i) { return v[i]; }

// O(log n): binary search assumes sorted, random-access data.
bool present(const std::vector<int>& v, int key) {
    return std::binary_search(v.begin(), v.end(), key);   // log2(n) comparisons
}

// O(n): touch every element once.
int64_t sum(const std::vector<int>& v) {
    int64_t s = 0;
    for (int x : v) s += x;     // n adds
    return s;
}

// O(n^2): every pair — the classic accidental quadratic.
int count_close_pairs(const std::vector<int>& v, int eps) {
    int c = 0;
    for (size_t i = 0; i < v.size(); ++i)
        for (size_t j = i + 1; j < v.size(); ++j)   // ~n^2/2 comparisons
            if (std::abs(v[i] - v[j]) <= eps) ++c;
    return c;
}
```

A useful intuition for the gap: `log₂(1,000,000) ≈ 20`, while
`1,000,000² = 10¹²`. Logarithmic vs quadratic is the difference between
"instant" and "go get a coffee."

## Amortized analysis: `vector::push_back`

A single operation can be expensive *occasionally* while the *average over a
sequence* stays cheap. That average is the **amortized** cost.

The canonical example is `std::vector::push_back`. When the vector is full, it
must allocate a larger buffer and copy/move every element — an `O(n)` event. So
*worst-case* `push_back` is `O(n)`. Yet `push_back` is documented as
**amortized `O(1)`**. Why?

Because implementations grow the capacity **geometrically** (typically ×2 on
libstdc++/libc++, ×1.5 on MSVC). Doubling means reallocations happen at sizes
`1, 2, 4, 8, …, n`. The total copy work across `n` insertions is
`1 + 2 + 4 + … + n < 2n` — a geometric series that sums to `O(n)` *total*, hence
`O(1)` *per element on average*.

```cpp
std::vector<int> v;
v.reserve(1'000'000);          // pre-size: now every push_back is true O(1),
for (int i = 0; i < 1'000'000; ++i)   // no reallocation, no copy storms.
    v.push_back(i);
```

> **HFT angle:** Amortized `O(1)` still has `O(n)` *spikes*. A reallocation mid
> hot-loop is a latency bomb (allocation + copy + cache eviction). The fix is
> trivial and mandatory: **`reserve()` up front** so the spike never happens.
> "Amortized" is a throughput concept; HFT cares about the tail.

## Complexity of common STL operations

Know this table cold — it is a frequent interview drill.

| Container / op | Access | Search | Insert | Erase | Notes |
|:---------------|:-------|:-------|:-------|:------|:------|
| `vector` | `O(1)` | `O(n)` | `O(1)` amortized (back) | `O(n)` (middle) | contiguous, cache-friendly |
| `deque` | `O(1)` | `O(n)` | `O(1)` (ends) | `O(1)` (ends) | chunked, not fully contiguous |
| `list` | `O(n)` | `O(n)` | `O(1)` (with iterator) | `O(1)` | node-per-element, pointer-chasing |
| `map` / `set` | — | `O(log n)` | `O(log n)` | `O(log n)` | red-black tree, sorted, pointer-chasing |
| `unordered_map` | — | `O(1)` avg, `O(n)` worst | `O(1)` avg | `O(1)` avg | hash table; rehash is `O(n)` |

`std::sort` is `O(n log n)` (introsort: quicksort with a heapsort fallback to
guarantee the bound). `std::nth_element` is average `O(n)` (quickselect).

> **Gotcha:** `std::list::size()` is `O(1)` since C++11, but `std::list::sort`
> is its own merge sort (you can't `std::sort` a list — it needs random-access
> iterators). And `unordered_map` worst-case lookup is `O(n)` when every key
> collides into one bucket — a real adversarial-input concern.

## Why Big-O lies: the cache and the constant

Here is the lesson that separates textbook knowledge from HFT engineering.
**Asymptotic complexity counts operations as if every operation costs the
same.** On real hardware, it does not. A cache miss to DRAM costs ~100ns —
roughly **two orders of magnitude** more than an L1 hit (~1ns) or an arithmetic
op. So an algorithm's true cost is dominated by its **memory access pattern**,
which Big-O ignores entirely.

Consider finding an element in a small collection:

```cpp
// "O(n)" linear scan over a contiguous array.
bool linear(const std::vector<int>& v, int key) {
    for (int x : v) if (x == key) return true;   // sequential, prefetcher-friendly
    return false;
}

// "O(1)" hash lookup.
bool hashed(const std::unordered_map<int,int>& m, int key) {
    return m.count(key) != 0;   // hash + bucket pointer chase + node deref
}
```

For small `n` (say, up to ~50–1000 ints — measure on *your* hardware), the
linear scan **wins decisively**, even though its complexity is "worse":

- The array is **contiguous**: one cache line holds 16 `int`s, the hardware
  prefetcher streams the next lines, and the loop **vectorizes** (SIMD compares
  many elements per instruction). Branch prediction nails the loop.
- The `unordered_map` pays: a hash computation, a bucket array indirection, then
  a **pointer chase** to a heap-allocated node (likely a cache miss), then a key
  comparison. Its `O(1)` is a constant *with a fat coefficient and poor
  locality*.

The same story plays out for `std::map` (`O(log n)` but each step is a pointer
chase to a scattered node) and `std::list` (a linked list is the cache's worst
enemy — every `next` is a potential miss). This is *why* HFT code is full of
`std::vector` and flat, contiguous structures and almost devoid of `std::list`
and `std::map` on the hot path.

> **The senior takeaway:** Big-O tells you which algorithm wins *as n → ∞*. On
> the hot path, `n` is often small and fixed, and the cache decides. **Small-n
> contiguous beats asymptotically-superior pointer-chasing.** Measure the
> crossover point; don't assume it.

```text
Approximate latency hierarchy (the numbers Big-O ignores):
  L1 cache hit       ~1 ns        <- linear scan lives here
  L2 cache hit       ~4 ns
  L3 cache hit       ~10-20 ns
  Main memory (DRAM) ~100 ns      <- a pointer chase to a scattered node
  ----------------------------------------------------------------
  One DRAM miss == ~100 sequential L1 array compares.
```

This connects to ideas covered in sibling lessons on the cache hierarchy, branch
prediction, and SIMD vectorization — the three hardware realities that the Big-O
abstraction deliberately hides.

## Quant/HFT relevance & interview gotchas

- **Bound the worst case, not the average.** HFT lives and dies on tail latency.
  An algorithm that is `O(1)` amortized but `O(n)` on a rehash is unacceptable
  in a hot loop unless you can guarantee the spike never fires (pre-size it).
- **Prefer contiguous data structures.** `std::vector` over `std::list`/`map`
  almost always, because the cache dominates the asymptotics at the small,
  fixed `n` typical of order books and working sets.
- **Know the crossover.** Be ready to say: "linear search wins under ~N
  elements; above that the hash table's `O(1)` pays off — and I'd benchmark to
  find N on our hardware."
- **Watch for accidental quadratics.** Calling `.find()` inside a loop,
  `string +=` in a loop, or `erase` in a loop over a vector are classic
  `O(n²)` traps interviewers plant.
- **Space matters too.** A recursive algorithm with `O(n)` stack depth can blow
  the stack; an `O(n)` auxiliary buffer may not fit in cache. State space
  complexity unprompted.
- **"What's faster, `std::map` or `unordered_map`?"** The answer is "it
  depends on `n` and access pattern, and I'd measure" — and you explain *why*
  (tree pointer-chase vs hash + node deref, both cache-hostile; a sorted
  `vector` + `binary_search` often beats both).

## Key takeaways

1. Big-O/Θ/Ω bound growth as `n → ∞`, ignoring constants and lower-order terms.
   State the **tight** bound and distinguish best/avg/**worst**.
2. Memorize the common classes (`O(1)`, `log n`, `n`, `n log n`, `n²`, `2ⁿ`) and
   the STL operation complexity table.
3. **Amortized** analysis explains why `push_back` is `O(1)` average despite
   `O(n)` reallocation spikes — geometric growth. Always `reserve()` in hot code.
4. Big-O counts operations as equal-cost; **real hardware doesn't**. A cache
   miss is ~100× an L1 hit.
5. For small/fixed `n`, a **contiguous `O(n)` scan beats `O(1)`/`O(log n)`
   pointer-chasing** because of locality, prefetching, and vectorization.
6. The discipline: know the complexity, then **measure the constant** — the
   cache usually decides on the hot path.

## Self-check

1. State the tight time complexity of `std::sort`, and explain why it's
   guaranteed and not just average-case.
2. Why is `vector::push_back` amortized `O(1)` but worst-case `O(n)`? What is
   the total work to push `n` elements, and why?
3. Give a concrete scenario where an `O(n)` linear scan outperforms an `O(1)`
   `unordered_map` lookup, and explain the hardware reason.
4. You see `if (v.find(x) != v.end()) ...` inside a loop over another container.
   What is the combined complexity and how would you fix it?
5. What is the worst-case lookup complexity of `std::unordered_map`, and what
   input triggers it?
6. A function recurses to depth `n` and allocates an `O(n)` buffer. State its
   time *and* space complexity, and one practical risk of the space cost.

## Further reading

- [Big-O Cheat Sheet](https://www.bigocheatsheet.com/) — complexity of common
  algorithms and data structures at a glance.
- Cormen, Leiserson, Rivest, Stein, *Introduction to Algorithms* (CLRS) —
  Chapters 3 (asymptotic notation) and 17 (amortized analysis) are the canonical
  treatment.
- [Containers library — cppreference](https://en.cppreference.com/w/cpp/container)
  — each container page documents the complexity of every operation.
- [`std::sort` — cppreference](https://en.cppreference.com/w/cpp/algorithm/sort)
  — note the `O(n log n)` complexity guarantee (introsort).
- [Big O notation — Wikipedia](https://en.wikipedia.org/wiki/Big_O_notation) —
  formal definitions of O, Ω, and Θ.
- [Amortized analysis — Wikipedia](https://en.wikipedia.org/wiki/Amortized_analysis)
  — aggregate, accounting, and potential methods.

## Videos

- *MIT 6.006 Introduction to Algorithms* — lectures on asymptotic notation and
  amortized analysis
  ([search](https://www.youtube.com/results?search_query=MIT+6.006+asymptotic+notation+amortized+analysis)).
- CppCon — **"Designing for Performance"** / data-structure-on-real-hardware
  talks; e.g. Chandler Carruth on efficiency and the cost of abstractions
  ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+efficiency+with+algorithms+performance+with+data+structures)).
