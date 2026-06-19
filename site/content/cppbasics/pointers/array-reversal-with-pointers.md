# Array Reversal with Pointers

> **Why a quant dev must own this:** Reversing in place is the canonical
> two-pointer pattern, and two-pointer technique shows up everywhere in
> latency-sensitive code — walking a buffer from both ends, partitioning,
> rotating a ring. It's also the cleanest way to see *iterators as generalized
> pointers*, a concept the whole STL is built on. Expect "reverse this array in
> place, O(1) extra space" as a warm-up, with follow-ups on iterators, bounds,
> and UB.

## First principles: swap from the ends inward

To reverse a sequence in place, walk one pointer in from the **left** and one in
from the **right**, swapping the elements they point at, until they meet in the
middle. Each element is touched once; no extra buffer is needed.

```text
  [ 10 | 20 | 30 | 40 | 50 ]
    ^lo                ^hi      swap(10,50)
  [ 50 | 20 | 30 | 40 | 10 ]
         ^lo      ^hi           swap(20,40)
  [ 50 | 40 | 30 | 20 | 10 ]
              ^lo,hi            lo >= hi -> stop (30 is the fixed midpoint)
```

```cpp
#include <utility>   // std::swap

void reverse_inplace(int* a, std::size_t n) {
    if (n == 0) return;                 // guard: empty range
    int* lo = a;                        // first element
    int* hi = a + n - 1;                // last element (NOT a + n)
    while (lo < hi) {                   // strict <: stop when they cross/meet
        std::swap(*lo, *hi);            // exchange the two ends
        ++lo;                           // move inward
        --hi;
    }
}
```

Why this is correct and safe:

- `hi` starts at `a + n - 1` (the **last** valid element), not `a + n`
  (one-past-the-end, which you may form but must never dereference).
- The loop condition is `lo < hi`. When `n` is odd, `lo == hi` at the middle and
  we stop — the centre element is its own mirror and needs no swap. When `n` is
  even they cross. Using `lo != hi` instead would be a **bug** for even `n`
  (they step past each other without ever being equal) and risks running off
  both ends — undefined behaviour.
- The `n == 0` guard matters: `a + n - 1` for `n == 0` computes `a - 1`, which is
  *before* the array — forming that address is itself UB. Guard first.

## `std::swap`

`std::swap(x, y)` exchanges two objects. For the trivially-copyable `int`s above
it's three moves the optimizer fuses into register exchanges; for a movable type
(`std::string`) it swaps via move construction/assignment — O(1) pointer
shuffles, not a deep copy. It is the right primitive precisely because it adapts:

```cpp
std::swap(*lo, *hi);     // ints: register moves; strings: swap of internals
```

ADL note: writing `using std::swap; swap(*lo, *hi);` lets a type's own
overloaded `swap` win — the idiom you'd use in fully generic code.

## `std::reverse` — don't hand-roll it

The standard already provides the algorithm, and it does exactly the two-pointer
walk (generalized to bidirectional iterators):

```cpp
#include <algorithm>
#include <vector>
#include <array>

int          c[5] = {1,2,3,4,5};
std::reverse(c, c + 5);                    // raw pointers ARE iterators

std::vector<double> v{...};
std::reverse(v.begin(), v.end());          // member iterators

std::array<int, 4> a{...};
std::ranges::reverse(a);                   // C++20 ranges: pass the range itself
```

`std::reverse` takes a `[first, last)` **half-open** range — `last` is
one-past-the-end, the universal STL convention. Internally it swaps `*first`
with `*--last` while `first != last` (correct for bidirectional iterators
because it decrements `last` *before* comparing). Prefer it: it's correct,
debug-checked under `_GLIBCXX_DEBUG`/`_LIBCPP_DEBUG`, and may be specialized for
speed.

## Iterators are generalized pointers

A raw pointer **is** a random-access iterator: `*it`, `++it`, `it + n`,
`it1 - it2`, and `it1 < it2` all work, which is exactly what `reverse_inplace`
used. The STL abstracts those operations into **iterator categories** so one
algorithm serves arrays, lists, and trees.

| Category | Adds | Example container | Reverse cost |
|---|---|---|---|
| Forward | `++it`, single pass | `forward_list` | n/a (one-directional) |
| Bidirectional | `--it` | `list`, `set`, `map` | O(n), needs `--` |
| Random-access | `it+n`, `it-it`, `<` | array, `vector`, `deque` | O(n), can index |

`std::reverse` requires **bidirectional** iterators (it needs `--last`), so it
works on `std::list` too — but not on a singly-linked `forward_list`, which has
no `--`. A raw pointer satisfies the strongest category (random-access), which
is why the two-pointer `lo < hi` form is available for arrays.

### Reverse iterators

Sometimes you don't want to mutate the array — you want to *traverse* it
backwards. `rbegin()`/`rend()` (and `std::make_reverse_iterator`) give an adaptor
that walks in reverse without touching the data:

```cpp
#include <iterator>
for (auto it = v.rbegin(); it != v.rend(); ++it)   // last -> first
    use(*it);                                       // v itself is unchanged

// A reverse_iterator wraps a base iterator; dereference yields *(base - 1).
```

A `reverse_iterator` stores the underlying iterator and, on dereference, returns
`*(base - 1)` — that "minus one" is how it reconciles the half-open range with
backward iteration. Use reverse iterators for read-back traversal; use
`std::reverse` (or the two-pointer loop) when you actually need the storage
reordered.

## Complexity

