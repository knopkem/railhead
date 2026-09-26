# The product arc: one feature run at a time

Complements the one-shot `railhead build` (unchanged for its demo sized
jobs) with an agile mode for real products: a durable product arc, and one
unattended feature run per session, stopped at a human verification gate
between steps.

## Context

`railhead build` steers a hard model through an entire app from one prompt.
That works for demos and tests, but a product is not built one shot: an
overall vision exists first, an MVP proves it, the operator tests, refines
the goal, and builds feature by feature — over months. The build machinery
(plan → durable Builder → verify/smoke → gates → per-ticket commits) is
exactly the loop a feature needs; nothing in it requires the plan to be the
whole product. What is missing is the thing around the loop: a durable
product identity, consistency between overnight builds done weeks apart, and
a human steering point that survives the whole process.

The machinery mostly survived a second run already: learnings, digest,
probe scripts, coherence charter, CONTEXT.md/ADRs, and the contracts index
are project-scoped by design (ADRs 0012, 0018, 0028, 0008); per-ticket
diffs are diff-scoped; the replan prompt already speaks "preserve committed
work". The one-shot assumption was concentrated in: greenfield planner
prompt rules (scaffold-first ticket, entry-point-once, a whole-app
launcher-first spine), the empty contracts index literally telling a real
repo "this is likely a greenfield repo", per-build overwrites of
`prompt`/`PLAN.md`/`docs/design.md`/`docs/architecture.md`, the absence of
any verify baseline (ADR 0006's premise was assumed, never checked), and two
git hazards for repos with real history (subject-scan ticket pre-marking;
`git clean -fd` destroying untracked files a diff cannot carry).

## Decision

### 1. The product arc (`docs/product.md`) is the durable artifact

Railhead owns the format (render/parse round-trip, like tickets per ADR
0007): decided prose sections (Vision, Workflows, Traits, Stack) plus a
Roadmap of ordered steps, each with a life-cycle status. `railhead product`
condenses (or steers, when the arc exists) the operator's input into the arc
in ONE planner-family call — model-condensed by decision, never silently
written: the CLI shows the parsed arc and adoption is explicit. Hand edits
survive byte-for-byte; only the machine-readable marker lines are
normalized.

Step life-cycle: `todo` → (feature run finishes) `built` (records the
run id) → human tests → `done`, or back to `todo` with a feedback note the
next attempt's derivation folds in as hard constraints.

### 2. `railhead feature` is a third plan mode

`build` (whole app, one shot) / `feature` (one step of a product) / `fix`
(one defect) share the engine; the verb names the unit. Without a
description, `railhead feature` derives the first `todo` step into the
feature prompt in ONE call (`railhead feature "<desc>"` and `--step N` are
the explicit forms). The feature prompt is archived in the step's plan
namespace. When the run finishes, the step is marked `built`; a run that
halts or fails does not advance the arc. No multi-step auto-continue exists
— the human gate between steps is the point.

### 3. Explicit mode, not prompt hope

`PlanMode` gains `feature`; persisted as `feature_mode` in railhead.json so
runs and resumes reproduce the same posture. The differences are machinery,
not instructions to a model:

- **Planner prompts** (`planFeature*SystemPrompt`): existing-codebase
  posture — contracts, charter, and stack are DECIDED; no scaffold-first
  ticket, no second entry point; first ticket is an integration slice
  leaving the EXISTING suite green; the spine-first rule becomes
  feature-first. The arc brief and the held coherence charter ride every
  feature-plan stage (consistency across overnight builds: same stack
  reuse, same art language).
- **Doc namespacing**: a feature plan's docs (PLAN.md, design.md,
  architecture.md) live beside its ticket store (`.scratch/<slug>/docs`);
  `state.docs_dir` resolves the location once at run start and every seat
  (base-session preamble, builder, reviewers, goal/structural gates,
  corrective tickets, replan) reads through it. Project-root docs are never
  overwritten. The coherence charter stays project-scoped (persisted once,
  amended by the goal reviewer) — it is the cross-run visual contract.
- **Baseline gate**: a fresh feature run refuses to start when the
  project's verify is red, pointing at `railhead fix "<failing output>"`
  (ADR 0006's premise, checked).
- **Goal review scoping**: in feature mode the goal reviewer receives the
  arc context and judges the FEATURE's goal; later roadmap steps are out of
  scope by design; regression of the existing product is a blocker; the
  final-group pass judges the feature's full goal, never the whole product.

### 4. Git safety for real repos (applies to all modes)

- `origin.json` records `base_sha` (HEAD at plan time); ticket pre-marking
  and resume reconciliation match ticket titles only against commits on top
  of that base — a years-old "01 — Title" commit can never satisfy a fresh
  plan's ticket.
- `cleanWorktree` archives unprotected untracked files byte-for-byte beside
  the diff stash before `git clean -fd` — a unified diff carries no binary
  content, so untracked assets used to be destroyed without a backup.
- `commitPaths` commits named paths only (the arc update lands on the
  product branch before the run branches, keeping per-ticket diffs pure).

## Consequences

- The unattended runs stay small, reviewed, and committed one checkpoint at
  a time while the product-level story (what exists, what is next, why)
  lives in one committed, hand-editable document.
- A session is: `railhead product "..."` when steering, `railhead feature`
  before bed, `railhead status` for the arc, `railhead fix` for a red
  baseline or a morning bug report. Nothing about `build`/`fix` changes.
- The arc file is a single point of failure whose corruption is a degradable
  (not fatal) event: parser warnings, never throws; adoption is explicit.
- Feature runs on a repo that never ran `railhead build` get an empty
  contracts index — the existing-repo framing of `summarizeContracts`
  replaces the greenfield line instead of lying to the planner.

## Non-goals

No unattended multi-step runs, no auto-restarts of the arc, no
auto-stabilization of red baselines, and no merge/rebase automation of
feature branches — the human gate between steps is the feature, not overhead.
