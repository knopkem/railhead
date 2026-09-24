import { describe, it, expect } from "vitest";
import { joinPhaseMessages, type PhaseMessages } from "../context/preamble.ts";
const promptText = (m: PhaseMessages): string => joinPhaseMessages(m);
const smokePrompt = (o: Parameters<typeof buildInteractionSmokePrompt>[0]): string => promptText(buildInteractionSmokePrompt(o));
import { buildInteractionSmokePrompt, parseInteractionSmokeVerdict } from "./interaction-smoke.ts";

describe("parseInteractionSmokeVerdict", () => {
  it("parses a pass", () => {
    expect(parseInteractionSmokeVerdict("$SMOKE_PASS\n$END")).toEqual({ verdict: "pass", findings: [] });
  });

  it("parses a fail with findings", () => {
    const v = parseInteractionSmokeVerdict("$SMOKE_FAIL\n[BLOCKER] the End Turn button does not advance the turn\n$END");
    expect(v.verdict).toBe("fail");
    expect(v.findings).toEqual(["[BLOCKER] the End Turn button does not advance the turn"]);
  });

  it("is inconclusive with no marker", () => {
    expect(parseInteractionSmokeVerdict("no verdict here")).toEqual({ verdict: "inconclusive", findings: [] });
  });
});

describe("buildInteractionSmokePrompt", () => {
  it("tells the agent to drive one real interaction and assert state", () => {
    const p = smokePrompt({ runCommandHint: "npm run dev", verifyCommands: ["npm test"] });
    expect(p).toContain("$SMOKE_PASS");
    expect(p).toContain("$SMOKE_FAIL");
    expect(p).toContain("OPERABLE");
    expect(p).toContain("npm run dev");
  });

  it("injects project interaction hints over interface guidance", () => {
    const p = smokePrompt({
      runCommandHint: "x",
      verifyCommands: [],
      interactionHints: "use PointerEvent dispatch on the canvas",
      projectInterface: "browser-ui",
    });
    expect(p).toContain("use PointerEvent dispatch on the canvas");
  });

  it("falls back to the declared-interface guidance when no hints are given", () => {
    const p = smokePrompt({ runCommandHint: "x", verifyCommands: [], projectInterface: "browser-ui" });
    expect(p).toContain("chrome-devtools_click");
  });
});
