/**
 * Vision capability probe (ADR 0036): can the model behind a seat actually
 * see image pixels? `opencode models --verbose` reports a DECLARED capability
 * — a provider that strips image parts, or a text-only checkpoint behind a
 * vision-declaring id, passes that check and then fails the reviewers'
 * screenshot workflow mid-run. This module measures the round trip the
 * reviewers depend on: a railhead-generated PNG is written to disk, a fresh
 * `opencode run` reads it with the `read` tool, and the answer is verified.
 *
 * The probe asks for the SET of colors present and their count, not their
 * left-to-right order. Order made a wrong-order answer from a model that did
 * receive pixels indistinguishable from blindness (ADR 0036 amendment), and
 * weaker local models that bind colors correctly still fumbled a four-cell
 * strip's order. A ten-name palette with four drawn keeps the guess space at
 * 1/C(10,4) = 1/210 — stronger than the old 1/24 — while carrying no order
 * requirement. A failed attempt is retried once with a fresh permutation,
 * because one flaky answer must not become a durable "measured blind" fact.
 * When no attempt's read ever returned an image block, the outcome is
 * INCONCLUSIVE: the toolchain failed, not the model, so no seat is told it is
 * blind on that evidence.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { DEFAULT_MODEL, type GateMode } from "../config/config.ts";
import { executeOpendCode } from "./executor.ts";
import { eventPath, extractAssistantText, initLedger, ledgerDir, resetPhase } from "../core/ledger.ts";
import { parseToolCalls, toolResultContainsImage } from "../gates/evidence.ts";

export const PROBE_VERSION = 2;
export const ANSWER_MARKER = "VISION_PROBE_ANSWER";
export const NOREAD_MARKER = "VISION_PROBE_NOREAD";

/** Ten perceptually separated colors: four are drawn per probe, so naming a
 * block can never be confused by a near-pair (red/blue, yellow/orange). */
export const PROBE_PALETTE = [
  { name: "red", rgb: [220, 40, 40] },
  { name: "orange", rgb: [240, 130, 30] },
  { name: "yellow", rgb: [240, 210, 40] },
  { name: "green", rgb: [40, 180, 70] },
  { name: "cyan", rgb: [40, 190, 200] },
  { name: "blue", rgb: [50, 90, 240] },
  { name: "purple", rgb: [140, 70, 200] },
  { name: "magenta", rgb: [220, 60, 160] },
  { name: "brown", rgb: [140, 90, 50] },
  { name: "gray", rgb: [130, 130, 130] },
] as const;

export const PROBE_BLOCKS = 4;
export const PROBE_CELL_PX = 80;
export const PROBE_GAP_PX = 16;
export const PROBE_BACKGROUND = [255, 255, 255] as const;

/** Two attempts: the retry exists for flaky tool use, not for blind guessing —
 * a text-only model cannot pass either attempt (1/210 per attempt). */
export const DEFAULT_PROBE_ATTEMPTS = 2;

const PROBE_NAMES: ReadonlySet<string> = new Set(PROBE_PALETTE.map((c) => c.name));

/** Model-authored synonyms mapped onto the palette's canonical names, so a
 * correct sighting is not failed by vocabulary (grey/gray, violet/purple). */
const COLOR_SYNONYMS: Record<string, string> = { violet: "purple", grey: "gray", silver: "gray" };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** A random four-block subset of {@link PROBE_PALETTE}: distinct colors, equal
 * area, no prompt leakage. The set — not the draw order — is the answer. */
export function randomProbeSpec(rng: () => number = Math.random): number[] {
  const order = PROBE_PALETTE.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order.slice(0, PROBE_BLOCKS);
}

/** Encode a truecolor PNG of the probe spec — solid blocks on a white canvas,
 * separated by gaps so patchifying encoders cannot blend neighbors. Hand-rolled
 * (node:zlib + chunk framing) so the probe carries no dependency a project's
 * toolchain could lack. Pure. */
