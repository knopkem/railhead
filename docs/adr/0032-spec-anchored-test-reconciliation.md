# Spec-anchored test reconciliation

Issue #105. The human plan origin prompt (`origin.json`'s `prompt`) is the only
artifact no model phase in a run authored, so when verify fails on a file a
phase itself wrote, a fresh arbiter reconciles that file against the spec —
once per ticket per run — and the railhead applies whatever it decides
mechanically.

## Context

In run-20260909-1501 (spriteforge-lane-c, ticket 03), the durable-session
builder wrote both the implementation and `src/model/history.test.ts`, whose
undo/redo walk compared the k-th `undo()` result to `chain[k]` when undo
returns the document current *before* that push (`chain[k-1]`). Every step
reported `deep mismatch` no matter how correct `History`/`document.ts` were,
and the terminal `undo() → null` was logged as a failure, so the test could
never pass even with fixed indexing. The phase burned two attempts and the full
80-step budget: the builder rewrote the same test four times to near-identical
content, reverted it via `git checkout`, and degenerated into scratchpad
`node -e` re-implementations of a `History` class. No production change could
satisfy the test.

The failure class is structural, not a builder bug. The same weak model writes
tests under TDD, and an independent test author reading the same plan AC can
misread it identically. The real gap is that a failing test authored by the
implementing context is a **non-oracle**: the session that wrote it is exactly
the context that cannot see its own error, and its first instinct ("fix the
impl", then "rewrite my own test") is self-approval, not diagnosis.

## Decision

The railhead inserts a bounded reconciliation between a red verify and the retry
machine, gated on the one signal that attributes authorship: the failure output
naming a file the current phase's working diff changed.

1. **Attribution is mechanical and technology-agnostic.** `authoredPathsInFailure`
   intersects path tokens in the compressed verify output with the paths of the
   uncommitted working diff (the current ticket's authored set in both the
   classic and durable-session paths). It never decides what a "test file" is —
   the failure output itself names the files. Only when this intersection is
   non-empty does anything reconcile or re-word.
2. **The arbiter's only ground truth is the human spec.** A fresh opencode
   subprocess (never `--session`, `guardMode: "kill"`, capped at 25 steps) is
   handed the origin `prompt` verbatim plus the failing output, the attributed
   files, and the diff. The ticket's title and acceptance criteria ride along
   explicitly labeled as a model paraphrase that may itself be wrong. The
   prompt states the failure shape outright: *the implementation may be correct
   and the test wrong* — an off-by-one in a walk loop, a terminal sentinel
   asserted as a failure, a fixture disagreement. It is the incident's 27B fix
   reframed: decent at a *specifically flagged* off-by-one when handed the spec,
   hopeless free-grinding against its own assumption.
3. **The arbiter emits; the railhead applies.** The reply carries exactly one
   `$RECONCILE_IMPL` / `$RECONCILE_TEST` / `$RECONCILE_INCONCLUSIVE` verdict,
   numbered findings, and — only under `$RECONCILE_TEST` — one `=== FILE ===`
   block per corrected file, terminating in `$RECONCILE_END`. The railhead
   parses lossily (the `readBlockedBy`/`extractContractsBlock` family), writes
   only edits whose path is inside the attribution set, and never writes a
   truncated block. The fix is mechanically perimetred, logged, and diffable in
   one stroke.
4. **One shot per ticket per run, persisted.** `TicketState.reconcile` records
   the verdict/findings/applied set through `writeState`, so a resume never
   re-spends it. A `$RECONCILE_TEST` correction that greens a re-verify ends
   the round as an ordinary green verify — gate counters untouched, one commit
   records the whole ticket, ADR 0006 holds (verify is green at the commit).
   Any other outcome takes the ordinary retry path with the arbiter's findings
   prepended to the feedback; the one-shot flag is spent either way.
5. **Blame-aware feedback rides every retry.** Whenever the failure names an
   authored file — whether the reconciliation ran, ruled, or failed to parse —
   the retry feedback opens with a preamble naming those files as candidates
   for a *test* bug and pointing at the spec, not the session's own assumption,
   as the arbiter. In the durable-builder path this flows through the same
   `GateFeedback` re-injection (item 6).
6. **The recorded exception to ADR 0022.** Corrections normally land *in
   context*: the session that wrote the code receives the verdict so findings
   never cross a context boundary. Reconciliation is the deliberate exception —
   the session that wrote the test is exactly the context that cannot see its
   error, so the spec goes to a fresh context instead; its ruling then rides
   back into the session as ordinary findings feedback.
7. **The residual grind is capped.** The executor already kills on
   `spinLoopThreshold` consecutive identical *errored* tool calls. It now also
   tracks near-identical full-file rewrites of one path (whitespace-insensitive,
   per-path streak, reset only by real progress — a materially different write
   or a first write to a different path; bash/read never resets, so the
   `git checkout`-then-rewrite-verbatim loop still trips). At 3 such rewrites
   the phase is killed with the existing `spin_loop` status and a
   `non-convergent edit loop` message. Retry semantics are deliberately
   unchanged (ADR 0023 — a retry is a probe): reconciliation lands its
   correction at the first verify failure, before this cap would ever matter;
   the cap only bounds the residual.
8. **Product-mode prompts stop pre-listing the queue.** The durable builder's
   "Work to do" used to enumerate every remaining ticket before the first was
   checkpointed — the structural invitation to "announce" a checkpoint in prose
   and jump ahead (the same run's 03 phase wrote 04's first file). Under product
   granularity the railhead now surfaces the current ticket only, states that
   tickets arrive one at a time after each green checkpoint, and keeps the
   marker-mismatch reconcile as the backstop. `ticket`/`group` prompts are
   byte-identical to before.

## Why the spec, not the AC

Plan acceptance criteria are themselves model paraphrases and can be wrong too
(the incident's bug was a bookkeeping error, not a misreading of an AC). The
one artifact the model cannot re-derive from its own head is the human origin
prompt, persisted verbatim by `writePlanOrigin` — so that is what the arbiter
rules against.

## Non-goals

An independent TDD test-author phase for product mode (issue remedy 2) is a
run-shape change that needs its own head-to-head; the issue itself says it is
not a fix on its own. An assertion-level do-not-weaken diff is an open design
question — the railhead-applied reconcile edits are logged and diffable, which
is the cheap half. The edit-loop verdict deliberately reuses `spin_loop`: the
message prefix routes it, and a new failure-ladder class is not earned by the
incident.

## Consequences

- An unsatisfiable model-authored test now ends at the first verify failure
  with a spec-grounded correction or a loudly-attributed ruling, instead of
  burning the step budget across near-silent attempts.
- The reconciliation is bounded by design (one subprocess, 25 steps, one shot
  per ticket) and perimetred to files the phase itself authored — an arbiter
  can never edit implementation it did not write this phase.
- Every verify-failure retry tells the model which of its own files the failure
  blames and points at the spec as the arbiter, breaking the self-approval loop
  in both the classic and durable-builder paths.
