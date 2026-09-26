# A blocked exit and a per-ticket budget — the builder may stop honestly

Status: **accepted — implemented.** The four review questions were resolved on
2026-09-18 (decisions below) and the implementation landed the same day
(`src/core/blocked.ts`, the executor's `stopAfterBlocked` watcher, the builder's
block directive, run.ts routing, plan-scaled per-ticket budgets, goal-review
routing of unverified criteria). Full suite green.

Recorded after the spriteforge run `run-20260917-0110`, ticket 07. The ticket's
work was done and unit-tested (95/95), but one acceptance criterion — "running
the app, the player can fight the boss, defeat it, and trigger the victory
state (verified by watching)" — needed a live playthrough the seat could not
script: its only observation path was `getImageData` pixel sampling, and its
bot died in pits and spikes from spawn, over and over. The builder had no
legal way to stop: the checkpoint contract says only `$CHECKPOINT` ends a
phase, and "never emit the marker for work that is not green." The phase ran
**7 hours / 95 steps** before it was killed — and the railhead's own kill made
things worse: `max_phase_steps: 80` fired at step 81, the failure ladder
retried the same durable session, and the fresh invocation got a **fresh
80-step budget**, so the "cap" reset itself (ticket `attempts` stayed 1, the
state log kept no record). A local model at 30–100 tok/s makes each of those
cycles ~5–6 hours. The user stopped the run by hand.

The model was not misbehaving. It followed its only instruction: try until
green. The contract offered no honest failure, and the enforcement was too
weak to substitute for one.

## Context

- **No blocked exit exists.** The builder prompt defines `$CHECKPOINT` and
  nothing else; goal/visual seats carry a `HALT_CONTRACT` (`.railhead/STOP`)
  the builder never learns. An AC that cannot be verified by the seat's tools
  is therefore an infinite assignment.
- **The existing guards miss this shape.** `stall_timeout_sec` needs silence —
  the model never stopped producing output. `max_step_model_sec` bounds one
  model call (~20 min here), not a phase. `spin_loop` catches identical tool
  calls, not varied attempts. Only `max_phase_steps` fires, once per process.
- **The step budget is per invocation, not per ticket.** `withFailureLadder`
  re-runs the builder closure with the same `maxSteps`, so each ladder rung
  is a fresh 80 steps. For the durable session (ADR 0022) the session survives
  the kill and resumes exactly where it left off — the loop is reset-proof.
- **Verification debt has nowhere to live.** The railhead has vision-capable
  seats (visual/goal, ADR 0036) that *can* watch a playthrough, but no way for
  the builder to say "this AC needs that seat" and hand it over.
- **A silent retry is worse than a stop.** The run kept burning hours with no
  state record a human could see, and on resume it would do the same again.

## Decision (proposed)

### 1. `$BLOCKED` — a structured, terminal exit for the builder

One line as the LAST line of the reply, mirroring `$CHECKPOINT`'s single-line
terminal contract (the last-line anchor is what keeps a prose mention of the
format from arming the kill):

```
$BLOCKED ticket=07 kind=verification-unavailable reason=<free text: the criterion and why this seat cannot complete it>
```

The reason carries the criterion and what was tried; a separate quoted
`criterion=` key is optional, and unknown kinds degrade to the conservative
`implementation-stuck`. `kind` is one of three:

- `verification-unavailable` — the work is believed complete, but this seat's
  tools cannot prove the criterion (a "verified by watching" AC with no
  vision/interaction path, an external service the environment lacks).
- `implementation-stuck` — the behavior does not work and the builder cannot
  make it work within its bounded attempts (failing tests it cannot fix).
- `plan-defect` — the ticket or plan is self-contradictory or impossible as
  written (a required symbol another ticket owns, an ordering that cannot
  hold).

The executor parses it exactly like the checkpoint marker (own line, last
line, stop-at-marker), so the phase ends cleanly with a structured result:
`blockedTicket`, `blockKind`, `blockReason`, `blockTried`. A block is neither
a checkpoint nor a crash.

### 2. Bounded attempts first, then block — a prompt contract

The builder prompt gains an explicit verification budget and the block
grammar:

- For a live/interactive criterion, make at most **N attempts** (proposed 3)
  or work a stated time box, whichever comes first. Each attempt must change
  something — a new mechanism or hypothesis — never repeat the same bot.
- After the cap, emit `$BLOCKED` with the exact criterion and the evidence
  gathered. Do not keep trying; do not checkpoint a criterion that is not met.
- For `verification-unavailable`, leave the tree green (build/tests pass)
  before blocking — the block hands off verification, not broken code.
- A false `$CHECKPOINT` (claiming an unmet criterion) becomes an explicit
  review finding, so blocking is always cheaper than lying.

### 3. What the railhead does with a block

`kind` decides the route; a block is never retried identically.

