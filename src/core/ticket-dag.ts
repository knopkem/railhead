import type { Ticket } from "./ticket.ts";

/**
 * The relationship layer of the Ticket format: how a model's dependency list
 * becomes an ordered, numbered, named set of ticket files. Where the model's
 * `PlanTicket` vocabulary (blocked_by as array indices) meets the persisted
 * `Ticket` vocabulary (blocked_by as file names). The literal file format lives
 * in ticket.ts; only the dependency-and-naming shape lives here.
 */
export interface PlanTicket {
  title: string;
  /** One-line goal of the whole build, repeated on every ticket for a single-ticket worker. */
  mission?: string;
  what: string;
  criteria: string[];
  blocked_by: number[];
  /** Files this ticket should read/reference (exact paths). */
  files?: string[];
  /** Existing contracts (symbols) this ticket must honor or extend. */
  references?: string[];
  /** New contracts this ticket is expected to introduce. */
  introduces?: string[];
  /** Plan-time TDD gate (issue #5). `false` skips the test phase; `true`
   * (the default when omitted) runs it. */
  testable?: boolean;
  /** An open-ended craft ticket: no structural acceptance criteria, judged by
   * looking at the rendered artifact. The builder iterates on screenshots
   * until it judges the goal met, and the per-ticket review is skipped (the
   * run-end visual/goal gate judges the artifact). Used for the single
   * art-direction ticket that owns the composed look. */
  open_ended?: boolean;
  /** Issue #19: a label grouping this ticket with others into a coherent
   * vertical slice (e.g. "core-engine", "gameplay", "polish"). Group
   * boundaries are where goal-level evaluation runs. Optional — when
   * absent, the railhead falls back to a cadence-based checkpoint. */
  group?: string;
}

/** The single source of truth for the `$TICKETS` field semantics. Every prompt
 * that asks a model to emit a `$TICKETS` array (the planner, the repair round,
 * the checkpoint replan) interpolates this block instead of hand-writing the
 * `blocked_by` / `files` / `references` / `introduces` / `testable` / `group`
 * rules — three hand-maintained copies already drifted once (a replan prompt
 * told the model `blocked_by` was 1-indexed) and crashed a run (issue #118).
 * The block is plain prose the model reads, not a schema serializer.
 *
 * `blocked_by` is 0-based positions in the emitted array. The replan prompt
 * composes ONE extra rule on top: its array contains only NEW tickets, so
 * committed tickets are out of the array entirely (commit order satisfies
 * their references). That rule stays in replan.ts, not here. */
export const TICKET_FIELD_SEMANTICS = `Field semantics:
- "blocked_by" lists the 0-based positions (within this array) of tickets that must be done first. Omit or use [] for tickets with no blockers. The railhead AUTO-INSERTS a missing "blocked_by" edge whenever ordering is already implied by a reference: if this ticket "references" a symbol another ticket "introduces", that introducer is forced to precede it, so you MAY omit the edge and the gate adds it (zero repair rounds). Author "blocked_by" yourself only for orderings the contracts cannot express — same-file wiring chains, UX sequencing, cross-cutting work — and ALWAYS author it when a ticket edits a file another ticket also edits.
- "files" are the exact paths the executor should read; always the complete edit set.
- "references" (consumes) are existing contracts this ticket must honor — list every contract from earlier tickets that this ticket reads or calls ([] for the first ticket).
- "introduces" (produces) are the new public contracts this ticket is expected to create — list every new symbol, function, or interface later tickets will depend on ([] for the last ticket). Every ticket MUST declare both directions; this pairing is what makes the contracts index and later Implementer prompts reliable.
- "mission" is the same one-line build goal on every ticket.
- "testable" is false for TWO classes of tickets: (1) pure-config / manifest / docs tickets that have no testable seam (a config file change, a manifest script, a README edit), AND (2) tickets whose criteria are purely visual or runtime behavior (observable only by running the app, not by a unit test) — e.g. "the animation glides smoothly", "the overlay fades in", "input responds without visible lag". No failing unit test the test phase can write will meaningfully assert those criteria — the visual review phase (which runs the app and takes screenshots) is the correct oracle, not the TDD test phase, and a non-testable ticket skips the railhead's write-failing-tests-before-implement step. When in doubt, omit it (defaults to testable).
- "open_ended" (optional, default false) marks an OPEN-ENDED CRAFT ticket: one whose deliverable is a rendered artifact judged by looking at it, not by structural acceptance criteria. An open-ended ticket has no meaningful criteria to check off — the builder works in a screenshot loop (run, capture, read, judge, improve) until it judges the artifact genuinely meets the goal, and the per-ticket code review is skipped because the artifact, not the diff, is the product. Use it for the ONE art-direction ticket that owns the composed look. Do NOT use it for tickets with concrete checkable behaviour.
- "group" labels tickets into a coherent vertical slice (e.g. "core-engine", "gameplay", "polish"). Group boundaries ARE the review schedule: when every ticket in a group has committed, the railhead runs a whole-app review of the running build. Place the FIRST boundary at the first runnable, demoable slice — a pure-tooling scaffold has nothing to judge, so either leave it ungrouped or extend it into the first playable group. Once a rendered/interactive surface exists, keep groups to roughly 3-5 tickets so a defect is caught within a few commits; a group that runs longer gets an automatic mid-group checkpoint anyway. Omit group when the plan is too small to benefit from checkpoints.`;

/**
 * Topologically number tickets in dependency order (blockers first).
 * Cycles are not permitted; a cycle aborts planning.
 */
