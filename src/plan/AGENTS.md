# src/plan — plan production and repair

Turns a description into the dependency-ordered ticket graph, then revises it: the `runPlan` stage machine, the lossy plan parsers, the sharpen interview, and plan identity/rulings.

## Seams

- `planner.ts` — `runPlan`: design → ticket emission → mechanical repair → coverage/plan review → decomposition; also `runSharpenSession` and `maybeGenerateAgentsMd` (writes a MINIMAL root AGENTS.md for the target project, only when none exists).
- `plan.ts` — prompt builders and the lossy block parsers: `parsePlanJson`, `parseVerifyBlock`, `parseSmokeBlock`, `parseDesignBlock`, `parseInterfaceBlock`, `parseCoherenceContract`, conflict tables (`scanPlanConflicts`, `impliedBlockedByEdits`).
- `sharpen.ts` — the plan-time interview: round parsing, depth budget, `renderPlanInterviewAnswers`, glossary/ADR writes (`appendContextTerms`, `writeGrillAdr`).
- `plan-identity.ts` — `origin.json`/`rulings.json`; `checkPlanOrigin` refuses to resume a plan against a changed prompt.
- `plan-contradiction.ts` — detects a resolver failure that contradicts a plan-authored artifact name.

## Invariants

- The parsers are deliberately tolerant of mid-array garbage, truncation, and prose-wrapped JSON; tests assert the malformed shapes, not just the happy path.
- Ticket format coupling (ADR 0007): changes to `src/core/ticket.ts` or `src/core/ticket-dag.ts` require matching prompt/parser changes here.
- Model rounds go through `src/execute/executor.ts` — planning is a client of execute, never the other way around.
