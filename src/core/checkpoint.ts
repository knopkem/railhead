/**
 * The checkpoint marker contract of the durable-session builder (ADR 0022,
 * issue #84, stage S0.2).
 *
 * The builder ends a session invocation, when the current ticket's acceptance
 * criteria are met and the build/tests pass, by emitting a single line naming
 * the ticket it just finished; the executor watches the stream for the marker
 * and SIGTERMs the child at the next step boundary with status "ok" (the
 * `stopAfterCheckpoint` seam). Stopping at the marker instead of letting the
 * run hit its own step budget keeps the signal in the transcript — the same
 * #60 failure shape `stopAfterVerdict` was built for, applied to the builder's
 * terminal marker.
 *
 * Twin of handoff.ts: the same lossy-parse discipline (line-start markers
 * only, last complete signal wins) is what makes a stressed small model's
 * emission trustworthy. `$HANDOFF` travels between fresh attempts; the
 * `$CHECKPOINT` marker travels between durable-session invocations — it is the
 * seam the railhead's gate phases fire around.
 */

/** The marker the builder emits, on its own line, when a ticket is green:
 * `$CHECKPOINT ticket=<number>`. */
export const CHECKPOINT_START = "$CHECKPOINT";

/** Detection regex for the executor's stream watcher — fires as soon as the
 * marker text appears in the accumulated assistant output. */
export const CHECKPOINT_RE = /\$CHECKPOINT\b/i;

/** Matches the `ticket=NN` (or `ticket: NN`) argument on a checkpoint line. */
const TICKET_ARG_RE = /ticket\s*[=:]\s*([A-Za-z0-9_.-]+)/i;

/** Normalize the ticket number a marker names: `1` matches ticket `01`. A
 * non-numeric token (a slug, a placeholder) is left alone. */
function normalizeTicketNumber(raw: string): string {
  return /^\d+$/.test(raw) ? String(Number(raw)).padStart(2, "0") : raw;
}

/** The ticket named by a line that carries a `$CHECKPOINT` marker — at the
 * line start or trailing after prose ("all green — $CHECKPOINT ticket=01").
 * The marker must be followed by a ticket argument; a bare prose mention
 * ("I will emit a $CHECKPOINT when done") yields null. `normalizeTicketNumber`
 * makes `ticket=1` match `ticket=01` (the five wasted re-invocations observed
 * were marker-emission slips, not wrong tickets). */
function checkpointTicketOn(line: string): string | null {
  const idx = line.search(CHECKPOINT_RE);
  if (idx < 0) return null;
  const m = line.slice(idx).match(TICKET_ARG_RE);
  return m ? normalizeTicketNumber(m[1]) : null;
}

/**
 * The ticket named by the LAST `$CHECKPOINT` line in a transcript, or null
 * when no checkpoint line is present. Lossy by design:
 *  - a `$CHECKPOINT` line without a `ticket=` argument is a narration, not a
 *    signal — ignored;
 *  - the marker may begin the line or trail prose on it (v2 issue 01: a
 *    cheap model's "all green — $CHECKPOINT ticket=01" is a real signal, and
 *    rejecting it wasted a whole re-invocation);
 *  - `ticket=1` is normalized to `01`, so zero-padding drift never fails the
 *    expected-ticket comparison;
 *  - the LAST matching line wins, so a stressed model that re-emits the marker
 *    mid-ramble still yields the terminal ticket number.
 */
export function readCheckpointTicket(transcript: string): string | null {
  let found: string | null = null;
  for (const line of transcript.split("\n")) {
    const ticket = checkpointTicketOn(line);
    if (ticket) found = ticket;
  }
  return found;
}

/** True when `text` ENDS with a checkpoint line — its last non-empty line
 * carries a `$CHECKPOINT` marker and a ticket argument (leading or trailing on
 * the line). Anchored to the end of the accumulated text so a model that keeps
 * talking past a marker never arms the executor's boundary kill. */
export function endsWithCheckpoint(text: string): boolean {
  let last = -1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) last = i;
  }
  if (last < 0) return false;
  return checkpointTicketOn(lines[last].trim()) !== null;
}
