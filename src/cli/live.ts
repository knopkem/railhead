/**
 * Render opencode `run --format json` events into human-readable progress
 * lines for the terminal. Never mutates the raw events (they are archived
 * verbatim to the ledger separately); this is display-only.
 *
 * During a live run, each event gets one line showing what the model is
 * actually doing: the command it ran, the file it wrote, whether the tool
 * succeeded or errored (with exit code), the token spend per step, and
 * any error that killed the phase. Verbose enough to follow the work without
 * scrolling back to read the full transcript later.
 */

const OUTPUT_MAX = 200;

export interface LiveRenderOptions {
  prefix?: string;
  /** When true, also render `reasoning` and `text` events (the model's
   * thinking and output prose). Default false: the live stream shows what
   * the model is DOING (tool calls, step transitions, errors), not what
   * it's saying — that's the noisiest part and the user can read the full
   * transcript later via `railhead log`. */
  verbose?: boolean;
}

export function renderEventLine(
  rawLine: string,
  opts: LiveRenderOptions = {},
): string | null {
  if (!rawLine.trim()) return null;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(rawLine);
  } catch {
    return null;
  }
  const p = opts.prefix ? `${opts.prefix} ` : "";
  const part = ev.part as Record<string, any> | undefined;

  switch (ev.type) {
    case "reasoning": {
      if (!opts.verbose) return null;
      const r = part?.text;
      if (!r) return null;
      // Full, untruncated under --verbose — the operator asked to read the
      // model's thinking, not a 200-char digest of it.
      return `${p}  · ${r}`.trimEnd();
    }
    case "text": {
      if (!opts.verbose) return null;
      const t = part?.text || "";
      if (!t) return null;
      return `${p}  ${t}`.trimEnd();
    }
    case "tool_use": {
      const tool = part?.tool || "tool";
      const title = part?.title;
      const state = part?.state ?? {};
      const status = state.status || "running";
      const input = state.input;

      const detail = summarizeToolInput(tool, input);
      const exit = state.metadata?.exit;
      const err = typeof state.error === "string" ? state.error : null;

      const parts: string[] = [`${p}→ ${tool}`];
      if (detail) parts.push(detail);
      else if (title) parts.push(title);
      parts.push(`[${status}${typeof exit === "number" ? ` exit ${exit}` : ""}]`);
      if (err) parts.push(`✖ ${truncate(err, OUTPUT_MAX)}`);
      return parts.join(" ").trimEnd();
    }
    case "step_start": {
      return `${p}── step ────────────────────────────────`.trimEnd();
    }
    case "step_finish": {
      const reason = part?.reason || "done";
      const tokens = part?.tokens;
      const tokenBits: string[] = [];
      if (tokens) {
        if (typeof tokens.input === "number") tokenBits.push(`in ${tokens.input}`);
        if (typeof tokens.output === "number") tokenBits.push(`out ${tokens.output}`);
        const cacheRead = tokens.cache?.read;
        if (typeof cacheRead === "number" && cacheRead > 0) tokenBits.push(`cache ${cacheRead}`);
      }
      const tail = tokenBits.length ? ` · ${tokenBits.join(", ")}` : "";
      return `${p}✔ ${reason}${tail}`.trimEnd();
    }
    case "error": {
      const err = ev.error as Record<string, any> | undefined;
      const name = err?.name || "error";
      const msg = err?.data?.message || err?.message || "";
      return `${p}✖ ${name}${msg ? `: ${truncate(msg, OUTPUT_MAX)}` : ""}`.trimEnd();
    }
    default:
      return null;
  }
}

function summarizeToolInput(tool: string, input: Record<string, any> | undefined): string | null {
  if (!input) return null;
  if (typeof input.command === "string") return truncate(input.command, OUTPUT_MAX);
  if (typeof input.filePath === "string") return input.filePath;
  if (typeof input.path === "string") return input.path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.query === "string") return truncate(input.query, OUTPUT_MAX);
  try {
    const json = JSON.stringify(input);
    return truncate(json, OUTPUT_MAX);
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return (nl > max * 0.5 ? cut.slice(0, nl) : cut) + " …";
}
