# Goal review: per-round transcripts, convergence stop

Amends the issue #19/#73 goal-review loop mechanics after a mid-run defect
produced hours of corrective-ticket churn (run-20260907-1340).

## Context

The run-end goal review loops: FAIL → corrective tickets committed → re-review,
bounded by `max_rounds`. The observed failure had three rounds of
byte-identical findings, each round regenerating the same corrective tickets —
three of them committed as literal no-ops reusing HEAD.

The cause was NOT a model echo. The reviewer's own round-1 transcript contained
"$GOAL_PASS — all prior findings verified resolved". Two railhead mechanics
combined to discard that verdict:

1. `runGoalReview` wrote every round to one append-only events file
   (`goal-run-end.jsonl`), and `extractAssistantText` concatenates the file.
   `parseVerdict` starts at the FIRST `$GOAL_FAIL` block — so round 1+ re-parsed
   round 0's stale verdict and replayed its findings verbatim.
2. The loop had no convergence guard: identical findings simply triggered
   another corrective cycle.

## Decision

- **One ledger phase file per review round**: `goal-<group>` for round 0,
  `goal-<group>-r<N>` for round N. Mirrors how `planner.ts`/`replan.ts` use
  `resetPhase` and how the visual loop names `visual-<round>-review`, while
  keeping every round's transcript in the Ledger for audit.
- **Convergence stop**: `runGoalReview` records the verdict, then compares the
  finding set against the previous round's for the same checkpoint (modulo
  screenshot paths and whitespace — those legitimately differ between rounds).
  Identical set ⇒ return a distinct `"stop"` signal; the run-end loop breaks
  instead of churning. The comparison is whole-set identity: a genuinely new or
  reworded finding continues the loop.
- **Escalation on stop is human/replan**: the stop logs that corrections are
  not landing and points at resume-with-replan. Mechanical convergence beats
  asking the same small-context model to resolve an impasse it already failed
  to converge on.

## Consequences

- The identical-blocker corrective-churn class is closed. A reviewer that
  really does keep failing on the same unchanged gap stops after one wasted
  round instead of `max_rounds`.
- The stop also fires if a model ever does echo its injected prior-findings
  block verbatim — that path needs no separate echo-filtering machinery; the
  same guard covers it.
- Latent sibling risk noted, not fixed here: the structural gate reuses
  `structural-<group>` across re-fires. It does not loop at run end today
  (single invocation), so the stale-parse defect cannot compound there yet.
