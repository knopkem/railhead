import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { TicketState } from "./state.ts";

/**
 * The on-disk Ticket format — a single source of truth. Producers (plan)
 * render Tickets through `writeTickets`, consumers (run) parse them back
 * through `parseTicket`; both speak the same `Ticket` shape so the format
 * cannot drift between writer and reader.
 */
export interface Ticket {
  file: string;
  number: string;
  slug: string;
  title: string;
  what: string;
  /** One-line goal of the whole build, so a single-ticket worker sees where this fits. */
  mission: string;
  /** File refs of Tickets that must be Committed first, e.g. "01-add-greet.md". */
  blocked_by: string[];
  criteria: string[];
  files: string[];
  references: string[];
  introduces: string[];
  /**
   * Plan-time gate (issue #5): whether a `test` phase should run before this
   * ticket's implement attempts. The planner sets `testable: false` for
   * pure-config / manifest / docs tickets (no testable seam); `true`
   * otherwise. Defaults to `true` when the planner omits the field — a
   * ticket that didn't think about it probably is testable.
   */
  testable?: boolean;
  /** Open-ended craft ticket: no structural acceptance criteria; the builder
   * iterates on screenshots until it judges the rendered artifact meets the
   * goal, and the per-ticket review is skipped. */
  open_ended?: boolean;
  /** Issue #19: group label for checkpoint-level goal review. Optional. */
  group?: string;
}

export function readBlockedBy(raw: string): string[] {
  const line = raw
    .split("\n")
    .find((l) => l.trim().toLowerCase().startsWith("**blocked by"));
  if (!line) return [];
  const rest = line
    .slice(line.indexOf(":") + 1)
    .replace(/\*\*/g, "")
    .trim();
  if (!rest || /^none\b/i.test(rest)) return [];
  return rest
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // Normalize any reference form to a ticket file name (e.g. 01-favor.md)
      const m = s.match(/(\d{2})[\s:.)-]*(.*)/);
      if (m) {
        const num = m[1];
        const slug = m[2].trim().replace(/\s+/g, "-").replace(/\.md$/, "").toLowerCase();
        return slug ? `${num}-${slug}.md` : `${num}.md`;
      }
      return s.toLowerCase().replace(/\.md$/, "") + ".md";
    });
}

export async function listTicketFiles(
  ticketsDir: string,
): Promise<string[]> {
  const entries = await readdir(ticketsDir);
  return entries.filter((f) => /^\d{2}-.*\.md$/.test(f)).sort();
}

export async function parseTicket(
  ticketsDir: string,
  file: string,
): Promise<Ticket> {
  const raw = await readFile(join(ticketsDir, file), "utf8");
  const num = file.slice(0, 2);
  const titleMatch = raw.match(/^#\s*\d+\s*[:.)-]\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, "");
  const missionMatch = raw.match(/\*\*Mission:\*\*\s*(.+)/);
  const whatMatch = raw.match(/\*\*What to build:\*\*\s*([\s\S]*?)(?=\n\*\*Blocked by:\*\*)/);
  const what = whatMatch ? whatMatch[1].trim() : "";
  const criteria = (raw.match(/^-\s+\[\s*\]\s+(.+)$/gm) ?? []).map((c) =>
    c.replace(/^-\s+\[\s*\]\s+/, "").trim(),
  );
  validateTicketShape(file, raw, what);
  return {
    file,
    number: num,
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, "") || "ticket",
    title,
    mission: missionMatch ? missionMatch[1].trim() : "",
    what,
    blocked_by: readBlockedBy(raw),
    criteria,
    files: readItemList(raw, "Files to read/use"),
    references: readItemList(raw, "Existing contracts to honor"),
    introduces: readItemList(raw, "Expected new contracts"),
    testable: readTestable(raw),
    open_ended: readOpenEnded(raw),
    group: readGroup(raw),
  };
}

/**
 * Fail loud, not silent, on a structurally malformed ticket. Every field this
 * parser reads falls back to `""`/`[]` on a regex miss — exactly the failure
 * class ADR 0007 already hit once for `blocked_by` (a missing-colon heading
 * silently defeated dependency ordering, with no error, until a human
 * noticed). That fix made the *known* heading tolerant; it did not stop a
 * ticket from reaching this parser with a DIFFERENT heading missing or
 * misspelled — which happens whenever a ticket comes from outside
 * `writeTickets` (a hand-edited file, where the writer's
 * exact shape cannot be assumed). Throwing here trades a silently-degenerate ticket (which would
 * otherwise burn a whole implement/review/retry cycle on blank content) for
 * an immediate, actionable error at load time — before any run starts.
 */
function validateTicketShape(file: string, raw: string, what: string): void {
  const problems: string[] = [];
  if (!/\*\*blocked by/i.test(raw)) {
    problems.push('missing a "**Blocked by:**" heading (write "**Blocked by:** None" if there truly are no blockers)');
  }
  if (!what) {
    problems.push('missing or empty "**What to build:**" content');
  }
  if (problems.length) {
    throw new Error(`ticket ${file} is malformed: ${problems.join("; ")}`);
  }
}

/** Read backtick or comma items under a `**Label:**` heading. */
function readItemList(raw: string, label: string): string[] {
  const re = new RegExp(`\\*\\*${label}:\\*\\*([\\s\\S]*?)(?=\\n\\*\\*[^*]+:\\*\\*|\\nStatus:|$)`, "");
  const m = raw.match(re);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").replace(/`/g, "").trim())
    .filter((l) => l.length > 0 && l !== "None");
}

