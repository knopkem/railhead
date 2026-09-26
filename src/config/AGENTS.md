# src/config — configuration and CLI policy

`railhead.json` shape and defaults, command-line parsing, gate-cadence policy, and the project-interface vocabulary. This directory is a foundation: it imports nothing outside itself.

## Seams

- `config.ts` — `RailheadConfig`, `DEFAULT_CONFIG`, `loadConfig`/`updateConfig`, `resolveModels`, context-budget helpers. `DEFAULT_MODEL` is the sentinel for "opencode's own default"; a `null` seat means unset and falls back down the chain.
- `args.ts` — `parsePlanArgs`/`parseRunArgs`, presets and per-gate overrides.
- `run-policy.ts` — resolves and persists run decisions: `resolveGateModes`, `resolveYolo`, `persistPolicy`. Persisted decisions are honored by `resume`/`run` without re-passing flags.
- `interface.ts` — `ProjectInterface` vocabulary and interaction guidance.
- `provider.ts` — the operator-declared provider surface (#134): `parseProviderConfig` (shape validation, throws on a typo), `resolveHealthUrl`, `evaluateHealthResponse` (pass rule over a JSON body). Pure; the network probe and restart tracking live in `src/execute/provider-health.ts`.

## Invariants

- `args.ts` and `config.ts` form an intentional cycle (`argValue` ↔ gate-mode parsing); keep it inside this directory.
- Gate-mode semantics (`firesMidRun`/`firesAtRunEnd`, preset tables, severity retry thresholds) are defined here once. `run-policy.ts` resolves them; no other module re-derives the tables.
- The light preset is corrective-anchored (ADR 0029 amendment): `goalCheckpointActionFor("light")` is `"corrective"` and `goalFiresCheckpointsMidRun` fires light checkpoints. `interactionSmokeEnabled` derives the smoke default from the declared interface (`browser-ui`/`canvas`), never from planner seeding. Per-ticket code review is scheduled only by `code_review.mode: "full"` (the light/medium presets resolve to `"off"`); its reviewer inherits the project's ordinary toolset by default (`code_review.inherit_tools`, bypassing the tool-denied reviewer seats).
- Presets and overrides are persisted into `railhead.json`; a policy change must stay resumable.
