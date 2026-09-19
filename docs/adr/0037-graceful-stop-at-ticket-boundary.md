# Graceful stop: Ctrl-C finishes the ticket's gate

A run lasts hours. Stopping it should not throw away the phase in flight, and
resuming should continue where it left off. Until now Ctrl-C was an immediate
kill: the active `opencode` child died mid-phase, recovery preserved the
worktree as a `(checkpoint)` commit, and the ticket re-ran its whole gate.
Work already generated — a nearly-finished implement, a review about to land —
was paid for again.

## Context

The Railhead commits a ticket only after its gate passes (ADR 0006). A ticket
boundary is therefore the one point where an interruption costs nothing: the
commit is durable, the gate is complete, and the frontier's next ticket is the
correct resume point. Stopping anywhere else means *something* must be re-run
(a phase in fresh mode, a gate in builder mode).

The signal path has two handlers: the run loop's `SIGINT` handler
(`installSignalHandlers`) and the executor's global handler that kills the
active child and persistent worker (`ensureSigintKillsChild`, registered on the
first child spawn). The executor handler exists so plan/init/diagnose (which
have no run loop) never orphan a subprocess.

## Decision

### 1. Ctrl-C is a two-stage request

- **First press — soft stop.** A module-level flag is armed (`src/execute/stop.ts`);
  nothing is killed. The run loop honors it at the next ticket boundary: the
  ticket in flight finishes implement → verify → smoke → review → commit →
  checkpoint gates, and only then does the run stop.
- **Second press — hard stop.** The pre-existing behavior: kill the active
  child and the persistent worker, write `status: "stopped"`, exit 130. The
  escape hatch when a phase will not finish or the operator changes their mind
  about waiting.

While a run loop is active, the executor's global `SIGINT` handler defers to
the run loop's handler; `SIGTERM` is never deferred — memory pressure and
`kill` want the child gone now, not a gate wind-down. A request that arrives
while no run loop exists (between runs in one process) is cleared on the next
run-loop entry, so it cannot stop an unrelated run.

### 2. The boundary includes the pipelined visual review and the run-end block

The per-ticket visual review is kicked off asynchronously at commit (#35) and
joined at the next commit. A ticket boundary without that join would leave the
review's promise dropped. The soft stop therefore joins the pending per-ticket
visual review — including any review a corrective commit kicks off — before
stopping. At run end (all tickets committed), the request is honored *between*
the end-of-run passes rather than after them; a resume re-enters the block and
runs only the passes that did not complete.

### 3. The stop is recorded, not just a status

`state.stop_reason` names why the run stopped ("stop requested — 03 committed;
stopping before the next ticket") and is rendered in report.md, so a soft stop
is distinguishable from a crash in a later review of the ledger.

The engine is soft-stop-only by construction: with no request, nothing changes.
A hard press writes the same `stopped` status the old handler did, so
`shouldResume` and recovery behave exactly as before.

## Consequences

- A soft stop loses nothing: the current ticket is committed and gated; resume
  starts at the next ticket.
- A soft stop can take as long as the current ticket's gate (minutes, or hours
  for a stubborn retry loop). The second Ctrl-C is the documented escape.
- The stop protocol is deliberately not a `.railhead/STOP`-style file: the halt
  file is an agent-initiated honest stop with a human-acknowledgement gate
  (ADR: gh #111), while Ctrl-C is an operator signal whose whole point is that
  resume may proceed without ceremony.
