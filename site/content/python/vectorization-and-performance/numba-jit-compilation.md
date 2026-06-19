# Numba JIT Compilation

> **Why a quant must own this:** Some of the most important quant computations are
> inherently *sequential* — path-dependent stops, online/recursive estimators
> (EWMA, Kalman filters), order-book replay, custom rolling statistics. These
> don't vectorize cleanly, yet a pure-Python loop is 50× too slow. Numba is the
> escape hatch: decorate a normal Python function, and it JIT-compiles the loop
> to machine code at near-C speed — *and* can release the GIL for true
> parallelism. Knowing when to reach for it (vs vectorizing, vs Cython/C++) is a
> senior-level performance judgement.

## First principles: a JIT for numeric Python

Numba is a **just-in-time compiler** built on LLVM. The first time you call a
`@njit` function, Numba inspects the *types* of the arguments, generates
specialized LLVM IR, compiles it to native machine code, and caches it keyed by
those types. Subsequent calls with the same argument types run the compiled
code directly — no interpreter, no boxing, no per-element overhead.

```python
from numba import njit
import numpy as np

@njit                                   # == @jit(nopython=True), the mode you want
def ewma(x, alpha):
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):          # an explicit loop -- but compiled to machine code
        out[i] = alpha * x[i] + (1 - alpha) * out[i-1]
    return out

x = np.random.default_rng(0).standard_normal(1_000_000)
y = ewma(x, 0.1)                        # first call: compile + run; later calls: just run
```

This EWMA is genuinely sequential (`out[i]` depends on `out[i-1]`). You *can*
express it with `pandas.ewm`, but a custom recursive estimator often can't be —
and Numba lets you write the obvious loop at C speed.

## `nopython` mode is the whole point

Numba has two modes:

- **`nopython` mode** (`@njit`): compiles the function with **no CPython objects
  at all** — pure machine code on unboxed numeric types. This is where the
  speedup lives.
- **object mode** (fallback): if Numba can't type something, it falls back to
  running through the interpreter — defeating the purpose.

