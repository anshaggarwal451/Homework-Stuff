# TA-Lib Technical Indicators

> **Why a quant must own this:** Technical indicators — moving averages, RSI,
> Bollinger Bands, MACD, ATR — are the raw features of countless systematic
> strategies and a common interview shorthand ("how would you compute RSI over a
> price series?"). TA-Lib is the de facto C library for these, wrapped for
> Python. Knowing how to call it correctly, how its outputs are *aligned* (the
> leading-NaN/warm-up problem), and — critically — that indicators are *trailing
> by construction but trivially misused into lookahead* is the difference
> between a feature and a bug.

## First principles: what TA-Lib is

TA-Lib (Technical Analysis Library) is a mature **C library** of ~150 indicators
with a thin Python wrapper (`TA-Lib`/`talib`). The functions take NumPy arrays of
prices and return NumPy arrays of indicator values, computed in optimized C. It's
fast and battle-tested, but it is a C extension — installation requires the
underlying C library (via conda, a system package, or a prebuilt wheel), which
trips people up.

```python
import numpy as np
import talib                                     # the python wrapper around the C lib

close = np.asarray(prices, dtype=np.float64)     # TA-Lib wants float64 arrays
sma20 = talib.SMA(close, timeperiod=20)          # simple moving average
rsi14 = talib.RSI(close, timeperiod=14)          # relative strength index
upper, mid, lower = talib.BBANDS(close, timeperiod=20, nbdevup=2, nbdevdn=2)
macd, signal, hist = talib.MACD(close, fastperiod=12, slowperiod=26, signalperiod=9)
atr14 = talib.ATR(high, low, close, timeperiod=14)   # needs OHLC, not just close
```

## The warm-up / leading-NaN problem

Every windowed indicator needs a *warm-up period* before it can produce a value.
TA-Lib pads the start of the output with `NaN` for those positions — and the
length of that pad (the "lookback") differs per indicator. You **must** align and
drop/ignore these, or downstream math silently propagates NaN.

```python
sma20 = talib.SMA(close, timeperiod=20)
# sma20[:19] are NaN; the first real value is at index 19
print(np.isnan(sma20).sum())          # 19 leading NaNs

lookback = talib.SMA_Lookback(20)     # TA-Lib tells you the warm-up length (19)
```

> **The alignment contract:** TA-Lib returns an array the *same length* as the
> input, NaN-padded at the front, so `output[i]` corresponds to `close[i]`. This
> right-alignment is what keeps it point-in-time: `SMA[i]` uses `close[i-19..i]`,
> i.e. only past and present — never future.

## Two APIs: function vs abstract

```python
# Function API: explicit NumPy arrays in, arrays out (shown above) -- simplest.

# Abstract API: pass a dict / DataFrame of OHLCV, refer to inputs by name
from talib import abstract
sma = abstract.SMA({"close": close}, timeperiod=20)
# good for pipelines that pass whole OHLCV frames around
```

## Worked example: RSI by hand (to show the mechanics)

Knowing how an indicator is built — not just calling it — is the interview ask.
RSI compares the average gain to the average loss over a window (Wilder's
smoothing):

```python
import numpy as np

def rsi_wilder(close, n=14):
    diff = np.diff(close)                       # day-over-day change
    gain = np.where(diff > 0, diff, 0.0)
    loss = np.where(diff < 0, -diff, 0.0)
    # Wilder's smoothing = an EWMA with alpha = 1/n; seeded by the first n-mean
    avg_gain = np.empty_like(gain); avg_loss = np.empty_like(loss)
    avg_gain[:n] = np.nan; avg_loss[:n] = np.nan
    avg_gain[n-1] = gain[:n].mean(); avg_loss[n-1] = loss[:n].mean()
    for i in range(n, len(gain)):               # sequential -> Numba candidate
        avg_gain[i] = (avg_gain[i-1]*(n-1) + gain[i]) / n
        avg_loss[i] = (avg_loss[i-1]*(n-1) + loss[i]) / n
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)                  # 0..100, >70 "overbought" etc.
```

The recursive smoothing is exactly the kind of *path-dependent* loop the Numba
lesson covered — a real reason to JIT a custom indicator, or just call
`talib.RSI` which does it in C. Note small definitional differences exist (SMA vs
Wilder smoothing), so TA-Lib's RSI may differ slightly from a naive version —
know which convention you're using.

## The pandas/`pandas-ta` alternative

TA-Lib's C dependency is a deployment headache. Pure-Python/pandas alternatives
exist:

```python
import pandas as pd
s = pd.Series(close)
sma20 = s.rolling(20).mean()                     # SMA in pandas, no C dep
ema12 = s.ewm(span=12, adjust=False).mean()      # EMA
# `pandas-ta` / `finta` provide a TA-Lib-like indicator set in pure Python
```

These are slower than TA-Lib's C but trivial to install and reproduce. For
feature engineering at moderate scale, `rolling`/`ewm` are often enough; reach for
TA-Lib when you need the exact standard definitions or raw speed over many
series.

## Common indicators and their inputs

| Indicator | Function          | Inputs        | Notes                                  |
|-----------|-------------------|---------------|----------------------------------------|
| SMA/EMA   | `SMA`/`EMA`       | close         | trend; warm-up = `timeperiod-1`        |
| RSI       | `RSI`             | close         | momentum oscillator 0-100              |
| MACD      | `MACD`            | close         | returns macd, signal, histogram        |
| Bollinger | `BBANDS`          | close         | mean ± k·std; returns upper/mid/lower  |
| ATR       | `ATR`             | high,low,close| volatility; needs full OHLC            |
| OBV       | `OBV`             | close,volume  | volume-flow                            |
| Stochastic| `STOCH`           | high,low,close| %K/%D oscillator                       |

## Performance reality

- TA-Lib runs in **C**, so a single indicator over one series is very fast. The
  cost is the **per-call overhead × number of series** when you compute hundreds
  of indicators across thousands of symbols — there, vectorize across the
  universe (compute one indicator for all symbols via a matrix), or parallelize
  by symbol.
- `rolling`/`ewm` in pandas are Cython-fast and adequate for most feature sets;
  the C-vs-Cython gap matters only at large scale.
- Indicators are cheap relative to the *backtest* around them; don't
  micro-optimize the indicator if your bottleneck is a Python loop over bars
  (vectorize/Numba that instead).

## Quant relevance & interview gotchas

- **Lookahead via shifting the wrong way:** TA-Lib outputs are right-aligned and
  trailing (safe). The bug is *using* `indicator[t]` to trade *at* `close[t]`
  when the indicator itself depends on `close[t]` — you'd need `close[t]` to act
  at `t`. Trade on `indicator.shift(1)` like any other signal.
- **`center=True` / smoothing that peeks:** never use a centered moving average
  for a live signal — it incorporates future bars.
- **Warm-up NaNs** silently nuke downstream computations and bias early backtest
  results; drop the warm-up window or start the backtest after it.
- **Definition mismatches:** RSI/EMA have multiple smoothing conventions
  (Wilder vs simple, `adjust=True/False` in pandas `ewm`); two libraries can
  give different numbers for "the same" indicator. Pin the definition.
- **Overfitting on indicator parameters:** sweeping `timeperiod` until a backtest
  looks good is classic data-snooping — interviewers probe whether you guard
  against it (out-of-sample, multiple-testing correction).
- **Indicators are features, not strategies:** know they are deterministic
  transforms of price/volume, prone to multicollinearity (many are near-
  duplicates), which matters when feeding them to an ML model.

## Key takeaways

1. TA-Lib is a fast C library of ~150 indicators with a Python wrapper; pass
   `float64` NumPy arrays (OHLC where required).
2. Outputs are same-length and **NaN-padded** during each indicator's warm-up
   (lookback); align and drop those.
3. Outputs are trailing/right-aligned (point-in-time) — but you still must
   `shift(1)` before trading on them to avoid lookahead.
4. Custom/recursive indicators (Wilder RSI, EMA) are path-dependent loops — call
   the C function or Numba-JIT them.
5. `rolling`/`ewm`/`pandas-ta` are easy-to-install pure-Python alternatives;
   beware smoothing-convention differences.
6. Indicator-parameter sweeping is data-snooping — validate out of sample.

## Self-check

1. Why does `talib.SMA(close, 20)` return an array with 19 leading NaNs, and how
   do you find that warm-up length programmatically?
2. TA-Lib indicators are trailing/right-aligned. Why must you still `shift(1)` a
   signal derived from them before backtesting?
3. Sketch how RSI is computed and identify the part that is path-dependent (and
   thus a Numba candidate).
4. Give two reasons the "same" indicator (e.g. EMA) can differ between TA-Lib and
   pandas.
5. When is `rolling`/`ewm` an acceptable substitute for TA-Lib, and when is
   TA-Lib worth its C dependency?
6. Why is sweeping an indicator's `timeperiod` until the PnL looks good a
   methodological red flag?

## Further reading

- [TA-Lib (Python wrapper) docs](https://ta-lib.github.io/ta-lib-python/) and [function list](https://ta-lib.github.io/ta-lib-python/funcs.html).
- [TA-Lib (Python) GitHub](https://github.com/TA-Lib/ta-lib-python) (installation, function vs abstract API).
- [pandas window operations (`rolling`, `ewm`)](https://pandas.pydata.org/docs/user_guide/window.html) — the dependency-free alternative.
- [`pandas-ta`](https://github.com/twopirllc/pandas-ta) — pure-Python indicator library.
- Marcos López de Prado, *Advances in Financial Machine Learning* — on feature engineering and data-snooping.

## Videos

- PyData — **"Technical analysis / feature engineering for trading in Python"** ([search](https://www.youtube.com/results?search_query=PyData+technical+analysis+feature+engineering+trading+python)).
- PyData — **"Backtesting trading strategies in Python"** (covers indicators + lookahead) ([search](https://www.youtube.com/results?search_query=PyData+backtesting+trading+strategies+python)).
