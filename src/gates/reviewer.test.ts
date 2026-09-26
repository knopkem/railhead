import { mkdtemp, writeFile, mkdir, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, expect } from "vitest";
import { extractAssistantText, extractPlanText } from "../core/ledger.ts";
import { splitFindings, countSeverity, reviewSummary, severityOf, review, stripCompileClaimsWhenGreen, parseVerdict, truncateFindingBody, changedPathsFromDiff, downgradeUnanchoredBlockers, classifySeverity, stripSeverityLabel, mentionsSeverityWord, promoteUnlabelledSeverity, isBlocker } from "./reviewer.ts";
import { normalizeState } from "../core/ledger.ts";
import type { RunState } from "../core/state.ts";

const dirs: string[] = [];

async function makeLedger(lines: string[]): Promise<{ dir: string; phase: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rv-"));
  dirs.push(dir);
  const phase = "x";
  await mkdir(join(dir, "events"), { recursive: true });
  await writeFile(join(dir, "events", `${phase}.jsonl`), lines.join("\n"), "utf8");
  return { dir, phase };
}

afterEach(async () => {
  while (dirs.length) {
    // leave cleanup to the OS temp dir; keep test I/O minimal
    dirs.pop();
  }
});

describe("splitFindings", () => {
  it("returns [] for NONE or empty", () => {
    expect(splitFindings("NONE")).toEqual([]);
    expect(splitFindings("")).toEqual([]);
  });

  it("splits a bullet list into items", () => {
    expect(splitFindings("- a\n- b\n- c")).toEqual(["a", "b", "c"]);
    expect(splitFindings("• x\n• y")).toEqual(["x", "y"]);
  });

  it("strips bullet markers and blank lines", () => {
    expect(splitFindings("- a\n\n- b")).toEqual(["a", "b"]);
  });
});

describe("parseVerdict — the one parser behind visual/goal/structural (#89)", () => {
  const visual = { failMarker: "$VISUAL_FAIL", passMarker: "$VISUAL_PASS" };
  const goal = { failMarker: "$GOAL_FAIL", passMarker: "$GOAL_PASS" };
  const structural = { failMarker: "$STRUCTURAL_FAIL", passMarker: "$STRUCTURAL_PASS" };

  it("is parameterized by marker names — the same text parses per kind", () => {
    expect(parseVerdict("$VISUAL_FAIL\n[BLOCKER] rows drift\n$END", visual).verdict).toBe("fail");
    // The goal markers must not trip the visual parser (a marker from another
    // kind is inert to this one — only its own markers open a verdict).
    expect(parseVerdict("$GOAL_FAIL\n[BLOCKER] rows drift\n$END", visual).verdict).toBe("inconclusive");
    expect(parseVerdict("$STRUCTURAL_PASS\n", structural).verdict).toBe("pass");
    expect(parseVerdict("$GOAL_PASS\n$END", goal).verdict).toBe("pass");
  });

  it("keeps the defensive defaults uniform across kinds", () => {
    // no marker → inconclusive
    expect(parseVerdict("the app looks fine", goal)).toEqual({ verdict: "inconclusive", findings: [] });
    // FAIL with NONE/empty → inconclusive (no evidence to act on)
    expect(parseVerdict("$VISUAL_FAIL\nNONE\n$END", visual)).toEqual({ verdict: "inconclusive", findings: [] });
    expect(parseVerdict("$GOAL_FAIL\n$END", goal)).toEqual({ verdict: "inconclusive", findings: [] });
    // both markers → prefer FAIL
    expect(parseVerdict("$STRUCTURAL_PASS\n$STRUCTURAL_FAIL\n[BLOCKER] drift\n$END", structural).verdict).toBe("fail");
  });

  it("does not match a marker that is only a prefix of a longer one", () => {
    // A transcript that says "$VISUAL_FAILED to launch" must not be read as a
    // $VISUAL_FAIL verdict — the word boundary keeps the prefix inert.
    expect(parseVerdict("$VISUAL_FAILED to launch\n$END", visual)).toEqual({ verdict: "inconclusive", findings: [] });
  });

  it("ignores a fenced $FAIL example and reads a real $PASS outside the fence (#108)", () => {
    const text = "Here is the shape I was asked for:\n```\n$VISUAL_FAIL\n[BLOCKER] example\n$END\n```\n\n$VISUAL_PASS\n$END";
    expect(parseVerdict(text, visual)).toEqual({ verdict: "pass", findings: [] });
  });

  it("ignores a fenced $PASS example and reads a real $FAIL outside the fence (#108)", () => {
    const text = "```\n$GOAL_PASS\n```\n$GOAL_FAIL\n[BLOCKER] a real gap\n$END";
    const v = parseVerdict(text, goal);
    expect(v.verdict).toBe("fail");
    expect(v.findings).toEqual(["[BLOCKER] a real gap"]);
  });

  it("ignores a fenced $STRUCTURAL_FAIL example and a real one still fails (#108)", () => {
    const text = "```\n$STRUCTURAL_FAIL\n[BLOCKER] example\n$END\n```\n$STRUCTURAL_FAIL\n[BLOCKER] drift\n$END";
    const v = parseVerdict(text, structural);
    expect(v.verdict).toBe("fail");
    expect(v.findings).toEqual(["[BLOCKER] drift"]);
  });

  it("does not fire a marker quoted before a dangling open fence (#108)", () => {
    // The unclosed fence cuts to the end, so a quoted $GOAL_PASS before it
    // never fires — the transcript is inconclusive, not pass.
    const text = "```\n$GOAL_PASS\n$END";
    expect(parseVerdict(text, goal)).toEqual({ verdict: "inconclusive", findings: [] });
  });

  it("still slices findings from the raw text, so fenced code inside a verdict block survives (#108)", () => {
    const text = "$GOAL_FAIL\n[BLOCKER] the fix is:\n```\nconst x = 42\n```\n$END";
    const v = parseVerdict(text, goal);
    expect(v.verdict).toBe("fail");
    expect(v.findings.join("\n")).toContain("const x = 42");
  });
});

