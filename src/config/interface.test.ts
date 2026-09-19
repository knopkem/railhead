import { describe, it, expect } from "vitest";
import {
  parseProjectInterface,
  buildInteractionGuidance,
  requiresRealInputEvidence,
  PROJECT_INTERFACES,
} from "./interface.ts";

describe("parseProjectInterface (#97)", () => {
  it("parses each valid declared interface", () => {
    for (const v of PROJECT_INTERFACES) {
      expect(parseProjectInterface(v)).toBe(v);
    }
    expect(parseProjectInterface("BROWSER-UI")).toBe("browser-ui");
  });

  it("returns null when absent or empty", () => {
    expect(parseProjectInterface(undefined)).toBeNull();
    expect(parseProjectInterface(null)).toBeNull();
    expect(parseProjectInterface("")).toBeNull();
    expect(parseProjectInterface("   ")).toBeNull();
  });

  it("throws on an unknown declared value (a deliberate new row, never a silent coercion)", () => {
    expect(() => parseProjectInterface("native")).toThrow(/unknown value "native"/);
    expect(() => parseProjectInterface(42)).toThrow(/non-string/);
  });
});

describe("requiresRealInputEvidence (#97)", () => {
  it("enforces browser-ui; exempts canvas/none/terminal (deferred instance)/undeclared", () => {
    expect(requiresRealInputEvidence("browser-ui")).toBe(true);
    expect(requiresRealInputEvidence("terminal")).toBe(false);
    expect(requiresRealInputEvidence("canvas")).toBe(false);
    expect(requiresRealInputEvidence("none")).toBe(false);
    expect(requiresRealInputEvidence(null)).toBe(false);
    expect(requiresRealInputEvidence(undefined)).toBe(false);
  });
});

describe("buildInteractionGuidance (#97)", () => {
  it("carries the browser-ui real-input discipline and never blesses synthetic dispatch as operation evidence", () => {
    const g = buildInteractionGuidance("browser-ui");
    expect(g).toContain("chrome-devtools_click");
    expect(g).toMatch(/operating it FOR REAL|for real/i);
    expect(g).toMatch(/never to prove a clickable control works/);
    expect(g).toMatch(/bypasses browser hit-testing/);
  });

  it("keeps the canvas evaluate/pointer-lock defaults as the canvas row", () => {
    const g = buildInteractionGuidance("canvas");
    expect(g).toContain("canvas-based game");
    expect(g).toContain("KeyboardEvent");
    expect(g).toContain("evaluate_script");
    expect(g).toContain("pointerLock");
  });

  it("injects nothing for terminal/none (zero pollution for non-DOM seats)", () => {
    expect(buildInteractionGuidance("terminal")).toBe("");
    expect(buildInteractionGuidance("none")).toBe("");
  });
});
