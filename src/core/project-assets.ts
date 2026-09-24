import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One reviewer agent as opencode's `agent` config schema (description, mode,
 * permission map, prompt). The railhead no longer writes these into the
 * project's `.opencode/agent/` directory — that permanently altered the user's
 * opencode behaviour. They are injected per-subprocess as inline config via
 * `OPENCODE_CONFIG_CONTENT` (see guard.ts) so they exist only for the lifetime
 * of the review subprocess and leave nothing behind.
 */
export interface ReviewerAgent {
  description: string;
  mode: "primary";
  permission: Record<string, string | Record<string, string>>;
  prompt: string;
}

/**
 * The reviewer agent the Railhead uses for diff-mode review. One catch-all
 * deny hides every tool, so the reviewer can only critique the diff already
 * present in its prompt — it must not explore the repo or balloon its context
 * by reading files. This is the mechanism that keeps reviews cheap.
 *
 * The catch-all is load-bearing, not shorthand: opencode matches permission
 * keys as globs against the tool NAME and takes the LAST matching rule, so
 * `"*"` covers what no enumerated list can — MCP servers (`chrome-devtools_*`,
 * `blender_*`) and custom tools, which appear and vanish with the user's
 * opencode config. Enumerating built-ins is how a reviewer denied `bash` once
 * held Blender's `execute_blender_code`, i.e. arbitrary Python.
 */
export const REVIEWER_AGENT: ReviewerAgent = {
  description:
    "Read-only critique of a ticket's diff for the Railhead. Every tool is denied — reviews only the diff in the prompt.",
  mode: "primary",
  permission: {
    "*": "deny",
  },
  prompt:
    "You are the Reviewer for one ticket of an unattended build. You are read-only and do not explore the project: every file a review needs is already in the prompt below (the ticket body, its acceptance criteria, and the diff). You have no read, search, or command tools. Critically evaluate only the code in the diff against the criteria, and answer in the exact format the railhead prompt requests.",
};

/**
 * A second reviewer agent variant for large diffs (#30): identical to
 * REVIEWER_AGENT except `read` is allowed, so the reviewer can read the diff
 * file or the touched source files one at a time instead of having the entire
 * diff injected into its initial prompt. Compaction handles context growth
 * between read calls — the same mechanism that works for the Implementer. The
 * catch-all deny still hides every other tool, so the reviewer cannot explore,
 * just read the named files.
 *
 * `read` must follow the catch-all (last match wins), and its patterns deny
 * the `mcp:*` pattern space: opencode gates its MCP-resource tools under the
 * `read` permission, so re-allowing `read` would otherwise hand the reviewer
 * a channel into every configured MCP server. File reads use worktree-relative
 * paths and never match `mcp:*`.
 */
export const REVIEWER_READMODE_AGENT: ReviewerAgent = {
  description:
    "Read-mode critique for the Railhead. Reads the diff file or the touched source files the prompt names — never edits, runs commands, or explores the repo.",
  mode: "primary",
  permission: {
    "*": "deny",
    read: { "*": "allow", "mcp:*": "deny" },
  },
  prompt:
    "You are the Reviewer for one ticket of an unattended build. You review by reading the files or the diff file the prompt names — never edit, run commands, or explore the repo beyond what the prompt lists. Read each file the prompt instructs you to read (a diff file, the touched source files, or both), check it against the acceptance criteria, and answer in the exact format the railhead prompt requests.",
};

/**
 * The reviewer agents as inline opencode `agent` config, keyed by the names
 * the reviewer runner passes to `opencode run --agent <name>`. Injected into
 * every review subprocess's `OPENCODE_CONFIG_CONTENT` (see guard.ts), so the
 * agents resolve without ever touching the project's `.opencode/` directory.
 */
export function reviewerAgentConfig(): { agent: Record<string, ReviewerAgent> } {
  return {
    agent: {
      "railhead-reviewer": REVIEWER_AGENT,
      "railhead-reviewer-readmode": REVIEWER_READMODE_AGENT,
    },
  };
}

