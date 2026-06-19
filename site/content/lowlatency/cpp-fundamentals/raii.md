# RAII

> **Why a quant dev must own this:** RAII is *the* idiom that makes
> deterministic, exception-safe, leak-free C++ possible — and determinism is the
> whole game in low-latency systems. A lock you forget to release stalls the
> book; a buffer you leak on an error path bloats RSS until you page-fault at the
> worst moment; a file/socket left open exhausts descriptors mid-session. RAII
> ties every resource to a stack object's lifetime so cleanup is automatic,
> ordered, and exception-proof — *for free, with no garbage collector and no
> runtime cost*. It is the backbone every other C++ safety feature (smart
> pointers, `lock_guard`, scope guards) is built on, and "explain RAII" is the
> most basic of all C++ interview questions.

## First principles: resource = object lifetime

**RAII** — Resource Acquisition Is Initialization — is a slightly unfortunate
name for a simple, powerful contract:

- **Acquire** the resource in a constructor.
- **Release** it in the destructor.
- Let the language's deterministic destruction (at end of scope, on return, on
  exception) guarantee the release happens *exactly once, automatically*.

The resource is anything that must be paired with a release: heap memory, a
mutex, a file handle, a socket, a GPU buffer, a database transaction, a "set
this flag back when done" obligation. The insight is that C++ already has a
mechanism that runs code deterministically when a name goes out of scope — the
destructor — so you bolt cleanup onto it and stop hand-writing release code.

```cpp
// C++17 — the shape of every RAII type
class FileHandle {
    std::FILE* f_ = nullptr;
public:
    explicit FileHandle(const char* path)            // ACQUIRE
        : f_(std::fopen(path, "rb")) {
        if (!f_) throw std::runtime_error("open failed");
    }
    ~FileHandle() { if (f_) std::fclose(f_); }       // RELEASE (always runs)

    FileHandle(const FileHandle&)            = delete;   // not copyable (one owner)
    FileHandle& operator=(const FileHandle&) = delete;
    FileHandle(FileHandle&& o) noexcept : f_(o.f_) { o.f_ = nullptr; }  // movable
    FileHandle& operator=(FileHandle&& o) noexcept {
        if (this != &o) { if (f_) std::fclose(f_); f_ = o.f_; o.f_ = nullptr; }
        return *this;
    }
    std::FILE* get() const { return f_; }
};
```

## Mechanics: why it's exception-safe

The destructor of a fully-constructed automatic object runs on **every** exit
path from its scope: normal fall-through, `return`, `break`, and — critically —
**stack unwinding** when an exception propagates through. This is the engine
behind exception safety.

```cpp
// C++17
void process(const char* path) {
    FileHandle fh(path);     // acquire
    parse(fh.get());         // if parse() throws...
    finalize(fh.get());
}                            // ...fh's destructor STILL runs during unwinding -> fclose
```

Compare the manual version: with raw `fopen`/`fclose` you'd need a `try/catch`
around every throwing call, or a `goto cleanup`, and you'd still leak on the path
you forgot. RAII makes the *correct* behavior the *default* behavior — there is
no path that skips the destructor of a constructed object.

> **Mnemonic:** *Constructor grabs, destructor frees, the stack does the
> bookkeeping.* You never write the cleanup call at the use site again.

### Construction ordering and partial construction

Subobjects and members are destroyed in **reverse** order of construction, and
the language guarantees that if a constructor throws, only the *already
fully-constructed* subobjects are destroyed (the throwing object's own
destructor does **not** run, because it never finished constructing). This is
why each resource should be a member with its *own* RAII wrapper — partial
construction then cleans up exactly the pieces that succeeded.

## The standard library is RAII all the way down

You rarely write raw RAII wrappers; the library gives you the common ones:

```cpp
// C++17
#include <memory>   // unique_ptr / shared_ptr
#include <mutex>    // lock_guard / scoped_lock / unique_lock
#include <fstream>  // ifstream/ofstream close the fd in their dtor
#include <vector>   // owns and frees its heap buffer

std::unique_ptr<Order> o = std::make_unique<Order>();  // delete in dtor
std::vector<double> buf(1024);                          // free() in dtor
std::ifstream in("ticks.bin");                          // close() in dtor
```

