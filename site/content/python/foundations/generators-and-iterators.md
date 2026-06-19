# Generators and Iterators

> **Why a quant must own this:** Tick files, trade logs, and order-event streams
> are often far larger than RAM. Generators let you process them one record at a
> time with O(1) memory, build lazy pipelines that fuse transformations, and
> stream results without ever materializing a giant list. The iterator protocol
> is also the contract behind every `for` loop, `zip`, and `itertools` recipe —
> understanding it is the difference between "writes Python" and "writes
> *streaming* Python."

## First principles: the iterator protocol

The `for` loop is sugar over two methods:

- **Iterable**: an object with `__iter__()` that returns an iterator.
- **Iterator**: an object with `__next__()` that returns the next value or
  raises `StopIteration` when exhausted. Its `__iter__` returns itself.

```python
it = iter([10, 20, 30])      # list is iterable -> gives an iterator
print(next(it))              # 10
print(next(it))              # 20
print(next(it), next(it))    # 30, then StopIteration is raised
```

```text
   for x in obj:           obj.__iter__()  ──▶  iterator
       ...                 loop: iterator.__next__()  -> value
                                  ...repeat until StopIteration
```

A key consequence: an **iterator is single-use**. Once exhausted it yields
nothing more. A *list* is re-iterable (its `__iter__` makes a fresh iterator each
time); a *generator* is not.

## Generators: iterators you write with `yield`

A function containing `yield` is a **generator function**. Calling it doesn't run
the body — it returns a *generator object* (an iterator). Each `next()` runs to
the next `yield`, suspends, and returns the value; local state (variables, the
instruction pointer) is frozen between calls.

```python
def returns(prices):
    """Lazily yield simple returns from a price stream."""
    prev = None
    for p in prices:
        if prev is not None:
            yield p / prev - 1.0       # suspend here, resume on next next()
        prev = p

gen = returns([100, 101, 99, 103])
print(list(gen))    # [0.01, -0.0198..., 0.0404...]
```

This is **lazy**: nothing computes until you iterate, and only one return is in
memory at a time — regardless of how long the price stream is.

### Generator expressions

The lazy cousin of a list comprehension; use parentheses instead of brackets.

```python
total = sum(p * q for p, q in fills)   # no intermediate list built
# vs sum([p * q for p, q in fills])    # materializes a throwaway list first
```

For an aggregate fed straight into `sum`/`max`/`any`, the generator form saves
the entire intermediate allocation.

## Mechanics: lazy pipelines and `itertools`

Generators compose into pipelines where each stage pulls from the previous one,
so a billion-row file flows through transform → filter → aggregate with constant
memory. `itertools` provides C-speed building blocks.

```python
import itertools as it

def read_ticks(path):
    with open(path) as f:
        for line in f:                       # files are themselves iterators
            ts, sym, px = line.split(",")
            yield ts, sym, float(px)

def only(symbol, stream):
    for ts, sym, px in stream:
        if sym == symbol:
            yield ts, px

pipeline = only("AAPL", read_ticks("ticks.csv"))
first_five = list(it.islice(pipeline, 5))     # pull just 5, file barely read
```

Indispensable `itertools` recipes for quant work:

```python
import itertools as it
xs = [1, 2, 3, 4, 5]

list(it.accumulate(xs))                 # [1, 3, 6, 10, 15] -> running sum / cumprod
list(it.pairwise(xs))                   # [(1,2),(2,3),(3,4),(4,5)] -> adjacent windows (3.10+)
list(it.chain([1, 2], [3, 4]))          # flatten without concatenating in memory
list(it.islice(it.count(0, 2), 4))      # [0, 2, 4, 6] -> lazy slice of infinite stream
list(it.groupby("AABBC"))               # group *consecutive* equal keys
```

## `yield from`, `send`, and coroutines

`yield from sub_gen` delegates to a sub-generator — clean for flattening and
recursion. Generators can also *receive* values via `send`, the basis of
coroutine patterns (and historically of `asyncio`).

```python
def running_mean():
    total, n = 0.0, 0
    avg = None
    while True:
        x = yield avg          # receive a value, yield the current mean
        total += x
        n += 1
        avg = total / n

rm = running_mean()
next(rm)                       # prime the coroutine
print(rm.send(10))             # 10.0
print(rm.send(20))             # 15.0
print(rm.send(30))             # 20.0
```

## Generators vs building a list — the trade-off

