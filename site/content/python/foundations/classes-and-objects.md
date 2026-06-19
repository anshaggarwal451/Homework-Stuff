# Classes and Objects

> **Why a quant must own this:** Strategy objects, order/position records,
> indicator pipelines — research code is full of small classes. Knowing how
> Python's object model actually works (attribute lookup, `__slots__`, dunder
> protocols, `dataclass`) lets you write objects that are memory-light, fast to
> construct by the million, and behave correctly in `dict`s and DataFrames.
> Interviewers probe `__slots__`, `@property`, and MRO because they expose
> whether you understand the model or just the syntax.

## First principles: everything is an object with a namespace

In Python every value is an object: it has a type, an identity (`id`), and a
namespace (`__dict__`) of attributes. A *class* is itself an object (an instance
of its metaclass, usually `type`). Instances delegate to their class for methods
and class attributes.

```python
class Order:
    venue = "NASDAQ"                 # class attribute (shared)

    def __init__(self, sym, qty):
        self.sym = sym               # instance attributes (per-object)
        self.qty = qty

o = Order("AAPL", 100)
print(o.sym, o.venue)                # AAPL NASDAQ
print(type(o), type(Order))          # <class 'Order'> <class 'type'>
```

## Mechanics: attribute lookup

When you read `o.attr`, Python searches in a defined order. Internally this is
driven by `__getattribute__`, the descriptor protocol, and the **MRO** (method
resolution order):

1. **Data descriptors** on the type (e.g. `property`) win first.
2. The instance `__dict__`.
3. Non-data descriptors and plain class attributes, walking the MRO.
4. `__getattr__` as a fallback if all else fails.

```python
print(Order.__mro__)        # (<class 'Order'>, <class 'object'>)
```

For multiple inheritance, the MRO is computed by the **C3 linearization**
algorithm, which gives a consistent, predictable order and is what makes
cooperative `super()` work.

### `self` and bound methods

There is no implicit `this`. `o.method()` is sugar: Python looks up `method` on
the class, sees it's a function (a descriptor), and binds it — `Order.method(o)`.
That's why every instance method takes `self` explicitly.

## The dunder protocols that make objects "Pythonic"

Operators and built-ins dispatch to **dunder** (double-underscore) methods. Implementing
the right ones makes your object behave like a native type.

```python
class Money:
    __slots__ = ("cents",)                  # see below

    def __init__(self, cents):
        self.cents = cents

    def __repr__(self):                      # unambiguous, for developers
        return f"Money(cents={self.cents})"

    def __eq__(self, other):
        return isinstance(other, Money) and self.cents == other.cents

    def __hash__(self):                      # needed to use as dict key / in set
        return hash(self.cents)

    def __lt__(self, other):                 # enables sorting & min/max
        return self.cents < other.cents

    def __add__(self, other):
        return Money(self.cents + other.cents)

print(sorted([Money(300), Money(100)]))      # [Money(cents=100), Money(cents=300)]
```

> **Rule:** if you define `__eq__`, you must also define `__hash__` (or set
> `__hash__ = None` to make it unhashable). Defining `__eq__` alone silently
> makes instances unhashable, breaking their use as dict keys.

## `__slots__`: the memory optimization that matters at scale

By default each instance carries a `__dict__` (a hash table) for its attributes —
flexible but heavy. `__slots__` replaces it with a fixed C-level array of
attribute slots: less memory per instance, faster attribute access, and no
accidental attributes.

```python
import sys

class WithDict:
    def __init__(self, p, q):
        self.p, self.q = p, q

class WithSlots:
    __slots__ = ("p", "q")
    def __init__(self, p, q):
        self.p, self.q = p, q

# On CPython, a WithSlots instance is meaningfully smaller than WithDict,
# and you cannot add an undeclared attribute:
s = WithSlots(1, 2)
# s.r = 3        # AttributeError: 'WithSlots' object has no attribute 'r'
```

For millions of small records (order events, ticks), `__slots__` can cut memory
several-fold and speed construction. The trade-offs: no dynamic attributes, and
subclasses need their own `__slots__` to keep the benefit.

## `@property`: computed attributes without breaking the interface

A `property` is a data descriptor that runs a method on attribute access — so
you can start with a plain attribute and later add validation or computation
without changing callers.

```python
class Position:
    def __init__(self, qty, price):
        self.qty = qty
        self.price = price

    @property
    def notional(self):
        return self.qty * self.price          # computed, read-only

    @property
    def price(self):
        return self._price

    @price.setter
    def price(self, value):
        if value < 0:
            raise ValueError("price must be non-negative")
        self._price = value

p = Position(100, 50.0)
print(p.notional)        # 5000.0
# p.price = -1          # ValueError
```

