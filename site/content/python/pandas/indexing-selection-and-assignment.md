# Indexing, Selection, and Assignment

> **Why a quant must own this:** Selecting "the close column for these tickers on
> these dates" and writing values back correctly is the most frequent thing you
> do in research — and the most error-prone. The `.loc` vs `.iloc` vs `[]`
> distinction, the `SettingWithCopyWarning`, and chained-indexing bugs cause
> *silent* failures: assignments that don't stick, or worse, that corrupt the
> wrong rows. Getting selection and assignment right is a correctness issue, not
> a style preference.

## First principles: three indexers, three jobs

pandas gives you three ways to index, and using the wrong one is the root of most
bugs:

- **`[]`** on a DataFrame selects **columns** by label (or rows by boolean mask).
  Ambiguous and convenience-only — avoid it for assignment.
- **`.loc[rows, cols]`** — **label-based**: select by index/column *labels*.
  Slices are **inclusive** of the endpoint.
- **`.iloc[rows, cols]`** — **position-based**: select by integer position, like
  NumPy. Slices are **exclusive** of the endpoint.

```python
import pandas as pd, numpy as np
df = pd.DataFrame(
    {"close": [100, 101, 99, 102], "vol": [1e6, 2e6, 8e5, 3e6]},
    index=pd.to_datetime(["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]),
)

df["close"]                              # column by label  -> Series
df.loc["2024-01-03", "close"]            # label lookup     -> 101
df.iloc[1, 0]                            # position lookup  -> 101
df.loc["2024-01-02":"2024-01-04"]        # INCLUSIVE of the end label -> 3 rows
df.iloc[0:2]                             # EXCLUSIVE of end position   -> 2 rows
```

> **The slice-endpoint asymmetry is a classic gotcha:** `.loc[a:b]` includes
> `b`; `.iloc[i:j]` excludes `j`. Label slices are inclusive because labels
> aren't necessarily contiguous integers.

## Boolean (mask) selection — the quant default

Filtering rows by a condition is the workhorse. The mask is a boolean Series
aligned by index.

```python
df.loc[df["vol"] > 1e6]                       # rows where volume exceeds 1M
df.loc[df["vol"] > 1e6, "close"]              # ...and just the close column
df.loc[(df["vol"] > 1e6) & (df["close"] < 102)]   # combine with & | ~ (NOT and/or)
df.loc[df.index >= "2024-01-04"]              # date filter on the index
```

- Use `&`, `|`, `~` (bitwise) with **parentheses** around each comparison — Python's
  `and`/`or` raise on Series.
- `.isin([...])` for membership, `.between(lo, hi)`, and `.query("vol > 1e6")`
  (string expression) are convenient alternatives.

## Assignment: do it through `.loc`, every time

This is the single most important rule. To set values, address rows and columns
in **one** `.loc`/`.iloc` call:

```python
df.loc[df["close"] < 100, "close"] = np.nan         # mark bad prints, in place
df.loc["2024-01-05", "vol"] = 0                       # single cell
df["ret"] = df["close"].pct_change()                  # new column (whole-column assign is fine)
df.loc[:, "logret"] = np.log1p(df["ret"])             # explicit, unambiguous
```

### The `SettingWithCopyWarning` and chained indexing

The warning fires when you index **twice in a row** (`df[...][...] = ...`).
The first `[]` may return a *copy* (recall views vs copies from NumPy), so the
assignment writes to the throwaway copy and the original is **silently
unchanged**.

```python
# WRONG -- chained indexing: may write to a temporary copy, may do nothing
df[df["close"] < 100]["close"] = np.nan        # SettingWithCopyWarning; often a no-op

# RIGHT -- single .loc call: pandas knows the target and writes in place
df.loc[df["close"] < 100, "close"] = np.nan
```

The mechanism is exactly the NumPy view/copy ambiguity surfacing in pandas:
because pandas can't tell whether the intermediate is a view or a copy, the
result of chained assignment is undefined. **Always collapse to one indexer.**

> pandas' **Copy-on-Write (CoW)** mode (default in 3.0, opt-in in 2.x) makes this
> deterministic: every selection behaves as if it returns a copy, so chained
> assignment *reliably* doesn't affect the original (and the warning becomes an
> error/cleaner semantics). Write CoW-correct code now: assign via a single
> `.loc`, and `.copy()` when you want an independent frame.

## MultiIndex: panels of (date, ticker)

Quant data is naturally 2-key (date × symbol). A `MultiIndex` indexes such
panels; `.loc` and `.xs` slice across levels.

```python
panel = df_long.set_index(["date", "ticker"]).sort_index()   # sort for fast slicing
panel.loc[("2024-01-03", "AAPL")]            # exact (date, ticker)
panel.loc[("2024-01-03",)]                   # all tickers on a date
panel.xs("AAPL", level="ticker")             # all dates for one ticker
panel.loc[pd.IndexSlice[:, "AAPL"], :]       # IndexSlice for partial selection
```

