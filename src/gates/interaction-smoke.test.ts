import { describe, it, expect } from "vitest";
import { joinPhaseMessages, type PhaseMessages } from "../context/preamble.ts";
const promptText = (m: PhaseMessages): string => joinPhaseMessages(m);
import { buildInteractionSmokePrompt, parseInteractionSmokeVerdict, type InteractionSmokeScope } from "./interaction-smoke.ts";

type SmokeOptions = Omit<Parameters<typeof buildInteractionSmokePrompt>[0], "scope">;

const SCOPE: InteractionSmokeScope = {
  group: "spine",
  groupTickets: [{ number: "02", title: "spine shell", what: "mount the bench", criteria: ["dragging paints pixels"] }],
  frontier: [
    { number: "01", title: "scaffold", group: "scaffold", built: true },
    { number: "02", title: "spine shell", group: "spine", built: true },
    { number: "03", title: "palette", group: "studio", built: false },
  ],
};
const smokePrompt = (o: SmokeOptions): string => promptText(buildInteractionSmokePrompt({ ...o, scope: SCOPE }));

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

  it("treats the explicit no-surface marker as inconclusive, never pass or fail", () => {
    expect(parseInteractionSmokeVerdict("$SMOKE_INCONCLUSIVE\n$END")).toEqual({ verdict: "inconclusive", findings: [] });
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

  it("requires a render-delta assertion and zero console errors (v2 issue 01)", () => {
    const p = smokePrompt({ runCommandHint: "npm run dev", verifyCommands: [], projectInterface: "browser-ui" });
    expect(p).toMatch(/RENDER DELTA/);
    expect(p).toMatch(/Capture the SAME output again and assert it CHANGED/);
    expect(p).toMatch(/ZERO errors/);
    expect(p).toMatch(/ANY logged error/);
  });

  it("states that a curl-style 200 / startup alone is not smoke evidence", () => {
    const p = smokePrompt({ runCommandHint: "npm run dev", verifyCommands: [], projectInterface: "browser-ui" });
    expect(p).toMatch(/HTTP 200.*NOT evidence/is);
    expect(p).toMatch(/unwired rectangle/);
    expect(p).toMatch(/must never be your basis for a pass/i);
  });

  it("scopes the judge to the built frontier and names the closed group's claims (v2 issue 01)", () => {
    const p = smokePrompt({ runCommandHint: "npm run dev", verifyCommands: [] });
    expect(p).toContain("- [built] 01 scaffold (group scaffold)");
    expect(p).toContain("- [built] 02 spine shell (group spine)");
    expect(p).toContain("- [pending] 03 palette (group studio)");
    expect(p).toContain('This gate closes group "spine"');
    expect(p).toContain("dragging paints pixels");
  });

  it("forbids failing a pending feature and offers the no-surface inconclusive verdict", () => {
    const p = smokePrompt({ runCommandHint: "npm run dev", verifyCommands: [] });
    expect(p).toMatch(/never try to operate it and never fail for its absence/i);
    expect(p).toContain("$SMOKE_INCONCLUSIVE");
  });
});
