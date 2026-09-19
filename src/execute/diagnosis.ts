import { indexOfOutsideFences } from "../core/fences.ts";

/**
 * gh #110: the plan-producing diagnosis rung. When the implement path's
 * failure ladder exhausts to rung 3 (`class: "diagnosed"`), the railhead makes
 * exactly ONE deep-diagnosis model call whose output is a root-cause verdict
 * plus an optional corrective plan fed straight back to one final implementer
 * attempt. This module holds the two pure pieces — the lossy, fence-aware
 * marker parser and the prompt builder — so they carry the unit tests. The
 * orchestration (the actual `executeOpendCode` call) lives in run.ts.
 */

/** The diagnosis phase's output markers. `$DIAGNOSIS` is always required;
 * `$PLAN` is optional — its absence means the ticket is not recoverable this
 * run and the rung stays terminal. */
export const DIAGNOSIS_MARKER = "$DIAGNOSIS";
export const PLAN_MARKER = "$PLAN";

export interface DiagnosisOutput {
  /** The root-cause text. null when the phase never emitted `$DIAGNOSIS`. */
  diagnosis: string | null;
  /** The corrective plan. null when `$PLAN` was omitted (terminal) or the
   * phase emitted no diagnosis at all. */
  plan: string | null;
}

/** Index of `re` in `s`, or Infinity when absent. A `.search` adapter so the
 * block-boundary arithmetic below stays a single `Math.min`. */
function indexOrInfinity(s: string, re: RegExp): number {
  const i = s.search(re);
  return i < 0 ? Infinity : i;
}

/**
 * Parse a diagnosis-phase transcript into its two markers, lossily. The
 * opening markers are fence-aware (#108): a `$DIAGNOSIS`/`$PLAN` quoted inside
 * a code fence is an example, not a signal. The block bodies are sliced from
 * the RAW text (a root-cause or plan may legitimately quote code), terminated
 * at the first `$END` (or `$PLAN`, or end of text). Defensive defaults: no
 * `$DIAGNOSIS` → both null; an empty body → null; `$PLAN` without a preceding
 * `$DIAGNOSIS` is ignored.
 */
export function parseDiagnosis(text: string): DiagnosisOutput {
  const diagIdx = indexOfOutsideFences(text, /\$diagnosis\b/i);
  if (diagIdx < 0) return { diagnosis: null, plan: null };

  const diagBody = text.slice(diagIdx + DIAGNOSIS_MARKER.length);
  const diagEnd = Math.min(
    indexOrInfinity(diagBody, /\$end\b/i),
    indexOrInfinity(diagBody, /\$plan\b/i),
  );
  const diagnosis = (diagEnd === Infinity ? diagBody : diagBody.slice(0, diagEnd)).trim() || null;

  const planIdx = indexOfOutsideFences(text, /\$plan\b/i);
  let plan: string | null = null;
  if (planIdx > diagIdx) {
    const planBody = text.slice(planIdx + PLAN_MARKER.length);
    const planEnd = indexOrInfinity(planBody, /\$end\b/i);
    plan = (planEnd === Infinity ? planBody : planBody.slice(0, planEnd)).trim() || null;
  }
  return { diagnosis, plan };
}

export interface DiagnosisPromptOptions {
  ticketFile: string;
  ticketBody: string;
  criteria: string[];
  /** The accumulated failure evidence — what the retries actually did. */
  evidence: { errorMessage: string | null; status: string; peakTokens: number; steps: number }[];
  /** The failed phases' transcript paths, so the diagnostician can read them. */
  transcriptPaths: string[];
  /** The current working diff, or null when the tree is clean. */
  diff: string | null;
  /** A one-line-per-entry public-contract summary (or null). */
  contractsSummary?: string | null;
  /** Project learnings (tooling facts). */
  learnings?: string | null;
  /** Model context-window size in tokens. */
  contextBudget?: number;
}

/**
 * Build the diagnosis-phase prompt (gh #110). The diagnostician is read-only:
 * its job is to explain WHY the implementer kept failing (root cause) and, if
 * a concrete corrective path exists, spell out the step-by-step fix. The plan
 * is fed into ONE final implementer attempt; a missing `$PLAN` is the honest
 * "not recoverable this run" signal and behaves exactly as today's rung 3.
 */
export function buildDiagnosisPrompt(options: DiagnosisPromptOptions): string {
  const { ticketFile, ticketBody, criteria, evidence, transcriptPaths, diff, contractsSummary, learnings, contextBudget } = options;

  const criteriaBlock = criteria.length
    ? criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- (no acceptance criteria listed)";

  const evidenceBlock = evidence.length
    ? evidence.map((e, i) => `- attempt ${i + 1}: ${e.status}${e.errorMessage ? ` — ${e.errorMessage}` : ""} (peak ${e.peakTokens} tokens, ${e.steps} steps)`).join("\n")
    : "- (no structured failure evidence)";

  const transcriptBlock = transcriptPaths.length
    ? transcriptPaths.map((p) => `- ${p}`).join("\n")
    : "- (no transcripts)";

  const diffBlock = diff && diff.trim()
    ? `\n## Current working diff\n${diff}`
    : "\n## Current working diff\n(no working diff — the tree is clean)";

  const contractsBlock = contractsSummary
    ? `\n## Existing public contracts (the surface the implementer was working against)\n${contractsSummary}`
    : "";

  const learningsBlock = learnings
    ? `\n## Project learnings (tooling facts from prior phases)\n${learnings}`
    : "";

  return `You are the Diagnostician for a ticket whose implementer has failed repeatedly in an unattended build (gh #110). You are READ-ONLY: diagnose, do not edit. The implementer — a fresh-context, small-model agent — has already burned its failure ladder (retry → worker restart → this diagnosis) without producing a working change. Your job is to figure out WHY it kept failing and, when a concrete fix path exists, write the step-by-step plan a fresh implementer can follow.

Read the failure evidence and (if helpful) the failed transcripts below. Do not re-run the whole build; use targeted reads/greps to confirm the root cause you are asserting.${contextBudget ? `\nYour context window is budgeted to roughly ${Math.floor(contextBudget / 1000)}k tokens — keep reads small.` : ""}

TICKET FILE: ${ticketFile}

TICKET:
${ticketBody}

ACCEPTANCE CRITERIA:
${criteriaBlock}

## Failure history (what the retries actually did)
${evidenceBlock}

## Failed transcript paths (read these to see what was tried)
${transcriptBlock}${diffBlock}${contractsBlock}${learningsBlock}

## Output contract (lossy — the railhead parses these markers)
Emit EXACTLY the markers below, on their own lines. The root-cause block is REQUIRED; the plan block is OPTIONAL:

${DIAGNOSIS_MARKER}
<the root cause, in concrete terms: what specific mistake, wrong assumption, or environment fact made the implementer fail. Name files/symbols/errors, not vibes.>
$END

${PLAN_MARKER}
<numbered, step-by-step instructions a fresh implementer can execute: which file(s) to edit, what to change, what command to run to confirm. Max 7 steps.>
$END

Rules:
- Always emit ${DIAGNOSIS_MARKER} with a real root cause.
- Emit ${PLAN_MARKER} ONLY when a concrete corrective path exists. If the ticket is genuinely not recoverable this run — the plan is wrong, the environment is broken, the acceptance criteria cannot be met — OMIT ${PLAN_MARKER} entirely. Omitting it is the honest stop signal; do NOT emit ${PLAN_MARKER} NONE.
- Never tell the implementer to just "retry" — the retries already happened. Either give a DIFFERENT approach, or stay silent on the plan.

Reply terse, no prose narration outside the markers.`;
}
