import { describe, it, expect, vi, beforeEach } from "vitest";
import { inflateSync } from "node:zlib";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../core/ledger.ts";
import {
  ANSWER_MARKER,
  NOREAD_MARKER,
  PROBE_BACKGROUND,
  PROBE_BLOCKS,
  PROBE_CELL_PX,
  PROBE_GAP_PX,
  PROBE_PALETTE,
  buildProbePng,
  capabilityFilePath,
  describeVisionOutcome,
  ensureVisionForGates,
  outcomeToRecord,
  parseProbeAnswer,
  pickBestProbeOutcome,
  probePrompt,
  randomProbeSpec,
  readVisionCapabilities,
  readVisionCapabilityFor,
  recordVisionCapability,
  visionCapabilityBlock,
  visionGateRequests,
  type VisionProbeOutcome,
} from "./vision-probe.ts";

type Behavior = "see" | "blind" | "noread" | "inconclusive";

/** The mocked executor's behavior. "see" decodes the generated probe PNG and
 * answers its true set; "blind" answers a set with one color replaced by an
 * absent one; "inconclusive" answers without a read, so no image block ever
 * comes back. A queue overrides the default per call, to exercise the retry. */
let probeBehavior: Behavior = "see";
let probeQueue: Behavior[] = [];
let probeCalls = 0;

vi.mock("./executor.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./executor.ts")>();
  return {
    ...mod,
    executeOpendCode: async (_prompt: string, options: { cwd: string; ledgerDir: string; phaseFile: string }) => {
      probeCalls++;
      const behavior = probeQueue.shift() ?? probeBehavior;
      const imagePath = join(options.cwd, ".railhead", "vision-probe", "probe.png");
      const png = await readFile(imagePath);
      const chunks = pngChunks(png);
      const width = chunks[0]!.data.readUInt32BE(0);
      const raw = inflateSync(chunks[1]!.data);
      const rowStride = 1 + width * 3;
      const midY = PROBE_GAP_PX + Math.floor(PROBE_CELL_PX / 2);
      const names: string[] = [];
      for (let i = 0; i < PROBE_BLOCKS; i++) {
        const x = PROBE_GAP_PX + i * (PROBE_CELL_PX + PROBE_GAP_PX) + Math.floor(PROBE_CELL_PX / 2);
        const off = midY * rowStride + 1 + x * 3;
        const rgb = [raw[off], raw[off + 1], raw[off + 2]];
        names.push(PROBE_PALETTE.find((c) => c.rgb.every((v, i2) => v === rgb[i2]))!.name);
      }
      if (behavior !== "inconclusive") {
        await appendEvent(options.ledgerDir, options.phaseFile, JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: imagePath },
              output: "Image read successfully",
              attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }],
            },
          },
        }));
      }
      let answer: string;
      if (behavior === "noread") {
        answer = NOREAD_MARKER;
      } else if (behavior === "inconclusive") {
        answer = "I could not read the file.";
      } else {
        const listed = behavior === "blind"
          ? [PROBE_PALETTE.map((c) => c.name).find((n) => !names.includes(n))!, ...names.slice(1)]
          : names;
        answer = `${ANSWER_MARKER} count=${PROBE_BLOCKS} colors=${listed.join(",")}`;
      }
      await appendEvent(options.ledgerDir, options.phaseFile, JSON.stringify({ type: "text", part: { type: "text", text: answer } }));
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
  inconclusive: false,
  attempts: 1,
  ...over,
});

beforeEach(() => {
  probeBehavior = "see";
  probeQueue = [];
  probeCalls = 0;
});

describe("randomProbeSpec", () => {
  it("draws four distinct indices from the palette", () => {
    const spec = randomProbeSpec(() => 0.5);
    expect(spec).toHaveLength(PROBE_BLOCKS);
    expect(new Set(spec).size).toBe(PROBE_BLOCKS);
    expect(spec.every((i) => i >= 0 && i < PROBE_PALETTE.length)).toBe(true);
  });

  it("is deterministic for a fixed rng", () => {
    expect(randomProbeSpec(() => 0.1)).toEqual(randomProbeSpec(() => 0.1));
  });
});

