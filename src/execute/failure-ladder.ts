import type { ExecStatus } from "./executor.ts";
import { isAbortRequested } from "./stop.ts";

/**
 * Issue #80: the escalating failure-response ladder. Classification is
 * inverted from "predict whether a retry helps, once, correctly" to
 * "respond-and-learn" — each rung is both an intervention and a probe, so a
 * misclassification costs one cheap extra step instead of hours of futile
 * identical retries.
 *
 * The classification core (`classifyFailure`, `nextRung`) is pure and decides
 * WHAT to do; `withFailureLadder` performs the retries, worker restarts, and
 * backoff sleeps around it, with I/O only at the injected edges.
 */

export type FailureClass = "fatal-config" | "capacity" | "server-state" | "blip" | "diagnosed";

/** The subset of a phase result the ladder reads. Deliberately decoupled from
 * `ExecResult` so the pure core never imports more than the status type. */
export interface FailureEvidence {
  status: ExecStatus;
  errorMessage: string | null;
  /** Peak input tokens across completed steps — the request-size signal the
   * capacity gate reads. Zero-output shapes report the pre-failure peak. */
  peakTokens: number;
  steps: number;
  toolCalls: number;
  code: number | null;
  signal: string | null;
  durationMs: number;
}

export interface LadderRung {
  rung: 1 | 2 | 3;
  action: "retry" | "restart-worker-then-retry" | "capacity-fail" | "hard-fail";
  backoffSec: number;
  diagnosis: string;
  /** The class this rung represents (persisted on the ticket for resume + report). */
  class: FailureClass;
}

/** Unambiguous config errors where an identical retry is provably futile. This
 * list errs toward STOPPING (the inverse of the old transient denylist, which
 * erred toward retrying) — an unmatched wording falls through to the ladder
 * default rather than being misrouted. */
const FATAL_CONFIG_PATTERNS = ["invalid api key", "authentication", "model not found"];

/** Capacity wording — a secondary signal (checked after the peak-token gate)
 * that a failure is a request-size problem, not a code problem. */
const CAPACITY_PATTERNS = [
  "insufficient memory",
  "gpu memory",
  "memory pressure",
  "context too long",
  "contextoverflowerror",
];

/** Fraction of the request ceiling at which a phase is treated as capacity-
 * limited. `peakTokens` is a reliable number the railhead already tracks, so
 * using it here is not brittle. */
export const CAPACITY_PEAK_FRACTION = 0.9;

/** Backoff per rung when the wrapper does not supply its own schedule (rung 3
 * is terminal — zero backoff). Mirrors `infra_backoff_sec`'s leading entries. */
const DEFAULT_BACKOFF_SEC = [5, 15, 0];

function matches(message: string, patterns: string[]): boolean {
  const lc = message.toLowerCase();
  return patterns.some((p) => lc.includes(p));
}

function isCapacity(evidence: FailureEvidence, budget: number): boolean {
  if (evidence.peakTokens >= budget * CAPACITY_PEAK_FRACTION) return true;
  return matches(evidence.errorMessage ?? "", CAPACITY_PATTERNS);
}

/** Evidence-driven classification. Only three classes are evidence-driven —
 * `server-state` and `diagnosed` emerge from the attempt count in `nextRung`,
 * not from any single failure's prose. */
export function classifyFailure(evidence: FailureEvidence, budget: number): FailureClass {
  const message = evidence.errorMessage ?? "";
  if (matches(message, FATAL_CONFIG_PATTERNS)) return "fatal-config";
  if (isCapacity(evidence, budget)) return "capacity";
  return "blip";
}

/** Compose ladder evidence from an `ExecResult`-shaped value. The executor
 * already embeds `evidence`, but mocks and partial results omit it — callers
 * build one here instead of re-deriving the seven fields. */
