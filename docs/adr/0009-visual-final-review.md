# Visual final review via a self-capturing vision-model agent

> Amended by ADR 0048: corrective tickets carry no `blocked_by`; they are
> inserted immediately before the remaining planned frontier and run inline.

## Context

Per-ticket review (ADR 0005) is diff-based: the reviewer reads the working diff and judges it against the ticket's criteria. That covers correctness gaps a model can see in source — but it cannot validate runtime or visual criteria: "the snake renders without ghosting", "the menu opens on click", "the chart draws axes". These only manifest when the app actually runs. The snake-again run (24 Aug 2026) shipped a classic ghosting bug (missing alternate-screen buffer) that passed text review because the diff looked correct; the ticket even said "no ghosting occurs" as a criterion, but no automated check enforced it.

The goal is local-only end-to-end verification: avoid hosted LLMs while catching what text review structurally cannot. A 27B-class local vision model (e.g. qwen3.8-27b) can read a screenshot; the question is how the railhead feeds it one without the railhead itself becoming a screenshot-capture subsystem.

## Decision

A **visual final review** is a single opencode run with a vision-capable model and full bash access, invoked once at the end of a run (not per-ticket). It is *opt-in*: the user passes `--final-review` (or accepts the review-mode prompt that offers it) and a vision-capable `model.review`. The railhead does not capture screenshots itself. The agent captures what it needs.

### Why the agent captures, not the railhead

There is no general railhead-side capture primitive that works across "Rust terminal game", "browser app", "native Cocoa window", "SDL game". Each requires a different screenshot path (PTY grab, `screencapture`, headless browser, offscreen render). Building any one of these into the railhead commits to a platform and an app type — exactly the kind of surface the railhead exists to avoid.

The alternative — let the agent own capture — is already proven to work. In a prior plain-opencode run (not the railhead) qwen3.8-27b, tasked to build a racing game, autonomously exported a PNG from its own game and used it to verify the render, without being told to. A capable bash-equipped vision model treats `screencapture`/`ffmpeg`/a headless browser as just another tool. The railhead's job is to invoke it and parse its verdict, not to know how a screenshot is taken.

This keeps the railhead generic: the capture mechanism is the agent's problem, parameterized by the project it's running against. The railhead stays free of platform-specific dependencies.

### Shape

