# Pointers and Free Store

> **Why a quant dev must own this:** Order books, ring buffers, market-data
> arenas — the latency-critical data structures in a trading system all live in
> memory you manage by address. Pointers *are* that addressing layer, and the
> free store (heap) is where dynamic state lives. A `new` in the hot path is a
> cache miss and a syscall waiting to happen; a dangling pointer is a corrupt
> book. Interviewers probe this first because everything else builds on it.

## First principles: a pointer is a typed address

Memory is a flat array of bytes, each with an integer **address**. A pointer is
just a variable whose *value* is one of those addresses — but with a **static
type** that says "the thing at this address is a `T`". That type is what makes a
pointer more than a raw integer: it tells the compiler how many bytes to read on
a dereference and how far to step on arithmetic.

```cpp
int x = 42;
int* p = &x;     // p holds the address of x; type "pointer to int"
int  y = *p;     // dereference: read the int at that address -> 42
*p = 7;          // write through the pointer: x is now 7
```

- `&x` — the **address-of** operator: yields a `T*` from a `T` lvalue.
- `*p` — the **dereference** (indirection) operator: yields the `T` lvalue the
  pointer refers to.

These are inverses: `*&x` is `x`, and `&*p` is `p` (for a valid `p`).

```text
        +-----------+        +---------+
  p  -> |  &x       | -----> |   42    |  x
0x7ffe  | (8 bytes) |  0x7ff |(4 bytes)|
        +-----------+        +---------+
   a pointer is an object too: it has its own address (&p)
   and, on a 64-bit target, sizeof(p) == 8
```

A pointer is itself an object stored somewhere, so `&p` has type `int**`. On
LP64 (Linux/macOS x86-64, ARM64) every object pointer is 8 bytes regardless of
what it points at — `sizeof(char*) == sizeof(double*) == 8`.

## Pointer arithmetic is scaled by `sizeof`

Adding `1` to a `T*` does **not** add one byte — it advances by `sizeof(T)`
bytes, so the result points at the *next `T`*. This is the entire reason
pointers are typed.

```cpp
int  a[4] = {10, 20, 30, 40};
int* p = a;          // array decays to &a[0]
p + 1;               // address of a[1]  == (char*)p + 4 on a 32-bit int
*(p + 2);            // == a[2] == 30
p[2];                // exactly the same thing: p[i] is *(p + i)
&a[3] - &a[0];       // pointer difference -> 3 (a ptrdiff_t, in elements)
```

| Expression | Meaning | Byte delta (4-byte `int`) |
|---|---|---|
| `p + n` | advance `n` elements | `n * 4` |
| `p - q` | element distance (`ptrdiff_t`) | `(addr_p - addr_q) / 4` |
| `*(p + n)` ≡ `p[n]` | element access | — |

Two rules that interviewers love: arithmetic is only defined **within a single
array** (and one-past-the-end is a legal address you may form but not
dereference); and `void*` arithmetic is *ill-formed* in standard C++ because
`sizeof(void)` doesn't exist (GCC allows it as a 1-byte extension — don't rely
on it).

## `nullptr` vs `NULL` vs `0`

A pointer that points at nothing should be the **null pointer**. C++ has three
historical spellings, and only one is right today.

```cpp
int* a = nullptr;   // C++11: a typed null. Always prefer this.
int* b = NULL;      // a macro, usually expands to 0 (or 0L) -> an int!
int* c = 0;         // the literal 0 is a null pointer constant
```

`NULL`/`0` are integer literals that happen to convert to a null pointer. That
breaks overload resolution:

```cpp
void f(int);
void f(int*);

f(NULL);     // ambiguous or calls f(int) — NULL is an integer!
f(nullptr);  // unambiguously calls f(int*) — nullptr_t converts only to ptr
```

`nullptr` has its own type, `std::nullptr_t`, that implicitly converts to any
pointer type but **not** to an integer. It also makes intent obvious to a
reader. Rule: never write `NULL` or `0` for a null pointer in modern C++.
Dereferencing a null pointer is undefined behaviour — typically a SIGSEGV, but
the optimizer is also free to assume it never happens.

## The free store vs the stack

C++ objects live in one of a few **storage durations**:

| Storage | Lifetime | Allocation cost | Typical size limit |
|---|---|---|---|
| **Automatic** (stack) | until enclosing scope exits | ~free (bump a register) | small (≈1–8 MB / thread) |
| **Free store** (heap) | until you `delete` it | expensive (allocator + maybe syscall) | most of RAM |
| **Static** | whole program | once, at load | — |

