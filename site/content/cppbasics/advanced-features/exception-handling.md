# Exception Handling

> **Why a quant dev must own this:** Exceptions are the standard library's
> error-reporting mechanism — `std::vector` throws, `std::stoi` throws, `new`
> throws. But the modern HFT answer is usually "not on the hot path": the
> *throw* path has unbounded, unpredictable latency, and even the *no-throw*
> path inflates code size and pressures the instruction cache. You must be able
> to explain the **zero-cost model** (why `try` is free until something throws),
> *why* a throw is nonetheless catastrophic for tail latency, and what you reach
> for instead (`std::expected`, error codes). This is a classic "do you really
> understand the machine?" interview topic.

## First principles: separating the error path from the happy path

An exception transfers control from the point an error is detected to a handler
that knows how to deal with it, *unwinding* every stack frame in between and
running their destructors as it goes. The design goal: keep error-handling code
out of the normal control flow so the common path reads cleanly, and make it
impossible to *ignore* an error (unlike a return code you can forget to check).

```cpp
#include <stdexcept>
#include <vector>

double price_at(const std::vector<double>& book, std::size_t i) {
    if (i >= book.size())
        throw std::out_of_range("index past top of book");   // detected here
    return book[i];
}

int main() {
    std::vector<double> book{100.1, 100.2};
    try {
        double p = price_at(book, 99);     // throws
        // ... never reached ...
    } catch (const std::out_of_range& e) { // handled here
        std::fprintf(stderr, "bad index: %s\n", e.what());
    }
}
```

`throw` constructs an **exception object** (here a `std::out_of_range`), copies
or moves it into runtime-managed storage, and then the runtime searches up the
call stack for a `catch` whose type matches. Always **throw by value, catch by
`const` reference** — catching by value slices polymorphic exception types.

## Stack unwinding and RAII

Between the `throw` and the matching `catch`, the runtime **unwinds** the stack:
it walks back through each frame and runs the destructors of all fully
constructed automatic objects. This is the entire reason **RAII** and exceptions
are co-designed — if every resource (memory, lock, file, socket) is owned by an
object whose destructor releases it, unwinding cleans up *automatically* and
*correctly*, with no `goto fail` ladder.

```cpp
void process(Connection& c) {
    std::lock_guard<std::mutex> lk(c.mtx);   // ctor locks
    auto buf = std::make_unique<char[]>(4096);
    parse(buf.get());                         // if this throws...
    // ...lk's and buf's destructors STILL run during unwinding:
    //    the mutex is unlocked and the buffer freed. No leak.
}
```

A raw `new`/`delete` or `malloc`/`free` pair across a possibly-throwing call is
a leak waiting to happen. **Never write naked owning pointers in
exception-aware code** — wrap them in RAII (`unique_ptr`, `lock_guard`,
`fstream`, …).

### `catch(...)`, rethrow, and `std::current_exception`

```cpp
try {
    risky();
} catch (const std::exception& e) {
    log(e.what());
    throw;                  // RE-THROW the *same* object, preserving its type
} catch (...) {             // catch-all: matches ANY exception, even non-std
    log("unknown failure");
    throw;                  // rethrow so an outer handler can still see it
}
```

- `throw;` (no operand) **rethrows the currently handled exception** unchanged —
  use it to log-and-propagate without slicing. `throw e;` would copy and
  potentially slice.
- `catch(...)` matches everything; you can't inspect the object directly, but
  `std::current_exception()` captures it into an `std::exception_ptr` you can
  store, move across threads, and later `std::rethrow_exception`.

### A destructor must not throw

If a destructor throws *during* unwinding, the runtime is already handling one
exception and cannot handle a second — it calls `std::terminate`. Since C++11
destructors are **implicitly `noexcept`**. The rule: destructors release
resources and never let an exception escape.

## Exception-safety guarantees

When you write a function that can throw, you owe the caller a contract about
what state things are left in. The standard vocabulary (Abrahams guarantees):

