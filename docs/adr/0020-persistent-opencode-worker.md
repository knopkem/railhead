# Persistent opencode worker process

## Context

ADR 0001 chose `spawn("opencode", ["run", "--format", "json"], …)` per phase to
guarantee a fresh model context (protecting the small-context window of a
local model) and process isolation (a crash kills one ticket, not the
railhead). That decision reserved an escape hatch: *"The SDK stays as an escape
hatch if we later need typed streaming or a long-lived server."* ADR 0010
later reinforced the per-phase-subprocess choice for the sharpening interview.

The cost of that freshness is paid on every phase. `executeOpendCode`
(`src/execute/executor.ts`) is called 6–8 times per ticket (test, each implement
attempt, contracts, verify-failure summarization, learnings consolidation,
review, per-ticket visual, goal, structural). Each call re-pays:

1. Node process startup + opencode initialization (~2–5s).
2. System-prompt evaluation — AGENTS.md + CONTEXT.md + contracts slice +
   learnings, the stable prefix every phase re-reads. The token data from a
   real snake run showed `input=20,068` against `cache_read=108,232`: the
   prefix dominates cost, and with a warm server KV cache it is evaluated
   once and reused, not recomputed per phase.

## Decision

When `persistent_worker: true` is set in `railhead.json`, keep one
`opencode serve` process alive for the duration of the run (or plan session)
and have every `executeOpendCode` phase call `opencode run --attach <url>`
instead of spawning a standalone subprocess. The server's KV cache reuses the
system-prompt prefix across phases; each phase adds only its volatile suffix
(ticket body, diff, prior findings). Roughly halves wall-clock time on a
multi-ticket run with visual+goal review enabled, since phases that previously
serialized across distinct startup + prefix-evaluation costs now share them.

### The seam

`src/execute/executor.ts` holds a module-level `activeWorkerUrl` (mirroring the
existing `activeChildPid` pattern). `executeOpendCode` inserts `--attach <url>`
into the spawn args whenever a worker URL is set, and the bare standalone args
when it is not. No `executeOpendCode` call site changes — every one of the
11+ callers (run.ts, planner.ts, reviewer.ts) routes through the same
function and inherits the attach behavior transparently. The test mocks at
`src/run.test.ts:21` and `src/planner.test.ts:13` are unaffected.

`withPersistentWorker(persistentWorker, cwd, body)` is the lifecycle wrapper.
`runLoop`, `runPlan`, and `runSharpenSession` wrap their bodies in it; the
worker is started before the first phase and stopped in a `finally` — on
normal return, on throw, and on early exit. `stopPersistentWorker` SIGTERMs
the process group and resolves once the child has exited (escalating to
SIGKILL after a 5s grace).

### Fresh context per phase is preserved

`opencode run --attach <url>` does **not** carry over the prior phase's
conversation: each invocation starts a new session (no `--continue`/`--session`
flag is passed). The persistent server's process and KV cache are shared; the
conversational context is not. ADR 0001's "fresh context protects the ~100k
window" property holds — only the per-process startup cost and the
prompt-prefix evaluation are amortized.

### Graceful fallback

If `opencode serve` cannot start within 30s (e.g. the installed `opencode`
version predates the `serve` subcommand, or the local model server is
unreachable), `startPersistentWorker` returns `null` and the run continues in
standalone mode. Correctness is unaffected — only the performance benefit is
lost.

## Recovery

If the worker crashes mid-run, the run is affected: the next
`executeOpendCode` call will fail to attach (its `opencode run --attach`
exits non-zero). The railhead's existing infra-retry (`withInfraRetry` in
`src/infra.ts`) treats that as a transient error and retries — but the worker
process is gone. A future enhancement (not in scope for #39) would have
`startPersistentWorker` restart on a failed attach; for now, a worker crash
is a run-stopping condition, same as a model provider outage. Each ticket's
state is persisted in the Ledger + `state.json` (ADR 0016), so `railhead
resume` restarts the worker and picks up from the last committed ticket.

## Config

`persistent_worker: true` in `railhead.json`, defaulting to `false`. Existing
runs are unaffected (ADR 0001 baseline: a fresh subprocess per phase). The
knob is per-project because the speed-up is real but the isolation tradeoff
(reduced process isolation, a worker crash affects more than one phase) is
project-dependent — a stable local llama.cpp server benefits; a flaky remote
provider may not.

### Default stays `false` (2026-09-03, pixeledit-night-1 telemetry)

The default was briefly flipped to `true` (commit 122d4a2) and reverted.
Measured on a real 4-hour run: the cross-session KV reuse this ADR's speed-up
claim rests on was **~2k tokens** — the system-prompt prefix and nothing more
(`cache 2048` on every fresh-session step; sessions diverge immediately after
the shared prefix). The bulk of observed cache hits (40k+) are *intra*-phase,
present regardless of worker topology. Meanwhile the decision's motivating
premise — that the server's KV cache is worker-controlled — is wrong for
content-keyed session-bank servers (vLLM-style prefix caches, MTPLX's session
bank + SSD restore), which retain per-prefix KV independent of which client
process attaches. The worker therefore buys ~2k tokens of prefix reuse while
keeping its isolation costs, and adds one more long-lived process whose state
occupies memory during capacity incidents. Opt-in remains for projects that
measure a real process-startup amortization benefit; the KV claim should not
be the reason to enable it.

## Consequences

- One `opencode serve` process lives for the whole run/plan session, killed
  on exit (including Ctrl+C via `executor.ts`'s SIGINT handler, which now
  calls `stopPersistentWorker`).
- The KV cache reuse is opaque to `executeOpendCode`'s JSONL parsing — the
  event stream is identical on `--attach` as on standalone (verified: the
  `step_start` / `text` / `step_finish` events carry the same shape, and
  the `cache.read` field on `step_finish` shows the warm cache hit).
- Complementary to #35 (parallelize visual review): #35 parallelizes across
  phases, #39 reduces per-phase startup cost. Both roughly halve wall-clock,
  in independent dimensions.
- ADR 0001's escape hatch is now exercised. This ADR amends (does not
  supersede) ADR 0001: the default behavior is unchanged, and the
  fresh-context property holds in the persistent path via `--attach`'s
  per-call session isolation.
