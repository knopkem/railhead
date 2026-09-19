# 04: Read-side parsers consume `PhaseEvent`

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Move the five remaining modules that independently parse opencode JSONL onto `parseOpenCodeLine` / the `PhaseEvent` model, so there is exactly one place in the codebase that understands a driver's raw stream shape (plus the driver adapter from ticket 05). Behavior and output are identical — these are pure read-side refactors with existing tests as the identity check.

Mechanics, in dependency order:

1. `src/token-meter.ts` — `streamedTokenCost(line)` reads `type: "text" | "reasoning"` and terminal `tool_use` events; switch it to consume a `PhaseEvent` (accept the event, not the line) and add a thin `line → event` call at the one call site in `src/executor.ts`. The token estimate formula is unchanged.

2. `src/telemetry.ts` — `analyzePhase` walks `step_start`/`tool_use`/`text`/`reasoning`/`step_finish` and `session.compacted`/`compaction_continue`. Re-read the archived file line-by-line and dispatch through `parseOpenCodeLine` for the covered types; keep the `session.compacted` and `compaction_continue` detection (these are opencode-only for now and stay as a raw-string check alongside the normalized dispatch, documented as a deliberate exception).

3. `src/live.ts` — `renderEventLine(line, ...)` switches on event type; change it to accept a pre-parsed `PhaseEvent` (or parse once via `parseOpenCodeLine`) with the same render output. The ANSI-banner strip behavior in `live.test.ts` must stay intact.

4. `src/ledger.ts` — `extractAssistantText` concatenates `text` parts and rejects `tool_use` "write" outside the working dir; switch its event walk to `parseOpenCodeLine` while keeping the write-rejection rule and the returned string identical.

5. `src/transcript.ts` — the full-transcript renderer switches on `step_start`/`text`/`tool_use`/`step_finish`; switch to the normalized model with identical output.

6. `src/evidence.ts` — extracts `tool_use` events for failure evidence; switch to the normalized model.

7. Leave `src/models.ts` (model-registry parsing) out of scope — that is ticket 06.

**Blocked by:** 02-phase-event-model

**Files to read/use:**
- `src/token-meter.ts`
- `src/telemetry.ts`
- `src/live.ts`
- `src/ledger.ts`
- `src/transcript.ts`
- `src/evidence.ts`
- `src/phase-event.ts`

**Existing contracts to honor:**
- Every function's public signature and return type is preserved where callers already depend on it (add a parse-at-the-edge where a function takes a raw line today)
- `extractAssistantText`'s write-rejection rule (path outside working dir → rejected) is unchanged
- `analyzePhase`'s `session.compacted` + `compaction_continue` counting is unchanged

**Expected new contracts:**
- One shared normalization entry point (`parseOpenCodeLine`) consumed by these modules; no module parses raw opencode JSON for `step_start`/`step_finish`/`tool_use`/`text`/`reasoning`/`error` anymore

**Testable:** yes

**Status:** ready-for-agent

- [ ] `streamedTokenCost` yields the same numbers on a captured opencode stream before and after (token-meter tests green)
- [ ] `analyzePhase` reports identical `compactions`/`peakInputTokens`/`finalInputTokens`/`totalInputTokens`/`totalOutputTokens`/`generationMs` on a real archived phase file (telemetry tests green)
- [ ] `renderEventLine` renders the same live lines, including the ANSI-banner null case (live tests green)
- [ ] `extractAssistantText` returns byte-identical text and still rejects the out-of-tree "write" (ledger tests green)
- [ ] the transcript renderer and evidence extraction produce identical output on a fixture (transcript/evidence tests green)
- [ ] `npm test` and `npm run typecheck` are green at the end of this ticket
