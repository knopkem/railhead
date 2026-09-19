# Replay gates a stopped run left owed

A ticket is marked committed before its post-commit work runs: the pipelined
per-ticket visual review (#35) and the group checkpoint gates (goal /
structural). That ordering is deliberate — an interrupt must never lose a
finished ticket (ADR 0016) — but it opens a window. Stop between the commit and
a gate's completion and resume sees the ticket committed, picks the next one,
and the gate is never heard from again: checkpoint detection only inspects the
ticket that just committed, and the visual review's promise is process-local.
The gap is not theoretical: any hard kill (OOM, SIGKILL, terminal close) can
land there, and with `goal_review.mode: full/medium` or group builder
granularity it silently skips corrective work.

> Amended by ADR 0046: the per-ticket visual review is serialized inside
> `committedTicket`; the marker/replay mechanism below is unchanged, and now
> covers only a crash mid-review rather than a cross-ticket overlap.

## Decision

### 1. Persist what is owed, before the gate runs

Two run-state fields, written to the ledger like any other state:

- `visual_pending: string | null` — the committed ticket whose per-ticket
  visual review was kicked off but not joined. Set by
  `kickoffPerTicketVisualReview` and persisted immediately by `committedTicket`;
  cleared by `joinPendingVisualReview`.
- `pending_checkpoints: { goal: string[]; structural: string[] }` — group
  checkpoint gates due but not returned. Recorded in the same state write that
  marks the completing ticket committed (`markGroupCheckpointsOwed`), and again
  by the checkpoint wrappers (`goalReviewAtCheckpoint`,
  `structuralReviewAtCheckpoint`) right before the review agent is spawned;
  cleared right after it returns. The early mark matters because the wrappers
  run only after the pipelined visual join — potentially many minutes later.
  Goal and structural keep separate sets, mirroring their separate review
  records (#107-C2).

The markers are the intent; the gates' own records (`goal_reviews`,
`structural_reviews`) remain the authoritative completion signal.

### 2. Replay at run-loop entry

`drainOwedGates` runs at the start of every `runLoopInner`, after signal
handlers are installed and before the frontier is consulted, so no ticket
stacks on a foundation a gate has not cleared (ADR 0006). Order mirrors the
ticket boundary: the visual join first (its [BLOCKER]s generate corrective
tickets processed inline), then structural, then goal (cheap-first fail-fast,
gh #107-C2).

- A pending group is **run** when its gate still fires mid-run and its record
  is absent.
- It is **dropped** when the gate recorded it (a crash between record and
  clear) or the gate can no longer fire (mode/model changed since the stop —
  the same live-config semantics every resume has).
- The visual marker is dropped when its ticket is no longer committed or the
  gate no longer applies; otherwise the review is re-run through the ordinary
  kickoff + join, so corrective handling is byte-identical to the pipeline's.

A replay's corrective failure stops the run like any gate failure; the caller
applies the ordinary status, with the halt file winning as usual.

### 3. A corrective's pipelined review is joined before the outer kickoff

The join above exposed a sibling hole: a corrective ticket committed while
joining ticket N's visual review kicks off its own review, which ticket N+1's
kickoff assignment then overwrote — the corrective's review promise was lost
with no record. `committedTicket` now joins any pending review left by the
join before kicking off the current ticket's.

## Consequences

- A stop or crash at any point resumes without skipping a gate. A review that
  was in flight when the process died may re-run — the safe direction.
- Every ticket commit writes the state once more (the marker set) and each
  checkpoint gate writes twice (set, clear) around an already-expensive model
  call; the cost is negligible next to the gate.
- State normalization (`normalizeState`) fills both fields for older runs, so
  pre-existing ledgers resume unchanged.
