import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLearnings,
  appendLearnings,
  writeLearnings,
  evictOldestToFit,
  wouldExceedBudget,
  buildConsolidationPrompt,
  readLearnedMarkers,
  readRetractedMarkers,
  suppressRetracted,
  learningsPath,
  extractFailureLearning,
  pushLearnings,
  mineFailureLearning,
  LEARNINGS_CHAR_LIMIT,
  LEARNED_MARKER,
  RETRACTED_MARKER,
} from "./learnings.ts";

vi.mock("../execute/executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execute/executor.ts")>();
  return { ...actual, executeOpendCode: vi.fn() };
});

import { executeOpendCode } from "../execute/executor.ts";
import { appendEvent, initLedger } from "../core/ledger.ts";
import { createRunState } from "../core/state.ts";
import { DEFAULT_CONFIG } from "../config/config.ts";
import type { RunState } from "../core/state.ts";

describe("learningsPath", () => {
  it("places the file under .railhead/", () => {
    expect(learningsPath("/proj")).toBe("/proj/.railhead/learnings.md");
  });
});

describe("readLearnings", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "learn-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", async () => {
    expect(await readLearnings(cwd)).toBeNull();
  });

  it("returns null when the file is empty or whitespace-only", async () => {
    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(learningsPath(cwd), "   \n\n  \n");
    expect(await readLearnings(cwd)).toBeNull();
  });

  it("returns the trimmed content when the file has learnings", async () => {
    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(learningsPath(cwd), "screencapture -x gives raw PNG\nnpm run dev serves on 5173\n");
    const content = await readLearnings(cwd);
    expect(content).toBe("screencapture -x gives raw PNG\nnpm run dev serves on 5173");
  });
});

describe("appendLearnings", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "learn-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("creates the file when it does not exist", async () => {
    await appendLearnings(cwd, "first learning");
    const content = await readFile(learningsPath(cwd), "utf8");
    expect(content).toBe("first learning\n");
  });

  it("appends to existing learnings on a new line", async () => {
    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(learningsPath(cwd), "first\n");
    await appendLearnings(cwd, "second");
    const content = await readFile(learningsPath(cwd), "utf8");
    expect(content).toBe("first\nsecond\n");
  });

  it("trims whitespace from the new learnings", async () => {
    await appendLearnings(cwd, "  spaced learning  \n\n");
    const content = await readFile(learningsPath(cwd), "utf8");
    expect(content).toBe("spaced learning\n");
  });

  it("can append multiple times accumulating lines", async () => {
    await appendLearnings(cwd, "one");
    await appendLearnings(cwd, "two");
    await appendLearnings(cwd, "three");
    const content = await readFile(learningsPath(cwd), "utf8");
    expect(content).toBe("one\ntwo\nthree\n");
  });

  it("issue #68: enforces the char budget itself by evicting the OLDEST lines (no model needed)", async () => {
    // model.extract: null configs previously grew learnings.md unbounded —
    // appendLearnings trusted the caller, and the caller's budget check sat
    // behind extract !== null. Now appendLearnings bounds the file itself.
    const big = "a".repeat(LEARNINGS_CHAR_LIMIT);
    await appendLearnings(cwd, big);
    await appendLearnings(cwd, "newest fact");
    const content = await readFile(learningsPath(cwd), "utf8");
    expect(content.length).toBeLessThanOrEqual(LEARNINGS_CHAR_LIMIT + 1);
    // The newest learning survives; the oversized oldest line was evicted.
    expect(content).toContain("newest fact");
    expect(content).not.toContain(big);
  });

  it("issue #68: evictOldestToFit drops oldest lines and keeps newest under the limit", () => {
    const content = ["oldest", "middle", "newest"].map((l) => l.repeat(100)).join("\n");
    const fitted = evictOldestToFit(content, 250);
    expect(fitted.length).toBeLessThanOrEqual(250);
    expect(fitted).toContain("newest");
    expect(fitted).not.toContain("oldest");
  });

  it("issue #68: evictOldestToFit leaves already-fitting content untouched", () => {
    expect(evictOldestToFit("a\nb", 10)).toBe("a\nb");
  });
});

