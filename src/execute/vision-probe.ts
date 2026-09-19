/**
 * Vision capability probe (ADR 0036): can the model behind a seat actually
 * see image pixels? `opencode models --verbose` reports a DECLARED capability
 * — a provider that strips image parts, or a text-only checkpoint behind a
 * vision-declaring id, passes that check and then fails the reviewers'
 * screenshot workflow mid-run. This module measures the round trip the
 * reviewers depend on: a railhead-generated PNG is written to disk, a fresh
 * `opencode run` reads it with the `read` tool, and the answer is verified.
 *
 * The image content is random per probe and never appears in the prompt, so a
 * text-only model that guesses is overwhelmingly likely to answer wrong — the
 * same asymmetry that makes the probe a measurement instead of a self-report.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { DEFAULT_MODEL, type GateMode } from "../config/config.ts";
import { executeOpendCode } from "./executor.ts";
import { eventPath, extractAssistantText, initLedger, ledgerDir, resetPhase } from "../core/ledger.ts";
import { parseToolCalls, toolResultContainsImage } from "../gates/evidence.ts";

export const PROBE_VERSION = 1;
export const ANSWER_MARKER = "VISION_PROBE_ANSWER";
export const NOREAD_MARKER = "VISION_PROBE_NOREAD";

export const PROBE_COLORS = [
  { name: "red", rgb: [220, 40, 40] },
  { name: "green", rgb: [40, 180, 70] },
  { name: "blue", rgb: [50, 90, 240] },
  { name: "yellow", rgb: [240, 210, 40] },
] as const;

const SIGNAL_COLORS = PROBE_COLORS.map((c) => c.name);

const PROBE_CELL_PX = 24;

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

/** A random permutation of {@link PROBE_COLORS} indices: four distinct colors,
 * equal area, no prompt leakage. Draw order is the answer. */
