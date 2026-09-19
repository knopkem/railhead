# 02: `PhaseEvent` normalized event model + opencode parser

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Introduce the normalized `PhaseEvent` model — the single lossy-parser boundary that both drivers' JSONL streams reduce to, per ADR 0034 ("what varies" item 2). This ticket creates the model and the opencode-side parser as a **pure module with unit tests**; no consumer is switched yet (tickets 03 and 04 do that). The model is the contract every guard and telemetry module will read instead of raw opencode `--format json` lines.

The normalized model covers exactly what the railhead's guards and readers consume today:

- `step_start` (timestamp)
- `step_finish` (timestamp, `tokens.input`, `tokens.output`, `reason`)
- `tool_use` (terminal only: `status: completed|error`, `tool`, `input`, `state.time.{start,end}`, `state.error`), plus an optional `running` flag for intermediate tool parts
- `text` (assistant text, timestamp), `reasoning` (timestamp)
- `error` (message)
- `session` (session id)

Mechanics, in dependency order:

1. `src/phase-event.ts` — define a discriminated union `PhaseEvent` with one variant per type above, each carrying only the fields consumers need (token counts as numbers, timestamps as numbers, `tool`/`input`/`state` as loosely-typed objects so the driver can stay shape-tolerant). Export `parsePhaseEventLine(line: string): PhaseEvent | null` — returns `null` on any non-JSON line or unknown type (never throws).

2. `src/phase-event.ts` — the opencode parser, `parseOpenCodeLine(line: string): PhaseEvent | null`, mapping today's event shapes to the union: `type: "step_finish"` → `step_finish` (reading `part.tokens.input/output`, `part.reason`); `type: "tool_use"` → `tool_use` (reading `part.state.status`, `part.tool`, `part.state.input`, `part.state.time`, `part.state.error`); `type: "text"`/`type: "reasoning"` → `text`/`reasoning` (reading `part.text` for text, `part.type`); `type: "error"` → `error` (reading `error.data.message ?? error.name`); top-level `sessionID` → a `session` field carried on every variant (or a dedicated `session` variant for the first event). `sessionID` is captured from the first event that carries one, mirroring `sessionIdOf` in `src/executor.ts`.

3. `src/phase-event.test.ts` — the lossy-parser regression suite: a real opencode `step_finish` line round-trips to the union with correct tokens; a `tool_use` with `state.time` maps its window; an `error` line maps its message; a mid-array garbage line, a truncated JSON line, a prose-wrapped line, and an empty line all return `null` without throwing; a line with an unknown `type` returns `null`.

**Blocked by:** None (can start immediately)

**Files to read/use:**
- `src/executor.ts` (the existing line-parsers: `inputTokensOf`, `outputTokensOf`, `stepFinishReasonOf`, `isTerminalToolUse`, `isToolRunning`, `toolExecMsOf`, `textEventTimestamp`, `sessionIdOf`, `assistantTextOf`, `toolErrorSignature`, `writePayloadOf`, `extractErrorMessage`, `toolUseErrorTextOf`)
- `src/token-meter.ts`
- `src/telemetry.ts`
- `src/ledger.ts`
- `docs/adr/0034-agent-driver-seam.md`

**Existing contracts to honor:**
- The `PhaseEvent` union must be a superset of what the consumers read; it must not change any consumer's semantics (tickets 03/04 prove identity by keeping `npm test` green)
- opencode event field paths, exactly as documented in `src/executor.ts` (e.g. `part.tokens.input`, `part.state.time`, `part.state.error`)
- ADR 0034's "what varies" item 2 — this is the normalized model named there

**Expected new contracts:**
- `PhaseEvent` union
- `parsePhaseEventLine(line: string): PhaseEvent | null`
- `parseOpenCodeLine(line: string): PhaseEvent | null`

**Testable:** yes

**Status:** ready-for-agent

- [ ] `PhaseEvent` has one variant per type (`step_start`, `step_finish`, `tool_use`, `text`, `reasoning`, `error`, `session`) with only the fields consumers read
- [ ] `parseOpenCodeLine` maps a real `step_finish` line to `{ input, output, reason }` exactly; a terminal `tool_use` line to `{ status, tool, input, time, error }`; a `text` line to its `part.text`; an `error` line to `error.data.message ?? error.name`
- [ ] a top-level `sessionID` on any line is surfaced as the `session` id (first-seen wins at the caller, matching `sessionIdOf`)
- [ ] malformed input (mid-array garbage, truncation, prose, empty, unknown `type`) returns `null` and never throws
- [ ] `parsePhaseEventLine` is a pure function of a string (no fs, no process, no state)
- [ ] every new function has its test beside it in `src/phase-event.test.ts`; `npm test` and `npm run typecheck` are green at the end of this ticket
