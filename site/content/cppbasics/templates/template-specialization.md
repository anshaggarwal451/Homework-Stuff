# Template Specialization

> **Why a quant dev must own this:** Specialization is how you make generic code
> *special-case the fast path* — a bespoke serializer for a fixed-size POD, a
> `std::numeric_limits`-style trait that the optimizer reads at compile time, a
> tag-dispatched memcpy for trivially-copyable types. Every type trait in the
> STL is built on it. Getting full vs partial specialization right — and knowing
> why function templates *can't* partially specialize — is a classic mid-level
> HFT interview question.

## The primary template and its specializations

A **primary template** is the general recipe. A **specialization** is an
alternative definition the compiler prefers when the arguments match a more
specific pattern. There are two kinds:

- **Full (explicit) specialization** — you pin down *every* parameter.
- **Partial specialization** — you pin down *some*, leaving others generic.
  **Class templates and variable templates only** — never function templates.

```cpp
template <typename T>            // primary template
struct Serializer {
    static void write(std::byte* out, const T& v) { /* generic, slow path */ }
};

// FULL specialization: T == double, everything pinned.
template <>
struct Serializer<double> {
    static void write(std::byte* out, const double& v) {
        std::memcpy(out, &v, sizeof v);   // fast path for this exact type
    }
};

// PARTIAL specialization: any pointer type T*.
template <typename T>
struct Serializer<T*> {
    static void write(std::byte* out, T* p) { Serializer<T>::write(out, *p); }
};
```

When you instantiate `Serializer<double>`, the full specialization wins. For
`Serializer<int*>`, the partial wins (with `T = int`). For `Serializer<int>`,
the primary. The compiler picks the **most specialized** match; ambiguity is an
error.

## Why function templates use overloading, not partial specialization

This trips up everyone. You **can** fully specialize a function template, but
you **cannot partially** specialize one — the language forbids it:

```cpp
template <typename T>           void f(T)      { /* primary */ }
template <>                     void f<int>(int){ /* full spec — legal */ }

// template <typename T> void f<T*>(T*) {}     // ILLEGAL: no partial spec of functions
```

The idiomatic fix is **overloading**, which *does* support patterns:

```cpp
template <typename T> void f(T)  { /* primary */ }
template <typename T> void f(T*) { /* "partial-spec-like" via overload */ }
```

### The Sutter pitfall: specializations don't participate in overload resolution

Herb Sutter's *GotW #49* lesson: **overload resolution picks the base template
first, *then* checks for an explicit specialization of that chosen template.**
Mixing full specialization with overloading produces surprises:

```cpp
template <typename T> void g(T)  { /* #1 base */ }
template <typename T> void g(T*) { /* #2 base — a different template */ }
template <>           void g<int*>(int*) { /* full spec of WHICH base? of #1 */ }

int* p = nullptr;
g(p);   // Overload resolution chooses #2 (T*), NOT #1. The g<int*> spec of #1
        // is then irrelevant -> the specialization is silently NOT called!
```

> **Interview takeaway:** "Why prefer overloading function templates over
> specializing them?" Because specializations are invisible to overload
> resolution; once you add a second overload, an explicit specialization can
> attach to the "wrong" base template and never fire. The senior rule of thumb:
> **don't specialize function templates — overload them** (and reserve full
> specialization for the rare single-template case).

## Specialization for traits

Traits are the canonical use: a class template whose specializations encode
compile-time *facts* about types. You read the trait, the optimizer reads the
trait, nobody pays at runtime.

```cpp
// A trait: is this a fixed-size wire message we can blast with memcpy?
template <typename T> struct is_pod_message : std::false_type {};

template <> struct is_pod_message<TradeMsg> : std::true_type {};
template <> struct is_pod_message<QuoteMsg> : std::true_type {};

template <typename T>
inline constexpr bool is_pod_message_v = is_pod_message<T>::value;   // C++17 variable template
```

This is exactly how the standard library is built — `std::is_integral<T>`,
`std::is_pointer<T>`, `std::iterator_traits<It>` are all primary-template +
specializations.

## `std::numeric_limits` — the canonical example

