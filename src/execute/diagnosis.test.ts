import { describe, it, expect } from "vitest";
import { parseDiagnosis, buildDiagnosisPrompt, DIAGNOSIS_MARKER, PLAN_MARKER } from "./diagnosis.ts";

describe("parseDiagnosis (#110)", () => {
  it("parses a root cause and a plan from a well-formed transcript", () => {
    const text = [
      "some prose",
      "$DIAGNOSIS",
      "the implementer kept using the phantom dependency `foo-bar`",
      "$END",
      "$PLAN",
      "1. replace foo-bar with the real package",
      "2. run the build",
      "$END",
    ].join("\n");
    const r = parseDiagnosis(text);
    expect(r.diagnosis).toContain("phantom dependency");
    expect(r.plan).toContain("replace foo-bar");
    expect(r.plan).toContain("run the build");
  });

  it("returns a null plan when $PLAN is omitted (terminal signal)", () => {
    const r = parseDiagnosis("$DIAGNOSIS\nroot cause here\n$END");
    expect(r.diagnosis).toBe("root cause here");
    expect(r.plan).toBeNull();
  });

  it("returns both null when no $DIAGNOSIS was emitted", () => {
    const r = parseDiagnosis("the model never reached the marker\njust prose");
    expect(r.diagnosis).toBeNull();
    expect(r.plan).toBeNull();
  });

  it("ignores a $DIAGNOSIS quoted inside a code fence (#108)", () => {
    const text = [
      "here is the shape I was asked for:",
      "```",
      "$DIAGNOSIS",
      "example",
      "$END",
      "```",
      "no real diagnosis follows",
    ].join("\n");
    const r = parseDiagnosis(text);
    expect(r.diagnosis).toBeNull();
    expect(r.plan).toBeNull();
  });

  it("ignores a fenced $PLAN but still reads an unfenced $DIAGNOSIS", () => {
    const text = [
      "$DIAGNOSIS",
      "real root cause",
      "$END",
      "```",
      "$PLAN",
      "quoted example",
      "$END",
      "```",
    ].join("\n");
    const r = parseDiagnosis(text);
    expect(r.diagnosis).toBe("real root cause");
    expect(r.plan).toBeNull();
  });

  it("treats an empty $DIAGNOSIS body as null", () => {
    const r = parseDiagnosis("$DIAGNOSIS\n$END\n$PLAN\nstep one\n$END");
    expect(r.diagnosis).toBeNull();
    expect(r.plan).toBe("step one");
  });

  it("ignores a $PLAN that appears before $DIAGNOSIS", () => {
    const r = parseDiagnosis("$PLAN\nearly plan\n$END\n$DIAGNOSIS\nroot cause\n$END");
    expect(r.diagnosis).toBe("root cause");
    expect(r.plan).toBeNull();
  });

  it("survives a truncated transcript with an unclosed $PLAN (slices to end)", () => {
    const r = parseDiagnosis("$DIAGNOSIS\ncause\n$END\n$PLAN\nstep one\nstep two");
    expect(r.diagnosis).toBe("cause");
    expect(r.plan).toContain("step two");
  });

  it("stops the root-cause block at $PLAN when $END is missing before it", () => {
    const r = parseDiagnosis("$DIAGNOSIS\ncause\n$PLAN\nstep one\n$END");
    expect(r.diagnosis).toBe("cause");
    expect(r.plan).toBe("step one");
  });
});

describe("buildDiagnosisPrompt (#110)", () => {
  const base = {
    ticketFile: "01-add-greet.md",
    ticketBody: "export a greet function",
    criteria: ["exports greet"],
    evidence: [
      { errorMessage: "connection reset by peer", status: "transient", peakTokens: 10_000, steps: 3 },
    ],
    transcriptPaths: ["events/01-01-implement.jsonl"],
    diff: null,
  };

  it("names the ticket, criteria, evidence, and transcript paths", () => {
    const p = buildDiagnosisPrompt(base);
    expect(p).toContain("01-add-greet.md");
    expect(p).toContain("exports greet");
    expect(p).toContain("connection reset by peer");
    expect(p).toContain("events/01-01-implement.jsonl");
  });

  it("requires $DIAGNOSIS and treats $PLAN as optional (no $PLAN NONE)", () => {
    const p = buildDiagnosisPrompt(base);
    expect(p).toContain(DIAGNOSIS_MARKER);
    expect(p).toContain(PLAN_MARKER);
    expect(p).toContain("do NOT emit");
    expect(p).toContain("NONE");
  });

  it("omits the contracts block when none are supplied", () => {
    const p = buildDiagnosisPrompt(base);
    expect(p).not.toContain("Existing public contracts");
  });
});
