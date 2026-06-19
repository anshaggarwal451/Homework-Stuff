# CPU Registers and Assembly Instructions

> **Why a quant dev must own this:** When a hot path is too slow, the source
> code stops being the truth — the **disassembly** is. *To know whether your
> branch became a `CMOV`, whether a call got inlined, whether a `double` is
> sitting in `xmm0` or spilling to the stack, you have to read x86-64 assembly.*
> You don't need to write it, but you must be fluent enough to look at Compiler
> Explorer output and explain what the CPU is actually doing — and that fluency
> is routinely probed in HFT interviews.

## First principles: registers are the CPU's scratch space

Memory is far away (a load from L1 is ~4-5 cycles, from DRAM ~100ns / hundreds
of cycles — see the cache-hierarchy lesson). **Registers are on the core,
zero-latency to access, and there are very few of them.** Almost every
instruction reads its operands from registers and writes its result to a
register. The compiler's central job is *register allocation*: keeping the
values you're actively using in registers and "spilling" the rest to the stack.

When you see `mov` instructions shuffling between registers and memory in a hot
loop, you're watching the cost of running out of registers. Knowing the register
file tells you what the compiler had to work with.

## The x86-64 general-purpose register file

There are 16 general-purpose registers (GPRs), each 64 bits. Eight have historic
names; eight are numbered `r8`-`r15`. Each can be addressed at 64/32/16/8 bits,
and the sub-register names are a frequent source of confusion:

| 64-bit | 32-bit | 16-bit | 8-bit (low) | Conventional role (System V) |
|--------|--------|--------|-------------|------------------------------|
| `rax` | `eax` | `ax` | `al` | return value; accumulator |
| `rbx` | `ebx` | `bx` | `bl` | callee-saved |
| `rcx` | `ecx` | `cx` | `cl` | 4th integer arg |
| `rdx` | `edx` | `dx` | `dl` | 3rd integer arg; high half of mul/div |
| `rsi` | `esi` | `si` | `sil` | 2nd integer arg |
| `rdi` | `edi` | `di` | `dil` | 1st integer arg |
| `rbp` | `ebp` | `bp` | `bpl` | frame pointer (callee-saved) |
| `rsp` | `esp` | `sp` | `spl` | **stack pointer** |
| `r8`-`r15` | `r8d`… | `r8w`… | `r8b`… | args 5-6 (`r8`,`r9`); rest scratch |

Plus two you don't name directly but always matter:

- **`rip`** — the **instruction pointer**: address of the next instruction.
  x86-64 supports *RIP-relative addressing* (`lea rax, [rip + sym]`), which is
  how position-independent code reaches globals.
- **`rflags`** — the **flags register**: a bundle of status bits set by
  arithmetic/compare instructions. The ones you'll read about constantly:
  **ZF** (zero), **SF** (sign), **CF** (carry, unsigned overflow), **OF**
  (signed overflow), **PF** (parity). `cmp`/`test`/`add` write them; `jz`,
  `jg`, `cmovne`, `setl` read them.

> **The 32-bit zeroing gotcha:** writing a 32-bit sub-register **zeros the upper
> 32 bits** of the 64-bit register. Writing an 8- or 16-bit sub-register does
> **not** — it merges, creating a partial-register dependency the CPU dislikes.
> This is why compilers emit `xor eax, eax` (not `xor rax, rax`) to zero a
> register, and `mov eax, 5` rather than `mov rax, 5`: the 32-bit form is
> shorter and clears the top half for free.

## SIMD / floating-point registers

Scalar floating point on x86-64 lives in the **SSE/AVX register file**, not the
old x87 stack. These are wide vector registers, and a scalar `double` just
occupies the low lane:

| Name | Width | Introduced | Notes |
|------|-------|-----------|-------|
| `xmm0`-`xmm15` | 128-bit | SSE/SSE2 | scalar `float`/`double` use the low 32/64 bits; `xmm0` returns FP values |
| `ymm0`-`ymm15` | 256-bit | AVX/AVX2 | `xmm` is the low half of `ymm` |
| `zmm0`-`zmm31` | 512-bit | AVX-512 | 32 of them; `xmm`/`ymm` are the low halves |

So `addsd xmm0, xmm1` is "add scalar double", and `addpd`/`vaddpd` is the packed
(vector) form doing 2/4/8 doubles at once. When you read pricing-math
disassembly, scalar FP shows up as `xmm` registers with `*sd`/`*ss` (scalar
double/single) mnemonics; auto-vectorized loops show `ymm`/`zmm` with `*pd`/`*ps`
(packed). Mixing legacy SSE and AVX without `vzeroupper` can incur a state-
transition penalty — another Agner-Fog-level detail.

