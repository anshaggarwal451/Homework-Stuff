# The ndarray and dtypes

> **Why a quant must own this:** NumPy is the substrate under pandas, scikit-
> learn, and most quant tooling. The `ndarray` is what makes Python fast for
> numbers — a contiguous, typed buffer that lets a C loop run with zero
> per-element Python overhead. Choosing the wrong `dtype` (an accidental
> `object` array, or `float32` where you needed `float64`) silently destroys
> performance or precision. Understanding the buffer + dtype + strides triple is
> the foundation everything else in this track builds on.

## First principles: a list of numbers is not a buffer of numbers

A Python `list` of a million floats is a million boxed `PyObject`s plus a
million pointers — scattered across the heap, each carrying type info and a
refcount. A NumPy `ndarray` of a million `float64`s is **one contiguous 8 MB
block** of raw IEEE-754 doubles, with the type stored *once*. That single
difference is why NumPy is 10-100× faster and far smaller: the data is dense,
typed, and CPU-cache friendly, and operations run in compiled C.

```python
import numpy as np, sys
lst = list(range(1_000_000))
arr = np.arange(1_000_000, dtype=np.int64)
print(arr.nbytes)              # 8_000_000  -- exactly 8 bytes x 1e6
# the list's pointer array alone is ~8 MB, PLUS the int objects it points to
```

## Anatomy of an ndarray

An `ndarray` is a thin Python object wrapping three things:

1. A **data buffer** — a flat C array of raw bytes (the actual numbers).
2. A **dtype** — how to interpret each element (kind + size + byte order).
3. **Shape and strides** — the shape gives dimensions; strides say how many
   *bytes* to step to move one index along each axis.

```python
a = np.arange(12, dtype=np.int32).reshape(3, 4)
print(a.shape)      # (3, 4)
print(a.dtype)      # int32
print(a.strides)    # (16, 4)  -> 16 bytes to next row, 4 bytes to next column
print(a.itemsize)   # 4 bytes per element
print(a.flags['C_CONTIGUOUS'])   # True -- row-major
```

```text
   logical view (3x4)          flat buffer (row-major / C order)
   [ 0  1  2  3 ]              [0 1 2 3 4 5 6 7 8 9 10 11]
   [ 4  5  6  7 ]   strides=    └──row0──┘└──row1──┘└──row2──┘
   [ 8  9 10 11 ]   (16, 4)     step col = 4 bytes, step row = 16 bytes
```

Strides are the trick behind views: a transpose or slice just *reinterprets* the
same buffer with different shape/strides — no data copied (covered in the next
lesson).

## dtypes: the type system of numeric data

A `dtype` encodes the element's kind, size, and byte order. The ones you'll use:

| dtype       | Meaning                       | Bytes | Notes                                   |
|-------------|-------------------------------|-------|-----------------------------------------|
| `int64`     | signed integer                | 8     | default int on 64-bit Linux/macOS       |
| `int32`     | signed integer                | 4     | overflow risk on large sums             |
| `float64`   | IEEE-754 double               | 8     | NumPy's default float; quant standard   |
| `float32`   | IEEE-754 single               | 4     | half memory, ~7 sig digits — ML/GPU     |
| `bool`      | boolean                       | 1     | masks                                   |
| `complex128`| two float64                   | 16    | FFTs, signal processing                 |
| `datetime64`| epoch-based timestamp         | 8     | time series; unit-aware (`ns`, `D`)     |
| `object`    | pointer to a Python object    | 8     | **the slow trap — avoid**               |

```python
np.array([1, 2, 3]).dtype            # int64 (platform int)
np.array([1.0, 2, 3]).dtype          # float64 (promotes to float)
np.array([1, 2, 3], dtype=np.float32)
np.zeros(5, dtype=np.float64)        # always specify when it matters
```

### Integer overflow is silent

Fixed-width integers wrap around with no warning — a real hazard summing large
volumes:

```python
np.array([2**31 - 1], dtype=np.int32) + 1   # array([-2147483648]) -- wrapped!
np.array([2**31 - 1], dtype=np.int64) + 1   # array([2147483648])  -- fine
```

### The `object` dtype: the performance cliff

If NumPy can't find a common numeric type — mixed types, Python `Decimal`,
strings, `None` — it falls back to `dtype=object`: an array of pointers to
Python objects. You lose *all* the speed (every operation loops in Python) and
the compact memory. A frequent accident:

```python
a = np.array([1, 2, None])           # dtype=object -- SLOW, silently
b = np.array([1.0, 2.0, np.nan])     # dtype=float64 -- use NaN for "missing"
```

> **Rule:** check `arr.dtype`. If it says `object` and you expected numbers,
> something coerced wrong — fix it before you build on it.

## Structured (record) dtypes for tabular data

A single dtype can describe a heterogeneous record — useful for fixed-layout
market data, and the basis of `recarray` and pandas under the hood.

