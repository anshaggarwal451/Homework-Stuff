# std::list

> **Why a quant dev must own this:** `std::list` is the container you'll most
> often be asked about *so you can explain why you wouldn't use it.* Its
> textbook O(1) splice/insert looks attractive, but its node-per-element heap
> allocation and pointer-chasing access pattern make it **cache-hostile** — and
> on modern hardware, cache misses dominate. Knowing precisely when a linked
> list is justified (rarely) — and reaching for an **intrusive** list when it
> genuinely is — separates someone who memorised Big-O from someone who
> understands the machine.

## First principles: a doubly-linked list of heap nodes

`std::list<T>` is a **doubly-linked list**. Each element lives in its own
separately-allocated node that also stores forward and backward pointers:

```cpp
template <class T>
struct list_node {     // conceptual; one heap allocation per element
    list_node* prev;
    list_node* next;
    T          value;
};
```

The list object holds pointers to the head and tail (and a size, since C++11).
Elements are **not** stored contiguously — each `push_back` does a separate heap
allocation and the resulting nodes can be scattered anywhere in memory.

```text
 list:  head ─┐                                         ┌─ tail
             v                                          v
        +------+      +------+      +------+      +------+
   null←| prev |  ┌──←| prev |  ┌──←| prev |  ┌──←| prev |
        | next |─→┘   | next |─→┘   | next |─→┘   | next |→ null
        | val  |      | val  |      | val  |      | val  |
        +------+      +------+      +------+      +------+
        (heap A)      (heap B)      (heap C)      (heap D)   ← scattered!
```

Contrast with `std::vector`, where all values sit in one contiguous block. That
single structural difference drives everything below.

## What `std::list` gives you

- **O(1) insert and erase anywhere**, *given an iterator to the position* — just
  relink four pointers; no elements shift. (`vector` insert/erase in the middle
  is O(n) because it shifts the tail.)
- **O(1) `splice`** — move a range of nodes from one list to another by
  pointer surgery, without moving or copying any elements. This is `list`'s one
  genuinely unique capability.
- **Stable iterators, pointers, and references.** Inserting or erasing
  *elsewhere* in the list never invalidates iterators/pointers/references to
  other elements. Only the iterator to an *erased* element is invalidated.
  (`vector` invalidates on reallocation; `list` never reallocates other nodes.)
- **No reallocation, no move-on-grow.** Each node is independent, so growth never
  touches existing elements — handy for large or non-movable element types.

## What it costs you

- **No random access.** There is no `operator[]` and no `.at()`. Reaching the
  *k*-th element is O(k) — you walk the chain. `std::advance(it, k)` is a loop.
- **A heap allocation per element.** Every insert calls the allocator; every
  erase frees. That allocator traffic alone can dwarf the work you're doing.
- **Pointer-chasing → cache misses.** To visit the next element you must
  dereference `next`, and that node may be anywhere. Each hop is a potential
  cache miss with no useful prefetching, because the address isn't known until
  the previous load completes (a dependent-load chain).
- **Per-element memory overhead.** Two pointers (16 bytes on a 64-bit box) plus
  allocator bookkeeping per element, on top of `sizeof(T)`.

## Why traversal is slow: the access-pattern contrast

Summing a sequence shows the difference in one picture. A `vector` walk is a
linear scan over contiguous memory; a `list` walk is a chain of dependent loads:

```x86asm
; vector<int> sum loop body — sequential, prefetchable, vectorizable
.loop_vec:
        add     eax, DWORD PTR [rdi]   ; load value, address known in advance
        add     rdi, 4                 ; next address = +4 (prefetcher loves this)
        cmp     rdi, rsi
        jne     .loop_vec

; list<int> sum loop body — pointer chase, each load depends on the previous
.loop_list:
        add     eax, DWORD PTR [rdi+16]; value at node offset
        mov     rdi, QWORD PTR [rdi+8] ; rdi = node->next  ← must finish before next iter
        test    rdi, rdi
        jne     .loop_list
```

The killer is the `mov rdi, [rdi+8]`: the address of the *next* load isn't
known until *this* load returns. The CPU can't run ahead, the prefetcher has
nothing to predict, and you eat memory latency on (potentially) every hop. The
`vector` loop, by contrast, has fully predictable addresses and auto-vectorizes.
This is why **`vector` usually beats `list` even for insertion-heavy workloads**:
the O(n) shift in a `vector` is a tight contiguous `memmove` the hardware loves,
while the O(1) `list` insert is preceded by an O(n) cache-missing *traversal* to
find the insertion point — and the constant factors favour contiguity by a wide
margin.

## `std::forward_list` — the singly-linked sibling

`std::forward_list<T>` (C++11) keeps only a `next` pointer per node (no `prev`),
saving 8 bytes per element and the back-link bookkeeping. The cost: it's
forward-only and its mutators are awkward — operations work via the *preceding*
iterator (`insert_after`, `erase_after`, `before_begin()`), and it deliberately
has **no `size()`** to stay as lean as a hand-rolled list. It's the choice when
you want the absolute minimum node overhead and only ever traverse forward — but
it inherits all of `list`'s cache problems.

## When a linked list is *actually* justified (rare)

`std::list` earns its keep only when its specific guarantees matter *and* the
cache cost is acceptable:

- **Frequent splicing of large sub-ranges** between lists with no copying —
  `splice` is genuinely O(1) and unique to linked structures.
- **Reference/iterator stability is a hard requirement** — other code holds
  long-lived pointers/iterators to elements while the container is mutated
  elsewhere (a `vector` would invalidate them on reallocation).
