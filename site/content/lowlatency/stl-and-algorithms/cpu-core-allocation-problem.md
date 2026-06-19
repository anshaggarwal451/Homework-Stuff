# CPU Core Allocation Problem

> **Why a quant dev must own this:** A trading box has a fixed, precious pool of
> isolated CPU cores. Deciding *which task runs on which core, and when a core
> frees up*, is the textbook **interval-scheduling / max-concurrency** problem in
> disguise — the same shape as "meeting rooms II". Recognising it instantly, and
> reaching for a **min-heap greedy** solution, is a common warm-up in HFT
> interviews; the framing (thread pinning, core isolation) is the real day job.

## Problem statement

You are given `n` tasks. Task `i` occupies a CPU core for a half-open time
interval `[start_i, end_i)` (a core it holds is busy from `start` up to, but not
including, `end`). Tasks that don't overlap in time can share the same core.

**Q1 — minimum cores:** What is the minimum number of cores needed so that every
task gets a core for its whole interval (no task is ever pre-empted)?

**Q2 — assignment:** Produce a concrete core index `[0, k)` for each task such
that no two tasks on the same core overlap.

This is exactly "minimum number of meeting rooms", "max concurrent intervals",
or — in our world — *"how many isolated cores do I need to pin all these
threads without contention?"*

## Clarifying constraints / assumptions

Senior move: pin down the contract before coding.

- **Half-open intervals.** A task ending at `t` and another starting at `t` can
  reuse the same core — they don't overlap. (Crucial tie-breaking detail; get
  it wrong and you over-allocate by one.)
- **Times** are integers (e.g. nanoseconds-since-midnight, or a discrete tick
  index). They can be large, so use 64-bit.
- **No pre-emption.** Once a task takes a core it keeps it until `end_i`.
- **Cores are interchangeable** for the counting question (Q1). For real thread
  pinning, cores are *not* interchangeable (NUMA node, hyperthread sibling,
  L3 slice) — we'll return to that in optimizations.
- `n` up to ~10^6 (a day of strategy tasks); answer fits in `int`.
- Empty input → 0 cores.

State these out loud. The half-open vs closed-interval question is the one
interviewers are listening for.

## Approaches and tradeoffs

### Approach 0 — brute force overlap count (don't ship this)

For each task, count how many others overlap it; the answer is the max. That is
O(n²) and tells you the count but not a clean assignment. Mentioned only to be
dismissed.

### Approach 1 — sort the two endpoint arrays (chronological sweep)

Split every interval into a `+1` event at `start` and a `-1` event at `end`.
Sort all `2n` events by time; sweep left to right keeping a running count of
"cores in use"; the peak running count is the answer.

The classic compact form: sort the `start` array and the `end` array
*separately*, then walk a two-pointer merge. When the next start is *before* the
earliest end, you need a new core (`++count`); otherwise a task finished, so
advance the end pointer (a core freed). Track the max.

- **Time:** O(n log n) for the two sorts. **Space:** O(n).
- Gives Q1 (the count) very cheaply, but **not** a per-task core assignment.

### Approach 2 — min-heap of release times (greedy, gives assignment)

Sort tasks by `start`. Keep a **min-heap keyed by `end` time** of the cores
currently in use. For each task in start order:

- If the heap's smallest `end` is `<= start_i`, that core has freed — pop it and
  reuse it. (`<=` because half-open.)
- Otherwise allocate a brand-new core.
- Push this task's `end` onto the heap.

The heap size at any moment is the number of cores in flight; its **maximum
size** is the answer to Q1, and the popped core index gives a concrete
assignment for Q2. This is the solution to reach for because it answers *both*
questions and generalises (priorities, heterogeneous cores).

- **Time:** O(n log n) — sort plus n heap ops. **Space:** O(k) heap, k = peak
  concurrency.

> **Mnemonic:** *Sort by start, free by end.* The heap always tells you the
> next core to come back.

