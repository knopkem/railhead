import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendEvent } from "../core/ledger.ts";
import { renderEventLine } from "../cli/live.ts";
import { nowClock } from "../cli/overview.ts";
import { estimateTokens } from "./diff-filter.ts";
import { streamedTokenCost } from "./token-meter.ts";
import { CHECKPOINT_RE, endsWithCheckpoint, readCheckpointTicket } from "../core/checkpoint.ts";
import { endsWithBlockReport, parseBlockReport, type BlockReport } from "../core/blocked.ts";
import { DEFAULT_STALL_TIMEOUT_SEC, DEFAULT_MAX_STEP_MODEL_SEC, DEFAULT_MODEL } from "../config/config.ts";
import type { FailureEvidence } from "./failure-ladder.ts";
import type { FirstStepCache } from "../core/telemetry.ts";
import { haltReason } from "../core/halt.ts";
import { guardedEnv } from "./guard.ts";
import { hardStopRequested, requestAbort, runStopHandlerInstalled } from "./stop.ts";

export type ExecStatus = "ok" | "error" | "transient" | "budget_exceeded" | "timeout" | "spin_loop" | "degraded_target" | "halted";

/**
 * The PID of the currently-running opencode child process, or `null` when no
 * child is active. Tracked globally so a SIGINT handler can kill the detached
 * child's process group before the railhead exits — without this, Ctrl+C
 * during planning (where `installSignalHandlers` from run.ts is not registered)
 * orphans the opencode subprocess, which keeps running indefinitely.
 */
let activeChildPid: number | null = null;

/** Kill the active opencode child's process group. Called by the SIGINT
 * handler and by any cleanup path that needs to ensure no orphaned subprocess
 * survives. Safe to call when no child is active (no-op). */
export function killActiveChild(): void {
  if (activeChildPid === null) return;
  try {
    process.kill(-activeChildPid, "SIGTERM");
  } catch {
    // Process group may already be gone; the child itself may have exited.
  }
  activeChildPid = null;
}

/**
 * Issue #39: the URL of the persistent `opencode serve` worker, or `null`
 * when standalone mode is in effect (ADR 0001 baseline). When non-null,
 * `executeOpendCode` spawns `opencode run --attach <url>` instead of a fresh
 * standalone subprocess, reusing the warm server's KV cache across phases.
 * Set by `startPersistentWorker`; cleared by `stopPersistentWorker` (or
 * `resetWorkerForTest` in tests). Module-level by design — it is the seam
 * every `executeOpendCode` call site consults without each caller threading
 * it through. Mirrors `activeChildPid`'s singleton pattern.
 */
let activeWorkerUrl: string | null = null;

/** Test-only escape hatch: clear the worker URL between tests so a prior
 * test's worker doesn't leak into the next. Production code calls
 * `stopPersistentWorker` (which also kills the spawned `opencode serve`). */
export function resetWorkerForTest(): void {
  activeWorkerUrl = null;
}

/** Test-only setter for the worker URL — exercises `executeOpendCode`'s
 * `--attach` branch without spawning a real `opencode serve`. Production
 * code calls `startPersistentWorker`, which sets this after the server is up. */
export function setActiveWorkerUrlForTest(url: string | null): void {
  activeWorkerUrl = url;
}

/**
 * Issue #39: wrap a run/plan body so a persistent `opencode serve` worker is
 * alive for the body's duration and stopped afterward — including on throw and
 * on early return. When `persistentWorker` is false (the default), the body
 * runs with no worker (ADR 0001 baseline). When true, `startPersistentWorker`
 * is invoked; if it cannot bring the worker up (e.g. no `opencode serve`
 * support), the body proceeds in standalone mode (graceful fallback — the run
 * is correct, only slower). The worker URL is held on a module-level handle
 * (`activeWorkerUrl`) that `executeOpendCode` consults; no call site changes.
 */
export async function withPersistentWorker<T>(
  persistentWorker: boolean,
  cwd: string,
  body: () => Promise<T>,
): Promise<T> {
  if (!persistentWorker) return body();
  const worker = await startPersistentWorker({ cwd });
  try {
    return await body();
  } finally {
    await stopPersistentWorker();
    void worker;
  }
}

export interface PersistentWorker {
  /** The base URL of the running `opencode serve`, e.g. `http://127.0.0.1:4097`.
   * Threaded into every `executeOpendCode` phase via the module-level
   * `activeWorkerUrl`. */
  url: string;
  /** Stop the worker process. Safe to call when the worker already exited. */
  stop: () => Promise<void>;
}

/**
 * Issue #39: spawn a long-lived `opencode serve` process whose KV cache stays
 * warm across every `executeOpendCode` phase of the run/plan session. Each
 * phase then `--attach`es to this server instead of paying the full
 * subprocess startup + prompt-prefix-evaluation cost on every invocation.
 *
 * The server is bound to `127.0.0.1` on an ephemeral port (port 0 → OS
 * assigns). The URL is parsed from the server's "listening on" stderr line
 * (e.g. `opencode server listening on http://127.0.0.1:4097`), with a polling
 * fallback to probe `/` until the server is ready.
 *
 * Returns `{ url, stop }` — `stop` sends SIGTERM to the process group and
 * resolves once the child exits. Safe to call when `opencode serve` is
 * unavailable (returns null); the run continues in standalone mode.
 */
export async function startPersistentWorker(opts: { cwd: string; quiet?: boolean }): Promise<PersistentWorker | null> {
  // Already running — idempotent. A second start returns the existing handle;
  // the caller is responsible for not double-starting (the railhead calls
  // stopPersistentWorker before startPersistentWorker if reusing).
  if (activeWorkerUrl !== null) {
    return { url: activeWorkerUrl, stop: async () => { await stopPersistentWorker(); } };
  }

  const child = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: opts.cwd,
    env: guardedEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Parse "opencode server listening on http://127.0.0.1:PORT" from stderr.
  const url = await new Promise<string | null>((resolve) => {
    let buf = "";
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) { settled = true; resolve(v); }
    };
    const timer = setTimeout(() => {
      done(null);
    }, 30_000);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const m = buf.match(/listening on (https?:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        done(m[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => {
      clearTimeout(timer);
      done(null);
    });
  });

  if (url === null) {
    // Server didn't come up — fall back to standalone mode. Don't kill the
    // child if it's still trying (rare); let the detach + process exit clean up.
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    if (!opts.quiet) {
      console.log(`[${nowClock()}] persistent worker: opencode serve did not start within 30s — falling back to standalone subprocesses per phase`);
    }
    return null;
  }

  activeWorkerUrl = url;
  activeWorkerPid = child.pid ?? null;
  if (!opts.quiet) {
    console.log(`[${nowClock()}] persistent worker: opencode serve listening on ${url} (KV cache reused across phases)`);
  }

  return {
    url,
    stop: async () => { await stopPersistentWorker(); },
  };
}

/** PID of the persistent worker (when active). Tracked so `stopPersistentWorker`
 * and the SIGINT handler can kill the detached process group. */
let activeWorkerPid: number | null = null;

/**
 * Stop the persistent `opencode serve` worker (if any) and clear the module-
 * level URL so subsequent `executeOpendCode` calls revert to standalone mode.
 * Safe to call when no worker is active (no-op). Resolves once the child has
 * exited (or after a 5s grace period, escalating to SIGKILL if it survives).
 */
export async function stopPersistentWorker(): Promise<void> {
  const pid = activeWorkerPid;
  activeWorkerPid = null;
  activeWorkerUrl = null;
  if (pid === null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process group may already be gone.
    return;
  }
  // Grace: wait up to 5s for the server to exit on SIGTERM.
  await new Promise<void>((resolve) => {
    const grace = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, 5_000);
    try {
      // Reap: best-effort wait. If the process group is already gone, exit.
      process.kill(pid, 0);
      const poll = setInterval(() => {
        try {
          process.kill(pid, 0);
        } catch {
          clearInterval(poll);
          clearTimeout(grace);
          resolve();
        }
      }, 200);
    } catch {
      clearTimeout(grace);
      resolve();
    }
  });
}