**Always use `@njit`** (which forces nopython and errors if it can't compile),
not bare `@jit`. A compile error is a *feature*: it tells you the function uses
something Numba can't accelerate, so you can fix it rather than silently get no
speedup.

## What Numba supports — and what it doesn't

| Works well in `@njit`                     | Does NOT work (or kills speed)             |
|-------------------------------------------|--------------------------------------------|
| NumPy arrays, scalar math, loops          | pandas DataFrames/Series (pass `.values`)  |
| Most NumPy functions & ufuncs             | Python `dict`/`list` of mixed types, objects|
| `range`, branches, tuples, basic strings  | arbitrary Python libraries / I/O           |
| `prange` for parallel loops               | dynamic typing / `object` arrays           |

The cardinal rule: **pass NumPy arrays, not pandas objects.** Extract
`df["close"].to_numpy()`, compute in Numba, assign the result back.

```python
df["ewma"] = ewma(df["close"].to_numpy(), 0.1)   # bridge: numpy in, numpy out
```

## Parallelism: `prange` and `nogil`

Because compiled Numba code holds no Python objects, it can **release the GIL** —
so a `@njit(nogil=True)` function called from multiple threads runs truly in
parallel. And `parallel=True` + `prange` auto-parallelizes independent loop
iterations across cores.

```python
from numba import njit, prange

@njit(parallel=True)
def rolling_vol(x, window):
    n = len(x)
    out = np.empty(n)
    out[:window] = np.nan
    for i in prange(window, n):          # prange -> iterations split across cores
        w = x[i-window:i]
        out[i] = w.std()
    return out
```

This is real multicore parallelism on CPU-bound numeric code — something pure
Python *cannot* do because of the GIL (see the multiprocessing lesson). Numba
sidesteps the GIL precisely because it operates on raw memory.

## The cost model: compilation overhead

The first call pays compilation latency (often 0.1-1s). This matters:

- **Amortize it.** Numba wins when the function runs long enough, or often
  enough, to dwarf the one-time compile. For a function called once on tiny data,
  the compile cost can exceed the savings.
- **`cache=True`** persists compiled code to disk across runs, avoiding
  recompilation each session.
- **Eager compilation**: pass a signature (`@njit("float64[:](float64[:], float64)")`)
  to compile at import time instead of first call.

```python
@njit(cache=True)                       # reuse compiled artifact across processes/runs
def fast_fn(x): ...
```

## Performance reality

- A well-typed `@njit` loop typically reaches **within ~1-3× of hand-written C**,
  i.e. **10-100×** over the pure-Python loop — competitive with, and sometimes
  beating, an equivalent vectorized NumPy expression (because it avoids
  intermediate temporaries and fuses operations).
- **Numba vs vectorization:** vectorization wins for clean elementwise/reduction
  work and needs no compile step; Numba wins for *sequential/path-dependent*
  logic, *fused* multi-step kernels (no temporaries), and *custom* rolling stats.
  Benchmark both.
- **`fastmath=True`** allows reassociation/relaxed IEEE rules for extra SIMD
  speed — but changes rounding; do **not** use it where bit-level reproducibility
  or careful summation matters (covariance accumulation, PnL).
- **Memory layout** still matters: contiguous arrays vectorize/SIMD better inside
  Numba too.

## Numba vs the alternatives

```text
   slowest ────────────────────────────────────────────────▶ fastest / more effort
   pure Python loop  <  pandas.apply  <  vectorized NumPy  ≈  Numba @njit  <  Cython / C++
                                          (no compile)        (JIT, easy)     (AOT, hardest)
```

- **Cython** — compile annotated Python to C ahead-of-time; more control, more
  ceremony, good when you need a stable compiled artifact or tight C interop.
- **C/C++ extension or pybind11** — maximum control/latency (the HFT path), most
  effort. Numba gets you most of the speed for a fraction of the work.
- **CuPy / Numba CUDA** — push the kernel to GPU for massively parallel work.

## Quant relevance & interview gotchas

- **The path-dependent kernel** (running stop-loss, drawdown with state,
  recursive filter, Monte Carlo with per-step logic, order-book event replay) is
  the textbook Numba use case — and a common "how would you speed this up?"
  interview prompt where "vectorize it" is the *wrong* answer.
- **First-call compile latency** surprises people in benchmarks: time the
  *second* call, or warm it up; report steady-state speed.
- **Passing a DataFrame** to an `@njit` function fails/falls back — extract
  `.to_numpy()` first. This is the #1 Numba beginner error.
- **`fastmath` reproducibility:** a backtest that flips PnL in the last decimal
  across runs/machines may be using relaxed float math.
- **Don't reach for Numba first.** The right ladder is: vectorize → if it can't
  be vectorized (or temporaries blow memory), Numba → if you need a hardened
  artifact or sub-microsecond latency, Cython/C++.
- **GIL release** is the honest answer to "how do you parallelize CPU-bound
  Python numeric code?" — Numba `nogil`/`parallel` or processes; *not* threads on
  pure Python.

## Key takeaways

1. Numba JIT-compiles numeric Python to machine code per argument-type, removing
   interpreter/boxing overhead from loops.
2. Use `@njit` (nopython mode) and let compile errors guide you; object-mode
   fallback gives no speedup.
3. Pass NumPy arrays, not pandas objects; bridge with `.to_numpy()` and assign
   results back.
4. It shines for **sequential/path-dependent** logic that doesn't vectorize, and
   can match vectorized speed by avoiding temporaries.
5. `parallel=True`/`prange` and `nogil=True` give true multicore CPU
   parallelism (the GIL is released).
6. Amortize first-call compile cost (`cache=True`); avoid `fastmath` where
   precision/reproducibility matters; reserve Cython/C++ for the last mile.

## Self-check

1. Why can Numba release the GIL when pure-Python code cannot, and what does that
   enable?
2. What does `nopython` mode mean, and why prefer `@njit` over bare `@jit`?
3. Give a concrete quant computation that should use Numba rather than NumPy
   vectorization, and say why.
4. What happens if you pass a `pd.Series` directly to an `@njit` function, and
   what's the fix?
5. Why might a naive Numba benchmark look slow on the first run, and how do you
   report fair numbers?
6. When is `fastmath=True` inappropriate in a finance calculation?

## Further reading

- [Numba documentation](https://numba.readthedocs.io/en/stable/) and [A ~5 minute guide to Numba](https://numba.readthedocs.io/en/stable/user/5minguide.html).
- [`@njit` / nopython mode](https://numba.readthedocs.io/en/stable/user/jit.html) and [Automatic parallelization with `@jit`](https://numba.readthedocs.io/en/stable/user/parallel.html).
- [Supported Python/NumPy features](https://numba.readthedocs.io/en/stable/reference/pysupported.html).
- [Enhancing performance — pandas docs](https://pandas.pydata.org/docs/user_guide/enhancingperf.html) (when to use Cython vs Numba).
- [Cython documentation](https://cython.readthedocs.io/) — the AOT alternative.

## Videos

- Numba team — **"Numba: Tell those C++ bullies to get lost"** (SciPy) ([search](https://www.youtube.com/results?search_query=Numba+tell+those+C%2B%2B+bullies+to+get+lost+SciPy)).
- Stan Seibert / Numba — **"Numba: A JIT Compiler for fast numerical code"** (PyData/SciPy) ([search](https://www.youtube.com/results?search_query=Numba+JIT+compiler+numerical+code+PyData+SciPy)).