The **free store** is the C++ standard's name for the pool of memory you grow
and shrink with `new`/`delete` (the "heap" is the looser, OS-level term). Stack
allocation is just moving the stack pointer; free-store allocation runs a
general-purpose allocator that searches free lists, may take a lock, and may
fall back to `mmap`/`sbrk` to ask the OS for more pages. That asymmetry — a
handful of cycles vs hundreds-plus — is *the* reason HFT code avoids the free
store in the hot path.

## `new` and `delete`

```cpp
int* p = new int{42};   // allocate one int on the free store, init to 42
// ... use *p ...
delete p;               // run no-op dtor (int), then free the storage
p = nullptr;            // optional hygiene: a deleted pointer is dangling
```

`new T{...}` does **two** things, in order:

1. Calls the allocation function **`operator new(sizeof(T))`** to obtain raw,
   suitably-aligned storage (this is what may hit the allocator/OS).
2. **Constructs** a `T` object in that storage by running its constructor.

`delete p` is the mirror image: run `p`'s **destructor**, then call
`operator delete(p)` to return the storage. (`int` has a trivial destructor, so
step one is a no-op there — but it matters enormously for a class with a
destructor.)

### Arrays: `new[]` / `delete[]`

```cpp
int* arr = new int[1000];      // allocate (and value-init? no — default-init)
int* z   = new int[1000]{};    // value-initialize all to 0
// ...
delete[] arr;                  // MUST match new[] with delete[]
delete[] z;
```

The most punished beginner mistake: **`new[]` must be paired with `delete[]`,
and `new` with `delete`.** Mixing them is undefined behaviour. `new[]` typically
stores the element count in a small header just before the returned block so
that `delete[]` knows how many destructors to run; calling plain `delete` skips
that bookkeeping and corrupts the allocator.

### A peek at the ABI: `new` is a call

`new int` is not magic — it's a function call to the Itanium ABI symbol
`operator new(unsigned long)` (`_Znwm`), then your constructor. For a trivial
type the body reduces to something like:

```x86asm
; int* p = new int{42};   (x86-64 SysV, GCC -O2)
        mov     edi, 4            ; size argument = sizeof(int)
        call    operator new      ; _Znwm  -> returns pointer in rax
        mov     DWORD PTR [rax], 42 ; construct: store 42
        ; p == rax
; delete p;
        mov     edi, eax          ; pointer argument
        call    operator delete   ; _ZdlPv (or sized _ZdlPvm)
```

`malloc` would look almost identical (`mov edi, 4; call malloc`) — in fact the
default `operator new` usually *is* a thin wrapper over `malloc` that throws
`std::bad_alloc` on failure instead of returning null. The point: a `new` in
your trade-handling loop is a `call` into a general allocator. That is what you
are paying for.

## The three ways pointers go wrong

**Dangling pointer** — points at storage whose lifetime has ended:

```cpp
int* dangle() {
    int local = 5;
    return &local;       // BUG: local dies when the function returns
}                        // the returned pointer dangles -> UB on deref

int* p = new int{1};
delete p;
*p = 2;                  // BUG: use-after-free, p dangles after delete
```

**Memory leak** — you allocate and lose the only pointer before `delete`:

```cpp
void leak() {
    int* p = new int[1'000'000];
    if (error) return;   // BUG: early return skips delete[] -> leaked forever
    delete[] p;
}
```

**Double free** — `delete` the same pointer twice → heap corruption, often a
delayed crash far from the cause.

Tools: compile with `-fsanitize=address` (ASan) and `-fsanitize=undefined`
(UBSan); run under Valgrind. They catch all three classes routinely.

## Why raw *owning* pointers are discouraged

Notice the leak above: correctness depended on remembering to `delete` on every
path, including exceptions. That manual discipline does not scale. The modern
answer is **RAII** — tie the resource's lifetime to an object's scope so the
destructor frees it automatically — delivered by the **smart pointers**
`std::unique_ptr` and `std::shared_ptr` (covered in their own lesson). With
them, the leaking function becomes exception-safe and `delete`-free.

The guidance (see the C++ Core Guidelines) is therefore: a raw pointer is fine
as a **non-owning observer** — "I look at this, I don't own it" — but ownership
(the responsibility to free) should live in a smart pointer or container. `new`
and `delete` appearing in ordinary application code is a code smell; prefer
`std::make_unique<T>(...)` / `std::vector<T>`.

## Performance & hardware reality

