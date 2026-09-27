import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  hasGateOverrides,
  resolveGateModes,
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
// hasGateOverrides
// ---------------------------------------------------------------------------

describe("hasGateOverrides", () => {
  // The parser fills every absent flag with null, never undefined (parseGateMode
  // returns null for absent/unrecognized). A `!== undefined` check therefore read
  // "no preset" interactive runs as fully overridden and silently skipped the
  // per-gate questionnaire.
  it("is false when every gate parsed to null (no flag given)", () => {
    expect(hasGateOverrides(emptyOverrides)).toBe(false);
  });

  it("is false for undefined entries (hand-built partial overrides)", () => {
    expect(hasGateOverrides({})).toBe(false);
  });

  it("is true when any single gate carries a mode", () => {
    for (const gate of ["code", "visual", "goal", "structural"] as const) {
      expect(hasGateOverrides({ ...emptyOverrides, [gate]: "off" })).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveGateModes — resolver matrix
// ---------------------------------------------------------------------------

describe("resolveGateModes", () => {
  it("defaults to the light preset when no preset and no overrides are given", () => {
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides });
    expect(modes).toEqual(presetGateModes("light"));
  });

  it("uses the given preset as the base", () => {
    for (const preset of ["full", "medium", "light", "none"] as const) {
      const modes = resolveGateModes({ preset, overrides: emptyOverrides });
      expect(modes).toEqual(presetGateModes(preset));
    }
  });

  it("lays CLI overrides on top of the preset", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: { code: null, visual: "full", goal: null, structural: "off" },
    });
    expect(modes.visual).toBe("full");
    expect(modes.structural).toBe("off");
    expect(modes.code).toBe("medium");
  });

  it("uses the interactive questionnaire answer instead of the preset base", () => {
    const answer = { modes: { code: "medium" as const, visual: "off" as const, goal: "off" as const, structural: "off" as const }, skipAll: false };
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides, answer });
    expect(modes).toEqual({ code: "medium", visual: "off", goal: "off", structural: "off" });
  });

  it("turns everything off when the questionnaire answered skip-all", () => {
    const answer = { modes: presetGateModes("medium"), skipAll: true };
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides, answer });
    expect(modes).toEqual(presetGateModes("none"));
  });

  it("goal mode light resolves the corrective checkpoint action (v2 issue 01)", () => {
    const modes = resolveGateModes({ preset: "light", overrides: emptyOverrides });
    expect(modes.goal).toBe("light");
    expect(modes.goalCheckpointAction).toBe("corrective");
  });

  it("an override off goal light drops the checkpoint action (no stale knob under medium)", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: { code: null, visual: null, goal: "medium", structural: null },
    });
    expect(modes.goal).toBe("medium");
    expect(modes.goalCheckpointAction).toBeUndefined();
  });

  it("medium/full presets never set the checkpoint action", () => {
    expect(resolveGateModes({ preset: "medium", overrides: emptyOverrides }).goalCheckpointAction).toBeUndefined();
    expect(resolveGateModes({ preset: "full", overrides: emptyOverrides }).goalCheckpointAction).toBeUndefined();
  });

  it("the light preset resolves the smart code trigger; the other presets resolve `always`", () => {
    expect(resolveGateModes({ preset: "light", overrides: emptyOverrides }).codeTrigger).toBe("smart");
    expect(resolveGateModes({ preset: "medium", overrides: emptyOverrides }).codeTrigger).toBeUndefined();
    expect(resolveGateModes({ preset: "full", overrides: emptyOverrides }).codeTrigger).toBeUndefined();
    expect(resolveGateModes({ preset: "none", overrides: emptyOverrides }).codeTrigger).toBeUndefined();
  });

  it("an explicit --review override resets the smart trigger to always", () => {
    const modes = resolveGateModes({
      preset: "light",
      overrides: { code: "medium", visual: null, goal: null, structural: null },
    });
    expect(modes.code).toBe("medium");
    expect(modes.codeTrigger).toBe("always");
  });

  it("a questionnaire answer carrying the smart trigger survives resolution", () => {
    const answer = {
      modes: { code: "medium" as const, codeTrigger: "smart" as const, visual: "off" as const, goal: "off" as const, structural: "off" as const },
      skipAll: false,
    };
    const modes = resolveGateModes({ preset: null, overrides: emptyOverrides, answer });
    expect(modes.codeTrigger).toBe("smart");
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

  it("persists yolo_permissions / fix_mode / feature_mode only when they change", async () => {
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

    await persistPolicy(cwd, config, { featureMode: true });
    const after = await readRaw(cwd);
    expect(after.feature_mode).toBe(true);
    expect((await loadConfig(cwd)).feature_mode).toBe(true);
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

  describe("goal checkpoint action (v2 issue 01, ADR 0029)", () => {
    it("a goal gate resolved to light persists goal_review.checkpoint_action: corrective", async () => {
      const cwd = await makeCwd(JSON.stringify({ goal_review: { mode: "light" } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { gateModes: { goal: "light" } });
      const raw = await readRaw(cwd);
      expect(raw.goal_review).toEqual({ mode: "light", checkpoint_action: "corrective" });
      expect(config.goal_review?.checkpoint_action).toBe("corrective");
    });

    it("moving the goal gate off light clears a stale checkpoint-action knob (replan to medium/full)", async () => {
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
      expect(raw.goal_review).toEqual({ mode: "light", checkpoint_action: "corrective", max_rounds: 5 });
    });
  });

  describe("code review trigger (smart review)", () => {
    it("persists code_review.trigger when it differs, preserving sibling keys", async () => {
      const cwd = await makeCwd(JSON.stringify({ code_review: { mode: "medium", inherit_tools: false } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { codeReviewTrigger: "smart" });
      expect((await readRaw(cwd)).code_review).toEqual({ mode: "medium", inherit_tools: false, trigger: "smart" });
      expect(config.code_review?.trigger).toBe("smart");
    });

    it("a re-plan off smart clears the trigger back to always (medium/full cannot inherit skipping)", async () => {
      const cwd = await makeCwd(JSON.stringify({ code_review: { mode: "medium", trigger: "smart" } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { gateModes: { code: "medium" }, codeReviewTrigger: "always" });
      expect((await readRaw(cwd)).code_review).toEqual({ mode: "medium", trigger: "always" });
      expect(config.code_review?.trigger).toBe("always");
    });

    it("no trigger decision leaves a hand-written trigger untouched", async () => {
      const cwd = await makeCwd(JSON.stringify({ code_review: { mode: "medium", trigger: "smart" } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { gateModes: { code: "medium" } });
      expect((await readRaw(cwd)).code_review).toEqual({ mode: "medium", trigger: "smart" });
    });

    it("an unchanged trigger is a no-op write", async () => {
      const cwd = await makeCwd(JSON.stringify({ code_review: { mode: "medium", trigger: "smart" } }));
      const config = await loadConfig(cwd);
      await persistPolicy(cwd, config, { codeReviewTrigger: "smart" });
      expect((await readRaw(cwd)).code_review).toEqual({ mode: "medium", trigger: "smart" });
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
