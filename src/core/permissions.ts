/**
 * Parse opencode's stderr "permission requested: ... auto-rejecting" lines.
 *
 * Why this exists: the snake-qwen run died silently because the implementer
 * kept trying to read termion source under ~/.cargo/registry/, opencode
 * auto-rejected every read with a one-line warning, and the implementer
 * burned its whole attempt budget retrying the same read. The railhead logged
 * each warning to <phase>.stderr.jsonl but never surfaced the pattern, so
 * the run looked like a slow implementation rather than a permissions policy
 * fighting it. This module makes the pattern visible at the run level.
 *
 * opencode emits the warning as:
 *   ! permission requested: <KIND> (<PATH>); auto-rejecting
 * possibly wrapped in ANSI color codes (yellow `!`).
 */

export interface PermissionRejection {
  kind: string;
  path: string;
}

export interface PermissionRejectionSummary {
  count: number;
  /** Distinct (kind, path) pairs, in first-seen order. */
  distinct: PermissionRejection[];
  /** One short human-readable line for the run log. Empty when count = 0. */
  summary: string;
}

const PERM_RE = /permission requested:\s*([a-zA-Z_]+)\s*\(([^)]+)\)\s*;\s*auto-rejecting/;

/** Strip ANSI color escapes so the regex can match the underlying text. */
function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

export function summarizePermissionRejections(lines: string[]): PermissionRejectionSummary {
  const distinct: PermissionRejection[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const raw of lines) {
    const m = PERM_RE.exec(stripAnsi(raw));
    if (!m) continue;
    count++;
    const kind = m[1];
    const path = m[2];
    const key = `${kind}|${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push({ kind, path });
    }
  }
  if (count === 0) return { count: 0, distinct: [], summary: "" };
  const label = distinct.length === 1
    ? `permission rejected (${distinct[0].kind}): ${distinct[0].path}`
    : `${count} permission rejections across ${distinct.length} distinct ${distinct[0].kind}(s) — first: ${distinct[0].path}`;
  return { count, distinct, summary: label };
}