// Register once: on SIGINT or SIGTERM, kill the active child and persistent
// worker before exiting. SIGINT covers Ctrl+C; SIGTERM covers macOS memory
// pressure and `kill` without a signal name. Without the SIGTERM handler, a
// force-terminated railhead orphans its `opencode serve` process, which keeps
// running indefinitely and holds a connection to the shared SQLite DB.
//
// While a run loop is active it installs its own SIGINT handler that turns the
// first Ctrl-C into a soft stop (finish the current ticket, then stop) and
// only kills on a second press — this global handler defers to it, or the
// immediate kill here would defeat the graceful stop. SIGTERM is never
// deferred: memory pressure and `kill` want the child gone now, not a gate
// wind-down; plan/init/diagnose (no run loop) keep the immediate SIGINT kill.
let sigintInstalled = false;
function ensureSigintKillsChild(): void {
  if (sigintInstalled) return;
  sigintInstalled = true;
  const handler = (signal: NodeJS.Signals) => {
    if (signal === "SIGINT" && runStopHandlerInstalled() && !hardStopRequested()) return;
    // The process is ending: mark the abort so an in-flight failure ladder
    // cannot log (or start) a retry while we tear down.
    requestAbort();
    killActiveChild();
    void stopPersistentWorker();
    setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 200);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

export interface ExecResult {
  status: ExecStatus;
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** Number of opencode steps completed (step_start events seen). */
  steps: number;
  /** Peak complete-context size seen across all step_finish events — input
   * plus cache-read and cache-write tokens, the full request the window must
   * hold. Issue #82: this is the finished-step truth — it only moves when a
   * step COMPLETES, so during a long step that thrashes toward an OOM it is
   * stale (it can underread the request actually being assembled by
   * multiples). The live number to watch is `inFlightTokens`. */
  peakTokens: number;
  /** Issue #82: the railhead's running estimate of the request currently
   * being assembled — the last reported step_finish complete context (or the
   * pre-flight prompt estimate before any step completed) plus the tokens of
   * every text/reasoning/tool event streamed since. Where `peakTokens` is
   * stale mid-step, this rises with the content that will form the next
   * request. On a kill it is the size the guard saw; on a normal finish it
   * converges to the last reported complete context. */
  inFlightTokens: number;
  /** Issue #82: at the last step_finish, the server's reported complete
   * context minus the railhead's pre-reconcile estimate of that request.
   * Non-zero is expected — the server counts template/KV terms the railhead
   * cannot see — and a systematically large magnitude is the signal for a
   * calibration factor. 0 when no step has reported context tokens yet. */
  estimateDriftTokens: number;
  /** Sum of output tokens across all step_finish events. */
  totalOutputTokens: number;
  /** Total DECODE time in ms — per step, the span from the first streamed
   * text/reasoning token to step_finish minus that step's tool-execution
   * time (so prefill and a slow `npm test` inside the step are both excluded).
   * Steps that stream nothing contribute nothing. */
  generationMs: number;
  /** Number of terminal tool calls the phase made (tool_use events with a
   * completed/error state). Issue #69: an implementer that made ZERO tool
   * calls produced no code — the run loop must not waste verify/smoke/review
   * on its empty diff. Absent in mocks (undefined = not instrumented). */
  toolCalls: number;
  /** The first error event message seen in the JSON stream, or null when no
   * error event was emitted. Captured so callers can decide whether the failure
   * is transient (rate-limit / 503) and should be retried. */
  errorMessage: string | null;
  /** Issue #80: the ladder's evidence, self-composed from the fields above so
   * the failure-response wrapper never re-derives it. Optional so existing
   * mocks and partial results stay valid; callers use `evidenceFromResult` to
   * build one when absent. Status strings are unchanged — a pure data
   * addition. */
  evidence?: FailureEvidence;
  /** Issue #84 (ADR 0022 S0.1): the durable opencode session this phase ran
   * under, captured from the JSON event stream's top-level `sessionID` (every
   * `opencode run --format json` event carries it). null when no event with a
   * session id was seen (pre-flight refusal, no model call, or an event shape
   * that predates the field). This is the handle the railhead persists so a
   * later invocation can resume the session with `--session <id>`. */
  sessionId?: string | null;
  /** Issue #84 (ADR 0022 S0.2): when the phase was stopped at a `$CHECKPOINT
   * ticket=NN` marker, the ticket number the marker named; null otherwise. The
   * run loop reconciles this against the ticket it asked for — a mismatch (or
   * an ok exit with no marker) means the builder stopped for a reason other
   * than a clean checkpoint. */
  checkpointTicket?: string | null;
  /** Issue #130: prompt-cache accounting of the phase's FIRST completed step.
   * `cached` is the prefix the provider restored from its prompt cache; `cold`
   * is the uncached prompt it had to prefill. A phase that shares a prefix
   * with an earlier one but reports `cached: 0` is a prompt-cache miss — the
   * first-step signal the snake run's report lacked (reviewer/goal first calls
   * re-prefilled 8–33k tokens at cache=0 while the builder resumed at
   * 26–81k). null when no step_finish reported token counts. */
  firstStepCache?: FirstStepCache | null;
  /** ADR 0040: when the phase was stopped at a terminal `$BLOCKED ticket=NN`
   * marker, the parsed report; null otherwise. A block is neither a checkpoint
   * nor a failure — the run loop routes it by kind. */
  block?: BlockReport | null;
  /** gh #111: the halt file's reason when the phase was stopped by an
   * agent-initiated halt (`.railhead/STOP`); null otherwise. Carried up so the
   * run loop records it without re-reading the file. */
  haltReason?: string | null;
}

export interface ExecOptions {
  cwd: string;
  ledgerDir: string;
  phaseFile: string;
  model: string | null;
  agent?: string | null;
  /** Issue #84 (ADR 0022 S0.1): the durable session to resume via
   * `opencode run --session <id>` — the builder's one session carried across
   * invocations. When set, the phase continues the named session instead of
   * starting fresh; sessions persist to disk and survive process death, so
   * freeing the process between checkpoints loses nothing. Absent = ADR 0001's
   * fresh session per phase. */
  session?: string | null;
  /** Issue #84 (ADR 0022 §5): how the request-ceiling kill guards behave.
   * `"kill"` (default) is the ADR 0014/#81/#82 regime — the railhead kills a
   * phase whose finished-step peak or streaming in-flight estimate crosses 95%
   * of `maxContextTokens`; gate phases stay on it. `"telemetry"` is the
   * durable-builder regime — those guards pass through as telemetry only
   * (peak/in-flight still tracked and surfaced), because opencode's compaction
   * owns fill management and a railhead kill would only race the compacter.
   * The #78 model-time floor (`maxStepModelSec`) is NOT relaxed by this flag:
   * it stays the builder's thrash health check. */
  guardMode?: "kill" | "telemetry";
  /** Render a live, human-readable progress stream to the railhead stderr.
   * When false, only the heartbeat (elapsed/step/peak summary) prints. */
  live?: boolean;
  /** When true AND `live`, also render `reasoning` and `text` events (the
   * model's thinking and output prose). Default: tool calls + step markers
   * + errors only — the model's *actions*, not its words. The full text is
   * always in the ledger for `railhead log` later. Independent of `live`,
   * `verbose` also echoes the exact prompt being sent (the audit hook). */
  verbose?: boolean;
  /** Print a periodic heartbeat even when not `live`, so a long run shows work. */
  heartbeat?: boolean;
  /** Seconds between heartbeat lines. */
  heartbeatIntervalSec?: number;
  /** Short prefix for live lines (e.g. "implement", "review"). */
  livePrefix?: string;
  /** Optional sink for live lines (defaults to process.stderr). */
  liveSink?: (line: string) => void;
  /**
   * Hard cap on the number of opencode step_start events before the railhead
   * kills the subprocess. Guards against models stuck in infinite tool loops
   * ACROSS steps. `null` or `0` = no cap.
   */
  maxSteps?: number | null;
  /**
   * Kill the subprocess if no stdout/stderr output arrives for this many
   * seconds — guards against a stall WITHIN a single step (one tool call
   * that never returns: a bash command waiting on stdin, a dev server
   * started by mistake that never exits). `maxSteps` cannot catch this: step
   * count never advances while stuck inside one step, so a step-count budget
   * alone leaves an unattended run stalled forever with nothing watching it.
   * The clock resets on every byte of output, so a slow-but-progressing
   * phase (many steps, or one step streaming output) is never penalized —
   * only silence is. `null` or `0` = no stall detection.
   */
  stallTimeoutSec?: number | null;
  /**
   * Issue #78: per-step ceiling on MODEL time — wall clock of the current
   * step minus its tool-execution time. Kills the subprocess once a single
   * step has spent this many seconds neither executing a tool (a `running`
   * tool part, or tool wall later attributed from a terminal event's
   * `state.time`) nor completing a part: a model server that is alive but
   * thrashing (0 tok/s) emits nothing, so the silence stall timer — one hour,
   * sized to tolerate any legitimate silent stretch — never fires on it. This
   * is the blast-radius bound, not a classifier; a wrong kill costs a
   * resumable retry, an undetected thrash costs hours. `null` or `0` =
   * disabled. Default `DEFAULT_MAX_STEP_MODEL_SEC` (3600s).
   */
  maxStepModelSec?: number | null;
  /** Hard cap on the model's context-window size in tokens (ADR 0014). The
   * railhead pre-flights the initial prompt against this cap (50% threshold —
   * leaving room for model output + tool I/O) and kills mid-run if the
   * finished-step `peakTokens` OR the streaming in-flight estimate (#82)
   * exceeds 95% of it. `null` or `0` = no token-budget guard. */
  maxContextTokens?: number | null;
  /** Kill the subprocess after this many consecutive identical errored tool
   * calls — a model stuck in a retry loop (same tool, same input, same error)
   * produces output so the stall timer never fires, but makes no progress.
   * `null` or `0` = disabled. Default 3. */
  spinLoopThreshold?: number | null;
  /**
   * Issue #96: the degraded-target guard. Kill the subprocess once this many
   * TIMEOUT-class errored tool calls have occurred within a rolling
   * `toolTimeoutWindowSec` window, REGARDLESS of tool name or input — the
   * shape the consecutive-identical spin guard (`spinLoopThreshold`) misses,
   * because a wedged tool target (a browser/app/MCP server that has stopped
   * answering) times out every ~60s call and the failing calls alternate
   * tool/input so no two signatures are ever equal. A timeout-class error is
   * the tool server's own request ceiling ("Request timed out after 60000ms"),
   * so each failed call emits output and re-arms the silence stall timer while
   * making no progress — this windowed kill is what bounds the spiral the way
   * a step budget cannot (a ~60s-timeout step makes 500 steps ≈ 8 hours).
   * Windowed (not consecutive, and NOT reset by a successful call in between):
   * a wedged target typically answers one call eventually (a fresh-tab retry)
   * before wedging again, which would defeat a strict-streak counter. `null`
   * or `0` = disabled. Defaults `DEFAULT_TOOL_TIMEOUT_LIMIT` /
   * `DEFAULT_TOOL_TIMEOUT_WINDOW_SEC`.
   */
  maxToolTimeouts?: number | null;
  /** The rolling window (seconds) over which `maxToolTimeouts` counts
   * timeout-class tool failures. `null`/`0`/absent = `DEFAULT_TOOL_TIMEOUT_WINDOW_SEC`. */
  toolTimeoutWindowSec?: number | null;
  /**
   * Issue #96: absolute wall-clock ceiling on the WHOLE phase, regardless of
   * output — unlike `stallTimeoutSec`, which re-arms on every byte and only
   * catches silence. Bounds "hours per phase" when a phase is slow-but-loud:
   * every step succeeds yet the round crawls (a degraded tool target that
   * answers after 300s instead of 60s never trips the burst guard above).
   * Visual review rounds pass this; other phases leave it unset (disabled).
   * `null` or `0` = no cap.
   */
  phaseWallSec?: number | null;
  /**
   * Issue #60: when true, the executor watches the accumulated assistant text
   * for a COMPLETE verdict block (`$VISUAL_PASS`/`$VISUAL_FAIL` ... `$END`)
   * and SIGTERMs the child at the NEXT step_start. Visual reviewers that emit
   * their verdict and then keep being re-called loop forever, re-emitting
   * "$VISUAL_PASS ... I'm done" until the step budget kills them — the verdict
   * is usually LOST (budget_exceeded → inconclusive). Stopping at the first
   * complete verdict preserves the transcript (learnings included) and reports
   * status "ok" so the verdict is parsed and honoured. The kill happens at the
   * step boundary so the current step's full text is archived first.
   */
  stopAfterVerdict?: boolean;
  /**
   * A custom stop marker (e.g. ADR 0022's `$CHECKPOINT ticket=NN` for the
   * session builder, #84) that gets the identical boundary-kill `stopAfterVerdict`
   * gives verdict blocks: the #60 failure shape — a model re-invoked after its
   * terminal signal, re-emitting it until the step budget eats the run — applies
   * to ANY stop marker, not just visual verdicts. When both this and
   * `stopAfterVerdict` are given, this marker wins.
   *
   * Issue #84 (ADR 0022 S0.2): pass the checkpoint marker (`CHECKPOINT_RE` from
   * checkpoint.ts) to stop at the builder's `$CHECKPOINT ticket=NN` line with
   * status "ok"; when the transcript carries a checkpoint line,
   * `result.checkpointTicket` reports which ticket the marker named.
   *
   * Unlike `stopAfterVerdict`, this seat arms the boundary kill only on a
   * TERMINAL emission — the marker as the model's last line — so a model that
   * merely quotes the marker format in prose does not get killed at the next
   * step boundary. See `endsWithCheckpoint` in checkpoint.ts.
   */
  stopAfterMarker?: RegExp | null;
  /** ADR 0040: also watch for the builder's terminal `$BLOCKED` marker and
   * stop the child at the next step boundary, surfacing the parsed report on
   * `result.block`. The durable builder turns this on alongside
   * `stopAfterMarker: CHECKPOINT_RE`. */
  stopAfterBlocked?: boolean;
}

const DEFAULT_MAX_STEPS = 50;
const DEFAULT_SPIN_LOOP_THRESHOLD = 3;
/** Issue #96: the degraded-target guard's defaults. The window is ten minutes —
 * long enough that a legitimately flaky-but-recovering phase (an occasional
 * tool timeout is NOT a wedge) never accumulates to the limit, short enough
 * that a genuinely wedged target (timeouts every ~60s) hits the limit after
 * roughly five minutes of spiral instead of the reported 13+. The reported
 * incident ran 38 timeout steps in 13 minutes; five in ten minutes fires long
 * before that. */
export const DEFAULT_TOOL_TIMEOUT_LIMIT = 5;
export const DEFAULT_TOOL_TIMEOUT_WINDOW_SEC = 600;
/** The errorMessage/describeExecFailure prefix for a degraded-target kill, so
 * callers (the visual loop's retry-with-recovery-note, #96) can tell a wedged
 * interaction target from a generic incomplete — same pattern as the
 * `model-stalled:` prefix for #78. */
export const DEGRADED_TARGET_PREFIX = "degraded-target:";
/** gh #105: near-identical rewrites of one path that trip the non-convergent
 * edit loop. Same blast-radius job as the errored-call spin loop — the
 * incident's grind was successful-but-identical REWRITES (a test file written
 * four times to near-identical content with a `git checkout` revert between),
 * which the errored-call detector never sees. */
export const EDIT_LOOP_THRESHOLD = 3;
/** The fraction of maxContextTokens reserved for model output + tool I/O;
 * the pre-flight estimate must not exceed this fraction of the budget. */
export const PROMPT_BUDGET_RATIO = 0.5;

/**
 * Run `opencode run --format json` in a fresh process, streaming the raw
 * JSON event lines into the ledger verbatim. When `live` is set, also renders
 * a concise progress stream to the given sink (default: railhead stderr), so a
 * long-running plan/implement shows that work is happening.
 *
 * A fresh subprocess per phase exists to keep context O(ticket), not
 * O(project) — each phase starts with a clean model context, fed only by the
 * railhead's per-ticket prompt.
 *
 * Issue #39: when a persistent `opencode serve` worker is active
 * (`startPersistentWorker` was called and set `activeWorkerUrl`), this same
 * function spawns `opencode run --attach <url>` instead of a standalone
 * subprocess. The warm server's KV cache reuses the system-prompt prefix
 * (AGENTS.md + CONTEXT.md + contracts) across phases, eliminating the
 * per-phase startup cost while preserving the fresh-context property (each
 * `--attach` call is a new session, not a `--continue`).
 */
export async function executeOpendCode(
  prompt: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const {
    cwd,
    ledgerDir,
    phaseFile,
    model,
    agent,
    session,
    live,
    verbose = false,
    heartbeat = false,
    heartbeatIntervalSec = 15,
    livePrefix,
    liveSink,
    maxSteps = DEFAULT_MAX_STEPS,
    stallTimeoutSec = DEFAULT_STALL_TIMEOUT_SEC,
    maxStepModelSec = DEFAULT_MAX_STEP_MODEL_SEC,
    maxContextTokens,
    guardMode = "kill",
    spinLoopThreshold = DEFAULT_SPIN_LOOP_THRESHOLD,
    maxToolTimeouts = DEFAULT_TOOL_TIMEOUT_LIMIT,
    toolTimeoutWindowSec = DEFAULT_TOOL_TIMEOUT_WINDOW_SEC,
    phaseWallSec = null,
    stopAfterVerdict = false,
    stopAfterMarker = null,
    stopAfterBlocked = false,
  } = options;
  // A custom marker (checkpoint contract, #84) takes precedence over the
  // visual-verdict default — same boundary-kill machinery, one trigger. The
  // "g" flag is stripped because .test() on a global regex is stateful
  // (lastIndex advances between calls), which would make the accumulation
  // miss a marker that arrived in an earlier text part.
  const stopMarkerOpt = stopAfterMarker ?? (stopAfterVerdict ? COMPLETE_VERDICT_RE : null);
  const stopMarker = stopMarkerOpt ? new RegExp(stopMarkerOpt.source, stopMarkerOpt.flags.replace("g", "")) : null;
  // Issue #84: the checkpoint/custom-marker seat arms the boundary kill only
  // on a TERMINAL emission — the marker as the model's last line (what the
  // gate later honours via readCheckpointTicket). The visual-verdict seat
  // keeps its block-substring test because learnings/notes may follow its
  // `$END`. A loose `$CHECKPOINT` substring latch made a model that merely
  // QUOTED the checkpoint format in prose kill the phase at the next step
  // boundary, discarding a productive in-flight generation.
  const terminalAnchor = stopAfterMarker !== null;
  // Issue #84: under the durable builder the request-ceiling kill guards are
  // telemetry-only (compaction owns fill; a railhead kill would race it).
  const killGuards = guardMode !== "telemetry";
  // Uniform timestamp for EVERY emitted line (event renders, step markers,
  // errors, heartbeats) so no line reads as a bare orphan next to a clocked
  // one. Callers pass unprefixed content; the clock lives here, in one place.
  const rawSink = liveSink ?? ((line: string) => process.stderr.write(line + "\n"));
  const sink = (line: string) => rawSink(`[${nowClock()}] ${line}`);

  // Issue #82: seed of the running in-flight estimate — the prompt's token
  // cost, which is what the phase will send before any step reports ground
  // truth. Computed once and reused by the pre-flight guard below.
  const promptTokens = estimateTokens(prompt);

  // Under `--verbose` echo the exact prompt being sent — the system prefix +
  // user content the model sees — so an operator can audit what each phase
  // asked for. Prints before the pre-flight guard so a call skipped for
  // budget still shows what was attempted.
  if (verbose) {
    const p = livePrefix ? `${livePrefix} ` : "";
    const seat = model !== null && model !== DEFAULT_MODEL ? model : "opencode default";
    sink(`${p}── prompt (${seat}, est ~${promptTokens} tokens) ──`);
    rawSink(prompt);
  }

  if (maxContextTokens && maxContextTokens > 0) {
    const estimated = promptTokens;
    const threshold = Math.floor(maxContextTokens * PROMPT_BUDGET_RATIO);
    if (estimated > threshold) {
      const p = livePrefix ? `${livePrefix} ` : "";
      if (killGuards) {
        sink(`${p}✖ prompt estimated at ~${estimated} tokens exceeds ${threshold} (50% of ${maxContextTokens} budget) — skipping model call`);
        return {
          status: "budget_exceeded",
          code: null,
          signal: null,
          durationMs: 0,
          steps: 0,
          peakTokens: estimated,
          inFlightTokens: estimated,
          estimateDriftTokens: 0,
          totalOutputTokens: 0,
          generationMs: 0,
          toolCalls: 0,
          errorMessage: null,
          firstStepCache: null,
          evidence: {
            status: "budget_exceeded",
            errorMessage: null,
            peakTokens: estimated,
            steps: 0,
            toolCalls: 0,
            code: null,
            signal: null,
            durationMs: 0,
          },
        };
      }
      // Issue #84: the durable builder's ceiling is telemetry, not a refusal —
      // a resumed session may legitimately open past the 50% pre-flight line
      // and let compaction manage the fill. Log and proceed; the request is
      // the model's to make.
      sink(`${p}ℹ prompt estimated at ~${estimated} tokens exceeds ${threshold} (50% of ${maxContextTokens} budget) — telemetry only under the session builder; proceeding`);
    }
  }

  const base = ["run", "--format", "json"];
  // Issue #39: when a persistent `opencode serve` worker is active, attach
  // to it instead of spawning a standalone subprocess. The warm server's KV
  // cache reuses the system-prompt prefix across phases. Each phase is still
  // a fresh session (no --continue/--session), so ADR 0001's fresh-context
  // property holds; only the server process is shared.
  if (activeWorkerUrl !== null) {
    base.push("--attach", activeWorkerUrl);
  }
  if (model && model !== DEFAULT_MODEL) base.push("--model", model);
  if (agent) base.push("--agent", agent);
  if (session) base.push("--session", session);
  base.push(prompt);

  const child = spawn("opencode", base, {
    cwd,
    env: guardedEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  activeChildPid = child.pid ?? null;
  ensureSigintKillsChild();

  let steps = 0;
  let peakTokens = 0;
  // Issue #82: the streaming in-flight estimate. `reconcileBase` is ground
  // truth — the prompt estimate until the first step reports, then the last
  // reported step_finish COMPLETE context (fresh input + cache-read/write);
  // `streamedTokens` is the token cost of every text/reasoning/tool event
  // that has arrived since that anchor. Their sum estimates the request being
  // assembled, so it rises mid-step where `peakTokens` is frozen. Each
  // step_finish reconciles the anchor to the server's reported context
  // (reported is ground truth for the completed request) and the difference
  // is captured as drift telemetry — rebasing instead of accumulating keeps
  // the estimate from drifting with every step.
  let reconcileBase = promptTokens;
  let streamedTokens = 0;
  let estimateDriftTokens = 0;
  let totalOutputTokens = 0;
  // Issue #130: the first completed step's cache accounting, captured once.
  // Later steps move the same cached prefix plus the growing tail, so only the
  // first step measures whether the phase's prompt was restored or prefilled.
  let firstStepCache: FirstStepCache | null = null;
  let generationMs = 0;
  // Per-finished-step rate samples feeding the heartbeat's rolling throughput
  // window — the phase-lifetime average cannot move within a step and reads
  // stale after any rate change. Each sample carries the DECODE window
  // (first streamed token → step end, minus tool time; null when the step
  // streamed nothing) and the step WALL (step_start → step end, minus tool
  // time) separately: the decode rate must never see prefill, and a step
  // whose prefill cannot be separated out contributes to the e2e rate only.
  const RATE_WINDOW_STEPS = 10;
  const stepRates: { out: number; decodeMs: number | null; wallMs: number | null }[] = [];
  let firstGenTs: number | null = null;
  let lastGenTs: number | null = null;
  let stepStartEventTs: number | null = null;
  let stepToolMs = 0;
  let stepStart = Date.now();
  let budgetExceeded = false;
  let stalled = false;
  let modelStalled = false;
  let spinLoop = false;
  let markerEarlyExit = false;
  // ADR 0040: the builder's terminal blocked marker was emitted; stop at the
  // next step boundary and surface the report (never a checkpoint, never a
  // failure — the run loop routes by kind).
  let blockEmitted = false;
  let blockReport: BlockReport | null = null;
  // gh #111: an agent-initiated halt (`.railhead/STOP`). Distinct from every
  // other kill: it is an honest stop, not a failure — the run loop reads the
  // reason and marks the run `stopped` rather than feeding the failure ladder.
  let halted = false;
  let haltReasonText: string | null = null;
  let consecutiveErrors = 0;
  let lastErrorSignature: string | null = null;
  let transientError = false;
  let errorMessage: string | null = null;
  // Issue #96: degraded-target detection. `toolTimeoutAt` holds the
  // Date.now() of every TIMEOUT-class errored tool call still inside the
  // rolling window; the phase is killed once the array reaches
  // `maxToolTimeouts`. Windowed on purpose — a wedged target can answer one
  // call (a fresh-tab retry) between timeouts, and a success must not reset
  // the counter the way the spin guard's streak resets, or the guard would
  // miss exactly the pattern it exists for.
  let toolTimeoutAt: number[] = [];
  let degradedTarget = false;
  // Issue #96: absolute phase wall-clock expiry (see the phaseWallSec option).
  let wallClockExceeded = false;
  let zeroTokenStep = false;
  let realTokenStep = false;
  let lastStepReason: string | null = null;
  let lastStepOutputTokens: number | null = null;
  let sawAssistantText = false;
  // Every assistant `text` part the phase streamed. When the model itself
  // produced no real tokens (`!realTokenStep`), any text present is not model
  // output — a proxy/gateway that failed upstream surfaces its diagnostic as
  // content rather than an `error` event. Kept so the zero-output failure can
  // name the real cause instead of the generic "0 tokens" message.
  let streamedText = "";
  let toolCalls = 0;
  // gh #105: the non-convergent-edit detector. `lastEdit`/`editStreak` track
  // the last completed full-file write and how many near-identical rewrites of
  // that path have stacked since the last REAL progress (a materially different
  // write, or a first write to a different path). Bash/read events do NOT reset
  // the streak — the incident's `git checkout`-then-rewrite-verbatim shape is
  // precisely the loop signature.
  let lastEdit: { path: string; content: string } | null = null;
  let editStreak = 0;
  let editLoop = false;
  // Issue #84 (ADR 0022 S0.1): the session id carried on every JSON event line
  // (opencode's `--format json` wraps each event with a top-level `sessionID`).
  // Captured from the first event that carries one — the durable handle the
  // railhead persists so a later invocation can resume the session.
  let sessionId: string | null = null;
  // Issue #84 (ADR 0022 S0.2): the ticket number the `$CHECKPOINT` marker
  // named, when the phase was stopped at a checkpoint marker.
  let checkpointTicket: string | null = null;
  // Issue #78: completed parts (text + terminal tool parts) in the current
  // step — the model-time kill message reports it so an operator can tell a
  // step that slowly completed work from a pure 0-tok/s thrash.
  let partsCompleted = 0;
  // Issue #60 (generalized to any stop marker, #84): accumulated assistant
  // text + whether the marker {$VISUAL_PASS/$VISUAL_FAIL ... $END} or a
  // custom stop marker has appeared. Mirrors what
  // extractAssistantText reads back from the ledger, so the early-exit
  // matches the post-hoc parse.
  let assistantText = "";
  let markerEmitted = false;
  const stepCap = typeof maxSteps === "number" && maxSteps > 0 ? maxSteps : Infinity;
  const stallCapMs =
    typeof stallTimeoutSec === "number" && stallTimeoutSec > 0 ? stallTimeoutSec * 1000 : Infinity;
  const modelCapMs =
    typeof maxStepModelSec === "number" && maxStepModelSec > 0 ? maxStepModelSec * 1000 : Infinity;
  const toolTimeoutLimit =
    typeof maxToolTimeouts === "number" && maxToolTimeouts > 0 ? maxToolTimeouts : Infinity;
  const toolTimeoutWindowMs =
    typeof toolTimeoutWindowSec === "number" && toolTimeoutWindowSec > 0 ? toolTimeoutWindowSec * 1000 : Infinity;
  const wallCapMs =
    typeof phaseWallSec === "number" && phaseWallSec > 0 ? phaseWallSec * 1000 : Infinity;

  let stallTimer: NodeJS.Timeout | null = null;
  // opencode's --format json emits one JSON object per line. But Node's stdout
  // stream delivers data in arbitrary Buffer chunks that don't align with line
  // boundaries — a large event (e.g. a screenshot response with a base64 PNG
  // payload) can span multiple `data` events. Without buffering, each fragment
  // is written to the ledger as a separate "line," none of which is valid JSON.
  let lineBuffer = "";
  const killForStall = () => {
    stalled = true;
    const p = livePrefix ? `${livePrefix} ` : "";
    sink(`${p}✖ no output for ${stallTimeoutSec}s — killing opencode process (stalled)`);
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  };
  // Issue #96: the absolute phase wall-clock cap. Unlike the stall timer
  // (re-armed on every byte) and the model-time cap (per step), this bounds
  // the WHOLE phase in wall time regardless of output — a slow-but-loud
  // round that never produces a silence gap or a model-time overrun still
  // cannot run past its budget. Deliberately distinct so a phase killed for
  // it reports a wall-clock timeout, not a bogus "no output" stall.
  const killForWallClock = () => {
    if (wallClockExceeded) return;
    wallClockExceeded = true;
    const msg = `wall-clock: phase exceeded its ${phaseWallSec}s wall-clock budget`;
    if (errorMessage === null) errorMessage = msg;
    const p = livePrefix ? `${livePrefix} ` : "";
    sink(`${p}✖ ${msg} — killing opencode process`);
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  };
  let wallTimer: NodeJS.Timeout | null = null;
  if (wallCapMs !== Infinity) wallTimer = setTimeout(killForWallClock, wallCapMs);
  // Armed on every byte of output (see the stdout/stderr handlers below), so a
  // phase that keeps producing events — however many steps it takes — is
  // never penalized; only silence trips this.
  const armStallTimer = () => {
    if (stallCapMs === Infinity) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(killForStall, stallCapMs);
  };
  armStallTimer();

  // Issue #78 model-time cap. opencode streams no per-token signal — parts
  // arrive atomically on completion (a 12-min thrash at 0 tok/s is silent, and
  // so is a legitimately long tool), so the discriminator is model TIME:
  // wall clock of the current step minus tool-execution wall. A `running`
  // tool part, when opencode emits one, exempts its wall live; the terminal
  // tool event's exact `state.time` window is attributed when it lands. With
  // neither, the wall accrues to model time and trips this cap — the thrash's
  // blast-radius bound, per issue #78's revised spec.
  let modelTimer: NodeJS.Timeout | null = null;
  let modelStallElapsedSec = 0;
  // Epoch ms a `running` tool part began, or null when no tool is known to be
  // in flight. Tool wall between this and the terminal event is not model time.
  let toolRunningSince: number | null = null;
  // True from the step_start that begins a step until its step_finish, so the
  // cap never counts the inter-step gap (opencode submitting the next request)
  // — that stretch is the silence timer's case.
  let inStep = false;
  const modelTimeNow = (): number => {
    const toolInFlight = toolRunningSince !== null ? Math.max(0, Date.now() - toolRunningSince) : 0;
    return Math.max(0, Date.now() - stepStart - stepToolMs - toolInFlight);
  };
  const killForModelStall = (modelMs: number) => {
    modelStalled = true;
    modelStallElapsedSec = Math.round(modelMs / 1000);
    const p = livePrefix ? `${livePrefix} ` : "";
    const estNow = reconcileBase + streamedTokens;
    const est = estNow > 0 ? `~${Math.round(estNow / 1000)}k request, ` : "";
    sink(`${p}✖ model-stalled: step exceeded the ${maxStepModelSec}s model-time budget (${est}${modelStallElapsedSec}s elapsed, ${partsCompleted} part${partsCompleted === 1 ? "" : "s"} completed) — killing opencode process`);
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  };
  if (modelCapMs !== Infinity) {
    modelTimer = setInterval(() => {
      if (!inStep) return;
      if (stalled || modelStalled || budgetExceeded || spinLoop || markerEarlyExit) return;
      const modelMs = modelTimeNow();
      if (modelMs > modelCapMs) killForModelStall(modelMs);
    }, 500);
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    armStallTimer();
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split("\n");
    // The last element after split is always a partial line (or "" if the
    // chunk ended with \n). Keep it in the buffer for the next chunk; only
    // complete lines (terminated by \n) are processed below.
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      void appendEvent(ledgerDir, phaseFile, line);
      if (line.trim()) {
        // gh #111: check the halt file once per streamed line (one stat is
        // negligible) so a mid-phase halt takes effect at the next line, not
        // the next ticket. Kills the child process group exactly as the budget
        // guard does. The read never throws — a race where the file vanishes
        // mid-stat is a clean "no halt".
        const halt = haltReason(cwd);
        if (halt !== null) {
          halted = true;
          haltReasonText = halt;
          const p = livePrefix ? `${livePrefix} ` : "";
          sink(`${p}✖ halt signal: an agent wrote the halt file (${halt}) — killing opencode process`);
          try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          return;
        }
        // Issue #84 (ADR 0022 S0.1): capture the durable session handle from
        // the first JSON event that carries one. Every `opencode run
        // --format json` event is wrapped `{ type, timestamp, sessionID, ... }`,
        // so the first event of the phase is enough.
        if (sessionId === null) sessionId = sessionIdOf(line);
        // Issue #82: every archived event that carries conversation content
        // (assistant text/reasoning, terminal tool input+output) grows the
        // in-flight estimate of the request being assembled. Runs before the
        // step_finish handling below so the reconcile measures the full cost.
        streamedTokens += streamedTokenCost(line);
        if (line.includes('"step_start"')) {
          // Issue #60 (generalized to any stop marker, #84): the stop marker
          // was already emitted — this phase's terminal signal is done. Kill
          // at this step boundary (the current step's text was archived) so
          // the model cannot loop by re-emitting it until the step budget
          // kills it and loses the signal.
          if ((stopMarker && markerEmitted) || blockEmitted) {
            markerEarlyExit = true;
            const p = livePrefix ? `${livePrefix} ` : "";
            sink(`${p}✓ stop marker already emitted — killing opencode process early`);
            try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
            return;
          }
          // Issue #53: check the accumulated peak BEFORE the step runs. The
          // step_finish-time check below fires only when an exceeding
          // step_finish is processed — if that event is the last one and the
          // process exits before the kill lands, the SIGTERM hits a dead
          // process and the guard is a no-op. Checking here at the NEXT step
          // boundary kills while the child is alive and guarantees no further
          // step runs once the budget is exceeded.
          if (maxContextTokens && maxContextTokens > 0 && peakTokens > maxContextTokens * 0.95) {
            const p = livePrefix ? `${livePrefix} ` : "";
            if (killGuards) {
              sink(`${p}✖ peak tokens ${peakTokens} exceeded 95% of budget ${maxContextTokens} — killing before the next step runs`);
              budgetExceeded = true;
              try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
              return;
            }
            // Issue #84: telemetry-only on the durable builder — compaction
            // owns the fill; the railhead only watches. Step bookkeeping below
            // still runs so the session progresses normally.
            sink(`${p}ℹ peak tokens ${peakTokens} exceeded 95% of budget ${maxContextTokens} — telemetry only under the session builder`);
          }
          steps++;
          stepStart = Date.now();
          inStep = true;
          toolRunningSince = null;
          firstGenTs = null;
          lastGenTs = null;
          stepToolMs = 0;
          partsCompleted = 0;
          try {
            const ev = JSON.parse(line);
            if (typeof ev.timestamp === "number") stepStartEventTs = ev.timestamp;
          } catch { /* ignore */ }
          if (steps > stepCap) {
            budgetExceeded = true;
            const p = livePrefix ? `${livePrefix} ` : "";
            sink(`${p}✖ step budget exceeded (${stepCap} steps) — killing opencode process`);
            // Kill the entire process group so shell-spawned children (cargo,
            // sleep, etc.) die too. SIGTERM first; escalate if needed.
            try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
            return;
          }
        }
        const reportedCtx = contextTokensOf(line);
        if (reportedCtx != null) {
          peakTokens = Math.max(peakTokens, reportedCtx);
          // Issue #82 reconcile: the reported context is ground truth for the
          // request that just completed. Capture the estimate's drift against
          // it, then rebase the streaming estimate so it converges to the
          // reported number instead of accumulating error across steps. A
          // zero-context finish is degenerate (model never ran) — leave the
          // anchor alone rather than collapsing it to nothing.
          if (reportedCtx > 0) {
            estimateDriftTokens = reportedCtx - (reconcileBase + streamedTokens);
            reconcileBase = reportedCtx;
            streamedTokens = 0;
          }
        }
        // Issue #130: the first completed step's prompt-cache split, captured
        // once and surfaced live — an operator sees immediately whether a
        // phase's prompt was restored (small cold, large cached) or had to be
        // prefilled from scratch (large cold, zero cached).
        if (firstStepCache === null) {
          const cache = firstStepCacheOf(line);
          if (cache !== null) {
            firstStepCache = cache;
            const p = livePrefix ? `${livePrefix} ` : "";
            sink(`${p}cache: ${cache.cached}/${cache.cold + cache.cached} first-step tokens reused`);
          }
        }
        const ot = outputTokensOf(line);
        if (ot != null) totalOutputTokens += ot;
        if (reportedCtx === 0 && ot === 0) zeroTokenStep = true;
        if ((reportedCtx !== null && reportedCtx > 0) || (ot !== null && ot > 0)) realTokenStep = true;
        const finishReason = stepFinishReasonOf(line);
        if (finishReason !== null) {
          lastStepReason = finishReason;
          lastStepOutputTokens = ot ?? null;
        }
        if (isTerminalToolUse(line)) {
          toolCalls++;
          partsCompleted++;
          const execMs = toolExecMsOf(line);
          if (execMs != null) {
            // Exact tool wall from the terminal event's state.time window.
            stepToolMs += execMs;
          } else if (toolRunningSince !== null) {
            // Terminal event without a state.time — close the running window.
            stepToolMs += Math.max(0, Date.now() - toolRunningSince);
          }
          toolRunningSince = null;
        } else if (isToolRunning(line) && toolRunningSince === null) {
          // Issue #78: an opencode stream that emits intermediate `running`
          // tool parts (the `→ tool [running]` live lines) lets the model-time
          // cap exempt the tool's wall live, instead of only at the terminal
          // event. Absent in current `--format json`; kept for streams that
          // emit it so a long build inside a step is never counted as model time.
          toolRunningSince = Date.now();
        }
        const ts = textEventTimestamp(line);
        if (ts !== null) {
          if (firstGenTs === null) firstGenTs = ts;
          lastGenTs = ts;
        }
        const textPart = assistantTextOf(line);
        if (textPart !== null) streamedText += textPart;
        if (stopMarker) {
          if (textPart !== null) {
            assistantText += textPart;
            // Terminal-anchored for the terminal-marker seats: only a marker
            // that ENDS the accumulated text (its own line as the last line)
            // arms the kill, so prose quoting the format cannot false-trigger
            // the early exit (issue: a summary that said "emit `$CHECKPOINT
            // ticket=03` once green" killed the next in-flight step). The
            // checkpoint seat keeps its own stricter grammar (an own-line
            // `$CHECKPOINT ticket=NN` with the argument); a generic custom
            // marker anchors on its own terminal line. The verdict seat keeps
            // its substring test on the full block.
            const emitted = terminalAnchor
              ? stopMarker === CHECKPOINT_RE
                ? endsWithCheckpoint(assistantText)
                : endsWithOwnLineMarker(assistantText, stopMarker)
              : stopMarker.test(assistantText);
            if (emitted) markerEmitted = true;
            if (stopAfterBlocked && !blockEmitted && endsWithBlockReport(assistantText)) {
              blockEmitted = true;
              blockReport = parseBlockReport(assistantText);
            }
            // Issue #84: capture which ticket a `$CHECKPOINT ticket=NN` line
            // named. Kept parsing after the marker fires (until found) so a
            // marker whose `ticket=` argument lands in a later text part still
            // reconciles; parse cost stays bounded because it stops on the
            // first ticket found.
            if (markerEmitted && checkpointTicket === null) {
              checkpointTicket = readCheckpointTicket(assistantText);
            }
          }
        }
        if (textPart !== null) {
          sawAssistantText = true;
          partsCompleted++;
        }
        if (isStepFinish(line) && typeof parseTimestamp(line) === "number") {
          const finishTs = parseTimestamp(line)!;
          const timing = stepTimingMs(finishTs, stepStartEventTs, firstGenTs, lastGenTs, stepToolMs);
          if (timing.decodeMs !== null) generationMs += timing.decodeMs;
          if (timing.decodeMs !== null || timing.wallMs !== null) {
            stepRates.push({ out: ot ?? 0, decodeMs: timing.decodeMs, wallMs: timing.wallMs });
            if (stepRates.length > RATE_WINDOW_STEPS) stepRates.shift();
          }
          firstGenTs = null;
          lastGenTs = null;
          stepStartEventTs = null;
          stepToolMs = 0;
          inStep = false;
        }
        if (maxContextTokens && maxContextTokens > 0 && peakTokens > maxContextTokens * 0.95) {
          const p = livePrefix ? `${livePrefix} ` : "";
          if (killGuards) {
            sink(`${p}✖ peak tokens ${peakTokens} exceeded 95% of budget ${maxContextTokens} — killing subprocess`);
            try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
            budgetExceeded = true;
            return;
          }
          // Issue #84: telemetry-only on the durable builder.
          sink(`${p}ℹ peak tokens ${peakTokens} exceeded 95% of budget ${maxContextTokens} — telemetry only under the session builder`);
        }
        // Issue #82: arm the ceiling on the IN-FLIGHT ESTIMATE while a step is
        // running, not only on step_finish-reported peaks. The steps that
        // matter most — thrashing toward an OOM — never emit a step_finish,
        // so the peak guard waits for a boundary that never comes. The
        // estimate reflects the tool outputs already streamed into the next
        // request, so an estimate over the ceiling is a request that must not
        // be sent. After a step_finish the estimate has just been reconciled
        // to the reported input, making this the finished-step guard's case
        // (reported vs estimate can diverge no more than the meter's error).
        if (inStep && maxContextTokens && maxContextTokens > 0) {
          const estNow = reconcileBase + streamedTokens;
          if (estNow > maxContextTokens * 0.95) {
            const p = livePrefix ? `${livePrefix} ` : "";
            if (killGuards) {
              sink(`${p}✖ in-flight estimate ${estNow} tokens exceeded 95% of budget ${maxContextTokens} — killing mid-step before the next request is sent`);
              budgetExceeded = true;
              try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
              return;
            }
            // Issue #84: telemetry-only on the durable builder.
            sink(`${p}ℹ in-flight estimate ${estNow} tokens exceeded 95% of budget ${maxContextTokens} — telemetry only under the session builder`);
          }
        }
        if (spinLoopThreshold && spinLoopThreshold > 0) {
          const sig = toolErrorSignature(line);
          // Issue #96: a timeout-class errored tool call is a WEDGED-target
          // signal, not a model spin — even when the model retries the same
          // tool+input, the fix is the degraded-target guard below (kill +
          // recovery note), not the identical-error spin verdict. Exempting
          // them here keeps a wedged target from being miscounted as (and
          // killed for) a spin loop before the burst guard can classify it.
          const toolErr = toolUseErrorTextOf(line);
          if (sig !== null && !(toolErr !== null && isToolTimeout(toolErr))) {
            if (sig === lastErrorSignature) {
              consecutiveErrors++;
            } else {
              consecutiveErrors = 1;
              lastErrorSignature = sig;
            }
            if (consecutiveErrors >= spinLoopThreshold) {
              spinLoop = true;
              const p = livePrefix ? `${livePrefix} ` : "";
              sink(`${p}✖ spin loop: ${consecutiveErrors} consecutive identical errored tool calls — killing opencode process`);
              try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
              return;
            }
          } else if (sig === null && line.includes('"tool_use"')) {
            try {
              const ev = JSON.parse(line);
              const state = ev.part?.state;
              if (state && state.status !== "error") {
                consecutiveErrors = 0;
                lastErrorSignature = null;
              }
            } catch { /* ignore */ }
          }
        }
        // Issue #96: degraded-target detection. Mirrors the spin guard's
        // blast radius but keys on TIMEOUT-CLASS tool errors across ANY
        // tool/input within a rolling window — the shape the consecutive-
        // identical spin guard cannot see (a wedged tool target times out
        // every call, the failing calls alternate tool/input, and an
        // eventual success resets a streak counter). Deliberately distinct
        // from the provider-error `transient` path: a timed-out tool call is
        // the tool SERVER's own request ceiling, not a blip to retry.
        if (toolTimeoutLimit !== Infinity && toolTimeoutWindowMs !== Infinity) {
          const toolErr = toolUseErrorTextOf(line);
          if (toolErr !== null && isToolTimeout(toolErr)) {
            const now = Date.now();
            toolTimeoutAt.push(now);
            while (toolTimeoutAt.length > 0 && now - toolTimeoutAt[0]! > toolTimeoutWindowMs) {
              toolTimeoutAt.shift();
            }
            if (toolTimeoutAt.length >= toolTimeoutLimit) {
              degradedTarget = true;
              const p = livePrefix ? `${livePrefix} ` : "";
              const msg = `${DEGRADED_TARGET_PREFIX} ${toolTimeoutAt.length} tool request timeouts within the last ${Math.round(toolTimeoutWindowMs / 1000)}s — the interaction target is wedged, not merely slow; killing opencode process to end the timeout spiral`;
              errorMessage = msg;
              sink(`${p}✖ ${msg}`);
              try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
              return;
            }
          }
        }
        // gh #105: non-convergent-edit detection. A completed write whose
        // content normalizes (whitespace-insensitive) equal to the last write
        // of that path increments the streak; a materially changed write — or
        // a first write to a different path — is real progress and resets it.
        // A near-identical rewrite after a mid-phase `git checkout` revert
        // still counts (bash does not reset). At the threshold the phase is
        // killed with the existing spin_loop status so the failure ladder's
        // retry semantics are unchanged (ADR 0023) — the message prefix is
        // what routes it, and the spec-reconcile path lands its correction at
        // the first verify failure before this cap would ever matter.
        {
          const payload = writePayloadOf(line);
          if (payload !== null) {
            const normalized = payload.content.replace(/\s+/g, " ").trim();
            if (lastEdit !== null && lastEdit.path === payload.path && lastEdit.content === normalized) {
              editStreak++;
            } else {
              lastEdit = { path: payload.path, content: normalized };
              editStreak = 1;
            }
            if (editStreak >= EDIT_LOOP_THRESHOLD) {
              editLoop = true;
              const msg = `non-convergent edit loop: ${editStreak} near-identical rewrites of ${payload.path}`;
              errorMessage = msg;
              const p = livePrefix ? `${livePrefix} ` : "";
              sink(`${p}✖ ${msg} — killing opencode process`);
              try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
              return;
            }
          }
        }
        if (line.includes('"error"')) {
          const msg = extractErrorMessage(line);
          if (msg !== null) {
            if (errorMessage === null) errorMessage = msg;
            if (isTransientError(msg)) transientError = true;
          }
        }
      }
      if (live) {
        const rendered = renderEventLine(line, { prefix: livePrefix, verbose });
        if (rendered) sink(rendered);
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    armStallTimer();
    for (const line of chunk.toString("utf8").split("\n")) {
      void appendEvent(ledgerDir, `${phaseFile}.stderr`, line);
    }
  });

  const start = Date.now();
  const heartbeatTimer =
    live || heartbeat
      ? setInterval(() => {
          const elapsed = Math.round((Date.now() - start) / 1000);
          const stepElapsed = Math.round((Date.now() - stepStart) / 1000);
          // The context riding on the current request: the last step_finish's
          // COMPLETE input (fresh + cache-read + cache-write — the bare
          // `input` field is only the uncached sliver and reads near-zero on
          // a warm cache) plus the content streamed toward the next request.
          const ctxNow = reconcileBase + streamedTokens;
          const ctxBit = ctxNow > 0 ? ` · ctx ${(ctxNow / 1000).toFixed(1)}k` : "";
          const outBit = totalOutputTokens > 0 ? ` · out ${(totalOutputTokens / 1000).toFixed(1)}k` : "";
          // Throughput over the recent window of finished steps, not the
          // phase-lifetime average: the average is dragged by the run's slow
          // start and cannot move within a step, while the window tracks the
          // rate the model is at right now. Decode and end-to-end are reported
          // separately — the decode rate never includes prefill (steps that
          // streamed nothing have no decode anchor and feed the e2e rate
          // only), so a local server chewing a large context reads honestly.
          const rates = windowedStepRates(stepRates);
          const decodeBit = rates.decodeTokPerSec !== null ? ` · ${rates.decodeTokPerSec} tok/s` : "";
          const e2eBit = rates.e2eTokPerSec !== null ? ` · e2e ${rates.e2eTokPerSec.toFixed(1)} tok/s` : "";
          const stepInfo = ` step ${steps}${stepCap === Infinity ? "" : ` (cap ${stepCap})`}`;
          const p = livePrefix ? `${livePrefix} ` : "";
          sink(`${p}… running ${elapsed}s (${stepInfo} this step ${stepElapsed}s${ctxBit}${outBit}${decodeBit}${e2eBit})`);
        }, heartbeatIntervalSec * 1000)
      : null;

  // Flush any remaining partial line in the buffer. opencode's stream may
  // end mid-line (no trailing \n on the last event). Archive it to the ledger
  // so no data is lost, but it may not be a complete JSON object.
  if (lineBuffer.trim()) {
    void appendEvent(ledgerDir, phaseFile, lineBuffer);
  }

  const [code, signal] = (await once(child, "close").catch(() => [-1, null])) as [
    number | null,
    NodeJS.Signals | null,
  ];

  activeChildPid = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (modelTimer) clearInterval(modelTimer);
  if (stallTimer) clearTimeout(stallTimer);
  if (wallTimer) clearTimeout(wallTimer);

  // Three zero-output shapes report "transient" — the model never produced:
  //  (1) a step_finish with 0 input+output tokens (zeroTokenStep — the proxy
  //      surfaced a connection error as text and opencode exited clean).
  //      zeroTokenStep takes priority over sawAssistantText because a 0-token
  //      step_finish is definitive: the model never generated, even if
  //      proxy error text appeared alongside it.
  //  (2) a step_start with NO step_finish AND no assistant text — opencode
  //      started a step then exited code 0 without completing it (observed
  //      on pixeledit-local: the planner emitted one step_start, exited 0,
  //      and the railhead reported "ok" → "plan output contained no
  //      readable tickets" instead of retrying). sawAssistantText exempts
  //      a step that emitted text events but had no step_finish (killed
  //      mid-step after a verdict) — the model WAS generating.
  //  (3) a final step_finish with reason "stop" and negligible output (≤1
  //      token) — the model server returned a degenerate no-op turn after
  //      real work in earlier steps (pixeledit-night-1: 20+ real steps, then
  //      a 1/1-token stop). The !realTokenStep gate does NOT exempt this:
  //      earlier steps being healthy doesn't mean the final step wasn't a
  //      server failure. A legitimate stop step always has substantial output
  //      (at minimum the DONE marker); output ≤1 is diagnostic.
  const wholePhaseDegenerate = !realTokenStep && (zeroTokenStep || (steps > 0 && !sawAssistantText));
  const lastStepDegenerate = lastStepReason === "stop" && lastStepOutputTokens !== null && lastStepOutputTokens <= 1;
  const zeroOutput = wholePhaseDegenerate || lastStepDegenerate;
  // Issue #78: a model-time kill is a distinct timeout flavour — its
  // errorMessage names model time, the estimated request size, and the
  // elapsed model seconds so describeExecFailure can tell it from a silence
  // stall (the two need different ladder responses under #80). The request
  // size shown is the in-flight estimate (#82), not the stale finished-step
  // peak — a step killed mid-thrash never reported its own size.
  const inFlightAtEnd = reconcileBase + streamedTokens;
  const modelStallMessage = modelStalled
    ? `model-stalled: step exceeded the ${maxStepModelSec}s model-time budget (${inFlightAtEnd > 0 ? `est. request ~${Math.round(inFlightAtEnd / 1000)}k, ` : ""}${modelStallElapsedSec}s elapsed, ${partsCompleted} part${partsCompleted === 1 ? "" : "s"} completed)`
    : null;
  const wallClockMessage = wallClockExceeded
    ? `wall-clock: phase exceeded its ${phaseWallSec}s wall-clock budget`
    : null;
  // A zero-output phase where the model never generated a real token can still
  // have streamed `text`: a proxy/gateway that failed upstream returns its
  // diagnostic as content (shape 1 above), not an `error` event. Surface it so
  // the failure names the real cause instead of the generic 0-token message.
  // Gated on `!realTokenStep`: once the model has produced real tokens, text is
  // its own output, not an injected diagnostic.
  const injected = !realTokenStep ? injectedDiagnostic(streamedText) : null;
  const zeroOutputMessage = injected
    ? `model produced 0 tokens (connection or provider failure) — ${injected}`
    : "model produced 0 tokens (connection or provider failure)";
  const finalStatus: ExecStatus = halted ? "halted" : markerEarlyExit || blockEmitted ? "ok" : degradedTarget ? "degraded_target" : (spinLoop || editLoop) ? "spin_loop" : budgetExceeded ? "budget_exceeded" : stalled || modelStalled || wallClockExceeded ? "timeout" : zeroOutput ? "transient" : transientError && code !== 0 ? "transient" : code === 0 ? "ok" : "error";
  const finalError = halted ? (haltReasonText ?? "halt file present") : modelStallMessage ?? wallClockMessage ?? (zeroOutput ? zeroOutputMessage : errorMessage);
  const durationMs = Date.now() - start;
  return {
    status: finalStatus,
    code,
    signal,
    durationMs,
    steps,
    peakTokens,
    inFlightTokens: inFlightAtEnd,
    estimateDriftTokens,
    totalOutputTokens,
    generationMs,
    toolCalls,
    errorMessage: finalError,
    sessionId,
    firstStepCache,
    // Surface the checkpoint ticket whenever the stop marker appeared — a
    // clean natural exit after `$CHECKPOINT ticket=NN` (marker as the model's
    // last line, process closes 0) is the EXPECTED path, not the kill path, so
    // gating on markerEarlyExit would drop the reconcile signal it carries.
    checkpointTicket: markerEmitted ? checkpointTicket : null,
    block: blockEmitted ? blockReport : null,
    haltReason: halted ? haltReasonText : null,
    evidence: {
      status: finalStatus,
      errorMessage: finalError,
      peakTokens,
      steps,
      toolCalls,
      code,
      signal,
      durationMs,
    },
  };
}

/** Whether a JSON event line is a TERMINAL tool-use event (a tool call that
 * actually ran — completed, or errored after being attempted). Intermediate
 * "running"-style events (if the stream emits them) are not counted, so a tool
 * call that was invoked counts exactly once (issue #69). */
function isTerminalToolUse(line: string): boolean {
  if (!line.includes('"tool_use"')) return false;
  try {
    const ev = JSON.parse(line);
    if (ev.type !== "tool_use") return false;
    const status = ev.part?.state?.status;
    return status === "completed" || status === "error";
  } catch {
    return false;
  }
}

/** Whether a JSON event line is an intermediate `running` tool-use event — a
 * tool that has STARTED but not yet finished. opencode's `--format json` does
 * not emit these (terminal events arrive atomically with the full
 * `state.time` window; verified empirically on 1.18.27), but a stream that
 * does must not let the tool's wall count as model time under the #78 cap. */
function isToolRunning(line: string): boolean {
  if (!line.includes('"tool_use"')) return false;
  try {
    const ev = JSON.parse(line);
    if (ev.type !== "tool_use") return false;
    return ev.part?.state?.status === "running";
  } catch {
    return false;
  }
}

/** The COMPLETE context a step_finish reports for its request — fresh input
 * plus cache-read and cache-write tokens. opencode's bare `tokens.input` is
 * only the uncached sliver (~0 on a warm cache), so keying the budget guards
 * and the operator's context readout on it underreads the window by the cache
 * size — the number that decides a context kill must include it. */
function contextTokensOf(line: string): number | null {
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type !== "step_finish") return null;
  const tokens = ev.part?.tokens;
  if (typeof tokens?.input !== "number") return null;
  const read = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
  const write = typeof tokens.cache?.write === "number" ? tokens.cache.write : 0;
  return tokens.input + read + write;
}

/** The `reason` field from a `step_finish` event (e.g. "stop", "tool-calls"),
 * or null for any other line type. Used to detect degenerate final steps where
 * the model signaled end-of-turn but produced no real output. */
function stepFinishReasonOf(line: string): string | null {
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type === "step_finish" && typeof ev.part?.reason === "string") {
    return ev.part.reason;
  }
  return null;
}

/** A complete verdict block: `$VISUAL_PASS` (or `$VISUAL_FAIL`) followed by
 * `$END`, however much prose sits between them. The marker names are matched
 * case-insensitively like the verdict parsers (visual.ts). */
const COMPLETE_VERDICT_RE = /\$(visual_pass|visual_fail)\b[\s\S]*?\$end\b/i;

/** True when the LAST non-empty line of `text` matches the given stop-marker
 * regex — the generic own-line terminal anchor for a custom `stopAfterMarker`
 * (gh #105's `$RECONCILE_END`: the arbiter's contract makes the marker its
 * final line, so a marker that does not END the accumulated text is a prose
 * mention, not a terminal signal). The checkpoint seat uses the stricter
 * `endsWithCheckpoint` grammar instead. */
function endsWithOwnLineMarker(text: string, marker: RegExp): boolean {
  let last = -1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) last = i;
  }
  if (last < 0) return false;
  const re = new RegExp(marker.source, marker.flags.replace("g", ""));
  return re.test(lines[last].trim());
}

