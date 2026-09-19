import { describe, it, expect } from "vitest";
import { readCheckpointTicket, endsWithCheckpoint, CHECKPOINT_RE, CHECKPOINT_START } from "./checkpoint.ts";

describe("readCheckpointTicket (issue #84 S0.2)", () => {
  it("extracts the ticket named by a clean terminal marker line", () => {
    expect(readCheckpointTicket(`${CHECKPOINT_START} ticket=01`)).toBe("01");
    expect(readCheckpointTicket(`${CHECKPOINT_START} ticket=12`)).toBe("12");
  });

  it("accepts the colon form the model may drift into", () => {
    expect(readCheckpointTicket(`${CHECKPOINT_START} ticket: 03`)).toBe("03");
    expect(readCheckpointTicket(`${CHECKPOINT_START} ticket : 04`)).toBe("04");
  });

  it("returns null when no checkpoint line is present", () => {
    expect(readCheckpointTicket("just some build output\nDONE")).toBeNull();
    expect(readCheckpointTicket("")).toBeNull();
  });

  it("ignores a $CHECKPOINT mention without a ticket argument (narration, not a signal)", () => {
    expect(readCheckpointTicket("I will emit a $CHECKPOINT when I am done")).toBeNull();
  });

  it("takes the LAST marker line — a stressed model that re-emits mid-ramble yields the terminal ticket", () => {
    const transcript = [
      "some work",
      `${CHECKPOINT_START} ticket=01`,
      "oh wait, I should double-check the verify",
      `${CHECKPOINT_START} ticket=01`,
    ].join("\n");
    expect(readCheckpointTicket(transcript)).toBe("01");
  });

  it("matches the executor's detection regex against prose-free terminal output", () => {
    expect(CHECKPOINT_RE.test(`${CHECKPOINT_START} ticket=07`)).toBe(true);
    expect(CHECKPOINT_RE.test("nothing here")).toBe(false);
  });
});

describe("endsWithCheckpoint (terminal-anchored executor latch)", () => {
  it("is true when the text ends with a clean checkpoint line", () => {
    expect(endsWithCheckpoint(`${CHECKPOINT_START} ticket=03`)).toBe(true);
    expect(endsWithCheckpoint(`All green.\n\n${CHECKPOINT_START} ticket=03`)).toBe(true);
    expect(endsWithCheckpoint(`All green.\n\n${CHECKPOINT_START} ticket=03\n  `)).toBe(true);
  });

  it("is FALSE for a prose mention quoting the checkpoint format — the false-kill that wasted a 03 retry", () => {
    const prose = [
      "- Checkpoint format: `$CHECKPOINT ticket=NN` (zero-padded two digits) as LAST line; run npm test green before each.",
      "2. Get npm test green, then emit `$CHECKPOINT ticket=03`.",
      "3. Proceed to ticket 04 (pure pixel tool math) in `src/model/pixels.ts`.",
    ].join("\n");
    expect(endsWithCheckpoint(prose)).toBe(false);
    expect(CHECKPOINT_RE.test(prose)).toBe(true); // the loose regex is exactly what over-matched
  });

  it("is FALSE when the marker line is followed by more model output (not terminal)", () => {
    expect(endsWithCheckpoint(`${CHECKPOINT_START} ticket=03\nkeep working`)).toBe(false);
  });

  it("is FALSE for a marker without a ticket argument, empty text, and a non-marker last line", () => {
    expect(endsWithCheckpoint(CHECKPOINT_START)).toBe(false);
    expect(endsWithCheckpoint("")).toBe(false);
    expect(endsWithCheckpoint("work\n")).toBe(false);
  });

  it("accepts the colon form the model may drift into, like readCheckpointTicket", () => {
    expect(endsWithCheckpoint(`${CHECKPOINT_START} ticket: 03`)).toBe(true);
  });
});