export function evidenceFromResult(result: {
  status: ExecStatus;
  errorMessage: string | null;
  peakTokens: number;
  steps: number;
  toolCalls: number;
  code: number | null;
  signal: string | null;
  durationMs: number;
}): FailureEvidence {
  return {
    status: result.status,
    errorMessage: result.errorMessage,
    peakTokens: result.peakTokens,
    steps: result.steps,
    toolCalls: result.toolCalls,
    code: result.code,
    signal: result.signal,
    durationMs: result.durationMs,
  };
}

function summarizeHistory(history: FailureEvidence[], current: FailureEvidence): string {
  const fmt = (n: number) => `${Math.round(n / 1000)}k`;
  const peaks = [...history.map((e) => fmt(e.peakTokens)), fmt(current.peakTokens)].join("→");
  return `${history.length + 1} attempts, peaks ${peaks}`;
}

/**
 * The next rung for a phase that failed on its `attempt`-th try (1-based).
 * `history` is the prior failures (excluding `evidence`); it feeds the rung-3
 * diagnosis so a terminal failure reports what the retries actually did.
 *
 *   attempt 1 → rung 1 retry (identical)
 *   attempt 2 → rung 2 restart-worker-then-retry
 *   attempt ≥ 3 → rung 3 terminal (capacity-fail or hard-fail)
 *
 * Capacity and fatal-config short-circuit the ladder from rung 1 — an OOM at
 * high context is a request-size problem (shrink the prompt), not a retry.
 */
export function nextRung(
  evidence: FailureEvidence,
  attempt: number,
  budget: number,
  history: FailureEvidence[],
): LadderRung {
  const cls = classifyFailure(evidence, budget);
  if (cls === "fatal-config") {
    return {
      rung: 3,
      action: "hard-fail",
      backoffSec: 0,
      diagnosis: `fatal configuration error (${evidence.errorMessage ?? "unknown"}) — retry would not help`,
      class: "fatal-config",
    };
  }
  if (cls === "capacity") {
    const peakGate = evidence.peakTokens >= budget * CAPACITY_PEAK_FRACTION;
    return {
      rung: 3,
      action: "capacity-fail",
      backoffSec: 0,
      diagnosis: peakGate
        ? `capacity failure: peak ${evidence.peakTokens} tokens is at/above ${Math.round(CAPACITY_PEAK_FRACTION * 100)}% of the ${budget}-token budget — the request is too large, not the code`
        : `capacity failure: capacity wording matched (${evidence.errorMessage ?? "unknown"}) — the request is too large, not the code`,
      class: "capacity",
    };
  }
  if (attempt <= 1) {
    return {
      rung: 1,
      action: "retry",
      backoffSec: DEFAULT_BACKOFF_SEC[0],
      diagnosis: `transient failure (${evidence.errorMessage ?? "no output"}) — retrying identically`,
      class: "blip",
    };
  }
  if (attempt === 2) {
    return {
      rung: 2,
      action: "restart-worker-then-retry",
      backoffSec: DEFAULT_BACKOFF_SEC[1],
      diagnosis: `server-state failure after ${history.length + 1} attempts — restarting the worker and retrying`,
      class: "server-state",
    };
  }
  return {
    rung: 3,
    action: "hard-fail",
    backoffSec: 0,
    diagnosis: `diagnosed after ${history.length + 1} attempts (${summarizeHistory(history, evidence)}) — not capacity, not config: model or server failure`,
    class: "diagnosed",
  };
}

/** An error a phase throws to carry its ladder evidence back to
 * `withFailureLadder`. Stage 4's implementer path wraps a failed `ExecResult`
 * in one of these instead of throwing a bare string, so the ladder can read
 * structural evidence rather than parse prose. */
export class PhaseFailure extends Error {
  readonly evidence: FailureEvidence;
  constructor(evidence: FailureEvidence) {
    super(evidence.errorMessage ?? `phase failed (${evidence.status})`);
    this.name = "PhaseFailure";
    this.evidence = evidence;
  }
}

