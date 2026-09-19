/**
 * Full-transcript renderer for an opencode phase JSONL ledger.
 *
 * Display-only: never mutates or persists the raw events (they are archived
 * verbatim by `executor.ts`). Sibling of `live.ts`'s one-line
 * `renderEventLine` — that one renders a single line as the run streams; this
 * one renders the whole phase as a readable transcript for post-hoc review
 * via `railhead log`.
 *
 * Tolerant of missing optional fields: ledgers from older runs (and from
 * model providers that omit `cache`) must render without crashing.
 */

const PREVIEW_MAX = 500;

export function renderTranscript(lines: string[]): string {
  let step = 0;
  const out: string[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    const rendered = renderEvent(ev, () => ++step);
    if (rendered) out.push(rendered);
  }
  return out.join("\n").trimEnd();
}

function renderEvent(ev: Record<string, any>, nextStep: () => number): string | null {
  switch (ev.type) {
    case "step_start":
      return renderStepStart(nextStep());
    case "text":
      return renderText(ev);
    case "tool_use":
      return renderToolUse(ev);
    case "step_finish":
      return renderStepFinish(ev);
    case "error":
      return renderError(ev);
    default:
      // file, message, snapshot, permission, etc. — display-only transcript
      // skips them (matches live.ts's policy: too noisy, actionably redundant).
      return null;
  }
}

function renderStepStart(n: number): string {
  return `\n── step ${n} ${"".padStart(Math.max(0, 64 - 8 - String(n).length), "─")}`;
}

function renderText(ev: Record<string, any>): string | null {
  const t = ev.part?.text;
  if (!t) return null;
  return indent(t);
}

function renderToolUse(ev: Record<string, any>): string | null {
  const part = ev.part ?? {};
  const tool = part.tool || "tool";
  const title = part.title;
  const state = part.state ?? {};
  const status = state.status || "running";

  const head = `▸ ${tool}${title ? ` (${title})` : ""} [${status}]`;

  const input = state.input;
  const inputPreview = input ? formatInput(input) : null;

  const output = pickOutput(state);
  const outputPreview = output ? truncate(output, PREVIEW_MAX) : null;

  const lines = [head];
  if (inputPreview) lines.push(`  in: ${inputPreview}`);
  if (outputPreview) lines.push(`  out: ${outputPreview}`);
  return lines.join("\n");
}

function renderStepFinish(ev: Record<string, any>): string | null {
  const part = ev.part ?? {};
  const reason = part.reason || "done";
  const tokens = part.tokens;

  const tokenBits: string[] = [];
  if (tokens) {
    if (typeof tokens.input === "number") tokenBits.push(`input ${tokens.input}`);
    if (typeof tokens.output === "number") tokenBits.push(`output ${tokens.output}`);
    const cacheRead = tokens.cache?.read;
    if (typeof cacheRead === "number" && cacheRead > 0) tokenBits.push(`cache ${cacheRead}`);
  }
  const tail = tokenBits.length ? ` · ${tokenBits.join(", ")}` : "";
  return `◂ finish (${reason}${tail})`;
}

function renderError(ev: Record<string, any>): string | null {
  const err = ev.error ?? {};
  const name = err.name || "error";
  const message = err.data?.message || err.message || "";
  return `✖ ${name}${message ? `: ${truncate(message, PREVIEW_MAX * 2)}` : ""}`;
}

function formatInput(input: Record<string, any>): string {
  // Command-style tools (bash) carry `command`; file-oriented tools carry `filePath`.
  // Anything else gets a compact JSON dump so nothing is silently dropped.
  if (typeof input.command === "string") {
    const workdir = typeof input.workdir === "string" ? ` (cwd: ${input.workdir})` : "";
    return truncate(input.command, PREVIEW_MAX) + workdir;
  }
  if (typeof input.filePath === "string") {
    const suffix = typeof input.oldString === "string" && typeof input.newString === "string"
      ? `: ${truncate(input.oldString, 80)} → ${truncate(input.newString, 80)}`
      : "";
    return input.filePath + suffix;
  }
  try {
    return truncate(JSON.stringify(input), PREVIEW_MAX);
  } catch {
    return "";
  }
}

function pickOutput(state: Record<string, any>): string | null {
  if (typeof state.output === "string" && state.output.length > 0) return state.output;
  const meta = state.metadata;
  if (meta && typeof meta.output === "string" && meta.output.length > 0) return meta.output;
  const err = state.error;
  if (typeof err === "string" && err.length > 0) return err;
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + ` … [+${s.length - max} chars]`;
}

function indent(s: string): string {
  return s.split("\n").map((l) => (l.length ? `  ${l}` : l)).join("\n");
}
