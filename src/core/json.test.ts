import { describe, it, expect } from "vitest";
import { scanJsonObjects } from "./json.ts";

describe("scanJsonObjects", () => {
  it("returns objects in order", () => {
    expect(scanJsonObjects('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips a malformed object and keeps the rest", () => {
    expect(scanJsonObjects('{"a":1}{BROKEN}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(scanJsonObjects('{BROKEN}{"b":2}')).toEqual([{ b: 2 }]);
  });

  it("respects braces inside strings", () => {
    expect(scanJsonObjects('{"s":"a}b"}')).toEqual([{ s: "a}b" }]);
  });

  it("tolerates escaped quotes inside strings", () => {
    expect(scanJsonObjects('{"s":"a\\"}b"}')).toEqual([{ s: 'a"}b' }]);
  });

  it("stops at an unbalanced trailing brace", () => {
    expect(scanJsonObjects('{"a":1},{"b":2').map((o) => o.a)).toEqual([1]);
  });

  it("recovers later objects after a malformed object desyncs string tracking (missing quote)", () => {
    // The spriteforge plan shape: an unquoted array element inverts the quote
    // state, so the object never closes. The scan must skip that one object and
    // keep reading — dropping every later object is the bug this guards.
    const text = '{"title":"a","files":["x.ts", y.ts"]},{"title":"b"},{"title":"c"}';
    expect(scanJsonObjects(text).map((o) => o.title)).toEqual(["b", "c"]);
  });

  it("returns nothing for prose without objects", () => {
    expect(scanJsonObjects("just words here")).toEqual([]);
  });
});