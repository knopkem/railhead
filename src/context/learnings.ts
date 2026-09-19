import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeExecFailure, executeOpendCode } from "../execute/executor.ts";
import { extractAssistantText } from "../core/ledger.ts";
import { contextBudget } from "../config/config.ts";
import type { RunState } from "../core/state.ts";
import { stripFencedRegions } from "../core/fences.ts";

/** The char budget for the learnings file. At ~2,200 chars (~800 tokens),
 * it's negligible vs the 50k+ tokens a phase already uses, while forcing
 * consolidation to be selective when the file fills. See ADR 0013. */
export const LEARNINGS_CHAR_LIMIT = 2200;

/** The path to the per-project learnings file. Per-project (not per-run): a
 * Pong build's learnings survive into a Pong fix run, but don't leak into a
 * TypeScript project. See ADR 0012. */
export function learningsPath(cwd: string): string {
  return join(cwd, ".railhead", "learnings.md");
}

/** Read the learnings file. Returns null if absent or empty. */
export async function readLearnings(cwd: string): Promise<string | null> {
  const path = learningsPath(cwd);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf8");
  return content.trim() || null;
}

/** Append new learnings to the file. Creates the file if absent. Enforces the
 * char budget itself (issue #68): when the merged result would exceed
 * `LEARNINGS_CHAR_LIMIT`, the OLDEST lines are evicted deterministically (no
 * model call) so the newest facts survive. This is the safety net for every
 * caller — previously the only budget gate sat behind `model.extract !==
 * null`, so configs without an extract model grew learnings.md unbounded. */
export async function appendLearnings(cwd: string, newLearnings: string): Promise<void> {
  const path = learningsPath(cwd);
  const existing = await readLearnings(cwd);
  const merged = existing
    ? existing + "\n" + newLearnings.trim()
    : newLearnings.trim();
  const bounded = evictOldestToFit(merged, LEARNINGS_CHAR_LIMIT);
  await mkdir(join(cwd, ".railhead"), { recursive: true });
  await writeFile(path, bounded + "\n", "utf8");
}

/** Deterministic FIFO eviction: drop the oldest (top) lines of `content`
 * until the result fits `limit`, keeping the newest facts (learnings are
 * appended chronologically). If a single over-long line remains, the tail of
 * that line is kept. Pure — used by `appendLearnings` and tested directly so
 * the no-model truncation path is a first-class behavior (issue #68). */
export function evictOldestToFit(content: string, limit: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= limit) return trimmed;
  let lines = trimmed.split("\n");
  while (lines.length > 1 && lines.join("\n").length > limit) {
    lines = lines.slice(1);
  }
  let out = lines.join("\n");
  if (out.length > limit) {
    out = out.slice(out.length - limit);
    const nl = out.indexOf("\n");
    if (nl >= 0) out = out.slice(nl + 1);
  }
  return out.trim();
}

/** Replace the entire learnings file (used by the consolidation path — the
 * extraction model outputs a merged, deduplicated version, and the railhead
 * swaps the file wholesale). */
export async function writeLearnings(cwd: string, content: string): Promise<void> {
  const path = learningsPath(cwd);
  await mkdir(join(cwd, ".railhead"), { recursive: true });
  await writeFile(path, content.trim() + "\n", "utf8");
}

/** Returns true if adding `newChars` more characters to the learnings file
 * would exceed the char budget. Used by the caller to decide whether to
 * consolidate before appending. */
export function wouldExceedBudget(currentContent: string | null, newChars: number): boolean {
  const currentLen = currentContent?.length ?? 0;
  return currentLen + newChars > LEARNINGS_CHAR_LIMIT;
}

/** Marker name the worker emits when pushing a tooling fact. Kept uppercase
 * and distinctive so it does not collide with prose a small model might write
 * mid-narrative; the parser only accepts the marker at line start. Twin of
 * `extractContractsBlock`'s lossy-parse discipline — see ADR 0012 push variant. */
export const LEARNED_MARKER = "LEARNED:";

/** Marker for retracting a prior learning the worker personally falsified. A
 * worker that discovers a previously-injected learning is wrong (e.g. a prior
 * phase claimed "this model cannot read images" but the worker just read a
 * screenshot and saw it) emits this line; the railhead removes the matched
 * learning from `.railhead/learnings.md` so the false fact stops propagating.
 *
 * Same lossy-parse discipline as `LEARNED_MARKER`: line-start only, prose
 * mid-sentence mentions ignored, `NONE` sentinel = empty. The worker is the
 * cheapest reporter of its own falsification (ADR 0013's principle applied
 * to corrections). */
export const RETRACTED_MARKER = "RETRACTED:";

