# Feature re-runs reuse an intact plan; the run prompt is not a worktree file

## Context

The combat step-03 incident. `railhead feature` planned 14 tickets for a
roadmap step, then `cmdRun` refused to check out `run/step-03-…`:
`Your local changes to the following files would be overwritten by checkout:
prompt`. `cmdBuild` had persisted the enriched prompt to a repo-root `prompt`
file, and per-ticket commits (`git add -A`) had tracked it. Every replan
rewrote the file, dirtying the worktree; committing it and re-running
`railhead feature` then re-derived the feature prompt and re-planned the whole
step (two more model calls) even though the ticket set was intact on disk —
because re-running a planning command always planned (ADR 0054) and always
asked the second start question.

## Decision

1. **The run prompt rides `origin.json`.** The plan's identity marker already
   carries the prompt (`PlanOrigin.prompt`) and is read by `startRun` for
   `arc_step`/`verify_seeded`. `cmdRun` sources `originalPrompt` from it; the
   root `prompt` file is no longer written at all. A legacy root `prompt` is
   still read as a fallback only when no origin exists (a hand-made ticket
   directory).
2. **A legacy dirty `prompt` never blocks a branch switch.** Before checking
   out the run branch (`run` and `resume`), a tracked-and-modified `prompt` is
   restored to HEAD: it is pure tool output, and discarding it is exactly what
   the operator was being forced to do by hand.
3. **Feature re-runs reuse an intact plan.** `cmdFeature` checks the active
   step's namespace (`.scratch/step-NN-title/issues`) before deriving
   anything: when `origin.json` exists and every ticket file it recorded is on
   disk, it starts the run from that ticket set — no derivation call, no
   planning calls. `--replan` forces a fresh plan; a step reopened with
   feedback always re-plans, because the existing ticket set cannot have
   honored a note newer than itself.
4. **Acceptance is the start; the second prompts are gone.** `cmdBuild`/
   `cmdFeature` start the run as soon as tickets exist. The plan review's
   acceptance (or the fix planner's single call) is the only decision; the
   feature-only "Build this step now?" approval and the `-c`/`--continue`
   carry-over flag are removed (see the ADR 0041 amendment).

## Consequences

- A stop, crash, or refused checkout mid-feature costs zero model calls on the
  next `railhead feature` — it resumes the interrupted run if one exists, or
  starts a fresh run from the tickets already planned. `--replan` is the
  explicit invalidation; a reopened step is the feedback-driven one.
- Plans that predate this ADR are reusable too: `origin.json` has existed since
  issue #47.
- Every path that DOES plan still writes a fresh ticket set and supersedes the
  branch's interrupted runs (ADR 0054) — reuse is what keeps that separation
  honest, not a weakening of it.
- The plan-only path (declining "Start this run now?") no longer exists;
  `railhead feature` is plan-and-run in one command, as its name implies.

## Relationship to ADR 0054

ADR 0054's "re-running a planning command asks for a new plan" governs the
commands that plan. Reuse skips planning entirely, so there is no replacement
to reconcile: the ticket files are untouched and auto-resume is safe.