## The instruction classes you must recognise

You don't need the whole ISA. About a dozen mnemonics cover the vast majority of
integer hot-path code:

| Class | Examples | What it does |
|-------|----------|--------------|
| **Data movement** | `mov`, `movzx`, `movsx`, `lea` | copy / zero-extend / sign-extend; `lea` computes an address (and abused for arithmetic) |
| **Arithmetic/logic** | `add`, `sub`, `imul`, `and`, `or`, `xor`, `shl`, `sar` | the ALU ops; set `rflags` |
| **Compare/test** | `cmp`, `test` | subtract / AND but discard result, keep only flags |
| **Conditional move** | `cmovz`, `cmovg`, … | branchless select based on flags |
| **Branches** | `jmp`, `je`/`jz`, `jne`, `jg`, `jl`, … | unconditional / conditional jumps |
| **Calls** | `call`, `ret` | push return address / pop it; transfer control |
| **Stack** | `push`, `pop` | adjust `rsp` and move a word to/from the stack |
| **Set byte** | `setz`, `setl`, … | materialise a flag into a 0/1 byte |

Two are worth dwelling on:

- **`lea` (load effective address)** computes `base + index*scale + disp`
  *without touching memory*. Compilers love it for arithmetic:
  `lea eax, [rdi + rdi*2]` is `x*3` in one fast instruction, no multiply.
- **`cmp` + conditional jump** is how every `if`/loop compiles when the compiler
  chooses a branch; **`cmp` + `cmov`** is the branchless alternative (ties back
  to the bitwise lesson's branchless theme).

## AT&T vs Intel syntax — read both

The same instruction is written two ways. You will meet both (GCC/`objdump`
default to AT&T; Compiler Explorer and Intel docs use Intel).

```text
Intel:  mov  rax, rbx        ; dest, src  — rax = rbx
        add  rax, 8          ; rax += 8
        mov  rax, [rbx + 8]  ; load from memory at rbx+8

AT&T:   movq %rbx, %rax      # src, dest  — note REVERSED operands
        addq $8, %rax        # immediates get $, registers get %
        movq 8(%rbx), %rax   # memory is disp(base,index,scale)
```

Differences to memorise: **AT&T reverses operand order** (src, dst), prefixes
registers with `%` and immediates with `$`, and suffixes the mnemonic with the
operand size (`q`=8, `l`=4, `w`=2, `b`=1 bytes). This page uses Intel syntax
(`-masm=intel` in GCC/Clang) because it's cleaner; just know which you're
looking at.

## The System V AMD64 calling convention

This is the ABI on Linux/macOS, and "how are arguments passed?" is a near-
guaranteed interview question. The rules:

**Integer/pointer arguments** go in, in order:

```text
arg1=rdi  arg2=rsi  arg3=rdx  arg4=rcx  arg5=r8  arg6=r9
```

beyond six, on the stack (pushed right-to-left). **Floating-point arguments** go
in `xmm0`-`xmm7`. **Return values**: integer/pointer in `rax` (and `rdx` for the
high 64 of a 128-bit return); floating-point in `xmm0`.

**Register preservation** — who must save what across a `call`:

| Saved by | Registers | Meaning |
|----------|-----------|---------|
| **Caller-saved** (volatile) | `rax, rcx, rdx, rsi, rdi, r8-r11`, all `xmm` | a `call` may clobber them; save before calling if you need them after |
| **Callee-saved** (non-volatile) | `rbx, rbp, r12-r15`, `rsp` | a function must restore them before returning |

The stack must be **16-byte aligned** at a `call` (so it's 8 off, i.e. the
return address makes it 16-aligned, when control enters a function). A
mis-aligned stack crashes SSE code that assumes alignment — a classic "why does
it segfault only with `-O2`" bug. (Windows uses a different convention — the
Microsoft x64 ABI: args in `rcx, rdx, r8, r9`, different callee-saved set.)

## A worked example: read the assembly

A tiny function and its (Intel-syntax) output at `-O2`:

```cpp
// sum of an array, classic reduction
long sum(const long* a, int n) {
    long s = 0;
    for (int i = 0; i < n; ++i)
        s += a[i];
    return s;
}
```

