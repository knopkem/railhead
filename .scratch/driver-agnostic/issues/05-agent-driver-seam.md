# 05: `AgentDriver` seam + opencode adapter

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Introduce the `AgentDriver` interface and the opencode adapter that satisfies it, per ADR 0034. This makes the seam real while keeping opencode the only implemented driver — the deletion test from `codebase-design.md` ("prove the seam with one adapter before a second exists") is the acceptance bar. `executeOpendCode` becomes a thin consumer of the driver's invoke/stream path; nothing observable changes.

The interface owns the five things ADR 0034 says vary, scoped to what the fresh-subprocess path (ADR 0001) needs today:

- `invoke(prompt, opts) → { spawn: () => ChildProcess }` — the driver builds argv and spawns; the executor still streams raw lines to the ledger and normalizes via the driver's `parseLine`.
- `parseLine(line) → PhaseEvent | null` — the driver's stream normalizer (opencode's is `parseOpenCodeLine`).
- `registry() → Promise<ModelEntry[]>` and `capabilities(model)` / `defaultModel()` — declared here, implemented by ticket 06 (opencode) and ticket 07 (pi).
- `permissionPolicy: "allow-ask-deny" | "none"` and `session: "supported" | "unsupported"`, `worker: "supported" | "unsupported"` — capability flags so callers degrade rather than assume.
- `agent` and `session` are passed as opaque options the opencode adapter maps to `--agent`/`--session`; pi maps them (or reports unsupported) later.

Mechanics, in dependency order:

1. `src/driver.ts` — define the `AgentDriver` interface and an `OpenCodeDriver` object with `invoke` (argv builder: `run --format json [--model] [--agent] [--session] <prompt>`, exactly the current `base` array) and `parseLine = parseOpenCodeLine`. `permissionPolicy = "allow-ask-deny"`, `worker = "supported"` (until ticket 01's removal is reconciled — after 01 this becomes `"unsupported"`, so this ticket must land with `worker: "unsupported"`), `session = "supported"`, `agent`-aware.

2. `src/driver.ts` — a `resolveDriver(name: string): AgentDriver` function that currently accepts only `"opencode"` (throws a typed error on anything else) and an `activeDriver`/threading choice: keep the module-level handle pattern (`activeChildPid` already lives in executor) rather than passing the driver through every call site.

3. Refactor `src/executor.ts` so `executeOpendCode` obtains the driver (default `resolveDriver("opencode")`) and uses `driver.invoke` to build the spawn and `driver.parseLine` to normalize events (replacing the direct `parseOpenCodeLine` call from ticket 03). The `spawn("opencode", ...)` literal and the hardcoded `["run", "--format", "json"]` array move into the adapter.

4. Keep `killActiveChild`/SIGINT handling in `src/executor.ts` — process-group kill is driver-agnostic (it kills whatever pid was spawned).

**Blocked by:** 03-executor-consumes-phase-event

**Files to read/use:**
- `src/executor.ts`
- `src/phase-event.ts`
- `docs/adr/0034-agent-driver-seam.md`
- `docs/codebase-design.md`

**Existing contracts to honor:**
- `ExecResult`/`ExecStatus`/`ExecOptions` are unchanged; call sites of `executeOpendCode` are unchanged
- The raw JSONL ledger archive is unchanged
- ADR 0034's five "what varies" items are the interface's scope; nothing outside them is added to the seam

**Expected new contracts:**
- `AgentDriver` interface (`invoke`, `parseLine`, `registry`, `capabilities`, `defaultModel`, `permissionPolicy`, `session`, `worker`, `agent`)
- `OpenCodeDriver` adapter
- `resolveDriver(name: string): AgentDriver`

**Testable:** yes

**Status:** ready-for-agent

- [ ] `OpenCodeDriver.invoke` produces the exact argv `executeOpendCode` spawned before this ticket (unit-asserted on the args array)
- [ ] `executeOpendCode` uses `driver.invoke`/`driver.parseLine`; the literal `spawn("opencode", ...)` and the hardcoded `run --format json` array exist only inside `OpenCodeDriver`
- [ ] `resolveDriver("opencode")` returns the adapter; `resolveDriver("pi")` throws a typed error stating pi is not yet implemented; `resolveDriver("bogus")` throws
- [ ] every existing `executor.test.ts` case passes with the driver defaulting to opencode
- [ ] `npm test` and `npm run typecheck` are green at the end of this ticket
