# A plan that seeds the verify suite is exempt from the feature baseline

## Context

ADR 0051's baseline refusal assumes a feature run extends an existing product
with a real verify suite. The first feature run of a greenfield product
violates that premise: `railhead feature` plans step 1 (which creates the
build manifest and the smoke test), the planner's `$VERIFY` seeds the
previously-empty `railhead.json`, and the run start then executes those
brand-new commands before ticket 01 — a guaranteed red baseline that refuses
the very run meant to establish it. The combat step-1 incident: `npm run
typecheck` failed with ENOENT because no package.json existed yet, and the
run stopped with "run `railhead fix` first".

## Decision

1. `runPlan` records `verify_seeded: true` on the plan origin when it seeded
   the verify list into a previously-empty `railhead.json` (and returns it as
   `PlanResult.verifySeeded`).
2. `startRun` skips the feature baseline when the origin says the suite was
   seeded by this plan (or, for a same-process plan→run handoff, when
   `RunOptions.verifySeeded` is true), logging the skip. There was no suite
   to be green before this plan; ticket 01 establishes it.
3. A verify list that predates the plan still gets the baseline check — the
   refusal keeps protecting feature runs on an existing product.

## Consequences

- Greenfield step 1 starts; the first ticket's own verify gate (ADR 0006)
  proves the suite once it exists.
- `railhead run <tickets-dir>` continuing a planned-but-not-started namespace
  honors the origin field, so the exemption survives a separate invocation.
- A user who deletes their verify list to disable gating gets the suite
  re-seeded and the check skipped for that plan — consistent with the
  pre-existing empty-list skip.
