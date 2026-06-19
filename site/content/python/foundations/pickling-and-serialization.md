# Pickling and Serialization

> **Why a quant must own this:** Caching a fitted model, shipping work to a
> `multiprocessing` pool, or persisting a feature matrix between runs all hinge
> on serialization. Pickle is the default — and a footgun: it executes
> arbitrary code on load, breaks across versions, and silently fails to capture
> open files or locks. Knowing *what* serializes, *how*, and *when to reach for
> Parquet/Feather instead* separates a reproducible research pipeline from a
> fragile one.

## First principles: what serialization is

Serialization turns a live, in-memory object graph into a flat byte stream that
can be written to disk or sent over a socket; deserialization reconstructs it.
The core difficulty is that Python objects form a *graph* — shared references,
cycles, nested containers — and the format must preserve that structure, not
just the leaf values.

Python ships several serializers, each with a different scope:

| Format    | Cross-language | Human-readable | Arbitrary objects | Speed | Safe to load untrusted |
|-----------|:--------------:|:--------------:|:-----------------:|:-----:|:----------------------:|
| `pickle`  | no             | no             | yes               | fast  | **NO**                 |
| `json`    | yes            | yes            | no (basic types)  | med   | yes                    |
| `marshal` | no             | no             | limited (CPython) | fast  | no                     |
| Parquet   | yes            | no (columnar)  | tabular only      | fast  | yes                    |

## Mechanics: how pickle works

`pickle` doesn't store a memory dump. It emits a small **stack-based program**
in a bytecode-like opcode language; `pickle.load` runs that program on a virtual
machine to rebuild the object. To serialize a custom object it, by default,
stores the class's import path and the instance's `__dict__`, then on load it
imports the class and repopulates the attributes.

```python
import pickle

obj = {"alpha": [1, 2, 3], "beta": (4, 5)}
blob = pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL)   # bytes
back = pickle.loads(blob)
assert back == obj

with open("state.pkl", "wb") as f:        # note: BINARY mode
    pickle.dump(obj, f)
```

### Protocols matter

Pickle has versioned **protocols** (0 through 5). Protocol 5 (3.8+) adds
out-of-band buffers for zero-copy of large binary data like NumPy arrays. Always
use `pickle.HIGHEST_PROTOCOL` (or `protocol=5`) for performance; the text-ish
protocol 0 is legacy. A pickle written with a higher protocol cannot be read by
an older Python that doesn't support it — a real cross-version trap.

### Reference sharing and cycles

Pickle uses a **memo** table to record objects it has already serialized, so
shared references stay shared and cycles terminate.

```python
import pickle
shared = [1, 2, 3]
graph = {"a": shared, "b": shared}        # both keys point to the SAME list
graph["self"] = graph                      # a cycle

restored = pickle.loads(pickle.dumps(graph))
print(restored["a"] is restored["b"])     # True -- sharing preserved
print(restored["self"] is restored)       # True -- cycle preserved
```

### Customizing pickling

When the default `__dict__` capture is wrong — open files, sockets, locks,
caches you don't want persisted — override the hooks. `__getstate__` returns
what to save; `__setstate__` reconstructs from it.

```python
class FeedHandler:
    def __init__(self, host):
        self.host = host
        self._conn = open("/dev/null")    # unpicklable resource

    def __getstate__(self):
        state = self.__dict__.copy()
        del state["_conn"]                # drop the live connection
        return state

    def __setstate__(self, state):
        self.__dict__.update(state)
        self._conn = open("/dev/null")    # re-open on load
```

## What does NOT pickle

- **Lambdas, local/nested functions, and most closures** — pickle stores
  functions *by import path* (module + qualified name), so anything that can't
  be re-imported fails. (`dill` and `cloudpickle` extend this.)
- **Open file handles, sockets, threads, locks, generators, tracebacks.**
- **`__main__`-defined classes** when unpickled in a different process can fail
  to resolve — a frequent `multiprocessing` headache on macOS/Windows ("spawn").

```python
import pickle
pickle.dumps(lambda x: x)     # PicklingError / AttributeError on lambdas
```

## The security warning that gets people fired

**`pickle.load` on untrusted data is remote code execution.** Because unpickling
runs an opcode program that can call arbitrary constructors, a malicious pickle
can execute any code via the `__reduce__` mechanism.

```python
# Illustrative ONLY — never load untrusted pickles.
class Exploit:
    def __reduce__(self):
        import os
        return (os.system, ("echo pwned",))   # runs on load!
```

