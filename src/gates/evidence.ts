/**
 * Transcript-based validation that an agent actually did the work its prompt
 * demanded, rather than emitting a verdict marker without evidence.
 *
 * Each phase declares the tool-usage signals that constitute evidence of
 * work done (e.g. a visual review must run a bash command that launches
 * the app — not just `cargo check` + `cargo test`). The railhead parses the
 * phase's event ledger and checks these signals before accepting the
 * agent's verdict.
 *
 * Core principle (ADR 0009): no evidence must never be coerced into a pass.
 * An agent that emits `$VISUAL_PASS` without running the app has produced
 * no evidence — the verdict is downgraded to "inconclusive".
 */

import type { ProjectInterface } from "../config/interface.ts";
export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  status: string;
  /** The tool result payload (state.output / state.result), when present.
   * Used by the screenshot diagnostic to check whether a `read` of a PNG
   * actually returned an image content block (issue #56). */
  output?: unknown;
  /** The tool result's attachments (state.attachments), when present. Modern
   * opencode emits a read image as an attachment (`{type: "file", mime:
   * "image/png", url: "data:..."}`) rather than an AI-SDK `type: "image"`
   * content block, so the pixels signal lives here, not in `output`. */
  attachments?: unknown;
}

/**
 * Parse tool-use events from a phase's JSONL ledger. Each line is one JSON
 * event; only `tool_use` events are extracted. Malformed lines are skipped
 * (a corrupt JSONL line is guarded at the edges, per AGENTS.md).
 *
 * Returns tool calls in the order they occurred, so callers can reason about
 * sequencing (e.g. "did the agent run the app AFTER reading the prompt?").
 */
export function parseToolCalls(jsonlText: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(ev)) continue;
    if (ev.type !== "tool_use") continue;
    const part = ev.part;
    if (!isRecord(part)) continue;
    if (part.type !== "tool") continue;
    const tool = typeof part.tool === "string" ? part.tool : "";
    const state = isRecord(part.state) ? part.state : {};
    const status = typeof state.status === "string" ? state.status : "";
    const input = isRecord(state.input) ? state.input : {};
    const output = state.output ?? state.result;
    calls.push({ tool, input, status, output, attachments: state.attachments });
  }
  return calls;
}

/**
 * Issue #56: whether a tool result carries an image content block. The `read`
 * tool on a PNG succeeds (status "completed") even when the model cannot see
 * images — opencode injects a text placeholder ("Cannot read image...")
 * instead of an image part. So a completed read proves the bytes were read,
 * not that the model received pixels. This checks the structured result for an
 * image content block (`"type": "image"`, as the AI-SDK/opencode protocol
 * emits for a vision-capable model). Pure.
 */
export function toolResultContainsImage(output: unknown, attachments?: unknown): boolean {
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!isRecord(attachment)) continue;
      if (attachment.type === "image") return true;
      const mime = typeof attachment.mime === "string" ? attachment.mime : "";
      const payload = typeof attachment.url === "string" ? attachment.url : typeof attachment.data === "string" ? attachment.data : "";
      if (mime.startsWith("image/") && payload.length > 0) return true;
    }
  }
  if (output == null) return false;
  if (typeof output === "string") {
    // A plain-string result cannot carry a structured image block; a string
    // like "Image read successfully" is exactly the false positive #56 caught.
    return /"type"\s*:\s*"image"/.test(output);
  }
  try {
    const serialized = JSON.stringify(output);
    return /"type"\s*:\s*"image"/.test(serialized);
  } catch {
    return false;
  }
}

/**
 * Evidence that a visual review actually ran the app (not just build/test).
 * The visual review prompt demands: "Launch the app... send inputs...
 * capture screenshots." An agent that skips this — running `cargo check`
 * and `cargo test` instead — has produced no visual evidence.
 *
 * Heuristic: check whether any tool call looks like an app launch.
 * Three categories count:
 * 1. A `bash` command that isn't a build/test/lint command AND isn't a
 *    server-start command (cargo run, ./binary, python main.py).
 * 2. A browser MCP tool call — `browser_navigate`, `browser_click`,
 *    `browser_screenshot`, `chrome-devtools_*`, etc. — which means the agent
 *    drove a browser via MCP (the only way to interact with a browser app
 *    headlessly).
 * 3. Screenshot files on disk under .railhead/visual/.
 *
 * Issue #58: server-start commands (`npm run preview`, `npm run dev`,
 * `npm start`) alone prove nothing was VIEWED — a preview server is not
 * evidence the agent opened a browser and looked. They count as app-launch
 * evidence only when accompanied by a browser tool call (which the `browser`
 * disjunct already covers). `cargo run`/`./binary` remain launch evidence on
 * their own — a native binary IS the app.
 */
export function hasAppLaunch(calls: ToolCall[], excludePattern: RegExp): boolean {
  return (
    calls.some((c) => isBrowserTool(c)) ||
    calls.some((c) => isBashAppLaunch(c, excludePattern) && !isServerStart(c))
  );
}

/** Bash commands that only start a server (a browser app's dev/preview server)
 * rather than launching the app itself. On their own they are not evidence the
 * agent saw anything — the visual review must pair them with a browser tool
 * call or a screenshot. */
const SERVER_START_RE =
  /^(?:npm (?:run preview|run dev|run serve|start)|pnpm (?:run preview|run dev|run serve|start)|yarn (?:run preview|run dev|run serve|start)|npx serve|python -m http\.server|python -m SimpleHTTPServer)\b/i;

