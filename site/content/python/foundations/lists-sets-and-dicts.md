# Lists, Sets, and Dicts

> **Why a quant must own this:** These three containers are the load-bearing
> walls of every Python research script — they hold your universe of tickers,
> your signal lookups, your dedup logic. Choosing the wrong one turns an O(1)
> membership test into an O(n) scan that quietly makes a backtest 100× slower.
> Interviewers probe this because it instantly reveals whether you reason about
> complexity or just reach for `list` by reflex.

## First principles: what each container *is*

Python's built-in collections are not interchangeable; each encodes a different
trade-off between **ordering**, **uniqueness**, and **lookup cost**.

- **`list`** — an ordered, mutable, *dynamic array* of object references.
  Indexing and append are O(1) amortized; membership (`x in lst`) and deletion
  by value are O(n).
- **`dict`** — an ordered (insertion order, guaranteed since 3.7), mutable
  *hash table* mapping keys to values. Lookup/insert/delete are O(1) average.
- **`set`** — the same hash table as `dict`, but storing only keys. O(1)
  membership; no duplicates; unordered.

The mental model that prevents most mistakes: **`list` is "I care about order and
position", `dict`/`set` is "I care about identity and fast lookup."**

## Mechanics & internals

### `list` is an array of pointers, not of values

A CPython `list` is a contiguous C array of `PyObject*` pointers plus a length
and an allocated capacity. The objects themselves live elsewhere on the heap.
This is why a `list` of a million ints costs far more than a NumPy `int64`
array of a million: each element is a full boxed `PyObject` (28 bytes for a
small int) *plus* an 8-byte pointer in the array.

```python
import sys
xs = [1, 2, 3]
print(sys.getsizeof(xs))        # array overhead + 3 pointers (~88 on CPython 3.12)
xs.append(4)
print(sys.getsizeof(xs))        # capacity over-allocated, so size jumps in chunks
```

Appending is **amortized** O(1): when the backing array fills, CPython
reallocates to roughly 1.125× the size (the growth factor is modest, not 2×),
copying all pointers. Inserting/deleting at the *front* is O(n) because every
pointer shifts — reach for `collections.deque` if you need fast ends.

### `dict` and `set` are open-addressing hash tables

Both compute `hash(key)`, mask it to an index, and probe. CPython's `dict` uses
a **compact** layout (since 3.6): a dense `entries` array preserving insertion
order, plus a sparse `indices` array of slots pointing into it. That compactness
is why dicts shrank ~20-25% in memory and gained ordering "for free."

Two consequences you must internalize:

1. **Keys must be hashable** — i.e. immutable-ish and implement `__hash__` +
   `__eq__`. `list` and `dict` are unhashable; `tuple` and `frozenset` are
   hashable (if their contents are).
2. **Hash collisions degrade to O(n)** in the worst case. With adversarial keys
   you can force collisions, but for ordinary data the average is O(1).

```python
prices = {"AAPL": 189.4, "MSFT": 430.1}
prices["AAPL"]                 # O(1) average
("AAPL", "2024-01-02") in some_set   # tuple key — hashable, O(1)
# [1,2] in some_set           # TypeError: unhashable type: 'list'
```

## The complexity table you must memorize

| Operation                | `list`    | `dict`        | `set`         |
|--------------------------|-----------|---------------|---------------|
| Index `a[i]`             | O(1)      | n/a           | n/a           |
| Key lookup `a[k]`        | n/a       | O(1) avg      | n/a           |
| `x in a` (membership)    | **O(n)**  | O(1) avg      | O(1) avg      |
| Append / add             | O(1) amort| O(1) avg      | O(1) avg      |
| Insert/delete at front   | O(n)      | n/a           | n/a           |
| Delete by key/value      | O(n)      | O(1) avg      | O(1) avg      |
| Preserves order          | yes       | yes (insertion)| no           |

> **The single most common slowdown in research code:** doing `if ticker in
> universe` where `universe` is a `list`. Convert it to a `set` once and the
> loop drops from O(n·m) to O(n).

## Idiomatic, runnable patterns

```python
from collections import Counter, defaultdict

trades = [
    ("AAPL", 100), ("MSFT", 50), ("AAPL", 75), ("AAPL", -25), ("MSFT", 30),
]

# 1. Aggregate signed volume per symbol — defaultdict avoids key-existence checks
vol = defaultdict(int)
for sym, qty in trades:
    vol[sym] += qty
print(dict(vol))                      # {'AAPL': 150, 'MSFT': 80}

# 2. Count occurrences — Counter is purpose-built and C-fast
fills = Counter(sym for sym, _ in trades)
print(fills.most_common(1))           # [('AAPL', 3)]

# 3. Fast membership: dedup a universe and test inclusion in O(1)
universe = {"AAPL", "MSFT", "GOOG", "AMZN"}
print("AAPL" in universe)             # True, O(1)

# 4. Set algebra for portfolio reconciliation
held   = {"AAPL", "MSFT", "TSLA"}
target = {"AAPL", "GOOG"}
print(target - held)   # {'GOOG'}  -> to buy
print(held - target)   # {'MSFT', 'TSLA'} -> to sell

# 5. Comprehensions: the idiomatic, fast way to build containers
squares = {x: x * x for x in range(5)}        # dict comprehension
evens   = {x for x in range(10) if x % 2 == 0} # set comprehension
```