### `std::lock_guard` / `std::scoped_lock` — RAII for mutexes

The single most important RAII use in concurrent low-latency code: never call
`mtx.lock()` / `mtx.unlock()` by hand.

```cpp
// C++17
#include <mutex>
std::mutex m;
int shared = 0;

void add(int x) {
    std::lock_guard<std::mutex> g(m);   // lock in ctor
    shared += x;
}                                       // unlock in dtor — even if += throws

// C++17: scoped_lock locks MULTIPLE mutexes deadlock-free (uses std::lock internally)
std::mutex a, b;
void transfer() {
    std::scoped_lock lk(a, b);          // CTAD; both locked in a deadlock-avoiding order
    /* ... */
}                                       // both unlocked in reverse
```

Hand-rolled `lock()/unlock()` leaks the lock on any early return or exception
between them — a hung mutex stalls every thread waiting on it, which in a feed
handler is a stall of the entire pipeline. `lock_guard` makes that impossible.
Use `std::unique_lock` when you need to unlock/relock or hand the lock to a
`condition_variable`.

## Scope guards — RAII for arbitrary cleanup

Not every obligation has a tidy type. A **scope guard** runs an arbitrary
callable in its destructor — perfect for "undo this on the way out" or
interop with C APIs that hand you a raw handle.

```cpp
// C++17 — a minimal scope guard (the std one, scope_exit, is in the Library
// Fundamentals TS / experimental; here's the idiom you can drop in anywhere)
template <class F>
class ScopeExit {
    F f_;
    bool active_ = true;
public:
    explicit ScopeExit(F f) : f_(std::move(f)) {}
    ~ScopeExit() { if (active_) f_(); }
    void dismiss() noexcept { active_ = false; }   // commit: don't run cleanup
    ScopeExit(ScopeExit&& o) noexcept : f_(std::move(o.f_)), active_(o.active_) { o.active_ = false; }
    ScopeExit(const ScopeExit&) = delete;
};
template <class F> ScopeExit<F> make_scope_exit(F f) { return ScopeExit<F>(std::move(f)); }

void use_c_api() {
    int fd = ::open("ticks", O_RDONLY);
    if (fd < 0) throw std::runtime_error("open");
    auto guard = make_scope_exit([&]{ ::close(fd); });  // close on any exit
    read_all(fd);
    // commit-or-rollback pattern:
    // guard.dismiss();  // call if ownership was successfully transferred elsewhere
}
```

> Keep destructors **`noexcept`** (they are by default). If cleanup can throw and
> you're already unwinding, a second exception calls `std::terminate`. A
> destructor that does I/O should swallow or log its own errors.

## Performance & hardware reality

- **RAII is zero-overhead.** A destructor call placed at scope exit is exactly
  the cleanup you'd have written by hand; with inlining the wrapper compiles to
  the same instructions. `std::unique_ptr`'s footprint is one pointer; its
  destructor is the `delete` you'd write anyway.
- **`lock_guard` adds nothing** over manual lock/unlock — same two atomic ops,
  just placed correctly and unconditionally.
- The cost to *watch* is not RAII itself but **what** the destructor does:
  - `delete` in a hot-path dtor is a heap free (hundreds of cycles, possible
    lock, possible page fault). Prefer object pools / arenas so destruction is a
    no-op or a pointer bump.
  - A destructor that touches a cold cache line or takes a lock on the hot path
    is the real cost. Profile the dtor, not the idiom.
- RAII enables a key HFT pattern: **preallocate on a cold path, let RAII own the
  buffers, never allocate/free in the steady state.** The vector you size at
  startup frees itself at shutdown; nothing churns the allocator mid-session.

```text
What RAII costs (with -O2 inlining)
  unique_ptr move/destroy ...... same as manual new/delete (the delete dominates)
  lock_guard ................... identical to correct manual lock/unlock
  vector destructor ............ one free() of the owned buffer
  scope guard (lambda) ......... inlined; the cleanup code, nothing more
```

## Quant/HFT relevance & interview gotchas

