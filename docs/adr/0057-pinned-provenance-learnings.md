# Pinned, provenance-tagged learnings (amends ADR 0013)

## Context

ADR 0013's push path made `.railhead/learnings.md` the project's durable tooling memory, bounded at 2,200 chars. Both loss paths into that file are silent:

- `evictOldestToFit` drops the oldest lines when the budget fills, regardless of value. A vital fact (a required env var, a flag the build command needs) can age out behind disposable ones.
- When `model.extract` is configured, consolidation can merge or trim anything the model judges mergeable — a model call the operator cannot inspect or veto.

The file also carries no record of *where* a fact came from. A stale fact cannot be traced to its transcript, and repeated pushes of the same fact accumulate as separate lines competing for the budget until a consolidation round.

External agent-memory systems (e.g. engraphis) address this class with provenance, bi-temporal supersession, and pinned facts. The railhead takes the ideas without the dependency: it stays plain files and deterministic parsers (ADR 0004), and the agent does not call a memory tool (ADR 0012's rejected option remains rejected).

## Decision

1. **Operator pin.** A learnings line starting with `! ` (`PIN_MARKER`) is pinned. `evictOldestToFit` never evicts a pinned line; consolidation never receives one — `mergeLearnings` filters pins out of the prompt and re-adds them verbatim around the model's output. Pinning is a hand edit to `.railhead/learnings.md`; workers do not emit pins (a model claiming importance every run would pin noise).
2. **Pins count against the budget.** The 2,200-char cap still bounds the injected context. An over-limit pinned line is never tail-sliced; if the pins alone exceed the cap, newly appended unpinned facts cannot fit and are evicted. That is the operator's explicit cost, not a railhead failure.
3. **Retraction still wins.** `RETRACTED:` removes a pinned line like any other. Pinning guards against *silent* loss (budget eviction, consolidation), not against a worker that directly falsified the fact — the false-capability-claim class ADR 0013 fixed must remain retractable. Un-pinning is one hand edit.
4. **Provenance.** Facts persisted by `pushLearnings`/`mineFailureLearning` get a trailing `<!-- learned: <phaseLabel> -->` comment naming the phase that produced them, so the ledger transcript can be located. `renderLearnings` strips it before any prompt injection — audit metadata, not context. Re-pushing a fact refreshes its provenance.
5. **Deterministic supersession.** Fact identity normalizes away punctuation, backticks, and provenance. A new fact that duplicates an existing unpinned line replaces it (moving to the end with the new provenance); a duplicate of a pinned line is dropped, keeping the pin in place. This is the deterministic half; *contradictions* (not duplicates) remain the worker's `RETRACTED:` + `LEARNED:` pair.
6. **One renderer.** `renderLearnings` is the single injectable form: pins first, marked `- [pinned] fact`, provenance stripped. All six prompt sites (reviewer ×2, builder, visual, goal reviewer, feature-step derivation) use it, so metadata cannot leak into a prompt through one un-updated call site.

## Considered Options

- **Agent-written memory via a memory server/MCP tool** (the engraphis approach): richer recall, but reverses ADR 0001/0012's railhead-orchestrates split, adds a runtime dependency and a nondeterministic retrieval layer to a system whose judging context is deliberately O(ticket). Rejected.
- **Embedding/vector recall over learnings instead of whole-file injection**: the file is capped at ~2,200 chars (~800 tokens); retrieval machinery would cost more than the whole file. Rejected.
- **Model-judged importance** (the worker pins what it thinks matters): pins must be rare and trustworthy; a model pinning its own claims every phase defeats the purpose. Rejected; pinning is an operator action.
- **Refuse retraction of pinned lines**: preserves the operator's assertion but lets a proven-false fact poison every later prompt — the exact failure ADR 0013 fixed. Rejected in favour of decision 3.

## Consequences

- `evictOldestToFit`'s contract changes: it evicts the oldest *unpinned* line; a single over-limit pinned line is kept intact rather than tail-sliced. Existing no-pin behavior is byte-identical.
- Consolidation gets a smaller prompt (pins excluded) and its output is deduped against the pins, then budgeted.
- `readLearnings` returns the file verbatim (pins and provenance included) — consumers that inject its result must go through `renderLearnings`. The six sites now do.
- `.railhead/learnings.md` becomes meaningfully hand-editable: prefix `! ` to pin, delete the line to unpin, ignore the provenance comments.
- The digest keeps its own aging rule: it is a rolling log by design (ADR 0018) and gets no pins here.