The rule: **never unpickle data you did not produce yourself.** For data
crossing a trust boundary, use JSON, Parquet, or a schema'd format (Protocol
Buffers, MessagePack) — none of which execute code.

## The quant-correct choice: columnar formats for data

Pickle is fine for transient caches and in-process IPC, but for a *feature
matrix* or *price panel* you want **Parquet** or **Feather**: columnar, typed,
compressed, cross-language (Arrow), and partial-read friendly.

```python
import pandas as pd
df = pd.DataFrame({"ret": [0.01, -0.02], "vol": [1e6, 2e6]})

df.to_parquet("features.parquet")            # columnar, compressed, typed
df.to_feather("features.feather")            # Arrow IPC: fastest round-trip
back = pd.read_parquet("features.parquet", columns=["ret"])   # column pruning
```

Why this beats `df.to_pickle`: Parquet round-trips dtypes faithfully, is
readable by Spark/DuckDB/R, supports predicate/column pushdown, and isn't tied
to your exact pandas version. Reserve `to_pickle` for throwaway intermediate
caches.

## Performance reality

- Pickle protocol 5 with NumPy arrays is near-`memcpy` fast (out-of-band
  buffers, zero-copy). Protocol 0 is dramatically slower — always set the
  protocol.
- For a single big DataFrame, **Feather/Arrow** typically gives the fastest
  round-trip; **Parquet** trades a little speed for compression and column
  pushdown.
- `multiprocessing` pickles every argument and return value to ship across the
  process boundary — so passing a 2 GB DataFrame to each worker pickles it 2 GB
  times. Prefer shared memory, memory-mapped Arrow, or chunking by reference.
- JSON is slow and lossy for numerics (everything becomes float/str), but it's
  the right call for config and cross-service messages.

## Quant relevance & interview gotchas

- **`joblib.dump`** (used by scikit-learn) is pickle under the hood but with
  efficient NumPy handling — still carries the same security and versioning
  caveats. A model pickled under sklearn 1.3 may not load under 1.5.
- **Reproducibility:** pickling a model freezes the *object*, not the *library
  version*. Pin your environment; record library versions alongside the blob.
- **`multiprocessing` on spawn** (default on macOS, mandatory on Windows)
  requires every passed object — and the target function — to be picklable and
  importable. This is why "it works in a Jupyter cell but not in a script"
  bites people.
- **Determinism:** pickle output is not guaranteed byte-stable across Python
  versions; don't hash a pickle blob to detect data changes — hash the data.

## Key takeaways

1. Pickle serializes a Python object *graph* as a stack-machine program; loading
   *executes* it — never unpickle untrusted data.
2. Use `protocol=5` (or `HIGHEST_PROTOCOL`) for speed and zero-copy buffers.
3. Lambdas, closures, files, sockets, and locks don't pickle; customize with
   `__getstate__`/`__setstate__` or use `cloudpickle`.
4. Pickle is version- and language-locked; for persisted data use Parquet/
   Feather (Arrow) — typed, compressed, cross-language.
5. `multiprocessing` and `joblib` rely on pickling; large objects get copied,
   so design for it.

## Self-check

1. Why is `pickle.load` on untrusted bytes a security vulnerability, and what is
   the mechanism that enables it?
2. Your object holds an open socket. Which two methods do you implement to
   pickle it, and what does each do?
3. Why does pickling a lambda fail while pickling a top-level `def` succeeds?
4. When would you choose Parquet over `df.to_pickle`, and name two advantages.
5. A script using `multiprocessing` works in a notebook but fails with a
   pickling error as a `.py` file. What's the likely cause?
6. What does protocol 5 add that matters for large NumPy arrays?

## Further reading

- [`pickle` — Python docs](https://docs.python.org/3/library/pickle.html) (protocols, `__reduce__`, security note).
- [`json` — Python docs](https://docs.python.org/3/library/json.html).
- [PEP 574 — Pickle protocol 5 with out-of-band data](https://peps.python.org/pep-0574/).
- [pandas IO: Parquet / Feather](https://pandas.pydata.org/docs/user_guide/io.html#io-parquet).
- [Apache Arrow Python docs](https://arrow.apache.org/docs/python/) — the format under Feather/Parquet.
- [`cloudpickle`](https://github.com/cloudpipe/cloudpickle) — pickling closures and notebook-defined objects.

## Videos

- PyData — **"The Apache Arrow / Parquet ecosystem"** talks ([search](https://www.youtube.com/results?search_query=PyData+Apache+Arrow+Parquet+talk)).
- **"Pickle's nine flaws"** / pickle security talk ([search](https://www.youtube.com/results?search_query=python+pickle+security+talk)).
