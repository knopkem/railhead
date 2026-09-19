import { describe, it, expect } from "vitest";
import { streamedTokenCost } from "./token-meter.ts";
import { estimateTokens } from "./diff-filter.ts";

function textEvent(text: string): string {
  return JSON.stringify({ type: "text", timestamp: 1, part: { type: "text", id: "p1", text } });
}

function reasoningEvent(text: string): string {
  return JSON.stringify({ type: "reasoning", timestamp: 1, part: { type: "reasoning", id: "p1", text } });
}

function toolUseEvent(over: Record<string, unknown>): string {
  return JSON.stringify({ type: "tool_use", timestamp: 1, part: { type: "tool", tool: "bash", ...over } });
}

describe("streamedTokenCost (#82)", () => {
  it("returns 0 for blank lines, malformed JSON, and non-object events", () => {
    expect(streamedTokenCost("")).toBe(0);
    expect(streamedTokenCost("   ")).toBe(0);
    expect(streamedTokenCost("not json at all")).toBe(0);
    expect(streamedTokenCost('["prose", "wrapped", "array"]')).toBe(0);
    expect(streamedTokenCost('{"type":"step_start"}')).toBe(0);
    expect(streamedTokenCost('{"type":"step_finish","part":{"tokens":{"input":100}}}')).toBe(0);
    expect(streamedTokenCost('{"type":"unknown"}')).toBe(0);
    expect(streamedTokenCost('"a bare json string"')).toBe(0);
  });

  it("counts assistant text events", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(streamedTokenCost(textEvent(text))).toBe(estimateTokens(text));
  });

  it("counts reasoning events as assistant text", () => {
    const text = "reasoning about the file layout before acting";
    expect(streamedTokenCost(reasoningEvent(text))).toBe(estimateTokens(text));
  });

  it("counts the input and output of a completed tool call", () => {
    const input = { command: "cat src/index.ts" };
    const output = "export const greet = (name) => `hello ${name}`;";
    const line = toolUseEvent({
      state: { status: "completed", input, output },
    });
    expect(streamedTokenCost(line)).toBe(estimateTokens(JSON.stringify(input)) + estimateTokens(output));
  });

  it("counts a completed tool's output through state.result when state.output is absent", () => {
    const line = toolUseEvent({
      state: { status: "completed", input: { filePath: "a.rs" }, result: "compiled ok" },
    });
    expect(streamedTokenCost(line)).toBe(estimateTokens('{"filePath":"a.rs"}') + estimateTokens("compiled ok"));
  });

  it("counts an errored tool call's input and its error text as the result", () => {
    const input = { command: "cargo build" };
    const line = toolUseEvent({
      state: { status: "error", input, error: "no such file or directory" },
    });
    expect(streamedTokenCost(line)).toBe(estimateTokens(JSON.stringify(input)) + estimateTokens("no such file or directory"));
  });

  it("does not count intermediate `running` tool events (a call surfaces twice)", () => {
    const running = toolUseEvent({
      state: { status: "running", input: { command: "sleep 1" }, output: "partial" },
    });
    expect(streamedTokenCost(running)).toBe(0);
  });

  it("ignores a tool event whose state or part shape is missing", () => {
    expect(streamedTokenCost(toolUseEvent({}))).toBe(0);
    expect(streamedTokenCost(toolUseEvent({ state: { status: "completed" } }))).toBe(0);
    expect(streamedTokenCost('{"type":"tool_use"}')).toBe(0);
  });

  it("charges a fixed allowance for image results, not their base64 size", () => {
    // A screenshot tool result re-sent to the model becomes an image content
    // part (~constant tokens), never base64 text — the raw bytes would
    // inflate the estimate by orders of magnitude.
    const data = "data:image/png;base64," + "x".repeat(200000);
    const line = toolUseEvent({ state: { status: "completed", output: data } });
    expect(streamedTokenCost(line)).toBe(1000);
  });

  it("charges one fixed allowance per image content block in a structured output", () => {
    const output = {
      blocks: [
        { type: "text", text: "viewing page" },
        { type: "image", data: "x".repeat(200000), mediaType: "image/png" },
        { type: "image", data: "y".repeat(200000), mediaType: "image/png" },
      ],
    };
    const line = toolUseEvent({ state: { status: "completed", output } });
    expect(streamedTokenCost(line)).toBe(2000);
  });

  it("does not treat a plain text tool result as an image", () => {
    const line = toolUseEvent({ state: { status: "completed", output: "done — saved screenshot.png" } });
    expect(streamedTokenCost(line)).toBe(estimateTokens("done — saved screenshot.png"));
  });
});
