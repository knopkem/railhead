# 07: `pi` adapter

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Implement the `pi` driver (`PiDriver`) satisfying `AgentDriver`, so a run can execute phases through `pi` with the same normalized `PhaseEvent` stream and guards the opencode driver produces. This is the payoff for the seam: the ~9.9k/phase system-prompt saving measured in ADR 0034. The fresh-subprocess path (ADR 0001) is the scope; the durable-session builder's compaction semantics stay opencode-only for now.

pi's CLI surface (0.84.4, verified): `pi --print --mode json --provider <p> --model <id> --thinking <level> [--no-session] <prompt>` emits a JSONL stream (`session`, `agent_start`, `turn_start`, `message_start`, `message_update` with `assistantMessageEvent`, `message_end`, `turn_end`, `agent_end`, `agent_settled`) whose `message_end` carries `usage { input, output, cacheRead, reasoning, totalTokens }`. Model discovery is `pi --list-models` (a table: provider/model/context/max-out/thinking/images). Sessions exist (`--session`, `--session-id`, `--continue`, `--resume`, `--fork`); there is no `serve`/`--attach`, and no allow/ask/deny permission policy (only `--approve` trust).

Mechanics, in dependency order:

1. **Empirical event-shape fixture (first, before any mapping code).** Capture pi's JSON stream for a *tool-using* run against the local model (`llama-cpp/qwen3.8-27b-noreason`, a prompt that writes a file and runs a command) into `src/driver-pi.test.ts` fixtures. The message-based shape is *not* the step/tool shape the guards expect — this capture pins exactly how tool calls (`tool_use`) and their terminal `state.time`/`state.error`/input appear (the railhead's model-time, spin-loop, degraded-target, and edit-loop guards all read these). If pi's stream lacks a `state.time` window, the adapter synthesizes it from adjacent timestamps; document that synthesis in the ADR.

2. `src/driver-pi.ts` — `PiDriver.invoke`: argv builder `["--print", "--mode", "json", "--provider", <provider>, "--model", <model>, "--thinking", <thinkingLevel>, "--no-session", <prompt>]`, where `<provider>`/`<model>`/`<thinkingLevel>` come from the driver's own config (see ticket 08). Map `agent` → unsupported (pi has no subagents).

3. `src/driver-pi.ts` — `PiDriver.parseLine(line) → PhaseEvent | null`: normalize pi's `message_*`/`turn_*`/`session`/`error` events into the `PhaseEvent` union (ticket 02). A `message_end` with `usage` supplies `step_finish` tokens (input/output; `reason` from `stopReason`); text deltas accumulate to `text` events; tool events map to `tool_use` per the captured shape; the `session` id maps from pi's `session` event.

4. `src/driver-pi.ts` — `registry()` (parse `pi --list-models`), `capabilities(model)`, `defaultModel()` (pi's resolved default provider/model). `permissionPolicy = "none"`, `worker = "unsupported"`, `session = "supported"`.

5. `resolveDriver("pi")` returns `PiDriver`. No `executeOpendCode` or guard code changes — they consume the driver already.

**Blocked by:** 06-driver-model-registry

**Files to read/use:**
- `src/driver.ts`
- `src/phase-event.ts`
- `src/executor.ts`
- `docs/adr/0034-agent-driver-seam.md`
- `docs/research/siesta-comparison.md` (§1.2 `run_pi`/`build_args` — pi's one-positional-prompt rule and explicit `--thinking`)

**Existing contracts to honor:**
- `AgentDriver` interface exactly as ticket 05 defined it — no new method, no changed signature
- `PhaseEvent` union exactly as ticket 02 defined it — the pi adapter normalizes *into* it, it does not extend it
- siesta's lesson: pass body and directive as one positional prompt, and always pass an explicit `--thinking` (never inferred from the model name)

**Expected new contracts:**
- `PiDriver` adapter in `src/driver-pi.ts`
- `resolveDriver("pi")` returns it
- A documented mapping note in `docs/adr/0034-agent-driver-seam.md` for any synthesized field pi's stream lacks (e.g. tool `state.time`)

**Testable:** yes

**Status:** ready-for-agent

- [ ] a captured pi tool-using JSONL fixture normalizes to `PhaseEvent` with `step_finish` tokens matching `usage.input/output`, and terminal `tool_use` events carrying tool/input/status (unit-tested)
- [ ] `PiDriver.invoke` produces the exact argv (`--print --mode json --provider ... --model ... --thinking ... --no-session <prompt>`), unit-asserted on the args array
- [ ] `PiDriver.registry()` parses a captured `--list-models` table into `ModelEntry[]` (context/thinking/images columns mapped to the existing fields)
- [ ] `resolveDriver("pi")` returns the adapter; `permissionPolicy` is `"none"` and `worker` is `"unsupported"` on the returned driver
- [ ] the guards (token meter, step budget, stall, model-time, spin, degraded-target, edit-loop, stop-marker, halt) run unchanged over a normalized pi stream without touching driver-specific code
- [ ] `npm test` and `npm run typecheck` are green at the end of this ticket
