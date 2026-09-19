# Plan-time sharpening: a bounded interview revises ADR 0007's lean-planner stance

> Superseded in part by ADR 0021 (issue #73): the interview is now gated by
> the run preset — `--medium`/`--full` run it (auto-answered under `-a`),
> `--light`/`--none` skip it, and `--sharpen`/`--no-sharpen` override. The
> `-ns`/`--no-sharpen` flag name survives as `--no-sharpen`; `sharpen_max_rounds: 0`
> still disables it. The mechanics recorded below are unchanged.

`railhead plan` now runs a bounded clarifying interview before generating tickets, ported from the `sharpen-with-docs`/`domain-modeling` discipline as railhead-owned prompts and parsers — no runtime or install-time dependency on an external skill suite, extending rather than abandoning ADR 0007's "the only external dependency is opencode." It is skipped entirely only under `-ns`/`--no-sharpen`; otherwise it runs by default. Under `-a`/`--auto` (formerly `-y`/`--yes`), the interview still runs but the model auto-answers its own questions — terms and ADRs still resolve to `CONTEXT.md`/`docs/adr/`, and the transcript still enriches the planner prompt. The depth picker's "Skip (auto-answer)" option is the interactive equivalent.

Mechanically it is railhead-driven rounds, not a live interactive session: each round is one ordinary `executeOpendCode` phase call (a fresh, stateless subprocess per ADR 0001), ledgered under `.railhead/plan-latest` like `runPlan`'s own phases. The railhead parses the model's `$TERMS`/`$ADRS`/`$QUESTIONS`/`$DONE` marker blocks, renders questions to the terminal, and collects answers via readline — the same mechanism the rest of the Gate already uses for `$CONTRACTS`/`$TICKETS`/`$BLOCKING`, not a new one. This keeps the interview inspectable via `railhead log` and inside the existing "fresh subprocess per phase" architecture, unlike a long-lived interactive `opencode` process.

Resolved terms land in `CONTEXT.md` and qualifying hard decisions in `docs/adr/` as they resolve, not batched at the end — matching `domain-modeling`'s discipline, and reusing conventions this repo already follows by hand for its own glossary and ADRs. `planSystemPrompt` now also reads `CONTEXT.md`, so a sharpened glossary reaches ticket generation even on a later run that skips the interview. `sharpen_max_rounds` (default 6, `0` disables the interview) bounds a model that never emits `$DONE`.

This revises ADR 0007's "planning is intentionally lean, not an open-ended interview step": the interview step now exists, but it is bounded, skippable, and produces the same tracked artifacts the rest of the project already relies on for its own decisions.

## Amendment: `-a`/`--auto` runs the interview (auto-answered), not skipped

The original ADR made `-y`/`--yes` skip the interview entirely — no subprocess, no terms/ADRs written. This meant the fully-automated path produced no `CONTEXT.md` or `docs/adr/` updates, losing the domain-modeling artifacts even when the model could have resolved them itself. The flag has been renamed to `-a`/`--auto` (with `-y`/`--yes` kept as aliases) and now runs the interview in skip mode: the model auto-answers its own questions using its recommendations, terms/ADRs still resolve to disk, and the transcript still enriches the planner prompt. The interview only truly skips under `-ns`/`--no-sharpen` (or `sharpen_max_rounds: 0` in config). This preserves the fully-automated, no-human-prompts contract while ensuring the domain artifacts are always produced.
