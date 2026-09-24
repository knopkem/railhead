import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eventPath } from "./ledger.ts";
import { analyzePhase, collectCacheStats, firstStepCacheFromEvents, mergePhases, summarizePhaseFiles } from "./telemetry.ts";

async function writePhase(lines: string[]): Promise<{ dir: string; phase: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tel-"));
  await mkdir(join(dir, "events"), { recursive: true });
  const phase = "01-01-implement";
  await writeFile(eventPath(dir, phase), lines.join("\n"), "utf8");
  return { dir, phase };
}

async function writePhases(files: Record<string, string[]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tel-"));
  await mkdir(join(dir, "events"), { recursive: true });
  for (const [phase, lines] of Object.entries(files)) {
    await writeFile(eventPath(dir, phase), lines.join("\n"), "utf8");
  }
  return dir;
}

describe("analyzePhase", () => {
  it("counts compaction events", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_finish","part":{"tokens":{"input":5000}}}`,
      `{"type":"session.compacted","sessionID":"s1"}`,
      `{"type":"session.compacted","sessionID":"s2"}`,
    ]);
    expect((await analyzePhase(dir, phase)).compactions).toBe(2);
  });

  it("counts compaction_continue markers emitted as synthetic text parts", async () => {
    // opencode emits auto-compaction as a `text` part carrying
    // metadata.compaction_continue === true (and synthetic: true), NOT as a
    // session.compacted event. A real rogueformer run produced 52 of these
    // while telemetry reported zero — the bug this test pins down.
    const { dir, phase } = await writePhase([
      `{"type":"step_finish","part":{"tokens":{"input":5000}}}`,
      `{"type":"text","timestamp":1,"part":{"type":"text","text":"Continue if you have next steps.","metadata":{"compaction_continue":true},"synthetic":true}}`,
      `{"type":"step_finish","part":{"tokens":{"input":4000}}}`,
      `{"type":"text","timestamp":2,"part":{"type":"text","text":"Continue if you have next steps.","metadata":{"compaction_continue":true},"synthetic":true}}`,
      `{"type":"text","timestamp":3,"part":{"type":"text","text":"Continue if you have next steps.","metadata":{"compaction_continue":true},"synthetic":true}}`,
    ]);
    expect((await analyzePhase(dir, phase)).compactions).toBe(3);
  });

  it("does not count ordinary text parts without the compaction_continue flag", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_finish","part":{"tokens":{"input":5000}}}`,
      `{"type":"text","timestamp":1,"part":{"type":"text","text":"hello"}}`,
      `{"type":"text","timestamp":2,"part":{"type":"text","text":"world","metadata":{"compaction_continue":false}}}`,
    ]);
    expect((await analyzePhase(dir, phase)).compactions).toBe(0);
  });

  it("counts both session.compacted events and compaction_continue markers", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"session.compacted","sessionID":"s1"}`,
      `{"type":"text","timestamp":1,"part":{"type":"text","text":"Continue.","metadata":{"compaction_continue":true}}}`,
    ]);
    expect((await analyzePhase(dir, phase)).compactions).toBe(2);
  });

  it("tracks peak, final, and total input tokens", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_finish","part":{"tokens":{"input":2000}}}`,
      `{"type":"step_finish","part":{"tokens":{"input":9000}}}`,
      `{"type":"step_finish","part":{"tokens":{"input":6000}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.peakInputTokens).toBe(9000);
    expect(t.finalInputTokens).toBe(6000);
    expect(t.totalInputTokens).toBe(17000);
  });

  it("tracks total output tokens", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_finish","part":{"tokens":{"input":2000,"output":150}}}`,
      `{"type":"step_finish","part":{"tokens":{"input":9000,"output":300}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.totalOutputTokens).toBe(450);
  });

  it("accumulates step wall time (prefill included) from step_start/step_finish pairs", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":1000,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":3000,"part":{"tokens":{"input":2000,"output":100}}}`,
      `{"type":"step_start","timestamp":4000,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":7000,"part":{"tokens":{"input":5000,"output":200}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.wallMs).toBe(5000);
    // Nothing streamed → no decode measurement; the wall is prefill + decode
    // and the event stream cannot split it.
    expect(t.generationMs).toBe(0);
    expect(t.outputTokensPerSec).toBe(0);
  });

  it("computes end-to-end tokens/sec from output tokens and wall time", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":10000,"part":{"tokens":{"input":2000,"output":500}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.totalOutputTokens).toBe(500);
    expect(t.wallMs).toBe(10000);
    expect(t.endToEndTokensPerSec).toBe(50);
  });

  it("returns 0 for both rates when no timing exists", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_finish","part":{"tokens":{"input":2000,"output":500}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.outputTokensPerSec).toBe(0);
    expect(t.endToEndTokensPerSec).toBe(0);
  });

  it("measures decode from the first streamed token to step end minus tool time — prefill before the first token is never counted", async () => {
    // step_start at 0, then 2000ms of prefill before the first token. Text
    // streams 2000→4000, the decoded tool call runs 5000→10000 (state.time),
    // step_finish at 10000. Decode window = 10000 - 2000 - 5000 = 3000ms:
    // the 0→2000 prefill is excluded, the measured tool tail is excluded, and
    // the post-text tool-call decode (4000→5000) IS included — those tokens
    // are part of the step's output count.
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"text","timestamp":2000,"part":{"text":"hello"}}`,
      `{"type":"text","timestamp":3000,"part":{"text":" world"}}`,
      `{"type":"text","timestamp":4000,"part":{"text":"!"}}`,
      `{"type":"tool_use","timestamp":10000,"part":{"type":"tool","tool":"bash","state":{"status":"completed","time":{"start":5000,"end":10000}}}}`,
      `{"type":"step_finish","timestamp":10000,"part":{"tokens":{"input":2000,"output":100}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(3000);
    expect(t.decodeOutputTokens).toBe(100);
    expect(t.outputTokensPerSec).toBe(33);
    expect(t.wallMs).toBe(5000); // 10000 − 0 − 5000 tool
  });

  it("starts the decode window at the first reasoning event when reasoning precedes text", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"reasoning","timestamp":1000,"part":{"text":"thinking"}}`,
      `{"type":"text","timestamp":3000,"part":{"text":"answer"}}`,
      `{"type":"step_finish","timestamp":8000,"part":{"tokens":{"input":2000,"output":100}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(7000);
  });

  it("does NOT guess a decode rate for steps that streamed no text/reasoning — their time lands in wallMs only", async () => {
    // A tool-call-only step on a local server: its wall is mostly prefill.
    // Folding that wall into the rate denominator would merge prefill speed
    // into token speed — the bug behind a 1 tok/s reading on a 40 tok/s model.
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":1000,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":5000,"part":{"tokens":{"input":2000,"output":100}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(0);
    expect(t.wallMs).toBe(4000);
    expect(t.outputTokensPerSec).toBe(0);
    expect(t.endToEndTokensPerSec).toBe(25);
  });

  it("counts decode time per step across multiple steps", async () => {
    // Step 1: first token at 1000, finish at 6000 → 5000ms. Step 2: first
    // token at 8000, finish at 15000 → 7000ms. Total = 12000ms.
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"text","timestamp":1000,"part":{"text":"a"}}`,
      `{"type":"text","timestamp":3000,"part":{"text":"b"}}`,
      `{"type":"step_finish","timestamp":6000,"part":{"tokens":{"input":2000,"output":100}}}`,
      `{"type":"step_start","timestamp":7000,"part":{"type":"step-start"}}`,
      `{"type":"text","timestamp":8000,"part":{"text":"c"}}`,
      `{"type":"text","timestamp":11000,"part":{"text":"d"}}`,
      `{"type":"step_finish","timestamp":15000,"part":{"tokens":{"input":5000,"output":200}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(12000);
  });

  it("subtracts tool-execution time from the wall so a slow build/test is not counted as model time", async () => {
    // Step runs 0→30000ms but 28000ms of that is a single bash tool (an
    // `npm run build`) whose state.time window is 2000→30000. Only 2000ms was
    // the model's step wall. With no streamed text the decode rate stays
    // unknown — it must not be fabricated from the wall.
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"tool_use","timestamp":30000,"part":{"type":"tool","tool":"bash","state":{"status":"completed","time":{"start":2000,"end":30000}}}}`,
      `{"type":"step_finish","timestamp":30000,"part":{"tokens":{"input":2000,"output":60}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.wallMs).toBe(2000);
    expect(t.endToEndTokensPerSec).toBe(30); // 60 tokens / 2s
    expect(t.generationMs).toBe(0);
    expect(t.outputTokensPerSec).toBe(0);
  });

  it("pairs the decode rate's numerator and denominator so unmeasured steps cannot inflate it", async () => {
    // Anchored step: 100 output tokens over a 2000ms decode window.
    // Unanchored step: 900 output tokens over a 30000ms wall (mostly prefill).
    // Decode rate must be 100/2s = 50 — folding the unanchored step's tokens
    // into the numerator (or its wall into the denominator) would fabricate a
    // rate the model never decoded at.
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"text","timestamp":8000,"part":{"text":"a"}}`,
      `{"type":"text","timestamp":9000,"part":{"text":"b"}}`,
      `{"type":"step_finish","timestamp":10000,"part":{"tokens":{"input":2000,"output":100}}}`,
      `{"type":"step_start","timestamp":11000,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":41000,"part":{"tokens":{"input":5000,"output":900}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(2000);
    expect(t.decodeOutputTokens).toBe(100);
    expect(t.outputTokensPerSec).toBe(50);
    expect(t.totalOutputTokens).toBe(1000);
    expect(t.wallMs).toBe(40000);
    expect(t.endToEndTokensPerSec).toBe(25);
  });

  it("treats a single text event delivered just before step_finish as unmeasurable (non-streaming provider)", async () => {
    // A buffered provider emits the whole text part as ONE event at the end of
    // the step — its timestamp marks the END of decode, not the first token.
    // Anchoring on it would divide 980 output tokens by a ~10ms window and
    // report a fantasy rate; the step must land in wallMs only.
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"text","timestamp":23990,"part":{"text":"the whole answer, delivered at once"}}`,
      `{"type":"step_finish","timestamp":24000,"part":{"tokens":{"input":30000,"output":980}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(0);
    expect(t.decodeOutputTokens).toBe(0);
    expect(t.outputTokensPerSec).toBe(0);
    expect(t.wallMs).toBe(24000);
    expect(t.endToEndTokensPerSec).toBe(41);
  });

  it("handles a missing phase and zero-input busy tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tel-"));
    await mkdir(join(dir, "events"), { recursive: true });
    expect(await analyzePhase(dir, "nope")).toEqual({
      compactions: 0,
      peakInputTokens: 0,
      finalInputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      generationMs: 0,
      decodeOutputTokens: 0,
      outputTokensPerSec: 0,
      wallMs: 0,
      endToEndTokensPerSec: 0,
    });
    const { phase } = await writePhase([`{"type":"step_finish","part":{"tokens":{"total":10}}}`]);
    const t = await analyzePhase(dir, "nope");
    expect(t.peakInputTokens).toBe(0);
  });

  it("ignores malformed lines", async () => {
    const { dir, phase } = await writePhase([
      "not json",
      `{"type":"step_finish","part":{"tokens":{"input":500}}}`,
    ]);
    expect((await analyzePhase(dir, phase)).finalInputTokens).toBe(500);
  });
});

describe("mergePhases", () => {
  it("returns zero-context for an empty array", () => {
    expect(mergePhases([])).toEqual({
      compactions: 0,
      peakInputTokens: 0,
      finalInputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      generationMs: 0,
      decodeOutputTokens: 0,
      outputTokensPerSec: 0,
      wallMs: 0,
      endToEndTokensPerSec: 0,
    });
  });

  it("returns the single phase unchanged when there is only one", () => {
    const p = {
      compactions: 1,
      peakInputTokens: 5000,
      finalInputTokens: 4000,
      totalInputTokens: 12000,
      totalOutputTokens: 800,
      generationMs: 4000,
      decodeOutputTokens: 800,
      outputTokensPerSec: 200,
      wallMs: 8000,
      endToEndTokensPerSec: 100,
    };
    expect(mergePhases([p])).toEqual(p);
  });

  it("sums output tokens, decode tokens, generation time, and wall time across phases", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 18000, generationMs: 95000, decodeOutputTokens: 18000, outputTokensPerSec: 189, wallMs: 200000, endToEndTokensPerSec: 90 },
      { compactions: 0, peakInputTokens: 5000, finalInputTokens: 5000, totalInputTokens: 5000, totalOutputTokens: 1400, generationMs: 8000, decodeOutputTokens: 1000, outputTokensPerSec: 125, wallMs: 20000, endToEndTokensPerSec: 70 },
      { compactions: 0, peakInputTokens: 6500, finalInputTokens: 200, totalInputTokens: 6500, totalOutputTokens: 270, generationMs: 1700, decodeOutputTokens: 270, outputTokensPerSec: 159, wallMs: 5000, endToEndTokensPerSec: 54 },
    ]);
    expect(merged.totalOutputTokens).toBe(19670);
    expect(merged.generationMs).toBe(104700);
    expect(merged.decodeOutputTokens).toBe(19270);
    expect(merged.outputTokensPerSec).toBe(184);
    expect(merged.wallMs).toBe(225000);
    expect(merged.endToEndTokensPerSec).toBe(87);
  });

  it("takes the max peak across phases", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 100, generationMs: 1000, decodeOutputTokens: 100, outputTokensPerSec: 100, wallMs: 1000, endToEndTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 19000, finalInputTokens: 19000, totalInputTokens: 19000, totalOutputTokens: 50, generationMs: 500, decodeOutputTokens: 50, outputTokensPerSec: 100, wallMs: 500, endToEndTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 6500, finalInputTokens: 200, totalInputTokens: 6500, totalOutputTokens: 200, generationMs: 2000, decodeOutputTokens: 200, outputTokensPerSec: 100, wallMs: 2000, endToEndTokensPerSec: 100 },
    ]);
    expect(merged.peakInputTokens).toBe(19000);
  });

  it("takes the last non-zero final input tokens", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 100, generationMs: 1000, decodeOutputTokens: 100, outputTokensPerSec: 100, wallMs: 1000, endToEndTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 5000, finalInputTokens: 5000, totalInputTokens: 5000, totalOutputTokens: 50, generationMs: 500, decodeOutputTokens: 50, outputTokensPerSec: 100, wallMs: 500, endToEndTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 6500, finalInputTokens: 200, totalInputTokens: 6500, totalOutputTokens: 200, generationMs: 2000, decodeOutputTokens: 200, outputTokensPerSec: 100, wallMs: 2000, endToEndTokensPerSec: 100 },
    ]);
    expect(merged.finalInputTokens).toBe(200);
  });

  it("sums compactions across phases", () => {
    const merged = mergePhases([
      { compactions: 1, peakInputTokens: 1000, finalInputTokens: 1000, totalInputTokens: 1000, totalOutputTokens: 100, generationMs: 1000, decodeOutputTokens: 100, outputTokensPerSec: 100, wallMs: 1000, endToEndTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 2000, finalInputTokens: 2000, totalInputTokens: 2000, totalOutputTokens: 200, generationMs: 1000, decodeOutputTokens: 200, outputTokensPerSec: 200, wallMs: 1000, endToEndTokensPerSec: 200 },
      { compactions: 2, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 300, generationMs: 1000, decodeOutputTokens: 300, outputTokensPerSec: 300, wallMs: 1000, endToEndTokensPerSec: 300 },
    ]);
    expect(merged.compactions).toBe(3);
  });

  it("sums total input tokens across phases", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 1000, finalInputTokens: 1000, totalInputTokens: 3000, totalOutputTokens: 100, generationMs: 1000, decodeOutputTokens: 100, outputTokensPerSec: 100, wallMs: 1000, endToEndTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 2000, finalInputTokens: 2000, totalInputTokens: 5000, totalOutputTokens: 200, generationMs: 1000, decodeOutputTokens: 200, outputTokensPerSec: 200, wallMs: 1000, endToEndTokensPerSec: 200 },
    ]);
    expect(merged.totalInputTokens).toBe(8000);
  });
});

describe("summarizePhaseFiles", () => {
  it("merges compaction and peak across every phase file, including files whose attempt never checkpointed", async () => {
    // run-20260907-2146 ticket 07: the compaction lives in a build phase that
    // exited without a $CHECKPOINT marker; the marker-bearing next attempt
    // resumed post-compaction. Only merging every phase file the ticket wrote
    // reports the true peak and compaction count.
    const dir = await writePhases({
      "01-01-build": [
        `{"type":"step_finish","part":{"tokens":{"input":69000,"output":100}}}`,
        `{"type":"text","timestamp":1,"part":{"type":"text","text":"Continue if you have next steps.","metadata":{"compaction_continue":true},"synthetic":true}}`,
        `{"type":"step_finish","part":{"tokens":{"input":39000,"output":200}}}`,
      ],
      "01-02-build": [
        `{"type":"step_finish","part":{"tokens":{"input":39500,"output":150}}}`,
      ],
    });
    const ctx = await summarizePhaseFiles(dir, ["01-01-build", "01-02-build"]);
    expect(ctx.compactions).toBe(1);
    expect(ctx.peakInputTokens).toBe(69000);
    expect(ctx.finalInputTokens).toBe(39500);
    expect(ctx.totalOutputTokens).toBe(450);
  });

  it("ignores missing/empty phase files (an attempt killed before its first event)", async () => {
    const dir = await writePhases({
      "01-01-implement": [`{"type":"step_finish","part":{"tokens":{"input":5000,"output":300}}}`],
    });
    const ctx = await summarizePhaseFiles(dir, ["01-01-implement", "01-02-implement", "01-03-implement"]);
    expect(ctx.totalOutputTokens).toBe(300);
    expect(ctx.peakInputTokens).toBe(5000);
  });

  it("returns a zero context when no phase file has data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tel-"));
    await mkdir(join(dir, "events"), { recursive: true });
    expect(await summarizePhaseFiles(dir, ["nothing-here"])).toEqual({
      compactions: 0,
      peakInputTokens: 0,
      finalInputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      generationMs: 0,
      decodeOutputTokens: 0,
      outputTokensPerSec: 0,
      wallMs: 0,
      endToEndTokensPerSec: 0,
    });
  });
});

describe("firstStepCacheFromEvents (#130)", () => {
  it("returns null when the stream has no step_finish with token counts", () => {
    expect(firstStepCacheFromEvents("")).toBeNull();
    expect(firstStepCacheFromEvents(`{"type":"step_start","part":{}}`)).toBeNull();
    expect(firstStepCacheFromEvents(`{"type":"step_finish","part":{"tokens":{"output":5}}}`)).toBeNull();
  });

  it("returns the FIRST completed step's split, not a later step's", () => {
    const raw = [
      `{"type":"step_finish","part":{"tokens":{"input":400,"output":10,"cache":{"write":0,"read":9000}}}}`,
      `{"type":"step_finish","part":{"tokens":{"input":120,"output":10,"cache":{"write":0,"read":9500}}}}`,
    ].join("\n");
    expect(firstStepCacheFromEvents(raw)).toEqual({ cold: 400, cached: 9000 });
  });

  it("treats a missing cache field as a fully cold first step", () => {
    expect(firstStepCacheFromEvents(`{"type":"step_finish","part":{"tokens":{"input":12000,"output":50}}}`)).toEqual({ cold: 12000, cached: 0 });
  });

  it("includes cache writes in cold", () => {
    expect(firstStepCacheFromEvents(`{"type":"step_finish","part":{"tokens":{"input":300,"output":5,"cache":{"write":700,"read":0}}}}`)).toEqual({ cold: 1000, cached: 0 });
  });

  it("ignores malformed lines and tokens from non-step_finish events", () => {
    const raw = [
      `not json`,
      `{"type":"text","part":{"tokens":{"input":1}}}`,
      `{"type":"step_finish","part":{"tokens":{"input":10,"output":1,"cache":{"read":0}}}}`,
    ].join("\n");
    expect(firstStepCacheFromEvents(raw)).toEqual({ cold: 10, cached: 0 });
  });
});

describe("collectCacheStats (#130)", () => {
  it("collects first-step cold/cached per phase, sorted, with run totals", async () => {
    const dir = await writePhases({
      "02-02-review": [
        `{"type":"step_finish","part":{"tokens":{"input":1500,"output":40,"cache":{"write":0,"read":8000}}}}`,
      ],
      "01-01-build": [
        `{"type":"step_finish","part":{"tokens":{"input":12000,"output":90,"cache":{"write":0,"read":0}}}}`,
      ],
      "goal-look": [
        `{"type":"step_finish","part":{"tokens":{"input":200,"output":10,"cache":{"write":0,"read":9000}}}}`,
      ],
    });
    const stats = await collectCacheStats(dir);
    expect(stats.perPhase.map((p) => p.phaseFile)).toEqual(["01-01-build", "02-02-review", "goal-look"]);
    expect(stats.perPhase[0]!.cache).toEqual({ cold: 12000, cached: 0 });
    expect(stats.cold).toBe(13700);
    expect(stats.cached).toBe(17000);
  });

  it("returns empty stats when the events dir is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tel-"));
    expect(await collectCacheStats(dir)).toEqual({ perPhase: [], cold: 0, cached: 0 });
  });

  it("skips files with no step_finish token data", async () => {
    const dir = await writePhases({
      "01-01-build": [`{"type":"step_start","part":{}}`],
      "02-02-review": [`{"type":"step_finish","part":{"tokens":{"input":100,"output":5,"cache":{"read":500}}}}`],
    });
    const stats = await collectCacheStats(dir);
    expect(stats.perPhase).toHaveLength(1);
    expect(stats.perPhase[0]!.phaseFile).toBe("02-02-review");
  });
});