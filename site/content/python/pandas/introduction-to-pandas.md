# Introduction to Pandas

> **Why a quant must own this:** pandas is the lingua franca of research:
> price panels, fundamentals, signals, and PnL all live in `DataFrame`s. It sits
> directly on NumPy, so the same dtype/view/vectorization lessons apply — but
> adds *labeled* axes and automatic **index alignment**, which is the feature
> that prevents the most common quant bug: silently combining mismatched dates or
> tickers. Knowing what a DataFrame *is* (a dict of typed columns) and how
> alignment works is the entry fee for everything downstream.

## First principles: labeled NumPy

A pandas **Series** is a 1-D NumPy array plus an **Index** (labels). A
**DataFrame** is an ordered dict of Series sharing one row index — i.e. a table
where each *column* is a typed, contiguous array and rows are addressed by
label, not just position.

```python
import pandas as pd, numpy as np

s = pd.Series([100.0, 101.5, 99.8], index=["AAPL", "MSFT", "GOOG"], name="px")
print(s["MSFT"])            # 101.5 -- label lookup
print(s.values.dtype)      # float64 -- a real NumPy array underneath

df = pd.DataFrame({
    "price": [100.0, 101.5, 99.8],
    "volume": [1_000_000, 2_500_000, 800_000],
}, index=["AAPL", "MSFT", "GOOG"])
print(df.dtypes)           # price float64, volume int64
```

The key mental model: **a DataFrame is column-oriented.** Each column is its own
typed array; operations down a column are vectorized NumPy, while operations
across mixed-dtype rows are slow (they fall back to Python objects).

## The Index is the superpower (and the trap)

The Index is not decoration — it drives **automatic alignment**. When you combine
two Series/DataFrames, pandas aligns on the index *labels*, not position, and
fills non-overlapping labels with `NaN`.

```python
a = pd.Series([1, 2, 3], index=["AAPL", "MSFT", "GOOG"])
b = pd.Series([10, 20, 30], index=["MSFT", "GOOG", "TSLA"])
print(a + b)
# AAPL     NaN     <- only in a
# GOOG    23.0     <- 3 + 20, aligned by label
# MSFT    12.0     <- 2 + 10
# TSLA     NaN     <- only in b
```

This is exactly what you want for finance (adding two strategies' PnL aligns
dates automatically) and exactly the source of mysterious all-`NaN` results when
indices don't match (e.g. timezone-aware vs naive timestamps, or string vs int
labels). **When a result is unexpectedly `NaN`, suspect index misalignment first.**

## dtypes in pandas — and the `object`/NaN traps

pandas dtypes are NumPy dtypes plus a few extensions:

| pandas dtype        | Backed by              | Notes                                        |
|---------------------|------------------------|----------------------------------------------|
| `int64` / `float64` | NumPy                  | the workhorses                               |
| `bool`              | NumPy                  | masks                                        |
| `datetime64[ns]`    | NumPy                  | timestamps; can be tz-aware                  |
| `category`          | pandas extension       | low-cardinality strings (sectors, exchanges) |
| `object`            | Python objects         | strings (classic), mixed types — **slow**    |
| `string`            | pandas extension (`pyarrow`) | proper string dtype (modern)          |

```python
df["sector"] = pd.Categorical(["Tech", "Tech", "Tech"])  # cheap, fast group keys
df["ts"] = pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04"])
```

- **Integer columns with missing data become `float64`** (because NumPy `int64`
  has no NaN). pandas' nullable `Int64` (capital I) extension type fixes this if
  you need integer-with-NA.
- **String columns default to `object`** in classic pandas — fine functionally,
  but slow and memory-heavy; `category` or the Arrow-backed `string` dtype are
  faster for repeated values.

## Reading data the right way

```python
df = pd.read_csv(
    "prices.csv",
    parse_dates=["date"],          # parse to datetime64 at load, not after
    index_col="date",              # make date the index
    dtype={"volume": "int64"},     # pin dtypes; avoid surprise object columns
    usecols=["date", "close", "volume"],   # read only what you need
)
```

For real datasets prefer **Parquet** (`pd.read_parquet`) over CSV: it stores
dtypes and is columnar, typed, compressed, and far faster to load — CSV
re-parses and re-infers types every time.

## Inspecting and basic vectorized work

```python
df.head(); df.tail(); df.shape; df.info()    # structure & memory
df.describe()                                  # summary stats per numeric column

df["ret"] = df["close"].pct_change()          # vectorized % change down the column
df["logret"] = np.log1p(df["ret"])            # NumPy ufunc on the column
roll20 = df["close"].rolling(20).mean()        # 20-row moving average
df["above_ma"] = df["close"] > roll20          # boolean Series (a signal)
```

Operations on whole columns are vectorized (NumPy under the hood). Iterating rows
with `for idx, row in df.iterrows()` boxes every value into Python objects and is
10-100× slower — avoid it (covered in the vectorization module).

