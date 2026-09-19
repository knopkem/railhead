import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The agent-initiated halt signal (gh #111, borrowed from siesta's `stop.md`):
 * any phase subprocess can drop `.railhead/STOP` to conclude "this needs a
 * human before more work stacks." Its contents are the halt reason, free-form.
 * It lives under `.railhead/` (already git-ignored via RAILHEAD_IGNORES) and is
 * an honest-stop control — a `stopped` run, not a `failed` one (ADR 0003).
 */

export const HALT_DIR = ".railhead";
export const HALT_FILE_NAME = "STOP";

/** The halt file's absolute path for a project cwd. */
export function haltFilePath(cwd: string): string {
  return join(cwd, HALT_DIR, HALT_FILE_NAME);
}

/**
 * The halt file's trimmed contents when present, or `null` when absent. The
 * existence check + read are deliberately exception-swallowed: a race where
 * the file vanishes between the stat and the read is a clean "no halt", never
 * a throw that would take the executor's stream loop down with it.
 */
export function haltReason(cwd: string): string | null {
  try {
    const path = haltFilePath(cwd);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : "(no reason given)";
  } catch {
    return null;
  }
}

export interface HaltRefusal {
  path: string;
  reason: string;
}

/**
 * The resume refusal gate (gh #111): while the halt file exists, a resume must
 * refuse — otherwise a resumed run would either silently loop on the halt or
 * proceed past a foundation the halting agent called wrong. The operator
 * reviews the reason and deletes the file to acknowledge. Returns null when
 * there is nothing to refuse (no halt file), so the decision is a pure lookup.
 */
export function resumeRefusal(cwd: string): HaltRefusal | null {
  const reason = haltReason(cwd);
  if (reason === null) return null;
  return { path: haltFilePath(cwd), reason };
}
