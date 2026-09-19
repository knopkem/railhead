# Rolling project digest

## Context

ADR 0012 introduced `.railhead/learnings.md` — tooling facts discovered by
prior agents (a command that needs a flag, a port that isn't default).
Learnings give each fresh-context agent a head start on the environment.

But there is no analogous artifact for **architectural state** — the rolling
summary of what has been built, what conventions the codebase has settled
into, and what structural milestones have been reached. Without it:

- An implementer on ticket #20 has no idea that tickets #5–#10 established
  a factory pattern for module creation — it rediscovers the pattern or
  diverges.
- A reviewer on ticket #25 can't see that the project has drifted from
  `architecture.md` in a specific direction — it reviews each diff in
  isolation.
- A goal reviewer at checkpoint #3 doesn't know what the structural shape
  was at checkpoint #2 — it has no rolling memory between checkpoints.

## Decision

Add a **rolling project digest** (`.railhead/digest.md`) — a bounded
architectural state summary that:

1. Is **written** by review seats (goal review and structural review) at
   checkpoint boundaries via `DIGEST:` markers in the transcript.
2. Is **read** by every seat that makes structural decisions: implementer,
   reviewer (inline + read-mode), goal reviewer, structural reviewer.
3. Is **bounded** by `DIGEST_CHAR_LIMIT` (3000 chars) — older entries are
   evicted from the front when new entries exceed the budget.

### Why distinct from learnings

- **Different content**: learnings are tooling environment facts ("the dev
  server runs on port 3001"); the digest is architectural state ("module A
  uses a factory pattern; contracts index includes entries for B, C").
- **Different lifecycle**: learnings can be retracted (`RETRACTED:`) when
  proven false. The digest is never retracted — it is a rolling log, and
  old entries age out by the budget gate.
- **Different consumer frame**: learnings come with a "test before trusting"
  caveat because they concern the model's own capabilities. The digest
  comes with a "trust the source if it contradicts" caveat because it
  concerns the codebase, which the agent can read directly.

### Why `DIGEST:` markers, not a separate phase

Same rationale as learnings (ADR 0013): no additional LLM call. The goal
reviewer and structural reviewer already read the codebase and understand
the architectural state at checkpoint time. They emit `DIGEST:` lines as a
side effect of their existing review, the same way they emit `LEARNED:`.

### Budget gate

`wouldExceedDigestBudget` mirrors `wouldExceedBudget` from learnings. When
the budget would overflow, `pushDigest` truncates from the front (keeping
the most recent entries), not from the back — recent architectural state
is more valuable than stale state.

## Consequences

- One additional `readDigest` call per seat that builds a prompt. Cheap —
  it's a single file read.
- The digest is an unverified model-claim, like learnings. The injection
  block warns: "If a statement in the digest contradicts what you observe
  in the source, trust the source."
- The 3000-char budget is a judgment call. Too small and it ages out
  before a multi-checkpoint run finishes. Too large and it consumes context
  tokens better spent on the actual ticket. 3000 chars ≈ 750 tokens — a
  fraction of the implementer's context budget.
