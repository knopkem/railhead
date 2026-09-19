import { describe, it, expect } from "vitest";
import { shouldSummarize, buildOutputSummaryPrompt, parseSummary, buildRunSummaryPrompt, SUMMARIZE_THRESHOLD_CHARS } from "./summary.ts";

describe("shouldSummarize", () => {
  it("returns false for short output (under the threshold)", () => {
    expect(shouldSummarize("error: expected ';' at line 42")).toBe(false);
  });

  it("returns true for output at or above the threshold", () => {
    const blob = "x".repeat(SUMMARIZE_THRESHOLD_CHARS);
    expect(shouldSummarize(blob)).toBe(true);
  });

  it("returns true for a large cargo rebuild log", () => {
    const blob = "   Compiling foo v0.1.0\n".repeat(1000);
    expect(shouldSummarize(blob)).toBe(true);
  });
});

describe("buildOutputSummaryPrompt", () => {
  it("names the kind (verify vs smoke) in the prompt", () => {
    const p = buildOutputSummaryPrompt("blob", "verify");
    expect(p).toContain("verify");
    expect(p).not.toContain("smoke");
  });

  it("names smoke when kind is smoke", () => {
    const p = buildOutputSummaryPrompt("blob", "smoke");
    expect(p).toContain("smoke");
  });

  it("includes the blob between markers", () => {
    const p = buildOutputSummaryPrompt("the error is here", "verify");
    expect(p).toContain("---");
    expect(p).toContain("the error is here");
  });

  it("asks for at most 500 tokens", () => {
    const p = buildOutputSummaryPrompt("blob", "verify");
    expect(p).toMatch(/500 tokens/i);
  });

  it("asks to drop noise and keep signal", () => {
    const p = buildOutputSummaryPrompt("blob", "verify");
    expect(p).toMatch(/error message|assertion|panic signature/i);
    expect(p).toMatch(/drop/i);
    expect(p).toMatch(/ansi escape/i);
  });
});

describe("parseSummary", () => {
  it("returns the text as-is when no meta-commentary is present", () => {
    const text = "error[E0308]: mismatched types at line 42\nexpected u32, found i64";
    expect(parseSummary(text)).toBe(text);
  });

  it("strips a leading 'Here is the summary:' line", () => {
    const text = "Here is the summary:\nerror at line 42";
    expect(parseSummary(text)).toBe("error at line 42");
  });

  it("strips a leading 'Here is a summary:' line", () => {
    const text = "Here is a summary:\nerror at line 42";
    expect(parseSummary(text)).toBe("error at line 42");
  });

  it("strips a leading 'Summary:' line", () => {
    const text = "Summary:\npanic at src/main.rs:17";
    expect(parseSummary(text)).toBe("panic at src/main.rs:17");
  });

  it("returns empty string for empty input", () => {
    expect(parseSummary("")).toBe("");
    expect(parseSummary("   ")).toBe("");
  });

  it("does not strip 'summary' appearing mid-text", () => {
    const text = "the summary of the error is: missing semicolon";
    expect(parseSummary(text)).toBe(text);
  });
});

describe("buildRunSummaryPrompt", () => {
  it("includes the per-ticket summaries in the prompt", () => {
    const p = buildRunSummaryPrompt([
      "01 Build it — status: committed, attempts: 1 | last logs: verify ok",
      "02 Add tests — status: committed, attempts: 2 | last logs: soft-pass: 1 finding(s) remain",
    ]);
    expect(p).toContain("01 Build it");
    expect(p).toContain("02 Add tests");
    expect(p).toContain("soft-pass");
  });

  it("asks for under 1000 tokens and Markdown format", () => {
    const p = buildRunSummaryPrompt(["01 x — status: committed"]);
    expect(p).toMatch(/1000 tokens/i);
    expect(p).toMatch(/Markdown/i);
  });

  it("asks what was built and what's fragile", () => {
    const p = buildRunSummaryPrompt(["01 x — status: committed"]);
    expect(p).toMatch(/what was built/i);
    expect(p).toMatch(/fragile|railhead fix/i);
  });

  it("handles an empty ticket list without crashing", () => {
    const p = buildRunSummaryPrompt([]);
    expect(p).toContain("Per-ticket logs:");
  });
});
