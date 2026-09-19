import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  fixModeForcesVisual,
  resolveGateModes,
  resolveTdd,
  resolveYolo,
  persistPolicy,
  GATES,
} from "./run-policy.ts";
import { loadConfig, presetGateModes } from "./config.ts";
import type { GateOverrides } from "./args.ts";

const emptyOverrides: GateOverrides = { code: null, visual: null, goal: null, structural: null };

async function makeCwd(body: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "policy-"));
  if (body !== null) {
    await writeFile(join(dir, "railhead.json"), body, "utf8");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// fixModeForcesVisual
// ---------------------------------------------------------------------------

describe("fixModeForcesVisual", () => {
  it("forces when fix mode, visual enabled, and a vision model exists", () => {
    expect(fixModeForcesVisual(true, true, true)).toBe(true);
  });

  it("does not force outside fix mode, with visual off, or without a vision model", () => {
    expect(fixModeForcesVisual(false, true, true)).toBe(false);
    expect(fixModeForcesVisual(true, false, true)).toBe(false);
    expect(fixModeForcesVisual(true, true, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveGateModes — resolver matrix
// ---------------------------------------------------------------------------

describe("resolveGateModes", () => {
  it("defaults to the light preset when no preset and no overrides are given", () => {
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides, fixMode: false, hasVisionModel: true, visualEnabled: true });
    expect(modes).toEqual(presetGateModes("light"));
  });

  it("uses the given preset as the base", () => {
    for (const preset of ["full", "medium", "light", "none"] as const) {
      const modes = resolveGateModes({ preset, overrides: emptyOverrides, fixMode: false, hasVisionModel: true, visualEnabled: true });
      expect(modes).toEqual(presetGateModes(preset));
    }
  });

  it("lays CLI overrides on top of the preset", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: { code: null, visual: "full", goal: null, structural: "off" },
      fixMode: false,
      hasVisionModel: true,
      visualEnabled: true,
    });
    expect(modes.visual).toBe("full");
    expect(modes.structural).toBe("off");
    expect(modes.code).toBe("light");
  });

  it("forces visual full in fix mode when visual is enabled and a vision model exists", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: { code: null, visual: "off", goal: null, structural: null },
      fixMode: true,
      hasVisionModel: true,
      visualEnabled: true,
    });
    expect(modes.visual).toBe("full");
  });

  it("does not force visual full in fix mode when the user disabled visual review", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: emptyOverrides,
      fixMode: true,
      hasVisionModel: true,
      visualEnabled: false,
    });
    expect(modes.visual).toBe("light");
  });

  it("does not force visual full when no vision model is configured", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: emptyOverrides,
      fixMode: true,
      hasVisionModel: false,
      visualEnabled: true,
    });
    expect(modes.visual).toBe("light");
  });

  it("uses the interactive questionnaire answer instead of the preset base", () => {
    const answer = { modes: { code: "medium" as const, visual: "off" as const, goal: "off" as const, structural: "off" as const }, skipAll: false };
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides, fixMode: false, hasVisionModel: true, visualEnabled: true, answer });
    expect(modes).toEqual({ code: "medium", visual: "off", goal: "off", structural: "off" });
  });

  it("turns everything off when the questionnaire answered skip-all", () => {
    const answer = { modes: presetGateModes("medium"), skipAll: true };
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides, fixMode: false, hasVisionModel: true, visualEnabled: true, answer });
    expect(modes).toEqual(presetGateModes("none"));
  });

  it("still forces visual full in fix mode even after a skip-all questionnaire answer", () => {
    const answer = { modes: presetGateModes("medium"), skipAll: true };
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides, fixMode: true, hasVisionModel: true, visualEnabled: true, answer });
    expect(modes).toEqual({ ...presetGateModes("none"), visual: "full" });
  });

  it("goal mode light resolves the advisory checkpoint action (ADR 0029)", () => {
    const modes = resolveGateModes({ preset: "light", overrides: emptyOverrides, fixMode: false, hasVisionModel: true, visualEnabled: true });
    expect(modes.goal).toBe("light");
    expect(modes.goalCheckpointAction).toBe("advisory");
  });

  it("an override off goal light drops the advisory action (no stale knob under medium)", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: { code: null, visual: null, goal: "medium", structural: null },
      fixMode: false, hasVisionModel: true, visualEnabled: true,
    });
    expect(modes.goal).toBe("medium");
    expect(modes.goalCheckpointAction).toBeUndefined();
  });

  it("medium/full presets never set the advisory action", () => {
    expect(resolveGateModes({ preset: "medium", overrides: emptyOverrides, fixMode: false, hasVisionModel: true, visualEnabled: true }).goalCheckpointAction).toBeUndefined();
    expect(resolveGateModes({ preset: "full", overrides: emptyOverrides, fixMode: false, hasVisionModel: true, visualEnabled: true }).goalCheckpointAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveTdd — decision table + both ask-defaults
// ---------------------------------------------------------------------------

describe("resolveTdd", () => {
  it("the --tdd/--no-tdd flag wins over everything", () => {
    expect(resolveTdd({ flag: true, mode: "fix", preset: "light", auto: false, askDefault: false })).toBe(true);
    expect(resolveTdd({ flag: false, mode: "build", preset: "full", auto: false, askDefault: false })).toBe(false);
  });

  it("fix mode forces the test phase off", () => {
    expect(resolveTdd({ flag: null, mode: "fix", preset: "full", auto: false, askDefault: false })).toBe(false);
  });

  it("a preset decides when not interactive", () => {
    expect(resolveTdd({ flag: null, mode: "build", preset: "full", auto: false, askDefault: false })).toBe(true);
    expect(resolveTdd({ flag: null, mode: "build", preset: "light", auto: true, askDefault: false })).toBe(false);
    // auto with no preset = the light preset's off
    expect(resolveTdd({ flag: null, mode: "build", preset: null, auto: true, askDefault: false })).toBe(false);
  });

  it("interactive (no flag, no preset, not auto) returns the answer", () => {
    expect(resolveTdd({ flag: null, mode: "build", preset: null, auto: false, askDefault: false, answer: true })).toBe(true);
    expect(resolveTdd({ flag: null, mode: "build", preset: null, auto: false, askDefault: false, answer: false })).toBe(false);
  });

  it("the plan ask-default is encoded as false (not the persisted config)", () => {
    // Empty input on the plan-time prompt keeps the test phase off even when
    // the persisted config has it on — the plan default is false.
    expect(resolveTdd({ flag: null, mode: "build", preset: null, auto: false, askDefault: false })).toBe(false);
    expect(resolveTdd({ flag: null, mode: "build", preset: null, auto: false, askDefault: true })).toBe(true);
  });

  it("the standalone-run ask-default is the persisted config, not false", () => {
    // A standalone `railhead run` that leaves the prompt empty keeps whatever
    // test_phase the persisted config already carries.
    expect(resolveTdd({ flag: null, mode: "build", preset: null, auto: false, askDefault: true })).toBe(true);
    expect(resolveTdd({ flag: null, mode: "build", preset: null, auto: false, askDefault: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveYolo
// ---------------------------------------------------------------------------

describe("resolveYolo", () => {
  it("the flag or persisted config decides without asking", () => {
    expect(resolveYolo({ flag: true, configValue: false })).toBe(true);
    expect(resolveYolo({ flag: false, configValue: true })).toBe(true);
    expect(resolveYolo({ flag: false, configValue: false })).toBe(false);
  });

  it("the interactive answer turns it on", () => {
    expect(resolveYolo({ flag: false, configValue: false, answer: true })).toBe(true);
    expect(resolveYolo({ flag: false, configValue: false, answer: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// persistPolicy — compare-then-persist diffing
// ---------------------------------------------------------------------------

async function readRaw(cwd: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8")) as Record<string, unknown>;
}

describe("persistPolicy", () => {
  it("persists a gate mode only when it differs from the persisted value", async () => {
    const cwd = await makeCwd(JSON.stringify({ code_review: { mode: "light" } }));
    const config = await loadConfig(cwd);

    const unchanged = await persistPolicy(cwd, config, { gateModes: { code: "light" } });
    expect(unchanged.gatesChanged).toEqual([]);
    expect((await readRaw(cwd)).code_review).toEqual({ mode: "light" });

    const changed = await persistPolicy(cwd, config, { gateModes: { code: "full" } });
    expect(changed.gatesChanged).toEqual(["code"]);
    const raw = await readRaw(cwd);
    expect(raw.code_review).toEqual({ mode: "full" });
    expect(config.code_review?.mode).toBe("full");
  });

  it("preserves unknown sibling keys inside a gate object when writing its mode", async () => {
    const cwd = await makeCwd(JSON.stringify({ visual_review: { mode: "off", max_rounds: 2, custom: "keep" } }));
    const config = await loadConfig(cwd);
    await persistPolicy(cwd, config, { gateModes: { visual: "light" } });
    const raw = await readRaw(cwd);
    expect(raw.visual_review).toEqual({ mode: "light", max_rounds: 2, custom: "keep" });
  });

  it("persists test_phase only when it differs (undefined counts as on)", async () => {
    const cwd = await makeCwd(JSON.stringify({ test_phase: false }));
    const config = await loadConfig(cwd);

    const same = await persistPolicy(cwd, config, { testPhase: false });
    expect(same.testPhaseChanged).toBe(false);
    expect((await readRaw(cwd)).test_phase).toBe(false);

    const on = await persistPolicy(cwd, config, { testPhase: true });
    expect(on.testPhaseChanged).toBe(true);
    expect(config.test_phase).toBe(true);
  });

  it("persists yolo_permissions / fix_mode only when they change", async () => {
    const cwd = await makeCwd(JSON.stringify({}));
    const config = await loadConfig(cwd);
    await persistPolicy(cwd, config, { yolo: true, fixMode: true });
    expect((await readRaw(cwd)).yolo_permissions).toBe(true);
    expect((await readRaw(cwd)).fix_mode).toBe(true);

    // second call with the same decision is a no-op write
    await persistPolicy(cwd, config, { yolo: true, fixMode: true });
    const raw = await readRaw(cwd);
    expect(raw.yolo_permissions).toBe(true);
    expect(raw.fix_mode).toBe(true);
  });

  it("leaves decisions that were not provided untouched", async () => {
    const cwd = await makeCwd(JSON.stringify({ test_phase: true, code_review: { mode: "full" }, unknown_key: 7 }));
    const config = await loadConfig(cwd);
    await persistPolicy(cwd, config, { gateModes: { code: "light" } });
    const raw = await readRaw(cwd);
    expect(raw.unknown_key).toBe(7);
    expect(raw.test_phase).toBe(true);
    expect(raw.code_review).toEqual({ mode: "light" });
  });

  describe("goal checkpoint action (ADR 0029, #102)", () => {
    it("a goal gate resolved to light persists goal_review.checkpoint_action: advisory", async () => {
      const cwd = await makeCwd(JSON.stringify({ goal_review: { mode: "light" } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { gateModes: { goal: "light" } });
      const raw = await readRaw(cwd);
      expect(raw.goal_review).toEqual({ mode: "light", checkpoint_action: "advisory" });
      expect(config.goal_review?.checkpoint_action).toBe("advisory");
    });

    it("moving the goal gate off light clears a stale advisory knob (replan to medium/full)", async () => {
      const cwd = await makeCwd(JSON.stringify({ goal_review: { mode: "light", checkpoint_action: "advisory" } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { gateModes: { goal: "medium" } });
      const raw = await readRaw(cwd);
      expect(raw.goal_review).toEqual({ mode: "medium" });
      expect(config.goal_review?.checkpoint_action).toBeUndefined();
    });

    it("no goal decision leaves the knob untouched (power-user hand config survives a plain run)", async () => {
      const cwd = await makeCwd(JSON.stringify({ goal_review: { mode: "medium", checkpoint_action: "advisory" } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { gateModes: { code: "light" } });
      const raw = await readRaw(cwd);
      expect(raw.goal_review).toEqual({ mode: "medium", checkpoint_action: "advisory" });
    });

    it("sibling keys survive the knob write", async () => {
      const cwd = await makeCwd(JSON.stringify({ goal_review: { mode: "light", max_rounds: 5 } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { gateModes: { goal: "light" } });
      const raw = await readRaw(cwd);
      expect(raw.goal_review).toEqual({ mode: "light", checkpoint_action: "advisory", max_rounds: 5 });
    });
  });
});

// GATES is consumed by cmdRun logging; ensure it stays aligned with the four gates.
describe("GATES", () => {
  it("maps every gate to its railhead.json key", () => {
    expect(GATES).toEqual([
      ["code", "code_review"],
      ["visual", "visual_review"],
      ["goal", "goal_review"],
      ["structural", "structural_review"],
    ]);
  });
});
