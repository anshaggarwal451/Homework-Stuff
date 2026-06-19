# Vectorization Patterns

> **Why a quant must own this:** Vectorization is the craft of expressing a
> computation as whole-array operations so the loop runs in C, not the
> interpreter. It's how you turn an hours-long backtest into a seconds-long one.
> But "vectorize everything" is too glib — the real skill is recognizing the
> *patterns* (masking, `cumsum` tricks, `np.where`, segment reductions) that map
> sequential logic onto array ops, and knowing the memory/lookahead traps each
> introduces. This is the most practically valuable lesson in the performance
> module.

## First principles: replace the loop with an expression

The CPython lesson established *why* loops are slow. Vectorization is the *how* of
avoiding them: restate "for each element, do X" as an operation over the whole
array, dispatched once into compiled C over a contiguous buffer.

```python
import numpy as np, pandas as pd

# SLOW: Python loop, per-element interpreter + boxing overhead
def returns_loop(prices):
    out = []
    for i in range(1, len(prices)):
        out.append(prices[i] / prices[i-1] - 1)
    return out

# FAST: one vectorized expression -> simple returns
prices = np.array([100., 101., 99., 103.])
ret = prices[1:] / prices[:-1] - 1          # shifted-slice arithmetic
```

The trick in the fast version — **offset slices** (`prices[1:]` vs
`prices[:-1]`) — is the canonical way to express "compare each element to its
neighbor" without a loop. It's a view (no copy) of each operand.

## Pattern 1 — Masking instead of `if`

A per-element conditional becomes a boolean mask + `np.where`/`np.select`.

```python
ret = np.random.default_rng(0).standard_normal(1000)

signal = np.where(ret > 0, 1, -1)                 # vectorized ternary
sig3   = np.select([ret > 0.02, ret < -0.02],     # multi-branch
                   [1, -1], default=0)
winsor = np.clip(ret, -0.05, 0.05)                # cap outliers
ret[np.abs(ret) > 0.1] = np.nan                   # in-place conditional update
```

