# Broadcasting

> **Why a quant must own this:** Broadcasting is how you subtract a per-asset
> mean from a returns matrix, scale every row of a panel by a vector of weights,
> or compute a full pairwise distance matrix — all without a single Python loop
> and without materializing redundant copies. It's the mechanism that turns
> linear-algebra-shaped finance math into one-line, C-speed NumPy. Misread the
> rules and you get a silent shape blow-up (a 100,000×100,000 temporary) or a
> wrong-axis bug that corrupts a signal. This is a top NumPy interview topic.

## First principles: pairing arrays of different shapes

Elementwise operations want operands of the same shape. Broadcasting is the set
of rules NumPy uses to *virtually* stretch a smaller array to match a larger one
**without copying data** — the smaller array's elements are reused (a stride of
0 along the stretched axis). The result: vectorized math across mismatched-but-
compatible shapes.

```python
import numpy as np
prices = np.array([[100.0, 101.0, 99.0],     # 3 days x 3 assets
                   [102.0, 100.0, 98.0]])
weights = np.array([0.5, 0.3, 0.2])           # one weight per asset (shape (3,))
weighted = prices * weights                    # (2,3) * (3,) -> (2,3)
port = weighted.sum(axis=1)                     # daily portfolio price
```

`weights` (shape `(3,)`) is broadcast across the 2 rows: conceptually it becomes
`(2, 3)`, but no copy is made — NumPy steps the same 3 values for each row.

## The broadcasting rules

Align shapes **from the trailing (rightmost) dimension** and work left. Two
dimensions are compatible when:

1. they are **equal**, or
2. one of them is **1** (it gets stretched), or
3. one of them is **missing** (treated as 1 — i.e. a shorter shape is left-padded
   with 1s).

If any pair is incompatible, NumPy raises `ValueError: operands could not be
broadcast together`.

```text
   A      (3 days, 4 assets) -> (3, 4)
   B                  (4,)   -> (1, 4)   # left-pad with 1
   ------------------------------------
   result            (3, 4)             # B's row reused across the 3 days

   A      (3, 4)
   C         (3,)  -> (1, 3)            # trailing dims 4 vs 3 -> INCOMPATIBLE -> error
```

That last case is the canonical bug: a per-row vector of length 3 won't
broadcast against a `(3, 4)` array, because alignment is from the *right*. The
fix is to make the intent explicit with a new axis.

## `np.newaxis` / `reshape`: controlling which axis stretches

To subtract a per-row scalar (one value per day) you must turn the `(3,)` vector
into a *column* `(3, 1)` so it aligns on the left axis.

```python
A = np.arange(12).reshape(3, 4).astype(float)

col = np.array([10.0, 20.0, 30.0])        # one value per ROW (per day)
A - col[:, np.newaxis]                      # (3,4) - (3,1) -> subtract per row
# col[:, None] is the same; None == np.newaxis

row = np.array([1.0, 2.0, 3.0, 4.0])      # one value per COLUMN (per asset)
A - row                                     # (3,4) - (4,) -> subtract per column
```

> **The mnemonic for demeaning returns:** to subtract each *asset's* mean,
> compute `R.mean(axis=0)` (shape `(n_assets,)`) and subtract directly — it
> aligns on the trailing axis. To subtract each *day's* cross-sectional mean,
> compute `R.mean(axis=1, keepdims=True)` (shape `(n_days, 1)`) so it broadcasts
> down the rows. `keepdims=True` is the clean way to get the column shape.

## Canonical quant patterns

```python
import numpy as np
rng = np.random.default_rng(0)
R = rng.standard_normal((250, 5))         # 250 days x 5 assets of returns

# 1. Standardize each asset (z-score down the time axis)
mu = R.mean(axis=0)                        # (5,)
sd = R.std(axis=0)                         # (5,)
Z = (R - mu) / sd                          # broadcast (250,5)-(5,) -> (250,5)

# 2. Cross-sectional demean (remove each day's market move)
day_mean = R.mean(axis=1, keepdims=True)   # (250,1)
R_resid = R - day_mean                     # broadcast across columns

# 3. Outer product: all pairwise products without a loop
a = np.array([1.0, 2.0, 3.0])
outer = a[:, None] * a[None, :]            # (3,1)*(1,3) -> (3,3)

# 4. Pairwise squared distances between row vectors (watch memory!)
X = rng.standard_normal((1000, 3))
d2 = ((X[:, None, :] - X[None, :, :]) ** 2).sum(axis=-1)   # (1000,1000)
```

