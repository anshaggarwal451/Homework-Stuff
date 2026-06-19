# Memory-Mapped Files (mmap)

> **Why a quant dev must own this:** `mmap` is the hinge between the page cache,
> virtual memory, and zero-copy IPC. It lets two processes share the *same
> physical pages* so data written by one is instantly visible to the other with
> **no kernel copy and no syscall per access** — the foundation of
> shared-memory ring buffers. It also backs fast journal/log files and lets you
> pre-fault and lock memory so the hot path never takes a page fault. Mapping,
> page faults, and `MAP_SHARED` vs `MAP_PRIVATE` are perennial systems-interview
> material.

## First principles: mapping bytes into your address space

A normal `read()`/`write()` copies bytes between a kernel buffer (the **page
cache** for files) and your user buffer. `mmap` does something fundamentally
different: it installs entries in your process's **page tables** so that a range
of your virtual address space *is* the file's (or anonymous) pages. After that,
touching `addr[i]` is an ordinary memory access — the MMU translates it to the
backing physical page. No syscall, no copy on the access itself.

```text
   read()/write() model:            mmap() model:
   file pages (page cache)          file pages (page cache)
        |  copy                          ^   same physical page
        v                                |   (page-table entry points here)
   user buffer                      your virtual address range
```

The kernel does the mapping **lazily** via **demand paging**: `mmap` itself only
reserves the address range and records the mapping. The first access to each
page triggers a **page fault**; the fault handler finds (or reads in, for a
file) the backing page, wires up the page-table entry, and resumes you. So the
cost is amortized — cheap to map a huge region, you pay per page actually
touched.

## The `mmap` signature and the flags that matter

```c
void* mmap(void* addr, size_t length, int prot, int flags, int fd, off_t offset);
```

- `prot`: `PROT_READ | PROT_WRITE | PROT_EXEC` — page protections.
- `fd`/`offset`: the file and where in it to start (offset must be page-aligned).

The decisive flags:

| Flag | Meaning |
|---|---|
| `MAP_SHARED` | Writes go to the **backing file and are visible to other mappers** of the same file. **This is what makes mmap an IPC channel.** |
| `MAP_PRIVATE` | **Copy-on-write (COW)**: your writes create private copies; the file and other processes never see them. |
| `MAP_ANONYMOUS` | No file backing — zero-filled pages. With `MAP_SHARED` + `fork`, the parent and child share anonymous pages (a quick IPC trick). |
| `MAP_POPULATE` | **Pre-fault** the whole mapping at `mmap` time (read-ahead) so the first touch doesn't fault — great for warming up before the hot path. |
| `MAP_HUGETLB` | Back the mapping with **huge pages** (2 MiB/1 GiB) → far fewer TLB entries, fewer page faults for large regions. |
| `MAP_FIXED` | Place at exactly `addr` (dangerous; clobbers existing mappings). `MAP_FIXED_NOREPLACE` is the safe variant. |

`munmap(addr, length)` tears it down.

## File-backed shared memory as IPC

The killer use: **two processes `mmap` the same file with `MAP_SHARED`**. The
kernel maps both processes' page tables to the *same* page-cache pages. A store
by process A is, after cache coherence, simply visible to process B's loads.
There is no IPC copy and no syscall per message — only ordinary memory traffic.
This is the substrate for the shared-memory ring buffers in
[Lock-Free IPC Patterns](lock-free-ipc-patterns.md). (The POSIX-shm idiom in
[POSIX Shared Memory](posix-shared-memory.md) is the same mechanism with a tmpfs
backing and no on-disk persistence.)

### Compilable example: two processes share a counter via mmap

