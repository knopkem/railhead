import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { argValue } from "./args.ts";
import { parseProjectInterface, type ProjectInterface } from "./interface.ts";
import { parseProviderConfig, type ProviderConfig } from "./provider.ts";
export type { ProjectInterface } from "./interface.ts";

export interface ModelConfig {
  plan: string | null;
  implement: string | null;
  review: string | null;
  /**
   * Vision-capable model for visual review (screenshot capture + UI judgment).
   * Separate from `review` (code-diff review) so a text-strong reviewer and a
   * vision-capable model can differ — e.g. `review` = inkling-small (best code
   * comprehension, no vision), `visual` = gemma-4-31b (vision, weaker code).
   * `null` (the default) falls back to `review` at resolve time; the visual
   * review phase guards on the resolved model being non-null.
   */
  visual: string | null;
  /**
   * Narrow-seat model for single-shot structured-output passes (learning
   * extraction, learnings consolidation, verify-output summarization, phase-
   * handoff extraction). The only tier where a 9B-Q4 model is endorsed —
   * see ADR 0015. `null` (the default) falls back to `model.implement` at
   * resolve time; the consuming call sites (#2, #8, #9) opt into a 9B
   * default only when they land, not in this policy ticket.
   */
  extract: string | null;
  /**
   * Issue #19: model for the goal review phase. Runs at group checkpoint
   * boundaries, evaluating the running build holistically against the
   * original goal and `design.md` (#34). May need strong holistic reasoning
   * over a design document — not necessarily vision. `null` (the default)
   * falls back to `visual`, then `review`, then `implement` at resolve time.
   */
  goal: string | null;
}

/**
 * Sentinel for "use opencode's configured default model." In railhead.json,
 * `model.implement: "default"` means the phase runs on whatever opencode's
 * own config selects. `null` means the phase is skipped entirely — no model
 * is configured, and the phase must not run. This is the only correct way to
 * express "use the default" in a model seat: the old convention of `null`
 * meaning "use default" for core phases but "skip" for oversight phases was
 * the ambiguity that let the pixeledit-railhead run enable goal_review and
 * visual_review with all models as null, silently skipping every oversight
 * phase while appearing to run them.
 */
export const DEFAULT_MODEL = "default";

/** ADR 0022 (#84): how many tickets the durable-session builder burns through
 * before the railhead expects a `$CHECKPOINT` marker and interleaves its gates.
 * `ticket` = one checkpoint per ticket (the default); `group` = checkpoint at
 * group boundaries; `product` = the whole build in one session, gates still
 * firing per ticket — only the builder's process lifetime changes. */
export type CheckpointGranularity = "ticket" | "group" | "product";

export const CHECKPOINT_GRANULARITIES: readonly CheckpointGranularity[] = ["ticket", "group", "product"];

/** Parse a checkpoint-granularity token, case-insensitive; null when absent or
 * unrecognized (callers fall back to the default). Mirrors `parseGateMode`. */
export function parseCheckpointGranularity(s: string | null | undefined): CheckpointGranularity | null {
  const v = s?.trim().toLowerCase();
  return (CHECKPOINT_GRANULARITIES as readonly string[]).includes(v ?? "") ? (v as CheckpointGranularity) : null;
}

/** ADR 0014 amendment: what a phase does when it crosses 95% of its request
 * ceiling. `"kill"` stops the subprocess; `"telemetry"` logs the crossing and
 * lets compaction own the fill. */
export type ContextGuardMode = "kill" | "telemetry";

/** Validate a `context_guard` value; null when absent or unrecognized, so the
 * caller falls back to the default rather than letting a typo arm a kill. */
export function parseContextGuard(s: string | null | undefined): ContextGuardMode | null {
  const v = s?.trim().toLowerCase();
  return v === "kill" || v === "telemetry" ? v : null;
}

/** The model each phase actually runs on, after config + flag fallbacks.
 * `null` = skip the phase; `DEFAULT_MODEL` = opencode's own default;
 * any other string = that named model is passed via `--model`. */
export interface ResolvedModels {
  plan: string | null;
  implement: string | null;
  review: string | null;
  visual: string | null;
  extract: string | null;
  goal: string | null;
}

/** A model seat's name (the keys of {@link ResolvedModels}). */
export type SeatName = keyof ResolvedModels;

/** Every seat, in a stable order for detection, reporting, and resolution. */
export const SEAT_ORDER = ["plan", "implement", "review", "visual", "goal", "extract"] as const satisfies readonly SeatName[];