describe("writeLearnings", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "learn-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("overwrites the entire file", async () => {
    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(learningsPath(cwd), "old\nstale\n");
    await writeLearnings(cwd, "consolidated");
    const content = await readFile(learningsPath(cwd), "utf8");
    expect(content).toBe("consolidated\n");
  });

  it("trims trailing whitespace", async () => {
    await writeLearnings(cwd, "fact\n  ");
    const content = await readFile(learningsPath(cwd), "utf8");
    expect(content).toBe("fact\n");
  });
});

describe("wouldExceedBudget", () => {
  it("returns false when there is no existing content", () => {
    expect(wouldExceedBudget(null, 100)).toBe(false);
  });

  it("returns false when the combined size is under the limit", () => {
    expect(wouldExceedBudget("a".repeat(1000), 100)).toBe(false);
  });

  it("returns true when the combined size exceeds the limit", () => {
    expect(wouldExceedBudget("a".repeat(LEARNINGS_CHAR_LIMIT - 50), 100)).toBe(true);
  });

  it("returns false at exactly the limit", () => {
    expect(wouldExceedBudget("a".repeat(LEARNINGS_CHAR_LIMIT - 1), 1)).toBe(false);
  });
});

describe("buildConsolidationPrompt", () => {
  it("includes both existing and new learnings", () => {
    const prompt = buildConsolidationPrompt("old fact", "new fact");
    expect(prompt).toContain("old fact");
    expect(prompt).toContain("new fact");
  });

  it("mentions the char budget", () => {
    const prompt = buildConsolidationPrompt("old", "new");
    expect(prompt).toContain("2,200");
  });

  it("asks for the full merged file as output", () => {
    const prompt = buildConsolidationPrompt("old", "new");
    expect(prompt).toContain("full merged file");
  });
});