export async function orderTickets(tickets: PlanTicket[]): Promise<Ticket[]> {
  const n = tickets.length;
  const inDegree = new Array(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (const b of tickets[i].blocked_by) {
      if (b < 0 || b >= n) {
        throw new Error(`ticket ${i} has invalid blocked_by index ${b}`);
      }
      if (b === i) continue;
      const key = `${i}->${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      adj[b].push(i);
      inDegree[i]++;
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (inDegree[i] === 0) queue.push(i);
  const order: number[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj[u]) {
      if (--inDegree[v] === 0) queue.push(v);
    }
  }
  if (order.length !== n) {
    throw new Error("plan contains a dependency cycle; cannot order tickets");
  }

  const numberByIndex = new Map<number, number>();
  order.forEach((idx, pos) => numberByIndex.set(idx, pos + 1));
  const slugs = tickets.map((t) => titleSlug(t.title));
  // Issue #100 (ADR 0027, amended): a gate finding's identity is the slug (the
  // `NN-` prefix stripped), so two tickets can never share one — a ruling
  // keyed on a duplicate slug would silently suppress a DIFFERENT pair's
  // finding. A collision no longer aborts planning: the later colliders get a
  // deterministic -2, -3… suffix so ordering, file names, and every other
  // finding's keys stay collision-free, and `scanTicketConflicts` raises a
  // class-A `duplicate-slug` finding so the bounded repair loop (issue #86)
  // retitles or drops the duplicate before the plan is accepted.
  const usedSlugs = new Set<string>();
  const uniqueSlugs = slugs.map((slug) => {
    if (!usedSlugs.has(slug)) {
      usedSlugs.add(slug);
      return slug;
    }
    let n = 2;
    while (usedSlugs.has(`${slug}-${n}`)) n++;
    const suffixed = `${slug}-${n}`;
    usedSlugs.add(suffixed);
    return suffixed;
  });
  const fileOf = new Map<number, string>();
  for (const idx of order) {
    fileOf.set(idx, `${String(numberByIndex.get(idx)!).padStart(2, "0")}-${uniqueSlugs[idx]}.md`);
  }

  return tickets.map((t, idx) => {
    const file = fileOf.get(idx)!;
    const num = file.slice(0, 2);
    return {
      file,
      number: num,
      slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
      title: t.title,
      mission: t.mission ?? "",
      what: t.what,
      blocked_by: t.blocked_by
        .filter((b, _i, arr) => b !== idx && arr.indexOf(b) === _i)
        .map((b) => fileOf.get(b)!),
      criteria: t.criteria,
      files: t.files ?? [],
      references: t.references ?? [],
      introduces: t.introduces ?? [],
      testable: t.testable,
      open_ended: t.open_ended,
      group: t.group,
    };
  });
}

/**
 * Issue #19: extend every uncommitted ticket's `blocked_by` to include the
 * corrective ticket files generated by a goal review. This preserves group
 * coherence: after a goal review emits corrective tickets, all remaining
 * uncommitted tickets depend on those corrections, so they don't build on an
 * unfixed foundation. Already-committed tickets are left untouched (their
 * edges cannot change retroactively — the work is done).
 *
 * Pure function: returns a new array, does not mutate the input.
 *
 * @param tickets - the current ticket list (in-memory, from `loadTickets`)
 * @param correctiveFiles - ticket file names the goal review generated
 *   (e.g. ["06-goal-review-fix-flat-renderer.md"])
 * @param isCommitted - predicate to determine which tickets are already
 *   committed (their `blocked_by` must not change). This is a function
 *   rather than a status field on `Ticket` because `Ticket` is the on-disk
 *   format and does not carry run state — the caller knows from `TicketState`.
 * @returns a new array with corrective files appended to uncommitted
 *   tickets' `blocked_by` (deduped). Generic over `{ file, blocked_by }` so it
 *   serves both the plan's `Ticket[]` and the run's in-memory `TicketState[]`.
 */
export function extendBlockedBy<T extends { file: string; blocked_by: string[] }>(
  tickets: T[],
  correctiveFiles: string[],
  isCommitted: (file: string) => boolean,
): T[] {
  if (correctiveFiles.length === 0) return tickets;
  const correctiveSet = new Set(correctiveFiles);
  return tickets.map((t) => {
    if (isCommitted(t.file)) return t;
    // Issue #63: corrective tickets never depend on each other. They are
    // processed inline in dependency order, so their relative order is the
    // dependency — adding each other's files as blocked_by edges creates
    // mutual cycles (13→14→15→13) that make no ticket ever frontier-ready.
    if (correctiveSet.has(t.file)) return t;
    const existing = new Set(t.blocked_by);
    const additions = correctiveFiles.filter((f) => !existing.has(f));
    if (additions.length === 0) return t;
    return { ...t, blocked_by: [...t.blocked_by, ...additions] };
  });
}

/** Issue #86: the class of a plan finding, deciding how it escalates.
 *
 * - `classA` — plan-structure defects that predict implementer clobbering
 *   (duplicate introduces, unordered same-file edits). These always gate:
 *   repair or rule them in a bounded plan-repair round, else the plan is
 *   rejected. At runtime, an un-ruled classA finding between two non-corrective
 *   tickets is a railhead defect (the plan gate should have caught it).
 * - `classB` — quality defects that cheaply repair (missing consumes/produces
 *   declarations, placeholder language). They enter the same repair round but
 *   never hard-fail before the round cap is spent. */
export type FindingClass = "classA" | "classB";

/** The defect kind a finding names — the repair prompt keys its instruction
 * and the model's ruling references it. */
export type PlanFindingKind =
  | "duplicate-introduces"
  | "duplicate-slug"
  | "unordered-same-file"
  | "unsatisfied-reference"
  | "dangling-reference"
  | "no-contracts"
  | "unorderable-plan"
  | "placeholder"
  | "uncovered-file"
  | "unre-owned-entry-point"
  | "missing-art-ticket"
  | "dropped-ticket";

/** One gate finding. Stable enough to be repaired, ruled, or persisted: every
 * finding carries a deterministic structured `key` (e.g.
 * `dup-introduce:FRAME_COUNT:x:y` — the involved tickets identified by their
 * slug, the `NN-` ordering prefix stripped) so a ruling recorded against it can
 * suppress the identical finding later — plan-time vs. runtime, across repair
 * rounds, regardless of what `NN` any round renumbered — without text matching.
 * The `message` (human/runtime-facing) keeps full `NN-slug.md` file names. */
export interface ConflictFinding {
  kind: PlanFindingKind;
  cls: FindingClass;
  /** Deterministic structured identity; a Ruling references it. */
  key: string;
  /** Human-readable finding for the console, the repair table, and the report. */
  message: string;
  /** The ticket files involved (sorted). A duplicate-introduce / same-file
   * finding names exactly two; a singleton finding (no-contracts,
   * placeholder) names the one ticket it is about. */
  tickets: string[];
}

/** A ruling: a finding adjudicated intentional (plan-time repair) or resolved
 * deterministically (runtime corrective precedence), never silently. The key
 * is what makes the ruling reach across scans: slug-identity (ADR 0027), so a
 * ruling recorded against round 1's numbering still matches round 2's scan of
 * the same physical pair. `tickets` keeps the full file names for the report. */
export interface Ruling {
  /** The structured finding key this ruling adjudicates. */
  key: string;
  /** The finding message it answered (for the report). */
  finding: string;
  /** One-line justification. Plan rulings carry the model's reason; runtime
   * rulings carry the deterministic rule (redefinition / defect-fix precedence). */
  reason: string;
  /** Where the ruling was made: plan-time adjudication or run-time auto-rule. */
  source: "plan" | "runtime";
  /** Ticket files the finding involved. */
  tickets: string[];
}

/** The result of `scanTicketConflicts`. `errors` abort the run immediately
 * (dangling refs, cycles); `classA` and `classB` findings escalate through the
 * bounded plan-repair loop (issue #86). */
export interface ConflictReport {
  errors: string[];
  /** Class-A findings: repair or rule, else the plan is rejected. */
  classA: ConflictFinding[];
  /** Class-B findings: quality defects, repairable in the same rounds. */
  classB: ConflictFinding[];
}

/** The union of a report's findings (class A first), used to build the repair
 * table and to decide whether any work remains. */
export function allConflictFindings(report: ConflictReport): ConflictFinding[] {
  return [...report.classA, ...report.classB];
}

/** Whether a report carries any finding (errors or escalatable). */
export function isEmptyConflictReport(report: ConflictReport): boolean {
  return report.errors.length === 0 && report.classA.length === 0 && report.classB.length === 0;
}

/** Print conflict findings to the console and optionally persist them to the
 * run ledger. Returns `true` if hard errors were found (caller should abort). */
export async function reportConflicts(
  conflicts: ConflictReport,
  opts: { ledger?: string; appendEvent?: (dir: string, phase: string, line: string) => Promise<void> } = {},
): Promise<boolean> {
  if (isEmptyConflictReport(conflicts)) return false;
  const lines = [
    ...conflicts.errors.map((e) => `[error] ${e}`),
    ...allConflictFindings(conflicts).map((f) => `[${f.cls === "classA" ? "A" : "B"}] ${f.message}`),
  ];
  if (opts.ledger && opts.appendEvent) {
    await opts.appendEvent(opts.ledger, "conflict-scan", lines.join("\n"));
  }
  for (const e of conflicts.errors) console.error(`[conflict] ${e}`);
  for (const f of allConflictFindings(conflicts)) console.warn(`[conflict][${f.cls === "classA" ? "A" : "B"}] ${f.message}`);
  return conflicts.errors.length > 0;
}

/** The two sorted ticket files a pairwise finding involves — the canonical
 * ordering for the persisted `tickets` pair. */
function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** The title-derived slug every file name, finding, and ruling key is built
 * on (ADR 0027). Shared by `orderTickets`, the duplicate-slug scan, and the
 * plan parser's $TICKETS-region reconciliation (issue #104) so all three
 * compute identity identically. */
export function titleSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || "ticket";
}

/** Normalize a declared contract symbol to its identity: strip a trailing
 * `=<value>` annotation (`CANVAS=32` → `CANVAS`) and surrounding whitespace.
 * The planner may record a constant's value in one ticket's "introduces" while
 * a later ticket references the bare name; symbol identity must not depend on
 * that formatting or the gate reports a phantom dangling reference. */
export function contractName(symbol: string): string {
  const trimmed = symbol.trim();
  const eq = trimmed.indexOf("=");
  return (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim();
}

/** Two slugs in canonical (lexicographic) order for embedding in a ruling key.
 * Sorting by SLUG — not by the `NN-` file prefix — keeps the key byte-identical
 * when an unrelated repair edge renumbers the same physical pair. */
function slugPairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Issue #48: pre-run conflict scan over the ticket set. Catches plan defects
 * that `orderTickets` does not (or that `extendBlockedBy` may introduce after
 * planning), so they are surfaced before burning Implementer attempts:
 *
 * - Dangling `blocked_by` references (a ticket depends on a file that does
 *   not exist in the set) — error.
 * - Dependency cycles (introduced at runtime by `extendBlockedBy`, since
 *   `orderTickets` already caught plan-time cycles) — error.
 * - Duplicate `introduces` symbols across tickets (two tickets claim to
 *   introduce the same contract) — class A finding (issue #86: repair or
 *   rule in a bounded plan-repair round, else reject).
 * - Duplicate title-slugs (ADR 0027, amended): tickets whose titles slug-ify
 *   identically — class A finding; `orderTickets` already suffixed their file
 *   names apart, the repair loop retitles or drops the duplicate.
 * - Unsatisfied references (issue #103): a ticket references a symbol another
 *   ticket introduces but is not ordered after it — class A finding.
 * - Dangling references (issue #103): a reference names a symbol no ticket
 *   introduces and no known existing contract — class A finding.
 * - Tickets that touch the same file without an ordering edge between them
 *   (directly or transitively) — class A finding.
 *
 * Pure function: does not mutate the input or touch the filesystem.
 *
 * @param tickets - the loaded ticket set (post-`orderTickets`, so
 *   `blocked_by` holds filenames, not numeric indices)
 * @param universe - the committed/existing-code context (issue #103): symbols
 *   the contracts index knows (a reference to one is not dangling) and ticket
 *   files whose work is done (references to their introduces need no edge).
 */
export function scanTicketConflicts(
  tickets: Ticket[],
  universe: ReferenceUniverse = {},
): ConflictReport {
  if (tickets.length === 0) return { errors: [], classA: [], classB: [] };
  const byFile = new Map(tickets.map((t) => [t.file, t]));
  const errors: string[] = [];

  const dangling = findDanglingBlockedBy(tickets, byFile);
  const cycles = findCycles(tickets, byFile);
  errors.push(...dangling, ...cycles);
  const classA = [
    ...findDuplicateIntroduces(tickets),
    ...findDuplicateSlugs(tickets),
    ...findUnsatisfiedReferences(tickets, universe.satisfiedFiles),
    ...findDanglingReferences(tickets, universe.existingSymbols),
    ...findUnorderedSameFile(tickets, byFile),
    ...findUncoveredRequiredFiles(tickets, universe.requiredFiles ?? [], universe.alreadyExistingFiles),
    ...findUnreOwnedEntryPoint(tickets, universe.promisesIntegration ?? false),
    ...findMissingArtTicket(tickets, universe.artDirectionRequired ?? false),
  ];

  return { errors, classA, classB: [] };
}

/** Issue #86: assess a ticket set that has been mutated at RUNTIME — a
 * corrective insertion (extendBlockedBy edge set applied) re-scanned against
 * the same policy the plan gate enforces. The policy is deterministic here;
 * there is no model round mid-run to adjudicate, so each outcome is either a
 * recorded auto-ruling or a hard throw.
 *
 * The scan runs over the FULL set (committed tickets included as passive
 * counterparties) so a corrective re-introducing a symbol a committed ticket
 * introduced is visible; committed-only pairs are inert (both already done).
 *
 * - A finding whose key a plan-time ruling already covers → inert (nothing to
 *   do; the plan gate adjudicated it).
 * - A class-A finding involving a corrective ticket → auto-ruled, run
 *   continues: `extendBlockedBy` orders the corrective first (defect-fix
 *   precedence) and `mergeContracts` models the later re-introduction as an
 *   update (redefinition), so the pair is recoverable by construction. When
 *   the counterpart is already committed the corrective IS the fix; when the
 *   counterpart is an uncommitted planned ticket that ticket redefines at run.
 * - A class-A finding between two non-corrective tickets → a railhead defect
 *   (the plan gate should have repaired or ruled it): abort naming the pair.
 * - Cycles / dangling refs → abort (unrecoverable), unchanged.
 *
 * Pure function. The caller sequences it AFTER the extendBlockedBy edges are
 * applied so corrective-connected pairs are already ordered and drop out of
 * the same-file scan on their own.
 *
 * @param tickets - the full ticket set (committed + live), post-extension
 * @param correctiveFiles - corrective ticket files that were just inserted
 * @param committedFiles - ticket files already committed (their work is done;
 *   a corrective re-introducing one of their symbols is a redefinition)
 * @param planRulings - rulings loaded from the plan directory
 * @param existingSymbols - the contracts-index symbols (issue #103): a live
 *   ticket referencing one is not a dangling reference
 */
export function assessRuntimeExtension(
  tickets: Ticket[],
  opts: { correctiveFiles: string[]; committedFiles: string[]; planRulings: Ruling[]; existingSymbols?: ReadonlySet<string> },
): { fatal: string[]; rulings: Ruling[] } {
  const { correctiveFiles, committedFiles, planRulings, existingSymbols } = opts;
  const committed = new Set(committedFiles);
  const report = scanTicketConflicts(tickets, {
    // A corrective legitimately references committed contracts it is NOT
    // blocked by (issue #63: correctives carry no blocked_by) — commit order
    // satisfies those references in time, so the committed introducer files
    // are pre-satisfied (issue #103).
    satisfiedFiles: committed,
    existingSymbols,
  });
  const fatal = [...report.errors];
  const rulings: Ruling[] = [];
  const corrective = new Set(correctiveFiles);
  const ruledKeys = new Set(planRulings.map((r) => r.key));

  for (const f of report.classA) {
    // Plan-time adjudication already settled this exact finding — inert.
    if (ruledKeys.has(f.key)) continue;
    // Issue #103: a dangling reference needs a model's judgement (no edge
    // exists to insert for a symbol nowhere) — the runtime has none, and a
    // corrective's references are advisory seams the reviewer names from
    // committed code (issue #67). Inert here; the plan gate owns this finding.
    if (f.kind === "dangling-reference") continue;
    const [a, b] = f.tickets;
    const aCorrective = corrective.has(a);
    const bCorrective = corrective.has(b);
    const bothCommitted = committed.has(a) && committed.has(b);
    if (bothCommitted && !aCorrective && !bCorrective) continue; // both done — nothing left to clobber
    if (aCorrective || bCorrective) {
      const correctiveFile = aCorrective ? a : b;
      const other = aCorrective ? b : a;
      const otherCommitted = committed.has(other);
      rulings.push({
        key: f.key,
        finding: f.message,
        source: "runtime",
        tickets: f.tickets,
        reason: pairRuntimeReason(f.kind, correctiveFile, other, otherCommitted),
      });
    } else {
      fatal.push(
        `plan invariant violated at runtime — class-A finding between non-corrective tickets ${a} and ${b}: ${f.message}. The plan gate should have repaired or ruled this; an unexpected mutation path exists.`,
      );
    }
  }
  return { fatal, rulings };
}

/** The auto-rule reason for a corrective-involved class-A pair (issue #86 +
 * #103). Each kind's recovery is deterministic, so the ruling names it. */
function pairRuntimeReason(
  kind: PlanFindingKind,
  correctiveFile: string,
  other: string,
  otherCommitted: boolean,
): string {
  if (kind === "unsatisfied-reference") {
    return otherCommitted
      ? `corrective ${correctiveFile} references a symbol committed ticket ${other} already ships — inert (the introducer's work is done; no edge is needed)`
      : `unsatisfied reference between corrective ${correctiveFile} and ticket ${other} — ruled: corrective-first precedence (extendBlockedBy edge); ${other} ships the referenced contract only after the corrective's fix is committed`;
  }
  return otherCommitted
    ? `corrective ${correctiveFile} re-introduces a symbol/fix from committed ticket ${other} — ruled: redefinition (the corrective replaces prior work; mergeContracts updates the entry at commit)`
    : `duplicate introduce/same-file between corrective ${correctiveFile} and ticket ${other} — ruled: defect-fix precedence (extendBlockedBy edge), ${other} redefines at run`;
}

function findDanglingBlockedBy(tickets: Ticket[], byFile: Map<string, Ticket>): string[] {
  const errors: string[] = [];
  for (const t of tickets) {
    for (const dep of t.blocked_by) {
      if (dep === t.file) continue;
      if (!byFile.has(dep)) {
        errors.push(`ticket ${t.number} (${t.file}) has a dangling blocked_by reference to "${dep}" — no such ticket in the set`);
      }
    }
  }
  return errors;
}

/** Cycle detection via DFS with three-color marking. `orderTickets` catches
 * cycles at plan time, but `extendBlockedBy` can introduce them at runtime. */
function findCycles(tickets: Ticket[], byFile: Map<string, Ticket>): string[] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tickets) color.set(t.file, WHITE);

  const visit = (file: string, path: string[]): boolean => {
    color.set(file, GRAY);
    const ticket = byFile.get(file);
    if (!ticket) return false;
    for (const dep of ticket.blocked_by) {
      if (dep === file || !byFile.has(dep)) continue;
      const c = color.get(dep)!;
      if (c === GRAY) return true;
      if (c === WHITE && visit(dep, [...path, dep])) return true;
    }
    color.set(file, BLACK);
    return false;
  };

  for (const t of tickets) {
    if (color.get(t.file) === WHITE && visit(t.file, [t.file])) {
      return [`dependency cycle detected in the ticket set — a ticket (transitively) blocks itself; see the blocked_by edges`];
    }
  }
  return [];
}

