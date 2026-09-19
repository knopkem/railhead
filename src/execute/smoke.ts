import { spawn } from "node:child_process";
import { once } from "node:events";
import type { VerifyResult } from "./verify.ts";

/**
 * Default ceiling on a single smoke (binary-launch) command, in seconds.
 * Tighter than `DEFAULT_VERIFY_TIMEOUT_SEC`: a smoke run that hasn't crashed
 * or moved decisively past startup in ~30s has usually reached a steady
 * state (a server listening, a game in its main loop with no panic), and
 * a longer cap just lets a hung GUI loop eat the run's clock. `runSmoke`
 * treats reaching the timeout while still running as a SUCCESS (the app
 * didn't panic) and SIGTERMs it — the point is "does it start?", not "does
 * it finish?" (a GUI never finishes).
 */
export const DEFAULT_SMOKE_TIMEOUT_SEC = 30;

/**
 * Substrings whose presence in a smoke run's stdout/stderr is itself a
 * failure, even if the process exits 0 (some apps catch a panic and limp on,
 * or a shell wrapper masks the exit code). Matched case-sensitive against
 * the Rust/Bevy panic line shape — broad patterns risk false positives, so
 * each entry is deliberately narrow to a real panic signature.
 */
export const SMOKE_PANIC_SIGNATURES = [
  "thread 'main' panicked at",
  "thread '<unnamed>' panicked at",
  "Encountered a panic in system",
] as const;

/**
 * Substrings whose presence in a smoke run's stdout/stderr signals that the
 * command itself doesn't exist — not a code defect. npm prints "Missing script"
 * when a package.json script is absent; other package managers print
 * "command not found" or "not found" in the shell. Exit 127 is the shell's
 * numeric signal for the same condition. When this fires, the smoke phase
 * is "not found" (skippable) rather than "failed" (retryable).
 */
export const SMOKE_NOT_FOUND_SIGNATURES = [
  "Missing script:",
  "command not found",
  "not found",
  "No such file or directory",
] as const;

export interface SmokeInput {
  /** The launch command, as the planner emitted it (`cargo run`, `npm start`). */
  command: string;
  /** Headless env to inject (e.g. `{ NO_VIDEO: "1" }` for Bevy). Merged onto
   * `process.env` — never replaces it, so PATH and friends stay intact. */
  env?: Record<string, string>;
}

/**
 * Run one smoke command. Three failure modes:
 *
 * 1. The process exits non-zero (a startup panic, a missing binary, a port
 *    clash) — reported as `ok: false`, no `timedOut`.
 * 2. A panic signature (see `SMOKE_PANIC_SIGNATURES`) appears in the captured
 *    output — reported as `ok: false` with `panic: true`, even if the
 *    process later exits 0. This is the Bevy B0001 case: the panic prints to
 *    stderr, and the process exits non-zero anyway, but the signature check
 *    makes us fail fast on the FIRST flush rather than waiting for the
 *    process tree to tear itself down.
 * 3. The process exceeds `timeoutSec` without exiting — `ok: true`, `timedOut:
 *    true`. This is the success case: a GUI/server that's still running
 *    after 30s reached its main loop without panicking. We SIGTERM the
 *    process group and report success.
 *
 * Returns the same `VerifyResult` shape (plus an extra `panic` flag) so the
 * phase's ledger/log handling mirrors verify's.
 */
export interface SmokeResult extends VerifyResult {
  /** True when a panic signature was found in the output (independent of exit
   * code or timeout). The phase failed for panic-reasons specifically. */
  panic?: boolean;
  /** True when the command was not found — exit code 127, or the output
   * contains a "Missing script" / "command not found" pattern. This is NOT
   * a code defect: on early tickets the smoke command's feature hasn't been
   * built yet. The run loop skips retrying implement in this case. */
  notFound?: boolean;
}

export async function runSmoke(
  cwd: string,
  input: SmokeInput,
  timeoutSec?: number | null,
): Promise<SmokeResult> {
  const timeout = typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec : DEFAULT_SMOKE_TIMEOUT_SEC;
  const env = { ...process.env, ...(input.env ?? {}) };
  const { code, out, timedOut } = await runShellWithEnv(cwd, input.command, env, timeout);
  const panic = SMOKE_PANIC_SIGNATURES.some((sig) => out.includes(sig));
  const notFound = code === 127 || (code !== 0 && !timedOut && SMOKE_NOT_FOUND_SIGNATURES.some((sig) => out.includes(sig)));

  if (panic) {
    return { ok: false, outputs: [`$ ${input.command}\n${out}`], panic: true };
  }
  if (notFound) {
    return { ok: false, outputs: [`$ ${input.command}\n${out}`], notFound: true };
  }
  if (code !== 0 && !timedOut) {
    return { ok: false, outputs: [`$ ${input.command}\n${out}`] };
  }
  // timedOut means the process was still running at the wall-clock ceiling —
  // for a smoke phase, that's success (the app started and stayed up). Signal
  // the kill in the output so a reader isn't confused by the missing natural
  // exit line.
  const suffix = timedOut ? `\n(killed: still running at ${timeout}s — smoke treats this as success)` : "";
  return { ok: true, outputs: [`$ ${input.command}\n${out}${suffix}`], timedOut };
}

/**
 * Same kill-the-process-group discipline as `runShell` in verify.ts (a hung
 * GUI has live grandchildren — render threads, audio threads — that survive
 * killing only the shell). Differs only in attaching `env` to the spawn,
 * which verify.ts doesn't need (its commands inherit process.env verbatim).
 */
function runShellWithEnv(
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutSec: number,
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, timeoutSec * 1000);
    child.stdout?.on("data", (b) => (out += b.toString()));
    child.stderr?.on("data", (b) => (out += b.toString()));
    once(child, "close").then(([code]) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, out, timedOut });
    });
  });
}
