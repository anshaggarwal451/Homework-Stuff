# Pipelined Processors and Instruction-Level Parallelism

> **Why a quant dev must own this:** A modern core can retire several
> instructions *per cycle* — but only if your code feeds it independent work. A
> tight hot loop full of dependent operations leaves most of that machinery
> idle, and you'll never see it in the instruction count. Understanding
> pipelining, latency-vs-throughput, and dependency chains is what lets you tell
> *why* a loop that "looks fine" runs at a quarter of the speed it should — and
> it's a staple HFT interview topic.

## First principles: a pipeline is an assembly line

A CPU instruction isn't done in one indivisible step. Executing one involves
several distinct phases. If the hardware insisted on finishing each instruction
entirely before starting the next, the expensive circuitry for each phase would
sit idle most of the time.

A **pipeline** splits instruction processing into stages and overlaps them, the
same way a car factory has many cars at different stations simultaneously. The
classic textbook **5-stage RISC pipeline** is:

```text
   IF        ID        EX        MEM        WB
 Fetch -> Decode -> Execute -> Memory -> Writeback

Cycle:   1    2    3    4    5    6    7
  I1:    IF   ID   EX   MEM  WB
  I2:         IF   ID   EX   MEM  WB
  I3:              IF   ID   EX   MEM  WB     <- 3 instructions
                                                "in flight" at once
```

Once the pipeline is full, **one instruction completes every cycle** even though
each individual instruction still takes 5 cycles end-to-end. That distinction —
how long *one* instruction takes vs how often *a new one finishes* — is the most
important idea in this whole lesson.

> **Real x86 is deeper.** Modern Intel/AMD cores have roughly **14–19+
> pipeline stages** (fetch, several decode stages, micro-op cache/queue, rename,
> schedule/dispatch, execute, retire). The 5-stage model is the right *mental*
> model; just know the real thing is far longer and more elaborate, which makes
> the costs below (especially branch misprediction) larger.

## Throughput vs latency: define them precisely

Two numbers describe every instruction, and confusing them is the classic
mistake:

- **Latency** — cycles from when an instruction's inputs are ready until its
  result is available to a *dependent* instruction.
- **Throughput** (often quoted as **reciprocal throughput**, cycles per
  instruction) — how many cycles must pass before you can issue *another*
  instruction of the same kind. A reciprocal throughput of **0.5** means the
  core can start **two per cycle**.

These differ because the core is **pipelined** and **superscalar**: even though
one multiply takes several cycles to *complete*, the multiplier unit can accept a
*new, independent* multiply almost every cycle.

Approximate figures for a modern x86 core (use Agner Fog's instruction tables
for exact per-microarchitecture values — these are typical/approximate):

| Operation | Approx latency (cycles) | Approx reciprocal throughput | Comment |
|-----------|------------------------:|-----------------------------:|---------|
| `ADD`/`SUB`/`AND` (reg) | 1 | ~0.25–0.5 | Several per cycle; the cheap workhorse |
| `LEA` (simple) | 1 | ~0.5 | Address arithmetic, very cheap |
| Integer `IMUL` (64-bit) | ~3 | ~1 | Fully pipelined but multi-cycle latency |
| `MULSD`/`MULPD` (FP mul) | ~4 | ~0.5 | Pipelined: high throughput despite latency |
| `ADDSD` (FP add) | ~4 | ~0.5 | Same shape as FP mul |
| `DIVSD` (FP divide) | ~13–20 | ~4–8 | **Not** fully pipelined; serializes |
| Integer `DIV` | ~20–90 | high | Very slow; avoid in hot loops |
| L1 load | ~4–5 | ~0.5 | Two loads/cycle on many cores |

> **The headline:** an `ADD` and a `MULSD` differ hugely in *latency* (1 vs ~4)
> but both have *high throughput*. `DIV` is the outlier — both slow *and* poorly
> pipelined, so it stalls everything behind it. "Avoid divides in hot loops"
> falls straight out of this table.

## What breaks the assembly line: hazards

A pipeline only hits one-per-cycle if every instruction can keep marching. Three
kinds of **hazard** force the hardware to insert a **stall** (also called a
**bubble** — a wasted cycle):

