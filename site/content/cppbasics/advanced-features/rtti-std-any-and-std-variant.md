# RTTI, std::any, and std::variant

> **Why a quant dev must own this:** A feed handler dispatches over a fixed set
> of message types (Add, Cancel, Trade, …); an event loop routes a heterogeneous
> stream of events. The naive design reaches for an inheritance hierarchy plus
> `dynamic_cast`/`typeid` — RTTI on the hot path, with heap-allocated message
> objects. The HFT-correct design is usually **`std::variant`**: a stack-based,
> heap-free, closed-set tagged union dispatched with `std::visit` (a compiler-
> generated jump table). Knowing *exactly* how RTTI, `std::any`, and
> `std::variant` differ — closed vs open set, heap vs stack, jump-table vs
> virtual dispatch — is the kind of question that separates "used the STL" from
> "understands the STL."

## Part 1 — RTTI mechanics

**RTTI** (Run-Time Type Information) is the machinery that lets a running program
ask about the dynamic type of an object. Two operators use it: `dynamic_cast`
(covered in its own lesson) and **`typeid`**.

### `typeid` and `std::type_info`

`typeid(expr)` yields a reference to a `const std::type_info` describing a type.
There are two very different cases:

```cpp
#include <typeinfo>

struct Base { virtual ~Base() = default; };   // polymorphic
struct Derived : Base {};

void inspect(Base& b) {
    // POLYMORPHIC operand: typeid is evaluated at RUNTIME -> the DYNAMIC type.
    const std::type_info& ti = typeid(b);     // == typeid(Derived) if b is a Derived
}

int x = 0;
const std::type_info& ti2 = typeid(x);        // NON-polymorphic / type: compile-time, static type
const std::type_info& ti3 = typeid(int);      // a type operand: always static, compile-time
```

- For a **polymorphic lvalue** (a type with at least one virtual function),
  `typeid` reads the object's actual most-derived type **at runtime**, via the
  `type_info` pointer stored in the vtable.
- For a **non-polymorphic expression or a type-id**, `typeid` is resolved at
  **compile time** from the static type — no runtime work, no vtable needed.

### `bad_typeid` on a null polymorphic pointer

```cpp
Base* p = nullptr;
typeid(*p);            // throws std::bad_typeid: dereferencing null to read its
                       //   runtime type is impossible
```

Applying `typeid` to a *dereferenced null pointer of polymorphic type* throws
**`std::bad_typeid`** — because the runtime would have to follow a vptr that
isn't there. (For a non-polymorphic type, `typeid(*p)` doesn't dereference and
won't throw, since the answer is static.)

### What `std::type_info` gives you

```cpp
const std::type_info& a = typeid(Derived);
a.name();           // implementation-defined string (often MANGLED, e.g. "7Derived")
a.hash_code();      // size_t, equal for equal types (C++11)
a == typeid(b);     // exact-type equality comparison
a.before(b);        // implementation-defined collation order (for ordered maps)
```

- `name()` is **implementation-defined** and frequently *mangled* — never parse
  it or rely on its format; for human-readable names, demangle (`abi::__cxa_demangle`
  on GCC/Clang) only in tooling, never on the hot path.
- `type_info` is **not** default-constructible or copyable; you hold references.
  Use `std::type_index` (a copyable, hashable wrapper) as a key in
  `std::unordered_map` if you need a type-keyed table.

### Layout: `type_info` lives in the vtable

In the Itanium ABI, each polymorphic class has a vtable, and a pointer to its
`std::type_info` sits **just before** the address the vptr points at (the
`-1`-slot). That's how a runtime `typeid`/`dynamic_cast` finds type identity:
follow the object's vptr, step back one slot, read the `type_info*`.

```text
object: [ vptr ] [ members... ]
            │
            ▼
       [ &type_info ]   <- vtable[-1]  (RTTI hook)
       [ &dtor       ]   <- vtable[0]
       [ &virt_fn_1  ]
       [ ...         ]
```

