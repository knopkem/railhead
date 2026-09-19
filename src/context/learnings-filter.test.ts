import { describe, it, expect } from "vitest";
import { isContextWindowClaim, filterContextWindowClaims, isCapabilitySelfAssessment, filterCapabilityClaims } from "./learnings.ts";

describe("isContextWindowClaim", () => {
  it("detects a claim about the model's hard context limit", () => {
    expect(isContextWindowClaim("The railhead runs with a 262144-token model context window")).toBe(true);
    expect(isContextWindowClaim("maximum context length is 262144 tokens")).toBe(true);
    expect(isContextWindowClaim("ContextOverflowError occurs at 262k tokens")).toBe(true);
  });

  it("detects claims mentioning 'context window' generically", () => {
    expect(isContextWindowClaim("the model context window is large")).toBe(true);
    expect(isContextWindowClaim("context window exceeded")).toBe(true);
  });

  it("detects claims with token counts", () => {
    expect(isContextWindowClaim("prompt exceeded 200000 tokens")).toBe(true);
    expect(isContextWindowClaim("the 64k token budget")).toBe(true);
    expect(isContextWindowClaim("failed at 262144 tokens")).toBe(true);
  });

  it("does NOT flag a normal tooling fact", () => {
    expect(isContextWindowClaim("screencapture -x gives raw PNG on macOS")).toBe(false);
    expect(isContextWindowClaim("npm run dev serves on port 5173")).toBe(false);
    expect(isContextWindowClaim("cargo run panics without a TTY")).toBe(false);
  });

  it("does NOT flag a claim about context that isn't about the window size", () => {
    expect(isContextWindowClaim("use context isolation for the render loop")).toBe(false);
    expect(isContextWindowClaim("the context object manages ECS resources")).toBe(false);
  });
});

describe("filterContextWindowClaims", () => {
  it("removes context-window claims and keeps the rest", () => {
    const input = "screencapture -x gives raw PNG\nThe railhead runs with a 262144-token model context window\nnpm run dev serves on 5173";
    const result = filterContextWindowClaims(input);
    expect(result).toBe("screencapture -x gives raw PNG\nnpm run dev serves on 5173");
  });

  it("returns null when all lines are context-window claims", () => {
    expect(filterContextWindowClaims("the 262k context window is the limit\ncontext window exceeded")).toBeNull();
  });

  it("returns the input unchanged when no claims are present", () => {
    const input = "cargo run panics without TTY\nport 5173 is default";
    expect(filterContextWindowClaims(input)).toBe(input);
  });

  it("returns null for null input", () => {
    expect(filterContextWindowClaims(null)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(filterContextWindowClaims("")).toBeNull();
  });
});

describe("isCapabilitySelfAssessment", () => {
  it("detects 'this model cannot read X' self-assessments", () => {
    expect(isCapabilitySelfAssessment("deepseek-v4-flash cannot read screenshots")).toBe(true);
    expect(isCapabilitySelfAssessment("this model cannot read images")).toBe(true);
    expect(isCapabilitySelfAssessment("the vision model is unable to parse PNG files")).toBe(true);
  });

  it("detects 'model X does not support Y' self-assessments", () => {
    expect(isCapabilitySelfAssessment("deepseek-v4-flash does not support tool calling")).toBe(true);
    expect(isCapabilitySelfAssessment("the local model lacks vision capability")).toBe(true);
  });

  it("detects first-person 'I cannot' self-assessments", () => {
    expect(isCapabilitySelfAssessment("I cannot read screenshots")).toBe(true);
    expect(isCapabilitySelfAssessment("I am unable to see images")).toBe(true);
  });

  it("does NOT flag a normal tooling fact that mentions the model", () => {
    expect(isCapabilitySelfAssessment("the model needs the --yolo flag for /tmp writes")).toBe(false);
    expect(isCapabilitySelfAssessment("opencode serve worker is flaky on macOS")).toBe(false);
    expect(isCapabilitySelfAssessment("npm run dev serves on port 5173")).toBe(false);
  });

  it("does NOT flag a fact about what a model IS (positive capability, not a limitation)", () => {
    expect(isCapabilitySelfAssessment("the vision model can read PNG screenshots")).toBe(false);
    expect(isCapabilitySelfAssessment("deepseek-v4-flash supports vision input")).toBe(false);
  });

  it("detects verbs beyond the original read/see/process/parse/view list (#57)", () => {
    // The run's false learning used 'decode' — not in the original verb list,
    // so it slipped through and poisoned every subsequent visual review.
    expect(isCapabilitySelfAssessment("this review model cannot decode PNGs via the read tool")).toBe(true);
    expect(isCapabilitySelfAssessment("this model cannot interpret screenshots")).toBe(true);
    expect(isCapabilitySelfAssessment("deepseek-v4-flash cannot perceive images")).toBe(true);
    expect(isCapabilitySelfAssessment("I cannot render images")).toBe(true);
    expect(isCapabilitySelfAssessment("the model cannot display screenshots")).toBe(true);
    expect(isCapabilitySelfAssessment("this model cannot open PNGs")).toBe(true);
    expect(isCapabilitySelfAssessment("the vision model cannot ingest images")).toBe(true);
  });

  it("detects negated image-noun claims regardless of the verb (#57)", () => {
    // The broader net: a negation within a couple of words of an image noun.
    expect(isCapabilitySelfAssessment("this model is unable to receive image input")).toBe(true);
    expect(isCapabilitySelfAssessment("I am unable to take in screenshots")).toBe(true);
    expect(isCapabilitySelfAssessment("the reviewer cannot see images at all")).toBe(true);
  });
});

describe("filterCapabilityClaims", () => {
  it("removes capability self-assessments and keeps tooling facts", () => {
    const input = "screencapture -x gives raw PNG\ndeepseek-v4-flash cannot read screenshots\nnpm run dev serves on 5173";
    const result = filterCapabilityClaims(input);
    expect(result).toBe("screencapture -x gives raw PNG\nnpm run dev serves on 5173");
  });

  it("returns null when all lines are capability claims", () => {
    expect(filterCapabilityClaims("this model cannot read images\nI cannot see screenshots")).toBeNull();
  });

  it("filters a 'cannot decode PNGs' learning that previously passed through (#57)", () => {
    // The run that prompted issue #57 persisted exactly this learning, which
    // then told every subsequent visual reviewer it couldn't see images.
    const input = "screencapture -x gives raw PNG\nThis review model cannot decode PNGs via the read tool (\"does not support image input\"); verify visuals via gl.readPixels\nnpm run dev serves on 5173";
    const result = filterCapabilityClaims(input);
    expect(result).toBe("screencapture -x gives raw PNG\nnpm run dev serves on 5173");
  });

  it("returns the input unchanged when no claims are present", () => {
    const input = "cargo run panics without TTY\nport 5173 is default";
    expect(filterCapabilityClaims(input)).toBe(input);
  });

  it("returns null for null input", () => {
    expect(filterCapabilityClaims(null)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(filterCapabilityClaims("")).toBeNull();
  });
});