/**
 * The toolchain a project runs on. The typed tag the framework-aware helpers
 * share: detection (`detectToolchains`) returns these, and every downstream
 * derivation — `.gitignore` lines (`frameworkIgnoreForVerify`), opencode
 * external-directory grants (`frameworkExternalDirsForVerify`), the smoke
 * launch (`frameworkSmokeRun`) — is a pure lookup keyed by one of them. A
 * project whose toolchain no tag covers behaves as if framework-aware
 * behaviour were off, never as an error.
 */
export type Framework = "rust-bin" | "node" | "python" | "go" | "dotnet" | "jvm";

/**
 * One row per supported toolchain: the word-bounded trigger tokens that
 * recognise it in command text (NOT substrings — "mercator" must not match
 * "cargo"), plus the artifacts derived once the tag is known. `detectToolchains`
 * classifies against this table alone and `frameworkIgnoreForVerify` /
 * `frameworkExternalDirsForVerify` are pure lookups on its rows, so the
 * toolchain regexes and their branches live in exactly one place. A new
 * toolchain = one row here.
 */
interface ToolchainRow {
  tag: Framework;
  trigger: RegExp;
  /** `.gitignore` lines for the toolchain's build/dependency artifacts. */
  ignores: string[];
  /** opencode `external_directory` patterns for the toolchain's dep cache. */
  externalDirs: string[];
}

const TOOLCHAIN_ROWS: ToolchainRow[] = [
  {
    tag: "rust-bin",
    trigger: /\b(cargo|rustc|rustup)\b/,
    ignores: ["/target"],
    externalDirs: [
      // ~/.cargo/registry/src holds vendored crate source (the termion crash);
      // ~/.rustup/toolchains holds the std library. Both worth granting.
      "~/.cargo/**",
      "~/.rustup/**",
    ],
  },
  {
    tag: "node",
    trigger: /\b(npm|pnpm|yarn|node|npx)\b/,
    ignores: ["node_modules/", "dist/", "build/", ".npm/", "*.tsbuildinfo", "*.log", "*.local"],
    externalDirs: ["~/.npm/**", "~/.pnpm-store/**", "~/.yarn/**"],
  },
  {
    tag: "python",
    trigger: /\b(python|pytest|pip|hatch|poetry|uv)\b/,
    ignores: ["__pycache__/", "*.pyc", "*.pyo", ".venv/", "venv/", ".pytest_cache/", "*.egg-info/"],
    externalDirs: ["~/.cache/pip/**", "~/.cache/pypoetry/**", "~/.local/lib/**"],
  },
  {
    tag: "go",
    trigger: /\bgo\b/,
    ignores: ["*.exe", "*.test", "*.out"],
    externalDirs: ["~/go/pkg/mod/**"],
  },
  {
    tag: "dotnet",
    trigger: /\b(dotnet|msbuild|nuget)\b/,
    ignores: ["bin/", "obj/", "*.user"],
    externalDirs: ["~/.nuget/packages/**"],
  },
  {
    tag: "jvm",
    trigger: /\b(mvn|mvnw|gradle|gradlew)\b/,
    ignores: ["target/", ".gradle/", "build/", "*.class"],
    externalDirs: ["~/.m2/**", "~/.gradle/**"],
  },
];

/** The single classification site. Every toolchain whose trigger tokens
 * appear in the command text is returned, in table order; a command list that
 * mixes toolchains (a monorepo, say) yields each tag, and callers needing one
 * answer take the first. Empty when nothing is recognised. */
export function detectToolchains(commands: string[]): Framework[] {
  const flat = commands.join("\n");
  const tags: Framework[] = [];
  for (const row of TOOLCHAIN_ROWS) {
    if (row.trigger.test(flat)) tags.push(row.tag);
  }
  return tags;
}

/**
 * The smoke-phase tag: the first recognised toolchain, but ONLY when the
 * smoke list looks like a launch command for some toolchain. The smoke list
 * (the binary launch command — `cargo run`, `npm start`, …) is what tells us
 * a runnable binary even exists; the verify list (build/test) alone does not,
 * so a project with only `tsc --noEmit` yields `null` — nothing to launch.
 * `go` has no launcher token yet, so it never classifies here even though
 * `detectToolchains` recognises it: the ignore/external-dir derivations are
 * not gated on runnability, only the smoke phase is.
 */
