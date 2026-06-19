# Function Pointers, Functors, and Lambdas

> **Why a quant dev must own this:** Callbacks are everywhere in a trading
> stack — order-event handlers, comparators in a sorted book, strategy hooks
> behind a matching loop. *How* you pass that callable decides whether the
> compiler **inlines** it into a few instructions or leaves an **indirect call**
> the CPU must predict and may mispredict. The gap between a templated lambda and
> a `std::function` is real cycles in the hot path, and it's a favourite
> interview discriminator between "writes C++" and "writes *fast* C++".

## First principles: three ways to name "something callable"

C++ has three ways to pass behaviour as a value, with very different costs:

1. **Function pointer** — the address of a free function. One indirection per
   call; no state.
2. **Functor (function object)** — a class with `operator()`. Can carry state;
   crucially, its call target is *known at compile time* through its type, so it
   inlines.
3. **Lambda** — syntactic sugar the compiler turns into a unique functor class.
   Inlines like a functor; can capture state.

Plus `std::function`, a type-erased *wrapper* that can hold any of the above —
convenient, but with a runtime indirection (and possibly a heap allocation) that
the others avoid.

## Function pointers: syntax and calling convention

```cpp
int add(int a, int b) { return a + b; }

int (*fp)(int, int) = &add;        // declare; the & is optional
int (*fp2)(int, int) = add;        // function-to-pointer decay
int r = fp(2, 3);                   // call through the pointer -> 5
int r2 = (*fp)(2, 3);               // same; explicit deref optional

using BinOp = int (*)(int, int);    // a typedef/alias makes this readable
BinOp g = add;
```

Read the declaration right-to-left around the name: `fp` is a pointer to a
function taking `(int,int)` returning `int`. The mandatory parentheses around
`*fp` distinguish it from `int* fp(int,int)` (a function returning `int*`).

At the ABI level, calling through a function pointer is an **indirect call**:
the target address sits in a register/memory and the CPU executes `call rax`
rather than a `call` to a fixed label. That's the cost centre.

## Indirect call cost & branch prediction

A **direct** call jumps to a compile-time-known address — the front end knows
exactly what comes next, and the target can be **inlined** away entirely. An
**indirect** call jumps to a runtime address; the CPU's **indirect branch
predictor** (BTB) guesses the target. If it guesses right, the call is cheap; if
the target varies call-to-call (a "megamorphic" callsite hammered with different
function pointers), it **mispredicts** and stalls — on the order of ~15–20 cycles
of pipeline flush, plus you've already lost all inlining and the cross-function
optimizations it enables.

```x86asm
; direct call (inlinable):     call    add        ; fixed target, may inline
; indirect call (fn ptr):      call    rax        ; runtime target, predict+verify
```

The deeper loss is usually **not** the predicted indirect call itself but the
**inlining you forfeited**: a `+` that could have been one ALU op instead becomes
a call boundary with register spills and no constant-propagation across it.

## Functors inline because the type carries the target

A functor is an ordinary class whose `operator()` is called by the usual
overload rules. When you pass it as a **template parameter**, the call target is
encoded in the *type*, so the compiler resolves and inlines it — zero
indirection.

```cpp
struct Add {
    int operator()(int a, int b) const { return a + b; }   // call operator
};

template <class Op>
int apply(int a, int b, Op op) { return op(a, b); }   // op's type is known here

int x = apply(2, 3, Add{});   // Op == Add; op(a,b) inlines to a + b
```

Because `Op` is a concrete type known at instantiation, `op(a,b)` is a *direct*
call the optimizer flattens. Functors also carry state cheaply (member
variables), and comparators like `std::less<>` are functors precisely so that
`std::sort` inlines the comparison.

## Lambdas are compiler-generated functor classes

A lambda expression makes the compiler synthesize an anonymous class (its
**closure type**) with an `operator()` and one member per captured variable. It's
exactly the functor above, written tersely.

```cpp
auto add = [](int a, int b) { return a + b; };   // a closure object
int y = add(2, 3);                                // calls its operator()

// Conceptually equivalent to:
struct __lambda_42 {
    int operator()(int a, int b) const { return a + b; }
};
```

Each lambda has a **unique, unnamable type** (hence `auto`). Passed to a template,
it inlines just like `Add`. This is why "pass a lambda to `std::sort`/`for_each`"
is the idiomatic, zero-overhead callback.

### Captures: by value, by reference, init-capture

