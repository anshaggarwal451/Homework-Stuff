# Process Memory Model

> **Why a quant dev must own this:** Where an object lives — text, data, BSS,
> heap, or stack — determines whether accessing it costs a cache hit or a page
> fault, whether it's shared between threads, and whether it survives a `fork`.
> The hot path of a trading system is an exercise in *placing* data: pre-faulted
> arenas, stack-allocated scratch, hugepage-backed buffers. You can't reason
> about any of that without a precise picture of the virtual address space, and
> "draw the memory map of a process" is a staple HFT interview prompt.

## First principles: one program, one private address space

When the kernel runs your binary it hands the process a **virtual address
space** — a flat array of bytes from `0` up to a huge limit (on x86-64,
canonical addresses give each process a 48-bit, 256 TiB user space). This space
is *private*: address `0x4000_0000` in your process and the same number in
another process point at completely different physical memory. The hardware MMU
translates these virtual addresses to physical frames on every access (covered
in depth in the virtual-memory lesson).

That address space isn't one undifferentiated blob. The loader and the runtime
carve it into **segments**, each with its own permissions (read/write/execute)
and lifetime. Knowing the segments is knowing the model.

## The segments, from the bottom up

- **Text (code) segment** — your machine instructions. **Read-only and
  executable**; shared (one physical copy can back many processes running the
  same binary). Writing here → segfault.
- **Rodata** — string literals, `const` globals, jump tables. Read-only.
- **Initialized data (`.data`)** — globals/statics with a nonzero initializer
  (`int g = 42;`). Read-write; the initial bytes come from the executable file.
- **BSS (`.bss`)** — globals/statics that are zero-initialized (`int g;`,
  `static double buf[1024];`). Takes **no space in the file** (just a size); the
  kernel zero-fills the pages on first touch. *"Block Started by Symbol."*
- **Heap** — dynamic allocation (`malloc`/`new`). **Grows upward** (toward higher
  addresses) via `brk`/`sbrk` for small allocations and via `mmap` for large
  ones. Managed by the allocator in userspace.
- **Memory-mapping region** — shared libraries, `mmap`'d files, and large
  anonymous allocations land here, between the heap and the stack.
- **Stack** — function call frames: locals, saved registers, return addresses.
  **Grows downward** (toward lower addresses). Per-thread (the main thread's
  stack is here; other threads get stacks in the mmap region).
- **Kernel space** — the top of the canonical range, mapped into every process
  but inaccessible from user mode (ring 3). A syscall traps into it.

### The classic map (x86-64 Linux, simplified)

```text
  high addresses
  0xFFFF_FFFF_FFFF_FFFF +-------------------------------+
                        |        kernel space           |  not user-accessible
  0xFFFF_8000_0000_0000 +-------------------------------+
                        |   (non-canonical "hole")      |
  0x0000_7FFF_FFFF_FFFF +-------------------------------+
                        |            STACK              |  grows DOWN  v
                        |  [main thread locals, frames] |
                        +-------------------------------+
                        |               |               |
                        |               v   (gap)       |
                        |                               |
                        +-------------------------------+
                        |     mmap region               |  shared libs,
                        | [libc.so, mmap'd files,        |  big malloc,
                        |  large anonymous allocs]       |  thread stacks
                        +-------------------------------+
                        |               ^   (gap)       |
                        |               |               |
                        +-------------------------------+
                        |            HEAP               |  grows UP    ^
                        |   [small malloc via brk]      |
        program break-> +-------------------------------+
                        |            .bss               |  zero-init globals/statics
                        +-------------------------------+
                        |            .data              |  init'd globals/statics
                        +-------------------------------+
                        |           .rodata             |  const / literals
                        +-------------------------------+
                        |            .text              |  code (r-x, shared)
  ~0x0000_5555_5555_xxxx +-------------------------------+  (PIE load base, randomized)
                        |     (reserved / NULL page)    |  deref NULL -> segfault
  0x0000_0000_0000_0000 +-------------------------------+
  low addresses
```

The "gap" between the upward-growing heap and the downward-growing stack is the
free virtual range the mmap region grows into. The NULL page at the bottom is
deliberately unmapped so that dereferencing `nullptr` faults instead of silently
reading garbage.

## Where does each kind of variable live?

| Declaration | Lives in | Lifetime |
|---|---|---|
| `int g = 5;` (global, nonzero) | `.data` | whole program |
| `int g;` / `static int s;` (zero-init) | `.bss` | whole program |
| `const char* s = "hi";` (the `"hi"`) | `.rodata` | whole program |
| `int x;` inside a function | stack | the function call |
| `static int x;` inside a function | `.bss`/`.data` | whole program (init once) |
| `int* p = new int;` / `malloc` | heap (or mmap if large) | until `delete`/`free` |
| Code of every function | `.text` | whole program |
| Large `malloc` (≳128 KiB by default) | mmap region | until `free` |

