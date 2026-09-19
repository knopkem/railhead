/**
 * The blocked-exit marker contract of the durable-session builder (ADR 0040).
 *
 * The builder ends an invocation with `$BLOCKED ticket=NN kind=... reason=...`
 * when it cannot complete or verify a criterion and further attempts would be
 * thrashing. The executor watches the stream for the marker and stops the
 * child at the next step boundary exactly as it does for `$CHECKPOINT`
 * (`stopAfterBlocked`), so the structured signal survives in the transcript
 * instead of dying under the step budget.
 *
 * Grammar discipline is the twin of checkpoint.ts: line-start markers only,
 * the LAST complete signal wins, and the marker must END the accumulated text
 * for the executor to arm — a model quoting the format in prose must not stop
 * a productive generation. Lossy by design: an unknown `kind` degrades to the
 * conservative `implementation-stuck` (never the auto-committing
 * `verification-unavailable`), and a `$BLOCKED` line without a `ticket=`
 * argument is narration, not a signal.
 */

export type BlockKind = "verification-unavailable" | "implementation-stuck" | "plan-defect";

export const BLOCK_KINDS: readonly BlockKind[] = ["verification-unavailable", "implementation-stuck", "plan-defect"];

export interface BlockReport {
  /** The ticket the builder was working on. */
  ticket: string;
  kind: BlockKind;
  /** Free text: the criterion and why this seat cannot complete it. */
  reason: string;
  /** True when the model emitted a kind this railhead does not know — the
   * report was read conservatively as `implementation-stuck`. */
  malformedKind: boolean;
}

/** The marker the builder emits, on its own line, when it is blocked:
 * `$BLOCKED ticket=<number> ...`. */
export const BLOCKED_START = "$BLOCKED";

/** Detection regex for the executor's stream watcher. */
export const BLOCKED_RE = /\$BLOCKED\b/i;

/** Matches the `ticket=NN` (or `ticket: NN`) argument on a block line. */
const TICKET_ARG_RE = /ticket\s*[=:]\s*([A-Za-z0-9_.-]+)/i;

/** Matches the `kind=<kind>` (or `kind: <kind>`) argument. */
const KIND_ARG_RE = /kind\s*[=:]\s*([A-Za-z-]+)/i;

/** Everything after `reason=` (or `reason:`) to end of line is the reason. */
const REASON_ARG_RE = /reason\s*[=:]\s*([\s\S]*)$/i;

function lastBlockLine(text: string): string | null {
  let found: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.toUpperCase().startsWith(BLOCKED_START)) found = line;
  }
  return found;
}

/** Parse the LAST `$BLOCKED` line in a transcript, or null when none names a
 * ticket. Unknown kinds read as `implementation-stuck` with `malformedKind`
 * set, so a stressed model's typo can never trigger the auto-commit route. */
export function parseBlockReport(text: string): BlockReport | null {
  const line = lastBlockLine(text);
  if (!line) return null;
  const ticket = line.match(TICKET_ARG_RE)?.[1];
  if (!ticket) return null;
  const rawKind = line.match(KIND_ARG_RE)?.[1]?.toLowerCase();
  const known = BLOCK_KINDS.find((k) => k === rawKind);
  const reason = (line.match(REASON_ARG_RE)?.[1] ?? "").trim() || line;
  return {
    ticket,
    kind: known ?? "implementation-stuck",
    reason,
    malformedKind: known === undefined,
  };
}

/** True when `text` ENDS with a valid `$BLOCKED ticket=NN` line — its last
 * non-empty line starts with the marker and names a ticket. Anchored to the
 * end for the same reason `endsWithCheckpoint` is: a model that quotes the
 * format in prose must not arm the executor's boundary kill. */
export function endsWithBlockReport(text: string): boolean {
  let last: string | null = null;
  for (const raw of text.split("\n")) {
    if (raw.trim()) last = raw.trim();
  }
  if (!last || !last.toUpperCase().startsWith(BLOCKED_START)) return false;
  return TICKET_ARG_RE.test(last);
}
