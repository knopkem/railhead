import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseToolCalls, type ToolCall } from "../gates/evidence.ts";
import * as git from "../core/git.ts";
import type { RunState, TicketState } from "../core/state.ts";
import type { Ticket } from "../core/ticket.ts";

/**
 * The deterministic attempt dossier: a compact digest of everything this
 * ticket has already tried, assembled from the ledger — tool-call histogram,
 * commands run more than once, files written/edited, the failures so far, the
 * ticket's own named files, and the uncommitted worktree. It is injected into
 * the retry prompt so a stuck session sees its own loop instead of repeating
 * it, and it costs ZERO model calls.
 *
 * This is evidence, not instruction: it states counts and text verbatim and
 * lets the worker draw the conclusion. It is not an analyzer — no inference,
 * no root-cause claims, no routing.
 */

/** Hard cap on the rendered dossier, so a pathological ticket cannot tax the
 * worker's context. */
export const DOSSIER_CHAR_LIMIT = 2400;

/**
 * Whether the dossier is worth injecting: there IS gate feedback (this is not
 * a first attempt) AND the correction is not the ordinary one-shot retry —
 * either the session was restarted (a fresh session lost its own history, so
 * the digest is its only view of what was tried) or the ticket has already
 * burned two invocations (attempt 3+, where repetition becomes the risk).
 */
export function dossierDue(attempts: number, sessionRestarted: boolean): boolean {
  return sessionRestarted || attempts >= 3;
}

export interface ToolCallSummary {
  toolCounts: [string, number][];
  repeatedCommands: { command: string; count: number }[];
  editedFiles: { file: string; count: number }[];
  lastActions: string[];
}

const TOOL_CAP = 8;
const COMMAND_CAP = 5;
const EDIT_CAP = 8;
const ACTION_CAP = 4;
const ERROR_CAP = 8;
const NAMED_FILE_CAP = 6;
const WORKTREE_CAP = 8;

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function editTarget(call: ToolCall): string | null {
  const fp = typeof call.input.filePath === "string"
    ? call.input.filePath
    : typeof call.input.path === "string"
      ? call.input.path
      : null;
  return fp && fp.trim() ? fp.trim() : null;
}

function topEntries(map: Map<string, number>, cap: number): { key: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([key, count]) => ({ key, count }));
}

/** Pure summary of a phase's tool calls: what was used, what was repeated,
 * what was edited, and the tail of actions. Counts are the signal — a command
 * run five times or a file edited fourteen times is the loop made visible. */
export function summarizeToolCalls(calls: ToolCall[]): ToolCallSummary {
  const toolCounts = new Map<string, number>();
  const commands = new Map<string, number>();
  const edits = new Map<string, number>();
  const lastActions: string[] = [];
  for (const call of calls) {
    if (call.tool) toolCounts.set(call.tool, (toolCounts.get(call.tool) ?? 0) + 1);
    if (call.tool === "bash") {
      const command = typeof call.input.command === "string" ? normalizeCommand(call.input.command) : "";
      if (command) {
        commands.set(command, (commands.get(command) ?? 0) + 1);
        lastActions.push(`bash: ${command.slice(0, 100)}`);
      }
    } else if (call.tool === "write" || call.tool === "edit") {
      const target = editTarget(call);
      if (target) edits.set(target, (edits.get(target) ?? 0) + 1);
      lastActions.push(`${call.tool}: ${(target ?? "?").slice(0, 100)}`);
    }
  }
  return {
    toolCounts: topEntries(toolCounts, TOOL_CAP).map((e) => [e.key, e.count]),
    repeatedCommands: topEntries(commands, 1000)
      .filter((e) => e.count >= 2)
      .slice(0, COMMAND_CAP)
      .map((e) => ({ command: e.key, count: e.count })),
    editedFiles: topEntries(edits, EDIT_CAP).map((e) => ({ file: e.key, count: e.count })),
    lastActions: lastActions.slice(-ACTION_CAP),
  };
}

/** Path-like tokens named by the ticket's text (its `what` and criteria), for
 * the edited-vs-named drift signal. It never decides what a "file" is beyond
 * the shape — a slashed path, or a basename with a real extension — and the
 * worker compares the two lists itself. */
export function pathTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g)) {
    const token = match[0].replace(/^\//, "");
    const pathLike = token.includes("/") || /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9]{1,6}$/.test(token);
    if (!pathLike) continue;
    seen.add(token);
    if (seen.size >= NAMED_FILE_CAP) break;
  }
  return [...seen];
}

export interface AttemptDossierInput {
  attempts: number;
  stepsTotal?: number | null;
  failureHighlights: string[];
  tools: ToolCallSummary;
  ticketNamedFiles: string[];
  errorLines: string[];
  worktree: string[];
}

