# Branch Prediction

> **Why a quant dev must own this:** A modern x86 core fetches and decodes
> instructions ~15-20 stages *ahead* of where it retires them. At every
> conditional branch the CPU must guess which way to go before it knows the
> answer. Guess right and the branch is essentially free; guess wrong and you
> flush the pipeline and eat ~15-20 cycles of nothing. In an HFT hot path that
> processes a market-data message in a few hundred nanoseconds, a single
> data-dependent mispredict per message can dominate your tail latency. Knowing
> when to *help* the predictor and when to *eliminate* the branch is a core HFT
> skill — and a perennial interview topic.

## First principles: why a pipeline needs to guess

A CPU does not execute one instruction at a time to completion. It overlaps
them in a **pipeline**: while instruction *N* is executing, *N+1* is being
decoded and *N+2* is being fetched. (See the sibling lesson on pipelining and
out-of-order execution.) To keep the front-end fed, the CPU must know the
address of the *next* instruction every single cycle.

For straight-line code that's trivial — it's the next address. But a
conditional branch (`if`, loop back-edge, `switch`, virtual call) makes the next
address depend on a comparison whose result may not be known for many cycles
(the condition might depend on a load that's still missing in cache). The CPU
cannot afford to stall and wait; the pipeline would drain.

So it **predicts**: it guesses the branch direction (taken / not-taken) and, for
taken branches, the target address, then speculatively fetches and executes down
that path. When the branch finally resolves:

- **Correct prediction:** the speculative work is committed. The branch cost
  essentially nothing — close to zero cycles of bubble.
- **Misprediction:** all the speculative instructions are squashed, the pipeline
  is flushed, and fetch restarts at the correct address. On modern x86 the
  penalty is roughly **15-20 cycles** (approx — it's the depth from fetch to the
  point the branch resolves).

```text
   correct prediction              misprediction
   ┌───────────────────┐           ┌───────────────────┐
   F D X X X ...        │           F D X . . (resolve) │  <- discovers wrong path
     F D X X X ...      │             F D X . . (squash) │  <- these are thrown away
       F D X X X ...    │               F D . . (squash) │
   full speed           │           ~15-20 cycle bubble, refetch correct path
   └───────────────────┘           └───────────────────┘
```

## Static vs dynamic prediction

**Static prediction** uses fixed heuristics with no runtime state. Classic rules:
backward branches are predicted taken (they're usually loop back-edges),
forward branches not-taken. Compilers can also emit hints based on
`__builtin_expect` / `[[likely]]`. Modern Intel/AMD cores largely *ignore*
static hints in hardware and rely on dynamic prediction, but the compiler still
uses the information to lay out code so the *predicted* path is the fall-through
(better I-cache locality).

**Dynamic prediction** learns from history at runtime. This is where the real
machinery lives.

### The 2-bit saturating counter

The foundational dynamic predictor. Each branch gets a 2-bit state that
saturates at the ends:

```text
   00            01            10            11
 Strongly      Weakly        Weakly       Strongly
 Not-Taken --> Not-Taken --> Taken   -->  Taken
   ^  taken-->     taken-->     taken-->     |
   |<--not-taken <--not-taken <--not-taken<-+
 predict NT    predict NT    predict T    predict T
```

The point of *two* bits (vs one) is hysteresis: a single anomalous outcome
(e.g. the one iteration that exits a loop) doesn't flip the prediction. A loop
that runs 1000 times mispredicts exactly **once** (on exit) instead of twice.

### BHT, BTB, and history-based predictors

Real cores combine several structures:

- **BHT (Branch History Table):** a table of 2-bit counters indexed by (part of)
  the branch instruction's address. Predicts *direction*.
- **BTB (Branch Target Buffer):** caches the *target address* of taken branches,
  indexed by branch PC, so the front-end can redirect fetch in the same cycle it
  recognizes a branch — before decode even finishes. Crucial for **indirect**
  branches (function pointers, virtual calls, jump tables).
- **Global history (GHR):** a shift register of the last *N* branch outcomes.
  Many branches correlate with *other* recent branches (`if (a) ... if (a&&b)`),
  so indexing the counter table by `PC XOR global_history` (a "gshare"-style
  predictor) captures that correlation.
- **Local history:** per-branch history of *that* branch's own recent pattern —
  great for short repeating patterns (`T N T N T N`).

### TAGE — the state of the art (mention)

Modern high-performance cores use **TAGE** (TAgged GEometric history length)
predictors: several tables indexed by *geometrically increasing* history lengths,
each tagged so the predictor can pick the longest history that has a confident
match, falling back to shorter histories otherwise. TAGE-style predictors achieve
well over 99% accuracy on typical code. You don't implement these — but knowing
the name and the idea (multiple history lengths, longest confident match wins)
is exactly the kind of detail that signals depth in an interview.

## The famous "sorted array" experiment

The canonical demonstration (the most-upvoted question in Stack Overflow history,
"Why is processing a sorted array faster than processing an unsorted array?"):

```cpp
#include <algorithm>
#include <cstdint>

long sum_above_threshold(int* data, std::size_t n) {
    long sum = 0;
    for (std::size_t i = 0; i < n; ++i) {
        if (data[i] >= 128)   // <-- the data-dependent branch
            sum += data[i];
    }
    return sum;
}
```

Fill `data` with random bytes (0-255), run the loop, and time it. Then `std::sort`
the array first and run the *identical* loop. The sorted version can be several
times faster — even though it does the same arithmetic and the sort isn't timed.

Why? On the **sorted** array the branch is `false` for a long run (all the small
values), then `true` for a long run. The predictor nails it: a handful of
mispredicts at the transition. On the **unsorted** array the branch is
essentially a coin flip per element — ~50% misprediction, and each mispredict
costs ~15-20 cycles. The branch's *predictability*, not its presence, is what
matters.

> **Interview gold:** the lesson isn't "sort your data." It's "**data-dependent
> branches on unpredictable data are expensive — so make them predictable or
> remove them.**"

## Branchless programming: cmov, masking, table lookup

If a branch is inherently unpredictable, the cure is often to delete it. The
loop above can be written *without* a control-flow branch so there's nothing to
mispredict:

```cpp
// Branchless: the conditional add becomes a data dependency, not control flow.
long sum_branchless(int* data, std::size_t n) {
    long sum = 0;
    for (std::size_t i = 0; i < n; ++i) {
        int v = data[i];
        // mask is 0 or -1 (all ones); add v only when v >= 128
        long mask = -(long)(v >= 128);
        sum += v & mask;
    }
    return sum;
}
```

Compilers frequently turn a small `if`-with-assignment into a **`cmov`**
(conditional move) — a single instruction that selects between two values with
*no* control-flow branch and therefore no misprediction:

```cpp
int select(bool c, int a, int b) { return c ? a : b; }
```

```x86asm
; clang/gcc -O2 typically emits:
select(bool, int, int):
    test    edi, edi        ; c == 0 ?
    mov     eax, edx        ; eax = b
    cmovne  eax, esi        ; if c != 0, eax = a   <-- no branch, no mispredict
    ret
```

Contrast the branchy version, which the predictor can mispredict:

```x86asm
; the same logic with a real branch
    test    edi, edi
    je      .Lb
    mov     eax, esi        ; a
    ret
.Lb:
    mov     eax, edx        ; b
    ret
```

**The trade-off:** `cmov` has *no* misprediction penalty but it always computes
*both* sides and adds a data dependency (the result can't be used until the
condition and both inputs are ready — roughly 1-2 cycles latency). A *well-predicted*
branch can be faster than `cmov` because the CPU speculates straight past it. So:

- **Predictable branch** (>~95% one way) → keep the branch; speculation hides it.
- **Unpredictable branch** (data-dependent, ~50/50) → go branchless (`cmov`,
  masking, arithmetic, or a lookup table).

Other branchless tools: **bit masking** (as above), **table lookup** (replace a
`switch` with an indexed array), and `std::clamp`/`std::min`/`std::max` which
typically lower to `min`/`max`/`cmov` instructions.

## Telling the compiler what you know

```cpp
// GCC/Clang builtin (works pre-C++20):
if (__builtin_expect(error_code != 0, 0)) {   // 0 == "expect false / unlikely"
    handle_error();
}

// C++20 attributes — clearer, standard:
if (price <= 0) [[unlikely]] {
    reject();
} else [[likely]] {
    process();
}
```

These do **not** override the hardware predictor's runtime learning. What they do
is guide **code layout**: the compiler puts the likely path on the fall-through
and hoists the unlikely path (error handling, slow paths) out of the hot
instruction stream, improving I-cache density and keeping the front-end on the
common path. Use them on genuinely lopsided branches (error checks, rare
conditions) — and *measure*, because a wrong hint hurts.

**Profile-guided optimization (PGO)** is the systematic version: build with
instrumentation, run a representative workload, rebuild feeding the profile back
(`-fprofile-generate` / `-fprofile-use` on GCC/Clang). The compiler then lays out
every branch and function based on *measured* behavior. PGO is one of the
highest-leverage, lowest-effort wins for a latency-sensitive binary and is
standard practice in production HFT builds.

## Indirect branches and virtual calls

A `virtual` call, a function pointer, or a `switch` compiled to a jump table is an
**indirect branch** — the target is a runtime value. The BTB predicts the target;
if the call site jumps to the *same* target repeatedly (monomorphic), prediction
is excellent. If the target varies unpredictably (megamorphic — many derived
types in random order), the BTB mispredicts and you pay the flush plus often an
extra cache miss to load the vtable/code.

In HFT this is why hot dispatch paths frequently avoid `virtual`: prefer
`if/switch` on a small enum, CRTP (static polymorphism), `std::variant` +
`std::visit`, or template specialization, so the target is statically known and
there's no indirect-branch prediction to get wrong.

## Performance & hardware reality (approx)

| Event | Approx cost | Notes |
|---|---|---|
| Correctly predicted branch | ~0-1 cycle | speculation hides it; throughput ~1-2 branches/cycle |
| Mispredicted branch | **~15-20 cycles** | full front-end flush + refetch on modern x86 |
| `cmov` / `min` / `max` | ~1-2 cycle latency | branchless, never mispredicts, computes both sides |
| Predictor accuracy on typical code | >99% | TAGE-class predictors |

Measure it with `perf`:

```text
perf stat -e branches,branch-misses ./your_program
# branch-misses / branches gives the misprediction rate; watch the hot loop.
perf record -e branch-misses ./your_program && perf report  # find the culprit
```

## Quant/HFT relevance & interview gotchas

- **Tail latency is the enemy.** A branch that's 99.9% predictable still
  mispredicts on the 0.1% — which is often *exactly the rare event you care about*
  (a wide quote, a cross, an error). The mispredict adds to the path you can least
  afford. Profile branch-misses on the hot path, not just average time.
- **Don't branch on the market data; branch on structure.** Branches that depend
  on prices/quantities are unpredictable. Branches that depend on message *type*
  (a small set, often repeating) predict well. Restructure so unpredictable
  decisions become branchless arithmetic.
- **`cmov` is not always a win.** A classic interview trap: "is branchless always
  faster?" No — a highly predictable branch beats `cmov` because the CPU
  speculates through it for free, while `cmov` serializes on its inputs. Answer:
  *it depends on predictability; measure.*
- **Branch hints don't change hardware prediction**, only code layout. Saying
  `[[likely]]` "tells the CPU which way to go" is wrong.
- **Spectre connection (high level):** branch prediction is what makes
  speculative execution possible, and speculative execution past a mispredicted
  bounds-check is the basis of Spectre v1. Mitigations (retpolines, `lfence`
  speculation barriers) constrain prediction and can cost performance — worth
  knowing exists. (See the out-of-order execution lesson.)
- **Virtual calls in hot loops** are a red flag: unpredictable indirect target +
  vtable load. Know the static-polymorphism alternatives.

## Key takeaways

1. Deep pipelines must **guess** branch direction and target before resolution; a
   wrong guess flushes the pipeline (~15-20 cycles approx).
2. Dynamic predictors use **2-bit saturating counters** indexed via the **BHT**,
   target caches (**BTB**), and **global/local history**; the state of the art is
   **TAGE** (>99% accuracy).
3. Cost scales with **(un)predictability**, not branch count — the sorted-array
   experiment is the canonical proof.
4. For **predictable** branches, keep them — speculation makes them free. For
   **unpredictable** ones, go **branchless**: `cmov`, masking, lookup tables.
5. `__builtin_expect` / `[[likely]]`/`[[unlikely]]` and **PGO** influence *code
   layout*, not hardware learning. Avoid unpredictable **indirect/virtual**
   branches in hot paths.

## Self-check

1. Why does a loop with a 2-bit saturating counter mispredict only once over 1000
   iterations, while a 1-bit predictor mispredicts twice?
2. The sorted-array loop is faster *even though sorting isn't timed*. Explain in
   terms of misprediction rate, and state the actual lesson.
3. Give a concrete case where a `cmov`-based branchless version is *slower* than
   the branchy version. What property of the branch decides this?
4. What does `[[unlikely]]` actually change in the generated code? What does it
   *not* change?
5. Why are megamorphic virtual calls expensive, and name two static-polymorphism
   techniques to avoid them.

## Further reading

- Stack Overflow — [**"Why is processing a sorted array faster than processing an unsorted array?"**](https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array) — the canonical demonstration, with great answers.
- Agner Fog, [**The microarchitecture of Intel, AMD and VIA CPUs**](https://www.agner.org/optimize/microarchitecture.pdf) — branch prediction sections per microarchitecture; and [Optimizing software in C++](https://www.agner.org/optimize/optimizing_cpp.pdf).
- Wikipedia — [Branch predictor](https://en.wikipedia.org/wiki/Branch_predictor) — solid overview of counters, BHT/BTB, gshare, TAGE.
- [`[[likely]]` / `[[unlikely]]` — cppreference](https://en.cppreference.com/w/cpp/language/attributes/likely) and the GCC manual on [`__builtin_expect`](https://gcc.gnu.org/onlinedocs/gcc/Other-Builtins.html).
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, §3.6.6 (implementing conditional branches, `cmov`) and §5.x (pipelining).
- [GCC PGO docs](https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html) (`-fprofile-generate`/`-fprofile-use`) — profile-guided branch layout.
- [uops.info](https://uops.info/) — per-microarchitecture latency/throughput for `cmov`, branches, and friends.

## Videos

- *Computerphile* — **"Branch Prediction"** ([search](https://www.youtube.com/results?search_query=computerphile+branch+prediction)) — clean intuition for the pipeline-guessing idea.
- CppCon — **Chandler Carruth, "Efficiency with Algorithms, Performance with Data Structures"** ([search](https://www.youtube.com/results?search_query=CppCon+Chandler+Carruth+efficiency+with+algorithms+performance+with+data+structures)) — touches branch behavior and why branchless/data-oriented code wins.
- CppCon — **Carl Cook, "When a Microsecond Is an Eternity"** ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — HFT hot-path techniques including branch avoidance.
