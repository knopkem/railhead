import { describe, it, expect } from "vitest";
import { parseStructuralVerdict, buildStructuralReviewPrompt } from "./structural-review.ts";

describe("parseStructuralVerdict (#49)", () => {
  it("parses $STRUCTURAL_PASS", () => {
    const v = parseStructuralVerdict("some prose\n$STRUCTURAL_PASS\n");
    expect(v).toEqual({ verdict: "pass", findings: [] });
  });

  it("parses $STRUCTURAL_FAIL with findings", () => {
    const text = "$STRUCTURAL_FAIL\n[BLOCKER] Duplicated greeting logic in utils.ts and greeter.ts\n[MAJOR] Dead code in old_renderer.ts\n$END";
    const v = parseStructuralVerdict(text);
    expect(v.verdict).toBe("fail");
    expect(v.findings.length).toBe(2);
    expect(v.findings[0]).toMatch(/\[BLOCKER\].*Duplicated greeting/);
    expect(v.findings[1]).toMatch(/\[MAJOR\].*Dead code/);
  });

  it("returns inconclusive when no marker is present", () => {
    const v = parseStructuralVerdict("some review text without markers");
    expect(v).toEqual({ verdict: "inconclusive", findings: [] });
  });

  it("returns inconclusive when $STRUCTURAL_FAIL has NONE", () => {
    const v = parseStructuralVerdict("$STRUCTURAL_FAIL\nNONE\n$END");
    expect(v).toEqual({ verdict: "inconclusive", findings: [] });
  });

  it("returns inconclusive when $STRUCTURAL_FAIL block is empty", () => {
    const v = parseStructuralVerdict("$STRUCTURAL_FAIL\n$END");
    expect(v).toEqual({ verdict: "inconclusive", findings: [] });
  });

  it("prefers FAIL when both markers are present", () => {
    const text = "$STRUCTURAL_PASS\n$STRUCTURAL_FAIL\n[BLOCKER] something is wrong\n$END";
    const v = parseStructuralVerdict(text);
    expect(v.verdict).toBe("fail");
  });

  it("tolerates case-insensitive markers", () => {
    const v = parseStructuralVerdict("$structural_pass\n");
    expect(v.verdict).toBe("pass");
  });

  it("handles $STRUCTURAL_FAIL without $END (graceful to EOF)", () => {
    const v = parseStructuralVerdict("$STRUCTURAL_FAIL\n[BLOCKER] missing abstraction\n");
    expect(v.verdict).toBe("fail");
    expect(v.findings.length).toBe(1);
  });
});

describe("buildStructuralReviewPrompt (#49)", () => {
  const baseOpts = {
    originalPrompt: "build a greeting CLI",
    verifyCommands: ["npm test"],
    group: "core-engine",
    completedGroups: [] as string[],
    priorFindings: [] as string[],
  };

  it("includes the original prompt", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts });
    expect(p).toContain("build a greeting CLI");
  });

  it("includes the architecture doc when provided", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts, architectureDoc: "Two modules: arg parsing and greeting" });
    expect(p).toContain("Two modules: arg parsing and greeting");
  });

  it("omits the architecture doc block when null", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts, architectureDoc: null });
    expect(p).not.toMatch(/Architecture intent/i);
  });

  it("includes the contracts summary when provided", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts, contractsSummary: "formatGreeting() — formats a greeting string" });
    expect(p).toContain("formatGreeting()");
  });

  it("includes the $STRUCTURAL_PASS/$STRUCTURAL_FAIL marker contract", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts });
    expect(p).toContain("$STRUCTURAL_PASS");
    expect(p).toContain("$STRUCTURAL_FAIL");
  });

  it("instructs the reviewer to flag only structural drift, not compile failures or behavior gaps", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts });
    expect(p).toMatch(/structural.*drift|architectural.*drift/i);
    expect(p).toMatch(/not.*compile|not.*build.*failure|verify owns that/i);
    expect(p).toMatch(/not.*behavior.*gap|goal review owns/i);
  });

  it("instructs the reviewer to read the accumulated source as a corpus", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts });
    expect(p).toMatch(/read.*source|read.*files|file-read|corpus/i);
  });

  it("includes the group name", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts });
    expect(p).toContain("core-engine");
  });

  it("includes prior findings when present", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts, priorFindings: ["[BLOCKER] earlier drift in utils.ts"] });
    expect(p).toContain("earlier drift in utils.ts");
  });

  it("notes this is the intended consumer of the strong-model tier (ADR 0015)", () => {
    const p = buildStructuralReviewPrompt({ ...baseOpts });
    expect(p).toMatch(/strong.*model|oversight/i);
  });
});