- **Structural hazard:** two instructions need the same hardware unit in the
  same cycle (e.g. only one divider). One waits.
- **Data hazard:** an instruction needs the *result* of an instruction still in
  flight. This is the dominant one for hot-loop performance.
- **Control hazard:** a branch — the fetch stage doesn't yet know which
  instruction comes next.

### Data hazards and forwarding/bypassing

The naive pipeline would stall a dependent instruction until its input is
written back (the WB stage). That's wasteful, so hardware adds **forwarding**
(a.k.a. **bypassing**): the result is routed directly from the EX/MEM output
back into a later instruction's EX input, *before* it's written to the register
file.

```text
  I1:  add  rax, rbx      ; result ready at end of EX
  I2:  add  rcx, rax      ; needs rax in its EX
          ^ forwarding sends I1's EX output straight into I2's EX
            input -> no stall for a 1-cycle-latency op.
```

Forwarding eliminates stalls for back-to-back **1-cycle** ops. But it cannot
conjure a result that doesn't exist yet: if I1 is a **load** that misses to L2,
or a **multiply** with 4-cycle latency, I2 must wait those cycles regardless.
That waiting is the essence of a **dependency chain** limiting performance.

### Control hazards and branch prediction

When the core hits a conditional branch, it doesn't know whether to fetch the
taken or not-taken path until the branch resolves — potentially many cycles
later. Rather than stall, the **branch predictor** guesses and the core
**speculatively** executes down the predicted path.

- **Correct prediction:** essentially free; the pipeline never drains.
- **Misprediction:** the speculative work is squashed and the pipeline refills
  from the correct target — a penalty of roughly **the pipeline depth**, on the
  order of **~15–20 cycles** on modern x86.