`std::numeric_limits<T>` is *the* textbook specialization: a primary template
with a full specialization for every fundamental type, each supplying the
machine constants the optimizer and your code rely on.

```cpp
#include <limits>
constexpr int    imax = std::numeric_limits<int>::max();          // 2147483647
constexpr double dmin = std::numeric_limits<double>::denorm_min();
constexpr bool   ieee = std::numeric_limits<double>::is_iec559;   // IEEE-754?
```

You can (and feed handlers sometimes do) specialize `std::numeric_limits` for a
*user-defined* fixed-point price type so generic numeric code "just works".

## Tag dispatch

When you want to choose an implementation based on a *property* of a type (not
the exact type), select an overload by passing a **tag** object — the standard
library's pre-`if constexpr` workhorse (e.g. `std::advance` dispatching on
iterator category).

```cpp
// Pick the fast path for trivially-copyable types, the safe path otherwise.
template <typename T>
void relocate_impl(T* dst, T* src, std::true_type /*trivial*/) {
    std::memcpy(dst, src, sizeof(T));            // blit
}
template <typename T>
void relocate_impl(T* dst, T* src, std::false_type /*non-trivial*/) {
    new (dst) T(std::move(*src)); src->~T();     // move-construct + destroy
}
template <typename T>
void relocate(T* dst, T* src) {
    relocate_impl(dst, src, std::is_trivially_copyable<T>{});   // tag selects overload
}
```

The tag (`true_type`/`false_type`) makes overload resolution do the branching at
compile time — zero runtime cost, dead path not even emitted.

## SFINAE and `enable_if`

**SFINAE** — *Substitution Failure Is Not An Error* — is the rule that a
template whose *signature* fails to substitute is quietly removed from the
overload set rather than causing a hard error. `std::enable_if` weaponizes it to
conditionally enable an overload:

```cpp
#include <type_traits>

// Enabled only for integral T.
template <typename T,
          typename = std::enable_if_t<std::is_integral_v<T>>>
T parse(const std::byte* p) { /* integer decode */ }

// A different overload for floating-point T.
template <typename T,
          typename = std::enable_if_t<std::is_floating_point_v<T>>>
T parse(const std::byte* p) { /* float decode */ }   // (use distinct signatures)
```

If `is_integral_v<T>` is false, `enable_if_t` has no `::type`, substitution
fails, and that overload silently disappears — leaving the float one. SFINAE is
powerful but produces the dreaded error walls and is easy to get subtly wrong
(notably the "two overloads with the same `enable_if` default arg" trap).

## `if constexpr` — the modern replacement for many specializations (C++17)

A large fraction of what once required full specialization, tag dispatch, or
`enable_if` collapses into one readable function with **`if constexpr`**. The
untaken branch is *discarded* — not compiled — so type-specific code that would
be ill-formed in the other branch is fine.

```cpp
template <typename T>
void write(std::byte* out, const T& v) {
    if constexpr (std::is_trivially_copyable_v<T>) {
        std::memcpy(out, &v, sizeof v);     // only compiled when T is trivial
    } else {
        v.serialize(out);                   // only compiled otherwise
    }
}
```

Compared to specialization/SFINAE this is one function, one place to read,
crisp errors, and no overload-set surprises. **And** C++20 concepts give you
named, subsuming constraints for the cases where you *do* want separate
overloads. The decision guide:

| Need                                            | Reach for |
|-------------------------------------------------|-----------|
| Pick code path inside one function by a trait   | `if constexpr` (C++17) |
| Pin behaviour for one exact type                | full specialization |
| Pattern over a *family* (`T*`, `vector<T>`)     | partial specialization (class) |
| Pattern over a family, for a **function**       | overloading |
| Conditionally enable/disable an overload        | concepts (C++20) > `enable_if` |
| Branch on iterator/type *category*              | tag dispatch (or `if constexpr`) |

## Performance & hardware reality

All of these mechanisms resolve at **compile time** — the chosen path is the
only one emitted, fully inlinable, with no branch in the generated code. A
trivially-copyable specialization compiles to a bare `memcpy` (often a few
`mov`s); the generic path's machinery simply isn't in the binary. There is no
runtime dispatch table, unlike `virtual`. The only cost is **compile time** and
**binary size** (more instantiations), the standard template tradeoff.

