import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { applyModelOverrides, DEFAULT_CONFIG, DEFAULT_CONTEXT_TOKENS, DEFAULT_INFRA_BACKOFF_SEC, DEFAULT_MAX_STEP_MODEL_SEC, DEFAULT_MODEL, DEFAULT_STALL_TIMEOUT_SEC, effectiveContextTokens, goalCheckpointActionFor, goalCheckpointIsAdvisory, goalFiresCheckpointsMidRun, interactionSmokeEnabled, loadConfig, parseCheckpointGranularity, parseGoalCheckpointAction, presetGateModes, resolveModels, parseModelContextLimit, seatContextBudget, seatContextCeilings, updateConfig, warnIfOversightModelIsLocal } from "./config.ts";

async function makeCwd(body: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"));
  if (body !== null) {
    await writeFile(join(dir, "railhead.json"), body, "utf8");
  }
  return dir;
}

describe("DEFAULT_STALL_TIMEOUT_SEC (#55)", () => {
  it("is a finite one-hour default, never null", () => {
    expect(DEFAULT_STALL_TIMEOUT_SEC).toBe(3600);
    expect(DEFAULT_CONFIG.stall_timeout_sec).toBe(3600);
    expect(Number.isFinite(DEFAULT_CONFIG.stall_timeout_sec)).toBe(true);
  });
});

describe("DEFAULT_CONTEXT_TOKENS (#79)", () => {
  it("defaults to ADR 0014's 64k working budget, not the 100k full-model window", () => {
    // Issue #79: the guard compared against a 100k default that matched the
    // whole detected model window, so it fired only after the phase had
    // already pushed the server toward its capacity wall. The default regime
    // must match ADR 0014's 64k operating point instead.
    expect(DEFAULT_CONTEXT_TOKENS).toBe(64_000);
  });
});

describe("DEFAULT_INFRA_BACKOFF_SEC", () => {
  it("waits minutes between the ladder's two retries, not seconds", () => {
    // A deliberately restarted model server is down for minutes. The old
    // 5s/15s waits let all three attempts land inside the outage and hard-fail
    // a healthy run; the default must give the server time to come back.
    expect(DEFAULT_INFRA_BACKOFF_SEC[0]).toBe(60);
    expect(DEFAULT_INFRA_BACKOFF_SEC[1]).toBe(300);
    expect(DEFAULT_CONFIG.infra_backoff_sec).toEqual(DEFAULT_INFRA_BACKOFF_SEC);
  });
});

describe("dependency_source_deny", () => {
  it("defaults to an empty list", async () => {
    expect(DEFAULT_CONFIG.dependency_source_deny).toEqual([]);
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.dependency_source_deny).toEqual([]);
  });

  it("loads the project's deny globs verbatim and drops non-strings", async () => {
    const cfg = await loadConfig(await makeCwd('{"dependency_source_deny":["*/.cargo/registry/src/*",42]}'));
    expect(cfg.dependency_source_deny).toEqual(["*/.cargo/registry/src/*"]);
  });
});

describe("max_step_model_sec (#78)", () => {
  it("defaults to 3600 in the resolved config", async () => {
    expect(DEFAULT_MAX_STEP_MODEL_SEC).toBe(3600);
    expect(DEFAULT_CONFIG.max_step_model_sec).toBe(3600);
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.max_step_model_sec).toBe(3600);
  });

  it("loads a max_step_model_sec override", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_step_model_sec":300}'));
    expect(cfg.max_step_model_sec).toBe(300);
  });

  it("treats an explicit max_step_model_sec: null as disabled, not the default", async () => {
    // Unlike stall_timeout_sec (where null resolves to the default so stall
    // detection is never silently off), a null max_step_model_sec means the
    // user wants silence-only detection and must survive the merge.
    const cfg = await loadConfig(await makeCwd('{"max_step_model_sec":null}'));
    expect(cfg.max_step_model_sec).toBeNull();
  });

  it("treats max_step_model_sec: 0 as disabled", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_step_model_sec":0}'));
    expect(cfg.max_step_model_sec).toBe(0);
  });
});

