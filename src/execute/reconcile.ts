import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { executeOpendCode, describeExecFailure } from "./executor.ts";
import { extractAssistantText } from "../core/ledger.ts";

/**
 * Spec-anchored test reconciliation (gh #105 / ADR 0032). A model-authored
 * test can be unsatisfiable (the run-20260909-1501 incident: an off-by-one in
 * a builder-authored undo/redo test burned the whole step budget because no
 * phase could see past the assumption it shared). The only artifact no model
 * phase in a run authored is the human plan origin prompt, so a red verify
 * whose failure names a file the phase itself wrote sends that spec — plus the
 * failure output, the attributed files, and the diff — to a FRESH arbiter
 * whose ruling the railhead applies mechanically. Pure parsing lives here;
 * `run.ts` owns the gate wiring. The executor's non-convergent-edit kill caps
 * the residual grind this reconciliation does not resolve.
 */

/** An edit the arbiter proposes for one file the failing phase authored. */
export interface ReconcileEdit {
  path: string;
  content: string;
}

export type ReconcileVerdict = "impl" | "test" | "inconclusive";

/** Bound on the arbiter phase: it is an arbiter, not an explorer. */
export const RECONCILE_MAX_STEPS = 25;

/** The reply's final line — armed as the executor's terminal stop marker so
 * the #60 post-verdict loop shape cannot eat the phase. */
export const RECONCILE_END = "$RECONCILE_END";
const RECONCILE_END_RE = /\$RECONCILE_END\b/i;

const RECONCILE_MARKERS: { marker: string; verdict: ReconcileVerdict }[] = [
  { marker: "$RECONCILE_IMPL", verdict: "impl" },
  { marker: "$RECONCILE_TEST", verdict: "test" },
  { marker: "$RECONCILE_INCONCLUSIVE", verdict: "inconclusive" },
];

/**
 * Which paths a (compressed) verify-failure output names, restricted to the
 * paths this phase authored. Path-like tokens are matched in the lossy
 * `readBlockedBy`/`extractContractsBlock` family style: candidates matching
 * `[\w./-]+\.[A-Za-z0-9]+` with a `:line` / `:line:col` suffix stripped. It
 * never decides what a "test file" is (technology-agnostic — the failure
 * output itself names the files); it answers only "which files this phase
 * authored does the failure name". Returns the deduped intersection in
 * first-appearance order.
 */
export function authoredPathsInFailure(output: string, authoredPaths: string[]): string[] {
  const wanted = new Map<string, string>();
  for (const p of authoredPaths) wanted.set(p.toLowerCase(), p);
  const seen = new Set<string>();
  const found: string[] = [];
  const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const token = m[1];
    const original = wanted.get(token.toLowerCase());
    if (original && !seen.has(original)) {
      seen.add(original);
      found.push(original);
    }
  }
  return found;
}

/** The blame-aware feedback preamble naming the files this phase authored
 * that the failing verify output calls out — pointing the retry at a TEST bug
 * before it rewrites production code (issue remedy 6). Pure. */
export function buildBlamePreamble(paths: string[]): string {
  const list = paths.map((p) => `\`${p}\``).join(", ");
  return `The failing verify output names files this phase authored: ${list}. Those files are candidates for a TEST bug — an off-by-one in a walk/index loop, a terminal sentinel asserted as a failure, a wrong fixture — not necessarily an implementation defect. Reconcile the test against the human spec (the plan's origin prompt), NOT against the ticket's acceptance-criteria paraphrase or your own assumption, before rewriting the implementation.`;
}

/** The findings block prepended to a retry's feedback after the arbiter ruled
 * (verdict `impl`, or a `test` verdict whose applied fix stayed red). Pure. */
export function reconcileFindingsBlock(verdict: ReconcileVerdict, findings: string[]): string {
  const head =
    verdict === "impl"
      ? `A fresh arbiter reading only the human spec ruled the IMPLEMENTATION wrong and explained why against the spec.`
      : `A fresh arbiter reading only the human spec ruled the TEST this phase authored wrong (the implementation may be correct). Its correction is below; reconcile the failing artifact against the spec, not the paraphrase.`;
  const list = findings.length ? findings.map((f, i) => `${i + 1}. ${f}`).join("\n") : "(no numbered findings emitted)";
  return `${head}\n${list}`;
}

export interface ReconcilePromptOpts {
  /** The human spec verbatim (the plan origin prompt) — the arbiter's only ground truth. */
  spec: string;
  ticketNumber: string;
  title: string;
  /** The ticket's acceptance criteria — labeled as a model paraphrase that may itself be wrong. */
  criteria: string[];
  /** The (compressed) verify-failure output. */
  failureOutput: string;
  /** The failing files this phase authored, per attribution. */
  authoredFailing: string[];
  /** The uncommitted working diff of the current ticket. */
  diff: string;
}

/**
 * The arbiter's input: the spec verbatim, the ticket's title and criteria
 * EXPLICITLY labeled as a paraphrase that may itself be wrong, the failure
 * shape, and the output contract ($RECONCILE_* verdict + numbered findings,
 * then — only under $RECONCILE_TEST — one fenced FILE block per corrected
 * file, the reply's final line being $RECONCILE_END). The model NEVER edits
 * the repo — it emits, the railhead applies. Pure.
 */
