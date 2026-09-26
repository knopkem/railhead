# src/core — foundation

The run/ticket data model, its durable persistence, and the bare host adapters. Nothing here spawns a phase; `src/execute/` owns that. Everything imports this directory.

## Seams

- `state.ts` — `RunState`/`TicketState`, `createRunState`, `frontier` (the first ready ticket in order), `isFinished`. The persisted model.
- `ledger.ts` — `.railhead/run-*` mechanics: `initLedger`, `writeState`/`readState`, `appendEvent`, `extractAssistantText`, `extractPlanText`. Append-only JSONL plus `state.json`; this is the resume source.
- `ticket.ts` — the on-disk ticket format and its ordered numbering: `parseTicket`, `renderTicket`, `loadTickets`, `numberTickets`, `titleSlug`, and the criterion probe-line helpers (`criterionBehavior`, `criterionProbe`, `withProbe`). Array order IS execution order.
- `contracts.ts` — `railhead.contracts.json` index: load/save/merge/slice/verify. This is the O(ticket) context seam (ADR 0008).
- `probes.ts` — the persistent probe registry (ADR 0043 amendment): `registerProbes`, `probesForGroup`, `materializeProbeScripts`, `runRegisteredProbes`. A probe is a command + expected predicate; entries persist in `state.probes`, scripts under `.railhead/probes/`.
- `recovery.ts` — pure resume logic: `planRecovery`, `reconcileCommittedButUnsaved`, `rebaseFrontier`.
- `product.ts` — the product arc (`docs/product.md`, ADR 0051): `parseProductPlan`/`renderProductPlan` round-trip, `firstOpenStep`, `renderProductBrief`, `setStepStatus` (machine-readable marker lines only; prose survives byte-for-byte; boundaries are fence-aware).
- `fences.ts` — fence-aware text primitives. Every `$MARKER`/regex parser must use these, never raw `indexOf`.
- `git.ts`, `models.ts`, `project-assets.ts`, `permissions.ts`, `provider-config.ts` — process-boundary adapters (git CLI, opencode model registry, scaffolded project assets, resolved-config provider timeout scan).
- `halt.ts`, `blocked.ts`, `checkpoint.ts`, `pending-checkpoints.ts` — marker/file grammars shared by execute and gates. `checkpoint.ts` normalizes zero-padding (`ticket=1` matches `01`) and accepts a marker that trails prose on its last line.

## Invariants

- The ticket parser and the planner prompt are coupled (ADR 0007): change `ticket.ts` and `src/plan/` together. A ticket carries no dependency or file-reference fields — order is the emitted array order.
- A corrupt JSONL line is guarded at the edge — parsers degrade, never throw mid-ledger.
- `state`/`ledger`/`telemetry`/`ticket` form one intentional import cycle; keep it inside this directory.
- Marker text lives in exactly one place here; other modules import it rather than re-declaring regexes.