export interface RailheadConfig {
  verify: string[];
  /**
   * Issue #97: the declared interaction interface of the DELIVERABLE —
   * `browser-ui | canvas | native | terminal | none` — recorded at plan time
   * from the planner's $INTERFACE block and seeded into railhead.json's top-level
   * `interface` field (seed-if-empty, exactly like verify/smoke). It
   * parameterizes the whole-app reviewer's interaction guidance AND the
   * evidence gate's "what counts as real user-level operation". `null`/absent
   * = undeclared: legacy behavior (no injected guidance, no widened gate;
   * canvas-only inference still applies at the seat). Unknown declared values
   * throw at load (see `parseProjectInterface`) — a new value is a deliberate
   * row of data, never a silent coercion.
   */
  projectInterface?: ProjectInterface | null;
  /**
   * Issue #134: the operator-declared provider surface — `base_url` for
   * resolving a relative health URL, and the `health` probe config. The
   * railhead probes before every phase and fast-fails into the failure ladder
   * when the provider is unhealthy; unset = no probe, today's behavior. No
   * provider is ever auto-detected, and no vendor's payload shape is known
   * here (see `provider.ts`). Malformed values throw at load.
   */
  provider?: ProviderConfig | null;
  /**
   * Whether the planner must own the look of a rendered surface with ONE
   * open-ended craft ticket (`open_ended: true`) — a single agent that creates
   * the composed artifact and iterates on screenshots, rather than a
   * decomposition of per-element visual tickets with structural criteria.
   * Default `true`; a build whose look is not the point can set `false` to skip
   * the plan-gate requirement (the planner prompt also stops asking). Only
   * applies when the plan declares a rendered `interface`
   * (`browser-ui`/`canvas`/`native`) — a `terminal`/`none` build never gets
   * one either way.
   */
  art_direction?: boolean;
  /**
   * Shell commands that launch the built binary and confirm it reaches a
   * running state without panicking — a stronger check than `verify` (which
   * is usually just build/test). The phase runs after verify passes and
   * before review, with a framework-aware headless env injected (see
   * `frameworkSmokeRun`). Empty for library-only projects or those the
   * planner didn't think to smoke; in that case the phase is skipped
   * entirely (backward-compat with railhead.json files predating this field).
   */
  smoke: string[];
  /**
   * Shell commands that run a deterministic linter (e.g. eslint, clippy,
   * ruff). Runs after verify passes and before review, non-blocking — the
   * output is injected into the reviewer prompt so the LLM can focus on
   * logic and design rather than style or common bug patterns the linter
   * already catches. Empty = skip the lint phase entirely (same pattern as
   * smoke). Issue #41.
   */
  lint?: string[];
  max_retries: number;
  /** Extra failed-review retries allowed before a ticket fails. `null` = same as max_retries (current default). */
  max_review_retries?: number | null;
  /** Absolute cap on total implement attempts per ticket, regardless of budget resets. `null` = max_retries * 3. */
  max_attempts?: number | null;
  infra_backoff_sec: number[];
  /** Largest single request (prompt + output reserve) a phase may send, in
   * tokens. Issue #81: this is a REQUEST ceiling — the planner slices tickets
   * to it and the executor watches every phase against it (killing only under
   * `context_guard: "kill"`, the opt-in) — not the server's capacity, which
   * is shared with invisible foreign KV. It is the IMPLEMENT seat's budget
   * (init derives it from the implement model); every judging seat resolves
   * its own model's configured opencode limit instead, so a small implementer
   * never caps a larger reviewer (ADR 0014 amendment). */
  request_ceiling_tokens?: number;
  /** Legacy alias for `request_ceiling_tokens` (kept so an existing
   * railhead.json keeps working). */
  max_context_tokens?: number;
  /** ADR 0014 amendment: what a phase does when it crosses 95% of its request
   * ceiling. `"kill"` stops the subprocess; `"telemetry"` (default, also when
   * absent) logs the crossing and lets compaction own the fill. The ceiling is
   * the model's configured opencode limit, so a crossing is near the real
   * bound and compaction is the right manager — the kill discarded a goal
   * review's verdict mid-probe (run-20260925-2006). */
  context_guard?: ContextGuardMode;
  /**
   * Hard cap on the number of opencode step_start events a single phase
   * (implement, review, contracts, plan, visual) may emit before the railhead
   * kills the subprocess. Guards against models that enter infinite tool
   * loops — e.g. guessing filenames wrong, getting "file not found", and
   * retrying forever. `null` = scaled from max_context_tokens (see
   * `resolveStepBudget`), falling back to 50 when no context budget is set.
   */
  max_phase_steps?: number | null;
  /**
   * Wall-clock ceiling, in seconds, on a single `verify` command. Unlike
   * `max_phase_steps` (which bounds an opencode phase by step count), a
   * verify command is a raw shell invocation with no step signal at all — an
   * unattended run has no other way to notice a hung test/build command.
   * `null` = the runVerify default (600s).
   */
  verify_timeout_sec?: number | null;
  /**
   * Wall-clock ceiling, in seconds, on a single `smoke` command (one that
   * launches the built binary). Same rationale as `verify_timeout_sec` but
   * tighter by default: a smoke run that hasn't crashed or moved past
   * startup in ~30s has usually reached a steady state, and a longer cap
   * just lets a hung GUI loop eat the run's clock. `null` = the
   * `DEFAULT_SMOKE_TIMEOUT_SEC` (30s).
   */
  smoke_timeout_sec?: number | null;
  /**
   * Kill an opencode phase (implement/review/plan/contracts/visual) if it
   * produces no output for this many seconds. Complements `max_phase_steps`:
   * the step cap catches a model looping across many steps, this catches a
   * single step that never returns (a hung tool call). Issue #55: the default
   * is finite (3600s) — a pure safety net sized never to interrupt a slow but
   * alive phase, where a null default resolved to `Infinity` in the executor
   * and let a hung implementer run forever.
   */
  stall_timeout_sec?: number | null;
  /**
   * Issue #78: per-step ceiling on MODEL time — the wall clock of a single
   * opencode step minus that step's tool-execution time. A model server that
   * is alive but thrashing (0 tok/s, stuck in prefill under memory pressure)
   * produces no events, so the silence stall timer — deliberately tolerant,
   * see `DEFAULT_STALL_TIMEOUT_SEC` — never fires on it. This cap kills the
   * phase once one step has spent more than this many seconds NOT executing a
   * tool AND NOT completing a part: the thrash blast-radius bound. Both this
   * and the stall default sit at one hour — a safety net for unattended runs,
   * not a scheduler's judgement on how long a legitimate step may take (a
   * wrong kill costs a resumable retry; an undetected thrash costs hours, so
   * the cap is deliberately not a per-step performance discriminator).
   * Tool-running wall is excluded when a `running` tool part is observed (and
   * via the terminal event's exact `state.time` window), so a long build
   * inside a step is the silence timer's case, not this one. `null` or `0`
   * disables; absent = the `DEFAULT_MAX_STEP_MODEL_SEC` (3600s) default.
   */
  max_step_model_sec?: number | null;
  /**
   * ADR 0040: cumulative `step_start` count a single TICKET may consume across
   * every builder invocation (ladder rungs, resumes, blocks) before the ticket
   * is stopped and surfaced. Unlike `max_phase_steps` (per process), this does
   * not reset. `null`/absent = `3 × max_phase_steps` (two windows reach the
   * capacity verdict, the third is its fresh-session recovery); `0` disables.
   */
  ticket_step_budget?: number | null;
  /**
   * ADR 0040: cumulative builder wall-clock, in seconds, a single ticket may
   * consume across every builder invocation. `null`/absent = the measured wall
   * time of this run's plan phase (the same model, same repo — the project's
   * own calibration), floored at 30 minutes; `0` disables.
   */
  ticket_wall_sec?: number | null;
  /**
   * ADR 0040: what happens when the builder commits a `verification-
   * unavailable` block (work gated green, but a criterion only a reviewer can
   * check). `"continue"` (default) records the criterion as unverified,
   * routes it to the next goal/visual checkpoint, and keeps the run going;
   * `"pause"` stops the run for a human at that boundary. An unrecognized
   * value falls back to `"continue"`.
   */
  on_block?: "continue" | "pause";
  /**
   * Bound on the number of interview rounds `railhead build` runs (ADR 0010)
   * before generating tickets. Each round is one ordinary opencode phase
   * call; the interview typically stops earlier on its own $DONE signal —
   * this is the backstop for a model that never emits one. `0` disables the
   * interview entirely (same effect as `--no-sharpen`, and overrides a
   * `--sharpen` flag — issue #73). Under `-a`/`--auto` the interview still
   * runs when the chosen preset runs it (`--medium`/`--full`), with the model
   * auto-answering its own questions (terms/ADRs still resolve). The `--light`
   * and `--none` presets skip the interview. `null`/absent =
   * `DEFAULT_SHARPEN_MAX_ROUNDS`.
   */
  sharpen_max_rounds?: number | null;
  /**
    * Fix mode (issue #6): when true, the implementer prompt injects the
    * diagnosing-bugs discipline — build a reproducer before hypothesizing,
    * minimize, rank 3-5 falsifiable hypotheses, change one variable at a time,
    * write the regression test before the fix, clean up debug logs. Set by
    * `railhead fix` at plan time; the railhead owns the environment so the model
    * never needs to "ask the user for access" (the interactive skill's escape
    * hatch collapses to "mark the ticket inconclusive"). False for `railhead
    * plan` / `railhead run`.
    */
    fix_mode?: boolean;
   /**
    * Feature mode (ADR 0051): the run extends an EXISTING product — the
    * planner gets the integration posture (no scaffold), the feature plan
    * docs live in the run's `.scratch/<slug>/docs` namespace, the run's
    * start checks the verify baseline is green, and the goal review judges
    * this run's feature scope against the product arc. Set by `railhead
    * feature`; `railhead build` clears it.
    */
   feature_mode?: boolean;
  /**
   * When true, the railhead writes a project-local `opencode.json` whose
   * `permission` block accepts ALL tool calls and external directories — no
   * rejections, ever, for the run. The escape hatch for a trusted build where
   * the user would rather the implementer not burn retry budget on
   * opencode's permission policy (a model that reads /tmp/*, or crate source
   * outside the pre-granted `~/.cargo/**`). TRADE-OFF: the run is fully
   * autonomous and will edit/bash/read anywhere opencode can reach; only
   * enable on a project you'd let an agent touch freely. Defaults to false.
   */
  yolo_permissions?: boolean;
  /**
   * Bash command globs the phase subprocesses must NOT run, injected as
   * opencode `deny` rules alongside the ledger guard. The mechanical backstop
   * for the prompt-level dependency-source rule: a model that greps a
   * dependency cache to pre-verify an API pulls multi-thousand-token source
   * dumps into its context — a durable builder session can fill its window
   * before writing a line. The railhead core stays technology-agnostic, so the
   * language-specific globs live HERE, in the project's railhead.json (e.g.
   * globs matching the package manager's registry-cache source directory or
   * the project's dependency install directory). Defaults to [] (off).
   */
  dependency_source_deny?: string[];
  /** Issue #39: keep one `opencode serve` process alive for the whole run
   * (or plan session), and have each `executeOpendCode` phase attach to it
   * via `opencode run --attach <url>` instead of spawning a standalone
   * subprocess. The server's KV cache stays warm across phases — the
   * system-prompt prefix (AGENTS.md + CONTEXT.md + contracts slice +
   * learnings) is evaluated once and reused, eliminating per-phase startup
   * cost. Each phase is still a fresh session (no `--continue`/`--session`),
   * so ADR 0001's fresh-context property holds; only the server process is
   * shared. ADR 0020 records the decision. Defaults to false — existing
   * runs spawn a fresh subprocess per phase (ADR 0001 baseline). */
  persistent_worker?: boolean;
  /**
   * ADR 0022 / issue #84: how many tickets the durable builder burns through
   * before expecting a `$CHECKPOINT` marker (`ticket` | `group` | `product`).
   * Routed into the builder prompt. Default `product` — one session for the
   * whole remaining build, with per-ticket gates and commits unchanged. Set
   * `ticket` to checkpoint after every ticket, `group` to gate whole planner
   * groups at once.
   */
  checkpoint_granularity?: CheckpointGranularity;
  model: ModelConfig;
  /** Per-ticket code review (v2 issue 01). Only `code_review.mode: "full"`
   * schedules a per-ticket diff review; the `light`/`medium` presets resolve
   * this to `"off"` — judged diffs from a same-tier judge caught nothing, and
   * the goal probes plus the structural review carry the signal. Cadence is
   * `code_review.mode`; the config default is `"off"`. */
  code_review?: CodeReviewConfig | null;
  /**
   * Visual review (ADR 0009/0011, issue #73). Cadence is `visual_review.mode`
   * (`full`/`medium` fire per-ticket after each commit, `full`/`light` fire
   * the end-of-run loop over the cumulative diff). On [BLOCKER] findings the
   * loop generates corrective tickets and re-runs, bounded by `max_rounds`
   * (defaults to `max_attempts`). Never fires when `mode: "off"` or when
   * `model.visual` is null — a text-only model cannot see the screen.
   */
  visual_review?: VisualReviewConfig | null;
  /**
   * Issue #19: goal-level evaluation. Cadence is `goal_review.mode`: after a
   * group's tickets all commit (or at the fallback cadence), a fresh-context
   * opencode phase evaluates the current build holistically against the
   * original goal (and `design.md` from #34, when present). Gaps are emitted
   * as corrective tickets that block all uncommitted tickets, then processed
   * through the full implement → verify → smoke → review → commit pipeline.
   * Never fires when `mode: "off"` or when the goal model seat is null.
   */
  goal_review?: GoalReviewConfig | null;
  /** Issue #49: structural whole-project review. Cadence is
    * `structural_review.mode` (checkpoint boundaries and/or run end, issue
    * #73). Flags architectural drift (duplicated abstractions, divergent
    * conventions, dead code, module-shape drift) that no per-ticket reviewer
    * can see. Generates refactoring tickets (testable: true), not corrective
    * tickets. Defaults to off — existing runs unaffected. */
  structural_review?: StructuralReviewConfig | null;
  /**
   * Interaction smoke (v2 issue 01): when on, a fresh opencode agent launches
   * the running app once per committed GROUP boundary and drives ONE real user
   * interaction with a render-delta assertion plus a zero-console-errors check
   * — an HTTP 200 or a listening port is not evidence. A FAIL feeds its
   * findings back to the builder before the boundary ticket commits; a PASS
   * without input+render evidence in the ledger downgrades to inconclusive.
   * No vision required: the agent asserts through DOM/a11y text, state reads,
   * or a pixel sample. Unset = derived by `interactionSmokeEnabled` (ON for a
   * declared `browser-ui`/`canvas` interface); an explicit boolean always
   * wins. Skipped silently when no model resolves or the declared interface is
   * `none`.
   */
  interaction_smoke?: boolean;
}