| Guarantee | Promise on exception |
|---|---|
| **No-throw** (`noexcept`) | Never throws. Operation always succeeds. |
| **Strong** | Commit-or-rollback: state is *exactly* as before the call. |
| **Basic** | No leaks, all invariants intact, but state may have changed. |
| **None** | Anything goes (leaks, corruption) — unacceptable. |

The classic strong-guarantee technique is **copy-and-swap**: do all the
throwing work on a copy, then swap it into place with a `noexcept` swap (the
swap is the single non-throwing commit point).

```cpp
Book& Book::operator=(Book other) {   // by value: the copy may throw, that's fine
    swap(*this, other);               // noexcept swap = the commit point
    return *this;                     // strong guarantee
}
```

## `noexcept` — promise, ABI effect, and the `terminate` trap

`noexcept` declares that a function will not let an exception escape. It is part
of the function's type and changes code generation:

```cpp
double dot(const double* a, const double* b, std::size_t n) noexcept;  // promise
```

- **It does NOT mean "no exceptions thrown inside."** It means none *escape*. If
  one tries to escape a `noexcept` function, the runtime calls
  **`std::terminate`** immediately — no unwinding past the boundary, no chance to
  catch it higher up. So `noexcept` is a hard promise; break it and the process
  dies.
- **ABI effect:** a `noexcept` function can omit the unwinding machinery at its
  boundary, and — more importantly — it lets *callers* skip generating cleanup
  paths around the call, shrinking code. You can query it: `noexcept(expr)` is a
  compile-time `bool`.

### Why `noexcept` move operations unlock `std::vector` optimizations

This is the single most practically important consequence and a guaranteed
interview question. When `std::vector` reallocates (grows), it must move its
elements to the new buffer. If an element's move constructor could throw
*halfway through*, the vector couldn't restore its strong guarantee — so it
falls back to **copying** (slow) instead of moving. It checks
`std::is_nothrow_move_constructible` via `std::move_if_noexcept`:

```cpp
struct Order {
    std::string sym;
    Order(Order&&) noexcept = default;     // <-- this `noexcept` matters
};
// Without `noexcept` on the move ctor, vector<Order> COPIES on every grow.
```

> **Rule:** mark your move constructor and move assignment `noexcept`. A missing
> `noexcept` silently turns vector growth from O(n) moves into O(n) *copies* —
> exactly the kind of hidden 10x you get grilled on.

## The zero-cost exception model (Itanium C++ ABI)

Modern GCC/Clang on Linux/macOS implement **table-driven, "zero-cost"**
exceptions (the Itanium C++ ABI). The key property is asymmetry:

- **Happy path: genuinely zero runtime cost.** Entering a `try` block, having
  destructors registered, calling a function that *might* throw — none of this
  emits any extra instructions on the path where nothing throws. There is no
  per-`try` setup, no flag to push/pop. The information about "which destructors
  to run if an exception passes through here" lives in **static side tables**
  (`.gcc_except_table`, the LSDA / Language-Specific Data Area), not in code.
- **Throw path: expensive and unpredictable.** When `throw` fires, the runtime
  (`__cxa_throw`) allocates the exception object, then the **personality
  routine** (`__gxx_personality_v0`) parses those tables, unwinds frame by
  frame, runs destructors, and matches the handler. This involves table lookups,
  indirect calls, and is *orders of magnitude* slower than a normal return —
  often hundreds of nanoseconds to microseconds, and **variable**.

```x86asm
; A function that may throw, compiled with the zero-cost model.
; The HAPPY path is just the call — no exception bookkeeping inline:
_Z7price_atRKSt6vectorIdSaIdEEm:
        ...
        call    _ZNKSt6vectorIdSaIdEEixEm   ; vector::operator[]
        ret                                  ; <-- normal return, NOTHING extra
; The unwinding logic lives entirely in .gcc_except_table (LSDA), referenced
; by the unwinder ONLY when an exception is in flight. Zero cost until thrown.
```

The older "setjmp/longjmp" model *did* tax the happy path (registering frames at
runtime); the Itanium model deliberately moves all cost onto the throw. That
trade — *free until thrown, then very expensive* — is exactly why exceptions are
fine for genuinely exceptional errors and poison for control flow.

### Cost summary

