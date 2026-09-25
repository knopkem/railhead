# src/context — model-facing text and durable context files

Everything that assembles the text a model sees, plus the small files that carry knowledge across fresh phases: prompt builders, the durable-session builder prompt, learnings, digest, coherence charter, output/run summaries, and the surface classifier.

## Seams

- `preamble.ts` — the two-message phase shape (#132): `renderPreamble` (canonical, byte-stable message 1 from stable inputs only), `renderTask` (message 2, volatile), `joinPhaseMessages` (the fail-open joined wire form used when no base session is held; #133 forks the base and sends only the task). Pure; imports nothing.
- `prompt.ts` — reviewer / contract-extract prompts, shared blocks (`BROWSER_HYGIENE`, `HALT_CONTRACT`, `SCRATCH_FILE_DISCIPLINE`). Builders return `PhaseMessages`.
- `builder.ts` — durable-session builder prompt rendering (`buildBuilderPrompt`, gate feedback, checkpoint directive). The builder *loop* lives in `src/execute/`. Every visual-surface ticket gets the screenshot self-check cadence (gated by the measured vision capability), and a warm surface invocation re-injects the design doc VERBATIM rather than trusting a cheap model to re-read it.
- `learnings.ts` — `.railhead/learnings.md` lifecycle: read/append/evict/consolidate, `LEARNED:`/`RETRACTED:` markers, failure-learning mining. Capped at `LEARNINGS_CHAR_LIMIT`.
- `digest.ts` — rolling project digest (`$DIGEST` marker) injected into planner rounds. Capped at `DIGEST_CHAR_LIMIT`.
- `coherence.ts` — `docs/coherence.md` charter grammar and `CHARTER:` revision application (ADR 0028).
- `summary.ts`, `playthrough.ts`, `surface.ts` — oversized-output summarization, goal-playthrough section, visual-surface classification.

## Invariants

- Prompts must stay technology-agnostic (root AGENTS.md): say "the build command", never a specific compiler/package manager.
- The canonical preamble carries STABLE inputs only — mission, AGENTS.md, CONTEXT.md, the planner's design/architecture/coherence docs. Ticket, diff, contract, learnings, digest, and finding text belongs in the task message; never pass it to `renderPreamble` (ADR 0020 amendment, #132).
- `learnings.ts` and `summary.ts` call the executor for one-shot model passes — that is the one reason `context` depends on `execute`. Keep pure prompt builders pure.
- All caps are enforced on write; an oversized file is a silent context tax on every later phase.