- **"What is RAII?"** Resource lifetime bound to object lifetime: acquire in
  ctor, release in dtor, cleanup guaranteed by deterministic destruction even
  during exception unwinding. Say *deterministic* and *exception-safe*.
- **Never hand-roll `lock()/unlock()`** — an early return between them deadlocks
  the system. `lock_guard`/`scoped_lock`/`unique_lock` exist for this.
- **Destructors must not throw** (they're `noexcept` by default); throwing during
  unwinding terminates the process.
- **Rule of zero:** prefer composing RAII members so your class needs *no*
  user-defined special members at all (see the Rule of Five lesson). If you do
  manage a raw resource, you owe all five.
- **RAII over a raw OS handle** (fd, socket, mmap region) is a classic interview
  exercise — show the deleted copy, the move with null-out, the `noexcept` dtor.
- **The hot-path nuance:** RAII is free, but *freeing* isn't. Move
  allocation/deallocation to startup/shutdown and let RAII own preallocated
  resources for the session.
- **`std::scoped_lock` (C++17) locks multiple mutexes deadlock-free**; prefer it
  over nesting `lock_guard`s.

## Key takeaways

1. RAII binds a resource's lifetime to a stack object's lifetime: **acquire in
   the constructor, release in the destructor**.
2. Destructors run on *every* scope exit including exception unwinding, which is
   what makes RAII **exception-safe** with no `try/catch` at the use site.
3. The standard library is RAII throughout: `unique_ptr`, `shared_ptr`,
   `vector`, `ifstream`, and especially **`lock_guard`/`scoped_lock`** for
   mutexes — never lock/unlock by hand.
4. **Scope guards** extend RAII to arbitrary cleanup and C-API handles, with a
   `dismiss()`/commit pattern.
5. RAII is **zero-overhead**; what costs is *what the destructor does* — keep
   heap frees and locks off the hot path by preallocating and pooling.
6. Keep destructors `noexcept`; a throw during unwinding calls
   `std::terminate`.

## Self-check

1. Why does RAII give you exception safety without writing `try/catch` at the
   call site?
2. What goes wrong if you call `m.lock()` / `m.unlock()` manually and the code
   between them throws? Which RAII type fixes it?
3. Write the five special members a class owning a raw OS file descriptor needs,
   and explain the move's null-out.
4. Why must destructors not throw, and what happens if one does during stack
   unwinding?
5. RAII is "zero overhead" — yet a destructor can still wreck your hot-path
   latency. Explain, and give the HFT mitigation.
6. What does `std::scoped_lock` give you over two nested `std::lock_guard`s?

## Further reading

- [RAII — cppreference](https://en.cppreference.com/w/cpp/language/raii) — the canonical definition and rationale.
- [`std::lock_guard`](https://en.cppreference.com/w/cpp/thread/lock_guard), [`std::scoped_lock`](https://en.cppreference.com/w/cpp/thread/scoped_lock), and [`std::unique_lock`](https://en.cppreference.com/w/cpp/thread/unique_lock) — the mutex RAII trio.
- [C++ Core Guidelines — Resource management (R)](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-resource) — the rules: prefer scoped objects, rule of zero, no naked `new`/`delete`.
- [`std::experimental::scope_exit` — cppreference](https://en.cppreference.com/w/cpp/experimental/scope_exit) — the standardized scope-guard family (Library Fundamentals TS).
- Bjarne Stroustrup, *The C++ Programming Language*, §13 (exception safety) — the original treatment that named RAII.
- Herb Sutter, *Exceptional C++* — exception-safety levels (basic/strong/nothrow) and why RAII delivers them.

## Videos

- CppCon — **"Back to Basics: RAII and the Rule of Zero" (Arthur O'Dwyer)** ([search](https://www.youtube.com/results?search_query=CppCon+Back+to+Basics+RAII+Rule+of+Zero+Arthur+O%27Dwyer)) — the definitive intro talk.
- CppCon — **Herb Sutter, "Leak-Freedom in C++... By Default"** ([search](https://www.youtube.com/results?search_query=CppCon+Herb+Sutter+Leak+Freedom+in+C%2B%2B+by+default)) — RAII and ownership as the path to leak-free code.