describe("readLearnedMarkers", () => {
  it("returns null when the transcript contains no marker", () => {
    expect(readLearnedMarkers("noise\nmore noise\nno facts here")).toBeNull();
  });

  it("returns null when the worker emitted LEARNED: NONE", () => {
    expect(readLearnedMarkers("did some work\nLEARNED: NONE\nDONE src/x.ts")).toBeNull();
  });

  it("returns null when the worker emitted LEARNED: with nothing after the colon", () => {
    expect(readLearnedMarkers("LEARNED:\nDONE x.ts")).toBeNull();
  });

  it("extracts a single fact after the marker", () => {
    expect(readLearnedMarkers("LEARNED: cargo run panics without a TTY on this project")).toBe(
      "cargo run panics without a TTY on this project",
    );
  });

  it("extracts each marker line, preserving order", () => {
    const transcript = [
      "running...",
      "LEARNED: screencapture -x gives raw PNG without cursor on macOS",
      "more narration",
      "LEARNED: npm run dev serves on port 5173, not 3000",
      "DONE src/x.ts src/y.ts",
    ].join("\n");
    expect(readLearnedMarkers(transcript)).toBe(
      "screencapture -x gives raw PNG without cursor on macOS\nnpm run dev serves on port 5173, not 3000",
    );
  });

  it("deduplicates identical facts across the transcript", () => {
    const transcript = `LEARNED: same fact twice
LEARNED: same fact twice`;
    expect(readLearnedMarkers(transcript)).toBe("same fact twice");
  });

  it("ignores the marker in the middle of a prose sentence (not at line start)", () => {
    const transcript = "I decided to LEARNED: cargo runs fine but I kept going anyway.";
    expect(readLearnedMarkers(transcript)).toBeNull();
  });

  it("ignores lowercase marker (the prompt specifies uppercase; lower is prose)", () => {
    expect(readLearnedMarkers("learned: some fact here")).toBeNull();
  });

  it("tolerates leading whitespace before the marker", () => {
    expect(readLearnedMarkers("   LEARNED: indented fact")).toBe("indented fact");
  });

  it("tolerates multiple spaces between marker and fact", () => {
    expect(readLearnedMarkers("LEARNED:    spaced fact")).toBe("spaced fact");
  });

  it("is case-insensitive about the NONE sentinel but not the fact text", () => {
    expect(readLearnedMarkers("LEARNED: none")).toBeNull();
    expect(readLearnedMarkers("LEARNED: None")).toBeNull();
    expect(readLearnedMarkers("LEARNED: nOne")).toBeNull();
    expect(readLearnedMarkers("LEARNED: nothing was learned here")).toBe(
      "nothing was learned here",
    );
  });

  it("preserves the marker text exactly, including commas and special chars", () => {
    const fact = "cargo run panics without a TTY; use `cargo build` + direct binary run instead";
    expect(readLearnedMarkers(`LEARNED: ${fact}`)).toBe(fact);
  });

  it("handles empty transcript gracefully", () => {
    expect(readLearnedMarkers("")).toBeNull();
  });

  it("handles whitespace-only transcript gracefully", () => {
    expect(readLearnedMarkers("   \n  \n")).toBeNull();
  });

  it("mixes NONE lines with real facts, keeping only the real ones", () => {
    const transcript = [
      "LEARNED: NONE",
      "LEARNED: a real fact",
      "LEARNED:",
      "LEARNED: another real fact",
    ].join("\n");
    expect(readLearnedMarkers(transcript)).toBe("a real fact\nanother real fact");
  });

  it("does not register a LEARNED: echo quoted inside a code fence (#108)", () => {
    const transcript = "the format is:\n```\nLEARNED: cargo run panics without a TTY\n```\nLEARNED: screencapture -x gives raw PNG";
    expect(readLearnedMarkers(transcript)).toBe("screencapture -x gives raw PNG");
  });

  it("registers nothing when the only LEARNED: is fenced (#108)", () => {
    expect(readLearnedMarkers("```\nLEARNED: not real\n```")).toBeNull();
  });
});

describe("readRetractedMarkers", () => {
  it("returns null when the transcript contains no retraction marker", () => {
    expect(readRetractedMarkers("noise\nLEARNED: a fact\nmore noise")).toBeNull();
  });

  it("returns null when the transcript emits RETRACTED: NONE", () => {
    expect(readRetractedMarkers("RETRACTED: NONE\nDONE x.ts")).toBeNull();
  });

  it("returns null when the transcript emits RETRACTED: with nothing after the colon", () => {
    expect(readRetractedMarkers("RETRACTED:\nDONE x.ts")).toBeNull();
  });

  it("extracts a single retraction after the marker", () => {
    expect(readRetractedMarkers("RETRACTED: this model cannot read image attachments")).toBe(
      "this model cannot read image attachments",
    );
  });

  it("extracts each retraction line, preserving order", () => {
    const transcript = [
      "running...",
      "RETRACTED: screenshots are useless for visual verification",
      "more narration",
      "RETRACTED: cargo run panics without a TTY on this project",
      "DONE src/x.ts",
    ].join("\n");
    expect(readRetractedMarkers(transcript)).toBe(
      "screenshots are useless for visual verification\ncargo run panics without a TTY on this project",
    );
  });

  it("deduplicates identical retractions", () => {
    const transcript = "RETRACTED: same fact twice\nRETRACTED: same fact twice";
    expect(readRetractedMarkers(transcript)).toBe("same fact twice");
  });

  it("ignores the marker mid-sentence (not at line start)", () => {
    expect(readRetractedMarkers("I decided to RETRACTED: cargo runs fine but kept going")).toBeNull();
  });

  it("ignores lowercase marker (the prompt specifies uppercase; lower is prose)", () => {
    expect(readRetractedMarkers("retracted: some fact here")).toBeNull();
  });

  it("tolerates leading whitespace before the marker", () => {
    expect(readRetractedMarkers("   RETRACTED: indented fact")).toBe("indented fact");
  });

  it("tolerates multiple spaces between marker and fact", () => {
    expect(readRetractedMarkers("RETRACTED:    spaced fact")).toBe("spaced fact");
  });

  it("is case-insensitive about the NONE sentinel but not the fact text", () => {
    expect(readRetractedMarkers("RETRACTED: none")).toBeNull();
    expect(readRetractedMarkers("RETRACTED: None")).toBeNull();
    expect(readRetractedMarkers("RETRACTED: nOne")).toBeNull();
    expect(readRetractedMarkers("RETRACTED: nothing was retracted here")).toBe(
      "nothing was retracted here",
    );
  });

  it("handles empty transcript gracefully", () => {
    expect(readRetractedMarkers("")).toBeNull();
  });

  it("handles whitespace-only transcript gracefully", () => {
    expect(readRetractedMarkers("   \n  \n")).toBeNull();
  });

  it("mixes NONE lines with real retractions, keeping only the real ones", () => {
    const transcript = [
      "RETRACTED: NONE",
      "RETRACTED: a real retraction",
      "RETRACTED:",
      "RETRACTED: another real retraction",
    ].join("\n");
    expect(readRetractedMarkers(transcript)).toBe("a real retraction\nanother real retraction");
  });
});

