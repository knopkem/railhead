# Two-call planning: design, then tickets

Supersedes the staged-planning shape of ADR 0039 and amends ADR 0041 (the
`$PLAN` document) and ADR 0042 (the interview's revision shape). Retires the
ADR 0027/0035 ruling gate mechanics from the planner (ADR 0048 removes the
underlying fields).

## Context

ADR 0039 split build planning into design → adversarial goal-coverage audit →
decomposition after a run shipped a GoTY-caliber goal with no art ticket. The
audit was the fix for a real failure, but in practice it became the largest
source of plan-time failure:

- **The spriteforge plan (the failing build that prompted this ADR)**:
  `plan-tickets` hit the model's output limit (`step_finish reason: "length"`)
  mid-array. The truncated tail lost the ticket that owned `png.ts`, the
  mechanical plan gate raised `uncovered-file:png.ts`, the first repair round
  produced no parseable array, the second emitted an empty `$RULINGS $END`, and
  the plan was rejected after two paid rounds. Zero tickets, build never
  started.
- **The snake bench**: the coverage audit rejected a valid plan because it
  demanded implementation-level detail ("no wgpu draw calls in render/mod.rs"),
  then rejected the revision too — two revision rounds, four minutes, zero
  tickets.
- **The `$PLAN` block** (ADR 0041) made the design call emit a full-length
  document plus two distilled summaries; the decomposition then consumed all of
  it, inflating both calls.

A weak planner fails an audit by either rubber-stamping it or demanding code it
will never write; neither outcome justifies a second model call, a revision
loop, and a repair loop that can reject the plan.

## Decision

### 1. Build planning is two calls

`design` (`$VERIFY`, `$INTERFACE`, `$SMOKE`, `$DESIGN`, `$ARCHITECTURE`) then
`tickets` (the small-schema `$TICKETS` array from ADR 0048). No coverage-audit
call, no plan-repair call, no `$RULINGS`.

### 2. The $PLAN block is removed

`$DESIGN` carries the full design intent (goal coverage checklist, narrative,
quality bar, art direction, coherence contract) and `$ARCHITECTURE` the module
map. `PLAN.md` — the human artifact and the interactive-review input — is
composed from those two plus the ticket breakdown. The interactive review
(ADR 0041) and the planning interview (ADR 0042) are unchanged; their revision
calls re-emit the same five blocks.

### 3. Validation is deterministic, not adversarial

After parsing, the railhead asserts: at least one ticket; every ticket has a
non-empty `what`; every non-`open_ended` ticket has criteria. A decomposition
whose `"title"` keys outnumber its parsed tickets (truncation) gets exactly one
continuation call asking for the remaining tickets as a second `$TICKETS`
array. No model ever re-judges the plan.

### 4. The art ticket is deterministic

A plan that declares a rendered surface and emitted no `open_ended` ticket gets
the standard craft ticket appended, pointed at the design doc's `## Art
direction` section. A missing ticket is no longer a reason to reject a plan.

### 5. Fix mode stays one call

A bug report has no plan to audit; the fix ticket is the plan.

## Consequences

- Planning costs two model calls (one for a fix) instead of two-to-six, and the
  design call no longer emits a redundant full plan document.
- A plan the old gate would have rejected now runs; scope loss from a
  truncated decomposition is surfaced (`unparsed` warning + one continuation)
  rather than blocking, and the goal review judges the running app against the
  goal at run end.
- The human review (interactive) and the goal gate (unattended) are the
  quality backstops; the model no longer certifies itself *or* rejects itself.

## Amendment (v2 issue 01): the plan gate

Planning is still two calls, and the planner still does not audit itself — but
the finished plan now passes ONE gate call by a different seat (the goal
seat, which did not write it): it walks the goal's demands against the ticket
ownership map and the spine-first ordering rule and returns scope-gap
findings or `$REPLAN`. A gap regenerates the frontier through the mid-run
replan prompt, capped by the same `max_replans` budget the run honors; a plan
still failing at the cap is rejected before the first commit. The gate runs in
unattended builds; an interactive run skips it because the human reviewing
PLAN.md is the coverage check. Deleting a plan no longer requires the planner
to certify itself (the rejected staged-audit shape) — the judging seat is
fresh and the failure is bounded to one extra call per revision.
