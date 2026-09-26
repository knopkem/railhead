import { mkdir, writeFile, rename, appendFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runId } from "./runid.ts";
import type { RunState } from "./state.ts";

export function ledgerDir(cwd: string, id: string): string {
  return join(cwd, ".railhead", id);
}

export function newRunId(): string {
  return runId();
}

export async function initLedger(dir: string): Promise<void> {
  await ensureEventsDir(dir);
}

/**
 * Recreate a ledger path's directory on demand. `initLedger` creates the run's
 * `events/` once, but an agent phase runs `bash` in the project with full
 * filesystem access and can `rm -rf .railhead` mid-run (its own scratch use
 * collides with the ledger). Writes re-ensure their directory so a missing
 * directory fails safe by being recreated, never by crashing the railhead.
 */
async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

function ensureEventsDir(dir: string): Promise<void> {
  return ensureDir(join(dir, "events"));
}

/** Truncate one phase's event files so a fresh invocation doesn't inherit earlier events. */
export async function resetPhase(
  dir: string,
  phaseFile: string,
): Promise<void> {
  await ensureEventsDir(dir);
  await writeFile(eventPath(dir, phaseFile), "", "utf8");
  await writeFile(eventPath(dir, `${phaseFile}.stderr`), "", "utf8");
}

export async function writeState(dir: string, state: RunState): Promise<void> {
  state.updated_at = new Date().toISOString();
  await ensureDir(dir);
  const target = join(dir, "state.json");
  const tmp = join(dir, "state.json.tmp");
  await writeFile(tmp, JSON.stringify(state, stateReplacer, 2), "utf8");
  await rename(tmp, target);
}

/** Drop runtime-only fields that are not serializable (e.g. the pending visual
 * review promise from #35). Underscore-prefixed keys are the convention. */
function stateReplacer(this: unknown, key: string, value: unknown): unknown {
  if (key.startsWith("_")) return undefined;
  return value;
}

export async function readState(dir: string): Promise<RunState> {
  const raw = await readFile(join(dir, "state.json"), "utf8");
  return normalizeState(JSON.parse(raw));
}

/** Guard state.json written by an older schema_version breadth: fill any fields that an earlier run may lack (e.g. review history). */
export function normalizeState(state: RunState): RunState {
  for (const t of state.tickets ?? []) {
    if (!Array.isArray(t.reviews)) t.reviews = [];
    if (typeof t.review_ok !== "boolean" && t.review_ok !== null) t.review_ok = null;
    if (typeof t.review_attempts !== "number") t.review_attempts = 0;
    if (typeof t.duration_ms !== "number") t.duration_ms = 0;
  }
  if (typeof state.visual_rounds !== "number") state.visual_rounds = -1;
  if (!Array.isArray(state.visual_findings)) state.visual_findings = [];
  if (typeof state.visual_ok !== "boolean" && state.visual_ok !== null) state.visual_ok = null;
  if (!Array.isArray(state.goal_reviews)) state.goal_reviews = [];
  if (!Array.isArray(state.structural_reviews)) state.structural_reviews = [];
  if (typeof state.halt_reason !== "string" && state.halt_reason !== null) state.halt_reason = undefined;
  if (typeof state.stop_reason !== "string" && state.stop_reason !== null) state.stop_reason = undefined;
  if (typeof state.visual_pending !== "string") state.visual_pending = null;
  if (typeof state.docs_dir !== "string" || !state.docs_dir) state.docs_dir = "docs";
  if (!state.pending_checkpoints) state.pending_checkpoints = { goal: [], structural: [] };
  if (!Array.isArray(state.pending_checkpoints.goal)) state.pending_checkpoints.goal = [];
  if (!Array.isArray(state.pending_checkpoints.structural)) state.pending_checkpoints.structural = [];
  if (state.builder) {
    if (typeof state.builder.checkpoint_count !== "number") state.builder.checkpoint_count = 0;
    if (!Array.isArray(state.builder.restarts)) state.builder.restarts = [];
  }
  return state;
}

export function eventPath(dir: string, phaseFile: string): string {
  return join(dir, "events", `${phaseFile}.jsonl`);
}

/** Full-fidelity sidecar path for a raw (non-opencode) log, e.g. verify output. */
export function rawLogPath(dir: string, phaseFile: string): string {
  return join(dir, "events", `${phaseFile}.log`);
}

/** Bound a potentially-large blob of text for storage in `ticket.logs`
 * (part of `RunState`, rewritten wholesale on nearly every phase transition —
 * see `writeState`). Keeps the TAIL, where compiler errors and stack traces
 * usually live, not the head. The full text is never lost: callers that hold
 * a durable copy elsewhere (an opencode phase's `events/<phase>.jsonl`, or a
 * `writeRawLog` sidecar) should reference that file in `label` so a human can
 * still recover the whole thing. */
