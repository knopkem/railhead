import { readFile } from "node:fs/promises";
import { eventPath } from "./ledger.ts";

/**
 * Context-window telemetry for one opencode phase, derived from the archived
 * `--format json` event stream. Lets a Run answer "was the context window big
 * enough for this ticket" and "did the model have to compact to fit".
 */
export interface PhaseContext {
  /** Number of compaction events: explicit `session.compacted` events plus
   *  auto-compaction markers (`text` parts with metadata.compaction_continue). */
  compactions: number;
  /** Peak context (input) tokens across all steps — how large the window grew. */
  peakInputTokens: number;
  /** Input tokens of the final step — the context the task actually finished at. */
  finalInputTokens: number;
  /** Sum of input tokens across all steps (a volume proxy for the whole run). */
  totalInputTokens: number;
  /** Sum of output tokens across all steps — how much the model generated. */
  totalOutputTokens: number;
  /** Total DECODE time in ms — for each step that demonstrably STREAMED
   * `text`/`reasoning` events (a nonzero first→last stream span), the span
   * from the first streamed token to step_finish, minus that step's
   * tool-execution time (from each `tool_use` `state.time`), summed across
   * steps. The first streamed token marks the end of prefill, so this window
   * never contains prompt processing; the post-text tool-call decode is
   * included because those tokens count in the step's output. The stream-span
   * gate matters: a non-streaming provider delivers the whole text part as
   * one event just before step_finish — anchoring there would divide by a
   * ~0 window and fabricate a thousand-tok/s rate. Steps without a proven
   * stream (tool-call-only steps, buffered providers) contribute NOTHING —
   * folding their wall in would merge prefill speed into token speed.
   * Subtracting tool runtime keeps a slow `npm test`/`build` from being
   * counted as decode. Unmeasured tool time (no `state.time`) remains in the
   * window — the rate then under-reads, never over-reads. */
  generationMs: number;
  /** Output tokens of exactly the steps that contributed to `generationMs` —
   * the rate's numerator must come from the same steps as its denominator,
   * or unmeasured steps would fabricate a decode rate. */
  decodeOutputTokens: number;
  /** Output tokens per second during DECODE — `decodeOutputTokens / (generationMs / 1000)`.
   * 0 when no step produced a measurable decode window. */
  outputTokensPerSec: number;
  /** Total step wall in ms — step_start→step_finish minus tool-execution
   * time, summed over every step with both timestamps. Includes prefill,
   * so it is the denominator for end-to-end throughput only. */
  wallMs: number;
  /** End-to-end output tokens per second — `totalOutputTokens / (wallMs / 1000)`.
   * Includes prompt-processing time; on a local server with a large context
   * this reads far below the decode rate, which is honest, not a bug.
   * 0 when wall time is unknown. */
  endToEndTokensPerSec: number;
}

/** Analyze a phase's event stream for compaction and context-window usage. */
export async function analyzePhase(
  ledgerDir: string,
  phaseFile: string,
): Promise<PhaseContext> {
  let raw = "";
  try {
    raw = await readFile(eventPath(ledgerDir, phaseFile), "utf8");
  } catch {
    return { compactions: 0, peakInputTokens: 0, finalInputTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, generationMs: 0, decodeOutputTokens: 0, outputTokensPerSec: 0, wallMs: 0, endToEndTokensPerSec: 0 };
  }

  let compactions = 0;
  let peak = 0;
  let final = 0;
  let total = 0;
  let totalOutput = 0;
  let firstGenTs: number | null = null;
  let lastGenTs: number | null = null;
  let stepStartTs: number | null = null;
  let stepToolMs = 0;
  let generationMs = 0;
  let decodeOutput = 0;
  let wallMs = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "session.compacted") {
      compactions++;
      continue;
    }
    // opencode's auto-compaction surfaces as a synthetic `text` part carrying
    // metadata.compaction_continue === true (it is not a session.compacted
    // event). Count it here so the report's "compactions N" reflects reality;
    // otherwise a run that compacted heavily reports zero and the context
    // budget looks fine when it isn't.
    if (ev.type === "text" && ev.part?.metadata?.compaction_continue === true) {
      compactions++;
    }
    if (ev.type === "step_start") {
      firstGenTs = null;
      lastGenTs = null;
      stepToolMs = 0;
      if (typeof ev.timestamp === "number") stepStartTs = ev.timestamp;
      continue;
    }
    if (ev.type === "tool_use") {
      const state = ev.part?.state;
      if (state && (state.status === "completed" || state.status === "error")) {
        const time = state.time;
        if (time && typeof time.start === "number" && typeof time.end === "number") {
          stepToolMs += Math.max(0, time.end - time.start);
        }
      }
      continue;
    }
    if (ev.type === "text" || ev.type === "reasoning") {
      if (typeof ev.timestamp === "number") {
        if (firstGenTs === null) firstGenTs = ev.timestamp;
        lastGenTs = ev.timestamp;
      }
      continue;
    }
    if (ev.type === "step_finish") {
      const tokens = ev.part?.tokens;
      const input = typeof tokens?.input === "number" ? tokens.input : 0;
      const output = typeof tokens?.output === "number" ? tokens.output : 0;
      peak = Math.max(peak, input);
      if (input > 0) final = input;
      total += input;
      totalOutput += output;
      const finishTs = typeof ev.timestamp === "number" ? ev.timestamp : null;
      if (stepStartTs !== null && finishTs !== null) {
        const wall = finishTs - stepStartTs - stepToolMs;
        if (wall > 0) wallMs += wall;
      }
      if (firstGenTs !== null && lastGenTs !== null && lastGenTs > firstGenTs && finishTs !== null) {
        const decode = finishTs - firstGenTs - stepToolMs;
        if (decode > 0) {
          generationMs += decode;
          decodeOutput += output;
        }
      }
      firstGenTs = null;
      lastGenTs = null;
      stepStartTs = null;
      stepToolMs = 0;
    }
  }

  const outputTokensPerSec = generationMs > 0 ? Math.round((decodeOutput / generationMs) * 1000) : 0;
  const endToEndTokensPerSec = wallMs > 0 ? Math.round((totalOutput / wallMs) * 1000) : 0;

  return { compactions, peakInputTokens: peak, finalInputTokens: final, totalInputTokens: total, totalOutputTokens: totalOutput, generationMs, decodeOutputTokens: decodeOutput, outputTokensPerSec, wallMs, endToEndTokensPerSec };
}

