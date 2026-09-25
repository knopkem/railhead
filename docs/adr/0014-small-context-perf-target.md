# Small-context perf target: 64k working budget, 16GB VRAM PC

> Amended by ADR 0047: the TDD test phase (the external oracle this ADR
> discusses) is retired with the fresh implementer; the durable session is the
> only builder.

## Context

The railhead's stated purpose is to run real software tasks on local models with small context windows. ADR 0001 names "~100k window of a local model" as the motivating constraint for the fresh-subprocess-per-phase design. That number was picked when the target hardware was vague. It is no longer vague, and the actual constraint turns out to be a *gradient*, not a wall.

Concrete target hardware: a 16GB-VRAM PC running a dense 27B model at Q4 (e.g. Qwen3.8 27B at Q3-XXS-heavy quantization with working tool-calling). On this hardware: q8 fits ~90k context in pure VRAM, turboquant fits ~130k. Throughput is ~20 tokens/sec at low fill, dropping to ~5 tokens/sec as the context approaches full. A 16GB integrated-memory MacBook M-series was considered and is *not* the target — shared memory and thermal constraints make the regime worse, not better, and the tool-calling reliability of small models there is the actual blocker, not VRAM size.

Two operating facts reframed what "small context" should mean in this railhead:

1. **The context budget is not a binary fit/no-fit limit.** It is a perf-vs-fill gradient. Every additional token held in working context slows every subsequent token's generation. The railhead's true optimization variable is *latency-to-completion per ticket*, not "fits within N tokens."

2. **The slowdown compounds across a phase, not just at the end.** A 50-step implementer phase that hits the slow band (5ts) at step 30 spends its last 20 steps at 4x lower throughput than its first 30. Shedding 5k tokens of working context *early* in the phase keeps the model in the fast band *longer*, which is worth more than the same 5k saved at the end. The marginal value of context discipline is not uniform across a phase.

This ADR records the *target* and the *principle the disciplines serve*. Specific railhead mechanisms that follow from it (small-module preference in AGENTS.md, sharper ticket granularity in the planner, bounded tool outputs, tiered model routing) are separate tickets derived from this target, not part of this decision.

## Decision

### Target

- **Hardware:** a 16GB-VRAM PC, GPU-only inference (no CPU offload).
- **Primary model class:** ~27B dense at Q4 (heavy quantization acceptable if tool-calling stays reliable).
- **Working context budget per phase: 64k tokens.** Picked as the operating point where the slowdown knee is hit only at phase-end (where the model is wrapping up), not mid-implementation (where it would slow down exactly when it most needs to be coherent).
- **Secondary target (not the goal, the floor):** a 9B Q4 model on *narrow* railhead seats only (contract extraction, learnings consolidation, structured-output passes with single I/O). 9B is not a target for the implementer or reviewer seats — its failure modes (instruction-following decay, multi-step going off-rail) make it unsuitable for judgment work, and pairing a 9B's recovery loops with the high-context slowdown is a multiplicative penalty.

### The principle

Every discipline this ADR justifies serves ONE goal: **minimize working-context size per phase**, not because of a capacity wall, but because of the slowdown gradient at high context fill. Concretely:

- Small modules / files: a worker reading one file holds fewer tokens, stays in the fast band longer.
- Small tickets: a phase that runs 10-15 productive steps spends less time at high context than a 50-step phase.
- Bounded tool outputs: a `cargo build` full stderr is easily 10k tokens; scoped reads (`tail -N`, `--stat`) shed that.
- Minimal prompt scaffolding: the implementer prompt's fixed costs (system prompt + AGENTS.md + CONTEXT.md + contracts + learnings + verify block) are paid on every step. Smaller fixed cost = more budget for productive work before the slowdown.
- Contracts slicing: a 20-ticket build's full `railhead.contracts.json` can be 5-10k tokens; slicing to the per-ticket relevant entries (`sliceContracts`) is not optional at this budget, it is required.

These are not independent disciplines bolted together — they are the same discipline (minimize working context to maximize throughput) expressed at different layers (write-time, plan-time, run-time, prompt-time).