## Complexity

| Approach | Time | Space | Gives count? | Gives assignment? |
|---|---|---|---|---|
| Brute overlap | O(n²) | O(1) | yes | no |
| Two sorted endpoint arrays | O(n log n) | O(n) | yes | no |
| Min-heap greedy | O(n log n) | O(k) | yes | **yes** |

The sort dominates. You cannot beat O(n log n) in the comparison model in
general, but if times are small bounded integers you can bucket/counting-sort
the events and get **O(n + range)** — worth raising.

## Complete, annotated reference implementation

C++ standard: **C++17** (compiles clean as C++20 too). Uses
`std::priority_queue` for the heap.

```cpp
#include <algorithm>
#include <cstdint>
#include <queue>
#include <vector>

struct Task {
    std::int64_t start;
    std::int64_t end;   // half-open: core busy on [start, end)
};

// ----- Q1: minimum number of cores (two-pointer sweep) -----------------------
int min_cores(std::vector<Task> tasks) {
    const std::size_t n = tasks.size();
    if (n == 0) return 0;

    std::vector<std::int64_t> starts(n), ends(n);
    for (std::size_t i = 0; i < n; ++i) {
        starts[i] = tasks[i].start;
        ends[i]   = tasks[i].end;
    }
    std::sort(starts.begin(), starts.end());
    std::sort(ends.begin(),   ends.end());

    int in_use = 0, peak = 0;
    std::size_t s = 0, e = 0;
    while (s < n) {
        // A core frees only when an end is <= the next start (half-open).
        if (starts[s] < ends[e]) {
            ++in_use;                 // overlap: need a fresh core
            peak = std::max(peak, in_use);
            ++s;
        } else {
            --in_use;                 // a task finished, core returns
            ++e;
        }
    }
    return peak;
}

// ----- Q2: concrete core assignment (min-heap greedy) ------------------------
// Returns assignment[i] = core index in [0, k) for tasks[i].
// k == the value min_cores() would return.
std::vector<int> assign_cores(std::vector<Task> tasks) {
    const std::size_t n = tasks.size();
    std::vector<int> assignment(n);
    if (n == 0) return assignment;

    // Process tasks in start order, but remember their original indices.
    std::vector<std::size_t> order(n);
    for (std::size_t i = 0; i < n; ++i) order[i] = i;
    std::sort(order.begin(), order.end(),
              [&](std::size_t a, std::size_t b) {
                  return tasks[a].start < tasks[b].start;
              });

    // Min-heap of (end_time, core_id) for cores currently busy.
    using Busy = std::pair<std::int64_t, int>;
    std::priority_queue<Busy, std::vector<Busy>, std::greater<Busy>> busy;

    int next_core = 0;                      // total cores ever allocated
    for (std::size_t idx : order) {
        const Task& t = tasks[idx];
        int core;
        if (!busy.empty() && busy.top().first <= t.start) {
            // Earliest-freeing core is available (<= because half-open).
            core = busy.top().second;
            busy.pop();
        } else {
            core = next_core++;             // must open a new core
        }
        assignment[idx] = core;
        busy.emplace(t.end, core);          // this core is busy until t.end
    }
    return assignment;                      // next_core == minimum cores needed
}
```

The two functions agree by construction: `assign_cores` opens a new core
exactly when no busy core has freed, which is precisely when the sweep in
`min_cores` increments the in-use count to a new peak.

### Worked trace

```text
tasks = [ [0,30), [5,10), [15,20) ]          (times in arbitrary units)

sort by start: same order
  t0 [0,30): heap empty            -> core 0 ; heap {30:0}
  t1 [5,10): top end 30 > 5        -> core 1 ; heap {10:1, 30:0}
  t2 [15,20): top end 10 <= 15     -> reuse core 1 ; heap {20:1, 30:0}

assignment = [0, 1, 1]    minimum cores = 2
```

