# The run-end goal review supersedes the end-of-run visual pass

Amends ADR 0009/0011's cadence split (issue #73). Recorded after a real run
(run-20260907-2146) where the end-of-run visual pass soft-passed a build with
66 prose "findings" while the goal review that ran minutes later caught the
real layout blocker.

## Context

The railhead has two whole-app gates that fire at run end under `full`/`light`:

- **End-of-run visual** (`visualReviewLoop`): aggregates every ticket's
  acceptance criteria (`aggregatedCriteria` — the deduplicated union of the
  per-ticket lists) and judges the integrated app against that union.
- **End-of-run goal** (`goalReviewAtRunEnd`): judges the integrated build
  against the ORIGINAL GOAL plus the planner's design doc.

Both run the same app with the same screenshot/interaction machinery. In the
observed run they fired back-to-back over the same build, and the weaker one
went first: the visual pass emitted prose findings with no `[BLOCKER]` marker,
`processCorrectiveFindings` found nothing actionable, it soft-passed and set
`visual_ok=true` — while the goal review that followed found the toolbar-wrap /
1280×800 layout blocker and drove the real corrective ticket.

The per-ticket visual pass is NOT in this redundancy: it reviews only ticket
N's criteria against the app as of ticket N, precisely so it never flags
features of later tickets. Goal review does not exist per-ticket, so per-ticket
visual has no substitute.

## Decision

The end-of-run visual whole-app pass fires only when the goal review will NOT
take that seat. Concretely, in the run-end gate sequence:

- visual runs at run end under `full`/`light` **and** the goal gate is off at
  run end (`off`/`medium`) **or** no goal model is resolved;
- otherwise goal owns the whole-app pass and visual's run-end loop is skipped.

Per-ticket visual (fires under `full`/`medium` after each commit) is unchanged
— it is the ticket-scoped runtime regression check, a job no other gate does.

Encapsulated as a pure predicate `visualFiresAtRunEnd(visualMode, goalMode,
goalModelResolved)` in config.ts so the cadence stays testable without a run.

## Consequences

- At run end, one whole-app review runs instead of two redundant ones; the
  stronger frame (goal + design doc) is the survivor.
- In the default `light` preset, where goal review already fires at run end,
  the visual seat contributes nothing further — users who want visual-only
  whole-app review set goal `off`/`medium` (or no goal model) and visual
  `light`/`full`.
- A model that emits prose instead of markers no longer wastes a run-end
  pass before the goal review does the real work.
- Residual gap unchanged: the observed weakness of the *goal* reviewer's
  interaction hygiene (synthetic `evaluate_script` instead of real pointer
  clicks) is a prompt/evidence problem, tracked separately, not addressed by
  this cadence change.
