import { buildReviewerPrompt, buildReviewerReadModePrompt } from "../context/prompt.ts";
import { describeExecFailure, executeOpendCode, isQuotaError } from "../execute/executor.ts";
import { extractAssistantText } from "../core/ledger.ts";
import type { ContractsIndex } from "../core/contracts.ts";
import { readLearnings } from "../context/learnings.ts";
import { readDigest } from "../context/digest.ts";
import { writeFile } from "node:fs/promises";
import { indexOfOutsideFences, indexOfLiteralOutsideFences, lastIndexOfLiteralOutsideFences } from "../core/fences.ts";
import { RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";

export interface ReviewOutcome {
  blocking: string;
  mustFix: string[];
  nits: string[];
  ok: string;
  transcript: string;
}

export interface ReviewArgs {
  cwd: string;
  ledgerDir: string;
  phaseFile: string;
  model: string | null;
  ticketFile: string;
  ticketBody: string;
  criteria: string[];
  diff: string;
  /** Blocking findings from prior reviews this ticket already went through. */
  priorFindings?: string[];
  /** Same contracts slice the Implementer received (by the ticket's files/references), so the Reviewer can check the diff's signatures against real ground truth instead of guessing. */
  contracts?: ContractsIndex;
  live?: boolean;
  verbose?: boolean;
  /* Show a periodic heartbeat (elapsed/ctx) during a long review. */
  heartbeat?: boolean;
  livePrefix?: string;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  /** Issue #78: per-step model-time ceiling, passed to the executor. */
  maxStepModelSec?: number | null;
  /** Issue #96: absolute wall-clock ceiling on the WHOLE phase, passed to the
   * executor. Visual review rounds thread their per-round budget through this
   * so a slow-but-loud round (every step succeeds yet the round crawls) is
   * bounded in wall time, not just step count. */
  phaseWallSec?: number | null;
  /** Project learnings (tooling facts from prior phases). See ADR 0012. */
  learnings?: string | null;
  /** Issue #50: rolling project digest. See ADR 0018. */
  digest?: string | null;
  /** Fix mode (issue #6): adds the debug-log cleanup check. */
  fixMode?: boolean;
  /** When true, run in read-mode: the reviewer gets read access and a stat+
   * file-list prompt instead of the raw diff (#30). */
  readMode?: boolean;
  /** When readMode is true, the diff stat to show instead of the raw diff. */
  stat?: string;
  /** When readMode is true, the list of source files the reviewer should read. */
  files?: string[];
  /** Hard cap on context-window size in tokens (#24). */
  maxContextTokens?: number | null;
  /** Which implement→review cycle this is (1-indexed). Escalates on 3+ (#16). */
  attempt?: number;
  /** Issue #34: the planner's design intent (visual identity, quality bar). */
  designDoc?: string | null;
  /** Issue #34: the planner's architecture intent (module map, rationale). */
  architectureDoc?: string | null;
  /** Issue #99 (ADR 0028): whether this ticket touches the rendered surface —
   * gates the design narrative exactly as the implementer's does. */
  surface?: boolean;
  /** Issue #99 (ADR 0028): the coherence charter for a surface ticket. */
  coherenceDoc?: string | null;
  /** Issue #41: linter output to inject into the reviewer prompt. */
  lintOutput?: string | null;
  /** Issue #45: gate the RED/GREEN evidence finding on "test phase ran." */
  testable?: boolean;
  /** Issue #46: when set, the caller has decided the diff is too large to
   * inline and the railhead should write it to this ledger file path, then
   * hand the reviewer the path + `diffStat` so it reads the diff on demand
   * instead of carrying it in the prompt. The caller owns the threshold
   * decision (mirroring how read-mode's caller owns `useReadMode`); `review()`
   * only writes the file and routes through the read-capable agent. */
  diffFile?: string;
  /** Issue #46: the `git diff --stat` summary shown alongside `diffFile`. */
  diffStat?: string;
}

export interface ReviewAgentArgs {
  /** Progress-line label used in thrown transient errors (e.g. "goal review").
   * Not the executor's `livePrefix` — that stays on the live stream. */
  label: string;
  prompt: string;
  cwd: string;
  ledgerDir: string;
  phaseFile: string;
  model: string | null;
  agent?: string | null;
  live?: boolean;
  verbose?: boolean;
  heartbeat?: boolean;
  livePrefix?: string;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  /** Issue #96: absolute wall-clock ceiling on the WHOLE phase (see ReviewArgs
   * `phaseWallSec`). Visual review rounds thread their per-round budget. */
  phaseWallSec?: number | null;
  maxContextTokens?: number | null;
  /** Issue #60: kill the subprocess at the next step boundary once a complete
   * verdict block (`$X_PASS`/`$X_FAIL` ... `$END`) has been emitted, so a
   * model that re-emits its verdict doesn't loop until the step budget eats
   * the verdict. Visual review passes it; goal/structural currently don't. */
  stopAfterVerdict?: boolean;
}

export type ReviewAgentOutcome =
  | { status: "ok"; transcript: string }
  | { status: "incomplete"; transcript: string; detail: string }
  | { status: "fatal"; transcript: string; detail: string };

/**
 * One review-process runner shared by every review kind (issue #89). The four
 * seats — diff review (`review`), visual, goal, structural — all execute the
 * same shape: fresh `opencode` subprocess (ADR 0001), ledger-archive the
 * stream, extract the assistant transcript, and interpret the exit. That
 * plumbing used to be hand-copied at four sites (three of them in run.ts),
 * drifting every time an executor option landed in one copy. The runner owns
 * only the invocation + transcript + exit-classification; verdict parsing and
 * post-verdict policy stay at the per-kind call site so no policy collapses.
 *
 * - `transient` executor status throws (the caller's infra-retry owns the
 *   retry — the same way a transient implement/review is retried today).
 * - any other non-ok status returns `incomplete`: the process ran but never
 *   completed a review (crash, step budget, stall). Every kind maps this to
 *   its own honest default (visual → inconclusive, goal/structural →
 *   inconclusive recorded, diff review → blocking fallback). An incomplete
 *   run is never coerced into a pass.
 */
export async function runReviewAgent(args: ReviewAgentArgs): Promise<ReviewAgentOutcome> {
  const result = await executeOpendCode(args.prompt, {
    cwd: args.cwd,
    ledgerDir: args.ledgerDir,
    phaseFile: args.phaseFile,
    model: args.model,
    agent: args.agent,
    live: args.live,
    verbose: args.verbose,
    heartbeat: args.heartbeat,
    livePrefix: args.livePrefix,
    maxSteps: args.maxSteps,
    stallTimeoutSec: args.stallTimeoutSec,
    maxStepModelSec: args.maxStepModelSec,
    phaseWallSec: args.phaseWallSec,
    maxContextTokens: args.maxContextTokens,
    stopAfterVerdict: args.stopAfterVerdict,
  });
  const transcript = await extractAssistantText(args.ledgerDir, args.phaseFile);
  if (result.status === "transient") {
    throw new Error(`${args.label}: ${describeExecFailure(result)}`);
  }
  if (result.status !== "ok") {
    // A quota/usage-limit wall is fatal for the run's lifetime, not a generic
    // "couldn't run the review" incomplete — surface it distinctly so the
    // goal/structural seats can stop the run instead of recording a silent
    // inconclusive. The full provider message rides in `detail`.
    if (isQuotaError(result.errorMessage ?? "")) {
      return { status: "fatal", transcript, detail: result.errorMessage ?? "model quota exhausted" };
    }
    return { status: "incomplete", transcript, detail: describeExecFailure(result) };
  }
  return { status: "ok", transcript };
}

/**
 * The verdict markers that delimit a review kind's transcript. Every
 * run-the-app review seat emits `$<KIND>_FAIL` + one finding per line, or
 * `$<KIND>_PASS` (issue #89 parameterizes the one shared parser by these —
 * visual, goal, and structural differ only in the marker names).
 */
export interface VerdictMarkers {
  /** e.g. "$VISUAL_FAIL" — opens the FAIL block. */
  failMarker: string;
  /** e.g. "$VISUAL_PASS" — the PASS signal. */
  passMarker: string;
}

export interface ReviewVerdict {
  verdict: "pass" | "fail" | "inconclusive";
  findings: string[];
}

/** Escape a marker string for literal inclusion in a RegExp. */
function escapeMarker(marker: string): string {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, word-bounded, fence-aware search for a verdict marker
 * (mirrors the per-kind `/\$visual_fail\b/i` the copies each hand-rolled). The
 * \b keeps a prefix like "$VISUAL_FAIL" from matching a longer marker
 * "$VISUAL_FAILED". A marker quoted inside a code fence is an example, not a
 * verdict — only unfenced occurrences count (issue #108). */
function indexOfMarker(text: string, marker: string): number {
  return indexOfOutsideFences(text, new RegExp(`${escapeMarker(marker)}\\b`, "i"));
}

/**
 * The one structured-verdict parser shared by the run-the-app review kinds
 * (visual, goal, structural — issue #89). The agent emits either `$<FAIL>`
 * followed by one finding per line (each prefixed with `[BLOCKER]` or
 * `[MAJOR]`), or `$<PASS>`. Defensive defaults, uniform across kinds:
 *
 * - No marker at all → inconclusive. A review whose whole point is to run the
 *   app and SEE it work has no verdict when the agent never completed (e.g. a
 *   terminal app that fails without a TTY). Treating that as pass would let a
 *   runtime bug ship behind a silent agent — see ADR 0009. Inconclusive
 *   surfaces the gap honestly.
 * - `$<FAIL>` with NONE/empty → inconclusive (the agent marked FAIL but had
 *   nothing concrete to say; same evidence vacuum as no marker).
 * - Both `$<FAIL>` and `$<PASS>` → prefer FAIL (a real finding wins over a
 *   misplaced pass marker).
 *
 * Only unfenced occurrences of a marker count (issue #108): the review prompts
 * themselves print the markers as the output contract, so a marker the model
 * echoes as an example inside a ``` block is never a verdict. Once an unfenced
 * fail marker is found, findings are still sliced from the RAW text (a finding
 * may legitimately quote code).
 *
 * Finding splitting reuses `splitFindings` so the severity/junk-tolerance
 * rules stay uniform across every review path.
 */
export function parseVerdict(text: string, markers: VerdictMarkers): ReviewVerdict {
  const failIdx = indexOfMarker(text, markers.failMarker);
  if (failIdx >= 0) {
    const findings = splitFindings(sliceUntilEnd(text.slice(failIdx)));
    if (findings.length === 0) {
      return { verdict: "inconclusive", findings: [] };
    }
    return { verdict: "fail", findings };
  }
  if (indexOfMarker(text, markers.passMarker) >= 0) {
    return { verdict: "pass", findings: [] };
  }
  return { verdict: "inconclusive", findings: [] };
}

/** Slice from just after the marker line to `$END` (or end of text). */
function sliceUntilEnd(afterMarker: string): string {
  const startNewline = afterMarker.indexOf("\n");
  const start = startNewline >= 0 ? startNewline + 1 : afterMarker.length;
  const rest = afterMarker.slice(start);
  const endMatch = rest.search(/\$end\b/i);
  return endMatch >= 0 ? rest.slice(0, endMatch).trim() : rest.trim();
}

/**
 * Truncate a verbose finding body for a corrective ticket's `what` (issue
 * #89 — the single truncation used by every corrective-ticket generator in
 * corrective.ts, whose per-kind specs were consolidated there by #88). A
 * long-form finding becomes a multi-thousand-char ticket body that fills the
 * implementer's context window; the full finding stays in the run's records,
 * so the ticket only carries the first `maxChars` plus a suffix pointing at
 * the record (or an ellipsis where no pointer applies).
 */
export function truncateFindingBody(body: string, maxChars: number, suffix: string): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars).trimEnd() + suffix;
}

export async function review(options: ReviewArgs): Promise<ReviewOutcome> {
  const learnings = options.learnings ?? await readLearnings(options.cwd);
  const digest = options.digest ?? await readDigest(options.cwd);

  // Issue #46: the caller decided to hand the diff as a file — write it before
  // building the prompt so the path the prompt hands the reviewer is live.
  // Route through the read-capable agent so the reviewer can actually read it.
  if (options.diffFile) {
    await writeFile(options.diffFile, options.diff, "utf8");
  }
  const useDiffFile = !!options.diffFile;

  const prompt = options.readMode
    ? await buildReviewerReadModePrompt({
        ticketFile: options.ticketFile,
        ticketBody: options.ticketBody,
        criteria: options.criteria,
        stat: options.stat ?? "",
        files: options.files ?? [],
        priorFindings: options.priorFindings,
        contracts: options.contracts,
        learnings,
        digest,
        fixMode: options.fixMode,
        attempt: options.attempt,
        designDoc: options.designDoc,
        architectureDoc: options.architectureDoc,
        surface: options.surface,
        coherenceDoc: options.coherenceDoc,
        lintOutput: options.lintOutput,
        testable: options.testable,
      })
    : await buildReviewerPrompt({
        ticketFile: options.ticketFile,
        ticketBody: options.ticketBody,
        criteria: options.criteria,
        diff: options.diff,
        diffFile: options.diffFile,
        diffStat: options.diffStat,
        priorFindings: options.priorFindings,
        contracts: options.contracts,
        learnings,
        digest,
        fixMode: options.fixMode,
        attempt: options.attempt,
        designDoc: options.designDoc,
        architectureDoc: options.architectureDoc,
        surface: options.surface,
        coherenceDoc: options.coherenceDoc,
        lintOutput: options.lintOutput,
        testable: options.testable,
      });

  const result = await runReviewAgent({
    label: "reviewer",
    prompt,
    cwd: options.cwd,
    ledgerDir: options.ledgerDir,
    phaseFile: options.phaseFile,
    model: options.model,
    agent: options.readMode || useDiffFile ? RAILHEAD_AGENT_NAMES.reviewReadmode : RAILHEAD_AGENT_NAMES.review,
    live: options.live,
    verbose: options.verbose,
    heartbeat: options.heartbeat,
    livePrefix: options.livePrefix,
    maxSteps: options.maxSteps,
    stallTimeoutSec: options.stallTimeoutSec,
    maxStepModelSec: options.maxStepModelSec,
    phaseWallSec: options.phaseWallSec,
    maxContextTokens: options.maxContextTokens,
  });

  if (result.status !== "ok") {
    const detail = `reviewer ${result.detail}`;
    return {
      blocking: "Reviewer invocation did not complete; treat as blocking.",
      mustFix: [],
      nits: [],
      ok: detail,
      transcript: result.transcript,
    };
  }

  const transcript = result.transcript;

  const blocking = sliceBetween(transcript, "$BLOCKING", ["$NITS", "$OK"])
    .trim();
  const mustFix = splitFindings(blocking);
  const nits = splitFindings(sliceBetween(transcript, "$NITS", "$OK"));
  const okIdx = lastIndexOfLiteralOutsideFences(transcript, "$OK");
  const ok = (okIdx >= 0 ? transcript.slice(okIdx + "$OK".length) : "").trim();

  return {
    blocking: blocking || "NONE",
    mustFix,
    nits,
    ok: ok || "(no verdict text)",
    transcript,
  };
}

/** Split a findings block into individual items, tolerating bullets and the word NONE. */
export function splitFindings(text: string): string[] {
  if (!text || /^none$/i.test(text.trim())) return [];
  return text
    .split(/[\n•;]\s*/)
    .map((s) => s.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

export type Severity = "blocker" | "major" | "minor";

/**
 * One tolerant severity classifier shared by every review seat (issue #119).
 * Small models rephrase the `[BLOCKER]`/`[MAJOR]` bracket labels the reviewer
 * is asked for — `BLOCKER 1 —`, `MAJOR 3:`, `**Blocker:**`, `* Major *`,
 * lowercase, numbered, bolded — and the old per-site anchored `^\[…\]` regexes
 * silently reclassified those as `minor`, soft-passing every seat. This reads
 * the label from the *start* of a finding (after stripping bullets, numbering,
 * bold/italic markers, and an opening bracket) and matches the bare word, so a
 * label in any of those shapes classifies identically to the bracketed form.
 */
export function classifySeverity(finding: string): Severity {
  const head = stripLabelDecorations(finding);
  if (/^blocker\b/i.test(head)) return "blocker";
  if (/^major\b/i.test(head)) return "major";
  return "minor";
}

/** Strip the leading bullets/numbering/bold/italic/bracket decoration a small
 * model may put before the severity word, leaving the word at the head of the
 * string for {@link classifySeverity} to match. */
function stripLabelDecorations(finding: string): string {
  let t = finding.trimStart();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEADING_LABEL_DECORATIONS) {
      const next = t.replace(re, "");
      if (next !== t) {
        t = next.trimStart();
        changed = true;
        break;
      }
    }
  }
  return t;
}

const LEADING_LABEL_DECORATIONS: RegExp[] = [
  /^[-*•+]\s+/,        // bullet followed by a space
  /^\d+\s*[.):]\s*/,   // numbered list item ("1. ", "2) ", "3: ")
  /^\*\*/,             // bold opener
  /^__/,               // bold opener (underscore)
  /^\*/,               // italic / single-asterisk emphasis
  /^\[\s*/,            // opening bracket of "[BLOCKER]"
];

/** The finding's body with its leading severity label (in whatever shape)
 * removed — used to re-label in {@link downgradeUnanchoredBlockers} and to
 * build corrective-ticket bodies. A finding with no recognized label is
 * returned trimmed and unchanged. */
export function stripSeverityLabel(finding: string): string {
  const head = stripLabelDecorations(finding);
  const m = /^(blocker|major)\b/i.exec(head);
  if (!m) return finding.trim();
  return head.slice(m[0].length).replace(/^[\s\d*:)\].—–_-]+/, "").trim();
}

