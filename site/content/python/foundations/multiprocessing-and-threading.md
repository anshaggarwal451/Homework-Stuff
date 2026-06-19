# Multiprocessing and Threading

> **Why a quant must own this:** Backtests over thousands of parameter sets,
> Monte Carlo simulations, and feature computation all beg for parallelism — but
> the **GIL** means naive threading gives you *zero* speedup on CPU-bound Python.
> Knowing exactly when to use threads (I/O), processes (CPU), or to push the work
> into NumPy/Numba (which release the GIL) is the single most consequential
> performance decision in a research pipeline. It's also a guaranteed interview
> topic.

## First principles: the GIL

CPython has a **Global Interpreter Lock** — a single mutex that ensures only one
thread executes Python bytecode at a time. It exists because CPython's memory
management (reference counting) isn't thread-safe without it. The practical
consequence:

- **CPU-bound pure-Python code does not speed up with threads.** Eight threads
  share one GIL and take turns; you get concurrency, not parallelism.
- **I/O-bound code *does* benefit from threads**, because a thread releases the
  GIL while blocked on a socket/disk read, letting others run.
- **C extensions can release the GIL** during heavy work. NumPy, pandas, scikit-
  learn, and Numba (`nogil=True`) do exactly this, so they *can* run truly
  parallel even from threads.

> Note: CPython 3.13 ships an experimental **free-threaded** build (PEP 703)
> that removes the GIL, but the default interpreter you'll meet in interviews and
> most production still has it. Reason about the GIL.

## The decision table

| Workload                              | Use                          | Why                                |
|---------------------------------------|------------------------------|------------------------------------|
| CPU-bound pure Python                 | `multiprocessing` / processes| sidesteps the GIL — separate interps|
| CPU-bound, vectorizable               | NumPy / Numba (`nogil`)      | C loops release the GIL            |
| I/O-bound (HTTP, DB, files)           | `threading` / `asyncio`      | GIL released while blocked         |
| Many small independent tasks          | `concurrent.futures` pool    | uniform API over threads/processes |
| Huge shared array, read-mostly        | shared memory / mmap         | avoid copying it to every worker   |

## Threads: right for I/O, useless for CPU Python

```python
from concurrent.futures import ThreadPoolExecutor
import urllib.request

def fetch(url):
    with urllib.request.urlopen(url) as r:      # blocks -> GIL released
        return len(r.read())

urls = ["https://example.com"] * 8
with ThreadPoolExecutor(max_workers=8) as pool:
    sizes = list(pool.map(fetch, urls))          # real overlap: network waits hide
```

Here eight downloads overlap because each thread releases the GIL while waiting
on the network. Swap `fetch` for a tight numeric Python loop and the same code
would be *no faster than serial* — often slower, due to lock contention.

## Processes: real parallelism for CPU work

`multiprocessing` (or `ProcessPoolExecutor`) spawns separate interpreters, each
with its own GIL. The cost: arguments and results are **pickled** and copied
across the process boundary, and startup is heavier than a thread.

```python
from concurrent.futures import ProcessPoolExecutor
import numpy as np

def run_backtest(params):
    fast, slow = params
    # ... pretend this is expensive pure-Python work ...
    return fast, slow, np.random.default_rng(fast).standard_normal(10).mean()

grid = [(f, s) for f in range(5, 15) for s in range(20, 60)]
if __name__ == "__main__":                       # REQUIRED on spawn (mac/Windows)
    with ProcessPoolExecutor() as pool:
        results = list(pool.map(run_backtest, grid))
```

The `if __name__ == "__main__":` guard is mandatory: on the **spawn** start
method (default on macOS and Windows) each worker re-imports your module, and
without the guard it would recursively spawn more pools.

### Start methods

- **fork** (Linux default): child inherits parent memory copy-on-write — cheap,
  but unsafe with threads/locks held at fork time.
- **spawn** (macOS/Windows default): fresh interpreter, everything re-imported
  and re-pickled — safe but slower; the source of most "works in notebook, fails
  in script" pickling errors.

## Sharing data without copying it

Pickling a 2 GB array to every worker is murder. Options:

```python
from multiprocessing import shared_memory
import numpy as np

arr = np.arange(1_000_000, dtype=np.float64)
shm = shared_memory.SharedMemory(create=True, size=arr.nbytes)
buf = np.ndarray(arr.shape, dtype=arr.dtype, buffer=shm.buf)
buf[:] = arr[:]                  # one copy into shared memory; workers map it
# pass shm.name to workers; each does np.ndarray(..., buffer=existing_shm.buf)
shm.close(); shm.unlink()        # clean up
```

For DataFrames, memory-mapping a Parquet/Arrow file that workers open
independently is often simpler and avoids per-worker copies entirely.

## The often-better answer: vectorize / Numba, then maybe parallelize

