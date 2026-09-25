import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeExecFailure, executeOpendCode } from "../execute/executor.ts";
import { SPIRAL_COMPACTION_THRESHOLD } from "../execute/failure-ladder.ts";
import { extractAssistantText } from "../core/ledger.ts";
import { contextBudget } from "../config/config.ts";
import type { RunState } from "../core/state.ts";

/** Threshold (in characters) above which verify/smoke output is summarized
 * before being fed forward as `prevFeedback`. ~2k tokens ≈ ~8k chars at 4
 * chars/token — generous enough that short failure output passes through
 * verbatim (where it is maximally informative), tight enough that a 50k-char
 * cargo rebuild log gets compressed before it fills the next implementer's
 * context window. ADR 0014 / issue #8. */
export const SUMMARIZE_THRESHOLD_CHARS = 8000;

/** Per-ticket compaction counts as ticket-SIZING feedback: a ticket that had
 * to compact to fit is a ticket whose scope barely fit the model's window.
 * One compaction is normal fill management on a durable builder session; at
 * the spiral threshold the ticket provably did not fit (the ladder routes
 * that to a fresh session — failure-ladder.ts). The run summary surfaces the
 * counts so the human can re-slice the plan or raise the window instead of
 * just observing "the run felt slow". Pure; null when nothing compacted. */
export function contextPressureLine(
  tickets: { number: string; context?: { compactions: number } | undefined }[],
): string | null {
  const compacted = tickets.filter((t) => (t.context?.compactions ?? 0) > 0);
  if (compacted.length === 0) return null;
  const named = compacted.map((t) => `${t.number} (${t.context!.compactions} compaction${t.context!.compactions === 1 ? "" : "s"})`).join(", ");
  const spiral = compacted.some((t) => t.context!.compactions >= SPIRAL_COMPACTION_THRESHOLD);
  return spiral
    ? `Context pressure: ${named} — a ticket that compacts twice does not fit the model's context window; split it finer or raise max_context_tokens for this seat.`
    : `Context pressure: ${named} — tolerable, but the window filled once; watch for growth on later tickets.`;
}


/** Whether a blob is large enough to warrant summarization. Pure logic. */
export function shouldSummarize(blob: string): boolean {
  return blob.length >= SUMMARIZE_THRESHOLD_CHARS;
}

/** Build the prompt for a cheap-model summarization pass on a verify/smoke
 * output blob. The model is asked to produce a focused <500-token summary that
 * preserves the failure causes, the error messages, and the changed
 * assertions — the signal the next implementer needs, without the 10k-token
 * noise of a full build log. Works toolchain-agnostically: cargo, tsc, pytest,
 * go test — anything that produces text. Pure logic; the `executeOpendCode`
 * call lives in `run.ts`. */
export function buildOutputSummaryPrompt(blob: string, kind: "verify" | "smoke"): string {
  return `You are summarizing ${kind} output for a small-context model that will use it as feedback on its next implement attempt. The full output is too large to pass verbatim — your job is to compress it to the signal the implementer needs.

The output is below, between --- markers. Summarize it into AT MOST 500 tokens. Focus on:
1. What failed (the error message, the assertion, the panic signature — verbatim, not paraphrased).
2. Which file/line/test the failure points at (if named).
3. What changed since the last green run (if the output names a diff).
4. Anything that looks like a environment/tooling issue (missing dep, port conflict, permission denied) rather than a code bug.

Drop: warnings about unrelated modules, deprecation notices, successful test output, repeated stack frames beyond the first 3, ANSI escape codes, and any line that does not contribute to understanding the failure.

Output ONLY the summary, no preamble, no "here is the summary". The implementer reads it as if it were the raw output — do not add meta-commentary.

---
${blob}
---`;
}

/** Extract the summary from the model's response. The model may wrap the
 * summary in prose ("Here is the summary:") — strip a leading sentence if it
 * looks like meta-commentary. Mirrors the lossy-parser pattern from
 * `readHandoffMarker`: tolerant of garbage, returns the text as-is when
 * nothing needs stripping. Pure logic. */
export function parseSummary(transcript: string): string {
  const trimmed = transcript.trim();
  if (!trimmed) return "";
  // Strip a leading "Here is the summary:" or "Summary:" line if present.
  const stripped = trimmed.replace(/^(here is (?:a|the) summary|summary)[:\s]*\n?/i, "");
  return stripped.trim();
}

/** When a verify/smoke blob is large enough to fill the next implementer's
 * context window, run a cheap-model summarization pass on the `model.extract`
 * seat (ADR 0015) before the blob becomes `prevFeedback`. Returns the summary;
 * returns the original blob verbatim when it's small enough or when no extract
 * model is configured (the raw output is more informative than nothing).
 * Issue #8. */
