import { describe, it, expect } from "vitest";
import { estimateTokens, REVIEW_MODE_THRESHOLD_RATIO } from "./diff-filter.ts";

describe("priorDiff stat fallback (#25)", () => {
  it("REVIEW_MODE_THRESHOLD_RATIO is 0.4 — shared with reviewer read-mode", () => {
    expect(REVIEW_MODE_THRESHOLD_RATIO).toBe(0.4);
  });

  it("a 64k budget yields a 25,600-token threshold for priorDiff", () => {
    const budget = 64000;
    const threshold = Math.floor(budget * REVIEW_MODE_THRESHOLD_RATIO);
    expect(threshold).toBe(25600);
  });

  it("a raw diff of ~30k tokens exceeds the 64k-budget threshold", () => {
    const budget = 64000;
    const threshold = Math.floor(budget * REVIEW_MODE_THRESHOLD_RATIO);
    const rawDiff = "a".repeat(120000);
    expect(estimateTokens(rawDiff)).toBeGreaterThan(threshold);
  });

  it("a raw diff of ~10k tokens is under the 64k-budget threshold", () => {
    const budget = 64000;
    const threshold = Math.floor(budget * REVIEW_MODE_THRESHOLD_RATIO);
    const rawDiff = "a".repeat(40000);
    expect(estimateTokens(rawDiff)).toBeLessThanOrEqual(threshold);
  });

  it("a raw diff of ~20k tokens exceeds the 32k-budget threshold", () => {
    const budget = 32768;
    const threshold = Math.floor(budget * REVIEW_MODE_THRESHOLD_RATIO);
    const rawDiff = "a".repeat(80000);
    expect(estimateTokens(rawDiff)).toBeGreaterThan(threshold);
  });
});
