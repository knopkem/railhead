import { goalCheckpointActionFor, presetGateModes, presetRunsTdd, updateConfig } from "./config.ts";
import type { GateMode, GatePreset, RailheadConfig, PresetGateModes } from "./config.ts";
import type { GateOverrides } from "./args.ts";

/**
 * Issue #92: the run's per-decision policy lives here — pure resolvers that
 * decide a single thing each, plus one compare-then-persist path. cli.ts
 * orchestrates the *asking* (the interleave is real: yolo must be decided
 * before permission grants are written, and the gate/TDD questions resolve
 * before the planner runs so the ADR 0036 vision check can refuse a blind
 * seat ahead of the plan's spend) and passes the answer back into the
 * resolver; the resolver never prompts.
 *
 * The gate-mode default rule (`code` → light, others → off) and the
 * persist-if-changed logic each exist exactly once, here — cmdBuild and cmdRun
 * resolve through these functions instead of reassembling policy inline.
 */

export type GateName = "code" | "visual" | "goal" | "structural";

export type GateConfigKey = "code_review" | "visual_review" | "goal_review" | "structural_review";

export const GATES: ReadonlyArray<readonly [GateName, GateConfigKey]> = [
  ["code", "code_review"],
  ["visual", "visual_review"],
  ["goal", "goal_review"],
  ["structural", "structural_review"],
] as const;

/**
 * The gate-mode default rule (issue #73): a gate with no persisted mode runs
 * at `code` → light (the end-of-run pass) and `visual`/`goal`/`structural` →
 * off. Shared by every "what is the gate currently set to" read.
 */
function defaultGateMode(gate: GateName): GateMode {
  return gate === "code" ? "light" : "off";
}

/** The persisted mode for a gate, defaulting per `defaultGateMode`. */
function currentGateMode(config: Pick<RailheadConfig, GateConfigKey>, gate: GateName): GateMode {
  const key = GATES.find(([g]) => g === gate)![1];
  const cfg = (config as RailheadConfig)[key];
  return (cfg && (cfg as { mode?: GateMode }).mode) ?? defaultGateMode(gate);
}

// ---------------------------------------------------------------------------
// resolveGateModes — the run's per-gate review cadence
// ---------------------------------------------------------------------------

/** The interactive per-gate questionnaire result (skipAll = the "--none"
 * shortcut pick on the code prompt). */
export interface GateCadenceAnswer {
  modes: PresetGateModes;
  skipAll: boolean;
}

export interface ResolveGateModesInput {
  /** The plan preset; `null` = no preset (defaults to light, or the
   * interactive answer when one was collected). */
  preset: GatePreset | null;
  /** Per-gate CLI overrides. */
  overrides: GateOverrides;
  /** Whether this is a `fix` plan — forces visual=full when possible. */
  fixMode: boolean;
  /** Whether a vision-capable model is configured (models.visual !== null). */
  hasVisionModel: boolean;
  /** Whether the visual gate is currently NOT off (a fix forces visual full
   * only when the user has visual review enabled at all). */
  visualEnabled: boolean;
  /** The interactive questionnaire result, when cmdBuild collected one. */
  answer?: GateCadenceAnswer | null;
}

/**
 * Fix mode (issue #6): the bug fix's whole point is observable runtime
 * behaviour, so visual verification is never optional — force the visual gate
 * to `full` when visual review is on (not off) and a vision-capable model is
 * configured. A user who disabled visual review entirely keeps it disabled.
 */
export function fixModeForcesVisual(fixMode: boolean, visualEnabled: boolean, hasVisionModel: boolean): boolean {
  return fixMode && visualEnabled && hasVisionModel;
}

/**
 * Resolve the final per-gate cadence for a plan: preset base (or the
 * interactive answer) → CLI overrides → fix-mode forcing visual=full when
 * visual review is enabled and a vision model exists → the per-gate default.
 */
export function resolveGateModes(input: ResolveGateModesInput): PresetGateModes {
  let modes: PresetGateModes = input.answer
    ? { ...input.answer.modes }
    : presetGateModes(input.preset ?? "light");
  for (const [gate] of GATES) {
    const override = input.overrides[gate];
    if (override) modes[gate] = override;
  }
  if (input.answer?.skipAll) {
    modes = presetGateModes("none");
  }
  if (fixModeForcesVisual(input.fixMode, input.visualEnabled, input.hasVisionModel)) {
    modes.visual = "full";
  }
  // ADR 0029 (#102): the goal checkpoint action rides the RESOLVED goal gate —
  // goal mode `light` is the advisory-checkpoints identity, whatever base
  // (preset or interactive answer) produced it, and an override off `light`
  // (e.g. --goal medium) must drop the field rather than leave a stale
  // advisory behind. Recomputed from the single goalCheckpointActionFor rule
  // at the end so preset, answer, and override paths can't disagree.
  const goalAction = goalCheckpointActionFor(modes.goal);
  if (goalAction) {
    modes.goalCheckpointAction = goalAction;
  } else {
    delete modes.goalCheckpointAction;
  }
  return modes;
}

// ---------------------------------------------------------------------------
// resolveTdd — the TDD test-phase decision
// ---------------------------------------------------------------------------

export interface ResolveTddInput {
  /** `--tdd` / `--no-tdd` flag value; `null` = not given. */
  flag: boolean | null;
  /** Plan mode — `fix` forces the test phase off. Run passes `"build"`. */
  mode: "build" | "fix";
  /** The plan preset; `null` in a standalone run. */
  preset: GatePreset | null;
  /** Whether this is a non-interactive (`-a`/`--auto`) invocation. */
  auto: boolean;
  /** The empty-input default for the interactive prompt. Plan: `false`;
   * standalone run: the persisted config. The two defaults are encoded by the
   * caller, never unified here. */
  askDefault: boolean;
  /** The interactive answer, when cmdBuild/cmdRun asked. */
  answer?: boolean;
}