describe("loadConfig", () => {
  it("returns defaults with no railhead.json", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("fills missing keys from defaults", async () => {
    const cfg = await loadConfig(await makeCwd('{"verify":["npm test"]}'));
    expect(cfg.verify).toEqual(["npm test"]);
    expect(cfg.max_retries).toBe(DEFAULT_CONFIG.max_retries);
  });

  it("reads the declared interaction interface (issue #97)", async () => {
    expect((await loadConfig(await makeCwd('{"interface":"browser-ui"}'))).projectInterface).toBe("browser-ui");
    expect((await loadConfig(await makeCwd('{"interface":"canvas"}'))).projectInterface).toBe("canvas");
    expect((await loadConfig(await makeCwd('{"interface":"none"}'))).projectInterface).toBe("none");
    expect((await loadConfig(await makeCwd('{"interface":"TERMINAL"}'))).projectInterface).toBe("terminal");
  });

  it("leaves the interface undeclared when absent or empty (#97)", async () => {
    expect((await loadConfig(await makeCwd('{"verify":["npm test"]}'))).projectInterface).toBeNull();
    expect((await loadConfig(await makeCwd('{"interface":""}'))).projectInterface).toBeNull();
    expect((await loadConfig(await makeCwd(null))).projectInterface).toBeUndefined();
  });

  it("throws on an unknown declared interface rather than silently coercing (#97)", async () => {
    await expect(loadConfig(await makeCwd('{"interface":"desktop"}'))).rejects.toThrow(/unknown value "desktop"/);
  });

  it("defaults fix_mode to false (#6)", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.fix_mode).toBe(false);
  });

  it("defaults art_direction to true and reads an explicit false (option c)", async () => {
    expect((await loadConfig(await makeCwd(null))).art_direction).toBe(true);
    expect((await loadConfig(await makeCwd('{"art_direction":false}'))).art_direction).toBe(false);
    expect((await loadConfig(await makeCwd('{"art_direction":true}'))).art_direction).toBe(true);
  });

  it("reads fix_mode: true from railhead.json (#6)", async () => {
    const cfg = await loadConfig(await makeCwd('{"fix_mode":true}'));
    expect(cfg.fix_mode).toBe(true);
  });

  it("defaults feature_mode to false and reads an explicit true (ADR 0051)", async () => {
    expect((await loadConfig(await makeCwd(null))).feature_mode).toBe(false);
    expect((await loadConfig(await makeCwd('{"feature_mode":true}'))).feature_mode).toBe(true);
  });

  it("defaults persistent_worker to false (ADR 0020; #39 telemetry: measured cross-session KV reuse was ~2k tokens)", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.persistent_worker).toBe(false);
  });

  it("reads persistent_worker: true from railhead.json (#39)", async () => {
    const cfg = await loadConfig(await makeCwd('{"persistent_worker":true}'));
    expect(cfg.persistent_worker).toBe(true);
  });

  it("reads persistent_worker: false from railhead.json to opt out (#39)", async () => {
    const cfg = await loadConfig(await makeCwd('{"persistent_worker":false}'));
    expect(cfg.persistent_worker).toBe(false);
  });

  it("loads max_context_tokens", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_context_tokens":32768}'));
    expect(cfg.max_context_tokens).toBe(32768);
  });

  it("accepts request_ceiling_tokens as the primary key, resolving into max_context_tokens", async () => {
    const cfg = await loadConfig(await makeCwd('{"request_ceiling_tokens":50000}'));
    expect(cfg.max_context_tokens).toBe(50000);
  });

  it("prefers request_ceiling_tokens over the legacy max_context_tokens alias", async () => {
    const cfg = await loadConfig(await makeCwd('{"request_ceiling_tokens":50000,"max_context_tokens":32768}'));
    expect(cfg.max_context_tokens).toBe(50000);
  });

  it("loads max_attempts override", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_attempts":12}'));
    expect(cfg.max_attempts).toBe(12);
  });

  it("loads max_phase_steps override", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_phase_steps":10}'));
    expect(cfg.max_phase_steps).toBe(10);
  });

  it("defaults max_phase_steps to 120", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.max_phase_steps).toBe(120);
  });

  it("scales max_phase_steps from max_context_tokens (64k → 120, floored)", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_context_tokens":64000}'));
    expect(cfg.max_phase_steps).toBe(120);
  });

  it("scales max_phase_steps from max_context_tokens (128k → 128)", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_context_tokens":128000}'));
    expect(cfg.max_phase_steps).toBe(128);
  });

  it("scales max_phase_steps from max_context_tokens (250k → 250)", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_context_tokens":250000}'));
    expect(cfg.max_phase_steps).toBe(250);
  });

  it("explicit max_phase_steps overrides scaling even with context budget set", async () => {
    const cfg = await loadConfig(await makeCwd('{"max_context_tokens":250000,"max_phase_steps":30}'));
    expect(cfg.max_phase_steps).toBe(30);
  });

  it("loads verify_timeout_sec override", async () => {
    const cfg = await loadConfig(await makeCwd('{"verify_timeout_sec":120}'));
    expect(cfg.verify_timeout_sec).toBe(120);
  });

  it("loads stall_timeout_sec override", async () => {
    const cfg = await loadConfig(await makeCwd('{"stall_timeout_sec":300}'));
    expect(cfg.stall_timeout_sec).toBe(300);
  });

  it("defaults verify_timeout_sec to null but stall_timeout_sec to 3600 (#55)", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.verify_timeout_sec).toBeNull();
    expect(cfg.stall_timeout_sec).toBe(3600);
  });

  it("resolves an explicit stall_timeout_sec: null to the 3600s default, never Infinity (#55)", async () => {
    // A null stall_timeout_sec used to propagate into the executor as
    // Infinity, disabling stall detection entirely (a hung implementer ran
    // for 27 minutes). The resolved config must always be finite.
    const cfg = await loadConfig(await makeCwd('{"stall_timeout_sec":null}'));
    expect(cfg.stall_timeout_sec).toBe(3600);
  });

  it("respects an explicit stall_timeout_sec: 0 as a deliberate disable (#55)", async () => {
    const cfg = await loadConfig(await makeCwd('{"stall_timeout_sec":0}'));
    expect(cfg.stall_timeout_sec).toBe(0);
  });

  it("defaults the ADR 0040 block knobs: null budgets (derive) and on_block continue", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.ticket_step_budget).toBeNull();
    expect(cfg.ticket_wall_sec).toBeNull();
    expect(cfg.on_block).toBe("continue");
  });

  it("loads explicit ADR 0040 budgets and preserves an explicit 0 as disabled", async () => {
    const cfg = await loadConfig(await makeCwd('{"ticket_step_budget":40,"ticket_wall_sec":1800,"on_block":"pause"}'));
    expect(cfg.ticket_step_budget).toBe(40);
    expect(cfg.ticket_wall_sec).toBe(1800);
    expect(cfg.on_block).toBe("pause");
    const off = await loadConfig(await makeCwd('{"ticket_step_budget":0,"ticket_wall_sec":0}'));
    expect(off.ticket_step_budget).toBe(0);
    expect(off.ticket_wall_sec).toBe(0);
  });

  it("an unrecognized on_block value falls back to continue (never an unknown route)", async () => {
    const cfg = await loadConfig(await makeCwd('{"on_block":"halt"}'));
    expect(cfg.on_block).toBe("continue");
  });

  it("defaults context_guard to telemetry and accepts an explicit kill; a typo falls back to telemetry (ADR 0014 amendment)", async () => {
    const dflt = await loadConfig(await makeCwd(null));
    expect(dflt.context_guard).toBe("telemetry");
    const kill = await loadConfig(await makeCwd('{"context_guard":"kill"}'));
    expect(kill.context_guard).toBe("kill");
    // A typo must not silently arm a kill switch.
    const typo = await loadConfig(await makeCwd('{"context_guard":"kll"}'));
    expect(typo.context_guard).toBe("telemetry");
  });

  it("loads sharpen_max_rounds override", async () => {
    const cfg = await loadConfig(await makeCwd('{"sharpen_max_rounds":3}'));
    expect(cfg.sharpen_max_rounds).toBe(3);
  });

  it("defaults sharpen_max_rounds to 6", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.sharpen_max_rounds).toBe(6);
  });

  it("allows sharpen_max_rounds: 0 to disable the planning interview", async () => {
    const cfg = await loadConfig(await makeCwd('{"sharpen_max_rounds":0}'));
    expect(cfg.sharpen_max_rounds).toBe(0);
  });

  it("reads the legacy grill_max_rounds key as a fallback (compat with pre-rename railhead.json files)", async () => {
    const cfg = await loadConfig(await makeCwd('{"grill_max_rounds":4}'));
    expect(cfg.sharpen_max_rounds).toBe(4);
  });

  it("prefers sharpen_max_rounds over the legacy grill_max_rounds when both are present", async () => {
    const cfg = await loadConfig(await makeCwd('{"sharpen_max_rounds":7,"grill_max_rounds":4}'));
    expect(cfg.sharpen_max_rounds).toBe(7);
  });

  it("tolerates a malformed file", async () => {
    const cfg = await loadConfig(await makeCwd("{ nope"));
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("defaults code_review to off (v2 issue 01 — light/medium presets stop scheduling per-ticket review)", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.code_review?.mode).toBe("off");
    expect(cfg.visual_review?.mode).toBe("off");
    expect(cfg.goal_review?.mode).toBe("off");
    expect(cfg.structural_review?.mode).toBe("off");
  });

  it("defaults code_review.inherit_tools to true (the reviewer runs on the ordinary tool-bearing seat like every other gate)", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.code_review?.inherit_tools).toBe(true);
  });

  it("preserves code_review.inherit_tools: false (restores the isolated tool-denied reviewer)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ code_review: { mode: "full", inherit_tools: false } })));
    expect(cfg.code_review?.inherit_tools).toBe(false);
  });

  it("reads code_review.mode / visual_review.mode / goal_review.mode / structural_review.mode (#73)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({
      code_review: { mode: "full" },
      visual_review: { mode: "light", max_rounds: 2 },
      goal_review: { mode: "medium", fallback_cadence: 3 },
      structural_review: { mode: "full" },
    })));
    expect(cfg.code_review?.mode).toBe("full");
    expect(cfg.visual_review?.mode).toBe("light");
    expect(cfg.visual_review?.max_rounds).toBe(2);
    expect(cfg.goal_review?.mode).toBe("medium");
    expect(cfg.goal_review?.fallback_cadence).toBe(3);
    expect(cfg.structural_review?.mode).toBe("full");
  });

  it("falls back to the default mode for an unrecognised gate-mode token (#73)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ code_review: { mode: "advisory" }, visual_review: { mode: "bogus" } })));
    expect(cfg.code_review?.mode).toBe("off");
    expect(cfg.visual_review?.mode).toBe("off");
  });

  it("maps the legacy visual_review { enabled, per_ticket } shape onto a mode (#73)", async () => {
    const on = await loadConfig(await makeCwd(JSON.stringify({ visual_review: { enabled: true } })));
    expect(on.visual_review?.mode).toBe("full");
    const endOnly = await loadConfig(await makeCwd(JSON.stringify({ visual_review: { enabled: true, per_ticket: false } })));
    expect(endOnly.visual_review?.mode).toBe("light");
    const off = await loadConfig(await makeCwd(JSON.stringify({ visual_review: { enabled: false, per_ticket: true } })));
    expect(off.visual_review?.mode).toBe("off");
  });

  it("reads visual_review.round_wall_sec (#96) and defaults it to null (the loop resolves the one-hour safety net)", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.visual_review?.round_wall_sec).toBeNull();
    const set = await loadConfig(await makeCwd(JSON.stringify({ visual_review: { mode: "full", round_wall_sec: 1800 } })));
    expect(set.visual_review?.round_wall_sec).toBe(1800);
  });

  it("preserves an explicit visual_review.round_wall_sec: 0 as disabled (#96 — 0 must survive ??, unlike an absent/null key)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ visual_review: { mode: "full", round_wall_sec: 0 } })));
    expect(cfg.visual_review?.round_wall_sec).toBe(0);
  });

  it("maps the legacy goal_review { enabled } shape onto checkpoint-only medium (#73)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ goal_review: { enabled: true } })));
    expect(cfg.goal_review?.mode).toBe("medium");
    expect(cfg.goal_review?.fallback_cadence).toBe(4);
    const off = await loadConfig(await makeCwd(JSON.stringify({ goal_review: { enabled: false } })));
    expect(off.goal_review?.mode).toBe("off");
  });

  it("maps the legacy structural_review { enabled, at_run_end } shape onto a mode (#73)", async () => {
    const full = await loadConfig(await makeCwd(JSON.stringify({ structural_review: { enabled: true } })));
    expect(full.structural_review?.mode).toBe("full");
    const checkpointsOnly = await loadConfig(await makeCwd(JSON.stringify({ structural_review: { enabled: true, at_run_end: false } })));
    expect(checkpointsOnly.structural_review?.mode).toBe("medium");
    const off = await loadConfig(await makeCwd(JSON.stringify({ structural_review: { enabled: false } })));
    expect(off.structural_review?.mode).toBe("off");
  });

  it("an explicit mode wins over a legacy enabled key when both are present (#73)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ visual_review: { mode: "light", enabled: true, per_ticket: true } })));
    expect(cfg.visual_review?.mode).toBe("light");
  });

  it("loads goal_review.fallback_cadence override (#19)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ goal_review: { mode: "medium", fallback_cadence: 2 } })));
    expect(cfg.goal_review?.fallback_cadence).toBe(2);
  });

  it("loads goal_review.max_replans override and defaults it to 2 (#116)", async () => {
    expect((await loadConfig(await makeCwd(JSON.stringify({ goal_review: { mode: "light" } })))).goal_review?.max_replans).toBe(2);
    const set = await loadConfig(await makeCwd(JSON.stringify({ goal_review: { mode: "light", max_replans: 1 } })));
    expect(set.goal_review?.max_replans).toBe(1);
  });

  it("loads model.goal from railhead.json (#19)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ model: { goal: "strong-reasoner" } })));
    expect(cfg.model.goal).toBe("strong-reasoner");
  });

  it("leaves interaction_smoke unset by default and preserves an explicit value", async () => {
    expect((await loadConfig(await makeCwd(JSON.stringify({})))).interaction_smoke).toBeUndefined();
    expect((await loadConfig(await makeCwd(JSON.stringify({ interaction_smoke: true })))).interaction_smoke).toBe(true);
    expect((await loadConfig(await makeCwd(JSON.stringify({ interaction_smoke: false })))).interaction_smoke).toBe(false);
  });

  it("interactionSmokeEnabled derives the default from the declared interface (v2 issue 01)", async () => {
    expect(interactionSmokeEnabled(await loadConfig(await makeCwd(JSON.stringify({ interface: "browser-ui" }))))).toBe(true);
    expect(interactionSmokeEnabled(await loadConfig(await makeCwd(JSON.stringify({ interface: "canvas" }))))).toBe(true);
    expect(interactionSmokeEnabled(await loadConfig(await makeCwd(JSON.stringify({ interface: "terminal" }))))).toBe(false);
    expect(interactionSmokeEnabled(await loadConfig(await makeCwd(JSON.stringify({ interface: "native" }))))).toBe(false);
    expect(interactionSmokeEnabled(await loadConfig(await makeCwd(JSON.stringify({}))))).toBe(false);
    // A human's explicit value always wins — even off for a browser-ui project.
    expect(interactionSmokeEnabled(await loadConfig(await makeCwd(JSON.stringify({ interface: "browser-ui", interaction_smoke: false }))))).toBe(false);
    expect(interactionSmokeEnabled(await loadConfig(await makeCwd(JSON.stringify({ interface: "terminal", interaction_smoke: true }))))).toBe(true);
  });
});

