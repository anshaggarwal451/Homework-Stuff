# Joins and Merges at Scale

> **Why a quant must own this:** Research is mostly *joining* — prices to
> fundamentals, signals to forward returns, trades to a reference universe,
> quotes to trades by timestamp. Each join is a chance to silently duplicate
> rows (a one-to-many you thought was one-to-one), drop data (wrong join type),
> or — most dangerously — introduce lookahead by joining a future value onto a
> past timestamp. `merge_asof` (the "as-of" point-in-time join) is the single
> most important pandas tool you've probably never been taught. This is a
> frequent interview and real-world correctness topic.

## First principles: the four join types

A join matches rows from two tables on key(s). The *how* controls which rows
survive when keys don't match on both sides.

| `how`     | Keeps                              | Quant use                                   |
|-----------|------------------------------------|---------------------------------------------|
| `inner`   | only keys present in **both**      | safe default; intersect universes           |
| `left`    | all left rows; NaN for missing right | enrich a primary table (prices + factors) |
| `right`   | mirror of left                     | rarely needed                               |
| `outer`   | union of all keys; NaN both sides  | build a full calendar/universe grid         |

```python
import pandas as pd
prices = pd.DataFrame({"ticker": ["AAPL","MSFT","XOM"], "px": [189, 430, 105]})
sector = pd.DataFrame({"ticker": ["AAPL","MSFT","TSLA"], "sec": ["Tech","Tech","Auto"]})

pd.merge(prices, sector, on="ticker", how="left")
#   ticker   px   sec
#   AAPL    189   Tech
#   MSFT    430   Tech
#   XOM     105   NaN     <- no sector match -> NaN (left keeps all left rows)
```

`pd.merge` joins on **columns** (`on=`/`left_on`/`right_on`); `df.join` joins on
the **index** (convenient for time series). Index joins can be much faster
because a sorted index supports binary search.

## The cardinality trap — `validate`

The most damaging join bug is an unintended **one-to-many**: a duplicate key on
the "lookup" side multiplies your rows, silently inflating counts, sums, and
PnL. Always assert the relationship you expect.

```python
# This RAISES if the relationship isn't actually one-to-one / one-to-many:
pd.merge(prices, sector, on="ticker", how="left", validate="m:1")
#                                                  validate options:
#  "1:1"  one-to-one        "1:m"  one-to-many
#  "m:1"  many-to-one       "m:m"  many-to-many (the danger zone)
```

> **Habit to build:** pass `validate=` on every merge, and use
> `indicator=True` to add a `_merge` column showing `left_only`/`right_only`/
> `both` so you can audit what matched. Duplicated keys + a silent many-to-many
> is how a backtest's notional quietly doubles.

```python
m = pd.merge(prices, sector, on="ticker", how="outer", indicator=True)
m["_merge"].value_counts()        # audit: how many matched vs only-one-side
```

## `merge_asof`: the point-in-time join (no lookahead)

This is the quant-critical one. `merge_asof` does a **nearest-key (usually
backward) join on a sorted key** — for each left row it finds the *most recent*
right row at or before it. It's how you attach the *last known* quote to a
trade, or the *latest available* fundamental to a date, **without using future
data**.

```python
trades = pd.DataFrame({
    "time":  pd.to_datetime(["09:30:01", "09:30:05", "09:31:00"]),
    "price": [100.0, 100.2, 100.5],
}).sort_values("time")

quotes = pd.DataFrame({
    "time": pd.to_datetime(["09:30:00", "09:30:04", "09:30:30"]),
    "bid":  [99.9, 100.0, 100.3],
}).sort_values("time")

pd.merge_asof(trades, quotes, on="time", direction="backward")
#   time      price   bid
#   09:30:01  100.0   99.9    <- last quote at/before 09:30:01
#   09:30:05  100.2   100.0   <- last quote at/before 09:30:05
#   09:31:00  100.5   100.3   <- last quote at/before 09:31:00 (the 09:30:30 one)
```

- **`direction="backward"`** (default) → "as of, looking back" = point-in-time
  correct. `"forward"` and `"nearest"` exist but `"forward"`/`"nearest"` can leak
  the future — use `"backward"` for tradable joins.
- **`tolerance=pd.Timedelta("1s")`** rejects matches older than a limit (don't
  attach a stale quote from minutes ago).
- **`by="ticker"`** does the as-of match *within* each symbol — essential when
  combining many names.
- **Both sides must be sorted on the key**, or it raises/misbehaves.

```python
# attach latest available fundamentals (reported with a lag) to each price date
pd.merge_asof(prices_ts.sort_values("date"),
              fundamentals.sort_values("report_date"),
              left_on="date", right_on="report_date",
              by="ticker", direction="backward")
```

Using a plain `merge` on date here would join *exact* dates only (mostly NaN), and
naively forward-filling fundamentals risks leaking a report before it was
public — `merge_asof` with `backward` is the correct, point-in-time tool.

