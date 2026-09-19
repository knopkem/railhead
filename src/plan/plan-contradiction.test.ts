import { describe, it, expect } from "vitest";
import {
  findUnresolvedArtifact,
  planMentions,
  describePlanContradiction,
} from "./plan-contradiction.ts";

describe("findUnresolvedArtifact (plan-contradiction detector)", () => {
  it("pulls a scoped artifact out of npm's 404-with-version line (the SpriteForge phantom-dep shape)", () => {
    const out = [
      "npm error code E404",
      "npm error 404  The requested resource '@jsquar/png@0.1.0' could not be found or you do not have permission to access it.",
      "npm error A complete log of this run can be found in: /Users/macair/.npm/_logs/2026-09-09T10_48_36_726Z-debug-0.log",
    ].join("\n");
    expect(findUnresolvedArtifact(out)).toBe("@jsquar/png");
  });

  it("strips the @* wildcard from a scoped versions-query 404", () => {
    const out = "npm error 404 The requested resource '@jsquar/png@*' could not be found";
    expect(findUnresolvedArtifact(out)).toBe("@jsquar/png");
  });

  it("recovers an unscoped artifact named in a registry-URL line", () => {
    const out = "npm error 404 Not Found - GET https://registry.npmjs.org/pngjs9 - Not found";
    expect(findUnresolvedArtifact(out)).toBe("pngjs9");
  });

  it("recovers a url-encoded scoped name from a registry URL", () => {
    const out = "npm error 404 Not Found - GET https://registry.npmjs.org/%40jsquar%2Fpng";
    expect(findUnresolvedArtifact(out)).toBe("@jsquar/png");
  });

  it("recovers a backticked crate name from cargo output", () => {
    const out = "error: no matching package named `bevy-sprite2d` found";
    expect(findUnresolvedArtifact(out)).toBe("bevy-sprite2d");
  });

  it("ignores a version-range token and returns the package name", () => {
    const out = "npm error 404 no matching version found for pngjs@^7.0.0";
    expect(findUnresolvedArtifact(out)).toBe("pngjs");
  });

  it("returns null when the output has no resolver failure (a compile error, a test failure)", () => {
    const out = [
      "> tsc --noEmit",
      "src/main.ts:4:7 - error TS2304: Cannot find name 'SIZE'.",
    ].join("\n");
    expect(findUnresolvedArtifact(out)).toBeNull();
  });

  it("returns null when a 404 line carries no artifact token", () => {
    const out = "error: 404 Not Found - GET https://registry.npmjs.org/-/v1/search";
    expect(findUnresolvedArtifact(out)).toBeNull();
  });
});

describe("planMentions", () => {
  it("is true when the ticket's plan text names the artifact verbatim", () => {
    const ticketText =
      "ACCEPTANCE CRITERIA:\n- dependencies include vite, typescript, vitest, @jsquar/png, gifenc";
    expect(planMentions(ticketText, "@jsquar/png")).toBe(true);
  });

  it("is true when the plan dropped the @scope/ prefix", () => {
    expect(planMentions("the project uses jsquar/png for encoding", "@jsquar/png")).toBe(true);
  });

  it("is false when the artifact appears nowhere in the plan text", () => {
    expect(planMentions("a pure-JS PNG encoder with no DOM", "@jsquar/png")).toBe(false);
  });

  it("is false on empty input", () => {
    expect(planMentions("", "@jsquar/png")).toBe(false);
    expect(planMentions("some text", "")).toBe(false);
  });
});

describe("describePlanContradiction", () => {
  it("names the artifact and demands an explicit recorded substitution, not silence", () => {
    const msg = describePlanContradiction("@jsquar/png");
    expect(msg).toContain("@jsquar/png");
    expect(msg).toMatch(/plan claim, not ground truth/i);
    expect(msg).toMatch(/record the substitution/i);
    expect(msg).toMatch(/stale plan text to correct/i);
  });
});