describe("goal_review.checkpoint_action (ADR 0029, #102)", () => {
  it("loads checkpoint_action: advisory from railhead.json", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ goal_review: { mode: "light", checkpoint_action: "advisory" } })));
    expect(cfg.goal_review?.mode).toBe("light");
    expect(cfg.goal_review?.checkpoint_action).toBe("advisory");
  });

  it("drops an unrecognized checkpoint_action token (mode decides, not a guessed default)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ goal_review: { mode: "medium", checkpoint_action: "inline" } })));
    expect(cfg.goal_review?.checkpoint_action).toBeUndefined();
  });

  it("defaults checkpoint_action to absent (the v2 light default fires corrective checkpoints)", async () => {
    const cfg = await loadConfig(await makeCwd(JSON.stringify({ goal_review: { mode: "light" } })));
    expect(cfg.goal_review?.checkpoint_action).toBeUndefined();
    expect(goalFiresCheckpointsMidRun(cfg.goal_review)).toBe(true);
  });

  it("parseGoalCheckpointAction accepts advisory and corrective, case-insensitive", () => {
    expect(parseGoalCheckpointAction("advisory")).toBe("advisory");
    expect(parseGoalCheckpointAction("ADVISORY")).toBe("advisory");
    expect(parseGoalCheckpointAction("corrective")).toBe("corrective");
    expect(parseGoalCheckpointAction("CORRECTIVE")).toBe("corrective");
    expect(parseGoalCheckpointAction("inline")).toBeNull();
    expect(parseGoalCheckpointAction(undefined)).toBeNull();
  });
});