describe("truncateFindingBody (#89)", () => {
  it("keeps a short body intact", () => {
    expect(truncateFindingBody("short finding", 500, "…")).toBe("short finding");
  });

  it("cuts a long body to maxChars and appends the suffix", () => {
    const out = truncateFindingBody("x".repeat(600), 500, "\n\n(full finding in the run records)");
    expect(out).toContain("x".repeat(500));
    expect(out).toContain("(full finding in the run records)");
    expect(out).not.toContain("x".repeat(600));
  });
});

describe("countSeverity", () => {
  it("groups findings by [BLOCKER], [MAJOR], and unlabelled", () => {
    expect(countSeverity(["[BLOCKER] crashes", "[MAJOR] edge case", "typo"])).toEqual({
      critical: 1,
      high: 1,
      minor: 1,
    });
  });

  it("matches severity labels case-insensitively and ignores surrounding space", () => {
    expect(countSeverity(["[blocker] a", "  [MAJOR] b  ", "[MAJOR] c"])).toEqual({
      critical: 1,
      high: 2,
      minor: 0,
    });
  });

  it("is all minor when no label is present", () => {
    expect(countSeverity(["plain", "x"])).toEqual({ critical: 0, high: 0, minor: 2 });
  });
});

describe("reviewSummary", () => {
  it("summarises severity counts", () => {
    expect(reviewSummary(["[BLOCKER] crash", "[MAJOR] edge", "typo"])).toBe(
      "3 issue(s) (1 critical, 1 high, 1 minor)",
    );
  });

  it("omits empty severity groups", () => {
    expect(reviewSummary(["[MAJOR] only"])).toBe("1 issue(s) (1 high)");
  });

  it("reports zero issues for an empty list", () => {
    expect(reviewSummary([])).toBe("0 issue(s)");
  });
});

describe("severityOf", () => {
  it("is 'blocker' when any [BLOCKER] is present, regardless of other findings", () => {
    expect(severityOf(["[BLOCKER] crash", "[MAJOR] edge", "polish"])).toBe("blocker");
    expect(severityOf(["[BLOCKER] only"])).toBe("blocker");
  });

  it("is 'major' when [MAJOR] is present but no [BLOCKER]", () => {
    expect(severityOf(["[MAJOR] edge case", "[MAJOR] another"])).toBe("major");
    expect(severityOf(["[MAJOR] a", "unlabelled note"])).toBe("major");
  });

  it("is 'minor' when no finding is labelled (empty or unlabelled prose only)", () => {
    expect(severityOf([])).toBe("minor");
    expect(severityOf(["some prose finding", "another note"])).toBe("minor");
  });

  it("matches severity labels case-insensitively", () => {
    expect(severityOf(["[blocker] x"])).toBe("blocker");
    expect(severityOf(["[Major] y"])).toBe("major");
  });
});