Peak concurrency is 2 (t0 and t1 overlap on [5,10)); t2 reuses the core t1
released at 10.

## Low-latency optimizations

The interview answer above is O(n log n) and allocation-y. For a hot path you'd
tighten it:

- **Avoid `std::priority_queue` allocation.** It wraps a `std::vector` that
  heap-allocates and grows. Pre-`reserve` the underlying container, or pass your
  own pre-sized vector. The heap never exceeds `k` (peak concurrency), so size it
  once: `busy.reserve` via the container constructor. No per-push allocation, no
  cache-cold reallocs.
- **Small-k shortcut.** On a trading box `k` is tiny (you have maybe 8–32
  isolated cores). For `k` in that range a **linear scan over a flat array of
  release times** beats a heap: better branch prediction, contiguous, fits in
  one cache line, no log factor in practice. Heaps win only when `k` is large.
- **Counting-sort the events.** If `start`/`end` are bounded discrete ticks,
  replace the comparison sorts with bucket sort → **O(n + range)** and fully
  branch-predictable, linear memory access.
- **Structure-of-arrays.** Store `starts[]` and `ends[]` as separate contiguous
  arrays (as in `min_cores`) rather than an array of `Task` structs; the sweep
  then streams two cache-friendly arrays instead of striding over padded structs.
- **Branch-free sweep.** The `if (starts[s] < ends[e])` branch in the sweep is
  data-dependent and mispredicts ~50% of the time on adversarial input. You can
  fold it: `int adv = starts[s] < ends[e]; in_use += adv ? +1 : -1; s += adv; e += !adv;`
  and let the compiler emit `cmov`. Measure — for well-behaved inputs the plain
  branch predicts fine.

> The "minimum cores" *count* is computed once at startup when you plan your
> thread layout — latency there is irrelevant. The reason to know the fast
> variants is that the same interval/heap machinery shows up in genuinely hot
> paths: timer wheels, reservation systems, rate limiters.

## The HFT framing: this *is* thread-to-core pinning

The reason this problem is in an HFT syllabus: the "cores" abstraction maps
directly to how you lay out a trading process.

- A low-latency process **pins** each critical thread to a dedicated **isolated**
  core (`isolcpus`/`nohz_full` kernel boot params keep the scheduler and ticks
  off it). The feed handler, the strategy, and the order gateway each "occupy" a
  core the way a task occupies one here.
- Counting *minimum cores* is exactly capacity planning: "given these
  always-on threads plus these periodic jobs, how many isolated cores must I
  carve out?" Over-allocate and you waste a scarce resource and may straddle a
  NUMA boundary; under-allocate and two hot threads share a core and fight.

```cpp
// Pin the calling thread to a specific core (Linux). This is the "assignment".
#include <pthread.h>     // or <sched.h> for sched_setaffinity
#include <sched.h>

bool pin_to_core(int core_id) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(core_id, &set);
    // Pin the current thread; returns 0 on success.
    return sched_setaffinity(0, sizeof(set), &set) == 0;
}
```

The crucial twist versus the clean interview problem: **real cores are not
interchangeable.** Hyperthread siblings share execution units; cores share an
L3 slice; cross-NUMA access costs ~1.5–2x local. So `assign_cores` is only the
*start* — production pinning adds topology constraints (don't co-locate two hot
threads on sibling HTs, keep a thread on the NUMA node owning its NIC). That
turns the simple greedy into a constrained assignment, which is a great
follow-up to raise unprompted.

## Follow-up variations interviewers ask

- **"Just the count, fastest possible?"** → Two-sorted-arrays sweep; mention
  counting sort if times are bounded.
- **"Stream the intervals, can't sort all up front."** → If they arrive roughly
  in start order, keep the min-heap online and pop freed cores lazily. Truly
  unordered streaming needs a different structure (interval tree / segment tree
  for live "how many overlap *now*?").
