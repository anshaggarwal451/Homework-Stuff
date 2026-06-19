# Functions and Decorators

> **Why a quant must own this:** Decorators are how you bolt timing, caching,
> retries, and logging onto signal code *without touching the signal*. Closures
> and first-class functions underpin every callback-driven backtester and every
> `functools.lru_cache` that turns a recomputed indicator into a free lookup.
> Interviewers use "write a timing decorator" as a litmus test for whether you
> truly understand that functions are objects.

## First principles: functions are objects

In Python a function is a first-class object — it has attributes, can be stored
in a list, passed as an argument, and returned from another function. This is
the foundation everything else rests on.

```python
def alpha(x):
    return 2 * x

f = alpha            # bind another name to the same object
print(f(10))         # 20
print(alpha.__name__, alpha.__defaults__)   # 'alpha' None
```

A **closure** is a function that captures variables from an enclosing scope.
The captured names are stored in the function's `__closure__` cells, kept alive
for as long as the inner function lives.

```python
def make_scaler(factor):
    def scale(x):
        return x * factor     # 'factor' is captured by closure
    return scale

bps = make_scaler(0.0001)
print(bps(250))               # 0.025  (250 bps as a fraction)
```

## Mechanics: arguments, `*args`, `**kwargs`

Python's call protocol is richer than C-style positional args. Understanding the
ordering rules prevents a class of subtle bugs.

```python
def f(a, b, /, c, d, *args, e, f=0, **kwargs):
    ...
#       ^^^^      positional-only (before /)
#                 ^^^^ positional-or-keyword
#                          ^^^^^ extra positionals collected here
#                                 ^^^^^^^ keyword-only (after *)
```

- Parameters before `/` are **positional-only** (3.8+).
- Parameters after `*` (or `*args`) are **keyword-only** — great for forcing
  callers to be explicit: `def sharpe(returns, *, periods=252)`.
- `*args` collects extra positionals into a tuple; `**kwargs` collects extra
  keywords into a dict.

### The mutable-default-argument trap

Default values are evaluated **once**, at function-definition time, and shared
across all calls. A mutable default is therefore a hidden global.

```python
def add_fill(price, book=[]):     # BUG: 'book' is shared
    book.append(price)
    return book

add_fill(100)        # [100]
add_fill(101)        # [100, 101]  -- leaked across calls!

def add_fill(price, book=None):   # correct idiom
    if book is None:
        book = []
    book.append(price)
    return book
```

## Decorators: a function that wraps a function

A decorator is just a callable that takes a function and returns a replacement.
`@deco` above `def f` is exactly `f = deco(f)`.

```python
import functools, time

def timed(func):
    @functools.wraps(func)            # preserve __name__, __doc__, signature
    def wrapper(*args, **kwargs):
        t0 = time.perf_counter()
        result = func(*args, **kwargs)
        dt = time.perf_counter() - t0
        print(f"{func.__name__} took {dt*1e3:.3f} ms")
        return result
    return wrapper

@timed
def compute_cov(matrix):
    return matrix.T @ matrix          # placeholder for real work
```

`functools.wraps` is not optional cosmetics: without it, `wrapper.__name__`
becomes `"wrapper"`, breaking introspection, tracebacks, and tools that key off
the function name (and it copies `__wrapped__` so you can still reach the
original).

### Decorators with arguments — one more layer

A parameterized decorator is a function returning a decorator returning a
wrapper — three levels deep.

```python
def retry(times=3):
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(times):
                try:
                    return func(*args, **kwargs)
                except ConnectionError:
                    if attempt == times - 1:
                        raise
        return wrapper
    return decorator

@retry(times=5)
def fetch_quote(symbol):
    ...                               # may raise ConnectionError
```

### `lru_cache` — the decorator you'll use most

Memoization turns an expensive pure function into a hash lookup after the first
call. In research code this is gold for recursive or repeatedly-queried
calculations.

```python
from functools import lru_cache

@lru_cache(maxsize=None)
def discount_factor(rate, years):
    return (1 + rate) ** (-years)

discount_factor(0.05, 10)     # computed
discount_factor(0.05, 10)     # cache hit, ~free
print(discount_factor.cache_info())   # hits=1 misses=1 ...
```

Caveats: arguments **must be hashable** (no DataFrames or lists), and the cache
holds references, so caching on huge objects leaks memory. Use `cache_clear()`
between backtests to avoid cross-contamination.

## How `@property` and class decorators fit