## `concat`: stacking, not key-matching

`pd.concat` glues frames along an axis — stacking daily files (axis=0) or adding
columns (axis=1). It aligns on the *other* axis's labels.

```python
all_days = pd.concat([jan_df, feb_df, mar_df], axis=0)        # stack rows
features = pd.concat([momentum, value, size], axis=1)         # align columns by index
```

Repeated `concat` inside a loop is **O(n^2)** (it copies the whole accumulator
each time). Collect frames in a list and `concat` **once**.

## Performance reality

- **Sort and use the index.** A merge on a *sorted index* uses a fast
  merge/binary-search path; an unsorted object-key merge builds a hash table and
  is slower and memory-heavier.
- **`category` keys** (tickers, exchanges) join faster and use less memory than
  `object` strings — integer code comparison instead of string comparison.
- **`merge_asof` is O(n+m)** on pre-sorted inputs (a merge-style sweep) — vastly
  faster than the naive "for each trade, search all quotes" loop, which is
  O(n·m).
- **Memory blow-up from many-to-many** is the real scaling failure: the result
  can be far larger than either input. `validate=` catches it before it OOMs you.
- **`concat` once, not in a loop.** Build a list, concat at the end. For truly
  large out-of-core joins, push to DuckDB/Polars/Dask rather than fighting
  pandas memory.

## Quant relevance & interview gotchas

- **Point-in-time / lookahead:** joining the *value as known today* requires
  `merge_asof(direction="backward")` (or careful as-of logic), not an exact-date
  `merge`. Joining a future-dated fundamental onto a past price is a classic,
  career-limiting backtest bug.
- **Silent row multiplication:** a duplicated key (e.g. a ticker listed twice in
  a reference file) turns a `left` join into a one-to-many and doubles your
  universe. `validate="m:1"` is your seatbelt.
- **`how="inner"` drops data:** intersecting universes can silently shrink your
  sample and bias results (you only kept names that survived in both tables — a
  survivorship flavor).
- **Key dtype mismatch** (`int` ticker id vs `str`) → zero matches, all NaN, no
  error. Normalize key dtypes first.
- **Timezone-mismatched datetime keys** never match — align tz before joining.
- Interview ask: "match each trade to the prevailing quote at its time" →
  `merge_asof` with `by=` symbol and `direction="backward"`; the wrong answer is
  an O(n·m) nested loop or an exact-time merge.

## Key takeaways

1. Choose `how` deliberately: `inner` (intersect, can drop data), `left`
   (enrich), `outer` (union/grid); `merge` on columns, `join` on index.
2. Always pass `validate=` (and use `indicator=True`) to catch unintended
   one-to-many joins that silently multiply rows.
3. `merge_asof(direction="backward")` is *the* point-in-time join — last known
   value at/before each timestamp; use `by=` per symbol and `tolerance=`.
4. Sorted indexes and `category` keys make joins faster and leaner; mismatched
   key dtypes/timezones silently produce all-NaN.
5. `concat` stacks frames — do it once, not in a loop (O(n^2) otherwise).
6. Joins are a prime lookahead-bias and data-loss surface — audit cardinality
   and point-in-time correctness every time.

## Self-check

1. You `left`-join a prices table to a sector table and your row count grows.
   What happened, and which argument would have caught it?
2. Why is `merge_asof(direction="backward")` the correct way to attach the
   prevailing quote to a trade, and what does `direction="forward"` risk?
3. What's the difference between `pd.merge` and `df.join`, and when is the
   index-based join faster?
4. A join on `ticker` returns all NaN despite matching names. Name two likely
   causes.
5. Why is building a big DataFrame by repeatedly `concat`-ing in a loop slow,
   and what's the fix?
6. How does `validate="1:1"` differ from `validate="m:1"`, and when would you use
   each?

## Further reading

- [Merge, join, concatenate and compare — pandas docs](https://pandas.pydata.org/docs/user_guide/merging.html).
- [`pandas.merge_asof`](https://pandas.pydata.org/docs/reference/api/pandas.merge_asof.html) — the as-of/point-in-time join.
- [`pandas.merge`](https://pandas.pydata.org/docs/reference/api/pandas.merge.html) (`validate`, `indicator`) and [`concat`](https://pandas.pydata.org/docs/reference/api/pandas.concat.html).
- [DuckDB](https://duckdb.org/docs/) and [Polars](https://docs.pola.rs/) — for joins larger than memory.
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Ch. 8 (combining and merging datasets).

## Videos

- PyData — **"High-performance pandas: merge / join"** talks ([search](https://www.youtube.com/results?search_query=PyData+pandas+merge+join+performance)).
- PyData — **"Polars / DuckDB vs pandas for large joins"** ([search](https://www.youtube.com/results?search_query=PyData+Polars+DuckDB+pandas+joins)).