- **"Weighted / priority cores."** → Tasks have priorities; high-priority tasks
  must get the 'best' (isolated, NUMA-local) cores. Now it's an assignment
  problem, not just a count — greedy by priority into a sorted core list.
- **"Pre-emption allowed."** → Changes everything; this becomes a real-time
  scheduling question (EDF / rate-monotonic). The no-pre-emption assumption is
  load-bearing.
- **"Maximum number of non-overlapping tasks one core can run."** → That's the
  *activity-selection* greedy (sort by `end`, take earliest finisher) — a
  different but neighbouring classic; be ready to distinguish the two.
- **"Report the busiest instant, not just the peak count."** → Augment the sweep
  to record the time `t` at which `in_use` hit its max.

## Key takeaways

1. "Minimum cores for overlapping intervals" is **meeting-rooms II** = max
   concurrent intervals. Recognise the shape immediately.
2. **Sort by start, free by end.** A **min-heap keyed on end time** gives both
   the minimum count *and* a concrete core assignment in O(n log n).
3. For *count only*, the two-sorted-endpoint-arrays two-pointer sweep is simpler
   and equally O(n log n).
4. **Half-open intervals**: a core that frees at `t` is reusable by a task
   starting at `t` (use `<=`). This off-by-one is the detail interviewers probe.
5. In HFT this is **capacity planning for core isolation and thread pinning** —
   and the real version is harder because cores aren't interchangeable (HT
   siblings, shared L3, NUMA).
6. Hot-path variants: pre-reserve the heap, linear scan when `k` is small,
   counting-sort bounded times, SoA layout, branch-free sweep.

## Self-check

1. Why must the heap comparison use `end <= start` rather than `end < start`?
   What changes if intervals are *closed* `[start, end]`?
2. Prove the greedy min-heap allocates a new core only when it is unavoidable
   (i.e. it is optimal).
3. The two-pointer sweep never advances `e` past `s`. Why can it ignore *which*
   task ended — only that one did?
4. You have 16 isolated cores but the greedy says you need 18. List two
   production options and the latency tradeoff of each.
5. Rewrite the count-only sweep branch-free with a `cmov`-friendly expression.
6. How would you extend `assign_cores` so two "hot" tasks are never placed on
   hyperthread-sibling cores?

## Further reading

- [`std::priority_queue` — cppreference](https://en.cppreference.com/w/cpp/container/priority_queue) and [`std::make_heap`/`push_heap`/`pop_heap`](https://en.cppreference.com/w/cpp/algorithm/make_heap) (roll your own flat heap).
- LeetCode 253 **Meeting Rooms II** — the canonical statement of this exact problem (greedy + heap).
- CLRS, *Introduction to Algorithms*, §16.1 — **activity-selection** greedy (the neighbouring "max tasks on one core" problem) and the exchange-argument proof technique.
- [Linux `sched_setaffinity(2)`](https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html) and [`cpuset(7)`](https://man7.org/linux/man-pages/man7/cpuset.7.html) — the real "core assignment" API.
- [Red Hat low-latency tuning guide — `isolcpus`, `nohz_full`, `tuned`](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux_for_real_time/) — why isolated cores are a finite resource you must plan.
- Erik Rigtorp, [**"Pinning threads to CPU cores"** and low-latency tuning notes](https://rigtorp.se/) — practical HFT-flavoured guidance.

## Videos

- CppCon — David Gross, **"Trading at Light Speed: Designing Low Latency Systems in C++"** ([search](https://www.youtube.com/results?search_query=CppCon+David+Gross+Trading+at+Light+Speed)) — covers core isolation and thread placement in real trading systems.
- CppCon — Carl Cook, **"When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — why you pin hot threads to isolated cores at all.
- *Back to Basics* — **"Algorithmic Complexity / Heaps & priority queues"** at CppCon ([search](https://www.youtube.com/results?search_query=CppCon+back+to+basics+heaps+priority+queue)) — refresher on the heap mechanics behind the greedy solution.