## `@dataclass`: the idiomatic record type

For the common "bag of typed fields with `__init__`/`__repr__`/`__eq__`" you
shouldn't hand-write boilerplate — use `dataclasses`. It also supports
`frozen=True` (immutable, hashable) and `slots=True` (3.10+).

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Trade:
    symbol: str
    qty: int
    price: float

    @property
    def notional(self) -> float:
        return self.qty * self.price

t = Trade("MSFT", 10, 430.0)
print(t)                 # Trade(symbol='MSFT', qty=10, price=430.0)
# t.qty = 5             # FrozenInstanceError -- frozen, so hashable & safe as key
positions = {t: 1}       # works because frozen dataclass is hashable
```

## Diagram: attribute lookup order

```text
   o.attr  ──▶  type(o).__getattribute__(o, "attr")
                  │
                  ├─ data descriptor on type?  (property/__set__) ─▶ use it
                  ├─ "attr" in o.__dict__?                        ─▶ return it
                  ├─ non-data descriptor / class attr in MRO?     ─▶ use it
                  └─ none found  ─▶  type(o).__getattr__(o,"attr") or AttributeError
```

## Performance reality

- **`__slots__`** is the big lever: less memory and faster access for many small
  instances. Profile before assuming — for a handful of objects it doesn't
  matter.
- Attribute access via `@property` adds a function call vs a bare attribute;
  cheap, but don't put a `@property` that recomputes an expensive value in a hot
  loop — use `functools.cached_property`.
- **Creating millions of Python objects is itself the bottleneck.** For tabular
  numeric data, don't model each row as an object — use a NumPy structured array
  or a DataFrame, which stores columns contiguously and avoids per-row boxing.
- `dataclass(slots=True)` gives you both ergonomics and the slots win.

## Quant relevance & interview gotchas

- **Class vs instance attribute mutation:** a *mutable* class attribute (e.g.
  `fills = []` at class level) is shared by all instances — the same trap as
  mutable default args. Initialize mutables in `__init__`.
- **`is` vs `==`:** `is` compares identity, `==` compares value (via `__eq__`).
  Small ints and interned strings may share identity, which leads to misleading
  `is` results — never use `is` for value comparison.
- **`__repr__` vs `__str__`:** define `__repr__` (unambiguous, for debugging);
  `__str__` falls back to it. A good `__repr__` saves hours in research logs.
- **MRO / diamond inheritance:** know that `super()` follows the C3 MRO, not a
  naive parent pointer — common in interviews about cooperative multiple
  inheritance.
- For modeling market data at scale, prefer columnar/array storage over an
  object per tick; objects are for *behavior*, arrays are for *bulk numbers*.

## Key takeaways

1. Everything is an object with a namespace; classes are objects too (instances
   of `type`).
2. Attribute lookup follows descriptors → instance `__dict__` → MRO →
   `__getattr__`.
3. Dunder methods make objects behave natively; define `__hash__` whenever you
   define `__eq__`.
4. `__slots__` trades flexibility for big memory/speed wins on many small
   instances.
5. Use `@property` for computed/validated attributes and `@dataclass` for record
   types (with `frozen`/`slots`).
6. For bulk numeric data, use arrays/DataFrames, not one Python object per row.

## Self-check

1. You define `__eq__` on a class and then use instances as dict keys. What
   happens, and why?
2. What exactly does `o.method()` desugar to, and what role does the descriptor
   protocol play?
3. When does `__slots__` help, and what two capabilities do you give up?
4. Why is a mutable class-level attribute a bug magnet? Give an example.
5. Explain the difference between `is` and `==`, and when relying on `is` for
   ints/strings misleads you.
6. What does `@dataclass(frozen=True, slots=True)` buy you over a hand-written
   class?

## Further reading

- [Python Data Model — language reference](https://docs.python.org/3/reference/datamodel.html) (dunder methods, `__slots__`, descriptors).
- [`dataclasses` — Python docs](https://docs.python.org/3/library/dataclasses.html).
- [Descriptor HowTo Guide — Python docs](https://docs.python.org/3/howto/descriptor.html).
- [The Python 2.3 Method Resolution Order (C3)](https://docs.python.org/3/howto/mro.html).
- Luciano Ramalho, *Fluent Python*, 2nd ed., Ch. 11-14 (objects, special methods, inheritance).

## Videos

- Raymond Hettinger — **"Python's Class Development Toolkit"** (PyCon) ([search](https://www.youtube.com/results?search_query=Raymond+Hettinger+Python%27s+Class+Development+Toolkit)).
- Raymond Hettinger — **"Build powerful, new data structures with Python's abstract base classes"** ([search](https://www.youtube.com/results?search_query=Raymond+Hettinger+abstract+base+classes+PyCon)).