/**
 * Read the plan-time `**Testable:**` gate (issue #5). Returns `true` when the
 * heading reads `yes`/`true` (case-insensitive), `false` when `no`/`false`,
 * and `undefined` when the heading is absent — the caller (`parseTicket`)
 * leaves that undefined for `runTestPhase` to default to `true` (a ticket the
 * planner didn't mark probably is testable). A heading the model emits in
 * prose form ("yes — it introduces new contracts") still parses because the
 * first word is what's matched.
 */
function readTestable(raw: string): boolean | undefined {
  const m = raw.match(/\*\*Testable:\*\*\s*(\w+)/i);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return undefined;
}

/** Read the `**Open-ended:**` marker from a rendered ticket. Returns `true`
 * when the heading reads `yes`/`true` (case-insensitive), `false` when
 * `no`/`false`, and `undefined` when absent — ordinary tickets omit it. */
function readOpenEnded(raw: string): boolean | undefined {
  const m = raw.match(/\*\*Open-ended:\*\*\s*(\w+)/i);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return undefined;
}

/** Issue #19: read the `**Group:**` label from a rendered ticket. Returns
 * `undefined` when absent — group is optional and falls back to cadence. */
function readGroup(raw: string): string | undefined {
  const m = raw.match(/\*\*Group:\*\*\s*(.+)/i);
  if (!m) return undefined;
  const v = m[1].trim();
  return v || undefined;
}

export async function loadTickets(
  ticketsDir: string,
): Promise<Ticket[]> {
  const files = await listTicketFiles(ticketsDir);
  const tickets: Ticket[] = [];
  for (const f of files) tickets.push(await parseTicket(ticketsDir, f));
  return tickets;
}

/** Issue #45: whether the test phase runs for this ticket — the fuse of the
 * planner's per-ticket `testable` gate (issue #5; `false` opts out a
 * pure-config / manifest / docs ticket) and the project-level `test_phase`
 * config (issue #5; `false` opts the whole project out). Used to gate both
 * the implementer's RED/GREEN evidence requirement (#45) and the
 * reviewer's missing-evidence finding (#45), so the two stay in sync. */
export function testPhaseRan(testPhaseConfig: boolean | undefined, ticketTestable: boolean | undefined): boolean {
  return testPhaseConfig !== false && ticketTestable !== false;
}

export function toTicketState(t: Ticket): TicketState {
  return {
    file: t.file,
    title: t.title,
    number: t.number,
    blocked_by: t.blocked_by,
    status: "ready",
    attempts: 0,
    start_commit: null,
    commit: null,
    verify_ok: null,
    review_ok: null,
    review_attempts: 0,
    duration_ms: 0,
    reviews: [],
    group: t.group,
    logs: [],
  };
}

export function resolveTicketsDir(cwd: string, given: string): string {
  return isAbsolute(given) ? given : join(cwd, given);
}

export async function writeTickets(
  dir: string,
  tickets: Ticket[],
): Promise<string> {
  await mkdir(dir, { recursive: true });
  // Clear stale `.md` files from prior plan/fix runs on this directory before
  // writing the new plan. A user who re-runs `railhead plan` (or `railhead fix`)
  // on the same .scratch/<slug>/issues path would otherwise accumulate ticket
  // files across runs — the next `railhead run` then loads the stale set along
  // with the new one, mixing already-completed tickets with fresh ones.
  // Non-`.md` files (a user-dropped README, a scratch file) are left alone;
  // clearing targets tickets only. Each new ticket's filename is written
  // AFTER the clear, so there's no race with files this call is about to write.
  for (const entry of await readdir(dir)) {
    if (entry.endsWith(".md")) await rm(join(dir, entry), { force: true });
  }
  for (const t of tickets) await writeFile(join(dir, t.file), renderTicket(t), "utf8");
  return dir;
}

export function renderTicket(t: Ticket): string {
  const criteria = t.criteria.length
    ? t.criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- [ ] (no acceptance criteria listed)";
  const blockedBy = t.blocked_by.length
    ? t.blocked_by.map((f) => f.replace(/\.md$/, "")).join(", ")
    : "None (can start immediately)";
  const filesBlock = t.files.length
    ? `\n**Files to read/use:**\n${t.files.map((f) => `- \`${f}\``).join("\n")}`
    : "";
  const refBlock = t.references.length
    ? `\n**Existing contracts to honor:**\n${t.references.map((r) => `- \`${r}\``).join("\n")}`
    : "";
  const introBlock = t.introduces.length
    ? `\n**Expected new contracts:**\n${t.introduces.map((r) => `- \`${r}\``).join("\n")}`
    : "";
  const testableBlock = t.testable === undefined
    ? ""
    : `\n**Testable:** ${t.testable ? "yes" : "no"}`;
  const openEndedBlock = t.open_ended ? "\n**Open-ended:** yes" : "";
  const groupBlock = t.group ? `\n**Group:** ${t.group}` : "";
  return `# ${t.number}: ${t.title}

${t.mission ? `**Mission:** ${t.mission}\n\n` : ""}**What to build:** ${t.what}

**Blocked by:** ${blockedBy}${filesBlock}${refBlock}${introBlock}${testableBlock}${openEndedBlock}${groupBlock}

**Status:** ready-for-agent

${criteria}
`;
}