export function buildReconcilePrompt(opts: ReconcilePromptOpts): string {
  const criteria = opts.criteria.length
    ? opts.criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- (none listed)";
  const failing = opts.authoredFailing.map((p) => `- ${p}`).join("\n");
  const diff = opts.diff?.trim() ? opts.diff : "(no uncommitted diff)";
  return `You are a FRESH, independent arbiter resolving why verification failed on ticket ${opts.ticketNumber}. You have exactly ONE ground truth — the human spec below, verbatim. You were NOT the author of the implementation or of any test this phase wrote, and you have no stake in either.

The implementation may be correct and the test wrong — an off-by-one in a walk/index loop, a terminal sentinel asserted as a failure, a fixture disagreement. Reconcile the failing artifact against the SPEC, not against the paraphrase.

## The human spec (verbatim — the ONLY ground truth)
${opts.spec}

## The ticket (a model-authored paraphrase of the spec — it may itself be wrong)
Ticket ${opts.ticketNumber} — ${opts.title}

ACCEPTANCE CRITERIA (paraphrase — reconcile against the spec above if they conflict):
${criteria}

## Failing verification output (compressed)
${opts.failureOutput}

## Files this phase authored that the failure names
${failing}

## The current ticket's uncommitted diff
${diff}

Your job: decide whether the fault is in the implementation or in the test the phase authored — or whether you cannot tell — by checking the failing artifact against the SPEC. The ticket's criteria are a paraphrase and can be wrong too.

Output contract — follow it EXACTLY:
1. Emit exactly ONE verdict marker on its own line: $RECONCILE_IMPL (the implementation is wrong), $RECONCILE_TEST (the test this phase authored is wrong), or $RECONCILE_INCONCLUSIVE (cannot tell). "Inconclusive" is a real verdict — prefer it over a guess.
2. After the marker, numbered findings (one per line, "1. ...") explaining each fault AGAINST THE SPEC.
3. ONLY under $RECONCILE_TEST, emit one block per file you are correcting, in exactly this shape:
=== FILE: <path> ===
<the ENTIRE corrected file content>
=== END FILE ===
Each block names a file in the list above; the corrected content REPLACES the whole file. Never emit a block for an implementation file when you ruled the test wrong — and never emit a block under $RECONCILE_IMPL or $RECONCILE_INCONCLUSIVE.
4. The final line of your entire reply must be exactly:
${RECONCILE_END}`;
}

export interface ReconcileVerdictParse {
  verdict: ReconcileVerdict;
  findings: string[];
  edits: ReconcileEdit[];
}

function escapeMarker(marker: string): string {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Earliest verdict marker + what it names, or null when no marker exists. */
function firstVerdict(text: string): { index: number; verdict: ReconcileVerdict } | null {
  let best: { index: number; verdict: ReconcileVerdict } | null = null;
  for (const { marker, verdict } of RECONCILE_MARKERS) {
    const idx = text.search(new RegExp(`${escapeMarker(marker)}\\b`, "i"));
    if (idx >= 0 && (best === null || idx < best.index)) best = { index: idx, verdict };
  }
  return best;
}

/** Numbered/bulleted findings from the region after the verdict marker, up to
 * the first FILE header or $RECONCILE_END. Tolerates prose between items by
 * splitting on inline number boundaries too. */
function extractFindings(region: string): string[] {
  let slice = region;
  const endIdx = slice.search(new RegExp(`${escapeMarker(RECONCILE_END)}\\b`, "i"));
  if (endIdx >= 0) slice = slice.slice(0, endIdx);
  const fileIdx = slice.search(/^[ \t]*=== *FILE *:/im);
  if (fileIdx >= 0) slice = slice.slice(0, fileIdx);
  const raw: string[] = [];
  const segments = slice.split(/(?:\n+|(?=\d+[.)]\s))/);
  for (const segment of segments) {
    const t = segment.trim();
    if (t) raw.push(t);
  }
  // A prose-wrapped verdict may leave a lead-in ("— the test is wrong
  // because") before the first numbered item; drop everything up to the first
  // numbered/bulleted segment so prose never becomes a finding. When no
  // segment is numbered (findings as plain lines), keep them all.
  const firstItem = raw.findIndex((t) => /^\d+[.)]\s*/.test(t) || /^[-*•]\s/.test(t));
  const startAt = firstItem >= 0 ? firstItem : 0;
  return raw
    .slice(startAt)
    .map((s) => s.replace(/^\d+[.)]\s*/, "").replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

const FILE_HEADER_RE = /^[ \t]*=== *FILE *: *([^=\r\n]+?) *===[ \t]*$/gim;
const FILE_END_RE = /^[ \t]*=== *END FILE *===[ \t]*$/gim;

/** Parse every COMPLETE `=== FILE: <path> === ... === END FILE ===` block. A
 * header without its terminator yields empty edits — never a partial write. */
