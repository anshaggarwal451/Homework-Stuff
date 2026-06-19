# Type Deduction

> **Why a quant dev must own this:** `auto`, templates, and perfect-forwarding
> are everywhere in modern HFT code — `auto&& msg = queue.front();`,
> `std::forward<T>(x)`, generic lambdas in your hot path. If you can't say
> *exactly* what type the compiler deduced, you can't reason about copies,
> dangling references, or accidental `std::function` allocations. "What type is
> `T` here?" is the single most common modern-C++ whiteboard question.

## The one idea behind it all

There is essentially **one** set of deduction rules in C++, and `auto` reuses
them. Scott Meyers frames this as Items 1–4 of *Effective Modern C++*: master
template deduction (Item 1), and `auto` (Item 2) follows for free, with two
exceptions. So we start with the template.

```cpp
template <typename T>
void f(ParamType param);   // ParamType is some pattern built around T

f(expr);                   // compiler deduces T and ParamType from expr
```

Deduction looks at **two things at once**: the type of `expr`, and the *shape*
of `ParamType` (is it a value? a reference? a pointer? `T&&`?). The shape
decides which rules fire. There are three cases.

## Case 1: `ParamType` is a reference or pointer (but not `T&&`)

Rule: if `expr` is a reference, **ignore the reference part**; then
pattern-match `expr`'s type against `ParamType` to find `T`.

```cpp
template <typename T> void f(T& param);

int        x  = 27;
const int  cx = x;
const int& rx = x;

f(x);    // T = int,        param type = int&
f(cx);   // T = const int,  param type = const int&   (const is preserved)
f(rx);   // T = const int,  param type = const int&   (ref stripped, const kept)
```

The `const` survives because the reference doesn't strip qualifiers — only the
*reference-ness* of `expr` is discarded. With `const T&` the parameter is always
const, so `T` itself never picks up `const`:

```cpp
template <typename T> void f(const T& param);
f(cx);   // T = int,        param type = const int&
```

Pointers behave identically (`T*`, `const T*`).

## Case 2: `ParamType` is a universal (forwarding) reference `T&&`

This is the special one — the foundation of perfect forwarding (*EMC++* Item
24). When the parameter is `T&&` **and** `T` is being deduced:

- If `expr` is an **lvalue**, `T` is deduced as an **lvalue reference** (`T&`),
  and reference collapsing makes the parameter `T&`.
- If `expr` is an **rvalue**, the ordinary Case-1 rules apply and `T` is a
  non-reference, parameter `T&&`.

```cpp
template <typename T> void f(T&& param);   // universal reference

int       x  = 27;
const int cx = x;

f(x);    // x is lvalue  -> T = int&,        param = int&
f(cx);   // cx is lvalue -> T = const int&,  param = const int&
f(27);   // 27 is rvalue -> T = int,         param = int&&
```

`T&&` is the **only** context where the value category of `expr` (lvalue vs
rvalue) changes what `T` becomes. That is precisely why `std::forward<T>(x)`
can recover the original category.

### Reference collapsing — the mechanism

You can't write `int& &` in source, but the compiler forms such combinations
during deduction and *collapses* them. The rule: **`&` wins unless both are
`&&`.**

| You form        | Collapses to |
|-----------------|:------------:|
| `T&  &`         | `T&`         |
| `T&  &&`        | `T&`         |
| `T&& &`         | `T&`         |
| `T&& &&`        | `T&&`        |

So when `T = int&` and the parameter is `T&&`, you get `int& &&` → `int&`.

## Case 3: `ParamType` is taken by value (`T param`)

Now `param` is a **copy**, so it can't be `const`, can't be a reference. The
rules (*EMC++* Item 1, case 3):

1. If `expr` is a reference, ignore it.
2. After that, ignore `const` and `volatile` (top-level only).

```cpp
template <typename T> void f(T param);

const int  cx = 27;
const int& rx = cx;

f(cx);   // T = int   (top-level const dropped — you got your own copy)
f(rx);   // T = int   (ref + const both dropped)
```

The const is dropped because **constness of the source says nothing about
whether *your copy* may be modified.** But note: only *top-level* const goes.

```cpp
const char* const ptr = "hello";   // const pointer to const char
f(ptr);  // T = const char*  — the pointer's own const dropped,
         //                    but the pointed-to const char survives.
```

## Array and function decay (by-value only)

Arrays and functions **decay to pointers** when passed by value — a C
inheritance:

