# Storage and Attributes

> **Why a quant dev must own this:** *Where* an object lives and *how long* it
> lives decide its access cost — a `thread_local` lookup is not free, a hot-path
> branch hint can save a misprediction, and a misaligned struct splits a cache
> line. Storage duration, linkage, and the C++ attribute vocabulary
> (`[[likely]]`, `[[nodiscard]]`, `alignas`) are the levers you pull to make the
> compiler emit the code you actually want — and they come up constantly once an
> HFT interview moves past syntax into "what does this cost?"

## First principles: lifetime, location, and visibility

Three orthogonal questions hang on every object:

1. **Storage duration** — *when* is it alive (its lifetime)?
2. **Storage-class specifier / location** — *where* does it live (stack, static
   area, TLS, heap) and *who controls* its lifetime?
3. **Linkage** — *across what scope is its name visible* to the linker?

These are independent and routinely confused. A variable can be `static`
(internal linkage) yet have automatic-looking syntax; a `thread_local` has
thread storage duration but can have external linkage. Untangling them is the
whole topic.

## Storage durations

| Duration | Lifetime | Lives in | Created by |
|---|---|---|---|
| **automatic** | enclosing block/scope | stack (registers) | ordinary local variables |
| **static** | whole program run | static/BSS/data segment | namespace-scope vars, `static` locals/members |
| **thread** | the thread's lifetime | thread-local storage (TLS) | `thread_local` variables |
| **dynamic** | until you `delete`/free it | heap | `new`, `malloc`, allocators |

- **Automatic** objects are born when control enters their scope and die at scope
  exit — allocation is just a stack-pointer adjustment, effectively free. This is
  where you want hot data.
- **Static** objects exist for the entire program; they're zero-initialized at
  load, then (possibly) dynamically initialized. One instance shared by all.
- **Thread** objects get one instance *per thread*; born at thread start (or
  first use), destroyed at thread exit.
- **Dynamic** objects you manage explicitly (ideally via RAII /
  `unique_ptr`/`shared_ptr`); allocation can cost hundreds of nanoseconds and is
  banned from many hot paths.

## Storage-class specifiers

These keywords choose duration and/or linkage:

```cpp
static int  g_count = 0;     // at namespace scope: STATIC duration + INTERNAL linkage
extern int  g_shared;        // declares a STATIC-duration var defined elsewhere
thread_local int  t_id;      // THREAD duration; one per thread

void f() {
    static int calls = 0;    // inside a function: STATIC duration, no linkage;
    ++calls;                 // initialized once, on first pass (thread-safe since C++11)
}

struct S {
    mutable int cache;       // 'mutable': may be modified even via a const S
    int compute() const { cache = 42; return cache; }  // legal because of mutable
};
```

- **`static`** is overloaded: at *namespace* scope it means **internal linkage**
  (the name is private to this TU); inside a *function* it means **static
  duration** with no linkage; on a *class member* it means one shared instance.