export function randomProbeSpec(rng: () => number = Math.random): number[] {
  const order = PROBE_COLORS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Encode a truecolor PNG of the probe spec — four side-by-side solid squares.
 * Hand-rolled (node:zlib + chunk framing) so the probe carries no dependency a
 * project's toolchain could lack. Pure. */
export function buildProbePng(spec: readonly number[], cellPx = PROBE_CELL_PX): Buffer {
  const width = spec.length * cellPx;
  const height = cellPx;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    let off = y * (1 + width * 3);
    raw[off++] = 0;
    for (const index of spec) {
      const [r, g, b] = PROBE_COLORS[index]!.rgb;
      for (let x = 0; x < cellPx; x++) {
        raw[off++] = r;
        raw[off++] = g;
        raw[off++] = b;
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function probePrompt(imagePath: string): string {
  const names = SIGNAL_COLORS.join(", ");
  return `You are being tested. Complete these two steps, then stop:

1. Read the image file ${imagePath} using your file-reading tool (the "read" tool).
2. Identify the color of each square in the image, left to right.

The image shows four square blocks side by side, each a solid color drawn from this set: ${names}. All four colors are different.
Reply with exactly one line: ${ANSWER_MARKER} color1, color2, color3, color4
If you cannot read image files at all, reply with exactly: ${NOREAD_MARKER}
Use no other tools, and add no other prose.`;
}

export interface ProbeAnswer {
  colors: string[];
  correct: boolean;
  selfReportedNoRead: boolean;
}

/** Tolerant of prose around the marker: the recognized color words are read in
 * order off the marked line, so "The colors are red, blue, ..." still parses,
 * while a wrong order or a missing color fails. Pure. */
export function parseProbeAnswer(text: string, spec: readonly number[]): ProbeAnswer {
  const selfReportedNoRead = text.includes(NOREAD_MARKER);
  const line = text.split("\n").find((l) => l.includes(ANSWER_MARKER)) ?? "";
  const colors = line.toLowerCase().match(/\b(red|green|blue|yellow)\b/g) ?? [];
  const expected = spec.map((i) => PROBE_COLORS[i]!.name);
  const correct = !selfReportedNoRead && colors.length === expected.length && colors.every((c, i) => c === expected[i]);
  return { colors, correct, selfReportedNoRead };
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
}

export interface VisionProbeOptions {
  cwd: string;
  model: string | null;
  maxContextTokens?: number | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
}

export async function runVisionProbe(options: VisionProbeOptions): Promise<VisionProbeOutcome> {
  const { cwd } = options;
  const model = options.model === DEFAULT_MODEL ? null : options.model;
  const modelKey = model ?? DEFAULT_MODEL;
  const dir = ledgerDir(cwd, "vision-probe");
  const imagePath = join(".railhead", "vision-probe", "probe.png");
  const spec = randomProbeSpec();

  await mkdir(dir, { recursive: true });
  await writeFile(join(cwd, imagePath), buildProbePng(spec));
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

  const error = result.status === "ok"
    ? null
    : `agent ${result.status === "timeout" ? "stalled (no output)" : result.status === "budget_exceeded" ? `exceeded step budget (${result.steps} steps)` : `exited ${result.code}`} — ${result.errorMessage ?? "no error message"}`;

  return {
    model: modelKey,
    ok: error === null && parsed.correct,
    sawImageBlock,
    answerCorrect: parsed.correct,
    selfReportedNoRead: parsed.selfReportedNoRead,
    answerColors: parsed.colors,
    expectedColors: spec.map((i) => PROBE_COLORS[i]!.name),
    error,
  };
}

export interface VisionCapabilityRecord {
  model: string;
  reads_images: boolean;
  saw_image_block: boolean;
  answer_correct: boolean;
  self_reported_no_read: boolean;
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
  const record = (await readVisionCapabilities(cwd)).find((r) => r.model === key && r.probe_version === PROBE_VERSION);
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
  return `vision gate refused: ${seat} review needs a model that can actually see images, but ${label} failed the vision probe (${describeVisionOutcome(outcome)}). Configure a vision-capable model for the ${seat} seat, or set ${seat}_review.mode to "off". Probe transcript: .railhead/vision-probe/events/vision-probe.jsonl`;
}

/** Probe each distinct seat model once (always — a model id's backing model can
 * change under it, so a cached "yes" is not evidence), record the outcomes, and
 * refuse when a requested gate's model cannot see. Budgets are deliberately
 * tight and independent of the run's phase limits: a probe is three steps of
 * work, and a wedged probe must never inherit a multi-hour stall tolerance. */
export async function ensureVisionForGates(options: {
  cwd: string;
  requests: VisionGateRequest[];
  maxContextTokens?: number | null;
}): Promise<VisionCapabilityRecord[]> {
  const { cwd, requests } = options;
  const byModel = new Map<string, VisionProbeOutcome>();
  const records: VisionCapabilityRecord[] = [];
  for (const request of requests) {
    if (request.model === null) {
      throw new Error(`vision gate refused: ${request.gate} review is enabled but no ${request.gate} model is configured (set model.${request.gate} or ${request.gate}_review.mode to "off").`);
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
    if (!outcome.ok) throw new Error(describeProbeFailure(request, outcome));
  }
  return records;
}

export function describeVisionOutcome(outcome: VisionProbeOutcome): string {
  if (outcome.ok) {
    return `read the generated PNG and named all four colors (${outcome.expectedColors.join(", ")})`;
  }
  if (outcome.error) return `the agent ${outcome.error}`;
  if (outcome.selfReportedNoRead) return "the model reported it cannot read image files";
  return `it answered "${outcome.answerColors.join(", ") || "nothing"}" instead of "${outcome.expectedColors.join(", ")}" — it did not receive the pixels`;
}

/** ADR 0036: the implementer's visual self-check is optional, so a surfaced
 * run measures the implement seat only when no current-version record covers
 * today's model — a gate always re-probes; this seat does not pay that cost on
 * every run once measured. `skip` names models already probed this invocation
 * (the gate seats), so an all-one-model config probes once. */
export async function ensureImplementerVision(options: {
  cwd: string;
  model: string | null;
  skip?: ReadonlySet<string>;
  maxContextTokens?: number | null;
}): Promise<VisionCapabilityRecord | null> {
  const { cwd, model } = options;
  if (model === null || options.skip?.has(model)) return null;
  const existing = (await readVisionCapabilities(cwd)).find((r) => r.model === model && r.probe_version === PROBE_VERSION);
  if (existing) return existing;
  const outcome = await runVisionProbe({
    cwd,
    model,
    maxContextTokens: options.maxContextTokens ?? null,
    maxSteps: 12,
    stallTimeoutSec: 120,
  });
  return recordVisionCapability(cwd, outcome);
}
