# Serialize the per-ticket visual review

Amends the pipelining introduced for ADR 0011 (issue #35); enforces ADR 0022's
sequential-interleaving contract. ADR 0021's cadence dispatch is unchanged.

## Context

ADR 0011 added the per-ticket visual review, and issue #35 made it pipelined:
`committedTicket` kicked the review off asynchronously and the next ticket's
commit joined it, so ticket N's visual pass overlapped with ticket N+1's
implement.

Two later decisions invalidated that shape:

- ADR 0022 settled the single-server contract: *gates never run concurrently
  with the builder — sequential interleaving is the single-server contract.*
  The target deployment is one context-limited server; a browser-driving visual
  phase running alongside the builder competes for the same KV pool. The
  pipelining predates the contract and was carried forward by ADR 0021 without
  being re-tested against it.
- The reviewer runs in the live `state.cwd` (`visual-loop.ts`). Overlapped with
  the next implement, it can build, launch, and screenshot a half-edited tree:
  a false pass (N+1 already changed the behaviour), an inconclusive, or
  phantom blockers that spawn corrective tickets against a state that never
  existed at any commit.

## Decision

Run the per-ticket visual review post-commit but synchronously: inside
`committedTicket`, kick it off, persist the owed marker, and join it before
the ticket returns. A `[BLOCKER]`'s corrective tickets commit within the same
boundary. Delete the cross-ticket pending join, the corrective-drain loop, the
goal browser-collision special case, and the run-end final join — all were
scaffolding for the overlap. The owed marker and its resume replay (ADR 0038)
stay: they cover a crash mid-review, not an overlap.

The order inside `committedTicket` becomes: commit → per-ticket visual →
structural checkpoint → goal checkpoint → contracts. Structural and goal
checkpoint gates already ran synchronously and need no change; deleting the
pending-visual serialization there removes a case that can no longer occur.

## Consequences

- The per-ticket visual wall time is back on the critical path. The gate fires
  only under `visual_review.mode: "full"` (opt-in), so the cost lands on the
  runs that ask for per-ticket runtime verification.
- The reviewer always judges the committed worktree; ADR 0006's "green at
  every committed step" now holds for runtime, not merely by the next commit.
- ADR 0037's stop semantics are unchanged in behaviour — the boundary already
  included the per-ticket visual review; the review is now what holds the
  boundary rather than a drain loop at the stop.
- ADR 0011's rationale for the gate and ADR 0021's cadence tables are
  unaffected; only the overlap is removed.