### What this rules out

- **16GB MacBook M-series as a primary target.** Considered and dropped. Apple Silicon's shared memory and thermals put this regime below the threshold where 27B Q4 + useful context window is achievable at acceptable throughput. Future unification improvements may revisit; today, this is not the target.
- **9B Q4 as the implementer or reviewer seat.** Discussed and rejected. A 9B model's multi-step unreliability pairs badly with the slowdown gradient — error-prone work needs more steps, and each step slows as the context fills, so the failure loops cost more relative to a strong model that succeeds in fewer steps. 9B is reserved for seats that emit one structured response and exit (no recovery loop, no multi-step exploration).
- **Skipping the review pass to save the slowdown cost.** Considered and explicitly rejected. The Bevy upgrade run on Qwen 35B 4-bit-active surfaced hallucinated `[BLOCKER]` findings that burned 9 retries — that was the *bad* model case, not the target model case. With a 27B Q4 model, hallucinations drop substantially, and the latency cost of a review pass is acceptable *in exchange for* not having to invoke `railhead fix` manually on a broken run. The trade is explicit: wait longer on the automated run, get a good result; do not trade quality for speed here, because the recovery cost (manual fix rounds) is larger than the review cost.

### The ts-knee is empirical (open question)

The 64k figure is a planning target, not a measured knee — the actual inflection point of the ts-vs-fill curve on the target hardware has not been characterized. If measurement later shows the knee is at, e.g., 45k of a 90k q8 budget, the railhead's per-phase target should drop accordingly. The principle (minimize working context to stay in the fast band) does not change; only the budget number does.

### Request ceiling (amended, #81)

The 64k budget now carries a second, independent ground: **safety**. On a server with content-keyed KV retention (vLLM prefix cache, llama.cpp `--cache-reuse`, MTPLX's warm-prefix session bank), dead sessions' KV occupies the pool invisibly to every railhead-side ledger, and some engines abort under sustained pressure *before* their allocator wall. A request sized near the full nominal window therefore cannot survive a warm pool — headroom below raw capacity is load-bearing, not waste. The budget encodes the largest single request the railhead will ever send (prompt + output reserve) — a **request ceiling** — defaulting to **0.6× the model's nominal window**, not the server's capacity number. `max_context_tokens` is renamed `request_ceiling_tokens` (the legacy key is kept as an alias). The 64k-on-100k operating point now falls out of the fraction rule from this safety argument, reinforcing — not replacing — the throughput argument above.

## Consequences

- The railhead's claim "works on local models with small context" now has a concrete target audience: 16GB-VRAM PC owners running a ~27B Q4 dense model. Anything below that (16k-32k working budgets, ~9B models on judgment seats) is explicitly *not* supported.
- Every existing discipline in the codebase that currently serves "fits in 100k" is re-interpreted as serving "minimizes working context to keep ts high":
  - `boundedLog` in `run.ts`
  - `sliceContracts` per-ticket in `run.ts`
  - `LEARNINGS_CHAR_LIMIT = 2200` in `learnings.ts`
  - The "targeted reads/greps, don't read whole large files" line in `buildImplementerPrompt`
  - The "each ticket must fit in a single context window" rule in `plan.ts:85`
- New disciplines (small-module preference in `maybeGenerateAgentsMd`, sharper ticket granularity in `plan.ts`, more aggressive tool-output scoping) become tickets derived from this ADR, not part of it.
- 16GB M-series MacBook users are not turned away — the railhead will still run there on smaller models — but they are not the optimization target, and the railhead makes no guarantee that real software tasks complete successfully in that regime. The 32k-context question, raised and discussed, is answered: 32k is not the target. 64k is. 32k was considered a poor aim because at that budget the slowdown knee hits mid-phase, exactly when coherence is most needed.
- ADR 0001's "~100k window of a local model" framing is superseded by this ADR for design purposes. ADR 0001's *decision* (fresh subprocess per phase) is unchanged — fresh subprocess keeps the per-phase working context low, which serves this ADR's principle directly. The decision is reinforced, not weakened, by this target.