describe("classifySeverity — tolerant severity labels (#119)", () => {
  it("classifies the bracketed labels identically to the bare-word forms", () => {
    expect(classifySeverity("[BLOCKER] x")).toBe("blocker");
    expect(classifySeverity("[MAJOR] y")).toBe("major");
    expect(classifySeverity("BLOCKER 1 — x")).toBe("blocker");
    expect(classifySeverity("MAJOR 3 — y")).toBe("major");
  });

  it("classifies bulleted/bolded and colon-suffixed labels", () => {
    expect(classifySeverity("**Blocker:** x")).toBe("blocker");
    expect(classifySeverity("* Major * y")).toBe("major");
    expect(classifySeverity("Blocker: x")).toBe("blocker");
    expect(classifySeverity("Major — y")).toBe("major");
  });

  it("is case-insensitive and strips leading numbering/bullets before matching", () => {
    expect(classifySeverity("blocker x")).toBe("blocker");
    expect(classifySeverity("major y")).toBe("major");
    expect(classifySeverity("1. BLOCKER x")).toBe("blocker");
    expect(classifySeverity("- **Blocker:** x")).toBe("blocker");
  });

  it("returns minor for a finding whose severity word is not at its head", () => {
    expect(classifySeverity("the toolbar overlap is a blocker")).toBe("minor");
    expect(classifySeverity("plain prose")).toBe("minor");
    expect(classifySeverity("")).toBe("minor");
  });

  it("does not match a longer word that only contains the label", () => {
    expect(classifySeverity("blockers are fine")).toBe("minor");
    expect(classifySeverity("majority rules")).toBe("minor");
  });
});

describe("stripSeverityLabel (#119)", () => {
  it("removes a bracketed label and returns the body", () => {
    expect(stripSeverityLabel("[BLOCKER] the drift")).toBe("the drift");
    expect(stripSeverityLabel("[MAJOR] edge case")).toBe("edge case");
  });

  it("removes bare/numbered/bolded labels, leaving only the body", () => {
    expect(stripSeverityLabel("BLOCKER 1 — Playback controls overflow")).toBe("Playback controls overflow");
    expect(stripSeverityLabel("**Blocker:** rows drift")).toBe("rows drift");
    expect(stripSeverityLabel("* Major * onion skin")).toBe("onion skin");
  });

  it("returns an unlabelled finding trimmed and unchanged", () => {
    expect(stripSeverityLabel("  plain prose  ")).toBe("plain prose");
  });
});

describe("mentionsSeverityWord (#119)", () => {
  it("finds a severity word anywhere in the finding, case-insensitively", () => {
    expect(mentionsSeverityWord("the toolbar overlap is a BLOCKER")).toBe(true);
    expect(mentionsSeverityWord("a major gap remains")).toBe(true);
  });

  it("does not match when neither word appears (or only as a plural/embedded form)", () => {
    expect(mentionsSeverityWord("all good")).toBe(false);
    expect(mentionsSeverityWord("blockers are fine")).toBe(false);
  });
});

describe("promoteUnlabelledSeverity (#119)", () => {
  it("re-labels a finding whose text names blocker/major but carries no label", () => {
    expect(promoteUnlabelledSeverity(["the toolbar overlap is a blocker"])).toEqual([
      "[BLOCKER] the toolbar overlap is a blocker",
    ]);
  });

  it("leaves findings untouched when a recognized blocker already stands", () => {
    const findings = ["[BLOCKER] real", "the other gap is major"];
    expect(promoteUnlabelledSeverity(findings)).toBe(findings);
  });

  it("leaves a label-less, severity-word-less list unchanged by reference", () => {
    const findings = ["plain prose", "another note"];
    expect(promoteUnlabelledSeverity(findings)).toBe(findings);
  });
});

describe("countSeverity — tolerant labels (#119)", () => {
  it("counts mis-formatted labels as their severity tier", () => {
    expect(countSeverity(["BLOCKER 1 — x", "MAJOR 3 — y", "**Blocker:** z", "Major — w"])).toEqual({
      critical: 2,
      high: 2,
      minor: 0,
    });
  });

  it("leaves unlabelled prose as minor", () => {
    expect(countSeverity(["the toolbar overlap is a blocker"])).toEqual({ critical: 0, high: 0, minor: 1 });
  });
});

describe("severityOf — tolerant labels (#119)", () => {
  it("is blocker for a bare BLOCKER finding", () => {
    expect(severityOf(["BLOCKER 1 — playback controls overflow"])).toBe("blocker");
  });

  it("is major for a bare MAJOR finding", () => {
    expect(severityOf(["MAJOR 3 — onion-skin opacity double-scaled"])).toBe("major");
  });
});

describe("isBlocker — tolerant labels (#119)", () => {
  it("matches bare/bolded blocker forms and rejects major/prose", () => {
    expect(isBlocker("BLOCKER 1 — x")).toBe(true);
    expect(isBlocker("**Blocker:** x")).toBe(true);
    expect(isBlocker("MAJOR 3 — y")).toBe(false);
    expect(isBlocker("the toolbar overlap is a blocker")).toBe(false);
  });
});