export function buildProbePng(spec: readonly number[], cellPx = PROBE_CELL_PX): Buffer {
  const gap = PROBE_GAP_PX;
  const width = gap + spec.length * (cellPx + gap);
  const height = 2 * gap + cellPx;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    let off = y * stride;
    raw[off++] = 0;
    for (let x = 0; x < width; x++) {
      let rgb: readonly [number, number, number] = PROBE_BACKGROUND;
      for (let i = 0; i < spec.length; i++) {
        const x0 = gap + i * (cellPx + gap);
        if (x >= x0 && x < x0 + cellPx && y >= gap && y < gap + cellPx) {
          const { rgb: blockRgb } = PROBE_PALETTE[spec[i]!]!;
          rgb = blockRgb;
          break;
        }
      }
      raw[off++] = rgb[0];
      raw[off++] = rgb[1];
      raw[off++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The path is absolute on purpose: a relative path let weaker models rewrite
 * it to `/.railhead/...`, take the read error for a capability limit, and
 * answer the (now removed) no-read marker. The read is forced before the
 * answer because an unforced model answered from this prompt's text. */
export function probePrompt(imagePath: string): string {
  const names = PROBE_PALETTE.map((c) => c.name).join(", ");
  return `You are being tested. Use the read tool now on this image file: ${imagePath}. You MUST call the read tool before answering — the answer is NOT in this text.
The image shows four solid color blocks side by side, each a different color drawn from this list: ${names}.
Reply with exactly one line:
${ANSWER_MARKER} count=<number of blocks> colors=<comma-separated names of the colors present>
Use no other tools, and add no other prose.
If the read fails for a tool reason, report the exact error instead of concluding anything about your capabilities.`;
}

export interface ProbeAnswer {
  colors: string[];
  count: number;
  correct: boolean;
  selfReportedNoRead: boolean;
}

/** Order-free: the marked line's count and its set of recognized color names
 * are compared to the drawn subset. A bare color list (no `count=`/`colors=`
 * labels) still parses — the count defaults to the list length. Pure. */
export function parseProbeAnswer(text: string, spec: readonly number[]): ProbeAnswer {
  const selfReportedNoRead = text.includes(NOREAD_MARKER);
  const line = text.split("\n").find((l) => l.includes(ANSWER_MARKER)) ?? "";
  const expected: string[] = spec.map((i) => PROBE_PALETTE[i]!.name);
  const countMatch = /count\s*[=:]\s*(\d+)/i.exec(line);
  const colorsSection = /colors?\s*[=:]\s*([^\n]*)/i.exec(line)?.[1] ?? line;
  const mentioned = (colorsSection.toLowerCase().match(/[a-z]+/g) ?? [])
    .map((word) => COLOR_SYNONYMS[word] ?? word)
    .filter((word) => PROBE_NAMES.has(word));
  const colors = [...new Set(mentioned)];
  const count = countMatch ? Number(countMatch[1]) : colors.length;
  const correct = !selfReportedNoRead
    && count === expected.length
    && colors.length === expected.length
    && colors.every((c) => expected.includes(c));
  return { colors, count, correct, selfReportedNoRead };
}

export interface VisionProbeOutcome {
  model: string;
  ok: boolean;
  sawImageBlock: boolean;
  answerCorrect: boolean;
  selfReportedNoRead: boolean;
  answerColors: string[];
  expectedColors: string[];
  error: string | null;
  /** No attempt's read ever returned an image block: the probe measured the
   * toolchain (path, permission, provider stripping), not the model. Never
   * injects a "measured blind" claim; gates still refuse because vision is
   * unverified. */
  inconclusive: boolean;
  /** opencode invocations spent: 1 when the first attempt passed, otherwise
   * the attempt count (a fresh permutation each). */
  attempts: number;
}

export interface VisionProbeOptions {
  cwd: string;
  model: string | null;
  maxContextTokens?: number | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  attempts?: number | null;
}

/** Rank for {@link pickBestProbeOutcome}: a pass outranks a delivered-but-
 * misread attempt, which outranks an attempt where no image ever arrived.
 * Ties keep the later attempt (freshest evidence). Pure. */
function outcomeRank(outcome: VisionProbeOutcome): number {
  if (outcome.ok) return 2;
  if (outcome.sawImageBlock) return 1;
  return 0;
}

export function pickBestProbeOutcome(a: VisionProbeOutcome, b: VisionProbeOutcome): VisionProbeOutcome {
  return outcomeRank(b) >= outcomeRank(a) ? b : a;
}

async function runProbeAttempt(options: VisionProbeOptions, model: string | null): Promise<VisionProbeOutcome> {
  const { cwd } = options;
  const modelKey = model ?? DEFAULT_MODEL;
  const dir = ledgerDir(cwd, "vision-probe");
  const imagePath = join(cwd, ".railhead", "vision-probe", "probe.png");
  const spec = randomProbeSpec();

  await mkdir(dir, { recursive: true });
  await writeFile(imagePath, buildProbePng(spec));
  await initLedger(dir);
  const phaseFile = "vision-probe";
  await resetPhase(dir, phaseFile);

  const result = await executeOpendCode(probePrompt(imagePath), {
    cwd,
    ledgerDir: dir,
    phaseFile,
    model,
    agent: null,
    live: true,
    verbose: false,
    heartbeat: true,
    livePrefix: "vision-probe",
    maxSteps: options.maxSteps ?? 12,
    stallTimeoutSec: options.stallTimeoutSec ?? 120,
    maxContextTokens: options.maxContextTokens ?? 32000,
  });

  let jsonlText = "";
  try {
    jsonlText = await readFile(eventPath(dir, phaseFile), "utf8");
  } catch {
    // ledger may not exist when the process was killed before its first event
  }
  const calls = parseToolCalls(jsonlText);
  const readOfProbe = calls.find((c) => {
    const path = (c.input.filePath as string) ?? (c.input.path as string) ?? "";
    return path.includes("probe.png");
  });
  const sawImageBlock = readOfProbe ? toolResultContainsImage(readOfProbe.output, readOfProbe.attachments) : false;
  const answerText = await extractAssistantText(dir, phaseFile).catch(() => "");
  const parsed = parseProbeAnswer(answerText, spec);
  const ok = result.status === "ok" && parsed.correct;

  const error = result.status === "ok"
    ? null
    : `agent ${result.status === "timeout" ? "stalled (no output)" : result.status === "budget_exceeded" ? `exceeded step budget (${result.steps} steps)` : `exited ${result.code}`} — ${result.errorMessage ?? "no error message"}`;

  return {
    model: modelKey,
    ok,
    sawImageBlock,
    answerCorrect: parsed.correct,
    selfReportedNoRead: parsed.selfReportedNoRead,
    answerColors: parsed.colors,
    expectedColors: spec.map((i) => PROBE_PALETTE[i]!.name),
    error,
    inconclusive: !ok && !sawImageBlock,
    attempts: 1,
  };
}

export async function runVisionProbe(options: VisionProbeOptions): Promise<VisionProbeOutcome> {
  const model = options.model === DEFAULT_MODEL ? null : options.model;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_PROBE_ATTEMPTS);
  let best: VisionProbeOutcome | null = null;
  let spent = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = await runProbeAttempt(options, model);
    spent = attempt;
    best = best === null ? outcome : pickBestProbeOutcome(best, outcome);
    if (best.ok) break;
  }
  return { ...best!, attempts: spent };
}

export interface VisionCapabilityRecord {
  model: string;
  reads_images: boolean;
  saw_image_block: boolean;
  answer_correct: boolean;
  self_reported_no_read: boolean;
  /** No image block ever came back: no measurement. Readers treat this as
   * absent, so it neither grants nor denies vision. */
  probe_inconclusive: boolean;
  verified_at: string;
  probe_version: number;
}

export function capabilityFilePath(cwd: string): string {
  return join(cwd, ".railhead", "capabilities.json");
}

/** Lossy by contract: a corrupt or absent record reads as "no record" (the
 * probe re-runs; it never coerces a verdict from garbage, ADR 0009's shape). */
export async function readVisionCapabilities(cwd: string): Promise<VisionCapabilityRecord[]> {
  let raw = "";
  try {
    raw = await readFile(capabilityFilePath(cwd), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { probes?: unknown }).probes)) return [];
  const out: VisionCapabilityRecord[] = [];
  for (const entry of (parsed as { probes: unknown[] }).probes) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.model !== "string" || typeof e.reads_images !== "boolean") continue;
    out.push({
      model: e.model,
      reads_images: e.reads_images,
      saw_image_block: e.saw_image_block === true,
      answer_correct: e.answer_correct === true,
      self_reported_no_read: e.self_reported_no_read === true,
      probe_inconclusive: e.probe_inconclusive === true,
      verified_at: typeof e.verified_at === "string" ? e.verified_at : "",
      probe_version: typeof e.probe_version === "number" ? e.probe_version : 0,
    });
  }
  return out;
}

