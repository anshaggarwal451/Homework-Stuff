# Context Managers

> **Why a quant must own this:** Every file handle, database connection, market-
> data socket, lock, and GPU context must be released *deterministically* —
> even when an exception fires mid-computation. Context managers (`with`) are
> Python's RAII: they guarantee setup/teardown pairing. They're also the cleanest
> way to write reusable timers and temporary-state scopes (e.g. "set NumPy error
> mode for this block only"). Interviewers ask you to write one because it tests
> both the protocol and your discipline around resource safety.

## First principles: guaranteed cleanup

The problem context managers solve: a resource acquired at the top of a block
must be released at the bottom — but a `return`, `break`, or exception can skip
the release. `try/finally` solves it but is verbose and easy to get wrong when
nested. The `with` statement packages acquire+release into a reusable object.

```python
# Without: fragile -- if processing raises, the file may stay open
f = open("ticks.csv")
try:
    process(f)
finally:
    f.close()

# With: the same guarantee, declaratively
with open("ticks.csv") as f:
    process(f)            # f.close() runs no matter how the block exits
```

## Mechanics: the context-manager protocol

A context manager is any object implementing two dunder methods:

- `__enter__(self)` — runs on entry; its return value is bound to the `as`
  variable.
- `__exit__(self, exc_type, exc_val, exc_tb)` — runs on exit, *always*. If the
  block raised, the three args describe the exception; otherwise they're `None`.
  **Returning a truthy value suppresses the exception** (use sparingly).

```python
class Timer:
    def __enter__(self):
        import time
        self.t0 = time.perf_counter()
        return self                       # bound to `as t`

    def __exit__(self, exc_type, exc_val, exc_tb):
        import time
        self.elapsed = time.perf_counter() - self.t0
        print(f"block took {self.elapsed*1e3:.3f} ms")
        return False                      # don't suppress exceptions

with Timer() as t:
    s = sum(range(10_000_000))
print(t.elapsed)
```

The `with` statement desugars to roughly:

```text
   mgr = expr
   value = mgr.__enter__()
   try:
       # body, with `value` bound to the `as` name
   finally-ish:
       mgr.__exit__(*sys.exc_info() or (None, None, None))
       # if body raised and __exit__ returns True -> swallow; else re-raise
```

## The idiomatic way: `contextlib.contextmanager`

Writing a class for every manager is heavy. The `@contextmanager` decorator lets
you write one with a generator: everything before `yield` is `__enter__`,
everything after (in a `finally`) is `__exit__`.

```python
from contextlib import contextmanager
import time

@contextmanager
def timer(label="block"):
    t0 = time.perf_counter()
    try:
        yield                              # <-- the body runs here
    finally:
        print(f"{label}: {(time.perf_counter()-t0)*1e3:.3f} ms")

with timer("cov-matrix"):
    cov = compute_cov(data)
```

The `try/finally` around `yield` is essential: it ensures teardown runs even if
the body raises. The value you `yield` becomes the `as` target.

## A genuinely useful pattern: scoped state

Context managers shine for temporarily changing global-ish state and restoring
it — pandas/NumPy options, random seeds, error modes.

```python
import numpy as np

# NumPy ships this one: treat divide/overflow as errors *only inside* the block
with np.errstate(divide="raise", invalid="raise"):
    try:
        bad = np.array([1.0, 0.0]) / np.array([0.0, 0.0])
    except FloatingPointError:
        print("caught a silent NaN/inf at the source")
# outside the block, NumPy's default 'warn' behavior is restored

import pandas as pd
with pd.option_context("display.max_rows", 100):
    print(df)                # wider display only here
```

A hand-rolled scoped-seed manager (reproducible backtests):

```python
from contextlib import contextmanager
import numpy as np

@contextmanager
def temp_seed(seed):
    state = np.random.get_state()         # save
    np.random.seed(seed)
    try:
        yield
    finally:
        np.random.set_state(state)        # restore -- no global pollution
```

## Composing and combining managers

- **Multiple resources in one `with`** (parenthesized form, 3.10+):
  ```python
  with (open("a.csv") as a, open("b.csv") as b):
      merge(a, b)            # both closed in reverse order on exit
  ```
- **`contextlib.ExitStack`** — register a dynamic, runtime-determined number of
  managers (e.g. open N files where N isn't known statically):
  ```python
  from contextlib import ExitStack
  with ExitStack() as stack:
      files = [stack.enter_context(open(p)) for p in paths]
      # all files closed when the stack unwinds, in reverse order
  ```
- **`contextlib.suppress`** — clean replacement for `try/except: pass`:
  ```python
  from contextlib import suppress
  with suppress(FileNotFoundError):
      os.remove("scratch.tmp")
  ```
- **`closing`** — wrap an object that has `.close()` but isn't a context manager.

## Diagram: normal vs exceptional exit

```text
   with mgr as v:                __enter__  ──▶  v
       body...                   body runs
   (normal end)                  __exit__(None, None, None)

   with mgr as v:                __enter__  ──▶  v
       body raises E             __exit__(type(E), E, tb)
                                   ├─ returns False/None  ─▶ E propagates
                                   └─ returns True         ─▶ E suppressed
```

## Performance reality

- The `with` machinery costs a couple of method calls — negligible for I/O or
  coarse work. **Don't** wrap a `with` around the inside of a multi-million-
  iteration numeric loop; hoist it outside the loop.
- For timing, prefer `time.perf_counter()` (monotonic, high-resolution) over
  `time.time()` inside your timer manager.
- Async resources (sockets, DB pools in `asyncio`) need `async with` and the
  `__aenter__`/`__aexit__` protocol — different methods, same idea.

## Quant relevance & interview gotchas

- **Resource leaks under exceptions** are the bug `with` prevents: a feed handler
  that opens a socket and raises while parsing must still close it. Bare
  `open()`/`socket()` without `with` (or `finally`) leaks descriptors and
  eventually exhausts the OS limit.
- **`__exit__` returning `True` silently swallows exceptions** — a subtle source
  of "errors that vanished." Return `False`/`None` unless you *intend* to
  suppress.
- **The `as` variable is `__enter__`'s return value, not the manager** — note
  `open(...) as f` returns the file, but a custom manager must `return self` if
  you want the manager object.
- **Locks as context managers:** `threading.Lock` is a context manager —
  `with lock:` acquires and guarantees release, the correct pattern over manual
  `acquire()/release()`.
- **Interview ask:** "write a context manager that times a block and works even
  if the block throws." The trap is forgetting the `try/finally` around `yield`.

## Key takeaways

1. `with` guarantees deterministic teardown — it's Python's RAII for resources.
2. The protocol is `__enter__` (returns the `as` value) and `__exit__` (always
   runs; gets exception info).
3. `__exit__` returning truthy *suppresses* the exception — usually you want
   `False`.
4. `@contextlib.contextmanager` lets you write one as a generator with a
   `try/finally` around `yield`.
5. Use them for scoped state (`np.errstate`, `pd.option_context`, temp seeds)
   and `ExitStack`/`suppress`/`closing` for composition.
6. Locks, files, sockets, and DB connections should always be entered via `with`.

## Self-check

1. Write a `Timer` context manager two ways: as a class and with
   `@contextmanager`. What must wrap the `yield`, and why?
2. What value gets bound to `x` in `with mgr as x:`?
3. How do you make a context manager that *swallows* a specific exception, and
   why is that dangerous?
4. Why is `with open(...) as f:` safer than `f = open(...); ...; f.close()`?
5. You must open a number of files known only at runtime and guarantee all are
   closed. Which `contextlib` tool fits?
6. What is `np.errstate` good for in a numerical pipeline, and why use a context
   manager rather than a global setting?

## Further reading

- [`with` statement / context managers — language reference](https://docs.python.org/3/reference/datamodel.html#context-managers).
- [`contextlib` — Python docs](https://docs.python.org/3/library/contextlib.html) (`contextmanager`, `ExitStack`, `suppress`, `closing`).
- [PEP 343 — The "with" Statement](https://peps.python.org/pep-0343/).
- [`numpy.errstate`](https://numpy.org/doc/stable/reference/generated/numpy.errstate.html) and [`pandas.option_context`](https://pandas.pydata.org/docs/reference/api/pandas.option_context.html).
- Luciano Ramalho, *Fluent Python*, 2nd ed., Ch. 18 (context managers and `with`).

## Videos

- Raymond Hettinger — **"Transforming Code into Beautiful, Idiomatic Python"** (covers `with`) ([search](https://www.youtube.com/results?search_query=Raymond+Hettinger+Transforming+Code+into+Beautiful+Idiomatic+Python)).
- PyCon — **"Context managers and contextlib"** tutorials ([search](https://www.youtube.com/results?search_query=python+context+managers+contextlib+pycon)).
