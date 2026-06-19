# Object-Oriented Design Principles

> **Why a quant dev must own this:** Interviewers expect you to speak SOLID
> fluently and write clean, maintainable abstractions for the *cold* path —
> config, order management, strategy wiring. But they also expect the senior
> twist: in the *hot* path, classic OO costs you. Every virtual call is a vtable
> indirection, a likely branch misprediction, and a wall the inliner can't cross.
> The HFT counter-discipline is **data-oriented design** — organize code around
> how data is laid out in cache, not around a class diagram. Knowing *when* to
> apply OO and when to abandon it for DOD / static polymorphism is the mark of a
> systems engineer.

## First principles: what OO design is for

Object-oriented design organizes code around **objects** that bundle data with
the operations on it, communicating through well-defined interfaces. Its goal is
*managing complexity in large, long-lived codebases* — making code easier to
change, test, and reason about. That goal is real and valuable; the question for
HFT is always *at what cost, and on which path.*

The discipline crystallized into **SOLID** (Robert C. Martin) plus a handful of
heuristics (composition over inheritance, DRY/KISS/YAGNI). Then comes the
hardware reality that complicates all of it.

## SOLID

### S — Single Responsibility Principle

*A class should have one reason to change* — one job. A class that parses a
feed, computes signals, *and* sends orders has three reasons to change and is
brittle. Split it.

```cpp
// Bad: one class, three responsibilities.
class Strategy { void parse(); void computeSignal(); void sendOrder(); };

// Good: each piece changes independently.
class FeedParser   { Quote parse(const std::byte* msg); };
class SignalEngine { Signal compute(const Quote& q); };
class OrderGateway { void send(const Order& o); };
```

### O — Open/Closed Principle

*Open for extension, closed for modification.* You should add new behavior by
adding code, not editing tested code. Adding a new order type shouldn't mean
re-opening (and re-risking) the matching engine.

```cpp
struct ExecutionAlgo { virtual void execute(const Order&) = 0; virtual ~ExecutionAlgo() = default; };
struct TWAP : ExecutionAlgo { void execute(const Order&) override; };
struct VWAP : ExecutionAlgo { void execute(const Order&) override; };
// Add a new algo by writing a new subclass — the dispatcher is untouched.
```

### L — Liskov Substitution Principle

*Subtypes must be usable anywhere their base type is expected, without surprises.*
A derived class must honor the base's contract — not strengthen preconditions or
weaken postconditions. The classic violation: `Square : Rectangle` where setting
width also changes height, breaking code that assumed they're independent.

### I — Interface Segregation Principle

*Don't force clients to depend on methods they don't use.* Prefer many small,
focused interfaces over one fat one. A read-only consumer of market data
shouldn't have to depend on (or stub out) the mutating half of a giant interface.

### D — Dependency Inversion Principle

*Depend on abstractions, not concretions.* High-level policy shouldn't hard-wire
a low-level implementation; both depend on an interface. This is what makes code
testable (inject a mock gateway) and swappable (sim vs live exchange).

```cpp
struct IClock { virtual std::int64_t now() const = 0; virtual ~IClock() = default; };
class Engine {
    IClock& clock_;                       // depends on the abstraction
public:
    explicit Engine(IClock& c) : clock_(c) {}   // inject real or simulated clock
};
```

## Composition over inheritance

Inheritance models *is-a* and is the tightest coupling in OO — it exposes the
base's internals, is fixed at compile time, and creates fragile hierarchies.
**Composition** models *has-a*: build behavior by holding component objects.

```cpp
// Prefer: a Strategy HAS-A risk checker and HAS-AN order gateway (composition)...
class Strategy {
    RiskChecker  risk_;
    OrderGateway gateway_;
};
// ...over a deep "Strategy is-a TradingComponent is-a Loggable is-a ..." tower.
```

Composition is more flexible (swap components at runtime), avoids the diamond
problem, and keeps coupling loose. The C++ Core Guidelines and *Effective C++*
both push this hard: reach for inheritance only when you genuinely need runtime
polymorphism through a base interface.

## The cost of OO abstractions in C++

Here is where the HFT lens sharpens. C++'s zero-overhead principle means you only
pay for what you use — but **runtime polymorphism (`virtual`) is not free**, and
it's the abstraction OO leans on hardest.

A virtual call:

1. Loads the object's **vtable pointer** (an extra indirection / cache line).
2. Loads the function address from the vtable (another indirection).
3. Performs an **indirect call** through that pointer.

The costs that matter:

- **Two dependent loads** before the call — and if the vtable/object isn't hot in
  cache, a miss (~tens of ns).
- **Branch (target) misprediction.** An indirect call's target varies; if the CPU
  mispredicts, you eat a pipeline flush (~15–20 cycles). This connects to the
  branch-prediction sibling lesson — predictable, monomorphic call sites are fast;
  megamorphic ones (many different targets) are not.
