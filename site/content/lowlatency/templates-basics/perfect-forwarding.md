# Perfect Forwarding

> **Why a quant dev must own this:** Perfect forwarding is the mechanism that
> lets a generic wrapper pass arguments through to an inner call **without
> changing their value category** — an rvalue stays movable, an lvalue stays an
> lvalue, `const` stays `const`. Get it wrong and your "zero-overhead" wrapper
> silently copies a fat order or an `std::string` on every call, or it
> moves-from an object the caller still owns. `emplace_back`, `make_unique`,
> `std::invoke`, every factory and every thread-launch helper rides on this. It
> is *the* C++ template interview question — expect to derive reference
> collapsing on the whiteboard.

(Standard: **C++11** introduced forwarding references and `std::forward`; the
examples compile as **C++17** and note C++20 where relevant.)

## The problem: a wrapper that doesn't ruin its arguments

You want a single function template `wrapper(args...)` that forwards to
`target(args...)` such that the call behaves *exactly* as if the caller had
invoked `target` directly. "Exactly" means value categories survive: a movable
temporary must arrive at `target` still movable; an lvalue must arrive as an
lvalue.

Naive attempts each fail:

```cpp
template <class T> void wrapper(T  v) { target(v); }   // copies on the way in
template <class T> void wrapper(T& v) { target(v); }   // can't bind to rvalues / const
template <class T> void wrapper(const T& v) { target(v); } // everything becomes const lvalue
```

The by-value version copies. The `T&` version won't accept `wrapper(42)` or a
`const` object. The `const T&` version accepts everything but **flattens** it —
`target` can never move from the argument, even when the caller passed a
temporary that is safe to move. None of them are "perfect".

## Forwarding (universal) references — `T&&` on a deduced `T`

The fix is a parameter of the form `T&&` **where `T` is a template parameter
being deduced** (or `auto&&`). This is *not* an rvalue reference — Scott Meyers
named it a **forwarding reference** (the standard calls it a forwarding
reference too) precisely to stop people confusing it with `int&&`.

```cpp
template <class T>
void wrapper(T&& arg);   // forwarding reference: binds to BOTH lvalues and rvalues
```

The defining behavior is in deduction (see *Templates & Type Deduction*, Case 2):

```cpp
int i = 0;
wrapper(i);     // i is an lvalue -> T = int&,  arg type = int&   (collapses below)
wrapper(42);    // 42 is an rvalue -> T = int,   arg type = int&&
```

**An lvalue argument makes `T` deduce to an lvalue reference type.** That single
fact, combined with reference collapsing, is the entire trick.

> **It is only a forwarding reference under exact conditions.** The form must be
> `T&&` with `T` *deduced for this call*. These are **not** forwarding
> references:
>
> ```cpp
> template <class T> void f(std::vector<T>&& v);  // rvalue ref — T isn't the whole param
> template <class T> void f(const T&& v);          // rvalue ref — const kills it
> void g(int&& x);                                  // not deduced at all
> template <class T> struct S { void h(T&& x); };   // T is the class's param, fixed by the
>                                                   // time h is called -> rvalue ref, NOT forwarding
> ```

## Reference collapsing — the rule that makes it work

You cannot write a reference to a reference in source code, but *deduction and
typedefs can produce one*. When they do, the language **collapses** it by a
simple rule:

```text
T&  &   ->  T&
T&  &&  ->  T&
T&& &   ->  T&
T&& &&  ->  T&&
```

**Mnemonic: an lvalue reference is "contagious" — if either side is `&`, the
result is `&`. Only `&& &&` stays `&&`.**

Now trace `wrapper(i)` where `i` is an lvalue: `T` deduces to `int&`, so the
parameter `T&&` is `int& &&`, which collapses to `int&`. The lvalue-ness is
preserved. Trace `wrapper(42)`: `T = int`, parameter is `int&&`, an rvalue
reference. Both cases land exactly where the caller's value category was.

## `std::forward` — conditional cast back to the original category

Inside `wrapper`, the parameter `arg` is a *named variable*, and **a named
variable is an lvalue** regardless of its type. If we just wrote `target(arg)`,
we'd pass an lvalue every time — losing the rvalue-ness of `wrapper(42)`.
`std::forward<T>` restores it: it casts `arg` back to an rvalue **iff** `T`
indicates the original argument was an rvalue.