/**
 * Issue #73: the unified review-cadence model (ADR 0021). Every review gate
 * carries a `mode` field that controls BOTH cadence axes — how often the gate
 * fires mid-run and whether it fires once at run end:
 *
 *   `full`   mid-run natural cadence (per-ticket for code/visual, group
 *            checkpoint for goal/structural) AND the end-of-run pass.
 *   `medium` mid-run natural cadence only (no end-of-run pass). The extra
 *            state the issue's `--medium` preset needs — full-without-the-
 *            safety-net — that a 3-valued mode could not express.
 *   `light`  end-of-run pass only (skip every mid-run trigger). The new
 *            default run cadence: faster, integration gaps caught at the end.
 *            ADR 0029 exception: a goal gate under `light` STILL fires its
 *            group checkpoints when `checkpoint_action: "advisory"` is set —
 *            advisory-only, correction deferred to the run-end batch.
 *   `off`    gate never fires.
 */
export type GateMode = "full" | "medium" | "light" | "off";

export const GATE_MODES: readonly GateMode[] = ["full", "medium", "light", "off"];

/** Parse a gate-mode token, case-insensitive; null when absent/unrecognized. */
export function parseGateMode(s: string | null | undefined): GateMode | null {
  const v = s?.trim().toLowerCase();
  return (GATE_MODES as readonly string[]).includes(v ?? "") ? (v as GateMode) : null;
}

/** Fires at the gate's mid-run natural cadence (per-ticket for code/visual,
 * group checkpoint for goal/structural). `full` and `medium` only. */
export const firesMidRun = (mode: GateMode): boolean => mode === "full" || mode === "medium";

/** Fires once at run end (the integration safety net). `full` and `light`. */
export const firesAtRunEnd = (mode: GateMode): boolean => mode === "full" || mode === "light";

/** The four plan-time cadence presets. `--light` is the default run shape. */
export type GatePreset = "full" | "medium" | "light" | "none";

export interface PresetGateModes {
  code: GateMode;
  visual: GateMode;
  goal: GateMode;
  structural: GateMode;
  /** ADR 0029 (#102): the light preset's goal identity — goal mode `light`
   * (run-end corrective batch) + advisory group checkpoints. Only `light` sets
   * it; `medium`/`full` keep inline corrective checkpoints. */
  goalCheckpointAction?: GoalCheckpointAction;
}

/** Per-gate modes for a preset. `--medium` is the distinctive one: checkpoint
 * goal/structural (catch problems at group boundaries) but no end-of-run
 * goal/structural pass, no per-ticket visual, and — since v2 issue 01 — no
 * per-ticket code review (only `--full` schedules one; the group probes and
 * the structural review carry the code-quality signal). `--light` is the
 * default run shape: same cadence plus a run-end goal pass, with the goal
 * judge firing corrective-anchored checkpoints at group boundaries. */
export function presetGateModes(preset: GatePreset): PresetGateModes {
  switch (preset) {
    case "full":
      return { code: "full", visual: "full", goal: "full", structural: "full" };
    case "medium":
      return { code: "off", visual: "light", goal: "medium", structural: "medium" };
    case "light":
      return {
        code: "off", visual: "light", goal: "light", structural: "light",
        goalCheckpointAction: goalCheckpointActionFor("light") ?? undefined,
      };
    case "none":
      return { code: "off", visual: "off", goal: "off", structural: "off" };
  }
}

/** Whether the preset runs the planning sharpening interview (`--medium` and
 * `--full` do; `--light`/`--none` skip it — the fast default skips the
 * interview, issue #73). */
export const presetRunsSharpen = (preset: GatePreset): boolean => preset === "full" || preset === "medium";

