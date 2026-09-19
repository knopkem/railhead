# Research: obra/superpowers vs local-llm-harness

Researched 2026-08-31 against primary sources: the `obra/superpowers` GitHub
repository (README, docs, skills, prompt templates, plugin source, releases)
and this repo's own docs, ADRs, and source code.

**Scope.** This note compares two systems that both decompose a build into
small, dependency-ordered tasks executed by coding agents with review gates.
The comparison is deliberately grounded in primary-source evidence, with
citations to specific files. Inferences are flagged as such.

---

## 1. What `obra/superpowers` actually is

### 1.1 Identity and goals

`obra/superpowers` is a **software development methodology for coding agents**
expressed as a library of composable skills. It is built by Jesse Vincent and
Prime Radiant, shipped as plugins for many agent runtimes, and its current
version is **6.3.0**.

> "Superpowers is a complete software development methodology for your coding
> agents, built on top of a set of composable skills and some initial
> instructions that make sure your agent uses them."
> — [`README.md`](https://github.com/obra/superpowers/blob/main/README.md)

Its goal is to make an existing coding agent (Claude Code, Codex, Cursor,
Kimi Code, OpenCode, etc.) follow a disciplined, human-paired workflow:
design approval before code, bite-sized plans, TDD, fresh-subagent
implementation, and code review between tasks. It does **not** replace the
agent runtime; it sits on top of it.

### 1.2 Architecture and core mechanisms

**Skills as the unit of behavior.** Each skill is a Markdown file under
`skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`). The
plugin registers the `skills/` directory with the host runtime and injects a
bootstrap prompt (`using-superpowers`) at session start. The bootstrap
contains a hard rule: *if a skill applies, use it before doing anything else*.

