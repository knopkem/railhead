# src/execute — the run loop and its subprocesses

The engine: run orchestration, opencode subprocess lifecycle, verification, retries, and the durable-session builder.

## Seams

- `run.ts` — `startRun`, `runLoop`, `processTicket`, `assembleBranch`, `protectedPaths`. The orchestration hub; it imports from every other module group by design. The interaction smoke runs once per committed group boundary; a marker-less builder turn whose ticket was already verify-green counts as the checkpoint (marker stays primary).
- `executor.ts` — the ONLY phase runner: `executeOpendCode`, `executeFreshPhase`, streamed event parsing, persistent worker, stall/timeout kills, `describeExecFailure`. Fresh subprocess per judging phase keeps context O(ticket) (ADR 0001); the Builder is one durable session reused across checkpoints (ADR 0022/0047).
- `base-session.ts` — `ensureBaseSession`/`forkPhase`: the per-run base conversation (`[system][canonical preamble]`) every fresh phase forks (`--session <base> --fork`) so only its task message is sent into a shared, cacheable prefix (#133, ADR 0020 amendment). Fail-open: no base → `joinPhaseMessages` as before; a rejected fork retries fresh once. Rebuilt only when the preamble inputs change or the session is gone.
- `failure-ladder.ts` — `classifyFailure`, `withFailureLadder`: retry → worker restart → diagnosed failure, with the capacity shrink-scope path.
- `provider-health.ts` — the operator-declared provider probe (#134): `configureProvider`/`setProviderHealth` install it at run/plan start, every phase probes before spawning, an unhealthy verdict fast-fails as transient into the ladder instead of the stall guard. A fail→ok transition logs the cold-cache line (sessions persist; only the prefix cache is cold). Undeclared = no probe, today's behavior.
- `stop.ts` — Ctrl-C semantics (ADR 0037): soft stop finishes the in-flight ticket's gate, `hardStopRequested` kills now. Signal handling lives here only.
- `verify.ts` / `smoke.ts` — run the project's commands with timeouts; `output-compress.ts` compresses their output.
- `guard.ts`, `diff-filter.ts`, `token-meter.ts`, `contract-extract.ts`, `reconcile.ts`, `builder-loop.ts`, `builder-units.ts`, `vision-probe.ts` — permission guard, diff shaping, context metering, contract index update, spec reconcile, builder recovery/routing, measured vision probe.

## Invariants

- Only `executor.ts` spawns phase processes. `core/models.ts` may spawn `opencode` for the init availability probe — nowhere else.
- Guards are the contract for unattended runs: spin budget, stall timeout, step budget, degraded-target window. A new blocking loop here needs one of these.
- `run.ts` and the gate loops import `overview.ts` (`nowClock`) from `src/cli/`; that known layering wart is the price of a single clock.