/** The assistant text carried by a `text` event, or null for any other line.
 * Mirrors `extractAssistantText`'s text-event rule so the early-exit check sees
 * the same transcript the post-hoc verdict parser reads back. */
function assistantTextOf(line: string): string | null {
  if (!line.includes('"text"')) return null;
  try {
    const ev = JSON.parse(line);
    if (ev.type === "text" && ev.part?.type === "text" && typeof ev.part.text === "string") {
      return ev.part.text;
    }
  } catch { /* ignore */ }
  return null;
}

/** A one-line, length-bounded rendering of text a zero-output phase streamed,
 * for the failure message. A gateway's upstream-failure diagnostic arrives as a
 * single `text` part; collapsing whitespace keeps it on the caller's one-line
 * `describeExecFailure` output. Returns null when there is nothing to show. */
function injectedDiagnostic(text: string): string | null {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}
function outputTokensOf(line: string): number | null {
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type === "step_finish") {
    const output = ev.part?.tokens?.output;
    return typeof output === "number" ? output : null;
  }
  return null;
}

/** Issue #130: the first `step_finish` line's prompt-cache split, or null for
 * any other line / a finish without token counts. Mirrors `contextTokensOf`'s
 * token reading: `tokens.input` is the uncached sliver, so cold is input plus
 * cache writes and cached is cache reads. */
