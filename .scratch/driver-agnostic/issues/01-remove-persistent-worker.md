# 01: Remove the persistent worker (`opencode serve` / `--attach`)

**Mission:** Make the railhead driver-agnostic so `pi` can drive local models with a ~9.9k-token-smaller per-phase system prompt, while `opencode` stays the default.

**What to build:** Delete the persistent-worker path (ADR 0020) in full and restore the ADR 0001 baseline — one fresh subprocess per phase — as the only topology. ADR 0020 already walked its own benefit back: the cross-session KV reuse was measured at ~2k tokens (the system-prompt prefix and nothing more), the motivating premise ("the server's KV cache is worker-controlled") is wrong for content-keyed session-bank servers (vLLM prefix caches, MTPLX session bank), and the default was reverted to `false`. The worker buys ~2k tokens of prefix reuse while adding a long-lived process, an isolation tradeoff, and a `restartWorker` callback threaded through four modules. It is opencode-only (`pi` has no `serve`/`--attach`), so removing it now shrinks the surface the `AgentDriver` seam (ticket 05) must abstract.

Mechanics, in dependency order:

1. In `src/executor.ts`, remove `activeWorkerUrl`, `activeWorkerPid`, `startPersistentWorker`, `stopPersistentWorker`, `withPersistentWorker`, the `PersistentWorker` interface, `resetWorkerForTest`, and `setActiveWorkerUrlForTest`. Remove the `--attach` branch in `executeOpendCode` (the `base` args array reverts to always-standalone). Remove the `void stopPersistentWorker()` call from the SIGINT/SIGTERM handler in `ensureSigintKillsChild` — `killActiveChild()` is all that remains.

2. In `src/config.ts`, remove the `persistent_worker` field from the config type, its `DEFAULT_CONFIG` entry (`persistent_worker: false`), and its parse line in `parseConfig`. Delete the doc comment on the key.

3. Remove the `restartWorker` plumbing everywhere it is threaded: `src/run.ts` (the `restartWorker` callback built from `state.config.persistent_worker`, passed into the run loops, plus the `withPersistentWorker(...)` wrapper around the run body), `src/planner.ts` (`plannerRestart`, the `withPersistentWorker` wrappers around `runPlan` and `runSharpenSession`, and every `restartWorker` pass-through), `src/visual-loop.ts` and `src/contract-extract.ts` (their `restartWorker: state.config.persistent_worker === true ? ... : ...` callbacks become absent). The degraded-target recovery (`describeExecFailure` / `DEGRADED_TARGET_PREFIX`, ADR 0023 / #96) keeps its recovery note; only the worker-restart half is dropped.

4. Remove the `persistentWorker: config.persistent_worker === true` arguments from the `runPlan` / `runSharpenSession` call sites in `src/cli.ts`.

5. Update `docs/adr/0020-persistent-opencode-worker.md` with a **Superseded** note (one short paragraph) pointing to this ticket: the measured benefit was ~2k tokens, the KV premise was wrong for content-keyed caches, and the feature was removed to reduce the driver surface. ADR 0001 is the sole topology again.

**Blocked by:** None (can start immediately)

**Files to read/use:**
- `src/executor.ts`
- `src/config.ts`
- `src/run.ts`
- `src/planner.ts`
- `src/visual-loop.ts`
- `src/contract-extract.ts`
- `src/cli.ts`
- `docs/adr/0020-persistent-opencode-worker.md`

**Existing contracts to honor:**
- ADR 0001 — fresh subprocess per phase is the baseline and must be the only path after this ticket
- `ExecResult` / `ExecStatus` shapes are unchanged — this is pure deletion, no new status, no new field
- The degraded-target recovery note (`describeExecFailure`, #96) still fires; only `restartWorker` is removed

**Expected new contracts:**
- None (pure removal; the removed `PersistentWorker` interface and `persistent_worker` config key cease to exist)

**Testable:** yes

**Status:** ready-for-agent

- [ ] `executeOpendCode` never emits `--attach`; a spawned phase's argv is `["run", "--format", "json", <model>, <agent?>, <session?>, <prompt>]` with no worker URL in any branch
- [ ] `startPersistentWorker`, `stopPersistentWorker`, `withPersistentWorker`, `resetWorkerForTest`, `setActiveWorkerUrlForTest`, and the `PersistentWorker` interface are gone from `src/executor.ts` (grep returns nothing)
- [ ] `persistent_worker` is gone from `src/config.ts` (type, default, parse); a `railhead.json` carrying the key is accepted without error and the key is ignored
- [ ] no `restartWorker` reference remains in `src/run.ts`, `src/planner.ts`, `src/visual-loop.ts`, or `src/contract-extract.ts`
- [ ] the SIGINT/SIGTERM handler still kills the active child (and no longer references a worker)
- [ ] `docs/adr/0020-*.md` carries a Superseded note explaining the removal
- [ ] `npm test` and `npm run typecheck` are green; the existing `executor.test.ts` / `config.test.ts` / `run.test.ts` / `planner.test.ts` suites pass with the worker-specific tests removed (not skipped)
