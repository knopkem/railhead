import { describe, it, expect, vi } from "vitest";
import { inflateSync } from "node:zlib";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../core/ledger.ts";
import {
  ANSWER_MARKER,
  NOREAD_MARKER,
  PROBE_COLORS,
  buildProbePng,
  capabilityFilePath,
  describeVisionOutcome,
  ensureVisionForGates,
  outcomeToRecord,
  parseProbeAnswer,
  probePrompt,
  randomProbeSpec,
  readVisionCapabilities,
  readVisionCapabilityFor,
  recordVisionCapability,
  visionCapabilityBlock,
  visionGateRequests,
  type VisionProbeOutcome,
} from "./vision-probe.ts";

/** The mocked executor's behavior: "see" decodes the generated probe PNG and
 * answers its true order; "blind" answers the correct order rotated by one
 * (guaranteed wrong for four distinct colors). */
let probeBehavior: "see" | "blind" = "see";
let probeCalls = 0;

vi.mock("./executor.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./executor.ts")>();
  return {
    ...mod,
    executeOpendCode: async (_prompt: string, options: { cwd: string; ledgerDir: string; phaseFile: string }) => {
      probeCalls++;
      const png = await readFile(join(options.cwd, ".railhead", "vision-probe", "probe.png"));
      const raw = inflateSync(pngChunks(png)[1]!.data);
      const names: string[] = [];
      for (let cell = 0; cell < 4; cell++) {
        const off = 1 + cell * 24 * 3;
        const rgb = [raw[off], raw[off + 1], raw[off + 2]];
        names.push(PROBE_COLORS.find((c) => c.rgb.every((v, i) => v === rgb[i]))!.name);
      }
      if (probeBehavior === "blind") names.push(names.shift()!);
      await appendEvent(options.ledgerDir, options.phaseFile, JSON.stringify({ type: "text", part: { type: "text", text: `${ANSWER_MARKER} ${names.join(", ")}` } }));
      return { status: "ok" as const, code: 0, signal: null, errorMessage: null, durationMs: 1, steps: 2, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 10, generationMs: 1, toolCalls: 1 };
    },
  };
});

function pngChunks(png: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  let off = 8;
  while (off < png.length) {
    const length = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString("ascii");
    chunks.push({ type, data: png.subarray(off + 8, off + 8 + length) });
    off += 12 + length;
  }
  return chunks;
}

const out = (over: Partial<VisionProbeOutcome> = {}): VisionProbeOutcome => ({
  model: "test/model",
  ok: true,
  sawImageBlock: true,
  answerCorrect: true,
  selfReportedNoRead: false,
  answerColors: ["red", "green", "blue", "yellow"],
  expectedColors: ["red", "green", "blue", "yellow"],
  error: null,
  ...over,
});

describe("randomProbeSpec", () => {
  it("returns a permutation of all four color indices", () => {
    const spec = randomProbeSpec(() => 0.5);
    expect([...spec].sort()).toEqual([0, 1, 2, 3]);
  });

  it("is deterministic for a fixed rng", () => {
    expect(randomProbeSpec(() => 0.1)).toEqual(randomProbeSpec(() => 0.1));
  });
});