describe("suppressRetracted", () => {
  it("returns the content unchanged when no retractions are given", () => {
    const content = "fact one\nfact two\nfact three";
    expect(suppressRetracted(content, null)).toBe(content);
  });

  it("returns the content unchanged when retractions is an empty string", () => {
    const content = "fact one\nfact two";
    expect(suppressRetracted(content, "")).toBe(content);
  });

  it("removes a line that matches a retraction exactly", () => {
    const content = "fact one\nthis model cannot read images\nfact three";
    expect(suppressRetracted(content, "this model cannot read images")).toBe("fact one\nfact three");
  });

  it("removes multiple lines matching multiple retractions", () => {
    const content = "keep this\nscreenshots are useless\nkeep this too\ncargo panics without TTY";
    expect(suppressRetracted(content, "screenshots are useless\ncargo panics without TTY")).toBe(
      "keep this\nkeep this too",
    );
  });

  it("removes a line that contains the retraction as a substring (a learning line is longer than the retraction trigger)", () => {
    const content = "screencapture -x gives raw PNG on macOS\nkeep this";
    expect(suppressRetracted(content, "screencapture -x gives raw PNG")).toBe("keep this");
  });

  it("does not remove lines that merely share words with a retraction", () => {
    const content = "the model is a vision model\nthe model is fast";
    expect(suppressRetracted(content, "the model cannot read images")).toBe(
      "the model is a vision model\nthe model is fast",
    );
  });

  it("is case-insensitive when matching a retraction to a learning line", () => {
    const content = "This Model Cannot Read Images\nkeep this";
    expect(suppressRetracted(content, "this model cannot read images")).toBe("keep this");
  });

  it("returns null when all lines are retracted (the file becomes empty)", () => {
    expect(suppressRetracted("only fact\nsecond fact", "only fact\nsecond fact")).toBeNull();
  });

  it("preserves the order of surviving lines", () => {
    const content = "a\nb\nc\nd\ne";
    expect(suppressRetracted(content, "b\nd")).toBe("a\nc\ne");
  });

  it("does not mutate the input content string", () => {
    const content = "fact one\nfact two";
    const snapshot = content;
    suppressRetracted(content, "fact one");
    expect(content).toBe(snapshot);
  });

  it("matches a retraction even when the learning has extra punctuation/backticks (platformer incident)", () => {
    // The real failure: learning was `deepseek-v4-flash cannot read `screenshots``
    // (with backticks around `screenshots`), retraction was without backticks.
    // The 1-char difference defeated the substring match.
    const content = "deepseek-v4-flash cannot read `screenshots`\nkeep this";
    expect(suppressRetracted(content, "deepseek-v4-flash cannot read screenshots")).toBe("keep this");
  });

  it("matches a retraction when the learning has trailing punctuation the retraction lacks", () => {
    const content = "cargo run panics without a TTY.\nkeep this";
    expect(suppressRetracted(content, "cargo run panics without a TTY")).toBe("keep this");
  });

  it("matches a retraction with different hyphenation/spacing", () => {
    const content = "the opencode serve worker is flaky\nkeep this";
    expect(suppressRetracted(content, "the opencode-serve worker is  flaky")).toBe("keep this");
  });

  it("still does NOT match lines that only share alphanumeric words", () => {
    const content = "the model is a vision model";
    expect(suppressRetracted(content, "the model cannot read screenshots")).toBe(
      "the model is a vision model",
    );
  });
});

