# Railhead

Drive `opencode` over dependency-ordered tickets, unattended. The build runs as one durable opencode session (or a fresh subprocess per ticket — see Durable-session builder), and every ticket is verified, reviewed, and committed before the next one starts. A contracts index keeps each phase's context O(ticket), so small local models and cloud models alike can run an arbitrarily large project.

## Install

```bash
npm install -g railhead     # or run it ad hoc: npx railhead <command>
```

Requires Node 20+, `opencode` on PATH, and a configured model (local or hosted). From a clone, `npm install && npm link` puts `railhead` on PATH; the CLI ships as a compiled JS bundle built by the `prepare` step.

## Quick start

```bash
railhead plan "a CLI that parses RSS feeds"       # model writes dependency-ordered tickets
```

This will first initialize the repo (`railhead init`) and lets you pick a model for each seat (plan, implement, review, visual, goal) or leave empty to use the opencode default.

Note: you can query the available models via: `opencode models` command.

`railhead plan` prints a live progress stream, writes the plan to `PLAN.md`, and — unless `-a`/`--auto` — lets you read it and ask for changes. It also runs a bounded clarifying interview (the `--light`/`--none` presets skip it; `--sharpen` forces it) whose answers revise the plan before tickets are decomposed; resolved vocabulary lands in `CONTEXT.md`, hard decisions in `docs/adr/`. The plan's design narrative and architecture are persisted as `docs/design.md` and `docs/architecture.md`.

Recommended to use vision capable models for reviewer and enable vision. This allows the reviewer to visually verify any UI output (if that is part of the ticket).

If there are bugs, don't use the plan feature but rather call it via:

```bash
railhead fix "paddles don't move"
```

This creates bug tickets and asks questions how to reproduce instead of how to implement.

## Commands

```
railhead init                                       git init + default railhead.json
railhead plan "<prompt>" [--model M] [-a] [--full|--medium|--light|--none] [--verbose]   turn a description into tickets
railhead fix  "<bug report>" [--model M] [-a] [--full|--medium|--light|--none] [--verbose]  turn a bug report into a fix ticket
       the interview asks ONLY about reproduction (trigger, symptom, expected) — never
       about code structure, which the planner reads itself. Use for runtime bugs a
       code-reading planner would otherwise misdiagnose as "already implemented."
railhead run <tickets-dir> [--verbose] [--pause-on-failure]
       [--plan M] [--exec M] [--review M] [--review full|medium|light|off]   run the queue
       [--vision …] [--goal …] [--structural …] [--tdd|--no-tdd]
railhead resume [<run-id>]                         continue a stopped/interrupted run
railhead status [<run-id>]                         show a live summary
railhead next [<run-id>]                           show the next actionable ticket(s) and what's blocked
railhead log [<run-id>] [<phase>]                  pretty-print a phase transcript from the ledger
railhead reset [--hard]                            abandon the latest interrupted run
       --hard also discards git work on the run branch back to the branch point
railhead diagnose screenshots [--model M]          test whether the model can take a screenshot and read it back
```

`railhead log` with no phase lists every phase in the run. Example: `railhead log 01-01-implement` renders the implementer's tool calls, outputs, token counts, and errors as a readable transcript. Ctrl-C during a run is a request, not a kill: the first press stops gracefully at the next ticket boundary, the second stops now (see Stopping a run).

## Planning interview

In build mode the interview runs *after* the plan exists: `railhead plan` writes `PLAN.md`, the interview's answers revise it, then tickets are decomposed from the accepted plan. Fix mode asks before planning, since a bug report has no plan to refine yet. Each round is one ordinary opencode phase call (not a live chat session): the railhead renders the model's questions with its recommended answers, collects yours, and folds the exchange into the next round's prompt. As terms and hard decisions resolve, they land in `CONTEXT.md` and `docs/adr/` immediately, not batched at the end.

```
❓ Q1 - Storage: Where does state live?
➡️ SQLite
```

Skipped by the `--light`/`--none` presets (the fast default) and run explicitly by `--medium`/`--full`; `--sharpen`/`--no-sharpen` override either way. Under `-a`/`--auto` the model auto-answers its own questions. Bounded by `sharpen_max_rounds` (default 6; `0` disables it entirely) — the model's own signal usually ends it sooner. The sharpened `CONTEXT.md` glossary feeds every later `railhead plan` call, interview or not.

## The Gate