/** Whether a finding's text names a severity word (blocker/major) anywhere —
 * the fail-loud probe for a $FAIL whose findings carry no recognized label
 * (issue #119: a "BLOCKER"-laden verdict must never convert to a clean
 * soft-pass). */
export function mentionsSeverityWord(finding: string): boolean {
  return /\b(?:blocker|major)\b/i.test(finding);
}

/** Fail-loud promotion (issue #119): when a FAIL verdict's findings carry no
 * recognized [BLOCKER]/[MAJOR] label yet still name a severity word
 * (blocker/major), re-label every such finding `[BLOCKER]` so the seat can
 * never convert a "BLOCKER"-laden verdict into a clean soft-pass. Findings
 * that already carry a recognized blocker are left untouched (the label won). */
export function promoteUnlabelledSeverity(findings: string[]): string[] {
  if (findings.some((f) => classifySeverity(f) === "blocker")) return findings;
  let changed = false;
  const out = findings.map((f) => {
    if (classifySeverity(f) === "minor" && mentionsSeverityWord(f)) {
      changed = true;
      return `[BLOCKER] ${f.trim()}`;
    }
    return f;
  });
  return changed ? out : findings;
}

/** True when a finding still labels itself a blocker — a must-fix the ticket cannot ship without. */
export function isBlocker(finding: string): boolean {
  return classifySeverity(finding) === "blocker";
}