```cpp
template <class T>
void wrapper(T&& arg) {
    target(std::forward<T>(arg));   // lvalue stays lvalue; rvalue restored to rvalue
}
```

`std::forward` is, in essence, a *conditional* `static_cast` keyed on `T`:

```cpp
// Simplified std::forward (real one has two overloads + remove_reference).
template <class T>
constexpr T&& forward(std::remove_reference_t<T>& a) noexcept {
    return static_cast<T&&>(a);   // T=int&  -> int& && -> int&  (lvalue: no-op cast)
}                                 // T=int   -> int&&            (rvalue: cast to xvalue)
```

When `T = int&` (caller passed an lvalue), `static_cast<int& &&>` collapses to
`static_cast<int&>` — a no-op. When `T = int` (caller passed an rvalue),
`static_cast<int&&>` turns the named lvalue back into an rvalue so the inner call
can move from it. **`std::forward` does nothing at runtime — it is a compile-time
cast** that vanishes in the generated code.

### `forward` vs `move`

- `std::move(x)` is an **unconditional** cast to rvalue — "I'm done with `x`,
  steal from it."
- `std::forward<T>(x)` is a **conditional** cast — "preserve whatever the caller
  gave me." It is *only* meaningful on a forwarding-reference parameter, where
  `T` carries the original category.

> **Rule of thumb:** `std::move` on rvalue references, `std::forward<T>` on
> forwarding references. Never `std::move` a forwarding-reference parameter you
> might be called with as an lvalue — you'd silently move from the caller's
> object.

## Forwarding a whole pack — the production pattern

Combine forwarding references with a variadic pack and you get the shape of
every factory in the standard library:

```cpp
template <class T, class... Args>
std::unique_ptr<T> make(Args&&... args) {
    return std::unique_ptr<T>(new T(std::forward<Args>(args)...));
    //                                ^ forward each element with its own Args_i
}
```

`std::forward<Args>(args)...` expands element-by-element, each cast keyed on its
own deduced `Args_i`. This is exactly how `std::make_unique`, `std::make_shared`,
`emplace_back`, and `std::thread`'s constructor pass their arguments.

## Why `emplace_back` exists — forwarding in the wild

`emplace_back` forwards its arguments straight into an in-place
constructor in the vector's storage. `push_back` takes a fully-built object.

```cpp
struct Order { Order(int id, double px); /* ... */ };
std::vector<Order> book;

book.push_back(Order{1, 100.5});   // build a temporary, then MOVE it into storage
book.emplace_back(1, 100.5);       // forward (1, 100.5) -> construct in place, no temporary
```

```text
push_back(Order{..})    : construct temp Order  -> move-construct into vector  (2 ctors)
emplace_back(1, 100.5)  : forward args          -> construct Order in place    (1 ctor)
```

For a type that's expensive to move (or move-only / non-movable), `emplace_back`
is strictly better. For a trivially-movable type the optimizer usually erases
the difference, but the *pattern* — perfect-forward the constructor args into
placement-new'd storage — is the whole reason `emplace*` exists.

## Common pitfalls

- **`const T&&` is not a forwarding reference.** Adding `const` (or any
  qualifier, or making it `std::vector<T>&&`) makes it a plain rvalue reference.
  Only bare `T&&` / `auto&&` on a deduced parameter forwards.
- **Member functions of a class template don't forward via the class's `T`.**
  In `template<class T> struct Wrap { void set(T&& x); }`, `T` is fixed by the
  time `set` is called, so `T&&` is an rvalue reference. To forward in a member,
  give the *method* its own template parameter: `template<class U> void set(U&&
  x){ ... std::forward<U>(x) ...; }`.
- **Forwarding constructors hijack the copy constructor.** A `template<class
  T> Widget(T&&)` is a *better match* than `Widget(const Widget&)` for a
  non-const `Widget` lvalue, so copying one `Widget` from another calls the
  template. Constrain it (C++20 `requires`/concepts, or SFINAE with
  `std::enable_if`) to exclude `Widget` itself.
- **Forwarding the same object twice is a use-after-move.**
  `f(std::forward<T>(x), std::forward<T>(x))` may move `x` into the first
  parameter, leaving the second with a moved-from husk. Forward each object once.
- **`std::forward` without the explicit `<T>`** is wrong / won't compile as
  intended — the template argument *is* the information about value category;
  it can't be deduced from the (always-lvalue) argument.