function firstStepCacheOf(line: string): FirstStepCache | null {
  if (!line.includes('"step_finish"') || !line.includes('"tokens"')) return null;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type !== "step_finish") return null;
  const tokens = ev.part?.tokens;
  if (typeof tokens?.input !== "number") return null;
  const read = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
  const write = typeof tokens.cache?.write === "number" ? tokens.cache.write : 0;
  return { cold: tokens.input + write, cached: read };
}

/** The durable session id carried by a JSON event line, or null for any line
 * without one. `opencode run --format json` wraps every emitted event as
 * `{ type, timestamp, sessionID, ... }` (verified on 1.18.27), so the top-level
 * `sessionID` of the FIRST event is the handle to persist for a `--session`
 * resume (issue #84, ADR 0022 S0.1). */
function sessionIdOf(line: string): string | null {
  if (!line.includes('"sessionID"')) return null;
  try {
    const ev = JSON.parse(line);
    return typeof ev.sessionID === "string" && ev.sessionID.length > 0 ? ev.sessionID : null;
  } catch {
    return null;
  }
}

/** Milliseconds a completed/errored tool call actually RAN (its execution
 * window from opencode's `state.time`), or null for a non-terminal tool event
 * or one without timing. Subtracted from a step's wall interval so a slow
 * `npm test`/`npm run build` executed inside a step is not mistaken for model
 * generation time — the bug that made the throughput read a fraction of the
 * server's real decode rate during long-tool implement steps. Counted once,
 * on the terminal (completed/error) event only. */