```cpp
int base = 100;

auto by_val = [base](int x) { return x + base; };       // copies base into the closure
auto by_ref = [&base](int x) { return x + base; };       // stores a reference (dangling risk!)
auto by_all_val = [=](int x) { return x + base; };        // capture everything used, by value
auto by_all_ref = [&](int x) { return x + base; };        // ... by reference
auto moved = [p = std::move(ptr)]() { return *p; };       // C++14 init-capture: move into closure
auto mut   = [n = 0]() mutable { return ++n; };           // mutable: operator() is non-const
```

- **By value** copies the captured object into a closure member; the call
  operator is `const` by default (use `mutable` to modify the copy).
- **By reference** stores a reference — fast and shares state, but the closure
  must not outlive the referent (a dangling-capture bug, common when a lambda is
  stored and called later).
- **Init-capture** (`[p = std::move(ptr)]`) lets you move-capture or compute a
  member — essential for capturing move-only types like `unique_ptr`.

> **HFT gotcha:** a `[&]` capture in a callback that's *stored* (in a queue, a
> `std::function`, a timer) is a landmine — the references dangle once the
> enclosing scope exits. For stored callbacks, capture by value or by owning
> handle.

### Stateless lambda → function pointer

A lambda with **no captures** is stateless and the standard says it is
*convertible to a plain function pointer* — useful for C APIs that take a
callback:

```cpp
auto cb = [](int sig) { /* handle */ };
void (*c_callback)(int) = cb;        // OK: captureless lambda -> function ptr
::signal(SIGINT, cb);                // pass to a C API expecting a fn pointer
```

A capturing lambda has state, so it has no such conversion — there's nowhere to
put the captured data in a bare function pointer.

## `std::function`: type erasure and its cost

`std::function<R(Args...)>` is a **type-erased** container that can hold *any*
callable with that signature — function pointer, functor, or lambda (capturing or
not). The price of that flexibility:

```cpp
#include <functional>
std::function<int(int,int)> f = add;                 // holds a fn ptr
f = [](int a, int b){ return a*b; };                  // ...now holds a lambda
int z = f(2, 3);                                       // INDIRECT call + type erasure
```

- **Indirection:** the call goes through an internal vtable-like dispatch — an
  indirect call the compiler **cannot inline** through. Same prediction risk as a
  function pointer.
- **Possible heap allocation:** the wrapped callable is stored in a small inline
  buffer (SBO); if the captured state is larger than that buffer,
  `std::function` **heap-allocates**. A `std::function` holding a fat lambda can
  silently `malloc`.
- **Copyability requirement:** the target must be copy-constructible (which
  excludes move-only captures unless wrapped — fixed by `std::move_only_function`
  in C++23).

Use `std::function` for *stored, heterogeneous* callbacks where the convenience
is worth it (plugin registries, event maps). **Avoid it in the hot path.**

## Template callable params: zero-overhead callbacks

When the callable is known at the callsite, pass it as a **template parameter** so
its concrete type — and thus inlining — is preserved end to end:

```cpp
template <class F>
void for_each_tick(const Tick* t, std::size_t n, F&& fn) {   // F deduced concretely
    for (std::size_t i = 0; i < n; ++i)
        fn(t[i]);                       // direct call; inlines fn's body
}

for_each_tick(ticks, n, [](const Tick& x){ /* update book */ });  // fully inlined
```

This is the **zero-overhead** path: no indirection, full inlining,
constant-propagation across the call. The cost is code bloat (one instantiation
per callable type) and that the type leaks into the signature — usually a fine
trade in performance-critical code. `std::invoke` (C++17) is the uniform way to
call any callable (function, member pointer, functor) inside such templates:

```cpp
#include <functional>
template <class F, class... A>
decltype(auto) call(F&& f, A&&... a) {
    return std::invoke(std::forward<F>(f), std::forward<A>(a)...);  // handles all callable kinds
}
```

## Inlining advantage, in assembly

```x86asm
; (1) templated lambda: apply(2,3, [](a,b){return a+b;})  -O2
;     the whole thing collapses to a constant — no call at all:
        mov     eax, 5
        ret

; (2) std::function<int(int,int)> f; ... f(2,3);   -O2
        mov     edi, OFFSET f          ; &f (the erased target)
        mov     esi, 2
        mov     edx, 3
        call    [QWORD PTR f.invoker]  ; INDIRECT call through the wrapper
        ; no inlining: add() body never seen here
```

(1) is what a comparator/handler passed as a template or lambda becomes; (2) is
the `std::function` reality — an indirect call the optimizer can't see through.

## Performance & hardware reality

| Mechanism | Call kind | Inlinable? | State | Hidden heap? |
|---|---|---|---|---|
| Function pointer | indirect | no | none | no |
| Functor (template arg) | direct | **yes** | members | no |
| Lambda (template arg) | direct | **yes** | captures | no |
| `std::function` | indirect | no | any | **possibly** |
| `virtual` call | indirect | no (usually) | object | no |

