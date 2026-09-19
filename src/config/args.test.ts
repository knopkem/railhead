import { describe, it, expect } from "vitest";
import { parseRunArgs, parsePlanArgs } from "./args.ts";
import { parseGateMode, presetGateModes, presetRunsTdd, presetRunsSharpen, firesMidRun, firesAtRunEnd, severityTriggersRetry, codeReviewRunsMidRun, visualFiresAtRunEnd } from "./config.ts";

describe("parseRunArgs", () => {
  it("extracts the non-dash positional as the tickets dir", () => {
    expect(parseRunArgs(["issues"]).ticketsDir).toBe("issues");
    expect(parseRunArgs([]).ticketsDir).toBeNull();
  });

  it("flags pause, verbose, max-retries", () => {
    const a = parseRunArgs(["issues", "--pause-on-failure", "--verbose", "-m", "5"]);
    expect(a).toMatchObject({
      ticketsDir: "issues",
      pauseOnFailure: true,
      verbose: true,
      maxRetriesRaw: "5",
    });
  });

  it("defaults flags off and absent overrides null/undefined", () => {
    const a = parseRunArgs(["issues"]);
    expect(a).toMatchObject({
      pauseOnFailure: false,
      verbose: false,
      quiet: false,
      maxRetriesRaw: null,
      fresh: false,
      tdd: null,
    });
    expect(a.overrides).toEqual({ code: null, visual: null, goal: null, structural: null });
  });

  it("parses --quiet standalone", () => {
    expect(parseRunArgs(["issues", "--quiet"]).quiet).toBe(true);
  });

  it("parses --fresh flag", () => {
    expect(parseRunArgs(["issues", "--fresh"]).fresh).toBe(true);
  });

  it("parses --tdd and --no-tdd (issue #73), rejecting both", () => {
    expect(parseRunArgs(["issues", "--tdd"]).tdd).toBe(true);
    expect(parseRunArgs(["issues", "--no-tdd"]).tdd).toBe(false);
    expect(() => parseRunArgs(["issues", "--tdd", "--no-tdd"])).toThrow(/mutually exclusive/);
  });

  it("parses per-gate cadence overrides (--review/--vision/--goal/--structural)", () => {
    const a = parseRunArgs(["issues", "--review", "off", "--vision", "full", "--goal", "medium", "--structural", "light"]);
    expect(a.overrides).toEqual({ code: "off", visual: "full", goal: "medium", structural: "light" });
  });

  it("ignores a --review value that is not a gate mode (a model name)", () => {
    const a = parseRunArgs(["issues", "--review", "mtplx/model-x"]);
    expect(a.overrides.code).toBeNull();
  });
});

describe("parsePlanArgs", () => {
  it("extracts the prompt from the non-flag args", () => {
    expect(parsePlanArgs(["build", "a", "thing"], "plan").prompt).toBe("build a thing");
  });

  it("detects auto and continue flags", () => {
    const a = parsePlanArgs(["-a", "-c", "build"], "plan");
    expect(a.auto).toBe(true);
    expect(a.cont).toBe(true);
  });

  it("parses a preset flag", () => {
    expect(parsePlanArgs(["build", "--medium"], "plan").preset).toBe("medium");
  });

  it("rejects two conflicting presets", () => {
    expect(() => parsePlanArgs(["build", "--full", "--light"], "plan")).toThrow(/conflicting presets/);
  });

  it("parses per-gate overrides and boolean overrides", () => {
    const a = parsePlanArgs(["build", "--review", "off", "--goal", "light", "--tdd", "--no-sharpen"], "plan");
    expect(a.overrides).toEqual({ code: "off", visual: null, goal: "light", structural: null });
    expect(a.tdd).toBe(true);
    expect(a.sharpen).toBe(false);
  });

  it("rejects contradictory boolean overrides", () => {
    expect(() => parsePlanArgs(["build", "--tdd", "--no-tdd"], "plan")).toThrow(/mutually exclusive/);
  });

  it("keeps the description clean of flag values (e.g. --model)", () => {
    const a = parsePlanArgs(["--model", "some/model", "build", "x"], "fix");
    expect(a.modelOverride).toBe("some/model");
    expect(a.prompt).toBe("build x");
    expect(a.mode).toBe("fix");
  });

  it("flags --verbose and keeps it out of the prompt", () => {
    const a = parsePlanArgs(["build", "x", "--verbose"], "plan");
    expect(a.verbose).toBe(true);
    expect(a.prompt).toBe("build x");
    expect(parsePlanArgs(["build", "x"], "plan").verbose).toBe(false);
  });
});

describe("parseGateMode", () => {
  it("accepts the four cadence modes case-insensitively", () => {
    expect(parseGateMode("full")).toBe("full");
    expect(parseGateMode("MEDIUM")).toBe("medium");
    expect(parseGateMode("Light")).toBe("light");
    expect(parseGateMode("off")).toBe("off");
  });

  it("returns null for unrecognised, empty or absent modes", () => {
    expect(parseGateMode("bogus")).toBeNull();
    expect(parseGateMode("advisory")).toBeNull();
    expect(parseGateMode("final")).toBeNull();
    expect(parseGateMode("")).toBeNull();
    expect(parseGateMode(undefined)).toBeNull();
    expect(parseGateMode(null)).toBeNull();
  });
});