```cpp
// g++ -std=c++20 -O2 mmap_ipc.cpp -o mmap_ipc && ./mmap_ipc
#include <sys/mman.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <atomic>
#include <cstdio>
#include <cstring>

struct Shared {
    std::atomic<uint64_t> counter;   // atomics work across processes in shared mem
    char                  note[64];
};

int main() {
    const char* path = "/tmp/mmap_ipc.bin";
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0660);
    if (fd < 0) { perror("open"); return 1; }
    if (ftruncate(fd, sizeof(Shared)) < 0) { perror("ftruncate"); return 1; }

    // MAP_SHARED: writes are visible to every process mapping this file.
    void* p = mmap(nullptr, sizeof(Shared), PROT_READ | PROT_WRITE,
                   MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) { perror("mmap"); return 1; }
    close(fd);                          // mapping survives the fd being closed
    auto* s = new (p) Shared{};         // placement-new the layout into the page
    s->counter.store(0, std::memory_order_relaxed);

    pid_t pid = fork();                 // child inherits the SAME mapping
    if (pid == 0) {                     // ---- child: producer ----
        for (int i = 0; i < 1'000'000; ++i)
            s->counter.fetch_add(1, std::memory_order_relaxed);
        std::strcpy(s->note, "child done");
        _exit(0);
    } else {                            // ---- parent: observer ----
        wait(nullptr);
        printf("counter=%lu note='%s'\n",
               s->counter.load(std::memory_order_relaxed), s->note);
        munmap(p, sizeof(Shared));
    }
}
```

Two *unrelated* processes would each `open` + `mmap` the same `path` instead of
relying on `fork` inheritance — the mapping is to the file, not to the process.

## msync, madvise, and persistence

- **`msync(addr, len, MS_SYNC)`** flushes dirty `MAP_SHARED` pages back to the
  backing file on disk. With a file-backed mapping the data **persists** across
  process restarts (useful for journals / recovery). With tmpfs-backed
  [POSIX shm](posix-shared-memory.md) it does not — tmpfs lives in RAM.
- **`madvise`** hints the kernel's paging policy:
  - `MADV_WILLNEED` — start reading these pages in now (prefetch).
  - `MADV_SEQUENTIAL` — I'll scan linearly; aggressive read-ahead, drop behind.
  - `MADV_DONTNEED` — I'm done; you may drop these pages (frees RAM; **for
    `MAP_PRIVATE`/anonymous this discards the contents**).
  - `MADV_HUGEPAGE` — try to back with transparent huge pages.
- **`mlock`/`mlockall`** pins pages in RAM so they can't be paged out — combined
  with `MAP_POPULATE` it guarantees the hot path never takes a major page fault.

## mmap vs read/write

| Aspect | `read`/`write` | `mmap` |
|---|---|---|
| Copies | page cache ↔ user buffer (one copy/op) | none on access (page-table aliasing) |
| Syscall per op | yes | only on fault / `msync` / `madvise` |
| Random access | seek + read each time | pointer arithmetic, OS pages in on demand |
| Sharing between processes | no (separate buffers) | **yes** with `MAP_SHARED` |
| First-touch cost | in the `read` | **page fault** (mitigate with `MAP_POPULATE`) |
| Small frequent ops | fine | fault/TLB overhead can lose |

`mmap` wins for large files, random access, and shared memory; plain
`read`/`write` can win for short, streaming, sequential I/O where the per-fault
and TLB costs of mapping aren't amortized.

## Performance and hardware reality

- A **minor page fault** (page already in the page cache, just needs a PTE) costs
  on the order of **~1 µs**; a **major fault** (must read from disk) is dominated
  by storage latency (microseconds for NVMe, milliseconds for spinning rust). In
  a latency-sensitive process you eliminate faults from the hot path entirely
  with `MAP_POPULATE` + `mlock` during startup.
- Each mapped page consumes a **TLB entry**; touching many scattered pages causes
  TLB misses and page-walks. **Huge pages** (`MAP_HUGETLB`) shrink the number of
  TLB entries by ~512× (2 MiB pages) and slash page-walk overhead for large
  shared regions — a standard HFT tuning.
- After warm-up, accessing shared mmap'd data is **just a memory load/store** —
  tens of nanoseconds at worst, nothing if it's L1-resident. That is the whole
  point: **no kernel copy, no syscall** between the two processes.
- These are **order-of-magnitude** figures; the page-fault and TLB costs vary by
  CPU, kernel, and access pattern — profile your own.

## Quant/HFT relevance & interview gotchas