function toolExecMsOf(line: string): number | null {
  if (!line.includes('"tool_use"')) return null;
  try {
    const ev = JSON.parse(line);
    if (ev.type !== "tool_use") return null;
    const state = ev.part?.state;
    if (!state || (state.status !== "completed" && state.status !== "error")) return null;
    const time = state.time;
    if (time && typeof time.start === "number" && typeof time.end === "number") {
      return Math.max(0, time.end - time.start);
    }
  } catch { /* ignore */ }
  return null;
}

/** A finished step's two timing windows, derived from the event timestamps.
 * `decodeMs` starts at the first streamed text/reasoning token — the moment
 * prefill ends — and runs to step_finish minus the step's measured tool time.
 * It is null unless the step demonstrably STREAMED: a non-streaming provider
 * delivers the whole text part as a single event just before step_finish, and
 * anchoring on that timestamp would divide the step's output by a ~0 window —
 * a fabricated thousand-tok/s reading, worse than the prefill-merge it
 * replaced. The anchor is only trusted when the observed stream span
 * (lastStreamTs > firstStreamTs) proves tokens arrived over time. `wallMs` is
 * the full step_start→step_finish interval minus tool time — prefill
 * included — and is the end-to-end denominator only. Either is null when its
 * window would be ≤ 0 (a tool that consumed the whole span) or its anchor
 * timestamp is missing. */