/** One finding per owner PAIR of a duplicated introduces symbol — a finding
 * names two tickets, so a repair round can fix or rule exactly the pair that
 * clashes (three owners = three pairwise findings; ruling one pair leaves the
 * others outstanding). The key `dup-introduce:<sym>:<slugA>:<slugB>` is
 * deterministic across plan-time and runtime scans of the same physical pair:
 * slugs identify tickets by content (ADR 0027), never by a re-derived `NN`. */
function findDuplicateIntroduces(tickets: Ticket[]): ConflictFinding[] {
  const slugByFile = new Map(tickets.map((t) => [t.file, t.slug]));
  const introducedBy = new Map<string, string[]>();
  for (const t of tickets) {
    for (const sym of t.introduces) {
      const name = contractName(sym);
      const owners = introducedBy.get(name) ?? [];
      owners.push(t.file);
      introducedBy.set(name, owners);
    }
  }
  const findings: ConflictFinding[] = [];
  for (const [name, owners] of introducedBy) {
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        const [a, b] = pairKey(owners[i], owners[j]);
        findings.push({
          kind: "duplicate-introduces",
          cls: "classA",
          key: `dup-introduce:${name}:${slugPairKey(slugByFile.get(a)!, slugByFile.get(b)!)}`,
          tickets: [a, b],
          message: `duplicate introduces: symbol "${name}" is introduced by tickets ${a} and ${b} — the later ticket may shadow or break the earlier one's contract`,
        });
      }
    }
  }
  return findings;
}

