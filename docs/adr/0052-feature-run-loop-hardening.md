# Feature-run loop hardening: a real steering loop, not a one-shot condense

Amends ADR 0051 after its first implementation. The one-feature-per-run shape
holds; what changes is that the arc is sharpened before adoption, each feature
is grounded in what the repo actually is, and the human gate between steps is
enforced by machinery instead of convention.

## Context

ADR 0051's first cut was operator-shaped end to end. `railhead product` was a
single condense call explicitly forbidden from pushing back ("The operator
drives; you condense their input"), with no interview and no review — so the
arc was only as good as one paragraph. The feature prompt was derived in the
operator's voice with no ground truth about the repo (the arc session never
even received the contracts index, and the derivation was told not to look).
Feature-mode planning inherited the greenfield art-direction rules, so every
rendered feature run could re-author the look and claim "everything the user
sees" — exactly the drift the coherence charter exists to prevent. And the
human gate was not machinery: `firstOpenStep` skipped a `built` step, step
identity was not persisted, so `resume`/`run` could not finish the arc
transaction and the post-run `built` write sat uncommitted.

## Decision

### 1. The arc is sharpened, then adopted

`railhead product` runs the existing planning-interview discipline after the
condense (depth picker, `--sharpen`/`--no-sharpen`, `sharpen_max_rounds`;
`-a` defaults to no interview). A new `product` interview mode asks only what
the operator alone knows — the MVP cut, each step's outcome and the morning
after test, ordering, explicit outs — never code structure. Non-empty answers
revise the arc through one more `$PRODUCT` stage that preserves step numbers,
statuses, run ids, and untouched prose. The full arc prose (not just the step
titles) is printed before adoption; parser warnings are surfaced.

### 2. The derivation is grounded, not mimicry

The feature-step prompt must produce a structured brief — Goal, the behaviour
plus the literal morning-after check, integration points named from the
project's real contracts/digest/learnings, out of scope, verified by. The
derivation receives the contracts index, the rolling digest, and the project
learnings; a reopened step also carries its previous run's report. The plan
gate and the feature goal review receive the exact roadmap step (description
and reopen feedback) in addition to the derived prompt, so a demand the
derivation dropped is still judged.

### 3. The held charter owns the look

Feature mode never uses the greenfield art-direction blocks. With a held
coherence charter, the design stage plans only the feature's new surface and
never restates or restyles the product; an open-ended craft ticket is
required only when the feature introduces a genuinely new surface, scoped to
it — the deterministic whole-look craft-ticket append and the false
"no coherence contract" warning are gone in feature mode with a held charter.

### 4. The human gate is machinery

The arc frontier is the first step that is not `done`; a `built` step blocks
the steps after it until the human marks it done or reopens it with feedback
(`--step N` is the explicit, warned override). Run-end marks the step `built`
and commits the arc update on the run branch — whenever the run finishes,
including via `resume`/`run` — and the interactive CLI asks done / leave /
reopen with feedback immediately. The step identity (`arc_step`) is persisted
in `origin.json` and `RunState`, so a resumed run still knows which roadmap
step it builds. Feature plans use a stable `step-<NN>-<title>` slug, so a
reopened step reuses its `.scratch/<slug>/` plan namespace and `run/<slug>`
branch instead of fragmenting a new one per attempt.

### 5. The feature verify block copies, never extends

A feature plan emits the project's existing verify commands unchanged. New
checks that only pass once the feature is complete would violate ADR 0006
(green after every ticket); new behaviour is verified by ticket criteria and
probes, and the final hardener ticket grows the suite at the end.

## Consequences

- The nightly loop is: sharpen the arc when steering, `railhead feature`,
  answer the done/reopen prompt in the morning, steer again. The arc's prose
  is what the operator adopts, sees in `railhead status`, and edits.
- A feature run's arc update travels with its `run/<slug>` branch; merge the
  branch (or keep working on it) to carry the `built` marker to the
  integration branch. No checkout automation — the pre-run update still
  commits on the checked-out branch before the run branches.
- Legacy feature runs (origin without `arc_step`) still get the arc context
  in goal review; they simply cannot auto-finalize the arc.

## Non-goals

No auto-merge/rebase of feature branches, no multi-step auto-continue, no
automatic `done` (verification is the human's call), and no arc editing
outside `railhead product` and hand edits.
