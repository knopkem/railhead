# Railhead

Drive `opencode` over dependency-ordered tickets, unattended: each ticket is implemented, verified, reviewed, and committed before the next begins. A contracts index keeps every phase's context O(ticket), so a small local model or a cloud model can run an arbitrarily large project without holding it all at once.

## How it works

A plan is sliced into dependency-ordered tickets; only tickets whose blockers are committed may start. Each ticket runs a gate and lands as one commit; optional review gates can add corrective tickets — or replan the remainder — before the run moves on.

```
per ticket, in dependency order
  TEST        optional   fresh phase writes one failing test per acceptance criterion
  IMPLEMENT              durable opencode session resumed across checkpoints
  VERIFY                 your build/test commands; must be green
  SMOKE       optional   launch command stays up (panic / not-found signatures fail)
  REVIEW                 read-only, diff-scoped critique of the change
  COMMIT                 "<NN> — <title>", then the contracts index is updated
  VISUAL      optional   post-commit screenshot review; completes (correctives
                         included) before the next ticket starts

at group checkpoints and run end
  GOAL        optional   judges the integrated build against the goal and design docs
  STRUCTURAL  optional   judges accumulated source for architectural drift
  RUN END                end-of-run visual/goal/structural passes, then report.md
```

- **TEST** runs when the TDD phase is on (`--full` or `--tdd`) and the ticket is testable — the external oracle a small model needs. It is skipped for config-only tickets and in `fix` mode, where the bug reproducer is the test.
- **SMOKE** runs when the planner emitted a `$SMOKE` launch command and the framework is recognized; a process still running at the timeout passes.
- **Retries** feed findings back into the same builder session. `[BLOCKER]` findings always retry (then hard-fail); `[MAJOR]` retry per cadence. Any `[BLOCKER]` can become a **corrective ticket** that runs the full gate inline before the originating review passes; a failing goal review can request a **replan** of the remaining tickets.
- **Tickets** declare what they are *blocked by*; the frontier is the set whose blockers are all committed. Committed tickets never re-open.
- **The builder** is one durable opencode session resumed across checkpoints, so the author of the code receives review feedback directly. Set `session_builder: false` for a fresh implementer subprocess per attempt instead.
- **Gates are always fresh and diff-scoped** — reviewers never inherit the builder's context — and phases can push `LEARNED:` facts into `.railhead/learnings.md` for later prompts.
- **The ledger** (`.railhead/<run-id>/`) records state and the raw event stream per phase; a crashed or stopped run resumes where it left off.
- **Failures** escalate through a three-rung ladder (retry → restart worker → diagnose/fail), with step, stall, and degraded-target guards for unattended runs.

## Install

```bash
npm install -g railhead     # or: npx railhead <command>
```

Requires Node 20+, `opencode` on PATH, and a configured model (local or hosted). From a clone: `npm install && npm link`.

## Quick start

```bash
railhead build "a CLI that parses RSS feeds"   # interview → PLAN.md → tickets → run
railhead fix "paddles don't move"             # bug report → reproduction questions → fix ticket
```

`railhead init` (run automatically on first use) asks for a model per seat and probes each one for context limit, vision, and reasoning. `opencode models` lists what is available.

`build` generates the plan, a bounded clarifying interview (preset-gated) revises it, and then — unless `-a`/`--auto` — the final plan is written to `PLAN.md` for you to read and request changes; accepting it decomposes the plan into tickets. Resolved vocabulary lands in `CONTEXT.md`, hard decisions in `docs/adr/`, and the design narrative and architecture in `docs/design.md` / `docs/architecture.md`. `fix` asks only about reproduction — the planner reads the code itself.

## Commands

