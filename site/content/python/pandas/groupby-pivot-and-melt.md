# GroupBy, Pivot, and Melt

> **Why a quant must own this:** Cross-sectional research *is* group-by:
> "rank every stock within its sector each day", "compute per-symbol volatility",
> "neutralize a signal by industry". Reshaping between **long** (tidy:
> date/ticker/value rows) and **wide** (date × ticker matrix) is constant —
> long for storage and joins, wide for matrix math and correlations. Doing these
> with vectorized GroupBy/pivot instead of Python loops is the difference between
> a backtest that runs in seconds and one that runs in hours.

## First principles: split-apply-combine

GroupBy implements the **split-apply-combine** paradigm:

1. **Split** rows into groups by one or more keys.
2. **Apply** a function to each group (aggregate, transform, or filter).
3. **Combine** the results back into a Series/DataFrame.

```python
import pandas as pd, numpy as np
df = pd.DataFrame({
    "date":   pd.to_datetime(["2024-01-02"]*3 + ["2024-01-03"]*3),
    "ticker": ["AAPL", "MSFT", "XOM"] * 2,
    "sector": ["Tech", "Tech", "Energy"] * 2,
    "ret":    [0.01, 0.02, -0.01, 0.00, -0.02, 0.03],
})

df.groupby("sector")["ret"].mean()        # split by sector, mean of ret per group
```

```text
   split                 apply (mean)        combine
   Tech   -> [.01,.02,...] ─▶  mean ─┐
   Energy -> [-.01,.03]    ─▶  mean ─┴─▶  Series indexed by sector
```

## The three apply modes — know which you need

| Mode          | Method                  | Output shape                    | Quant use                                |
|---------------|-------------------------|---------------------------------|------------------------------------------|
| **Aggregate** | `.agg` / `.mean` etc.   | one row per group               | per-sector mean return, per-symbol vol   |
| **Transform** | `.transform`            | **same shape as input**         | demean/zscore within group (broadcast)   |
| **Filter**    | `.filter`               | subset of original rows         | keep groups with > N observations        |
| **Apply**     | `.apply`                | flexible (slow, general)        | last resort for arbitrary per-group logic|

```python
# AGGREGATE: per-sector summary, multiple stats at once
df.groupby("sector")["ret"].agg(["mean", "std", "count"])

# TRANSFORM: cross-sectional z-score WITHIN each date -- aligned back to rows
g = df.groupby("date")["ret"]
df["z"] = (df["ret"] - g.transform("mean")) / g.transform("std")

# the idiomatic "neutralize by sector each day": demean within (date, sector)
df["resid"] = df["ret"] - df.groupby(["date", "sector"])["ret"].transform("mean")
```

> **`transform` is the cross-sectional workhorse.** Aggregation collapses groups;
> `transform` returns a result *aligned to the original rows*, so you can write
> it straight back as a column. Demeaning, z-scoring, and ranking within a date
> or sector all use `transform` (or `rank`).

## Ranking within groups — the signal staple

```python
# cross-sectional rank of each stock within its date (0..1)
df["xrank"] = df.groupby("date")["ret"].rank(pct=True)
# rank within sector each day
df["sec_rank"] = df.groupby(["date", "sector"])["ret"].rank(pct=True)
```

Vectorized `rank` inside a GroupBy replaces the classic nested Python loop over
days and names — and is correct about ties and NaNs.

## Reshaping: long ↔ wide

**Tidy/long** format (one row per observation) is best for storage, joins, and
GroupBy. **Wide** format (date index × ticker columns) is best for matrix math,
`.corr()`, and plotting. You constantly convert between them.

```python
# LONG -> WIDE: pivot to a date x ticker price/return matrix
wide = df.pivot(index="date", columns="ticker", values="ret")
#            AAPL   MSFT   XOM
# 2024-01-02 0.01   0.02  -0.01
# 2024-01-03 0.00  -0.02   0.03

corr = wide.corr()                 # asset correlation matrix -- needs wide form

# WIDE -> LONG: melt back to tidy rows
long = wide.reset_index().melt(id_vars="date", var_name="ticker", value_name="ret")
```

- **`pivot`** requires unique (index, columns) pairs; if duplicates exist (e.g.
  multiple ticks per day), use **`pivot_table`** with an `aggfunc`.
- **`melt`** is the inverse: collapse many columns into key/value rows.
- **`stack`/`unstack`** move levels between index and columns (the MultiIndex
  equivalents of melt/pivot).

```python
# pivot_table aggregates duplicates (e.g. average price per day per ticker)
pt = df.pivot_table(index="date", columns="ticker", values="ret", aggfunc="mean")
```

## Named aggregation and multiple functions