Always `sort_index()` a MultiIndex before label-slicing — unsorted MultiIndex
slicing is slow and may raise `UnsortedIndexError`.

## Selection cheat-sheet

| Goal                              | Idiom                                   |
|-----------------------------------|-----------------------------------------|
| Column by name                    | `df["close"]`                           |
| Cell by label                     | `df.loc[date, "close"]`                 |
| Cell by position                  | `df.iloc[i, j]`                         |
| Rows by condition                 | `df.loc[mask]`                          |
| Rows by condition + cols          | `df.loc[mask, ["a", "b"]]`              |
| Label slice (inclusive)           | `df.loc["2024-01":"2024-03"]`           |
| Position slice (exclusive)        | `df.iloc[0:100]`                        |
| Set values (correct way)          | `df.loc[mask, "col"] = value`           |
| Scalar fast get/set               | `df.at[label, "col"]` / `df.iat[i, j]`  |

## Performance reality

- **`.at`/`.iat`** are the fast scalar accessors (single cell); `.loc`/`.iloc`
  carry alignment overhead. Don't loop `.loc` over rows — that's the slow path.
- **Boolean masking allocates** a new frame; for a one-off filter it's fine, but
  repeated masking in a loop is wasteful — filter once.
- **Sorted indexes enable fast label slicing** (binary search). An unsorted (or
  unsorted MultiIndex) makes `.loc` slices O(n) and can raise.
- **`query()`** can use `numexpr` to evaluate large boolean expressions faster
  and with less memory than building intermediate boolean Series.
- **CoW** can *reduce* surprise copies (lazy) while making semantics
  predictable — a net win once you stop relying on accidental views.

## Quant relevance & interview gotchas

- **Chained assignment that silently no-ops** is a backtest-corrupting bug: you
  "set" stop-loss exits but the frame never changed. Use single `.loc`.
- **`.loc` label-slice inclusivity** means `df.loc["2024-01-01":"2024-03-31"]`
  includes March 31 — convenient for date ranges, but don't assume Python-slice
  exclusivity.
- **`and`/`or` on Series raise**; use `&`/`|`/`~` with parentheses. A missing
  paren (`df.a > 0 & df.b > 0`) binds wrong due to operator precedence.
- **Assigning a misaligned Series** reindexes by label, inserting NaN where
  labels don't match — not positionally. To assign positionally use `.values`.
- **Integer index confusion:** with an integer index, `df[0]` is a *column*
  label `0`, not the first row — a frequent surprise; use `.iloc[0]` for
  position.
- Interview ask: "what's the difference between `.loc` and `.iloc`, and why does
  `df[df.x>0]['y'] = 1` sometimes do nothing?" — label vs position; chained
  indexing writes to a possible copy.

## Key takeaways

1. `[]` selects columns/masks; `.loc` is label-based (inclusive slices); `.iloc`
   is position-based (exclusive slices).
2. Always assign through a **single** `.loc`/`.iloc` call — never chain
   (`df[...][...] = ...`).
3. `SettingWithCopyWarning` signals chained indexing that may write to a copy and
   silently fail.
4. Combine masks with `&`/`|`/`~` and parentheses, not `and`/`or`.
5. Use `MultiIndex` for (date, ticker) panels and `sort_index()` before slicing.
6. `.at`/`.iat` for fast scalar access; CoW makes view/copy semantics
   deterministic.

## Self-check

1. Why does `df.loc["a":"c"]` return three rows while `df.iloc[0:3]` returns
   three rows but excludes position 3?
2. Explain precisely why `df[df.x > 0]["y"] = 1` may not modify `df`. Give the
   correct form.
3. What goes wrong with `df.a > 0 & df.b > 0` (no parentheses)?
4. You assign a Series with a different index to `df["z"]`. What happens to rows
   whose labels don't match?
5. With an integer index, what does `df[0]` return — the first row or a column?
   How do you get the first row?
6. Why must you `sort_index()` before slicing a MultiIndex by label?

## Further reading

- [Indexing and selecting data — pandas docs](https://pandas.pydata.org/docs/user_guide/indexing.html).
- [Returning a view versus a copy — pandas docs](https://pandas.pydata.org/docs/user_guide/indexing.html#returning-a-view-versus-a-copy).
- [Copy-on-Write — pandas docs](https://pandas.pydata.org/docs/user_guide/copy_on_write.html).
- [MultiIndex / advanced indexing — pandas docs](https://pandas.pydata.org/docs/user_guide/advanced.html).
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Ch. 5 & 8 (indexing, hierarchical indexing).

## Videos

- Data School — **"How do I select multiple rows and columns from a pandas DataFrame?"** ([search](https://www.youtube.com/results?search_query=Data+School+pandas+loc+iloc+select+rows+columns)).
- PyData — pandas indexing / SettingWithCopyWarning explainers ([search](https://www.youtube.com/results?search_query=PyData+pandas+SettingWithCopyWarning+loc+iloc)).