### Views vs copies — a slicing trap

`list` slicing **copies**: `prices[10:20]` builds a new list of references.
Dict views (`.keys()`, `.items()`, `.values()`) are **live views** — they
reflect later mutations and must not be mutated during iteration.

```python
d = {"a": 1, "b": 2}
ks = d.keys()
d["c"] = 3
print(list(ks))        # ['a', 'b', 'c'] — the view updated
# for k in d: del d[k] # RuntimeError: dictionary changed size during iteration
```

## Performance reality

- **Membership:** `set`/`dict` beat `list` by orders of magnitude as n grows.
  Always hoist a repeated `in list` test into a one-time `set(...)` conversion.
- **Memory:** a `set`/`dict` carries hash-table slack (load factor ~2/3), so it
  uses ~2-3× the memory of the bare elements. A `list` is leaner but its O(n)
  search is the killer. For *millions of numeric values you scan*, neither is
  right — use a NumPy array (covered later in this track).
- **Construction:** comprehensions are faster than an explicit `append` loop
  because they avoid repeated `LOAD_METHOD`/`CALL` of `.append`. `Counter` and
  `dict.fromkeys` push the loop into C.
- **`deque`:** for FIFO/rolling windows, `collections.deque(maxlen=N)` gives
  O(1) append-and-evict, unlike `list.pop(0)` which is O(n).

```python
from collections import deque
window = deque(maxlen=20)            # 20-period rolling buffer
for price in stream:
    window.append(price)            # O(1); oldest auto-evicted
    if len(window) == 20:
        signal = sum(window) / 20   # simple moving average
```

## Quant relevance & interview gotchas

- **Mutable default argument:** `def f(acc=[])` shares one list across calls —
  a classic bug. Use `acc=None` then `acc = acc or []`.
- **Dict ordering** is guaranteed insertion order *as a language spec* since
  3.7, but **never rely on it for sorting** — sort explicitly.
- **`set` is unordered** and its iteration order can change between runs
  (hash randomization for strings via `PYTHONHASHSEED`). Don't seed a backtest
  off `for x in some_set`.
- **`float('nan')` as a key/element** never equals itself, so it can be inserted
  twice and never found — a real hazard when keying on computed values.
- **Tuple keys** are the idiomatic multi-dimensional lookup: `panel[(date, sym)]`.
- Interviewers love: *"Find the first non-repeating element"* (one pass to a
  `Counter`, second pass over the list) and *"two-sum"* (a `dict` of
  complements) — both hinge on swapping an O(n) scan for an O(1) hash lookup.

## Key takeaways

1. `list` = ordered dynamic array; `dict`/`set` = hash tables with O(1) lookup.
2. Membership in a `list` is O(n); in a `set`/`dict` it's O(1) — convert before
   looping.
3. Dict preserves insertion order and is memory-compact since 3.6/3.7; set is
   unordered.
4. Keys/elements must be **hashable** (immutable): use `tuple`/`frozenset`, not
   `list`.
5. Reach for `defaultdict`, `Counter`, and `deque` instead of hand-rolling.
6. For millions of *numbers*, none of these are the answer — use NumPy.

## Self-check

1. You repeatedly test `ticker in tradable` inside a hot loop. `tradable` is a
   list of 5,000 names. What one change gives the biggest speedup, and why?
2. Why can a `tuple` be a dict key but a `list` cannot?
3. What is the amortized vs worst-case cost of `list.append`, and what causes
   the worst case?
4. Explain why `d.keys()` reflects a mutation made after you called it.
5. Why might iterating a `set` of strings produce a different order across two
   process runs?
6. When would you choose `deque(maxlen=N)` over a `list` for a rolling window?

## Further reading

- [Built-in Types — Python docs](https://docs.python.org/3/library/stdtypes.html#sequence-types-list-tuple-range) (lists, sets, dicts).
- [`collections` — container datatypes](https://docs.python.org/3/library/collections.html) (`defaultdict`, `Counter`, `deque`).
- [TimeComplexity — Python Wiki](https://wiki.python.org/moin/TimeComplexity) — the canonical big-O table for built-ins.
- [Raymond Hettinger on the compact dict](https://mail.python.org/pipermail/python-dev/2016-September/146327.html) (PyDev mailing-list rationale).
- Luciano Ramalho, *Fluent Python*, 2nd ed., Ch. 3 (dicts & sets) — the deepest practical treatment.

## Videos

- Brandon Rhodes — **"The Mighty Dictionary"** (PyCon) ([search](https://www.youtube.com/results?search_query=Brandon+Rhodes+The+Mighty+Dictionary+PyCon)).
- Raymond Hettinger — **"Modern Python Dictionaries: A Confluence of a Dozen Great Ideas"** (PyCon 2017) ([search](https://www.youtube.com/results?search_query=Raymond+Hettinger+Modern+Python+Dictionaries)).