describe("buildProbePng", () => {
  const spec = [2, 0, 3, 1];
  const png = buildProbePng(spec);

  it("emits a valid PNG signature and chunk sequence", () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("declares an 8-bit truecolor image sized to the spec", () => {
    const ihdr = pngChunks(png)[0]!.data;
    expect(ihdr.readUInt32BE(0)).toBe(spec.length * 24);
    expect(ihdr.readUInt32BE(4)).toBe(24);
    expect(ihdr[8]).toBe(8);
    expect(ihdr[9]).toBe(2);
  });

  it("inflates to one filter byte plus RGB per pixel", () => {
    const raw = inflateSync(pngChunks(png)[1]!.data);
    expect(raw.length).toBe(24 * (1 + spec.length * 24 * 3));
  });

  it("paints each cell with its spec color", () => {
    const raw = inflateSync(pngChunks(png)[1]!.data);
    const rowStride = 1 + spec.length * 24 * 3;
    for (let cell = 0; cell < spec.length; cell++) {
      const [r, g, b] = PROBE_COLORS[spec[cell]!]!.rgb;
      const off = 1 + cell * 24 * 3;
      expect([raw[off], raw[off + 1], raw[off + 2]]).toEqual([r, g, b]);
      expect([raw[rowStride + off], raw[rowStride + off + 1], raw[rowStride + off + 2]]).toEqual([r, g, b]);
    }
  });
});

describe("probePrompt", () => {
  it("asks for the marked answer and the no-read self-report", () => {
    const prompt = probePrompt(".railhead/vision-probe/probe.png");
    expect(prompt).toContain(".railhead/vision-probe/probe.png");
    expect(prompt).toContain(ANSWER_MARKER);
    expect(prompt).toContain(NOREAD_MARKER);
  });

  it("cannot leak the answer — the marker is never followed by a color list", () => {
    const prompt = probePrompt(".railhead/vision-probe/probe.png");
    expect(prompt).not.toMatch(new RegExp(`${ANSWER_MARKER}\\s+(?:red|green|blue|yellow)`, "i"));
  });
});

describe("parseProbeAnswer", () => {
  const spec = [2, 0, 3, 1];
  const expected = ["blue", "red", "yellow", "green"];

  it("accepts the exact color sequence", () => {
    const r = parseProbeAnswer(`${ANSWER_MARKER} ${expected.join(", ")}`, spec);
    expect(r.correct).toBe(true);
    expect(r.colors).toEqual(expected);
  });

  it("rejects a wrong order — it proves the pixels were not read", () => {
    const r = parseProbeAnswer(`${ANSWER_MARKER} red, blue, yellow, green`, spec);
    expect(r.correct).toBe(false);
  });

  it("rejects a guessed subset", () => {
    expect(parseProbeAnswer(`${ANSWER_MARKER} blue, red`, spec).correct).toBe(false);
  });

  it("parses prose around the marked line", () => {
    const r = parseProbeAnswer(`The colors are ${ANSWER_MARKER} Blue, RED, yellow and green.`, spec);
    expect(r.colors).toEqual(expected);
    expect(r.correct).toBe(true);
  });

  it("treats the no-read marker as an explicit failure", () => {
    const r = parseProbeAnswer(NOREAD_MARKER, spec);
    expect(r.selfReportedNoRead).toBe(true);
    expect(r.correct).toBe(false);
  });

  it("returns no colors when the marker is absent", () => {
    const r = parseProbeAnswer("I cannot see the image.", spec);
    expect(r.colors).toEqual([]);
    expect(r.correct).toBe(false);
  });
});

describe("visionGateRequests", () => {
  it("requests nothing when both gates are off", () => {
    expect(visionGateRequests({ visual: "off", goal: "off" }, { visual: "a", goal: "b" })).toEqual([]);
  });

  it("names the seat model for each active gate", () => {
    expect(visionGateRequests({ visual: "light", goal: "off" }, { visual: "v", goal: "g" })).toEqual([{ gate: "visual", model: "v" }]);
    expect(visionGateRequests({ visual: "off", goal: "full" }, { visual: "v", goal: "g" })).toEqual([{ gate: "goal", model: "g" }]);
  });

  it("surfaces a null model so the caller can refuse rather than skip", () => {
    expect(visionGateRequests({ visual: "light", goal: "light" }, { visual: null, goal: null })).toEqual([
      { gate: "visual", model: null },
      { gate: "goal", model: null },
    ]);
  });
});

describe("outcomeToRecord", () => {
  it("maps the outcome fields onto the persisted record", () => {
    const record = outcomeToRecord(out(undefined), "2026-01-01T00:00:00.000Z");
    expect(record.model).toBe("test/model");
    expect(record.reads_images).toBe(true);
    expect(record.answer_correct).toBe(true);
    expect(record.verified_at).toBe("2026-01-01T00:00:00.000Z");
    expect(record.probe_version).toBeGreaterThan(0);
  });

  it("records a blind model as reads_images=false", () => {
    const record = outcomeToRecord(out({ ok: false, answerCorrect: false, sawImageBlock: false }));
    expect(record.reads_images).toBe(false);
  });
});

describe("visionCapabilityBlock", () => {
  it("adds nothing without a measurement", () => {
    expect(visionCapabilityBlock(null, "visual")).toBe("");
    expect(visionCapabilityBlock(null, "implement")).toBe("");
  });

  it("tells a verified reviewer it must read screenshots and cannot claim image reading is unusable", () => {
    const block = visionCapabilityBlock({ readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" }, "goal");
    expect(block).toContain("Vision capability (railhead-verified)");
    expect(block).toContain("MUST");
    expect(block).toContain("read");
    expect(block).toContain("not a valid finding");
  });

  it("gives the verified implementer a surface self-check with pixels", () => {
    const block = visionCapabilityBlock({ readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" }, "implement");
    expect(block).toContain("capture a screenshot");
    expect(block).toContain("zero height");
  });

  it("stops a blind implementer from claiming a visual check", () => {
    const block = visionCapabilityBlock({ readsImages: false, verifiedAt: "2026-01-01T00:00:00.000Z" }, "implement");
    expect(block).toContain("does NOT receive image pixels");
    expect(block).toContain("Do not claim");
  });
});

describe("readVisionCapabilityFor", () => {
  it("maps the null/default seat to the default-model record and ignores stale probe versions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    await recordVisionCapability(cwd, out({ model: "default" }));
    await recordVisionCapability(cwd, out({ model: "old/model" }));
    const raw = JSON.parse(await readFile(capabilityFilePath(cwd), "utf8"));
    raw.probes = raw.probes.map((r: { model: string }) => (r.model === "old/model" ? { ...r, probe_version: 0 } : r));
    await writeFile(capabilityFilePath(cwd), JSON.stringify(raw), "utf8");
    expect(await readVisionCapabilityFor(cwd, null)).toMatchObject({ readsImages: true });
    expect(await readVisionCapabilityFor(cwd, "default")).toMatchObject({ readsImages: true });
    expect(await readVisionCapabilityFor(cwd, "old/model")).toBeNull();
    expect(await readVisionCapabilityFor(cwd, "unmeasured/model")).toBeNull();
  });
});

describe("capability record file", () => {
  it("round-trips records, replacing a prior entry for the same model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    await recordVisionCapability(cwd, out());
    await recordVisionCapability(cwd, out({ model: "other/model", ok: false, answerCorrect: false }));
    await recordVisionCapability(cwd, out({ answerColors: ["red", "green", "blue", "yellow"] }));
    const records = await readVisionCapabilities(cwd);
    expect(records.map((r) => r.model).sort()).toEqual(["other/model", "test/model"]);
    expect(records.find((r) => r.model === "test/model")!.reads_images).toBe(true);
    expect(records.find((r) => r.model === "other/model")!.reads_images).toBe(false);
    const raw = JSON.parse(await readFile(capabilityFilePath(cwd), "utf8"));
    expect(raw.version).toBe(1);
  });

  it("reads an absent record as no records", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    expect(await readVisionCapabilities(cwd)).toEqual([]);
  });

  it("reads corrupt JSON as no records instead of throwing (ADR 0009 shape)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(capabilityFilePath(cwd), "{not json", "utf8");
    expect(await readVisionCapabilities(cwd)).toEqual([]);
    await writeFile(capabilityFilePath(cwd), JSON.stringify({ version: 1, probes: [{ model: 7 }, { model: "ok", reads_images: true }] }), "utf8");
    const records = await readVisionCapabilities(cwd);
    expect(records.map((r) => r.model)).toEqual(["ok"]);
  });
});

describe("describeVisionOutcome", () => {
  // The snake-run misdiagnosis: the probe claimed "did not receive the pixels"
  // while the transcript showed the image block attached and ~23k input tokens.
  // The message must split the two causes — they have different remedies.
  it("splits the failure cause on sawImageBlock: pixels delivered-but-misread vs pixels never delivered", () => {
    const wrong = out({ ok: false, answerCorrect: false, answerColors: ["blue", "yellow", "red", "green"], expectedColors: ["blue", "yellow", "green", "red"] });
    expect(describeVisionOutcome({ ...wrong, sawImageBlock: true })).toContain("reached the model but it misread");
    expect(describeVisionOutcome({ ...wrong, sawImageBlock: false })).toContain("never reached the model");
  });

  it("keeps the agent-error and self-report branches", () => {
    expect(describeVisionOutcome(out({ ok: false, answerCorrect: false, error: "agent exited 1 — boom" }))).toContain("exited 1");
    expect(describeVisionOutcome(out({ ok: false, answerCorrect: false, selfReportedNoRead: true }))).toContain("cannot read image files");
  });
});

describe("ensureVisionForGates", () => {
  it("collects a refusal per blind gate instead of throwing, probing a shared model once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    probeBehavior = "blind";
    probeCalls = 0;
    const { records, refusals } = await ensureVisionForGates({
      cwd,
      requests: [
        { gate: "visual", model: "test/model" },
        { gate: "goal", model: "test/model" },
      ],
    });
    expect(probeCalls).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]!.reads_images).toBe(false);
    expect(refusals.map((r) => r.gate)).toEqual(["visual", "goal"]);
    expect(refusals[0]!.reason).toContain("failed the vision probe");
  });

  it("returns no refusals when the seat model reads the probe", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    probeBehavior = "see";
    probeCalls = 0;
    const { records, refusals } = await ensureVisionForGates({ cwd, requests: [{ gate: "visual", model: "test/model" }] });
    expect(probeCalls).toBe(1);
    expect(refusals).toEqual([]);
    expect(records[0]!.reads_images).toBe(true);
  });

  it("a gate with no configured model is a refusal without spending a probe", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    probeCalls = 0;
    const { refusals } = await ensureVisionForGates({ cwd, requests: [{ gate: "goal", model: null }] });
    expect(probeCalls).toBe(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toContain("no goal model is configured");
  });
});