Pattern 4 shows broadcasting's power *and* its danger: `X[:, None, :] -
X[None, :, :]` materializes a `(1000, 1000, 3)` intermediate — 24 MB here, but
`(100_000, 100_000, 3)` would be 240 GB.

## Performance reality

- **Broadcasting copies no data for the operands** — the stretched array uses a
  0-stride trick. That's the efficiency win over manually `np.tile`-ing.
- **But the *output* is full-size**, and intermediate broadcast expressions are
  materialized. The pairwise-distance idiom is the classic memory bomb: the
  `(N, N, D)` temporary is what kills you, not the inputs. For large `N`, use
  the `||x-y||^2 = |x|^2 + |y|^2 - 2x·y` identity (a matrix multiply, no 3-D
  temporary) or `scipy.spatial.distance.cdist`.
- A broadcasted vectorized op is dramatically faster than the equivalent Python
  loop (C loop, contiguous memory, SIMD). It's also usually faster *and* clearer
  than `np.tile` + elementwise, since tile allocates the full expanded array.
- `keepdims=True` avoids an extra `reshape`/`newaxis` and keeps reductions
  broadcasting-ready — prefer it.

## Diagram: stretching with a 0-stride

```text
   weights (3,)  =  [w0 w1 w2]
   broadcast to (2,3) for prices*(weights):

        row 0:  [w0 w1 w2]   ┐  same 3 values reused,
        row 1:  [w0 w1 w2]   ┘  stride along the new axis = 0 (no copy)
```

## Quant relevance & interview gotchas

- **Wrong-axis demeaning** is a real signal bug: subtracting `R.mean(axis=0)`
  when you meant a per-day cross-sectional mean (`axis=1, keepdims=True`)
  silently produces a different, wrong signal — no error raised.
- **`(n,)` vs `(n,1)` vs `(1,n)`**: a 1-D array of length `n` broadcasts as a
  *row*. To use it as a column you must add a trailing axis. Mixing these up is
  the #1 broadcasting mistake.
- **Silent shape blow-up**: `a[:, None] - b[None, :]` for large `a`, `b` quietly
  allocates an `N×M` matrix. Always sanity-check the *output* shape and size.
- **Integer/float dtype promotion** happens during broadcasting too — `int32`
  array divided by a Python float yields `float64`.
- **`np.broadcast_to` returns a read-only view** with 0-strides — useful, but
  writing to it (or to overlapping broadcast results) is unsafe/forbidden.
- Interview ask: "subtract the column mean from a matrix" and "compute a Gram /
  pairwise matrix without loops" — both test broadcasting fluency and axis
  reasoning.

## Key takeaways

1. Broadcasting virtually stretches arrays (0-stride, no copy) to make
   elementwise ops work across compatible shapes.
2. Rules align trailing dims first; dims must be equal, or one must be 1, or
   missing (padded with 1).
3. A `(n,)` vector broadcasts as a *row*; use `[:, None]` / `keepdims=True` to
   make it a column.
4. Operands aren't copied, but the *result and intermediates* are full-size —
   watch for the `(N, N, D)` memory bomb.
5. Choose the reduction axis deliberately: `axis=0` (down time) vs `axis=1`
   (across assets) changes the meaning of your signal.
6. Vectorized broadcasting beats Python loops and `np.tile` on both speed and
   clarity.

## Self-check

1. State the broadcasting rules. Why is `(3,4) - (3,)` an error while
   `(3,4) - (4,)` works?
2. You have returns `R` of shape `(days, assets)`. Write the expression to
   z-score each asset, and separately to remove each day's cross-sectional mean.
3. What does `a[:, None] * a[None, :]` produce for a length-3 vector, and what's
   the output shape?
4. Why does the pairwise-distance broadcast `X[:,None,:] - X[None,:,:]` risk
   running out of memory, and what's a memory-safe alternative?
5. What does `keepdims=True` do, and why is it convenient for subsequent
   broadcasting?
6. Is the array returned by `np.broadcast_to` writable? Why or why not?

## Further reading

- [Broadcasting — NumPy docs](https://numpy.org/doc/stable/user/basics.broadcasting.html).
- [`numpy.newaxis`](https://numpy.org/doc/stable/reference/constants.html#numpy.newaxis) and [`numpy.broadcast_to`](https://numpy.org/doc/stable/reference/generated/numpy.broadcast_to.html).
- [Array broadcasting — NumPy "Glossary"/array-broadcasting article](https://numpy.org/doc/stable/user/theory.broadcasting.html).
- [`scipy.spatial.distance.cdist`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.distance.cdist.html) — distances without the 3-D temporary.
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Appendix A (advanced NumPy / broadcasting).

## Videos

- Jake VanderPlas — **"Losing your Loops: Fast Numerical Computing with NumPy"** (PyCon 2015) ([search](https://www.youtube.com/results?search_query=Jake+VanderPlas+Losing+your+Loops+NumPy+PyCon+2015)).
- SciPy — **"NumPy broadcasting"** tutorial sessions ([search](https://www.youtube.com/results?search_query=SciPy+conference+NumPy+broadcasting+tutorial)).
