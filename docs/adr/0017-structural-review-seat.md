# Structural whole-project review seat

## Context

ADR 0009 (visual final review) and ADR 0011 (per-ticket visual review)
established review seats that catch per-ticket and end-of-run quality gaps.
ADR 0019 (goal review) added a checkpoint-level evaluator that judges the
running build against the original goal.

None of these seats catch **architectural drift** — the slow accumulation of
structural problems that no single ticket reviewer can see:

- Duplicated abstractions across modules built by different tickets.
- Divergent conventions (naming, error handling, module shape) that drift
  from what `architecture.md` intended.
- Contracts that grew inconsistent when one ticket changed an interface and
  a later ticket didn't follow.
- Dead code from a superseded attempt that no ticket cleaned up.

Per-ticket review sees one diff at a time. Goal review sees the running app.
Neither reads the source as a corpus.

## Decision

Add a **structural review seat** (`src/gates/structural-review.ts`) that runs at
checkpoint boundaries (alongside goal review) and at run end. It reads the
accumulated source as a corpus and flags only structural drift — never
compile failures (verify owns that) or behavior gaps (goal review owns those).

### Why a distinct seat, not a mode of goal review

- **Different judgment frame**: goal review evaluates the *running app*
  against the *original goal*. Structural review evaluates the *source code*
  against `architecture.md`. One looks outward at behavior, the other
  inward at structure.
- **Different ticket class**: goal review produces **corrective tickets**
  (`testable: false` — a behavior gap usually has no unit-testable seam).
  Structural review produces **refactoring tickets** (`testable: true` —
  a structural smell is testable: the refactor must keep tests green).
- **Different prompt**: goal review says "launch the app and interact."
  Structural review says "read the source files as a corpus."

### Config

The original shape was `structural_review: { enabled: boolean, at_run_end: boolean }`
in `railhead.json`, defaulting to `{ enabled: false, at_run_end: true }`.
Issue #73 (ADR 0021) folded cadence into a single `mode` field —
`structural_review: { mode: "off" }` by default, with `full` (checkpoints +
run end), `medium` (checkpoints only), and `light` (run end only).
The seat is opt-in — existing runs are unaffected.

### Model

Reuses `model.goal` (the oversight-tier model). ADR 0015's companion
paragraph (#52) documents that oversight seats are the intended consumers
of the strong-model tier.

### Verdict protocol

`$STRUCTURAL_PASS` / `$STRUCTURAL_FAIL` / `$END` — peer to goal review's
`$GOAL_PASS` / `$GOAL_FAIL`. Reuses `splitFindings` and the
`[BLOCKER]`/`[MAJOR]` severity contract from `reviewer.ts`.

## Consequences

- One additional LLM call per checkpoint (when enabled) and one at run end.
  Paid only when the knob is on.
- Refactoring tickets enter the ticket sequence with `testable: true` and
  block uncommitted tickets via `extendBlockedBy` — same coherence
  mechanism as goal review's corrective tickets.
- The contracts index (`railhead.contracts.json`) is the natural input: the
  structural reviewer compares declared structure against actual source.
