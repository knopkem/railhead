# Agent-driver seam: opencode first, pi as a second driver chosen by measurement

## Context

The railhead drives `opencode` as its only agent runtime (ADR 0001, amended by
ADR 0020 for the persistent worker and ADR 0022 for the durable session). A
proposal to prefer `pi` (`earendil-works/pi`) for local models rests on one
claim: pi's system prompt is smaller, so it leaves more of a small model's
context window for the ticket. This ADR records the measurement that settles
that claim and the seam that lets a second driver exist at all.

`codebase-design.md` already states the governing rule: *"One adapter means a
hypothetical seam. Two adapters means a real one."* Today there is one adapter
and deliberately no seam. The claim, if true, is what turns that hypothetical
seam into a real one.

## Measurement (2026-09-11)

Baseline input tokens for a trivial prompt (`reply with just: ok`) in an empty
directory, so the count is the driver's system prompt + tool schemas and nothing
else. Both drivers pointed at the same local model,
`llama-cpp/qwen3.8-27b-noreason` (openode 1.18.27, pi 0.84.4):

| Driver | Cold baseline | Warm re-invoke | Notes |
|---|---|---|---|
| opencode | ~12.7k | `input 4`, `cache.read ~12.7k` | total stable across three runs (12,735 / 12,745 / 13,509) |
| pi | ~2.8k | `input ~0.5k` | first call 2,825; warm re-runs report only the non-cached tail |

The premise is **true**: pi's cold system prompt + tools are ~9.9k tokens
(~4.5x) smaller than opencode's. On ADR 0014's 64k working budget that is ~15%
of the window reclaimed per phase, permanently — the driver prefix is resident
in every phase's context and pushes the model down the ts-vs-fill gradient.

The cold/warm split is the point, not noise, and it keeps the win honest:

1. **Cache reads soften the wall-clock cost, not the context-budget cost.**
   opencode's 12.7k prefix is served from the model server's content-keyed KV
   cache after warm-up (`cache.read ~12.7k`, `input 4`) — the same mechanism
   ADR 0020's telemetry found. So pi's advantage is not "fewer tokens computed
   per phase" (a warm cache makes both near-free). It is "fewer tokens
   permanently occupying the window" — the variable ADR 0014 optimizes. The
   single-shot ratio is noisy (`~4.5x` cold, `~26x` if you mistake a warm pi
   read for its cold size); the defensible number is the ~9.9k cold delta.
2. **The railhead's own prefix is driver-identical.** AGENTS.md + CONTEXT.md +
   the contracts slice + learnings sit on top of whichever driver runs. pi
   removes only the driver's share; the railhead's share is the same either way.

## Decision

Introduce an **`AgentDriver` seam** with `opencode` as the first adapter and
`pi` as a second. `opencode` remains the default driver for now, because pi has
no allow/ask/deny permission policy (see below) and the parity work is not yet
done. The seam owns exactly the five things that vary across drivers:

1. **Invocation** — binary + argument builder (`opencode run --format json
   --model …` vs `pi --print --mode json --provider … --model …`).
2. **Event stream → normalized `PhaseEvent` model.** Both already emit parseable
   JSONL: opencode emits `step_start`/`step_finish`/`tool_use`/`text`/
   `reasoning`/`error`/`sessionID`; pi's `--mode json` emits `session`/
   `message_start`/`message_update`/`message_end`/`turn_end`/`agent_end` with a
   `usage { input, output, cacheRead, reasoning }` object. Every guard and
   telemetry module (executor, token-meter, telemetry, live, transcript, ledger,
   evidence) consumes the normalized model, not raw lines.
3. **Model registry + capability probe** — `opencode models --verbose` /
   `debug config` vs `pi --list-models`. Both expose id, context limit, and
   reasoning/vision/attachment capability.
4. **Permission policy** — opencode's `opencode.json` allow/ask/deny plus the
   `permissions.ts` auto-reject detector. pi has only `--approve` (trust
   project-local files), no path/command permission enforcement; its README
   states this explicitly. A pi run must therefore default to sandboxed /
   containerized mode until a policy layer exists — this is a **safety
   regression to be designed for, not papered over**.
5. **Session / worker** — opencode's `--session` (ADR 0022) and `serve`/
   `--attach` (ADR 0020) map to pi's `--session`/`--session-id`/`--continue`/
   `--resume`/`--fork`; pi has no `serve`/`--attach` equivalent, so the
   persistent worker is opencode-only and must degrade.

## What is explicitly unchanged

- **opencode is still the default.** No existing run changes behavior; the
  first adapter must reproduce today's `executeOpendCode` output bit-for-bit
  (per codebase-design, the seam is proven with one adapter before a second is
  added).
- **ADR 0001's fresh-context property, ADR 0006's green-every-step, and
  ADR 0014's minimize-working-context target all stand.** A driver change is a
  means to ADR 0014's end, not a new end.
- **No language-specific knowledge.** The seam speaks of "the driver binary,"
  "the registry," "the permission policy" — never a vendor's config file name
  inside prompts or ticket logic.

## Consequences

- `src/execute/executor.ts`, `src/core/models.ts`, `src/config/config.ts` grow a driver seam; the
  riskiest parsers move behind it first (normalized `PhaseEvent` is Phase 1).
- A `driver` key in `railhead.json` (`"opencode"` | `"pi"`, default `"opencode"`).
- The measurement lives on as `scripts/measure-driver-overhead.mts`, re-run
  when either CLI changes version.
- pi's permission gap is a named open risk; it must be closed (sandbox,
  containerization, or a policy shim) before `pi` is a safe default for
  unattended runs.
