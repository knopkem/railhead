# 08: `driver` config key + selection + pi safety surfacing

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Expose the driver as a first-class `railhead.json` key, route every phase and probe through the resolved driver, and — because pi has no permission policy — refuse to silently start an unattended pi run without the operator acknowledging the gap.

Mechanics, in dependency order:

1. In `src/config.ts`, add a `driver` key (`"opencode" | "pi"`, default `"opencode"`) with a `driverConfig` for pi's own needs: `pi.provider`, `pi.model`, `pi.thinking` (default `"off"`). Parse both in `parseConfig` with defaults, tolerating absence so existing `railhead.json` files are unchanged.

2. `src/driver.ts` — extend `resolveDriver` to take the resolved config (name + driverConfig) and build the correct adapter; `executeOpendCode` (and its callers) consult the *run's* resolved driver rather than defaulting to opencode. Thread the resolved driver through the run/plan/init entry points in `src/run.ts`, `src/planner.ts`, `src/cli.ts` (mirroring how the model seats are threaded today).

3. In `src/cli.ts` init, when `driver === "pi"` (or when a pi run is selected), probe the pi driver's `registry()`/`capabilities()` for the configured seats, exactly as the opencode init probes today. A pi seat whose model is not in pi's registry, or lacks tool calling, fails fast with an actionable message (pi's README requires the worker be verified for native tool calling and registered with its true served context window).

4. **Permission-gap surfacing.** Because `PiDriver.permissionPolicy === "none"`, an unattended (`-a`) run on `driver: "pi"` must either (a) refuse until the operator passes an explicit `--allow-no-permissions` flag or sets a config key acknowledging the gap, or (b) print a loud, non-skippable warning and require confirmation. Choose the fail-closed option: refuse in `-a` mode without the acknowledgment; the acknowledgment is persisted so `railhead resume` does not re-prompt. This is the safety regression ADR 0034 flagged — it must be a gate, not a log line.

5. Update `docs/adr/0034-agent-driver-seam.md` with a short "Config" section documenting the `driver` key, the pi sub-keys, and the fail-closed permission acknowledgment.

**Blocked by:** 07-pi-adapter

**Files to read/use:**
- `src/config.ts`
- `src/config.test.ts`
- `src/driver.ts`
- `src/cli.ts`
- `src/run.ts`
- `src/planner.ts`
- `docs/adr/0034-agent-driver-seam.md`

**Existing contracts to honor:**
- Default `driver: "opencode"` reproduces today's behavior exactly; no existing run changes
- `DEFAULT_MODEL` / model-seat resolution is unchanged for opencode
- The fail-closed permission gate must not fire for `opencode` (its policy is `allow-ask-deny`)

**Expected new contracts:**
- `driver` + `driverConfig` (pi `provider`/`model`/`thinking`) in `src/config.ts`
- `resolveDriver(resolvedConfig)` builds the adapter from config
- A fail-closed permission acknowledgment for `driver: "pi"` in unattended mode

**Testable:** yes

**Status:** ready-for-agent

- [ ] `driver: "opencode"` (and an absent key) resolve to `OpenCodeDriver` with behavior identical to today; existing `config.test.ts` / `cli.test.ts` green
- [ ] `driver: "pi"` resolves to `PiDriver` carrying `provider`/`model`/`thinking` from `driverConfig`
- [ ] `railhead init` probes through the pi registry when `driver === "pi"`, and fails fast with an actionable message when a seat is absent from the registry or lacks tool calling
- [ ] an unattended (`-a`) pi run without the permission acknowledgment refuses with a clear message; with the acknowledgment (or in attended mode with confirmation) it proceeds; `railhead resume` does not re-prompt
- [ ] the permission gate never fires for `opencode`
- [ ] ADR 0034 gains a Config section documenting the key, the pi sub-keys, and the fail-closed acknowledgment
- [ ] `npm test` and `npm run typecheck` are green at the end of this ticket