/**
 * Phrases a reviewer uses to assert a *compilation failure* (as opposed to
 * mentioning compilation in passing, e.g. "the runtime compiles shaders").
 * Matched case-insensitively against the finding's text. Kept as alternations
 * only (not anchored) so prose-wrapped claims like "This change introduces a
 * Compile Error" still match — but the negative-lookahead-free shape means we
 * rely on the suffix: every pattern asserts a *failure* (fail(s)/won't/error),
 * not just the word "compile".
 */
const COMPILE_FAILURE_PHRASES = [
  /fails?\s+to\s+compile/i,
  /\bwill\s+(?:not|never)\s+compile\b/i,
  /\bwon[''']?t\s+compile\b/i,
  /\bcompile\s+error\b/i,
  /\bcompilation\s+error\b/i,
  /\bcompiles?\s+error\b/i,
  /\btype\s*check\s+fail/i,
  /\btypecheck\s+fail/i,
  /\bfails?\s+type\s*check/i,
  /\bdoes\s+not\s+compile\b/i,
  /\bcannot\s+compile\b/i,
  /\bbuild\s+fail/i,
];

function isCompileFailureClaim(finding: string): boolean {
  return COMPILE_FAILURE_PHRASES.some((re) => re.test(finding));
}

/**
 * Strip findings that assert a compilation/build/typecheck failure when the
 * verify phase already passed green. A small-context reviewer sometimes
 * hallucinates a "this won't compile" [BLOCKER] against code that has, in
 * fact, compiled and passed its tests — without this guard, that
 * hallucination overrides the green verify evidence and burns the retry
 * budget on a non-existent failure (issue #1). When verify is red, nothing
 * is stripped: a real compile failure must survive to drive the retry.
 *
 * Returns a new array; the input is not mutated. Findings are matched on
 * their full text (label included), case-insensitively, in prose-wrapped
 * form — see {@link COMPILE_FAILURE_PHRASES}. Order of survivors is
 * preserved.
 */
export function stripCompileClaimsWhenGreen(findings: string[], verifyOk: boolean): string[] {
  if (!verifyOk) return findings;
  return findings.filter((f) => !isCompileFailureClaim(f));
}

/**
 * The repo-relative paths a git diff changes, read from its `+++ b/<path>`
 * hunk headers. Only the new-file side counts: a finding is about the code
 * the ticket produced, and `--- a/` names the old side while `index` lines
 * carry hashes, so neither can anchor a claim about the change. A deletion's
 * `+++ /dev/null` carries no path and drops out naturally. The diff at the
 * review call site is already stripped of non-source files (see
 * {@link stripNonSource}), so the returned set is the ticket's source diff.
 * De-duplicated, first-appearance order.
 */
export function changedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^\+{3} b\/(.+)$/.exec(line);
    if (m) paths.add(m[1].trim());
  }
  return [...paths];
}

/** Characters that can continue a path token — a matched anchor must not be
 * bordered by one, or it is a false positive like `src/a.ts` inside
 * `src/a.tsx`. The `:` of a `path:line` reference and the prose around a
 * mention are not path chars, so both count as real boundaries. */
const PATH_CHAR = /[A-Za-z0-9_.\/-]/;

/** Whether a finding text names any of the allowed paths (as a bare path or
 * `path:line`) at a token boundary, case-insensitively. Path membership only
 * — a hallucinated line number on a real path still anchors. */
function referencesAnchor(finding: string, anchors: string[]): boolean {
  for (const anchor of anchors) {
    const needle = anchor.toLowerCase();
    let from = 0;
    while (from <= finding.length) {
      const idx = finding.toLowerCase().indexOf(needle, from);
      if (idx < 0) break;
      const before = finding[idx - 1];
      const after = finding[idx + anchor.length];
      const boundedBefore = !before || !PATH_CHAR.test(before);
      const boundedAfter = after === undefined || !PATH_CHAR.test(after);
      if (boundedBefore && boundedAfter) return true;
      from = idx + 1;
    }
  }
  return false;
}

/**
 * The issue #94 gate: a `[BLOCKER]` that names no path belonging to the
 * change is presumed speculative and downgraded to `[MAJOR]`. Small-context
 * reviewers hallucinate hard failures the verify gate cannot refute (the ADR
 * 0014 failure class that burned 9 retries); `stripCompileClaimsWhenGreen`
 * covers only the compile-hallucination subclass, this closes the rest. A
 * downgrade preserves the finding's text — the report and retry feedback
 * must still show the claim — only the label moves down the ADR 0005 ladder.
 * `allowedAnchors` is the ticket's changed paths plus, for read-mode reviews,
 * the files the reviewer read (it reads whole files and may legitimately
 * anchor on an unchanged call site the change breaks). Returns a new array;
 * the input is not mutated.
 */
export function downgradeUnanchoredBlockers(
  findings: string[],
  allowedAnchors: string[],
): { findings: string[]; downgraded: number } {
  let downgraded = 0;
  const out: string[] = [];
  for (const finding of findings) {
    if (isBlocker(finding) && !referencesAnchor(finding, allowedAnchors)) {
      downgraded++;
      out.push(`[MAJOR] ${stripSeverityLabel(finding)}`);
    } else {
      out.push(finding);
    }
  }
  return { findings: out, downgraded };
}

/** Count findings by severity label: blocker=critical, major=high, unlabelled=minor. */
export function countSeverity(findings: string[]): { critical: number; high: number; minor: number } {
  let critical = 0;
  let high = 0;
  let minor = 0;
  for (const f of findings) {
    const sev = classifySeverity(f);
    if (sev === "blocker") critical++;
    else if (sev === "major") high++;
    else minor++;
  }
  return { critical, high, minor };
}

/**
 * The severity class of a finding set, per ADR 0005:
 * - "blocker": at least one [BLOCKER] — must retry, fails the ticket at the cap.
 * - "major":   [MAJOR] present, no [BLOCKER] — retry up to budget, soft-pass at the cap.
 * - "minor":   no labelled findings — PASS, do not retry.
 *
 * A round whose $BLOCKING section holds only unlabelled prose counts as minor:
 * the reviewer was told to label real issues, so unlabelled items are treated
 * as the lowest tier rather than burning the retry budget.
 */
export function severityOf(findings: string[]): "blocker" | "major" | "minor" {
  const { critical, high } = countSeverity(findings);
  if (critical > 0) return "blocker";
  if (high > 0) return "major";
  return "minor";
}

/** A terse, severity-aware summary of blocked findings for the run log. */
export function reviewSummary(findings: string[]): string {
  const { critical, high, minor } = countSeverity(findings);
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (high > 0) parts.push(`${high} high`);
  if (minor > 0) parts.push(`${minor} minor`);
  return `${critical + high + minor} issue(s)${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/**
 * Slice text between `startMarker` and the FIRST of `endMarkers` to occur.
 * The prompt's own format nests `$NITS` between `$BLOCKING` and `$OK`
 * (`$BLOCKING ... $NITS ... $OK ...`), so a single fixed end marker of `$OK`
 * would swallow the literal "$NITS\nNONE" text into the blocking slice on
 * every normal reviewer response — contaminating `mustFix` with junk entries
 * that then leak into the retry feedback and the findings history. Stopping
 * at whichever marker appears first keeps each section to just its own text.
 * Only unfenced marker occurrences seed a section (issue #108) — a fenced
 * worked example of the review format is the model narrating, not signalling.
 */
function sliceBetween(text: string, startMarker: string, endMarkers: string | string[]): string {
  const start = indexOfLiteralOutsideFences(text, startMarker);
  if (start < 0) return "";
  const afterStart = start + startMarker.length;
  const markers = Array.isArray(endMarkers) ? endMarkers : [endMarkers];
  let end = -1;
  for (const marker of markers) {
    const idx = indexOfLiteralOutsideFences(text, marker, afterStart);
    if (idx >= 0 && (end < 0 || idx < end)) end = idx;
  }
  return text.slice(afterStart, end === -1 ? undefined : end).trim();
}