/** Visual final + per-ticket review (ADR 0009/0011). Cadence is `mode`
 * (issue #73) — `full`/`medium` fire per-ticket, `full`/`light` fire the
 * end-of-run loop. Issue #97: the end-of-run whole-app pass is skipped when
 * the goal review owns that seat (goal `full`/`light` with a resolved goal
 * model) — goal review judges the integrated build against the original goal
 * and design doc, a stronger frame than visual's per-ticket criteria union.
 * Never fires when `model.visual` is null — a text-only model cannot see the
 * screen. */
export interface VisualReviewConfig {
  mode: GateMode;
  /** Absolute cap on visual-review rounds (each fail generates tickets + re-review). `null` = max_attempts. */
  max_rounds?: number | null;
  /** Issue #96: absolute wall-clock cap, in seconds, on ONE visual-review
   * round (one run-the-app judge pass). Step count is meaningless when each
   * step is a slow tool call — a wedged or merely crawling interaction
   * target can burn an hour across a handful of ~60s-timeout steps while the
   * step budget (hundreds) and the silence stall timer (re-armed on every
   * timeout error) both stay silent. This is the per-round "minutes, not
   * steps" bound; the executor's degraded-target guard catches the *timeout*
   * spiral fast, this catches the slow-but-loud round that never times out.
   * `null`/absent = `DEFAULT_VISUAL_ROUND_WALL_SEC` (one hour — a pure
   * safety net, never a discriminator, sized to tolerate any legitimate
   * slow round the way `stall_timeout_sec` is); `0` disables. Threaded
   * through `runReviewAgent` to the executor's phase wall-clock option. */
  round_wall_sec?: number | null;
  /** Project-provided interaction hints for visual review (#20). Injected
   * verbatim into the visual review prompt so the model doesn't have to
   * discover the interaction model from scratch. E.g. "The game uses
   * requestPointerLock + KeyboardEvent on window. Override
   * document.pointerLockElement, then dispatch KeyboardEvent for WASD."
   * Saves ~15-20 explore steps per visual review phase. */
  interaction_hints?: string | null;
}

/** The value `GoalReviewConfig.checkpoint_action` can hold. `"advisory"` is
 * the legacy ADR 0029 shape: the goal judge fires at group checkpoints
 * advisory-only (findings recorded + steering; correction deferred to the
 * run-end batch). `"corrective"` is the v2 default for `light` (v2 issue 01):
 * the judge fires at group checkpoints and ANCHORED [BLOCKER] findings splice
 * corrective tickets inline through the ordinary corrective pipeline — the
 * unanchored ones stay steering-only, and replans stay max_replans-capped. See
 * the field's doc for the full contract. */
export type GoalCheckpointAction = "advisory" | "corrective";

/** Parse a goal checkpoint-action token; null when absent or unrecognized
 * (callers treat null as "mode decides"). Mirrors `parseGateMode`. */
export function parseGoalCheckpointAction(s: string | null | undefined): GoalCheckpointAction | null {
  const v = s?.trim().toLowerCase();
  if (v === "advisory" || v === "corrective") return v;
  return null;
}

/** The preset-application rule for the goal checkpoint action: goal mode
 * `light` is corrective-anchored at group boundaries as of v2 issue 01 — the
 * judge sees early, and its anchored blockers splice corrective tickets ahead
 * of the frontier while unanchored findings stay advisory. `medium`/`full`
 * already fire inline-corrective checkpoints (null = mode decides). */
export function goalCheckpointActionFor(mode: GateMode): GoalCheckpointAction | null {
  return mode === "light" ? "corrective" : null;
}

/** Issue #19: goal-level evaluation. Cadence is `mode` (issue #73) —
 * `full`/`medium` fire at group checkpoints (or the fallback cadence),
 * `full`/`light` fire the end-of-run pass. Never fires when the goal model
 * seat is null. */
export interface GoalReviewConfig {
  mode: GateMode;
  /** v2 issue 01 / ADR 0029: the mid-run checkpoint's action.
   * - `"corrective"` (the light-preset default): the goal judge fires at group
   *   checkpoints (and the fallback cadence); anchored [BLOCKER] findings
   *   generate corrective tickets inline through the ordinary pipeline, while
   *   unanchored findings stay recorded steering; `$REPLAN` remains
   *   max_replans-capped.
   * - `"advisory"` (legacy): findings recorded + `CHARTER:`/`LEARNED:`/`DIGEST:`
   *   steering applied, ZERO corrective tickets, correction deferred to the
   *   gate's run-end batch.
   * - Absent: mode decides — `full`/`medium` fire mid-run with inline
   *   corrective tickets; `light` also fires corrective checkpoints (v2
   *   default). */
  checkpoint_action?: GoalCheckpointAction;
  /** When the planner does not emit group labels, run a goal review every N
    * committed tickets (the fallback cadence). Defaults to 4. */
  fallback_cadence?: number;
  /** Absolute cap on goal-review rounds per checkpoint. `null` = max_attempts. */
  max_rounds?: number | null;
  /** gh #116: cap on the number of goal-review replans (`$REPLAN` frontier
   * regenerations) a single run will honor. A `$REPLAN` past the cap is
   * refused with a logged "plan re-scoped N times" line and the verdict falls
   * back to corrective tickets (or soft-passes when there are no [BLOCKER]s).
   * `null`/absent = `DEFAULT_MAX_REPLANS` (2). */
  max_replans?: number | null;
  /** Project-provided interaction hints for goal review. Same semantics as
    * `VisualReviewConfig.interaction_hints` — injected verbatim so the goal
    * reviewer can interact with the running app without discovering the model
    * from scratch. */
  interaction_hints?: string | null;
}

/** Whether the goal gate fires its mid-run group checkpoints. `full`/`medium`
 * always do; `light` now does too (v2 issue 01: corrective-anchored — anchored
 * blockers splice corrective tickets, unanchored findings stay steering), and
 * a persisted legacy `checkpoint_action: "advisory"` keeps the advisory
 * processing. `off` never fires. */
export function goalFiresCheckpointsMidRun(cfg: GoalReviewConfig | null | undefined): boolean {
  if (!cfg || cfg.mode === "off") return false;
  if (cfg.mode === "light") return true;
  return firesMidRun(cfg.mode);
}

/** Whether a goal-review invocation is the advisory variant (ADR 0029): a
 * mid-run group checkpoint under `checkpoint_action: "advisory"` whose gate
 * still owns a run-end corrective seat (`light`/`full`). The run-end pass
 * itself is never advisory, and a `medium` gate ignores the knob — mode
 * decides, so its inline-corrective contract (and the run-end batch a record
 * without correction would need) can't be silently dropped. Single predicate,
 * shared by the loop so firing and processing cannot disagree. */
export function goalCheckpointIsAdvisory(cfg: GoalReviewConfig | null | undefined, runEnd: boolean | undefined): boolean {
  if (runEnd) return false;
  if (!cfg || cfg.checkpoint_action !== "advisory") return false;
  return firesAtRunEnd(cfg.mode);
}

/** Issue #49: structural whole-project review. Cadence is `mode` (issue #73) —
 * same semantics as the goal gate (checkpoints + end-of-run under `full`,
 * checkpoint-only under `medium`, end-of-run-only under `light`). */
export interface StructuralReviewConfig {
  mode: GateMode;
}

/** Per-ticket code review (issue #73; v2 issue 01). Only `full` schedules it
 * mid-run: the code review reviews each ticket's working diff after verify
 * passes and before commit. `mode` controls which finding severities trigger
 * retry:
 * - `full`: `[BLOCKER]` and `[MAJOR]` trigger retry; minor are noted.
 * - `medium`/`light`: not scheduled per-ticket by the presets (the mode only
 *   selects the severity policy if a hand-written `railhead.json` schedules it).
 * - `off` (the default): no code review.
 *
 * The end-of-run advisory pass (`finalReviewPass`) was removed — it was
 * redundant with per-ticket review and its findings had no teeth. */