/** Parse `LEARNED: <fact>` lines out of a worker transcript. Lossy by design:
 * ignores malformed lines, prose-wrapped markers (mid-sentence), and stray
 * `LEARNED` mentions that are not the marker-on-its-own-line. Returns each
 * fact on its own line, deduplicated against input order. Returns `null` when
 * no marker is present, so callers can skip the merge step entirely.
 *
 * The worker is told to emit `LEARNED: NONE` (or to omit the line) when there
 * is nothing reusable; this function treats `NONE` as empty and returns null.
 *
 * This is the single learning-persistence parser (ADR 0013). The previous
 * pull path's separate extraction-model call is retired — the worker that did
 * the work is the cheapest extractor of what was hard about the work. */
export function readLearnedMarkers(transcript: string): string | null {
  const text = stripFencedRegions(transcript);
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(LEARNED_MARKER)) continue;
    const rest = line.slice(LEARNED_MARKER.length).trim();
    if (!rest || rest.toUpperCase() === "NONE") continue;
    if (seen.has(rest)) continue;
    seen.add(rest);
    facts.push(rest);
  }
  return facts.length > 0 ? facts.join("\n") : null;
}

/** Parse `RETRACTED: <fact>` lines out of a worker transcript. Twin of
 * `readLearnedMarkers` with the same lossy discipline. Returns each retracted
 * fact on its own line, deduplicated against input order. Returns `null` when
 * no retraction marker is present. */
export function readRetractedMarkers(transcript: string): string | null {
  const text = stripFencedRegions(transcript);
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(RETRACTED_MARKER)) continue;
    const rest = line.slice(RETRACTED_MARKER.length).trim();
    if (!rest || rest.toUpperCase() === "NONE") continue;
    if (seen.has(rest)) continue;
    seen.add(rest);
    facts.push(rest);
  }
  return facts.length > 0 ? facts.join("\n") : null;
}

/** Remove learning lines that a retraction falsifies. A learning line is
 * dropped when it matches a retraction after normalizing both sides to
 * alphanumeric-only characters (lowercased). This makes the match robust to
 * minor transcription differences — backticks around a word, trailing
 * punctuation, different hyphenation — which caused the platformer-test-2
 * incident where a 1-char backtick difference defeated the substring match
 * and a false "model cannot read screenshots" learning survived.
 *
 * Lines that merely share common words with a retraction are kept (the
 * threshold is "the retraction's normalized text appears inside the
 * normalized learning," not "shares a word").
 *
 * Pure: does not touch disk, does not mutate the input. Returns the surviving
 * lines joined by newlines, or `null` when every line is retracted (the
 * caller writes `null` as "no learnings," not an empty file). */
export function suppressRetracted(content: string, retracted: string | null): string | null {
  if (!retracted) return content;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const retractionLines = retracted
    .split("\n")
    .map((l) => normalize(l))
    .filter((l) => l.length > 0);
  if (retractionLines.length === 0) return content;
  const surviving = content
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((line) => {
      if (line.trim().length === 0) return false;
      const normalized = normalize(line);
      return !retractionLines.some((r) => normalized.includes(r));
    });
  return surviving.length > 0 ? surviving.join("\n") : null;
}

/** Build the consolidation prompt: merge existing learnings + new learnings
 * into a deduplicated, consolidated version that fits the char budget. */
export function buildConsolidationPrompt(existing: string, newLearnings: string): string {
  return `You are consolidating a project's learnings file. Merge the existing learnings with the new ones below. Rules:
- Deduplicate: merge overlapping facts into a single, tighter line.
- Remove stale or redundant entries.
- Keep each fact terse and self-contained (one line each).
- Output the full merged file content (not just the new entries).
- If the result exceeds the spirit of ~2,200 chars, trim the least useful entries.

EXISTING LEARNINGS:
${existing}

NEW LEARNINGS:
${newLearnings}

OUTPUT: the full merged file, one fact per line. No preamble, no explanations.`;
}

const CONTEXT_WINDOW_PATTERNS = [
  /\bcontext\s+window\b/i,
  /\bcontext\s+length\b/i,
  /\bcontextoverflowerror\b/i,
  /\bmaximum\s+context\b/i,
  /\b\d{4,6}\s*k?\s*tokens?\b/i,
  /\btoken\s+(budget|limit|window)\b/i,
];

export function isContextWindowClaim(fact: string): boolean {
  return CONTEXT_WINDOW_PATTERNS.some((re) => re.test(fact));
}