describe("goalFiresCheckpointsMidRun (ADR 0029, #102)", () => {
  it("full and medium fire group checkpoints mid-run", () => {
    expect(goalFiresCheckpointsMidRun({ mode: "full" })).toBe(true);
    expect(goalFiresCheckpointsMidRun({ mode: "medium" })).toBe(true);
  });

  it("light fires corrective group checkpoints mid-run (v2 issue 01 default)", () => {
    expect(goalFiresCheckpointsMidRun({ mode: "light" })).toBe(true);
  });

  it("light + a persisted advisory knob still fires, and stays advisory", () => {
    expect(goalFiresCheckpointsMidRun({ mode: "light", checkpoint_action: "advisory" })).toBe(true);
  });

  it("off never fires, even with the knob set", () => {
    expect(goalFiresCheckpointsMidRun({ mode: "off", checkpoint_action: "advisory" })).toBe(false);
  });

  it("absent/null config never fires", () => {
    expect(goalFiresCheckpointsMidRun(undefined)).toBe(false);
    expect(goalFiresCheckpointsMidRun(null)).toBe(false);
  });
});

describe("goalCheckpointIsAdvisory (ADR 0029, #102)", () => {
  it("a light/full gate with the knob is advisory at a mid-run checkpoint, never at run end", () => {
    expect(goalCheckpointIsAdvisory({ mode: "light", checkpoint_action: "advisory" }, false)).toBe(true);
    expect(goalCheckpointIsAdvisory({ mode: "full", checkpoint_action: "advisory" }, false)).toBe(true);
    expect(goalCheckpointIsAdvisory({ mode: "light", checkpoint_action: "advisory" }, true)).toBe(false); // run-end is corrective
  });

  it("a medium gate ignores the knob — mode decides (its run-end batch does not exist)", () => {
    expect(goalCheckpointIsAdvisory({ mode: "medium", checkpoint_action: "advisory" }, false)).toBe(false);
  });

  it("no knob is never advisory", () => {
    expect(goalCheckpointIsAdvisory({ mode: "light" }, false)).toBe(false);
    expect(goalCheckpointIsAdvisory(undefined, false)).toBe(false);
  });
});