export function detectFramework(verify: string[], smoke: string[]): Framework | null {
  const tags = detectToolchains([...verify, ...smoke]);
  if (tags.length === 0) return null;
  const looksRunnable = smoke.some((c) =>
    /\b(cargo run|npm (run|start)|pnpm (run|start|dev)|yarn (run|start|dev)|node\s|python\s|hatch run|python -m|dotnet run|gradlew? run)\b/.test(c),
  );
  return looksRunnable ? tags[0] : null;
}

/**
 * Detect whether the project is a canvas/game app (#20). Checks
 * `package.json` dependencies for known browser game frameworks (Three.js,
 * Phaser, PixiJS, Babylon.js). When true, the visual review prompt gets
 * default canvas interaction guidance so the model doesn't have to discover
 * the interaction model from scratch (which cost ~15-20 explore steps in
 * the horror_game run).
 *
 * A project-provided `interaction_hints` in `railhead.json` takes precedence
 * over these defaults — the project knows its own interaction model best.
 */
const GAME_DEPS = /\b(three|phaser|pixi\.js|pixijs|@babylonjs|babylonjs|canvas|kontra|regl|claygl|oimo|cannon)\b/;

export async function detectGameCanvas(cwd: string): Promise<boolean> {
  try {
    const pkg = await readFile(join(cwd, "package.json"), "utf8");
    const json = JSON.parse(pkg);
    const deps = { ...json.dependencies, ...json.devDependencies };
    return Object.keys(deps).some((d) => GAME_DEPS.test(d));
  } catch {
    return false;
  }
}

/**
 * The smoke recipe for a framework: the launch command (verbatim from the
 * planner's `$SMOKE` block) plus any env the railhead contributes. Returns
 * `null` when no runnable command was emitted — callers SKIP the smoke phase
 * in that case (a library-only project, or one the planner didn't think to
 * smoke), rather than failing the run for want of a binary that may not exist.
 *
 * `runCommands` is the smoke list as the planner emitted it (`cargo run`,
 * `npm start`, …); we run the FIRST of those verbatim so the planner stays
 * in charge of which binary/flags to launch.
 *
 * NO headless env is injected. An earlier version set `NO_VIDEO=1` for Rust
 * binaries (Bevy's headless switch), but that let the implementer SKIP the
 * very rendering/schedule code path whose startup panic the smoke phase
 * exists to catch — the smoke run went green testing a different path than
 * the user runs. The smoke phase now launches the binary exactly as `cargo
 * run` / `npm start` would, so a panic on the real code path surfaces. On a
 * headless CI box without a display, a windowed app would fail to open its
 * window — a different failure mode than a startup panic, and one we accept
 * for now (the common case is a dev machine with a display).
 */
export function frameworkSmokeRun(
  framework: Framework,
  runCommands: string[],
): { command: string; env: Record<string, string> } | null {
  if (runCommands.length === 0) return null;
  // All frameworks: run the planner's command as-is, no env injection.
  // The timeout + panic-signature detection in `runSmoke` is what catches
  // startup failures, not env manipulation.
  switch (framework) {
    case "rust-bin":
    case "node":
    case "python":
    case "go":
    case "dotnet":
    case "jvm":
      return { command: runCommands[0], env: {} };
    default:
      // Exhaustive: a future Framework tag without a smoke recipe skips
      // rather than silently doing the wrong thing.
      return null;
  }
}

/** The railhead's own runtime artifacts that must never be committed as work. */
export const RAILHEAD_IGNORES = [
  ".railhead/",
  ".scratch/",
  "railhead.contracts.json",
  ".playwright-mcp/",
];

/** Fold a row's lines across every toolchain `detectToolchains` recognises in
 * the verify commands, deduped and in table order. Shared by the two
 * verify-driven derivations so each stays a pure lookup on the classifier. */
function toolchainLines(verify: string[], pick: (row: ToolchainRow) => string[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const tag of detectToolchains(verify)) {
    const row = TOOLCHAIN_ROWS.find((r) => r.tag === tag);
    if (row) {
      for (const line of pick(row)) {
        if (!seen.has(line)) {
          seen.add(line);
          lines.push(line);
        }
      }
    }
  }
  return lines;
}

