# Research: siesta vs local-llm-harness

Researched 2026-09-10 against primary sources: a local clone of siesta at
`/Users/macair/projects/siesta` (upstream credited in its README as
[`jairorodriguezarias/siesta`](https://github.com/jairorodriguezarias/siesta);
the clone's `origin` is `knopkem/siesta`, last commit `46bc8b1`, 2026-09-09),
read in full — `README.md`, `AGENTS.md`, and every file under
`factory/pipeline/` (`__main__.py`, `phases.py`, `pi.py`, `kb.py`, `learn.py`,
`text.py`) — plus this repo's own docs, ADRs, and source code.

**Scope.** Both systems turn a human intent into unattended, dependency-ordered
builds executed by a coding agent with verification gates. This note is
grounded in primary-source evidence with file/line citations; inferences are
flagged as such. The borrowings identified here are filed as issues
**#108–#113** (see §3.7).

---

## 1. What siesta actually is

### 1.1 Identity and goals

Siesta is a **local-first autonomous development pipeline for macOS**. The
tagline is *"Give me an idea, go take a siesta, come back to working code."*
You give it an idea, answer a few clarifying questions, then leave; it produces
a git repository with working, tested code.

> "Siesta is a local-first autonomous development pipeline for macOS. You give
> it a project idea, answer a few clarifying questions, then walk away."
> — `README.md`

Its architecture is a **thin Python orchestrator** (~2,300 lines across
`factory/pipeline/`) that shells out to the [`pi`](https://github.com/mariozechner/pi-coding-agent)
coding agent, with the intelligence pushed into **15 external skills** (10 from
[`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) +
5 custom factory skills) and a **self-improving JSON knowledge graph**.

### 1.2 Architecture and core mechanisms

**Role-based, config-driven routing.** Model routing lives in
`factory/config/models.json` and is read by `pi.py`: three independent roles
(planner, worker, consultant), each naming a `model` and a `provider` from the
user's `pi` catalog, plus an optional `thinking` level. Siesta hardcodes no
model, endpoint, or IP — the shipped config is a template with placeholders,
and a run fails fast (`validate_routing()`) if a role is unconfigured. The
three roles may share one model or use different ones:

| Role | Responsibility | Phases |
|---|---|---|
| planner | spec + plan; also the consultant when the worker is stuck | 0 interview, 1 spec, 2 plan |
| worker | writes code, runs tests, reviews, verifies | 3 execute, 4 review, 5 verify |
| consultant | consultations, deep diagnosis, human-proxy, learner | 3 (on stuck), 7 |

The protocol phases need a model that answers with markers
(`INTENT_FINALIZED:`, `VERIFY_PASSED:`) rather than tool-call JSON; the worker
must return **native tool calls** so it can write files and run commands. Both
are model properties a user selects, not siesta constants.

*(Before 2026-09-10 the repo shipped a fixed GLM-planner/Gemma-worker routing
via Ollama; this note was updated after the routing was made configurable and
provider-agnostic.)*

**One model-call wrapper.** Every call goes through `run_pi()` (`pi.py:170`),
which enforces two rules the pipeline depends on:

1. **One positional prompt** — body and directive merged, data first,
   directive last (`build_args`, `pi.py:142-167`). pi 0.84.3 stopped
   delivering `--append-system-prompt` content, so the old shape showed the
   model the format but not the subject.
2. **Explicit, config-driven thinking** (`build_args`) — `pi` is always called
   with an explicit `--thinking`, resolved from the role's configured level
   (default `off`). Reasoning is never inferred from the model name, so the
   framework hardcodes no model families and a misrouted call cannot fall back
   to a provider default the model may reject.

**Seven phases.** Phase 0 interview → 1 spec → 2 plan → 3 execute (TDD loop)
→ 4 review → 5 verify → 6 done/commit → 7 learn. Dispatch is in
`factory/pipeline/__main__.py`; phase bodies in `phases.py`.

### 1.3 Work decomposition

**Interview → spec → issues.** Phase 0 asks one question at a time until
~95% confidence, ending on `INTENT_FINALIZED:`. Phase 1 autonomously writes
`spec.md`; Phase 2 writes `issues.md` with ordered atomic issues, each with a
title, description, acceptance criteria, and dependencies. Issues are parsed
by `text.split_issues` (`text.py:80`) from `## Issue #N:` headers.

### 1.4 Quality and safety enforcement

Siesta's safety features are catalogued in `README.md` § Safety Features
(inspired by [`SantanderAI/ralph`](https://github.com/SantanderAI/ralph)) and
detailed in `AGENTS.md` § Interaction Flows. The load-bearing ones:

- **Regression suite before each issue** (`run_regression`, `phases.py:423`):
  all previous tests re-run before each new issue; a red suite gets one
  worker-driven repair attempt, then gates the next issue; two consecutive
  unrepairable suites halt phase 3. An empty suite (pytest exit 5) is
  *absence*, never green or failed (`phases.py:420-453`).
- **Blocked-issue residue discard** (`_discard_residue`, `phases.py:560`): a
  blocked issue's uncommitted work is restored/removed so the committed base
  stays honest — `git restore` + `clean -fd` without `-x`, so ignored run
  evidence and the KB survive.
- **Degenerate-output guard** (`text.degenerate`, `text.py:64`): tool-call
  JSON narration, questions to the absent human, and truncated/too-short
  output are non-answers — one feedback retry, then the issue is blocked.
- **Fence-free marker gates** (`text.without_fences`, `text.py:210`): every
  protocol marker is matched against the transcript with fenced code regions
  cut, so a marker quoted as an example can never fire.
- **Explicit approval marker** (`text.APPROVED`, `text.py:30`): proxy gates
  are fail-closed — only a line-start `APPROVED` continues.
- **Honest verify verdict** (`verify`, `phases.py:1060`): the verdict is
  persisted to `verify_verdict.txt`; resume reads it, never invents a pass.
- **Deep diagnosis after 3 failures** (`_escalate`, `phases.py:795-830`):
  a diagnosis prompt (`DIAGNOSE_PROMPT`, `phases.py:510-533`) returns a
  root cause and a plan fed back to the worker, with `SKIP:` (block + continue)
  and `CRITICAL:` (write `stop.md`, halt) outcomes.
- **`stop.md`** (`phases.py:649`): any agent can drop a file to halt the
  pipeline cleanly.
- **Call timeout** (`PI_TIMEOUT`, `pi.py:19`, env `SIESTA_PI_TIMEOUT`, 1200s):
  a hung call returns empty and counts as a failed attempt.

### 1.5 Context management

**Progressive-disclosure KB.** Agents load summaries first and drill in only
when needed (`AGENTS.md` § KB): Level 1 `{id, type, summary}`, Level 2 filtered
by type, Level 3 full detail. The store is a tiny JSON graph re-read on every
operation to avoid stale-instance clobbering (`kb.py:28-46`); `compact()`
(`kb.py:94`) emits summary-only JSON for prompts.

**Two KB tiers.** A per-project graph (`factory/projects/<name>/kb/graph.json`)
and a **global** graph (`factory/kb/global-graph.json`) that accumulates
learnings across all projects, including `principle` nodes injected into every
Phase 1 spec prompt and every per-issue worker context (`pre_issue`,
`phases.py:97`).

**Gather budget.** `gather()` (`phases.py:54`) caps the total source shown to
any model call (`GATHER_BUDGET = 120_000`, `phases.py:51`) and emits a
`TRUNCATED: N further source files not shown` notice for what was cut.

### 1.6 Self-improvement loop

After **every issue**, `learn.learn_issue` (`learn.py:168`) runs the learner
role: it analyzes what happened (stuck? consulted? rejected? retried?) and
emits `LEARNING:` / `SKILL_IMPROVEMENT:` / `NEW_SKILL:` actions plus optional
`SKILL_UPDATE_START/END` blocks. `act_on_learnings` (`learn.py:24`) logs to the
global KB; `apply_skill_updates` (`learn.py:42`) rewrites **factory** skills
(never addyosmani skills), with a guard that rejects a block that is not a
complete `SKILL.md` so a truncated learner block cannot gut a skill.
`learn_project` (`learn.py:290`) does the cross-issue summary at project end.

### 1.7 Durability and resumability

State lives in files, not the session: the KB graph plus git history. Resume is
**per-issue idempotent** (`execute`, `phases.py:641-648`): an issue whose
`"Issue #N completed"` decision node is already on disk is skipped; blocked
issues have no node and naturally retry. The final summary rebuilds the blocked
list from KB blocker nodes so a resumed run never reports "0 blocked" while the
KB holds blockers.

### 1.8 Maturity and requirements

Small, early, and moving fast. `factory/BACKLOG.md` doubles as a changelog of
what Siesta learned about itself (the code comments cite rounds 3–9 of live
runs). It requires the `pi` CLI and a model provider configured in pi's
catalog (local or hosted); there is no packaging or published release cadence.
The worker must be verified for native tool calling and registered in pi's
catalog with its **true served context window** (`README.md` § Installation
note; `AGENTS.md` § Model Routing).

---

## 2. Point-by-point comparison with local-llm-harness

| Dimension | siesta | local-llm-harness |
|---|---|---|
| **What it is** | Thin Python orchestrator + external skills + self-improving KB, driving `pi`. | Standalone TypeScript CLI driving `opencode`. |
| **Size** | ~2.3k LOC orchestrator, 15 markdown skills. | ~46k LOC TypeScript. |
| **Primary goal** | "Idea in, working code out" for a solo macOS user. | Unattended builds on small-context local models. |
| **Controller** | Python orchestrator; intelligence in prompts/skills. | TypeScript harness; intelligence in gates and parsers. |
| **Agent runtime** | `pi` (provider configured in pi's catalog; local or hosted). | `opencode` (any provider, local or hosted). |
| **Model routing** | Fixed roles: planner/consultant (GLM cloud) vs worker (Gemma). | Per-seat slots (`plan`/`implement`/`review`/`visual`/`goal`/`extract`) + fallback chains (ADR 0015). |
| **Decomposition unit** | Ordered atomic issues from `issues.md`. | Tickets with acceptance criteria, `blocked_by`, `files`, `references`, `introduces`. |
| **Execution** | One worker invocation per issue; TDD; consult on stuck. | Fresh subprocess per phase (or durable session builder, ADR 0022). |
| **Verification** | Regression suite before each issue + runtime smoke. | `harness.json` verify after every committed ticket (ADR 0006). |
| **Review** | Single 5-axis code review + human-proxy approval. | Per-ticket code review + visual/goal/structural gates with cadence modes. |
| **Escalation** | Consult → retry → deep diagnosis (plan fed back) → SKIP/CRITICAL. | 3-rung failure ladder; rung 3 terminal; review findings feed retries (ADR 0023/0005). |
| **Knowledge/context** | Two-tier JSON KB (project + global), progressive disclosure. | Contracts index + per-project `.harness/learnings.md` (ADR 0008/0012). |
| **Learning** | Self-modifying factory skills after every issue. | Harness-extracted learnings; prompts live in code. |
| **Durability** | KB graph + git; idempotent per-issue resume. | `state.json` + `events/<phase>.jsonl`; crash-resistant resume (ADR 0004/0016). |
| **Human-in-the-loop** | Interview at start, then autonomous; human-proxy replaces approval. | Optional bounded interview; `-a` fully unattended. |
| **Provider coupling** | `pi` + a user-configured provider catalog; siesta hardcodes no model/endpoint. | `opencode` CLI, provider-agnostic by design (ADR 0001). |

### 2.1 Same problem, opposite center of gravity

Siesta puts the intelligence in **prompt text and skills**; the orchestrator is
thin and the model is trusted to hold the protocol. The Harness puts the
intelligence in **code and mechanical gates**; the model is a replaceable
subprocess and prompt-compliance is assumed to fail (the same conclusion this
repo reached in `superpowers-comparison.md` §6.2). On a 27B local model, the
Harness's mechanical stance is the safer one — but siesta's *content* is a
battle-tested source to mine.

### 2.2 Where they converged

Independent arrival at the same invariants is evidence the Harness's decisions
are right:

- verify/regression green as a precondition for progress (ADR 0006 ↔
  `run_regression`);
- honest verdicts, never a silent pass (ADR 0009 ↔ `verify_verdict.txt`,
  `UNVERIFIED` commits);
- bounded context with explicit truncation (contracts index + request ceiling
  ↔ `gather()`/`GATHER_BUDGET`);
- file-based state as the resume source (ADR 0004 ↔ KB graph + git);
- marker protocols rather than trusting tool-call JSON.

### 2.3 Where the Harness is ahead

- **Resume correctness** — `state.json` per-ticket statuses beat siesta's
  summary-string matching against KB nodes.
- **Gate richness** — visual/goal/structural reviews, coherence charter,
  contracts index, severity-aware retries have no siesta analogue.
- **Audit trail** — append-only `events/<phase>.jsonl` vs siesta's overwritten
  `*_output.txt`.
- **Self-modifying skills are a liability** — siesta guards against a
  truncated learner block gutting a skill; the Harness's code-resident prompts
  cannot be gutted by a model. Do not adopt self-modification.

### 2.4 Where siesta is ahead

- **Cross-project memory** — the global KB makes the *next* project smarter;
  the Harness's learnings are per-project by design (ADR 0012).
- **Fence-aware marker parsing** — a proven hardening the Harness lacks.
- **A diagnosis rung that produces a plan** — the Harness's rung 3 only
  diagnoses in prose.
- **A first-class halt signal** any phase can raise.

---

## 3. What local-llm-harness could learn / borrow from siesta

Ranked by value and feasibility; each is filed (see §3.7).

### 3.1 Fence-aware marker parsing (high value, low effort)

Siesta cuts fenced regions before matching any protocol marker
(`text.without_fences`, `text.py:210`; applied at `phases.py:721,758,843` and
`learn.py:211`). The Harness's `parseVerdict` (`reviewer.ts:212`) searches the
raw transcript, and the review prompts themselves print the markers — so a
model echoing the format inside a ``` block can trigger a false verdict, and
`parseVerdict` prefers FAIL. Small, self-contained, testable.

### 3.2 Portable cross-project learnings (high value, architectural)

Siesta's two-tier KB (`factory/kb/global-graph.json` + `principle` nodes) is
its headline advantage. The Harness's `learningsPath()` is per-project
(ADR 0012) with a ~2,200-char budget (`src/context/learnings.ts`); nothing travels.
A curated portable tier (user-home principles injected at plan time) is the
analogue — but it needs an ADR to settle curation, trust, injection points,
and privacy.

### 3.3 Diagnosis as a plan-producing rung (medium-high value, medium effort)

Siesta's third failure produces a *plan* fed back to the worker, with
`SKIP`/`CRITICAL` outcomes (`_escalate`, `phases.py:795-830`). The Harness's
`nextRung` rung 3 is terminal prose (`failure-ladder.ts:175-181`). Adding a
diagnosis phase before giving up would convert some hard fails into
recoveries — but `$SKIP` must be reconciled with ADR 0003 (stop-not-skip).

### 3.4 Agent-initiated halt (medium value, low effort)

Siesta's `stop.md` (`phases.py:649`) lets any agent halt cleanly. The Harness
has SIGINT handling (`run.ts:264`) and `--pause-on-failure`, but no signal a
phase can raise when it concludes "stop — this needs a human."

### 3.5 Shared degenerate-output classifier (medium value, low effort)

Siesta names three non-answer shapes in one place (`text.degenerate`,
`text.py:64`). The Harness has one instance (`toolCalls === 0`, `run.ts:862`)
that is skipped under the builder and does not cover "asks the absent human" or
"too short", and the review seats route these silently to inconclusive.

### 3.6 Capability-aware routing validation (medium value, low effort)

Siesta makes thinking a per-role config value and, where the provider exposes
one, probes served-vs-declared context (`pi.py` `warn_if_context_mismatch`).
The Harness already probes vision/reasoning/context
(`src/core/models.ts`, `src/cli/cli.ts`) and clamps reasoning, but does not validate
that a seat's model has the capability the seat needs, nor compare the served
window against the declared one.

### 3.7 Anti-lessons (do not adopt)

- **Self-modifying skills** — siesta lets the learner rewrite factory skills;
  its own guards exist because that is dangerous. The Harness's code-resident
  prompts (ADR 0007) are more reliable.
- **Single 5-axis review** — coarser than the Harness's gate set; no reason to
  regress.
- **Fixed dual-model roles** — the Harness's per-seat routing (ADR 0015) is
  strictly more flexible.

### 3.8 Borrowings filed

| Borrow | Issue |
|---|---|
| Fence-aware marker parsing | **#108** |
| Portable cross-project learnings | **#109** |
| Diagnosis as a plan-producing rung | **#110** |
| Agent-initiated halt (`stop.md`) | **#111** |
| Shared degenerate-output classifier | **#112** |
| Capability-aware routing validation + served-vs-declared context guard | **#113** |

---

## 4. Verdict

Siesta and local-llm-harness solve the same problem from opposite ends: siesta
trusts the model and externalizes intelligence into skills and a KB; the
Harness trusts code and externalizes it into gates and parsers. They are
**complementary, not substitutes**, and siesta is the smaller, earlier, more
experimental project — a source of proven ideas rather than a peer to match.

The honest read: the Harness is far more mature on verification, resume, and
audit; siesta is ahead on **adaptivity** (cross-project memory, self-tuning
skills) and on a handful of **cheap robustness primitives** (fence-aware
parsing, degenerate taxonomy, a halt signal). The highest-value, lowest-regret
imports are §3.1 (fence-aware parsing) and §3.3 (diagnosis rung); §3.2
(portable learnings) is the one genuinely different capability and belongs in
an ADR before any code.

---

## 5. Confidence and caveats

| Claim | Confidence | Caveat |
|---|---|---|
| Siesta is a thin Python orchestrator + skills + KB. | High | Read `factory/pipeline/` in full. |
| The two systems target different runtime regimes. | High | Follows from `pi`/provider-agnostic vs `opencode` and the model routing. |
| Fence-aware parsing is absent in the Harness. | High | `parseVerdict` (`reviewer.ts:212`) and the sibling parsers search raw text. |
| The Harness's learnings are per-project only. | High | `learningsPath()` + ADR 0012. |
| Rung 3 of the ladder is terminal prose, not a plan. | High | `failure-ladder.ts:175-181`. |
| Siesta's self-improvement is a reliability risk. | Medium (inference) | Its own guards (`apply_skill_updates`) imply the risk; no independent failure data. |
| Siesta's model-routing table (8B local vs 31B cloud). | Medium | `README.md` and `AGENTS.md` disagree on the worker (8B local vs 31B cloud since round-9); the code reads only `models.json`. |

---

## 6. References

### siesta (local clone `/Users/macair/projects/siesta`; upstream `jairorodriguezarias/siesta`)

- `README.md`
- `AGENTS.md`
- `factory/pipeline/pi.py` — `run_pi`, `build_args`, `validate_routing`, `warn_if_context_mismatch`
- `factory/pipeline/phases.py` — `pre_issue` (97), `gather` (54), `run_regression` (423), `_discard_residue` (560), `_escalate` (752), `runtime_smoke` (1001), `verify` (1060)
- `factory/pipeline/learn.py` — `act_on_learnings` (24), `apply_skill_updates` (42), `learn_issue` (168), `learn_project` (290)
- `factory/pipeline/kb.py` — `Graph` (28), `compact` (94)
- `factory/pipeline/text.py` — `degenerate` (64), `split_issues` (80), `without_fences` (210)
- `factory/pipeline/__main__.py` — phase dispatch, failure trap
- `factory/config/models.json`, `factory/kb/schema.json`, `factory/kb/global-graph.json`
- `factory/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`

### local-llm-harness (this repo)

- `README.md`, `CONTEXT.md`, `AGENTS.md`
- `docs/research/superpowers-comparison.md`
- `docs/adr/0003-stop-not-skip-on-retry-exhaustion.md`, `0004-file-ledger-not-db.md`, `0006-verify-green-every-step.md`, `0007-railhead-owns-ticket-format.md`, `0009-visual-final-review.md`, `0012-cross-attempt-learnings.md`, `0013-push-learnings.md`, `0015-model-tier-policy.md`, `0022-restated-purpose-session-builder-interleaved-gates.md`, `0023-failure-response-ladder.md`
- `src/gates/reviewer.ts` (`parseVerdict` 212), `src/gates/goal-review.ts` (`parseGoalVerdict` 22, `parseReplanRequested` 33, `parseCorrectiveTickets` 49), `src/gates/visual.ts`, `src/gates/structural-review.ts`
- `src/execute/failure-ladder.ts` (`nextRung` 129), `src/execute/run.ts` (`installSignalHandlers` 264, `toolCalls === 0` guard 862), `src/context/learnings.ts`, `src/core/models.ts`, `src/config/config.ts` (`warnIfOversightModelIsLocal` 881)