describe("stripCompileClaimsWhenGreen", () => {
  // Regression for #1: a reviewer hallucinating a compile failure overrides
  // green verify evidence and burns the retry budget on a non-existent bug.
  // When verify passed, any finding that asserts a compile/build/typecheck
  // failure is dropped — the railhead already proved the code compiles.

  it("drops a [BLOCKER] that claims the code won't compile, when verify is green", () => {
    const findings = [
      "[BLOCKER] Projection::Orthographic(projection) will fail to compile",
      "[MAJOR] a real correctness gap",
    ];
    expect(stripCompileClaimsWhenGreen(findings, true)).toEqual(["[MAJOR] a real correctness gap"]);
  });

  it("keeps everything when verify is NOT green (a real compile failure survives)", () => {
    const findings = ["[BLOCKER] fails to compile", "[MAJOR] gap"];
    expect(stripCompileClaimsWhenGreen(findings, false)).toEqual(findings);
  });

  it("keeps findings that are about correctness, not compilation, even when green", () => {
    const findings = [
      "[BLOCKER] the paddle never moves because input is read from the wrong variable",
      "[MAJOR] scoring counts the wrong player",
    ];
    expect(stripCompileClaimsWhenGreen(findings, true)).toEqual(findings);
  });

  it("matches compile-claim phrases case-insensitively and in prose-wrapped form", () => {
    const findings = [
      "[BLOCKER] This change introduces a Compile Error in main.rs",
      "[BLOCKER] the code Will Not Compile as written",
      "[BLOCKER] won't compile because TextLayout was renamed",
      "[BLOCKER] fails to compile on line 42",
      "[BLOCKER] typecheck fails on the new signature",
    ];
    expect(stripCompileClaimsWhenGreen(findings, true)).toEqual([]);
  });

  it("ignores the word 'compile' when used in a non-failure context", () => {
    const findings = [
      "[BLOCKER] the runtime compiles shaders lazily and this leaks them",
      "[MAJOR] refactor compiles but the behaviour is wrong",
    ];
    expect(stripCompileClaimsWhenGreen(findings, true)).toEqual(findings);
  });

  it("returns [] unchanged for an empty findings list", () => {
    expect(stripCompileClaimsWhenGreen([], true)).toEqual([]);
    expect(stripCompileClaimsWhenGreen([], false)).toEqual([]);
  });

  it("preserves the relative order of surviving findings", () => {
    const findings = [
      "[BLOCKER] fails to compile",
      "[MAJOR] first real",
      "[BLOCKER] won't compile",
      "[MAJOR] second real",
    ];
    expect(stripCompileClaimsWhenGreen(findings, true)).toEqual(["[MAJOR] first real", "[MAJOR] second real"]);
  });
});

describe("changedPathsFromDiff (#94)", () => {
  it("extracts the changed source paths from +++ hunk headers, de-duplicated", () => {
    const diff = [
      "diff --git a/src/index.js b/src/index.js",
      "new file mode 100644",
      "index 0000000..e69de29",
      "--- /dev/null",
      "+++ b/src/index.js",
      "@@ -0,0 +1,3 @@",
      "+export const x = 1;",
      "diff --git a/src/util/score.ts b/src/util/score.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/util/score.ts",
      "+++ b/src/util/score.ts",
      "@@ -5,7 +5,7 @@",
      "+return n;",
    ].join("\n");
    expect(changedPathsFromDiff(diff)).toEqual(["src/index.js", "src/util/score.ts"]);
  });

  it("reads only the +++ b/ side — --- a/ lines and index lines never anchor a finding", () => {
    const diff = [
      "diff --git a/src/index.js b/src/index.js",
      "index 0000000..e69de29 100644",
      "--- a/src/index.js",
      "+++ b/src/index.js",
      "@@ -1 +1 @@",
      "+export const x = 1;",
    ].join("\n");
    expect(changedPathsFromDiff(diff)).toEqual(["src/index.js"]);
  });

  it("skips a pure deletion (+++ /dev/null carries no path)", () => {
    const diff = [
      "diff --git a/src/old.js b/src/old.js",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "--- a/src/old.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const x = 1;",
    ].join("\n");
    expect(changedPathsFromDiff(diff)).toEqual([]);
  });

  it("returns [] for an empty diff or one with no +++ b/ headers", () => {
    expect(changedPathsFromDiff("")).toEqual([]);
    expect(changedPathsFromDiff("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ /dev/null")).toEqual([]);
  });

  it("reads only +++ headers — a content line carries its own + prefix, so one starting '+++ b/' in the file appears as '++++ b/' and is not read as a header", () => {
    const diff = [
      "diff --git a/src/a.js b/src/a.js",
      "+++ b/src/a.js",
      "@@ -1 +1 @@",
      "++++ b/not-a-header.js   <- added content that literally starts with '+++ b/'",
    ].join("\n");
    expect(changedPathsFromDiff(diff)).toEqual(["src/a.js"]);
  });
});