function parseFileBlocks(text: string): ReconcileEdit[] {
  const edits: ReconcileEdit[] = [];
  let searchFrom = 0;
  for (;;) {
    FILE_HEADER_RE.lastIndex = searchFrom;
    const m = FILE_HEADER_RE.exec(text);
    if (!m) break;
    const path = m[1].trim();
    FILE_END_RE.lastIndex = m.index + m[0].length;
    const em = FILE_END_RE.exec(text);
    if (!em) break; // truncated — drop this and any later block (never a partial write)
    edits.push({ path, content: text.slice(m.index + m[0].length, em.index) });
    searchFrom = em.index + em[0].length;
  }
  return edits;
}

/**
 * The lossy verdict parser (the `readBlockedBy`/`extractContractsBlock`
 * family). Case-insensitive markers, prose-wrapped verdicts tolerated. Returns
 * null when no verdict marker is present at all; a truncated FILE block is
 * dropped (empty edits), never a partial file write.
 */
export function parseReconcileVerdict(text: string): ReconcileVerdictParse | null {
  const verdictMarker = firstVerdict(text);
  if (!verdictMarker) return null;
  const after = text.slice(verdictMarker.index);
  const marker = RECONCILE_MARKERS.find((m) => m.verdict === verdictMarker.verdict)!;
  const findings = extractFindings(after.slice(marker.marker.length));
  const edits = verdictMarker.verdict === "test" ? parseFileBlocks(after) : [];
  return { verdict: verdictMarker.verdict, findings, edits };
}

/** Write only the edits whose path is a member of `allowedPaths` (the
 * attribution set — the arbiter can fix the files this ticket's own phase
 * authored and nothing else); everything else is dropped and reported. */
export async function applyReconcileEdits(
  cwd: string,
  edits: ReconcileEdit[],
  allowedPaths: string[],
): Promise<{ applied: string[]; dropped: string[] }> {
  const allowed = new Set(allowedPaths);
  const applied: string[] = [];
  const dropped: string[] = [];
  for (const edit of edits) {
    if (!allowed.has(edit.path)) {
      dropped.push(edit.path);
      continue;
    }
    const target = join(cwd, edit.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, edit.content, "utf8");
    applied.push(edit.path);
  }
  return { applied, dropped };
}

export interface RunSpecReconcileOpts {
  cwd: string;
  ledgerDir: string;
  phaseFile: string;
  model: string | null;
  spec: string;
  ticketNumber: string;
  title: string;
  criteria: string[];
  failureOutput: string;
  authoredFailing: string[];
  diff: string;
  live?: boolean;
  verbose?: boolean;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
}

export type ReconcileRunOutcome =
  | { ok: true; verdict: ReconcileVerdict; findings: string[]; edits: ReconcileEdit[] }
  | { ok: false; detail: string };

/**
 * The reconciliation phase's I/O half: one FRESH opencode subprocess (never
 * `--session`) on the implement-seat model with the spec in front of it. A
 * fresh context plus the one artifact no prior phase authored is the fix —
 * not a bigger model. Bounded by `RECONCILE_MAX_STEPS` (an arbiter, not an
 * explorer), `guardMode: "kill"`, and the `$RECONCILE_END` terminal marker so
 * the #60 post-verdict loop cannot eat the phase. A transient infra failure
 * throws (the caller's failure ladder owns the retry); any other non-ok exit
 * is a runner death and returns `{ ok: false }`.
 */
export async function runSpecReconcile(opts: RunSpecReconcileOpts): Promise<ReconcileRunOutcome> {
  const prompt = buildReconcilePrompt({
    spec: opts.spec,
    ticketNumber: opts.ticketNumber,
    title: opts.title,
    criteria: opts.criteria,
    failureOutput: opts.failureOutput,
    authoredFailing: opts.authoredFailing,
    diff: opts.diff,
  });
  const result = await executeOpendCode(prompt, {
    cwd: opts.cwd,
    ledgerDir: opts.ledgerDir,
    phaseFile: opts.phaseFile,
    model: opts.model,
    live: opts.live ?? false,
    verbose: opts.verbose ?? false,
    heartbeat: false,
    livePrefix: "reconcile",
    guardMode: "kill",
    maxSteps: opts.maxSteps ?? RECONCILE_MAX_STEPS,
    stallTimeoutSec: opts.stallTimeoutSec ?? null,
    maxStepModelSec: opts.maxStepModelSec,
    maxContextTokens: opts.maxContextTokens,
    stopAfterMarker: RECONCILE_END_RE,
  });
  if (result.status === "transient") {
    throw new Error(`reconcile ${opts.phaseFile}: ${describeExecFailure(result)}`);
  }
  if (result.status !== "ok") {
    return { ok: false, detail: describeExecFailure(result) };
  }
  const transcript = await extractAssistantText(opts.ledgerDir, opts.phaseFile);
  const parsed = parseReconcileVerdict(transcript);
  if (!parsed) {
    return { ok: false, detail: "no $RECONCILE_* verdict marker found in the arbiter's reply" };
  }
  return { ok: true, verdict: parsed.verdict, findings: parsed.findings, edits: parsed.edits };
}