export function stepTimingMs(
  finishTs: number,
  stepStartTs: number | null,
  firstStreamTs: number | null,
  lastStreamTs: number | null,
  toolMs: number,
): { decodeMs: number | null; wallMs: number | null } {
  const streamed = firstStreamTs !== null && lastStreamTs !== null && lastStreamTs > firstStreamTs;
  const decode = streamed ? finishTs - firstStreamTs! - toolMs : null;
  const wall = stepStartTs !== null ? finishTs - stepStartTs - toolMs : null;
  return {
    decodeMs: decode !== null && decode > 0 ? decode : null,
    wallMs: wall !== null && wall > 0 ? wall : null,
  };
}

/** Rolling-window throughput from finished-step samples. The decode rate
 * pairs only anchored steps' output with their decode windows; the e2e rate
 * pairs every wall-measured step's output with its wall. Keeping the two
 * numerators and denominators paired is what stops prefill speed and decode
 * speed from blending into a single fictitious number. Null when no sample
 * in the window can support the rate. */
export function windowedStepRates(
  samples: { out: number; decodeMs: number | null; wallMs: number | null }[],
): { decodeTokPerSec: number | null; e2eTokPerSec: number | null } {
  let decodeOut = 0;
  let decodeMs = 0;
  let e2eOut = 0;
  let e2eMs = 0;
  for (const s of samples) {
    if (s.decodeMs !== null) {
      decodeOut += s.out;
      decodeMs += s.decodeMs;
    }
    if (s.wallMs !== null) {
      e2eOut += s.out;
      e2eMs += s.wallMs;
    }
  }
  return {
    decodeTokPerSec: decodeMs > 0 ? Math.round((decodeOut / decodeMs) * 1000) : null,
    e2eTokPerSec: e2eMs > 0 ? (e2eOut / e2eMs) * 1000 : null,
  };
}