```cpp
template <typename T> void f(T  param);    // by value
template <typename T> void g(T& param);    // by reference

const char name[13] = "feed_handler";

f(name);   // T = const char*           (array decays to pointer)
g(name);   // T = const char (&)[13]    (no decay — size is preserved!)
```

Capturing the reference (Case 1) lets you recover the array size at compile
time — the idiom behind a safe `arraySize`:

```cpp
template <typename T, std::size_t N>
constexpr std::size_t arraySize(T (&)[N]) noexcept { return N; }   // C++14
```

Function types decay the same way: by value you get a function *pointer*, by
reference a reference to the function type.

## `auto` deduction == template deduction (with one twist)

`auto` plays the role of `T`, and the declared type plays the role of
`ParamType`. Everything above carries over (*EMC++* Item 2):

```cpp
auto         x  = 27;        // auto = int          (Case 3: by value)
const auto   cx = x;         // auto = int
const auto&  rx = x;         // auto = int          (Case 1: const T&)
auto&&       uref = x;       // auto = int&         (Case 2: lvalue -> T&)
auto&&       uref2 = 27;     // auto = int          (Case 2: rvalue)
```

`auto&&` is therefore a **universal reference** and the right way to write a
range-for or to bind to "whatever this expression yields" without a copy:

```cpp
for (auto&& msg : market_data_queue)   // binds to lvalue or rvalue, no copy
    process(std::forward<decltype(msg)>(msg));
```

### The braced-init twist (the one real difference)

This is the **single** way `auto` deviates from template deduction. A braced
initializer with `auto` deduces `std::initializer_list`; a template will not
deduce it at all:

```cpp
auto a = 27;        // int
auto b{27};         // C++17: int        (was initializer_list<int> pre-C++17!)
auto c = {1, 2, 3}; // std::initializer_list<int>
auto d{1, 2, 3};    // ERROR in C++17 (more than one element in direct-list-init)

template <typename T> void f(T);
f({1, 2, 3});       // ERROR: template deduction can't deduce initializer_list
```

> **Interview gotcha:** "What is the type of `auto x{1};`?" The post-C++17
> answer is `int`. The pre-C++17 answer was `std::initializer_list<int>` — a
> change so surprising it was retrofitted via N3922. Know both, and know that
> `auto x = {1};` is *still* an `initializer_list`.

## `decltype` and `decltype(auto)`

`decltype` is a *different* beast — it reports the **declared type** of an
expression, references and all, with no decay (*EMC++* Item 3):

```cpp
const int  ci = 0;
const int& cr = ci;

decltype(ci)  a;   // const int
decltype(cr)  b = ci;   // const int&   (reference preserved!)
decltype(0)   c;   // int   — a prvalue expression yields its type
```

The infamous extra rule: for an **lvalue expression** that is *not* a bare name
(i.e. a more complex expression), `decltype` adds an `&`:

```cpp
int x = 0;
decltype(x)    // int    — x is a name
decltype((x))  // int&   — (x) is an lvalue expression, so reference is added
```

`decltype(auto)` (C++14) means "deduce using `decltype` rules, not `auto`
rules" — use it when you must **forward a return type exactly**, preserving
reference-ness:

```cpp
template <typename Container, typename Index>
decltype(auto) access(Container&& c, Index i) {
    return std::forward<Container>(c)[i];   // returns T& exactly, not a copy
}
```

Written with plain `auto`, that return type would *decay* and silently copy or
return a dangling value — a classic, expensive bug.

| Construct          | Strips ref/cv? | Array/fn decay? | Adds `&` for `(expr)`? |
|--------------------|:--------------:|:---------------:|:----------------------:|
| `auto`             | yes (Case 3)   | yes             | no                     |
| `auto&` / `auto&&` | per Case 1/2   | no              | no                     |
| `decltype(expr)`   | no             | no              | yes                    |
| `decltype(auto)`   | no             | no              | yes                    |

## CTAD: class template argument deduction (C++17)

Before C++17 you deduced *function* template args but had to spell out *class*
template args (hence `std::make_pair`). CTAD lets the class template deduce
from its constructor arguments:

```cpp
std::pair p{1, 2.5};            // std::pair<int, double>  — no make_pair needed
std::vector v{1, 2, 3};         // std::vector<int>
std::lock_guard g{my_mutex};    // std::lock_guard<std::mutex>
std::array a{1, 2, 3};          // std::array<int, 3>      (size deduced too)
```

CTAD uses *deduction guides* — implicit ones synthesized from constructors, or
explicit ones the author writes. It is a distinct mechanism from the
template-argument deduction above, but it's the same spirit: let the compiler
infer types from initializers.

## How to actually *see* a deduced type