```x86asm
sum(long const*, int):
        test    esi, esi          ; n == 0 ?  (esi = arg2 = n)
        jle     .empty            ; if n <= 0, skip the loop
        mov     eax, esi          ; eax = n  (loop trip count setup)
        xor     edx, edx          ; edx = i = 0   (xor zeroes & is cheap)
        xor     ecx, ecx          ; ecx = s = 0   (caller-saved scratch)
.loop:
        add     rcx, [rdi + rdx*8]; s += a[i]   (rdi=arg1=a, rdx*8 indexes longs)
        inc     rdx               ; ++i
        cmp     rax, rdx          ; i < n ?
        jne     .loop
        mov     rax, rcx          ; return value goes in rax
        ret
.empty:
        xor     eax, eax          ; return 0
        ret
```

What to *read out of this*, the way you would in an interview:

- `a` arrived in **`rdi`**, `n` in **`esi`** (the 32-bit `int` sub-register) —
  textbook System V.
- The return is built in `rcx` (a scratch register) and moved to **`rax`** at
  the end — the return register.
- `[rdi + rdx*8]` is the **scaled-index addressing mode**: base `a` + `i`*8
  (8 = `sizeof(long)`), one instruction for the address *and* the load.
- `xor eax, eax` is the idiomatic, cheapest way to produce 0.
- No `xmm` registers because everything is integer; you'd see them the moment a
  `double` entered.

> If you'd written this with `double`, the accumulator would live in `xmm0`, the
> loop body would be `addsd xmm0, [rdi + rdx*8]`, and the compiler would
> *refuse* to vectorize the reduction unless you allow reassociation
> (`-ffast-math`) because FP addition isn't associative — a great thing to know
> and explain.

## Reading hot-path disassembly: a practical checklist