export function outcomeToRecord(outcome: VisionProbeOutcome, verifiedAt = new Date().toISOString()): VisionCapabilityRecord {
  return {
    model: outcome.model,
    reads_images: outcome.ok,
    saw_image_block: outcome.sawImageBlock,
    answer_correct: outcome.answerCorrect,
    self_reported_no_read: outcome.selfReportedNoRead,
    probe_inconclusive: outcome.inconclusive,
    verified_at: verifiedAt,
    probe_version: PROBE_VERSION,
  };
}

export async function recordVisionCapability(cwd: string, outcome: VisionProbeOutcome): Promise<VisionCapabilityRecord> {
  const record = outcomeToRecord(outcome);
  const existing = await readVisionCapabilities(cwd);
  const next = [record, ...existing.filter((r) => r.model !== outcome.model)];
  await mkdir(join(cwd, ".railhead"), { recursive: true });
  await writeFile(capabilityFilePath(cwd), JSON.stringify({ version: 1, probes: next }, null, 2) + "\n", "utf8");
  return record;
}

export interface VisionGateRequest {
  gate: "visual" | "goal";
  model: string | null;
}

/** The seats a run's resolved gate modes actually need vision from. Pure. */
export function visionGateRequests(
  modes: { visual: GateMode; goal: GateMode },
  models: { visual: string | null; goal: string | null },
): VisionGateRequest[] {
  const out: VisionGateRequest[] = [];
  if (modes.visual !== "off") out.push({ gate: "visual", model: models.visual });
  if (modes.goal !== "off") out.push({ gate: "goal", model: models.goal });
  return out;
}