- **An inlining barrier.** The compiler usually can't see *which* function runs,
  so it can't inline the callee — and losing inlining loses *all* the downstream
  optimizations (constant propagation, vectorization). This is frequently the
  biggest cost, dwarfing the indirection itself.

```cpp
struct Base { virtual int f(int) = 0; };
// for (auto* p : objects) sum += p->f(x);
//   -> per element: load vtable ptr, load f's address, indirect call,
//      no inlining of f, possible mispredict. In a hot loop, death by 1000 cuts.
```

> **Approximate, not benchmarked:** a well-predicted, cache-hot virtual call is
> only a few cycles more than a direct call. The damage is the *lost inlining*
> and the *misprediction under a megamorphic, cache-cold call site* — which is
> exactly the hot-loop scenario. Measure; don't guess.

## When polymorphism is worth it: static vs dynamic

The fix isn't "never use polymorphism" — it's "use the right *kind*."

- **Dynamic polymorphism (`virtual`)** — dispatch decided at *runtime*. Use it
  when the set of types genuinely isn't known until runtime (plugins, config-
  driven strategy selection) and the call is *not* on the hot path.
- **Static polymorphism (templates / CRTP)** — dispatch resolved at *compile
  time*, so the call inlines and there's no indirection or misprediction. Use it
  on the hot path when the type *is* known at compile time.

The **Curiously Recurring Template Pattern (CRTP)** gives you interface-style
reuse with zero runtime cost (covered fully in the CRTP sibling lesson):

```cpp
template <class Derived>
struct Strategy {
    void run() { static_cast<Derived*>(this)->onTick(); }   // resolved at compile time
};
struct Momentum : Strategy<Momentum> { void onTick(); };    // onTick INLINES, no vtable
```

> **Interview-ready rule:** *virtual dispatch for the cold/config path; CRTP or
> plain value types and free functions for the hot path.* Reserve runtime
> polymorphism for where the flexibility actually pays for itself.

## DRY / KISS / YAGNI

The pragmatic heuristics that keep OO honest:

