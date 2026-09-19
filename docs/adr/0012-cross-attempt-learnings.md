# Cross-attempt learnings for unattended builds

> **STATUS: SUPERSEDED by ADR 0013** (push-learnings). The pull-extraction mechanism this ADR chose was empirically refuted by `run-20260826-1159`: 0/5 pull coverage vs 5/5 push coverage on the same run. ADR 0013 keeps this ADR's *shape* (per-project file, char budget, consolidation, injection) and replaces only the *persistence mechanism* (pull → push). Read this ADR for the original reasoning; read 0013 for the decision in force.

## Context

The railhead runs each phase (implement, review, visual) as a fresh `opencode` subprocess (ADR 0001). This keeps context O(ticket) and prevents context rot — but it means every retry starts from zero. If the implementer spent 30 steps figuring out that `screencapture -x` gives raw PNG on macOS (a tooling fact, not a code fact), the next attempt rediscovers the same thing. On the Pong run (Aug 2026), the visual reviewer spent multiple rounds re-learning how to capture and interact with the Bevy window — knowledge that the end-of-run visual review's `priorFindings` mechanism partially covered, but only for visual findings, not general tooling facts.

Hermes Agent (NousResearch) solves this with a managed memory system: a tool the agent calls to persist facts, injected as a frozen snapshot into the system prompt. The railhead's design philosophy is the opposite — the railhead orchestrates, the agent executes; the agent's prompt stays simple and predictable.

## Decision

Add a **learnings** system: a single `.railhead/learnings.md` file per project (not per run) that accumulates tooling/environment facts extracted from implement-phase transcripts. The railhead writes it (not the agent); the railhead injects it into every subsequent implementer, reviewer, and visual reviewer prompt as a `## Project learnings` section.

### Shape

- **Who writes:** the railhead, not the agent. After an implement phase that was retried (attempt > 1) or any visual review phase, the railhead runs an extraction call on the transcript using `model.implement`. The extraction prompt asks: "This phase was retried / the reviewer ran the app. Extract the tooling or environment facts the agent discovered between attempts. Output one fact per line, or NONE." The railhead appends the results to `.railhead/learnings.md`.
- **Where it lives:** `.railhead/learnings.md` — a single file, per-project (not per-run). A Pong build's learnings survive into a Pong fix run, but don't leak into a TypeScript project. Matches the project scope: a project is about one thing.
- **Schema:** freeform one-per-line. No tags, no JSON, no timestamps. Terse, self-contained facts. The model writes them; the railhead parses by splitting on newlines.
- **Char budget:** ~2,200 chars (~800 tokens). When the file would exceed the budget, the extraction model is also asked to consolidate: merge overlapping entries, remove stale ones, output the full merged file. The railhead replaces the file wholesale.
- **When extraction runs:** after implement *retries* (attempt > 1 — a one-shot success rarely teaches a tooling fact because nothing went wrong) and after any visual review phase (the visual reviewer discovers how to interact with the app, how to capture screenshots, what the app looks like — high-signal tooling facts that the next visual round or corrective ticket's implementer can use). Skips one-shot implement successes and text reviews (diff-based, doesn't run commands). This was refined from the original "implement phase only" after the Pong run (Aug 2026) showed that a cheap implementer (Qwen 35B) discovered nothing, while the strong visual reviewer (Kimi K3) discovered all the tooling facts — but would have been skipped under the original rule.
- **Which prompts get it:** implementer, text reviewer, and visual reviewer. All three can benefit from knowing "cargo run panics without a TTY on this project."
- **Injection point:** a `## Project learnings (tooling facts from prior phases)` section in the prompt, between the ticket body and the verify block. The model treats them as ambient context, not instructions.

## Considered Options

- **Agent writes via opencode tool** (Hermes approach): richer — the agent decides what's worth keeping — but requires a tool plugin and risks the agent wasting steps writing noise. Rejected: violates the railhead's "railhead orchestrates, agent executes" design principle (ADR 0001).
- **Agent writes via $LEARNED marker**: no new tool needed, but depends on the model consistently emitting the marker. Fragile with small models. Rejected.
- **Per-run learnings**: clean (no stale accummulation) but can't carry forward tooling facts that are genuinely project-level (the TTY panic is a Bevy project fact, not a run fact). Rejected.
- **Per-run, carry forward**: middle ground but the chain is fragile — an interrupted run loses the link. Rejected in favour of per-project, which is simpler and matches the project scope.

## Consequences

- One new file (`.railhead/learnings.md`), one new extraction prompt, one extra `executeOpendCode` call per implement phase. The call uses `model.implement` (already the cheapest slot) and is one step — negligible cost vs the 50+ steps the implementer itself uses.
- `.railhead/learnings.md` must be in `protectedPaths` so `cleanWorktree` doesn't delete it between implement attempts (it's untracked — plan writes it after the first implement phase).
- The char budget (~800 tokens) is paid on every phase prompt. For a 3-ticket run with per-ticket visual, that's ~9 implementer/reviewer/visual prompts × 800 = ~7,200 extra tokens total — negligible.
- Pruning is model-driven (consolidation when full), not heuristic. The extraction model is the same model that writes the learnings, so it understands the domain.
- Learnings are per-project. A `railhead plan` on a new project starts with no learnings file. A `railhead fix` on the same project picks up prior run's learnings. This is the desired behavior.
