# src/config — configuration and CLI policy

`railhead.json` shape and defaults, command-line parsing, gate-cadence policy, and the project-interface vocabulary. This directory is a foundation: it imports nothing outside itself.

## Seams

- `config.ts` — `RailheadConfig`, `DEFAULT_CONFIG`, `loadConfig`/`updateConfig`, `resolveModels`, context-budget helpers. `DEFAULT_MODEL` is the sentinel for "opencode's own default"; a `null` seat means unset and falls back down the chain.
- `args.ts` — `parsePlanArgs`/`parseRunArgs`, presets and per-gate overrides.
- `run-policy.ts` — resolves and persists run decisions: `resolveGateModes`, `resolveTdd`, `resolveYolo`, `persistPolicy`. Persisted decisions are honored by `resume`/`run` without re-passing flags.
- `interface.ts` — `ProjectInterface` vocabulary and interaction guidance.
- `provider.ts` — the operator-declared provider surface (#134): `parseProviderConfig` (shape validation, throws on a typo), `resolveHealthUrl`, `evaluateHealthResponse` (pass rule over a JSON body). Pure; the network probe and restart tracking live in `src/execute/provider-health.ts`.

## Invariants

- `args.ts` and `config.ts` form an intentional cycle (`argValue` ↔ gate-mode parsing); keep it inside this directory.
- Gate-mode semantics (`firesMidRun`/`firesAtRunEnd`, preset tables, severity retry thresholds) are defined here once. `run-policy.ts` resolves them; no other module re-derives the tables.
- Presets and overrides are persisted into `railhead.json`; a policy change must stay resumable.