export interface CodeReviewConfig {
  mode: GateMode;
  /**
   * Whether the per-ticket reviewer inherits the project's ordinary toolset
   * (the same observe seat visual/goal/structural use) or runs on the isolated
   * reviewer agent that denies every tool. `true` (the default) is the bypass:
   * the reviewer may read, search, and run read-only commands to verify the
   * diff instead of judging the prompt alone. `false` restores the sandboxed
   * diff-only seat. Absent = the default (`true`).
   */
  inherit_tools?: boolean;
}

/** Whether a given finding severity should trigger a retry in the per-ticket
 * review gate. `light` retries on `blocker` with the full budget and on
 * `major` at most once per ticket (the one-shot is orchestration in run.ts,
 * not this threshold — `severityTriggersRetry` stays "does light ever burn
 * budget on a major?" and answers no); `medium`/`full` retry on `blocker` and
 * `major` through the gate machine. `off` never reaches here (the gate doesn't
 * fire). `minor` never triggers retry in any mode (ADR 0005). */
export const severityTriggersRetry = (
  sev: "blocker" | "major" | "minor",
  mode: GateMode,
): boolean => {
  if (sev === "minor") return false;
  if (sev === "blocker") return true;
  // major
  return mode === "medium" || mode === "full";
};

/** Whether code review runs per-ticket (mid-run). `off` is the only mode that
 * skips per-ticket review — `light` runs per-ticket review too (BLOCKERs get
 * the full retry budget; MAJORs get one corrective attempt, issue #96). */
export const codeReviewRunsMidRun = (mode: GateMode): boolean => mode !== "off";

/** v2 issue 01: whether the interaction smoke is on. An explicit
 * `interaction_smoke` value (true OR false) always wins; when unset it
 * defaults ON for a project whose declared interface is a browser page the
 * seat can drive (`browser-ui` / `canvas` — not `native`: the smoke drives a
 * browser, and a native window has none). The default is derived, not seeded
 * by the planner, so it holds for hand-written `railhead.json` files and for
 * projects planned before the interface was declared. */
export function interactionSmokeEnabled(
  config: Pick<RailheadConfig, "interaction_smoke" | "projectInterface">,
): boolean {
  if (typeof config.interaction_smoke === "boolean") return config.interaction_smoke;
  return config.projectInterface === "browser-ui" || config.projectInterface === "canvas";
}

/** Whether the end-of-run visual whole-app pass should fire. Issue #97: it
 * fires under `full`/`light` UNLESS the goal review owns the same run-end
 * seat (goal mode `full`/`light` with a resolved goal model) — goal review
 * judges the integrated build against the original goal and design doc,
 * which is a stronger frame than visual's per-ticket criteria union, so a
 * visual pass firing beside it is a weaker duplicate. When goal is off (or
 * has no model) at run end, visual is the whole-app seat and fires. */
export function visualFiresAtRunEnd(
  visualMode: GateMode,
  goalMode: GateMode,
  goalModelResolved: boolean,
): boolean {
  if (!firesAtRunEnd(visualMode)) return false;
  const goalOwnsRunEnd = firesAtRunEnd(goalMode) && goalModelResolved;
  return !goalOwnsRunEnd;
}

/** Concrete fallback for `sharpen_max_rounds` — a named export (not a bare
 * magic number) so callers that need a definite `number` (not the config
 * field's `number | null | undefined`) share one source of truth, the same
 * pattern as `DEFAULT_MAX_STEPS`/`DEFAULT_VERIFY_TIMEOUT_SEC` elsewhere. */
export const DEFAULT_SHARPEN_MAX_ROUNDS = 6;

/** Concrete fallback for `stall_timeout_sec` (issue #55). A stall timer that
 * resolves to `Infinity` (the previous null-default path) disables stall
 * detection entirely — a hung opencode subprocess ran forever. The default is
 * one hour: a pure safety net for unattended runs, set deliberately high so
 * it never interrupts a slow-but-alive phase. Reasoning models can legitimately
 * sit silent on a single step for a long stretch (deep prefill, one long
 * thinking chain) and this timer must tolerate that — its job is to catch a
 * genuinely silent child, not to judge how long a step may take. Shared with
 * the executor (which also uses it as its own default when the option is
 * omitted) so both sides agree on what "unset" means.
 */
export const DEFAULT_STALL_TIMEOUT_SEC = 3600;

/**
 * Concrete fallback for `max_step_model_sec` (issue #78). One hour per step of
 * model time (prefill + thinking + generation) sits far above the observed
 * legitimate ceilings on the incident hardware yet still bounds the "0 tok/s
 * forever" thrash a silence timer never sees (a wedged server emits nothing).
 * The cap is deliberately not a discriminator — a wrong kill costs one
 * resumable retry (issue #80's ladder); an undetected thrash costs hours. Set
 * at the same one-hour default as `DEFAULT_STALL_TIMEOUT_SEC` so the two
 * guards agree on the tolerance; users who want a tighter per-step bound
 * configure it explicitly. Shared with the executor as its own default when
 * the option is omitted, mirroring `DEFAULT_STALL_TIMEOUT_SEC`.
 */
export const DEFAULT_MAX_STEP_MODEL_SEC = 3600;

/**
 * Concrete fallback for `visual_review.round_wall_sec` (issue #96). One hour
 * for a WHOLE visual-review round — the same pure-safety-net posture as
 * `DEFAULT_STALL_TIMEOUT_SEC` and `DEFAULT_MAX_STEP_MODEL_SEC`: deliberately
 * sized to never interrupt a slow-but-legitimate round, so a wrong kill (a
 * project whose visual round genuinely needs an hour) costs one resumable
 * retry instead of hours of undetected spiral. The sharp per-round bound for
 * the reported shape (a ~60s-per-call timeout spiral) is the executor's
 * degraded-target burst guard, which fires in minutes; this is the wall-clock
 * backstop that also catches a slow-but-loud round with no timeout errors.
 */
export const DEFAULT_VISUAL_ROUND_WALL_SEC = 3600;

/** gh #116: fallback for `goal_review.max_replans`. Two is enough to recover
 * from a plan that was wrong in two distinct ways; beyond that a repeated
 * `$REPLAN` is more likely a reviewer stuck in a loop than a fresh plan-level
 * insight, so the verdict degrades to corrective tickets (or a soft-pass). */
export const DEFAULT_MAX_REPLANS = 2;

/** Default `infra_backoff_sec`: the waits before the ladder's two retries
 * (rung 1 identical retry, rung 2 worker-restart retry). Minute-scale on
 * purpose — a deliberately restarted model server (a proxy bounce, an operator
 * reboot, a KV-cache flush) is down for minutes, and the old 5s/15s waits let
 * all three attempts land inside the outage and hard-fail a healthy run. A
 * plain blip now costs ~1 min; an unattended run can afford that far more than
 * it can afford a false terminal failure. The trailing entries are unused by
 * the three-rung ladder (rung 3 is terminal) but kept as a forward-compatible
 * schedule; a project overrides this in its own `railhead.json`. */
export const DEFAULT_INFRA_BACKOFF_SEC = [60, 300, 900, 1800];

/** Fallback step budget when no context budget is configured, and the floor
 * for `resolveStepBudget`. 120 covers a hard ticket on a small model — the
 * ADR 0040 incident ticket needed 95 steps, and a routine first ticket
 * already uses ~50, so 80 left less than one retry of headroom. The durable
 * builder resumes across the cap, so hitting it is wasteful, never fatal. */
const FALLBACK_STEP_BUDGET = 120;

/** Default request ceiling when no model limit can be detected and no explicit
 * ceiling is configured. Issue #79: 64k — ADR 0014's working-context operating
 * point, not a guess at the model's whole window. With detection working, the
 * ceiling is the model's configured opencode limit (ADR 0014 amendment: the
 * safety margin lives in `limit.context`, not in a second harness fraction). */
