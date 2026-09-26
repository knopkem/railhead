import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { isAbsolute, join } from "node:path";
import {
  assembleBranch,
  runLoop,
  startRun,
} from "../execute/run.ts";
import {
  applyModelOverrides,
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_SHARPEN_MAX_ROUNDS,
  effectiveContextTokens,
  loadConfig,
  parseGateMode,
  presetGateModes,
  presetRunsSharpen,
  queryOpencodeContextLimit,
  querySeatContextWindows,
  resolveModels,
  resolveStepBudget,
  seatContextCeilings,
  updateConfig,
  warnIfOversightModelIsLocal,
  type GateMode,
  type GatePreset,
  type PresetGateModes,
  type ResolvedModels,
  type RailheadConfig,
} from "../config/config.ts";
import * as git from "../core/git.ts";
import { latestRun, ledgerDir, listPhases, readState, readStderrLines, writeState, eventPath, findRunForBranch, removeRun } from "../core/ledger.ts";
import { parsePlanArgs, parseProductArgs, parseRunArgs, argValue, type PlanArgs, type ProductArgs } from "../config/args.ts";
import {
  GATES,
  resolveGateModes,
  resolveYolo,
  persistPolicy,
  fixModeForcesVisual,
  type GateCadenceAnswer,
  type GateName,
} from "../config/run-policy.ts";
import {
  planRecovery,
  reconcileCommittedButUnsaved,
  rebaseFrontier,
  shouldResume,
  checkTicketInvariants,
} from "../core/recovery.ts";
import type { TicketState, RunState } from "../core/state.ts";
import { renderStatusTable, writeReport, elapsedLabel, nowClock, renderNextActionable, renderArcSummary } from "./overview.ts";
import { runPlan, maybeGenerateAgentsMd, runSharpenSession, runProductSession, reviseProductArc, deriveFeaturePrompt, type ProductSessionResult } from "../plan/planner.ts";
import { readPlanOrigin } from "../plan/plan-identity.ts";
import { readProductPlan, writeProductPlan, nextArcAction, setStepStatus, PRODUCT_DOC, type ProductStep } from "../core/product.ts";
import {
  GRILL_DEPTH_OPTIONS,
  DEPTH_TARGET_QUESTIONS,
  depthToMaxRounds,
  isStopAnswer,
  readInterviewAnswers,
  renderPlanInterviewAnswers,
  type SharpenDepth,
  type SharpenDepthOption,
  type SharpenQuestion,
} from "../plan/sharpen.ts";
import { ensureProjectGitignore, ensureProjectOpenCodePermissions, frameworkIgnoreForVerify, frameworkExternalDirsForVerify } from "../core/project-assets.ts";
import { isRenderedSurface } from "../config/interface.ts";
import { renderTranscript } from "./transcript.ts";
import { loadTickets, titleSlug, toTicketState } from "../core/ticket.ts";
import { getDefaultModel, queryReasoningCapability, modelParameterClass, queryFreeModels, assignFreeModels, fetchModelsVerbose, createInitProber, type InitProbe } from "../core/models.ts";
import { runScreenshotDiagnostic, renderDiagnoseResult } from "./diagnose.ts";
import { describeVisionOutcome, ensureImplementerVision, ensureVisionForGates, recordVisionCapability, runVisionProbe, visionGateRequests, type VisionCapabilityRecord } from "../execute/vision-probe.ts";
import { configureProvider } from "../execute/provider-health.ts";
import { configureContextGuard } from "../execute/executor.ts";
import { resumeRefusal } from "../core/halt.ts";

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();

  switch (cmd) {
    case "build": {
      const prefs = parsePlanArgs(rest, "build");
      await ensureInitialized(cwd, prefs.auto);
      if (!prefs.prompt) throw new Error("build requires a description of what to build");
      await cmdBuild(cwd, prefs);
      break;
    }
    case "fix": {
      const prefs = parsePlanArgs(rest, "fix");
      await ensureInitialized(cwd, prefs.auto);
      if (!prefs.prompt) throw new Error("fix requires a description of the bug");
      await cmdBuild(cwd, prefs);
      break;
    }
    case "feature": {
      const prefs = parsePlanArgs(rest, "feature");
      await ensureInitialized(cwd, prefs.auto);
      await cmdFeature(cwd, prefs);
      break;
    }
    case "product": {
      const args = parseProductArgs(rest);
      await ensureInitialized(cwd, args.auto);
      await cmdProduct(cwd, args);
      break;
    }
    case "run": {
      await ensureInitialized(cwd);
      await cmdRun(cwd, rest);
      break;
    }
    case "resume": {
      await cmdResume(cwd, rest[0]);
      break;
    }
    case "status": {
      await cmdStatus(cwd, rest[0]);
      break;
    }
    case "next": {
      await cmdNext(cwd, rest[0]);
      break;
    }
    case "log": {
      await cmdLog(cwd, rest[0], rest[1]);
      break;
    }
    case "init": {
      const free = rest.includes("--free");
      const yes = rest.includes("-y") || rest.includes("--yes");
      await cmdInit(cwd, yes, free);
      break;
    }
    case "reset": {
      await cmdReset(cwd, rest);
      break;
    }
    case "diagnose": {
      await cmdDiagnose(cwd, rest);
      break;
    }
    default:
      usage();
  }
}

function usage() {
  console.log(`usage: railhead <command>

  build "<what to build>" [--model M] [-a] [-c] [--full|--medium|--light|--none]
       [--review M|full|light|off] [--vision full|light|off] [--goal full|light|off]
       [--structural full|light|off] [--sharpen|--no-sharpen] [--yolo] [--verbose]
       turn a description into dependency-ordered tickets, then run them (issue #73)
        each gate (code/visual/goal/structural review) has a cadence mode:
          full   = mid-run triggers + end-of-run pass
          medium = mid-run triggers only (goal/structural group checkpoints)
          light  = end-of-run pass only (the default run shape; the goal gate
                   additionally fires advisory at group checkpoints under the
                   light preset — ADR 0029)
          off    = gate never fires
        presets:  --light  per-ticket code review; run-end goal/structural (default)
                  --medium per-ticket code review + goal/structural checkpoints
                  --full   everything on (per-ticket visual too)
                  --none   plan -> implement -> verify -> commit, no reviews
       -a/--auto: no human prompts (light preset unless another is given); auto-start
       -c:        ask all questions, then auto-start the run
       --sharpen/--no-sharpen: boolean override (presets default the sharpening
       interview off under --light/--none)
       a clarifying interview runs when a preset runs sharpen (--medium/--full) unless
       --no-sharpen; under -a the model auto-answers (terms/ADRs still resolve).
  fix  "<bug report>" [--model M] [-a] [-c] [--full|--medium|--light|--none]
       [--review ...] [--vision ...] [--goal ...] [--structural ...]
       [--sharpen|--no-sharpen] [--yolo] [--verbose]
       turn a bug report into a fix ticket, then run it
        fix mode forces visual_review.mode: full (bug reproducer is the test, #6)
        flags: same as build above
  feature ["<one feature>"] [--step N] [flags as build]
       [--review ...] [--vision ...] [--goal ...] [--structural ...]
       [--sharpen|--no-sharpen] [--yolo] [--verbose] [-a]
       build ONE unattended feature of the product arc (ADR 0051). With no
        description: the first eligible roadmap step in docs/product.md is
        derived into the feature prompt; a built-but-unverified step blocks
        the next until you mark it done or reopen it; --step N forces a step.
        On finish the step is marked built and the arc update is committed on
        the run branch — test it, then answer done / leave / reopen.
  product "<overall vision | steering>" [--model M] [-a] [--verbose]
       [--sharpen|--no-sharpen]
       condense (or steer) the product arc — docs/product.md: vision, traits,
        workflows, the decided stack, and the ordered roadmap of feature
        steps. A sharpening interview (depth picker) questions the MVP cut and
        each step's outcome before the full arc is shown for adoption; adoption
        is explicit unless -a/--auto.
   init [--free] [-y]                     scaffold a default railhead.json in the current directory
        all five model seats (plan/implement/review/visual/goal) are asked up front and default to
        the opencode default; each is probed once for availability, context limit, vision and reasoning.
        review cadence is written OFF here (code=light, run-end only) — presets and
        per-gate flags set them per run at plan time (issue #73)
        --free:   auto-discover free models (cost=0) from \`opencode models\` and assign the
                  best-scoring model to each of the five seats, then run the same capability probe
        -y/--yes: skip all prompts — every seat uses the opencode default, context = min detected
  run <tickets-dir> [--pause-on-failure] [-m N] [--quiet] [--verbose] [--fresh]
       [--review full|medium|light|off] [--vision full|medium|light|off]
       [--goal full|medium|light|off] [--structural full|medium|light|off]
       [--plan M] [--exec M] [--review M] [--visual M]
       [--extract M] [--goal-model M]                                      run the ticket queue
       (auto-resumes an interrupted run; --fresh starts new)
       per-gate flags override the cadence persisted in railhead.json (issue #73);
       --review with a model name sets the review seat model (as before)
  resume [<run-id>]                    continue a stopped/interrupted run
   status [<run-id>]                    show a live summary of a run
   next [<run-id>]                      show the next actionable ticket(s) and what's blocked
   log [<run-id>] [<phase>]             print a phase transcript from the latest (or named) run
       e.g. railhead log 01-01-implement
            railhead log run-20260824-2354 02-02-review
       with no phase: lists every phase in the run
   reset [--hard]                       abandon the latest interrupted run (removes .railhead/run-<id>/)
        --hard also discards git work on the run branch back to the branch point
   diagnose screenshots [--model M]     test whether the model can take a screenshot and read it back
       spawns a real opencode run with the visual model — no app build needed.
       verifies: take_screenshot with a repo-relative path → read the saved PNG.
       use this before an unattended run to catch tool-availability issues.`);
}

export function describeModel(m: string | null): string {
  if (m === null) return "skip";
  if (m === DEFAULT_MODEL) return "opencode default";
  return m;
}

function printModels(models: ResolvedModels): void {
  console.log(`models: plan=${describeModel(models.plan)} implement=${describeModel(models.implement)} review=${describeModel(models.review)} visual=${describeModel(models.visual)} extract=${describeModel(models.extract)}`);
}

/** Re-exported from models.ts — the lossy parser is unit-tested there (ADR 0015). */
export { modelParameterClass } from "../core/models.ts";

// ---------------------------------------------------------------------------
// init (issue #74): the five model seats asked up front and probed in one pass
// ---------------------------------------------------------------------------

/** The five judgment seats `railhead init` configures. `extract` is deliberately
 * absent — it is a separate cheap seat (ADR 0015), configured later, never by
 * init. */
const INIT_SEATS = [
  { role: "plan", label: "planning", prompt: "Model for planning" },
  { role: "implement", label: "implementation", prompt: "Model for implementation" },
  { role: "review", label: "review", prompt: "Model for review" },
  { role: "visual", label: "visual", prompt: "Model for visual review" },
  { role: "goal", label: "goal", prompt: "Model for goal review" },
] as const;