function evidenceFromThrow(err: unknown): FailureEvidence {
  if (err instanceof PhaseFailure) return err.evidence;
  const message = err instanceof Error ? err.message : String(err);
  return { status: "error", errorMessage: message, peakTokens: 0, steps: 0, toolCalls: 0, code: null, signal: null, durationMs: 0 };
}

export interface FailureLadderOptions {
  /** Per-rung delays in seconds (rung 1 / rung 2), from `infra_backoff_sec`. */
  backoff: number[];
  /** The request ceiling the capacity gate reads against. */
  budget: number;
  /** Restart the persistent worker. A no-op here degrades rung 2 to a long
   * backoff (the standalone-mode behaviour). */
  restartWorker: () => Promise<void>;
  /** Injectable for tests. Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each rung's intervention, for the live line. */
  onRung?: (rung: LadderRung, evidence: FailureEvidence) => void;
  /** Start at this attempt (1-based) instead of 1 — a resume re-enters at the
   * persisted rung so a deterministic failure doesn't replay rung 1 forever. */
  startAttempt?: number;
}

export type FailureLadderResult<T> =
  | { ok: true; value: T }
  | { ok: false; rung: LadderRung; evidence: FailureEvidence[] };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a phase through the 3-rung ladder. The phase resolves T on success and
 * throws (ideally a `PhaseFailure`) on failure. Each failure is classified;
 * rung 1 retries identically, rung 2 restarts the worker then retries, rung 3
 * (and the capacity / fatal-config short-circuits) stop and return the verdict
 * with the accumulated evidence. Hard-bounded: at most three phase invocations.
 */
export async function withFailureLadder<T>(
  runPhase: () => Promise<T>,
  options: FailureLadderOptions,
): Promise<FailureLadderResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const history: FailureEvidence[] = [];
  let attempt = options.startAttempt ?? 1;
  for (;;) {
    try {
      const value = await runPhase();
      return { ok: true, value };
    } catch (err) {
      const evidence = evidenceFromThrow(err);
      const rung = nextRung(evidence, attempt, options.budget, history);
      // An operator abort (Ctrl-C / SIGTERM on a standalone phase, or a hard
      // stop) overrides the retry rungs: the process is ending, so a retry is
      // never the right response — it logs a misleading "retrying identically"
      // and can spawn a child inside the exit window.
      const decided: LadderRung = isAbortRequested() && rung.action !== "capacity-fail" && rung.action !== "hard-fail"
        ? { ...rung, rung: 3, action: "hard-fail", backoffSec: 0, diagnosis: `operator stop — not retrying (${evidence.errorMessage ?? "phase interrupted"})` }
        : rung;
      options.onRung?.(decided, evidence);
      if (decided.action === "capacity-fail" || decided.action === "hard-fail") {
        return { ok: false, rung: decided, evidence: [...history, evidence] };
      }
      history.push(evidence);
      if (decided.action === "restart-worker-then-retry") await options.restartWorker();
      const delaySec = options.backoff[decided.rung - 1] ?? decided.backoffSec;
      await sleep(delaySec * 1000);
      attempt++;
    }
  }
}

/** Adapt a legacy string-throwing phase (the pre-ladder shape — it throws a
 * string/Error on failure, with no structured evidence) to the ladder. A
 * thrown message becomes a synthesized `FailureEvidence` (peak unknown → 0), so
 * fatal-config and capacity *wording* still classify; only the peak-token
 * capacity gate is unavailable. Used by the non-implementer phases (planner,
 * reviewer, contracts, visual) whose failure surface is a thrown string. */
export async function withFailureLadderOnThrow<T>(
  runPhase: () => Promise<T>,
  options: FailureLadderOptions,
): Promise<FailureLadderResult<T>> {
  return withFailureLadder(
    async () => {
      try {
        return await runPhase();
      } catch (err) {
        throw new PhaseFailure({
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          peakTokens: 0,
          steps: 0,
          toolCalls: 0,
          code: null,
          signal: null,
          durationMs: 0,
        });
      }
    },
    options,
  );
}