- **`verification-unavailable`** — run the ordinary gates (verify, smoke,
  review) on the current diff. If they pass, commit the ticket and record the
  criterion in run state as **unverified** (`ticket.unverified: string[]`).
  Discharge is routed to the seat that can verify it: the next group
  checkpoint's visual/goal review receives the unverified criteria as explicit
  must-check items; if no such gate is enabled, they surface at run end and
  the run is reported as *not fully verified* — never as done-green. If the
  gates fail, the work is not done and the block degrades to an ordinary
  failed attempt.
- **`implementation-stuck`** — do not retry blindly: feed the block reason
  into one findings-style attempt. If it blocks again, fail the ticket and
  stop with the block surfaced (per the run's existing failure policy), rather
  than consuming more ladder rungs.
- **`plan-defect`** — stop and surface; a bounded replan is the likely answer
  but is a policy question (below), not an automatic default.

Every block is written to state and the ledger (`block_kind`, reason, tried,
criterion), so a resume replays the decision instead of re-entering the loop.

### 4. A real per-ticket budget — the cap cannot reset

Run state accumulates per ticket and is checked at every retry boundary:
`build_ms_total`, `build_steps_total`, `build_blocks`. Both budgets scale from
the plan (decision 2), not arbitrary constants:

- `ticket_step_budget` — cumulative `step_start` count per ticket. Default
  `2 × max_phase_steps`; `max_phase_steps` already scales from the plan's
  context budget (`resolveStepBudget`).
- `ticket_wall_sec` — cumulative builder wall-clock per ticket. Default is the
  **measured wall time of the plan phase** (the design + audit + tickets calls
  ran on the same model, same repo — the only clean per-project calibration of
  model speed), floored at 1800s. Explicit config wins; `0` disables either.

Exceeding either stops the ticket as budget-exhausted and surfaces it — it
never resets on a ladder rung, a resume, or a compaction. The phase's own
`max_phase_steps` stays as the per-invocation guard.

### 5. Reuse, not a parallel machine

- The block marker shares the checkpoint marker's line contract and the
  executor's stop-at-marker path.
- Unverified criteria reuse the goal-review findings channel and the run
  report; there is no new "verification debt" subsystem.
- `plan-defect` reuses the existing diagnosis/replan machinery when a human or
  policy enables it.

## Non-goals

- Not a stop button for the model to avoid hard work: blocks count against
  the ticket budget, need an exact criterion and evidence, and
  `verification-unavailable` still has to pass verify + review to commit.
- Not a replacement for the vision-probe refusal (ADR 0036): this is for
  criteria that are *individually* unverifiable, not for a blind seat running
  a whole gate.
- Not an auto-commit of unverified work: the legacy gates decide the commit;
  only the recorded debt and its routing are new.

## Decisions (review, 2026-09-18)

1. **`verification-unavailable` commits with recorded debt** and routes the
   criterion to the visual/goal seat; verify + review must still pass first.
2. **Budgets scale from the plan** — the formulas in §4, no fixed 2h constant.
3. **`plan-defect` auto-runs the bounded replan** when `max_replans` remains;
   otherwise it stops and surfaces.
4. **A block auto-continues** (record and route), with an `on_block:
   "continue" | "pause"` config knob for runs that want to stop and look.

## Consequences

- A 7-hour thrash becomes a ~15-minute block with a criterion, a reason, and
  a handoff — and the ticket's work survives as a recorded-debt commit.
- Ticket 07's AC gets verified by the seat that can actually watch: the goal
  reviewer drives the boss fight (its interaction-hints path already exists).
- The step budget stops being decorative: 80 steps per ticket, cumulative,
  regardless of how many processes, rungs, or resumes it takes to hit it.
- The builder gains an honest failure channel, which also makes its success
  signal meaningful: a `$CHECKPOINT` now means the criteria were met, not
  that the model ran out of options.

## Amendment (2026-09-23): the wall clock restarts at a green checkpoint

The snake run `run-20260923-1547` exposed a misfire the original scaling
could not have caught. Ticket 01 built green — 50 steps, checkpoint, verify
PASS — but the smoke gate (`timeout 5 cargo run --release` on a windowed
game: the app runs until the timeout kills it, exit 124 = "failure") sent the
loop back for a retry, and the wall budget stop fired at the attempt
boundary: 35m cumulative against the 30m floor. A slow-but-progressing ticket
was canceled for being slow, and a project-config smoke misjudgment was
amplified into a whole-run failure.

Two separate flaws, two separate fixes:

1. **The scaling premise broke.** The plan-phase wall (2.6 minutes here —
   three LLM calls, nine events) cannot calibrate build wall: a build ticket
   runs dozens of tool-heavy steps, an order of magnitude more wall per unit
   work than planning. In practice the 30-minute floor always governed, and
   the floor was sized for fast cloud models, not an 11 tok/s local one.
2. **Absolute wall time is the wrong invariant.** The budget exists to bound
   thrash — and the spriteforge thrash this ADR records produced **zero**
   checkpoints in 7 hours. A ticket that keeps reaching green checkpoints is
   not thrashing: a `$CHECKPOINT` is externally validated (verify must pass
   downstream), so it is proof of progress.

The amendment: `ticket_wall_sec` bounds builder wall time **since the last
green checkpoint** (`build_ms_since_checkpoint`, restarted at each
checkpoint; before the first checkpoint it equals the cumulative total).
`ticket_step_budget` stays cumulative across checkpoints — total work is
still bounded regardless of progress, and thrash still hits the wall budget
at the same attempt boundaries as before, because thrash lands no
checkpoints. The 30-minute floor is unchanged: it now bounds a
no-progress stretch, which is the shape it was meant to catch.

## Amendment 2 (2026-09-23, same incident): calibrate from the build itself, gate the reset on verify, land green work softly

A review of the first amendment found four remaining defects, all fixed here:

1. **The reset moved from the checkpoint marker to verify-green.** The first
   amendment restarted the clock when the marker *arrived* — but a premature
   `$CHECKPOINT` whose verify fails would restart the very budget that exists
   to bound that thrash. `build_ms_since_checkpoint` now restarts only on the
   verify-green path in `processTicket` (the reconcile re-verify included).
   The snake scenario is unaffected: its verify passed before smoke ran.
2. **The derived wall budget self-calibrates from the build, not the plan.**
   `max(plan-phase wall, 30m floor, 2 × slowest builder invocation)` — the
   new `build_ms_max_invocation` telemetry makes the bound a multiple of the
   model's own observed pace: two checkpoint-less invocations of the slowest
   observed length is the thrash signature. The 30-minute floor now binds
   only when every invocation was shorter than 15 minutes — fast models,
   exactly where the floor is sane. A slow first invocation on a local model
   can no longer be killed by a floor sized for a cloud one, and a resume
   persisted mid-thrash un-wedges itself (the recorded invocation raises the
   derived budget).
3. **Budget exhaustion with a green tree lands softly.** The old stop flipped
   the run to `failed` with verified work uncommitted — while the attempt-cap
   path right beside it soft-passes and commits. The budget stop now mirrors
   it: `verify_ok` green and no standing blocker → commit as a soft-pass,
   then stop the run as `stopped` (a stop-for-human, not a failure). A red
   tree or a standing blocker keeps the hard fail.
4. **The step budget's scaling was decorative.** `resolveStepBudget` was
   `max(80, contextTokens/2000)`: below a 160k window the floor always won
   (64k → 32), so "80" was a constant wearing a formula. It is now
   `max(120, contextTokens/1000)` — 120 because this ADR's incident ticket
   needed 95 steps and a routine first ticket already uses ~50.

Two smoke-gate repairs ride along, both from the snake incident's root cause
(`timeout 5 cargo run --release` on a windowed game — a command that can
never pass): every smoke outcome now prints to the console (the phase
previously wrote only to `ticket.logs`, which is why the run's log read
"verify PASS, then died for no reason"), and exit code 124 — GNU
`timeout(1)`'s kill code — is treated as the success it is for a
run-until-killed app, identical to `runSmoke`'s own `timedOut` path. A panic
signature in the output still fails first.

## Amendment 3 (2026-09-25): the step budget leaves room for the capacity recovery

The spriteforge run `run-20260925-2006` exposed a self-contradiction in the
defaults. Ticket 02 (spine shell + canvas + pencil) ran two capped
invocations of 120 steps, each filling ~85k of its 100k window and compacting
once — one compaction per invocation, i.e. normal fill management, not a
spiral. On the second invocation the accumulated phase file reached two
compactions, so the capacity verdict fired at rung 3: a fresh session from
the last green commit is cheaper than another compaction cycle. But
`ticket_step_budget` defaulted to `2 × max_phase_steps` — exactly the two
invocations already spent — so the budget check at the next attempt boundary
stopped the ticket before the fresh session the verdict prescribes could
ever run. The recovery was structurally unreachable in the very case it
exists for.

The default step budget is now `3 × max_phase_steps`. The third window is the
capacity recovery's own invocation: two checkpoint-less windows reach the
verdict, and one more gives its remedy a chance to run. The wall budget keeps
its `2 × slowest invocation` derivation — it bounds checkpoint-less time, and
the observed incident bound it last (27.4m against 32.9m) — and explicit
`ticket_step_budget` / `ticket_wall_sec` still win, so an operator can raise
or disable either. A ticket that spends the third window without a green
verify stops as before, now with a fresh session's output in the ledger
rather than a dead-end diagnosis.
