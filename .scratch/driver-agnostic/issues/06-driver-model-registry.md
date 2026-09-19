# 06: Driver-owned model registry + capability probe

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Move the opencode-specific model discovery in `src/models.ts` behind the `AgentDriver.registry()`/`capabilities()`/`defaultModel()` contract from ticket 05, and neutralize the one opencode bias in scoring. The pure, driver-agnostic functions (scoring, role assignment, the parameter-class heuristic) stay; the opencode CLI probes (`opencode models --verbose`, `opencode debug config`, `opencode run` availability) become the opencode adapter's implementation.

Mechanics, in dependency order:

1. In `src/models.ts`, split the opencode-specific *probe* functions from the pure *parse/score* functions. Keep pure and driver-agnostic: `parseModelList`/`parseModelEntry`/`findModelEntry`/`parseCapabilityInfo` (these parse an already-captured verbose string), `modelParameterClass`, `scoreModelForRole`, `assignFreeModels`, `isFree`, `contextScore`, `hasVision`. The opencode-probe functions — `fetchModelsVerbose`, `getDefaultModel`, `testModel`, `queryReasoningCapability`, `queryVisionCapability`, `queryFreeModels`, `createInitProber` — move behind the driver.

2. Implement `OpenCodeDriver.registry()` (runs `opencode models --verbose`, returns `parseModelList`), `OpenCodeDriver.capabilities(model)` (runs the verbose capture once and calls `parseCapabilityInfo`), and `OpenCodeDriver.defaultModel()` (runs `opencode debug config`, `parseDefaultModel`). Availability probing (`opencode run`) stays in the adapter too.

3. Neutralize the `providerID === "opencode"` `+5` scoring bias in `scoreModelForRole` — replace the hardcoded provider check with a driver-neutral signal (a `preferred: boolean` on `ModelEntry`, set by the driver, or drop the bias entirely and rely on the existing scoring terms). Pick one and document the choice in the ADR.

4. Wire the existing callers of the probe functions to go through `resolveDriver(...)` instead of calling `opencode` directly: `src/cli.ts` init probing (`createInitProber`/`fetchModelsVerbose`), free-model discovery (`queryFreeModels`), and the context-limit/reasoning/vision probes. The `init` path is the visible one — it must produce the same probes for `opencode`.

**Blocked by:** 05-agent-driver-seam

**Files to read/use:**
- `src/models.ts`
- `src/models.test.ts`
- `src/driver.ts`
- `src/cli.ts`
- `docs/adr/0015-model-tier-policy.md`
- `docs/adr/0034-agent-driver-seam.md`

**Existing contracts to honor:**
- `ModelEntry`, `CapabilityInfo`, `InitProbe`, `ModelRole` shapes are unchanged
- `parseCapabilityInfo` / `findModelEntry` keep their "unknown" (`found: false`) semantics for an unlisted model
- The pure parse/score functions remain pure (string/array in, value out) so their unit tests stand

**Expected new contracts:**
- `AgentDriver.registry()`, `AgentDriver.capabilities(model)`, `AgentDriver.defaultModel()` implemented by `OpenCodeDriver`
- A driver-neutral preference signal replacing the `providerID === "opencode"` bias

**Testable:** yes

**Status:** ready-for-agent

- [ ] `OpenCodeDriver.registry()` returns the same `ModelEntry[]` as the old `parseModelList(fetchModelsVerbose())` (unit-tested on a captured verbose fixture, no live CLI)
- [ ] `OpenCodeDriver.capabilities(model)` and `defaultModel()` reproduce the old probe results on fixtures
- [ ] no `opencode models --verbose` / `opencode debug config` / `opencode run` string lives outside `src/driver.ts` (the adapter) — grep on `src` confirms
- [ ] `scoreModelForRole` no longer references `providerID === "opencode"`; the chosen neutral signal is documented and unit-tested
- [ ] `railhead init` probes still return the same capabilities/availability for the opencode driver (existing `cli.test.ts` / `models.test.ts` green)
- [ ] `npm test` and `npm run typecheck` are green at the end of this ticket
