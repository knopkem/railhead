# src/core — foundation

The run/ticket data model, its durable persistence, and the bare host adapters. Nothing here spawns a phase; `src/execute/` owns that. Everything imports this directory.

## Seams

- `state.ts` — `RunState`/`TicketState`, `createRunState`, `frontier`, `isFinished`. The persisted model.
- `ledger.ts` — `.railhead/run-*` mechanics: `initLedger`, `writeState`/`readState`, `appendEvent`, `extractAssistantText`, `extractPlanText`. Append-only JSONL plus `state.json`; this is the resume source.
- `ticket.ts` — the on-disk ticket format: `parseTicket`, `renderTicket`, `loadTickets`, `readBlockedBy`.
- `ticket-dag.ts` — graph operations over tickets: `orderTickets`, `extendBlockedBy`, conflict scans, `Ruling`.
- `contracts.ts` — `railhead.contracts.json` index: load/save/merge/slice/verify. This is the O(ticket) context seam (ADR 0008).
- `recovery.ts` — pure resume logic: `planRecovery`, `reconcileCommittedButUnsaved`, `rebaseFrontier`.
- `fences.ts` — fence-aware text primitives. Every `$MARKER`/regex parser must use these, never raw `indexOf`.
- `git.ts`, `models.ts`, `project-assets.ts`, `permissions.ts` — process-boundary adapters (git CLI, opencode model registry, scaffolded project assets).
- `halt.ts`, `blocked.ts`, `checkpoint.ts`, `pending-checkpoints.ts` — marker/file grammars shared by execute and gates.

## Invariants

- The ticket parser and the planner prompt are coupled (ADR 0007): change `ticket.ts` and `src/plan/` together.
- A corrupt JSONL line is guarded at the edge — parsers degrade, never throw mid-ledger.
- `state`/`ledger`/`telemetry`/`ticket`/`ticket-dag` form one intentional import cycle; keep it inside this directory.
- Marker text lives in exactly one place here; other modules import it rather than re-declaring regexes.