function isServerStart(c: ToolCall): boolean {
  return (
    c.tool === "bash" &&
    typeof c.input.command === "string" &&
    SERVER_START_RE.test(c.input.command.trim())
  );
}

function isBashAppLaunch(c: ToolCall, excludePattern: RegExp): boolean {
  return (
    c.tool === "bash" &&
    typeof c.input.command === "string" &&
    c.input.command.trim().length > 0 &&
    !excludePattern.test(c.input.command)
  );
}

/** Browser MCP tools indicate the agent drove a browser — the only way to
 * interact with a browser app in a headless context. Any tool whose name
 * starts with `browser_`, `chrome-devtools_`, or `playwright_browser_` counts
 * (navigate, click, screenshot, evaluate, etc.). The chrome-devtools and
 * playwright prefixes were missed before (issue #58), so a visual reviewer
 * that only used them produced no recognised browser evidence. */
function isBrowserTool(c: ToolCall): boolean {
  return (
    c.tool.startsWith("browser_") ||
    c.tool.startsWith("chrome-devtools_") ||
    c.tool.startsWith("playwright_browser_")
  );
}

/** The build/test/lint command shapes that are NOT an app launch, shared by
 * the whole-app evidence checks (visual whole-app + goal) so the two seats
 * cannot disagree about what "the reviewer ran the app" means. */
export const BUILD_TEST_EXCLUDE_RE =
  /^(?:cargo (?:check|test|build|clippy)|npm (?:test|run build|run lint|run typecheck)|pytest|ruff|eslint|tsc|go (?:test|build|vet))/;

/** Issue #97: the real user-level input tool calls that count as operating a
 * DOM control — the `browser-ui` interface row of the interaction evidence
 * gate. Synthetic dispatch (`evaluate_script`), observation (screenshot,
 * snapshot), and page-level navigation deliberately do NOT count: a synthetic
 * `el.click()` bypasses browser hit-testing, so a control that is dead to a
 * real cursor looks alive to `evaluate_script` (the #97 spark). A new input
 * primitive is one row here. */
const REAL_INPUT_TOOL_NAMES = [
  "click",
  "double_click",
  "drag",
  "fill",
  "hover",
  "press_key",
  "type_text",
  "upload_file",
] as const;

const BROWSER_PREFIXES = ["chrome-devtools_", "browser_", "playwright_browser_"] as const;

function isRealInputTool(c: ToolCall): boolean {
  return BROWSER_PREFIXES.some((prefix) =>
    REAL_INPUT_TOOL_NAMES.some((name) => c.tool === `${prefix}${name}`),
  );
}

/**
 * Issue #97: whether a phase's tool calls show real user-level operation for
 * the project's declared interaction interface — the INSTANCE row of the
 * evidence gate, keyed to the same per-project fact that drives prompt
 * guidance. The policy is universal ("a PASS without real operation is not a
 * PASS"); only what counts as real operation differs per interface:
 *
 * - `browser-ui` → at least one real-input tool call (chrome-devtools click /
 *   fill / type_text / press_key …). Synthetic `evaluate_script` alone never
 *   counts.
 * - `canvas` / `none` / `terminal` / undeclared (`null`) → exempt by
 *   construction: for canvas, synthetic dispatch IS the correct input class;
 *   `none` has no user-facing surface to operate; `terminal`'s driven-stdin
 *   instance is not ledger-visible yet (see `requiresRealInputEvidence` in
 *   interface.ts); undeclared keeps today's behavior.
 *
 * Returns the verdict plus the reason a PASS would be downgraded, so the
 * caller can log why without re-deriving it.
 */
export function hasInteractionEvidence(
  calls: ToolCall[],
  projectInterface: ProjectInterface | null | undefined,
  _launchExclude?: RegExp,
): { ok: boolean; missing: string | null } {
  if (projectInterface === "browser-ui") {
    if (calls.some(isRealInputTool)) return { ok: true, missing: null };
    return {
      ok: false,
      missing: "no real-input browser tool call (chrome-devtools click/fill/type_text/press_key) — synthetic evaluate_script dispatch does not prove a DOM control is operable",
    };
  }
  return { ok: true, missing: null };
}

/**
 * Evidence that a visual review captured visual output. The prompt says:
 * "Save screenshots under .railhead/visual/". An agent that followed the
 * prompt produces at least one file there. This checks the filesystem
 * (not the transcript) because screenshots are side effects of bash
 * commands, not tool calls themselves.
 */
export async function hasScreenshots(dir: string): Promise<boolean> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const entries = await readdir(join(dir, ".railhead", "visual"));
    return entries.some((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Validate a visual review transcript. Returns true when the agent produced
 * evidence of actually running the app (either a bash command that isn't
 * build/test/lint, or screenshot files on disk).
 *
 * When this returns false, a `$VISUAL_PASS` verdict must be downgraded to
 * "inconclusive" — the agent claimed success without doing the work.
 */
export async function hasVisualEvidence(
  jsonlText: string,
  runDir: string,
  buildTestPattern: RegExp,
): Promise<{ ranApp: boolean; hasScreenshots: boolean; hasEvidence: boolean }> {
  const calls = parseToolCalls(jsonlText);
  const ranApp = hasAppLaunch(calls, buildTestPattern);
  const screenshots = await hasScreenshots(runDir);
  return { ranApp, hasScreenshots: screenshots, hasEvidence: ranApp || screenshots };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
