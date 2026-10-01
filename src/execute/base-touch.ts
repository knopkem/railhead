import { RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";
import { nowClock } from "../cli/overview.ts";
import type { RunState } from "../core/state.ts";
import { baseSessionId } from "./base-session.ts";
import { executeOpendCode } from "./executor.ts";

/**
 * The base session's KV-prefix keep-warm (issue #133 follow-up).
 *
 * The base session is created ONCE per run and then only ever read: every
 * fresh phase forks it. On an openai-compatible server with an LRU prefix
 * cache that is a trap. Nothing re-sends the base's `[system][preamble]`
 * after creation, so its entry ages out of the cache while the run spends
 * hours inside builder contexts that grow to tens of thousands of tokens.
 * The next phase then forks a prefix the server no longer holds and pays a
 * full cold prefill for it — which is exactly what the phase telemetry shows
 * (`firstStepCache.cached === 0` on most phase starts) even though the base
 * session itself is alive and the fork succeeds.
 *
 * The fix is a re-touch, not a longer-lived process: a trivial forked call
 * that ends in the same deterministic `READY` acknowledgement re-sends the
 * prefix and re-inserts it into the cache, so the next real phase finds it
 * hot. It is independent of `persistent_worker` (a process-pool setting) and
 * costs one tiny request per interval.
 *
 * Everything here fails OPEN. A touch that cannot run is logged and forgotten:
 * it never mutates `state.base_session`, never recreates a base, never
 * disturbs the `ensureBaseSession` memo, and never fails a phase. The prefix
 * is an optimization, never a prerequisite.
 */

/** The same deterministic turn-ender the base conversation was created with,
 * so a touch extends the prefix with text the fork already knows instead of
 * new content. */
const BASE_ACK = "Reply with just: READY";

/** Touches get their own ledger stream. `base-session.jsonl` is the record of
 * the ONE conversation that defines the run's prefix; folding routine
 * keep-warm calls into it would make that record unreadable, and a failed
 * touch would sit inside the creation's transcript. */
export const BASE_TOUCH_PHASE_FILE = "base-touch";

/** How long a touch keeps the prefix resident in practice. The observed run
 * that motivated this had its base created at startup and forked again hours
 * later, cold — the entry does not survive a run's builder traffic on its
 * own. The interval is therefore a compromise, not a tuned constant: long
 * enough that the per-ticket call sites almost always no-op, short enough
 * that a base is warm again within one phase of the phases that fork it. */
export const BASE_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

export interface BaseTouchArgs {
  state: RunState;
  ledger: string;
  model: string | null;
  contextTokens: number | null;
  /** Bypass the interval. Reserved for the resume path, where the base on the
   * state predates this process and nothing is known about its cache
   * residency — a touch there is worth one call even minutes after the last. */
  force?: boolean;
}

/** One touch decision per RunState per process. The timestamp is written
 * BEFORE the call so a provider that hangs or throws still cannot be
 * re-probed in a tight loop by the next phase. */
const touched = new WeakMap<RunState, number>();

/** Whether a touch is due. Pure so the policy — not the process spawn — is
 * what the tests pin: no base, or a touch inside the interval, is a no-op. */
export function touchDue(lastTouchedMs: number | null, nowMs: number, intervalMs = BASE_TOUCH_INTERVAL_MS): boolean {
  if (lastTouchedMs === null) return true;
  return nowMs - lastTouchedMs >= intervalMs;
}

/** Record that the base prefix is warm as of now, without spending a request.
 * Called right after `ensureBaseSession` creates the base: that creation
 * response IS the prefix's insertion into the cache, so touching again
 * immediately would be a wasted model call. Without this the first
 * `keepBaseWarm` would always fire one interval's worth of too early. */
export function markBaseWarm(state: RunState, nowMs: number = Date.now()): void {
  touched.set(state, nowMs);
}

/**
 * Re-touch the run's base session when the interval has elapsed, so the next
 * phase that forks it finds a resident prefix instead of re-prefilling one.
 *
 * Uses the same fork shape a real phase uses (`--session <base> --fork` plus
 * one task message) so the cached prefix is byte-identical to the one the
 * phases inherit. `maxSteps: 3` is a floor, not a target: an all-tools-denied
 * `READY` acknowledgement is a single step.
 */
export async function keepBaseWarm(args: BaseTouchArgs): Promise<void> {
  const { state, ledger } = args;
  const id = baseSessionId(state);
  if (id === null) return;

  const now = Date.now();
  if (args.force !== true && !touchDue(touched.get(state) ?? null, now)) return;
  touched.set(state, now);

  try {
    const result = await executeOpendCode(BASE_ACK, {
      cwd: state.cwd,
      ledgerDir: ledger,
      phaseFile: BASE_TOUCH_PHASE_FILE,
      model: args.model,
      agent: RAILHEAD_AGENT_NAMES.base,
      session: id,
      fork: true,
      task: BASE_ACK,
      maxSteps: 3,
      stallTimeoutSec: state.config.stall_timeout_sec,
      maxStepModelSec: state.config.max_step_model_sec,
      maxContextTokens: args.contextTokens,
      live: false,
      heartbeat: false,
    });

    if (result.status !== "ok") {
      console.log(`[${nowClock()}] base session keep-warm skipped (${result.status})`);
      return;
    }
    const cache = result.firstStepCache;
    const total = cache ? cache.cold + cache.cached : 0;
    const bit = cache ? ` (${cache.cached}/${total} prefix tokens cached)` : "";
    console.log(`[${nowClock()}] base session keep-warm ok${bit}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[${nowClock()}] base session keep-warm skipped (${message})`);
  }
}
