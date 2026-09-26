import { frontier, type TicketState, type RunState } from "../core/state.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseReplanRequested } from "./goal-review.ts";
import { nextTicketNumber, type RunTicket } from "./corrective.ts";
import { parsePlanJson } from "../plan/plan.ts";
import { numberTickets, toTicketState, renderTicket, type PlanTicket } from "../core/ticket.ts";
import { resetPhase, writeState, extractPlanText } from "../core/ledger.ts";
import { describeExecFailure, executeOpendCode } from "../execute/executor.ts";
import { seatContextBudget } from "../config/config.ts";
import { loadContracts, summarizeContracts } from "../core/contracts.ts";
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

## Current contracts index (ground truth)

${contractsSummary || "(no contracts yet)"}
${digestBlock}
## Committed tickets (FIXED — do not regenerate, do not renumber; build on these)

${committedBlock}
${replaceSection}
## Instructions

1. Read the findings carefully. They tell you WHY the original plan was wrong.
2. Read the committed tickets. They are your fixed context — the new tickets must build on what exists, not re-do it.
3. Generate a NEW set of tickets to replace the uncommitted frontier. These tickets:
   - Are numbered by the railhead — do NOT try to control their \`NN\` numbers; emit them in the order they must run.
   - Account for the checkpoint findings — the structural flaw must be addressed by the revised plan, not ignored.
   - Must NOT duplicate work already committed.
4. Emit the same ticket shape as the original planner: each ticket has "title", "what" (the end-to-end behaviour, naming the files/modules it touches in prose), "criteria" (concrete checkable bullets), and optionally "group" / "open_ended". Tickets run STRICTLY in the order emitted: order the array so every prerequisite comes before the ticket that needs it.

Do NOT emit $VERIFY, $SMOKE, $DESIGN, or $ARCHITECTURE blocks — those are already established from the original plan and committed work. Emit ONLY the $TICKETS block.

$TICKETS
[{"title":"...","what":"...","criteria":["..."],"group":"...","open_ended":false}]`;
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
  const designDoc = await git.readProjectDoc(state.cwd, join(state.docs_dir, "design.md"));
  const architectureDoc = await git.readProjectDoc(state.cwd, join(state.docs_dir, "architecture.md"));

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
    maxContextTokens: seatContextBudget(state, "plan"),
  });

  if (result.status === "transient") {
    throw new Error(`replan: ${describeExecFailure(result)}`);
  }
  if (result.status !== "ok") {
    console.log(`[${nowClock()}] replan: agent ${describeExecFailure(result)}; skipping`);
    return false;
  }

  const replanTranscript = await extractPlanText(ledger, phaseFile);
  let planTickets: PlanTicket[];
  try {
    planTickets = parsePlanJson(replanTranscript).tickets;
  } catch (err) {
    console.log(`[${nowClock()}] replan: failed to parse tickets: ${String(err)}; skipping`);
    return false;
  }

  if (planTickets.length === 0) {
    console.log(`[${nowClock()}] replan: planner produced no tickets; skipping`);
    return false;
  }
  const blank = planTickets.filter((t) => !t.what?.trim());
  if (blank.length > 0) {
    console.log(`[${nowClock()}] replan: ${blank.length} ticket(s) missing a "what" body — skipping`);
    return false;
  }

  // Number the regenerated frontier into the run's global sequence. Tickets run
  // strictly in array order, so no dependency remapping is needed.
  const ordered = numberTickets(planTickets, nextTicketNumber(state));
  const newTicketStates: TicketState[] = ordered.map(toTicketState);

  await mkdir(state.tickets_dir, { recursive: true });
  for (let i = 0; i < ordered.length; i++) {
    await writeFile(join(state.tickets_dir, newTicketStates[i].file), renderTicket(ordered[i]), "utf8");
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
