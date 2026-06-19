# The C++ Compiler

> **Why a quant dev must own this:** In HFT the build *is* part of the product.
> Whether a hot function inlines, whether the linker can devirtualize across
> objects, whether LTO sees your accessor — all of it is decided by the
> translation model: headers, translation units, the one-definition rule, and
> the linker. "What actually happens between `.cpp` and a running binary?" is a
> staple interview opener, and the answer is the foundation for every
> optimization conversation that follows.

## First principles: source text in, machine code out

A C++ "compiler" is really a *pipeline*. You feed it text and it emits an
executable, but in between it crosses several well-defined boundaries. Knowing
those boundaries is what lets you reason about why a change to a header
recompiles the world, why a symbol is "undefined", and why the function you
expected to inline didn't.

The standard formalizes this as the **phases of translation** (`[lex.phases]`).
The phases you care about day-to-day collapse into three stages:

```text
  foo.cpp ──preprocess──▶ foo.ii ──compile──▶ foo.s ──assemble──▶ foo.o ──┐
  bar.cpp ──preprocess──▶ bar.ii ──compile──▶ bar.s ──assemble──▶ bar.o ──┼─link─▶ a.out
                                                       libc++.a / .so ─────┘
```

1. **Preprocessing** — a textual pass. `#include` literally pastes a header's
   contents in; `#define` macros are expanded; `#if`/`#ifdef` cut text in or
   out. The output is a single, self-contained stream of C++ tokens with no
   directives left. See it with `g++ -E foo.cpp`.
2. **Compilation** — the compiler proper parses that stream, does semantic
   analysis and optimization, and emits **assembly** (`-S`), which the assembler
   turns into an **object file** (`.o`). This is where templates instantiate,
   inlining happens, and constant folding occurs.
3. **Linking** — the linker (`ld`, `lld`, `gold`, `mold`) stitches the object
   files and libraries together, *resolving symbols* (matching each use of a
   name to its one definition) and laying out the final binary.

## The translation unit — the compiler's unit of work

A **translation unit (TU)** is one `.cpp` file *after preprocessing* — i.e. the
source plus everything its `#include`s pulled in. The compiler sees exactly one
TU at a time and knows *nothing* about the others. Every `.cpp` you list on the
command line becomes one `.o`. This isolation is the single most important fact
about C++ builds:

- The compiler can only inline a function whose **body** it can see *in this
  TU*. A function defined in another `.cpp` is, to the optimizer, an opaque
  `call` — unless LTO or the inliner is given visibility (see below). *This is
  why performance-critical accessors live in headers.*
- An error in `b.cpp` cannot be detected while compiling `a.cpp`, even if
  they're inconsistent. The consistency is the programmer's responsibility,
  enforced (partly) at link time.

## Declarations vs definitions, and the One-Definition Rule

A **declaration** introduces a name and its type — it promises something exists.
A **definition** actually provides it (allocates the storage / emits the code).

```cpp
// --- math.hpp ---
int add(int, int);          // declaration: "add exists, here's its type"
extern int g_counter;       // declaration of a variable
struct Order;               // declaration (incomplete type)

// --- math.cpp ---
int add(int a, int b) { return a + b; }   // definition: emits the code
int g_counter = 0;                        // definition: allocates storage
```

The **One-Definition Rule (ODR)**, `[basic.def.odr]`, governs how many
definitions are allowed:

- A given *entity* may be **declared** any number of times but **defined at most
  once** within a single translation unit.
- Across the whole program, a non-`inline` function or variable with external
  linkage must have **exactly one** definition.
- For things that *must* appear in every TU that uses them — class definitions,
  `inline` functions, templates — multiple definitions are permitted **provided
  every definition is token-for-token identical**. Violate that (e.g. compile
  two TUs with different `-DFOO` that changes a class layout) and you get an
  **ODR violation**: silent, ill-formed-no-diagnostic-required, and a classic
  source of "works in debug, crashes in release."

> **Interview gotcha:** "Why can a class be defined in a header included by 100
> files, but a free function can't?" Because a class definition and an `inline`
> function are explicitly exempted by the ODR (subject to the identical-tokens
> rule); a non-`inline` function definition is not, so 100 copies = 100
> conflicting definitions = a multiple-definition link error.

## Headers, include guards, and `#pragma once`

Because `#include` is textual, including a header twice in one TU re-pastes it
twice — and re-defining a class is an ODR violation *within the TU*. Guards stop
that:

```cpp
// classic include guard — portable, standard
#ifndef ORDER_HPP
#define ORDER_HPP
struct Order { /* ... */ };
#endif  // ORDER_HPP

// or, supported by every mainstream compiler:
#pragma once
```

`#pragma once` is not in the standard but is universally implemented; it's
terser and lets the compiler skip re-reading the file (a small build-speed win).
Its one weakness is identity: if the same header is reachable by two different
paths (symlinks, network mounts) the compiler may fail to recognize it as "the
same" file. Include guards key off a macro name and don't have that problem.
Many shops use both, belt-and-suspenders.

## The toolchain: front end, back end, and IR

