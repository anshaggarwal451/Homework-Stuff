# CPython Interpreter & Loop Performance

> **Why a quant must own this:** When a backtest is "too slow," the answer is
> almost always "you wrote a Python loop over data." Understanding *why*
> CPython's per-iteration overhead is so large — bytecode dispatch, object
> boxing, reference counting, dynamic dispatch — tells you exactly where the
> time goes and which fixes actually help (vectorize, drop to C/Numba) versus
> which are cargo-cult (micro-tweaks). This is the conceptual bedrock for the
> rest of the performance module and a favorite "why is Python slow?" interview
> question.

## First principles: CPython is a bytecode interpreter

CPython compiles your source to **bytecode** and runs it on a stack-based virtual
machine. There is no machine-code compilation of your loop; each operation is
*interpreted*. You can see the bytecode:

```python
import dis
def add_loop(xs):
    total = 0
    for x in xs:
        total += x
    return total

dis.dis(add_loop)
# ... FOR_ITER, LOAD_FAST, BINARY_OP (+), STORE_FAST, JUMP_BACKWARD ...
```

Every `total += x` becomes several bytecode instructions. The interpreter's
evaluation loop fetches, decodes, and dispatches each one — overhead that a
compiled language pays *once* at compile time, Python pays *every iteration*.

## Where the time actually goes

A single `total += x` in pure Python triggers, per iteration:

1. **Bytecode dispatch** — the eval loop decodes each instruction (a computed
   `goto`/switch). Tens of these per loop body.
2. **Object boxing** — `x` is a full `PyObject` (a heap-allocated `int` with a
   type pointer and refcount), not a raw machine integer. `total` and `x` are
   pointers that must be dereferenced.
3. **Dynamic type dispatch** — `+` doesn't know it's adding ints until runtime;
   it looks up `__add__` on the type and calls it.
4. **New object allocation** — Python ints are immutable, so `total += x`
   allocates a *new* int object (above the small-int cache of -5..256).
5. **Reference counting** — every object touched has its refcount incremented and
   decremented; the GIL is held throughout.

The result: a pure-Python numeric loop runs roughly **10-100× slower** than the
equivalent C, and that gap *grows* with the amount of per-element work that could
otherwise be amortized.

```text
   C loop:        load reg, add, store      ~1 instr/elem, in cache, SIMD-able
   Python loop:   FOR_ITER -> LOAD_FAST -> BINARY_OP(__add__ dispatch ->
                  alloc new int -> refcount churn) -> STORE_FAST -> JUMP
                  ~dozens of instrs/elem, pointer-chasing, GIL held
```

## The fix: push the loop into C

Vectorization (NumPy/pandas) and JIT (Numba) both work by **moving the loop out
of the interpreter** into compiled code that operates on raw, contiguous,
unboxed data — paying the dispatch/boxing cost *zero* times instead of N times.

```python
import numpy as np
xs = np.arange(10_000_000)

# Pure Python: ~dozens of bytecode ops per element, all boxed
def py_sum(a):
    t = 0
    for x in a:        # NOTE: iterating a NumPy array in Python is the WORST case
        t += int(x)    # each element is unboxed to a Python int -> extra cost
    return t

# Vectorized: one C call, contiguous int64 buffer, SIMD reduction
fast = xs.sum()        # orders of magnitude faster
```

> **Counterintuitive but vital:** iterating a NumPy array *with a Python loop* is
> often *slower* than iterating a list, because each access boxes a NumPy scalar
> into a Python object. The win comes only from staying in vectorized C — never
> from `for x in np_array`.

## Measuring before optimizing

Never guess. Time and profile.

```python
# %timeit in IPython/Jupyter: robust micro-benchmark
# %timeit py_sum(xs)
# %timeit xs.sum()

import timeit
timeit.timeit("xs.sum()", globals=globals(), number=100)

# Find the hot function with a profiler:
import cProfile
cProfile.run("py_sum(xs)")      # shows cumulative time per function
# line_profiler (@profile) for line-by-line; py-spy for sampling a live process
```

Optimize the function the profiler flags, not the one you *think* is slow.
Premature micro-optimization of cold code is wasted effort.

## What helps vs what doesn't

| Tactic                                   | Effect on a numeric loop                       |
|------------------------------------------|------------------------------------------------|
| Vectorize with NumPy/pandas              | **10-100×** — eliminates per-element overhead  |
| Numba `@njit` on the loop                | **10-100×** — compiles to machine code         |
| `sum()`/built-ins / comprehensions       | modest — loop still in C-ish builtin, less boxing|
| Local-variable binding of attrs/methods  | small — fewer `LOAD_GLOBAL`/attr lookups       |
| `__slots__` on hot objects               | small-moderate — less memory, faster attr access|
| Renaming variables / cosmetic tweaks     | **none** — cargo cult                          |
| Multithreading a CPU-bound Python loop   | **none/negative** — the GIL serializes it      |

