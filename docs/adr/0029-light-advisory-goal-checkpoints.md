# Light preset: advisory goal checkpoints at group boundaries

Supersedes the light-cadence decision recorded in the #98 comment (issue #102).
Amends the goal row of ADR 0021's cadence table.

## Context

Light's whole-app story was a single goal pass at run end: the first time
anything judged the rendered whole was after 100% of the work was committed.
The observed failure (issue #98) was coherence drift found late and fixed by
corrective churn — one big corrective batch against a build whose earlier
groups had already diverged. The #98 decision kept light run-end-only for
speed and deferred cadence changes until the charter moved quality.

This ADR reframes light's identity as **see early, steer early, correct
once**: the goal judge fires at planner-group boundaries **advisory-only** —
no inline corrective tickets, no corrective churn per group — and correction
stays a single bounded batch at run end.

The cost anatomy is why this is cheap. A goal *judgment* is minutes: a fresh
seat, a small scoped prompt, run the app, look. What made `medium` a long run
was not the judging but the **corrective churn per group** — each `[BLOCKER]`
→ corrective ticket → full pipeline → re-review. Advisory checkpoints keep the
judging and drop the churn: one single-round judge pass per group, expected
single-digit-percent mid-run wall-clock overhead, and the convergence stop
would fire immediately anyway (no correction means no re-review).

## Decision

1. **`checkpoint_action: "advisory"` is a goal-gate config knob**
   (`GoalReviewConfig.checkpoint_action`). Absent = today's behavior (`mode`
   decides: `full`/`medium` fire group checkpoints with inline corrective
   tickets; `light` is run-end only). Set to `"advisory"`, the judge fires at
   group checkpoints (labeled groups; via `fallback_cadence` for unlabeled
   plans) even under `light`, and processes advisory-only. The knob only takes
   effect where the gate owns a run-end corrective seat (`light`/`full`); a
   `medium` gate (no run-end pass) ignores it and mode decides — a record
   without any corrective seat would be findings-without-correction, which is
   not a state this ADR creates.

2. **Advisory processing** (`runGoalReview`): the judge runs exactly as
   today — scoped prompt (original goal + design doc + coherence charter +
   digest + group deliverables + prior findings), verdict parsed as usual —
   and on findings the railhead:
   - records them into `state.goal_reviews` (the existing prior-findings
     channel the run-end pass already flatMaps),
   - applies `CHARTER:` revisions and `LEARNED:`/`DIGEST:` marker emissions as
     normal — this is the steering: amended charter + digest ride into later
     groups' builder, reviewer, and goal prompts. (Fix folded in: goal-review
     transcripts' `DIGEST:` lines now push on EVERY goal checkpoint via the
     ADR 0018 path — previously only structural review pushed them, so a goal
     reviewer's digest lines were silently dropped. Steering therefore does
     not depend on the variant firing.)
   - generates **zero corrective tickets** and returns pass-equivalent so the
     run continues. Single round by construction; the convergence stop and
     `$REPLAN` never apply mid-run advisory.

3. **The prompt gains an advisory variant** (same markers, same concreteness
   bar, findings must be actionable LATER not vented now; `$REPLAN` /
   `$CORRECTIVE` decomposition guidance is dropped because nothing is
   corrected at the checkpoint). Severity semantics are kept — `[BLOCKER]`
   still means "the build does not yet meet the goal" and still prioritizes
   the run-end batch; the reviewer is told not to soften a real blocker just
   because the checkpoint is advisory.

4. **Run-end is unchanged**: `mode` still controls the end-of-run pass
   (`full`/`light` fire it). For light that pass now processes ONE corrective
   batch over the accumulated advisory (and its own) findings — the existing
   prior-findings mechanism.

5. **Preset mapping**: goal mode `light` IS the advisory identity. The light
   preset row carries `goalCheckpointAction: "advisory"`; the persist path
   writes `goal_review.checkpoint_action: "advisory"` when the resolved goal
   gate is `light` and clears it when the goal moves off `light` (a replan to
   `medium`/`full` must not inherit light's advisory). `medium`/`full` are
   unchanged — inline corrective checkpoints stay their identity. Pre-existing
   `railhead.json` files with goal `mode: light` and no knob keep the old
   run-end-only behavior until re-planned.

6. **Goal checkpoints never coarsen the per-ticket gate cadence** —
   explicitly. Goal-checkpoint triggers are orthogonal to builder batching:
   they fire when all tickets of a planner group are committed
   (`detectGroupCheckpoints`), regardless of how the builder was checkpointed
   or batched. Light keeps its best per-token assets — per-ticket verified
   commits and per-ticket code review (`product` granularity, now the default
   per ADR 0022 §4, coarsens only the builder's session lifetime, never the
   gates); group-cadence whole-app sight comes from the judge, not from
   coarsening the build or review to group level.

## What this does not change

- `checkpoint_granularity` (default `product`, ADR 0022 §4); per-ticket
  verify/review/commit cadence — a light run between checkpoints behaves
  exactly as before (product coarsens only the builder session lifetime).
- The visual gate: its end-of-run seat is already owned by goal under
  `full`/`light` (ADR 0026); structural run-end is unchanged and out of scope.
- `medium`/`full` goal semantics — inline corrective checkpoints stay.

## Secondary candidate (cut)

Carrying the queued advisory findings into the next builder invocation as a
"known gaps — do not worsen; fix if trivially in scope" block was considered
and CUT for this ticket: the charter + digest + learnings channel is the
steering the ADR already trusts (ADR 0018/0028), and re-adding findings in the
builder prompt duplicates the prior-findings channel at more token cost. Revisit
only if e2e shows the steering channel insufficient.

## Consequences

- Light runs now see whole-app quality gaps at each group boundary instead of
  at 100% — coherence drift is spotted while later groups can still absorb a
  redirect, and the run-end corrective batch is smaller.
- `state.goal_reviews` records carry an `advisory` flag; report.md counts
  advisory checkpoints and lists each checkpoint's findings per group.
- `medium`/`full` goal semantics are unchanged (inline corrective checkpoints;
  the `medium`-and-knob hand config falls back to mode deciding), and the goal
  seat's `DIGEST:` lines now persist on every goal checkpoint (ADR 0018) — a
  latent dropped-marker gap fixed, not an advisory-only behaviour.
- The knob is explicit and opt-in at the config level, so pre-#102 light
  configs keep their exact cadence until a plan re-applies the light preset.
- The `goal_review.checkpoint_action` knob, the advisory prompt variant, and
  the record/report plumbing are unit-tested beside their modules.

## Validation (recorded, not gating)

Spriteforge corpus A/B per the issue's validation note: bare (no goal review)
vs current light vs light-with-advisory-checkpoints. Compare wall-clock,
whole-app quality at the goal criteria, and corrective-ticket count. The same
corpus backs ADR 0028's validation (fewer coherence-class blockers when the
charter steers), so one set of runs feeds both measurements.
