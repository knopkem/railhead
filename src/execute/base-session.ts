import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { renderPreamble, renderTask } from "../context/preamble.ts";
import { readPreambleDoc } from "../context/prompt.ts";
import { writeState } from "../core/ledger.ts";
import type { RunState } from "../core/state.ts";
import { RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";
import { nowClock } from "../cli/overview.ts";
import { executeOpendCode } from "./executor.ts";

/**
 * The base session (ADR 0020 amendment, issue #133): one conversation whose
 * only content is `[shared system][canonical preamble]`, created once per run.
 * Every fresh phase forks it (`opencode run --session <base> --fork`) and
 * sends ONLY its volatile task message, so each phase starts from the shared
 * prefix and nothing else — fresh context preserved, prefill shared.
 *
 * The session is created through a dedicated all-tools-denied agent because
 * the base call must have no side effects. `opencode run` accepts one message
 * per invocation, so the preamble and the acknowledgement that ends the turn
 * share message 1; a fork still shares the whole exchange before its task.
 *
 * Everything here fails OPEN: a base that cannot be created, validated, or
 * forked leaves `base_session` null and the phases run the ADR 0001 joined
 * prompt. The prefix is an optimization, never a prerequisite.
 */
export const BASE_PHASE_FILE = "base-session";

/** The deterministic turn-ender that keeps the base reply one token. */
const BASE_ACK = "Reply with just: READY";
const ALIVE_TIMEOUT_MS = 15_000;

/**
 * One base creation attempt per RunState per process. A failed creation is
 * remembered so a failing provider is not re-probed by every phase ("never
 * loop on it"); a resume is a new process and may try again.
 */
const attempted = new WeakMap<RunState, string | null>();

export function baseSessionId(state: RunState): string | null {
  return state.base_session?.session_id ?? null;
}

/** The executor arguments a fresh phase uses under the run's base session:
 * fork it and send ONLY the volatile `task` message, so the phase begins from
 * the shared `[system][preamble]` prefix and sees no sibling phase's
 * transcript. No base (creation failed, an older opencode without `--fork`, or
 * a session that vanished) returns null fields — the phase runs the ADR 0001
 * joined prompt instead. */
export function forkPhase(state: RunState, task: string): { session: string | null; fork: boolean; task: string | null } {
  const id = baseSessionId(state);
  return id ? { session: id, fork: true, task } : { session: null, fork: false, task: null };
}

export interface BaseSessionArgs {
  state: RunState;
  ledger: string;
  model: string | null;
  contextTokens: number | null;
  /** Test seam for the persisted-session liveness check. */
  isSessionAlive?: (sessionId: string) => Promise<boolean>;
}

/** The canonical preamble's stable inputs, resolved from the repo. Missing
 * docs render an explicit placeholder (same shape the prompt builders use) so
 * "checked and absent" is distinguishable from "not an input", and so the
 * hash is stable across renders. */
async function canonicalPreamble(state: RunState): Promise<string> {
  const [agents, context, design, architecture, coherence] = await Promise.all([
    readPreambleDoc(state.cwd, "AGENTS.md"),
    readPreambleDoc(state.cwd, "CONTEXT.md"),
    readPreambleDoc(state.cwd, "docs/design.md"),
    readPreambleDoc(state.cwd, "docs/architecture.md"),
    readPreambleDoc(state.cwd, "docs/coherence.md"),
  ]);
  return renderPreamble({
    mission: state.original_prompt ?? null,
    agents,
    context,
    design,
    architecture,
    coherence,
  });
}

export function preambleHash(preamble: string): string {
  return createHash("sha256").update(preamble).digest("hex");
}

/** Whether opencode still knows this session. `opencode export` reads local
 * storage only (no model call) and exits non-zero for an unknown id. A missing
 * binary or a hung export reads as not-alive — both mean "recreate". */
async function sessionAlive(sessionId: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(alive);
    };
    const child = spawn("opencode", ["export", sessionId], { stdio: "ignore" });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done(false);
    }, ALIVE_TIMEOUT_MS);
    child.on("close", (code) => done(code === 0));
    child.on("error", () => done(false));
  });
}

/**
 * Resolve the run's base session, creating or rebuilding it when needed:
 * absent → create; persisted but its inputs changed (docs hash mismatch) or
 * the session no longer exists → rebuild; valid → reuse. Never throws and
 * never returns a session the run cannot use — null means the phases take the
 * joined-prompt path.
 */
export async function ensureBaseSession(args: BaseSessionArgs): Promise<string | null> {
  const { state, ledger } = args;
  const memo = attempted.get(state);
  if (memo !== undefined) return memo;

  try {
    const preamble = await canonicalPreamble(state);
    const hash = preambleHash(preamble);
    const existing = state.base_session;
    if (existing && existing.preamble_hash === hash) {
      const alive = await (args.isSessionAlive ?? sessionAlive)(existing.session_id);
      if (alive) {
        attempted.set(state, existing.session_id);
        return existing.session_id;
      }
      console.log(`[${nowClock()}] base session ${existing.session_id.slice(0, 8)} is gone — recreating`);
    } else if (existing) {
      console.log(`[${nowClock()}] base session: preamble inputs changed — rebuilding`);
    }

    const result = await executeOpendCode(renderTask([preamble, BASE_ACK]), {
      cwd: state.cwd,
      ledgerDir: ledger,
      phaseFile: BASE_PHASE_FILE,
      model: args.model,
      agent: RAILHEAD_AGENT_NAMES.base,
      maxSteps: 3,
      stallTimeoutSec: state.config.stall_timeout_sec,
      maxStepModelSec: state.config.max_step_model_sec,
      maxContextTokens: args.contextTokens,
      live: false,
      heartbeat: false,
    });

    if (result.status !== "ok" || !result.sessionId) {
      console.log(`[${nowClock()}] base session unavailable (${result.status}) — phases run fresh without the shared prefix`);
      attempted.set(state, null);
      return null;
    }

    state.base_session = {
      session_id: result.sessionId,
      preamble_hash: hash,
      created_at: new Date().toISOString(),
    };
    await writeState(ledger, state);
    const cache = result.firstStepCache;
    const cacheBit = cache ? ` (${cache.cached}/${cache.cold + cache.cached} first-step tokens cached)` : "";
    console.log(`[${nowClock()}] base session ${result.sessionId.slice(0, 8)} ready${cacheBit}`);
    attempted.set(state, result.sessionId);
    return result.sessionId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[${nowClock()}] base session unavailable (${message}) — phases run fresh without the shared prefix`);
    attempted.set(state, null);
    return null;
  }
}
