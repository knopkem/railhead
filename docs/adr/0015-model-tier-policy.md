# Model tier-routing policy: 27B+ for judgment seats, 9B OK only for the extract slot

## Context

ADR 0014 commits the railhead to a 16GB-VRAM / 27B-Q4 primary model class and names a 9B-Q4 secondary target — but only for "narrow railhead seats," without enumerating which seats those are. That left an ambiguity in practice: the Bevy upgrade run (issue #1) ran the same Qwen 35B in both `model.implement` and `model.review`, and a hallucinating reviewer had nowhere to escalate. Three things are now clear enough to record as policy:

1. The railhead exposes model slots (`model.plan`, `model.implement`, `model.review`) but the seat-to-model-class expectations are documented only in prose scattered across ADR 0001/0014. There is no single place a user can read "this seat wants 27B+; this one tolerates 9B."
2. The upcoming extraction tickets (#2 push-learnings, #8 verify-output summarization, #9 phase-handoff) all need a cheap single-shot model seat. ADR 0007's coupling of ticket format and planner prompt means a small-model mistake at the *plan* seat propagates everywhere — that seat is judgment, not narrow.
3. `resolveModels` today silently falls back `model.review ?? model.implement` (`src/config/config.ts:220`), so a user who sets only `model.implement` is running the same model in both seats without being told. That's a footgun under ADR 0014's "asymmetric reviewer" reasoning — the whole point of a separate `review` slot is you *can* run a stronger reviewer than implementer.

This ADR records the policy. The implementation (a `model.extract` slot, startup warnings) lands in this same ticket because the policy is unenforceable without the seat to land extraction tickets into — but the policy itself is the decision; the code is the surface area that exposes it.

## Decision

### The seats

| Seat | Tier floor | Rationale |
|---|---|---|
| `model.plan` | 27B+ minimum | Planning shapes the ticket graph. ADR 0007 couples the ticket format and the planner prompt, so a small-planner mistake (over-fragmented tickets, unbounded slices) propagates to every downstream phase. Single-pass judgment with cascading consequences — the definition of a judgment seat. |
| `model.implement` | 27B+ minimum | The implementer does the most multi-step reasoning. ADR 0014 explicitly rejects 9B here: its multi-step unreliability pairs badly with the context-slowdown gradient, because error-prone work needs more steps and each step slows as context fills. |
| `model.review` | 27B+ minimum, AND a separate slot from `model.implement` | Text review is judgment work and must be 27B+. The slot must also be *separable* — a user can run a stronger reviewer than implementer. The Bevy run's failure mode (a 35B reviewer hallucinating `[BLOCKER]` compile failures with nowhere to escalate) argues asymmetric strengths are not a luxury, they are the recovery path. Default coupling (both set to the same model) is fine; the *separation* is what must be possible. |
| `model.visual` (uses `model.review` today) | 27B+ with vision capability | Visual review needs vision *and* reasoning. A 9B vision-capable model exists, but its reasoning on screenshots is poor, and a wrong visual verdict generates corrective tickets that waste a full implement→verify→smoke→review cycle each. Judgment work, with a representation cost on error. |
| `model.extract` (new) | 9B-Q4 OK; this is the only tier where 9B is endorsed | For single-shot structured-output passes: `extractLearnings`/`mergeLearnings` consolidation, verify-output summarization (#8), phase-handoff extraction (#9). These emit one structured response and exit — no recovery loop, no multi-step exploration — which is exactly the class ADR 0014 reserves for 9B. |

### The policy

1. **Three judgment seats are 27B+ minimum**: plan, implement, review. The railhead warns at startup if any of these is configured below ~27B-equivalent. The warning is advisory, not a hard reject — a user in a hurry can proceed, but the run is marked experimental. Per ADR 0001's "railhead orchestrates, agent executes," the railhead *advises* on model choice; the user decides.

2. **One narrow seat is 9B-Q4 OK**: the new `model.extract` slot. The default for `model.extract` is `null` (falls back to `model.implement` for now), because the extraction tickets that consume it (#2, #8, #9) do not exist yet. When they land, callers resolve `model.extract ?? model.implement` — same fallback shape as `review ?? implement`. The railhead does not switch the existing extraction call sites to a 9B default in this ticket; that switch is part of those tickets, not this policy.

3. **`model.review` is a separate slot from `model.implement`**, even when set to the same model. The fallback `review ?? implement` stays (compatibility with existing railhead.json files that predate asymmetric configuration), but the railhead logs `"warning: model.review unset, falling back to model.implement"` at startup when the fallback fires. The warning is the policy made visible: a user who meant to configure a stronger reviewer and forgot now sees it.

4. **No seat falls back silently.** The `review ?? implement` fallback logs. The (future) `extract ?? implement` fallback will log the same way. `plan ?? implement` does not need a warning — it is conventional to reuse the implementer for planning and the asymmetry there is rarely meaningful.

### What this rules out

- **Hard rejection of sub-27B judgment models.** Considered and rejected. The railhead's role is to advise, not to gate. A user on a 16GB M-series MacBook running a 13B model is not the target audience (ADR 0014), but the railhead will not refuse to run — it will warn and proceed.
- **Auto-selecting a 9B model for `model.extract` when unset.** Rejected. The default stays `null` (→ `model.implement`) until the consuming tickets land, because auto-switching to a 9B model before the extraction call sites are structured for single-shot output would degrade quality on tasks that are still multi-step. The *policy* is "9B OK here"; the *application* is per-ticket.
- **Benchmarking 9B vs 27B on the extract seat.** Out of scope. The research note (`docs/research/small-local-llm-techniques.md` §2) found no high-signal 9B-as-judge evidence, which supports the "narrow seats only" stance but does not measure it. A follow-up ticket should record real measurements once #2/#8/#9 land.

## Consequences

- `ModelConfig` and `ResolvedModels` gain an `extract: string | null` field. `loadConfig` reads `model.extract` from railhead.json (default `null`). `applyModelOverrides` accepts `--extract`. `resolveModels` resolves `extract: model.extract ?? model.implement`.
- The CLI startup path (`cmdRun` in `src/cli/cli.ts`, after `printModels`) emits two advisory warnings: (a) when `model.review` was unset and fell back to `model.implement`; (b) when a judgment-seat model (plan, implement, review) looks sub-27B by a parameter-count heuristic. Both are `console.log WARNING:` lines, not hard failures.
- The parameter-count heuristic is intentionally crude: parse the model string for a number followed by `B` (e.g. `qwen3-7b`, `Qwen3.6-35B-A3R`) and compare to 27. False positives (a model named with a non-parameter number) are acceptable because the warning is advisory — a confused user re-reads their config, a confident user ignores it. The heuristic is exposed as a pure function `modelParameterClass` so it is unit-tested for the lossy parsing.
- The Bevy run's failure mode is partially mitigated: with #1's prompt+parser guard (hallucinated compile claims dropped on green verify) AND this ADR's "asymmetric reviewer" policy made visible, a future run can configure a stronger reviewer than implementer and the railhead will both surface the configuration and trust the verify evidence.
- Tickets #2, #8, #9 now have a `model.extract` seat to land into. Their implementing tickets resolve `model.extract ?? model.implement` at their call sites; this ADR provides the slot and the policy but does not switch the existing `extractLearnings` call site (which still uses `model.implement`) — that switch belongs to #2.

### Oversight seats: the intended consumers of the strong-model tier (#52)

`model.goal` (and, when it lands, the structural review seat from #49) is the oversight tier — the architect that catches architectural drift the local implementer accumulates across tickets. The `goal` seat falls back through `goal → visual → review → implement` (`resolveModels`), which means a user who sets only `model.implement` is running the same local model in every seat, including oversight. That defeats the purpose: goal review needs a *different perspective*, not just the same model looking at its own output. The railhead warns at run start when goal review is enabled and `model.goal` resolves to the same value as `model.implement` (`warnIfOversightModelIsLocal`). The `railhead init` flow recommends a hosted strong model for the goal seat. This is the cheapest mitigation for unattended quality: the model seats already exist; this just makes the choice actionable at init time and visible at run start.