Each ticket on the frontier (blockers all committed) runs:

```
IMPLEMENT  durable opencode session resumed across checkpoints (session_builder, default since ADR 0022)
           or a fresh subprocess per ticket (session_builder: false, ADR 0001)
           prompt = ticket + contracts + verify cmds
VERIFY     railhead.json verify commands; must be green
REVIEW     opencode run, read-only (railhead-reviewer agent); skipped only when code_review.mode = "off"
    approve → git commit "<NN> — <title>"
    BLOCKER findings → feed back to implementer, retry (bounded by max_retries)
    MAJOR findings → retry in medium/full; in light, one corrective attempt then soft-pass
```

Execution failures escalate through a three-rung failure ladder (issue #80): rung 1 retries identically (rate limits, blips); rung 2 restarts the persistent worker then retries (server crash, poisoned KV cache); rung 3 diagnoses and fails — a fatal config error (bad key, model not found) fails immediately, and a capacity failure (peak near the ceiling, or OOM wording) fails the phase and re-implements with a shrink-scope instruction. A step budget (`max_phase_steps`) still kills phases stuck in an infinite tool loop.

## Configuration

```jsonc
{
  "verify": ["npm run typecheck", "npm test"],
  "max_retries": 3,
  "max_review_retries": 3,
  "max_attempts": null,          // absolute cap (null = max_retries * 3)
  "max_phase_steps": 50,         // kill a stuck phase after N opencode steps
  "verify_timeout_sec": null,    // kill a hung verify command (null = 600s default)
  "stall_timeout_sec": null,     // kill a phase with no output for this long (null = 3600s default)
  "max_step_model_sec": null,    // kill a step after N seconds of model time — no tool, no completed part (thrashing server at 0 tok/s; null/0 disables, default 3600s)
  "sharpen_max_rounds": 6,         // cap on railhead plan's clarifying-interview rounds (0 disables it)
  "infra_backoff_sec": [60, 300, 900, 1800],  // waits before the ladder's two retries (rung 1, rung 2); minute-scale to survive a restarted model server
  "request_ceiling_tokens": 32768,  // largest request a phase may send (default 0.6× the model's window); "max_context_tokens" still accepted
  "model": {
    "plan":      "deepseek/deepseek-v4-flash",   // 27B+ recommended (shapes the ticket graph)
    "implement": "deepseek/deepseek-v4-flash",   // 27B+ recommended (most multi-step reasoning)
    "review":    null,            // 27B+, separate from implement recommended; null = falls back to implement
    "goal":      null,            // 27B+ for goal review; null = falls back to visual → review → implement
    "visual":    null,            // vision-capable 27B+ for screenshot review; null = falls back to review
    "extract":   null             // 9B OK — single-shot structured output only (cheapest seat)
  },
  "visual_review": { "mode": "off", "max_rounds": null, "round_wall_sec": null, "interaction_hints": null },
  "goal_review": { "mode": "off", "fallback_cadence": 4, "max_rounds": null, "interaction_hints": null },
  "structural_review": { "mode": "off" },
  "code_review": { "mode": "light" },
  "session_builder": true,           // one durable opencode session across checkpoints (ADR 0022); false = fresh subprocess per ticket (ADR 0001)
  "checkpoint_granularity": "product" // "ticket" | "group" | "product" — how much plan the session holds between checkpoints
}
```

Models are independent — a big model can plan while a cheap one executes. `null` falls back to the next slot. Override per invocation: `--plan M1 --exec M2 --review M3`.

### Per-seat guidance (ADR 0015)

| Seat | Tier floor | When to use a cheaper model |
|------|-----------|------------------------------|
| `plan` | 27B+ | Never — planning shapes the whole ticket graph |
| `implement` | 27B+ | Never — the implementer does the most multi-step reasoning |
| `review` | 27B+, separate from `implement` | Not recommended below `implement`'s tier — review is judgment work |
| `goal` | 27B+ | Not recommended below `implement` — the goal reviewer shapes remaining work |
| `visual` | 27B+ with vision | Only when using a vision-capable model that still meets 27B |
| `extract` | 9B OK | **Always** — this is the only seat where a cheaper model is endorsed. Use for single-shot contract extraction |

The railhead warns at startup when `review` or `goal` is configured weaker than `implement`, or when any judgment seat is below 27B. These warnings are advisory — the run proceeds, but quality may suffer.

`max_phase_steps` guards a model looping across many steps; `stall_timeout_sec` guards the opposite failure — one step (a bash call, a tool invocation) that never returns, where step count never advances at all. `verify_timeout_sec` covers the same gap for `verify` commands, which have no step signal of their own. All three exist because an unattended run has no human to notice or kill a hang.

Two more guards cover the "slow-but-loud" shapes those three miss (issue #96 — a visual-review round that burned 13+ minutes of ~60s-per-call request timeouts against a wedged browser target, with the step budget still ~95% unspent and the silence timer re-armed by every timeout error). The executor's **degraded-target guard** (default-on, like the spin loop) kills any phase once 5 timeout-class errored tool calls land within a 10-minute rolling window — regardless of tool name or input, and *not* reset by an interspersed success — because a run of request timeouts means the tool target stopped answering, not that the model is looping. Visual-review rounds additionally carry a per-round **wall-clock budget** (`visual_review.round_wall_sec`, default one hour) that bounds a whole round in wall time even when no individual call ever times out.

### Durable-session builder (ADR 0022)

`"session_builder"` (default `true` since the #83 head-to-head; set `false` for the ADR 0001 fresh-subprocess-per-ticket shape) runs the build as ONE durable opencode session resumed across checkpoints (`opencode run --session <id>`, compaction permitted) instead of a fresh implementer subprocess per ticket. The gates — verify, review, visual, goal, structural — are unchanged fresh, diff-scoped phases that interleave between the builder's `$CHECKPOINT` markers, and a failing gate's findings are re-injected INTO the same session: the author of the code receives the verdict, no fresh explorer loses it across a context boundary. `checkpoint_granularity` (`ticket` | `group` | `product`, default `product`) picks how much plan the session holds between checkpoints. Gates and commits stay per-ticket in every mode — only the builder's process lifetime changes. report.md carries the builder's telemetry (checkpoints, session restarts with cause, compactions).

## Review cadence (issue #73)

Every review gate carries a cadence `mode` — `full` | `medium` | `light` | `off` — persisted in railhead.json and chosen per run by preset flags plus per-gate overrides.

**Code review** runs per-ticket in every mode except `off`. The mode controls which finding severities trigger a retry:

| Mode | Per-ticket review | Retry threshold | Run-end pass |
|------|-------------------|-----------------|--------------|
| `full` | yes | BLOCKER + MAJOR | no |
| `medium` | yes | BLOCKER + MAJOR | no |
| `light` (default) | yes | BLOCKER (full budget); MAJOR one attempt then soft-pass | no |
| `off` | no | — | no |

`[BLOCKER]` findings always trigger retry (up to the attempt cap, then hard-fail). `[MAJOR]` findings trigger retry in `medium`/`full` through the retry budget; in `light` they get exactly **one** corrective attempt per ticket, then soft-pass if still unresolved (issue #96 — a real-but-not-blocking gap, like the SpriteForge toolbar pointer-capture bug, deserves one fix shot without stalling the run). Minor findings never trigger retry in any mode (ADR 0005).

**Visual, goal, and structural** review use the mid-run / run-end cadence split. Visual's end-of-run whole-app pass is skipped whenever the goal review is configured to take that same run-end seat (goal mode `full`/`light` + a goal model) — goal review judges the integrated build against the original goal and design doc, which is a stronger frame than visual's per-ticket criteria union (issue #97):

| Mode | Mid-run | At run end |
|------|---------|------------|
| `full` | Natural cadence (per-ticket for visual, group checkpoints for goal/structural) | Fires (goal takes visual's whole-app seat when both enabled) |
| `medium` | Natural cadence only | Does not fire |
| `light` | Skipped | Fires (goal takes visual's whole-app seat when both enabled). Goal exception (ADR 0029): with `goal_review.checkpoint_action: "advisory"` the goal judge ALSO fires advisory at group checkpoints mid-run — see early, steer early, correct once in a single run-end batch |
| `off` | Never | Never |

Presets (`railhead plan … -a --full/--medium/--light/--none`; `-a` alone is `--light`):

| Gate | `--full` | `--medium` | `--light` | `--none` |
|------|----------|------------|-----------|----------|
| Code review | per-ticket, BLOCKER + MAJOR retry | per-ticket, BLOCKER + MAJOR retry | per-ticket, BLOCKER full retry, MAJOR one attempt | off |
| Visual review | per-ticket + run-end | run-end | run-end | off |
| Goal review | checkpoints + run-end | checkpoints | advisory checkpoints + run-end corrective (ADR 0029) | off |
| Structural review | checkpoints + run-end | checkpoints | run-end | off |
| TDD test phase | on | off | off | off |
| Sharpen interview | on (auto-answered under `-a`) | on | off | off |

Per-gate overrides for power users: `--review full|medium|light|off`, `--vision …`, `--goal …`, `--structural …`, plus `--tdd`/`--no-tdd` and `--sharpen`/`--no-sharpen`. The old opt-out flags (`-nt`, `-nr`, `-nv`, `-ns`) and `review_mode` are gone. See [ADR 0021](docs/adr/0021-unified-review-cadence.md).

Reviews split findings into MUST-FIX (blocking) and NITS (non-blocking). In `light` mode, `[BLOCKER]` findings in MUST-FIX trigger retry with the full budget; `[MAJOR]` findings trigger exactly one corrective attempt per ticket and then soft-pass (noted, no further budget burned). In `medium`/`full`, both `[BLOCKER]` and `[MAJOR]` trigger retry. Retry budget resets on progress — fixing distinct bugs won't exhaust it.

## Visual review

Opt-in via `visual_review: { mode: "full"|"light" }` (offered at plan time). A vision-capable `model.visual` runs the app, captures screenshots via bash, and judges it against the acceptance criteria. Emits `$VISUAL_PASS` or `$VISUAL_FAIL` with findings. On failure, generates corrective tickets and re-runs them, bounded by `max_attempts`.

`mode: "full"` fires the per-ticket pass after each ticket commits *and* the end-of-run pass; `light` fires only the end-of-run pass (the default shape). Per-ticket catches per-ticket runtime regressions before they stack onto downstream tickets; end-of-run catches integration issues across the cumulative diff. The end-of-run whole-app pass is superseded by goal review when that gate fires at run end (issue #97) — they judge the same integrated build, and goal's goal+design-doc frame is stronger. `railhead fix` forces `mode: "full"` — a bug fix's whole point is observable runtime behaviour, so visual verification is never optional in fix mode. See [ADR 0011](docs/adr/0011-per-ticket-visual-review.md).

Each round is bounded against a wedged interaction target (issue #96): when the executor's degraded-target guard kills a round, the loop retries it **once** with a recovery note telling the reviewer to restart the app in a fresh page (and not to re-create the wedge with an unbounded in-page pixel-readback poll); a second degraded kill ends the run honestly as INCONCLUSIVE. `round_wall_sec` (default one hour) caps any single round in wall clock even when nothing ever times out.

### Vision capability probe (ADR 0036)

A declared vision capability is only a claim, so the railhead measures it: it generates a small PNG with a known random pattern, has the seat model `read` it and name the content, and records the result in `.railhead/capabilities.json`. `railhead init` probes the `implement`/`visual`/`goal` seats (so a blind seat is known before a plan spends hours); `plan`/`run`/`fix`/`resume` re-probe the seats behind any enabled `visual`/`goal` gate before doing model work, and **refuse to start** if the gate's model cannot actually see — the message names the two escapes: a vision-capable model, or set that gate's mode to `"off"`. The verified result is injected into the visual/goal/implementer prompts as a railhead fact, so no phase can silently decide it "doesn't want" to read screenshots. A surfaced project (`browser-ui`/`canvas`) also gets the implement seat measured once, letting a capable implementer self-check its layout with pixels.

## Live output

During a run, the railhead renders each opencode event as it streams — by default showing what the model is *doing*, not what it's saying:

```
implement ── step ────────────────────────────────
implement → bash ls -la [completed exit 0]
implement → write src/main.rs [completed]
implement ✔ tool-calls · in 477, out 123, cache 8304
implement → bash cargo build [completed exit 0]
```

Tool calls (`→`), step markers (`── step ──`, `✔ … · in 477, out 123`), and errors (`✖`) print by default; the model's reasoning and output prose is suppressed (read it later via `railhead log`). Three levels govern this:

- *(default)* live tool calls + step transitions + errors, plus a periodic heartbeat with elapsed time, step count, and peak context.
- `--verbose` streams the model's reasoning and text output inline **untruncated**, and echoes the exact prompt sent to each model call (the enriched plan/interview prompt, implementer prompts, review prompts — every phase), bracketed by `── prompt (model, est ~N tokens) ──`.
- `--quiet` suppresses the live stream entirely, leaving only the heartbeat (elapsed/step/peak) and the final per-ticket verdict line.

For post-hoc review, `railhead log` renders the full transcript with truncated I/O previews and error details.

## Stopping a run (operator)

Ctrl-C is a request, not a kill (ADR 0037):

- **First Ctrl-C** — graceful stop. The ticket in flight finishes its whole gate
  (implement → verify → smoke → review → commit, including the pipelined
  per-ticket visual review) and the run then stops with `status: "stopped"`.
  Nothing is lost: `railhead resume` (or `railhead run`) continues at the next
  ticket. The stop lands between end-of-run passes too, so an interrupt during
  the final review passes only defers the remaining ones.
- **Second Ctrl-C** — immediate stop: kills the active child, persists
  `stopped`, exits 130. In-flight phase work is re-run on resume (the worktree
  itself is preserved as a `(checkpoint)` commit).

The reason for the stop is recorded as `stop_reason` in `state.json` and
`report.md`, so a later look at the ledger can tell an operator stop from a
crash. `SIGTERM` (memory pressure, `kill`) stays immediate.

A stopped run never leaves a gate owed: the per-ticket visual review and any
group checkpoint the run committed past are recorded as pending and replayed
on resume before the next ticket commits (ADR 0038).

## Halting mid-run (agent-initiated)

Any phase (implementer, reviewer, visual/goal/structural reviewer) can drop a file to stop the whole run and ask for a human, borrowed from siesta's `stop.md`:

```bash
echo "the plan assumes a browser, but this project is a terminal app" > .railhead/STOP
```

The railhead checks for `.railhead/STOP` once per streamed event line (and at every ticket boundary), kills the active child's process group, marks the run `status: "stopped"` (ADR 0003's honest-stop — not a `failed` run), and records the file's contents as the halt reason in `report.md` and the ledger. It is a deliberate "a human must look before more work stacks," not a failure: review feedback, the retry/failure ladder, and corrective tickets are the machinery for a hard ticket or a failing gate — the halt file is only for a fundamentally wrong plan or broken environment.

`railhead resume` refuses while the file exists, printing the reason and the instruction to delete it. Delete the file once you have looked, and resume proceeds normally. The file lives under `.railhead/`, so it is already git-ignored and never committed.

## Ledger

Every run writes to `.railhead/<run-id>/`:

- `state.json` — full ticket state (resume source)
- `events/<NN>-<phase>.jsonl` — raw opencode event stream
- `report.md` — end-of-run summary with review history and context telemetry

## Contracts index

A `railhead.contracts.json` index keeps per-ticket context O(ticket), not O(project). After each commit, a diff-only extract pass updates the index. Later tickets get exact file/symbol pointers instead of "go explore the codebase." This lets a 100k-window model run an arbitrarily large project one ticket at a time.

## Setting up opencode

The one critical setting is the **per-model context limit** — opencode can't infer it for local models:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "provider": {
    "lmstudio": {
      "options": { "baseURL": "http://127.0.0.1:1234/v1", "apiKey": "not-needed" },
      "models": {
        "prism-ml/bonsai-27b": {
          "capabilities": { "limits": { "max_context_window_tokens": 32768, "max_output_tokens": 8192 } }
        }
      }
    }
  },
  "model": "lmstudio/prism-ml/bonsai-27b"
}
```

Set the request ceiling in `railhead.json` as `request_ceiling_tokens` so the planner slices tickets to fit. This is a **request** ceiling — the largest single request (prompt + output reserve) a phase may send — not the server's capacity, which is shared with invisible foreign KV. Leave it unset and the railhead defaults to **0.6× the model's window** (a 100k model → a 60k ceiling), which survives a warm KV pool. Set it explicitly only to a value *below* the window; never mirror the server's full capacity. After a run, check `report.md` — if a ticket's peak context approaches the ceiling with zero compactions, it may still be set too high.

## Design notes

- **Fresh subprocess per gate, context O(ticket).** The implementer is a durable session (or a fresh subprocess per ticket with `session_builder: false`); every judging phase is fresh and diff-scoped. The contracts index is the seam that makes this work.
- **Verify is green at every step** (ADR 0006) — the suite runs after every committed ticket, so it must be a baseline (typecheck, lint, existing tests), not future-feature assertions.
- Decisions recorded in `docs/adr/0001`–`0045`.