- **Inlining is the real prize** — it unlocks constant folding, dead-code
  elimination, and vectorization across the call. Indirect mechanisms forfeit
  all of it.
- **Megamorphic indirect callsites** mispredict and stall; monomorphic ones are
  cheap but still un-inlined.
- **`std::function`'s SBO threshold is implementation-defined** — a capture that
  fits today may spill to the heap after you add a field. Profile, don't assume.

## Quant/HFT relevance & interview gotchas

- **Hot-path rule: prefer templates/lambdas over `std::function`/`virtual`.**
  Keep the callable's type concrete so the matching loop inlines the handler.
- **`std::function` can `malloc`** when the captured state exceeds the small
  buffer — a stealth allocation in code that "looks" allocation-free.
- **Captureless lambdas convert to function pointers**; capturing ones don't —
  know why (nowhere to store state).
- **Dangling `[&]` captures** in stored/deferred callbacks are a top bug; capture
  by value or owning handle for anything that outlives the scope.
- **`virtual` vs template strategy:** for a fixed, known-at-compile-time strategy,
  a template (or CRTP) beats a virtual call — same indirection argument.
- **`std::invoke`** is the generic "just call it" that also handles member
  pointers — worth name-dropping for clean generic code.
- Be able to read the assembly: templated lambda → folded/inlined; `std::function`
  → indirect call.

## Key takeaways

1. Three callables: **function pointer** (indirect, stateless), **functor**
   (`operator()`, inlines, stateful), **lambda** (compiler-generated functor with
   captures).
2. **Direct calls inline; indirect calls don't** — and the lost inlining usually
   costs more than the indirect call itself. Indirect targets also risk
   **branch misprediction**.
3. A lambda is a unique **closure type**; captures become members. Capture
   **by value** (copy, `mutable` to mutate), **by reference** (dangling risk), or
   via **init-capture** (move-only).
4. A **captureless** lambda converts to a function pointer; a capturing one
   cannot.
5. **`std::function`** type-erases any callable but adds an **indirect call** and
   a **possible heap allocation** — convenient for stored callbacks, wrong for
   the hot path.
6. Pass callables as **template parameters** (and call via **`std::invoke`**) for
   zero-overhead, fully-inlined callbacks. In HFT, prefer templates/lambdas over
   `std::function`/`virtual` in hot paths.

## Self-check

1. Write the type of a pointer to a function taking `(double, int)` returning
   `bool`, and explain why the parentheses around `*` are required.
2. Why does a lambda passed to a function template inline, while the same lambda
   stored in a `std::function` does not?
3. Which captures convert a lambda into something that is *not* convertible to a
   plain function pointer, and why?
4. Under what condition does a `std::function` allocate on the heap? How would you
   detect it?
5. A stored callback uses `[&]`. Describe the bug and two ways to fix it.
6. Contrast a templated `F&& fn` parameter with a `std::function` parameter on
   inlining, indirection, code size, and ABI stability.

## Further reading

- [Lambda expressions](https://en.cppreference.com/w/cpp/language/lambda) — cppreference (closure type, captures, init-capture, conversion to function pointer).
- [`std::function`](https://en.cppreference.com/w/cpp/utility/functional/function) and [`std::move_only_function`](https://en.cppreference.com/w/cpp/utility/functional/move_only_function) (C++23) — cppreference.
- [Pointers to functions](https://en.cppreference.com/w/cpp/language/pointer#Pointers_to_functions) and [`std::invoke`](https://en.cppreference.com/w/cpp/utility/functional/invoke) — cppreference.
- Scott Meyers, *Effective Modern C++*, Items 31–34 (lambdas and captures).
- Agner Fog, [*Optimizing software in C++*](https://www.agner.org/optimize/) — indirect branches, the BTB, and inlining (and the microarchitecture manual on indirect-branch misprediction cost).
- C++ Core Guidelines — [F.50/F.51: when to use a lambda vs a function](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-functions).

## Videos

- CppCon 2017 — Carl Cook, **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+2017+Carl+Cook+When+a+Microsecond+Is+an+Eternity)) — argues directly for inlinable callbacks over `std::function`/virtual in the hot path.
- CppCon 2019 — Eduardo Madrid & Scott Bruce / talks on **type erasure and `std::function` cost** ([search](https://www.youtube.com/results?search_query=CppCon+std%3A%3Afunction+type+erasure+cost)).
- CppCon 2015 — Bjarne Stroustrup-era material aside, see **"Demystifying C++ lambdas"** style talks ([search](https://www.youtube.com/results?search_query=CppCon+demystifying+C%2B%2B+lambdas)).
