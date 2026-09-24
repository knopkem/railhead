import { describe, it, expect } from "vitest";
import { renderPreamble, renderTask, joinPhaseMessages, type PreambleInputs } from "./preamble.ts";

const stable: PreambleInputs = {
  mission: "build a snake game",
  agents: "# AGENTS\ncargo fmt before commit",
  context: "# CONTEXT\nSnake: the player avatar",
  design: "Neon palette; the snake glides, never jumps.",
  architecture: "Modules: grid, snake, renderer.",
  coherence: "Visual tokens: NEON from src/ui/tokens.ts.",
};

describe("renderPreamble (#132)", () => {
  it("is byte-stable: two renders of the same inputs are identical", () => {
    expect(renderPreamble(stable)).toBe(renderPreamble(stable));
  });

  it("is seat-neutral: no seat or phase input exists, so any caller with the same inputs gets the same bytes", () => {
    const asImplementer = renderPreamble(stable);
    const asReviewer = renderPreamble({ ...stable });
    expect(asImplementer).toBe(asReviewer);
  });

  it("orders the canonical sections deterministically", () => {
    const p = renderPreamble(stable);
    const order = ["MISSION:", "AGENTS.md", "CONTEXT.md", "Design intent", "Architecture intent", "Coherence contract"];
    const indices = order.map((needle) => p.indexOf(needle));
    for (const idx of indices) expect(idx).toBeGreaterThan(-1);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("locks the exact bytes (golden)", () => {
    expect(renderPreamble({ mission: "m", agents: "A", context: "C", design: "D", architecture: "R", coherence: "H" }))
      .toBe(
        "MISSION: m\n\n" +
          "## Project agent guidance (AGENTS.md)\n\nA\n\n" +
          "## Domain glossary (CONTEXT.md)\n\nC\n\n" +
          "## Design intent (docs/design.md)\n\nD\n\n" +
          "## Architecture intent (docs/architecture.md)\n\nR\n\n" +
          "## Coherence contract (docs/coherence.md)\n\nH",
      );
  });

  it("drops absent and empty sections, so a phase contributes only the stable material it holds", () => {
    expect(renderPreamble({ mission: "m" })).toBe("MISSION: m");
    expect(renderPreamble({ mission: "", agents: "A" })).toBe("## Project agent guidance (AGENTS.md)\n\nA");
    expect(renderPreamble({})).toBe("");
  });

  it("never carries representative ticket/diff/finding material (no-volatile-token property)", () => {
    const volatile = [
      "TICKET: fix the paddle collision",
      "diff --git a/src/main.ts b/src/main.ts",
      "[BLOCKER] the ball passes through the paddle",
      "ACCEPTANCE CRITERIA: paddle moves on arrow keys",
    ];
    const p = renderPreamble(stable);
    for (const text of volatile) expect(p).not.toContain(text);
    // And feeding volatile material into the task leaves the preamble bytes untouched.
    const task = renderTask(volatile);
    expect(renderPreamble(stable)).toBe(renderPreamble({ ...stable }));
    expect(task).toContain(volatile[0]);
  });
});

describe("renderTask (#132)", () => {
  it("joins non-empty sections in order with a blank line between them", () => {
    expect(renderTask(["a", null, "b", undefined, "", "c"])).toBe("a\n\nb\n\nc");
  });

  it("returns an empty string when nothing is present", () => {
    expect(renderTask([])).toBe("");
    expect(renderTask([null, undefined, ""])).toBe("");
  });
});

describe("joinPhaseMessages (#132)", () => {
  it("puts the preamble before the task, separated by a blank line (the transitional single-message form)", () => {
    expect(joinPhaseMessages({ preamble: "P", task: "T" })).toBe("P\n\nT");
  });

  it("degrades gracefully when one part is empty", () => {
    expect(joinPhaseMessages({ preamble: "", task: "T" })).toBe("T");
    expect(joinPhaseMessages({ preamble: "P", task: "" })).toBe("P");
  });
});
