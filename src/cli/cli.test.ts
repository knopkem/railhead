import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import { parseLogArgs, describeModel, ensureInitialized, modelParameterClass, modelTierWarnings, initRailheadConfig, minDetectedContext, contextOverrideWarnings, visionCapabilityWarnings, type InitSeatProbe } from "./cli.ts";
import { DEFAULT_MODEL } from "../config/config.ts";
import type { CapabilityInfo } from "../core/models.ts";

describe("parseLogArgs", () => {
  it("with both args, treats them as an explicit run id and phase", () => {
    expect(parseLogArgs("run-20260824-2354", "02-02-review")).toEqual({
      runId: "run-20260824-2354",
      phase: "02-02-review",
    });
  });

  it("with one arg starting with 'run-', treats it as a bare run id (list phases)", () => {
    expect(parseLogArgs("run-20260824-2354")).toEqual({ runId: "run-20260824-2354" });
  });

  it("with one arg NOT starting with 'run-', treats it as a phase against the latest run", () => {
    expect(parseLogArgs("01-01-implement")).toEqual({ runId: null, phase: "01-01-implement" });
  });

  it("with no args, resolves to the latest run with no phase", () => {
    expect(parseLogArgs()).toEqual({ runId: null });
  });

  it("a phase name that happens to start with digits is still not mistaken for a run id", () => {
    // Real phase names start with a 2-digit ticket number (e.g. 02-02-review);
    // only the literal "run-" prefix means "this is a run id", not "starts
    // with a digit" — a phase name never collides with that shape.
    expect(parseLogArgs("02-10-implement")).toEqual({ runId: null, phase: "02-10-implement" });
  });
});

