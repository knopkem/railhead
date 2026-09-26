import type { RunState, StructuralReviewRecord, TicketState } from "../core/state.ts";
import { isFinished } from "../core/state.ts";
import { loadTickets } from "../core/ticket.ts";
import { join } from "node:path";
import { seatContextBudget, firesMidRun } from "../config/config.ts";
import { reviewSummary, runReviewAgent } from "./reviewer.ts";
import { baseSessionId } from "../execute/base-session.ts";
import { processCorrectiveFindings, type RunTicket } from "./corrective.ts";
import { replanFromCheckpoint, drainFrontier } from "./replan.ts";
import { buildStructuralReviewPrompt, parseStructuralVerdict } from "./structural-review.ts";
import { pushDigest, readDigest } from "../context/digest.ts";
import { readLearnings } from "../context/learnings.ts";
import { loadContracts, summarizeContracts } from "../core/contracts.ts";
import * as git from "../core/git.ts";
import { nowClock } from "../cli/overview.ts";
import { writeState } from "../core/ledger.ts";
import { detectGroupCheckpoints } from "./goal-loop.ts";
import { addPendingCheckpoint, clearPendingCheckpoint } from "../core/pending-checkpoints.ts";
import { RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";

/** The structural gate's unreviewed reached checkpoints — `structural_reviews`
 * is its own dedup set, so goal firing first (or at all) no longer suppresses
 * it (gh #107-C2). */
export function structuralCheckpointsToFire(state: RunState, ticket: TicketState): string[] {
  return detectGroupCheckpoints(state, ticket, (state.structural_reviews ?? []).map((r) => r.group));
}

/** Same cadence semantics as the goal gate (ADR 0021): the structural review
 * fires at group checkpoints under `full`/`medium`; `light` defers it to run
 * end, `off` disables it. Returns "fail" only when a refactor ticket the
 * review generated fails to commit. */
export async function structuralReviewAtCheckpoint(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  runTicket: RunTicket,
): Promise<"pass" | "fail"> {
  const cfg = state.config.structural_review;
  if (!cfg || !firesMidRun(cfg.mode)) return "pass";
  const goalModel = state._models?.goal ?? null;
  if (!goalModel) return "pass";

  const checkpoints = structuralCheckpointsToFire(state, ticket);
  if (checkpoints.length === 0) return "pass";

  for (const group of checkpoints) {
    // gh: persist the owed marker BEFORE spawning the review agent (same
    // post-commit window as the goal gate — see pending-checkpoints.ts).
    addPendingCheckpoint(state, "structural", group);
    await writeState(ledger, state);
    const outcome = await runStructuralReview(state, ledger, group, runTicket);
    clearPendingCheckpoint(state, "structural", group);
    await writeState(ledger, state);
    if (outcome === "fail") return "fail";
  }
  return "pass";
}

/** Run a single structural-review checkpoint (or, with `runEnd`, the issue #73
 * end-of-run pass). Spawns a fresh opencode process with the goal model,
 * builds the prompt from architecture.md + cumulative contracts, parses the
 * verdict, and on FAIL generates refactor tickets that block all uncommitted
 * tickets (preserving group coherence), then processes them through the full
 * pipeline. Mirrors `runGoalReview`: pass returns, inconclusive returns (no
 * refactor tickets, honest status), fail with [BLOCKER]s generates and
 * processes refactor tickets inline. */
export async function runStructuralReview(
  state: RunState,
  ledger: string,
  group: string,
  runTicket: RunTicket,
  opts?: { runEnd?: boolean },
): Promise<"pass" | "fail"> {
  const cfg = state.config.structural_review;
  if (!cfg || !firesMidRun(cfg.mode) && !opts?.runEnd) return "pass";
  const goalModel = state._models?.goal ?? null;
  if (!goalModel) return "pass";

  console.log(`\n[${nowClock()}] structural review — checkpoint "${group}"`);

  const allTickets = await loadTickets(state.tickets_dir);
  const mission = state.original_prompt ?? "(no mission declared)";
  const architectureDoc = await git.readProjectDoc(state.cwd, join(state.docs_dir, "architecture.md"));
  const contractsIndex = await loadContracts(state.cwd);
  const contractsSummary = summarizeContracts(contractsIndex);

  const completedGroups = (state.goal_reviews ?? []).map((r) => r.group);
  const priorFindings = (state.goal_reviews ?? []).flatMap((r) => r.findings);

  const prompt = buildStructuralReviewPrompt({
    originalPrompt: state.original_prompt ?? "(no mission declared)",
    architectureDoc,
    contractsSummary,
    verifyCommands: state.config.verify,
    group,
    completedGroups,
    priorFindings,
    learnings: await readLearnings(state.cwd),
    digest: await readDigest(state.cwd),
  });

  const phaseFile = `structural-${group.replace(/[^a-z0-9-]/gi, "-")}`;
  const agentOutcome = await runReviewAgent({
    label: "structural review",
    prompt,
    cwd: state.cwd,
    ledgerDir: ledger,
    phaseFile,
    model: goalModel,
    agent: RAILHEAD_AGENT_NAMES.observe,
    baseSession: baseSessionId(state),
    live: !state.quiet,
    verbose: state.verbose,
    heartbeat: true,
    livePrefix: "structural",
    maxSteps: state.config.max_phase_steps,
    stallTimeoutSec: state.config.stall_timeout_sec,
    maxStepModelSec: state.config.max_step_model_sec,
    maxContextTokens: seatContextBudget(state, "goal"),
  });
  if (agentOutcome.status === "fatal") {
    const message = `structural review unavailable — ${agentOutcome.detail}`;
    console.log(`[${nowClock()}] ${message}; marking the run ${state.pause_on_failure ? "stopped" : "failed"}`);
    recordStructuralReview(state, { group, verdict: "inconclusive", findings: [message] });
    state.status = state.pause_on_failure ? "stopped" : "failed";
    await writeState(ledger, state);
    return "fail";
  }
  if (agentOutcome.status !== "ok") {
    console.log(`[${nowClock()}] structural review: agent ${agentOutcome.detail}; inconclusive`);
    recordStructuralReview(state, { group, verdict: "inconclusive", findings: [] });
    await writeState(ledger, state);
    return "pass";
  }

  const transcript = agentOutcome.transcript;
  await pushDigest(state.cwd, transcript, group);

  const verdict = parseStructuralVerdict(transcript);
  // Record before any corrective/replan handling, mirroring the goal gate: the
  // checkpoint's own record is what stops a resume from re-running it.
  recordStructuralReview(state, { group, verdict: verdict.verdict, findings: verdict.findings });
  await writeState(ledger, state);

  if (verdict.verdict === "pass") {
    console.log(`[${nowClock()}] structural review ✓ PASS (checkpoint "${group}")`);
    return "pass";
  }
  if (verdict.verdict === "inconclusive") {
    console.log(`[${nowClock()}] structural review ⚠ INCONCLUSIVE (checkpoint "${group}")`);
    return "pass";
  }

  let structuralReplanTriggered = false;
  let structuralReplanFailed = false;
  const outcome = await processCorrectiveFindings(state, ledger, verdict.findings, {
    kind: "structural",
    label: `structural review (checkpoint "${group}")`,
    runTicket,
    beforeCorrectives: async () => {
      structuralReplanTriggered = await replanFromCheckpoint(state, ledger, verdict.findings, group, transcript);
      // Run-end replan has no build loop left — drain the regenerated frontier
      // inline; a failed drain flips status and surfaces as a gate failure.
      if (structuralReplanTriggered && opts?.runEnd) {
        const drained = await drainFrontier(state, ledger, runTicket);
        if (!drained) {
          if (!isFinished(state.status)) {
            state.status = state.pause_on_failure ? "stopped" : "failed";
          }
          await writeState(ledger, state);
          structuralReplanFailed = true;
        }
      }
      return structuralReplanTriggered;
    },
  });
  if (structuralReplanTriggered) {
    if (structuralReplanFailed) {
      console.log(`[${nowClock()}] structural review: replanned ticket failed at run-end; stopping`);
      return "fail";
    }
    console.log(`[${nowClock()}] structural review: replan triggered for checkpoint "${group}"; refactor tickets superseded by regenerated frontier`);
    return "pass";
  }
  if (outcome === "none") {
    console.log(`[${nowClock()}] structural review ⚠ FAIL with no [BLOCKER] — soft-pass; ${reviewSummary(verdict.findings)} noted`);
    return "pass";
  }
  if (outcome === "halted") {
    console.log(`[${nowClock()}] structural review: halted by an agent-initiated stop signal; stopping`);
    return "fail";
  }
  if (outcome === "failed") {
    console.log(`[${nowClock()}] structural review: refactor ticket failed; stopping`);
    return "fail";
  }
  console.log(`[${nowClock()}] structural review: refactor ticket(s) committed for checkpoint "${group}"; PASS`);
  return "pass";
}

function recordStructuralReview(state: RunState, record: StructuralReviewRecord): void {
  if (!state.structural_reviews) state.structural_reviews = [];
  state.structural_reviews.push(record);
}