### `-fno-rtti`: cost and trade-off

RTTI adds the `type_info` objects and class-hierarchy metadata to the binary
(modest size, but nonzero). Compiling with **`-fno-rtti`**:

- removes that metadata (smaller binary, relevant for I-cache and embedded), and
- makes `typeid` on polymorphic types and `dynamic_cast` (down/cross) **compile
  errors**.

You keep `typeid` on *types* and *non-polymorphic* expressions (those are
compile-time). Many trading and embedded builds use `-fno-rtti` deliberately to
forbid runtime type queries and force a `variant`/virtual design.

## Part 2 — `std::any` (C++17): open-set type erasure

`std::any` holds **a single value of any copy-constructible type**, type-erased.
You put a type in; you get it back only by naming the *exact* type via
`std::any_cast`.

```cpp
#include <any>

std::any a = 42;                       // holds an int
a = std::string{"market open"};        // now holds a std::string (old value destroyed)

if (a.type() == typeid(std::string))   // type() returns the stored type_info
    std::string s = std::any_cast<std::string>(a);   // exact type required

int* p = std::any_cast<int>(&a);       // pointer form: nullptr if type mismatches
int  v = std::any_cast<int>(a);        // value/ref form: throws std::bad_any_cast on mismatch
```

### Why `std::any` is heavy

- **Type erasure + RTTI:** `any` stores a `type_info` (or equivalent vtable of
  operations) to support `.type()` and to verify `any_cast`. Every access is a
  type check.
- **Heap allocation for large/non-trivial types:** implementations apply a
  **Small Buffer Optimization (SBO)** — small, trivially-movable values live
  inline in the `any` object; anything larger (or with a non-trivial move)
  **allocates on the heap**. So storing a big struct in an `any` is a `malloc`.
- **Open set:** the whole point is you *don't* enumerate the types in advance.
  That flexibility is exactly what costs you the indirection, the type check,
  and possibly the allocation.

`std::any` is a fine tool for genuinely heterogeneous, *cold* storage —
configuration blobs, plugin registries, scripting glue. It is the **wrong** tool
on a hot path: heap traffic, type checks, and cache misses. **Avoid `any` in the
tick path.**

## Part 3 — `std::variant` (C++17): closed-set tagged union

`std::variant<Ts...>` holds **exactly one** value out of a *fixed, known* list
of alternative types. It is a **type-safe tagged union**: a `union` plus a small
integer **discriminant** (the index) that records which alternative is active —
and, unlike a raw `union`, it runs the right constructor/destructor for you.

```cpp
#include <variant>

using Msg = std::variant<AddOrder, CancelOrder, Trade>;   // closed set of 3

Msg m = AddOrder{/*...*/};

std::holds_alternative<AddOrder>(m);   // true/false
m.index();                              // 0, 1, or 2 — the active discriminant

std::get<AddOrder>(m);                  // throws std::bad_variant_access if not active
std::get<0>(m);                         // by index, same throwing behavior
if (auto* a = std::get_if<AddOrder>(&m))// pointer form: nullptr if not active (no throw)
    handle(*a);
```

### No heap — it's stack-based

A `variant` stores its value **inline**. Its size is (roughly) the size of its
**largest** alternative plus the discriminant, rounded to the strictest
alignment. **No allocation, ever** — the value lives wherever the `variant`
lives (stack, array, member). This is the headline reason HFT prefers it over an
`any` or an inheritance hierarchy of heap objects.

```text
std::variant<AddOrder, CancelOrder, Trade>   // sizes: 24, 8, 16 bytes (example)

  ┌──────────────────────────────┬─────────┐
  │  storage (max alt = 24 bytes) │  index  │   <- discriminant: 0/1/2
  ├──────────────────────────────┼─────────┤
  │  AddOrder | CancelOrder|Trade │  1 byte │   (padded for alignment)
  └──────────────────────────────┴─────────┘
        the active alternative occupies the front;
        only one is "alive" at a time, tracked by index
```