Both GCC and Clang split into a **front end** (language-specific: lex, parse,
semantic analysis, template instantiation) and a **back end**
(target-specific: optimization, register allocation, instruction selection).

- **Clang** is a front end for the **LLVM** project. It lowers C++ to **LLVM
  IR** — a typed, target-independent intermediate representation — which the
  LLVM back end optimizes and turns into machine code. You can dump it with
  `clang -S -emit-llvm foo.cpp -o foo.ll`.
- **GCC** has its own internal IRs (GENERIC → GIMPLE → RTL). Same idea, GCC's
  own pipeline.

The IR is where the heavy optimization lives. Understanding that "my C++ becomes
IR, which the optimizer rewrites" is the mental model behind reading the
assembly: there is no one-to-one mapping from source lines to instructions.

## Object files and symbols

An object file is machine code plus a **symbol table**: a list of names this
file *defines* and names it *needs* (undefined / external). The linker's job is
to make every "needs" point at exactly one "defines".

```bash
$ g++ -c math.cpp -o math.o
$ nm -C math.o          # -C = demangle
0000000000000000 T add(int, int)      # T = defined in text (code) section
                 U printf             # U = undefined: must come from elsewhere
0000000000000000 B g_counter          # B = uninitialized data (BSS)
```

`nm` is the tool you reach for when the linker says *"undefined reference to
`foo`"*: it tells you which `.o` defines a symbol and which only references it.
The capital/lowercase of the type letter encodes external vs local linkage.

## Name mangling, `extern "C"`, and `c++filt`

C++ has overloading, namespaces, and templates — but a linker only matches flat
symbol *strings*. So the front end **mangles** the rich C++ signature into a
unique linker symbol:

```text
add(int, int)            ->  _Z3addii            (Itanium ABI, used by GCC/Clang)
ns::Order::price() const ->  _ZNK2ns5Order5priceEv
```

```bash
$ echo _Z3addii | c++filt        # decode a mangled name
add(int, int)
```

This is also *why C++ symbols are ABI-coupled*: two compilers must agree on the
mangling scheme (and the rest of the ABI) to link against each other. To expose
a function to C (or to dlopen by a stable name), suppress mangling with
`extern "C"`:

```cpp
extern "C" int feed_handler_init(int);   // symbol is literally "feed_handler_init"
```

`extern "C"` disables mangling (and overloading) for that declaration — the cost
of a stable, language-agnostic symbol.

## Static vs dynamic linking

| | Static (`libfoo.a`) | Dynamic (`libfoo.so`) |
|---|---|---|
| When resolved | At link time, copied into the binary | At load/run time, by the dynamic loader |
| Binary size | Larger (code baked in) | Smaller |
| Deployment | Self-contained | Needs the `.so` present & compatible |
| Startup | No relocation of shared code | Pays PLT/GOT indirection, lazy binding |
| Inlining/LTO across the boundary | Possible with LTO | Generally not |
| HFT preference | **Usually static** for hot paths | For ubiquitous system libs |

HFT shops lean **static** for latency-critical code: it removes
position-independent-code (PIC) indirection through the PLT/GOT, keeps everything
in one address layout the optimizer/LTO can reason about, and eliminates a class
of "wrong `.so` in production" failures. The trade-off is fatter binaries and
losing the ability to patch a library without relinking.

## Optimization levels and useful flags

| Level | Intent |
|---|---|
| `-O0` | No optimization; fastest builds, best debugging, 1:1-ish asm. Default. |
| `-O1` | Light optimization. |
| `-O2` | The workhorse: aggressive, standards-conforming, no size explosion. |
| `-O3` | `-O2` plus more vectorization/inlining; can bloat code (watch I-cache). |
| `-Os` / `-Oz` | Optimize for size. |
| `-Ofast` | `-O3` plus `-ffast-math` — **breaks IEEE-754 semantics**; rarely safe for pricing. |
| `-march=native` | Emit instructions for *this* CPU (AVX2/AVX-512, BMI). Big wins, but the binary won't run on older silicon. |
| `-flto` | **Link-time optimization** — defer codegen so the optimizer sees the *whole program* and can inline/devirtualize across TUs. |

Flags every C++ engineer should know for *reading the machine*:

```bash
g++ -O2 -S -masm=intel foo.cpp -o foo.s   # emit Intel-syntax assembly
g++ -O2 -fno-exceptions -fno-rtti ...      # strip EH tables / RTTI (HFT common)
g++ -Wall -Wextra -Werror ...              # build hygiene: warnings as errors
```

## A tiny snippet and its assembly

```cpp
// C++17. Compile with: g++ -O2 -S -masm=intel
int square_plus_one(int x) {
    return x * x + 1;
}
```

```x86asm
square_plus_one(int):
        imul    edi, edi        ; edi = x * x
        lea     eax, [rdi+1]    ; eax = (x*x) + 1   (LEA does the add)
        ret
```