describe("goalCheckpointActionFor (v2 issue 01, ADR 0029)", () => {
  it("goal light is corrective-anchored; medium/full already fire inline corrective (mode decides)", () => {
    expect(goalCheckpointActionFor("light")).toBe("corrective");
    expect(goalCheckpointActionFor("medium")).toBeNull();
    expect(goalCheckpointActionFor("full")).toBeNull();
    expect(goalCheckpointActionFor("off")).toBeNull();
  });
});

describe("preset goal checkpoint action (v2 issue 01, ADR 0029)", () => {
  it("only the light preset carries the corrective goal checkpoint action", () => {
    expect(presetGateModes("light").goalCheckpointAction).toBe("corrective");
    expect(presetGateModes("full").goalCheckpointAction).toBeUndefined();
    expect(presetGateModes("medium").goalCheckpointAction).toBeUndefined();
    expect(presetGateModes("none").goalCheckpointAction).toBeUndefined();
  });
});

describe("applyModelOverrides", () => {
  it("applies --plan/--exec/--review/--extract flags", () => {
    const model = { ...DEFAULT_CONFIG.model };
    applyModelOverrides(model, ["--plan", "M1", "--exec", "M2", "--review", "M3", "--extract", "M4"]);
    expect(model).toEqual({ plan: "M1", implement: "M2", review: "M3", visual: null, extract: "M4", goal: null });
  });

  it("falls back to config for unset flags", () => {
    const model = { plan: "P", implement: null, review: null, visual: null, extract: null, goal: null };
    applyModelOverrides(model, ["--exec", "E"]);
    expect(model.plan).toBe("P");
    expect(model.implement).toBe("E");
  });

  it("applies --goal-model flag override (#19)", () => {
    const model = { ...DEFAULT_CONFIG.model };
    applyModelOverrides(model, ["--goal-model", "strong-reasoner"]);
    expect(model.goal).toBe("strong-reasoner");
  });
});