## Seeing it with your own eyes

```cpp
#include <cstdio>
#include <cstdlib>

int   g_init = 42;          // .data
int   g_bss;                // .bss
const char* g_str = "lit";  // pointer in .data; "lit" in .rodata

void f() {
    static int s_local = 7; // .bss/.data, function-scope
    int local = 0;          // stack
    int* heap = new int(1); // heap

    std::printf("text  (f)        @ %p\n", (void*)&f);
    std::printf(".rodata (\"lit\")  @ %p\n", (void*)g_str);
    std::printf(".data (g_init)   @ %p\n", (void*)&g_init);
    std::printf(".bss  (g_bss)    @ %p\n", (void*)&g_bss);
    std::printf("static s_local   @ %p\n", (void*)&s_local);
    std::printf("heap             @ %p\n", (void*)heap);
    std::printf("stack (local)    @ %p\n", (void*)&local);
    delete heap;
}

int main() { f(); }
// Compile: g++ -O0 t.cpp && ./a.out
// You'll see text/rodata/data/bss clustered LOW, heap above them,
// and the stack address far HIGHER — exactly the map above.
```

To confirm against the kernel's own view, read the process's mapping table:

```cpp
// Dump this process's virtual memory map (segments, perms, backing file).
#include <cstdio>
int main() {
    char line[512];
    FILE* f = std::fopen("/proc/self/maps", "r");
    while (std::fgets(line, sizeof line, f)) std::fputs(line, stdout);
    std::fclose(f);
}
// Each line: start-end  perms  offset  dev  inode  path
//   555555554000-555555555000 r-xp ... /path/a.out   <- text
//   7ffff7d.. r-xp ... /usr/lib/libc.so.6            <- shared lib in mmap region
//   ...                          [heap]
//   ...                          [stack]
```