Don't guess — make the compiler tell you. The cleanest trick is an
**incomplete-type error**:

```cpp
template <typename> struct TD;   // declared, never defined

template <typename T> void f(T&& param) {
    TD<T> td;                 // error names T
    TD<decltype(param)> tp;   // error names param's type
}
```

The diagnostic ("aggregate `TD<int&> td` has incomplete type") leaks the exact
type. (`typeid(...).name()` is **unreliable** here — *EMC++* Item 4 — because
`std::type_info::name` strips references and cv-qualifiers.) For a runtime tool,
use Boost.TypeIndex's `type_id_with_cvr`.

## Quant/HFT relevance & interview gotchas

- **Accidental copies in the hot path.** `auto x = book.top();` copies the top
  level; `const auto& x = book.top();` doesn't. On a level book or a fat order
  struct, that copy is real cycles per tick.
- **Dangling `auto&&` / `decltype(auto)` return.** Returning `decltype(auto)`
  from a function that returns a *local* by `(local)` yields `T&` to a
  destroyed object — UB. Reference-preserving deduction cuts both ways.
- **Perfect forwarding** rests entirely on Case 2 + reference collapsing.
  Expect to be asked *why* `std::forward<T>` needs `T` and not just `move`.
- **`initializer_list` ambush:** `auto v = {x};` makes a list, not an `x`. In a
  generic factory this silently changes the type you store.
- **Top-level vs low-level const:** be ready to explain why `f(const int)` and
  `f(int)` are the *same* signature (top-level const ignored on parameters)
  while `const int*` and `int*` are not.

## Key takeaways

1. There is one deduction engine; `auto` reuses template rules (*EMC++* 1–2).
2. **Three cases** by parameter shape: `T&`/`T*` (strip ref, keep cv); `T&&`
   universal reference (lvalue→`T&`, rvalue→`T`); by-value `T` (strip ref *and*
   top-level cv, plus array/function decay).
3. **Reference collapsing** (`&` wins unless both `&&`) makes universal
   references and `std::forward` work.
4. `auto`'s only deviation: braced-init becomes `std::initializer_list`.
5. `decltype` preserves ref/cv and decay-nothing; `decltype(auto)` uses those
   rules for *exact* return-type forwarding. Beware dangling references.
6. **CTAD** (C++17) deduces class template args from constructor arguments via
   deduction guides.

## Self-check

1. For `template<class T> void f(T&& p);`, what is `T` for `f(x)` (lvalue `int`)
   vs `f(std::move(x))`? Why does the difference matter for `std::forward`?
2. Given `const int ci = 9; const int& cr = ci;`, what are `decltype(ci)`,
   `decltype((ci))`, and `decltype(cr)`?
3. Why does `arraySize` use `T (&)[N]` and not `T param`?
4. What type does `auto x{42};` have in C++17, and what did it have before?
5. When would `decltype(auto)` as a return type introduce a dangling reference?
6. Explain why a by-value template parameter drops *top-level* const but keeps
   the const in `const char*`.

## Further reading

- [Template argument deduction — cppreference](https://en.cppreference.com/w/cpp/language/template_argument_deduction)
- [`auto` specifier — cppreference](https://en.cppreference.com/w/cpp/language/auto) and [`decltype` — cppreference](https://en.cppreference.com/w/cpp/language/decltype)
- [Class template argument deduction (CTAD) — cppreference](https://en.cppreference.com/w/cpp/language/class_template_argument_deduction)
- [Reference collapsing & forwarding references — cppreference](https://en.cppreference.com/w/cpp/language/reference)
- Scott Meyers, *Effective Modern C++*, **Items 1–4** (template deduction, `auto`, `decltype`, viewing deduced types) — the definitive treatment.
- [`std::forward` — cppreference](https://en.cppreference.com/w/cpp/utility/forward) and Meyers, *EMC++* Item 24 (universal references vs rvalue references).
- [Boost.TypeIndex `type_id_with_cvr`](https://www.boost.org/libs/type_index/) — for reliably printing deduced types at runtime.

## Videos

- Scott Meyers — **"Type Deduction and Why You Care"** (CppCon 2014), [search](https://www.youtube.com/results?search_query=CppCon+2014+Scott+Meyers+Type+Deduction+and+Why+You+Care) — the talk that became *EMC++* Items 1–4.
- CppCon — **"Back to Basics: Type Deduction"** (Andreas Fertig, CppCon 2022), [search](https://www.youtube.com/results?search_query=CppCon+2022+Back+to+Basics+Type+Deduction+Andreas+Fertig).