describe("preset gate modes (issue #73)", () => {
  it("--full turns every gate on at full cadence", () => {
    expect(presetGateModes("full")).toEqual({ code: "full", visual: "full", goal: "full", structural: "full" });
  });

  it("--medium: per-ticket code review, end-of-run visual, checkpoint-only goal/structural", () => {
    expect(presetGateModes("medium")).toEqual({ code: "medium", visual: "light", goal: "medium", structural: "medium" });
  });

  it("--light: light cadence for all gates (code runs per-ticket: BLOCKER full retry + MAJOR one attempt; goal checkpoints advisory — ADR 0029)", () => {
    expect(presetGateModes("light")).toEqual({ code: "light", visual: "light", goal: "light", structural: "light", goalCheckpointAction: "advisory" });
  });

  it("--none turns every gate off", () => {
    expect(presetGateModes("none")).toEqual({ code: "off", visual: "off", goal: "off", structural: "off" });
  });

  it("preset booleans: only --full keeps TDD; --medium/--full run sharpen", () => {
    expect(presetRunsTdd("full")).toBe(true);
    expect(presetRunsTdd("medium")).toBe(false);
    expect(presetRunsTdd("light")).toBe(false);
    expect(presetRunsTdd("none")).toBe(false);
    expect(presetRunsSharpen("full")).toBe(true);
    expect(presetRunsSharpen("medium")).toBe(true);
    expect(presetRunsSharpen("light")).toBe(false);
    expect(presetRunsSharpen("none")).toBe(false);
  });
});

describe("cadence helpers (issue #73)", () => {
  it("firesMidRun: full and medium", () => {
    expect(firesMidRun("full")).toBe(true);
    expect(firesMidRun("medium")).toBe(true);
    expect(firesMidRun("light")).toBe(false);
    expect(firesMidRun("off")).toBe(false);
  });

  it("firesAtRunEnd: full and light", () => {
    expect(firesAtRunEnd("full")).toBe(true);
    expect(firesAtRunEnd("medium")).toBe(false);
    expect(firesAtRunEnd("light")).toBe(true);
    expect(firesAtRunEnd("off")).toBe(false);
  });
});

describe("code review severity threshold (issue #73 redesign)", () => {
  it("codeReviewRunsMidRun: light, medium, full all run per-ticket; only off skips", () => {
    expect(codeReviewRunsMidRun("full")).toBe(true);
    expect(codeReviewRunsMidRun("medium")).toBe(true);
    expect(codeReviewRunsMidRun("light")).toBe(true);
    expect(codeReviewRunsMidRun("off")).toBe(false);
  });

  it("severityTriggersRetry: minor never triggers retry in any mode", () => {
    expect(severityTriggersRetry("minor", "light")).toBe(false);
    expect(severityTriggersRetry("minor", "medium")).toBe(false);
    expect(severityTriggersRetry("minor", "full")).toBe(false);
  });

  it("severityTriggersRetry: blocker always triggers retry", () => {
    expect(severityTriggersRetry("blocker", "light")).toBe(true);
    expect(severityTriggersRetry("blocker", "medium")).toBe(true);
    expect(severityTriggersRetry("blocker", "full")).toBe(true);
  });

  it("severityTriggersRetry: major triggers retry only in medium/full, not light", () => {
    expect(severityTriggersRetry("major", "light")).toBe(false);
    expect(severityTriggersRetry("major", "medium")).toBe(true);
    expect(severityTriggersRetry("major", "full")).toBe(true);
  });
});

describe("visualFiresAtRunEnd (issue #97)", () => {
  it("fires under full/light when goal is off at run end", () => {
    expect(visualFiresAtRunEnd("light", "off", false)).toBe(true);
    expect(visualFiresAtRunEnd("full", "off", false)).toBe(true);
    expect(visualFiresAtRunEnd("full", "off", true)).toBe(true);
  });

  it("does not fire when goal review owns the run-end whole-app pass", () => {
    // goal full/light + a resolved goal model → goal takes the seat.
    expect(visualFiresAtRunEnd("light", "light", true)).toBe(false);
    expect(visualFiresAtRunEnd("light", "full", true)).toBe(false);
    expect(visualFiresAtRunEnd("full", "full", true)).toBe(false);
  });

  it("still fires when goal is configured at run end but has NO resolved model (goal would skip)", () => {
    expect(visualFiresAtRunEnd("light", "light", false)).toBe(true);
  });

  it("never fires when visual mode itself does not reach run end", () => {
    expect(visualFiresAtRunEnd("off", "off", false)).toBe(false);
    expect(visualFiresAtRunEnd("medium", "off", false)).toBe(false);
    expect(visualFiresAtRunEnd("off", "off", true)).toBe(false);
  });
});