- **Shared-memory ring buffers** between a market-data distributor and strategy
  processes are `MAP_SHARED` mmaps (file or tmpfs). The data move is zero-copy;
  synchronization is via atomics/seqlocks in the mapped region — see
  [Lock-Free IPC Patterns](lock-free-ipc-patterns.md).
- **Pre-fault and pin** (`MAP_POPULATE` + `mlockall`) at startup so no page fault
  ever lands on the critical path. Saying this unprompted reads as experienced.
- **`MAP_SHARED` vs `MAP_PRIVATE`** is the question. Only `MAP_SHARED` is IPC;
  `MAP_PRIVATE` is COW and invisible to peers — a frequent confusion.
- **`ftruncate` before you map**, or stores past EOF raise `SIGBUS`. The file
  must be at least as large as the mapping.
- **The mapping outlives the fd** — you may `close(fd)` right after `mmap`.
- **mmap for journals:** append-style writes to a `MAP_SHARED` file with periodic
  `msync` give a fast, crash-recoverable log; huge pages and pre-fault keep the
  write path fault-free.
- **mmap is not synchronization.** Sharing pages does not order accesses; you
  still need atomics/fences (next two lessons) and you must respect cache-line
  layout to avoid false sharing.

## Key takeaways

1. `mmap` maps file or anonymous pages into your address space via **page-table
   entries**; access is an ordinary load/store with **no copy and no syscall**,
   paged in lazily by **demand paging** (page faults).
2. **`MAP_SHARED` is the IPC mechanism** — two processes mapping the same file
   share physical pages; **`MAP_PRIVATE` is copy-on-write** and private.
3. Use **`MAP_POPULATE`** to pre-fault, **`mlock`** to pin, and **`MAP_HUGETLB`**
   to cut TLB pressure — together they keep page faults off the hot path.
4. `msync` flushes `MAP_SHARED` dirty pages to disk (persistence for journals);
   `madvise` tunes paging (`WILLNEED`/`SEQUENTIAL`/`DONTNEED`).
5. `ftruncate` the file to size first or risk `SIGBUS`; the mapping survives
   `close(fd)`; mmap shares memory but does **not** synchronize it.

## Self-check

1. What does `mmap` actually do at call time, and when is the real cost paid?
2. Process A writes through a `MAP_PRIVATE` mapping; does process B see it? What
   about `MAP_SHARED`? Why?
3. Why might you map a file but get a `SIGBUS` when you write to it, and how do you
   prevent that?
4. How do `MAP_POPULATE` and `mlock` together protect a latency-critical loop, and
   when in the process lifecycle do you call them?
5. When would plain `read`/`write` beat `mmap`, and when does `mmap` clearly win?
6. Sharing pages via `MAP_SHARED` is not enough to safely pass messages between
   processes. What else is required?

## Further reading

- [`mmap(2)`](https://man7.org/linux/man-pages/man2/mmap.2.html) — every flag, `prot`, and the `SIGBUS`/alignment rules.
- [`madvise(2)`](https://man7.org/linux/man-pages/man2/madvise.2.html) and [`msync(2)`](https://man7.org/linux/man-pages/man2/msync.2.html) — paging hints and flushing dirty pages.
- [`mlock(2)`](https://man7.org/linux/man-pages/man2/mlock.2.html) — pinning pages in RAM to avoid faults.
- [Hugepages — Linux kernel docs](https://www.kernel.org/doc/html/latest/admin-guide/mm/hugetlbpage.html) and [Transparent Hugepage support](https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html).
- W. Richard Stevens, *Advanced Programming in the UNIX Environment* (APUE), §14.8 — memory-mapped I/O.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, ch. 9 — virtual memory, page tables, and memory mapping.

## Videos

- **Linux mmap and demand paging explained** ([search](https://www.youtube.com/results?search_query=linux+mmap+demand+paging+page+fault+explained)).
- **Shared memory with mmap MAP_SHARED between processes** ([search](https://www.youtube.com/results?search_query=mmap+MAP_SHARED+shared+memory+between+processes+linux)).