type InitRole = (typeof INIT_SEATS)[number]["role"];

/** The per-seat model choices init writes to railhead.json. A seat is either the
 * DEFAULT_MODEL sentinel ("opencode's default") or a concrete model id — never
 * null: init no longer leaves visual/goal unset, so raising their review mode
 * at plan time needs no config edit (issue #74). */
export type InitSeatModels = Record<InitRole, string>;

/** A seat together with its probe result, the shape the pure helpers below
 * consume so cmdInit stays thin and the message logic is unit-tested. */
export interface InitSeatProbe {
  role: InitRole;
  label: string;
  /** The model id shown to the user / reported for the seat (the resolved
   * default id when the seat is the opencode default — never the sentinel). */
  display: string;
  probe: InitProbe;
}

/**
 * Issue #74: init captures infrastructure only — the five seat models plus the
 * context budget. Cadence and enablement are plan-time concerns (issue #73):
 * gates are written with their defaults (code_review light — the end-of-run
 * pass; visual/goal/structural off). `visual`/`goal` seats hold a model (never
 * null) even though their gates are off so the seat is ready to be raised;
 * only `extract` stays null.
 */
export function initRailheadConfig(seats: InitSeatModels, contextBudget: number): RailheadConfig {
  return {
    ...DEFAULT_CONFIG,
    max_context_tokens: contextBudget,
    max_phase_steps: resolveStepBudget(contextBudget),
    model: { ...seats, extract: null },
  };
}

/** Smallest detected context limit across the configured seats; null when none
 * of the models could be found in the registry (issue #74 #3 — the bottleneck
 * is the min, so no single-model probe can miss a smaller seat). */
export function minDetectedContext(seats: readonly InitSeatProbe[]): number | null {
  const limits = seats
    .map((s) => s.probe.capabilities.contextLimit)
    .filter((n): n is number => n !== null && n > 0);
  return limits.length === 0 ? null : Math.min(...limits);
}

/** Informational warnings when the user overrides the budget above a seat's
 * detected context window — printed, never blocking (issue #74 #3). */
export function contextOverrideWarnings(seats: readonly InitSeatProbe[], budget: number): string[] {
  const out: string[] = [];
  for (const s of seats) {
    const limit = s.probe.capabilities.contextLimit;
    if (limit !== null && limit > 0 && budget > limit) {
      out.push(`warning: ${s.label} model (${s.display}) has a ${Math.round(limit / 1000)}k context limit — setting budget above this may be unstable`);
    }
  }
  return out;
}

/** Vision warnings for the oversight seats. Only when the seat's model was
 * actually found in the registry and lacks vision — an unknown model is not
 * claimed to be vision-blind (issue #74 #5: informational, never a gate). */
export function visionCapabilityWarnings(seats: readonly InitSeatProbe[]): string[] {
  const out: string[] = [];
  for (const s of seats) {
    if (s.role !== "visual" && s.role !== "goal") continue;
    if (!s.probe.capabilities.found || s.probe.capabilities.vision) continue;
    out.push(
      s.role === "visual"
        ? `warning: visual model (${s.display}) is not vision-capable — visual review will run but screenshots cannot be read`
        : `warning: goal model (${s.display}) is not vision-capable — goal review will run but screenshots cannot be read`,
    );
  }
  return out;
}

/** Judgment seats are 27B+ minimum per ADR 0015; `extract` is the narrow seat (9B OK). */
const JUDGMENT_SEATS = ["plan", "implement", "review", "visual", "goal"] as const;
const JUDGMENT_MIN_B = 27;

/** Operator-facing lines for the implement seat's probe result. The gates'
 * probe is announced by `ensureVisionGates`; this seat's is otherwise silent,
 * and a silent "blind" is exactly how a false negative disabled the visual
 * self-check for a whole run. Pure. */
export function implementerVisionLines(record: VisionCapabilityRecord | null): string[] {
  if (!record) return [];
  if (record.reads_images) {
    return [`vision probe: implement model ${record.model} can read images (verified ${record.verified_at})`];
  }
  if (record.probe_inconclusive) {
    return [`vision probe: implement model ${record.model} could not be verified (no image block came back) — visual self-checks stay off`];
  }
  return [`vision probe: implement model ${record.model} cannot read images — visual self-checks will be skipped`];
}

function warnIfWeakerThanImplement(
  seat: "review" | "goal",
  config: Pick<RailheadConfig, "model">,
  resolved: ResolvedModels,
): string | null {
  const seatModel = config.model[seat];
  const resolvedSeat = resolved[seat];
  if (seatModel === null || resolvedSeat === null) return null;
  const implSize = modelParameterClass(resolved.implement);
  if (implSize === null) return null;
  const seatSize = modelParameterClass(resolvedSeat);
  if (seatSize === null || seatSize >= implSize) return null;
  return `WARNING: model.${seat} (${resolvedSeat}, ~${seatSize}B) is a weaker tier than model.implement (${resolved.implement}, ~${implSize}B) — ${seat} should be at least as strong as the implementer (${seat === "review" ? "ADR 0015" : "#47"}).`;
}

/**
 * Emit the ADR 0015 advisory warnings for this run's model configuration.
 * Five failure modes are surfaced (advisory, never a hard reject):
 *  (1) `model.review` was unset and silently fell back to `model.implement`
 *      — the user may have meant to configure a stronger reviewer.
 *  (2) `model.visual` was unset and silently fell back to `model.review` (or
 *      `model.implement`) — the user may have meant to configure a separate
 *      vision-capable model.
 *  (3) A judgment-seat model (plan/implement/review/visual/goal) parses below 27B.
 *  (4) `model.review` is explicitly set but to a weaker tier than
 *      `model.implement` — review is judgment work that should not be weaker
 *      than the implementer it judges (ADR 0015).
 *  (5) `model.goal` is explicitly set but to a weaker tier than
 *      `model.implement` — the goal reviewer shapes the remaining plan and
 *      should not be weaker than the implementer whose work it reviews (#47).
 * `extract` is excluded from tier comparisons — it is the narrow seat where
 * 9B is endorsed.
 * Returns the warning lines so they're unit-testable; `cmdRun` logs them.
 */
export function modelTierWarnings(
  config: Pick<RailheadConfig, "model">,
  resolved: ResolvedModels,
): string[] {
  const out: string[] = [];
  if (config.model.review === DEFAULT_MODEL && resolved.implement !== DEFAULT_MODEL && resolved.implement !== null) {
    out.push(
      `WARNING: model.review unset, falling back to model.implement (${describeModel(resolved.implement)}) — a stronger reviewer than implementer is recommended (ADR 0015).`,
    );
  }
  if (config.model.visual === DEFAULT_MODEL && resolved.review !== DEFAULT_MODEL && resolved.review !== null) {
    out.push(
      `WARNING: model.visual unset, falling back to model.review (${describeModel(resolved.review)}) — a vision-capable model is recommended for visual review. Set model.visual if model.review lacks vision.`,
    );
  }
  for (const seat of JUDGMENT_SEATS) {
    const m = resolved[seat];
    const size = modelParameterClass(m);
    if (m !== null && size !== null && size < JUDGMENT_MIN_B) {
      out.push(
        `WARNING: model.${seat} (${m}) parses as ${size}B, below the 27B+ judgment-seat floor — the run may be unreliable (ADR 0015).`,
      );
    }
  }
  for (const seat of ["review", "goal"] as const) {
    const w = warnIfWeakerThanImplement(seat, config, resolved);
    if (w) out.push(w);
  }
  return out;
}

/** Ask a yes/no question on the terminal; `defaultYes` selects on empty input. */
async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  try {
    const answer = (await rl.question(question + suffix + " ")).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Ask a free-text numeric question; returns `fallback` on empty input. */
async function askNumber(question: string, fallback: number): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question + ` [${fallback}] `)).trim();
    if (!answer) return fallback;
    const n = Number(answer);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  } finally {
    rl.close();
  }
}