const MAX_LOG_CHARS = 4000;

export function boundedLog(label: string, text: string, max = MAX_LOG_CHARS): string {
  if (text.length <= max) return `${label}: ${text}`;
  const tail = text.slice(text.length - max);
  return `${label} (showing last ${max} of ${text.length} chars): ${tail}`;
}

/**
 * Persist a raw (non-JSONL) log's full text as a plain-file sidecar under
 * `events/`, so a large blob (verify output has no opencode event stream of
 * its own to fall back on, unlike implement/review transcripts) keeps full
 * fidelity on disk without living — unbounded — inside `state.json`.
 */
export async function writeRawLog(dir: string, phaseFile: string, content: string): Promise<void> {
  await ensureEventsDir(dir);
  await writeFile(rawLogPath(dir, phaseFile), content, "utf8");
}


/** The newest run id that has a readable state.json, or throws when none does. */
export async function latestRun(cwd: string): Promise<string> {
  const dir = join(cwd, ".railhead");
  const stores = await readdir(dir).catch(() => [] as string[]);
  const valid = stores.filter((r) => r.startsWith("run-")).sort().reverse();
  if (!valid.length) throw new Error("no runs found");
  for (const id of valid) {
    const hasState = await readState(ledgerDir(cwd, id)).then(() => true).catch(() => false);
    if (hasState) return id;
  }
  throw new Error("no runs with a readable state found");
}

/**
 * Find the newest run whose branch matches, with a status that means
 * "interrupted" (running or stopped). Returns null when no prior run
 * exists for the branch, or when the prior run already finished/failed.
 * Used by `railhead run` to decide whether to auto-resume.
 */
export async function findRunForBranch(
  cwd: string,
  branch: string,
): Promise<{ runId: string; state: RunState } | null> {
  const dir = join(cwd, ".railhead");
  const stores = await readdir(dir).catch(() => [] as string[]);
  const valid = stores.filter((r) => r.startsWith("run-")).sort().reverse();
  for (const id of valid) {
    const state = await readState(ledgerDir(cwd, id)).catch(() => null);
    if (!state) continue;
    if (state.branch !== branch) continue;
    if (state.status !== "running" && state.status !== "stopped") continue;
    return { runId: id, state };
  }
  return null;
}

/** Remove a run's ledger directory entirely. Used by `railhead reset`. */
export async function removeRun(cwd: string, runId: string): Promise<void> {
  await rm(ledgerDir(cwd, runId), { recursive: true, force: true });
}

export async function appendEvent(
  dir: string,
  phaseFile: string,
  line: string,
): Promise<void> {
  if (!line.trim()) return;
  const path = eventPath(dir, phaseFile);
  const content = line.trimEnd() + "\n";
  try {
    await appendFile(path, content, "utf8");
  } catch (err) {
    // The events dir (or a parent) was deleted out from under the ledger — an
    // agent can `rm -rf .railhead` mid-run. Recreate it and retry once so this
    // fire-and-forget write can't crash the railhead with ENOENT. The happy
    // path keeps a single appendFile (no per-line mkdir): this write runs once
    // per streamed opencode line, so an unconditional mkdir would both slow
    // the hot path and widen the flush race the executor's tests depend on.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await ensureEventsDir(dir);
    await appendFile(path, content, "utf8");
  }
}

/**
 * Concatenate the assistant text parts from an opencode `--format json`
 * stream archived under `events/<phase>.jsonl`. The Ledger owns transcript
 * reading because it owns the event stream.
 *
 * Also recovers content a model emitted through a tool call instead of as
 * assistant text, since the lossy parsers read only this transcript:
 *  - a `write` tool call. Some models emit their whole reply as the `content`
 *    of a `write` to /tmp; opencode auto-rejects the call (the path is outside
 *    the project), the file is never written, and the content would be lost.
 *    A SUCCESSFUL write is NOT included here — its content lives on disk, and
 *    the reviewer/contract-extractor read files separately, so duplicating the
 *    bytes into the transcript would only inflate context. The plan phases use
 *    {@link extractPlanText}, which does recover successful writes, because in
 *    that phase the written file IS the deliverable — there are no source files
 *    to read separately.
 *  - a `cat` heredoc in a `bash` command (see {@link catHeredocBody}): a model
 *    that "prints" its structured plan with `cat << 'DELIM'` leaves it invisible
 *    to the text-only reader unless recovered.
 */
export async function extractAssistantText(
  dir: string,
  phaseFile: string,
): Promise<string> {
  return extractTranscript(dir, phaseFile, false);
}