describe("extractFailureLearning (#42)", () => {
  it("extracts the error line from a verify failure", () => {
    const result = extractFailureLearning({
      verifyOutput: "$ npm run build\nsrc/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n  at Object.<anonymous> (...)",
    });
    expect(result).toBe("Verify failed: src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.");
  });

  it("returns null when verify output has no error line", () => {
    const result = extractFailureLearning({
      verifyOutput: "$ npm run build\nBuild succeeded.\nDone.",
    });
    expect(result).toBeNull();
  });

  it("returns null when verify output is empty", () => {
    const result = extractFailureLearning({
      verifyOutput: "",
    });
    expect(result).toBeNull();
  });

  it("returns null when verify output is null", () => {
    const result = extractFailureLearning({
      verifyOutput: null,
    });
    expect(result).toBeNull();
  });

  it("skips the command echo line ($ cmd) when mining", () => {
    const result = extractFailureLearning({
      verifyOutput: "$ eslint src/\nerror: 'unused' is not defined (no-undef)",
    });
    expect(result).toBe("Verify failed: error: 'unused' is not defined (no-undef)");
  });

  it("detects panic lines from smoke failures", () => {
    const result = extractFailureLearning({
      verifyOutput: "thread 'main' panicked at src/main.rs:42:10:\ncalled `Option::unwrap()` on a `None` value",
    });
    expect(result).toContain("panicked");
    expect(result).toContain("src/main.rs");
  });

  it("extracts the first BLOCKER finding from a review failure", () => {
    const result = extractFailureLearning({
      reviewFindings: [
        "[BLOCKER] The event listener is attached after the element is removed",
        "[MAJOR] Missing error handling for null",
      ],
    });
    expect(result).toBe("Review blocked: The event listener is attached after the element is removed");
  });

  it("ignores [MAJOR] findings when no [BLOCKER] exists", () => {
    const result = extractFailureLearning({
      reviewFindings: ["[MAJOR] Missing error handling for null"],
    });
    expect(result).toBeNull();
  });

  it("returns null when review findings are empty", () => {
    const result = extractFailureLearning({
      reviewFindings: [],
    });
    expect(result).toBeNull();
  });

  it("returns null when neither verify output nor review findings are provided", () => {
    const result = extractFailureLearning({});
    expect(result).toBeNull();
  });

  it("prioritizes verify failure over review findings", () => {
    const result = extractFailureLearning({
      verifyOutput: "$ cargo build\nerror[E0277]: the trait bound is not satisfied",
      reviewFindings: ["[BLOCKER] Some review issue"],
    });
    expect(result).toContain("Verify failed");
    expect(result).not.toContain("Review blocked");
  });

  it("trims very long error lines to a reasonable length", () => {
    const longError = "error: " + "x".repeat(300);
    const result = extractFailureLearning({
      verifyOutput: `$ cmd\n${longError}`,
    });
    expect(result!.length).toBeLessThan(230);
    expect(result!.endsWith("…")).toBe(true);
  });

  it("strips the [BLOCKER] prefix from the mined finding", () => {
    const result = extractFailureLearning({
      reviewFindings: ["[BLOCKER] Missing wire from button to handler"],
    });
    expect(result).not.toContain("[BLOCKER]");
    expect(result).toContain("Missing wire from button to handler");
  });
});