export const DEFAULT_CONTEXT_TOKENS = 64_000;

/**
 * Scale the step budget from the context-token budget. Each model step
 * consumes roughly 1k tokens of output + tool I/O on average (some steps
 * are a one-line text reply, others are a read+write+test sequence).
 * The budget scales linearly so a 250k context gets ~250 steps (enough for
 * a complex ticket that reads many files and iterates on verify) and a
 * 128k context ~128.
 *
 * Floors at the fallback (120) so small contexts still get enough steps for
 * a hard ticket — the floor is the real default below a ~120k window; the
 * old /2000 slope made the scaling dead below 160k (64k → 32, floor wins),
 * which is why 80 read as an arbitrary constant rather than a derivation.
 */
export function resolveStepBudget(contextTokens: number | undefined, explicit?: number | null): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  if (!contextTokens || contextTokens <= 0) return FALLBACK_STEP_BUDGET;
  return Math.max(FALLBACK_STEP_BUDGET, Math.round(contextTokens / 1000));
}

export const DEFAULT_CONFIG: RailheadConfig = {
  verify: [],
  smoke: [],
  lint: [],
  max_retries: 3,
  max_review_retries: null,
  max_attempts: null,
  infra_backoff_sec: DEFAULT_INFRA_BACKOFF_SEC,
  max_phase_steps: FALLBACK_STEP_BUDGET,
  context_guard: "telemetry",
  verify_timeout_sec: null,
  stall_timeout_sec: DEFAULT_STALL_TIMEOUT_SEC,
  max_step_model_sec: DEFAULT_MAX_STEP_MODEL_SEC,
  ticket_step_budget: null,
  ticket_wall_sec: null,
  on_block: "continue",
  sharpen_max_rounds: DEFAULT_SHARPEN_MAX_ROUNDS,
  yolo_permissions: false,
  dependency_source_deny: [],
  persistent_worker: false,
  checkpoint_granularity: "product",
  fix_mode: false,
  feature_mode: false,
  art_direction: true,
  model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: DEFAULT_MODEL, visual: null, extract: null, goal: null },
  code_review: { mode: "off", inherit_tools: true },
  visual_review: { mode: "off", max_rounds: null, round_wall_sec: null, interaction_hints: null },
  goal_review: { mode: "off", fallback_cadence: 4, max_rounds: null, max_replans: DEFAULT_MAX_REPLANS, interaction_hints: null },
  structural_review: { mode: "off" },
  provider: null,
};

/** Read railhead.json, falling back to DEFAULT_CONFIG for missing keys or a bad file. */
export async function loadConfig(cwd: string): Promise<RailheadConfig> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, "railhead.json"), "utf8");
  } catch {
    return { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model } };
  }
  let j: Record<string, any>;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model } };
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) {
    return { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model } };
  }
  // Issue #97: an unknown DECLARED interface throws HERE, outside the mapping's
  // fallback, so a railhead.json typo surfaces at run start instead of quietly
  // running with legacy (undeclared) behavior.
  const projectInterface = parseProjectInterface(j["interface"]);
  // Issue #134: a malformed declared provider block is a typo that must fail
  // at load, not silently disable the health probe (same rule as `interface`).
  const provider = parseProviderConfig(j.provider);
  try {
    const model = (j.model ?? {}) as Record<string, any>;
    const codeReview = (j.code_review ?? {}) as Record<string, any>;
    const visualReview = (j.visual_review ?? {}) as Record<string, any>;
    const goalReview = (j.goal_review ?? {}) as Record<string, any>;
    const structuralReview = (j.structural_review ?? {}) as Record<string, any>;
    // Issue #73 gate modes. A railhead.json from before the unified-mode change
    // spells gates as `{ enabled, per_ticket }` / `{ enabled, at_run_end }` —
    // read the old shape as a fallback (the same precedent as
    // `grill_max_rounds` below) so a pre-#73 config silently stops running a
    // gate it thought was on. The mapping preserves each old config's cadence:
    // visual per_ticket:true (per-ticket + end) → `full`, per_ticket:false
    // (end only) → `light`; goal (checkpoints only — it had no end-of-run
    // pass) → `medium`; structural at_run_end defaulting true (checkpoints +
    // end) → `full`, at_run_end:false → `medium`.
    const modeOf = (obj: Record<string, any>, fallback: GateMode, legacy: (obj: Record<string, any>) => GateMode): GateMode =>
      parseGateMode(obj.mode) ?? ("enabled" in obj ? legacy(obj) : fallback);
    return {
      verify: Array.isArray(j.verify) ? j.verify : DEFAULT_CONFIG.verify,
      projectInterface,
      provider,
      smoke: Array.isArray(j.smoke) ? j.smoke : DEFAULT_CONFIG.smoke,
      lint: Array.isArray(j.lint) ? j.lint : DEFAULT_CONFIG.lint,
      max_retries: j.max_retries ?? DEFAULT_CONFIG.max_retries,
      max_review_retries: j.max_review_retries ?? DEFAULT_CONFIG.max_review_retries,
      max_attempts: j.max_attempts ?? DEFAULT_CONFIG.max_attempts,
      infra_backoff_sec: j.infra_backoff_sec ?? DEFAULT_CONFIG.infra_backoff_sec,
      max_context_tokens: j.request_ceiling_tokens ?? j.max_context_tokens,
      max_phase_steps: resolveStepBudget(j.request_ceiling_tokens ?? j.max_context_tokens, j.max_phase_steps),
      context_guard: parseContextGuard(j.context_guard) ?? DEFAULT_CONFIG.context_guard,
      verify_timeout_sec: j.verify_timeout_sec ?? DEFAULT_CONFIG.verify_timeout_sec,
      smoke_timeout_sec: j.smoke_timeout_sec ?? DEFAULT_CONFIG.smoke_timeout_sec,
      stall_timeout_sec: j.stall_timeout_sec ?? DEFAULT_CONFIG.stall_timeout_sec,
      // Issue #78: an explicit null means "disabled", unlike stall_timeout_sec
      // where null resolves to the default — a null max_step_model_sec must
      // survive `??` so a user who wants silence-only detection can say so.
      max_step_model_sec: j.max_step_model_sec === undefined ? DEFAULT_CONFIG.max_step_model_sec : j.max_step_model_sec,
      // ADR 0040: `null` means "derive it" for the two budgets (unlike
      // max_step_model_sec's null-disables contract); an explicit 0 disables.
      ticket_step_budget: j.ticket_step_budget === undefined ? DEFAULT_CONFIG.ticket_step_budget : j.ticket_step_budget,
      ticket_wall_sec: j.ticket_wall_sec === undefined ? DEFAULT_CONFIG.ticket_wall_sec : j.ticket_wall_sec,
      on_block: j.on_block === "pause" ? "pause" : "continue",
      // `sharpen_max_rounds` was `grill_max_rounds` before the rename. Read the
      // old key as a fallback so a railhead.json from before the rename still
      // configures the interview — a silent break here would surprise a user
      // whose existing config suddenly stopped disabling the interview.
      sharpen_max_rounds: j.sharpen_max_rounds ?? legacyNumber(j, "grill_max_rounds") ?? DEFAULT_CONFIG.sharpen_max_rounds,
      yolo_permissions: j.yolo_permissions ?? DEFAULT_CONFIG.yolo_permissions,
      dependency_source_deny: Array.isArray(j.dependency_source_deny)
        ? j.dependency_source_deny.filter((g: unknown): g is string => typeof g === "string")
        : DEFAULT_CONFIG.dependency_source_deny,
      persistent_worker: j.persistent_worker ?? DEFAULT_CONFIG.persistent_worker,
      checkpoint_granularity: parseCheckpointGranularity(j.checkpoint_granularity) ?? DEFAULT_CONFIG.checkpoint_granularity,
      fix_mode: j.fix_mode ?? DEFAULT_CONFIG.fix_mode,
      feature_mode: j.feature_mode ?? DEFAULT_CONFIG.feature_mode,
      art_direction: j.art_direction === undefined ? DEFAULT_CONFIG.art_direction : j.art_direction === true,
      model: {
        plan: model.plan ?? DEFAULT_MODEL,
        implement: model.implement ?? DEFAULT_MODEL,
        review: model.review ?? DEFAULT_MODEL,
        visual: model.visual ?? null,
        extract: model.extract ?? null,
        goal: model.goal ?? null,
      },
      code_review: hasKeys(codeReview)
        ? {
            mode: modeOf(codeReview, DEFAULT_CONFIG.code_review!.mode, () => DEFAULT_CONFIG.code_review!.mode),
            inherit_tools: codeReview.inherit_tools === undefined
              ? DEFAULT_CONFIG.code_review!.inherit_tools
              : codeReview.inherit_tools === true,
          }
        : DEFAULT_CONFIG.code_review,
      visual_review: hasKeys(visualReview)
        ? {
            mode: modeOf(visualReview, DEFAULT_CONFIG.visual_review!.mode, (o) => legacyVisualMode(o.enabled, o.per_ticket)),
            max_rounds: typeof visualReview.max_rounds === "number" ? visualReview.max_rounds : null,
            // Issue #96: absent/null → the executor default (visual passes it
            // explicitly); 0 disables — like stall_timeout_sec, null never
            // silently disables a guard.
            round_wall_sec: typeof visualReview.round_wall_sec === "number" ? visualReview.round_wall_sec : null,
            interaction_hints: typeof visualReview.interaction_hints === "string" ? visualReview.interaction_hints : null,
          }
        : DEFAULT_CONFIG.visual_review,
      goal_review: hasKeys(goalReview)
        ? {
            mode: modeOf(goalReview, DEFAULT_CONFIG.goal_review!.mode, (o) => legacyGoalMode(o.enabled)),
            // ADR 0029 (#102): an unrecognized checkpoint_action token is
            // dropped (mode decides) rather than defaulted — advisory is the
            // only value the field carries meaning for.
            checkpoint_action: parseGoalCheckpointAction(goalReview.checkpoint_action) ?? undefined,
            fallback_cadence: typeof goalReview.fallback_cadence === "number" ? goalReview.fallback_cadence : DEFAULT_CONFIG.goal_review!.fallback_cadence,
            max_rounds: typeof goalReview.max_rounds === "number" ? goalReview.max_rounds : null,
            max_replans: typeof goalReview.max_replans === "number" ? goalReview.max_replans : DEFAULT_MAX_REPLANS,
            interaction_hints: typeof goalReview.interaction_hints === "string" ? goalReview.interaction_hints : null,
          }
        : DEFAULT_CONFIG.goal_review,
      structural_review: hasKeys(structuralReview)
        ? {
            mode: modeOf(structuralReview, DEFAULT_CONFIG.structural_review!.mode, (o) => legacyStructuralMode(o.enabled, o.at_run_end)),
          }
        : DEFAULT_CONFIG.structural_review,
      interaction_smoke: typeof j.interaction_smoke === "boolean" ? j.interaction_smoke : undefined,
    };
  } catch {
    return { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model } };
  }
}