- **Allocation is the cost, not the pointer.** Following a pointer is one load;
  the expense of the free store is the *allocator*, plus the cache/TLB misses
  from chasing pointers scattered across the heap.
- **Pointer chasing kills throughput.** A linked structure where each `next` is
  a fresh `new` defeats the hardware prefetcher: every hop is a likely L1/L2
  miss (~4 cycles L1 vs ~200+ cycles DRAM). Contiguous arrays (`std::vector`)
  win because the prefetcher sees the stride.
- **64-bit pointers are fat.** Eight bytes each: a node with two pointers and
  one `int` is dominated by addresses. This motivates indices-into-an-array or
  32-bit "handles" in cache-sensitive code.
- **Stack allocation is essentially free** — one register adjustment, hot in
  cache. Prefer it; reach for the free store only for lifetime or size reasons.

## Quant/HFT relevance & interview gotchas

- **No `new` in the hot path.** Preallocate everything at startup; the steady
  state should perform zero heap allocations. A surprise `new` (often hidden
  inside `std::string`, `std::function`, or a growing `vector`) is a classic
  latency spike. *Next lesson covers arenas/pools that fix this.*
- **Owning vs observing.** Be ready to say which raw pointers in a design own
  their target. The senior answer: "raw pointers observe, `unique_ptr` owns."
- **`delete`/`delete[]` mismatch** and **double free** are favourite "spot the
  bug" snippets. So is returning the address of a local.
- **`sizeof` a pointer vs its pointee:** `sizeof(arr)` where `arr` is a heap
  `int*` is `8`, not the array's bytes — the size is *not* carried by the
  pointer. Only a true array (`int a[10]`) knows its size, and even that decays.
- **`nullptr` vs `NULL`** overload resolution is a quick screening question.

## Key takeaways

1. A pointer is a **typed address**; `&` takes an address, `*` dereferences.
2. Pointer arithmetic is **scaled by `sizeof(T)`** and is only defined within a
   single array (one-past-the-end allowed, not dereferenceable).
3. Use **`nullptr`**, never `NULL`/`0` — it has a real type and fixes overloads.
4. The **free store** (heap) is expensive and managed by you; the **stack** is
   nearly free but scope-bound. `new` = `operator new` (allocate) + constructor.
5. Pair `new`/`delete` and `new[]`/`delete[]` exactly. Avoid **dangling**,
   **leaks**, and **double free**.
6. Prefer **RAII / smart pointers** for ownership; reserve raw pointers for
   non-owning observation.

## Self-check

1. Why does `p + 1` on an `int*` advance four bytes but on a `char*` advance
   one? What single rule explains both?
2. What two distinct operations does `new T{}` perform, and in what order? What
   does `delete` undo?
3. Why is `f(NULL)` ambiguous when `f(int)` and `f(int*)` both exist, but
   `f(nullptr)` is not?
4. A function returns `&local`. Name the defect and what the standard says
   happens when the caller dereferences it.
5. Given `int* a = new int[10];`, why is `delete a;` (no brackets) undefined
   behaviour? What does `new[]` store that plain `delete` ignores?
6. Why is allocating ten million small nodes with individual `new` calls slower
   to *traverse* than one `vector` of the same data, even ignoring allocation
   time?

## Further reading

- [Pointer declarations — cppreference](https://en.cppreference.com/w/cpp/language/pointer)
- [`new` expression](https://en.cppreference.com/w/cpp/language/new) and [`delete` expression](https://en.cppreference.com/w/cpp/language/delete) — cppreference
- [`nullptr` / `std::nullptr_t`](https://en.cppreference.com/w/cpp/language/nullptr) — cppreference
- [Storage duration & lifetime](https://en.cppreference.com/w/cpp/language/storage_duration) — what "free store" means formally.
- C++ Core Guidelines — [R: Resource management](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-resource) (esp. R.3 "a raw pointer is non-owning").
- Scott Meyers, *Effective Modern C++*, Items 8 (`nullptr`) and 18–22 (smart pointers).
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, §3.8 (arrays & pointer arithmetic), §9.9 (dynamic allocation).

## Videos

- CppCon 2016 — Arthur O'Dwyer, **"The Smart Pointers I Wish I Had"** ([search](https://www.youtube.com/results?search_query=CppCon+2016+Arthur+O%27Dwyer+The+Smart+Pointers+I+Wish+I+Had)) — motivates why raw owning pointers fade away.
- CppCon 2017 — Carl Cook, **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+2017+Carl+Cook+When+a+Microsecond+Is+an+Eternity)) — why allocation belongs out of the hot path.