```
railhead init                          git init + default railhead.json
railhead build "<prompt>" [flags]      turn a description into tickets, then run them
railhead fix  "<bug report>" [flags]   turn a bug report into a fix ticket, then run it
railhead run <tickets-dir>             run a queued ticket set (auto-resumes interrupted runs)
railhead resume [<run-id>]             continue a stopped/interrupted run
railhead status [<run-id>]             live summary of a run
railhead next [<run-id>]               next actionable ticket(s) and what blocks them
railhead log [<run-id>] [<phase>]      readable transcript of a phase from the ledger
railhead reset [--hard]                abandon the latest interrupted run (--hard drops its commits)
railhead diagnose screenshots [--model M]  check that a model can take a screenshot and read it back
```

`build`/`fix` flags: `[--model M] [-a|--auto] [-c] [--full|--medium|--light|--none] [--verbose] [--yolo]`, plus per-gate overrides (`--review`, `--vision`, `--goal`, `--structural`, `--tdd`, `--sharpen`). `run` accepts `[--plan M] [--exec M] [--review M] [--visual M] [--extract M] [--goal-model M] [-m N] [--pause-on-failure] [--quiet|--verbose] [--fresh]` and the same gate overrides. `-a` alone means `--light`.

## Configuration

```jsonc
{
  "verify": ["npm run typecheck", "npm test"],
  "smoke": [],                    // launch commands for the smoke phase (usually seeded by the planner)
  "test_phase": false,            // TDD: write a failing test per acceptance criterion before implementing
  "max_retries": 3,
  "max_review_retries": 3,
  "max_attempts": null,           // absolute retry cap (null = max_retries * 3)
  "max_phase_steps": 50,          // kill a phase stuck in a tool loop
  "verify_timeout_sec": null,     // kill a hung verify command (null = 600s)
  "stall_timeout_sec": null,      // kill a phase with no output (null = 3600s)
  "max_step_model_sec": null,     // kill a single step stuck in model time (null = 3600s)
  "request_ceiling_tokens": null, // largest request a phase may send (null = 0.6× the model window)
  "sharpen_max_rounds": 6,        // interview round cap (0 disables the interview)
  "infra_backoff_sec": [60, 300, 900, 1800],
  "model": {
    "plan":      "deepseek/deepseek-v4-flash",
    "implement": "deepseek/deepseek-v4-flash",
    "review":    null,            // null = falls back to implement
    "visual":    null,            // vision-capable; null = falls back to review
    "goal":      null,            // null = falls back to visual → review → implement
    "extract":   null             // cheap model, single-shot structured output
  },
  "code_review":       { "mode": "light" },
  "visual_review":     { "mode": "off", "round_wall_sec": null },
  "goal_review":       { "mode": "off" },  // add "checkpoint_action": "advisory" for advisory goal checkpoints
  "structural_review": { "mode": "off" },
  "session_builder": true,                 // one durable session; false = fresh subprocess per ticket
  "checkpoint_granularity": "product"      // "ticket" | "group" | "product"
}
```

Models are independent — a strong model can plan while a cheap one executes — and `null` falls back down the chain.

### Model seats

| Seat | Tier floor | Notes |
|------|-----------|-------|
| `plan` | 27B+ | Shapes the ticket graph; don't cheap out |
| `implement` | 27B+ | Most multi-step reasoning |
| `review` | 27B+, separate model recommended | Judgment work; should not be weaker than `implement` |
| `goal` | 27B+ | Judges the integrated build; shapes remaining work |
| `visual` | 27B+ with vision | Screenshot review |
| `extract` | 9B OK | The one seat where a cheap model is endorsed |

Railhead warns (never blocks) when `review`/`goal` is weaker than `implement`, or when any judgment seat parses below 27B.

## Reviews

Every gate has a cadence mode: `full` | `medium` | `light` | `off`. Presets choose defaults; per-gate flags override.