/**
 * Resolve the TDD test-phase decision: flag → fix-mode-off → interactive
 * answer → the preset's default (only `--full` runs it). The caller decides
 * when a prompt is needed and passes `answer` back in.
 */
export function resolveTdd(input: ResolveTddInput): boolean {
  if (input.flag !== null) return input.flag;
  if (input.mode === "fix") return false;
  if (!input.auto && input.preset === null) return input.answer ?? input.askDefault;
  return presetRunsTdd(input.preset ?? "light");
}

// ---------------------------------------------------------------------------
// resolveYolo — the yolo permission decision (plan-side only)
// ---------------------------------------------------------------------------

export interface ResolveYoloInput {
  /** The `--yolo` flag. */
  flag: boolean;
  /** Whether yolo_permissions is already persisted. */
  configValue: boolean;
  /** The interactive answer, when cmdBuild asked. */
  answer?: boolean;
}

/** Yolo is on when the flag says so, the config already persists it, or the
 * interactive answer is yes. cmdRun never asks — it consumes the persisted
 * config. */
export function resolveYolo(input: ResolveYoloInput): boolean {
  return input.flag || input.configValue || input.answer === true;
}

// ---------------------------------------------------------------------------
// persistPolicy — the ONE compare-then-persist path
// ---------------------------------------------------------------------------

export interface PolicyDecisions {
  /** Persist `yolo_permissions` to this value (plan only ever sends true). */
  yolo?: boolean;
  /** Persist `fix_mode` to this value (plan-only; always true). */
  fixMode?: boolean;
  /** Persist `test_phase` to this value. */
  testPhase?: boolean;
  /** Desired per-gate cadence; only the listed gates are considered. */
  gateModes?: Partial<Record<GateName, GateMode>>;
}

export interface PersistReport {
  /** Gates whose persisted mode actually changed. */
  gatesChanged: GateName[];
  /** Whether the persisted test phase changed. */
  testPhaseChanged: boolean;
}

/**
 * The one compare-then-persist path. Each provided decision is compared
 * against the value already on the in-memory config; only differences are
 * written, through `updateConfig` (which preserves keys the railhead doesn't
 * model). Returns what changed so cmdRun can log — cmdBuild ignores the report.
 */
export async function persistPolicy(
  cwd: string,
  config: RailheadConfig,
  decisions: PolicyDecisions,
): Promise<PersistReport> {
  const report: PersistReport = { gatesChanged: [], testPhaseChanged: false };
  // Decide what would change against the value already on the in-memory
  // config; only differences are written, in one updateConfig pass. The
  // in-memory config is kept in sync so callers (cmdRun passes it into
  // startRun) see the persisted decision too.
  const actions: Array<(cfg: Record<string, unknown>) => void> = [];

  if (decisions.yolo !== undefined && config.yolo_permissions !== decisions.yolo) {
    actions.push((cfg) => {
      cfg.yolo_permissions = decisions.yolo;
    });
    config.yolo_permissions = decisions.yolo;
  }
  if (decisions.fixMode !== undefined && config.fix_mode !== decisions.fixMode) {
    actions.push((cfg) => {
      cfg.fix_mode = decisions.fixMode;
    });
    config.fix_mode = decisions.fixMode;
  }
  if (decisions.testPhase !== undefined && (config.test_phase ?? true) !== decisions.testPhase) {
    actions.push((cfg) => {
      cfg.test_phase = decisions.testPhase;
    });
    config.test_phase = decisions.testPhase;
    report.testPhaseChanged = true;
  }
  if (decisions.gateModes) {
    for (const [gate, key] of GATES) {
      const want = decisions.gateModes[gate];
      if (want === undefined) continue;
      const now = currentGateMode(config, gate);
      if (want === now) continue;
      actions.push((cfg) => {
        const g = (cfg[key] ?? {}) as Record<string, unknown>;
        g.mode = want;
        cfg[key] = g;
      });
      const typed = (config[key] as { mode: GateMode } | null | undefined) ?? {};
      (config[key] as { mode: GateMode } | null | undefined) = { ...typed, mode: want };
      report.gatesChanged.push(gate);
    }
    // ADR 0029 (#102): a goal-gate decision ALSO syncs `goal_review.checkpoint_action`
    // — the preset layer expresses "goal light ⇒ advisory checkpoints" by
    // persisting the knob (and clears a stale one when the resolved goal moves
    // off light, so a replan to medium/full never inherits light's advisory).
    // Derived from the same rule as presetGateModes so plan and run agree.
    if (decisions.gateModes.goal !== undefined) {
      const wantAction = goalCheckpointActionFor(decisions.gateModes.goal);
      const currentAction = (config.goal_review?.checkpoint_action ?? null) as "advisory" | null;
      if (currentAction !== wantAction) {
        if (wantAction === null) {
          actions.push((cfg) => {
            const g = cfg.goal_review;
            if (typeof g === "object" && g !== null) {
              delete (g as Record<string, unknown>).checkpoint_action;
            }
          });
        } else {
          actions.push((cfg) => {
            const g = (cfg.goal_review ?? {}) as Record<string, unknown>;
            g.checkpoint_action = wantAction;
            cfg.goal_review = g;
          });
        }
        const base = config.goal_review ?? { mode: currentGateMode(config, "goal") };
        config.goal_review = { ...base, checkpoint_action: wantAction ?? undefined };
      }
    }
  }
  if (actions.length > 0) {
    await updateConfig(cwd, (cfg) => {
      for (const act of actions) act(cfg);
    });
  }
  return report;
}
