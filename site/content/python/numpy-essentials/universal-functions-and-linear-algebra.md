# Universal Functions & Linear Algebra

> **Why a quant must own this:** Ufuncs are the elementwise C-speed engine
> (`np.exp`, `np.log`, `+`, `np.maximum`) and the *reduction* engine (`sum`,
> `cumsum`, `mean`) behind every vectorized signal. `np.linalg` is the gateway to
> the linear algebra at the heart of quant: covariance matrices, OLS betas, PCA,
> portfolio optimization, Cholesky factorizations for correlated simulation.
> Knowing what runs in optimized BLAS/LAPACK versus a Python loop — and which
> numerical method is stable — is what makes the difference between a fast,
> correct model and a slow, wrong one.

## Part 1 — Universal functions (ufuncs)

A **ufunc** is a function that operates elementwise on arrays, looping in
compiled C (often SIMD-vectorized), broadcasting its inputs, and supporting an
optional `out=` buffer. Arithmetic operators (`+`, `*`, `**`), comparisons, and
the math library (`np.exp`, `np.sqrt`, `np.log1p`) are all ufuncs.

```python
import numpy as np
r = np.array([0.01, -0.02, 0.015])

np.exp(r)                 # elementwise exp, in C
log_ret = np.log1p(r)     # log(1+r) -- numerically better than np.log(1+r)
gross = np.expm1(log_ret) # exp(x)-1 -- the inverse, also precision-safe
np.maximum(r, 0)          # elementwise max with 0 (a ReLU / floor)
```

### Reductions, accumulations, and `axis`

Every binary ufunc exposes `.reduce` and `.accumulate`; the common ones have
friendly names. The `axis` argument selects *which* dimension collapses.

```python
R = np.arange(12).reshape(3, 4).astype(float)
R.sum()                    # scalar: grand total
R.sum(axis=0)              # (4,) -- collapse rows: per-column totals
R.sum(axis=1)              # (3,) -- collapse cols: per-row totals
np.cumsum(R, axis=0)       # running total down time -> equity curve from returns
np.cumprod(1 + r)          # compounded growth factor
np.add.reduce(R, axis=0)   # the general form behind .sum
```

> **Equity curve in one line:** `equity = np.cumprod(1 + returns)` (simple
> returns) or `np.exp(np.cumsum(log_returns))` (log returns). Both are ufunc
> accumulations — no Python loop, no per-bar overhead.

### Precision-aware ufuncs

- `np.log1p(x)` / `np.expm1(x)` keep precision for small `x` (returns, rates)
  where `log(1+x)`/`exp(x)-1` would lose significant digits.
- `np.logaddexp` sums in log-space without overflow (useful in likelihoods).
- Use `np.isclose`/`np.allclose` for float comparisons, never `==`.

### `out=` and in-place: avoiding temporaries

```python
a = np.ones(1_000_000)
np.multiply(a, 2.0, out=a)     # write back into a -- no new allocation
a *= 2.0                        # same idea via augmented assignment
```

Augmented assignment (`+=`, `*=`) and `out=` reuse the buffer, avoiding a
throwaway array — meaningful for large arrays in hot code.

## Part 2 — Linear algebra (`np.linalg` and `@`)

The `@` operator is matrix multiplication (`np.matmul`); `*` is *elementwise*.
Confusing them is a top NumPy bug.

```python
A = np.arange(6).reshape(2, 3).astype(float)
B = np.arange(6).reshape(3, 2).astype(float)
A @ B               # (2,2) matrix product  -- calls BLAS GEMM
A * A               # (2,3) elementwise square -- NOT a matrix product
A.T @ A             # (3,3) Gram matrix
np.dot(A, B)        # same as A @ B for 2-D
```

### The quant workhorses

```python
import numpy as np
rng = np.random.default_rng(0)
R = rng.standard_normal((250, 5))          # returns: 250 days x 5 assets

# Covariance and correlation
cov = np.cov(R, rowvar=False)              # (5,5); rowvar=False -> columns are vars
corr = np.corrcoef(R, rowvar=False)

# OLS beta: solve (X'X) b = X'y  -- use lstsq, NOT inv
X = np.column_stack([np.ones(250), R[:, 0]])   # intercept + one factor
y = R[:, 1]
beta, *_ = np.linalg.lstsq(X, y, rcond=None)   # stable least-squares

# Eigen-decomposition for PCA (covariance is symmetric -> use eigh)
evals, evecs = np.linalg.eigh(cov)         # ascending eigenvalues, orthonormal vecs

# Cholesky: generate correlated normals from a target covariance
L = np.linalg.cholesky(cov + 1e-10*np.eye(5))  # cov = L L'
sims = rng.standard_normal((10000, 5)) @ L.T   # rows now have covariance ~cov
```

### Solve, don't invert

To solve `Ax = b`, use `np.linalg.solve(A, b)` — never `np.linalg.inv(A) @ b`.
Explicit inversion is slower, less accurate, and amplifies conditioning errors.
For least squares use `lstsq`; for symmetric positive-definite systems prefer
Cholesky (`scipy.linalg.cho_solve`).