```python
trade_t = np.dtype([("ts", "datetime64[ns]"),
                    ("sym", "U6"),
                    ("price", np.float64),
                    ("qty", np.int32)])
trades = np.zeros(3, dtype=trade_t)
trades["price"] = [100.1, 100.2, 100.3]      # column access by field name
print(trades.itemsize)                        # sum of field sizes (+ alignment)
```

## Creating arrays the idiomatic way

```python
np.zeros((3, 4))                 # filled with 0.0, float64
np.ones(5, dtype=np.int64)
np.empty(1000)                   # uninitialized -- fast, but contains garbage
np.arange(0, 1, 0.1)             # like range, but float-capable (watch FP error)
np.linspace(0, 1, 11)            # 11 evenly spaced points incl. endpoints
np.full((2, 2), np.nan)          # pre-fill a result you'll populate
rng = np.random.default_rng(42)  # modern Generator API (seedable, reproducible)
rng.standard_normal((1000,))     # 1000 N(0,1) draws
```

Prefer `np.random.default_rng(seed)` (the new Generator) over the legacy
`np.random.seed` — it's faster, statistically better, and explicit about state.

## Performance reality

- **Memory layout drives speed.** Contiguous `float64` arrays let the CPU stream
  cache lines and let NumPy hand the loop to optimized C/SIMD. An `object` array
  defeats all of it.
- **`float32` vs `float64`**: `float32` halves memory and bandwidth (big for GPU
  / huge matrices and ML) but carries ~7 significant digits — risky for
  iterative finance math (compounding, covariance accumulation). Default to
  `float64` for research correctness; drop to `float32` deliberately.
- **`np.empty` vs `np.zeros`**: `empty` skips zeroing and is faster when you'll
  overwrite every element — but reading it before writing yields garbage.
- **`astype` copies.** Converting dtype allocates a new buffer; don't do it in a
  hot loop. Pick the dtype at creation.
- `nbytes` and `itemsize` tell you the true memory footprint — use them when an
  array "shouldn't be that big."

## Quant relevance & interview gotchas

- **Accidental `object` arrays** from mixed/`None` data are the most common
  silent perf killer; always sanity-check `dtype`.
- **Integer overflow** when summing volumes/notional in `int32` — promote to
  `int64` or `float64`.
- **`float32` precision** loss in covariance/returns accumulation; interviewers
  may ask why a sum differs from the math — catastrophic cancellation and
  reduced precision are the answers.
- **`datetime64[ns]`** has a finite range (~584 years around 1970 at ns
  resolution) — fine for markets, but know it's bounded.
- **`a == b` on float arrays** rarely does what you want; use `np.isclose` /
  `np.allclose` for floating comparisons.
- Interview classic: "why is a NumPy array faster than a Python list?" — answer
  with *contiguous typed buffer + single dtype + C-level vectorized loops + cache
  locality*, not just "it's written in C."

## Key takeaways

1. An `ndarray` = contiguous typed data buffer + dtype + shape/strides; that
   density is the whole performance story.
2. The dtype is stored once and fixes element size/kind/byte order; `float64` is
   the quant default.
3. `object` dtype means pointers to Python objects — it silently kills speed and
   memory; verify your dtype.
4. Fixed-width integers overflow silently; `float32` trades precision for
   memory.
5. Strides let views reinterpret the same buffer without copying.
6. Use `np.random.default_rng(seed)` for reproducible, modern random number
   generation.

## Self-check

1. Why does a NumPy `float64` array of 1e6 elements use ~8 MB while a Python
   list of the same floats uses much more?
2. What three pieces of metadata let an `ndarray` interpret its flat byte
   buffer?
3. You build `np.array([1, 2, "3"])` — what dtype results and why is that bad?
4. Show an `int32` sum that overflows silently and the fix.
5. When is `float32` appropriate, and what's the risk in finance math?
6. Why does `astype(np.float64)` not belong inside a hot loop?

## Further reading

- [The N-dimensional array — NumPy docs](https://numpy.org/doc/stable/reference/arrays.ndarray.html).
- [Data type objects (dtype) — NumPy docs](https://numpy.org/doc/stable/reference/arrays.dtypes.html).
- [NumPy: the absolute basics for beginners](https://numpy.org/doc/stable/user/absolute_beginners.html).
- [Internal memory layout of an ndarray](https://numpy.org/doc/stable/reference/arrays.ndarray.html#internal-memory-layout-of-an-ndarray).
- Harris et al., ["Array programming with NumPy"](https://www.nature.com/articles/s41586-020-2649-2), *Nature* 585 (2020).
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Ch. 4 (NumPy basics).

## Videos

- Jake VanderPlas — **"Losing your Loops: Fast Numerical Computing with NumPy"** (PyCon 2015) ([search](https://www.youtube.com/results?search_query=Jake+VanderPlas+Losing+your+Loops+NumPy+PyCon+2015)).
- SciPy — **"NumPy: vectorization and broadcasting"** tutorials ([search](https://www.youtube.com/results?search_query=SciPy+NumPy+vectorization+broadcasting+tutorial)).