Two instructions. The compiler used `lea` — an address-arithmetic instruction —
to do an integer add for free, and never touched memory. This is the kind of
thing you confirm on **[Compiler Explorer (godbolt.org)](https://godbolt.org/)**:
paste the function, pick a compiler and flags, and watch the assembly update
live. It is the single most valuable tool for this entire course — use it
constantly.

## Performance & hardware reality: why headers matter

The translation model has direct latency consequences:

- **Inlining needs the body in the TU.** A one-line getter defined in a `.cpp`
  is a real `call` (push args, jump, return) from every other TU — and, worse,
  an *optimization barrier*: the optimizer must assume it clobbers memory. Put
  hot, small functions in the header (implicitly `inline`) so every caller can
  inline and the surrounding code can be optimized through them.
- **LTO** (`-flto`) recovers cross-TU inlining when you *can't* header-ify
  everything: it stashes IR in the object files and optimizes at link time. It
  can devirtualize and propagate constants across the whole program — at the
  cost of longer, more memory-hungry links.
- **Build hygiene compounds.** A bloated header included everywhere balloons
  compile times and, via templates, code size — which pressures the instruction
  cache in the hot loop. Minimal includes, forward declarations, and `pImpl` at
  cold boundaries keep both build times and I-cache footprint down.

## Quant/HFT relevance & interview gotchas

- **"Where should a hot accessor live?"** In the header, so it inlines. If it
  must stay in a `.cpp`, turn on **LTO**.
- **"Undefined reference to X"** — you have a declaration but no definition the
  linker can find: missing `.o`/`-l`, an `extern "C"` mismatch, or a mangling
  mismatch (e.g. compiling one TU as C and another as C++). Reach for `nm -C`
  and `c++filt`.
- **"Multiple definition of X"** — a non-`inline` function or a variable defined
  in a header. Mark it `inline` (C++17 `inline` variables too) or move the
  definition to one `.cpp`.
- **ODR violations are the silent killer:** mixing TUs built with different
  macros/flags that change a type's layout. Standardize the build; LTO and
  `-Wodr` can catch some.
- **`-Ofast` near pricing math** reorders/contracts floating-point and is a
  correctness landmine — know that `-O2`/`-O3` keep IEEE semantics and
  `-ffast-math` does not.
- Be ready to **walk the pipeline end to end** (`-E`, `-S`, `-c`, link) and name
  the front end / back end / IR split.

## Key takeaways

1. The build is **preprocess → compile (to asm/object) → link**; each `.cpp`
   becomes one **translation unit** the compiler sees in isolation.
2. **Declaration** ≠ **definition**; the **ODR** allows one definition per
   entity program-wide (with the identical-token exemption for classes,
   templates, and `inline` functions/variables).
3. Headers exist because `#include` is textual; **include guards / `#pragma
   once`** prevent double-definition within a TU.
4. C++ **name-mangles** signatures into linker symbols; `extern "C"` opts out,
   `nm`/`c++filt` decode them.
5. Prefer **static linking** and put hot, small functions **in headers** (or use
   **LTO**) so the optimizer can inline across boundaries.
6. Learn to read assembly via `-S -masm=intel` and **godbolt**; know your `-O`
   levels and that `-Ofast` breaks IEEE-754.

## Self-check

1. What exactly is a translation unit, and why can't the compiler inline a
   function defined in a different `.cpp` without LTO?
2. A header defines `int counter = 0;` and is included by three `.cpp` files.
   What error do you get, and what are two correct fixes?
3. The linker reports `undefined reference to feed_init`. The function is
   defined in C and called from C++. What's the likely cause and the fix?
4. Why is a class definition allowed in a header included everywhere, but a
   non-`inline` free function's definition is not?
5. You ship to mixed hardware. Why might `-march=native` cause a crash in
   production but not on the build box?
6. When does `-flto` change the generated code for a function, and what does it
   cost you?

## Further reading

- [Phases of translation — cppreference](https://en.cppreference.com/w/cpp/language/translation_phases)
- [One Definition Rule (ODR) — cppreference](https://en.cppreference.com/w/cpp/language/definition)
- [Definitions and ODR — `[basic.def.odr]` (C++ draft)](https://eel.is/c++draft/basic.def.odr)
- [`inline` specifier (incl. inline variables) — cppreference](https://en.cppreference.com/w/cpp/language/inline)
- [Language linkage / `extern "C"` — cppreference](https://en.cppreference.com/w/cpp/language/language_linkage)
- [GCC optimization options manual](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html)
- [Compiler Explorer (godbolt.org)](https://godbolt.org/) — your daily driver for asm.
- [Itanium C++ ABI — name mangling](https://itanium-cxx-abi.github.io/cxx-abi/abi.html#mangling)

## Videos

- Matt Godbolt, CppCon — **"What Has My Compiler Done for Me Lately? Unbolting the Compiler's Lid"** ([search](https://www.youtube.com/results?search_query=CppCon+Matt+Godbolt+What+Has+My+Compiler+Done+for+Me+Lately)).
- Chandler Carruth, CppCon — **"Understanding Compiler Optimization"** ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+Understanding+Compiler+Optimization)).
- Matt Godbolt, CppCon — **"Memory Latency / Optimizations You Shouldn't Make"** for the LTO/inlining mindset ([search](https://www.youtube.com/results?search_query=CppCon+Matt+Godbolt+optimizations+you+shouldnt+make)).