/** ADR 0027 (amended): one class-A finding per colliding base title-slug — a
 * group of tickets whose titles slug-ify identically. Keyed by the BASE slug
 * (not the suffixed file slug `orderTickets` assigned) so the key stays stable
 * however the -2 suffix lands across repair rounds. The disambiguating suffix
 * exists only to keep ordering, file names, and every OTHER finding's keys
 * collision-free while the repair loop fixes the collision itself. */
function findDuplicateSlugs(tickets: Ticket[]): ConflictFinding[] {
  const groups = new Map<string, string[]>();
  for (const t of tickets) {
    const base = titleSlug(t.title);
    const members = groups.get(base) ?? [];
    members.push(t.file);
    groups.set(base, members);
  }
  const findings: ConflictFinding[] = [];
  for (const [base, members] of groups) {
    if (members.length < 2) continue;
    const files = [...members].sort();
    findings.push({
      kind: "duplicate-slug",
      cls: "classA",
      key: `dup-slug:${base}`,
      tickets: files,
      message: `duplicate title-slug: tickets ${files.join(" and ")} all title-slug to "${base}" — findings and rulings identify tickets by slug (ADR 0027), so retitle one ticket to a distinct title, or remove the duplicated ticket entirely`,
    });
  }
  return findings;
}

/** Issue #103: what a scan knows about contracts that live OUTSIDE the
 * scanned ticket set (the committed/existing-code universe). A reference is
 * only ever checked against the set plus this universe, so a ticket that
 * builds on a committed contract is never misread as a dangling reference.
 *
 * - `existingSymbols`: symbols the contracts index already knows (committed
 *   tickets' introduces, hand-maintained entries). A reference to one is not
 *   dangling.
 * - `satisfiedFiles`: ticket files whose work is already done (committed). A
 *   reference to a symbol they introduce needs no `blocked_by` edge — commit
 *   order already satisfies it in time (a mid-run corrective references
 *   committed contracts it is not, and must not be, blocked by). */