> "IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT."
> — [`skills/using-superpowers/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md)

The OpenCode plugin source shows how this works mechanically:

1. A `config` hook adds the repo's `skills/` path to the runtime's skill
   discovery list.
2. An `experimental.chat.messages.transform` hook prepends the
   `using-superpowers` skill content to the first user message of every
   session.
> — [`/.opencode/plugins/superpowers.js`](https://github.com/obra/superpowers/blob/main/.opencode/plugins/superpowers.js)

The Kimi plugin manifest does the equivalent for Kimi Code: it points at the
same `skills/` directory and loads `using-superpowers` via `sessionStart.skill`,
plus a tool-mapping section that maps skill actions to Kimi tools.
> — [`/.kimi-plugin/plugin.json`](https://github.com/obra/superpowers/blob/main/.kimi-plugin/plugin.json)

**Core workflow.** The README lists seven ordered skills that constitute the
basic workflow:

1. `brainstorming` — Socratic design refinement with a **hard human-approval
   gate** before implementation.
2. `using-git-worktrees` — isolated workspace on a new branch.
3. `writing-plans` — detailed implementation plan with bite-sized tasks.
4. `subagent-driven-development` **or** `executing-plans` — task execution.
5. `test-driven-development` — strict red/green/refactor.
6. `requesting-code-review` — between tasks; critical issues block progress.
7. `finishing-a-development-branch` — merge/PR/keep/discard decision.
> — [`README.md` § "The Basic Workflow"](https://github.com/obra/superpowers/blob/main/README.md)

### 1.3 Work decomposition

Superpowers splits work at **two levels**: a written *spec/design* and a
written *implementation plan*.

**Brainstorming** classifies every request as *spike*, *bounded*, or
*architectural*. Architectural work requires a written spec saved to
`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and explicit human
approval before proceeding.
> — [`skills/brainstorming/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md)

**Writing-plans** produces plans saved to
`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`. The required header
includes Goal, Architecture, Tech Stack, and a `Spec:` pointer. Each task has:

- exact files to create/modify/test,
- a per-task **Interfaces** block (`Consumes` / `Produces`),
- a **Global Constraints** block copied verbatim from the spec,
- step-level code blocks,
- verification commands.

> "Every step must contain the actual content an engineer needs."
> — [`skills/writing-plans/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md)

Tasks are intentionally **bite-sized (2–5 minutes each)** and are sized to
earn their own test cycle and reviewer gate.

### 1.4 Quality enforcement

**TDD is mandatory.** The `test-driven-development` skill states an "Iron
Law": *no production code without a failing test first*. Code written before
its test must be deleted. It also requires watching the test fail for the
expected reason, then watching it pass.
> — [`skills/test-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md)

**Two-stage review.** `subagent-driven-development` dispatches a fresh
implementer subagent per task, then a task reviewer who returns both **spec
compliance** and **code quality** verdicts. A final whole-branch review runs
on the most capable available model after all tasks.
> — [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

**Bounded fix loop.** The SDD skill allows up to five fix rounds per task:
rounds 1–3 resume the original implementer; rounds 4–5 escalate to a more
capable model. At the cap, the controller adjudicates and records rulings in
a ledger. Findings are categorized Critical / Important / Minor; Critical
block progress.
> — [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

**No worker-spawned reviewers.** The implementer prompt explicitly forbids
the subagent from dispatching its own reviewer: "Review is the controller's
job."
> — [`skills/subagent-driven-development/implementer-prompt.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/implementer-prompt.md)

### 1.5 Context management

Superpowers keeps the **controller session** alive while delegating each task
to a **fresh subagent** with isolated context. The controller never pastes
accumulated history into later dispatches; instead it hands artifacts as
files:

- `scripts/task-brief PLAN_FILE N` extracts one task to a uniquely named file.
- `scripts/review-package PLAN_FILE BASE HEAD` writes the diff to a uniquely
  named file for the reviewer.

> "Everything you paste into a dispatch prompt — and everything a subagent
> prints back — stays resident in your context for the rest of the session
> and is re-read on every later turn. Hand artifacts over as files."
> — [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

The skill also warns that "conversation memory does not survive compaction"
and instructs the controller to track progress in a **ledger file**, not only
in todos.

### 1.6 Durability and resumability

The SDD skill creates a per-plan workspace under
`<repo-root>/.superpowers/sdd/<plan-basename>/`. That directory holds the
ledger, briefs, reports, and review packages. The ledger's first line names
the plan file so a resumed controller can distinguish its own plan from a
stray one. Commits are the durable record; the workspace is deleted after the
final review is clean.
> — [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

Release v6.2.0 explicitly fixed cross-plan contamination by making the
workspace plan-scoped.
> — [`releases/tag/v6.2.0`](https://github.com/obra/superpowers/releases/tag/v6.2.0)

### 1.7 Maturity and adoption signals

| Signal | Value | Source |
|---|---|---|
| Stars | 279,799 | [`api.github.com/repos/obra/superpowers`](https://api.github.com/repos/obra/superpowers) |
| Forks | 25,081 | same |
| Open issues | 344 | same |
| License | MIT | same |
| Latest release | v6.3.0 (2026-08-12) | [`releases/tag/v6.3.0`](https://github.com/obra/superpowers/releases/tag/v6.3.0) |
| Prior major | v6.0.0 (2026-06-16) | [`releases/tag/v6.0.0`](https://github.com/obra/superpowers/releases/tag/v6.0.0) |

The release cadence is active: v6.0.0 → v6.1.0 → v6.1.1 → v6.2.0 → v6.3.0
within roughly two months. The project also runs a behavior-evaluation
campaign using a separate `superpowers-evals` repo.
> — [`README.md` § Contributing](https://github.com/obra/superpowers/blob/main/README.md)

### 1.8 Requirements and runtime assumptions

Superpowers is **not a standalone executable**. It is a plugin/skills
framework that requires an underlying agent runtime. The README lists
installation instructions for:

- Claude Code (official marketplace + Superpowers marketplace)
- Codex App / Codex CLI
- Cursor
- Devin CLI
- Factory Droid
- Gemini CLI
- GitHub Copilot CLI
- Grok Build CLI
- Kimi Code
- OpenCode
- Pi
- Hermes Agent
- Antigravity
> — [`README.md` § Getting Started](https://github.com/obra/superpowers/blob/main/README.md)

In practice, most of those runtimes assume access to **frontier or strong
cloud models** (Claude, GPT-4o, Gemini, Kimi K2, Grok, etc.). The SDD skill's
own model-selection guidance assumes a tiered menu of models and explicitly
says "use the most capable available model" for architecture and final
review. It also warns that an omitted model "silently inherits the session's
most expensive one."
> — [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

There is **no small-local-model optimization** in Superpowers. The design
does not target 27B Q4 models or llama.cpp/Ollama endpoints; it targets the
subagent and skill-tooling features of full agent harnesses.

---

## 2. Point-by-point comparison with local-llm-harness

| Dimension | `obra/superpowers` | `local-llm-harness` |
|---|---|---|
| **What it is** | Skills/methodology plugin for existing coding agents. | Standalone TypeScript CLI that shells out to `opencode`. |
| **Primary goal** | Give a coding agent a disciplined, human-paired SDLC. | Run unattended builds on small-context local models. |
| **Target runtime** | Claude Code, Codex, Cursor, Kimi Code, OpenCode, Pi, etc. | `opencode` (any model it can drive, local or hosted). |
| **Target model class** | Frontier / strong cloud models (Claude, GPT-4o, Gemini, Kimi, Grok). | ~27B Q4 dense local model, ~64k working context (`docs/adr/0014-small-context-perf-target.md`). |
| **Human-in-the-loop** | Mandatory design approval; stops for destructive/irreversible actions. | Can be fully unattended (`-a`/`--auto`); optional `pause-on-failure`. |
| **Plan source** | Agent generates design + plan, human approves each. | Human prompt → planner generates dependency-ordered tickets; optional bounded interview. |
| **Decomposition unit** | 2–5 minute tasks in a plan document. | One-context-window Tickets with acceptance criteria, `blocked_by`, `files`, `references`, `introduces`. |
| **Execution unit** | Fresh subagent per task within one controller session. | Fresh `opencode` subprocess per phase (implement → verify → smoke → review → commit). |
| **Workspace model** | Isolated git worktree per plan/branch. | Single branch `run/<slug>` with linear commits. |
| **Context seam** | File-based handoffs (task brief, review package) + ledger. | `harness.contracts.json` per-ticket index + `.harness/learnings.md`. |
| **TDD** | Strict red/green/refactor; delete code written before tests. | Optional TDD test phase writes failing tests before implement (issue #5 / `src/context/prompt.ts`). |
| **Review** | Two verdicts per task (spec + quality), final whole-branch review. | Per-ticket reviewer with blocking `[BLOCKER]`/`[MAJOR]` findings; optional final/advisory/none modes; visual + goal review. |
| **Fix loop** | Up to 5 rounds; rounds 4–5 escalate model. | Bounded by `max_retries`/`max_review_retries`/`max_attempts`; retry budget resets on real progress. |
| **Verification** | Project-specific commands embedded in each plan task. | `harness.json` `verify` commands run after every committed ticket (`docs/adr/0006-verify-green-every-step.md`). |
| **Durability** | Per-plan ledger in `.superpowers/sdd/<plan>/progress.md`. | Per-run `state.json` + `events/<phase>.jsonl` in `.harness/<run-id>/` (`docs/adr/0004-file-ledger-not-db.md`). |
| **Resume** | Controller re-reads ledger after compaction. | `harness resume`/`harness run` auto-resumes from `state.json` with checkpoint/reset logic (`src/cli/cli.ts`, `src/execute/run.ts`). |
| **Parallelism** | `dispatching-parallel-agents` for independent failures/tasks. | Serial dependency-order execution; no parallel ticket dispatch. |
| **Portability** | One skill set, many harnesses. | Tied to `opencode` CLI and Node/npm ecosystem. |

### 2.1 Goals and problem solved

Superpowers solves the "agent without a process" problem: a powerful coding
agent that jumps straight to code, skips tests, and loses track across long
sessions. It imposes a methodology.

Local-llm-harness solves the "small model can't hold the whole project"
problem: it slices a human intent into context-window-sized tickets and
executes them unattended, using fresh subprocesses to keep each phase's
context small.

These are **orthogonal problems**. A user could in principle install
Superpowers inside a harness that itself calls local models, but Superpowers
does not optimize for that regime and its prompt style is not tuned for
64k-context 27B models.

### 2.2 Decomposition approach

Superpowers' `writing-plans` skill produces plans with **very small**
tasks—individual steps like "write the failing test," "run it," "write
minimal implementation." Each task is a vertical slice and includes exact
file paths and code. This is a strength for **clarity and reviewability**;
its cost is a large number of subagent dispatches.

Local-llm-harness' planner produces **Tickets** that are larger vertical
slices ("a ticket must fit in a single context window" per
`src/plan/plan.ts:108`). A ticket may still touch 1–3 files and may include its
own test phase, but it is coarser than a Superpowers task. This is a
strength for **unattended throughput** on small models; its cost is less
granular review.

### 2.3 Quality gates

Superpowers enforces **TDD as a non-negotiable skill** with explicit
red/green evidence required in the implementer report. The reviewer prompt
demands TDD evidence and treats test-output warnings as findings.
> — [`skills/subagent-driven-development/task-reviewer-prompt.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/task-reviewer-prompt.md)

Local-llm-harness has a TDD **phase** (`buildTestPhasePrompt` in
`src/context/prompt.ts:306`) but it is optional and can be skipped with `-nt`. Its
verify gate is the stronger invariant: `harness.json` verify commands run
after every committed ticket and must stay green at every step
(`docs/adr/0006-verify-green-every-step.md`). The reviewer is a separate
opencode run that may be configured as `full`, `advisory`, `none`, or
`final` (`README.md` § Review modes).

Superpowers' review is more **prescriptive** (Critical/Important/Minor,
spec compliance vs quality, five-round escalation). Local-llm-harness' review
is more **configurable** and includes vision/golf-review checkpoints that
Superpowers does not have.

### 2.4 Context management

Both systems use **fresh-context delegation**, but the mechanism differs:

- Superpowers keeps one long-lived **controller** session and dispatches
  fresh **subagents** per task. The controller's context is protected by
  handing artifacts as files and by a ledger.
- Local-llm-harness kills and restarts the **entire agent process** for each
  phase. There is no controller session; the harness itself is the
  controller. Context is kept small by the contracts index
  (`harness.contracts.json`) and by an explicit char budget for learnings
  (`LEARNINGS_CHAR_LIMIT = 2200`, `src/context/learnings.ts`).

Superpowers' model assumes a runtime with cheap, fast subagent dispatch and
large context windows. Local-llm-harness' model assumes a runtime where every
process startup is expensive and every token in context slows generation.

### 2.5 Durability / resumability

Superpowers relies on a **plan-scoped ledger** in
`.superpowers/sdd/<plan>/progress.md` plus git history. The ledger is the
recovery map after compaction.

Local-llm-harness relies on a **run-scoped ledger** in
`.harness/<run-id>/state.json` plus `events/<phase>.jsonl`. The harness has
explicit crash-resistant resume logic: checkpoint in-flight work, hard
reset, rebase frontier, invariant checks (`src/cli/cli.ts:934-999`,
`docs/adr/0016-crash-resistant-resume.md`).

### 2.6 Human-in-the-loop assumptions

This is the sharpest difference. Superpowers is designed as a **human-paired**
system: brainstorming requires explicit approval before any implementation,
and the controller stops for destructive actions, merges, pushes, and broken
plans.

Local-llm-harness is designed to be **left running**:
`harness plan -a "..."` auto-answers the planning interview and starts the
run. The user may set `pause_on_failure`, but the default path is unattended.

---

## 3. What local-llm-harness could learn / borrow from Superpowers

Ranked by estimated value and feasibility for this harness.

### 3.1 Borrow the plan-quality discipline (high value, medium effort)

Superpowers' `writing-plans` skill has several concrete artifacts that would
improve the harness planner:

- **A required plan header** with Goal, Architecture, Tech Stack, and a
  `Spec:` pointer. The harness already extracts `$DESIGN`/`$ARCHITECTURE`
  blocks (`src/plan/plan.ts:190-213`) but does not require a `Spec:` back-pointer
  or a `Global Constraints` block.
- **Per-task Interfaces block** naming exactly what each ticket consumes and
  produces. The harness ticket format has `references`/`introduces`, but the
  planner prompt does not explicitly require a paired `Consumes`/`Produces`
  block. That would make later implementers' contracts more reliable.
- **"No placeholders" rule.** The harness planner prompt already forbids
  exploration, but it does not explicitly forbid "TBD", "implement later",
  or "add appropriate error handling" the way Superpowers does.

Source: [`skills/writing-plans/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md)

### 3.2 Borrow the TDD red/green evidence requirement (high value, low effort)

The harness already has a test phase, but it is optional and the reviewer
does not require red/green evidence. Superpowers' implementer prompt
requires the report to include:

- RED: command run, relevant failing output, why the failure was expected.
- GREEN: command run, relevant passing output.

Adding a similar evidence block to `buildImplementerPrompt`
(`src/context/prompt.ts:33`) and to the reviewer prompt
(`buildReviewerPrompt`, `src/context/prompt.ts:388`) would raise test trust without
adding new phases.

Source: [`skills/subagent-driven-development/implementer-prompt.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/implementer-prompt.md)

### 3.3 Borrow the file-based review package (medium value, medium effort)

Superpowers writes the task brief and the diff to files and gives the
reviewer file paths, so the reviewer's full diff does not pollute the
controller's context. The harness currently passes the diff as a string in
the reviewer prompt (`buildReviewerPrompt` in `src/context/prompt.ts:388`). For
large diffs on small-context models, writing the diff to a temporary file
and instructing the reviewer to read it would reduce prompt bloat.

Source: [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

### 3.4 Borrow the per-plan ledger identity line (medium value, low effort)

The harness `.harness/<run-id>/state.json` is already run-scoped, but the
plan directory (`.scratch/<slug>/issues`) has no identity marker. Superpowers
puts `# SDD ledger — plan: <plan file path>` as the first line of its ledger
to prevent cross-plan contamination. The harness could add a similar
`plan.md` identity file inside each `.scratch/<slug>/` directory.

Source: [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

### 3.5 Borrow explicit per-role model selection guidance (medium value, low effort)

Superpowers' SDD skill gives clear rules: cheap model for mechanical
1–2-file tasks, standard model for integration, strongest model for
architecture and final review, and always name the model explicitly. The
harness has model slots (`plan`, `implement`, `review`, `visual`, `goal`,
`extract`) and ADR 0015's tier policy, but the implementer prompt does not
currently guide the *worker* to choose models by task complexity—because the
harness chooses the model, not the worker. However, the harness could expose
a cheaper `model.extract` seat more aggressively and document when to use it.

Source: [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

### 3.6 Borrow the pre-dispatch conflict scan (medium value, medium effort)

Before dispatching Task 1, Superpowers' controller scans the plan for
conflicts and writes a table to the ledger. The harness planner already has
`fileCountWarnings` (`src/plan/plan.ts:257`) but no explicit conflict scan. Adding
a lightweight check for contradictory `blocked_by` cycles, duplicate
`introduces` symbols, or tickets that touch the same file without ordering
would catch plan defects before spend.

Source: [`skills/subagent-driven-development/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)

### 3.7 Borrow git-worktree isolation (low value for this harness, high effort)

Superpowers uses `using-git-worktrees` to isolate each plan on its own
branch in a separate worktree. Local-llm-harness deliberately uses a single
branch with linear commits (`docs/adr/0002-single-branch-linear-commits.md`)
to avoid merge conflicts in unattended mode. Worktrees would add complexity
without a clear payoff for the target use case, so this is ranked lowest.

Source: [`skills/using-git-worktrees/SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/using-git-worktrees/SKILL.md)

---

## 4. Verdict: does Superpowers make this project unnecessary?

> **Revised 2026-09-03** after the pixeledit-night-1 post-mortem and ADR 0022
> (session builder + interleaved gates). The "complementary regimes"
> conclusion below still holds, but the mechanism and the positioning sharpen
> considerably — and the highest-value borrowings changed. See §6.

**No.** Superpowers and local-llm-harness are **complementary**, not
substitutes. The honest assessment is that they win in different regimes.

### 4.1 Where Superpowers genuinely wins

- **Users with frontier-model access** who want a guided, human-paired
  methodology. Superpowers is built for Claude, Codex, Kimi, Gemini, etc.
- **Code-review rigor.** Its two-stage spec+quality review, five-round fix
  loop with model escalation, and strict TDD evidence requirements are more
  prescriptive than the harness' current defaults.
- **Plan clarity.** The `writing-plans` skill's required header, Global
  Constraints, and per-task Interfaces blocks are a higher-quality planning
  discipline than the harness' current JSON ticket format.
- **Multi-harness portability.** One skill library runs on a dozen agent
  runtimes. The harness is tied to `opencode`.
- **Human-paired control.** If you want the agent to stop for approval
  before implementation and before destructive actions, Superpowers is
  designed for that.

### 4.2 Where local-llm-harness genuinely wins

- **Small local models.** This is the entire reason the harness exists. It
  explicitly targets ~27B Q4 dense models on a 16GB-VRAM PC with ~64k
  working context (`docs/adr/0014-small-context-perf-target.md`).
- **Unattended execution.** `harness plan -a "..."` can run for hours
  without human interaction. Superpowers is designed to stop for human
  approval.
- **Cost and privacy.** No subscription to a frontier API is required; the
  model can run locally via llama.cpp/Ollama through `opencode`.
- **Deterministic ticket queue.** Dependency-ordered Tickets with a tracked
  contracts index give the harness a clear, reproducible execution graph.
- **Tool-agnostic CLI shape.** While currently tied to `opencode`, the
  architecture (drive CLI, not SDK, `docs/adr/0001-drive-cli-not-sdk.md`)
  is built around shelling out, making it easier to retarget than a
  runtime-specific plugin.

### 4.3 The real overlap

Both systems believe in:

1. Small, dependency-ordered tasks.
2. Fresh-context delegation (subagents or subprocesses).
3. Automated verification before declaring success.
4. Code review as a gate, not an afterthought.
5. File-based or indexed context seams rather than accumulating history.

Those similarities are real, but they sit on top of **different runtime
assumptions**. Superpowers assumes a capable, long-lived controller with
subagent support; the harness assumes a constrained local model where every
process restart is a feature.

### 4.4 Recommendation

- If you have access to Claude Code / Codex / Kimi Code and want a
  high-quality, human-paired workflow, **use Superpowers**.
- If you want to run software builds unattended on a small local model,
  **use local-llm-harness**.
- If you are building local-llm-harness, **selectively borrow** from
  Superpowers: plan-quality discipline (§3.1), red/green TDD evidence
  (§3.2), and file-based review packages (§3.3) are the highest-value,
  lowest-regret imports.

---

## 5. Confidence and caveats

| Claim | Confidence | Caveat |
|---|---|---|
| Superpowers is a skills/methodology plugin, not a runtime. | High | Directly stated in README and plugin source. |
| Superpowers requires a frontier/strong agent runtime. | High (inference) | README lists only full agent runtimes; no small-local-model install path exists. |
| Superpowers uses fresh subagent per task within a controller session. | High | Explicit in SDD skill and implementer prompt. |
| Superpowers mandates human approval before implementation. | High | Hard-gate language in `brainstorming` skill. |
| Local-llm-harness targets ~27B Q4 / ~64k context. | High | `docs/adr/0014-small-context-perf-target.md`. |
| Local-llm-harness is designed for unattended execution. | High | `README.md` and `src/cli/cli.ts` `-a`/`--auto` path. |
| Superpowers has 279k stars / active 6.x releases. | High | GitHub API and releases page, current as of fetch date. |
| The two systems are complementary, not substitutes. | High | Follows from different target runtimes and human-loop assumptions. |

---

## 6. Post-ADR-0022 re-assessment (2026-09-03)

Written after the pixeledit-night-1 post-mortem (#75–#82), the bare-session
counterexample (a compacting `opencode` session outperforming the harness on
the same prompt), and ADR 0022 (restated purpose: session builder with
interleaved gates). Primary sources re-read in full: the
`subagent-driven-development` SKILL.md, its `implementer-prompt.md` template,
and `writing-plans`.

### 6.1 Positioning (now explicit)

The harness **exclusively targets unattended builds on local, low-context
models**. For anything on cloud/frontier models, use Superpowers — we cannot
and do not want to compete there. §2.1's "orthogonal problems" framing was
correct but understated the divide: it is a *product* decision, not just a
regime observation.

### 6.2 The structural difference: who is the controller

Superpowers' controller is a **model session** steered by prompt text — the
SDD skill (~8k words) resident in context, gate compliance
("never skip the task review") enforced by instruction. Its own Common
Rationalizations table enumerates the ways *frontier* controllers cheat the
process. The harness's controller is **code**: verify runs in bash whether
the model feels like it, commits are deterministic, retry counters are
integers. On a 27B, prompt-compliance failure is the baseline (#75: the
implementer ignored "end with DONE" for four hours), so:

- enforcement must be mechanical (harness advantage),
- coordination must cost zero model tokens — on one 100k server, Superpowers'
  controller pays for orchestration *out of the same window the build needs*,
  and its tiered-model guidance degenerates when all seats are one model
  (harness advantage),
- unattended entry/exit is required, not optional (harness advantage;
  Superpowers is human-paired at its boundaries by design).

Conversely, attended work on frontier models is Superpowers' home ground and
the harness should not follow it there. Superpowers is best treated as a
**content library to port from** (its skill texts are battle-tested prompt
content) — including potentially loading its opencode plugin *inside* the
harness-driven builder session for in-session TDD discipline, with the
caveat that skill text competes for the small context window.

### 6.3 Why Superpowers' smaller tasks don't lose context, and ours did

They did not make boundaries stronger — they made them **non-load-bearing**:

1. **Plans contain the code** (`writing-plans`' no-placeholders rule), so
   executors are transcribers, not designers. Their model guidance states it:
   "the implementation is transcription plus testing: use the cheapest tier."
   A boundary crossing carries no understanding because the understanding was
   externalized into the plan document at plan time.
2. **Interfaces are forward-declared exactly at plan time** (per-task
   Consumes/Produces with exact signatures) — consistent by construction,
   versus the harness's backward-extracted contracts (`regexExtractContracts`
   from diffs after the fact) which drift (#61).
3. **The concept-holder never edits code**, and the fix loop *resumes* the
   implementer (rounds 1–3: "its context is intact"), escalating only at
   rounds 4–5. The harness's `$HANDOFF`/attempt-history machinery (#9, #16)
   was compensating for killing the implementer on every retry — ADR 0022's
   findings re-injection is the same convergence, arrived independently.

Note Superpowers is not loss-free either — their own docs call compaction
losses "the single most expensive failure observed" (controllers re-dispatched
completed task sequences). Their recovery is file-based (ledger, plan-with-
code, git). The transferable principle: **externalize understanding into
artifacts; make every agent replaceable.** The harness did this for state
(`state.json`, contracts) but never for design intent — tickets said *what*,
never *how*, so the "how" died at every boundary.

### 6.4 Updated borrowings (filed)

| Borrow | Status |
|---|---|
| Tickets carry implementation code — implementers become transcribers | **#85** (pilot; planner-budget constraint is a first-class design driver) |
| Plan invariants with consequence — conflict warnings escalate through a bounded repair/adjudication loop instead of printing | **#86** (the pixeledit plan would have been repaired or rejected, never run) |
| Red/green TDD evidence (§3.2) | already shipped (`testable` evidence block, `prompt.ts`) |
| Per-task Interfaces block (§3.1) | folded into #85's forward-declared interfaces table |
| Pre-dispatch conflict scan (§3.6) | superseded by #86's escalation semantics |
| Resume-the-implementer in fix loops | superseded by ADR 0022 / #84 findings re-injection |

### 6.5 Anti-lesson

Do **not** adopt Superpowers' 2–5-minute task granularity. Their task size is
sized for cloud dispatch economics (cheap, fast subagents); on a single local
server every dispatch re-prefills the world. Take the content discipline
(complete code, exact interfaces, rulings), not the granularity.



### Superpowers (external)

- Main repo: https://github.com/obra/superpowers
- README: https://github.com/obra/superpowers/blob/main/README.md
- OpenCode install docs: https://github.com/obra/superpowers/blob/main/docs/README.opencode.md
- Kimi plugin manifest: https://github.com/obra/superpowers/blob/main/.kimi-plugin/plugin.json
- OpenCode plugin source: https://github.com/obra/superpowers/blob/main/.opencode/plugins/superpowers.js
- `using-superpowers` skill: https://github.com/obra/superpowers/blob/main/skills/using-superpowers/SKILL.md
- `brainstorming` skill: https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md
- `writing-plans` skill: https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md
- `subagent-driven-development` skill: https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md
- Implementer prompt template: https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/implementer-prompt.md
- Task reviewer prompt template: https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/task-reviewer-prompt.md
- `test-driven-development` skill: https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md
- `requesting-code-review` skill: https://github.com/obra/superpowers/blob/main/skills/requesting-code-review/SKILL.md
- `using-git-worktrees` skill: https://github.com/obra/superpowers/blob/main/skills/using-git-worktrees/SKILL.md
- `finishing-a-development-branch` skill: https://github.com/obra/superpowers/blob/main/skills/finishing-a-development-branch/SKILL.md
- `dispatching-parallel-agents` skill: https://github.com/obra/superpowers/blob/main/skills/dispatching-parallel-agents/SKILL.md
- Releases: https://github.com/obra/superpowers/releases

### local-llm-harness (local)

- `README.md`
- `CONTEXT.md`
- `docs/codebase-design.md`
- `docs/roadmap.md`
- `docs/code-review-smells.md`
- `docs/adr/0001-drive-cli-not-sdk.md`
- `docs/adr/0002-single-branch-linear-commits.md`
- `docs/adr/0004-file-ledger-not-db.md`
- `docs/adr/0005-reviews-feed-the-retry-loop.md`
- `docs/adr/0006-verify-green-every-step.md`
- `docs/adr/0008-contracts-index.md`
- `docs/adr/0012-cross-attempt-learnings.md`
- `docs/adr/0013-push-learnings.md`
- `docs/adr/0014-small-context-perf-target.md`
- `docs/adr/0015-model-tier-policy.md`
- `docs/adr/0016-crash-resistant-resume.md`
- `src/cli/cli.ts`
- `src/execute/run.ts`
- `src/plan/plan.ts`
- `src/plan/planner.ts`
- `src/context/prompt.ts`
- `src/core/contracts.ts`
- `src/context/learnings.ts`
- `package.json`
- `harness.json`
