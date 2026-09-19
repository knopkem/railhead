import { frontier, type TicketState, type RunState } from "../core/state.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseReplanRequested } from "./goal-review.ts";
import { nextTicketNumber, type RunTicket } from "./corrective.ts";
import { parsePlanJson, reportConflicts, scanOrderedConflicts } from "../plan/plan.ts";
import { orderTickets, collapseRepeatedTickets, TICKET_FIELD_SEMANTICS, type PlanTicket } from "../core/ticket-dag.ts";
import { loadTickets, toTicketState, renderTicket, type Ticket } from "../core/ticket.ts";
import { appendEvent, resetPhase, writeState, extractPlanText } from "../core/ledger.ts";
import { describeExecFailure, executeOpendCode } from "../execute/executor.ts";
import { contextBudget } from "../config/config.ts";
import { loadContracts, summarizeContracts, knownContractSymbols } from "../core/contracts.ts";
import { readDigest } from "../context/digest.ts";
import * as git from "../core/git.ts";
import { nowClock } from "../cli/overview.ts";

export interface ReplanClassification {
  replan: boolean;
  reason: string;
}

// Issue #65: these patterns no longer TRIGGER replan — the reviewer's $REPLAN
// marker is the authority. They survive only as a heuristic to warn when
// findings LOOK structural but no marker was emitted. Being lenient is safe:
// a false-positive warning just nudges the reviewer's signal discipline.
const PLAN_LEVEL_SIGNALS = [
  /plan\s+assumption/i,
  /planned\s+\S*\s*structure/i,
  /plan\s+was\s+wrong/i,
  /replan/i,
  /regenerate/i,
  /diverged?\s+from.*(?:plan|architecture)/i,
  /divergen[ct]\b/i,
  /actual\s+architecture/i,
  /remaining\s+tickets\s+(?:must|should)\s+be\s+(?:restructured|regenerated|replanned)/i,
  /tickets.*reference.*(?:modules?|files?)\s+that\s+(?:don'?t|do\s+not)\s+exist/i,
];

const IMPLEMENTATION_GAP_SIGNALS = [
  /crashes?\s+on/i,
  /missing\s+error\s+handling/i,
  /missing\s+(?:the\s+)?\w+\s+(?:endpoint|function|method|field|feature)/i,
  /naming\s+convention/i,
  /camelcase|snake_case/i,
  /leftover|cleanup/i,
  /stub|placeholder/i,
];

export function classifyFindings(findings: string[]): ReplanClassification {
  if (findings.length === 0) {
    return { replan: false, reason: "no findings to classify" };
  }

  const text = findings.join(" ");
  const hasPlanSignal = PLAN_LEVEL_SIGNALS.some((re) => re.test(text));
  if (hasPlanSignal) {
    return {
      replan: true,
      reason: "findings indicate a plan-level flaw, not just an implementation gap",
    };
  }

  return {
    replan: false,
    reason: "findings are implementation gaps — corrective tickets suffice",
  };
}

export interface ReplanPromptOptions {
  originalPrompt: string;
  findings: string[];
  contractsSummary: string;
  digest: string | null;
  committedTickets: { number: string; title: string; file: string }[];
  uncommittedTickets: { number: string; title: string; file: string }[];
}

export function buildReplanPrompt(options: ReplanPromptOptions): string {
  const { originalPrompt, findings, contractsSummary, digest, committedTickets, uncommittedTickets } = options;

  const findingsBlock = findings.length
    ? findings.map((f) => `- ${f}`).join("\n")
    : "- (no specific findings)";

  const committedBlock = committedTickets.length
    ? committedTickets.map((t) => `- ${t.file}: ${t.title} (number ${t.number})`).join("\n")
    : "(none yet — this is an early checkpoint)";

  const uncommittedBlock = uncommittedTickets.length
    ? uncommittedTickets.map((t) => `- ${t.file}: ${t.title} (number ${t.number})`).join("\n")
    : "(none — all planned tickets are committed)";

  // A run-end replan has no uncommitted frontier to replace — the plan was
  // incomplete, so the job is to emit the ADDITIONAL tickets that close the gaps.
  const jobLine = uncommittedTickets.length > 0
    ? "Your job: regenerate ONLY the uncommitted frontier. Preserve all committed work — it is built, tested, and committed. Replace the uncommitted tickets with a revised plan that accounts for what was actually learned at the checkpoint."
    : "Your job: the plan turned out INCOMPLETE — generate the ADDITIONAL tickets needed to complete the goal, building on the committed work. Preserve all committed work — it is built, tested, and committed.";
  const replaceSection = uncommittedTickets.length > 0
    ? `\n## Tickets to replace (the old uncommitted frontier — regenerate these entirely)\n\n${uncommittedBlock}\n`
    : "";

  const digestBlock = digest?.trim()
    ? `\n## Project digest (rolling architectural state summary)\n${digest.trim()}\n`
    : "";

  return `You are the Planner, re-invoked mid-run after a checkpoint review revealed that the ORIGINAL PLAN was wrong — not just an implementation gap, but a structural flaw in the plan that means the remaining uncommitted tickets were planned against wrong assumptions.

${jobLine}

## Original goal/prompt

${originalPrompt}

## Checkpoint findings (why the plan was wrong)

${findingsBlock}

## Current contracts index (ground truth — your revised tickets must reference these, not duplicate them)

${contractsSummary || "(no contracts yet)"}
${digestBlock}
## Committed tickets (FIXED — do not regenerate, do not renumber; build on these)

${committedBlock}
${replaceSection}
## Instructions

1. Read the findings carefully. They tell you WHY the original plan was wrong.
2. Read the committed tickets. They are your fixed context — the new tickets must build on what exists, not re-do it.
3. Read the contracts index. It is the ground-truth seam: your revised tickets must \`reference\` existing contracts, not re-declare them.
4. Generate a NEW set of tickets to replace the uncommitted frontier. These tickets:
   - Are numbered by the railhead — do NOT try to control their \`NN\` numbers; emit them in dependency order and let the railhead assign numbers.
   - Have \`blocked_by\` following the field semantics below, with ONE replan-specific rule: your emitted array contains ONLY the new tickets, so a \`blocked_by\` value is a position in the array you emit, NOT an absolute ticket number like "06" — and Do NOT list committed tickets there. Committed work is already committed, so commit order already satisfies any reference to its contracts (the gate exempts them), and a committed ticket has no position in your emitted array.
   - Account for the checkpoint findings — the structural flaw must be addressed by the revised plan, not ignored.
   - Must NOT duplicate work already committed.
5. Emit the same output format as the original planner: $TICKETS JSON array with the same ticket schema (title, mission, what, criteria, blocked_by[], files[], references[], introduces[], testable, group).

${TICKET_FIELD_SEMANTICS}

Do NOT emit $VERIFY, $SMOKE, $DESIGN, or $ARCHITECTURE blocks — those are already established from the original plan and committed work. Emit ONLY the $TICKETS block.

$TICKETS
[{"title":"...","mission":"the one-line goal of the whole build (the same on every ticket)","what":"...","criteria":["..."],"blocked_by":[],"files":["..."],"references":["..."],"introduces":["..."],"testable":true,"open_ended":false,"group":"..."}]`;
}

/** A replanned frontier's tickets must each carry the build's one-line mission
 * — plan.ts instructs the planner to stamp every ticket, so a single-ticket
 * worker sees where its work fits. The replan prompt's schema example omitted
 * the field, and the model followed the example: the platformer replan shipped
 * 15 missionless tickets, so from ticket 23 the builder was never re-given the
 * goal with its work. Backfill any blank mission from the run's existing one
 * (read from the committed tickets on disk). Pure; returns the input untouched
 * when no run mission is known. */
export function backfillMission(tickets: PlanTicket[], mission: string): PlanTicket[] {
  const m = mission.trim();
  if (!m) return tickets;
  return tickets.map((t) => (t.mission && t.mission.trim() ? t : { ...t, mission: m }));
}

export function meldReplannedTickets(
  state: RunState,
  newTickets: TicketState[],
): RunState {
  const preservedStatuses = new Set<TicketState["status"]>(["committed", "skipped", "failed"]);
  const preserved = state.tickets.filter((t) => preservedStatuses.has(t.status));
  return {
    ...state,
    tickets: [...preserved, ...newTickets],
  };
}

/** Translate a replan's ABSOLUTE-numbered `blocked_by` edges into the 0-based
 * array positions `orderTickets` expects. Only kicks in when the array actually
 * contains an absolute ticket number (a value at or past the array length that
 * maps into the new-ticket range `[startNumber, startNumber + n)`), so a
 * well-formed 0-based replan is returned unchanged and never reinterpreted.
 * Committed-ticket numbers are dropped: their work is committed, so commit
 * order already satisfies the reference (the gate exempts committed
 * introducers). Pure function. */
export function normalizeReplanBlockedBy(
  tickets: PlanTicket[],
  startNumber: number,
  committedNumbers: ReadonlySet<number>,
): PlanTicket[] {
  const n = tickets.length;
  const usesAbsoluteNumbers = tickets.some((t) =>
    t.blocked_by.some((b) => b >= n && b >= startNumber && b - startNumber < n),
  );
  if (!usesAbsoluteNumbers) return tickets;
  return tickets.map((t) => ({
    ...t,
    blocked_by: t.blocked_by.flatMap((b) => {
      if (committedNumbers.has(b)) return [];
      const asAbsolute = b - startNumber;
      if (asAbsolute >= 0 && asAbsolute < n) return [asAbsolute];
      if (b >= 0 && b < n) return [b];
      return [];
    }),
  }));
}

/** ADR 0045: `orderTickets` numbers a replan LOCALLY (01…, 02…) and returns
 * tickets whose `blocked_by` list those local file names. The run's frontier
 * uses global numbers (23…, 24…), so without this remap every dependency edge
 * in a regenerated frontier points at a file that does not exist — no ticket
 * is ever ready and the run stops as stuck (the platformer replan's exact
 * failure: ticket 24 blocked on "01-camera-…" while the file on disk was
 * "23-camera-…"). Returns the ordered tickets renumbered into the global
 * range, with `blocked_by` remapped to the global files. Pure. */
export function globalizeReplanTickets(ordered: Ticket[], startNumber: number): Ticket[] {
  const localToGlobal = new Map<string, string>();
  ordered.forEach((t, i) => {
    localToGlobal.set(t.file, `${String(startNumber + i).padStart(2, "0")}-${t.slug}.md`);
  });
  return ordered.map((t, i) => ({
    ...t,
    number: String(startNumber + i).padStart(2, "0"),
    file: localToGlobal.get(t.file)!,
    blocked_by: [...new Set(t.blocked_by.map((b) => localToGlobal.get(b) ?? b))],
  }));
}

/** Order a replan's ticket array, tolerating the misreading that has actually
 * aborted runs: the planner treats `blocked_by` as ABSOLUTE ticket numbers
 * ("06", "07"…) because the prompt told it to continue the committed
 * numbering, while `orderTickets` reads 0-based array positions. A value past
 * the array length then throws and — before this guard — escaped
 * `replanFromCheckpoint` uncaught, killing the whole run at the checkpoint.
 *
 * On that throw, translate absolute numbers to array positions and retry once.
 * Any remaining ordering failure is logged and the replan skipped, never fatal:
 * a bad replan must degrade to "keep the current frontier", not crash the run.
 * Returns null when the plan cannot be ordered under either reading. */
async function orderReplanTickets(
  planTickets: PlanTicket[],
  startNumber: number,
  state: RunState,
): Promise<Ticket[] | null> {
  try {
    return await orderTickets(planTickets);
  } catch (err) {
    const committedNumbers = new Set(
      state.tickets
        .filter((t) => t.status === "committed")
        .map((t) => Number.parseInt(t.number, 10))
        .filter((n) => Number.isFinite(n)),
    );
    const normalized = normalizeReplanBlockedBy(planTickets, startNumber, committedNumbers);
    if (normalized === planTickets) {
      console.log(`[${nowClock()}] replan: plan could not be ordered — ${describeOrderError(err)}; skipping`);
      return null;
    }
    try {
      const ordered = await orderTickets(normalized);
      console.log(`[${nowClock()}] replan: translated absolute blocked_by ticket numbers to array positions`);
      return ordered;
    } catch (retryErr) {
      console.log(`[${nowClock()}] replan: plan could not be ordered — ${describeOrderError(retryErr)}; skipping`);
      return null;
    }
  }
}

function describeOrderError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a checkpoint replan (issue #65 / #19): when the goal/structural
 * reviewer emitted `$REPLAN`, regenerate the uncommitted frontier with the
 * planner model. Returns true when the frontier was replaced. */
export async function replanFromCheckpoint(
  state: RunState,
  ledger: string,
  findings: string[],
  group: string,
  transcript: string,
): Promise<boolean> {
  // Issue #65: the reviewer's explicit $REPLAN marker is the authority — regex
  // keyword matching over finding prose is too fragile ("drift", "dead code",
  // "not wired" never matched). The regex classifier survives only as a
  // warning generator when findings LOOK structural but no marker was emitted.
  if (!parseReplanRequested(transcript)) {
    const classification = classifyFindings(findings);
    if (classification.replan) {
      console.warn(`[${nowClock()}] replan: findings look plan-level but the reviewer did not emit $REPLAN — falling back to corrective tickets (issue #65)`);
    } else {
      console.log(`[${nowClock()}] replan: ${classification.reason}; skipping`);
    }
    return false;
  }

  const planModel = state._models?.plan ?? null;
  if (!planModel) {
    console.log(`[${nowClock()}] replan: no planner model configured; skipping`);
    return false;
  }

  console.log(`[${nowClock()}] replan: reviewer emitted $REPLAN; regenerating uncommitted frontier for checkpoint "${group}"`);

  const contracts = await loadContracts(state.cwd);
  const contractsSummary = summarizeContracts(contracts);
  const digest = await readDigest(state.cwd);
  const designDoc = await git.readProjectDoc(state.cwd, "design");
  const architectureDoc = await git.readProjectDoc(state.cwd, "architecture");

  const committedTickets = state.tickets
    .filter((t) => t.status === "committed")
    .map((t) => ({ number: t.number, title: t.title, file: t.file }));
  const uncommittedTickets = state.tickets
    .filter((t) => t.status === "ready" || t.status === "in_progress")
    .map((t) => ({ number: t.number, title: t.title, file: t.file }));

  const prompt = buildReplanPrompt({
    originalPrompt: state.original_prompt ?? "",
    findings,
    contractsSummary,
    digest,
    committedTickets,
    uncommittedTickets,
  });

  const phaseFile = `replan-${group.replace(/[^a-z0-9-]/gi, "-")}`;
  await resetPhase(ledger, phaseFile);
  const result = await executeOpendCode(prompt, {
    cwd: state.cwd,
    ledgerDir: ledger,
    phaseFile,
    model: planModel,
    agent: null,
    live: !state.quiet,
    verbose: state.verbose,
    heartbeat: true,
    livePrefix: "replan",
    maxSteps: state.config.max_phase_steps,
    stallTimeoutSec: state.config.stall_timeout_sec,
    maxStepModelSec: state.config.max_step_model_sec,
    maxContextTokens: contextBudget(state),
  });

  if (result.status === "transient") {
    throw new Error(`replan: ${describeExecFailure(result)}`);
  }
  if (result.status !== "ok") {
    console.log(`[${nowClock()}] replan: agent ${describeExecFailure(result)}; skipping`);
    return false;
  }

  const replanTranscript = await extractPlanText(ledger, phaseFile);
  let planTickets: ReturnType<typeof parsePlanJson>;
  try {
    planTickets = parsePlanJson(replanTranscript);
  } catch (err) {
    console.log(`[${nowClock()}] replan: failed to parse tickets: ${String(err)}; skipping`);
    return false;
  }

  // ADR 0035: the same repeat collapse the plan gate runs — a replanning model
  // under checkpoint pressure double-emits tickets exactly like the planner,
  // and the repeat's duplicate findings would discard the whole replan.
  const collapsed = collapseRepeatedTickets(planTickets);
  if (collapsed.dropped.length > 0) {
    planTickets = collapsed.tickets;
    console.log(`[${nowClock()}] replan: dropped ${collapsed.dropped.length} repeated ticket emission(s) (${collapsed.dropped.map((d) => `"${d.title}"`).join(", ")}) — identical to an earlier ticket (ADR 0035)`);
  }

  if (planTickets.length === 0) {
    console.log(`[${nowClock()}] replan: planner produced no tickets; skipping`);
    return false;
  }

  // The replan model follows the prompt's example, which historically omitted
  // `mission`; stamp the run's mission onto any ticket it left blank so the
  // builder is never handed goal-less work (see backfillMission).
  const existingTickets = await loadTickets(state.tickets_dir).catch(() => [] as Ticket[]);
  const runMission = existingTickets.find((t) => t.mission.trim())?.mission ?? "";
  planTickets = backfillMission(planTickets, runMission);

  const startNumber = nextTicketNumber(state);
  const ordered = await orderReplanTickets(planTickets, startNumber, state);
  if (!ordered) return false;
  // Issue #86: replan output is plan-time-shaped — it goes through the same
  // gate escalation as any plan. Un-ruled class-A findings discard the replan
  // (the defective ticket set must not replace the frontier); class-B prints.
  // Issue #103: revised tickets legitimately reference committed contracts —
  // the contracts index is that existing-symbol universe, so not dangling.
  const replanConflicts = scanOrderedConflicts(
    ordered,
    { existingSymbols: knownContractSymbols(contracts) },
  );
  if (await reportConflicts(replanConflicts, { ledger, appendEvent })) {
    console.log(`[${nowClock()}] replan: conflict scan found hard errors; skipping`);
    return false;
  }
  const replanRuled = new Set((state.plan_rulings ?? []).map((r) => r.key));
  const replanClassA = replanConflicts.classA.filter((f) => !replanRuled.has(f.key));
  if (replanClassA.length > 0) {
    console.log(`[${nowClock()}] replan: ${replanClassA.length} un-ruled class-A finding(s) — skipping (${replanClassA.map((f) => f.message).join("; ")})`);
    return false;
  }

  const globalized = globalizeReplanTickets(ordered, startNumber);
  const newTicketStates: TicketState[] = globalized.map(toTicketState);

  await mkdir(state.tickets_dir, { recursive: true });
  for (let i = 0; i < globalized.length; i++) {
    await writeFile(join(state.tickets_dir, newTicketStates[i].file), renderTicket(globalized[i]), "utf8");
  }

  const oldUncommittedFiles = state.tickets
    .filter((t) => t.status === "ready" || t.status === "in_progress")
    .map((t) => t.file);
  for (const f of oldUncommittedFiles) {
    await rm(join(state.tickets_dir, f), { force: true });
  }

  const newState = meldReplannedTickets(state, newTicketStates);
  state.tickets = newState.tickets;
  await writeState(ledger, state);

  console.log(`[${nowClock()}] replan: regenerated ${newTicketStates.length} ticket(s) replacing ${oldUncommittedFiles.length} old ticket(s)`);
  return true;
}

/** After a run-end replan regenerates a frontier there is no build loop left
 * to process it (the run-end passes sit after the per-ticket loop). Drain the
 * ready frontier inline in dependency order — `frontier()` returns only ready
 * tickets whose blockers are committed — running each through the injected
 * `runTicket` (processTicket) exactly as the build loop would. Pure with respect
 * to status/ledger: returns true when the frontier drains to empty, false on
 * the first failed ticket; the CALLER owns the status flip and state write. */
export async function drainFrontier(
  state: RunState,
  ledger: string,
  runTicket: RunTicket,
): Promise<boolean> {
  for (;;) {
    const next = frontier(state)[0];
    if (!next) return true;
    const outcome = await runTicket(state, ledger, next);
    if (outcome === "failed") return false;
    if (outcome === "halted") return false;
  }
}
