import { describe, it, expect } from "vitest";
import { renderTranscript } from "./transcript.ts";

/**
 * The transcript renderer is display-only and never mutates the raw event
 * stream. Tests pin the exact rendering of each event type the ledgers
 * actually carry: step_start, text, tool_use (with input/output preview),
 * step_finish (tokens + cost), and error (e.g. ContextOverflowError). Shapes
 * are sampled from real runs in snake-kimi and snake-qwen — the renderer
 * must outlive the model's exact field set, so missing optional fields are
 * tolerated rather than crashing.
 */

function stepStart(ts = 1787610880435): string {
  return JSON.stringify({
    type: "step_start",
    timestamp: ts,
    sessionID: "ses_x",
    part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_x", snapshot: "abc", type: "step-start" },
  });
}

function text(t: string, ts = 1787610881086): string {
  return JSON.stringify({
    type: "text",
    timestamp: ts,
    sessionID: "ses_x",
    part: { id: "prt_2", messageID: "msg_1", sessionID: "ses_x", type: "text", text: t },
  });
}

function toolUse(over: Record<string, any> = {}): string {
  return JSON.stringify({
    type: "tool_use",
    timestamp: 1787610880958,
    sessionID: "ses_x",
    part: {
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "completed", input: { command: "ls -la", workdir: "/x" }, output: "total 0\n", metadata: { output: "total 0\n", exit: 0, truncated: false } },
      title: "ls -la",
      time: { start: 1787610880955, end: 1787610880957 },
      id: "prt_3",
      messageID: "msg_1",
      sessionID: "ses_x",
      ...over,
    },
  });
}

function stepFinish(over: Record<string, any> = {}): string {
  return JSON.stringify({
    type: "step_finish",
    timestamp: 1787610881087,
    sessionID: "ses_x",
    part: {
      id: "prt_4",
      reason: "tool-calls",
      snapshot: "abc",
      messageID: "msg_1",
      sessionID: "ses_x",
      type: "step-finish",
      tokens: { total: 8904, input: 477, output: 123, reasoning: 0, cache: { write: 0, read: 8304 } },
      cost: 0.001458675,
      ...over,
    },
  });
}

function errorEvent(name: string, message: string): string {
  return JSON.stringify({
    type: "error",
    timestamp: 1787608735163,
    sessionID: "ses_x",
    error: { name, data: { message } },
  });
}

describe("renderTranscript", () => {
  it("renders empty input as empty output", () => {
    expect(renderTranscript([])).toBe("");
  });

  it("drops blank and non-JSON lines without crashing", () => {
    const out = renderTranscript(["", "   ", "not json at all"]);
    expect(out).toBe("");
  });

  it("renders step_start as a section header", () => {
    const out = renderTranscript([stepStart()]);
    expect(out).toMatch(/step 1/i);
    expect(out).toContain("\n");
  });

  it("renders assistant text verbatim", () => {
    const out = renderTranscript([text("Now I will write the file.")]);
    expect(out).toContain("Now I will write the file.");
  });

  it("renders a tool_use with tool name, title, status, and a truncated output preview", () => {
    const big = "x".repeat(2000);
    const ev = toolUse({
      state: { status: "completed", input: { command: "ls -la" }, output: big, metadata: { exit: 0 } },
    });
    const out = renderTranscript([ev]);
    expect(out).toContain("bash");
    expect(out).toContain("ls -la");
    expect(out).toContain("completed");
    // The huge output must be truncated, not echoed in full.
    expect(out).not.toContain(big);
    expect(out.length).toBeLessThan(big.length);
  });

  it("renders a tool_use with no state/output as running, without crashing", () => {
    const ev = toolUse({ state: undefined, title: undefined });
    const out = renderTranscript([ev]);
    expect(out).toContain("bash");
    expect(out).toMatch(/running|pending/i);
  });

  it("renders step_finish with input/output token counts (no cost)", () => {
    const out = renderTranscript([stepFinish()]);
    expect(out).toMatch(/input[: ]/i);
    expect(out).toContain("477");
    expect(out).toMatch(/output[: ]/i);
    expect(out).toContain("123");
    expect(out).not.toContain("$");
  });

  it("tolerates a step_finish with no tokens", () => {
    const ev = stepFinish({ tokens: undefined, cost: undefined });
    const out = renderTranscript([ev]);
    expect(out).toMatch(/finish/);
    expect(out).not.toContain("$");
  });

  it("renders an error event with its name and message — the ContextOverflowError case", () => {
    const ev = errorEvent(
      "ContextOverflowError",
      "This model's maximum context length is 131072 tokens. Your request requires at least 254806 tokens.",
    );
    const out = renderTranscript([ev]);
    expect(out).toContain("ContextOverflowError");
    expect(out).toContain("254806 tokens");
  });

  it("renders a realistic multi-event sequence in chronological order, with clear separators", () => {
    const lines = [
      stepStart(1),
      text("Let me check the layout.", 2),
      toolUse({ state: { status: "completed", input: { command: "ls" }, output: "src\nCargo.toml\n" } }),
      stepFinish(),
    ];
    const out = renderTranscript(lines);
    const stepPos = out.toLowerCase().indexOf("step 1");
    const textPos = out.indexOf("Let me check the layout.");
    const toolPos = out.indexOf("bash");
    const finishPos = out.toLowerCase().indexOf("finish");
    expect(stepPos).toBeGreaterThanOrEqual(0);
    expect(stepPos).toBeLessThan(textPos);
    expect(textPos).toBeLessThan(toolPos);
    expect(toolPos).toBeLessThan(finishPos);
  });

  it("skips event types it does not recognise (file, message, snapshot, etc.)", () => {
    const unknown = JSON.stringify({ type: "file", part: { type: "file", path: "/x" } });
    const out = renderTranscript([unknown]);
    expect(out).toBe("");
  });
});
