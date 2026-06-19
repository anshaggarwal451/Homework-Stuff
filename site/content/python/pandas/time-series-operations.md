# Time Series Operations

> **Why a quant must own this:** Markets *are* time series. Resampling ticks to
> bars, computing rolling volatility, lagging a signal so it's tradable,
> aligning data across timezones and holidays, and avoiding lookahead bias are
> the daily mechanics of research. pandas' `DatetimeIndex` makes these
> declarative and fast — but the same tools make it trivially easy to peek into
> the future and inflate a backtest. This lesson is as much about *correctness*
> (no lookahead) as it is about API.

## First principles: the DatetimeIndex

A time series in pandas is a Series/DataFrame indexed by a `DatetimeIndex` —
`datetime64[ns]` labels with optional timezone and frequency. With it, pandas can
slice by date string, resample, roll, and align by timestamp.

```python
import pandas as pd, numpy as np
idx = pd.date_range("2024-01-01", periods=6, freq="B")   # business days
px = pd.Series([100, 101, 99, 102, 103, 101], index=idx, name="close")

px["2024-01"]                     # partial-string slice: all of January
px.loc["2024-01-02":"2024-01-04"] # inclusive label slice (recall .loc rules)
px.asof("2024-01-03 15:30")       # last known value at/just before a timestamp
```

`pd.to_datetime(...)` parses strings/epochs to `datetime64[ns]`; always convert
at load (`parse_dates=`) rather than carrying string dates.

## Shifting and lagging — the lookahead frontier

`shift(n)` moves data *down* by `n` rows (introducing leading NaN); `diff` and
`pct_change` build on it. **This is where lookahead bias lives.**

```python
px.shift(1)                       # yesterday's close, aligned to today
px.pct_change()                   # (today - yesterday) / yesterday == simple return
np.log(px / px.shift(1))          # log return
```

> **The golden rule:** a signal computed from information up to time *t* may only
> be *acted on* at *t+1* (or later). To trade tomorrow on today's signal, lag the
> signal: `position = signal.shift(1)`. Forgetting the `shift(1)` is the single
> most common way backtests "discover" alpha that doesn't exist — you traded on
> a price you couldn't have known yet.

```python
signal = (px > px.rolling(3).mean()).astype(int)   # computed at close of day t
position = signal.shift(1)                          # held from the NEXT day -> tradable
strategy_ret = position * px.pct_change()           # PnL aligned correctly
```

## Resampling: changing frequency

`resample` is a time-aware GroupBy: it buckets timestamps into fixed periods and
aggregates. Downsampling ticks→bars uses OHLC; upsampling needs a fill rule.

```python
ticks = pd.Series(np.random.default_rng(0).standard_normal(1000).cumsum() + 100,
                  index=pd.date_range("2024-01-01 09:30", periods=1000, freq="s"))

bars = ticks.resample("1min").ohlc()      # open/high/low/close per minute
vol  = ticks.resample("5min").last().pct_change().std()   # 5-min realized move

daily = px.resample("D").last()            # downsample to daily close
filled = daily.resample("h").ffill()       # upsample, forward-fill (carry last)
```

- **`label`/`closed`** control whether a bar is stamped at the start or end of
  its interval and which edge is inclusive — get these wrong and your bars are
  off by one period (a subtle lookahead source for intraday).
- Use `last()`/`ohlc()` for prices, `sum()` for volume, `mean()`/`std()` for
  returns.

## Rolling, expanding, and EW windows

These compute statistics over a moving window — the heart of indicators and
risk measures.

```python
ret = px.pct_change()

ret.rolling(20).std() * np.sqrt(252)      # 20-day annualized realized vol
ret.rolling(20, min_periods=20).mean()    # require a FULL window (no partial)
ret.expanding().mean()                     # cumulative mean (uses all past data)
ret.ewm(span=20).mean()                    # exponentially-weighted moving average
ret.ewm(halflife=10).std()                 # EW volatility (RiskMetrics-style)
```

- **`rolling(window)`** uses a *trailing* window ending at the current row — so
  it is point-in-time by construction (no future leakage), *provided* you don't
  later `shift(-1)`.
- **`min_periods`** controls how many observations are required; the default
  emits values once `min_periods` are present, which can produce early values
  from partial windows — set it explicitly for honest signals.
- **`expanding`** grows from the start; **`ewm`** weights recent data more
  (define via `span`, `halflife`, `com`, or `alpha`).
- **`center=True`** centers the window on the current row — which means it uses
  *future* data. **Never use `center=True` for a tradable signal.**

## Alignment, timezones, and missing data

```python
px = px.tz_localize("America/New_York")    # attach a timezone
px_utc = px.tz_convert("UTC")              # convert (same instants)

a.reindex(b.index)                          # align a onto b's timestamps
df.asfreq("B")                              # force a business-day frequency, NaN gaps
df.ffill(limit=1)                           # carry last obs forward (carefully!)
```