describe("downgradeUnanchoredBlockers (#94)", () => {
  const anchors = ["src/ui.ts", "src/index.js"];

  it("keeps a [BLOCKER] that names an allowed path (or path:line) a blocker", () => {
    const findings = [
      "[BLOCKER] src/ui.ts:41 crashes on first render",
      "[BLOCKER] the breakage is in src/index.js",
    ];
    expect(downgradeUnanchoredBlockers(findings, anchors)).toEqual({ findings, downgraded: 0 });
  });

  it("downgrades a [BLOCKER] naming no allowed path to [MAJOR], preserving the finding text", () => {
    const findings = ["[BLOCKER] the whole approach is wrong and must be redone"];
    expect(downgradeUnanchoredBlockers(findings, anchors)).toEqual({
      findings: ["[MAJOR] the whole approach is wrong and must be redone"],
      downgraded: 1,
    });
  });

  it("treats a prose-wrapped anchor as an anchor", () => {
    const findings = ['[BLOCKER] the bug in src/ui.ts:41 appears only after focus loss'];
    expect(downgradeUnanchoredBlockers(findings, anchors).downgraded).toBe(0);
  });

  it("anchors when any one of several referenced paths is a member", () => {
    const findings = ["[BLOCKER] src/other.ts and src/ui.ts both need the same guard"];
    const notMember = ["[BLOCKER] src/a.ts and src/b.ts are both broken"];
    expect(downgradeUnanchoredBlockers(findings, anchors).downgraded).toBe(0);
    expect(downgradeUnanchoredBlockers(notMember, anchors).downgraded).toBe(1);
  });

  it("anchors when a read-mode files-list entry (not in the diff) is referenced — the membership is the same", () => {
    // A read-mode reviewer may anchor on an unchanged call site it read; the
    // railhead passes the files list into allowedAnchors, so membership is all
    // that distinguishes it from a diff path — test that membership wins.
    const readFiles = anchors.concat(["src/main.ts"]);
    expect(downgradeUnanchoredBlockers(["[BLOCKER] src/main.ts:7 calls into removed code"], readFiles).downgraded).toBe(0);
    expect(downgradeUnanchoredBlockers(["[BLOCKER] src/main.ts:7 calls into removed code"], anchors).downgraded).toBe(1);
  });

  it("does not treat a longer path that merely contains an anchor as an anchor", () => {
    const findings = ["[BLOCKER] src/ui.tsx layout is wrong", "[BLOCKER] src/ui.ts.new is stale"];
    expect(downgradeUnanchoredBlockers(findings, anchors)).toEqual({
      findings: ["[MAJOR] src/ui.tsx layout is wrong", "[MAJOR] src/ui.ts.new is stale"],
      downgraded: 2,
    });
  });

  it("matches severity labels case-insensitively", () => {
    expect(downgradeUnanchoredBlockers(["[blocker] unanchored claim"], anchors)).toEqual({
      findings: ["[MAJOR] unanchored claim"],
      downgraded: 1,
    });
  });

  it("leaves [MAJOR] and unlabelled findings untouched", () => {
    const findings = ["[MAJOR] real gap", "unlabelled prose", "[BLOCKER] wild claim"];
    expect(downgradeUnanchoredBlockers(findings, anchors)).toEqual({
      findings: ["[MAJOR] real gap", "unlabelled prose", "[MAJOR] wild claim"],
      downgraded: 1,
    });
  });

  it("preserves the order of surviving findings", () => {
    const findings = ["[BLOCKER] a", "[MAJOR] b", "[BLOCKER] c", "[MAJOR] d"];
    expect(downgradeUnanchoredBlockers(findings, []).findings).toEqual([
      "[MAJOR] a",
      "[MAJOR] b",
      "[MAJOR] c",
      "[MAJOR] d",
    ]);
  });

  it("downgrades every blocker when there are no anchors at all", () => {
    expect(downgradeUnanchoredBlockers(["[BLOCKER] a", "[BLOCKER] b"], [])).toEqual({
      findings: ["[MAJOR] a", "[MAJOR] b"],
      downgraded: 2,
    });
  });

  it("downgrades a bare-word blocker form into a bracketed [MAJOR] (#119)", () => {
    expect(downgradeUnanchoredBlockers(["BLOCKER 1 — the toolbar overflows"], [])).toEqual({
      findings: ["[MAJOR] the toolbar overflows"],
      downgraded: 1,
    });
  });
});

