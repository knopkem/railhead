# Strict goal checkpoints are scoped and evidence-anchored

Supersedes the framing that mid-run goal review must stay advisory to be safe
(ADR 0029). Recorded after enabling `goal_review.mode: "medium"` on the
platformer run. Two prompt defects made strict group checkpoints unsafe, and
they were the real reason advisory existed:

1. **The playthrough was unconditional.** The prompt told every checkpoint to
   "play the core loop to completion … reach the TERMINAL state" and that an
   incomplete loop is a `[BLOCKER]`. At the scaffold/early groups the loop does
   not exist yet, so the reviewer flagged unbuilt later-group features — the
   exact false-scope failures that pushed runs onto advisory.
2. **A `[BLOCKER]` needed no evidence.** Findings could name nothing in the
   current tree, or name files owned only by unbuilt tickets, and still
   generate corrective tickets. Advisory made those findings free; strict
   turned them into churn.

## Decision

### 1. The playthrough is gated on the loop existing

`buildPlaythroughSection` takes `coreLoopReady`. When false, it emits a
**Group playthrough**: a required, real-input, screenshot-backed exercise of
THIS group's deliverables, with an explicit rule that later-group features are
out of scope and a missing later-group feature is not a blocker. When true,
the original full core-loop-to-terminal-state section is unchanged.

`goal-loop` computes it conservatively: ready at run end, when the checkpoint
is the final group, or when some committed ticket names the run lifecycle
(`state machine|run lifecycle|game state|gameplay loop|win condition|victory|
death|boss|finale`) and no pending ticket does. A false "not ready" only
scopes the playthrough (safe); a false "ready" would recreate the false
blocker. Including the boss/finale matters: a roguelike's terminal state is
often behind it, so the loop is not judged to completion until it exists.

### 2. Strict `[BLOCKER]`s are evidence-anchored

The prompt gains an enforced **Blocker evidence** rule: a blocker must cite a
screenshot path under `.railhead/` taken this pass or a file that exists now,
and concern this group's deliverables, the running build's integration, or a
charter clause. Findings about later scope are `[MAJOR]` notes at most.

The railhead enforces it with the pure `splitAnchoredBlockers(findings, {
exists, pendingFiles })`: non-blockers pass through; a blocker citing no
existing artifact, or only files owned by pending tickets, is **typed
steering-only** — recorded in the goal review (it still steers later reviews
and the report) and generating no corrective ticket. `$REPLAN` is unaffected:
the replan hook runs before the blocker short-circuit, so an explicit
plan-level signal still fires.

### 3. Consequence for defaults

`goal_review.mode: "medium"` (corrective group checkpoints) is the recommended
default for go-forward runs: the anchoring above removes the false-positive
class that advisory was compensating for. `light` remains the cheap path
(run-end corrective batch plus optional advisory steering), and advisory stays
available for runs that want early signal without mid-run correctives — but it
is no longer the mechanism for avoiding out-of-scope blockers.

## Non-goals

- Not removing advisory; not removing per-ticket visual review.
- Not changing the run-end goal pass, which is always full-loop, corrective,
  and (pending empty) cannot be future-scoped.

## Consequences

- A checkpoint cannot block on features the plan has not built: the
  playthrough scope and the finding typing both enforce it.
- Corrective tickets at group boundaries now require current-state evidence,
  so each ticket has an actionable subject.
- Unanchored blockers still reach the human: they are recorded in
  `goal_reviews`, reported, and injected into later reviews as prior findings.
- Tests pin both: playthrough scope, the evidence rule in the prompt, the
  splitter's typing, and an end-to-end run where an unanchored blocker
  generates no corrective ticket while remaining recorded.

## Amendment (v2 issue 01): the probe registry is the blocker fast-recheck

A checkpoint's concrete findings are materialized once per group as probe
scripts under `.railhead/probes/` — the goal seat emits a `$PROBE` block of
`{behavior, command, expect}` objects, the railhead registers them in
`state.probes` (resume-safe) and writes the scripts. Before a re-review, the
railhead runs the registered probes deterministically and injects their
results into the prompt; a PASS closes the behavior, and findings it matches
are dropped before recording (`dropClosedFindings`). The seat re-derives only
genuinely new behaviors, so the observed waste — four goal rounds re-probing
the same blockers by hand — cannot recur. Probes stay language-agnostic: a
command plus an expected predicate, never a test framework.