`/proc/self/maps` (see [`proc(5)`](https://man7.org/linux/man-pages/man5/proc.5.html))
is the authoritative answer to "what's mapped where, with what permissions."
`r-xp` = read/exec/private (code); `rw-p` = read/write/private (data, heap,
stack). A segfault is the MMU saying *this virtual address isn't mapped, or you
violated its permissions* — e.g. writing to `r-xp` text, or touching the NULL
page or an unmapped gap.

## How the heap and stack actually grow

- **Stack** grows down automatically: each call pushes a frame (return address,
  saved frame pointer, locals, spilled registers). The kernel maps stack pages
  on demand as you descend; overrun the limit (`ulimit -s`, often 8 MiB) and you
  get a **stack overflow** → SIGSEGV. Deep recursion or a giant `int buf[1<<22]`
  local blows it.
- **Heap** grows up via two mechanisms. Small requests bump the **program
  break** with `brk`/`sbrk(2)` (a single contiguous region). Large requests go
  straight to **`mmap(2)`** for an independent anonymous mapping that can be
  `munmap`'d back to the OS individually. glibc's `malloc` switches to `mmap`
  around `M_MMAP_THRESHOLD` (default ~128 KiB).

```c
#include <unistd.h>
#include <sys/mman.h>
void* small = sbrk(0);                 // current break; sbrk(n) moves it up
void* big   = mmap(NULL, 16*1024*1024, // 16 MiB anonymous mapping
                   PROT_READ|PROT_WRITE,
                   MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
```

## Arguments, environment, and ASLR

At process start the kernel places **`argv`** and the **environment** (`envp`) at
the very top of the stack, below the stack base. And by default Linux applies
**ASLR (Address Space Layout Randomization)**: the load addresses of the stack,
mmap region, heap, and (for a PIE binary) the text segment are randomized each
run, so the addresses your program prints change between runs. That's a security
feature (defeats hard-coded addresses in exploits) — and the reason you should
never assume a fixed layout. (`cat /proc/sys/kernel/randomize_va_space`;
disabling it is for debugging only.)

## Performance & hardware reality

- **Stack allocation is ~free.** Reserving locals is a single `sub rsp, N`; the
  pages are already mapped and hot in cache. Stack-allocate scratch in the hot
  path whenever you can.
- **First touch is a page fault.** A freshly `mmap`'d or BSS region has no
  physical frame yet; the first write triggers a **minor page fault** to map a
  zeroed page — *approx* a few µs each (see the virtual-memory lesson). Across a
  large buffer that's thousands of faults you don't want during trading.
- **`malloc` is not free.** It can take a lock, search free lists, and possibly
  `mmap` — variable latency, unacceptable in a hot loop. HFT systems
  pre-allocate arenas/object pools at startup and never call the general
  allocator on the critical path.
- **Layout drives cache behavior.** Hot fields packed together share cache lines
  (good — fewer lines touched); unrelated hot data on the same line causes
  **false sharing** between threads (bad). The address-space map decides which.

## Quant/HFT relevance & interview gotchas

- **Pre-fault and pin your arenas at startup.** Allocate the big buffers, then
  *touch every page* (write a byte per 4 KiB) so the minor faults happen during
  warm-up, not on the first market message. Pair with `mlockall` so they're
  never paged out (virtual-memory lesson).
- **Hugepages shrink the map's TLB footprint.** Backing a large arena with 2 MiB
  hugepages instead of 4 KiB pages means one TLB entry covers 512× the memory,
  so your working set fits in the TLB and you avoid page-walk stalls.
- **Globals/statics are shared by all threads** — they sit in one `.data`/`.bss`
  visible process-wide, so a mutable global needs synchronization. Stack and
  `thread_local` are per-thread and need none.
- **`reinterpret_cast` over a buffer** ignores the layout rules — alignment,
  padding, and the segment's permissions. Deserialize by value (see the
  endianness lesson).
- **Know the segfault taxonomy:** writing `.text`/`.rodata`, dereferencing NULL,
  running off a `munmap`'d region, or overflowing the stack — all SIGSEGV, all
  diagnosable from `/proc/self/maps` + the faulting address.
- **`fork` and the map:** the child gets a *copy* of the address space (lazily,
  copy-on-write), so a huge pre-allocated arena makes `fork` page-table setup
  expensive — a real gotcha addressed in the process-creation lesson.

## Key takeaways

1. A process gets a **private virtual address space** split into segments:
   text (r-x), rodata, data, **bss** (zero-fill, no file space), heap, mmap
   region, and stack.
2. **Heap grows up** (`brk`/`sbrk`, or `mmap` for large blocks); **stack grows
   down** (frames, locals); they grow toward the gap between them.
3. Variable placement is deterministic: globals→data/bss, literals→rodata,
   locals→stack, `new`/`malloc`→heap (or mmap if large), code→text.
4. **`/proc/self/maps`** is ground truth for what's mapped where with what
   permissions; a **segfault** is a violation of that map.
5. **ASLR** randomizes segment base addresses each run — never hard-code layout.
6. HFT performance is about *placement*: stack-allocate scratch, pre-fault and
   `mlock` arenas, back big buffers with hugepages, keep the allocator off the
   hot path.

## Self-check

1. Where do `static int x;` (file scope), `int* p = new int[1000];`, a string
   literal, and a function's local `int` each live? Which take space in the
   on-disk executable?
2. Why does BSS occupy no space in the executable file but does occupy memory at
   runtime?
3. The heap grows up and the stack grows down. What's in the gap between them,
   and what happens if either runs into it?
4. You print the address of a global twice across two runs and get different
   values. What feature explains this, and how would you disable it for
   debugging?
5. Why is a `malloc` in the hot path a latency risk, and what do HFT systems do
   instead?
6. Reading `/proc/self/maps`, you see a region marked `r-xp` backed by your
   binary. What is it, and what happens if your code writes to it?

## Further reading

- [`proc(5)` — man7.org](https://man7.org/linux/man-pages/man5/proc.5.html) — `/proc/self/maps`, `/proc/self/status`, smaps.
- [`mmap(2)` — man7.org](https://man7.org/linux/man-pages/man2/mmap.2.html) and [`brk(2)`/`sbrk(2)`](https://man7.org/linux/man-pages/man2/brk.2.html) — how the heap and mappings grow.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 9 (Virtual Memory) — the canonical address-space-map treatment.
- [Anatomy of a Program in Memory — Gustavo Duarte](https://manybutfinite.com/post/anatomy-of-a-program-in-memory/) — the best illustrated walkthrough of the Linux process layout.
- [`elf(5)` — man7.org](https://man7.org/linux/man-pages/man5/elf.5.html) — how sections in the ELF map to segments at load time.
- Robert Love, *Linux Kernel Development*, 3rd ed. — Ch. 15 (The Process Address Space, `mm_struct`, VMAs).

## Videos

- *CppCon* — **"Back to Basics: The Abstract Machine / Object Model"** ([search](https://www.youtube.com/results?search_query=CppCon+back+to+basics+memory+model+stack+heap)) — storage duration and where objects live.
- *Computerphile* — **"Stack vs Heap Memory"** ([search](https://www.youtube.com/results?search_query=computerphile+stack+vs+heap+memory)) — intuition for the two growing regions.