## Diagram: a DataFrame is columns, not rows

```text
   index     price(float64)   volume(int64)   sector(category)
   ──────    ──────────────   ─────────────   ────────────────
   AAPL  ─▶  [100.0           1000000          Tech ]
   MSFT  ─▶  [101.5           2500000          Tech ]
   GOOG  ─▶  [ 99.8            800000          Tech ]
             └─ contiguous     └─ contiguous    └─ codes+categories
                NumPy array       NumPy array      (compact)
   Operations DOWN a column = fast (vectorized). ACROSS a row = slow (mixed types).
```

## Performance reality

- **Column ops are fast; row loops are slow.** A DataFrame stores each column
  contiguously, so `df["a"] + df["b"]` is a NumPy add. `iterrows`/`apply(axis=1)`
  re-boxes data per row.
- **`category` dtype** slashes memory and speeds `groupby`/joins for
  low-cardinality strings (tickers, sectors, exchanges) — encode once, compare
  integers.
- **`object` string columns** are memory hogs (a pointer per cell to a Python
  `str`); the Arrow-backed `string[pyarrow]` dtype is much leaner. pandas 2.x
  can use a PyArrow backend broadly.
- **Copy-on-Write (CoW)**, default in pandas 3.0 (and opt-in in 2.x), changes
  view/copy semantics to make them predictable — read about it; it affects when
  assignments propagate.
- **Loading**: Parquet ≫ CSV for speed and fidelity; `read_csv` re-infers dtypes
  and is the slow path.

## Quant relevance & interview gotchas

- **Index alignment silently injects NaN** — the top source of "my merged signal
  is all NaN." Check that indices/timezones match before arithmetic; use
  `.align()` explicitly when in doubt.
- **`int` → `float` on missing data**: an integer count column with one NaN
  becomes `float64`; downstream `==` comparisons then surprise you.
- **`object` dtype** sneaking into a numeric column (a stray string in a CSV)
  disables vectorization; check `df.dtypes`.
- **Chained assignment** (`df[mask]['col'] = ...`) is the `SettingWithCopyWarning`
  trap — use `df.loc[mask, 'col'] = ...` (see the indexing lesson).
- **`pct_change` and `shift`** introduce leading NaNs and, if misused, **lookahead
  bias** — make sure a signal at time *t* uses only data up to *t*.
- Interview ask: "what is a DataFrame, really?" → *an ordered collection of typed,
  labeled columns (Series) sharing an index, built on NumPy, with automatic
  label alignment.*

## Key takeaways

1. A Series is a labeled NumPy array; a DataFrame is column-oriented — a dict of
   typed Series sharing an index.
2. Operations align on **index labels**, not position, filling gaps with `NaN` —
   powerful and the #1 silent-bug source.
3. dtypes matter: pin them on load, use `category`/Arrow strings, and know that
   missing data promotes `int` columns to `float`.
4. Column-wise vectorized ops are fast; per-row iteration is slow — work in
   columns.
5. Prefer Parquet over CSV for typed, fast, columnar loading.
6. Watch alignment, chained assignment, dtype surprises, and lookahead bias from
   `shift`/`pct_change`.

## Self-check

1. Why is `a + b` for two Series with partially overlapping indices full of NaNs
   where labels don't match, and how is that useful in finance?
2. What is a DataFrame stored as internally — by row or by column — and why does
   that make `iterrows` slow?
3. Why does an `int64` column with one missing value become `float64`, and what
   dtype fixes it?
4. When would you convert a string column to `category`, and what do you gain?
5. Give the correct, warning-free way to set `col` where a boolean mask is True.
6. How can `shift`/`pct_change` introduce lookahead bias if you're not careful?

## Further reading

- [10 minutes to pandas](https://pandas.pydata.org/docs/user_guide/10min.html) and [Intro tutorials](https://pandas.pydata.org/docs/getting_started/intro_tutorials/index.html).
- [Data structures — pandas docs](https://pandas.pydata.org/docs/user_guide/dsintro.html) (Series & DataFrame).
- [Copy-on-Write — pandas docs](https://pandas.pydata.org/docs/user_guide/copy_on_write.html).
- [Categorical data — pandas docs](https://pandas.pydata.org/docs/user_guide/categorical.html).
- [IO tools (CSV, Parquet) — pandas docs](https://pandas.pydata.org/docs/user_guide/io.html).
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Ch. 5 (Getting started with pandas).

## Videos

- Wes McKinney — talks on pandas/Arrow ([search](https://www.youtube.com/results?search_query=Wes+McKinney+pandas+Arrow+talk)).
- PyData — **"pandas: powerful data analysis tools"** introductory tutorials ([search](https://www.youtube.com/results?search_query=PyData+pandas+tutorial)).