describe("resolveModels", () => {
  it("plan falls back to implement; review falls back to implement", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: DEFAULT_MODEL, visual: DEFAULT_MODEL, extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, [])).toEqual({ plan: "I", implement: "I", review: "I", visual: "I", extract: "I", goal: "I" });
  });

  it("null means skip — no fallback when a seat is explicitly null", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: null, implement: "I", review: null, visual: null, extract: null, goal: null },
    };
    expect(resolveModels(cfg, [])).toEqual({ plan: null, implement: "I", review: null, visual: null, extract: null, goal: null });
  });

  it("DEFAULT_CONFIG has sentinel for core seats, null for oversight", () => {
    expect(resolveModels(DEFAULT_CONFIG, [])).toEqual({ plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: DEFAULT_MODEL, visual: null, extract: null, goal: null });
  });

  it("applies flag overrides", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: "P", implement: "I", review: "R", visual: DEFAULT_MODEL, extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, ["--exec", "NEW"])).toEqual({ plan: "P", implement: "NEW", review: "R", visual: "R", extract: "NEW", goal: "R" });
  });

  it("extract falls back to implement when unset (ADR 0015 — narrow-seat policy)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: DEFAULT_MODEL, visual: DEFAULT_MODEL, extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, [])).toEqual({ plan: "I", implement: "I", review: "I", visual: "I", extract: "I", goal: "I" });
  });

  it("extract stays its own model when set, without falling back to implement", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: DEFAULT_MODEL, visual: DEFAULT_MODEL, extract: "9B-cheap", goal: DEFAULT_MODEL },
    };
    const r = resolveModels(cfg, []);
    expect(r.extract).toBe("9B-cheap");
    expect(r.implement).toBe("I");
  });

  it("applies --extract flag override", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: DEFAULT_MODEL, visual: DEFAULT_MODEL, extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, ["--extract", "Qwen-7B"]).extract).toBe("Qwen-7B");
  });

  it("visual falls back to review, then implement (visual ?? review ?? implement)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: "R", visual: DEFAULT_MODEL, extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, []).visual).toBe("R");
  });

  it("applies --visual flag override", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: "R", visual: DEFAULT_MODEL, extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, ["--visual", "gemma-4-31b"]).visual).toBe("gemma-4-31b");
  });

  it("goal falls back to visual, then review, then implement (#19)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: "R", visual: "V", extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, []).goal).toBe("V");
  });

  it("goal falls back to review when visual is null/skip (#19)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: DEFAULT_MODEL, implement: "I", review: "R", visual: null, extract: DEFAULT_MODEL, goal: DEFAULT_MODEL },
    };
    expect(resolveModels(cfg, []).goal).toBe("R");
  });

  it("goal stays its own model when set (#19)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: null, implement: "I", review: "R", visual: "V", extract: null, goal: "strong-model" },
    };
    expect(resolveModels(cfg, []).goal).toBe("strong-model");
  });

  it("applies --goal-model flag override (#19)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      model: { plan: null, implement: "I", review: null, visual: null, extract: null, goal: null },
    };
    expect(resolveModels(cfg, ["--goal-model", "reasoner"]).goal).toBe("reasoner");
  });
});

