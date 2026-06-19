# Indexing, Slicing, and Views

> **Why a quant must own this:** The single most consequential — and most
> error-prone — NumPy concept is **views vs copies**. A slice is a *view*: it
> shares memory with its parent, so writing through it mutates the original.
> Fancy indexing *copies*. Get this wrong and you silently corrupt a price panel
> or, conversely, pay for copies you didn't need. It also underlies pandas'
> infamous `SettingWithCopyWarning`. Mastering when NumPy shares memory is
> non-negotiable for correct, fast research code.

## First principles: slicing reinterprets, it doesn't copy

Because an `ndarray` is a buffer + shape + strides (see the previous lesson), a
basic slice can be expressed purely as *new strides/offset over the same
buffer*. So NumPy returns a **view**: a second array object pointing at the same
memory. No data is copied — slicing a 10 GB array is O(1).

```python
import numpy as np
a = np.arange(10)
s = a[2:8]                  # a VIEW: shares a's buffer
s[0] = 999
print(a)                   # [  0   1 999   3   4   5   6   7   8   9]  <-- mutated!
print(s.base is a)         # True  -- s.base reveals the owner of the data
```

This is a feature (cheap, fast) and a footgun (action at a distance). The
guarantee: **basic slicing → view; fancy indexing → copy.**

## Basic indexing and slicing

```python
m = np.arange(12).reshape(3, 4)
m[1, 2]            # scalar at row 1, col 2
m[0]               # first row (1-D view)
m[:, 1]            # second column (a view, strided)
m[1:, ::2]         # rows 1.., every other column -- still a view
m[..., -1]         # ellipsis: "all leading axes", last element of the trailing
```

- Slices use `start:stop:step` per axis; omitted bounds default to the full
  extent. A *negative step* reverses.
- `m[i]` on a 2-D array returns a 1-D **view** of row `i`.
- All of the above are basic indexing → **views**, including reversed and
  strided ones.

## Fancy (advanced) indexing — always a copy

Indexing with an **integer array** or a **boolean mask** is *advanced* indexing.
The result generally cannot be expressed as strides over the original buffer, so
NumPy allocates a **new array (a copy)**.

```python
a = np.arange(10)

# integer-array (fancy) indexing -> COPY
idx = np.array([0, 2, 4, 2])      # may repeat / reorder
picked = a[idx]                    # array([0, 2, 4, 2]) -- new buffer
picked[0] = -1
print(a[0])                        # 0 -- original untouched (it was a copy)

# boolean-mask indexing -> COPY
returns = np.array([0.01, -0.02, 0.03, -0.01])
losers = returns[returns < 0]      # array([-0.02, -0.01]) -- new buffer
```

> **The rule that disambiguates everything:** if you index with a *slice* (`:`),
> integer, or ellipsis → view. If you index with an *array of integers* or a
> *boolean array* → copy.

### But assignment *through* fancy indexing still writes back

`a[mask] = value` and `a[idx] = value` mutate the original — because that's an
*assignment target*, not an expression producing a copy. This is how you do
in-place conditional updates:

```python
prices = np.array([10.0, -1.0, 12.0, -5.0])
prices[prices < 0] = np.nan        # in-place: mark bad prints as NaN
print(prices)                      # [10. nan 12. nan]
```

## Masking: the vectorized "if" for quant work

Boolean masks replace Python loops over conditions and are the bread and butter
of signal logic.

```python
rng = np.random.default_rng(0)
ret = rng.standard_normal(1000)

mask = ret > 2.0                   # boolean array
print(mask.sum())                  # count of >2-sigma days (True counts as 1)
print(ret[mask].mean())            # mean of extreme up-days
np.where(ret > 0, 1, -1)           # vectorized sign signal: +1 / -1 array
np.clip(ret, -3, 3)                # winsorize to +/- 3 sigma
```

`np.where(cond, x, y)` is the vectorized ternary; `np.select` handles
multi-branch logic. These run in C — no Python-level branching per element.

## Detecting views vs copies, and forcing a copy

```python
a = np.arange(10)
v = a[::2]                         # view
print(np.shares_memory(a, v))      # True
print(v.base is a)                 # True  -> v owns no data

c = a[[0, 1, 2]]                   # fancy -> copy
print(np.shares_memory(a, c))      # False

safe = a[2:5].copy()               # explicit copy when you must NOT alias
```

When you intend to mutate a sub-array *without* touching the parent, call
`.copy()` explicitly. When you intend to mutate the parent, slice and assign.
Being explicit removes the ambiguity.

## Reshaping: when it stays a view

`reshape` returns a view *if the data can be reinterpreted without moving it*
(contiguous, compatible order); otherwise it copies. `ravel()` returns a view
when possible; `flatten()` always copies. A transpose `T` is always a view (it
just swaps strides) — but the result is non-contiguous, so a subsequent
`reshape` may then copy.

