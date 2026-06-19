# Progressive Binary Search

> **Why a quant dev must own this:** Lookups in sorted price levels, calendar
> arrays, timestamp indices and config tables all reduce to binary search — and
> the textbook version is *cache-hostile* (each probe jumps to a random
> address) and *branch-mispredicty* (every comparison is a ~50/50 guess). The
> senior toolkit is broader: knowing `lower_bound` vs `upper_bound` cold,
> **exponential / galloping ("progressive") search** for unbounded or streaming
> data, and the **branchless / Eytzinger** layout that turns binary search into
> a cache-friendly, mispredict-free probe.

## Problem statement

Given a sorted range, locate a key efficiently:

1. **Membership / first-not-less.** Return the position of the first element
   `>= key` (`lower_bound`) or `> key` (`upper_bound`); membership is then a
   single comparison at that position.
2. **Progressive / unbounded search.** The range has **no known upper bound** (a
   stream, a growing log, an array you don't want to size first). Find the key,
   or its insertion point, without scanning the whole thing — by first **probing
   exponentially** to bracket a window, then binary-searching inside it.

Both are O(log n)-ish; the interview is really about *which variant, why, and
how it behaves on real hardware.*

## Clarifying constraints / assumptions

- **Sorted, random-access range** (array / `std::vector`). Binary search needs
  random access; on a `std::list` it degrades to O(n) and is pointless.
- **Comparator and ordering.** Strict-weak-ordering; `lower_bound`/`upper_bound`
  assume the range is partitioned with respect to the predicate.
- **Duplicates allowed.** That's exactly why `lower_bound` (first `>= key`) and
  `upper_bound` (first `> key`) differ; their gap is the equal-range.
- **Unbounded case:** for exponential search the range is conceptually infinite
  or its size is expensive to obtain; we only require that probing index `i` is
  valid until we step past the end.
- **Read-mostly / hot data** is the latency motivation; if it's cold or queried
  rarely, plain `std::lower_bound` is the right, boring answer.

## Approaches and tradeoffs

### `lower_bound` vs `upper_bound` vs `binary_search` vs `equal_range`

Know these four cold — interviewers test the distinction:

| Want | STL call | Returns |
|---|---|---|
| First element `>= key` | `std::lower_bound` | iterator to first not-less |
| First element `> key` | `std::upper_bound` | iterator to first greater |
| Is `key` present? | `std::binary_search` | `bool` |
| All elements `== key` | `std::equal_range` | `{lower, upper}` pair |

`binary_search(b,e,k)` is literally `lo = lower_bound(...); return lo!=e && !(k<*lo)`.
`equal_range` is `{lower_bound, upper_bound}`. So **`lower_bound` is the
primitive**; the rest are spelled in terms of it. To get the *index* of a found
key: `lower_bound`, check it's not `end()` and equals the key, then `it - begin`.

### Exponential / galloping search ("progressive")

For an unbounded or front-loaded query, don't binary-search the whole space.
**Probe at indices 1, 2, 4, 8, 16, …** (doubling) until you overshoot the key,
then binary-search the bracket `[prev, current]`. If the answer is near the
front (common for recent timestamps, hot price levels), you touch far fewer
elements than a full `log2(n)` search.

- **Cost:** O(log i) where *i* is the answer's position — output-sensitive.
  Galloping is O(log i) to bracket plus O(log i) to bisect.
- Used inside **TimSort's merge** ("galloping mode") and to search unbounded
  streams. This is the precise meaning of "progressive": *grow the search window
  progressively until it brackets the target.*

### Interpolation search

If keys are roughly uniform (e.g. dense sequence numbers, evenly spaced
timestamps), guess the probe position by linear interpolation instead of always
halving → ~O(log log n) on uniform data, but O(n) worst case on skewed data and
more arithmetic per probe. Mention it; rarely worth it in practice.

### Branchless / Eytzinger layout (the low-latency teaser)

Classic binary search has two problems on modern CPUs: each probe is a
**branch the predictor can't learn** (the comparison outcome is ~random), and
successive probes hit **scattered cache lines**. Two fixes:

- **Branchless:** replace the `if` that moves `lo`/`hi` with arithmetic
  (`base += (cmp) * half`) so the compiler emits `cmov` — no misprediction.
- **Eytzinger (BFS) layout:** store the array in *breadth-first heap order* so
  the children of index `i` are at `2i+1`, `2i+2`. Now the first few probes live
  in the *same* cache lines and you can **prefetch** the next probe.
  Combined with branchless comparison this is dramatically faster than
  `std::lower_bound` on large read-mostly arrays — at the cost of a one-time
  permutation and losing in-order layout. (Detailed in Further reading.)

## Complexity

| Variant | Time | When |
|---|---|---|
| `std::lower_bound` | O(log n), 1 cmp/probe | known-size sorted range |
| Exponential / galloping | O(log i), i = answer pos | unbounded / front-loaded |
| Interpolation | O(log log n) avg, O(n) worst | uniform keys |
| Branchless + Eytzinger | O(log n), no mispredict, cache-friendly | large hot read-mostly array |

All are logarithmic; the differences are **constant factors and cache/branch
behaviour**, which is the whole point in a latency context.

## Complete, annotated reference implementation

C++ standard: **C++17** (the templates are C++14-clean; comments note C++20
options). Self-contained.

```cpp
#include <cstddef>
#include <iterator>
#include <vector>

// ---- 1. Index of first element >= key (a lower_bound that returns an index).
template <class T>
std::size_t lower_bound_index(const T* a, std::size_t n, const T& key) {
    std::size_t lo = 0, len = n;
    while (len > 0) {
        std::size_t half = len / 2;
        std::size_t mid  = lo + half;
        if (a[mid] < key) {        // mid too small -> discard [lo, mid]
            lo  = mid + 1;
            len -= half + 1;
        } else {                   // a[mid] >= key -> answer in [lo, mid]
            len = half;
        }
    }
    return lo;                     // == n if every element < key
}

// ---- 2. Branchless binary search over a power-of-handling length.
// Emits cmov instead of a data-dependent branch; great for hot read-mostly data.
template <class T>
std::size_t lower_bound_branchless(const T* a, std::size_t n, const T& key) {
    const T* base = a;
    std::size_t len = n;
    while (len > 1) {
        std::size_t half = len / 2;
        // No branch: advance base only if the midpoint is still < key.
        base += (base[half - 1] < key) ? half : 0;   // compiles to cmov
        len  -= half;
    }
    // base now points at the candidate; nudge by one final comparison.
    base += (n > 0 && *base < key) ? 1 : 0;
    return static_cast<std::size_t>(base - a);
}

// ---- 3. Exponential ("progressive") + binary search.
// Brackets the key by doubling the probe index, then bisects the window.
// Returns index of first element >= key. Cost O(log answer_position).
template <class T>
std::size_t exponential_search(const T* a, std::size_t n, const T& key) {
    if (n == 0) return 0;
    if (a[0] >= key) return 0;               // answer is at the very front

    std::size_t bound = 1;
    while (bound < n && a[bound] < key)      // probe 1,2,4,8,... until overshoot
        bound <<= 1;                          // doubling = "progressive" window

    std::size_t lo = bound >> 1;             // last index known to be < key
    std::size_t hi = (bound < n) ? bound : n; // clamp the upper edge to n
    // Binary-search the bracket [lo, hi) for the first element >= key.
    return lo + lower_bound_index(a + lo, hi - lo, key);
}

// ---- 4. Galloping from a hint (TimSort-style): search starting near `hint`.
// Useful when the next query is likely close to the previous result.
template <class T>
std::size_t gallop_from(const T* a, std::size_t n, std::size_t hint, const T& key) {
    std::size_t lo = hint, hi = hint, step = 1;
    if (hint < n && a[hint] < key) {         // gallop right
        while (hi < n && a[hi] < key) { lo = hi; hi += step; step <<= 1; }
        if (hi > n) hi = n;
    } else {                                  // gallop left
        while (lo > 0 && a[lo] >= key) { hi = lo; lo = (lo > step ? lo - step : 0); step <<= 1; }
    }
    return lo + lower_bound_index(a + lo, hi - lo, key);
}
```

Notes:

- `lower_bound_index` is the `len/half` form (the same shape libstdc++ uses)
  rather than `lo/hi` midpoints — it avoids the classic `(lo+hi)/2` overflow and
  keeps the loop tight.
- `lower_bound_branchless` swaps the `if` for a conditional add. On x86 the
  ternary becomes a `cmov`, eliminating the unpredictable branch. Verify in the
  disassembly — compilers sometimes still emit a branch.
- `exponential_search` does the *progressive* doubling, then delegates to the
  plain bisect on the small bracket. The clamp `(bound < n) ? bound : n` is the
  off-by-one that handles overshooting past the end.

### Worked trace (exponential)

```text
a = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91]   (n=10), key = 38

a[0]=2 < 38, probe: bound=1 (a[1]=5<38) -> 2 (a[2]=8<38) -> 4 (a[4]=16<38)
        -> 8 (a[8]=72 >= 38) stop.   lo=4, hi=8
binary-search a[4..8) for >=38:  a[6]=38  -> index 6   ✓
touched ~7 elements vs full log2(10)≈4 probes; the win grows when the answer
is near the front of a huge array.
```

## Low-latency optimizations

- **Prefer `std::lower_bound` until profiled.** It's correct, debugged, and the
  optimizer knows it. Only hand-roll when a profile says binary search is hot.
- **Branchless > branchy on random data.** A mispredicted branch costs ~15–20
  cycles; over `log2(n)` probes on adversarial keys that dominates. The `cmov`
  form pays a fixed small cost every probe but never mispredicts. (On *sorted*
  query streams the branch *does* predict well — measure before assuming.)
- **Eytzinger layout for big hot arrays.** Lay the data out BFS so the first
  ~`log2(cacheline/elem)` probes share cache lines, and **software-prefetch**
  the next probe (`__builtin_prefetch(&a[2*i+1])`). This is the standard "make
  binary search cache-friendly" trick; it beats `std::lower_bound` on
  multi-megabyte arrays. Trade-off: you lose sorted iteration order and pay a
  one-time permute.
- **Galloping with a hint** when consecutive queries are correlated (e.g.
  monotonic timestamps): start from the previous result and double outward. This
  is why `std::sort`'s merge step (TimSort elsewhere) gallops — amortises to
  O(1) when queries cluster.
- **Linear scan wins for tiny n.** Below ~16–64 elements a branch-predictable,
  vectorizable linear scan beats binary search: no mispredicts, one cache line,
  SIMD-comparable. Many price-level books exploit this — the top of book is
  small and hot.
- **Keep the search range hot.** A cold binary search is `log n` cache misses
  (~100ns each) — potentially microseconds. If the structure is queried in the
  critical path, keep it resident and small, or fall back to a flat hot array.

> Senior framing: asymptotically all of these are O(log n). The *latency*
> question is "how many cache misses and how many mispredicts per lookup?" —
> and that's what branchless + Eytzinger + small-n-linear address.

## Follow-up variations interviewers ask

- **"Find the insertion point for a key not present."** → `lower_bound` returns
  exactly that; show membership = `it != end && *it == key`.
- **"Search a rotated sorted array."** → Modified binary search deciding which
  half is sorted each step; classic and adjacent.
- **"The array is unbounded / a stream."** → Exponential search: bracket then
  bisect; cost is output-sensitive O(log i).
- **"`std::lower_bound` is slow in my profile — why and what do you do?"** →
  Branch mispredicts + scattered cache lines; answer with branchless + Eytzinger
  + prefetch, and small-n linear fallback.
- **"Why does `(lo+hi)/2` have a bug?"** → Integer overflow for large indices;
  use `lo + (hi-lo)/2` or the `len/half` form. A famous real-world bug.
- **"lower vs upper bound on duplicates?"** → `[lower_bound, upper_bound)` is the
  equal-range; show how `equal_range` and `binary_search` are built from them.
- **"Search by a key field inside a struct."** → Pass a projection/comparator;
  in C++20 use `std::ranges::lower_bound(v, key, {}, &T::field)`.

## Key takeaways

1. **`lower_bound` is the primitive**: first element `>= key`. `upper_bound`,
   `binary_search`, and `equal_range` are all defined in terms of it. Know the
   four cold.
2. **Progressive / exponential search** = double the probe index to bracket the
   key, then bisect — O(log i), ideal for unbounded streams or front-loaded
   queries. It's what TimSort's galloping mode does.
3. All variants are O(log n); the **latency** story is *cache misses and branch
   mispredicts per lookup*, not the asymptotic.
4. **Branchless** binary search (`cmov`) kills mispredicts on random query
   streams; the **Eytzinger / BFS layout** plus prefetch makes the probes
   cache-friendly. Together they beat `std::lower_bound` on large hot arrays.
5. For **tiny n** (top-of-book sized), a linear scan beats binary search —
   predictable, contiguous, vectorizable.
6. Avoid the `(lo+hi)/2` overflow; prefer the `len/half` loop form.

## Self-check

1. Given `[1,2,2,2,3]` and key `2`, what do `lower_bound`, `upper_bound`, and
   `equal_range` return (as indices)?
2. Why is the textbook binary-search branch hard for the CPU to predict, and how
   does the `cmov` form fix it? What's the downside?
3. For `key` at position 3 in a 1,000,000-element array, how many elements does
   exponential search probe vs full binary search? Why is it "output-sensitive"?
4. Explain the Eytzinger layout: where are the children of index `i`, and why
   does that improve cache behaviour over a sorted array?
5. Write membership-with-index on top of `std::lower_bound`. What two checks must
   you make before dereferencing the result?
6. At roughly what `n` would you switch from binary search to a linear scan in a
   latency-critical lookup, and why?

## Further reading

- [`std::lower_bound`](https://en.cppreference.com/w/cpp/algorithm/lower_bound), [`std::upper_bound`](https://en.cppreference.com/w/cpp/algorithm/upper_bound), [`std::equal_range`](https://en.cppreference.com/w/cpp/algorithm/equal_range), [`std::binary_search`](https://en.cppreference.com/w/cpp/algorithm/binary_search) — the four primitives and how they relate.
- Paul-Virak Khuong & Pat Morin, [**"Array Layouts for Comparison-Based Searching"**](https://arxiv.org/abs/1509.05053) — the definitive study of Eytzinger/branchless binary search and prefetching.
- Sergey Slotin, [**Algorithmica: "Binary Search"**](https://en.algorithmica.org/hpc/data-structures/binary-search/) — superb hands-on walkthrough of branchless + Eytzinger + prefetch with benchmarks.
- [Exponential search — Wikipedia](https://en.wikipedia.org/wiki/Exponential_search) and [Interpolation search — Wikipedia](https://en.wikipedia.org/wiki/Interpolation_search).
- [TimSort galloping mode](https://github.com/python/cpython/blob/main/Objects/listsort.txt) — the canonical description of galloping/progressive search inside a real sort.
- Jon Bentley, *Programming Pearls*, ch. on binary search — and the famous `(lo+hi)/2` overflow write-up by Joshua Bloch, ["Nearly All Binary Searches Are Broken"](https://research.google/blog/extra-extra-read-all-about-it-nearly-all-binary-searches-and-mergesorts-are-broken/).

## Videos

- CppCon — Timur Doumler, **"Want Fast C++? Know Your Hardware!"** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+want+fast+c%2B%2B+know+your+hardware)) — caches and branch prediction, the why behind branchless/Eytzinger search.
- CppCon — **"Branchless Programming in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+branchless+programming+in+C%2B%2B)) — turning data-dependent branches into `cmov`, directly applicable here.
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why cache misses and mispredicts in a lookup matter on the hot path.