export interface ReferenceUniverse {
  existingSymbols?: ReadonlySet<string>;
  satisfiedFiles?: ReadonlySet<string>;
  /** Files the spec/architecture promise the plan will produce; any not owned
   * by a ticket's `files` and not already on disk is a coverage gap. */
  requiredFiles?: string[];
  alreadyExistingFiles?: ReadonlySet<string>;
  /** Whether the plan text promises a late/terminal integration of the entry
   * point (e.g. "re-owned by the final integration ticket") — the plan defers
   * wiring to a terminal ticket instead of wiring the shell early. */
  promisesIntegration?: boolean;
  /** Whether this plan must contain the art-direction ticket pair (a rendered
   * surface, and art direction not disabled by config). The plan-time gate
   * only; replan/runtime universes leave it unset so an already-committed art
   * ticket is never demanded again. */
  artDirectionRequired?: boolean;
}

/** Issue #103: the single-owner introducer index — symbol → the ticket file
 * that introduces it. Single-valued because duplicate introduces is already a
 * class-A finding: on a clean set every symbol has exactly one owner. First
 * owner wins when a dirty set slips in (the duplicate finding gates that case
 * separately). */
export function introducerIndex(tickets: Ticket[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const t of tickets) {
    for (const sym of t.introduces) {
      const name = contractName(sym);
      if (!index.has(name)) index.set(name, t.file);
    }
  }
  return index;
}