describe("normalizeState", () => {
  it("backfills missing review fields on tickets from an older ledger", () => {
    const old = {
      tickets: [{ number: "02", reviews: undefined, review_ok: undefined, review_attempts: undefined }],
    } as unknown as RunState;
    const norm = normalizeState(old);
    expect(norm.tickets[0].reviews).toEqual([]);
    expect(norm.tickets[0].review_ok).toBeNull();
    expect(norm.tickets[0].review_attempts).toBe(0);
  });

  it("backfills missing goal_reviews array from an older ledger (#19)", () => {
    const old = { tickets: [] } as unknown as RunState;
    const norm = normalizeState(old);
    expect(norm.goal_reviews).toEqual([]);
  });

  it("preserves existing goal_reviews through normalization (#19)", () => {
    const reviews = [{ group: "core", round: 0, verdict: "pass", findings: [] }];
    const old = { tickets: [], goal_reviews: reviews } as unknown as RunState;
    const norm = normalizeState(old);
    expect(norm.goal_reviews).toEqual(reviews);
  });
});

describe("extractAssistantText", () => {
  it("concatenates text parts in order", async () => {
    const { dir, phase } = await makeLedger([
      `{"type":"step_start","part":{}}`,
      `{"type":"text","part":{"type":"text","text":"first"}}`,
      `{"type":"text","part":{"type":"text","text":"second"}}`,
    ]);
    expect(await extractAssistantText(dir, phase)).toBe("first\nsecond");
  });

  it("skips non-text events", async () => {
    const { dir, phase } = await makeLedger([
      `{"type":"tool_use","part":{"type":"tool","tool":"bash"}}`,
      `{"type":"text","part":{"type":"text","text":"only text"}}`,
    ]);
    expect(await extractAssistantText(dir, phase)).toBe("only text");
  });

  it("ignores malformed JSON lines", async () => {
    const { dir, phase } = await makeLedger([
      "this is not json",
      `{"type":"text","part":{"type":"text","text":"recovered"}}`,
    ]);
    expect(await extractAssistantText(dir, phase)).toBe("recovered");
  });

  it("returns empty string when the phase file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rv-"));
    dirs.push(dir);
    expect(await extractAssistantText(dir, "nope")).toBe("");
  });

  it("recovers content from a rejected write tool call (model emitted the plan as a write instead of as text)", async () => {
    const eventRejectedWrite = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: {
          status: "error",
          input: { filePath: "/tmp/plan.json", content: "the plan content the model tried to write" },
          error: "The user rejected permission to use this specific tool call.",
        },
      },
    });
    const { dir, phase } = await makeLedger([eventRejectedWrite]);
    expect(await extractAssistantText(dir, phase)).toBe("the plan content the model tried to write");
  });

  it("ignores content from a successful write tool call (that content lives in a file, not the transcript)", async () => {
    const eventOkWrite = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: { status: "completed", input: { filePath: "src/x.ts", content: "file body" } },
      },
    });
    const { dir, phase } = await makeLedger([
      eventOkWrite,
      `{"type":"text","part":{"type":"text","text":"assistant prose"}}`,
    ]);
    expect(await extractAssistantText(dir, phase)).toBe("assistant prose");
  });

  it("ignores a write tool call with no content field", async () => {
    const eventNoContent = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: { status: "error", input: { filePath: "/tmp/x" }, error: "rejected" },
      },
    });
    const { dir, phase } = await makeLedger([eventNoContent]);
    expect(await extractAssistantText(dir, phase)).toBe("");
  });

  it("recovers a plan emitted through a bash cat heredoc instead of assistant text", async () => {
    const eventCatHeredoc = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: { status: "completed", input: { command: "cat << 'ENDOFPLAN'\n$VERIFY\nnpm test\n$TICKETS\n[{\"title\":\"x\",\"what\":\"w\",\"criteria\":[],\"blocked_by\":[]}]\nENDOFPLAN" } },
      },
    });
    const { dir, phase } = await makeLedger([
      eventCatHeredoc,
      `{"type":"text","part":{"type":"text","text":"The plan is complete."}}`,
    ]);
    const text = await extractAssistantText(dir, phase);
    expect(text).toContain("$TICKETS");
    expect(text).toContain('"title":"x"');
    expect(text).toContain("The plan is complete.");
  });

  it("ignores a bash cat heredoc redirected to a real file", async () => {
    const eventCatToFile = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: { status: "completed", input: { command: "cat > src/x.ts << 'EOF'\nfile body\nEOF" } },
      },
    });
    const { dir, phase } = await makeLedger([
      eventCatToFile,
      `{"type":"text","part":{"type":"text","text":"assistant prose"}}`,
    ]);
    expect(await extractAssistantText(dir, phase)).toBe("assistant prose");
  });
});