/**
 * Transcript reader for the plan, plan-repair, and replan phases. Recovers the
 * same content {@link extractAssistantText} does, PLUS the content of a
 * SUCCESSFUL `write` tool call. Those phases tell the model to emit a ticket
 * JSON array as plain text; when it instead routes the array through the
 * `write` tool (the spriteforge repair failure — the corrected array landed in
 * `plan.json`, invisible to the text-only reader), the written content is the
 * plan itself, not a source file any later phase reads separately. There is
 * nothing to "read from disk later", so excluding it would just lose the plan.
 */
export async function extractPlanText(
  dir: string,
  phaseFile: string,
): Promise<string> {
  return extractTranscript(dir, phaseFile, true);
}

/** Shared body of {@link extractAssistantText} and {@link extractPlanText}.
 * `recoverSuccessfulWrites` distinguishes the two: the plan phases recover a
 * successful `write` (its content is the deliverable), every other phase does
 * not (that content is a source file read separately on disk). */
async function extractTranscript(
  dir: string,
  phaseFile: string,
  recoverSuccessfulWrites: boolean,
): Promise<string> {
  try {
    const raw = await readFile(eventPath(dir, phaseFile), "utf8");
    const parts: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "text" && ev.part?.type === "text" && ev.part.text) {
          parts.push(ev.part.text);
        }
        if (ev.type === "tool_use" && ev.part?.type === "tool" && ev.part.tool === "write"
            && typeof ev.part.state?.input?.content === "string"
            && (ev.part.state?.status === "error" || recoverSuccessfulWrites)) {
          parts.push(ev.part.state.input.content);
        }
        if (ev.type === "tool_use" && ev.part?.type === "tool" && ev.part.tool === "bash"
            && typeof ev.part.state?.input?.command === "string") {
          const body = catHeredocBody(ev.part.state.input.command);
          if (body) parts.push(body);
        }
      } catch {
        /* ignore malformed line */
      }
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

/** Recover the body of a `cat` heredoc a model used to emit content through a
 * shell instead of as assistant text — the spriteforge failure mode, where the
 * whole `$VERIFY…$TICKETS` plan rode inside `cat << 'ENDOFPLAN'` and the
 * text-only reader reported "no readable tickets". Mirrors the rejected-`write`
 * recovery: content not persisted to a project file belongs in the transcript,
 * so a `cat > path` (a real file write, whose bytes live on disk) is skipped
 * while stdout and `/dev/null` heredocs are recovered. Returns null when the
 * command is not a `cat` heredoc or redirects to a real file. */
export function catHeredocBody(command: string): string | null {
  const cat = /(?:^|\n)\s*cat\b([^\n]*?)<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\2/m;
  const m = cat.exec(command);
  if (!m || m.index === undefined) return null;
  if (m[1] && />\s*(?!\/dev\/null\b)\S/.test(m[1])) return null;
  const delim = m[3];
  const rest = command.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`\\n${delim}\\s*$`, "m"));
  const body = end < 0 ? rest : rest.slice(0, end);
  const trimmed = body.replace(/^\r?\n/, "").trim();
  return trimmed || null;
}

/**
 * Read the `<phase>.stderr.jsonl` ledger back as a list of lines. Each line is
 * one chunk the opencode subprocess wrote to its stderr — preserved verbatim
 * including ANSI escapes, since callers like `summarizePermissionRejections`
 * strip them themselves and other future consumers may want the original.
 */
export async function readStderrLines(
  dir: string,
  phaseFile: string,
): Promise<string[]> {
  try {
    const raw = await readFile(eventPath(dir, `${phaseFile}.stderr`), "utf8");
    return raw.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Phase names available in a run's ledger, sorted in natural order (so
 * `02-10-implement` follows `02-02-implement`, not the lexicographic gap that
 * plain string sort would impose). Excludes the per-phase `.stderr` sidecars;
 * callers that want those can read them via `readStderrLines`. Pure filename
 * inspection — does not open or parse any ledger file.
 */
export async function listPhases(dir: string): Promise<string[]> {
  const eventsDir = join(dir, "events");
  let names: string[];
  try {
    names = await readdir(eventsDir);
  } catch {
    return [];
  }
  const phases = new Set<string>();
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    if (n.endsWith(".stderr.jsonl")) continue;
    phases.add(n.slice(0, -".jsonl".length));
  }
  return Array.from(phases).sort((a, b) => naturalCompare(a, b));
}

function naturalCompare(a: string, b: string): number {
  // Split into runs of digits and non-digits; compare digit runs numerically
  // so `02-10-implement` sorts after `02-02-implement` instead of before it.
  const re = /(\d+|\D+)/g;
  const ax = a.match(re) ?? [a];
  const bx = b.match(re) ?? [b];
  const len = Math.min(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const ai = ax[i];
    const bi = bx[i];
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d;
    } else if (ai < bi) {
      return -1;
    } else if (ai > bi) {
      return 1;
    }
  }
  return ax.length - bx.length;
}