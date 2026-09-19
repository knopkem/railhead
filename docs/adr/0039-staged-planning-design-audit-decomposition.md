# Staged planning: design, adversarial goal-coverage audit, decomposition

Recorded after the spriteforge run `run-20260917-0110`. Planning was one model
call that had to interpret the goal, judge its own interpretation, and
decompose it into tickets. It did the first and third and skipped the second:
the plan was its own coverage certificate. The design doc set the quality bar
at *"movement must feel great — that is the bar"*, the architecture chose
"no assets", and the ten-ticket decomposition shipped a GoTY-caliber goal as
procedural `fillRect` graphics with no ticket that could have produced art —
because the ticket-sizing rules (3-5 files, ~40% of the window, ceiling ~12)
left no room for it. Nothing in the pipeline compared the plan to the raw goal.

The sizing rules were also stale. They encoded a fresh-context implementer per
ticket (ADR 0001). The durable session builder (ADR 0022) removed that
constraint: a ticket is now a checkpoint, not a context budget. Rules that
made a small model safe made the plan small — the exact failure mode the
project exists to prevent.

## Context

Three separable defects lived in one call:

- **Self-certification.** The same completion authored the design, the
  architecture, and the tickets. A model cannot adversarially audit its own
  interpretation of the goal in the same response that produced it.
- **Stale sizing.** `≤2-3 files`, `~40% of the window`, `ceiling ~12`, and the
  class-B `file-count` gate finding all assumed tickets must fit a fresh
  worker's window. They biased the decomposition toward scope reduction and
  punished the planner for emitting a large-but-honest plan.
- **No goal-coverage check.** The plan gate checks structural consistency
  (references resolve, one owner per file, orderable) and quality nits
  (placeholders, missing consumes/produces). It never asks whether the plan
  delivers what the prompt asked for. A plan that silently drops a demanded
  capability is structurally perfect.

## Decision

### 1. Build-mode planning is three stages

`railhead plan` (build mode) runs separate model calls, each with its own
output shape and its own ledger phase:

1. **Design** (`planDesignSystemPrompt`, phase `plan`) — emits `$VERIFY`,
   `$INTERFACE`, `$SMOKE`, `$DESIGN`, `$ARCHITECTURE`. The `$DESIGN` block
   must contain a **Goal coverage** checklist: one line per goal demand
   (feature, behaviour, constraint, quality adjective) mapping to the concrete
   deliverable that produces it. An adjective is not a deliverable.
2. **Coverage audit** (`buildGoalCoveragePrompt`, phases `plan-check-N` /
   `plan-revise-N`) — a fresh call that did not write the plan, given the raw
   goal and the plan, asked to enumerate the goal's demands itself (not trust
   the checklist) and emit `$COVERAGE_PASS` or `$COVERAGE_FAIL` with
   `[MISSING]`/`[THIN]` findings. A failed round feeds the findings back to
   the design stage (`buildPlanRevisionPrompt`) for a full re-emit, bounded by
   `MAX_PLAN_COVERAGE_ROUNDS = 2`; an un-cleared plan is rejected, never run.
   An inconclusive audit (no verdict marker) counts as a failed round, never
   as an assumed pass.
3. **Decomposition** (`planTicketsSystemPrompt`, phase `plan-tickets`) —
   emits only the `$TICKETS` array, from the validated plan. It must cover
   every plan deliverable ("COVER THE PLAN ... never silently drop plan
   scope"); the structural gate (`runPlanGate`) is unchanged after it.

Fix mode (`planFixSystemPrompt`) stays a single call: a bug report has no plan
to audit, and the fix ticket is the plan.

### 2. Sizing rules are deleted, not relaxed

- Removed from the planner prompts: the 2-3-file heuristic, the ~40%-window
  one-ticket rule, the `ceiling ~12`, the 10%-of-window file threshold, and
  the read-3/write-2 limits.
- Removed from the plan gate: the class-B `file-count` finding and
  `fileCountWarnings`/`fileCapForBudget`. A ticket's file span is a
  decomposition choice, never a context-window defect.
- Kept: ONE OWNER PER FILE, dependency ordering, contract references, the
  early-shell rule, and the scaffold-first rule. Those are correctness and
  gate safety, not sizing.
- The tickets prompt now states the bar positively: size by verifiability and
  dependency seams; there is no ticket-count ceiling and no file-count cap.

### 3. The railhead stays domain-neutral

No prompt may assume a kind of app. The removed offenders were game nouns in
the surface-recall regex (`paddle`, `ball`, `snake`, `hud`, `game-over`) and
game/web examples in the planner and field-semantics text. The declared
`$INTERFACE` token (`browser-ui` / `canvas` / `terminal` / `none`) is the only
place interaction shape is allowed to influence prompts and gates.

## Non-goals

- Not a replan rewrite: `replan.ts` still regenerates tickets from the same
  plan doc, via the same ticket gate.
- Not a ticket-format change: `TICKET_FIELD_SEMANTICS` and the `$TICKETS`
  schema are unchanged apart from neutral examples (ADR 0007 lockstep intact).
- Not a fix-mode change.

## Consequences

- Build planning costs two extra model calls (design audit, decomposition)
  plus up to two revision pairs. The audit runs before the first ticket, so a
  rejected plan costs minutes, not a build.
- Coverage findings are specific enough to become design changes because the
  audit must name the demand and the missing deliverable; the revision call
  re-emits the complete plan.
- A goal whose quality adjectives cannot be translated into named deliverables
  now fails at plan time instead of shipping — the intended hard edge.
- Tests pin the new prompt split: `plan.test.ts` covers the stage prompts and
  the coverage verdict parser; `planner.test.ts` drives the three-stage flow
  through phase-aware mocks.
