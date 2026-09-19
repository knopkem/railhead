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

/**
 * The ticket named by the LAST `$CHECKPOINT` line in a transcript, or null
 * when no checkpoint line is present. Lossy by design:
 *  - a `$CHECKPOINT` line without a `ticket=` argument is a narration, not a
 *    signal — ignored;
 *  - the LAST matching line wins, so a stressed model that re-emits the marker
 *    mid-ramble still yields the terminal ticket number (matching what
 *    `readHandoffMarker`'s "first complete pair" does for handoffs, inverted
 *    here because a checkpoint is a single terminal line, not a block).
 */
export function readCheckpointTicket(transcript: string): string | null {
  let found: string | null = null;
  for (const line of transcript.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith(CHECKPOINT_START)) continue;
    const m = trimmed.match(TICKET_ARG_RE);
    if (m) found = m[1];
  }
  return found;
}

/** True when `text` ENDS with a valid checkpoint line — its last non-empty
 * line starts with `$CHECKPOINT` and names a ticket. This is the terminal
 * marker contract ("the marker on its own line as the LAST line") and it is
 * deliberately NOT the loose `CHECKPOINT_RE` substring match: a model that
 * quotes the format in prose ("Checkpoint format: `$CHECKPOINT ticket=NN` as
 * LAST line", "then emit `$CHECKPOINT ticket=03`") must not arm the executor's
 * boundary kill — those mentions killed productive mid-work generations. It
 * also stays unarmed for a marker written mid-message that the model then
 * keeps talking past. Mirrors what makes a checkpoint real to the gate
 * (`readCheckpointTicket`), anchored to the end of the accumulated text. */
export function endsWithCheckpoint(text: string): boolean {
  let last = -1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) last = i;
  }
  if (last < 0) return false;
  const line = lines[last].trim();
  if (!line.toUpperCase().startsWith(CHECKPOINT_START)) return false;
  return TICKET_ARG_RE.test(line);
}
