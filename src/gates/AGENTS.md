# src/gates — review gates and the corrective pipeline

Everything that judges a ticket after implementation: the shared review-agent runner and verdict parsing, the retry-budget machine, the visual/goal/structural loops and their checkpoint scheduling, evidence checks, owed-gate replay, corrective tickets, and mid-run replan.

## Seams

- `reviewer.ts` — `runReviewAgent`, `parseVerdict`, severity classification (`classifySeverity`, `isBlocker`), `reviewSummary`. All review seats share this. A non-ok reviewer invocation THROWS (infra, routed via the caller's failure ladder) — a pass is impossible without a transcript (ADR 0050).
- `gate.ts` — pure retry-budget state machine: `advanceRetry`, `GateCounters`, `INITIAL_COUNTERS`. No I/O.
- `corrective.ts` — `[BLOCKER]` findings become corrective tickets that run through the full gate inline before the originating review may pass.
- `replan.ts` — classifies goal-review findings, builds the replan prompt, renumbers the regenerated frontier into the run's global sequence, `drainFrontier`.
- `visual-loop.ts` / `goal-loop.ts` / `structural-loop.ts` — cadence scheduling and round execution per gate; `owed-gates.ts` replays gates owed across a stop (ADR 0038).
- `evidence.ts` — transcript predicates (screenshots, real interaction, app launch) used to keep reviewers honest.
- `goal-review.ts`, `structural-review.ts`, `visual.ts`, `interaction-smoke.ts` — prompt builders and verdict parsers per gate. `goal-review.ts` owns the `$PROBE` block parser (`parseProbeBlock`) and `dropClosedFindings` (probe-closed findings are never re-found).
- `goal-loop.ts` re-verifies previously open blockers from the probe registry before a re-review (ADR 0043 amendment); `interaction-smoke.ts` runs once per committed group boundary with a render-delta + zero-console-errors bar.

## Invariants

- Review runs are read-only and diff-scoped; a gate never edits project files except through the corrective path.
- A gate verdict is green only if the gate ran (ADR 0050): a non-ok invocation is infra, an unevidenced PASS downgrades to inconclusive, and a configured-but-never-fired gate reports "not run".
- Severity → retry rules (BLOCKER full budget; MAJOR one attempt then soft-pass in light — ADR 0025) live here and in `src/config/`; do not invent variants.
- Gates are named in findings by slug (ADR 0027); reference identity must stay stable across rounds.
- Corrective tickets are inserted immediately before the remaining planned frontier, so a resume picks them up before continuing the plan.
- A gate that fires at a checkpoint must record what it owes so resume can replay it.
