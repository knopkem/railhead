import { describe, it, expect } from "vitest";
import {
  fenceRanges,
  stripFencedRegions,
  isOutsideFences,
  indexOfOutsideFences,
  indexOfLiteralOutsideFences,
  lastIndexOfLiteralOutsideFences,
} from "./fences.ts";

describe("fenceRanges (#108)", () => {
  it("returns [] for a transcript with no fences", () => {
    expect(fenceRanges("plain prose\nmore prose")).toEqual([]);
    expect(fenceRanges("")).toEqual([]);
  });

  it("spans a bare fenced region including both fence lines", () => {
    // "prose\n```\nfoo\n```\nmore"
    const text = "prose\n```\nfoo\n```\nmore";
    expect(fenceRanges(text)).toEqual([{ start: 6, end: 18 }]);
  });

  it("spans a tagged fenced region", () => {
    const text = "a\n```ts\ncode\n```\nb";
    // a(0) \n(1) ```ts [2..7) \n(7) code [8..12) \n(12) ``` [13..16) \n(16) b
    expect(fenceRanges(text)).toEqual([{ start: 2, end: 17 }]);
  });

  it("counts a fence with leading whitespace", () => {
    const text = "prose\n    ```\ncode\n    ```\nmore";
    const ranges = fenceRanges(text);
    expect(ranges.length).toBe(1);
    // The stripped view removes the indented fence too.
    expect(stripFencedRegions(text)).toBe("prose\nmore");
  });

  it("cuts an unclosed fence to the end", () => {
    const text = "prose\n```\ndangling open";
    const ranges = fenceRanges(text);
    expect(ranges).toEqual([{ start: 6, end: text.length }]);
  });

  it("tracks multiple fences independently", () => {
    const text = "a\n```\nx\n```\nb\n```ts\ny\n```\nc";
    expect(fenceRanges(text).length).toBe(2);
  });

  it("does not treat an indented content line as a fence", () => {
    const text = "```\n  not a fence, just indented code\n```\nafter";
    expect(fenceRanges(text).length).toBe(1);
    expect(stripFencedRegions(text)).toBe("after");
  });
});

describe("stripFencedRegions (#108)", () => {
  it("returns the input unchanged when there are no fences", () => {
    const text = "no fences here\n$GOAL_PASS\n$END";
    expect(stripFencedRegions(text)).toBe(text);
  });

  it("removes fence lines and content, joining prose with newlines", () => {
    const text = "before\n```\n$GOAL_FAIL\n[BLOCKER] example\n$END\n```\nafter";
    expect(stripFencedRegions(text)).toBe("before\nafter");
  });

  it("handles a tagged fence and an empty transcript without throwing", () => {
    expect(stripFencedRegions("")).toBe("");
    expect(stripFencedRegions("   \n  \n")).toBe("   \n  \n");
    expect(stripFencedRegions("```python\ncode\n```")).toBe("");
  });
});

describe("isOutsideFences (#108)", () => {
  const ranges = [{ start: 6, end: 18 }];

  it("is outside a span wholly before or after a range", () => {
    expect(isOutsideFences(ranges, 0, 3)).toBe(true);
    expect(isOutsideFences(ranges, 18, 20)).toBe(true);
  });

  it("is not outside a span inside a range", () => {
    expect(isOutsideFences(ranges, 8, 12)).toBe(false);
  });

  it("is not outside a span straddling a range boundary", () => {
    expect(isOutsideFences(ranges, 5, 7)).toBe(false);
    expect(isOutsideFences(ranges, 17, 19)).toBe(false);
  });

  it("is outside everything when there are no ranges", () => {
    expect(isOutsideFences([], 0, 100)).toBe(true);
  });
});

describe("indexOfOutsideFences (#108)", () => {
  it("finds the first unfenced marker", () => {
    const text = "fenced:\n```\n$GOAL_FAIL\n```\nreal: $GOAL_FAIL\n";
    expect(indexOfOutsideFences(text, /\$goal_fail\b/gi)).toBe(text.indexOf("real: $GOAL_FAIL") + "real: ".length);
  });

  it("returns -1 when the only occurrence is fenced", () => {
    expect(indexOfOutsideFences("```\n$GOAL_FAIL\n```", /\$goal_fail\b/gi)).toBe(-1);
  });

  it("skips a fenced occurrence and lands on a later unfenced one", () => {
    const text = "```\n$VISUAL_PASS\n```\n$VISUAL_FAIL\n[BLOCKER] x\n$END";
    expect(indexOfOutsideFences(text, /\$visual_fail\b/i)).toBe(text.indexOf("$VISUAL_FAIL"));
  });
});

describe("indexOfLiteralOutsideFences / lastIndexOfLiteralOutsideFences (#108)", () => {
  it("finds a literal outside fences, honouring fromIndex", () => {
    const text = "```\n$BLOCKING\n```\n$BLOCKING\nreal\n$OK";
    const first = indexOfLiteralOutsideFences(text, "$BLOCKING");
    expect(first).toBe(text.lastIndexOf("$BLOCKING"));
    const second = indexOfLiteralOutsideFences(text, "$BLOCKING", first + 1);
    expect(second).toBe(-1);
  });

  it("returns -1 when a literal only appears inside fences", () => {
    expect(indexOfLiteralOutsideFences("```\n$NITS\n```", "$NITS")).toBe(-1);
  });

  it("finds the last unfenced occurrence", () => {
    const text = "```\n$OK\n```\n$OK\nfinal";
    expect(lastIndexOfLiteralOutsideFences(text, "$OK")).toBe(text.lastIndexOf("$OK"));
    expect(lastIndexOfLiteralOutsideFences("```\n$OK\n```", "$OK")).toBe(-1);
  });
});