| Preset | Code review | Visual | Goal | Structural | TDD test phase | Interview |
|--------|-------------|--------|------|------------|----------------|-----------|
| `--full` | per-ticket, BLOCKER+MAJOR retry | per-ticket + run-end | checkpoints + run-end | checkpoints + run-end | on | on |
| `--medium` | per-ticket, BLOCKER+MAJOR retry | run-end | checkpoints | checkpoints | off | on |
| `--light` (default) | per-ticket; BLOCKER full retry, MAJOR one attempt | run-end | advisory checkpoints + run-end | run-end | off | off |
| `--none` | off | off | off | off | off | off |

Notes:

- **Severities:** `[BLOCKER]` always retries (up to the cap, then hard-fail). `[MAJOR]` retries through the budget in `medium`/`full`; in `light` it gets one corrective attempt, then soft-passes. Minor findings never retry.
- **TDD test phase:** when on, a fresh phase writes a failing test per acceptance criterion before each testable ticket; the implementer must make it pass. `--tdd`/`--no-tdd` override the preset, and `fix` forces it off — the reproducer is the test.
- **Mid-run vs run-end:** goal and structural fire at group checkpoints as well as at run end; visual fires per-ticket (under `full`) and at run end. When goal review fires at run end it takes visual's whole-app seat — the goal + design-doc frame is stronger.
- **Corrective tickets:** `[BLOCKER]` findings generate corrective tickets that run the full gate inline before the originating review may pass.
- **Visual review** runs the app, captures screenshots with a vision model, and judges them against the acceptance criteria. `fix` raises it to `full` whenever the gate is enabled with a vision model, since a bug fix is about observable behaviour.
- **Vision is measured, not declared.** A probe has the seat model read a generated PNG; `build`/`run`/`fix`/`resume` refuse to start a vision gate on a blind model.
- **Halt:** any phase can write `.railhead/STOP` (contents = reason) to stop the run for a human. `resume` refuses until the file is deleted.
- **Ctrl-C is a request, not a kill.** The first press finishes the ticket in flight's gate and stops at the commit boundary; the second stops immediately. Either way `railhead resume` continues with no gate left owed.

## Live output

```
implement ── step ────────────────────────────────
implement → bash ls -la [completed exit 0]
implement ✔ tool-calls · in 477, out 123, cache 8304
```

Tool calls, step markers, and errors stream by default, plus a heartbeat with elapsed time, step count, and peak context. `--verbose` adds the model's reasoning and the exact prompts; `--quiet` keeps only the heartbeat. `railhead log` replays any phase afterwards.

## Ledger

Every run writes to `.railhead/<run-id>/`:

- `state.json` — full ticket state, the resume source
- `events/<NN>-<phase>.jsonl` — raw opencode event stream per phase
- `report.md` — end-of-run summary with review history and context telemetry

## Contracts index

After each commit, a diff-only extract pass updates `railhead.contracts.json` with the files and symbols that changed. Later tickets receive exact pointers instead of "go explore the codebase" — this is what keeps per-ticket context O(ticket).

## Setting up opencode

The one critical setting is the **per-model context limit** — opencode cannot infer it for local models:

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

Set `request_ceiling_tokens` in `railhead.json` to bound the largest single request (prompt + output reserve) a phase may send. Leave it unset and Railhead uses **0.6× the model's window** — a value that survives a warm KV pool. Only set it below the window; never mirror the server's full capacity. After a run, `report.md` shows whether any ticket's peak context approached the ceiling.

## Design principles

- **Context is O(ticket), not O(project)** — fresh, diff-scoped judging phases plus the contracts index are the seam that makes long unattended runs possible.
- **No gate overlaps the builder** — review phases run in sequence with implementation, so a reviewer never sees a half-edited worktree (ADR 0046).
- **Green at every step** — every commit passed verify first, so the suite must be a baseline (typecheck, lint, existing tests), never future-feature assertions.
- **Verify, then trust** — every commit has passed its gate; the ledger is the audit trail.

Decisions and trade-offs are recorded in [`docs/adr/`](docs/adr/).
