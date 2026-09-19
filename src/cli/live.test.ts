import { describe, it, expect } from "vitest";
import { renderEventLine } from "./live.ts";

const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe("renderEventLine", () => {
  it("drops empty lines", () => {
    expect(renderEventLine("")).toBeNull();
    expect(renderEventLine("   ")).toBeNull();
  });

  it("drops non-JSON banner output", () => {
    expect(renderEventLine("\u001b[0m opencode \u001b[0m")).toBeNull();
  });

  it("renders step_start with a clear step divider", () => {
    const out = renderEventLine(line({ type: "step_start", part: {} }))!;
    expect(out).toMatch(/step|──|▶/i);
  });

  it("renders assistant text under --verbose", () => {
    expect(renderEventLine(line({ type: "text", part: { text: "hello" } }), { verbose: true })).toContain("hello");
  });

  it("suppresses text and reasoning by default", () => {
    expect(renderEventLine(line({ type: "text", part: { text: "hello" } }))).toBeNull();
    expect(renderEventLine(line({ type: "reasoning", part: { text: "thinking" } }))).toBeNull();
  });

  it("renders reasoning inline, visually distinct from text", () => {
    const reasoning = renderEventLine(line({ type: "reasoning", part: { text: "think hard" } }), { verbose: true })!;
    const text = renderEventLine(line({ type: "text", part: { text: "think hard" } }), { verbose: true })!;
    expect(reasoning).toContain("think hard");
    expect(text).toContain("think hard");
    expect(reasoning).not.toEqual(text);
  });

  it("renders long text and reasoning verbatim under --verbose (no 200-char truncation)", () => {
    const long = "word ".repeat(100).trim();
    expect(long.length).toBeGreaterThan(200);
    expect(renderEventLine(line({ type: "text", part: { text: long } }), { verbose: true })).toBe(`  ${long}`);
    expect(renderEventLine(line({ type: "reasoning", part: { text: long } }), { verbose: true })).toBe(`  · ${long}`);
  });

  it("renders a bash tool_use with the command, status, and exit code", () => {
    const out = renderEventLine(
      line({
        type: "tool_use",
        part: {
          tool: "bash",
          title: "npm test",
          state: { status: "completed", input: { command: "npm test" }, output: "all passing", metadata: { exit: 0 } },
        },
      }),
    )!;
    expect(out).toContain("bash");
    expect(out).toContain("npm test");
    expect(out).toContain("completed");
    expect(out).toContain("exit 0");
  });

  it("renders a write/edit tool_use with the file path", () => {
    const out = renderEventLine(
      line({
        type: "tool_use",
        part: {
          tool: "write",
          title: "src/main.rs",
          state: { status: "completed", input: { filePath: "/x/src/main.rs" } },
        },
      }),
    )!;
    expect(out).toContain("write");
    expect(out).toContain("main.rs");
  });

  it("renders a tool_use with no state as running", () => {
    const out = renderEventLine(
      line({ type: "tool_use", part: { tool: "bash", title: "ls", state: undefined } }),
    )!;
    expect(out).toContain("running");
  });

  it("renders a tool_use with error status, including the error text", () => {
    const out = renderEventLine(
      line({
        type: "tool_use",
        part: {
          tool: "bash",
          title: "npm test",
          state: { status: "error", input: { command: "npm test" }, error: "FAILED: expected 5 got 4", metadata: { exit: 1 } },
        },
      }),
    )!;
    expect(out).toContain("error");
    expect(out).toContain("exit 1");
    expect(out).toContain("FAILED");
  });

  it("renders step_finish with reason and token counts (no cost)", () => {
    const out = renderEventLine(
      line({
        type: "step_finish",
        part: { reason: "tool-calls", tokens: { input: 477, output: 123 }, cost: 0.0015 },
      }),
    )!;
    expect(out).toContain("tool-calls");
    expect(out).toContain("477");
    expect(out).toContain("123");
    expect(out).not.toContain("$");
  });

  it("tolerates step_finish with no tokens", () => {
    const out = renderEventLine(line({ type: "step_finish", part: { reason: "stop" } }))!;
    expect(out).toContain("stop");
    expect(out).not.toContain("$");
  });

  it("renders an error event with a clear marker and the message", () => {
    const out = renderEventLine(
      line({ type: "error", error: { name: "ContextOverflowError", data: { message: "too big" } } }),
    )!;
    expect(out).toContain("ContextOverflowError");
    expect(out).toContain("too big");
  });

  it("drops noisy default event types (message, snapshot, permission)", () => {
    for (const type of ["message", "snapshot", "permission", "unknown"]) {
      expect(renderEventLine(line({ type, part: {} }))).toBeNull();
    }
  });

  it("applies the prefix", () => {
    const out = renderEventLine(
      line({ type: "tool_use", part: { tool: "bash", title: "ls", state: { status: "completed", input: { command: "ls" }, metadata: {} } } }),
      { prefix: "plan" },
    )!;
    expect(out).toMatch(/plan/);
  });
});