**Trap:** `np.where(cond, f(x), g(x))` evaluates **both** `f(x)` and `g(x)`
fully (they're arrays), so `np.where(x > 0, np.log(x), 0)` still computes
`log` of non-positive values and warns. Mask the *input* or use `np.errstate`.

## Pattern 2 — Cumulative tricks (`cumsum`/`cumprod`)

Running totals, equity curves, and drawdowns are accumulations, not loops.

```python
simple_ret = np.array([0.01, -0.02, 0.03])
equity = np.cumprod(1 + simple_ret)               # compounded value path
log_eq = np.exp(np.cumsum(np.log1p(simple_ret)))  # same, precision-friendly

peak = np.maximum.accumulate(equity)              # running max -> for drawdown
drawdown = equity / peak - 1                       # vectorized drawdown series
```

`np.maximum.accumulate` (running max) for drawdowns is a pattern worth
memorizing — it replaces a stateful loop tracking the high-water mark.

## Pattern 3 — Boolean-mask aggregation and counting

```python
big_moves = np.abs(ret) > 0.02
big_moves.sum()                 # count of large moves (True == 1)
big_moves.mean()                # fraction of days with large moves
ret[ret > 0].mean()             # conditional mean (mask then reduce)
np.count_nonzero(ret > 0)       # fast count
```

## Pattern 4 — Segment / grouped reductions without loops

When you must aggregate by group, vectorized tools beat Python loops:

```python
groups = np.array([0, 0, 1, 1, 2])
vals   = np.array([10., 20., 30., 40., 50.])
np.add.at(np.zeros(3), groups, vals)     # unbuffered scatter-add -> [30, 70, 50]
np.bincount(groups, weights=vals)         # same, often faster for int groups

# In pandas, this IS groupby (the previous module) -- vectorized in Cython
```

`np.add.at` / `np.bincount` are the NumPy primitives behind grouped sums; pandas
`groupby` is the labeled, higher-level version.

## Pattern 5 — `einsum` and matrix ops for multi-dim reductions

```python
W = np.random.default_rng(0).standard_normal((250, 5))   # weights over time
R = np.random.default_rng(1).standard_normal((250, 5))   # returns
port_ret = np.einsum("ti,ti->t", W, R)        # per-day dot product (rowwise)
# equivalently: (W * R).sum(axis=1)
cov = R.T @ R / len(R)                          # covariance via matrix multiply
```

`einsum` expresses arbitrary index contractions in one call (and can avoid
intermediates); `@` routes to BLAS. Both crush explicit loops.

## When NOT to vectorize (or how to do it carefully)

- **Path-dependent / stateful logic** (a stop-loss whose trigger depends on the
  running position, an order-book replay) doesn't vectorize cleanly. Either
  reformulate (many path-dependent quantities *are* `cumsum`/`accumulate` in
  disguise) or use **Numba** (next lesson) to keep an explicit loop at C speed.
- **Early exit / irregular control flow** — vectorizing forces you to compute the
  whole array even when a loop would stop early; sometimes the loop (in Numba)
  wins.
- **Huge intermediates** — a vectorized expression can materialize a giant
  temporary (the broadcasting memory bomb). Chunk the data or use `out=`/in-place
  ops to bound memory.

## pandas vectorization: avoid `apply`/`iterrows`

```python
df = pd.DataFrame({"close": prices})

# SLOW (per-row Python): df.apply(..., axis=1), df.iterrows()
# FAST (column ops):
df["ret"]    = df["close"].pct_change()
df["logret"] = np.log1p(df["ret"])
df["signal"] = np.where(df["close"] > df["close"].rolling(20).mean(), 1, -1)
df["pnl"]    = df["signal"].shift(1) * df["ret"]     # note shift(1): no lookahead
```

`Series.str`, `Series.dt`, `rolling`, `ewm`, and arithmetic are all vectorized.
`df.apply(f, axis=1)` and `iterrows()` fall back to per-row Python and are the
classic anti-patterns.

## Performance reality

- Vectorized array ops are typically **10-100×** faster than the Python-loop
  equivalent, for the reasons in the CPython lesson (no per-element dispatch/
  boxing, contiguous memory, SIMD).
- **Memory vs speed trade:** chaining many vectorized ops creates intermediate
  arrays. `a = b + c; a *= d` allocates twice; `np.multiply(b + c, d, out=...)`
  or in-place `+=`/`*=` reduce allocations. For very large arrays, `numexpr`
  (and pandas' `eval`/`query`) fuse operations to avoid temporaries.
- **A vectorized solution that allocates a 100 GB temporary is *worse* than a
  loop.** Watch the shape of intermediates, not just the elegance of the
  expression.
- **Strided / non-contiguous** arrays (post-transpose) vectorize more slowly;
  `np.ascontiguousarray` before a hot reduction can help.

## Quant relevance & interview gotchas

- **`shift(1)` in the vectorized PnL** is the lookahead guard — vectorizing makes
  it *easy* to accidentally multiply a same-bar signal by same-bar return.
  Vectorization doesn't excuse you from point-in-time discipline.
- **`np.where` evaluates both branches** — computing `log`/`1/x` of invalid
  inputs in the unused branch is a real source of NaN/inf and warnings.
- **Drawdown / running-max** via `np.maximum.accumulate` is a frequent live-coding
  ask; the naive answer is a stateful loop.
- **`np.add.at` is unbuffered** (handles repeated indices correctly), unlike
  `arr[idx] += vals` which can silently drop duplicate-index updates — a subtle
  scatter-add bug.
- **Vectorize-then-profile:** confirm the vectorized version is actually faster
  on your data size and didn't just trade CPU for an OOM.
- Interview ask: "compute returns / a moving average / max drawdown without a
  Python loop" — they want offset slices, `rolling`, and `maximum.accumulate`.

## Key takeaways

1. Vectorization restates per-element loops as whole-array expressions that run
   once in compiled C.
2. Core patterns: offset slices (neighbor ops), masking + `np.where`/`np.select`,
   `cumsum`/`cumprod`/`maximum.accumulate`, mask-and-reduce, `np.add.at`/
   `bincount`, `einsum`/`@`.
3. `np.where` evaluates *both* branches — guard invalid math in the input.
4. Mind intermediates: an elegant expression can OOM; use in-place ops, `out=`,
   `numexpr`, or chunking.
5. In pandas, use column ops/`rolling`/`ewm`; never `iterrows`/`apply(axis=1)`
   for numeric work.
6. Stateful/path-dependent logic may need Numba instead — and vectorizing never
   excuses lookahead (`shift(1)`).

## Self-check

1. Express daily simple returns from a price array using offset slices, and a
   max-drawdown series without a loop.
2. Why does `np.where(x > 0, np.log(x), 0.0)` still emit a domain warning, and how
   do you avoid it?
3. What's the difference between `arr[idx] += vals` and `np.add.at(arr, idx,
   vals)` when `idx` has repeats?
4. When is a vectorized solution *worse* than a Numba loop?
5. Why is `shift(1)` essential in a vectorized strategy-return calculation?
6. Name two ways to reduce intermediate-array allocations in a long chain of
   vectorized operations.

## Further reading

- [NumPy: vectorization basics](https://numpy.org/doc/stable/user/basics.broadcasting.html) and [universal functions](https://numpy.org/doc/stable/reference/ufuncs.html).
- [`numpy.where`](https://numpy.org/doc/stable/reference/generated/numpy.where.html), [`numpy.select`](https://numpy.org/doc/stable/reference/generated/numpy.select.html), [`numpy.ufunc.at`](https://numpy.org/doc/stable/reference/generated/numpy.ufunc.at.html), [`einsum`](https://numpy.org/doc/stable/reference/generated/numpy.einsum.html).
- [Enhancing performance — pandas docs](https://pandas.pydata.org/docs/user_guide/enhancingperf.html) (`eval`/`query`, numexpr, Cython, Numba).
- [`numexpr`](https://numexpr.readthedocs.io/) — fused array expressions.
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Appendix A (advanced NumPy).

## Videos

- Jake VanderPlas — **"Losing your Loops: Fast Numerical Computing with NumPy"** (PyCon 2015) ([search](https://www.youtube.com/results?search_query=Jake+VanderPlas+Losing+your+Loops+NumPy+PyCon+2015)).
- Nathaniel Smith — **"Inside NumPy"** / array internals talks (PyData) ([search](https://www.youtube.com/results?search_query=Nathaniel+Smith+Inside+NumPy+PyData)).
