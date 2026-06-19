# Process Creation and Lifecycle

> **Why a quant dev must own this:** You rarely `fork` in the hot path — but you
> *do* design the startup, supervision, and restart machinery that wraps every
> trading process, and you'll be asked how `fork`/`exec`/`wait` actually work.
> The subtle parts bite: `fork` copies the page tables (cost scales with mapped
> memory — a real gotcha for a process holding a huge pre-allocated arena),
> unreaped children become zombies, and a child that outlives a careless parent
> becomes an orphan. Getting the lifecycle right is the difference between a
> supervisor that self-heals and one that leaks PIDs until the box falls over.

## First principles: how a new process comes to exist

On Unix, you don't "create a process from a program" in one step. You **clone an
existing process** (`fork`) and then optionally **replace its program image**
(`exec`). Every process descends from `init`/`systemd` (PID 1) through this
fork-tree. The split is deliberate: between the fork and the exec, the child is a
copy of the parent and can adjust its environment (redirect file descriptors,
change directory, drop privileges) *before* the new program takes over. That's
exactly how a shell sets up pipes and redirections.

## `fork()` — duplicate the calling process

`fork()` creates a child that is a near-exact copy of the parent: same code,
same data, same open file descriptors, same instruction pointer. It returns
**twice**:

- in the **parent**, it returns the **child's PID** (> 0);
- in the **child**, it returns **0**;
- on failure, **-1** (no child created).

The child gets its own address space — but thanks to **copy-on-write (COW)** the
physical pages are shared read-only at first and copied only when one side
writes. So `fork` is cheap in data copying. What it is *not* free of is **page
table** duplication: the kernel must copy the parent's page-table mappings, and
that cost grows with how much memory the parent has mapped. (See below — the HFT
gotcha.)

```c
#include <unistd.h>
#include <stdio.h>
pid_t pid = fork();
if (pid < 0)        perror("fork");          // failed
else if (pid == 0)  /* child:  pid==0  */ ;  // child branch
else                /* parent: pid==child's PID */ ;
```

Open file descriptors are *shared* (they reference the same open file
description), so parent and child share file offsets — important when both write
to the same file or pipe.

## `exec` — replace the program image

The `exec*` family **replaces** the current process's memory image with a new
program. The PID stays the same; the text/data/heap/stack are thrown away and
rebuilt from the new executable. On success **`exec` does not return** (there's
nothing to return to — the old image is gone); it returns only on *failure*.

The variants differ in how you pass arguments and environment:

| Function | args as | env | path search |
|---|---|---|---|
| `execv` / `execvp` | array (`char* argv[]`) | inherited | `p` = search `$PATH` |
| `execl` / `execlp` | list (`"a","b",NULL`) | inherited | `p` = search `$PATH` |
| `execve` | array | explicit `envp` | no | 
| `execvpe` | array | explicit | yes |

`execve(2)` is the actual syscall; the rest are libc wrappers around it.

## The fork + exec + wait pattern (compilable)

This is the canonical "run a program and collect its exit status" — what a
supervisor does:

```c
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>

int run(const char* path, char* const argv[]) {
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return -1; }

    if (pid == 0) {
        // ----- CHILD: optionally redirect FDs / chdir / drop privs here -----
        execv(path, argv);          // replace image; returns ONLY on failure
        perror("execv");            // if we got here, exec failed
        _exit(127);                 // _exit, not exit: don't flush parent's buffers
    }

    // ----- PARENT: wait for the specific child and decode its status -----
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) { perror("waitpid"); return -1; }

    if (WIFEXITED(status))   printf("child exited, code=%d\n", WEXITSTATUS(status));
    else if (WIFSIGNALED(status)) printf("child killed by signal %d\n", WTERMSIG(status));
    return 0;
}

int main() {
    char* argv[] = { (char*)"/bin/echo", (char*)"hello from child", NULL };
    return run("/bin/echo", argv);
}
// Compile: cc fork_exec.c -o fe && ./fe   ->  prints "hello from child" then the exit code
```

Two details that interviewers probe: use **`_exit`** (not `exit`) in the child
after a failed `exec` so you don't flush stdio buffers the parent set up; and
prefer **`waitpid(pid, ...)`** over bare `wait()` when you care about a *specific*
child. The `WIFEXITED`/`WEXITSTATUS`/`WIFSIGNALED`/`WTERMSIG` macros decode the
packed status word.