| Path | Cost |
|---|---|
| Enter/exit a `try` block, no throw | **Zero** (no instructions emitted) |
| Normal return through a frame with destructors | Same as without exceptions |
| `throw` → unwind → `catch` | **High & variable**: alloc + table walk + dtors |
| Code size | Larger: every call site needs unwind tables / cleanup landing pads |

## Why exceptions are often banned on the HFT hot path

Even with zero happy-path cost, trading shops frequently compile the latency-
critical path with **`-fno-exceptions`**:

- **Tail latency.** A single thrown exception can cost microseconds and the cost
  is *unpredictable* (table walks, possible heap allocation of the exception
  object, possible lock in the runtime). On a path budgeted in *nanoseconds*,
  one throw blows the entire latency distribution's tail. HFT optimizes the
  99.9th percentile, and exceptions wreck it.
- **Code size / I-cache.** Landing pads and cleanup code bloat the binary and
  evict hot instructions from the L1 I-cache, slowing the path even when nothing
  throws.
- **Inlining & optimization barriers.** Possibly-throwing calls can inhibit some
  optimizations and force the compiler to keep cleanup paths around.
- **Determinism.** `-fno-exceptions` makes a throw a hard compile/link error,
  forcing an error-code discipline and guaranteeing no surprise unwinds.

So the idiom is: **exceptions at the boundary** (startup, config parsing,
order-entry validation off the hot path) are fine; **the steady-state
tick-to-trade loop is exception-free** by construction.

## Alternatives to exceptions

```cpp
#include <expected>     // C++23
#include <optional>     // C++17
#include <system_error>

// C++23 std::expected — value OR error, no heap, no unwinding, branch-predictable:
std::expected<Price, ParseError> parse_price(std::string_view s) noexcept;

auto r = parse_price(field);
if (!r) { handle(r.error()); return; }      // explicit, in-line, cheap branch
use(*r);

// std::optional — when "no value" needs no reason attached:
std::optional<Order> find_order(OrderId id) noexcept;

// std::error_code / std::error_condition — the standard "C-style code, typed":
std::error_code ec;
auto n = read(fd, buf, len, ec);
if (ec) { /* handle */ }
```

| Mechanism | Heap? | Hot-path-friendly? | Notes |
|---|---|---|---|
| Exceptions | maybe (exc. object) | **No** (throw path) | great for truly exceptional errors |
| Error codes / `errno` | No | Yes | easy to ignore; manual propagation |
| `std::error_code` | No | Yes | typed, composable C++ error codes |
| `std::optional<T>` | No | Yes | "value or nothing", no reason |
| `std::expected<T,E>` (C++23) | No | **Yes** | value-or-error in the return type |

## Constructors, exceptions, and exception specifications history

- **Constructors should throw to report failure.** A constructor has no return
  value, so throwing is the *only* way to refuse to create a half-built object.
  If the constructor throws, the object never existed — but **already-constructed
  members and bases are destroyed** during unwinding. This is why RAII members
  make exception-safe construction nearly automatic.
- **Exception specifications history.** C++98's dynamic `throw(TypeList)`
  specifications (and `throw()` for "throws nothing") were a mistake — they were
  checked at *runtime* (calling `std::unexpected`/`std::terminate` on violation),
  hurt optimization, and were **deprecated in C++11 and removed in C++17**. The
  modern replacement is the binary, compile-time-friendly **`noexcept`**. Treat
  `throw()` as legacy spelling of `noexcept`; never write new dynamic specs.

## Quant/HFT relevance & interview gotchas

- **"Are exceptions zero-cost?"** Correct answer: *zero on the happy path, very
  expensive and unpredictable on the throw path* (Itanium table-driven model).
  Saying just "yes, zero-cost" without the asymmetry is the trap.
- **Mark moves `noexcept`** or `std::vector` copies instead of moves on
  reallocation — name `std::move_if_noexcept`. Top-asked, high-impact.
- **`noexcept` ⇒ `std::terminate` on escape.** It is a promise enforced by
  killing the process, not by catching. Don't slap `noexcept` on something that
  can throw.