// The phase lifecycle (issue #91): pushLearnings / mineFailureLearning now
// live behind the learnings module seam, where the push-vs-mine-vs-consolidate
// decision is unit-testable without going through processTicket.
describe("phase learning lifecycle", () => {
  let cwd: string;
  let ledger: string;
  let state: RunState;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "learn-life-"));
    ledger = join(cwd, ".railhead", "ledger");
    await initLedger(ledger);
    state = createRunState({
      cwd,
      branch: "run/test",
      tickets_dir: join(cwd, ".scratch", "issues"),
      config: DEFAULT_CONFIG,
      pause_on_failure: false,
      verbose: false,
      quiet: false,
    });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    vi.mocked(executeOpendCode).mockReset();
  });

  async function emitTranscript(phaseFile: string, text: string): Promise<void> {
    await appendEvent(ledger, phaseFile, JSON.stringify({ type: "text", part: { type: "text", text } }));
  }

  it("pushLearnings no-ops (writes nothing) when the phase emitted no marker", async () => {
    await emitTranscript("01-01-implement", "did the work, no marker here");
    await pushLearnings(state, ledger, "01-01-implement");
    expect(await readLearnings(cwd)).toBeNull();
  });

  it("pushLearnings persists a LEARNED: fact to the file (push-only path, ADR 0013)", async () => {
    await emitTranscript("01-01-implement", `done\n${LEARNED_MARKER} screencapture -x gives raw PNG on macOS`);
    await pushLearnings(state, ledger, "01-01-implement");
    expect(await readLearnings(cwd)).toContain("screencapture -x gives raw PNG on macOS");
    expect(vi.mocked(executeOpendCode)).not.toHaveBeenCalled();
  });

  it("pushLearnings applies a RETRACTED: line before merging new facts", async () => {
    await writeLearnings(cwd, "this model cannot read images");
    await emitTranscript("02-01-implement", `${RETRACTED_MARKER} this model cannot read images\n${LEARNED_MARKER} screencapture -x works`);
    await pushLearnings(state, ledger, "02-01-implement");
    const content = await readLearnings(cwd);
    expect(content).not.toContain("this model cannot read images");
    expect(content).toContain("screencapture -x works");
  });

  it("mineFailureLearning skips when the worker already emitted its own LEARNED: line", async () => {
    await emitTranscript("03-01-implement", `${LEARNED_MARKER} worker knew the tooling fact`);
    await mineFailureLearning(state, ledger, "03-01-implement", { verifyOutput: "error: boom" });
    expect(await readLearnings(cwd)).toBeNull();
  });

  it("mineFailureLearning mines a correction from a verify failure the worker did not report", async () => {
    await emitTranscript("04-01-implement", "no marker here");
    await mineFailureLearning(state, ledger, "04-01-implement", { verifyOutput: "$ cargo build\nerror[E0277]: the trait bound is not satisfied" });
    expect(await readLearnings(cwd)).toContain("Verify failed");
  });

  it("merging consolidates on the extract seat when the budget would be exceeded", async () => {
    state._models = { extract: "extract-model" } as unknown as NonNullable<RunState["_models"]>;
    await writeLearnings(cwd, "line\n".repeat(600));
    vi.mocked(executeOpendCode).mockImplementation(async (prompt, opts) => {
      await emitTranscript(opts.phaseFile, "consolidated: all facts merged");
      return { status: "ok" as const, code: 0, signal: null, errorMessage: null, durationMs: 1, steps: 1, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls: 0 };
    });
    await emitTranscript("05-01-implement", `${LEARNED_MARKER} new fact after the budget filled`);
    await pushLearnings(state, ledger, "05-01-implement");
    expect(vi.mocked(executeOpendCode)).toHaveBeenCalledTimes(1);
    expect(await readLearnings(cwd)).toContain("consolidated");
  });
});