- **Index alignment** (from the intro lesson) applies: arithmetic on two series
  with different timestamps yields NaN at non-overlapping stamps. Reindex or
  `align` deliberately.
- **Timezone naivety** silently misaligns data across venues; localize once and
  convert.
- **Forward-fill is dangerous in finance:** ffilling a price across a halt can
  fabricate observations and leak the last known value into periods it shouldn't
  reach. Fill with intent and a `limit`.

## Diagram: why `shift(1)` matters

```text
   day:        t-1     t      t+1
   close:      100    102     101
   signal@t:    -      BUY      -      (computed AT t's close)
   WRONG: ret_t  uses today's move with today's signal -> you "knew" the close
   RIGHT: position = signal.shift(1); pnl_(t+1) = position_(t+1) * ret_(t+1)
          you act on t's signal during t+1 -> no lookahead
```

## Performance reality

- `rolling`/`ewm`/`resample` run in optimized Cython over contiguous arrays —
  far faster than a Python loop computing windows manually. Don't hand-roll a
  rolling mean.
- `rolling(...).apply(func, raw=True)` for a *custom* statistic passes a NumPy
  array (no per-window Series overhead) — use `raw=True`, and consider Numba via
  `engine="numba"` for heavy custom windows.
- Partial-string indexing and `resample` rely on a **monotonic, sorted**
  DatetimeIndex; sort first or operations are slow/incorrect.
- For very high-frequency data, keep timestamps as `datetime64[ns]` (8 bytes,
  vectorized) — never as Python `datetime` objects (`object` dtype, slow).

## Quant relevance & interview gotchas

- **Lookahead bias via missing `shift(1)`** — the cardinal sin. Also via
  `center=True` rolling, via resample `label`/`closed` off-by-one, and via
  ffilling future-into-past.
- **Survivorship/alignment:** combining a price series with a fundamentals series
  on mismatched dates injects NaN; reindex to a common business-day calendar.
- **Realized vol annualization:** `std * sqrt(252)` for daily, `sqrt(252*6.5*60)`
  for minute bars — the scaling factor depends on the sampling frequency; getting
  it wrong is a common interview catch.
- **`pct_change` over gaps** (weekends, halts) computes a return across a
  multi-day gap unless you resample/align first — can distort vol.
- **Timezone bugs at the open/close** misclassify which session a trade belongs
  to. Localize explicitly; don't rely on naive timestamps.
- Interview ask: "you have daily closes and a momentum signal — how do you
  backtest it without lookahead?" → lag the signal with `shift(1)` and multiply
  by next-period returns.

## Key takeaways

1. A `DatetimeIndex` enables date slicing, resampling, rolling, and timestamp
   alignment — keep timestamps as `datetime64[ns]`, sorted and (if needed)
   tz-aware.
2. `shift(1)` lags a signal so it's tradable; missing it is the #1 lookahead
   bug.
3. `resample` is a time-aware GroupBy (OHLC for prices, sum for volume); mind
   `label`/`closed`.
4. `rolling` is trailing (point-in-time); `center=True` peeks into the future and
   must not be used for live signals.
5. `ewm` gives exponentially-weighted means/vols (RiskMetrics); `expanding` uses
   all history.
6. Forward-fill and naive timezones silently corrupt finance data — fill and
   localize with intent.

## Self-check

1. You compute a signal from today's close. What single operation makes a
   backtest of it free of lookahead, and why?
2. Why is `rolling(20).std()` point-in-time but `rolling(20, center=True).std()`
   is not?
3. Resample 1-second prices into 1-minute OHLC bars and into 5-minute realized
   volatility.
4. Why does `pct_change()` across a weekend gap potentially distort volatility,
   and how do you handle it?
5. What's the annualization factor for volatility from daily returns vs from
   1-minute returns?
6. Two series have mismatched timestamps; you add them and get mostly NaN. What
   happened and how do you fix it?

## Further reading

- [Time series / date functionality — pandas docs](https://pandas.pydata.org/docs/user_guide/timeseries.html).
- [Window operations (rolling, expanding, ewm) — pandas docs](https://pandas.pydata.org/docs/user_guide/window.html).
- [`DataFrame.resample`](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.resample.html) and [`shift`](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.shift.html).
- [Time zone handling — pandas docs](https://pandas.pydata.org/docs/user_guide/timeseries.html#time-zone-handling).
- Marcos López de Prado, *Advances in Financial Machine Learning*, Ch. 2-3 (bars, labeling, and lookahead).
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Ch. 11 (time series).

## Videos

- PyData — **"Modern pandas time series"** / resampling tutorials ([search](https://www.youtube.com/results?search_query=PyData+pandas+time+series+resample+rolling)).
- PyData — **"Working with time series data in pandas"** ([search](https://www.youtube.com/results?search_query=PyData+working+with+time+series+data+pandas)).
