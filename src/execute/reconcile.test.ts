import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authoredPathsInFailure,
  buildBlamePreamble,
  buildReconcilePrompt,
  parseReconcileVerdict,
  applyReconcileEdits,
  reconcileFindingsBlock,
} from "./reconcile.ts";

describe("authoredPathsInFailure", () => {
  it("returns the deduped intersection in first-appearance order from bare path, path:line, and path:line:col forms embedded in prose", () => {
    const authored = ["src/model/history.test.ts", "src/document.ts", "src/main.ts"];
    const output = [
      "FAIL src/main.ts:12:5 deep mismatch: chain[3] vs chain[2]",
      "note: src/model/history.test.ts:3 also fails",
      "see src/document.ts",
    ].join("\n");
    expect(authoredPathsInFailure(output, authored)).toEqual([
      "src/main.ts",
      "src/model/history.test.ts",
      "src/document.ts",
    ]);
  });

  it("returns [] when the failure names no authored path", () => {
    expect(authoredPathsInFailure("nothing here at all", ["src/a.ts"])).toEqual([]);
    expect(authoredPathsInFailure("", ["src/a.ts"])).toEqual([]);
  });

  it("never returns a path named in passing that is not in authoredPaths", () => {
    const output = "assert failed at node_modules/pkg/index.ts:4 while src/a.test.ts ran";
    expect(authoredPathsInFailure(output, ["src/a.test.ts"])).toEqual(["src/a.test.ts"]);
    // node_modules path is not authored — excluded even though it appears.
    expect(authoredPathsInFailure(output, ["src/unrelated.ts"])).toEqual([]);
  });

  it("dedupes a path named more than once", () => {
    const output = "src/a.test.ts:1\nsrc/a.test.ts:9\nsrc/a.test.ts:11";
    expect(authoredPathsInFailure(output, ["src/a.test.ts", "src/b.ts"])).toEqual(["src/a.test.ts"]);
  });
});

describe("buildBlamePreamble", () => {
  it("names the authored failing files and points at a test bug reconciled against the spec", () => {
    const preamble = buildBlamePreamble(["src/model/history.test.ts"]);
    expect(preamble).toContain("src/model/history.test.ts");
    expect(preamble).toMatch(/TEST bug/);
    expect(preamble).toMatch(/spec/);
  });
});

describe("reconcileFindingsBlock", () => {
  it("numbers the arbiter's findings and names which artifact it ruled wrong", () => {
    const block = reconcileFindingsBlock("impl", ["undo() compares chain[k] not chain[k-1]", "returns null on empty history"]);
    expect(block).toMatch(/ruled the IMPLEMENTATION wrong/);
    expect(block).toContain("1. undo() compares chain[k] not chain[k-1]");
    expect(block).toContain("2. returns null on empty history");
  });
});

