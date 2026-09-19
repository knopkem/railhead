# src/context — model-facing text and durable context files

Everything that assembles the text a model sees, plus the small files that carry knowledge across fresh phases: prompt builders, the durable-session builder prompt, learnings, digest, coherence charter, handoff, output/run summaries, and the surface classifier.

## Seams

- `prompt.ts` — implementer / test-phase / reviewer / contract-extract prompts, shared blocks (`buildContext`, `BROWSER_HYGIENE`, `HALT_CONTRACT`, `SCRATCH_FILE_DISCIPLINE`).
- `builder.ts` — durable-session builder prompt rendering (`buildBuilderPrompt`, gate feedback, checkpoint directive). The builder *loop* lives in `src/execute/`.
- `learnings.ts` — `.railhead/learnings.md` lifecycle: read/append/evict/consolidate, `LEARNED:`/`RETRACTED:` markers, failure-learning mining. Capped at `LEARNINGS_CHAR_LIMIT`.
- `digest.ts` — rolling project digest (`$DIGEST` marker) injected into planner rounds. Capped at `DIGEST_CHAR_LIMIT`.
- `coherence.ts` — `docs/coherence.md` charter grammar and `CHARTER:` revision application (ADR 0028).
- `handoff.ts`, `summary.ts`, `playthrough.ts`, `surface.ts` — marker parsing, oversized-output summarization, goal-playthrough section, visual-surface classification.

## Invariants

- Prompts must stay technology-agnostic (root AGENTS.md): say "the build command", never a specific compiler/package manager.
- `learnings.ts` and `summary.ts` call the executor for one-shot model passes — that is the one reason `context` depends on `execute`. Keep pure prompt builders pure.
- All caps are enforced on write; an oversized file is a silent context tax on every later phase.