/** The symbol → owning-files map, used to skip reference resolution on symbols
 * a dirty set introduces twice — with no unambiguous owner the ordering cannot
 * be decided (the duplicate-introduces finding gates that case, not this one). */
function symbolOwners(tickets: Ticket[]): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const t of tickets) {
    for (const sym of t.introduces) {
      const name = contractName(sym);
      const list = owners.get(name) ?? [];
      list.push(t.file);
      owners.set(name, list);
    }
  }
  return owners;
}

/** Issue #103: for each ticket's `references` symbol that ANOTHER ticket in
 * the set introduces, a finding when the introducer is not already a
 * transitive `blocked_by` predecessor — the reference would force an
 * implementer to consume a contract the plan has not shipped yet (the #61/#64
 * failure class). Class A: it gates. The key `ref:<referencingSlug>:<symbol>`
 * is slug-identity (ADR 0027) and content-derived, so a ruling survives a
 * renumber. `satisfiedFiles` (committed tickets) are exempt — time orders them
 * even without an edge. */
export function findUnsatisfiedReferences(
  tickets: Ticket[],
  satisfiedFiles?: ReadonlySet<string>,
): ConflictFinding[] {
  const byFile = new Map(tickets.map((t) => [t.file, t]));
  const introducers = introducerIndex(tickets);
  const owners = symbolOwners(tickets);
  const findings: ConflictFinding[] = [];
  for (const t of tickets) {
    for (const sym of t.references) {
      const name = contractName(sym);
      const owner = introducers.get(name);
      if (!owner || owner === t.file) continue;
      if ((owners.get(name)?.length ?? 0) > 1) continue; // ambiguous while dup-introduces is open
      if (satisfiedFiles?.has(owner)) continue; // introducer's work is already done
      if (dependsOn(t.file, owner, byFile)) continue;
      findings.push({
        kind: "unsatisfied-reference",
        cls: "classA",
        key: `ref:${t.slug}:${name}`,
        tickets: pairKey(t.file, owner),
        message: `ticket ${t.file} references symbol "${name}", introduced by ticket ${owner}, but is not ordered after it — add ${owner} to ${t.file}'s blocked_by (the gate auto-inserts this edge when no other finding blocks)`,
      });
    }
  }
  return findings;
}

/** Issue #103: a reference to a symbol NO ticket in the set introduces and no
 * known existing contract names — a typo, a forgotten introduces declaration,
 * or a genuinely missing symbol. Deliberately a DISTINCT kind from
 * unsatisfied-reference: there is no deterministic edge to insert, so this must
 * escalate to a model repair round for judgement. `existingSymbols` is the
 * committed/existing-code universe (the contracts index); a reference to one
 * of those is not dangling. */
export function findDanglingReferences(
  tickets: Ticket[],
  existingSymbols?: ReadonlySet<string>,
): ConflictFinding[] {
  const introducers = introducerIndex(tickets);
  const findings: ConflictFinding[] = [];
  for (const t of tickets) {
    for (const sym of t.references) {
      const name = contractName(sym);
      if (introducers.has(name)) continue;
      if (existingSymbols?.has(name)) continue;
      findings.push({
        kind: "dangling-reference",
        cls: "classA",
        key: `dangling-ref:${t.slug}:${name}`,
        tickets: [t.file],
        message: `ticket ${t.file} references symbol "${name}", which no ticket introduces and which is not a known contract — check for a typo, a missing introduces declaration on an earlier ticket, or (if the contract exists in committed code) a symbol missing from the contracts index`,
      });
    }
  }
  return findings;
}