describe("buildReconcilePrompt", () => {
  const opts = {
    spec: "The app keeps an undo chain. undo() returns the document current BEFORE the last push.",
    ticketNumber: "03",
    title: "History undo",
    criteria: ["undo returns chain[k]"],
    failureOutput: "FAIL src/model/history.test.ts:4 deep mismatch",
    authoredFailing: ["src/model/history.test.ts"],
    diff: "diff --git a/src/model/history.test.ts b/src/model/history.test.ts",
  };

  it("carries the spec verbatim as the only ground truth", () => {
    const p = buildReconcilePrompt(opts);
    expect(p).toContain("The app keeps an undo chain. undo() returns the document current BEFORE the last push.");
    expect(p).toMatch(/human spec \(verbatim/);
  });

  it("labels the ticket's title and criteria as a paraphrase that may itself be wrong", () => {
    const p = buildReconcilePrompt(opts);
    expect(p).toContain("Ticket 03 — History undo");
    expect(p).toContain("- [ ] undo returns chain[k]");
    expect(p).toMatch(/paraphrase of the spec — it may itself be wrong/);
    expect(p).toMatch(/criteria are a paraphrase and can be wrong too/);
  });

  it("states the failure shape outright — the implementation may be correct and the test wrong", () => {
    const p = buildReconcilePrompt(opts);
    expect(p).toMatch(/implementation may be correct and the test wrong/);
    expect(p).toMatch(/off-by-one in a walk\/index loop/);
    expect(p).toMatch(/terminal sentinel asserted as a failure/);
    expect(p).toMatch(/Reconcile the failing artifact against the SPEC/);
  });

  it("carries the failure output, the attributed authored files, and the diff", () => {
    const p = buildReconcilePrompt(opts);
    expect(p).toContain("FAIL src/model/history.test.ts:4 deep mismatch");
    expect(p).toContain("- src/model/history.test.ts");
    expect(p).toContain("The current ticket's uncommitted diff");
  });

  it("spells out the output contract — verdict markers, numbered findings, FILE blocks, and the final $RECONCILE_END line", () => {
    const p = buildReconcilePrompt(opts);
    expect(p).toContain("$RECONCILE_IMPL");
    expect(p).toContain("$RECONCILE_TEST");
    expect(p).toContain("$RECONCILE_INCONCLUSIVE");
    expect(p).toContain("=== FILE: <path> ===");
    expect(p).toContain("=== END FILE ===");
    expect(p).toContain("$RECONCILE_END");
    expect(p).toMatch(/final line of your entire reply must be exactly/);
  });
});

describe("parseReconcileVerdict", () => {
  it("yields all three verdicts with numbered findings", () => {
    const impl = parseReconcileVerdict("I reviewed it.\n$RECONCILE_IMPL\n1. undo returns null on empty history\n2. index drift\n$RECONCILE_END");
    expect(impl).toEqual({ verdict: "impl", findings: ["undo returns null on empty history", "index drift"], edits: [] });

    const test = parseReconcileVerdict("$RECONCILE_TEST\n1. the walk compares the k-th undo() to chain[k]\n$RECONCILE_END");
    expect(test!.verdict).toBe("test");
    expect(test!.findings).toEqual(["the walk compares the k-th undo() to chain[k]"]);

    const inconclusive = parseReconcileVerdict("$RECONCILE_INCONCLUSIVE\n1. cannot tell from this output\n$RECONCILE_END");
    expect(inconclusive).toEqual({ verdict: "inconclusive", findings: ["cannot tell from this output"], edits: [] });
  });

  it("tolerates prose-wrapped and lowercased markers", () => {
    const prose = parseReconcileVerdict(
      "After checking against the spec I rule $reconcile_test — the test is wrong because 1. it compares chain[k] instead of chain[k-1].\n2. the terminal undo is asserted as a failure.\n$RECONCILE_END",
    );
    expect(prose!.verdict).toBe("test");
    expect(prose!.findings[0]).toContain("it compares chain[k] instead of chain[k-1]");
    expect(prose!.findings).toContain("the terminal undo is asserted as a failure.");
  });

  it("returns null when no verdict marker is present", () => {
    expect(parseReconcileVerdict("just prose, no markers here")).toBeNull();
    expect(parseReconcileVerdict("")).toBeNull();
  });

  it("extracts every complete FILE block verbatim and returns empty edits for a verdict carrying none", () => {
    const text = [
      "$RECONCILE_TEST",
      "1. fix the indexing",
      "=== FILE: src/model/history.test.ts ===",
      "import { undo } from './history';",
      "it('walks back', () => { expect(undo()).toBe('before'); });",
      "=== END FILE ===",
      "=== FILE: src/model/history.test.ts ===",
      "=== END FILE ===",
      "$RECONCILE_END",
    ].join("\n");
    const parsed = parseReconcileVerdict(text)!;
    expect(parsed.verdict).toBe("test");
    expect(parsed.edits).toHaveLength(2);
    expect(parsed.edits[0].path).toBe("src/model/history.test.ts");
    expect(parsed.edits[0].content).toContain("expect(undo()).toBe('before');");
    // Empty content block: the header-to-terminator gap is a single newline.
    expect(parsed.edits[1].content.trim()).toBe("");

    const noFiles = parseReconcileVerdict("$RECONCILE_TEST\n1. nothing to change\n$RECONCILE_END")!;
    expect(noFiles.edits).toEqual([]);
  });

  it("returns empty edits when a FILE block is truncated to no terminator (never a partial write)", () => {
    const truncated = [
      "$RECONCILE_TEST",
      "1. fix the indexing",
      "=== FILE: src/model/history.test.ts ===",
      "import { undo } from './history';",
      "it('walks back', () => { expect(undo()).toBe('before'); });",
      // no === END FILE === and no $RECONCILE_END — the model was cut off
    ].join("\n");
    const parsed = parseReconcileVerdict(truncated)!;
    expect(parsed.edits).toEqual([]);
    expect(parsed.findings).toContain("fix the indexing");
  });
});

describe("applyReconcileEdits", () => {
  it("writes only allowedPaths members and reports every dropped path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reconcile-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "keep.ts"), "old", "utf8");
    const { applied, dropped } = await applyReconcileEdits(
      cwd,
      [
        { path: "src/keep.ts", content: "fixed content\n" },
        { path: "src/new.ts", content: "new file\n" },
        { path: "src/other/not-authored.ts", content: "sneaky\n" },
      ],
      ["src/keep.ts", "src/new.ts"],
    );
    expect(applied).toEqual(["src/keep.ts", "src/new.ts"]);
    expect(dropped).toEqual(["src/other/not-authored.ts"]);
    expect(await readFile(join(cwd, "src", "keep.ts"), "utf8")).toBe("fixed content\n");
    expect(await readFile(join(cwd, "src", "new.ts"), "utf8")).toBe("new file\n");
    // The dropped file was never created.
    await expect(readFile(join(cwd, "src", "other", "not-authored.ts"), "utf8")).rejects.toThrow();
  });

  it("creates parent directories for an applied edit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "reconcile-"));
    const { applied, dropped } = await applyReconcileEdits(
      cwd,
      [{ path: "src/deep/nested/thing.test.ts", content: "x\n" }],
      ["src/deep/nested/thing.test.ts"],
    );
    expect(applied).toEqual(["src/deep/nested/thing.test.ts"]);
    expect(dropped).toEqual([]);
    expect(await readFile(join(cwd, "src", "deep", "nested", "thing.test.ts"), "utf8")).toBe("x\n");
  });
});
