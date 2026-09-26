import { parseGateMode, type GateMode, type GatePreset } from "./config.ts";

/**
 * Owns the run/plan argument parsing that cli.ts and config.ts once each
 * hand-rolled (the duplicated `flag` helpers). One module, one shape, so the
 * per-gate review modes chosen at plan time and the ones re-read at run time
 * cannot disagree.
 *
 * Issue #73: the old opt-out review knobs (-nt/-nr/-nv/-ns and the single
 * `review_mode`) are gone. Per-gate cadence is `mode: full|medium|light|off`,
 * chosen by preset (--full/--medium/--light/--none) with per-gate overrides
 * (--review/--vision/--goal/--structural) and the boolean override
 * --sharpen/--no-sharpen.
 */

/** The four gate keys that carry a `mode` field. */
export type GateKey = "code" | "visual" | "goal" | "structural";

export interface GateOverrides {
  code?: GateMode | null;
  visual?: GateMode | null;
  goal?: GateMode | null;
  structural?: GateMode | null;
}

export interface RunArgs {
  ticketsDir: string | null;
  pauseOnFailure: boolean;
  verbose: boolean;
  quiet: boolean;
  maxRetriesRaw: string | null;
  fresh: boolean;
  /** Per-gate cadence overrides. */
  overrides: GateOverrides;
}

/** Parse the non-command arguments of `railhead run` into one shape. */
export function parseRunArgs(rest: string[]): RunArgs {
  return {
    ticketsDir: rest.find((a) => !a.startsWith("-")) ?? null,
    pauseOnFailure: rest.includes("--pause-on-failure"),
    verbose: rest.includes("--verbose"),
    quiet: rest.includes("--quiet"),
    maxRetriesRaw: argValue(rest, "-m"),
    fresh: rest.includes("--fresh"),
    overrides: {
      code: parseGateMode(argValue(rest, "--review")),
      visual: parseGateMode(argValue(rest, "--vision")),
      goal: parseGateMode(argValue(rest, "--goal")),
      structural: parseGateMode(argValue(rest, "--structural")),
    },
  };
}

export interface PlanArgs {
  /** The description prompt — the non-flag arguments joined. */
  prompt: string;
  auto: boolean;
  cont: boolean;
  yolo: boolean;
  /** Echo the exact prompt sent to each model call to the console. */
  verbose: boolean;
  modelOverride: string | null;
  /** The chosen preset; null = interactive (prompts, light defaults). */
  preset: GatePreset | null;
  overrides: GateOverrides;
  sharpen: boolean | null;
  mode: "build" | "fix" | "feature";
  /** Feature mode (ADR 0051): force a specific roadmap step (1-based).
   * Absent for build/fix; null = pick the first todo step. */
  step: number | null;
}

const PLAN_BOOL_FLAGS = new Set([
  "-a", "--auto", "-y", "--yes",
  "-c", "--continue",
  "--yolo",
  "--verbose",
  "--full", "--medium", "--light", "--none",
  "--sharpen", "--no-sharpen",
]);

const PLAN_VALUE_FLAGS = new Set([
  "--model",
  "--review", "--vision", "--goal", "--structural",
  "--step",
]);

/** Parse the arguments of `railhead build` / `railhead fix` / `railhead feature`. */
export function parsePlanArgs(argv: string[], mode: "build" | "fix" | "feature"): PlanArgs {
  const auto = argv.includes("-a") || argv.includes("--auto") || argv.includes("-y") || argv.includes("--yes");
  const cont = argv.includes("-c") || argv.includes("--continue");
  const presets = (["full", "medium", "light", "none"] as const).filter((p) => argv.includes(`--${p}`));
  if (presets.length > 1) {
    throw new Error(`conflicting presets: ${presets.map((p) => `--${p}`).join(" and ")} — pick one`);
  }
  const overrides: GateOverrides = {
    code: parseGateMode(argValue(argv, "--review")),
    visual: parseGateMode(argValue(argv, "--vision")),
    goal: parseGateMode(argValue(argv, "--goal")),
    structural: parseGateMode(argValue(argv, "--structural")),
  };
  const sharpen = parseBoolOverride(argv, "--sharpen", "--no-sharpen");
  const consumed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (PLAN_BOOL_FLAGS.has(a) || PLAN_VALUE_FLAGS.has(a)) {
      consumed.push(a);
      if (PLAN_VALUE_FLAGS.has(a)) {
        const v = argv[i + 1];
        if (v !== undefined && !v.startsWith("-")) {
          consumed.push(v);
          i++;
        }
      }
    }
  }
  const consumedSet = new Set(consumed);
  // `--model <value>` is consumed as a pair; a bare `--model` value could
  // otherwise leak into the prompt when the flag's value is missing.
  const prompt = argv.filter((a, i) => !consumedSet.has(a) && !(a.startsWith("-") && a.length > 1)).join(" ").trim();
  const stepRaw = argValue(argv, "--step");
  return {
    prompt,
    auto,
    cont,
    yolo: argv.includes("--yolo"),
    verbose: argv.includes("--verbose"),
    modelOverride: argValue(argv, "--model"),
    preset: presets[0] ?? null,
    overrides,
    sharpen,
    mode,
    step: stepRaw !== null && /^\d+$/.test(stepRaw) ? Number(stepRaw) : null,
  };
}

export interface ProductArgs {
  /** The vision (authoring) or steering text (revision) for this session. */
  instruction: string;
  auto: boolean;
  verbose: boolean;
  modelOverride: string | null;
}

/** Parse the arguments of `railhead product`: the joined non-flag text is the
 * operator's input for the session. */
export function parseProductArgs(argv: string[]): ProductArgs {
  const consumed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model" || a === "-m") {
      consumed.push(a);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("-")) {
        consumed.push(v);
        i++;
      }
    } else if (a === "-a" || a === "--auto" || a === "-y" || a === "--yes" || a === "--verbose") {
      consumed.push(a);
    }
  }
  const consumedSet = new Set(consumed);
  return {
    instruction: argv.filter((a, i) => !consumedSet.has(a) && !(a.startsWith("-") && a.length > 1)).join(" ").trim(),
    auto: argv.includes("-a") || argv.includes("--auto") || argv.includes("-y") || argv.includes("--yes"),
    verbose: argv.includes("--verbose"),
    modelOverride: argValue(argv, "--model") ?? argValueFlag(argv, "-m"),
  };
}

function argValueFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

/** Read a paired boolean override: the enabled flag wins over the disabled
 * one only when both are absent the result is null (not specified). Throws
 * when both sides are passed — a contradictory request the user should
 * resolve, never guess at. */
function parseBoolOverride(argv: string[], on: string, off: string): boolean | null {
  const yes = argv.includes(on);
  const no = argv.includes(off);
  if (yes && no) throw new Error(`${on} and ${off} are mutually exclusive`);
  if (yes) return true;
  if (no) return false;
  return null;
}

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "true") : null;
}

/** Value following a named flag, or null when the flag is absent. Shared across cli.ts and config.ts. */
export { argValue };