- **`-fno-exceptions` on the hot path**, exceptions at the boundary. Be ready to
  justify the latency-tail and I-cache arguments.
- **`std::expected` (C++23)** is the modern, branch-predictable, allocation-free
  way to carry errors through a hot path — know it exists and how it differs from
  exceptions and `optional`.
- **Throw by value, catch by `const&`, rethrow with bare `throw;`.** Catching by
  value slices; `throw e;` re-copies. Destructors are `noexcept` — never throw
  from one.
- **Strong vs basic guarantee + copy-and-swap** is the canonical exception-safety
  question for `operator=`.

## Key takeaways

1. An exception unwinds the stack to a matching `catch`, running every automatic
   object's destructor on the way — which is why **RAII** is mandatory for
   leak-free error handling.
2. The **zero-cost (Itanium) model** makes the no-throw path free (cost lives in
   static unwind tables) but makes the **throw path expensive and
   unpredictable** — fine for rare errors, fatal for control flow.
3. **`noexcept`** is a hard promise: an escaping exception calls
   `std::terminate`. It shrinks caller code and, critically, **enables move (not
   copy) on `std::vector` growth** via `std::move_if_noexcept`.
4. Exception-safety guarantees are **no-throw / strong / basic / none**;
   copy-and-swap is the standard route to the strong guarantee.
5. HFT typically uses **`-fno-exceptions` on the hot path** and reaches for
   **error codes / `std::optional` / `std::expected` (C++23)** — allocation-free,
   branch-predictable error reporting — reserving exceptions for the boundary.
6. Dynamic exception specifications (`throw(...)`) are removed; **`noexcept`** is
   the only modern spelling. Constructors throw to report failure;
   destructors never throw.

## Self-check

1. In the zero-cost model, what is the runtime cost of *entering* a `try` block
   when nothing throws? Where does the cost actually live?
2. Why does a *missing* `noexcept` on a move constructor make `std::vector`
   slower, and which standard utility decides this?
3. What happens if an exception tries to escape a `noexcept` function? Why can't
   you catch it at an outer scope?
4. Explain the strong vs basic exception-safety guarantee, and sketch
   copy-and-swap for `operator=`.
5. Give two concrete reasons exceptions are banned on an HFT hot path, and name
   the C++23 alternative for value-or-error returns.
6. Why must destructors not throw, and what does the runtime do if one throws
   during unwinding?

## Further reading

- [`throw` / `try`-`catch` — cppreference](https://en.cppreference.com/w/cpp/language/throw) and [exceptions overview](https://en.cppreference.com/w/cpp/language/exceptions).
- [`noexcept` specifier — cppreference](https://en.cppreference.com/w/cpp/language/noexcept_spec) and [`noexcept` operator](https://en.cppreference.com/w/cpp/language/noexcept).
- [Itanium C++ ABI — Exception Handling](https://itanium-cxx-abi.github.io/cxx-abi/abi-eh.html) — the canonical zero-cost / LSDA / personality-routine spec.
- [`std::expected` — cppreference](https://en.cppreference.com/w/cpp/utility/expected) and [`std::move_if_noexcept` — cppreference](https://en.cppreference.com/w/cpp/utility/move_if_noexcept).
- Scott Meyers, *Effective Modern C++*, **Item 14: Declare functions `noexcept` if they won't emit exceptions.**
- [C++ Core Guidelines — Error handling (E.*)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-errors).
- David Abrahams — ["Exception-Safety in Generic Components"](https://www.boost.org/community/exception_safety.html) — origin of the no-throw/strong/basic vocabulary.

## Videos

- Ben Saks (CppCon) — **"Back to Basics: Exception Handling and Exception Safety"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Exception+Handling+and+Exception+Safety)).
- Carl Cook (CppCon) — **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+When+a+Microsecond+Is+an+Eternity)) — why the hot path avoids exceptions.
- Khalil Estell (CppCon) — **"The Validity of C++ Exception Handling on Cost-Constrained Devices"** / cost of exceptions ([search](https://www.youtube.com/results?search_query=CppCon+Khalil+Estell+C%2B%2B+exceptions+cost)).
