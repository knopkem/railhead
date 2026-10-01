# Unified review cadence: per-gate mode replaces scattered knobs (issue #73)

> Amended by ADR 0046: the per-ticket visual review is serialized inside
> `committedTicket`; the cadence modes and dispatch below are otherwise
> unchanged. Amended by ADR 0047: the TDD test phase is retired (the durable
> builder is the only implementer). Amended 2026-09-27: fix mode no longer
> forces `visual_review.mode: "full"`; `fix` answers the same per-gate cadence
> questions as `build` (the forcing predated the interactive questionnaire,
> which an always-true override check had silently skipped).

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
- The interaction smoke is preset-gated with the gates even though it is not one of the four: it is derived ON for a `browser-ui`/`canvas` interface, but when every gate is off (the `--none` shape) it is off too. `--none` is the no-judges run — the smoke feeds findings back to the builder, so leaving it on made the no-overhead preset the only one that still launched a browser agent. An explicit `interaction_smoke: true` still wins, so a hand-written `railhead.json` can keep the smoke without turning a review gate on. (Amended 2026-10-01.)
- The sharpen interview and TDD phase are preset-gated too: only `--full` keeps TDD on; `--medium`/`--full` run sharpen; `--light`/`--none` skip both (the fast default).
- Fix mode (`railhead fix`) resolves its gates exactly like `build` — interactive runs answer the per-gate cadence questions (code review, then visual), and a vision model being configured forces nothing. (Amended 2026-09-27: this line originally forced `visual_review.mode: "full"` when a vision model was configured, from #6. The forcing overrode the operator's questionnaire answer, and the questionnaire was itself unreachable — the "no gate overrides" test compared parsed `null` values against `undefined`, so every interactive run read as fully overridden. Both are fixed.)
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
