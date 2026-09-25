# Unified review cadence: per-gate mode replaces scattered knobs (issue #73)

> Amended by ADR 0046: the per-ticket visual review is serialized inside
> `committedTicket`; the cadence modes and dispatch below are otherwise
> unchanged. Amended by ADR 0047: the TDD test phase is retired (the durable
> builder is the only implementer).

## Status

Accepted.

## Context

Four review gates (code, visual, goal, structural), plus the sharpen interview and TDD test phase, each had its own cadence controls with inconsistent shapes: a run-level `review_mode` (full/advisory/none/final) that only gated code review, `visual_review: { enabled, per_ticket }`, `goal_review: { enabled, fallback_cadence }`, and `structural_review: { enabled, at_run_end }`. Consequences:

- No way to defer goal review to run end (goal was checkpoint-only).
- `structural_review.at_run_end: false` looked like it suppressed all end-of-run reviews but only affected structural.
- `advisory` code review was unused and confusing; the opt-out CLI flags (`-nt`, `-nr`, `-nv`, `-ns`) implied everything was on by default when the desired default is a faster, lighter run.
- No single vocabulary to say "catch problems early at group boundaries but do not re-review at the end".

## Decision

Every review gate carries a cadence `mode` with four values:

| Mode | Mid-run | At run end |
|---|---|---|
| `full` | natural cadence (per-ticket code/visual; group checkpoints goal/structural) | fires |
| `medium` | natural cadence only | does not fire |
| `light` | none | fires (default run shape) |
| `off` | none | none |

- Gate config: `code_review.mode`, `visual_review.mode`, `goal_review.mode`, `structural_review.mode`. Per-gate tuning knobs orthogonal to cadence stay (`max_rounds`, `interaction_hints`, `fallback_cadence`).
- Four plan-time presets map every gate + TDD + sharpen at once: `--full`, `--medium`, `--light` (default), `--none`. Per-gate overrides (`--review/--vision/--goal/--structural`) and boolean overrides (`--tdd/--no-tdd`, `--sharpen/--no-sharpen`) layer on top. Resolved modes are persisted to railhead.json so resume honors them.
- The sharpen interview and TDD phase are preset-gated too: only `--full` keeps TDD on; `--medium`/`--full` run sharpen; `--light`/`--none` skip both (the fast default).
- Fix mode (`railhead fix`) forces `visual_review.mode: "full"` when a vision model is configured and defaults TDD off (the bug reproducer is already the test, #6).
- End-of-run goal review is new: `goal_review.mode: full|light` runs a goal review after the run's tickets commit, after the end-of-run visual pass (whose screenshots are evidence the goal reviewer can reference).
- `code_review.mode: full|light` runs the end-of-run review pass over each committed diff (the former `final` mode became `light`).

### Deviation from the issue as filed

The issue specified `mode: full | light | off` for every gate, but its own `--medium` behavior table gives goal/structural a fourth effective state — group checkpoints only, no end-of-run pass — which a three-valued mode cannot express. We added `medium` as a real gate-mode value (full-without-the-safety-net). For goal/structural it is checkpoint-only; the mode vocabulary is uniform across gates, so code/visual accept `medium` too (parity with the issue's `--medium` preset), where it means the mid-run cadence without the run-end pass.

### Legacy config

Pre-#73 railhead.json shapes are read as cadence modes on load: visual `enabled + per_ticket` → `full` (per-ticket+end) or `light` (end only); goal `enabled` → `medium` (its historical checkpoint-only behavior); structural `enabled + at_run_end` → `full` or `medium`. `advisory` code review is dropped (it was unused).

## Consequences

- One knob vocabulary for "when should this gate fire"; the "no way to defer goal review" and "per-ticket visual is invisible" gaps close.
- Light is now the default run: code/visual/goal/structural each fire once at run end unless the user opts into early review.
- The mid-run trigger mechanics are unchanged: `shouldRunVisualReview` ticket filtering, group-checkpoint detection and `fallback_cadence`, per-ticket visual pipelining with the next implement (#35), and the `finalReviewPass` implementation all stay — they are now dispatched by mode instead of by per-gate booleans.