## Quant/HFT relevance & interview gotchas

- **Fast-path specialization:** a `memcpy` serializer for POD wire messages vs a
  field-by-field one for complex types — selected at compile time, zero
  overhead.
- **Traits read by the optimizer:** `std::is_trivially_copyable`,
  `std::numeric_limits` for a fixed-point price type — generic numeric code with
  no runtime checks.
- **The function-template trap (Sutter):** *don't* fully-specialize function
  templates when overloads exist; the spec attaches to a base template that
  overload resolution may not pick. Use overloading.
- **Partial spec is class-only** — be ready to state this and give the overload
  workaround.
- **Modern preference:** `if constexpr` + concepts have largely retired hand-
  rolled SFINAE; mention it, but still know `enable_if` for legacy/library code.

## Key takeaways

1. Full (explicit) specialization pins **all** parameters; partial pins
   **some** — and partial is **class/variable templates only**.
2. Function templates **cannot be partially specialized**; use **overloading**,
   which supports patterns and participates in overload resolution.
3. Beware the Sutter pitfall: explicit function-template specializations are
   *not* considered by overload resolution — the base template is chosen first.
4. Traits (`std::numeric_limits`, `std::is_*`) are primary template +
   specializations encoding compile-time facts.
5. **Tag dispatch**, **SFINAE/`enable_if`** select implementations by type
   property; **`if constexpr`** (C++17) and **concepts** (C++20) are the modern,
   cleaner replacements for most of them.
6. Everything resolves at compile time — chosen path only, no runtime dispatch.

## Self-check

1. Why is `template<typename T> void f<T*>(T*) {}` ill-formed, and what do you
   write instead?
2. Explain the Sutter pitfall: why might an explicit specialization of `g<int*>`
   never be called once a `g(T*)` overload exists?
3. Which can be partially specialized: class templates, function templates,
   variable templates? 
4. Rewrite a tag-dispatched `relocate` using `if constexpr`. What did you gain?
5. What does SFINAE stand for, and how does `std::enable_if` exploit it?
6. Give a reason an HFT serializer would specialize on
   `std::is_trivially_copyable` rather than on each exact message type.

## Further reading

- [Explicit (full) specialization — cppreference](https://en.cppreference.com/w/cpp/language/template_specialization) and [Partial specialization — cppreference](https://en.cppreference.com/w/cpp/language/partial_specialization)
- [SFINAE — cppreference](https://en.cppreference.com/w/cpp/language/sfinae) and [`std::enable_if` — cppreference](https://en.cppreference.com/w/cpp/types/enable_if)
- [`std::numeric_limits` — cppreference](https://en.cppreference.com/w/cpp/types/numeric_limits) — the canonical specialization.
- [`if constexpr` — cppreference](https://en.cppreference.com/w/cpp/language/if#Constexpr_if)
- Herb Sutter, [**GotW #49: Template Specialization and Overloading**](https://www.gotw.ca/gotw/049.htm) — *why you don't specialize function templates.*
- [Tag dispatch — cppreference iterator example (`std::advance`)](https://en.cppreference.com/w/cpp/iterator/advance) and the [`<type_traits>` library](https://en.cppreference.com/w/cpp/header/type_traits).
- Vandevoorde, Josuttis & Gregor, *C++ Templates: The Complete Guide* (2nd ed.), chapters on specialization, traits, and SFINAE.

## Videos

- Arthur O'Dwyer — **"Template Normal Programming"** (CppCon 2016, two parts), [search](https://www.youtube.com/results?search_query=CppCon+2016+Template+Normal+Programming+Arthur+O%27Dwyer).
- Walter E. Brown — **"Modern Template Metaprogramming: A Compendium"** (CppCon 2014), [search](https://www.youtube.com/results?search_query=CppCon+2014+Walter+Brown+Modern+Template+Metaprogramming+Compendium).
- CppCon — **"Back to Basics: Templates / SFINAE & `if constexpr`"**, [search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+SFINAE+if+constexpr).
