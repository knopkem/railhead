/**
 * Intra-ticket, inter-attempt handoff (issue #9).
 *
 * When an implementer attempt fails (verify or review returns blocking), the
 * next attempt used to receive the raw prior diff (`priorDiff`, 5-10k tokens
 * at the 64k budget) — eating ~10-15% of the next attempt's budget before it
 * has read a single new file. This module is the push-shaped replacement: the
 * failing implementer emits a `$HANDOFF ... $END` block as part of its
 * terminal wrap-up, the railhead parses it lossy, and passes it forward as
 * `prevHandoff` *instead of* the raw diff.
 *
 * Twin of `readLearnedMarkers` in learnings.ts: the same lossy-parse
 * discipline (line-start markers only, prose-wrapped markers ignored, NONE
 * sentinel treated as empty) is what makes a stressed small model's emission
 * trustworthy. ADR 0013's push-learnings outcome (5/5 push vs 0/5 pull on
 * the sharpen3 run) is the prior-art argument for push over pull here.
 *
 * Lifespan: one retry cycle (not durable like learnings, which are
 * per-project). The handoff is text on disk, read by the next phase — ADR
 * 0001's fresh-subprocess-per-phase is unchanged.
 */

import { stripFencedRegions } from "../core/fences.ts";

/** Marker the worker emits to open a handoff block. */
export const HANDOFF_START = "$HANDOFF";

/** Marker the worker emits to close a handoff block. */
export const HANDOFF_END = "$END";

/**
 * Extract the first complete `$HANDOFF ... $END` block from a worker
 * transcript. Lossy by design:
 *  - ignores a `$HANDOFF` with no closing `$END` (truncated mid-emission);
 *    the first *complete* pair wins, so a stressed model that opens, gets
 *    cut off, then retries still produces a usable handoff.
 *  - ignores the markers when they appear mid-prose (not at line start);
 *    the prompt tells the worker to emit them on their own lines, and a
 *    mid-sentence mention is the model narrating, not signalling.
 *  - treats `NONE` (case-insensitive) and empty content as "no handoff":
 *    the worker is told to omit the block entirely when it has nothing to
 *    say, but `NONE` is accepted as the explicit empty signal.
 *  - ignores a handoff the model quotes as an example inside a code fence
 *    (#108) — the fence view is applied before marker matching, so a fenced
 *    format echo never seeds the next attempt's handoff.
 *
 * Returns the trimmed block text (internal newlines preserved), or `null`
 * when no complete pair is present — so callers can fall back to the raw
 * `priorDiff` path when the model emits no handoff.
 */
export function readHandoffMarker(transcript: string): string | null {
  const text = stripFencedRegions(transcript);
  const lines = text.split("\n");
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim().toUpperCase();
    if (trimmed === HANDOFF_START.toUpperCase()) {
      // A new $HANDOFF opens. If a prior one was still open (no $END seen
      // before this point), it is abandoned — a stressed model that opened,
      // got cut off, then retried should yield the retry's handoff, not the
      // truncated open's bleed-through. This mirrors the "first complete
      // pair wins" intent: an unclosed open is not complete.
      openIdx = i;
    } else if (trimmed === HANDOFF_END.toUpperCase() && openIdx >= 0) {
      const block = lines
        .slice(openIdx + 1, i)
        .map((l) => l.trim())
        .join("\n")
        .trim();
      if (!block || block.toUpperCase() === "NONE") return null;
      return block;
    }
  }
  return null;
}
