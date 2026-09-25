import { describe, it, expect } from "vitest";
import { parseToolCalls, hasAppLaunch, hasInteractionEvidence, hasRenderObservation, interactionSmokePassGap, type ToolCall } from "./evidence.ts";

function toolUseEvent(tool: string, input: Record<string, unknown>, status = "completed"): string {
  return JSON.stringify({
    type: "tool_use",
    part: { type: "tool", tool, state: { status, input } },
  });
}

function stepStartEvent(): string {
  return JSON.stringify({ type: "step_start", part: { type: "step-start" } });
}

function textEvent(text: string): string {
  return JSON.stringify({ type: "text", part: { type: "text", text } });
}

const SAMPLE_TRANSCRIPT = [
  stepStartEvent(),
  toolUseEvent("bash", { command: "cargo check" }),
  toolUseEvent("bash", { command: "cargo test" }),
  toolUseEvent("read", { filePath: "Cargo.toml" }),
  textEvent("$VISUAL_PASS\n$END"),
].join("\n");

const APP_LAUNCH_TRANSCRIPT = [
  stepStartEvent(),
  toolUseEvent("bash", { command: "cargo check" }),
  toolUseEvent("bash", { command: "cargo run" }),
  textEvent("$VISUAL_PASS\n$END"),
].join("\n");

function toolCall(
  tool: string,
  input: Record<string, unknown>,
  status = "completed",
): ToolCall[] {
  return [{ tool, input, status }];
}

describe("parseToolCalls", () => {
  it("extracts tool_use events in order", () => {
    const calls = parseToolCalls(SAMPLE_TRANSCRIPT);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      tool: "bash",
      input: { command: "cargo check" },
      status: "completed",
    });
    expect(calls[1]).toEqual({
      tool: "bash",
      input: { command: "cargo test" },
      status: "completed",
    });
    expect(calls[2].tool).toBe("read");
  });

  it("skips malformed JSON lines", () => {
    const text = [
      "not json",
      toolUseEvent("bash", { command: "cargo run" }),
      "{bad",
      textEvent("hi"),
    ].join("\n");
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("bash");
  });

  it("skips non-tool_use events", () => {
    const text = [stepStartEvent(), textEvent("hello")].join("\n");
    expect(parseToolCalls(text)).toEqual([]);
  });

  it("handles empty input", () => {
    expect(parseToolCalls("")).toEqual([]);
  });

  it("handles tool_use without input", () => {
    const text = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "bash", state: { status: "completed" } },
    });
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({});
  });
});

describe("hasAppLaunch", () => {
  const buildTestPattern = /^(cargo (check|test|build|clippy)|npm (test|run build|run lint|run typecheck)|pytest|ruff|eslint|tsc)/;

  it("returns false when only build/test commands ran", () => {
    const calls = parseToolCalls(SAMPLE_TRANSCRIPT);
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(false);
  });

  it("returns true when a non-build-test bash command ran", () => {
    const calls = parseToolCalls(APP_LAUNCH_TRANSCRIPT);
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(true);
  });

  it("returns false for npm run dev alone — a server start proves nothing was viewed (#58)", () => {
    const calls = toolCall("bash", { command: "npm run dev" });
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(false);
  });

  it("returns false for npm run preview alone (#58)", () => {
    const calls = toolCall("bash", { command: "npm run preview -- --port 4317" });
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(false);
  });

  it("returns true when a server-start command is paired with a browser tool call (#58)", () => {
    const calls = [
      ...toolCall("bash", { command: "npm run preview -- --port 4317" }),
      ...toolCall("playwright_browser_take_screenshot", { filename: "frame.png" }),
    ];
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(true);
  });

  it("returns true for chrome-devtools_ MCP browser tools (#58)", () => {
    const calls = toolCall("chrome-devtools_take_screenshot", { filePath: ".railhead/visual/frame.png" });
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(true);
  });

  it("returns true for running a binary directly", () => {
    const calls = toolCall("bash", { command: "./target/debug/pong" });
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(true);
  });

  it("returns false when only read/write tools used (no bash at all)", () => {
    const calls = toolCall("read", { filePath: "Cargo.toml" });
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(false);
  });

  it("returns false for a bash command with no input.command", () => {
    const calls = toolCall("bash", {});
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(false);
  });

  it("returns false for empty calls", () => {
    expect(hasAppLaunch([], buildTestPattern)).toBe(false);
  });

  it("returns true for browser MCP tool calls (browser_navigate)", () => {
    const calls = toolCall("browser_navigate", { url: "http://localhost:3000" });
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(true);
  });

  it("returns true for browser MCP tool calls (browser_screenshot)", () => {
    const calls = toolCall("browser_screenshot", {});
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(true);
  });

  it("returns true when only build/test bash ran but a browser tool was also used", () => {
    const calls = [
      ...parseToolCalls(SAMPLE_TRANSCRIPT),
      ...toolCall("browser_click", { selector: "#start-btn" }),
    ];
    expect(hasAppLaunch(calls, buildTestPattern)).toBe(true);
  });
});