/** Ask a free-text question on the terminal; returns `fallback` on empty input. */
async function askText(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question + ` [${fallback}] `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

/**
 * Numbered one-of-many picker. Presents each option on its own line as
 * `  N. label — description`, then a single prompt. Accepts the number, or
 * empty input for `defaultIndex` (the recommended option). Re-asks on garbage
 * input (out-of-range, non-numeric, blank when no default) rather than
 * guessing — a sharpen depth picked by accident is exactly the kind of edge to
 * guard. Mirrors the `sharpen` skill's depth-picker UX, but in plain readline
 * since the agent-only `question` tool is unavailable to a real CLI.
 */
async function askPick(question: string, options: readonly SharpenDepthOption[], defaultIndex = 0): Promise<SharpenDepth> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const menu = options
    .map((o, i) => `  ${i + 1}. ${o.label} — ${o.description}`)
    .join("\n");
  const suffix = defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : "";
  try {
    while (true) {
      const raw = (await rl.question(`${question}\n${menu}\nPick${suffix} `)).trim();
      if (!raw) {
        if (defaultIndex >= 0) return options[defaultIndex].depth;
        continue;
      }
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        return options[n - 1].depth;
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Collect the user's answer to a sharpen question, defaulting to the
 * model's recommendation on empty input. The question itself (title, body,
 * recommended, with the ❓Qn header) has ALREADY been printed by the
 * `onQuestion` callback, so this only prompts for the answer — repeating
 * the question here would double-print it and misplace the cursor.
 *
 * Returns `null` when the user ends the interview early: the explicit `:done`
 * token (advertised in the prompt hint) or Ctrl-D on an empty line. The
 * session keeps every answer already given and still runs the revision.
 */
async function askAnswer(recommendation: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Ctrl-D closes the interface instead of submitting a line; abort the
    // pending question so it settles as a stop rather than hanging forever.
    const eof = new AbortController();
    rl.once("close", () => eof.abort());
    let raw: string;
    try {
      raw = await rl.question(`\n➡️ answer [${recommendation}] (:done to end the interview) `, { signal: eof.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return null;
      throw err;
    }
    const answer = raw.trim();
    console.log();
    return isStopAnswer(answer) ? null : answer || recommendation;
  } finally {
    rl.close();
  }
}

/** One-line interview outcome: count, rounds, whether the human stopped early,
 * and where the answers were persisted. Shared by the build/fix/product call
 * sites so an interrupted interview always says what was kept and where. */
function interviewSummary(count: number, rounds: number, stopped: boolean, answersPath: string | null): string {
  const early = stopped ? " — ended early at your request" : "";
  const saved = answersPath ? ` — saved to ${answersPath}` : "";
  return `${count} question(s) answered across ${rounds} round(s)${early}${saved}`;
}

async function cmdInit(cwd: string, yes: boolean = false, free: boolean = false): Promise<void> {
  const target = join(cwd, "railhead.json");
  if (await git.initGit(cwd)) {
    console.log(`initialized git repository in ${cwd}`);
  }
  if (existsSync(target)) {
    console.log(`railhead.json already exists at ${target}; leaving it unchanged.`);
    return;
  }

  const defaultModel = await getDefaultModel();
  const defaultLabel = defaultModel
    ? `opencode default (${defaultModel})`
    : "opencode default";

  // Issue #74: ask for (or auto-assign) ALL five seats up front — one question
  // block, no enablement branching. A seat's answer is stored as a concrete
  // model id or the DEFAULT_MODEL sentinel; pressing Enter on a slot means "use
  // the opencode default" for that slot.
  const seats = {} as InitSeatModels;
  if (free) {
    console.log(" discovering free models from `opencode models`…");
    const freeModels = await queryFreeModels();
    if (freeModels.length === 0) {
      throw new Error(
        "no free models found in `opencode models` output. " +
        "Check provider credentials or re-run `railhead init` without --free.",
      );
    }
    const assignment = assignFreeModels(freeModels);
    console.log(`  found ${freeModels.length} free model(s)`);
    for (const seat of INIT_SEATS) {
      // A role with no free candidate (e.g. no vision-capable model) falls back
      // to the opencode default so the seat is configured and ready to be
      // raised at plan time rather than silently skipped (never stored null).
      seats[seat.role] = assignment[seat.role] ?? DEFAULT_MODEL;
      console.log(`  ${seat.label}=${describeModel(seats[seat.role])}`);
    }
  } else if (yes) {
    for (const seat of INIT_SEATS) {
      seats[seat.role] = DEFAULT_MODEL;
    }
  } else {
    console.log(" configuring railhead.json — press Enter to accept each default");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      let lastExplicit: string | null = null;
      for (const seat of INIT_SEATS) {
        const currentDefault: string = lastExplicit ?? defaultLabel;
        const answer: string = (await rl.question(`${seat.prompt} [${currentDefault}] `)).trim();
        const resolved: string = answer && answer !== defaultLabel
          ? answer
          : (!answer && lastExplicit ? lastExplicit : DEFAULT_MODEL);
        if (resolved !== DEFAULT_MODEL) lastExplicit = resolved;
        seats[seat.role] = resolved;
      }
    } finally {
      rl.close();
    }
  }

  // One probe pass over all five seats: availability (opencode run) + context
  // limit / vision / reasoning (opencode models --verbose), deduplicated so five
  // seats on the same model test that model once.
  const prober = createInitProber(await fetchModelsVerbose());
  const probed: InitSeatProbe[] = [];
  const failures: string[] = [];
  console.log("\n testing model availability…");
  for (const seat of INIT_SEATS) {
    const value = seats[seat.role];
    const named = value !== DEFAULT_MODEL;
    const display = named ? value : (defaultModel ?? "opencode default");
    process.stderr.write(`  ${seat.label} (${display})… `);
    // A default seat runs the availability test with NO --model flag (opencode's
    // own default) but reports the resolved default model's registry caps.
    const probe = await prober(named ? value : null, named ? value : defaultModel);
    probed.push({ role: seat.role, label: seat.label, display, probe });
    if (probe.available) {
      const ctx = probe.capabilities.contextLimit !== null
        ? `${Math.round(probe.capabilities.contextLimit / 1000)}k`
        : "?";
      process.stderr.write(`ok (context: ${ctx}, vision: ${probe.capabilities.vision ? "yes" : "no"}, reasoning: ${probe.capabilities.reasoning ? "yes" : "no"})\n`);
    } else {
      process.stderr.write(`FAILED: ${probe.error ?? "unknown error"}\n`);
      failures.push(`${seat.label} (${display}): ${probe.error ?? "unknown error"}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `model check failed:\n  ${failures.join("\n  ")}\n\nFix the model configuration or provider credentials, then re-run \`railhead init\`.`,
    );
  }

  // Context budget = the min across all configured models (the bottleneck);
  // interactive init lets the user override it.
  const detectedMin = minDetectedContext(probed);
  const budgetDefault = detectedMin ?? DEFAULT_CONTEXT_TOKENS;
  let contextBudget = budgetDefault;
  if (detectedMin !== null) {
    const atMin = [...new Set(probed.filter((s) => s.probe.capabilities.contextLimit === detectedMin).map((s) => s.display))];
    const distinctLimits = new Set(probed.map((s) => s.probe.capabilities.contextLimit).filter((n): n is number => n !== null && n > 0));
    const bottleneck = distinctLimits.size > 1 && atMin.length > 0 ? `; bottleneck: ${atMin.join(", ")}` : "";
    console.log(` context budget: ${Math.round(detectedMin / 1000)}k (min across all configured models${bottleneck})`);
  } else {
    console.log(` context budget: ${Math.round(DEFAULT_CONTEXT_TOKENS / 1000)}k (default — none of the configured models' context limits were detectable)`);
  }
  if (!yes && !free) {
    const hint = detectedMin !== null
      ? ` (min across configured models: ${Math.round(detectedMin / 1000)}k)`
      : "";
    contextBudget = await askNumber(`Max context budget (tokens)${hint}?`, budgetDefault);
  }

  for (const w of contextOverrideWarnings(probed, contextBudget)) console.log(w);
  for (const w of visionCapabilityWarnings(probed)) console.log(w);

  // ADR 0036: measure vision capability for the seats that run the app —
  // implement (visual self-check), visual and goal (screenshot review). A
  // declared capability is a claim; the probe makes the round trip real, so a
  // blind seat is known here, before a plan spends hours. Init itself never
  // fails: the vision gates are off by default, so the result is recorded and
  // reported, and plan/run refuse only when a gate is actually requested.
  const visionCfg = initRailheadConfig(seats, contextBudget);
  const resolvedSeats = resolveModels(visionCfg, []);
  const distinctModels = new Map<string, { role: InitRole; model: string | null }>();
  for (const role of ["implement", "visual", "goal"] as const) {
    const model = resolvedSeats[role];
    if (model === null || distinctModels.has(model)) continue;
    distinctModels.set(model, { role, model });
  }
  if (distinctModels.size > 0) {
    console.log("\n testing image reading (vision probe)…");
  }
  for (const { role, model } of distinctModels.values()) {
    const label = role === "implement" ? "implementation" : role;
    process.stderr.write(`  ${label} (${model})… `);
    const outcome = await runVisionProbe({ cwd, model, maxContextTokens: contextBudget, maxSteps: 12 });
    await recordVisionCapability(cwd, outcome);
    if (outcome.ok) {
      process.stderr.write(`ok — read the generated PNG (${outcome.expectedColors.join(", ")})\n`);
      continue;
    }
    process.stderr.write(`FAILED — ${describeVisionOutcome(outcome)}\n`);
    if (role === "implement") {
      if (outcome.inconclusive) {
        console.log(`warning: the vision probe could not verify the implementer's image reading (no image block came back) — visual self-checks stay off until a probe passes.`);
      } else {
        console.log(`warning: the implementer cannot read screenshots — visual self-checks will be skipped; configure a vision-capable model.implement if you want them.`);
      }
    } else {
      console.log(`warning: ${role} review will be REFUSED at plan/run time until model.${role} can read images (or ${role}_review.mode is "off").`);
    }
  }

  // No enablement/cadence questions: gates are written with their defaults
  // (code=light run-end; visual/goal/structural=off) and presets at plan time
  // raise them (issue #73). Visual/goal seats still hold a model — never null —
  // so raising a mode needs no config edit (issue #74).
  const cfg = visionCfg;
  await writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log(`wrote ${target}`);
  console.log(`models: plan=${describeModel(cfg.model.plan)} implement=${describeModel(cfg.model.implement)} review=${describeModel(cfg.model.review)} visual=${describeModel(cfg.model.visual)} goal=${describeModel(cfg.model.goal)}`);
  console.log(`context budget: ${Math.round(contextBudget / 1000)}k tokens`);
  console.log(`review cadence: code=light (run-end); visual/goal/structural=off — raise gates at plan time with --full/--medium/--light/--none or per-gate flags`);
  console.log(`edit ${target} to change these, then run \`railhead build -a "<what to build>"\`.`);
}

/**
 * Commands that read railhead.json / require git run here: if the directory was
 * never `railhead init`-ed (no railhead.json), auto-init it so the command can
 * proceed instead of failing with a "run init first" error.
 */
export async function ensureInitialized(cwd: string, yes: boolean = false): Promise<void> {
  if (existsSync(join(cwd, "railhead.json"))) return;
  console.log("no railhead.json found — initializing (git + default config)…");
  await cmdInit(cwd, yes);
}

/**
 * ADR 0036: a vision-dependent gate must not run on a model the railhead has
 * measured blind. Every invocation that will use one probes the seat models
 * first — always, because a local server can swap the checkpoint behind a
 * model id — and refuses in seconds, before the plan or the run spends hours.
 * The probe result is recorded for the report and for prompt injection.
 *
 * The refusal is interactive-aware: an unattended run (no TTY, or `build -a`)
 * still hard-fails — silently dropping a requested gate is worse than
 * stopping — but an interactive operator is asked whether to continue with
 * the affected gates off (the operator with no vision-capable model at hand).
 * A continue downgrades the gates to "off" on the passed config (and the
 * returned modes) and the run proceeds unverified-visually. `persists` names
 * whether the caller will write the downgraded modes to railhead.json (build
 * does — the run it starts re-reads the file; run/resume are in-memory).
 * Returns the effective modes after any downgrade.
 */
async function ensureVisionGates<M extends { visual: GateMode; goal: GateMode }>(
  cwd: string,
  modes: M,
  models: Pick<ResolvedModels, "visual" | "goal">,
  config: RailheadConfig,
  opts: { canAsk?: boolean; persists?: boolean } = {},
): Promise<M> {
  const requests = visionGateRequests(modes, models);
  if (requests.length === 0) return modes;
  console.log("vision probe required — a vision-dependent review gate is enabled (ADR 0036)");
  const { records, refusals } = await ensureVisionForGates({
    cwd,
    requests,
    maxContextTokens: config.max_context_tokens,
  });
  for (const record of records) {
    console.log(`vision probe: ${record.model} can read images (verified ${record.verified_at})`);
  }
  if (refusals.length === 0) return modes;
  for (const refusal of refusals) {
    console.log(`vision gate problem: ${refusal.reason}`);
  }
  const gates = [...new Set(refusals.map((r) => r.gate))];
  const canAsk = opts.canAsk ?? process.stdin.isTTY === true;
  if (canAsk) {
    const cont = await askYesNo(
      `Continue with the vision-dependent gates disabled (${gates.join(", ")} → off)? The run will NOT be visually verified`,
      true,
    );
    if (cont) {
      const next: M = { ...modes };
      for (const gate of gates) (next as { visual: GateMode; goal: GateMode })[gate] = "off";
      if (gates.includes("visual")) config.visual_review = { ...config.visual_review, mode: "off" };
      if (gates.includes("goal")) config.goal_review = { ...config.goal_review, mode: "off" };
      const scope = opts.persists
        ? "saved to railhead.json — re-enable later with --vision/--goal or by editing the file"
        : "for this run only — railhead.json is unchanged";
      console.log(`vision gates disabled (${scope}): ${gates.join(", ")} → off`);
      return next;
    }
  }
  throw new Error(refusals.map((r) => `vision gate refused: ${r.reason}`).join("\n"));
}

async function cmdBuild(cwd: string, prefs: PlanArgs, internal: { arcStepNumber?: number; slug?: string } = {}): Promise<RunOutcome | null> {
  const { prompt, auto, cont, yolo: yoloFlag, verbose, modelOverride, mode, overrides, sharpen } = prefs;
  // Planner/interview mode vocabulary is `build` | `fix`; the CLI's build/fix
  // commands map onto it (sharpen/planner prompts differ in fix mode).
  // Issue #73: run cadence. A preset flag wins; otherwise `-a` and
  // interactive mode default to `light` — the fast default that defers all
  // review to run end. Interactive mode offers per-gate prompts whose
  // suggested defaults are the light preset's.
  const preset: GatePreset = prefs.preset ?? "light";
  const config = await loadConfig(cwd);
  // Persist an explicit --yolo flag into railhead.json so a resume / `railhead
  // run` (without re-passing the flag) honors it. The interactive prompt
  // below also persists; this handles the `-y --yolo` fully-automated path.
  if (yoloFlag && !config.yolo_permissions) {
    await persistPolicy(cwd, config, { yolo: true });
  }
  const models = resolveModels(config, modelOverride ? ["--plan", modelOverride] : []);
  printModels(models);

  // Clamp the context budget to the model's actual context window so the
  // railhead never sets a budget that exceeds what the model can handle.
  const implModel = models.implement;
  const detectedLimit = implModel !== null && implModel !== DEFAULT_MODEL
    ? await queryOpencodeContextLimit(implModel)
    : await queryOpencodeContextLimit(null);
  if (detectedLimit !== null && config.max_context_tokens && config.max_context_tokens > detectedLimit) {
    console.log(`WARNING: railhead.json max_context_tokens (${config.max_context_tokens}) exceeds the model's actual context window (${detectedLimit}) — clamping to ${detectedLimit}.`);
    config.max_context_tokens = detectedLimit;
  }
  let contextBudget = config.max_context_tokens ?? null;
  if (contextBudget == null) {
    const defaultBudget = detectedLimit ?? DEFAULT_CONTEXT_TOKENS;
    const hint = detectedLimit
      ? ` (opencode's model limit.context: ${(detectedLimit / 1000).toFixed(0)}k — lower it there to leave your server headroom)`
      : ` (default: ${(DEFAULT_CONTEXT_TOKENS / 1000).toFixed(0)}k — no opencode model limit detected; see ADR 0014)`;
    if (auto) {
      contextBudget = defaultBudget;
      console.log(`context budget: ${(contextBudget / 1000).toFixed(0)}k ${detectedLimit ? "(opencode's model limit.context — lower it there to leave your server headroom)" : "(default — no opencode model limit detected)"}`);
    } else {
      contextBudget = await askNumber(
        `No max context given${hint}. Set the context budget (tokens)?`,
        defaultBudget,
      );
    }
    await updateConfig(cwd, (cfg) => {
      cfg.max_context_tokens = contextBudget;
    });
    config.max_context_tokens = contextBudget;
  }

  // Yolo permission mode: the flag may have set it, or config may already have
  // it persisted. In interactive mode (not `-y`), ask the user — this is the
  // one permission decision that genuinely needs their call, because yolo
  // grants the implementer access BEYOND this repo (read/edit/bash anywhere
  // opencode can reach, plus all external directories). The flag and config
  // are the non-interactive ways to pre-decide; the prompt is the default path.
  // DECIDED BEFORE SHARPEN/RUNPLAN: a model may emit its plan as a `write` to
  // a scratch path (/tmp, ~/.cache); without the yolo `**` grant in opencode.json
  // that write auto-rejects and the plan is lost before parsing even runs. The
  // verify-derived external dirs grant (below, after runPlan) is a separate
  // concern that genuinely needs the plan's verify output.
  let yolo = resolveYolo({ flag: yoloFlag, configValue: config.yolo_permissions === true });
  if (!auto && !yolo) {
    const answer = await askYesNo(
      "Enable yolo permissions? (grants the implementer read/edit/bash access BEYOND this repo — e.g. ~/.cargo, /tmp, anywhere opencode can reach. Faster: no permission rejections to burn retries on. Riskier: the run is fully autonomous and will touch anything it can.)",
      false,
    );
    yolo = resolveYolo({ flag: yoloFlag, configValue: config.yolo_permissions === true, answer });
    if (yolo) await persistPolicy(cwd, config, { yolo: true });
  }
  const implSupportsReasoning = config.model.implement && config.model.implement !== DEFAULT_MODEL
    ? await queryReasoningCapability(config.model.implement)
    : false;
  await ensureProjectOpenCodePermissions(cwd, [], { yolo, contextTokens: config.max_context_tokens, implementModel: config.model.implement ?? undefined, clampReasoning: implSupportsReasoning });

  // Issue #73: resolve the run's per-gate review cadence, and the TDD test
  // phase (issue #5), BEFORE the planner runs. These questions are static —
  // nothing in them reads plan output — and answering them first lets the
  // ADR 0036 vision check refuse a blind seat before the plan's multi-hour
  // spend instead of after it. Base = the preset's modes (`light` unless
  // another preset was given — the new fast default), overlaid by per-gate CLI
  // overrides. Interactive mode (no preset, no gate overrides) prompts for
  // each gate with the light-preset defaults, and a "none — skip all reviews"
  // shortcut on the first prompt.
  const gateOverrideProvided = overrides.code !== undefined || overrides.visual !== undefined || overrides.goal !== undefined || overrides.structural !== undefined;
  const gateAnswer: GateCadenceAnswer | null = !auto && prefs.preset === null && !gateOverrideProvided
    ? await askGateCadence()
    : null;
  const visualEnabled = config.visual_review?.mode !== "off";
  let modes = resolveGateModes({
    preset: prefs.preset,
    overrides,
    fixMode: mode === "fix",
    hasVisionModel: models.visual !== null,
    visualEnabled,
    answer: gateAnswer,
  });
  const fixForcesVisual = fixModeForcesVisual(mode === "fix", visualEnabled, models.visual !== null);
  // ADR 0051: the mode vocabulary lives in one persisted place. `railhead
  // feature` sets feature_mode (and clears fix_mode — a fix run before it
  // must not leave bug-diagnosis discipline on the implementer); build/fix
  // clear feature_mode the same way.
  if (mode === "fix") {
    await persistPolicy(cwd, config, { fixMode: true, featureMode: false });
  } else if (mode === "feature") {
    await persistPolicy(cwd, config, { fixMode: false, featureMode: true });
  } else {
    await persistPolicy(cwd, config, { featureMode: false });
  }

  // ADR 0036: a requested vision gate must not run on a model the railhead has
  // measured blind — refuse here, before the planner spends hours, not after.
  // An interactive operator may instead continue with the blind gates off;
  // the downgrade persists through the cadence write below (the run started
  // from build re-reads railhead.json), so `persists` is set.
  modes = await ensureVisionGates(cwd, modes, models, config, { canAsk: !auto, persists: true });

  // Persist the resolved cadence so a resume / later `railhead run` honors it
  // without re-passing the flags.
  await persistPolicy(cwd, config, { gateModes: modes });
  console.log(
    `review cadence: code=${modes.code} visual=${modes.visual} goal=${modes.goal} structural=${modes.structural}${fixForcesVisual ? " (fix mode forces visual=full)" : ""}`,
  );

  // Planning interview (ADR 0010, amended by ADR 0042 — gated by the run
  // preset, issue #73). Build mode: the interview runs AFTER the plan is
  // generated, gets the prompt + plan as its source, and its answers REVISE
  // the plan before tickets are decomposed — `interviewPlan` below is the
  // closure `runPlan` calls at that point. Fix mode keeps the original
  // pre-plan interview (a bug report has no plan to refine yet). `--light`/
  // `--none` skip it; `--medium`/`--full` run it; interactive asks,
  // defaulting to skip. Under `-a`/`--auto` the model auto-answers its own
  // questions. Resolved terms/decisions still land in CONTEXT.md/docs/adr as
  // they resolve (CONTEXT.md is the glossary the planner and the implementer/
  // reviewer prompts read; the ADRs are repo documentation).
  const configCap = config.sharpen_max_rounds ?? DEFAULT_SHARPEN_MAX_ROUNDS;
  let runSharpen: boolean;
  if (configCap <= 0) {
    runSharpen = false;
    console.log(`sharpen_max_rounds is ${configCap}; planning interview disabled (set it > 0 in railhead.json to enable).`);
  } else if (sharpen !== null) {
    runSharpen = sharpen;
  } else if (!auto) {
    runSharpen = await askYesNo(
      "Run a planning interview to refine the plan? (the plan is generated first, then your answers revise it; terms/decisions land in CONTEXT.md + ADRs)",
      presetRunsSharpen(preset),
    );
  } else {
    runSharpen = presetRunsSharpen(preset);
  }
  let enrichedPrompt = prompt;
  let interviewPlan: ((planText: string) => Promise<string | null>) | undefined;
  if (runSharpen) {
    // Depth picker (mirrors the `sharpen` skill's selector). Asked once,
    // before round 1: sets the soft question budget the model paces toward,
    // and — only for "exhaustive" — raises the hard `maxRounds` backstop
    // for this session so a never-stopping model can't spin literally
    // forever, while a thorny design isn't cut short by the default 6.
    // Under -a/--auto, the depth is forced to "skip" (auto-answer).
    const depth: SharpenDepth = auto ? "skip" : await askPick(
      "How deep should the planning interview go?",
      GRILL_DEPTH_OPTIONS,
      0,
    );
    const isSkip = depth === "skip";
    const sessionOptions = {
      cwd,
      model: models.plan,
      contextBudget,
      maxSteps: config.max_phase_steps,
      stallTimeoutSec: config.stall_timeout_sec,
      maxStepModelSec: config.max_step_model_sec,
      maxContextTokens: config.max_context_tokens,
      maxRounds: depthToMaxRounds(depth, configCap),
      depthTarget: DEPTH_TARGET_QUESTIONS[depth],
      verbose,
      persistentWorker: config.persistent_worker === true,
      infraBackoffSec: config.infra_backoff_sec,
      ask: isSkip
        ? (q: SharpenQuestion) => Promise.resolve(q.recommended || "(no recommendation given)")
        : (q: SharpenQuestion) => askAnswer(q.recommended || "(no recommendation given)"),
      onQuestion: isSkip ? undefined : (_q: SharpenQuestion, rendered: string) => console.log("\n" + rendered),
    };
    const skipLabel = isSkip ? " (auto-answered)" : "";
    if (mode === "fix") {
      const session = await runSharpenSession({ ...sessionOptions, topic: prompt, mode });
      if (session.transcript) {
        enrichedPrompt = `${prompt}\n\n${session.transcript}`;
        console.log(`fix interview (${depth})${skipLabel}: ${interviewSummary(session.exchanges.length, session.rounds, session.stopped, session.answersPath)}`);
      } else if (session.stopped) {
        console.log(`fix interview (${depth})${skipLabel}: ended early at your request before any answer — no interview context added`);
      }
    } else {
      interviewPlan = async (planText: string) => {
        const session = await runSharpenSession({ ...sessionOptions, topic: prompt, mode: "build", planText });
        if (session.exchanges.length === 0) {
          console.log(`plan interview (${depth})${skipLabel}: ${session.stopped ? "ended early at your request before any answer" : "no questions — the plan already decides what the interview would ask"}`);
          return null;
        }
        console.log(`plan interview (${depth})${skipLabel}: ${interviewSummary(session.exchanges.length, session.rounds, session.stopped, session.answersPath)}`);
        return renderPlanInterviewAnswers(session.exchanges);
      };
    }
  }

  // Issue #134: install the declared provider health probe and warn about
  // disabled timeouts before planning spawns any phase; `runLoop` installs
  // the same config for the run half. The warning is scoped to the providers
  // the resolved seats actually reach.
  configureProvider(config.provider, cwd, models);
  // ADR 0014 amendment: the plan phases honor the same request-ceiling guard
  // mode as the run phases (telemetry-only unless `context_guard: "kill"`).
  configureContextGuard(config.context_guard);
  const { outDir, tickets: ordered, verify, verifySeeded } = await runPlan({
    cwd,
    prompt: enrichedPrompt,
    model: models.plan,
    contextBudget,
    maxSteps: config.max_phase_steps,
    stallTimeoutSec: config.stall_timeout_sec,
    maxStepModelSec: config.max_step_model_sec,
    maxContextTokens: config.max_context_tokens,
    mode,
    verbose,
    persistentWorker: config.persistent_worker === true,
    infraBackoffSec: config.infra_backoff_sec,
    artDirection: config.art_direction !== false,
    // ADR 0051: a feature run carries the roadmap step it builds (origin.json)
    // and a stable slug so reopen attempts land in the same plan namespace.
    arcStepNumber: internal.arcStepNumber,
    slug: internal.slug,
    // ADR 0041: non-auto runs review the completed plan (PLAN.md) with the
    // user and replan on their feedback until they accept — the human review
    // replaces the goal-coverage audit. Auto runs keep the audit and skip
    // this loop.
    interviewPlan,
    // v2 issue 01: the goal seat judges the finished plan against the goal
    // before any build starts; interactive runs skip it (the human review IS
    // the coverage check).
    goalModel: models.goal,
    maxReplans: config.goal_review?.max_replans ?? undefined,
    reviewPlan: auto || mode === "fix"
      ? undefined
      : async ({ planPath }) => {
          console.log(`\nThe final plan is written to ${planPath ? planPath : "PLAN.md"} — read it before answering.`);
          const answer = await askText("Is the plan acceptable? (Enter/accept = create tickets and start the build; otherwise describe the changes you want)", "accept");
          const trimmed = answer.trim();
          return trimmed && trimmed.toLowerCase() !== "accept" ? trimmed : null;
        },
  });

  // Seed the .gitignore at plan time (before any implementer runs) so the first
  // ticket's scaffold commit already excludes toolchain artifacts. Inferred
  // from the verify commands the planner emitted; append-only, never wipes.
  await ensureProjectGitignore(cwd, frameworkIgnoreForVerify(verify));

  // Pre-grant opencode read access to the toolchain's external dependency
  // dirs (e.g. ~/.cargo/registry/src/** for Rust, ~/go/pkg/mod/** for Go).
  // Without this, the implementer's reads of crate/package source hit
  // opencode's external_directory auto-reject and the run burns its retry
  // budget on a permissions policy instead of on real work. The yolo `**`
  // grant was already written before the planner ran (above); this is the
  // verify-derived supplement that needs the plan's verify output to infer
  // the toolchain.
  const implReasoning = config.model.implement && config.model.implement !== DEFAULT_MODEL
    ? await queryReasoningCapability(config.model.implement)
    : false;
  await ensureProjectOpenCodePermissions(cwd, frameworkExternalDirsForVerify(verify), { yolo, contextTokens: config.max_context_tokens, implementModel: config.model.implement ?? undefined, clampReasoning: implReasoning });

  console.log(`planned ${ordered.length} ticket(s) -> ${outDir}`);
  if (verify.length > 0) {
    console.log(`seeded verify commands into railhead.json: ${verify.join(", ")}`);
  } else {
    console.log("warning: planner emitted no $VERIFY block; railhead.json verify list unchanged. Edit railhead.json to set build/test commands before running.");
  }

  if (!existsSync(join(cwd, "AGENTS.md"))) {
    const written = await maybeGenerateAgentsMd({ cwd, prompt: enrichedPrompt, model: models.plan, tickets: ordered, contextBudget, maxSteps: config.max_phase_steps, stallTimeoutSec: config.stall_timeout_sec, maxStepModelSec: config.max_step_model_sec, maxContextTokens: config.max_context_tokens, verbose });
    if (written) console.log(`wrote ${written}`);
    else console.log("no AGENTS.md written (model produced none).");
  }

  if (ordered.length) {
    await git.writeProjectDoc(cwd, "prompt", enrichedPrompt);
    // ADR 0041 (amended): accepting the interactive plan IS the start
    // decision — tickets are created and the build begins with no second
    // prompt. Fix mode (no plan review) keeps the explicit start question.
    const acceptedPlan = !auto && mode === "build";
    const startNow = auto || cont || acceptedPlan || await askYesNo("Start this run now?", true);
    if (startNow) {
      return await cmdRun(cwd, [outDir, ...(verbose ? ["--verbose"] : [])], { fromPlan: true, verifySeeded });
    } else {
      console.log("planned; nothing run. start later with: railhead run <tickets-dir>");
      return null;
    }
  } else {
    console.log("planned; nothing run. start later with: railhead run <tickets-dir>");
    return null;
  }
}

interface GateCadenceOption {
  value: GateMode | "skip-all";
  label: string;
}

/** Interactive per-gate cadence questionnaire (issue #73). Suggested defaults
 * come from the light preset — the new default run shape. The code-review
 * prompt additionally offers "none — skip all reviews", the shorthand for the
 * --none preset that a user who doesn't know the flag can still pick. */
async function askGateCadence(): Promise<{ modes: PresetGateModes; skipAll: boolean }> {
  const pick = async (question: string, options: readonly GateCadenceOption[], defaultLabel: string): Promise<GateMode | "skip-all"> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const menu = options.map((o, i) => `  ${i + 1}. ${o.label}`).join("\n");
    const defIndex = options.findIndex((o) => o.label.startsWith(defaultLabel));
    try {
      while (true) {
        const raw = (await rl.question(`${question}\n${menu}\nPick (1-${options.length}) [${defIndex + 1}] `)).trim().toLowerCase();
        if (!raw) return options[defIndex]!.value;
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
      }
    } finally {
      rl.close();
    }
  };
  const code = await pick(
    "Code review cadence?",
    [
      { value: "full", label: "full — per-ticket review, BLOCKER + MAJOR retry" },
      { value: "medium", label: "medium — per-ticket review, BLOCKER + MAJOR retry" },
      { value: "light", label: "light — per-ticket review, BLOCKER full retry + MAJOR one attempt (default)" },
      { value: "off", label: "off — no code review" },
      { value: "skip-all", label: "skip all reviews — none for code/visual/goal/structural (--none)" },
    ],
    "light",
  );
  if (code === "skip-all") {
    return { modes: presetGateModes("none"), skipAll: true };
  }
  const visual = await pick(
    "Visual review cadence? (needs a vision-capable model.visual)",
    [
      { value: "full", label: "full — after each ticket + at run end" },
      { value: "light", label: "light — at run end only (default)" },
      { value: "off", label: "off — no visual review" },
    ],
    "light",
  );
  const goal = await pick(
    "Goal review cadence? (needs a goal seat model)",
    [
      { value: "full", label: "full — group checkpoints (inline corrective) + run end" },
      { value: "medium", label: "medium — group checkpoints only (inline corrective)" },
      { value: "light", label: "light — advisory group checkpoints + run-end corrective (default)" },
      { value: "off", label: "off — no goal review" },
    ],
    "light",
  );
  const structural = await pick(
    "Structural review cadence? (needs a goal seat model)",
    [
      { value: "full", label: "full — group checkpoints + run end" },
      { value: "medium", label: "medium — group checkpoints only" },
      { value: "light", label: "light — run end only (default)" },
      { value: "off", label: "off — no structural review" },
    ],
    "light",
  );
  return { modes: { code: code as GateMode, visual: visual as GateMode, goal: goal as GateMode, structural: structural as GateMode }, skipAll: false };
}

/** Gate-override flags whose value is a cadence mode are dropped from the args
 * handed to applyModelOverrides so a `--review off` never lands in the review
 * seat model slot (issue #73). A `--review <model-name>` stays (not a gate
 * mode) and selects the review seat model as before. */
function modelSeatFlags(argv: string[]): string[] {
  const consumed = new Set<string>();
  for (const flag of ["--review", "--vision", "--goal", "--structural"]) {
    const i = argv.indexOf(flag);
    if (i < 0) continue;
    const val = argv[i + 1];
    if (val !== undefined && parseGateMode(val) !== null) {
      consumed.add(flag);
      consumed.add(val);
    }
  }
  return argv.filter((a) => !consumed.has(a));
}

/** What cmdRun/cmdBuild hand back to orchestration callers (`cmdFeature`):
 * the run id and its final state. Null when nothing ran. */
interface RunOutcome {
  runId: string;
  state: RunState;
}

/**
 * ADR 0051: run-end arc transaction. A FINISHED feature run marks its roadmap
 * step `built` (recording the run id) and commits the marker lines on the
 * current branch — the record must never sit uncommitted in the worktree.
 * Runs here, not in `cmdFeature`, so `resume`/`run` finish the transaction
 * too. Idempotent: non-feature runs and already-built/done steps are no-ops.
 */
async function finalizeArcStep(
  cwd: string,
  runId: string,
  state: RunState,
): Promise<{ number: number; title: string } | null> {
  const identity = state.arc_step;
  if (state.status !== "finished" || !identity) return null;
  const arc = await readProductPlan(cwd);
  const step = arc?.steps.find((s) => s.number === identity.number);
  if (!step || step.status !== "todo") return null;
  await setStepStatus(cwd, step.number, { status: "built", runId });
  await git.commitPaths(cwd, [PRODUCT_DOC], `railhead: arc — step ${step.number} (${step.title}) built (${runId})`);
  console.log(`arc: step ${step.number} — ${step.title} is built (run ${runId}); the arc update is committed on ${state.branch}.`);
  return { number: step.number, title: step.title };
}

/**
 * ADR 0051: the human verification gate, as a prompt. After a finished feature
 * run the operator decides the step's fate in place — done, leave built for
 * later, or reopen with feedback the next attempt folds in — instead of
 * hand-editing the arc. The decision is committed immediately, so the arc
 * record is never left dirty in the worktree.
 */
async function promptStepVerification(cwd: string, stepNumber: number): Promise<void> {
  const arc = await readProductPlan(cwd);
  const step = arc?.steps.find((s) => s.number === stepNumber);
  if (!step) return;
  const answer = (await askText(
    `Did step ${step.number} ("${step.title}") do what you wanted? [done / leave / reopen <feedback>]`,
    "leave",
  )).trim();
  const lower = answer.toLowerCase();
  if (lower === "done" || lower === "d") {
    await setStepStatus(cwd, step.number, { status: "done", runId: step.runId });
    await git.commitPaths(cwd, [PRODUCT_DOC], `railhead: arc — step ${step.number} (${step.title}) done`);
    console.log(`arc: step ${step.number} marked done — \`railhead feature\` builds the next step when you are ready.`);
    return;
  }
  if (lower.startsWith("reopen")) {
    const feedback = answer.replace(/^reopen\b/i, "").trim();
    await setStepStatus(cwd, step.number, {
      status: "todo",
      runId: step.runId,
      feedback: feedback || "Reopened without notes — re-run the step and compare against what was built.",
    });
    await git.commitPaths(cwd, [PRODUCT_DOC], `railhead: arc — step ${step.number} (${step.title}) reopened`);
    console.log(`arc: step ${step.number} reopened with feedback — run \`railhead feature\` to rebuild it.`);
    return;
  }
  console.log(`step ${step.number} left as built. Test it later, then mark it done or reopen it with feedback in ${PRODUCT_DOC}.`);
}

/**
 * ADR 0051: `railhead feature` — one unattended feature run against the
 * product arc. Without a description, the first eligible `todo` roadmap step
 * is derived into the feature prompt (a `built`-but-unverified step blocks
 * the next; `--step N` overrides with a warning). When the run finishes, the
 * step is marked `built` (committed on the run branch) — the human tests the
 * outcome the next morning and answers done / leave / reopen-with-feedback.
 * A one-off description bypasses the arc entirely (like `build`, in feature
 * posture).
 */
async function cmdFeature(cwd: string, prefs: PlanArgs): Promise<void> {
  const description = prefs.prompt.trim();
  if (description) {
    await cmdBuild(cwd, { ...prefs, prompt: description, mode: "feature" });
    return;
  }
  const arc = await readProductPlan(cwd);
  if (!arc) {
    throw new Error(`no product arc (${PRODUCT_DOC}) — pass a feature description, or design the arc with \`railhead product "<your product vision>"\` first`);
  }
  const wanted = prefs.step;
  let step: ProductStep;
  if (wanted !== null) {
    // ADR 0051: `--step N` is the explicit override. It may skip ahead, but
    // the human gate is the point — say plainly which earlier step is not done.
    const found = arc.steps.find((s) => s.number === wanted);
    if (!found) {
      throw new Error(`step ${wanted} does not exist in ${PRODUCT_DOC} (found: ${arc.steps.map((s) => s.number).join(", ") || "none"})`);
    }
    step = found;
    if (step.status !== "todo") {
      throw new Error(`step ${step.number} — ${step.title} is ${step.status}, not todo. Reopen it with your feedback in ${PRODUCT_DOC} to rebuild it.`);
    }
    const blocking = arc.steps.find((s) => s.number < step.number && s.status !== "done");
    if (blocking) {
      console.warn(`[arc] warning: step ${blocking.number} — ${blocking.title} is ${blocking.status}; building step ${step.number} out of order (--step ${step.number}) skips the human verification gate for it.`);
    }
  } else {
    // Strict frontier: a built-but-unverified step blocks the steps after it.
    const action = nextArcAction(arc);
    if (action.kind === "extend") {
      throw new Error(`every roadmap step is built or done — add the next step with \`railhead product "<steering>"\``);
    }
    if (action.kind === "verify") {
      throw new Error(`step ${action.step.number} — ${action.step.title} is built and awaits your verification. Test it, then flip it to done (or reopen it with feedback) in ${PRODUCT_DOC}; \`railhead feature --step N\` can override.`);
    }
    step = action.step;
  }
  if (!step.description.trim()) {
    throw new Error(`step ${step.number} ("${step.title}") has no description — write one in ${PRODUCT_DOC} so the derivation has material`);
  }
  const config = await loadConfig(cwd);
  const models = resolveModels(config, prefs.modelOverride ? ["--model", prefs.modelOverride] : []);
  console.log(`arc: deriving the feature prompt for step ${step.number} — ${step.title}`)
  const prompt = await deriveFeaturePrompt({
    cwd,
    step: { number: step.number, title: step.title, description: step.description, feedback: step.feedback, runId: step.runId },
    plan: arc,
    model: models.plan ?? null,
    maxContextTokens: config.max_context_tokens ?? undefined,
  });
  console.log(`\nfeature prompt (step ${step.number} — ${step.title}):\n\n${prompt}\n`);
  if (!prefs.auto) {
    const go = await askYesNo("Build this step now?", true);
    if (!go) {
      console.log("not built — `railhead feature` derives it again next time.");
      return;
    }
  }
  // The arc's update commits on the product branch now, so the upcoming
  // per-ticket commits stay pure feature diffs (stage-by-path only — never
  // weaving in-progress worktree changes into the commit).
  await git.commitPaths(cwd, [PRODUCT_DOC], `railhead: product arc — step ${step.number} (${step.title})`);
  const end = await cmdBuild(cwd, { ...prefs, prompt, mode: "feature" }, {
    arcStepNumber: step.number,
    // Stable per-step namespace: a reopened step's next attempt reuses the
    // same `.scratch/<slug>/` plan docs and `run/<slug>` branch instead of
    // fragmenting a new one per derivation.
    slug: `step-${String(step.number).padStart(2, "0")}-${titleSlug(step.title)}`,
  });
  if (!end) {
    console.log(`arc: step ${step.number} ran under \`railhead run\` — flip it to built in ${PRODUCT_DOC} once the run finishes.`);
    return;
  }
  if (end.state.status === "finished") {
    // ADR 0051: the human gate, as a prompt. Under -a the operator is not at
    // the terminal, so the step stays built with instructions.
    if (prefs.auto) {
      console.log(`Test it, then either flip it to done in ${PRODUCT_DOC}, or reopen it with your feedback and run \`railhead feature\` again.`);
    } else {
      await promptStepVerification(cwd, step.number);
    }
  } else {
    console.log(`arc: step ${step.number} NOT marked built — the run ended with status "${end.state.status}". Inspect with \`railhead status\`, fix what stopped it, then run \`railhead feature\` again.`);
  }
}

/**
 * ADR 0051: `railhead product` — condense the operator's input into the
 * product arc (or steer the existing one). The session never writes on its
 * own: the parsed arc is shown, adoption is explicit (or automatic under
 * -a/--auto).
 */
async function cmdProduct(cwd: string, args: ProductArgs): Promise<void> {
  if (!args.instruction && !args.answers) {
    throw new Error(`product requires the vision or steering text, e.g. \`railhead product "a hiking log my family actually opens; first a rough mvp, then search, then shared albums"\` — or replay a stopped interview's answers with \`railhead product --answers <file>\``);
  }
  const config = await loadConfig(cwd);
  const models = resolveModels(config, args.modelOverride ? ["--model", args.modelOverride] : []);
  const existing = await readProductPlan(cwd);
  console.log(existing ? "product session — steering the existing arc" : "product session — authoring the product arc");

  // The recorded-answer replay: no condense, no interview — one revision call
  // against the arc on disk, so a stopped/crashed interview finishes where it
  // left off with the operator's own answers.
  if (args.answers) {
    if (!existing) {
      throw new Error(`--answers revises an existing ${PRODUCT_DOC}, but none exists — author the arc first with \`railhead product "<vision>"\``);
    }
    const answersFile = isAbsolute(args.answers) ? args.answers : join(cwd, args.answers);
    const exchanges = await readInterviewAnswers(answersFile);
    console.log(`product session — replaying ${exchanges.length} recorded answer(s) from ${args.answers}`);
    const replayed = await reviseProductArc({
      cwd,
      instruction: args.instruction || "The operator answered a planning interview about this arc; apply the recorded answers.",
      findings: renderPlanInterviewAnswers(exchanges),
      model: models.plan ?? null,
      maxSteps: config.max_phase_steps,
      stallTimeoutSec: config.stall_timeout_sec,
      maxStepModelSec: config.max_step_model_sec,
      maxContextTokens: config.max_context_tokens ?? undefined,
      verbose: args.verbose,
      persistentWorker: config.persistent_worker === true,
      infraBackoffSec: config.infra_backoff_sec,
    });
    await adoptProductArc(cwd, args, replayed);
    return;
  }

  // ADR 0051: the post-condense arc interview (same discipline and depth picker
  // as the build pipeline's planning interview). It sharpens the roadmap — the
  // MVP cut, each step's outcome and morning-after test — before the operator
  // adopts the arc. `-a`/`--auto` defaults to no interview; `--sharpen` opts in
  // with auto-answered questions (depth "skip").
  const configCap = config.sharpen_max_rounds ?? DEFAULT_SHARPEN_MAX_ROUNDS;
  let runSharpen: boolean;
  if (configCap <= 0) {
    runSharpen = false;
  } else if (args.sharpen !== null) {
    runSharpen = args.sharpen;
  } else if (!args.auto) {
    runSharpen = await askYesNo(
      "Run a sharpening interview on the arc? (questions only the operator can answer: the MVP cut, each step's outcome, how you will test it)",
      true,
    );
  } else {
    runSharpen = false;
  }
  let refine: ((arcMarkdown: string) => Promise<string | null>) | undefined;
  if (runSharpen) {
    const depth: SharpenDepth = args.auto ? "skip" : await askPick("How deep should the arc interview go?", GRILL_DEPTH_OPTIONS, 0);
    const isSkip = depth === "skip";
    refine = async (arcMarkdown: string) => {
      const session = await runSharpenSession({
        cwd,
        model: models.plan,
        maxContextTokens: config.max_context_tokens,
        maxRounds: depthToMaxRounds(depth, configCap),
        depthTarget: DEPTH_TARGET_QUESTIONS[depth],
        verbose: args.verbose,
        persistentWorker: config.persistent_worker === true,
        infraBackoffSec: config.infra_backoff_sec,
        mode: "product",
        topic: args.instruction,
        planText: arcMarkdown,
        ask: isSkip
          ? (q: SharpenQuestion) => Promise.resolve(q.recommended || "(no recommendation given)")
          : (q: SharpenQuestion) => askAnswer(q.recommended || "(no recommendation given)"),
        onQuestion: isSkip ? undefined : (_q: SharpenQuestion, rendered: string) => console.log("\n" + rendered),
      });
      const skipLabel = isSkip ? " (auto-answered)" : "";
      if (session.exchanges.length === 0) {
        console.log(`arc interview (${depth})${skipLabel}: ${session.stopped ? "ended early at your request before any answer" : "no questions — the arc already decides what the interview would ask"}`);
        return null;
      }
      console.log(`arc interview (${depth})${skipLabel}: ${interviewSummary(session.exchanges.length, session.rounds, session.stopped, session.answersPath)}`);
      return renderPlanInterviewAnswers(session.exchanges);
    };
  }

  const session = await runProductSession({
    cwd,
    instruction: args.instruction,
    model: models.plan ?? null,
    maxContextTokens: config.max_context_tokens ?? undefined,
    verbose: args.verbose,
    refine,
  });
  await adoptProductArc(cwd, args, session);
}

/** Show a product session's arc, take the adoption decision, and write it — the
 * shared tail of the authoring/steering session and the --answers replay. */
async function adoptProductArc(cwd: string, args: ProductArgs, session: ProductSessionResult): Promise<void> {
  console.log();
  // Adoption must be of the arc's PROSE, not just its step titles: the operator
  // is about to have every future feature run steer against this file.
  console.log(session.markdown.trimEnd());
  for (const w of session.warnings) console.warn(`[product] ${w}`);
  console.log();
  if (!args.auto) {
    const adopt = await askYesNo(`Adopt this arc into ${PRODUCT_DOC}? (every future \`railhead feature\` steers against it)`, true);
    if (!adopt) {
      console.log("discarded — nothing written.");
      return;
    }
  }
  await writeProductPlan(cwd, session.plan);
  console.log(`wrote ${PRODUCT_DOC}.`);
  console.log(renderArcSummary(session.plan));
  console.log(`next: \`railhead feature\` builds the first todo step unattended. Commit ${PRODUCT_DOC} whenever the arc changes.`);
}

async function cmdRun(cwd: string, rest: string[], opts: { fromPlan?: boolean; verifySeeded?: boolean } = {}): Promise<RunOutcome | null> {
  const args = parseRunArgs(rest);
  if (!args.ticketsDir) throw new Error("run requires a tickets directory");
  const ticketsDir = isAbsolute(args.ticketsDir) ? args.ticketsDir : join(cwd, args.ticketsDir);
  const pause = args.pauseOnFailure;
  const verbose = args.verbose;
  const quiet = args.quiet;
  const maxRetriesRaw = args.maxRetriesRaw;

  const config = await loadConfig(cwd);
  if (maxRetriesRaw) config.max_retries = Number(maxRetriesRaw);
  // Per-gate cadence overrides (--review/--vision/--goal/--structural, issue
  // #73). --review with a gate-mode value is a code-review override; with a
  // model name it is the review-seat model override (legacy) — the model-seat
  // filter below drops only the gate-mode uses so both keep working.
  const { overrides } = args;
  applyModelOverrides(config.model, modelSeatFlags(rest));
  const visionModels = resolveModels(config, modelSeatFlags(rest));
  // Issue #134: install the declared provider health probe and warn once about
  // providers whose request timeouts are all disabled — the shape that let the
  // snake run's wedged request reach the stall guard. The warning is scoped to
  // models a resolved seat actually uses.
  configureProvider(config.provider, cwd, visionModels);

  const gateModes = {} as Partial<Record<GateName, GateMode>>;
  for (const gate of GATES.map(([g]) => g)) {
    if (overrides[gate]) gateModes[gate] = overrides[gate]!;
  }
  const gateReport = await persistPolicy(cwd, config, { gateModes });
  for (const gate of gateReport.gatesChanged) {
    const key = GATES.find(([g]) => g === gate)![1];
    console.log(`${key}.mode: ${overrides[gate]} via --${gate === "code" ? "review" : gate}`);
  }

  // ADR 0036: refuse a vision-dependent gate whose seat model cannot see —
  // before a fresh run spends hours, and before a resume continues one. An
  // interactive operator may instead continue with the blind gates off (the
  // downgrade is in-memory here — railhead.json is untouched). A run started
  // from `build` already probed in this process seconds ago, so it does not
  // pay for the same measurement twice.
  let visionModes = {
    visual: (config.visual_review?.mode ?? "off") as GateMode,
    goal: (config.goal_review?.mode ?? "off") as GateMode,
  };
  if (opts.fromPlan !== true) {
    visionModes = await ensureVisionGates(cwd, visionModes, visionModels, config);
  }

  // ADR 0036: a surfaced project also wants a current implement-seat record,
  // so the builder's visual self-check reflects the model actually running
  // today. Unlike a gate this seat does not re-probe every run — it reuses a
  // current-version record and skips models a gate probe already covered.
  if (isRenderedSurface(config.projectInterface)) {
    const probed = new Set(visionGateRequests(visionModes, visionModels).map((r) => r.model).filter((m): m is string => m !== null));
    const implVision = await ensureImplementerVision({ cwd, model: visionModels.implement, skip: probed, maxContextTokens: config.max_context_tokens });
    for (const line of implementerVisionLines(implVision)) console.log(line);
  }

  const branch = assembleBranch(cwd, ticketsDir);

  if (!(await git.isGitRepo(cwd))) {
    throw new Error("Not a git repository. Run `railhead init` to scaffold railhead.json and git, then retry.");
  }

  if (await git.branchExists(cwd, branch)) {
    await git.checkoutBranch(cwd, branch);
  } else if ((await git.currentBranch(cwd).catch(() => "")) !== branch) {
    await git.createBranch(cwd, branch);
  }

  if (!args.fresh) {
    const prior = await findRunForBranch(cwd, branch);
    if (shouldResume(branch, prior?.state ?? null)) {
      // gh #111: refuse auto-resume while the halt file exists — an
      // unacknowledged halt must never be silently skipped or looped.
      const refusal = resumeRefusal(cwd);
      if (refusal) {
        printHaltRefusal(refusal.path, refusal.reason);
        return null;
      }
      console.log(`found interrupted run ${prior!.runId} on branch ${branch} — resuming`);
      // Re-apply the FRESH railhead.json config (already loaded + flag-overridden
      // at the top of cmdRun) over the frozen copy persisted in state.json at
      // startRun, so a mid-run railhead.json edit — a switched goal/visual model,
      // a changed verify list, a raised gate — takes effect on resume.
      prior!.state.config = config;
      prior!.state._models = resolveModels(prior!.state.config, []);
      await detectContextLimit(prior!.state);
      const resumed = await resumeRun(cwd, prior!.runId, ledgerDir(cwd, prior!.runId), prior!.state);
      return { runId: prior!.runId, state: resumed };
    }
  }

  const { runId, state, ledger } = await startRun({
    cwd,
    ticketsDir,
    branch,
    pauseOnFailure: pause,
    config,
    verbose,
    quiet,
    originalPrompt: await git.readProjectDoc(cwd, "prompt") ?? undefined,
    verifySeeded: opts.verifySeeded,
  });

  console.log(`branch ${branch}`);
  const resolvedModels = resolveModels(config, modelSeatFlags(rest));
  printModels(resolvedModels);
  for (const w of modelTierWarnings(config, resolvedModels)) console.log(w);
  for (const w of warnIfOversightModelIsLocal(config, resolvedModels)) console.log(w);
  if (config.verify.length === 0) {
    console.log(
      `WARNING: railhead.json "verify" is empty — every ticket will skip the verify gate and rely on review alone (ADR 0006 violated). Re-run \`railhead build\` to seed verify commands from the plan, or edit railhead.json {"verify":["cargo build","cargo test"]}/{"verify":["npm test","tsc --noEmit"]} manually.`,
    );
  }
  console.log(`run ${runId} — ${state.tickets.length} tickets`);
  console.log(renderStatusTable(state));

  const final = await runLoop(state, ledger, () => {
    console.log("\n" + renderStatusTable(state));
  });

  await writeReport(cwd, runId, final);
  console.log("\n" + renderStatusTable(final));
  console.log(`total time: ${elapsedLabel(final.started_at, final.updated_at)}`);
  console.log(`report: .railhead/${runId}/report.md`);
  await finalizeArcStep(cwd, runId, final);
  return { runId, state: final };
}

async function cmdResume(cwd: string, runIdArg?: string): Promise<void> {
  // gh #111: the resume refusal gate — while the halt file exists, a resume
  // must refuse (the operator deletes it to acknowledge the halt was seen).
  const refusal = resumeRefusal(cwd);
  if (refusal) {
    printHaltRefusal(refusal.path, refusal.reason);
    return;
  }
  const runId = runIdArg ?? (await latestRun(cwd));
  const dir = ledgerDir(cwd, runId);
  const state = await readState(dir);
  await git.checkoutBranch(cwd, state.branch);
  // Re-read railhead.json so a mid-run config edit (a switched model, a changed
  // verify list, a raised gate) takes effect on resume — `state.json` holds the
  // config frozen at startRun, and reading only that silently discards any edit
  // made between cancel and resume.
  state.config = await loadConfig(cwd);
  state._models = resolveModels(state.config, []);
  configureProvider(state.config.provider, cwd, state._models);
  await detectContextLimit(state);
  // ADR 0036: a resume that still owes a vision-dependent gate gets the same
  // refusal as a fresh run — an interrupted run is not a reason to judge blind.
  // The interactive continue-without-vision choice applies here too; the
  // downgrade lands on state.config (re-read from railhead.json above), so the
  // resumed run itself honors it without touching the file.
  let resumeModes = {
    visual: (state.config.visual_review?.mode ?? "off") as GateMode,
    goal: (state.config.goal_review?.mode ?? "off") as GateMode,
  };
  resumeModes = await ensureVisionGates(cwd, resumeModes, state._models, state.config);
  if (isRenderedSurface(state.config.projectInterface)) {
    const probed = new Set(visionGateRequests(resumeModes, state._models).map((r) => r.model).filter((m): m is string => m !== null));
    const implVision = await ensureImplementerVision({ cwd, model: state._models.implement, skip: probed, maxContextTokens: state.config.max_context_tokens });
    for (const line of implementerVisionLines(implVision)) console.log(line);
  }
  await resumeRun(cwd, runId, dir, state);
}

/** gh #111: print the halt-file refusal with the reason and the acknowledge-by-
 * delete instruction. Sets a non-zero exit code so a scripted resume notices. */
function printHaltRefusal(path: string, reason: string): void {
  console.error(`refusing to resume: the halt file ${path} is still present.`);
  console.error(`  halt reason: ${reason}`);
  console.error(`  review it, then delete the file to acknowledge the halt and resume.`);
  process.exitCode = 1;
}

/** Query opencode for the implement model's actual context window and clamp
 * the railhead config's `max_context_tokens` to it. The result is stored on
 * `state._effectiveContextTokens` so the run loop uses the real ceiling, not
 * a stale config value that may exceed what the model actually supports. */
async function detectContextLimit(state: import("../core/state.ts").RunState): Promise<void> {
  const models = state._models;
  const windows = models ? await querySeatContextWindows(models) : {};
  const detected = windows.implement ?? null;
  const { budget, source } = effectiveContextTokens(state.config.max_context_tokens, detected);
  state._effectiveContextTokens = budget;
  state._seatContextTokens = models ? seatContextCeilings(models, windows, state.config.max_context_tokens) : undefined;
  if (source === "model") {
    if (state.config.max_context_tokens && detected !== null && state.config.max_context_tokens > detected) {
      console.log(`WARNING: railhead.json max_context_tokens (${state.config.max_context_tokens}) exceeds the model's actual context window (${detected}) — using ${budget} instead.`);
    } else {
      console.log(`context budget: ${(budget / 1000).toFixed(0)}k (from opencode's model limit.context — lower it there to leave your server headroom)`);
    }
  } else if (source === "default") {
    console.log(`context budget: ${(budget / 1000).toFixed(0)}k (default — no opencode model limit detected)`);
  }
  const perSeat = Object.entries(state._seatContextTokens ?? {})
    .filter(([, seatBudget]) => seatBudget !== budget)
    .map(([seat, seatBudget]) => `${seat} ${Math.round(seatBudget! / 1000)}k`);
  if (perSeat.length > 0) {
    console.log(`request ceilings (per seat, from each model's window): ${perSeat.join(", ")}`);
  }
}

/**
 * Shared recovery + runLoop shell used by both `cmdResume` (explicit resume)
 * and `cmdRun` (auto-resume). Performs: reconcile committed-but-unsaved →
 * checkpoint in-flight → reset → rebase frontier → invariant check → runLoop.
 * The recovery step ordering (checkpoint before reset) is the safety
 * invariant from recovery.ts — the steps are pure, the git side effects
 * live here.
 */
async function resumeRun(
  cwd: string,
  runId: string,
  dir: string,
  state: RunState,
): Promise<RunState> {
  const head = await git.headCommit(cwd).catch(() => "");
  const origin = await readPlanOrigin(join(state.tickets_dir, "..")).catch(() => null);
  const subjects = new Set(head ? await git.commitSubjectsSince(cwd, origin?.base_sha ?? null) : []);
  const commitLockup = new Map<string, string>();
  for (const t of state.tickets) {
    if (t.status !== "in_progress" && t.status !== "ready") continue;
    if (head && subjects.has(`${t.number} — ${t.title}`)) commitLockup.set(t.file, head);
  }
  let recovered = reconcileCommittedButUnsaved(state, (t) => commitLockup.get(t.file));

  const inFlight = recovered.tickets.find((t) => t.status === "in_progress");
  const steps = planRecovery(inFlight ?? null);
  for (const step of steps) {
    switch (step.kind) {
      case "checkpoint": {
        // Preserve ALL in-flight work (tracked AND untracked real files) as a
        // checkpoint so a ^C mid-implement is never thrown away by the reset
        // below. staging -A is safe because .railhead/.scratch/railhead.contracts.json
        // are gitignored, so only the implement's actual work gets committed.
        //
        // The ticket stays in_progress here — rebaseFrontier (next step)
        // demotes it to ready so it re-runs from the checkpoint. A checkpoint
        // is NOT a completed ticket: the implementer was mid-work, verify
        // and review never ran. Marking it committed here (the prior bug)
        // silently skipped the ticket on resume.
        const clean = await git.isClean(cwd).catch(() => true);
        if (clean) break;
        await git.commit(cwd, `${step.ticket.number} — ${step.ticket.title} (checkpoint)`);
        console.log(`checkpointed in-flight work for ${step.ticket.number} (will re-run)`);
        break;
      }
      case "reset":
        await git.resetHard(cwd, "HEAD");
        break;
      case "rebase":
        recovered = rebaseFrontier(recovered);
        recovered.status = "running";
        break;
    }
  }

  const diverged = checkTicketInvariants(
    recovered.tickets.map((t) => ({ file: t.file, title: t.title })),
    (await loadTickets(recovered.tickets_dir).catch(() => [])).map((t) => ({ file: t.file, title: t.title })),
  );
  const missingOnDisk = diverged.filter((d) => d.problem === "missing_on_disk");
  if (missingOnDisk.length > 0) {
    const files = missingOnDisk.map((d) => d.file).join(", ");
    throw new Error(
      `tickets missing from disk: ${files}. The state.json references ticket files that no longer exist (possibly purged by a mid-run bug). Re-run \`railhead build\` to regenerate, or restore from git.`,
    );
  }
  for (const d of diverged) {
    if (d.problem === "missing_in_state") {
      console.log(`warning: ticket ${d.file} on disk but not in state.json — will not be processed`);
    } else if (d.problem === "title_mismatch") {
      console.log(`warning: ticket ${d.file} title mismatch (state: "${d.stateTitle}", disk: "${d.diskTitle}") — may indicate a stale plan`);
    }
  }

  await writeState(dir, recovered);

  console.log(`[${nowClock()}] resuming ${runId}`);
  // Pass `recovered` (the post-recovery state: in-flight ticket checkpointed,
  // interrupted tickets demoted to ready, status=running), NOT the stale
  // `state` we read at the top. runLoop uses its argument in-memory; passing
  // the pre-recovery state made the snake-qwen resume sleepwalk — 02 stayed
  // `in_progress`, frontier found nothing ready, the loop exited, and visual
  // review printed "1 ticket still pending" forever. Recovery had been
  // written to disk then immediately clobbered by runLoop's first writeState.
  const final = await runLoop(recovered, dir, () => {
    console.log("\n" + renderStatusTable(recovered));
  });
  await writeReport(cwd, runId, final);
  console.log("\n" + renderStatusTable(final));
  console.log(`total time: ${elapsedLabel(final.started_at, final.updated_at)}`);
  await finalizeArcStep(cwd, runId, final);
  return final;
}

async function cmdStatus(cwd: string, runIdArg?: string): Promise<void> {
  const arc = await readProductPlan(cwd);
  if (arc) {
    console.log(renderArcSummary(arc));
    console.log();
  }
  const runId = runIdArg ?? (await latestRun(cwd));
  const state = await readState(ledgerDir(cwd, runId));
  console.log(renderStatusTable(state));
  console.log(`run: ${runId}  ledger: .railhead/${runId}`);
}

/**
 * `railhead next [<run-id>]` — show the next actionable ticket(s) from a run.
 * Lists ready, in-progress, failed, and blocked tickets with their dependencies.
 * Useful for manual resume or understanding what's left without reading state.json.
 */
async function cmdNext(cwd: string, runIdArg?: string): Promise<void> {
  const runId = runIdArg ?? (await latestRun(cwd));
  const state = await readState(ledgerDir(cwd, runId));
  console.log(renderNextActionable(state));
  console.log(`\nrun: ${runId}  ledger: .railhead/${runId}`);
}

async function cmdReset(cwd: string, rest: string[]): Promise<void> {
  const hard = rest.includes("--hard");
  const runId = await latestRun(cwd).catch(() => null);
  if (!runId) {
    console.log("no runs to reset");
    return;
  }
  const state = await readState(ledgerDir(cwd, runId)).catch(() => null);
  await removeRun(cwd, runId);
  console.log(`removed .railhead/${runId}`);
  if (hard && state) {
    await git.checkoutBranch(cwd, state.branch).catch(() => {});
    await git.resetHard(cwd, "HEAD");
    console.log(`git reset --hard on branch ${state.branch} (work discarded)`);
  } else if (state) {
    console.log(`git branch ${state.branch} left intact (use --hard to also discard git work)`);
  }
}

/** `railhead diagnose screenshots` — run a real model to test the screenshot
 * workflow (take_screenshot → save to repo path → read the PNG back). This
 * is a manual diagnostic, not part of `npm test`. */
async function cmdDiagnose(cwd: string, rest: string[]): Promise<void> {
  const sub = rest[0] ?? "screenshots";
  if (sub !== "screenshots") {
    console.error(`unknown diagnose subcommand: ${sub}`);
    console.error("available: screenshots");
    process.exitCode = 1;
    return;
  }
  const modelOverride = argValue(rest, "--model");
  const config = await loadConfig(cwd);
  const models = resolveModels(config, modelOverride ? ["--visual", modelOverride] : []);
  const model = modelOverride ?? models.visual ?? models.review ?? models.implement;
  console.log(`\n[${nowClock()}] running screenshot diagnostic with model: ${describeModel(model)}`);
  if (model !== models.visual && models.visual) {
    console.log(`[${nowClock()}] (override — railhead.json visual model is ${describeModel(models.visual)})`);
  }
  const result = await runScreenshotDiagnostic({
    cwd,
    model,
    maxContextTokens: config.max_context_tokens,
    maxSteps: config.max_phase_steps,
    stallTimeoutSec: config.stall_timeout_sec,
  });
  console.log(renderDiagnoseResult(result));
}

/**
 * Pure parsing of `railhead log`'s positional args into a target run id (or
 * `null` meaning "resolve the latest run" — an I/O operation left to the
 * caller) plus an optional phase. Discriminates the single-argument form by
 * shape: run ids always start with `run-` (see runid.ts); anything else is
 * treated as a bare phase name against the latest run. Extracted from
 * `cmdLog` so this ambiguity-resolution rule is directly testable without
 * touching the filesystem.
 */
export function parseLogArgs(arg1?: string, arg2?: string): { runId: string | null; phase?: string } {
  if (arg1 && arg2) return { runId: arg1, phase: arg2 };
  if (arg1) {
    return arg1.startsWith("run-") ? { runId: arg1 } : { runId: null, phase: arg1 };
  }
  return { runId: null };
}

/**
 * `railhead log [<run-id>] [<phase>]` — pretty-print a phase transcript from
 * the ledger. With no phase, lists every phase in the run so the caller knows
 * what to ask for. Discriminates the single-argument form by shape: run ids
 * start with `run-`, phase names start with a digit (e.g. `01-01-implement`).
 * A bare phase name resolves against the latest run.
 */
async function cmdLog(cwd: string, arg1?: string, arg2?: string): Promise<void> {
  const parsedArgs = parseLogArgs(arg1, arg2);
  const runId = parsedArgs.runId ?? (await latestRun(cwd));
  const phase = parsedArgs.phase;

  const dir = ledgerDir(cwd, runId);
  const phases = await listPhases(dir);

  if (phases.length === 0) {
    console.error(`no phase ledgers found in .railhead/${runId}/events/`);
    process.exitCode = 1;
    return;
  }

  if (!phase) {
    console.log(`phases in ${runId}:`);
    for (const p of phases) console.log(`  ${p}`);
    console.log(`\nusage: railhead log ${runId} <phase>`);
    return;
  }

  if (!phases.includes(phase)) {
    console.error(`phase "${phase}" not found in ${runId}. Available:`);
    for (const p of phases) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(eventPath(dir, phase), "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const rendered = renderTranscript(lines);
  if (rendered) {
    console.log(rendered);
  } else {
    console.log(`(phase ${phase} has no renderable events)`);
  }
}