- **Elements are large and non-movable/non-copyable**, so a `vector` grow would
  be expensive or impossible — node-per-element growth never touches existing
  elements.
- **Stable addresses for nodes** are needed (e.g. external structures point at
  elements).

Even then, measure: a `std::deque`, a `vector` of indices, a slot-map, or an
intrusive list is frequently a better answer.

## Performance & hardware reality

- **Allocation overhead** per element is real and shows up immediately — a
  `list` of *n* elements is *n* allocator calls and *n* frees.
- **Cache misses dominate traversal.** Pointer chasing serializes on memory
  latency; there's no spatial locality and the prefetcher is blind.
- **Memory bloat:** `sizeof(node) = sizeof(T) + 2*sizeof(ptr) + alloc overhead`,
  scattered across the heap — worse TLB and cache-line utilisation.
- A custom **pool/arena allocator** can recover the allocation cost and cluster
  nodes for *some* locality, which is the standard mitigation when you must use a
  node-based structure.

## Quant/HFT relevance & interview gotchas

- **The honest answer is "I usually wouldn't."** For order books, queues, and
  buffers, contiguous structures (`vector`, ring buffers, `deque`) win on
  latency because of cache behaviour. Saying "`list` is O(1) insert so it's
  faster" without the cache caveat is a red flag in an HFT interview.
- **Intrusive lists are the HFT idiom.** When you do need O(1) splice/erase with
  stable nodes — e.g. an order resting in a price-level queue that must be
  cancelled in O(1) — you embed the `prev`/`next` links *inside the element
  itself* (Boost.Intrusive, or a hand-rolled intrusive list). This gives:
  **zero per-node allocation** (the node *is* the order, allocated once from a
  pool), O(1) unlink given a pointer to the element, and no `std::list`
  double-indirection. That's why production matching-engine/order-cancel paths
  use intrusive lists, not `std::list`.
- **Know the invalidation contrast cold:** `list` never invalidates other
  elements' iterators on insert/erase; `vector` invalidates everything on
  reallocation. This stability is the *only* thing that occasionally tips the
  choice toward `list`.
- **`splice` is the one trick `vector` can't do** — be ready to name it as
  `list`'s genuine O(1) advantage.
- **`forward_list` has no `size()`** and mutates via `*_after` operations — a
  small but common quiz point.

## Key takeaways

1. `std::list` is a **doubly-linked list of heap-allocated nodes** — one
   allocation per element, non-contiguous, two link pointers per node.
2. It offers **O(1) insert/erase/splice given an iterator** and **stable
   iterators/references** (only the erased element's iterator is invalidated).
3. It pays for that with **no random access**, **per-element allocation**, and
   **cache-hostile pointer chasing** (dependent loads, no prefetch).
4. **`vector` usually wins anyway** — even for "many insertions" — because
   contiguous access and the prefetcher beat linked-list constant factors;
   finding the insertion point is still an O(n) cache-missing walk.
5. In HFT, when you truly need O(1) unlink with stable nodes, use an
   **intrusive list** (pool-allocated, links inside the element), not
   `std::list`. `forward_list` is the leaner singly-linked variant with no
   `size()`.

## Self-check

1. How many heap allocations does building a `std::list` of 1,000 elements
   cause, and how many does an equivalent `std::vector` (with `reserve`) cause?
2. Why is `list` insert/erase O(1) only *given an iterator*, and what's the cost
   of *getting* that iterator at position *k*?
3. Explain the dependent-load chain that makes `list` traversal slow even though
   it's "just following pointers".
4. Name the one operation `std::list` does in O(1) that `std::vector` genuinely
   cannot.
5. What does an intrusive list change versus `std::list`, and why does that
   matter in an order-cancel hot path?
6. Why does `std::forward_list` omit `size()` and use `insert_after`/`erase_after`?

## Further reading

- [`std::list` — cppreference](https://en.cppreference.com/w/cpp/container/list) and [`std::forward_list`](https://en.cppreference.com/w/cpp/container/forward_list).
- [`std::list::splice` — cppreference](https://en.cppreference.com/w/cpp/container/list/splice) — the O(1) node-relink operation.
- [Boost.Intrusive — design and rationale](https://www.boost.org/libs/intrusive/) — how intrusive lists avoid per-node allocation and double indirection.
- Bjarne Stroustrup, ["Software Development for Infrastructure" / the famous *vector vs list* benchmark slides](https://www.stroustrup.com/Software-for-infrastructure.pdf) — why `vector` beats `list` in practice.
- Scott Meyers, *Effective STL*, Item 1 ("choose your containers with care") and the container-selection discussion.
- [C++ Core Guidelines — Containers (SL.con)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#slcon-containers) — default to contiguous containers.
- [Agner Fog — Optimizing software in C++](https://www.agner.org/optimize/optimizing_cpp.pdf) — cache effects and data-structure choice for performance.

## Videos

- CppCon — Chandler Carruth, **"Efficiency with Algorithms, Performance with Data Structures"** (CppCon 2014) ([search](https://www.youtube.com/results?search_query=CppCon+2014+Chandler+Carruth+Efficiency+with+Algorithms+Performance+with+Data+Structures)) — the canonical demolition of linked lists on modern hardware.
- Bjarne Stroustrup — **"Are lists evil?" / vector-vs-list benchmark talk** ([search](https://www.youtube.com/results?search_query=Stroustrup+are+lists+evil+vector+vs+list)).
- CppCon — talks on **Boost.Intrusive / intrusive containers** ([search](https://www.youtube.com/results?search_query=CppCon+intrusive+containers+boost+intrusive)).