describe("hasInteractionEvidence (#97)", () => {
  it("browser-ui: counts a real chrome-devtools input call", () => {
    expect(hasInteractionEvidence(toolCall("chrome-devtools_click", { uid: "btn" }), "browser-ui").ok).toBe(true);
    expect(hasInteractionEvidence(toolCall("chrome-devtools_fill", { uid: "f", value: "x" }), "browser-ui").ok).toBe(true);
    expect(hasInteractionEvidence(toolCall("chrome-devtools_press_key", { key: "Enter" }), "browser-ui").ok).toBe(true);
    expect(hasInteractionEvidence(toolCall("chrome-devtools_type_text", { text: "hi" }), "browser-ui").ok).toBe(true);
  });

  it("browser-ui: synthetic evaluate_script dispatch alone never counts (the #97 spark)", () => {
    const res = hasInteractionEvidence(
      [
        ...toolCall("chrome-devtools_take_snapshot", {}),
        ...toolCall("chrome-devtools_evaluate_script", { function: "() => { document.querySelector('#save').click(); }" }),
        ...toolCall("chrome-devtools_take_screenshot", { filePath: ".railhead/visual/a.png" }),
      ],
      "browser-ui",
    );
    expect(res.ok).toBe(false);
    expect(res.missing).toMatch(/real-input|synthetic/i);
  });

  it("browser-ui: real input paired with evaluate is fine", () => {
    const calls = [
      ...toolCall("chrome-devtools_evaluate_script", { function: "() => document.querySelector('#save').textContent" }),
      ...toolCall("chrome-devtools_click", { uid: "save-btn" }),
    ];
    expect(hasInteractionEvidence(calls, "browser-ui").ok).toBe(true);
  });

  it("terminal is not enforced yet (driven-stdin instance is not ledger-visible, like native) — declared value, no downgrade", () => {
    expect(hasInteractionEvidence(toolCall("read", { filePath: "src/main.rs" }), "terminal").ok).toBe(true);
    expect(hasInteractionEvidence(toolCall("bash", { command: "cargo test" }), "terminal").ok).toBe(true);
  });

  it("canvas/none/undeclared are exempt by construction — never downgraded for missing real input", () => {
    for (const iface of ["canvas", "none"] as const) {
      const res = hasInteractionEvidence(toolCall("chrome-devtools_evaluate_script", { function: "() => {}" }), iface);
      expect(res.ok).toBe(true);
      expect(res.missing).toBeNull();
    }
    expect(hasInteractionEvidence([], null).ok).toBe(true);
    expect(hasInteractionEvidence([], undefined).ok).toBe(true);
  });
});

describe("interaction smoke pass evidence (v2 issue 01)", () => {
  it("hasRenderObservation: screenshots and image reads count; a text snapshot does not", () => {
    expect(hasRenderObservation(toolCall("chrome-devtools_take_screenshot", { filePath: "a.png" }))).toBe(true);
    expect(hasRenderObservation(toolCall("read", { filePath: ".railhead/visual/a.png" }))).toBe(true);
    expect(hasRenderObservation(toolCall("read", { path: "shot.webp" }))).toBe(true);
    expect(hasRenderObservation(toolCall("chrome-devtools_take_snapshot", {}))).toBe(false);
    expect(hasRenderObservation(toolCall("read", { filePath: "src/main.ts" }))).toBe(false);
  });

  it("a browser-ui pass with real input but no pixels is a gap (the curl-200 case), not a failure", () => {
    const gap = interactionSmokePassGap(toolCall("chrome-devtools_click", { uid: "new-game" }), "browser-ui");
    expect(gap).toMatch(/render observation/i);
    expect(gap).toMatch(/200/);
  });

  it("a browser-ui pass with pixels but only synthetic dispatch is a gap", () => {
    const odd: ToolCall[] = [
      { tool: "chrome-devtools_evaluate_script", input: { function: "() => document.querySelector('#a').click()" }, status: "completed" },
      { tool: "chrome-devtools_take_screenshot", input: { filePath: "a.png" }, status: "completed" },
    ];
    expect(interactionSmokePassGap(odd, "browser-ui")).toMatch(/real-input|synthetic/i);
  });

  it("a fully evidenced browser-ui pass has no gap; non-browser interfaces are exempt", () => {
    const good: ToolCall[] = [
      { tool: "chrome-devtools_click", input: { uid: "new-game" }, status: "completed" },
      { tool: "chrome-devtools_take_screenshot", input: { filePath: "before.png" }, status: "completed" },
      { tool: "chrome-devtools_take_screenshot", input: { filePath: "after.png" }, status: "completed" },
    ];
    expect(interactionSmokePassGap(good, "browser-ui")).toBeNull();
    expect(interactionSmokePassGap([], "canvas")).toBeNull();
  });
});