describe("parseModelContextLimit", () => {
  const SAMPLE_OUTPUT = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "limit": {
    "context": 200000,
    "output": 32000
  }
}
mtplx/mtplx-qwen35-9b-optimized-speed
{
  "id": "mtplx-qwen35-9b-optimized-speed",
  "providerID": "mtplx",
  "limit": {
    "context": 262144,
    "output": 262144
  }
}
mtplx/mtplx-qwen38-27b-optimized-speed
{
  "id": "mtplx-qwen38-27b-optimized-speed",
  "providerID": "mtplx",
  "limit": {
    "context": 65000,
    "output": 65000
  }
}
`;

  it("finds the context limit for a provider/model name", () => {
    expect(parseModelContextLimit(SAMPLE_OUTPUT, "mtplx/mtplx-qwen35-9b-optimized-speed")).toBe(262144);
  });

  it("finds the context limit for a different model on the same provider", () => {
    expect(parseModelContextLimit(SAMPLE_OUTPUT, "mtplx/mtplx-qwen38-27b-optimized-speed")).toBe(65000);
  });

  it("finds the context limit for a model on a different provider", () => {
    expect(parseModelContextLimit(SAMPLE_OUTPUT, "opencode/big-pickle")).toBe(200000);
  });

  it("returns null when the model is not found", () => {
    expect(parseModelContextLimit(SAMPLE_OUTPUT, "unknown/model")).toBeNull();
  });

  it("returns null when the output is empty", () => {
    expect(parseModelContextLimit("", "mtplx/mtplx-qwen35-9b-optimized-speed")).toBeNull();
  });

  it("returns null when the JSON block has no limit field", () => {
    const noLimit = `foo/bar
{
  "id": "bar",
  "providerID": "foo"
}
`;
    expect(parseModelContextLimit(noLimit, "foo/bar")).toBeNull();
  });

  it("returns null when limit.context is missing", () => {
    const noContext = `foo/bar
{
  "id": "bar",
  "providerID": "foo",
  "limit": {
    "output": 32000
  }
}
`;
    expect(parseModelContextLimit(noContext, "foo/bar")).toBeNull();
  });

  it("handles malformed JSON blocks gracefully", () => {
    const malformed = `mtplx/test-model
{not valid json
}
mtplx/real-model
{
  "id": "real-model",
  "providerID": "mtplx",
  "limit": {
    "context": 100000
  }
}
`;
    expect(parseModelContextLimit(malformed, "mtplx/real-model")).toBe(100000);
    expect(parseModelContextLimit(malformed, "mtplx/test-model")).toBeNull();
  });

  it("handles a model name with no provider prefix (searches all providers)", () => {
    expect(parseModelContextLimit(SAMPLE_OUTPUT, "mtplx-qwen35-9b-optimized-speed")).toBe(262144);
  });
});

describe("warnIfOversightModelIsLocal (#52)", () => {
  const mk = (over: {
    plan?: string | null;
    implement?: string | null;
    goal?: string | null;
    review?: string | null;
    visual?: string | null;
    extract?: string | null;
    goalEnabled?: boolean;
  }): { config: Pick<import("./config.ts").RailheadConfig, "model" | "goal_review">; resolved: import("./config.ts").ResolvedModels } => {
    const config: Pick<import("./config.ts").RailheadConfig, "model" | "goal_review"> = {
      model: {
        plan: "plan" in over ? over.plan! : DEFAULT_MODEL,
        implement: "implement" in over ? over.implement! : DEFAULT_MODEL,
        review: "review" in over ? over.review! : DEFAULT_MODEL,
        visual: "visual" in over ? over.visual! : DEFAULT_MODEL,
        extract: "extract" in over ? over.extract! : DEFAULT_MODEL,
        goal: "goal" in over ? over.goal! : DEFAULT_MODEL,
      },
      goal_review: { mode: over.goalEnabled ? "medium" : "off", fallback_cadence: 4 },
    };
    const resolved = resolveModels({ ...DEFAULT_CONFIG, ...config }, []);
    return { config, resolved };
  };

  it("warns when goal review is enabled and model.goal resolves to the same model as model.implement", () => {
    const { config, resolved } = mk({ implement: "local/qwen3-32b", goalEnabled: true });
    const w = warnIfOversightModelIsLocal(config, resolved);
    expect(w.length).toBeGreaterThan(0);
    expect(w[0]).toMatch(/oversight|goal.*review.*local|same.*model.*implement/i);
  });

  it("does not warn when goal review is disabled", () => {
    const { config, resolved } = mk({ implement: "local/qwen3-32b", goalEnabled: false });
    expect(warnIfOversightModelIsLocal(config, resolved)).toEqual([]);
  });

  it("does not warn when model.goal is set to a different (hosted) model than implement", () => {
    const { config, resolved } = mk({ implement: "local/qwen3-32b", goal: "anthropic/claude-sonnet-4.5", goalEnabled: true });
    expect(warnIfOversightModelIsLocal(config, resolved)).toEqual([]);
  });

  it("does not warn when goal review is enabled but implement is null (skip, no model to compare)", () => {
    const { config, resolved } = mk({ implement: null, goalEnabled: true });
    expect(warnIfOversightModelIsLocal(config, resolved)).toEqual([]);
  });

  it("warns when goal is unset and falls back through visual and review to the local implement model", () => {
    const { config, resolved } = mk({ implement: "local/qwen3-32b", goalEnabled: true });
    const w = warnIfOversightModelIsLocal(config, resolved);
    expect(w.length).toBeGreaterThan(0);
    expect(resolved.goal).toBe("local/qwen3-32b");
  });
});

describe("effectiveContextTokens", () => {
  it("clamps config to the model's detected limit when config exceeds it", () => {
    const { budget, source } = effectiveContextTokens(230000, 65000);
    expect(budget).toBe(65000);
    expect(source).toBe("model");
  });

  it("uses config when it is below the detected limit", () => {
    const { budget, source } = effectiveContextTokens(50000, 65000);
    expect(budget).toBe(50000);
    expect(source).toBe("config");
  });

  it("uses the model's detected limit verbatim when config is unset (ADR 0014 amendment: the margin lives in limit.context)", () => {
    const { budget, source } = effectiveContextTokens(undefined, 100000);
    expect(budget).toBe(100000);
    expect(source).toBe("model");
  });

  it("honors an explicit ceiling without applying the default fraction", () => {
    const { budget, source } = effectiveContextTokens(90000, 100000);
    expect(budget).toBe(90000);
    expect(source).toBe("config");
  });

  it("uses config when detection failed (null)", () => {
    const { budget, source } = effectiveContextTokens(230000, null);
    expect(budget).toBe(230000);
    expect(source).toBe("config");
  });

  it("falls back to default when neither is set", () => {
    const { budget, source } = effectiveContextTokens(undefined, null);
    expect(budget).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(source).toBe("default");
  });
});

describe("seatContextCeilings (ADR 0014 per-seat amendment)", () => {
  const models = { plan: "plan/model", implement: "impl/model", review: "rev/model", visual: "vis/model", goal: "goal/model", extract: null };

  it("does not cap a larger-window judging seat with the implementer's budget", () => {
    const ceilings = seatContextCeilings(
      { ...models, plan: null, review: null, visual: null },
      { implement: 100000, goal: 200000 },
      100000,
    );
    expect(ceilings.implement).toBe(100000);
    expect(ceilings.goal).toBe(200000);
  });

  it("resolves each judging seat from its own configured limit verbatim (no harness fraction)", () => {
    const ceilings = seatContextCeilings(
      { ...models, plan: null, review: null, extract: "extract/model" },
      { implement: 100000, visual: 150000, goal: 200000, extract: 50000 },
      undefined,
    );
    expect(ceilings.implement).toBe(100000);
    expect(ceilings.visual).toBe(150000);
    expect(ceilings.goal).toBe(200000);
    expect(ceilings.extract).toBe(50000);
  });

  it("falls back to the operator ceiling for a seat whose window was not detected", () => {
    const ceilings = seatContextCeilings({ ...models, extract: null, visual: null }, { goal: null }, 80000);
    expect(ceilings.goal).toBe(80000);
  });

  it("skips seats with no configured model", () => {
    const ceilings = seatContextCeilings({ ...models, extract: null }, { implement: 100000 }, 100000);
    expect(ceilings.extract).toBeUndefined();
    expect(Object.keys(ceilings).sort()).toEqual(["goal", "implement", "plan", "review", "visual"]);
  });
});

describe("seatContextBudget", () => {
  const state = {
    _seatContextTokens: { implement: 100000, goal: 200000 },
    _effectiveContextTokens: 100000,
    config: { max_context_tokens: 100000 },
  };

  it("prefers the seat's resolved ceiling", () => {
    expect(seatContextBudget(state, "goal")).toBe(200000);
    expect(seatContextBudget(state, "implement")).toBe(100000);
  });

  it("falls back to the implement-derived budget when the seat has no entry", () => {
    expect(seatContextBudget(state, "visual")).toBe(100000);
    expect(seatContextBudget({ _effectiveContextTokens: 90000, config: {} }, "goal")).toBe(90000);
  });
});

describe("parseCheckpointGranularity (ADR 0022, #84)", () => {
  it("parses the three granularity tokens case-insensitively", () => {
    expect(parseCheckpointGranularity("ticket")).toBe("ticket");
    expect(parseCheckpointGranularity("GROUP")).toBe("group");
    expect(parseCheckpointGranularity(" Product ")).toBe("product");
  });

  it("returns null for absent or unrecognized tokens", () => {
    expect(parseCheckpointGranularity(undefined)).toBeNull();
    expect(parseCheckpointGranularity(null)).toBeNull();
    expect(parseCheckpointGranularity("epic")).toBeNull();
    expect(parseCheckpointGranularity("")).toBeNull();
  });
});

describe("checkpoint_granularity (ADR 0022, #84)", () => {
  it("defaults to product granularity", async () => {
    const cfg = await loadConfig(await makeCwd(null));
    expect(cfg.checkpoint_granularity).toBe("product");
  });

  it("reads checkpoint_granularity and falls back to the product default on a bad value", async () => {
    const ticket = await loadConfig(await makeCwd('{"checkpoint_granularity":"ticket"}'));
    expect(ticket.checkpoint_granularity).toBe("ticket");
    const bad = await loadConfig(await makeCwd('{"checkpoint_granularity":"whole-thing"}'));
    expect(bad.checkpoint_granularity).toBe("product");
  });
});

describe("updateConfig", () => {
  it("mutates a known key while preserving unknown railhead.json keys", async () => {
    const cwd = await makeCwd(JSON.stringify({ max_retries: 3, future_field: { nested: true }, verify: ["npm test"] }));
    await updateConfig(cwd, (cfg) => {
      cfg.max_retries = 7;
    });
    const raw = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8")) as Record<string, unknown>;
    expect(raw.max_retries).toBe(7);
    expect(raw.future_field).toEqual({ nested: true });
    expect(raw.verify).toEqual(["npm test"]);
  });

  it("writes a fresh minimal config when railhead.json is missing", async () => {
    const cwd = await makeCwd(null);
    await updateConfig(cwd, (cfg) => {
      cfg.yolo_permissions = true;
    });
    const raw = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({ yolo_permissions: true });
  });

  it("does not clobber unknown nested gate sibling keys when mutating a gate object", async () => {
    const cwd = await makeCwd(JSON.stringify({ visual_review: { mode: "off", max_rounds: 2, custom_hint: "keep" } }));
    await updateConfig(cwd, (cfg) => {
      const g = (cfg.visual_review ?? {}) as Record<string, unknown>;
      g.mode = "full";
      cfg.visual_review = g;
    });
    const raw = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8")) as Record<string, unknown>;
    expect(raw.visual_review).toEqual({ mode: "full", max_rounds: 2, custom_hint: "keep" });
  });
});

describe("provider config (#134)", () => {
  it("is null when undeclared and parsed when present", async () => {
    expect((await loadConfig(await makeCwd(null))).provider).toBeNull();
    const cfg = await loadConfig(await makeCwd(JSON.stringify({
      provider: { base_url: "http://box:8080", health: { url: "/status", pass: { path: "ready", equals: true } } },
    })));
    expect(cfg.provider?.health?.pass).toEqual({ path: "ready", equals: true });
  });

  it("throws on a malformed declared provider instead of silently falling back (#134)", async () => {
    await expect(loadConfig(await makeCwd('{"provider":{"health":{"url":"/status"}}}')))
      .rejects.toThrow(/provider\.base_url/);
    await expect(loadConfig(await makeCwd('{"provider":{"health":{}}}')))
      .rejects.toThrow(/provider\.health\.url/);
  });
});