Decorators also wrap *methods* and *classes*. `@property`, `@staticmethod`,
`@classmethod`, and `functools.cached_property` are all decorators. The last is
especially useful for lazily-computed, expensive instance attributes:

```python
from functools import cached_property

class Strategy:
    def __init__(self, returns):
        self.returns = returns

    @cached_property
    def sharpe(self):                 # computed once, then cached on the instance
        import numpy as np
        r = np.asarray(self.returns)
        return r.mean() / r.std() * (252 ** 0.5)
```

## Diagram: what `@timed` actually does

```text
   @timed                         timed(compute_cov)
   def compute_cov(m): ...   ==>  returns 'wrapper' closure that:
                                    1. records t0
   compute_cov  ──rebound──▶ wrapper  2. calls original compute_cov
                                    3. prints elapsed, returns result
   call compute_cov(m)  ──▶  wrapper(m)  ──inner──▶  original(m)
```

## Performance reality

- A decorator adds **one extra Python function call** per invocation (a few
  hundred nanoseconds). Negligible for coarse-grained work; *measurable* if you
  decorate a function called millions of times in a tight loop — in that case
  push the loop inside the function or vectorize.
- `lru_cache` lookups are dict lookups: O(1) average, but the cache key is built
  by hashing all arguments every call, which is not free for large tuples.
- `functools.partial` (pre-binding arguments) is implemented in C and is faster
  and clearer than a `lambda` wrapper for fixing parameters.

```python
from functools import partial
annualize = partial(lambda r, p: r * p, p=252)   # bind periods
```

## Quant relevance & interview gotchas

- **"Write a decorator that times a function and preserves its name"** — the
  canonical question. Forgetting `functools.wraps` is the trap.
- **Closures capture variables, not values.** A loop creating closures over the
  loop variable is a classic late-binding bug:
  ```python
  fns = [lambda: i for i in range(3)]
  print([f() for f in fns])     # [2, 2, 2] -- all see final i
  fns = [lambda i=i: i for i in range(3)]   # bind per-iteration via default
  print([f() for f in fns])     # [0, 1, 2]
  ```
- **Stacked decorators apply bottom-up:** `@a` then `@b` over `f` is `a(b(f))`.
- `lru_cache` on a method keeps `self` alive (memory leak across the cache's
  lifetime) and requires hashable args — don't cache on DataFrames.
- Decorators are how production quant frameworks register strategies, expose
  endpoints, and inject instrumentation without polluting business logic.

## Key takeaways

1. Functions are first-class objects; closures capture enclosing variables in
   `__closure__` cells.
2. `@deco` is sugar for `f = deco(f)`; a decorator is any callable returning a
   replacement.
3. Always use `functools.wraps` to preserve metadata and tracebacks.
4. Parameterized decorators need a third nesting level.
5. `lru_cache`/`cached_property` memoize pure work — but args must be hashable.
6. Beware mutable default arguments and late-binding closures over loop vars.

## Self-check

1. Rewrite `f = timed(compute_cov)` to use `@` syntax and explain what
   `compute_cov.__name__` prints with vs without `functools.wraps`.
2. Why does `[lambda: i for i in range(3)]` yield three functions that all
   return 2? How do you fix it?
3. What are the two hard requirements on arguments passed to an `lru_cache`-d
   function?
4. Write a decorator `@retry(times=3)` from scratch; how many nested functions
   does it need and why?
5. When is `functools.partial` preferable to a `lambda`?
6. What goes wrong if you `@lru_cache` an instance method, and how would you
   detect it?

## Further reading

- [`functools` — Python docs](https://docs.python.org/3/library/functools.html) (`wraps`, `lru_cache`, `cached_property`, `partial`).
- [PEP 318 — Decorators for Functions and Methods](https://peps.python.org/pep-0318/).
- [Primer on Python Decorators — Real Python](https://realpython.com/primer-on-python-decorators/).
- [Defining Functions — Python tutorial](https://docs.python.org/3/tutorial/controlflow.html#defining-functions) (argument forms, `*args`/`**kwargs`).
- Luciano Ramalho, *Fluent Python*, 2nd ed., Ch. 7-9 (functions as objects, closures, decorators).

## Videos

- Reuven Lerner — **"Practical decorators"** (PyCon 2019) ([search](https://www.youtube.com/results?search_query=Reuven+Lerner+Practical+decorators+PyCon+2019)).
- Dave Beazley — **"Python 3 Metaprogramming"** (PyCon) ([search](https://www.youtube.com/results?search_query=David+Beazley+Python+3+Metaprogramming)).