/** The capability as the prompts state it. Unlike a learnings line this is a
 * railhead measurement, so no seat may retract or override it — a model that
 * "decides" it does not want to read images is contradicted by the probe. */
export interface VisionCapabilityFact {
  readsImages: boolean;
  verifiedAt: string;
}

export async function readVisionCapabilityFor(cwd: string, model: string | null): Promise<VisionCapabilityFact | null> {
  const key = model === null ? DEFAULT_MODEL : model;
  const record = (await readVisionCapabilities(cwd)).find(
    (r) => r.model === key && r.probe_version === PROBE_VERSION && !r.probe_inconclusive,
  );
  return record ? { readsImages: record.reads_images, verifiedAt: record.verified_at } : null;
}

export function visionCapabilityBlock(fact: VisionCapabilityFact | null, seat: "implement" | "visual" | "goal"): string {
  if (!fact) return "";
  if (fact.readsImages) {
    if (seat === "implement") {
      return `\n## Vision capability (railhead-verified)
The railhead measured this seat's model: it read a generated PNG and identified its content correctly. If this ticket touches the rendered surface, use that capability — after implementing, run the app, capture a screenshot, and \`read\` it back to inspect your own layout. The a11y/DOM tree hides exactly the defects pixels expose (a control clipped to zero height, overlapping chrome, an off-screen toolbar). Never conclude "image reading is unusable in this environment" — the railhead verified it works for this seat.`;
    }
    return `\n## Vision capability (railhead-verified)
The railhead measured this seat's model on ${fact.verifiedAt}: it read a generated PNG and identified its content correctly. You MUST \`read\` every screenshot you capture before judging it — a read returning no pixels is a tool/config failure to report (or a halt), never an accepted environment limitation. "Image reading is unusable" is not a valid finding for this seat: the railhead refuses to run this gate on a model that failed this measurement.`;
  }
  if (seat === "implement") {
    return `\n## Vision capability (railhead-verified: no image reading)
The railhead measured this seat's model and it does NOT receive image pixels. Do not claim you visually checked anything; verify through the DOM/a11y tree, programmatic state reads, console output, and the build/test gate.`;
  }
  return `\n## Vision capability (railhead-verified: no image reading)
The railhead measured this seat's model and it does NOT receive image pixels. Do not claim to have seen screenshots; judge through real input plus DOM/a11y/state/console evidence, and label any purely visual conclusion unverified.`;
}

function describeProbeFailure(request: VisionGateRequest, outcome: VisionProbeOutcome): string {
  const seat = request.gate;
  const label = outcome.model === DEFAULT_MODEL ? "the opencode default model" : outcome.model;
  return `${seat} review needs a model that can actually see images, but ${label} failed the vision probe (${describeVisionOutcome(outcome)}). Configure a vision-capable model for the ${seat} seat, or set ${seat}_review.mode to "off". Probe transcript: .railhead/vision-probe/events/vision-probe.jsonl`;
}

/** A gate that cannot run vision-verified: either no model is configured for
 * the seat, or the probe measured it blind. `reason` is operator-facing. */
export interface VisionGateRefusal {
  gate: "visual" | "goal";
  model: string | null;
  reason: string;
}

