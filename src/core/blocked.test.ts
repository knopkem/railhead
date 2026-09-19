import { describe, it, expect } from "vitest";
import { endsWithBlockReport, parseBlockReport, BLOCKED_RE } from "./blocked.ts";

describe("parseBlockReport", () => {
  it("reads the ticket, kind, and reason from a block line", () => {
    const report = parseBlockReport("$BLOCKED ticket=07 kind=verification-unavailable reason=AC 6 needs a live playthrough; the canvas offers no state hook and pixel-sampling the bot dies at the first pit");
    expect(report).toEqual({
      ticket: "07",
      kind: "verification-unavailable",
      reason: "AC 6 needs a live playthrough; the canvas offers no state hook and pixel-sampling the bot dies at the first pit",
      malformedKind: false,
    });
  });

  it("accepts colon separators (the checkpoint grammar's loose dialect)", () => {
    const report = parseBlockReport("$BLOCKED ticket: 07 kind: plan-defect reason: ticket 07 requires a symbol ticket 08 owns");
    expect(report?.ticket).toBe("07");
    expect(report?.kind).toBe("plan-defect");
    expect(report?.reason).toContain("ticket 08 owns");
  });

  it("degrades an unknown kind to implementation-stuck and flags it", () => {
    const report = parseBlockReport("$BLOCKED ticket=07 kind=whatever reason=stuck");
    expect(report?.kind).toBe("implementation-stuck");
    expect(report?.malformedKind).toBe(true);
  });

  it("returns null when the block line names no ticket (narration, not a signal)", () => {
    expect(parseBlockReport("$BLOCKED kind=implementation-stuck reason=something")).toBeNull();
    expect(parseBlockReport("no markers here")).toBeNull();
  });

  it("the LAST block line wins, so a re-emitted marker resolves to the final state", () => {
    const text = [
      "$BLOCKED ticket=07 kind=implementation-stuck reason=first attempt",
      "work work work",
      "$BLOCKED ticket=07 kind=verification-unavailable reason=final answer",
    ].join("\n");
    const report = parseBlockReport(text);
    expect(report?.kind).toBe("verification-unavailable");
    expect(report?.reason).toBe("final answer");
  });

  it("falls back to the whole line as the reason when reason= is absent", () => {
    const report = parseBlockReport("$BLOCKED ticket=07 kind=implementation-stuck");
    expect(report?.reason).toBe("$BLOCKED ticket=07 kind=implementation-stuck");
  });
});

describe("endsWithBlockReport", () => {
  it("is true only when the last non-empty line is a block naming a ticket", () => {
    expect(endsWithBlockReport("some work\n$BLOCKED ticket=07 kind=implementation-stuck reason=x")).toBe(true);
    expect(endsWithBlockReport("$BLOCKED ticket=07 kind=implementation-stuck reason=x\nmore prose")).toBe(false);
    expect(endsWithBlockReport("$BLOCKED ticket=07 kind=implementation-stuck reason=x\n\n  ")).toBe(true);
  });

  it("is false for a prose mention of the format (must not arm the kill)", () => {
    expect(endsWithBlockReport("If you cannot verify, emit `$BLOCKED ticket=07 kind=...` as the last line.")).toBe(false);
    expect(endsWithBlockReport("$BLOCKED without a ticket arg")).toBe(false);
  });
});

describe("BLOCKED_RE", () => {
  it("finds the marker token in streamed text", () => {
    expect(BLOCKED_RE.test("...$BLOCKED ticket=03...")).toBe(true);
    expect(BLOCKED_RE.test("nothing")).toBe(false);
  });
});
