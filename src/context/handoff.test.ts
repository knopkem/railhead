import { describe, it, expect } from "vitest";
import { readHandoffMarker, HANDOFF_START, HANDOFF_END } from "./handoff.ts";

describe("readHandoffMarker", () => {
  // Twin of readLearnedMarkers (learnings.ts). The same lossy-parse
  // discipline: line-start markers only, prose-wrapped markers ignored,
  // NONE sentinel treated as empty. The risk-bearing concern is robustness
  // against a stressed small model that may emit the marker mid-narrative,
  // truncated, or with stray prose around it (issue #9).

  it("extracts the text between $HANDOFF and $END markers", () => {
    const transcript = "doing work\n$HANDOFF\ntried X\nfailed because Y\ntry Z next\n$END\nDONE src/x.ts";
    expect(readHandoffMarker(transcript)).toBe("tried X\nfailed because Y\ntry Z next");
  });

  it("returns null when no $HANDOFF marker is present", () => {
    expect(readHandoffMarker("noise\nmore noise\nDONE src/x.ts")).toBeNull();
  });

  it("returns null when $HANDOFF is present without a closing $END (truncated)", () => {
    expect(readHandoffMarker("$HANDOFF\ntried X\nfailed because Y")).toBeNull();
  });

  it("returns null when $HANDOFF block is empty or NONE", () => {
    expect(readHandoffMarker("$HANDOFF\nNONE\n$END")).toBeNull();
    expect(readHandoffMarker("$HANDOFF\n\n$END")).toBeNull();
  });

  it("trims leading/trailing whitespace from the block but preserves internal newlines", () => {
    const transcript = "$HANDOFF\n\n  tried X  \n  failed because Y  \n\n$END";
    expect(readHandoffMarker(transcript)).toBe("tried X\nfailed because Y");
  });

  it("matches the markers case-insensitively", () => {
    const transcript = "$handoff\ntried X\n$end";
    expect(readHandoffMarker(transcript)).toBe("tried X");
  });

  it("ignores the marker in the middle of a prose sentence (not at line start)", () => {
    const transcript = "I decided to $HANDOFF my work and continue differently. $END";
    expect(readHandoffMarker(transcript)).toBeNull();
  });

  it("takes the FIRST $HANDOFF...$END pair when several exist (the wrap-up is the signal)", () => {
    const transcript = "$HANDOFF\nfirst handoff\n$END\nmore work\n$HANDOFF\nsecond handoff\n$END";
    expect(readHandoffMarker(transcript)).toBe("first handoff");
  });

  it("takes the first COMPLETE pair when an earlier $HANDOFF has no $END (truncated then retried)", () => {
    // A stressed model may start a handoff, get cut off, then emit a clean
    // one. The truncated open is ignored; the first complete pair wins.
    const transcript = "$HANDOFF\ntried X but got cut off\n$HANDOFF\nsecond attempt\n$END";
    expect(readHandoffMarker(transcript)).toBe("second attempt");
  });

  it("tolerates leading whitespace before the marker (indented wrap-up)", () => {
    expect(readHandoffMarker("   $HANDOFF\nindented handoff\n   $END")).toBe("indented handoff");
  });

  it("handles empty transcript gracefully", () => {
    expect(readHandoffMarker("")).toBeNull();
  });

  it("handles whitespace-only transcript gracefully", () => {
    expect(readHandoffMarker("   \n  \n")).toBeNull();
  });

  it("does not swallow text after $END into the block", () => {
    const transcript = "$HANDOFF\nthe handoff\n$END\nLEARNED: a tooling fact\nDONE src/x.ts";
    expect(readHandoffMarker(transcript)).toBe("the handoff");
  });

  it("preserves special characters, commas, and code-like content exactly", () => {
    const handoff = "tried `cargo run`; it panicked with `B0001` — use `cargo build` + direct binary run instead";
    expect(readHandoffMarker(`$HANDOFF\n${handoff}\n$END`)).toBe(handoff);
  });

  it("does not seed a handoff from a fenced format echo (#108)", () => {
    const transcript = "the format is:\n```\n$HANDOFF\nquoted example\n$END\n```\n$HANDOFF\nreal handoff\n$END";
    expect(readHandoffMarker(transcript)).toBe("real handoff");
  });

  it("returns null when the only $HANDOFF is fenced (#108)", () => {
    expect(readHandoffMarker("```\n$HANDOFF\nquoted example\n$END\n```")).toBeNull();
  });
});

describe("handoff marker constants", () => {
  it("exposes the start and end markers as named exports (single source of truth for prompt + parser)", () => {
    expect(HANDOFF_START).toBe("$HANDOFF");
    expect(HANDOFF_END).toBe("$END");
  });
});
