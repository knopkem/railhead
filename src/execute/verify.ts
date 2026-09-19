import { spawn } from "node:child_process";
import { once } from "node:events";

export interface VerifyResult {
  ok: boolean;
  outputs: string[];
  /** True when a command was killed for exceeding the timeout (included in `outputs`). */
  timedOut?: boolean;
}

/**
 * Default ceiling on a single verify command, in seconds. `runVerify` has no
 * bound of its own otherwise: an unattended, hours-long run has no human to
 * notice or kill a command that never exits (a test suite that starts a dev
 * server and doesn't return, an interactive prompt with nothing to answer
 * it). 10 minutes comfortably covers a real build/test command while still
 * failing a genuinely stuck one within the run's lifetime.
 */
export const DEFAULT_VERIFY_TIMEOUT_SEC = 600;

/** Run each command; a failure of any command fails the whole verify. */
export async function runVerify(
  cwd: string,
  commands: string[],
  timeoutSec?: number | null,
): Promise<VerifyResult> {
  const timeout = typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec : DEFAULT_VERIFY_TIMEOUT_SEC;
  const outputs: string[] = [];
  for (const cmd of commands) {
    const { code, out, timedOut } = await runShell(cwd, cmd, timeout);
    const suffix = timedOut ? `\n(killed: exceeded ${timeout}s timeout)` : "";
    outputs.push(`$ ${cmd}\n${out}${suffix}`);
    if (code !== 0) return { ok: false, outputs, timedOut };
  }
  return { ok: true, outputs };
}

function runShell(
  cwd: string,
  command: string,
  timeoutSec: number,
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // detached so a timeout can kill the whole process group, not just the
    // shell — a hung `npm test` typically has live grandchildren (a test
    // runner, a dev server it started) that survive killing only the shell.
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true });
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