```python
m = np.arange(12)
print(m.reshape(3, 4).base is m)   # True -- view
t = m.reshape(3, 4).T              # view (strides swapped), non-contiguous
print(t.flags['C_CONTIGUOUS'])     # False
```

## Diagram: view vs copy

```text
   parent buffer:  [ p0 p1 p2 p3 p4 p5 p6 p7 ]
       │                 ▲          ▲
   slice a[2:5] ─────────┘ view ────┘   (shares the bytes; write -> parent changes)

   fancy a[[2,4,6]] ──▶  NEW buffer [ p2 p4 p6 ]   (independent; write -> no effect on parent)
```

## Performance reality

- **Views are free** (O(1), no allocation) — slicing into a huge array costs
  nothing. Prefer views when you only *read* a region.
- **Fancy indexing copies**, so it costs memory and a pass over the selected
  elements; fine, but don't do it repeatedly in a loop when a slice would do.
- **Non-contiguous views are slower to iterate** than contiguous ones (worse
  cache behavior, no SIMD-friendly stride-1 access). After a transpose, an
  `np.ascontiguousarray` before heavy compute can pay off.
- `a[mask]` allocates; if you only need a reduction, `a[mask].sum()` is fine, but
  `np.where`/`np.add.reduce` patterns can avoid the temporary entirely.

## Quant relevance & interview gotchas

- **Aliasing bugs:** `window = panel[-20:]; window[:] = 0` zeroes the last 20
  rows of `panel` — surprising if you thought `window` was a copy. Slice + `.copy()`
  when isolating data.
- **`SettingWithCopyWarning`** in pandas is *exactly* this view/copy ambiguity
  leaking up: chained indexing (`df[df.x > 0]['y'] = ...`) may write to a
  temporary copy and silently do nothing. Use `.loc[mask, 'y'] = ...`.
- **Boolean mask length must match the axis**; a stale mask from a different-
  length array raises or, worse, misaligns.
- **`np.where(cond, x, y)` evaluates both `x` and `y`** fully (they're arrays),
  unlike a short-circuiting `if` — watch for invalid math (e.g. `log` of
  negatives) computed in the unused branch; mask the input instead.
- Interview ask: "does `a[1:3]` copy? does `a[[1,2]]`?" — know the answer cold
  (view; copy) and how to verify with `np.shares_memory`.

## Key takeaways

1. Basic slicing returns a **view** sharing the parent's buffer; writing through
   it mutates the parent.
2. Fancy indexing (integer arrays, boolean masks) returns a **copy**.
3. But assignment *to* `a[mask]`/`a[idx]` mutates the original in place — the
   idiom for conditional updates.
4. Use `np.shares_memory`/`.base` to check aliasing, and `.copy()` to force
   independence.
5. `reshape`/`ravel` may return views; transpose always does (but yields
   non-contiguous data).
6. This view/copy distinction is the root of pandas' `SettingWithCopyWarning`.

## Self-check

1. Does `a[2:5]` share memory with `a`? Does `a[[2,3,4]]`? How do you verify?
2. Write a vectorized expression that sets all negative entries of `prices` to
   `NaN` in place.
3. Why might `df[df.col > 0]['other'] = 1` silently fail to update `df`, and what
   is the correct form?
4. After `t = m.reshape(3,4).T`, is `t` a view? Is it contiguous? Why does that
   matter for performance?
5. Explain why `np.where(x > 0, np.log(x), 0.0)` can still emit a warning about
   `log` of non-positive values.
6. You need a sub-array you can mutate without affecting the parent. What's the
   one call you add?

## Further reading

- [Indexing on ndarrays — NumPy docs](https://numpy.org/doc/stable/user/basics.indexing.html) (basic vs advanced).
- [Copies and views — NumPy docs](https://numpy.org/doc/stable/user/basics.copies.html).
- [`numpy.shares_memory`](https://numpy.org/doc/stable/reference/generated/numpy.shares_memory.html) and [`numpy.where`](https://numpy.org/doc/stable/reference/generated/numpy.where.html).
- [Returning a view versus a copy — pandas docs](https://pandas.pydata.org/docs/user_guide/indexing.html#returning-a-view-versus-a-copy).
- Wes McKinney, *Python for Data Analysis*, 3rd ed., Ch. 4 (indexing, boolean/fancy).

## Videos

- Jake VanderPlas — **"Losing your Loops: Fast Numerical Computing with NumPy"** (PyCon 2015) ([search](https://www.youtube.com/results?search_query=Jake+VanderPlas+Losing+your+Loops+NumPy+PyCon+2015)).
- Nicolas Rougier — **"From Python to NumPy"** material / talks ([search](https://www.youtube.com/results?search_query=Nicolas+Rougier+From+Python+to+NumPy)).
