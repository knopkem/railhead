import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eventPath } from "./ledger.ts";
import { analyzePhase, mergePhases, summarizePhaseFiles } from "./telemetry.ts";

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

  it("computes generation time from step_start/step_finish timestamp pairs", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":1000,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":3000,"part":{"tokens":{"input":2000,"output":100}}}`,
      `{"type":"step_start","timestamp":4000,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":7000,"part":{"tokens":{"input":5000,"output":200}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(5000);
  });

  it("computes tokens/sec from output tokens and generation time", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":10000,"part":{"tokens":{"input":2000,"output":500}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.totalOutputTokens).toBe(500);
    expect(t.generationMs).toBe(10000);
    expect(t.outputTokensPerSec).toBe(50);
  });

  it("returns 0 for tokensPerSec when generation time is zero", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_finish","part":{"tokens":{"input":2000,"output":500}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.outputTokensPerSec).toBe(0);
  });

  it("uses text-event span, not step_start→step_finish, for generation time", async () => {
    // step_start at 0ms, first text at 2000ms, last text at 4000ms, step_finish
    // at 10000ms. Generation time should be 4000-2000=2000ms (the text span),
    // NOT 10000-0=10000ms (the full step including tool execution after text).
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"text","timestamp":2000,"part":{"text":"hello"}}`,
      `{"type":"text","timestamp":3000,"part":{"text":" world"}}`,
      `{"type":"text","timestamp":4000,"part":{"text":"!"}}`,
      `{"type":"tool_use","timestamp":5000,"part":{"type":"tool","tool":"bash"}}`,
      `{"type":"step_finish","timestamp":10000,"part":{"tokens":{"input":2000,"output":100}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(2000);
    expect(t.outputTokensPerSec).toBe(50);
  });

  it("uses reasoning-event span for generation time when present", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"reasoning","timestamp":1000,"part":{"text":"thinking"}}`,
      `{"type":"text","timestamp":3000,"part":{"text":"answer"}}`,
      `{"type":"step_finish","timestamp":8000,"part":{"tokens":{"input":2000,"output":100}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(2000);
  });

  it("falls back to step interval when no text/reasoning events exist", async () => {
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":1000,"part":{"type":"step-start"}}`,
      `{"type":"step_finish","timestamp":5000,"part":{"tokens":{"input":2000,"output":100}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    expect(t.generationMs).toBe(4000);
  });

  it("counts generation time per step across multiple steps", async () => {
    // Step 1: text span 2000ms. Step 2: text span 3000ms. Total = 5000ms.
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
    expect(t.generationMs).toBe(5000);
  });

  it("subtracts tool-execution time so a slow build/test is not counted as generation", async () => {
    // Step runs 0→30000ms but 28000ms of that is a single bash tool (an
    // `npm run build`) whose state.time window is 2000→30000. Only 2000ms was
    // the model emitting tokens. The old code counted all 30000ms, dividing the
    // step's output by it and reading a fraction of the server's decode rate.
    const { dir, phase } = await writePhase([
      `{"type":"step_start","timestamp":0,"part":{"type":"step-start"}}`,
      `{"type":"tool_use","timestamp":30000,"part":{"type":"tool","tool":"bash","state":{"status":"completed","time":{"start":2000,"end":30000}}}}`,
      `{"type":"step_finish","timestamp":30000,"part":{"tokens":{"input":2000,"output":60}}}`,
    ]);
    const t = await analyzePhase(dir, phase);
    // No text events → interval fallback: 30000 - stepToolMs(28000) = 2000ms.
    expect(t.generationMs).toBe(2000);
    expect(t.outputTokensPerSec).toBe(30); // 60 tokens / 2s
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
      outputTokensPerSec: 0,
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
      outputTokensPerSec: 0,
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
      outputTokensPerSec: 200,
    };
    expect(mergePhases([p])).toEqual(p);
  });

  it("sums output tokens and generation time across phases", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 18000, generationMs: 95000, outputTokensPerSec: 189 },
      { compactions: 0, peakInputTokens: 5000, finalInputTokens: 5000, totalInputTokens: 5000, totalOutputTokens: 1400, generationMs: 8000, outputTokensPerSec: 175 },
      { compactions: 0, peakInputTokens: 6500, finalInputTokens: 200, totalInputTokens: 6500, totalOutputTokens: 270, generationMs: 1700, outputTokensPerSec: 159 },
    ]);
    expect(merged.totalOutputTokens).toBe(19670);
    expect(merged.generationMs).toBe(104700);
    expect(merged.outputTokensPerSec).toBe(Math.round((19670 / 104700) * 1000));
  });

  it("takes the max peak across phases", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 100, generationMs: 1000, outputTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 19000, finalInputTokens: 19000, totalInputTokens: 19000, totalOutputTokens: 50, generationMs: 500, outputTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 6500, finalInputTokens: 200, totalInputTokens: 6500, totalOutputTokens: 200, generationMs: 2000, outputTokensPerSec: 100 },
    ]);
    expect(merged.peakInputTokens).toBe(19000);
  });

  it("takes the last non-zero final input tokens", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 100, generationMs: 1000, outputTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 5000, finalInputTokens: 5000, totalInputTokens: 5000, totalOutputTokens: 50, generationMs: 500, outputTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 6500, finalInputTokens: 200, totalInputTokens: 6500, totalOutputTokens: 200, generationMs: 2000, outputTokensPerSec: 100 },
    ]);
    expect(merged.finalInputTokens).toBe(200);
  });

  it("sums compactions across phases", () => {
    const merged = mergePhases([
      { compactions: 1, peakInputTokens: 1000, finalInputTokens: 1000, totalInputTokens: 1000, totalOutputTokens: 100, generationMs: 1000, outputTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 2000, finalInputTokens: 2000, totalInputTokens: 2000, totalOutputTokens: 200, generationMs: 1000, outputTokensPerSec: 200 },
      { compactions: 2, peakInputTokens: 3000, finalInputTokens: 3000, totalInputTokens: 3000, totalOutputTokens: 300, generationMs: 1000, outputTokensPerSec: 300 },
    ]);
    expect(merged.compactions).toBe(3);
  });

  it("sums total input tokens across phases", () => {
    const merged = mergePhases([
      { compactions: 0, peakInputTokens: 1000, finalInputTokens: 1000, totalInputTokens: 3000, totalOutputTokens: 100, generationMs: 1000, outputTokensPerSec: 100 },
      { compactions: 0, peakInputTokens: 2000, finalInputTokens: 2000, totalInputTokens: 5000, totalOutputTokens: 200, generationMs: 1000, outputTokensPerSec: 200 },
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
      outputTokensPerSec: 0,
    });
  });
});