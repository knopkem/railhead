# PLAN.md and the interactive plan review loop

Recorded after the staged-planning change (ADR 0039). Planning now emits a
design and an architecture, but both are deliberately distilled — terse
gate/reviewer inputs. The human who asked for the build never saw the full
plan: after planning the CLI only asked "Start this run now?", so the first
chance to object to scope, approach, or ticket breakdown was after hours of
implementation. And in non-auto mode the model-driven coverage audit is the
wrong verifier anyway: the user is present and can judge the plan directly.

## Context

- `$DESIGN`/`$ARCHITECTURE` are capped ("3-15 sentences", "under ~40 lines") so
  they stay cheap to inject into every later prompt. That makes them summaries,
  not the plan.
- The coverage audit (ADR 0039) exists for unattended runs. Interactive runs
  have a better auditor sitting at the terminal, but the pipeline gave them
  no artifact to review and no loop to revise it.
- The ticket decomposition is where scope is actually allocated; a plan review
  that cannot see or change tickets would miss the most consequential part.

## Decision

### 1. `$PLAN` — the complete, authoritative plan

Build-mode planning emits a `$PLAN` block before the distilled blocks: the
goal restated, approach and rationale, every module/artifact and what it owns,
data/control flow, shared conventions, phases of work in order, risks and
decisions taken, and the definition of done. No length cap; the prompt states
that anything omitted there is scope dropped from the build, and that
`$DESIGN`/`$ARCHITECTURE` are distilled summaries of it. The ticket
decomposition receives the full transcript (including `$PLAN`), so tickets are
derived from the detailed document, not from the summaries.

### 2. `PLAN.md` — the human-facing artifact

`buildPlanMarkdown` composes `PLAN.md` at the repo root: the `$PLAN` body (or,
for legacy plans without the block, the distilled docs) and — once they exist
— a complete ticket breakdown (number, title, what, files, criteria,
dependencies, consumes/produces). It is written twice in an interactive run:
**plan-only before the user is asked to accept it** (no tickets exist yet),
then rewritten by the finalize pass with the ticket section. Fix mode writes
none (one bug, one ticket). `PlanResult` carries `planDoc` and `planPath`.

### 3. Interactive review loop — the user replaces the audit

`runPlan` accepts `reviewPlan` (ADR 0041). When present, the review happens
after the plan is final (design + any planning-interview refinement) and
**before any ticket is decomposed**:

- the goal-coverage audit is **skipped** — the human verifies the plan;
- `PLAN.md` is written plan-only, then the callback receives
  `{ planPath, planDoc }` and returns feedback or null/empty;
- non-empty feedback re-runs the design stage with the user's words
  (`buildPlanUserFeedbackPrompt`), rewrites plan-only `PLAN.md`, and asks
  again;
- acceptance (empty return) decomposes the plan into tickets exactly once,
  runs the mechanical gate, and rewrites `PLAN.md` with the ticket breakdown;
- in the CLI, acceptance IS the start decision: the build begins with no
  further prompt (the old "Start this run now?" question is gone for
  interactive build runs; fix mode, which has no plan review, keeps it).

Auto runs keep the audit and skip the loop, and fix mode ignores it.

### 4. The ticket gate still runs every iteration

The user review replaces the goal-coverage audit, not the mechanical gate:
references/dependencies/one-owner-per-file are correctness checks a human
reviewing prose will not reliably perform, and the gate's repair rounds are
cheap relative to a broken run.

## Non-goals

- Not a plan editor: feedback is model-mediated through a full re-emit, so a
  user who wants to hand-edit prose edits `PLAN.md` for reference but the
  authority remains the planner's blocks.
- Not a change to what the gates read: design/architecture/coherence stay the
  distilled reviewer inputs; `PLAN.md` is the human artifact and the
  decomposition's source.
- Not a fix-mode change.

## Consequences

- A non-auto run's first decision point moves from "build now?" to "here is
  the complete plan — is it acceptable?", before tickets exist and before any
  implementation spend. Answering yes flows straight into tickets and the
  build.
- Every review iteration re-runs only the design stage (bounded by the user's
  patience, ledgered as `plan-revise-user-N`); decomposition happens once, on
  acceptance.
- Auto runs are unchanged: coverage audit, no loop.
- The final finalize rewrites `PLAN.md` with the ticket breakdown alongside
  `docs/design.md`, `docs/architecture.md`, the ticket files, and origin.json.
