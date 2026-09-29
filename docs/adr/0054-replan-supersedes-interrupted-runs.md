# A replan supersedes interrupted runs on its branch

## Context

Re-running `railhead build`/`fix`/`feature` re-plans into the same
`.scratch/<slug>/issues` directory. `writeTickets` clears the stale `.md` files
there before writing the new plan (correct at plan time), but `cmdBuild` then
handed the post-plan run to `cmdRun`, whose auto-resume (ADR 0016) found the
prior interrupted run on the branch and tried to resume it — against ticket
files the planner had just replaced. The combat
`the-heightmap-looks-great-but-` incident: a stopped 5-ticket run was re-planned
into 2 tickets, and `resumeRun` dead-ended on "tickets missing from disk". Had
filenames collided, the resume would instead have silently restored the OLD
ticket set, discarding the plan the user just paid for.

The command semantics decide the winner: re-running a planning command asks for
a new plan. Auto-resume belongs to `railhead run`/`resume`, which never plan.

## Decision

1. `RunStatus` gains `superseded` — terminal like `failed`, but honest: the run
   was deliberately replaced, nothing went wrong. `isFinished` treats it as
   terminal; `shouldResume` never resumes it.
2. After `runPlan` writes the new plan, `cmdBuild` calls
   `supersedeRunsForBranch(cwd, branch)`: every `running`/`stopped` run on the
   plan's branch is closed with `stop_reason: "superseded by a fresh plan on
   this branch"`, and each closed run is named on the console. This covers the
   plan-only path too (the user declines "Start this run now?"): the old run is
   invalid the moment its ticket files are replaced, not only when the new run
   starts.
3. `cmdRun` never auto-resumes when invoked from the plan handoff
   (`opts.fromPlan`): the plan just replaced the ticket set, so there is no
   frontier to continue. `--fresh` on a direct `railhead run` supersedes the
   branch's interrupted runs for the same reason — an explicit discard must not
   leave a resumable ghost behind.
4. Superseding keeps the old ledger and report for inspection; only
   `railhead reset` removes them.

## Consequences

- The natural re-run of `build`/`fix`/`feature` after a stop or crash now
  plans, starts a fresh run, and never dead-ends; `railhead reset` is no longer
  required first.
- `railhead run <tickets-dir>` and `railhead resume` keep ADR 0016's
  auto-resume; only the post-plan handoff is exempt.
- A later `railhead run` on a namespace whose plan was regenerated starts fresh
  from the on-disk plan instead of resuming the stale frontier, because the
  stale run is already closed as superseded.
- Committed ticket work stays on the branch; the new run's title/`base_sha`
  scoped pre-marking recognizes whatever the new plan still lists.
- `railhead status` may show a superseded run as the latest when the operator
  planned but declined to start it — the state is honest about where the work
  went.

## Relationship to ADR 0016

ADR 0016's invariant "`railhead run` on a branch with a prior running/stopped
run resumes it" still holds verbatim — this ADR narrows only the post-plan
handoff, which is not a `railhead run` invocation. ADR 0016's Gap 3 invariant
check stays as the corruption guard it was meant to be.

## Amendment (2026-09-29): a feature re-run with an intact plan does not re-plan

Decision 2's "re-running a planning command asks for a new plan" governs the
commands that PLAN. `railhead feature` now checks its step namespace first:
when the plan is intact (origin.json plus every ticket file it recorded),
the re-run reuses it and starts/resumes the run directly, unless `--replan`
is passed or the step was reopened with feedback (ADR 0058). Auto-resume on
that path is safe for the same reason this ADR disabled it after a replan —
the ticket files were not replaced. Every path that still plans supersedes
the branch's interrupted runs exactly as below. The plan-only path in
decision 2 (the user declines "Start this run now?") no longer exists:
accepting a plan always starts the run.