describe("describeModel", () => {
  it("describes a configured model verbatim", () => {
    expect(describeModel("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
  });

  it("describes a null model as skip", () => {
    expect(describeModel(null)).toBe("skip");
  });

  it("describes the DEFAULT_MODEL sentinel as opencode default", () => {
    expect(describeModel("default")).toBe("opencode default");
  });
});

describe("ensureInitialized", () => {
  it("is a no-op when railhead.json already exists — never clobbers an existing config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-init-"));
    const target = join(cwd, "railhead.json");
    const original = '{"verify":["custom test command"]}';
    await writeFile(target, original, "utf8");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await ensureInitialized(cwd);
    } finally {
      logSpy.mockRestore();
    }
    expect(await readFile(target, "utf8")).toBe(original);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("modelParameterClass", () => {
  // The lossy parser ADR 0015 calls for: a crude parameter-count heuristic to
  // flag sub-27B judgment-seat models. False positives (a non-parameter number)
  // are acceptable because the warning is advisory.

  it("parses a парамет-B suffix (case-insensitive)", () => {
    expect(modelParameterClass("qwen3-7b")).toBe(7);
    expect(modelParameterClass("Qwen3.6-35B-A3R")).toBe(35);
    expect(modelParameterClass("deepseek-271b")).toBe(271);
  });

  it("returns null when no <number>B pattern is present (a model with no parseable size)", () => {
    expect(modelParameterClass("opencode default")).toBeNull();
    expect(modelParameterClass("gpt-4o")).toBeNull();
    expect(modelParameterClass("claude")).toBeNull();
  });

  it("takes the largest match when several <number>B substrings exist", () => {
    expect(modelParameterClass("Qwen3.6-35B-A3R-v2-0B-at-layer-12B")).toBe(35);
  });
});

describe("modelTierWarnings", () => {
  // ADR 0015: judgment seats (plan, implement, review) are 27B+ minimum.
  // The railhead warns advisory (not reject) when a configured judgment model
  // parses below 27B, or when `model.review` fell back to `model.implement`.

  it("warns when a judgment seat is configured below 27B", () => {
    const cfg = {
      ...({} as any),
      model: {
        plan: "qwen3-7b",
        implement: "Qwen3.6-35B-A3R",
        review: "Qwen3.6-35B-A3R", visual: null, goal: null,
        extract: null,
      },
    };
    const resolved = { plan: "qwen3-7b", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).toContainEqual(expect.stringMatching(/plan.*qwen3-7b.*7B.*below the 27B/i));
  });

  it("warns on the review ?? implement fallback (model.review unset, fell back)", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: "Qwen3.6-35B-A3R", review: DEFAULT_MODEL, visual: null, goal: null, extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).toContainEqual(expect.stringMatching(/model\.review unset.*falling back to model\.implement/i));
  });

  it("does not warn on review ?? implement when model.review was explicitly set", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).not.toContainEqual(expect.stringMatching(/model\.review unset/i));
  });

  it("does not warn when all judgment seats are at or above 27B and review is set", () => {
    const cfg = {
      ...({} as any),
      model: { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: "Qwen3.6-35B-A3R", goal: null, extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: "Qwen3.6-35B-A3R", goal: null, extract: "Qwen3.6-35B-A3R" };
    expect(modelTierWarnings(cfg, resolved)).toEqual([]);
  });

  it("does not warn on the extract seat being sub-27B (narrow seats tolerate 9B per ADR 0015)", () => {
    const cfg = {
      ...({} as any),
      model: { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "qwen3-7b" },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "qwen3-7b" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).not.toContainEqual(expect.stringMatching(/extract/i));
  });

  it("does not warn on null (opencode default) judgment models — size unparseable, no basis to advise", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null },
    };
    const resolved = { plan: null, implement: null, review: null, visual: null, goal: null, extract: null };
    expect(modelTierWarnings(cfg, resolved)).toEqual([]);
  });

  it("warns when model.review is explicitly weaker than model.implement (#47)", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: "Qwen3.6-35B-A3R", review: "qwen3-7b", visual: null, goal: null, extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "qwen3-7b", visual: null, goal: null, extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).toContainEqual(expect.stringMatching(/review.*weaker.*implement|review.*below.*implement/i));
  });

  it("does not warn when model.review is equal to model.implement", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).not.toContainEqual(expect.stringMatching(/review.*weaker/i));
  });

  it("does not warn when model.review is stronger than model.implement", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: "qwen3-7b", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: null },
    };
    const resolved = { plan: "qwen3-7b", implement: "qwen3-7b", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "qwen3-7b" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).not.toContainEqual(expect.stringMatching(/review.*weaker/i));
  });

  it("warns when model.goal is explicitly weaker than model.implement (#47)", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: "qwen3-7b", extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: "qwen3-7b", extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).toContainEqual(expect.stringMatching(/goal.*weaker.*implement|goal.*below.*implement/i));
  });

  it("does not warn when model.goal is unset (falls back silently per fallback chain)", () => {
    const cfg = {
      ...({} as any),
      model: { plan: null, implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: null, extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).not.toContainEqual(expect.stringMatching(/goal.*weaker/i));
  });

  it("warns when model.goal is below the 27B judgment-seat floor (#47)", () => {
    const cfg = {
      ...({} as any),
      model: { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: "qwen3-7b", extract: null },
    };
    const resolved = { plan: "Qwen3.6-35B-A3R", implement: "Qwen3.6-35B-A3R", review: "Qwen3.6-35B-A3R", visual: null, goal: "qwen3-7b", extract: "Qwen3.6-35B-A3R" };
    const w = modelTierWarnings(cfg, resolved);
    expect(w).toContainEqual(expect.stringMatching(/model\.goal.*7B.*below the 27B/i));
  });
});

// ---------------------------------------------------------------------------
// init (issue #74): seat probing, warnings, and the config init writes
// ---------------------------------------------------------------------------

/** A seat probe whose capabilities come from a partial CapabilityInfo. */
function seat(role: InitSeatProbe["role"], caps: Partial<CapabilityInfo>): InitSeatProbe {
  return {
    role,
    label: role,
    display: `seat-${role}`,
    probe: {
      available: true,
      capabilities: { found: false, vision: false, reasoning: false, contextLimit: null, ...caps },
    },
  };
}