| Aspect            | List comprehension          | Generator                       |
|-------------------|-----------------------------|---------------------------------|
| Memory            | O(n) — all elements at once | O(1) — one element at a time    |
| Re-iterable       | yes                         | no (single-use)                 |
| Random access     | yes (`xs[i]`, `len`)        | no                              |
| Best for          | small data reused often     | large/streaming, one pass       |
| `len()`/indexing  | works                       | raises / unsupported            |

## Performance reality

- Generators trade **memory for a small per-item overhead**: each `next()` is a
  Python-level resume of the frame, costing tens to a few hundred nanoseconds.
  For a one-pass stream that doesn't fit in RAM, that's a non-issue and the only
  viable approach.
- For *numeric bulk* work that *does* fit in memory, a vectorized NumPy
  operation beats a Python generator by 10-100×, because the loop runs in C with
  no per-element Python overhead. Generators win on **memory and streaming**,
  not raw arithmetic throughput.
- `itertools` functions run their loops in C and are far faster than equivalent
  hand-written Python loops — prefer them.
- Don't `list(gen)` just to get a length or to iterate twice if you can avoid
  it; that throws away the memory advantage. Use `itertools.tee` (with care — it
  buffers) only when you genuinely need two passes.

## Quant relevance & interview gotchas

- **Single-use exhaustion** is the #1 bug: `data = returns(prices); list(data);
  list(data)` — the second list is empty. If you need it twice, either rebuild
  the generator or materialize once into a list.
- **Memory:** reading a multi-GB tick file with `pd.read_csv(...)` may blow up;
  a generator pipeline or `chunksize=` streams it.
- **Laziness hides exceptions:** an error inside a generator only fires when you
  *iterate to that point*, not when you create it — surprising in pipelines.
- **`StopIteration` inside a generator** is swallowed/converted (PEP 479): raising
  it manually in a generator body becomes a `RuntimeError`. Use `return` to stop.
- **Interview classic:** "implement a Fibonacci/sliding-window/`enumerate`
  generator" — they want to see `yield`, correct state handling, and awareness
  of laziness and single-use semantics.

## Key takeaways

1. Iterable → has `__iter__`; iterator → has `__next__` and raises
   `StopIteration`; the `for` loop drives both.
2. A `yield` function returns a lazy, single-use generator that freezes local
   state between values.
3. Generators give O(1) memory and compose into streaming pipelines — ideal for
   data larger than RAM.
4. `itertools` (`accumulate`, `pairwise`, `islice`, `chain`, `groupby`) provides
   C-speed lazy primitives.
5. Generators win on memory/streaming; NumPy vectorization wins on numeric
   throughput.
6. Watch for single-use exhaustion, deferred exceptions, and PEP 479
   `StopIteration` handling.

## Self-check

1. Distinguish an *iterable* from an *iterator*. Which one does `iter()` return,
   and which can you call `next()` on?
2. Why does iterating the same generator object twice yield nothing the second
   time, while iterating a list twice works?
3. Rewrite `sum([x*x for x in data])` to avoid building the intermediate list,
   and say what you save.
4. What does `yield from` do, and give a case where it's cleaner than a loop?
5. You have a 50 GB trade log and need the total notional per symbol. Sketch a
   constant-memory generator pipeline.
6. Why might an exception raised by a buggy transform appear only "later" in a
   generator pipeline?

## Further reading

- [Generators — Python tutorial](https://docs.python.org/3/tutorial/classes.html#generators) and [Iterators](https://docs.python.org/3/tutorial/classes.html#iterators).
- [`itertools` — Python docs](https://docs.python.org/3/library/itertools.html) (and the "Itertools Recipes" section).
- [PEP 255 — Simple Generators](https://peps.python.org/pep-0255/) and [PEP 380 — `yield from`](https://peps.python.org/pep-0380/).
- [PEP 479 — Change StopIteration handling inside generators](https://peps.python.org/pep-0479/).
- Luciano Ramalho, *Fluent Python*, 2nd ed., Ch. 17 (iterators, generators, coroutines).

## Videos

- David Beazley — **"Generators: The Final Frontier"** ([search](https://www.youtube.com/results?search_query=David+Beazley+Generators+The+Final+Frontier)).
- David Beazley — **"Generator Tricks for Systems Programmers"** ([search](https://www.youtube.com/results?search_query=David+Beazley+Generator+Tricks+for+Systems+Programmers)).