describe("buildProbePng", () => {
  const spec = [7, 2, 9, 0];
  const width = PROBE_GAP_PX + spec.length * (PROBE_CELL_PX + PROBE_GAP_PX);
  const height = 2 * PROBE_GAP_PX + PROBE_CELL_PX;
  const png = buildProbePng(spec);

  it("emits a valid PNG signature and chunk sequence", () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("declares an 8-bit truecolor image with a gap around every block", () => {
    const ihdr = pngChunks(png)[0]!.data;
    expect(ihdr.readUInt32BE(0)).toBe(width);
    expect(ihdr.readUInt32BE(4)).toBe(height);
    expect(ihdr[8]).toBe(8);
    expect(ihdr[9]).toBe(2);
  });

  it("inflates to one filter byte plus RGB per pixel", () => {
    const raw = inflateSync(pngChunks(png)[1]!.data);
    expect(raw.length).toBe(height * (1 + width * 3));
  });

  it("paints a white background and each block with its spec color", () => {
    const raw = inflateSync(pngChunks(png)[1]!.data);
    const rowStride = 1 + width * 3;
    const px = (x: number, y: number) => {
      const off = y * rowStride + 1 + x * 3;
      return [raw[off], raw[off + 1], raw[off + 2]];
    };
    expect(px(0, 0)).toEqual([...PROBE_BACKGROUND]);
    expect(px(width - 1, height - 1)).toEqual([...PROBE_BACKGROUND]);
    for (let i = 0; i < spec.length; i++) {
      const x = PROBE_GAP_PX + i * (PROBE_CELL_PX + PROBE_GAP_PX) + 1;
      expect(px(x, PROBE_GAP_PX + 1)).toEqual([...PROBE_PALETTE[spec[i]!]!.rgb]);
    }
  });
});

describe("probePrompt", () => {
  it("forces a read of the given absolute path and names the answer fields", () => {
    const prompt = probePrompt("/repo/.railhead/vision-probe/probe.png");
    expect(prompt).toContain("/repo/.railhead/vision-probe/probe.png");
    expect(prompt).toContain("MUST call the read tool");
    expect(prompt).toContain(ANSWER_MARKER);
    expect(prompt).toContain("count=");
    expect(prompt).toContain("colors=");
  });

  it("no longer offers a no-read escape hatch", () => {
    expect(probePrompt("/x/probe.png")).not.toContain(NOREAD_MARKER);
  });

  it("cannot leak the answer order-free — no palette name follows the marker on its line", () => {
    const prompt = probePrompt("/x/probe.png");
    const names = PROBE_PALETTE.map((c) => c.name).join("|");
    expect(prompt).not.toMatch(new RegExp(`${ANSWER_MARKER}[^\\n]*(?:${names})`, "i"));
  });
});

describe("parseProbeAnswer", () => {
  const spec = [4, 0, 5, 3];
  const expected = ["cyan", "red", "blue", "green"];

  it("accepts the exact set in any order, with the count", () => {
    const r = parseProbeAnswer(`${ANSWER_MARKER} count=4 colors=green, blue, cyan, red`, spec);
    expect(r.correct).toBe(true);
    expect(r.colors).toEqual(["green", "blue", "cyan", "red"]);
    expect(r.count).toBe(4);
  });

  it("accepts a bare color list without the count/colors labels", () => {
    const r = parseProbeAnswer(`${ANSWER_MARKER} red, cyan, green, blue`, spec);
    expect(r.correct).toBe(true);
    expect(r.count).toBe(4);
  });

  it("rejects a set containing a color that was not drawn", () => {
    expect(parseProbeAnswer(`${ANSWER_MARKER} count=4 colors=green, blue, cyan, orange`, spec).correct).toBe(false);
  });

  it("rejects a duplicated color — three distinct names in four slots", () => {
    expect(parseProbeAnswer(`${ANSWER_MARKER} count=4 colors=green, blue, blue, red`, spec).correct).toBe(false);
  });

  it("rejects a wrong count even when the set matches", () => {
    expect(parseProbeAnswer(`${ANSWER_MARKER} count=5 colors=green, blue, cyan, red`, spec).correct).toBe(false);
  });

  it("maps vocabulary synonyms onto the palette's canonical names", () => {
    const r = parseProbeAnswer(`${ANSWER_MARKER} count=4 colors=violet, red, blue, green`, [6, 0, 5, 3]);
    expect(r.correct).toBe(true);
  });

  it("parses prose around the marked line", () => {
    const r = parseProbeAnswer(`I read the image. ${ANSWER_MARKER} count=4 colors= Blue, RED, green and cyan.`, spec);
    expect(r.colors).toEqual(["blue", "red", "green", "cyan"]);
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

describe("pickBestProbeOutcome", () => {
  const misread = out({ ok: false, answerCorrect: false, sawImageBlock: true });
  const noImage = out({ ok: false, answerCorrect: false, sawImageBlock: false, inconclusive: true, answerColors: [] });
  const good = out();

  it("prefers a pass over a misread attempt over a no-image attempt", () => {
    expect(pickBestProbeOutcome(noImage, misread)).toBe(misread);
    expect(pickBestProbeOutcome(misread, good)).toBe(good);
    expect(pickBestProbeOutcome(good, misread)).toBe(good);
  });

  it("keeps the later attempt on a tie", () => {
    const later = out({ answerColors: ["red"] });
    expect(pickBestProbeOutcome(misread, later)).toBe(later);
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

  it("records a delivered-but-misread model as a conclusive blind verdict", () => {
    const record = outcomeToRecord(out({ ok: false, answerCorrect: false, sawImageBlock: true, inconclusive: false }));
    expect(record.reads_images).toBe(false);
    expect(record.probe_inconclusive).toBe(false);
  });

  it("records a probe that never received an image as inconclusive, not blind", () => {
    const record = outcomeToRecord(out({ ok: false, answerCorrect: false, sawImageBlock: false, inconclusive: true }));
    expect(record.reads_images).toBe(false);
    expect(record.probe_inconclusive).toBe(true);
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

  it("treats an inconclusive record as no measurement, never as a blind claim", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    await recordVisionCapability(cwd, out({ model: "flaky/model", ok: false, answerCorrect: false, sawImageBlock: false, inconclusive: true, answerColors: [] }));
    expect(await readVisionCapabilityFor(cwd, "flaky/model")).toBeNull();
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

  it("persists the inconclusive flag", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    await recordVisionCapability(cwd, out({ model: "flaky/model", ok: false, answerCorrect: false, sawImageBlock: false, inconclusive: true, answerColors: [] }));
    expect((await readVisionCapabilities(cwd)).find((r) => r.model === "flaky/model")!.probe_inconclusive).toBe(true);
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

  it("describes a pass as the named blocks", () => {
    expect(describeVisionOutcome(out())).toContain("named all blocks correctly");
  });
});

describe("ensureVisionForGates", () => {
  it("collects a refusal per blind gate, retrying the failed probe once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    probeBehavior = "blind";
    const { records, refusals } = await ensureVisionForGates({
      cwd,
      requests: [
        { gate: "visual", model: "test/model" },
        { gate: "goal", model: "test/model" },
      ],
    });
    expect(probeCalls).toBe(2);
    expect(records).toHaveLength(1);
    expect(records[0]!.reads_images).toBe(false);
    expect(records[0]!.probe_inconclusive).toBe(false);
    expect(refusals.map((r) => r.gate)).toEqual(["visual", "goal"]);
    expect(refusals[0]!.reason).toContain("failed the vision probe");
  });

  it("a flaky first attempt that passes the retry records a verified model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    probeQueue = ["blind", "see"];
    const { records, refusals } = await ensureVisionForGates({ cwd, requests: [{ gate: "visual", model: "test/model" }] });
    expect(probeCalls).toBe(2);
    expect(refusals).toEqual([]);
    expect(records[0]!.reads_images).toBe(true);
  });

  it("returns no refusals when the seat model reads the probe first try", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    const { records, refusals } = await ensureVisionForGates({ cwd, requests: [{ gate: "visual", model: "test/model" }] });
    expect(probeCalls).toBe(1);
    expect(refusals).toEqual([]);
    expect(records[0]!.reads_images).toBe(true);
  });

  it("records a probe that never received an image as inconclusive, not as a blind model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    probeBehavior = "inconclusive";
    const { records } = await ensureVisionForGates({ cwd, requests: [{ gate: "visual", model: "test/model" }] });
    expect(probeCalls).toBe(2);
    expect(records[0]!.probe_inconclusive).toBe(true);
    expect(await readVisionCapabilityFor(cwd, "test/model")).toBeNull();
  });

  it("a gate with no configured model is a refusal without spending a probe", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vision-probe-"));
    const { refusals } = await ensureVisionForGates({ cwd, requests: [{ gate: "goal", model: null }] });
    expect(probeCalls).toBe(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toContain("no goal model is configured");
  });
});