/** One finding per ticket PAIR that edits a shared file without an ordering
 * edge (direct or transitive) between them. The key `same-file:<slugA>:<slugB>`
 * names the pair by content identity (ADR 0027) — the shared files are detail
 * in the message. Once an edge exists (extendBlockedBy at runtime, a repair
 * round at plan time) the pair drops out of the scan entirely. */
function findUnorderedSameFile(tickets: Ticket[], byFile: Map<string, Ticket>): ConflictFinding[] {
  const ticketsWithFiles = tickets.filter((t) => t.files.length > 0);
  const findings: ConflictFinding[] = [];
  for (let i = 0; i < ticketsWithFiles.length; i++) {
    for (let j = i + 1; j < ticketsWithFiles.length; j++) {
      const a = ticketsWithFiles[i];
      const b = ticketsWithFiles[j];
      const shared = a.files.filter((f) => b.files.includes(f));
      if (shared.length === 0) continue;
      if (dependsOn(a.file, b.file, byFile) || dependsOn(b.file, a.file, byFile)) continue;
      const [fa, fb] = pairKey(a.file, b.file);
      findings.push({
        kind: "unordered-same-file",
        cls: "classA",
        key: `same-file:${slugPairKey(byFile.get(fa)!.slug, byFile.get(fb)!.slug)}`,
        tickets: [fa, fb],
        message: `tickets ${fa} and ${fb} both touch ${shared.map((f) => `\`${f}\``).join(", ")} but have no ordering edge between them — one may clobber the other's edits`,
      });
    }
  }
  return findings;
}

/** A file the plan names that no ticket owns and that does not already exist
 * on disk is a coverage gap: the spec or architecture promised a module/surface
 * file the ticket decomposition never produced. `alreadyExistingFiles` exempts
 * files that predate the plan (the input spec, committed docs, prior work) — a
 * named file only counts as a promise when it does not yet exist. */
/** Normalize a plan path for coverage comparison: trim, collapse backslashes,
 * strip a leading `./`. The spec/architecture names a file loosely (`tokens.ts`
 * in a module map) while a ticket lists the real path (`src/art/tokens.ts`). */
function normalizePlanPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Whether an owned ticket file satisfies a required file: exact match, or the
 * owned path ends with the required path on a path-segment boundary. Without
 * the suffix arm, a bare name in the architecture's module map never matches
 * the ticket's full path and the gate rejects a plan that actually covers the
 * file (the platformer/art-proto `tokens.ts` vs `src/art/tokens.ts` false
 * positive). */
function fileCovers(ownedPath: string, requiredPath: string): boolean {
  const owned = normalizePlanPath(ownedPath);
  const required = normalizePlanPath(requiredPath);
  return owned === required || owned.endsWith(`/${required}`);
}

export function findUncoveredRequiredFiles(
  tickets: Ticket[],
  requiredFiles: string[],
  alreadyExistingFiles?: ReadonlySet<string>,
): ConflictFinding[] {
  if (requiredFiles.length === 0) return [];
  const owned = tickets.flatMap((t) => t.files);
  const existing = alreadyExistingFiles ? [...alreadyExistingFiles] : [];
  const findings: ConflictFinding[] = [];
  for (const f of requiredFiles) {
    if (existing.some((e) => fileCovers(e, f))) continue;
    if (owned.some((o) => fileCovers(o, f))) continue;
    findings.push({
      kind: "uncovered-file",
      cls: "classA",
      key: `uncovered-file:${f}`,
      tickets: [],
      message: `the plan names required file "${f}" (from the spec or architecture) but no ticket lists it in "files" — a ticket must own it, or the plan is incomplete`,
    });
  }
  return findings;
}

/** The art-direction coverage check: a plan for a rendered surface must own the
 * LOOK with exactly ONE open-ended craft ticket (`open_ended: true`) that
 * creates the composed artifact. Decomposing the look into per-element visual
 * tickets with structural criteria is the failure this gate exists to prevent —
 * it caps the result at "measurably non-bland" and stops at each slice. Pure. */
export function findMissingArtTicket(tickets: Ticket[], required: boolean): ConflictFinding[] {
  if (!required || tickets.length === 0) return [];
  const openEnded = tickets.filter((t) => t.open_ended === true);
  if (openEnded.length === 0) {
    return [{
      kind: "missing-art-ticket",
      cls: "classA",
      key: "missing-art-ticket:open-ended",
      tickets: [],
      message: `this build has a rendered surface, so its look must be owned by exactly ONE open-ended craft ticket (open_ended: true) that creates the composed artifact and iterates on screenshots until the goal is met — not decomposed into per-element visual tickets with structural criteria; no open-ended ticket was found`,
    }];
  }
  if (openEnded.length > 1) {
    return [{
      kind: "missing-art-ticket",
      cls: "classA",
      key: "missing-art-ticket:multiple",
      tickets: openEnded.map((t) => t.file),
      message: `this build has ${openEnded.length} open-ended craft tickets (${openEnded.map((t) => t.file).join(", ")}) — the look must be owned by exactly ONE so a single agent composes the whole artifact; merge them into one, or mark the others as ordinary tickets with concrete criteria`,
    }];
  }
  return [];
}

/** Whether a path is the app's JS/TS entry point (the file one early shell
 * ticket owns and that later tickets dock into via its mount contract).
 * Restricts to script extensions so `index.html` and test barrels are not
 * mistaken for it. */
function isEntryFile(path: string): boolean {
  return /(?:^|\/)(?:main|index)\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path);
}

/** When the plan text promises a late/terminal integration of the entry point
 * but nothing wires the shell EARLY, the app ships as a placeholder for the
 * whole run (issue #115). The early-owner shape is: ONE shell ticket owns the
 * entry point near the start and mounts a minimal running shell, and later
 * tickets dock into its mount contract — so the smell is the promise of a
 * terminal integration itself, whatever the owner count. Zero owners is the
 * `uncovered-file` case (handled separately). */