/**
 * `.gitignore` lines for the build artifacts and dependency dirs of every
 * toolchain recognised in the verify commands the planner emitted. Pure
 * lookup on `detectToolchains`: the same verify list yields the same ignores,
 * so it is unit-testable. Returns lines WITHOUT trailing newlines; empty when
 * no toolchain signal is recognised. A command list may match more than one
 * toolchain (a monorepo); the union is returned. Order is deterministic.
 */
export function frameworkIgnoreForVerify(verify: string[]): string[] {
  return toolchainLines(verify, (row) => row.ignores);
}

/**
 * Ensure a project's .gitignore covers the railhead's own runtime dirs, so
 * `git add -A` (used by commit / checkpoint) never sweeps the ledger or events
 * into a work commit. Appends only missing lines; never rewrites or truncates
 * the file — a user's hand-authored ignores are preserved verbatim. `extra`
 * lines (typically framework artifacts derived from verify commands) are
 * appended the same way: only lines not already present are added.
 */
export async function ensureProjectGitignore(cwd: string, extra: string[] = []): Promise<void> {
  const target = join(cwd, ".gitignore");
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch {
    /* none yet */
  }
  const desired = [...RAILHEAD_IGNORES, ...extra];
  const existing = new Set(current.split("\n").map((l) => l.trim()));
  const missing = desired.filter((line) => line.trim().length > 0 && !existing.has(line.trim()));
  if (!missing.length) return;
  const append = (current.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n";
  await writeFile(target, current + append, "utf8");
}

const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

/**
 * External directories opencode should pre-grant the Implementer read access
 * to — a pure lookup on `detectToolchains` over the same verify commands that
 * drive `.gitignore`. The snake-qwen run died on opencode's
 * `external_directory` auto-reject of `~/.cargo/registry/src/.../termion-4.0.6/src/*`
 * — the implementer kept trying to read termion source to learn the API,
 * opencode silently rejected every read, and the run ground through its retry
 * budget on a permissions policy instead of on actual implementation work.
 * Pre-granting the toolchain's dep cache at plan/start time eliminates that
 * whole failure mode.
 *
 * Returns opencode `external_directory` patterns (paths with `~/` and globs).
 * Empty when no toolchain signal is recognised.
 */
export function frameworkExternalDirsForVerify(verify: string[]): string[] {
  return toolchainLines(verify, (row) => row.externalDirs);
}

/**
 * Ensure a project's opencode.json pre-grants read access to the named
 * external directories. Idempotent and append-only:
 *
 *   - Creates `opencode.json` with `$schema` when none exists.
 *   - Initializes `permission.external_directory` only when at least one path
 *     is requested — never emits an empty block.
 *   - For each requested path, sets `"allow"` ONLY if the user hasn't already
 *     expressed a rule for that exact pattern. An explicit user `deny` (or
 *     `ask`) for the same path always wins; the railhead never overrides
 *     intent. opencode's external_directory rule is "last match wins", so a
 *     user can still deny a broad path after we allow it.
 *
 * @param cwd project root
 * @param allowDirs paths to allow (typically from `frameworkExternalDirsForVerify`)
 */
export async function ensureProjectOpenCodePermissions(
  cwd: string,
  allowDirs: string[],
  options?: { yolo?: boolean; contextTokens?: number; implementModel?: string; clampReasoning?: boolean },
): Promise<void> {
  const yolo = options?.yolo === true;
  // Always pre-grant the OS temp directory: visual/goal review agents redirect
  // dev-server output to /tmp (e.g. `npx vite &>/tmp/vite.log`) and read it
  // back. Without this grant, opencode auto-rejects the external_directory
  // access, the agent can't confirm the server is up, and the review goes
  // inconclusive — "no evidence must never be coerced into a pass" (ADR 0009).
  // macOS resolves /tmp to /private/tmp, so both patterns are needed.
  const tmpDirs = ["/tmp/*", "/private/tmp/*"];
  const allDirs = yolo ? allowDirs : [...allowDirs, ...tmpDirs];
  // In yolo mode we ALWAYS write (even with no allowDirs) — the accept-all
  // shape applies regardless of toolchain. Skip only when NOT yolo and the
  // planner detected no toolchain dirs to pre-grant.
  const skipPermissions = !yolo && allDirs.length === 0;
  const target = join(cwd, "opencode.json");
  let cfg: Record<string, any> = {};
  let existed = false;
  try {
    const raw = await readFile(target, "utf8");
    cfg = JSON.parse(raw);
    existed = true;
  } catch {
    /* none yet — write fresh below */
  }

  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    // A corrupted non-object file: never silently overwrite user content.
    throw new Error(`opencode.json exists but is not a JSON object — refusing to rewrite it; edit it by hand: ${target}`);
  }

  cfg.$schema = cfg.$schema ?? OPENCODE_SCHEMA;

  let changed = !existed;
  if (!skipPermissions) {
    cfg.permission = cfg.permission ?? {};
    if (yolo) {
      // Accept-all shape per opencode's permission semantics (see the
      // customize-opencode skill): each tool gets `"allow"`, and
      // external_directory gets a `"**"` catch-all. The railhead sets these
      // only when the key is ABSENT — a user who already set `bash: "ask"` to
      // gate something by hand keeps their rule. This is the one place yolo
      // yields to user intent; everything else is overwritten.
      for (const tool of ["bash", "read", "edit", "glob", "grep", "list", "write"] as const) {
        if (cfg.permission[tool] === undefined) {
          cfg.permission[tool] = "allow";
          changed = true;
        }
      }
      const ext = cfg.permission.external_directory ?? {};
      if (!("**" in ext)) {
        ext["**"] = "allow";
        cfg.permission.external_directory = ext;
        changed = true;
      }
    } else {
      const existing = cfg.permission.external_directory ?? {};
      for (const p of allDirs) {
        if (!(p in existing)) {
          existing[p] = "allow";
          changed = true;
        }
      }
      if (changed) {
        cfg.permission.external_directory = existing;
      }
    }
  }

  // Re-enable opencode's auto-compaction so the implementer can keep working
  // mid-run (issue #54). The railhead sets `reserved` to 10% of the context
  // budget so opencode compacts at ~90% utilization instead of its default
  // (~50%), maximizing usable context while still leaving headroom for the
  // compaction summary to complete without overflowing. Never overwrite a
  // user's explicit compaction setting (their intent wins).
  if (cfg.compaction === undefined) {
    const reserved = options?.contextTokens
      ? Math.floor(options.contextTokens * 0.1)
      : undefined;
    cfg.compaction = reserved !== undefined ? { auto: true, reserved } : { auto: true };
    changed = true;
  }

  // Clamp reasoning effort to "medium" for the implement model, but ONLY when
  // the caller has confirmed the model supports reasoning (via
  // queryReasoningCapability). Reasoning models (e.g. Qwen3.8 27B) can think
  // for 20+ minutes on a single step with no output events, tripping the stall
  // timer. "medium" bounds the reasoning chain while keeping the model's
  // problem-solving ability. Never overwrite a user's existing setting.
  if (options?.implementModel && options.implementModel !== "default" && options.clampReasoning) {
    const slashIdx = options.implementModel.indexOf("/");
    if (slashIdx > 0) {
      const providerId = options.implementModel.slice(0, slashIdx);
      const modelId = options.implementModel.slice(slashIdx + 1);
      cfg.provider = cfg.provider ?? {};
      cfg.provider[providerId] = cfg.provider[providerId] ?? {};
      cfg.provider[providerId].models = cfg.provider[providerId].models ?? {};
      cfg.provider[providerId].models[modelId] = cfg.provider[providerId].models[modelId] ?? {};
      const modelCfg = cfg.provider[providerId].models[modelId];
      modelCfg.options = modelCfg.options ?? {};
      if (modelCfg.options.reasoningEffort === undefined) {
        modelCfg.options.reasoningEffort = "medium";
        changed = true;
      }
    }
  }

  if (changed) {
    await writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }
}