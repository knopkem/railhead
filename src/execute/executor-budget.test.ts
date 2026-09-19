import { describe, it, expect } from "vitest";
import { estimateTokens } from "./diff-filter.ts";
import { PROMPT_BUDGET_RATIO } from "./executor.ts";

describe("estimateTokens (for prompt-size guard #24)", () => {
  it("estimates ~4 chars per token", () => {
    const text = "a".repeat(4000);
    const tokens = estimateTokens(text);
    expect(tokens).toBe(1000);
  });

  it("returns at least 1 for non-empty text", () => {
    expect(estimateTokens("x")).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("PROMPT_BUDGET_RATIO", () => {
  it("is 0.5 — half the context window reserved for model output + tool I/O", () => {
    expect(PROMPT_BUDGET_RATIO).toBe(0.5);
  });

  it("produces the correct threshold for a 64k budget", () => {
    const budget = 64000;
    const threshold = Math.floor(budget * PROMPT_BUDGET_RATIO);
    expect(threshold).toBe(32000);
  });

  it("produces the correct threshold for a 32k budget", () => {
    const budget = 32768;
    const threshold = Math.floor(budget * PROMPT_BUDGET_RATIO);
    expect(threshold).toBe(16384);
  });

  it("produces the correct threshold for a 128k budget", () => {
    const budget = 128000;
    const threshold = Math.floor(budget * PROMPT_BUDGET_RATIO);
    expect(threshold).toBe(64000);
  });
});