When you drop a hot function into [Compiler Explorer (godbolt.org)](https://godbolt.org)
at `-O2`/`-O3`, scan for:

1. **Did it inline?** A `call` to a small helper in the hot loop is a missed
   inline — look for `inline`/LTO or why it failed.
2. **Branch or `cmov`?** A `jne`/`jg` in an unpredictable spot is a
   misprediction risk (~15-20 cycle penalty). `cmovX` is branchless.
3. **Did it vectorize?** `ymm`/`zmm` with `*pd`/`*ps` = good; scalar `*sd` in a
   loop = not vectorized.
4. **Spills?** Lots of `mov [rsp+…], reg` / `mov reg, [rsp+…]` inside the loop =
   register pressure; the value couldn't stay in a register.
5. **Strength reduction?** `imul`/`idiv` replaced by `lea`, shifts, and
   multiply-by-reciprocal. Division (`idiv`, ~20-40+ cycles) is the slow one to
   hunt for.
6. **Memory ops per iteration** — each is a potential cache miss; fewer is
   better.

## Latency intuition (approx, modern Intel/AMD)

Never invent benchmark numbers, but these well-known rough figures frame what
you're reading:

| Operation | Approx cost |
|-----------|-------------|
| Register-to-register `mov`, `add`, `and`, `lea` | ~1 cycle, several per cycle |
| `imul` (integer multiply) | ~3 cycles |
| `idiv` (integer divide) | ~20-40+ cycles, *not* pipelined |
| Correctly predicted branch | ~0-1 cycle |
| **Mispredicted** branch | ~15-20 cycle penalty |
| L1 load | ~4-5 cycles |
| `call`/`ret` (predicted) | ~1-2 cycles + the callee |

The takeaways for hot code: avoid division, avoid unpredictable branches, keep
working set in registers/L1. (Detailed per-instruction tables live in Agner
Fog's manuals and Intel's optimization guide.)

## Quant/HFT relevance & interview gotchas

- **You will be asked to read assembly.** A common live exercise: "here's a
  function and its godbolt output — walk me through it." Practise naming the arg
  registers, the return register, the addressing mode, and whether a branch
  became a `cmov`.
- **Calling convention** ("which register holds the 3rd argument?" → `rdx`;
  "where's the float return?" → `xmm0`; "what's callee-saved?" → `rbx, rbp,
  r12-r15`) is rote knowledge they expect.
- **`lea` for arithmetic** and **`xor reg, reg` to zero** are the two idioms
  that confuse beginners reading disassembly — recognise them instantly.
- **Inlining** is the single biggest hot-path lever; reading asm is how you
  confirm it happened. A surprise `call` in your inner loop is a red flag.
- **`vzeroupper` / AVX-SSE transition penalties**, **partial-register stalls**,
  and the **`POPCNT` false dependency** are senior-level details that signal you
  read Agner Fog.
- **`rdtsc` / `rdtscp`** is how low-latency code timestamps with cycle
  granularity — expect it to come up when discussing measurement (and the
  serialization caveats around it).
- **Watch the sub-register zeroing rule**: `mov eax, …` clears `rax`'s top half;
  8/16-bit writes don't and cause partial-register dependencies.

## Key takeaways

1. x86-64 has 16 64-bit GPRs (`rax`-`r15`) addressable at 64/32/16/8 bits, plus
   `rip`, `rsp`, and `rflags`; writing a **32-bit sub-register zeroes the upper
   32 bits** (hence `xor eax, eax`).
2. Scalar and vector FP live in `xmm`/`ymm`/`zmm`; scalar `double` uses the low
   lane of `xmm` (`addsd`), packed math uses `*pd`/`*ps`.
3. The dozen instruction classes — `mov`/`lea`, ALU ops, `cmp`/`test`, `cmov`,
   jumps, `call`/`ret`, `push`/`pop` — cover most hot-path code; `lea` does
   address math (and arithmetic), `cmp`+`cmov` is the branchless `if`.
4. **System V AMD64**: integer args `rdi, rsi, rdx, rcx, r8, r9`; FP args
   `xmm0-7`; return in `rax`/`xmm0`; callee-saved `rbx, rbp, r12-r15`; 16-byte
   stack alignment at `call`. (Windows differs.)
5. Read disassembly at `-O2` on godbolt: check inlining, branch-vs-`cmov`,
   vectorization, spills, and division. The compiled code, not the source, is
   the truth in a hot path.

## Self-check

1. In which registers do the 1st, 3rd, and 6th integer arguments arrive under
   System V AMD64? Where does an integer return value go? A `double` return?
2. Why do compilers emit `xor eax, eax` instead of `mov eax, 0`, and why the
   32-bit form rather than `xor rax, rax`?
3. What does `lea rax, [rdi + rdi*4]` compute, and why is it preferred over a
   multiply?
4. In AT&T syntax, what does `movq 16(%rsp), %rax` do? Rewrite it in Intel
   syntax.
5. You see `addsd xmm0, [rdi + rdx*8]` in a loop. What types and what kind of
   operation is this, and why might the compiler not have vectorized it?
6. Which registers are callee-saved, and what bug appears if the stack isn't
   16-byte aligned at a `call`?

## Further reading

- [System V AMD64 ABI](https://gitlab.com/x86-psABIs/x86-64-ABI) (PDF) — the authoritative calling-convention document; also the readable [OSDev: System V ABI](https://wiki.osdev.org/System_V_ABI).
- [Intel 64 and IA-32 Architectures Software Developer Manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) — Vol. 1 (basic architecture/registers) and Vol. 2 (instruction set reference).
- Agner Fog, [**optimization manuals & instruction tables**](https://www.agner.org/optimize/) — latencies/throughput, partial-register stalls, AVX-SSE transitions, the `POPCNT` false dependency.
- [Compiler Explorer (godbolt.org)](https://godbolt.org) — paste C++, read the asm; the single most useful tool for this topic.
- Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*, Ch. 3 (machine-level representation of programs) — the canonical teaching treatment of x86-64.
- [x86 calling conventions — Wikipedia](https://en.wikipedia.org/wiki/X86_calling_conventions) and [x86-64 — Wikipedia](https://en.wikipedia.org/wiki/X86-64) for the register-file overview.
- [`objdump`/`gdb` x86 AT&T vs Intel syntax](https://sourceware.org/binutils/docs/as/i386_002dSyntax.html) — GNU `as` syntax reference.

## Videos

- Matt Godbolt — **"What Has My Compiler Done for Me Lately? Unbolting the Compiler's Lid"** (CppCon) ([search](https://www.youtube.com/results?search_query=Matt+Godbolt+what+has+my+compiler+done+for+me+lately)) — the definitive "how to read your compiler's assembly" talk.
- Chandler Carruth — **"Understanding Compiler Optimization"** / **"Tuning C++"** (CppCon) ([search](https://www.youtube.com/results?search_query=Chandler+Carruth+tuning+C%2B%2B+understanding+compiler+optimization)).
- Carl Cook — **"When a Microsecond Is an Eternity: High Performance Trading Systems in C++"** (CppCon) ([search](https://www.youtube.com/results?search_query=CppCon+Carl+Cook+when+a+microsecond+is+an+eternity)) — hot-path asm reading in a trading context.