const CAPABILITY_SELF_ASSESSMENT_PATTERNS = [
  /\b(this|the)\s+(model|vision model|local model)\s+(cannot|can'?t|is unable to|is not able to)\b/i,
  /\b(this|the)\s+(model|vision model|local model)\s+(does not|doesn'?t)\s+(support|have|include)\b/i,
  /\b(model|vision model|local model)\s+\S+\s+(cannot|can'?t|is unable to|does not support|lacks?)\b/i,
  /\bI\s+(cannot|can'?t|am unable to|am not able to)\b/i,
  // "model cannot read/decode/interpret/perceive screenshots/images/PNGs".
  // The verb list is deliberately wide — a run discovered "decode" slipping
  // through (issue #57), and models coin new verbs freely. Missing verbs let
  // a false capability claim poison every subsequent visual-review prompt.
  /\b\S+\s+(cannot|can'?t)\s+(read|see|process|parse|view|decode|interpret|perceive|render|display|open|load|handle|consume|ingest)\s+(screenshots?|images?|png|pngs)\b/i,
  // Broader net: any negation followed within a couple of words by an image
  // noun, whatever the verb ("cannot receive image input", "is unable to take
  // in screenshots"). Captures phrasings the enumerated list will miss.
  /\b\S+\s+(cannot|can'?t|is unable to|am unable to)\s+(\w+\s+){0,2}(screenshots?|images?|pngs?)\b/i,
  /\b\S+\s+(does not|doesn'?t)\s+support\s+(vision|image|screenshot|tool|function)\b/i,
  /\b(model|vision model|local model)\s+\S+\s+lacks?\s+/i,
  /\b\S+\s+lacks?\s+(vision|image|screenshot|tool|function)\b/i,
];

export function isCapabilitySelfAssessment(fact: string): boolean {
  return CAPABILITY_SELF_ASSESSMENT_PATTERNS.some((re) => re.test(fact));
}

export function filterContextWindowClaims(content: string | null): string | null {
  if (!content) return null;
  const surviving = content
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isContextWindowClaim(line));
  return surviving.length > 0 ? surviving.join("\n") : null;
}

export function filterCapabilityClaims(content: string | null): string | null {
  if (!content) return null;
  const surviving = content
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isCapabilitySelfAssessment(line));
  return surviving.length > 0 ? surviving.join("\n") : null;
}

/**
 * Mine a one-line correction from a failed phase's output, to append to
 * learnings.md when the worker did NOT emit its own `LEARNED:` marker.
 *
 * The worker is the cheapest reporter of what was hard, but a failed verify
 * or review BLOCKER often contains a clear "what went wrong" the worker
 * didn't think to report — a compiler error naming the wrong symbol, a review
 * finding naming a missing wire. Mining it captures the correction so a future
 * ticket hitting the same wall sees it.
 *
 * Returns `null` when nothing mineable is present — the caller skips the
 * merge step entirely, same as when `readLearnedMarkers` returns null.
 *
 * Pure: no I/O, no mutation. The caller calls this AFTER `pushLearnings`
 * already ran, and only mines when the worker didn't already emit a learning
 * for the phase (checked by the caller via `readLearnedMarkers`).
 *
 * Issue #42.
 */
export function extractFailureLearning(options: {
  /** Raw output from the failed verify/smoke phase. */
  verifyOutput?: string | null;
  /** Blocking findings from a failed review pass. */
  reviewFindings?: string[];
}): string | null {
  const { verifyOutput, reviewFindings } = options;

  // Priority 1: verify/smoke failure — extract the first error line.
  // Compiler/linter/test output follows a predictable shape: the line
  // containing "error" (case-insensitive) is the actionable signal.
  if (verifyOutput && verifyOutput.trim()) {
    const errorLine = extractErrorLine(verifyOutput);
    if (errorLine) return errorLine;
  }

  // Priority 2: review BLOCKER findings — the first blocker is the
  // most actionable correction.
  if (reviewFindings && reviewFindings.length > 0) {
    const blocker = reviewFindings.find((f) => /^\[BLOCKER\]/i.test(f.trim()));
    if (blocker) {
      const cleaned = blocker.trim().replace(/^\[BLOCKER\]\s*/i, "");
      if (cleaned) return `Review blocked: ${trimmedSummary(cleaned)}`;
    }
  }

  return null;
}

/** Extract the first actionable error line from verify/smoke output.
 * Looks for lines containing "error" (case-insensitive) that aren't just
 * the command echo. Returns the line trimmed, or null when no error line
 * is found. */
function extractErrorLine(output: string): string | null {
  const lines = output.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("$ ")) continue;
    if (/\berror\b/i.test(line) || /\bpanic/i.test(line)) {
      return `Verify failed: ${trimmedSummary(line)}`;
    }
  }
  return null;
}

/** Trim a finding/error line to a reasonable length for a learnings entry.
 * Learnings are one line each; a 500-char compiler error is too much. */
function trimmedSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
}

/** Parse worker-pushed learnings (and retractions) from the worker's own
 * transcript via `readLearnedMarkers` / `readRetractedMarkers` into
 * `.railhead/learnings.md`. This is the only learning-persistence path (ADR
 * 0013): the worker that did the work is the one that knows what was hard,
 * so no separate extraction call is needed — only a lossy parse of any
 * `LEARNED:` lines it emitted at end-of-run.
 *
 * Retractions (`RETRACTED:` lines the worker emits when it falsified a prior
 * learning) are applied first: the matched line is removed from the existing
 * learnings file before any new learnings are merged. This is the correction
 * path ADR 0013's push discipline lacks without it — a false learning (e.g.
 * "this model cannot read images") otherwise propagates forever, injected
 * into every subsequent prompt with no mechanism to retract.
 *
 * No-ops when the worker emitted no marker. Consolidates via a model-driven
 * call on the `model.extract` seat (ADR 0015, 9B-Q4 OK) when the char budget
 * would be exceeded. */
export async function pushLearnings(
  state: RunState,
  ledger: string,
  phaseFile: string,
): Promise<void> {
  const transcript = await extractAssistantText(ledger, phaseFile);
  if (!transcript.trim()) return;
  const retracted = readRetractedMarkers(transcript);
  if (retracted) {
    const existing = await readLearnings(state.cwd);
    if (existing) {
      const suppressed = suppressRetracted(existing, retracted);
      if (suppressed === null) {
        await writeLearnings(state.cwd, "");
      } else if (suppressed !== existing) {
        await writeLearnings(state.cwd, suppressed);
      }
    }
  }
  const pushed = readLearnedMarkers(transcript);
  if (!pushed) return;
  const noContextClaims = filterContextWindowClaims(pushed);
  if (!noContextClaims) return;
  const filtered = filterCapabilityClaims(noContextClaims);
  if (!filtered) return;
  const phaseLabel = phaseFile.replace(/\.jsonl$/, "");
  await mergeLearnings(state, ledger, phaseLabel, filtered);
}

/** Mine a correction from a failed verify or review BLOCKER, when the worker
 * did NOT emit its own `LEARNED:` marker for the phase. The worker is the
 * cheapest reporter, but a failed verify output or review BLOCKER often
 * contains a clear "what went wrong" the worker didn't think to report — a
 * compiler error, a missing wire. Mining it captures the correction so a
 * future ticket hitting the same wall sees it.
 *
 * Only mines when the worker's transcript for this phase had no `LEARNED:`
 * marker — the worker's own report always takes precedence (ADR 0013).
 * Issue #42. */
export async function mineFailureLearning(
  state: RunState,
  ledger: string,
  phaseFile: string,
  failure: { verifyOutput?: string | null; reviewFindings?: string[] },
): Promise<void> {
  const transcript = await extractAssistantText(ledger, phaseFile);
  const workerLearned = readLearnedMarkers(transcript);
  if (workerLearned) return;

  const mined = extractFailureLearning(failure);
  if (!mined) return;
  const phaseLabel = phaseFile.replace(/\.jsonl$/, "");
  await mergeLearnings(state, ledger, `${phaseLabel}-mined`, mined);
}

/** Append new learnings (or consolidate when over budget). The single
 * persistence path after ADR 0013 (push only). Consolidation runs on the
 * `model.extract` seat (ADR 0015 — the narrow seat where 9B-Q4 is OK for
 * single-shot structured output), falling back to a deterministic FIFO
 * eviction inside `appendLearnings` when no extract model is configured —
 * previously the extract-null path bypassed the budget check entirely and
 * learnings.md grew unbounded (issue #68). */
async function mergeLearnings(
  state: RunState,
  ledger: string,
  phaseLabel: string,
  newLearnings: string,
): Promise<void> {
  const extractModel = state._models?.extract ?? null;
  const existing = await readLearnings(state.cwd);
  const overBudget = existing !== null && wouldExceedBudget(existing, newLearnings.length);
  if (extractModel !== null && overBudget) {
    const consolPhaseFile = `${phaseLabel}-consolidate`;
    const consolPrompt = buildConsolidationPrompt(existing!, newLearnings);
    const consolResult = await executeOpendCode(consolPrompt, {
      cwd: state.cwd,
      ledgerDir: ledger,
      phaseFile: consolPhaseFile,
      model: extractModel,
      live: false,
      verbose: state.verbose,
      maxSteps: 5,
      stallTimeoutSec: state.config.stall_timeout_sec,
      maxStepModelSec: state.config.max_step_model_sec,
      maxContextTokens: contextBudget(state),
    });
    if (consolResult.status === "transient") throw new Error(`learnings consolidate: ${describeExecFailure(consolResult)}`);
    if (consolResult.status === "ok") {
      const merged = (await extractAssistantText(ledger, consolPhaseFile)).trim();
      if (merged && merged !== "NONE") {
        await writeLearnings(state.cwd, merged.slice(0, LEARNINGS_CHAR_LIMIT));
        return;
      }
    }
    // Consolidation failed to produce a merged file — fall through to the
    // deterministic bounded append rather than dropping the new learning.
  }
  await appendLearnings(state.cwd, newLearnings);
}

