import { appendEvent } from "../core/ledger.ts";
import * as git from "../core/git.ts";
import { nowClock } from "../cli/overview.ts";

/**
 * Run a phase whose seat has no write tools, and record any worktree change it
 * made anyway. The contracts update already refuses to let a tooling commit
 * claim out-of-scope work; this generalizes the detection to every
 * write-denied phase, at the moment the phase ends — before a later builder
 * commit could sweep the change into the ticket.
 *
 * It records (console warning + a `worktree.changed` event in the phase's
 * ledger) and never commits or reverts: a write here is an anomaly to surface,
 * not a failure to retry. The check runs in `finally`, so a phase that throws
 * after mutating the tree is still recorded.
 */
export async function guardReadOnlyPhase<T>(
  cwd: string,
  ledger: string,
  phaseFile: string,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  const before = await git.worktreeFingerprint(cwd);
  try {
    return await run();
  } finally {
    const after = await git.worktreeFingerprint(cwd);
    if (after !== before) {
      const paths = await git.dirtyPaths(cwd).catch(() => [] as string[]);
      const shown = paths.slice(0, 5).join(", ");
      const message = `${label} is write-denied but changed the worktree: ${shown || "(paths unavailable)"}`;
      console.warn(`[${nowClock()}] ⚠ ${message}`);
      await appendEvent(ledger, phaseFile, JSON.stringify({ type: "worktree.changed", timestamp: Date.now(), label, paths })).catch(() => {});
    }
  }
}
