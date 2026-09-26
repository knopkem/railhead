import { describe, it, expect } from "vitest";
import { parseRunArgs, parsePlanArgs, parseProductArgs } from "./args.ts";
import { parseGateMode, presetGateModes, presetRunsSharpen, firesMidRun, firesAtRunEnd, severityTriggersRetry, codeReviewRunsMidRun, visualFiresAtRunEnd } from "./config.ts";

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
    });
    expect(a.overrides).toEqual({ code: null, visual: null, goal: null, structural: null });
  });

  it("parses --quiet standalone", () => {
    expect(parseRunArgs(["issues", "--quiet"]).quiet).toBe(true);
  });

  it("parses --fresh flag", () => {
    expect(parseRunArgs(["issues", "--fresh"]).fresh).toBe(true);
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
    expect(parsePlanArgs(["build", "a", "thing"], "build").prompt).toBe("build a thing");
  });

  it("detects auto and continue flags", () => {
    const a = parsePlanArgs(["-a", "-c", "build"], "build");
    expect(a.auto).toBe(true);
    expect(a.cont).toBe(true);
  });

  it("parses a preset flag", () => {
    expect(parsePlanArgs(["build", "--medium"], "build").preset).toBe("medium");
  });

  it("rejects two conflicting presets", () => {
    expect(() => parsePlanArgs(["build", "--full", "--light"], "build")).toThrow(/conflicting presets/);
  });

  it("parses per-gate overrides and boolean overrides", () => {
    const a = parsePlanArgs(["build", "--review", "off", "--goal", "light", "--no-sharpen"], "build");
    expect(a.overrides).toEqual({ code: "off", visual: null, goal: "light", structural: null });
    expect(a.sharpen).toBe(false);
  });

  it("rejects contradictory boolean overrides", () => {
    expect(() => parsePlanArgs(["build", "--sharpen", "--no-sharpen"], "build")).toThrow(/mutually exclusive/);
  });

  it("keeps the description clean of flag values (e.g. --model)", () => {
    const a = parsePlanArgs(["--model", "some/model", "build", "x"], "fix");
    expect(a.modelOverride).toBe("some/model");
    expect(a.prompt).toBe("build x");
    expect(a.mode).toBe("fix");
  });

  it("flags --verbose and keeps it out of the prompt", () => {
    const a = parsePlanArgs(["build", "x", "--verbose"], "build");
    expect(a.verbose).toBe(true);
    expect(a.prompt).toBe("build x");
    expect(parsePlanArgs(["build", "x"], "build").verbose).toBe(false);
  });

  it("feature mode: --step forces a roadmap step and stays out of the prompt", () => {
    const a = parsePlanArgs(["--step", "2", "-a"], "feature");
    expect(a.step).toBe(2);
    expect(a.mode).toBe("feature");
    expect(a.prompt).toBe("");
    expect(parsePlanArgs(["--step", "03"], "feature").step).toBe(3);
  });

  it("build/fix parse --step but leave it to feature mode to honor", () => {
    expect(parsePlanArgs(["--step", "2", "x"], "build").step).toBe(2);
    expect(parsePlanArgs(["x"], "build").step).toBeNull();
    expect(parsePlanArgs(["--step"], "feature").step).toBeNull();
  });
});

describe("parseProductArgs", () => {
  it("joins the non-flag text as the operator's input", () => {
    const a = parseProductArgs(["a", "hiking log,", "please"]);
    expect(a.instruction).toBe("a hiking log, please");
    expect(a.auto).toBe(false);
  });

  it("keeps --model values out of the input and reads the convenience flags", () => {
    const a = parseProductArgs(["--model", "opencode/gpt", "-a", "--verbose", "revise", "the arc"]);
    expect(a.instruction).toBe("revise the arc");
    expect(a.modelOverride).toBe("opencode/gpt");
    expect(a.auto).toBe(true);
    expect(a.verbose).toBe(true);
  });

  it("an all-flags invocation has an empty instruction (the command throws the guidance)", () => {
    expect(parseProductArgs(["-a"]).instruction).toBe("");
  });

  it("reads the arc interview override and rejects both sides at once", () => {
    expect(parseProductArgs(["vision text"]).sharpen).toBeNull();
    expect(parseProductArgs(["vision text", "--sharpen"]).sharpen).toBe(true);
    expect(parseProductArgs(["vision text", "--no-sharpen"]).sharpen).toBe(false);
    expect(parseProductArgs(["vision text", "--sharpen"]).instruction).toBe("vision text");
    expect(() => parseProductArgs(["x", "--sharpen", "--no-sharpen"])).toThrow(/mutually exclusive/);
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

  it("--medium: per-ticket code review (BLOCKER+MAJOR retry), end-of-run visual, checkpoint-only goal/structural", () => {
    expect(presetGateModes("medium")).toEqual({ code: "medium", visual: "light", goal: "medium", structural: "medium" });
  });

  it("--light: per-ticket code review (BLOCKER+MAJOR retry), light cadence for the other gates (goal checkpoints corrective)", () => {
    expect(presetGateModes("light")).toEqual({ code: "medium", visual: "light", goal: "light", structural: "light", goalCheckpointAction: "corrective" });
  });

  it("--none turns every gate off", () => {
    expect(presetGateModes("none")).toEqual({ code: "off", visual: "off", goal: "off", structural: "off" });
  });

  it("preset booleans: --medium/--full run sharpen", () => {
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