## `vfork` and `posix_spawn`

- **`vfork`** is a historical optimization: it suspends the parent and shares its
  address space until the child `exec`s or `_exit`s — avoiding even the
  page-table copy. It's fragile (the child must do almost nothing before
  `exec`), and with COW the savings are mostly moot. Avoid in new code.
- **`posix_spawn`** is the modern, portable "do the fork+exec safely for me"
  call. It's implemented efficiently (often via `clone`/`vfork` internally) and
  lets you specify FD actions and attributes declaratively. **Prefer it** over
  hand-rolled `fork`+`exec` for launching helper processes.

## Reaping: zombies and orphans

When a child terminates, it doesn't fully disappear — the kernel keeps a minimal
record (its exit status) until the parent collects it with `wait`/`waitpid`.
Between exit and reaping, the child is a **zombie** (state `Z`): no memory, no
code, just a slot in the process table holding the status.

- **Zombie (`Z`):** dead-but-unreaped. Harmless individually, but a parent that
  never `wait`s leaks process-table slots — eventually you exhaust PIDs and can't
  fork. A leaking supervisor is a classic production outage.
- **Orphan:** a child whose parent died first. It gets **re-parented to PID 1**
  (init/systemd), which reaps it automatically. So orphans are self-cleaning;
  zombies are not.

The kernel notifies the parent of a child's death with **`SIGCHLD`**. A robust
supervisor installs a `SIGCHLD` handler (or uses `signalfd`/an event loop) and
calls `waitpid(-1, &status, WNOHANG)` in a loop to reap all dead children
without blocking.

## Process states

Linux's per-process state (visible as `ps`/`top`'s `STAT` column):

| State | Meaning |
|---|---|
| **R** | Running or runnable (on a run queue). |
| **S** | Interruptible sleep (waiting for an event; wakeable by signals). |
| **D** | Uninterruptible sleep (usually blocked in I/O; *cannot* be killed). |
| **T** | Stopped (e.g. by `SIGSTOP`, or under a debugger). |
| **Z** | Zombie (terminated, awaiting reaping by its parent). |

A `D`-state process stuck on bad I/O is unkillable and a known operational
headache; a pile of `Z` processes means a parent isn't reaping.

```text
  fork()        scheduled        blocks (I/O, lock)
  ------>  R  <-----------> R/S  <----------------- (event)
            \                                  \
             \  exec() replaces image           \  exit()/killed
              \                                   v
               \---------------------------->  Z (zombie)
                                                 |
                                                 | parent wait()s
                                                 v
                                              reaped / gone
```

## PID, PPID, and the process tree

Every process has a **PID** and a **PPID** (parent PID). `getpid()`/`getppid()`
report them; the tree is rooted at PID 1. After re-parenting, an orphan's PPID
becomes 1. (Recall from the threads lesson that on Linux a multithreaded
process shares one PID/TGID across its threads, each of which has a distinct
TID.)

## Daemonization (high level)

A traditional daemon detaches from its controlling terminal so it survives
logout: `fork` (parent exits, child continues in the background), `setsid` (new
session, no controlling TTY), optionally `fork` again, `chdir("/")`, reset
`umask`, and redirect stdin/stdout/stderr to `/dev/null`. In practice modern
deployments let **systemd** supervise the process directly instead of
hand-rolling this dance — systemd handles restart, logging, and reaping for you.

## Performance & hardware reality (approx)

- **`fork` cost scales with mapped memory.** The data pages are COW (cheap), but
  the kernel must duplicate the parent's **page tables**, and that work grows
  with the size of the parent's address space. *Approx*: hundreds of µs for a
  small process; substantially more for a process mapping many gigabytes —
  precisely the HFT gotcha of forking from a process holding a huge
  pre-allocated/hugepage arena.
- **`exec`** discards the image and faults in the new one on demand — its cost is
  dominated by loading and relocating the new binary and its shared libraries.
- **`posix_spawn`** is generally cheaper than `fork`+`exec` when you only intend
  to exec, because good implementations avoid duplicating the full page tables.

None of this belongs in a trading hot loop — process creation is a *startup and
supervision* concern, measured in microseconds-to-milliseconds, not nanoseconds.

## Quant/HFT relevance & interview gotchas

