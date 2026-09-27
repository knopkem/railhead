# Smart code review: spend the per-ticket review where the build was stressed

## Status

Accepted. Amends the code row of ADR 0021's cadence table and the retry
thresholds discussion of ADR 0025 (the code gate's `mode` is unchanged; only
WHEN the gate fires changes under the light preset).

## Context

The light preset is the default run shape, and since v2 issue 01 it schedules a
per-ticket code review (`code_review.mode: "medium"`) on every ticket. The
observed cost on the SpriteForge corpus is lopsided: on a strong, well-quantized
model a clean ticket's review mostly returns minor-only findings — pure spend —
while the tickets that carry real blockers are the ones that compact mid-build
(06: two compactions, six blockers across rounds). Compaction is the durable
builder session's normal fill management, not an error, but it is also exactly
the event after which the session no longer holds the design docs, contracts,
and learnings it was seeded with: the diff authored around it is the artifact
that most needs a fresh reader.

The regression is real but not uniform, so making the review unconditional is
waste and making it absent is blind. The previous attempt to turn per-ticket
review off in the cheap presets (v2 issue 01) was reverted precisely because
nothing replaced it at the diff level — the goal/visual passes judge the
integrated product, and structural review judges architecture, but no gate
reads a single ticket's diff.

## Decision

1. **`code_review.trigger: "always" | "smart"` is a persisted config field**,
   orthogonal to `mode`. `mode` keeps its meaning (severity thresholds once the
   gate runs); `trigger` decides whether the gate is spent on a given ticket.
   No new `GateMode` value: the four-mode vocabulary (ADR 0021) stays uniform
   across gates, and smart is meaningless for visual/goal/structural.

2. **The light preset (the default) resolves the code gate to
   `medium` + `smart`.** `--full`/`--medium` resolve `trigger: "always"`;
   `--none` stays off. An explicit `--review <mode>` override resolves the
   trigger back to `always` — a human naming a cadence must not have the gate
   silently stress-skipped — and the interactive questionnaire offers smart as
   the code question's default. `persistPolicy` writes the trigger so
   `resume`/`run` honor it without re-passing flags, and a re-plan off light
   clears it (a `--medium` plan cannot inherit skipping).

3. **The trigger is a pure predicate over persisted telemetry**
   (`src/execute/review-schedule.ts`). The review fires when ANY of:
   - the ticket's merged build-phase telemetry shows ≥1 compaction
     (`summarizePhaseFiles` across every attempt, not just the marker-bearing
     one — the durable session's compaction usually lands in a no-marker
     attempt);
   - more than one build attempt (including attempts persisted before a
     resume);
   - a builder-session restart recorded during the ticket;
   - the ADR 0032 spec reconciliation was spent;
   - a `$BLOCKED` report or unverified criteria were recorded (ADR 0040);
   - a replan or capacity split regenerated the frontier since the last review
     — armed where `state.replan_count` increments and consumed by the next
     review decision.

   Compaction is one stress signal, NOT a defect oracle. The predicate returns
   a reason string, never a bare boolean.

4. **A skipped review is "not run", never a pass** (ADR 0050). The run loop
   records `review_skip_reason` on `TicketState`, leaves `review_ok` null,
   pushes no verdict, and logs the skip. When the review does fire it runs the
   configured mode's severity rules unchanged (BLOCKER + MAJOR through the
   retry machine under medium) — no new retry threshold exists.

5. **Coverage honesty.** `report.md` gains a smart coverage section: reviews
   run vs skipped with reasons, plus a false-negative tally — a skipped ticket
   counted when a later goal/structural record with findings covers its group,
   or any run-end record has findings. The tally is group-scope, not exact
   per-ticket attribution (findings name artifacts, not always ticket
   numbers); it is the measurement that decides whether smart's skipping is
   trustworthy. `railhead overview` renders a skipped review as
   "not run (smart — no stress)".

6. **Nothing else is suppressed.** The interaction smoke keeps its once-per-
   committed-group-boundary cadence, and goal/structural checkpoints are never
   stress-gated: their failure classes (wiring gaps, cross-ticket drift) are
   orthogonal to context loss, and mid-run checkpoints are where correction is
   cheapest. Stress-based earlier escalation is not part of this decision.

## Consequences

- Clean runs stop paying N review phases; stressed runs review exactly as
  before. The savings scale with plan size and model quality.
- On a clean run the only remaining judges of committed work are verify/smoke
  (mechanical), the interaction smoke (boundary), and the goal/visual/structural
  run-end passes (product/architecture) — no gate reads an individual clean
  ticket's diff. That is the deliberate trade; the coverage section and the
  false-negative tally make it visible, and `--review medium|full` or
  `"trigger": "always"` restores unconditional review per project.
- The trigger is derivable from persisted telemetry, so resume re-decides
  identically; the replan arm is persisted (`smart_review_armed`) so a stop
  between a replan and the next ticket cannot lose the signal.
- `src/config/AGENTS.md`, `src/execute/AGENTS.md`, and the README describe the
  preset, the trigger, and the never-suppressed gates. Tests cover the
  predicate's boundaries, the resolver/persistence matrix, the run loop's
  skip-vs-fire behavior per signal, and the report's coverage rendering.
- Non-light behavior is unchanged: `always` is the default and the existing
  cadence suites pass unmodified.