/**
 * Read railhead.json as raw JSON, let the caller mutate it, then write it back
 * pretty-printed. Mutates the *raw* object (not the typed RailheadConfig) so
 * keys the railhead doesn't model (future fields, hand-edited extras) survive
 * the round-trip — that preservation is why the old cli.ts setConfig* helpers
 * parsed raw instead of loading typed. A missing/corrupt railhead.json starts
 * from an empty object (write a fresh config), mirroring the helpers.
 */
export async function updateConfig(cwd: string, mutate: (cfg: Record<string, unknown>) => void): Promise<void> {
  const target = join(cwd, "railhead.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
  } catch {
    /* write a fresh minimal config */
  }
  mutate(cfg);
  await writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Whether a parsed gate object carries any key at all — an empty `{}` in
 * railhead.json means "leave the gate at its default", the same as absent. */
function hasKeys(obj: Record<string, any>): boolean {
  return Object.keys(obj).length > 0;
}

/** Legacy `visual_review: { enabled, per_ticket }` → cadence mode (#73). */
function legacyVisualMode(enabled: unknown, perTicket: unknown): GateMode {
  if (enabled !== true) return "off";
  return perTicket === false ? "light" : "full";
}

/** Legacy `goal_review: { enabled }` → cadence mode. The old goal gate fired
 * only at group checkpoints (no end-of-run pass existed), so the faithful
 * mapping is `medium` — checkpoint-only. */
function legacyGoalMode(enabled: unknown): GateMode {
  return enabled === true ? "medium" : "off";
}

/** Legacy `structural_review: { enabled, at_run_end }` → cadence mode. */
function legacyStructuralMode(enabled: unknown, atRunEnd: unknown): GateMode {
  if (enabled !== true) return "off";
  return atRunEnd === false ? "medium" : "full";
}

/**
 * Read a numeric field that may live under a legacy key name. Returns `null`
 * when the key is absent or holds a non-number — the caller's `?? default`
 * then applies. Used for `grill_max_rounds` → `sharpen_max_rounds` compat.
 */
function legacyNumber(obj: Record<string, any>, legacyKey: string): number | null {
  const v = obj[legacyKey];
  return typeof v === "number" ? v : null;
}

/** Resolve CLI model flags (--plan --exec --implement --review) onto a config's model, in place. */
export function applyModelOverrides(
  model: ModelConfig,
  flags: string[],
): void {
  const or = (names: string[]): string | null => {
    for (const n of names) {
      const v = argValue(flags, n);
      if (v) return v;
    }
    return null;
  };
  model.plan = or(["--plan"]) ?? model.plan;
  model.implement = or(["--exec", "--implement"]) ?? model.implement;
  model.review = or(["--review"]) ?? model.review;
  model.visual = or(["--visual"]) ?? model.visual;
  model.extract = or(["--extract"]) ?? model.extract;
  model.goal = or(["--goal-model"]) ?? model.goal;
}

/**
 * Resolve the effective per-phase models, applying the fallback chains.
 *
 * Semantics of model seat values after resolution:
 * - A named string (`"mtplx/qwen3-32b"`) — that model is used for this phase.
 * - `DEFAULT_MODEL` (`"default"`) — opencode's own configured default model
 *   is used (the railhead passes no `--model` flag).
 * - `null` — the phase is skipped entirely. No model is configured; the
 *   phase must not run.
 *
 * Fallback chains: when a seat is `DEFAULT_MODEL` (meaning "I didn't pick a
 * specific model"), it inherits from the implement seat — so setting only
 * `model.implement` to a named string cascades to plan/review/extract/visual/
 * goal unless they are explicitly set. A seat set to `null` stays `null`
 * (explicit skip, no fallback). A seat explicitly set to a named string or
 * the sentinel stays as-is.
 */
export function resolveModels(config: RailheadConfig, flags: string[]): ResolvedModels {
  const model = { ...config.model };
  applyModelOverrides(model, flags);
  const fallback = (seat: string | null, ...chain: (string | null)[]): string | null => {
    if (seat !== DEFAULT_MODEL) return seat;
    for (const next of chain) {
      if (next === DEFAULT_MODEL || next === null) continue;
      return next;
    }
    return DEFAULT_MODEL;
  };
  return {
    plan: fallback(model.plan, model.implement),
    implement: model.implement,
    review: fallback(model.review, model.implement),
    visual: fallback(model.visual, model.review, model.implement),
    extract: fallback(model.extract, model.implement),
    goal: fallback(model.goal, model.visual, model.review, model.implement),
  };
}

/** Issue #52: the goal seat's fallback chain (goal → visual → review → implement)
 *  means a user who sets only `model.implement` silently runs the same local
 *  model in the oversight seat. This surfaces that gap at run start. */
export function warnIfOversightModelIsLocal(
  config: Pick<RailheadConfig, "model" | "goal_review">,
  resolved: ResolvedModels,
): string[] {
  if (config.goal_review?.mode === "off" || config.goal_review?.mode === undefined) return [];
  if (resolved.goal === null || resolved.implement === null) return [];
  if (resolved.goal !== resolved.implement) return [];
  const display = resolved.goal === "default" ? "opencode default" : resolved.goal;
  return [
    `WARNING: goal review is enabled but model.goal resolves to the same model as model.implement (${display}) — oversight seats should run on a stronger hosted model to catch architectural drift the local implementer cannot see (ADR 0015, #52). Set model.goal in railhead.json to a hosted strong model.`,
  ];
}

/** Parse `opencode models --verbose` output and extract the context limit
 * for the named model. The output is a series of `provider/model\n{json}`
 * blocks; this function scans for JSON objects and matches by providerID/id.
 *
 * The `modelName` may be `provider/model` (e.g. `mtplx/qwen-9b`) or just
 * `model` (searches all providers). Returns `null` when the model isn't
 * found, the JSON is malformed, or the limit field is absent.
 *
 * This is a pure function — the caller supplies the raw output, making it
 * testable without spawning a subprocess. */
export function parseModelContextLimit(rawOutput: string, modelName: string): number | null {
  const lines = rawOutput.split("\n");
  let provider: string | null = null;
  let model: string = modelName;
  const slash = modelName.indexOf("/");
  if (slash >= 0) {
    provider = modelName.slice(0, slash);
    model = modelName.slice(slash + 1);
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line === "{") {
      const block: string[] = [];
      let depth = 0;
      while (i < lines.length) {
        const l = lines[i]!;
        block.push(l);
        depth += (l.match(/{/g) ?? []).length - (l.match(/}/g) ?? []).length;
        if (depth <= 0 && block.length > 1) break;
        i++;
      }
      try {
        const obj = JSON.parse(block.join("\n")) as Record<string, any>;
        const limit = obj?.limit;
        if (typeof limit?.context === "number" && limit.context > 0) {
          const objProvider = obj.providerID as string | undefined;
          const objModel = obj.id as string | undefined;
          if (objModel === model && (!provider || objProvider === provider)) {
            return limit.context as number;
          }
        }
      } catch {
        // malformed JSON block — skip
      }
    }
    i++;
  }
  return null;
}