Before adding processes, ask whether the work can be vectorized. A NumPy
operation runs a C loop with no per-element GIL cost and often uses BLAS
multithreading internally — frequently faster than a Python process pool *and*
simpler. Numba's `@njit(parallel=True)` releases the GIL and parallelizes loops
with `prange`. The hierarchy of effort:

```text
   1. Vectorize in NumPy/pandas      (often 10-100x, no parallel code)
   2. Numba @njit (+ parallel)       (loop-shaped work, GIL released)
   3. ProcessPool over chunks        (embarrassingly parallel, CPU-bound)
   4. Threads                        (ONLY for I/O or GIL-releasing C calls)
```

## Performance reality

- **Process pool overhead**: spawn + pickle round-trips. Parallelism pays off
  only when each task is substantial (tens of ms+). For millions of tiny tasks,
  the IPC dominates — chunk them.
- **Threads + NumPy** *can* parallelize because BLAS/NumPy drop the GIL — but
  watch for **oversubscription**: a 16-thread pool each calling 16-thread BLAS =
  256 threads fighting for cores. Set `OMP_NUM_THREADS` / `MKL_NUM_THREADS=1` in
  workers.
- **Memory**: `fork` shares pages copy-on-write (read-only data is free to
  share); `spawn` copies everything. A read-only lookup table is nearly free
  under fork, expensive under spawn.
- `asyncio` beats threads for *thousands* of concurrent I/O operations (no
  per-connection thread stack), but it's single-threaded and CPU-bound work
  blocks the loop.

## Quant relevance & interview gotchas

- **"Why didn't my threaded backtest get faster?"** — the GIL. CPU-bound pure
  Python doesn't parallelize across threads. This is *the* classic question.
- **Picklability**: `ProcessPoolExecutor` pickles the function and its args.
  Lambdas, closures, and `__main__`-only objects fail under spawn. Use top-level
  functions or `cloudpickle`-backed pools.
- **Determinism / reproducibility**: parallel workers with shared RNG state give
  non-reproducible results. Seed each worker independently
  (`np.random.default_rng(seed)` per task).
- **Forking with threads is dangerous**: if a lock is held when you fork, the
  child can deadlock. Prefer spawn, or fork before starting threads.
- **`joblib.Parallel`** (used by scikit-learn) wraps all of this with sensible
  defaults and a memory-mapping backend (`loky`) for large arrays — reach for it
  in research before hand-rolling pools.

## Key takeaways

1. The GIL serializes Python bytecode: threads give concurrency, not CPU
   parallelism, in pure Python.
2. Threads/`asyncio` win for I/O-bound work (GIL released while blocked);
   processes win for CPU-bound pure Python.
3. NumPy/pandas/Numba release the GIL in their C code — so vectorizing is often
   the best "parallelism" and beats process pools.
4. Processes copy args via pickle; guard entry points with
   `if __name__ == "__main__"`, and use shared memory/mmap for big arrays.
5. Beware spawn-vs-fork pitfalls, BLAS thread oversubscription, and
   per-worker RNG seeding.

## Self-check

1. Why does running a tight numeric Python loop across 8 threads not get
   faster, while downloading 8 URLs across 8 threads does?
2. What does `multiprocessing` copy to each worker, and why does that make
   passing a 2 GB DataFrame expensive?
3. Why is `if __name__ == "__main__":` required for a process pool on macOS?
4. Give two reasons to vectorize in NumPy before reaching for a process pool.
5. What is BLAS thread oversubscription and how do you avoid it in a process
   pool?
6. How do you make a parallel Monte Carlo reproducible across workers?

## Further reading

- [`threading`](https://docs.python.org/3/library/threading.html), [`multiprocessing`](https://docs.python.org/3/library/multiprocessing.html), [`concurrent.futures`](https://docs.python.org/3/library/concurrent.futures.html) — Python docs.
- [What is the GIL? — Python docs glossary](https://docs.python.org/3/glossary.html#term-global-interpreter-lock).
- [PEP 703 — Making the GIL optional](https://peps.python.org/pep-0703/) (free-threaded CPython).
- [`multiprocessing.shared_memory`](https://docs.python.org/3/library/multiprocessing.shared_memory.html) and [joblib Parallel](https://joblib.readthedocs.io/en/stable/parallel.html).
- [`asyncio` — Python docs](https://docs.python.org/3/library/asyncio.html).

## Videos

- David Beazley — **"Understanding the Python GIL"** (PyCon 2010) ([search](https://www.youtube.com/results?search_query=David+Beazley+Understanding+the+Python+GIL)).
- Raymond Hettinger — **"Thinking about Concurrency"** ([search](https://www.youtube.com/results?search_query=Raymond+Hettinger+Thinking+about+Concurrency)).