function textEventTimestamp(line: string): number | null {
  if (!line.includes('"text"') && !line.includes('"reasoning"')) return null;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if ((ev.type === "text" || ev.type === "reasoning") && typeof ev.timestamp === "number") {
    return ev.timestamp;
  }
  return null;
}

function isStepFinish(line: string): boolean {
  if (!line.includes('"step_finish"')) return false;
  try {
    return JSON.parse(line).type === "step_finish";
  } catch {
    return false;
  }
}

function parseTimestamp(line: string): number | null {
  try {
    const ev = JSON.parse(line);
    return typeof ev.timestamp === "number" ? ev.timestamp : null;
  } catch {
    return null;
  }
}

/** Returns a signature (tool + serialized input) for an errored tool_use
 * event, or null if the line is not an errored tool call. Two errored calls
 * with the same signature are the model retrying the exact same action. */
function toolErrorSignature(line: string): string | null {
  if (!line.includes('"tool_use"')) return null;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type !== "tool_use") return null;
  const part = ev.part;
  if (!part || part.type !== "tool") return null;
  const state = part.state;
  if (!state || state.status !== "error") return null;
  const tool = part.tool || "unknown";
  const input = state.input;
  try {
    return `${tool}:${JSON.stringify(input)}`;
  } catch {
    return `${tool}:${String(input)}`;
  }
}

