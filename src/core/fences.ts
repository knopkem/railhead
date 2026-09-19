/**
 * Fence-aware transcript views (issue #108).
 *
 * A small model that quotes a protocol marker inside a code fence — "here is
 * the $GOAL_FAIL shape I was asked for" — must never fire the parser gating on
 * that marker. Every verdict/line-marker parser routes through the one
 * primitive here: fence regions (bare ``` or tagged ```lang, fence lines
 * included) are identified as [start, end) spans, and an occurrence filter
 * decides whether a marker match sits outside every span.
 *
 * Behaviour ported from siesta's `without_fences` (factory/pipeline/text.py),
 * not its code: an unclosed fence cuts to the end, fences with leading
 * whitespace count, a transcript without fences round-trips unchanged, and
 * nothing here throws.
 */

/** A fenced region's span: [start, end) over the raw text, fence lines
 *  included. `end` is text.length for an unclosed fence. */
export interface FenceRange {
  start: number;
  end: number;
}

/** A bare ``` fence line: backticks only, optional surrounding whitespace. */
const BARE_FENCE_RE = /^[ \t]*```[ \t]*$/;

/** A tagged ```lang fence line: a tag of word chars after the backticks. */
const TAGGED_FENCE_RE = /^[ \t]*```\w[\w+-]*[ \t]*$/;

function isBareFence(line: string): boolean {
  return BARE_FENCE_RE.test(line);
}

function opensFence(line: string): boolean {
  return isBareFence(line) || TAGGED_FENCE_RE.test(line);
}

/** The [start, end) spans of every fenced region in `text`, ascending. Fence
 *  lines and their content are inside the span; surrounding prose is outside.
 *  An unclosed fence (a dangling open with no closing ```) spans to the end of
 *  the text, so a truncated transcript never re-exposes a quoted marker. */
export function fenceRanges(text: string): FenceRange[] {
  const ranges: FenceRange[] = [];
  let openStart = -1;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (openStart < 0) {
      if (opensFence(line)) openStart = lineStart;
    } else if (isBareFence(line)) {
      ranges.push({ start: openStart, end: nl < 0 ? text.length : nl + 1 });
      openStart = -1;
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  if (openStart >= 0) ranges.push({ start: openStart, end: text.length });
  return ranges;
}

/** Cut every fenced region (fence lines and content), joining the surviving
 *  prose with newlines. The stripped view is a one-line adapter over
 *  `fenceRanges`; a transcript with no fences is returned unchanged. */
export function stripFencedRegions(text: string): string {
  const ranges = fenceRanges(text);
  if (ranges.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const r of ranges) {
    out += text.slice(cursor, r.start);
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

/** Whether the span [start, end) sits outside every fenced region (no
 *  overlap with any range). */
export function isOutsideFences(ranges: FenceRange[], start: number, end: number): boolean {
  for (const r of ranges) {
    if (start < r.end && end > r.start) return false;
  }
  return true;
}

/** Index of the first `re` match whose span sits outside every fenced region,
 *  or -1 when every occurrence is fenced. `re` is searched globally regardless
 *  of the flags it was built with. */
export function indexOfOutsideFences(text: string, re: RegExp): number {
  const global = re.global ? re : new RegExp(re.source, re.flags + "g");
  const ranges = fenceRanges(text);
  for (const m of text.matchAll(global)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (isOutsideFences(ranges, start, end)) return start;
  }
  return -1;
}

/** Index of the first `needle` occurrence at or after `fromIndex` that sits
 *  outside every fenced region, or -1. Literal, case-sensitive. */
export function indexOfLiteralOutsideFences(text: string, needle: string, fromIndex = 0): number {
  const ranges = fenceRanges(text);
  let idx = text.indexOf(needle, fromIndex);
  while (idx >= 0) {
    if (isOutsideFences(ranges, idx, idx + needle.length)) return idx;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return -1;
}

/** Index of the last `needle` occurrence that sits outside every fenced
 *  region, or -1. Literal, case-sensitive. */
export function lastIndexOfLiteralOutsideFences(text: string, needle: string): number {
  const ranges = fenceRanges(text);
  let last = -1;
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    if (isOutsideFences(ranges, idx, idx + needle.length)) last = idx;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return last;
}
