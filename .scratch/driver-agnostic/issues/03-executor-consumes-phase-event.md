# 03: Executor consumes `PhaseEvent`

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Rewrite `executeOpendCode`'s inline stream parsing onto the `PhaseEvent` model from ticket 02, so the executor no longer reaches into raw opencode JSON by string shape. This is the "prove the seam with one adapter" step: `ExecResult` and `ExecStatus` are byte-for-byte identical, the ledger still archives the raw line verbatim, and every guard (peak/in-flight token meter, step budget, stall, model-time, spin, degraded-target, edit-loop, stop-marker, halt) keeps its exact behavior — only the *parse* changes. All existing `executor.test.ts` cases pass unchanged.

Mechanics, in dependency order:

1. In `src/executor.ts`, replace the individual helpers `inputTokensOf`, `outputTokensOf`, `stepFinishReasonOf`, `isTerminalToolUse`, `isToolRunning`, `toolExecMsOf`, `textEventTimestamp`, `isStepFinish`, `parseTimestamp`, `toolErrorSignature`, `writePayloadOf`, `extractErrorMessage`, `toolUseErrorTextOf`, `sessionIdOf`, `assistantTextOf` with reads off `parseOpenCodeLine(line)`. Keep the `endsWithOwnLineMarker` / `endsWithCheckpoint` / `COMPLETE_VERDICT_RE` text-accumulation logic as-is — it operates on accumulated assistant text, which the `text` variant now supplies.

2. Preserve the raw-archive invariant: `appendEvent(ledgerDir, phaseFile, line)` still receives the **raw** line (before/independent of normalization), and stderr lines still go to `<phaseFile>.stderr` untouched. The `PhaseEvent` is the *analysis* view, never the stored one.

3. Keep the non-parse control flow byte-identical: `lineBuffer` splitting, `armStallTimer`, all kill guards, the `sessionId`/`checkpointTicket`/`haltReason` capture, and the final `finalStatus`/`finalError` composition must not move. Only `if (line.includes('"step_start"'))`-style string tests become `event.type === "step_start"`.

4. Delete the now-unused per-shape helpers (or move them into `src/phase-event.ts` if ticket 02 did not already) so `src/executor.ts` has one parser entry point. `describeExecFailure` and the `ExecOptions`/`ExecResult` types are untouched.

**Blocked by:** 02-phase-event-model

**Files to read/use:**
- `src/executor.ts`
- `src/phase-event.ts`
- `src/executor.test.ts`
- `docs/adr/0034-agent-driver-seam.md`

**Existing contracts to honor:**
- `ExecResult` and `ExecStatus` are unchanged (no new status, no field addition/removal)
- The raw JSONL ledger format is unchanged (`appendEvent` gets the raw line)
- Every kill guard's trigger condition and message string is unchanged

**Expected new contracts:**
- `executeOpendCode` depends on `parseOpenCodeLine` from `src/phase-event.ts` and no longer parses raw event JSON inline

**Testable:** yes

**Status:** ready-for-agent

- [ ] `executeOpendCode` reads every event through `parseOpenCodeLine`; no `line.includes('"step_start"')`-style string dispatch remains in the event-analysis path (string tests may remain only for the raw-line archive and the live renderer's own parse)
- [ ] peak tokens, in-flight estimate, drift, output tokens, generation ms, `toolCalls`, `steps`, `sessionId`, `checkpointTicket`, and `haltReason` match the pre-refactor values on a captured opencode JSONL fixture
- [ ] each kill guard (stall, model-time, step budget, spin loop, degraded-target, edit-loop, stop-marker early exit, halt, token ceiling) still fires on the same fixture lines and yields the same `ExecStatus` + `errorMessage`
- [ ] the raw ledger archive and `<phaseFile>.stderr` sidecar are byte-identical to before
- [ ] `executor.test.ts` passes with no test rewritten for behavior (only any mock-shape plumbing needed by the parser)
- [ ] `npm test` and `npm run typecheck` are green at the end of this ticket