/** Render the dossier. Bounded and sectioned; the invocation count is always
 * present so "this is attempt N" survives even when the ledger is sparse. */
export function renderAttemptDossier(input: AttemptDossierInput): string {
  const head = input.attempts > 0 ? `invocation ${input.attempts}` : "invocation ?";
  const steps = input.stepsTotal ? `, ${input.stepsTotal} cumulative build steps` : "";
  const lines: string[] = [
    `(deterministic digest of this ticket's own attempts — evidence, not instructions)`,
    `- ${head}${steps}`,
  ];
  if (input.failureHighlights.length) {
    lines.push(`- Gate history: ${input.failureHighlights.join(" | ")}`);
  }
  if (input.tools.toolCounts.length) {
    lines.push(`- Tool calls: ${input.tools.toolCounts.map(([tool, n]) => `${tool} x${n}`).join(", ")}`);
  }
  if (input.tools.repeatedCommands.length) {
    lines.push(`- Commands run more than once (usually the loop):`);
    for (const r of input.tools.repeatedCommands) lines.push(`  - x${r.count}: ${r.command.slice(0, 140)}`);
  }
  if (input.tools.editedFiles.length) {
    lines.push(`- Files written/edited: ${input.tools.editedFiles.map((e) => `${e.file} x${e.count}`).join(", ")}`);
  }
  if (input.ticketNamedFiles.length) {
    lines.push(`- Files this ticket names: ${input.ticketNamedFiles.join(", ")}`);
  }
  if (input.tools.lastActions.length) {
    lines.push(`- Last actions (oldest of these first): ${input.tools.lastActions.join(" | ")}`);
  }
  if (input.errorLines.length) {
    lines.push(`- Recent failure output (deduped):`);
    for (const line of input.errorLines) lines.push(`  - ${line.slice(0, 180)}`);
  }
  if (input.worktree.length) {
    lines.push(`- Uncommitted worktree paths: ${input.worktree.join(", ")}`);
  }
  const text = lines.join("\n");
  return text.length > DOSSIER_CHAR_LIMIT ? `${text.slice(0, DOSSIER_CHAR_LIMIT)}\n… (truncated)` : text;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Error-shaped lines from the ticket's verify sidecars, deduped and kept in
 * order; ANSI stripped so the digest reads cleanly. */
export async function collectErrorLines(eventsDir: string, verifyLogs: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of verifyLogs.slice(-2)) {
    const raw = await readFile(join(eventsDir, file), "utf8").catch(() => "");
    for (const line of raw.replace(ANSI_RE, "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !/(error|failed|failure|exception|cannot|not found|undefined|missing|expected )/i.test(trimmed)) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out.slice(-ERROR_CAP);
}

/**
 * Collect the dossier from the run ledger and worktree. Returns null only on
 * I/O failure — the renderer always carries at least the invocation count.
 */
export async function collectAttemptDossier(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  parsed: Ticket,
): Promise<string | null> {
  const eventsDir = join(ledger, "events");
  const files = await readdir(eventsDir).catch(() => [] as string[]);
  const buildFiles = files
    .filter((f) => f.startsWith(`${ticket.number}-`) && f.endsWith("-build.jsonl"))
    .sort();
  const verifyLogs = files
    .filter((f) => f.startsWith(`${ticket.number}-`) && f.endsWith("-verify.log"))
    .sort();
  const calls: ToolCall[] = [];
  for (const file of buildFiles) {
    const raw = await readFile(join(eventsDir, file), "utf8").catch(() => "");
    calls.push(...parseToolCalls(raw));
  }
  const highlights = (ticket.logs ?? [])
    .filter((l) => /FAILED|capacity|blocked|soft-pass|review .*(major|blocker)|verify .*FAILED|no checkpoint marker/i.test(l))
    .slice(-6)
    .map((l) => l.replace(/\s+/g, " ").slice(0, 160));
  const worktree = await git.dirtyPaths(state.cwd).catch(() => [] as string[]);
  return renderAttemptDossier({
    // The current invocation number, not the count of prior transcripts (the
    // current phase file may not exist yet at collection time).
    attempts: ticket.attempts ?? buildFiles.length,
    stepsTotal: ticket.build_steps_total ?? null,
    failureHighlights: highlights,
    tools: summarizeToolCalls(calls),
    ticketNamedFiles: pathTokens(`${parsed.what}\n${parsed.criteria.join("\n")}`),
    errorLines: await collectErrorLines(eventsDir, verifyLogs),
    worktree: worktree.slice(0, WORKTREE_CAP),
  });
}
