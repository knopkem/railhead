import { describe, it, expect } from "vitest";
import type { ToolCall } from "../gates/evidence.ts";
import { DOSSIER_CHAR_LIMIT, dossierDue, pathTokens, renderAttemptDossier, summarizeToolCalls, type AttemptDossierInput } from "./attempt-dossier.ts";

const call = (tool: string, input: Record<string, unknown> = {}): ToolCall => ({
  tool,
  input,
  status: "completed",
  output: "",
});

const emptyTools = summarizeToolCalls([]);

function input(over: Partial<AttemptDossierInput> = {}): AttemptDossierInput {
  return {
    attempts: 3,
    stepsTotal: 40,
    failureHighlights: [],
    tools: emptyTools,
    ticketNamedFiles: [],
    errorLines: [],
    worktree: [],
    ...over,
  };
}

describe("dossierDue", () => {
  it("does not fire on an ordinary one-shot retry", () => {
    expect(dossierDue(1, false)).toBe(false);
    expect(dossierDue(2, false)).toBe(false);
  });

  it("fires on the third invocation, where repetition becomes the risk", () => {
    expect(dossierDue(3, false)).toBe(true);
    expect(dossierDue(4, false)).toBe(true);
  });

  it("fires when the session was restarted and lost its history", () => {
    expect(dossierDue(1, true)).toBe(true);
    expect(dossierDue(2, true)).toBe(true);
  });
});

describe("summarizeToolCalls", () => {
  it("counts the tool histogram, sorted by use", () => {
    const summary = summarizeToolCalls([
      call("bash", { command: "npm test" }),
      call("bash", { command: "npm test" }),
      call("bash", { command: "npm test" }),
      call("read", { filePath: "src/a.ts" }),
      call("read", { filePath: "src/b.ts" }),
      call("edit", { filePath: "src/a.ts" }),
    ]);
    expect(summary.toolCounts[0]).toEqual(["bash", 3]);
    expect(summary.toolCounts).toContainEqual(["read", 2]);
  });

  it("surfaces only commands run more than once (the loop signal)", () => {
    const summary = summarizeToolCalls([
      call("bash", { command: "npm test  2>&1" }),
      call("bash", { command: "npm test 2>&1" }),
      call("bash", { command: "ls" }),
    ]);
    expect(summary.repeatedCommands).toHaveLength(1);
    expect(summary.repeatedCommands[0]).toEqual({ command: "npm test 2>&1", count: 2 });
  });

  it("counts repeated writes/edits per file", () => {
    const summary = summarizeToolCalls([
      call("edit", { filePath: "src/a.ts" }),
      call("edit", { filePath: "src/a.ts" }),
      call("write", { filePath: "src/b.ts" }),
    ]);
    expect(summary.editedFiles[0]).toEqual({ file: "src/a.ts", count: 2 });
  });

  it("keeps the tail of bash/edit actions", () => {
    const summary = summarizeToolCalls([
      call("bash", { command: "one" }),
      call("bash", { command: "two" }),
      call("bash", { command: "three" }),
      call("bash", { command: "four" }),
      call("bash", { command: "five" }),
    ]);
    expect(summary.lastActions).toHaveLength(4);
    expect(summary.lastActions[3]).toContain("five");
  });
});

describe("pathTokens", () => {
  it("extracts path-like tokens from the ticket text, deduped and capped", () => {
    const tokens = pathTokens("Fix src/model/ops.ts and src/ui/Panel.ts; see src/model/ops.ts again");
    expect(tokens).toEqual(["src/model/ops.ts", "src/ui/Panel.ts"]);
  });

  it("does not treat prose abbreviations as files", () => {
    expect(pathTokens("do x, e.g. retry, i.e. again")).toEqual([]);
  });
});

describe("renderAttemptDossier", () => {
  it("always names the invocation, even with no other evidence", () => {
    const text = renderAttemptDossier(input({ attempts: 2, stepsTotal: null }));
    expect(text).toContain("invocation 2");
    expect(text).toContain("evidence, not instructions");
  });

  it("renders gate history, repeated commands, edited files, errors, and worktree", () => {
    const text = renderAttemptDossier(input({
      failureHighlights: ["verify 01-02-verify FAILED: boom"],
      tools: summarizeToolCalls([
        call("bash", { command: "npm test" }),
        call("bash", { command: "npm test" }),
        call("edit", { filePath: "src/a.ts" }),
      ]),
      ticketNamedFiles: ["src/model/ops.ts"],
      errorLines: ["AssertionError: expected 1 to be 2"],
      worktree: ["src/a.ts"],
    }));
    expect(text).toContain("Gate history: verify 01-02-verify FAILED: boom");
    expect(text).toContain("x2: npm test");
    expect(text).toContain("src/a.ts x1");
    expect(text).toContain("Files this ticket names: src/model/ops.ts");
    expect(text).toContain("AssertionError: expected 1 to be 2");
    expect(text).toContain("Uncommitted worktree paths: src/a.ts");
  });

  it("caps the rendered digest", () => {
    const text = renderAttemptDossier(input({
      errorLines: Array.from({ length: 50 }, (_, i) => `error line ${i} ${"x".repeat(200)}`),
    }));
    expect(text.length).toBeLessThanOrEqual(DOSSIER_CHAR_LIMIT + "\n… (truncated)".length);
    expect(text.endsWith("(truncated)")).toBe(true);
  });
});