/** Query `opencode models --verbose` and return the context limit for the
 * given model, or `null` if the command fails or the model isn't found. */
export async function queryOpencodeContextLimit(modelName: string | null): Promise<number | null> {
  if (!modelName) return null;
  try {
    const raw = execFileSync("opencode", ["models", "--verbose"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseModelContextLimit(raw, modelName);
  } catch {
    return null;
  }
}

/**
 * Compute the effective request ceiling: the largest single request the
 * railhead will let a phase send, resolved from the user's explicit value (or
 * the legacy `max_context_tokens` alias) against the model's context window.
 *
 * The model's window is ground truth (ADR 0014 amendment, 2026-09-25): the
 * detected number is opencode's EFFECTIVE `limit.context` for the model —
 * config overrides included — so the safety margin against a warm KV pool
 * belongs there, set by the operator (e.g. 80k when the server's hard limit is
 * 100k), not compounded by a second harness fraction. `opencode models
 * --verbose` is the source, so an operator-tuned limit is what both opencode's
 * compaction and the railhead see. When the user sets nothing, the ceiling is
 * the detected limit verbatim; an explicit value is honored as-is, clamped to
 * the window. Detection failure falls back to `DEFAULT_CONTEXT_TOKENS` (or the
 * explicit value).
 *
 * Returns `{ budget, source }` so the caller can log which value won.
 */
export function effectiveContextTokens(
  configBudget: number | undefined,
  detectedLimit: number | null,
): { budget: number; source: "model" | "config" | "default" } {
  if (detectedLimit !== null) {
    if (configBudget && configBudget > 0) {
      return { budget: Math.min(configBudget, detectedLimit), source: configBudget <= detectedLimit ? "config" : "model" };
    }
    return { budget: detectedLimit, source: "model" };
  }
  if (configBudget && configBudget > 0) return { budget: configBudget, source: "config" };
  return { budget: DEFAULT_CONTEXT_TOKENS, source: "default" };
}

/** The effective context-token budget for a run, clamped to the model's
 * actual context window. Falls back to `max_context_tokens` from config (or
 * the default) when the runtime field is unset (e.g. on a state loaded from
 * disk before auto-detection ran). Structural param keeps config.ts free of a
 * state.ts runtime import (state.ts type-imports config, not the reverse). */
export function contextBudget(state: {
  _effectiveContextTokens?: number | null;
  config: { max_context_tokens?: number | null };
}): number {
  return state._effectiveContextTokens ?? state.config.max_context_tokens ?? DEFAULT_CONTEXT_TOKENS;
}

/** One seat's request ceiling, falling back to the run's implement-derived
 * budget when no per-seat value was resolved (a state loaded from disk, or a
 * seat with no configured model). */
export function seatContextBudget(
  state: {
    _seatContextTokens?: Partial<Record<SeatName, number>> | null;
    _effectiveContextTokens?: number | null;
    config: { max_context_tokens?: number | null };
  },
  seat: SeatName,
): number {
  return state._seatContextTokens?.[seat] ?? contextBudget(state);
}

/** Per-seat request ceilings. The operator's `request_ceiling_tokens` is the
 * IMPLEMENT seat's budget — init derives it from the implement model — and
 * every judging seat resolves ITS OWN model's configured opencode limit
 * verbatim (ADR 0014 amendment: the margin lives in `limit.context`, so no
 * second fraction). Applying the smallest seat's window to all seats is what
 * killed a 200k-window goal review at 95k: the implementer's 100k budget
 * capped it before opencode's compaction could ever run. A seat whose window
 * was not detected falls back to the operator ceiling (or the default). Pure. */
export function seatContextCeilings(
  models: ResolvedModels,
  windows: Partial<Record<SeatName, number | null>>,
  configCeiling: number | null | undefined,
): Partial<Record<SeatName, number>> {
  const out: Partial<Record<SeatName, number>> = {};
  for (const seat of SEAT_ORDER) {
    if (models[seat] === null) continue;
    const window = windows[seat] ?? null;
    out[seat] = seat === "implement" || window === null
      ? effectiveContextTokens(configCeiling ?? undefined, window).budget
      : Math.round(window);
  }
  return out;
}

/** One `opencode models --verbose` pass gives every distinct seat model's
 * context window (deduplicated). A failed query or an unknown model reads as
 * null, so {@link seatContextCeilings} falls back to the operator ceiling for
 * that seat. */
export async function querySeatContextWindows(models: ResolvedModels): Promise<Partial<Record<SeatName, number | null>>> {
  const distinct = [...new Set(SEAT_ORDER.map((s) => models[s]).filter((m): m is string => m !== null && m !== DEFAULT_MODEL))];
  const out: Partial<Record<SeatName, number | null>> = {};
  if (distinct.length === 0) return out;
  let raw = "";
  try {
    raw = execFileSync("opencode", ["models", "--verbose"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return out;
  }
  const byModel = new Map<string, number | null>(distinct.map((m) => [m, parseModelContextLimit(raw, m)]));
  for (const seat of SEAT_ORDER) {
    const model = models[seat];
    if (model === null) continue;
    out[seat] = model === DEFAULT_MODEL ? null : byModel.get(model) ?? null;
  }
  return out;
}