- **`extern`** declares (doesn't define) a static-duration variable with
  **external linkage** defined in another TU — the header-side counterpart of a
  global.
- **`thread_local`** gives thread storage duration.
- **`register`** (a hint to keep a variable in a register) was **deprecated in
  C++11 and removed in C++17** — the keyword is now reserved and does nothing;
  the optimizer allocates registers far better than you can hint.
- **`mutable`** lets a data member be modified through a `const` object — the
  sanctioned escape hatch for *logical* constness (caches, mutexes, lazy fields)
  that doesn't affect the object's observable value.

## Linkage

Linkage controls whether a name refers to the same entity across translation
units:

| Linkage | Meaning | How to get it |
|---|---|---|
| **external** | one entity, visible to all TUs | namespace-scope non-`static` / non-`const` vars; ordinary functions |
| **internal** | private to this TU | `static` at namespace scope; **anonymous namespace**; namespace-scope `const` (by default) |
| **none** | not visible to the linker at all | locals, function params |

```cpp
namespace {                 // anonymous namespace => internal linkage (preferred over file-static)
    int helper_table[256];  // private to this TU; no symbol leaks out
}
```

The modern idiom for "TU-private" globals/functions is the **anonymous
namespace**, not file-`static` — it works for types too and is the C++ Core
Guidelines recommendation. Internal linkage is also an optimization gift: the
compiler knows nothing outside the TU can observe the symbol, so it can inline or
discard it freely.

## `inline` variables (C++17)

Before C++17 you couldn't define a variable in a header without multiple-
definition link errors — you used the `extern`-in-header / define-in-one-`.cpp`
dance, or a function-returning-static. **`inline` variables** fix this: like
inline functions, multiple identical definitions across TUs collapse to one
entity.

```cpp
// config.hpp — header-only, no .cpp needed
inline constexpr int  kMaxOrders   = 1 << 20;   // constexpr is implicitly inline-able
inline           Registry g_registry;           // ONE shared instance, defined in a header
```

This is what makes modern header-only libraries and `inline constexpr`
configuration constants possible. (`static constexpr` class members are
implicitly `inline` since C++17 too.)

## Attributes: telling the compiler your intent

Attributes (`[[...]]`, standardized since C++11) annotate code with semantic
intent the compiler can check or exploit. The portable, standard ones:

```cpp
[[nodiscard]] int send_order(const Order&);   // ignoring the return is a warning
[[noreturn]] void fatal(const char* msg);     // never returns; aids flow analysis

int parse(int code) {
    switch (code) {
        case 1:
            do_a();
            [[fallthrough]];          // "yes, I meant to fall through" (silences -Wimplicit-fallthrough)
        case 2:
            return do_b();
        [[likely]] case 0:            // C++20: hint this case is the common one
            return 0;
    }
    [[maybe_unused]] int debug_only = compute();  // no -Wunused warning in release
    return -1;
}
```

- **`[[nodiscard]]`** — warns if the caller ignores the return value. Put it on
  **error codes**, factory functions, and anything whose result must be checked.
  In HFT this is your compile-time guard against a dropped error status in the
  order path. C++20 lets you attach a reason string: `[[nodiscard("check the
  ack")]]`.
- **`[[noreturn]]`** — promises the function never returns (it `exit`s, throws,
  or loops forever), letting the optimizer drop dead code after the call and
  improve liveness analysis.
- **`[[maybe_unused]]`** — suppresses unused-variable/parameter warnings for
  things used only in some build configs (asserts, debug logging).
- **`[[fallthrough]]`** — documents an intentional `switch` fall-through so
  `-Wimplicit-fallthrough` stays useful for the *accidental* ones.

## Branch hints: `[[likely]]` / `[[unlikely]]` (C++20)

These mark the expected path so the compiler lays out code to keep the hot path
straight-line and falling-through (no taken branch), shoving the cold path out of
line:

```cpp
int risk_check(const Order& o) {
    if (o.qty > limit) [[unlikely]] {     // rare: reject path pushed out of line
        return reject(o);
    }
    return accept(o);                     // common path stays hot & contiguous
}
```

The win is twofold: better **branch-predictor** behavior on first encounter and
tighter **instruction-cache** locality (the cold reject code isn't sitting in
the hot loop's cache lines). Use them **only where you have measured/known
skew** — a wrong hint pessimizes the path you actually take. This is a textbook
HFT micro-optimization for hot dispatch and risk gates.

## Compiler-specific power tools

The standard attributes are intentionally conservative; for the last few
percent, GCC/Clang expose vendor attributes via the `[[gnu::...]]` spelling:

```cpp
[[gnu::always_inline]] inline int fast_add(int a, int b) { return a + b; }
[[gnu::hot]]  void on_market_data(const Tick&);   // optimize aggressively; group hot code
[[gnu::cold]] void log_error(const char*);        // rarely called; optimize for size, move away
```

- **`always_inline`** *forces* inlining even at `-O0`/when the heuristics say no —
  use sparingly for tiny hot helpers (it's a request the compiler honors, unlike
  the mere `inline` keyword which only affects linkage/ODR).
- **`hot`** / **`cold`** influence code placement and optimization weighting: hot
  functions are grouped together (better I-cache), cold ones are moved away and
  optimized for size. They also implicitly bias surrounding branch prediction.

These are non-portable; gate them behind a macro if you support MSVC
(`__forceinline`, `__declspec`).

## Alignment: `alignas` and `alignof`

Alignment is the requirement that an object's address be a multiple of some power
of two. It's a correctness *and* performance lever:

```cpp
alignas(64) struct alignas(64) PerCore {   // pad to a full 64-byte cache line
    std::atomic<std::uint64_t> seq;
    char pad[64 - sizeof(std::atomic<std::uint64_t>)];
};
static_assert(alignof(PerCore) == 64);

std::cout << alignof(double);   // queries the required alignment (typically 8)
```

The dominant HFT use is **avoiding false sharing**: two atomics that different
threads hammer must not share a 64-byte cache line, or every write by one core
invalidates the line in the other's cache (cache-line ping-pong). Padding each to
its own line with `alignas(64)` (or C++17's `std::hardware_destructive_interference_size`)
eliminates it. Over-aligning also enables aligned SIMD loads. The cost is wasted
space — alignment trades memory for speed, so apply it deliberately.

## A glimpse of the machine

```cpp
// C++20. g++ -O2 -S -masm=intel
int dispatch(int x) {
    if (x == 0) [[unlikely]] return slow(x);
    return x + 1;
}
```

```x86asm
dispatch(int):
        test    edi, edi
        je      .Lcold          ; the equal (x==0) case JUMPS AWAY (cold)
        lea     eax, [rdi+1]     ; hot path falls straight through, no taken branch
        ret
.Lcold:
        jmp     slow(int)        ; cold code placed after the return
```

The `[[unlikely]]` made the compiler arrange the common path as fall-through and
exile the rare path past the `ret` — exactly the layout a hot loop wants.

## Performance & hardware reality

- **`thread_local` access is not a plain load.** Depending on the TLS model it
  may go through `__tls_get_addr` (a function call) or an indirection off the
  thread pointer (`%fs`-relative on x86-64). The fast `initial-exec`/`local-exec`
  models are a couple of instructions; the general dynamic model can cost a
  function call. **Keep `thread_local` off the innermost hot loop** — cache the
  pointer in a local once.
- **Static-duration function locals** pay a one-time guarded init (an acquire
  load of a guard byte on every call). `constinit`/`inline constexpr` avoid it.
- **Branch hints** are about predictor warm-up and I-cache layout; on a perfectly
  predicted branch the steady-state cost is ~0 either way, so the payoff is on
  cold/rare paths and first encounters.
- **Alignment vs false sharing** is often the single biggest win in multi-threaded
  hot code — a ping-ponging cache line can cost hundreds of cycles per access.

## Quant/HFT relevance & interview gotchas

- **"What does `static` mean?"** Trick question — *where?* Namespace scope =
  internal linkage; function scope = static duration; class member = shared
  instance. Nail all three.
- **"Cost of `thread_local`?"** Not free; TLS model determines whether it's an
  offset load or a function call. Cache the address.
- **"How do you stop false sharing?"** `alignas(64)` (or
  `hardware_destructive_interference_size`) to give each hot atomic its own cache
  line.
- **"Why `[[nodiscard]]` on error codes?"** Turns a silently-ignored failure
  return into a compile warning — cheap insurance in the order path.
- **"`[[likely]]`/`[[unlikely]]` — when?"** Only with measured skew; they bias
  code layout and prediction, not correctness, and a wrong hint hurts.
- **`register` is gone** (removed C++17); **anonymous namespace** beats
  file-`static`; `inline` variables (C++17) put shared globals in headers.

## Key takeaways

1. **Storage duration** (automatic/static/thread/dynamic), **storage class**, and
   **linkage** are independent axes — `static` overloads all three, so always ask
   *in what context*.
2. **Linkage**: external (shared across TUs), internal (`static` at file scope /
   anonymous namespace), none (locals). Prefer **anonymous namespaces** for
   TU-private symbols.
3. **`inline` variables (C++17)** let you define one shared variable in a header;
   `thread_local` gives one instance per thread (with a non-trivial access cost).
4. Use standard attributes for intent: **`[[nodiscard]]`** on must-check returns,
   **`[[noreturn]]`**, **`[[maybe_unused]]`**, **`[[fallthrough]]`**, and
   **`[[likely]]`/`[[unlikely]]`** (C++20) for measured branch skew.
5. **`[[gnu::always_inline]]`/`[[gnu::hot]]/[[gnu::cold]]`** are non-portable
   placement/inlining hammers for the hot path.
6. **`alignas`/`alignof`** control alignment; `alignas(64)` is the standard cure
   for **false sharing** between threads.

## Self-check

1. Give the three distinct meanings of `static` depending on where it appears.
2. What is the difference between storage duration and linkage? Give a variable
   that has thread storage duration *and* external linkage.
3. Why might a `thread_local` access cost more than reading a global, and what's
   the mitigation in a hot loop?
4. What problem do `inline` variables (C++17) solve, and what did people do
   before?
5. When should you use `[[unlikely]]`, and why can it backfire?
6. Explain false sharing and how `alignas(64)` fixes it.

## Further reading

- [Storage duration & linkage — cppreference](https://en.cppreference.com/w/cpp/language/storage_duration)
- [`thread_local` / storage class specifiers — cppreference](https://en.cppreference.com/w/cpp/keyword/thread_local)
- [Attribute specifier sequence (all standard attributes) — cppreference](https://en.cppreference.com/w/cpp/language/attributes)
- [`[[likely]]` / `[[unlikely]]`](https://en.cppreference.com/w/cpp/language/attributes/likely) · [`[[nodiscard]]`](https://en.cppreference.com/w/cpp/language/attributes/nodiscard) — cppreference
- [`alignas`](https://en.cppreference.com/w/cpp/language/alignas) · [`alignof`](https://en.cppreference.com/w/cpp/language/alignof) · [`std::hardware_destructive_interference_size`](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size) — cppreference
- [Ulrich Drepper, *ELF Handling for Thread-Local Storage*](https://www.akkadia.org/drepper/tls.pdf) — the definitive TLS-cost reference.
- [GCC: Common Function Attributes (`hot`, `cold`, `always_inline`)](https://gcc.gnu.org/onlinedocs/gcc/Common-Function-Attributes.html)
- [C++ Core Guidelines: SF.22 (anonymous namespaces) and the linkage rules](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#sf22-use-an-unnamed-namespace-for-all-internalnonexported-entities)

## Videos

- Timur Doumler, CppCon — **"What is the C++ memory model?" (false sharing / alignment)** ([search](https://www.youtube.com/results?search_query=CppCon+Timur+Doumler+C%2B%2B+memory+model)).
- Fedor Pikus, CppCon — **"The Speed of Concurrency / lock-free programming" (false sharing in practice)** ([search](https://www.youtube.com/results?search_query=CppCon+Fedor+Pikus+speed+of+concurrency)).
- CppCon — **"Back to Basics: The Abstract Machine / object lifetime"** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+object+lifetime)).