export function findUnreOwnedEntryPoint(
  tickets: Ticket[],
  promisesIntegration: boolean,
): ConflictFinding[] {
  if (!promisesIntegration || tickets.length <= 1) return [];
  const owners = new Map<string, string[]>();
  for (const t of tickets) {
    for (const f of t.files) {
      if (!isEntryFile(f)) continue;
      const list = owners.get(f) ?? [];
      list.push(t.file);
      owners.set(f, list);
    }
  }
  const findings: ConflictFinding[] = [];
  for (const [file, owns] of owners) {
    findings.push({
      kind: "unre-owned-entry-point",
      cls: "classA",
      key: `unre-owned-entry:${file}`,
      tickets: owns,
      message: `the plan promises a late/terminal integration of the entry point "${file}" (owned by ${owns.join(", ")}) — wire the shell EARLY instead: one early ticket owns "${file}" and mounts a minimal running shell (a mount contract with empty panel slots), and later tickets dock into that contract rather than a terminal integration`,
    });
  }
  return findings;
}

/** A title-slug present in the pre-repair plan but absent from the repaired
 * plan is a DROPPED ticket, not a silent shrink: the repair model (or the lossy
 * plan re-parse) must not be allowed to delete scope without a trace. A
 * legitimate merge (two tickets folded into one) is surfaced the same way and
 * adjudicated with a ruling — the point is that a drop is never invisible. */
export function findDroppedTickets(
  before: PlanTicket[],
  after: PlanTicket[],
): ConflictFinding[] {
  const afterSlugs = new Set(after.map((t) => titleSlug(t.title)));
  const findings: ConflictFinding[] = [];
  for (const t of before) {
    const slug = titleSlug(t.title);
    if (afterSlugs.has(slug)) continue;
    findings.push({
      kind: "dropped-ticket",
      cls: "classA",
      key: `dropped-ticket:${slug}`,
      tickets: [],
      message: `the repaired plan dropped ticket "${t.title}" (slug "${slug}") that existed before the repair round — restore it, merge it into a surviving ticket and rule the merge, or rule the drop as intentional; silent shrinkage is not accepted`,
    });
  }
  return findings;
}

/** The structural identity of a plan ticket for repeat detection (ADR 0035):
 * title-slug + owned files + introduced symbols, each normalized the way the
 * gate normalizes (slugify, `contractName`), order-insensitive. Prose fields
 * (`what`, `criteria`, `mission`) are deliberately excluded: a small planner
 * re-emitting the same ticket mid-continuation often rephrases prose while the
 * structural content — the part findings are computed from — stays identical. */
function ticketStructuralKey(t: PlanTicket): string {
  const norm = (xs?: string[]) => [...(xs ?? [])].map((x) => x.trim()).filter((x) => x.length > 0).sort();
  const introduces = norm(t.introduces?.map(contractName));
  return `${titleSlug(t.title)}|${norm(t.files).join(",")}|${introduces.join(",")}`;
}

/** ADR 0035: collapse a ticket the planner emitted more than once — identical
 * title, files, and introduces (the classic small-model continuation failure:
 * the plan is emitted, then emitted again inside one array, and the gate's
 * duplicate-slug / duplicate-introduces / same-file findings all fire on the
 * same physical pairs). Keeping the FIRST emission and remapping `blocked_by`
 * is deterministic, so it never belongs in a paid model repair round.
 *
 * Distinct-content tickets that merely share a title (same slug, different
 * files or introduces) are NOT collapsed — dropping one could silently delete
 * scope, so those still escalate as `duplicate-slug` findings for the model to
 * retitle or merge (ADR 0027, amended).
 *
 * `blocked_by` indices pointing at a dropped copy remap to the kept twin (they
 * name the same work); indices into kept tickets shift with the compaction;
 * self-edges introduced by the remap are dropped. Pure: returns the input
 * array unchanged (not a copy) when nothing repeats. */
export function collapseRepeatedTickets(
  plan: PlanTicket[],
): { tickets: PlanTicket[]; dropped: { index: number; title: string }[] } {
  const keptByKey = new Map<string, number>();
  const keepOldIndex: number[] = [];
  const twinOf = new Map<number, number>();
  const dropped: { index: number; title: string }[] = [];
  plan.forEach((t, i) => {
    const key = ticketStructuralKey(t);
    const kept = keptByKey.get(key);
    if (kept === undefined) {
      keptByKey.set(key, i);
      keepOldIndex.push(i);
    } else {
      twinOf.set(i, kept);
      dropped.push({ index: i, title: t.title });
    }
  });
  if (dropped.length === 0) return { tickets: plan, dropped };
  const newIndexOf = new Map<number, number>();
  keepOldIndex.forEach((oldIdx, newIdx) => newIndexOf.set(oldIdx, newIdx));
  const remap = (b: number): number => newIndexOf.get(twinOf.get(b) ?? b) ?? b;
  const tickets = keepOldIndex.map((oldIdx, newIdx) => {
    const t = plan[oldIdx];
    const remapped = (t.blocked_by ?? [])
      .map(remap)
      .filter((b, pos, arr) => b !== newIdx && arr.indexOf(b) === pos);
    return { ...t, blocked_by: remapped };
  });
  return { tickets, dropped };
}

export function dependsOn(from: string, to: string, byFile: Map<string, Ticket>): boolean {
  const visited = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const ticket = byFile.get(cur);
    if (!ticket) continue;
    for (const dep of ticket.blocked_by) {
      if (dep === to) return true;
      if (!visited.has(dep) && byFile.has(dep)) queue.push(dep);
    }
  }
  return false;
}