| Task                              | Right tool                         | Avoid                |
|-----------------------------------|------------------------------------|----------------------|
| Solve `Ax=b`                      | `np.linalg.solve`                  | `inv(A) @ b`         |
| Least squares / OLS               | `np.linalg.lstsq`                  | normal eq via `inv`  |
| Symmetric eigen (covariance/PCA)  | `np.linalg.eigh`                   | general `eig`        |
| Cholesky (PSD matrix)             | `np.linalg.cholesky`              | manual factorization |
| Conditioning check                | `np.linalg.cond` / `svd`           | trusting blindly     |

## Performance reality

- **`@`/`solve`/`eig` call BLAS/LAPACK** (OpenBLAS or Intel MKL) — heavily
  optimized, cache-blocked, and **multithreaded**. A matrix multiply is far
  faster than any hand-written loop and is where most of a model's FLOPs go.
- **Watch thread oversubscription:** if you also use a process pool, the
  per-process BLAS threads multiply. Set `OMP_NUM_THREADS`/`MKL_NUM_THREADS` to
  control it.
- **`inv` is ~2-3× the work of `solve`** and numerically worse. Conditioning
  (`np.linalg.cond`) matters: a near-singular covariance (collinear assets)
  makes `inv` explode; regularize (ridge: add `λI`) or use the pseudo-inverse.
- **`eigh` vs `eig`:** for a symmetric matrix (covariance is symmetric), `eigh`
  is faster *and* returns real, orthonormal results; `eig` may return tiny
  imaginary parts from round-off.
- Ufunc reductions run in C; `np.sum` over a big array beats Python `sum()` by
  orders of magnitude and is more numerically careful (pairwise summation).

## Quant relevance & interview gotchas

- **`@` vs `*`:** `cov = X.T @ X / n` is the Gram/covariance; `X * X` squares
  elementwise. Mixing these silently produces nonsense — a classic interview
  trap.
- **`np.cov` defaults to `rowvar=True`** (each *row* a variable). Returns panels
  are usually columns-as-variables, so pass `rowvar=False` or you'll get a
  wrong-shape, wrong-meaning matrix.
- **Don't invert covariance matrices** for portfolio weights via `inv(Σ) @ μ`
  when `Σ` is ill-conditioned; use `solve` and shrinkage (Ledoit-Wolf).
- **Floating-point reductions aren't associative:** `R.sum()` may differ in the
  last bits across orderings/threads. Use `np.allclose`, and `math.fsum` /
  Kahan summation only if exactness matters.
- **PCA sign ambiguity:** eigenvectors are defined up to sign; don't be alarmed
  that a factor flips sign between runs/libraries.
- Interview ask: "compute OLS betas without scikit-learn" → `np.linalg.lstsq`
  (and know *why* not the normal-equations inverse).

## Key takeaways

1. Ufuncs apply elementwise in compiled C with broadcasting; reductions
   (`sum`, `cumsum`, `mean`) collapse a chosen `axis`.
2. Use `np.log1p`/`np.expm1` for precision on small returns; build equity curves
   with `cumprod`/`cumsum`.
3. `@` is matrix multiply (BLAS), `*` is elementwise — never confuse them.
4. **Solve, don't invert:** `np.linalg.solve`/`lstsq`/`cholesky` over
   `inv`; they're faster and more stable.
5. Use `eigh` (not `eig`) for symmetric matrices like covariance; pass
   `rowvar=False` to `np.cov` for column-variables.
6. BLAS/LAPACK calls are multithreaded — mind oversubscription and matrix
   conditioning.

## Self-check

1. What's the difference between `A * B` and `A @ B`, and which computes a
   covariance/Gram matrix?
2. Why use `np.linalg.solve(A, b)` instead of `np.linalg.inv(A) @ b`?
3. Write a one-liner that turns a vector of daily simple returns into a
   compounded equity curve.
4. Why does `np.cov` give the "wrong" matrix on a `(days, assets)` returns panel
   by default, and how do you fix it?
5. Why prefer `eigh` over `eig` for a covariance matrix?
6. Your `inv(Σ)` blows up for a basket of nearly identical assets. What's
   happening and what are two fixes?

## Further reading

- [Universal functions (ufunc) — NumPy docs](https://numpy.org/doc/stable/reference/ufuncs.html).
- [Linear algebra (`numpy.linalg`) — NumPy docs](https://numpy.org/doc/stable/reference/routines.linalg.html).
- [`numpy.linalg.lstsq`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.lstsq.html), [`solve`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.solve.html), [`cholesky`](https://numpy.org/doc/stable/reference/generated/numpy.linalg.cholesky.html).
- [`scipy.linalg` — SciPy docs](https://docs.scipy.org/doc/scipy/reference/linalg.html) (richer LAPACK coverage than `np.linalg`).
- [Ledoit-Wolf shrinkage — scikit-learn](https://scikit-learn.org/stable/modules/covariance.html#shrunk-covariance).
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Appendix A (linear algebra functions).

## Videos

- Jake VanderPlas — **"Losing your Loops: Fast Numerical Computing with NumPy"** (PyCon 2015) ([search](https://www.youtube.com/results?search_query=Jake+VanderPlas+Losing+your+Loops+NumPy+PyCon+2015)).
- SciPy — **"Numerical linear algebra with NumPy/SciPy"** tutorials ([search](https://www.youtube.com/results?search_query=SciPy+conference+numerical+linear+algebra+NumPy+SciPy+tutorial)).