export async function summarizeIfNeeded(
  state: RunState,
  ledger: string,
  phaseFile: string,
  blob: string,
  kind: "verify" | "smoke",
): Promise<string> {
  if (!shouldSummarize(blob)) return blob;
  const extractModel = state._models?.extract ?? null;
  if (extractModel === null) return blob;
  const prompt = buildOutputSummaryPrompt(blob, kind);
  const result = await executeOpendCode(prompt, {
    cwd: state.cwd,
    ledgerDir: ledger,
    phaseFile,
    model: extractModel,
    live: false, verbose: state.verbose,
    heartbeat: false,
    maxSteps: state.config.max_phase_steps,
    stallTimeoutSec: state.config.stall_timeout_sec,
    maxStepModelSec: state.config.max_step_model_sec,
    maxContextTokens: contextBudget(state),
  });
  if (result.status === "transient") throw new Error(`summarize: ${describeExecFailure(result)}`);
  if (result.status !== "ok") return blob;
  const transcript = await extractAssistantText(ledger, phaseFile);
  const summary = parseSummary(transcript);
  return summary || blob;
}

/** Build the prompt for an end-of-run summary. Takes the per-ticket logs and
 * produces a 1k-2k token "what was built" markdown summary for the human.
 * Stores as `.railhead/run-summary.md`. Issue #12 (proposal B). */
export function buildRunSummaryPrompt(ticketSummaries: string[]): string {
  return `You are writing a concise end-of-run summary of a railhead build. The build is complete. Below are the per-ticket logs (what each ticket did, its status, and any notes). Produce a single Markdown summary for the human who ran the build.

The summary should answer, in terse form:
1. What was built (1-2 sentences).
2. Ticket count and final statuses (how many committed, failed, skipped).
3. Any tickets that soft-passed (committed with residual findings) — name them and the residual issue in one line.
4. Any criteria marked UNVERIFIED (the builder could not prove them) — name them; the run is not fully verified while they stand.
5. Anything known fragile or worth a future \`railhead fix\` run.

Keep it under 1000 tokens. Use Markdown headings and bullets. No preamble, no "here is the summary" — just the Markdown.

Per-ticket logs:
${ticketSummaries.map((l) => `- ${l}`).join("\n")}`;
}

/** End-of-run distilled summary (issue #12, proposal B). Runs a cheap-model
 * extraction pass on the per-ticket logs to produce a 1k-2k token "what was
 * built" summary at `.railhead/run-summary.md`. The human gets a single
 * artifact; a future `railhead fix` run can read it as starting context.
 * Skipped when no extract model is configured (the raw `railhead overview` is
 * the fallback). No-ops on an empty run. */
export async function writeRunSummary(state: RunState, ledger: string): Promise<void> {
  if (state.tickets.length === 0) return;
  const extractModel = state._models?.extract ?? null;
  // No model configured: fall back to a machine-generated summary from the
  // ticket logs — no model call, just formatted strings.
  if (extractModel === null) {
    const summary = state.tickets
      .map((t) => `${t.number} ${t.title} — ${t.status}${(t.unverified?.length ?? 0) > 0 ? `\n  UNVERIFIED CRITERIA (not proven by any seat): ${t.unverified!.join(" | ")}` : ""}${t.logs.length ? `\n  ${t.logs.slice(-3).join("\n  ")}` : ""}`)
      .join("\n\n");
    const pressure = contextPressureLine(state.tickets);
    await writeFile(join(ledger, "..", "run-summary.md"), `# Run Summary\n\n${pressure ? `${pressure}\n\n` : ""}${summary}\n`, "utf8").catch(() => {});
    return;
  }
  const ticketSummaries = state.tickets.map((t) =>
    `${t.number} ${t.title} — status: ${t.status}, attempts: ${t.attempts}${(t.context?.compactions ?? 0) > 0 ? `, compactions: ${t.context!.compactions}` : ""}${(t.unverified?.length ?? 0) > 0 ? `, UNVERIFIED CRITERIA: ${t.unverified!.join(" | ")}` : ""}${t.logs.length ? ` | last logs: ${t.logs.slice(-3).join("; ")}` : ""}`,
  );
  const prompt = buildRunSummaryPrompt(ticketSummaries);
  const summaryPhase = "run-summary";
  const result = await executeOpendCode(prompt, {
    cwd: state.cwd,
    ledgerDir: ledger,
    phaseFile: summaryPhase,
    model: extractModel,
    live: !state.quiet, verbose: state.verbose,
    heartbeat: false,
    maxSteps: state.config.max_phase_steps,
    stallTimeoutSec: state.config.stall_timeout_sec,
    maxStepModelSec: state.config.max_step_model_sec,
    maxContextTokens: contextBudget(state),
  });
  if (result.status === "transient") throw new Error(`run summary: ${describeExecFailure(result)}`);
  if (result.status !== "ok") return;
  const transcript = await extractAssistantText(ledger, summaryPhase);
  if (!transcript.trim()) return;
  await writeFile(join(ledger, "..", "run-summary.md"), transcript.trim() + "\n", "utf8").catch(() => {});
}