describe("initRailheadConfig", () => {
  it("writes default seats for all five roles and leaves extract null", () => {
    const cfg = initRailheadConfig(
      { plan: "default", implement: "default", review: "default", visual: "default", goal: "default" },
      230000,
    );
    expect(cfg.model).toEqual({
      plan: "default",
      implement: "default",
      review: "default",
      visual: "default",
      goal: "default",
      extract: null,
    });
    expect(cfg.max_context_tokens).toBe(230000);
  });

  it("writes concrete ids verbatim into their seats", () => {
    const cfg = initRailheadConfig(
      { plan: "deepseek/deepseek-v4-pro", implement: "deepseek/deepseek-v4-pro", review: "neuralwatt/gemma-4-31b", visual: "neuralwatt/gemma-4-31b", goal: "deepseek/deepseek-v4-pro" },
      100000,
    );
    expect(cfg.model.visual).toBe("neuralwatt/gemma-4-31b");
    expect(cfg.model.goal).toBe("deepseek/deepseek-v4-pro");
  });

  it("never stores visual/goal as null even though their gates default off", () => {
    const cfg = initRailheadConfig(
      { plan: "default", implement: "default", review: "default", visual: "default", goal: "default" },
      230000,
    );
    expect(cfg.model.visual).not.toBeNull();
    expect(cfg.model.goal).not.toBeNull();
  });

  it("writes infra-only cadence defaults: every review gate off (v2 issue 01)", () => {
    const cfg = initRailheadConfig(
      { plan: "default", implement: "default", review: "default", visual: "default", goal: "default" },
      230000,
    );
    expect(cfg.code_review?.mode).toBe("off");
    expect(cfg.visual_review?.mode).toBe("off");
    expect(cfg.goal_review?.mode).toBe("off");
    expect(cfg.structural_review?.mode).toBe("off");
  });
});

describe("minDetectedContext", () => {
  it("returns the smallest detected context across seats (the bottleneck)", () => {
    const seats = [
      seat("plan", { contextLimit: 200000 }),
      seat("visual", { contextLimit: 32000 }),
      seat("goal", { contextLimit: null }),
    ];
    expect(minDetectedContext(seats)).toBe(32000);
  });

  it("returns null when no seat's context limit was detected", () => {
    expect(minDetectedContext([seat("plan", { contextLimit: null }), seat("goal", { contextLimit: null })])).toBeNull();
  });
});

describe("contextOverrideWarnings", () => {
  it("warns when the budget is raised above a detected seat limit (informational)", () => {
    const seats = [seat("visual", { contextLimit: 32000 })];
    const w = contextOverrideWarnings(seats, 100000);
    expect(w).toContainEqual(expect.stringMatching(/visual model.*32k context limit.*unstable/));
  });

  it("is silent at or below every detected limit", () => {
    const seats = [seat("plan", { contextLimit: 32000 }), seat("goal", { contextLimit: 200000 })];
    expect(contextOverrideWarnings(seats, 32000)).toEqual([]);
  });

  it("ignores seats whose context limit is unknown", () => {
    const seats = [seat("plan", { contextLimit: null })];
    expect(contextOverrideWarnings(seats, 100000)).toEqual([]);
  });
});

describe("visionCapabilityWarnings", () => {
  it("warns for a found non-vision visual seat — informational, never a gate", () => {
    const w = visionCapabilityWarnings([seat("visual", { found: true, vision: false })]);
    expect(w).toContainEqual(expect.stringMatching(/visual model.*not vision-capable.*visual review will run/));
  });

  it("warns for a found non-vision goal seat", () => {
    const w = visionCapabilityWarnings([seat("goal", { found: true, vision: false })]);
    expect(w).toContainEqual(expect.stringMatching(/goal model.*not vision-capable.*goal review will run/));
  });

  it("is silent when the oversight seat is vision-capable", () => {
    expect(visionCapabilityWarnings([seat("visual", { found: true, vision: true })])).toEqual([]);
  });

  it("never claims vision-blindness for a model absent from the registry (unknown ≠ no)", () => {
    expect(visionCapabilityWarnings([seat("visual", { found: false, vision: false })])).toEqual([]);
    expect(visionCapabilityWarnings([seat("goal", { found: false, vision: false })])).toEqual([]);
  });

  it("never warns for the core seats (plan/implement/review) regardless of vision", () => {
    expect(visionCapabilityWarnings([seat("plan", { found: true, vision: false })])).toEqual([]);
    expect(visionCapabilityWarnings([seat("review", { found: true, vision: false })])).toEqual([]);
  });
});
