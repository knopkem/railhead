# Replan ticket numbering is globalized before it reaches the frontier

Recorded after the platformer run (run-20260918-1154). A plan-defect block
triggered an auto-replan; the replan regenerated 15 tickets, and the run
stopped immediately after the first of them committed. The stop was silent —
status `stopped`, no stop reason, no failed gate.

## Context

`orderTickets` numbers a ticket array LOCALLY: with a 15-ticket replan they
become `01-…`, `02-…`, and each ticket's `blocked_by` is mapped to those local
file names. `replanFromCheckpoint` then renumbers the ordered tickets into the
run's global range (`23-…`, `24-…`) for state and the files it writes — but it
did not remap `blocked_by`. So ticket 24's edge read
`01-camera-renderer-sprite-manifest-placeholder-atlas.md` while the file in
state and on disk was `23-camera-…`.

`frontier()` treats a `blocked_by` entry as satisfied only when a committed
ticket carries that exact file name. No ticket can ever be ready with an edge
naming a file that does not exist, so after ticket 23 committed the frontier
was empty, `nextRunStatus` returned `stopped`, and `railhead overview` showed
8/22 committed with no explanation. The written ticket files carried the same
local numbering in their header (`# 02:` inside `24-…md`) and blocked_by line,
so even after a state-only repair the builder would read a mis-numbered ticket.

## Decision

### 1. Globalize at the replan boundary

`globalizeReplanTickets(ordered, startNumber)` is the pure seam: it renumbers
`number`/`file` and remaps every `blocked_by` through the local→global map
(deduped). `replanFromCheckpoint` uses the globalized set for BOTH the state
tickets and the rendered ticket files, so the two can never disagree.

### 2. Repair stale references on resume

`repairBlockedByReferences(state)` runs at every run-loop entry (fresh or
resume): for each `blocked_by` entry that is not a known ticket file, it
resolves by unique slug match (`camera-…` → the one `NN-camera-….md`) and
rewrites the edge; an entry matching no ticket — or several — is left in place
and reported, never guessed. `runLoopInner` persists the repair, rewrites the
affected ticket files from the repaired state (header + blocked_by line), and
logs each remap. The run then continues instead of deadlocking.

The repair is deliberately conservative: it only rewrites what it can resolve
uniquely. A genuinely unknown blocker still stops the run, now with a log line
naming the ticket and the entry.

## Non-goals

- Not renumbering committed history.
- Not dropping unknown blockers (a missing prerequisite must stay visible).
- Not changing `orderTickets`' local numbering — the globalizer is the
  boundary adapter.

## Consequences

- Replan dependency chains survive renumbering; the frontier is processable in
  order (pinned by an integration test that replans into a two-ticket chain
  and asserts both commit with the global edge).
- A run stopped by the old bug resumes: the repair remaps the edges and
  rewrites the mis-numbered ticket files at loop entry.
- Unknown or ambiguous blockers are surfaced in the log instead of stalling
  silently.
