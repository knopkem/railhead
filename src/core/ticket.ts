import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketState } from "./state.ts";

/**
 * The on-disk Ticket format — a single source of truth. Producers (plan)
 * render Tickets through `writeTickets`, consumers (run) parse them back
 * through `parseTicket`; both speak the same `Ticket` shape so the format
 * cannot drift between writer and reader.
 *
 * A ticket is a checkpoint and a unit of work: `what` names the behaviour and
 * the files it touches in prose, `criteria` are the checkable bullets the
 * builder must satisfy. The execution order is the array order the planner
 * emitted (strictly sequential); there is no dependency graph.
 *
 * A criterion is an observable behaviour sentence, optionally followed by an
 * indented `probe:` recipe line the judging seats can materialize into a
 * deterministic script (see {@link criterionProbe}). The probe is part of the
 * criterion's string (`behaviour\n  probe: launch; act; assert`) so the format
 * round-trips through one field and legacy criteria without probes parse
 * unchanged.
 */
export interface Ticket {
  file: string;
  number: string;
  slug: string;
  title: string;
  what: string;
  criteria: string[];
  /** Issue #19: group label for checkpoint-level goal review. Optional. */
  group?: string;
  /** Open-ended craft ticket: no structural acceptance criteria; the builder
   * iterates on screenshots until it judges the rendered artifact meets the
   * goal, and the per-ticket review is skipped. */
  open_ended?: boolean;
}

/** The planner-model draft of a ticket, before the railhead numbers it. */
export interface PlanTicket {
  title: string;
  what: string;
  criteria?: string[];
  /** Issue #19: group label for checkpoint-level goal review. Optional. */
  group?: string;
  /** The one open-ended craft ticket that owns a rendered surface's look. */
  open_ended?: boolean;
}

/** The title-derived slug every file name and finding key is built on. */
export function titleSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || "ticket";
}

/** The indented marker that introduces a criterion's probe recipe line. */
export const PROBE_PREFIX = "probe:";

/** The observable-behaviour sentence of a criterion, with any probe line
 * stripped. Legacy criteria (including ones ending in "(test)") are returned
 * unchanged — the grammar treats them as plain behaviours. */
export function criterionBehavior(criterion: string): string {
  const idx = criterion.search(/\n[ \t]*probe[ \t]*:/i);
  return (idx < 0 ? criterion : criterion.slice(0, idx)).trim();
}

/** The probe recipe of a criterion, or null when it carries none. A probe is
 * a deterministic command sequence ("launch; act; assert") a cheap judging
 * seat can materialize into a script — never a test framework name. */
export function criterionProbe(criterion: string): string | null {
  const m = criterion.match(/(?:^|\n)[ \t]*probe[ \t]*:[ \t]*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

/** Attach a probe recipe to a behaviour sentence in the one-field criterion
 * shape `behaviour\n  probe: recipe` — the inverse of {@link criterionProbe}. */
export function withProbe(behavior: string, probe: string): string {
  return `${behavior.trim()}\n  ${PROBE_PREFIX} ${probe.trim()}`;
}

/** Parse the acceptance-criteria bullets out of a rendered ticket body. A
 * criterion may be followed by one indented probe line; the two are folded
 * into one criterion string so render → parse round-trips exactly. */
function parseCriteria(raw: string): string[] {
  const criteria: string[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^-\s+\[\s*\]\s+(.+)$/);
    if (!m) continue;
    const behavior = m[1].trim();
    const probe = lines[i + 1]?.match(/^[ \t]+probe[ \t]*:[ \t]*(.+)$/i);
    if (probe) {
      criteria.push(withProbe(behavior, probe[1]));
      i++;
    } else {
      criteria.push(behavior);
    }
  }
  return criteria;
}

/** Number a plan's ticket drafts in emission order, assigning each a unique
 * file name (`01-slug.md`). Array order IS execution order — the railhead runs
 * tickets strictly in sequence, one commit per checkpoint. `startNumber`
 * continues an existing run's global sequence (replans). Pure. */
export function numberTickets(tickets: PlanTicket[], startNumber = 1): Ticket[] {
  const usedSlugs = new Set<string>();
  return tickets.map((t, i) => {
    let slug = titleSlug(t.title);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);
    const number = String(startNumber + i).padStart(2, "0");
    return {
      file: `${number}-${slug}.md`,
      number,
      slug,
      title: t.title,
      what: t.what,
      criteria: t.criteria ?? [],
      group: t.group,
      open_ended: t.open_ended,
    };
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
  const whatMatch = raw.match(/\*\*What to build:\*\*[ \t]*([\s\S]*?)(?=\n\s*\n|\n\*\*|\n-\s+\[|$)/);
  const what = whatMatch ? whatMatch[1].trim() : "";
  const criteria = parseCriteria(raw);
  validateTicketShape(file, what);
  return {
    file,
    number: num,
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, "") || "ticket",
    title,
    what,
    criteria,
    open_ended: readOpenEnded(raw),
    group: readGroup(raw),
  };
}

/**
 * Fail loud, not silent, on a structurally malformed ticket. Every field this
 * parser reads falls back to `""`/`[]` on a regex miss — exactly the failure
 * class ADR 0007 already hit once for `blocked_by` (a missing-colon heading
 * silently defeated dependency ordering, with no error, until a human
 * noticed). A ticket that reaches this parser with its body heading missing or
 * misspelled (a hand-edited file, where the writer's exact shape cannot be
 * assumed) would otherwise burn a whole implement/review/retry cycle on blank
 * content. Throwing here trades that for an immediate, actionable error at
 * load time — before any run starts.
 */
function validateTicketShape(file: string, what: string): void {
  if (!what) {
    throw new Error(`ticket ${file} is malformed: missing or empty "**What to build:**" content`);
  }
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

export function toTicketState(t: Ticket): TicketState {
  return {
    file: t.file,
    title: t.title,
    number: t.number,
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

export async function writeTickets(
  dir: string,
  tickets: Ticket[],
): Promise<string> {
  await mkdir(dir, { recursive: true });
  // Clear stale `.md` files from prior build/fix runs on this directory before
  // writing the new plan. A user who re-runs `railhead build` (or `railhead fix`)
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
  const openEndedBlock = t.open_ended ? "\n**Open-ended:** yes" : "";
  const groupBlock = t.group ? `\n**Group:** ${t.group}` : "";
  return `# ${t.number}: ${t.title}

**What to build:** ${t.what}

**Status:** ready-for-agent${openEndedBlock}${groupBlock}

${criteria}
`;
}
