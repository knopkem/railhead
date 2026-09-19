# Push-learnings: the worker emits the LEARNED: marker, the railhead parses it (supersedes ADR 0012)

## Context

ADR 0012 chose a **pull** model: the railhead runs a separate extraction model on phase transcripts after implement-retries and visual reviews. The reasoning was the railhead-orchestrates-agent-executes principle (ADR 0001) plus a stated worry that small models would be "fragile" at consistently emitting a push marker, and risked "wasting steps writing noise."

A prototype push path (`readLearnedMarkers`, `pushLearnings`) was added alongside pull to A/B compare. A real run on `/Users/macair/projects/sharpen3` (`run-20260826-1159`, the Bevy upgrade run) produced 5 reusable learnings: **5/5 from push, 0/5 from pull.** The reviewer (Qwen3.6-35B-A3B — exactly the small-model tier ADR 0012 worried about) emitted a clean `LEARNED: <fact>` marker on 5 of 5 review transcripts, exactly at end-of-message after `$OK`. No `LEARNED: NONE` compliance noise, no fabricated facts, no mid-narrative markers. All 5 dispatched into `learnings.md` correctly via `pushLearnings` → `mergeLearnings` → `appendLearnings`.

The pull path returned `NONE` on every implement-retry transcript it was given on the same run — its coverage gap is real, not hypothetical. The agent that did the work is the cheapest possible extractor of what was hard about the work; a second model reading a transcript after the fact recovers less.

## What this empirically refutes in ADR 0012

- ADR 0012:25 — "risks the agent wasting steps writing noise": **not observed.** The reviewer spent zero extra steps — the marker was emitted as part of its already-existing final wrap-up.
- ADR 0012:26 — "fragile with small models": **not observed** for the reviewer role on the very model class ADR 0012 named. The marker-on-its-own-line discipline parses cleanly with the lossy `readLearnedMarkers` parser.
- The premise that a second extraction call recovers more than the worker's own end-of-run marker: **refuted by the run's 0/5 pull coverage.**

## Decision

1. **`pushLearnings` is the default and only learning path.** The pull path (`extractLearnings`, `buildExtractionPrompt`) is retired. `readLearnedMarkers` is the single risk-bearing parser; the lossy discipline (line-start only, `NONE` sentinel, mid-sentence ignored, dedup against input order) is what makes the small-model emission trustworthy.

2. **`pushLearnings` runs after every implement, review, and visual phase** — not gated on retries. A fresh agent's own comprehension is the cheapest extractor, and a one-shot implement success can still surface a tooling fact (a port that isn't default, a command that needs a flag). The previous pull path's "attempt > 1 only" gating was a cost optimization for a call that no longer exists; the push parse is free.

3. **The implementer-side prompt wiring is fixed.** The prototype placed the `LEARNED:` instruction *after* the `DONE <files>` terminator. The implementer treats `DONE` as a hard stop (correctly per its existing prompt contract), so the marker instruction was unreachable. The `LEARNED:` block now sits **before** `DONE` in the implementer prompt, so the model emits it as part of its final wrap-up rather than after a terminator it never crosses.

4. **Consolidation uses `model.extract` (ADR 0015).** The merge-when-over-budget path was the one place the pull model's separate extraction call survived semantically. With pull retired, the consolidation model call moves to the new `model.extract` slot (9B-Q4 OK per ADR 0015) — a single-shot structured-output task, exactly the seat ADR 0015 reserves for small models. `mergeLearnings` resolves `model.extract ?? model.implement` so a config without `model.extract` still works.

## Considered Options

- **Retire pull outright** (chosen). The run's 0/5 pull coverage and 5/5 push coverage is decisive on n=1, and the architectural argument (the worker is the cheapest extractor of its own experience) holds regardless of n. Keeping a parallel canary path adds code surface and a second parser to maintain for a path that has produced zero learnings.
- **Canary-gate pull behind a config flag for A/B.** Considered and rejected: the comparison was already run, the result was 5/0, and a config flag preserves a code path nothing populates. The flag would be permanent cargo.
- **Keep both as defense in depth.** Rejected: the pull path's 0/5 is not "missed coverage at the edges," it is "misses everything." A defense-in-depth argument requires both paths to catch *some* distinct cases; here one catches none.

## What this does NOT decide

- **n>1 confirmation.** This ADR lands on n=1. The architectural argument (worker is cheapest extractor of its own experience) does not require more runs to hold; the empirical 5/0 is corroborating evidence, not the load-bearing reason. If future runs show push coverage collapsing on the implementer role specifically (the prototype wiring bug, now fixed, is the most likely past cause), this ADR's decision is the thing to revisit — but the wiring fix lands with this ADR, so a re-test starts from a correct prompt.
- **Learnings content quality.** Whether the 5 facts were *useful* is a separate question from whether push captured them. The consolidation path (model-driven dedup/trim) is unchanged and remains the quality sieve.
- **The char budget.** Unchanged from ADR 0012 (~2,200 chars). The budget bounds the per-phase prompt cost, not the extraction mechanism.

## Consequences

- `src/context/learnings.ts` loses `buildExtractionPrompt`; `readLearnedMarkers` is the single parser, with its existing lossy-parse tests as the risk-bearing coverage.
- `src/execute/run.ts` loses `extractLearnings` and its two gated call sites (the post-commit `attempt > 1` checks at the committed-ticket and soft-pass paths). `pushLearnings` already runs after every implement / review / visual phase and is now the only path.
- `src/context/prompt.ts` moves the `## Reusable tooling facts (push)` block to **before** `## Terse output`'s `DONE <files>` terminator in the implementer prompt. The reviewer prompt's marker placement (after `$OK`, the reviewer's own terminator) is unchanged — it already worked 5/5.
- `mergeLearnings` resolves `model.extract ?? model.implement` for its consolidation call. Per ADR 0015, users may now route the consolidation step to a 9B model; the default fallback stays `model.implement` for configs predating the `model.extract` slot.
- ADR 0012 is marked superseded by this ADR. ADR 0012's *shape decisions* (per-project file, `.railhead/learnings.md`, char budget, model-driven consolidation, injection as `## Project learnings`) are reaffirmed — only the *persistence mechanism* (pull → push) changes.