- **When:** after every ticket in the run is committed (or soft-passed), as a single terminal gate. Not per-ticket: visual checks are expensive (model + capture) and a per-ticket visual gate would either need a partially-integrated app (which doesn't exist mid-run) or risk blocking early tickets on visuals that only make sense once the whole app is integrated.
- **Model:** `model.review` (the same slot as text review), but the user is responsible for pointing it at a vision-capable local model. If `model.review` is a text-only model, visual review is a no-op with a warning — we do not silently fall back, because a text model cannot see the screen and a silent skip would give false confidence.
- **Prompt:** the agent receives the build mission, the aggregated acceptance criteria across all tickets, and the verify commands. It is told: "capture the running app one or more times using whatever tool the project provides (`cargo run`, `npm run dev`, a binary path from the ticket's `files`); judge each screenshot against the criteria; emit `$VISUAL_PASS` or `$VISUAL_FAIL` with findings." The agent has bash to run the app, take screenshots, and inspect them.
- **Verdict parsing:** a new `parseVisualVerdict(transcript)` returns `"pass" | { findings: string[] }` by slicing between `$VISUAL_FAIL`/`$VISUAL_PASS` markers, mirroring the text reviewer's `$BLOCKING`/`$OK` shape. Severity (`[BLOCKER]`/`[MAJOR]`) is reused so the existing soft-pass logic at the attempt cap applies unchanged.
- **Failure → tickets:** on `$VISUAL_FAIL` with `[BLOCKER]` findings, the railhead generates corrective tickets (one per finding, blocked_by the failing ticket) and re-runs them. This is the closed feedback loop the user originally proposed for general final review; it is **bounded by `max_attempts`** at the *round* level (each visual-review round = one attempt; default cap 9, reusing `max_attempts`). Distinct findings reset the per-round budget per ADR 0005, but the absolute `max_attempts` cap terminates the loop regardless.
- **Capture artifacts:** screenshots the agent takes are written under `.railhead/<run-id>/visual/` so the report can reference them and a human can see what the model saw. These are not committed to git (they are run outputs, not source).

## Consequences

- The railhead adds one new phase (visual review) and one new parser (`parseVisualVerdict`). No new platform capture code, no new subprocess shape — it reuses `executeOpendCode` with `agent: null` (default opencode agent with bash) and a vision model.
- Visual review runs only when explicitly requested with a vision-capable `model.review`. Default behavior (text-only model, or no `--final-review` flag) is unchanged.
- Corrective tickets generated from visual findings are ordinary tickets and flow through the normal implement→verify→smoke→review→commit pipeline. They show in `report.md` like any other.
- The closed loop is bounded by `max_attempts` at the round level; an illusory-finding drift (the model keeps finding "something" visually wrong) terminates at the cap and soft-passes if no `[BLOCKER]` survives, mirroring per-ticket review's safety property.
- This defers the question of *what* screenshot to take entirely to the agent. If a future project type makes that hard (e.g. a hardware-dependent native app), visual review simply won't fire usefully for that project and the user falls back to manual visual inspection — the same status quo as today, gated behind one opt-in flag.

## Open questions (deferred to implementation)

- The corrective-ticket generator: does it synthesize a full `PlanTicket`-shaped file (title/mission/what/criteria/blocked_by), or a lighter "fix this finding" stub? Leaning toward the full shape so the existing pipeline consumes it unchanged, but the trade-off is plan-quality of generated tickets.
- Whether `parseVisualVerdict` needs a severity split or whether a visual fail is always treated as `[BLOCKER]` (if you can see it's broken, it's blocking). Leaning toward always-`[BLOCKER]` for simplicity.
- How the report surfaces the screenshot paths so a human can audit the visual verdict without digging into `.railhead/`.

## Amendment: an `inconclusive` verdict for "agent ran, produced no evidence" (Aug 2026)

The original `parseVisualVerdict` returned only `"pass" | "fail"` and defaulted no-marker to `pass`, mirroring the text reviewer's defensive rule ("we don't fabricate a failure from ambiguous text"). This was wrong for *visual* review. Visual review's whole point is to run the app and SEE it work; a transcript with no `$VISUAL_*` marker almost always means the agent never got the app running (e.g. a terminal app that fails without a TTY, which is exactly the railhead's own subprocess situation). Coercing that to PASS shipped a broken snake game behind a silent agent — the report read "Visual review: PASS (round 1)" while the binary panicked on startup every time the agent ran it.

`runVisualReview` had the same defect one layer up: a stuck agent (`budget_exceeded`) and a crashed agent (non-`ok` status) were both coerced to `{ verdict: "pass" }` with the comment "cannot fabricate a failure from a stuck agent." That logic confused "no evidence of failure" with "evidence of success" — opposite things.

The fix introduces a third verdict, `inconclusive`, for "the agent ran but produced no verdict":

- `parseVisualVerdict`: no marker → `inconclusive` (not `pass`); `$VISUAL_FAIL` with `NONE` → `inconclusive` (not `pass`). An explicit `$VISUAL_PASS` marker is still required for `pass`. This raises the bar from "the agent didn't say it failed" to "the agent said it passed."
- `runVisualReview`: stuck/crashed agent → `inconclusive` (not `pass`).
- `visualReviewLoop`: an `inconclusive` verdict leaves `visual_ok = null` (the run is *not verified*, not *passed*), generates **no** corrective tickets (there's nothing concrete to fix), and returns. `overview.ts` distinguishes `visual_ok === null && visual_rounds >= 0` as "INCONCLUSIVE (manual visual inspection required)" from `visual_rounds < 0` as "not run."

This matches the ADR's original ¶36 intent — when visual review can't fire usefully, the user falls back to manual inspection — but makes the railhead *say so honestly* rather than reporting PASS. The soft-pass for `$VISUAL_FAIL` with only `[MAJOR]` findings is unchanged: that is an intentional ADR 0005 carry-over (agent saw minor issues, nothing blocking), not an evidence vacuum.