/** Merge multiple per-phase contexts into one aggregate, as for a ticket
 * that ran several implement attempts. Sums tokens and generation time
 * (throughput is proportional); takes the max for peak; takes the last
 * non-zero for final (the context the ticket actually ended at). */
export function mergePhases(phases: PhaseContext[]): PhaseContext {
  if (phases.length === 0) {
    return { compactions: 0, peakInputTokens: 0, finalInputTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, generationMs: 0, decodeOutputTokens: 0, outputTokensPerSec: 0, wallMs: 0, endToEndTokensPerSec: 0 };
  }
  let compactions = 0;
  let peak = 0;
  let final = 0;
  let total = 0;
  let totalOutput = 0;
  let generationMs = 0;
  let decodeOutput = 0;
  let wallMs = 0;
  for (const p of phases) {
    compactions += p.compactions;
    peak = Math.max(peak, p.peakInputTokens);
    if (p.finalInputTokens > 0) final = p.finalInputTokens;
    total += p.totalInputTokens;
    totalOutput += p.totalOutputTokens;
    generationMs += p.generationMs;
    decodeOutput += p.decodeOutputTokens;
    wallMs += p.wallMs;
  }
  const outputTokensPerSec = generationMs > 0 ? Math.round((decodeOutput / generationMs) * 1000) : 0;
  const endToEndTokensPerSec = wallMs > 0 ? Math.round((totalOutput / wallMs) * 1000) : 0;
  return { compactions, peakInputTokens: peak, finalInputTokens: final, totalInputTokens: total, totalOutputTokens: totalOutput, generationMs, decodeOutputTokens: decodeOutput, outputTokensPerSec, wallMs, endToEndTokensPerSec };
}

/** Aggregate the context telemetry of a ticket across ALL its implement/build
 * phase files — not just the final successful attempt. A durable-session
 * builder's compaction usually lands inside an attempt that exits WITHOUT a
 * checkpoint marker (run-20260907-2146 ticket 07: the marker-bearing file
 * resumed post-compaction at ~39k, so per-ticket "compactions 0 / peak 39k"
 * hid the 69.7k→38.9k compaction in the attempt that drove it there). Every
 * attempt writes its own phase file; analyzing each and merging reports the
 * ticket's true peak and compaction count. Missing/empty files contribute
 * nothing (an attempt killed before its first event is not "0 tokens of work"
 * — it is absent). */
export async function summarizePhaseFiles(
  ledgerDir: string,
  phaseFiles: Iterable<string>,
): Promise<PhaseContext> {
  const seen = new Set<string>();
  const phases: PhaseContext[] = [];
  for (const f of phaseFiles) {
    if (seen.has(f)) continue;
    seen.add(f);
    const ctx = await analyzePhase(ledgerDir, f);
    if (ctx.peakInputTokens > 0 || ctx.totalOutputTokens > 0 || ctx.compactions > 0) {
      phases.push(ctx);
    }
  }
  return mergePhases(phases);
}