- **Braced initializers can't be forwarded** through a deduced parameter —
  `make<T>({1,2})` fails to deduce `Args` from `{1,2}` (same brace-deduction
  hole from the deduction lesson).

## Performance & hardware reality

Perfect forwarding is a **pure compile-time** construct. `std::forward` and
`std::move` are casts that generate **no instructions** — they change which
constructor/assignment overload is selected, not the runtime work. The payoff is
in *avoided copies*: forwarding a temporary `std::string` (a heap allocation +
memcpy of the buffer) into a move instead of a copy saves the allocation and the
copy entirely — easily tens to hundreds of nanoseconds for a non-trivial buffer,
and it removes an allocator round-trip you really don't want on a hot path. The
cast machinery itself is free; the savings are real.

## Quant/HFT relevance & interview gotchas

- **Derive reference collapsing live.** "Why does `T&&` bind to lvalues?" →
  lvalue makes `T = U&` → `U& &&` collapses to `U&`. This is the most common
  template interview question, full stop.
- **`move` vs `forward`** — unconditional vs conditional cast; when to use each;
  why `forward` needs the explicit `<T>`.
- **Explain `emplace_back` vs `push_back`** in terms of forwarding + placement
  construction, including when it does *not* matter (trivially movable types).
- **The forwarding-constructor / copy-constructor clash** is a great "have you
  shipped this?" signal — bonus points for the C++20 `requires` fix.
- **A named rvalue reference is an lvalue** — the reason `std::forward` (or
  `std::move`) is needed at all inside the function body.

## Key takeaways

1. A **forwarding reference** is `T&&` (or `auto&&`) where `T` is *deduced for
   this call* — it binds to lvalues and rvalues alike. `const T&&`,
   `std::vector<T>&&`, and a class-template member's `T&&` are **not**
   forwarding references.
2. **Reference collapsing** (`& &`/`& &&`/`&& &` → `&`; only `&& &&` → `&&`)
   plus the rule that *lvalues make `T` a reference* is the whole mechanism.
3. `std::forward<T>(x)` is a **conditional** cast that restores the caller's
   value category; `std::move(x)` is **unconditional**. Both compile to nothing.
4. Forward a **pack** with `std::forward<Args>(args)...`; this is the shape of
   `make_unique`, `emplace_back`, and `std::thread`.
5. Watch the classics: forwarding-ctor hijacking the copy-ctor, double-forwarding
   one object, and `const T&&` quietly not forwarding.

## Self-check

1. Walk through deduction and reference collapsing for `wrapper(i)` (lvalue) vs
   `wrapper(42)` (rvalue). What is `T` in each, and the final parameter type?
2. Why is a named parameter of type `int&&` an *lvalue* inside the function, and
   what does that imply about needing `std::forward`?
3. Is `template<class T> void f(const T&& x)` a forwarding reference? Why not?
4. Show how `template<class T> struct Box{ void put(T&&); }` fails to forward,
   and fix it.
5. Explain precisely why `emplace_back(id, px)` can construct one fewer object
   than `push_back(Order{id, px})`.
6. Why must a perfect-forwarding constructor be constrained, and what breaks if
   it isn't?

## Further reading

- [`std::forward` — cppreference](https://en.cppreference.com/w/cpp/utility/forward) and [`std::move` — cppreference](https://en.cppreference.com/w/cpp/utility/move)
- [Reference collapsing & forwarding references — cppreference](https://en.cppreference.com/w/cpp/language/reference#Reference_collapsing)
- Scott Meyers, *Effective Modern C++*, Items 23–30 (move, forward, forwarding references, reference collapsing, the forwarding-ctor trap) — the definitive treatment.
- Thomas Becker, ["C++ Rvalue References Explained"](http://thbecker.net/articles/rvalue_references/section_01.html) — the classic deep dive on collapsing and `std::forward`.
- [`std::vector::emplace_back` — cppreference](https://en.cppreference.com/w/cpp/container/vector/emplace_back).

## Videos

- CppCon — **"Back to Basics: Move Semantics"** (Klaus Iglberger) ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+Move+Semantics+Iglberger)) — covers forwarding references and `std::forward` carefully.
- CppCon — Scott Meyers, **"Universal References in C++11"** ([search](https://www.youtube.com/results?search_query=Scott+Meyers+Universal+References+in+C%2B%2B11)) — the talk that named and explained forwarding references.