- **Don't `fork` in the hot path.** Process creation is orders of magnitude too
  slow and too jittery for the critical path. Spawn workers at startup; supervise
  and restart out-of-band.
- **The huge-arena `fork` trap:** a strategy process that pre-allocates a massive
  locked/hugepage arena pays a large page-table-copy cost (and risks COW fault
  storms) if it forks. If you must spawn helpers, do it *before* allocating the
  arena, or use `posix_spawn`, or use a tiny pre-forked launcher process.
- **`fork` in a multithreaded process is dangerous** — only the calling thread
  exists in the child; mutexes locked by other threads stay locked forever. The
  only safe move post-fork in a threaded program is to `exec` immediately. Avoid
  mixing threads and fork; use `posix_spawn`.
- **Always reap your children.** A supervisor that ignores `SIGCHLD` leaks
  zombies until PID exhaustion — a slow-motion outage. Use `waitpid(-1, …,
  WNOHANG)` in a loop, or `signalfd`, or let systemd be PID 1's helper.
- **Know the status macros** (`WIFEXITED`/`WEXITSTATUS`/`WIFSIGNALED`) and the
  `_exit`-vs-`exit` distinction in the child.
- **`vfork` is a legacy trap;** prefer `posix_spawn`.

## Key takeaways

1. New processes are made by **`fork`** (duplicate) then optionally **`exec`**
   (replace the image); the PID survives `exec`, and `fork` returns twice
   (child PID to parent, 0 to child).
2. `fork` uses **copy-on-write** for data pages, so it's cheap to copy — but it
   still **duplicates page tables**, a cost that **grows with mapped memory**.
3. **`exec` doesn't return on success**; the variants differ only in argument and
   environment passing (`execve` is the underlying syscall).
4. A terminated child is a **zombie** until its parent **`wait`/`waitpid`** reaps
   it; an **orphan** is re-parented to PID 1 and reaped automatically. The parent
   learns of death via **`SIGCHLD`**.
5. Process states: **R**unnable, **S**leeping, **D** (uninterruptible),
   **T**stopped, **Z**ombie.
6. HFT: never fork in the hot path; beware forking a huge-arena or multithreaded
   process; prefer **`posix_spawn`**; always reap.

## Self-check

1. What does `fork()` return in the parent, in the child, and on failure? How do
   you branch on it?
2. After a *successful* `exec`, why doesn't control return to the line after the
   call? What does it mean if `exec` *does* return?
3. What is a zombie process, what is an orphan, and which one cleans itself up —
   and how?
4. Why does `fork`'s cost grow with the parent's mapped memory even though data
   pages are copy-on-write? Why is this a gotcha for a process holding a large
   pre-allocated arena?
5. Why is calling `fork()` from a multithreaded process unsafe, and what's the
   one safe thing to do in the child afterward?
6. In a supervisor, what signal tells you a child died, and what's the
   non-blocking way to reap all dead children?

## Further reading

- [`fork(2)` — man7.org](https://man7.org/linux/man-pages/man2/fork.2.html), [`execve(2)`](https://man7.org/linux/man-pages/man2/execve.2.html), [`wait(2)`/`waitpid(2)`](https://man7.org/linux/man-pages/man2/wait.2.html).
- [`posix_spawn(3)` — man7.org](https://man7.org/linux/man-pages/man3/posix_spawn.3.html) and [`vfork(2)`](https://man7.org/linux/man-pages/man2/vfork.2.html) — the modern and the legacy alternatives.
- [`clone(2)` — man7.org](https://man7.org/linux/man-pages/man2/clone.2.html) — the common substrate under `fork` and thread creation.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 8 (Exceptional Control Flow) — fork/exec/wait and signals, the canonical treatment.
- Robert Love, *Linux Kernel Development*, 3rd ed. — Ch. 3 (Process Management): `do_fork`, COW, reaping.
- Maurice Bach, *The Design of the UNIX Operating System* — classic account of process creation and the fork/exec model.

## Videos

- *MIT 6.828 / OS lectures* — **"fork, exec, wait"** ([search](https://www.youtube.com/results?search_query=MIT+operating+systems+fork+exec+wait)) — a clean walk through the syscalls.
- *Computerphile* — **"fork() and the process tree"** ([search](https://www.youtube.com/results?search_query=computerphile+fork+process+unix)) — intuition for the fork-tree and zombies.