/**
 * The full-replacement write payload of a completed tool_use event, or null
 * for any line that is not one. Matches opencode's write/edit tool family — a
 * terminal event whose `state.input` carries a file path and a full
 * replacement content (`write` → `content`; `edit` → the `oldString`+`newString`
 * pair that jointly define the rewrite). That is the driver's tool contract,
 * not a project-language assumption. Used by the non-convergent-edit detector
 * to compare near-identical rewrites of one path (gh #105).
 */
export function writePayloadOf(line: string): { path: string; content: string } | null {
  if (!line.includes('"tool_use"')) return null;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type !== "tool_use") return null;
  const part = ev.part;
  if (!part || part.type !== "tool") return null;
  const state = part.state;
  if (!state || state.status !== "completed") return null;
  const tool = part.tool;
  if (tool !== "write" && tool !== "edit") return null;
  const input = state.input;
  if (!input || typeof input.filePath !== "string" || !input.filePath) return null;
  let content: unknown;
  if (tool === "write") {
    content = input.content;
  } else {
    content = `${String(input.oldString ?? "")}\u0000${String(input.newString ?? "")}`;
  }
  if (typeof content !== "string") return null;
  return { path: input.filePath, content };
}

/** Extract the error message from a JSON event line of type "error".
 * Returns null when the line is not a parseable error event. */
function extractErrorMessage(line: string): string | null {
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type !== "error") return null;
  const msg = ev.error?.data?.message ?? ev.error?.name;
  return typeof msg === "string" ? msg : null;
}

/**
 * Whether an error message from opencode's JSON stream indicates a transient
 * provider failure (rate-limit, server error, connection reset) that is
 * worth retrying after a backoff. Matched case-insensitively against the
 * full message. Patterns cover the common HTTP 429/5xx wording from
 * OpenRouter / OpenAI / Anthropic / Google providers, plus Node.js socket
 * errors. A non-transient error (context overflow, auth failure, model-not-
 * found) returns false — retrying those wastes time and hides a real
 * configuration problem.
 */
const TRANSIENT_PATTERNS = [
  "429",
  "rate limit",
  "rate_limit",
  "too many requests",
  "overloaded",
  "capacity",
  "502",
  "503",
  "service unavailable",
  "bad gateway",
  "internal server error",
  "gateway timeout",
  "connection reset",
  "econnreset",
  "etimedout",
  "socket hang up",
  "econnrefused",
  "temporarily unavailable",
  "try again later",
];

export function isTransientError(message: string): boolean {
  const lc = message.toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => lc.includes(p));
}

/**
 * Whether an error message indicates the model seat's QUOTA is exhausted (a
 * 403 "weekly usage limit"/"quota" wall, e.g. kimi's 7-day limit), as opposed
 * to a retryable 429 rate limit. Quota exhaustion is fatal for the run's whole
 * lifetime — no retry within the same window will help — so it must surface as
 * a hard signal (the run stops/fails and tells a human to switch models), never
 * a silent inconclusive. Distinct from `isTransientError` on purpose: a rate
 * limit backs off and retries; a quota wall does not.
 */
const QUOTA_PATTERNS = [
  "usage limit",
  "weekly limit",
  "quota",
  "billing",
  "payment required",
  "plan limit",
  "insufficient balance",
  "resource exhausted",
];

export function isQuotaError(message: string): boolean {
  const lc = message.toLowerCase();
  return QUOTA_PATTERNS.some((p) => lc.includes(p));
}

/**
 * Issue #96: whether an errored tool call's error text is TIMEOUT-CLASS —
 * the tool server's own request ceiling ("Request timed out after 60000ms").
 * This is the degraded-target signal: a run of these across any tool/input
 * means the tool TARGET (a browser/app/MCP server) stopped answering, not
 * that the model is retrying a bad action (that is the spin guard's shape).
 * Vendor-neutral on purpose — matched as loose prose substrings, so the
 * exact wording of any MCP/tool server's timeout ("timed out", "timeout",
 * Node's ETIMEDOUT) classifies without coupling to one vendor.
 */
const TOOL_TIMEOUT_PATTERNS = [
  "timed out",
  "timeout",
  "etimedout",
];

export function isToolTimeout(message: string): boolean {
  const lc = message.toLowerCase();
  return TOOL_TIMEOUT_PATTERNS.some((p) => lc.includes(p));
}

/** The error text of an errored tool_use event, or null for any other line.
 * Issue #96: the degraded-target classifier reads `part.state.error` on
 * errored `tool_use` events — the tool-call error text already sitting in the
 * JSONL stream — not the provider-level `error` events `isTransientError`
 * sees (a timed-out tool call is a different failure surface, and its text
 * would not match the transient patterns anyway). Handles both a string error
 * and an object carrying a `message`. */
function toolUseErrorTextOf(line: string): string | null {
  if (!line.includes('"tool_use"')) return null;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev.type !== "tool_use") return null;
  const part = ev.part;
  if (!part || part.type !== "tool") return null;
  const state = part.state;
  if (!state || state.status !== "error") return null;
  const err = state.error;
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err && typeof err === "object" && typeof err.message === "string") return err.message;
  return null;
}

/**
 * A short, human-readable reason for a non-"ok" ExecResult, shared by every
 * caller (implementer, reviewer, planner, visual review) so a stall reads as
 * a stall everywhere, not as a bare "exited null" the way an untranslated
 * status would print for a killed-for-silence process. Callers prefix their
 * own subject ("implementer", "reviewer", ...).
 */
export function describeExecFailure(result: Pick<ExecResult, "status" | "steps" | "code" | "errorMessage">): string {
  if (result.status === "transient") return `hit a transient provider error (${result.errorMessage ?? "unknown"})`;
  if (result.status === "budget_exceeded") return `exceeded step budget (${result.steps} steps)`;
  if (result.status === "timeout") {
    // Issue #78: distinguish a model-time kill (server thrashing at 0 tok/s)
    // from a silence kill so callers can route each to the right response —
    // the model-time case wants a worker restart / slimmed re-implement, not
    // a retry of the same bloated context.
    if (result.errorMessage?.startsWith("model-stalled")) {
      return `stalled on model time — exceeded the model-time budget, killed`;
    }
    // Issue #96: a phase-wall-clock kill (whole-phase budget, any output).
    if (result.errorMessage?.startsWith("wall-clock:")) {
      return `exceeded its wall-clock budget and was killed`;
    }
    return `stalled with no output and was killed`;
  }
  if (result.status === "spin_loop") {
    if (result.errorMessage?.startsWith("non-convergent edit loop")) {
      return result.errorMessage;
    }
    return `stuck in a repeated identical tool-call loop`;
  }
  if (result.status === "degraded_target") {
    // The errorMessage carries the `degraded-target:` prefix so a caller can
    // distinguish a wedged interaction target (visual review retries it with
    // a recovery note, #96) from a generic incomplete.
    return result.errorMessage ?? `degraded tool target — a run of request timeouts, killed`;
  }
  if (result.status === "halted") {
    // gh #111: an honest stop, not a failure — the run loop records the reason
    // and marks the run `stopped`, it never feeds the failure ladder.
    return `halted on an agent-initiated stop signal (${result.errorMessage ?? "no reason given"})`;
  }
  return `exited ${result.code}`;
}
