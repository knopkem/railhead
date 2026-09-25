# src/plan — plan production

Turns a description into the ordered ticket queue: the `runPlan` two-call flow, the lossy plan parsers, the sharpen interview, and plan identity.

## Seams

- `planner.ts` — `runPlan`: one call for a fix; design → ticket decomposition for a build, with an optional post-plan interview, an interactive PLAN.md review, a plan gate, and the deterministic test-hardener ticket around it. Also `runSharpenSession` and `maybeGenerateAgentsMd` (writes a MINIMAL root AGENTS.md for the target project, only when none exists).
- `plan.ts` — prompt builders and the lossy block parsers: `planDesignSystemPrompt`, `planTicketsSystemPrompt`, `planFixSystemPrompt`, `planContinuationSystemPrompt`, `buildPlanGatePrompt`, `parsePlanGateVerdict`, `parsePlanJson`, `parseVerifyBlock`, `parseSmokeBlock`, `parseDesignBlock`, `parseArchitectureBlock`, `parseInterfaceBlock`, `splitCoherenceContract`.
- `sharpen.ts` — the plan-time interview: round parsing, depth budget, `renderPlanInterviewAnswers`, glossary/ADR writes (`appendContextTerms`, `writeGrillAdr`).
- `plan-identity.ts` — `origin.json`; `checkPlanOrigin` refuses to resume a plan against a changed prompt.
- `plan-contradiction.ts` — detects a resolver failure that contradicts a plan-authored artifact name.

## Invariants

- Planning is exactly two model calls for a build (design, then tickets) and one for a fix. There is no model coverage audit, no plan-repair round, and no `$PLAN` block: the ticket decomposition is validated deterministically (non-empty `what`, criteria present unless `open_ended`) and a truncated decomposition gets exactly ONE "emit the remaining tickets" continuation call.
- Unattended builds then run ONE plan gate (goal seat, ADR 0049 amendment): it walks the goal's demands against the ticket ownership map and fails/regenerates the frontier via the mid-run replan prompt, capped by `max_replans`; a plan still failing at the cap is rejected before the first commit. Interactive runs skip it (the human review is the coverage check).
- Criteria are observable behaviours (ADR 0007 amendment), optionally with an indented `probe:` recipe inside the same string. The planner never emits "(test)" asks; when the plan's verify block names a test runner, a final hardener ticket is appended after the frontier to transcribe confirmed probe behaviours into the project's own test stack.
- The parsers are deliberately tolerant of mid-array garbage, truncation, and prose-wrapped JSON; tests assert the malformed shapes, not just the happy path. A region whose `"title"` keys outnumber its parsed tickets reports `unparsed` — truncation is never a silent shrink.
- Ticket format coupling (ADR 0007): changes to `src/core/ticket.ts` (the ticket shape or `numberTickets`) require matching prompt/parser changes here.
- Model rounds go through `src/execute/executor.ts` — planning is a client of execute, never the other way around.