- **DRY** (Don't Repeat Yourself) — each piece of knowledge has one authoritative
  representation. Duplicated logic drifts out of sync. *But* over-DRYing creates
  premature, tangled abstractions — balance against KISS.
- **KISS** (Keep It Simple) — the simplest design that works; complexity is a
  cost you pay forever.
- **YAGNI** (You Aren't Gonna Need It) — don't build for speculative future
  requirements. Especially relevant in HFT: a flexible, virtual-everything design
  "for future extensibility" you never use is pure hot-path tax.

## Design patterns relevant to systems

A few patterns recur in trading systems:

- **Strategy** — encapsulate interchangeable algorithms behind an interface
  (execution algos, signal models). Often *better as a template/CRTP* on the hot
  path.
- **Observer** — publish/subscribe; market-data dispatch to multiple consumers.
  Watch the cost: a `std::vector<Observer*>` notified per tick is a hot-loop of
  virtual calls — a place to consider static dispatch.
- **Factory** — centralize object creation (construct the right strategy from
  config). A cold-path pattern — fine to be virtual.
- **RAII as a pattern** — arguably C++'s most important "pattern": tie resource
  lifetime to object lifetime so cleanup is automatic and deterministic (see the
  RAII sibling lesson).

## Data-oriented design: the HFT counterpoint

This is the crux. Classic OO organizes code around *objects* and asks "what does
this thing do?" **Data-oriented design (DOD)** organizes code around *data* and
asks "how is this data laid out, accessed, and transformed — and what does the
cache want?" Mike Acton's argument: *the purpose of the program is to transform
data; the hardware that transforms it is real and has a cost; design for that
hardware, not for an idealized object model.*

The flagship DOD technique is **Struct-of-Arrays (SoA)** vs **Array-of-Structs
(AoS)**:

```cpp
// AoS — classic OO layout. Iterating one field touches whole objects.
struct Order { double price; double qty; int id; char side; /* padding */ };
std::vector<Order> orders;   // to sum prices, you stride over qty/id/side too

// SoA — DOD layout. One field is contiguous: cache-dense, vectorizable.
struct OrderBook {
    std::vector<double> price;   // summing/scanning price touches ONLY price,
    std::vector<double> qty;     // packs ~8 doubles per cache line,
    std::vector<int>    id;      // and auto-vectorizes cleanly.
    std::vector<char>   side;
};
```

If a hot loop only reads `price`, AoS wastes most of every cache line on `qty`,
`id`, `side`, and padding; SoA puts only prices in cache, so you fetch 8× more
useful data per line and the loop vectorizes. On memory-bound hot paths this is a
large, real speedup — and it is the *opposite* of "model the domain as objects."

```text
AoS cache line:  [price qty id side pad][price qty id side pad] ...
                  ^only price wanted; rest of the line is wasted bandwidth

SoA cache line:  [price price price price price price price price]
                  ^every byte is useful; the prefetcher and SIMD love this
```

> **The tension, stated plainly:** clean OO optimizes for *human* understanding
> and changeability; DOD optimizes for the *machine's* cache and pipeline. They
> pull in opposite directions. The senior judgment is to apply **OO where the
> code changes often and isn't hot** (config, wiring, order management) and
> **DOD where the loop is hot and the data is large** (book maintenance, signal
> computation, backtests).

## Quant/HFT relevance & interview gotchas

- **Speak SOLID precisely**, with a one-line trading example each — but be ready
  for the follow-up: "and where does this *cost* you in a hot loop?"
- **Virtual dispatch isn't free.** The headline cost is the **lost inlining** and
  **branch misprediction at megamorphic sites**, not just the indirection. State
  that distinction.
- **Static polymorphism (CRTP) for the hot path; virtual for the cold path.** The
  clean, reusable answer to "how do you get polymorphism without the cost."
- **AoS vs SoA** is a near-guaranteed HFT question. Know that SoA is cache-dense,
  vectorization-friendly, and wins on field-wise hot loops.
- **Prefer composition and value types** on the hot path; deep inheritance towers
  add vptr bloat and indirection.
- **YAGNI applies hard in HFT** — "extensible, virtual-everything" designs you
  never extend are pure latency tax.
- **Cite Mike Acton's DOD argument** as the philosophical counterpoint to OO: the
  program transforms data; design for the data and the hardware.
- **It's not OO *vs* DOD dogmatically** — it's *which path*. The wrong answer is
  treating either as universal.

## Key takeaways

1. **SOLID** (SRP, OCP, LSP, ISP, DIP) makes large, long-lived code changeable
   and testable — ideal for the **cold/config** path of a trading system.
2. **Prefer composition over inheritance**; reach for inheritance only when you
   need runtime polymorphism through a base interface.
3. **Virtual dispatch costs**: vtable indirection, **branch misprediction** at
   megamorphic call sites, and — usually the biggest hit — an **inlining
   barrier** that loses downstream optimizations.
4. Use **static polymorphism (templates / CRTP)** on the hot path for
   zero-overhead, inlinable dispatch; reserve **`virtual`** for the cold path.
5. **DRY/KISS/YAGNI** keep abstractions honest; over-abstraction is a real
   hot-path cost.
6. **Data-oriented design** is the HFT counterpoint: organize by data layout
   (**SoA** over AoS) for the cache and the vectorizer, not by class diagram.
7. The senior skill is **judgment**: clean OO where code changes and isn't hot;
   DOD / value types / static dispatch where the loop is hot and the data large.

## Self-check

1. State each SOLID letter in one sentence and give a trading-system example of a
   violation and its fix.
2. Why is composition usually preferable to inheritance? Name two concrete
   problems deep inheritance hierarchies cause.
3. Break down the cost of a virtual call into its components. Which component is
   usually the most damaging in a hot loop, and why?
4. When is dynamic (`virtual`) polymorphism the right choice, and when should you
   use CRTP instead? Give the hot-path/cold-path rule.
5. Explain AoS vs SoA. For a loop that sums only the `price` field of a million
   orders, which layout wins and why (in cache terms)?
6. What is the core tension between classic OO and data-oriented design, and how
   do you decide which to apply where?

## Further reading

- [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines)
  — especially the C (classes), I (interfaces), and ES sections; "prefer
  composition," "make base interfaces explicit."
- Robert C. Martin, *Clean Architecture* / *Agile Software Development* — the
  origin and full treatment of the **SOLID** principles.
- [SOLID — Wikipedia](https://en.wikipedia.org/wiki/SOLID) and
  [Data-oriented design — Wikipedia](https://en.wikipedia.org/wiki/Data-oriented_design).
- Scott Meyers, *Effective C++* — Items 32–40 (inheritance, OO design) and the
  guidance to prefer composition; *More Effective C++* on virtual dispatch costs.
- [Curiously Recurring Template Pattern — cppreference](https://en.cppreference.com/w/cpp/language/crtp)
  — static polymorphism for the hot path.
- [`virtual` function specifier — cppreference](https://en.cppreference.com/w/cpp/language/virtual)
  — the mechanics behind the vtable.

## Videos

- Mike Acton, CppCon **"Data-Oriented Design and C++"** — the canonical DOD talk
  ([search](https://www.youtube.com/results?search_query=Mike+Acton+data+oriented+design+and+c%2B%2B+cppcon)).
- Tony Van Eerd / various, CppCon talks on **SOLID and clean C++ design**
  ([search](https://www.youtube.com/results?search_query=CppCon+SOLID+principles+C%2B%2B+design)).
- CppCon — **inheritance vs composition / "Inheritance Is The Base Class of
  Evil"** (Sean Parent)
  ([search](https://www.youtube.com/results?search_query=Sean+Parent+inheritance+is+the+base+class+of+evil)).