describe("extractPlanText", () => {
  it("recovers a plan emitted through a successful write tool call (the spriteforge repair shape)", async () => {
    const eventSuccessfulWrite = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: { status: "completed", input: { filePath: "plan.json", content: '[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]' } },
      },
    });
    const { dir, phase } = await makeLedger([
      eventSuccessfulWrite,
      `{"type":"text","part":{"type":"text","text":"All findings have been fixed."}}`,
    ]);
    const text = await extractPlanText(dir, phase);
    expect(text).toContain('"title":"x"');
    expect(text).toContain("All findings have been fixed.");
  });

  it("extractAssistantText still excludes a successful write (source-file content lives on disk)", async () => {
    const eventSuccessfulWrite = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: { status: "completed", input: { filePath: "src/x.ts", content: "export const x = 1;" } },
      },
    });
    const { dir, phase } = await makeLedger([
      eventSuccessfulWrite,
      `{"type":"text","part":{"type":"text","text":"assistant prose"}}`,
    ]);
    expect(await extractAssistantText(dir, phase)).toBe("assistant prose");
  });
});

describe("review", () => {
  // A fake `opencode` binary on PATH that echoes its own last argv (the
  // prompt) back as a text event, so the test can assert on what `review()`
  // actually sent — the same technique executor.test.ts uses to avoid a real
  // opencode/model dependency.
  async function makeFakeOpencodeEcho(): Promise<{ cwd: string; ledgerDir: string; restorePath: string }> {
    const base = await mkdtemp(join(tmpdir(), "rv-exec-"));
    const binDir = join(base, "bin");
    const ledgerDir = join(base, "ledger");
    await mkdir(binDir, { recursive: true });
    await mkdir(join(ledgerDir, "events"), { recursive: true });
    const script = join(binDir, "opencode");
    // $* is the whole invocation ("run --format json ... <prompt>"); echoing
    // it back as a JSON text event lets the test grep the transcript for
    // whatever review() actually built into the prompt.
    await writeFile(
      script,
      `#!/bin/sh
node -e 'console.log(JSON.stringify({type:"text",part:{type:"text",text:process.argv.slice(1).join(" ")}}))' "$@"
`,
      "utf8",
    );
    await chmod(script, 0o755);
    const restorePath = process.env.PATH ?? "";
    process.env.PATH = binDir + ":" + restorePath;
    return { cwd: base, ledgerDir, restorePath };
  }

  /** A fake `opencode` that exits non-zero without emitting a verdict — the
   * "invocation did not complete" shape that used to be logged as a pass. */
  async function makeFakeOpencodeExit(code: number): Promise<{ cwd: string; ledgerDir: string; restorePath: string }> {
    const base = await mkdtemp(join(tmpdir(), "rv-exec-"));
    const binDir = join(base, "bin");
    const ledgerDir = join(base, "ledger");
    await mkdir(binDir, { recursive: true });
    await mkdir(join(ledgerDir, "events"), { recursive: true });
    const script = join(binDir, "opencode");
    await writeFile(script, `#!/bin/sh\nexit ${code}\n`, "utf8");
    await chmod(script, 0o755);
    const restorePath = process.env.PATH ?? "";
    process.env.PATH = binDir + ":" + restorePath;
    return { cwd: base, ledgerDir, restorePath };
  }

  it("throws (infra) when the reviewer exits non-ok — a pass is impossible without a transcript (v2 issue 01, ADR 0050)", async () => {
    const env = await makeFakeOpencodeExit(1);
    try {
      await expect(review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-01-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff: "diff --git a/x b/x",
      })).rejects.toThrow(/reviewer/i);
    } finally {
      process.env.PATH = env.restorePath;
    }
  });

  it("forwards the contracts slice into the executed reviewer prompt", async () => {    const env = await makeFakeOpencodeEcho();
    try {
      const outcome = await review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-01-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff: "diff --git a/x b/x",
        contracts: {
          schema_version: 1,
          entries: [{ symbol: "greet", kind: "function", file: "src/index.js", signature: "greet(name) -> string" }],
        },
      });
      expect(outcome.transcript).toContain("EXISTING PUBLIC CONTRACTS");
      expect(outcome.transcript).toContain("greet(name)");
    } finally {
      process.env.PATH = env.restorePath;
    }
  });

  it("runs on the tool-bearing observe seat when the review inherits tools, and on the isolated reviewer otherwise (code_review.inherit_tools)", async () => {
    const env = await makeFakeOpencodeEcho();
    try {
      const inherited = await review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-01-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff: "diff --git a/x b/x",
        inheritTools: true,
      });
      expect(inherited.transcript).toMatch(/--agent railhead-observe\b/);

      const restricted = await review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-02-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff: "diff --git a/x b/x",
      });
      expect(restricted.transcript).toMatch(/--agent railhead-review\b/);
      expect(restricted.transcript).not.toMatch(/--agent railhead-observe\b/);
    } finally {
      process.env.PATH = env.restorePath;
    }
  });

  it("writes the diff to a ledger file and hands the reviewer a path+stat when diffFile is set (#46)", async () => {
    const env = await makeFakeOpencodeEcho();
    try {
      const diff = "diff --git a/src/big.ts b/src/big.ts\n+export const line = " + JSON.stringify("x".repeat(2000)) + ";";
      const diffPath = join(env.ledgerDir, "events", "01-01-review.diff");
      const outcome = await review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-01-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff,
        diffStat: " src/big.ts | 1 +\n 1 file changed, 1 insertion(+)",
        diffFile: diffPath,
      });
      expect(outcome.transcript).toContain(diffPath);
      expect(outcome.transcript).toContain("1 file changed, 1 insertion(+)");
      expect(outcome.transcript).not.toContain(diff);
      const written = await readFile(diffPath, "utf8");
      expect(written).toBe(diff);
    } finally {
      process.env.PATH = env.restorePath;
    }
  });

  it("inlines the diff body when diffFile is absent (#46 — back-compat)", async () => {
    const env = await makeFakeOpencodeEcho();
    try {
      const diff = "diff --git a/x b/x\n+small";
      const outcome = await review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-01-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff,
      });
      expect(outcome.transcript).toContain(diff);
    } finally {
      process.env.PATH = env.restorePath;
    }
  });

  // A fake `opencode` binary that replies with a fixed transcript, for
  // testing how review() slices a realistic, fully-shaped response.
  async function makeFakeOpencodeStatic(text: string): Promise<{ cwd: string; ledgerDir: string; restorePath: string }> {
    const base = await mkdtemp(join(tmpdir(), "rv-exec-"));
    const binDir = join(base, "bin");
    const ledgerDir = join(base, "ledger");
    await mkdir(binDir, { recursive: true });
    await mkdir(join(ledgerDir, "events"), { recursive: true });
    const script = join(binDir, "opencode");
    await writeFile(
      script,
      `#!/bin/sh
node -e 'console.log(JSON.stringify({type:"text",part:{type:"text",text:${JSON.stringify(text)}}}))'
`,
      "utf8",
    );
    await chmod(script, 0o755);
    const restorePath = process.env.PATH ?? "";
    process.env.PATH = binDir + ":" + restorePath;
    return { cwd: base, ledgerDir, restorePath };
  }

  it("does not let the $NITS section's own marker text leak into $BLOCKING findings", async () => {
    // Regression test: the prompt's own mandated shape nests $NITS between
    // $BLOCKING and $OK ($BLOCKING ... $NITS ... $OK ...). A reviewer that
    // dutifully follows the format — as every real one does — used to have
    // its literal "$NITS\nNONE" text swallowed into the blocking slice,
    // polluting mustFix with two junk "findings" on every normal response.
    const env = await makeFakeOpencodeStatic(
      "$BLOCKING\n[BLOCKER] missing edge case\n$NITS\nNONE\n$OK\nneeds fix",
    );
    try {
      const outcome = await review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-01-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff: "diff --git a/x b/x",
      });
      expect(outcome.mustFix).toEqual(["[BLOCKER] missing edge case"]);
      expect(outcome.nits).toEqual([]);
    } finally {
      process.env.PATH = env.restorePath;
    }
  });

  it("still extracts nits correctly when both sections have real content", async () => {
    const env = await makeFakeOpencodeStatic(
      "$BLOCKING\n[MAJOR] edge case\n$NITS\nunused import\n$OK\nmostly fine",
    );
    try {
      const outcome = await review({
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "01-01-review",
        model: null,
        ticketFile: "01-a.md",
        ticketBody: "work",
        criteria: ["c1"],
        diff: "d",
      });
      expect(outcome.mustFix).toEqual(["[MAJOR] edge case"]);
      expect(outcome.nits).toEqual(["unused import"]);
      expect(outcome.ok).toBe("mostly fine");
    } finally {
      process.env.PATH = env.restorePath;
    }
  });
});
describe("stripCompileClaimsWhenGreen — failure-noun shapes (#135)", () => {
  it("drops compile/build FAILURE phrasings that green verify refutes", () => {
    const findings = [
      '[BLOCKER] src/shell.rs:11 EventLoop::with_user_event() requires crate feature "tracing" to be enabled, causing compilation failure',
      "[BLOCKER] compile failure in main.rs",
      "[BLOCKER] the crate fails to build with this dependency set",
      "[BLOCKER] the workspace failed to build",
      "[BLOCKER] it won't build as written",
    ];
    expect(stripCompileClaimsWhenGreen(findings, true)).toEqual([]);
    expect(stripCompileClaimsWhenGreen(findings, false)).toEqual(findings);
  });
});