### `std::monostate` and `valueless_by_exception`

- A `variant`'s first alternative is default-constructed by the variant's
  default constructor. If your first type isn't default-constructible, put
  **`std::monostate`** (an empty placeholder "no value" state) first:
  `std::variant<std::monostate, AddOrder, Trade>`.
- **`valueless_by_exception`:** if a type-changing assignment throws *midway*
  (after the old value is destroyed, before the new one is built), the variant
  has no valid alternative; `index()` returns `variant_npos` and
  `valueless_by_exception()` is `true`. With `noexcept`-movable alternatives this
  essentially never happens — another reason to make your message types
  `noexcept`-movable.

### `std::visit` and the `overloaded` idiom

`std::visit` applies a callable to whichever alternative is active — *exhaustive*
dispatch the compiler checks for you (forget a case and it won't compile). The
common idiom is the **`overloaded`** helper that fuses several lambdas into one
overload set:

```cpp
// The "overloaded" helper (C++17). Inherit operator() from each lambda.
template <class... Ts> struct overloaded : Ts... { using Ts::operator()...; };
template <class... Ts> overloaded(Ts...) -> overloaded<Ts...>;   // deduction guide (pre-C++20)

std::visit(overloaded{
    [](const AddOrder& a)    { book.add(a); },
    [](const CancelOrder& c) { book.cancel(c); },
    [](const Trade& t)       { tape.record(t); },
}, m);                       // dispatches to the matching lambda; exhaustive
```

`using Ts::operator()...;` is a pack-expanded using-declaration that brings each
lambda's `operator()` into `overloaded`, so the combined object is callable with
any of the alternative types and overload resolution picks the right one.

### Recursive variants

A variant can't directly contain itself (it would have infinite size). Wrap the
recursion behind an indirection — a `unique_ptr`, or use Boost's
`boost::recursive_variant`:

```cpp
struct Expr;
using Node = std::variant<Literal, std::unique_ptr<Expr>>;   // indirection breaks the cycle
```

## RTTI vs `std::any` vs `std::variant`

| | RTTI + inheritance | `std::any` | `std::variant` |
|---|---|---|---|
| Type set | **open** (extensible hierarchy) | **open** (any copyable type) | **closed** (fixed `Ts...`) |
| Storage | heap (objects via `new`) | SBO then **heap** for big/non-trivial | **inline / stack, no heap** |
| Dispatch | **virtual call** (vtable) | manual `any_cast` + type check | **`std::visit`** (jump table) |
| Failure mode | `nullptr` / `bad_cast` | `bad_any_cast` | `bad_variant_access` |
| Exhaustiveness checked? | no | no | **yes** (visit) |
| Needs RTTI? | yes (for `dynamic_cast`/`typeid`) | yes (`type()`/cast) | **no** |
| Hot-path fit | poor (heap + RTTI) | poor (heap + checks) | **good** |

**Closed-set vs open-set** is the governing distinction. If you can enumerate the
types up front — message kinds in a protocol, AST node kinds — that's a
**closed set**: use `variant`. If new types arrive at runtime (plugins,
user-defined scripting values), that's an **open set**: that's where
inheritance/`any` earn their place.

## `std::visit` dispatch cost vs virtual

Both `std::visit` and a virtual call do *indirect* dispatch, but differently:

- **Virtual call:** load the vptr from the object → index the vtable → indirect
  `call`. One indirect call; the object carries its own dispatch pointer; objects
  are typically heap-allocated and scattered (cache misses).
- **`std::visit`:** the compiler builds a **jump table** indexed by
  `variant::index()`. Dispatch is: read the small integer index → index a
  function-pointer table → indirect `call` (or, for a small alternative count
  and inlinable visitor, the optimizer may lower it to a `switch`/branches and
  even inline each arm). The data is **inline and contiguous** — far better cache
  behavior than scattered polymorphic objects.

```x86asm
; std::visit over variant<A,B,C>: index drives a jump table.
        movzx   eax, BYTE PTR [rdi+24]   ; load discriminant (index)
        cmp     al, 2
        ja      .Lbad                     ; out of range -> valueless path
        jmp     [rax*8 + .Ljump_table]    ; indirect jump to the matching arm
.Ljump_table:
        .quad   .Lcase_A
        .quad   .Lcase_B
        .quad   .Lcase_C
; each arm can be inlined; no vptr load from a heap object, data is contiguous
```

Neither is "free" — both are an indirect branch the CPU must predict. The
`variant`+`visit` win is rarely the branch itself; it's **no heap allocation and
contiguous, cache-friendly data**, plus compile-time exhaustiveness. For a small,
fixed alternative count the optimizer can often beat a virtual call outright by
inlining the arms.

## A realistic feed-handler dispatch

```cpp
// C++17. Closed set of message types, zero heap, exhaustive dispatch.
struct AddOrder    { std::uint64_t id; std::int64_t px; std::uint32_t qty; };
struct CancelOrder { std::uint64_t id; };
struct Trade       { std::uint64_t id; std::uint32_t qty; };

using Msg = std::variant<AddOrder, CancelOrder, Trade>;

void on_message(const Msg& m, OrderBook& book) {
    std::visit(overloaded{
        [&](const AddOrder& a)    { book.add(a.id, a.px, a.qty); },
        [&](const CancelOrder& c) { book.cancel(c.id); },
        [&](const Trade& t)       { book.fill(t.id, t.qty); },
    }, m);
}
// No `new`, no vtable, no dynamic_cast, no RTTI. The Msg lives on the stack
// (or in a contiguous queue). Add a 4th message type and the visit FAILS to
// compile until you handle it — exhaustiveness as a safety net.
```

## Quant/HFT relevance & interview gotchas

- **`std::variant` is the closed-set workhorse:** stack-based, **no heap**, no
  RTTI, exhaustive `std::visit` dispatch. Use it for message/event types instead
  of an inheritance hierarchy of heap-allocated objects.
- **Avoid `std::any` on the hot path:** type erasure + RTTI type checks + heap
  allocation for non-trivial/large types (SBO only saves the small ones). It's
  for cold, genuinely open-set storage.
- **`std::visit` vs virtual:** both are indirect dispatch; `visit`'s advantage is
  contiguous, heap-free data and compile-time exhaustiveness, and the arms can
  inline. Don't claim it's "branchless" — it's a predicted indirect branch.
- **`typeid` on a polymorphic lvalue is a runtime read** (the dynamic type) via
  the vtable; on types / non-polymorphic expressions it's compile-time.
  `typeid(*p)` on a null polymorphic `p` throws **`bad_typeid`**.
- **`-fno-rtti`** forbids `dynamic_cast` and polymorphic `typeid` and is common
  in trading builds — which is *another* reason to design around `variant`, since
  it needs no RTTI.
- **Sizing:** `sizeof(variant<Ts...>)` ≈ largest alternative + discriminant +
  padding. A wildly-sized alternative bloats every instance and the queue
  holding them — keep alternatives similarly sized or box the outlier.
- **`valueless_by_exception`** is the edge case interviewers probe; make
  alternatives `noexcept`-movable and it effectively never occurs.
- **The `overloaded` idiom** (`struct overloaded : Ts... { using Ts::operator()...; };`)
  is a near-guaranteed write-it-on-the-whiteboard question.

## Key takeaways

1. **RTTI** powers `typeid` and `dynamic_cast` via a `type_info` reachable
   through the vtable; `typeid` is a **runtime** dynamic-type read for
   polymorphic lvalues, compile-time otherwise, and throws **`bad_typeid`** on a
   null polymorphic dereference. `-fno-rtti` removes it and forbids both.
2. **`std::any`** is open-set type erasure: it stores any copyable type but pays
   with RTTI type checks and **heap allocation** for large/non-trivial values
   (SBO saves only small ones). Keep it off the hot path.
3. **`std::variant`** is a closed-set, **stack-based, heap-free** tagged union: a
   `union` plus a discriminant (`index()`), accessed with
   `get`/`get_if`/`holds_alternative` and dispatched with **`std::visit`**.
4. **`std::visit` + `overloaded`** gives **exhaustive, compiler-checked**
   dispatch as a **jump table** over the index — contiguous, cache-friendly, and
   needing no RTTI, unlike a virtual hierarchy of heap objects.
5. Choose by **closed vs open set**: enumerable types → `variant`; runtime-
   extensible types → inheritance/`any`. HFT message/event routing is almost
   always closed → `variant`.
6. Mind **`sizeof`** (largest alternative + discriminant) and
   **`valueless_by_exception`** (avoid by making alternatives `noexcept`-movable).

## Self-check

1. When is `typeid(expr)` evaluated at runtime versus compile time, and what
   does `typeid(*p)` do when `p` is a null pointer to a polymorphic type?
2. Why can storing a large struct in `std::any` cause a heap allocation, and
   what optimization sometimes avoids it?
3. How does `std::variant` track which alternative is active, and why does it
   never allocate on the heap? What roughly determines its `sizeof`?
4. Write the `overloaded` helper and use it with `std::visit` over a
   three-alternative variant.
5. Compare `std::visit` dispatch with a virtual call: where does each get its
   indirection, and why is the `variant` version usually more cache-friendly?
6. You must route a fixed set of exchange message types with zero heap and no
   RTTI. Which facility do you choose and why? What if new message types could
   be loaded at runtime as plugins?

## Further reading

- [`std::variant` — cppreference](https://en.cppreference.com/w/cpp/utility/variant) and [`std::visit` — cppreference](https://en.cppreference.com/w/cpp/utility/variant/visit).
- [`std::any` — cppreference](https://en.cppreference.com/w/cpp/utility/any) and [`std::any_cast` — cppreference](https://en.cppreference.com/w/cpp/utility/any/any_cast).
- [`typeid` / RTTI — cppreference](https://en.cppreference.com/w/cpp/language/typeid) and [`std::type_info` — cppreference](https://en.cppreference.com/w/cpp/types/type_info); [`std::type_index`](https://en.cppreference.com/w/cpp/types/type_index).
- [Itanium C++ ABI — RTTI layout (`type_info` in the vtable)](https://itanium-cxx-abi.github.io/cxx-abi/abi.html#rtti).
- [`std::monostate`](https://en.cppreference.com/w/cpp/utility/variant/monostate) and the [`overloaded` idiom example on cppreference](https://en.cppreference.com/w/cpp/utility/variant/visit).
- Bartłomiej Filipek, [*C++17 In Detail*](https://www.cppstories.com/2018/09/visit-variants/) — `std::variant`, `std::any`, and the visitor/`overloaded` pattern.
- [C++ Core Guidelines — C.181/C.183 (avoid "naked" unions; use `variant`)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#Ru-naked).

## Videos

- Nicolai Josuttis (CppCon) — **"The Nightmare of Initialization in C++"** and his `std::variant`/`std::any` material in *C++17 - The Complete Guide* talks ([search](https://www.youtube.com/results?search_query=Nicolai+Josuttis+C%2B%2B17+variant+any+CppCon)).
- Arthur O'Dwyer — **"`std::variant` and the power of pattern matching"** / variant talks ([search](https://www.youtube.com/results?search_query=Arthur+O%27Dwyer+std+variant+visit+CppCon)).
- Jason Turner, *C++ Weekly* — **"`std::visit` and `std::variant`"** episodes ([search](https://www.youtube.com/results?search_query=C%2B%2B+Weekly+Jason+Turner+std+variant+visit)).
