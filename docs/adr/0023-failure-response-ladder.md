# Failure-response ladder: escalate, don't predict

## Context

Two mechanisms classified execution failures and predicted a response:

1. `TRANSIENT_PATTERNS` string matching — a denylist over provider error prose. `insufficient memory: …GPU memory` matched nothing, so a deterministic GPU OOM fell through to "transient" and was retried identically five times (pixeledit-night-1, 06:56 → 07:31).
2. Zero-output detection — a symptom (no tokens) shared by rate limits, OOMs, crashes, and network blips, each needing a different response. Three incident-shaped patches accumulated (`executor.test.ts` documents the 7-empty-commits, bare `step_start`, and degenerate 1/1-token-stop shapes).

Both mechanisms tried to classify once, up front, from unreliable evidence, and got the OOM wrong in a way that cost hours. No portable health endpoint exists across llama.cpp / LM Studio / vLLM, so the railhead cannot probe the server — the only signals are the event stream, exit code, and token counts.

## Decision

**Invert classify-then-respond into respond-and-learn.** Every execution failure enters a three-rung ladder; each rung is both an intervention and a probe, so being wrong costs one cheap step instead of hours:

| Rung | Intervention | Fixes | Proves if it fails |
|------|-------------|-------|--------------------|
| 1 | backoff + identical retry | rate limits, 5xx, blips, degenerate one-off responses | not a blip |
| 2 | restart the persistent worker + retry | server crash, poisoned KV cache (#77), OOM-with-shed-caches | failure is request-inherent |
| 3 | diagnose and fail | — | terminal: capacity or hard failure |

> Amended by ADR 0033 (#110): for the **implement** path, rung 3's `diagnosed`
> verdict now runs one deep-diagnosis phase before going terminal. That phase's
> `$PLAN` — if produced — feeds exactly one final implementer attempt; a missing
> plan (or a failed diagnosis) falls through to the terminal rung unchanged. The
> other terminal classes (fatal-config, capacity) still short-circuit with no
> diagnosis call, and ADR 0003 (stop-not-skip) is untouched.

Two **structural** evidence gates short-circuit the ladder (never prose denylists):

- **Fatal-fast list** — `invalid api key`, `authentication`, `model not found` route straight to hard-fail with zero retries. This list errs toward *stopping* on config errors (the inverse-safety of the old transient list, which erred toward retrying).
- **Capacity route** — `peakTokens ≥ 90%` of the request ceiling (#81), **or** capacity wording (`insufficient memory`, `GPU memory`, `memory pressure`, `context too long`, `ContextOverflowError`) as a secondary signal. Fails the *phase* and re-implements with a shrink-scope instruction, because an OOM needs a smaller request, not a restarted server.

`TRANSIENT_PATTERNS` survives as an annotation (a hint that tunes rung-1 backoff), never as the decider. Zero-output detection survives as one input to the failure record, not the classifier.

## Consequences

- The implementer path returns structured `FailureEvidence` (not a thrown string); all phases run through `withFailureLadder` / `withFailureLadderOnThrow` in `failure-ladder.ts`. `withInfraRetry` is deleted.
- When `persistent_worker: false`, rung 2 degrades to a longer backoff (there is no railhead worker to restart; the fault is in the external server).
- A capacity failure feeds the next attempt a shrink-scope instruction and drops the handoff/prior-diff/attempt-history (prompt weight the failing context cannot afford). A second consecutive capacity failure marks the ticket `capacity_limited` — distinct from a code-quality failure in the report.
- The reached rung (`ladder_rung`) and failure class (`last_failure_class`) are persisted on the ticket, so a resume re-enters at the same rung instead of replaying rung 1 forever on a deterministic failure.
- `report.md` gains a "Failure ladder" section (per-ticket class + rung, and a run-end capacity-failure count).

What is explicitly rejected: adding more OOM wordings to `TRANSIENT_PATTERNS`, smarter zero-output variants, probing the server for health, and unbounded retry with different interventions (three rungs, hard-bounded, persisted across resume).

This decision supplies the response machinery that #76 (OOM misclassified as transient) and #77 (KV cache never reset) route through, and enforces the ceiling #81 re-grounds.
