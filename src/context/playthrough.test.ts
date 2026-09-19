import { describe, it, expect } from "vitest";
import { buildPlaythroughSection, extractCoreLoopAnchor } from "./playthrough.ts";

describe("extractCoreLoopAnchor", () => {
  it("pulls a header-and-body loop (the plan.md '## Core loop' shape)", () => {
    const doc = "## Core loop\nSail from Europe (1492) \u2192 explore \u2192 found colonies \u2192 win.";
    expect(extractCoreLoopAnchor(doc)).toContain("Sail from Europe");
  });

  it("pulls an inline loop line", () => {
    expect(extractCoreLoopAnchor("Core loop: sail \u2192 found \u2192 win")).toContain("sail");
  });

  it("returns null when the design doc states no loop", () => {
    expect(extractCoreLoopAnchor("## Visual identity\nPainterly hex map.")).toBeNull();
  });

  it("returns null for a missing/empty design doc", () => {
    expect(extractCoreLoopAnchor(null)).toBeNull();
    expect(extractCoreLoopAnchor(undefined)).toBeNull();
    expect(extractCoreLoopAnchor("")).toBeNull();
  });
});

describe("buildPlaythroughSection", () => {
  it("demands the loop be played to completion, not sampled", () => {
    const s = buildPlaythroughSection("build a colonization game", "## Core loop\nsail \u2192 found \u2192 win.");
    expect(s).toContain("PLAY IT TO COMPLETION");
    expect(s).toContain("terminal");
    expect(s).toContain("sail \u2192 found \u2192 win");
  });

  it("tells the reviewer to derive the loop when the design doc has none", () => {
    const s = buildPlaythroughSection("goal", null);
    expect(s).toContain("Derive the minimal core loop");
  });

  it("ADR 0043: scopes the playthrough to this group when the core loop is not built yet", () => {
    const s = buildPlaythroughSection("a full platformer", "## Core loop\nrun → fight → win.", { coreLoopReady: false });
    expect(s).toContain("Group playthrough");
    expect(s).toContain("this group's deliverables");
    expect(s).toContain("out of scope");
    // It must NOT demand the full loop or its terminal state.
    expect(s).not.toContain("PLAY IT TO COMPLETION");
    expect(s).not.toContain("TERMINAL state");
    expect(s).not.toContain("run → fight → win.");
  });

  it("ADR 0043: keeps the full-loop contract when the loop is ready (default true)", () => {
    const s = buildPlaythroughSection("a full platformer", null);
    expect(s).toContain("Core-loop playthrough");
    expect(s).toContain("PLAY IT TO COMPLETION");
  });
});