- **Time:** O(n) — exactly `floor(n/2)` swaps, each O(1) for trivial types. Every
  element is read and written once.
- **Space:** O(1) — in place; only the two index/iterator variables.
- For non-trivial element types, each swap is O(cost-of-swap); with movable types
  that's still O(1) per element (move-swaps), so the whole reverse stays O(n).

## Cache & access pattern

Reversal's memory pattern is **two converging linear scans** — one ascending
(`lo`), one descending (`hi`):

- The ascending stream (`lo`) is perfectly prefetcher-friendly. The **descending**
  stream (`hi`) is less so: classic next-line hardware prefetchers favour
  forward strides, though modern CPUs detect descending patterns reasonably well.
- For an array that fits in L1/L2, reversal is essentially free; for a large
  array you're bandwidth-bound, reading and writing every cache line once.
- `std::reverse` over trivially-swappable elements can be **vectorized**: load a
  block from each end, byte/lane-shuffle to reverse it, store crosswise. The
  compiler/library may do this; a hand loop with a data-dependent `swap` is
  harder to auto-vectorize, which is one more reason to call `std::reverse`.
- Two-pointer access is sequential and predictable, so **branch prediction** on
  `lo < hi` is trivially accurate (one mispredict at loop exit).

## Quant/HFT relevance & interview gotchas

- **Two-pointer is the pattern, not the trivia.** Interviewers use "reverse in
  place" to check you reason about bounds, the half-open convention, and
  iterators — then extend to partitioning, in-place rotate, or dedup.
- **Off-by-one and the loop condition.** `hi = a + n` (not `a + n - 1`) or
  `lo != hi` instead of `lo < hi` are the two planted bugs. Be precise about why
  `<` is mandatory for even `n`.
- **`n == 0` forms `a - 1`** — guard before computing `a + n - 1`; forming a
  pointer before the array is UB even without a dereference.
- **Know the iterator hierarchy.** "Can you `std::reverse` a `forward_list`?" →
  no (needs bidirectional); "a `std::list`?" → yes. This separates rote from
  understanding.
- **Prefer `std::reverse`/`std::ranges::reverse`** in production; reach for the
  manual loop only to demonstrate the mechanics or when you need a custom
  in-loop side effect.
- **Reverse iterators don't move data** — useful when you want backward reads of
  a buffer (e.g. scanning a log/ring tail-first) without disturbing it.

## Key takeaways

1. Reverse in place with **two pointers** converging from the ends, swapping
   until `lo < hi` fails — `floor(n/2)` swaps, O(n) time, O(1) space.
2. `hi` starts at the **last element** (`a + n - 1`), the condition is **`<`**
   (mandatory for even `n`), and you must **guard `n == 0`** (else `a - 1` is UB).
3. **`std::swap`** adapts to the element type (register moves for `int`, move-
   swaps for movable types) — O(1) per element.
4. Prefer **`std::reverse`** / **`std::ranges::reverse`**; it's the same
   algorithm, debug-checked and possibly vectorized, over half-open `[first,last)`.
5. **Iterators generalize pointers**; `std::reverse` needs **bidirectional**
   iterators (works on `list`, not `forward_list`). A raw pointer is
   random-access.
6. **Reverse iterators** traverse backward without reordering storage
   (`rbegin`/`rend`).

## Self-check

1. Why must the loop use `lo < hi` rather than `lo != hi`? Give the input that
   breaks the `!=` version.
2. What goes wrong if `hi` is initialized to `a + n` instead of `a + n - 1`?
3. Why is the `n == 0` early-return necessary even though the `while` loop body
   never runs for `n == 0`?
4. Can `std::reverse` operate on a `std::forward_list`? On a `std::list`? Which
   iterator capability decides it?
5. How does a `reverse_iterator` relate to its base iterator on dereference, and
   when would you use one instead of `std::reverse`?
6. For a very large array, is reversal compute-bound or bandwidth-bound? Which of
   the two converging streams is friendlier to the hardware prefetcher?

## Further reading

- [`std::reverse`](https://en.cppreference.com/w/cpp/algorithm/reverse) and [`std::ranges::reverse`](https://en.cppreference.com/w/cpp/algorithm/ranges/reverse) — cppreference.
- [`std::swap`](https://en.cppreference.com/w/cpp/algorithm/swap) — cppreference (and the `using std::swap;` ADL idiom).
- [Iterator library & iterator categories](https://en.cppreference.com/w/cpp/iterator) — cppreference.
- [`std::reverse_iterator`](https://en.cppreference.com/w/cpp/iterator/reverse_iterator) and [`rbegin`/`rend`](https://en.cppreference.com/w/cpp/iterator/rbegin) — cppreference.
- [Iterator invalidation & half-open ranges](https://en.cppreference.com/w/cpp/named_req/Iterator) — cppreference named requirements.
- Stepanov & McJones, *Elements of Programming* — the iterator-as-generalized-pointer worldview.

## Videos

- CppCon 2018 — Jonathan Boccara, **"105 STL Algorithms in Less Than an Hour"** ([search](https://www.youtube.com/results?search_query=CppCon+2018+Jonathan+Boccara+105+STL+Algorithms+in+Less+Than+an+Hour)) — places `reverse`/`swap` in the algorithm landscape.
- CppCon 2019 — Conor Hoekstra, **"Algorithm Intuition"** ([search](https://www.youtube.com/results?search_query=CppCon+2019+Conor+Hoekstra+Algorithm+Intuition)) — when to reach for a named algorithm vs a hand loop.