```python
summary = df.groupby("ticker").agg(
    mean_ret=("ret", "mean"),
    vol=("ret", "std"),
    n=("ret", "count"),
)                                          # clean, named output columns
```

Named aggregation (`new_col=("source", "func")`) avoids the messy MultiIndex
columns you get from `.agg(["mean","std"])` and is the modern idiom.

## Performance reality

- **Built-in aggregations are C-fast.** `.mean()`, `.sum()`, `.std()`, `.rank()`,
  `.cumsum()` on a GroupBy run in optimized Cython over the whole frame.
- **`.apply(lambda g: ...)` is the slow trap.** It calls a Python function per
  group, re-boxing data — orders of magnitude slower than `agg`/`transform` with
  a built-in. Reserve `.apply` for genuinely custom logic, and prefer
  `transform`/`agg` with named reducers whenever possible.
- **Sorting**: GroupBy sorts keys by default (`sort=True`); pass `sort=False`
  when you don't need sorted output to save time on many groups.
- **`observed=True`** for categorical group keys avoids materializing the full
  Cartesian product of unused category combinations (big memory saver).
- **Pivot/wide** of a huge universe creates a dense matrix with many NaNs — fine
  for hundreds of names, costly for tens of thousands; keep big data long and
  pivot only the slice you need.

## Quant relevance & interview gotchas

- **Cross-sectional vs time-series grouping:** `groupby("date")` operates across
  names *within* a day (cross-sectional neutralization); `groupby("ticker")`
  operates down time per name. Choosing the wrong key silently produces a wrong
  signal.
- **`transform` vs `agg`:** using `agg` where you needed `transform` collapses
  your frame and breaks the row alignment when you try to assign it back.
- **NaN handling:** GroupBy aggregations skip NaN by default (`skipna`), and
  rows with a NaN *group key* are dropped entirely — a subtle data-loss bug if
  your sector labels have gaps. Use `dropna=False` if you must keep them.
- **`pivot` duplicate-key error:** real tick data has multiple rows per
  (date, ticker); `pivot` raises, `pivot_table` aggregates. Know the difference.
- **Lookahead in grouped transforms:** a `groupby("ticker")["ret"].transform("mean")`
  uses the *whole* series including the future — fine for in-sample stats, a
  lookahead bug if used as a tradable signal. Use expanding/rolling within group
  for point-in-time correctness.
- Interview ask: "rank stocks cross-sectionally each day and neutralize by
  sector" → `groupby("date").rank` and `groupby(["date","sector"]).transform`.

## Key takeaways

1. GroupBy = split-apply-combine; pick **aggregate** (collapse), **transform**
   (same shape, align back), or **filter** (subset).
2. `transform` is the cross-sectional engine for demean/zscore/rank-within-group,
   written straight back as a column.
3. `pivot`/`pivot_table` go long→wide (matrix math, `.corr()`); `melt`/`stack`
   go wide→long (storage, joins).
4. Use `pivot_table` (with `aggfunc`) when (index, columns) pairs aren't unique.
5. Built-in C-level aggregations are fast; `.apply` with a Python lambda is the
   slow path — avoid it.
6. Choosing `groupby("date")` (cross-section) vs `groupby("ticker")` (time
   series) defines the meaning of your signal — and grouped stats can leak the
   future.

## Self-check

1. When do you use `transform` instead of `agg`, and what's different about the
   output shape?
2. Write the expression to z-score returns cross-sectionally within each date.
3. Why does `pivot` raise on real tick data, and what do you use instead?
4. Convert a wide date×ticker return matrix back to tidy long form.
5. Why is `groupby(...).apply(lambda g: ...)` usually slow, and what's the fast
   alternative for a mean?
6. How can a grouped `transform("mean")` introduce lookahead bias, and how do you
   make it point-in-time?

## Further reading

- [Group by: split-apply-combine — pandas docs](https://pandas.pydata.org/docs/user_guide/groupby.html).
- [Reshaping and pivot tables — pandas docs](https://pandas.pydata.org/docs/user_guide/reshaping.html).
- [`DataFrame.pivot_table`](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.pivot_table.html) and [`melt`](https://pandas.pydata.org/docs/reference/api/pandas.melt.html).
- Hadley Wickham, ["Tidy Data"](https://vita.had.co.nz/papers/tidy-data.pdf) — the long-vs-wide rationale.
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Ch. 10 (data aggregation and group operations).

## Videos

- Data School — **"pandas groupby"** lessons ([search](https://www.youtube.com/results?search_query=Data+School+pandas+groupby)).
- PyData — **"Idiomatic pandas: split-apply-combine"** talks ([search](https://www.youtube.com/results?search_query=PyData+pandas+split+apply+combine+groupby)).