The hierarchy: **vectorize first**; if the algorithm can't be expressed in array
ops, **Numba/Cython**; only then consider micro-tactics. Threads don't help
CPU-bound Python (the GIL) — see the multiprocessing lesson.

## A note on the modern interpreter

CPython has been getting faster: 3.11's "Faster CPython" work added an *adaptive
specializing* interpreter (PEP 659) that specializes hot bytecodes (e.g. an
`int + int` becomes a fast path after observing types), and 3.13 adds an
experimental JIT. These shrink the constant factor but **do not** change the big
picture: a Python-level loop over millions of elements still loses badly to a
vectorized C loop. Vectorization remains the answer.

## Performance reality

- The overhead is **per element**, so the gap scales with N. For 10 elements,
  nobody cares; for 10 million, it's the whole ballgame.
- **Boxing and allocation churn** also thrash the allocator and cache — the loop
  isn't just doing more instructions, it's doing *memory-unfriendly* ones
  (pointer chasing vs streaming a contiguous buffer).
- **`functools`/builtin reductions** (`sum`, `max`, `any`, `map`) run their loop
  in C and beat hand-written Python loops, though they still box elements — a
  middle ground when you can't vectorize.
- **The right metric is wall-clock on representative data.** Use `%timeit` for
  micro, `cProfile`/`py-spy` for finding hot spots in a real run.

## Quant relevance & interview gotchas

- **"Why is Python slow?"** — the expected answer: *interpreted bytecode +
  dynamic typing + everything is a boxed heap object + refcounting under a GIL*,
  so per-element work is expensive; the fix is to push loops into compiled C via
  NumPy/Numba. Saying "Python is just slow" is a junior answer.
- **`iterrows`/`apply(axis=1)`/`for x in array`** are the three telltale signs of
  a loop that should be vectorized — interviewers and code reviewers spot these
  instantly.
- **Profiling discipline:** be ready to say *how* you'd find the bottleneck
  (`cProfile`, `line_profiler`, `py-spy`) rather than guessing.
- **The GIL** means you cannot fix a slow CPU-bound Python loop by adding
  threads — a common wrong answer.
- Knowing *when not to vectorize* matters too: inherently sequential logic (path-
  dependent state, early exit, irregular control flow) may be better in Numba
  than contorted into array ops.

## Key takeaways

1. CPython interprets bytecode on a VM; each operation pays dispatch, boxing,
   dynamic dispatch, allocation, and refcount costs — *per element*.
2. A pure-Python numeric loop is ~10-100× slower than C; the gap scales with N.
3. The fix is to move the loop into compiled code (NumPy vectorization, Numba),
   paying the overhead zero times instead of N.
4. Iterating a NumPy array in a Python loop is the worst of both worlds — it
   boxes every element.
5. Measure with `%timeit`/`cProfile`/`py-spy` before optimizing; optimize the
   hot function, not the imagined one.
6. Adaptive specialization (3.11+) shrinks constants but doesn't beat
   vectorization; threads don't help CPU-bound loops (GIL).

## Self-check

1. List four distinct sources of per-iteration overhead in a pure-Python numeric
   loop.
2. Why is `for x in numpy_array: ...` often slower than vectorized NumPy *and*
   sometimes slower than looping a list?
3. What does `dis.dis(f)` show you, and how does it explain Python's loop cost?
4. Name the tools you'd use to (a) micro-benchmark and (b) find the hot function
   in a slow backtest.
5. Why won't adding threads speed up a CPU-bound pure-Python loop?
6. Give one situation where Numba is a better fix than vectorization.

## Further reading

- [CPython internals — `dis` module](https://docs.python.org/3/library/dis.html) (bytecode disassembly).
- [PEP 659 — Specializing Adaptive Interpreter](https://peps.python.org/pep-0659/) (Faster CPython).
- [`cProfile` and `profile`](https://docs.python.org/3/library/profile.html), [`timeit`](https://docs.python.org/3/library/timeit.html).
- [`line_profiler`](https://github.com/pyutils/line_profiler) and [`py-spy`](https://github.com/benfred/py-spy) (sampling profiler).
- [Why is Python slow? — Jake VanderPlas blog](https://jakevdp.github.io/blog/2014/05/09/why-python-is-slow/).

## Videos

- Jake VanderPlas — **"Losing your Loops: Fast Numerical Computing with NumPy"** (PyCon 2015) ([search](https://www.youtube.com/results?search_query=Jake+VanderPlas+Losing+your+Loops+NumPy+PyCon+2015)).
- Brandon Rhodes — **"The Day of the EXE Is Upon Us"** / CPython internals talks ([search](https://www.youtube.com/results?search_query=CPython+bytecode+interpreter+internals+talk+PyCon)).