Predictors are very good (often >95%) on regular patterns. They struggle with
**data-dependent, unpredictable** branches — exactly the kind that appear in
order-matching logic. This motivates **branchless** code in hot paths (we'll
cover that and prediction in depth in their own lessons; the takeaway here is
*why* a mispredict is expensive: it's a near-full pipeline flush).

## Superscalar and out-of-order: more than one lane

Two more dimensions multiply the pipeline's throughput:

- **Superscalar:** the core has **multiple execution ports** and can issue
  several instructions per cycle. A modern core is roughly **4–6 wide** — it can
  retire that many micro-ops per cycle *if* it can find that many independent
  ones. The simultaneous use of these ports is **Instruction-Level Parallelism
  (ILP)**.
- **Out-of-order (OoO) execution:** the core doesn't execute in program order.
  It **renames** registers to remove false dependencies, buffers many in-flight
  instructions in a reservation station / reorder buffer, and executes whichever
  ones have their inputs ready — then *retires* them in order to preserve
  correct architectural state. This lets it run *ahead* of a stalled load and
  find independent work to fill the gap (memory-level parallelism).

OoO and renaming are a deep topic with their own advanced lesson — here, treat
them as "the hardware will reorder and parallelize aggressively **as long as you
give it independent instructions**." The whole game of writing fast hot loops is
*supplying that independence*.

## The crux: dependency chains limit ILP

Here is the single most important demonstration in this lesson. Consider summing
an array two ways. Both do the same `N` additions; one is several times faster.

```cpp
#include <cstddef>

// SLOW: one accumulator -> a single dependency chain.
// Each += depends on the previous +=. FP add latency ~4 cycles,
// so iterations are serialized ~4 cycles apart regardless of how
// many add units exist. ILP = ~0.
double sum_serial(const double* a, std::size_t n) {
    double s = 0.0;
    for (std::size_t i = 0; i < n; ++i)
        s += a[i];          // s_{i} depends on s_{i-1}
    return s;
}

// FAST: four independent accumulators -> four independent chains.
// Each chain still has 4-cycle latency, but four of them run
// overlapped, hiding the latency. ILP ~4x, near throughput-bound.
double sum_unrolled(const double* a, std::size_t n) {
    double s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    std::size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        s0 += a[i + 0];     // four chains, no dependency
        s1 += a[i + 1];     // between them -> the core can have
        s2 += a[i + 2];     // ~4 adds in flight at once
        s3 += a[i + 3];
    }
    double s = (s0 + s1) + (s2 + s3);
    for (; i < n; ++i) s += a[i];   // tail
    return s;
}
```

Why the gap? In `sum_serial`, iteration *i*+1 cannot start its add until
iteration *i*'s add **completes** — they form one **loop-carried dependency**
chain. With FP-add latency ~4 cycles, the loop is fundamentally limited to one
add every ~4 cycles, **no matter how many adder ports exist**. The expensive
superscalar/OoO machinery is starved.

`sum_unrolled` breaks the single chain into four independent ones. Now four adds
can be in flight simultaneously; the loop runs near the *throughput* limit
(reciprocal throughput ~0.5), roughly **4× faster** on the addition, until you
hit some other bound (load throughput, memory bandwidth).

> **The principle:** performance of a hot loop is bounded by the **latency of
> its longest loop-carried dependency chain**, *not* by instruction count. To go
> faster, **shorten or parallelize the chain.** This is why we unroll with
> multiple accumulators, and why FP reductions are reassociated (which is also
> why `-ffast-math` / `-Ofast` is needed to let the compiler do it — strict IEEE
> ordering forbids the reassociation that creates the independence).

### Seeing the dependency in the assembly

The serial version produces a single accumulator with a tight read-modify-write
dependency:

```x86asm
.loop:
    addsd   xmm0, [rdi+rax*8]   ; xmm0 = xmm0 + a[i]  -- xmm0 depends on
                                ;   the previous addsd's result
    add     rax, 1
    cmp     rax, rcx
    jne     .loop               ; throughput limited by addsd LATENCY (~4)
```

The unrolled version uses several independent destination registers
(`xmm0..xmm3`), so the `addsd`s have no inter-dependency and the scheduler issues
them in parallel — limited by addsd *throughput*, not latency. (With
vectorization enabled the compiler will additionally pack 2–8 doubles per SIMD
register, multiplying throughput again — a related but separate axis from ILP.)

## A second flavour: independent vs dependent arithmetic

The same effect appears without loops. These two snippets have identical
operation counts:

```cpp
// Dependent chain: each multiply feeds the next. Latency-bound:
// total ~ 3 * mul_latency.
double chain(double x) { return ((x * x) * x) * x; }

// Independent products combined at the end: the two inner muls
// run in parallel. Total latency is shorter (one fewer level of
// dependency) -> exploits ILP.
double tree(double x) { double a = x * x; double b = x * x; return a * b; }
```

Reassociating a computation into a **balanced tree** of independent sub-results
shortens the critical path from *O(N)* to *O(log N)* dependent steps — the
compiler does this for you under fast-math, and you do it by hand when it can't.

## Quant/HFT relevance & interview gotchas

- **Count the dependency chain, not the instructions.** "This loop has 6
  instructions, why is it slow?" — because 5 of them sit on a 4-cycle-latency
  loop-carried chain. Reason in terms of the **critical path**.
- **Unroll with multiple accumulators** for reductions (sum, dot product, min)
  to expose ILP; the compiler often won't for floating point unless you allow
  reassociation (`-ffast-math`/`-Ofast`) because it changes results.
- **Avoid `DIV` and other long, poorly-pipelined ops in hot loops.** Multiply by
  a reciprocal computed once outside the loop; replace `x / c` with `x * (1/c)`
  when correctness allows.
- **Unpredictable branches are expensive** (~full pipeline flush, ~15–20
  cycles). In matching/decision hot paths, prefer branchless formulations
  (`cmov`, masks, table lookups) for *data-dependent* conditions. (Branch
  prediction has its own lesson.)
- **Latency vs throughput is a classic interview question.** Be ready to explain
  why a fully-pipelined multiplier with 4-cycle latency can still sustain ~2
  multiplies/cycle, and when each number matters (latency for dependent code,
  throughput for independent/parallel code).
- **Use the right tool to confirm it:** `llvm-mca` and Intel's IACA/uiCA model
  the pipeline and report the critical path and port pressure of a loop; `perf
  stat` gives IPC (instructions per cycle) and mispredict/stall counters. Quoting
  IPC and "we were latency-bound on the accumulator chain" in an interview is
  gold.
- **Don't over-unroll.** Past the point where you've saturated the relevant
  execution ports (or run out of registers, causing spills), more unrolling just
  bloats code and hurts the I-cache.

## Key takeaways

1. A pipeline overlaps instruction **stages** (classic 5: IF/ID/EX/MEM/WB; real
   x86 is ~14–19+), so one instruction can finish per cycle even though each
   takes several cycles end-to-end.
2. **Latency** (when a result is ready for a dependent op) and **throughput**
   (how often you can issue another) are different numbers; pipelining and
   superscalar execution make throughput far higher than 1/latency.
3. **Hazards** stall the pipeline: **structural**, **data** (mitigated by
   **forwarding/bypassing**), and **control** (mitigated by **branch
   prediction**; a mispredict costs ~the pipeline depth, ~15–20 cycles).
4. **Superscalar + out-of-order** cores execute multiple independent
   instructions per cycle — that's **ILP** — but only if you supply independent
   work.
5. A hot loop is bounded by the **latency of its longest loop-carried dependency
   chain**, not its instruction count. **Break the chain** (multiple
   accumulators, balanced trees) to expose ILP.
6. Cheap/fully-pipelined: `ADD`, `LEA`, FP `mul`/`add`. Expensive/serializing:
   `DIV`. Use Agner Fog's tables for exact latency/throughput.

## Self-check

1. A floating-point add has ~4-cycle latency and ~0.5 reciprocal throughput.
   What is the maximum sustained rate of a loop with **one** accumulator? With
   **four independent** accumulators? Explain the difference.
2. Define *latency* and *reciprocal throughput*. How can a multiplier have
   4-cycle latency yet sustain two multiplies per cycle?
3. What is forwarding/bypassing, and which kind of hazard does it address? Name a
   case where forwarding still can't prevent a stall.
4. Roughly how many cycles does a branch misprediction cost on a modern x86 core,
   and why is that number tied to pipeline depth?
5. Rewrite `double r = ((a + b) + c) + d;` to shorten its dependency chain, and
   explain why a compiler may refuse to do this transformation for you.
6. Why is `DIVSD` singled out as "avoid in hot loops" when `MULSD` of similar
   latency is fine?

## Further reading

- [Agner Fog — Optimization manuals & instruction tables](https://www.agner.org/optimize/) — `instruction_tables.pdf` (per-instruction latency/throughput) and `microarchitecture.pdf` (pipelines, ports, OoO). The reference.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 4 (Processor Architecture) and §5.7–5.9 (pipelining, dependency chains, and the "Get-A-Bound" critical-path analysis).
- [Instruction pipelining — Wikipedia](https://en.wikipedia.org/wiki/Instruction_pipelining) and [Instruction-level parallelism — Wikipedia](https://en.wikipedia.org/wiki/Instruction-level_parallelism).
- [Classic RISC pipeline — Wikipedia](https://en.wikipedia.org/wiki/Classic_RISC_pipeline) — the 5-stage model, hazards, and forwarding in detail.
- Intel® 64 and IA-32 Architectures [Optimization Reference Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) — front-end, ports, and scheduling for real microarchitectures.
- [`llvm-mca` — LLVM Machine Code Analyzer docs](https://llvm.org/docs/CommandGuide/llvm-mca.html) — model a loop's critical path and port pressure.
- [uiCA / uops.info](https://uops.info/) — measured port usage, latency, and throughput for x86 instructions.
- [`perf stat` — man7 / Linux perf wiki](https://perf.wiki.kernel.org/index.php/Tutorial) — read IPC and stall/mispredict counters on real runs.

## Videos

- Matt Godbolt — **"What Has My Compiler Done for Me Lately?"** ([search](https://www.youtube.com/results?search_query=Matt+Godbolt+what+has+my+compiler+done+for+me+lately)) — seeing pipelines, vectorization, and dependency chains in the assembly.
- Chandler Carruth — **"Efficiency with Algorithms, Performance with Data Structures"** ([search](https://www.youtube.com/results?search_query=Chandler+Carruth+efficiency+with+algorithms+performance+with+data+structures)) — how the machine actually executes your hot loops.
- Computerphile — **"Pipelining"** ([search](https://www.youtube.com/results?search_query=computerphile+CPU+pipelining)) — clear introductory intuition for the staged pipeline and hazards.