/** Probe each distinct seat model once (always — a model id's backing model can
 * change under it, so a cached "yes" is not evidence), record the outcomes, and
 * COLLECT the gates that cannot run vision-verified. This function no longer
 * refuses itself: the caller decides what a refusal means — an unattended run
 * still hard-fails, but an interactive operator may choose to continue with
 * the affected gates off (a user with no vision-capable model at hand).
 * Budgets are deliberately tight and independent of the run's phase limits: a
 * probe is three steps of work, and a wedged probe must never inherit a
 * multi-hour stall tolerance. */
export async function ensureVisionForGates(options: {
  cwd: string;
  requests: VisionGateRequest[];
  maxContextTokens?: number | null;
}): Promise<{ records: VisionCapabilityRecord[]; refusals: VisionGateRefusal[] }> {
  const { cwd, requests } = options;
  const byModel = new Map<string, VisionProbeOutcome>();
  const records: VisionCapabilityRecord[] = [];
  const refusals: VisionGateRefusal[] = [];
  for (const request of requests) {
    if (request.model === null) {
      refusals.push({
        gate: request.gate,
        model: null,
        reason: `${request.gate} review is enabled but no ${request.gate} model is configured (set model.${request.gate} or ${request.gate}_review.mode to "off").`,
      });
      continue;
    }
    let outcome = byModel.get(request.model);
    if (!outcome) {
      outcome = await runVisionProbe({
        cwd,
        model: request.model,
        maxContextTokens: options.maxContextTokens ?? null,
        maxSteps: 12,
        stallTimeoutSec: 120,
      });
      byModel.set(request.model, outcome);
      records.push(await recordVisionCapability(cwd, outcome));
    }
    if (!outcome.ok) {
      refusals.push({ gate: request.gate, model: request.model, reason: describeProbeFailure(request, outcome) });
    }
  }
  return { records, refusals };
}

export function describeVisionOutcome(outcome: VisionProbeOutcome): string {
  if (outcome.ok) {
    return `read the generated PNG and named all blocks correctly (${outcome.expectedColors.join(", ")})`;
  }
  if (outcome.error) return `the agent ${outcome.error}`;
  if (outcome.selfReportedNoRead) return "the model reported it cannot read image files";
  const answered = outcome.answerColors.join(", ") || "nothing";
  const expected = outcome.expectedColors.join(", ");
  // sawImageBlock splits two failure modes with different remedies: the image
  // part never reached the model (provider/tool stripped it — fix the wiring)
  // vs pixels delivered but misread (weak vision, or a text-only checkpoint
  // behind a vision-declaring id). Claiming the first unconditionally was the
  // snake-run misdiagnosis: the probe transcript showed the image block
  // attached and ~23k input tokens, and the answer was the right set in the
  // wrong order — the set is disclosed in the prompt, so only order carries
  // signal, and one wrong-order answer cannot distinguish blind-lucky from
  // weak-vision.
  if (outcome.sawImageBlock) {
    return `the image block reached the model but it misread the probe (answered "${answered}" instead of "${expected}") — weak vision, or a text-only checkpoint behind a vision-declaring id`;
  }
  return `the read returned no image block — the image part never reached the model (answered "${answered}" instead of "${expected}"); the provider or the read tool stripped the pixels`;
}

/** ADR 0036: the implementer's visual self-check is optional, so a surfaced
 * run measures the implement seat only when no current-version PASS covers
 * today's model — a gate always re-probes; this seat does not pay that cost on
 * every run once verified. A negative or inconclusive record is re-probed every
 * invocation: a stale "no" silently disables the self-check (the opt-out §4
 * rejects), and it is the false-negative direction that a flaky probe
 * produced. `skip` names models already probed this invocation (the gate
 * seats), so an all-one-model config probes once. */
export async function ensureImplementerVision(options: {
  cwd: string;
  model: string | null;
  skip?: ReadonlySet<string>;
  maxContextTokens?: number | null;
}): Promise<VisionCapabilityRecord | null> {
  const { cwd, model } = options;
  if (model === null || options.skip?.has(model)) return null;
  const existing = (await readVisionCapabilities(cwd)).find((r) => r.model === model && r.probe_version === PROBE_VERSION);
  if (existing?.reads_images === true) return existing;
  const outcome = await runVisionProbe({
    cwd,
    model,
    maxContextTokens: options.maxContextTokens ?? null,
    maxSteps: 12,
    stallTimeoutSec: 120,
  });
  return recordVisionCapability(cwd, outcome);
}
