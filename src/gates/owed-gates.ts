import type { RunState } from "../core/state.ts";
import { writeState } from "../core/ledger.ts";
import { loadTickets } from "../core/ticket.ts";
import { nowClock } from "../cli/overview.ts";
import { firesMidRun, goalFiresCheckpointsMidRun } from "../config/config.ts";
import { kickoffPerTicketVisualReview, joinPendingVisualReview } from "./visual-loop.ts";
import { runGoalReview } from "./goal-loop.ts";
import { runStructuralReview } from "./structural-loop.ts";
import { clearPendingCheckpoint, owedCheckpointGroups, type CheckpointGate, type OwedCheckpoints } from "../core/pending-checkpoints.ts";
import { isSoftStopRequested } from "../execute/stop.ts";
import type { RunTicket } from "./corrective.ts";

/**
 * Resume-owed gate replay (gh: graceful stop).
 *
 * A ticket is marked committed BEFORE its post-commit work runs — the
 * per-ticket visual review (ADR 0011) and the group checkpoint gates
 * (goal/structural). That ordering is deliberate (an interrupt must never lose
 * a finished ticket), but it opens a window: stop between the commit and a
 * gate's completion and resume sees the ticket committed, picks the next one,
 * and the gate is never heard from again — checkpoint detection only inspects
 * the ticket that just committed, and the visual promise is process-local.
 *
 * The fix is a persisted marker per owed gate, set before the gate runs and
 * cleared once it lands (visual-loop.ts, goal-loop.ts, structural-loop.ts).
 * `drainOwedGates` replays whatever a stop left behind, before the frontier
 * stacks more work on top (ADR 0006). The gates' own records stay the
 * authoritative dedup: a group that recorded is dropped even if its marker
 * survived a crash between record and clear.
 */

/**
 * Replay the gates a stopped/crashed run left owed. Order mirrors the ticket
 * boundary: the per-ticket visual review first (its [BLOCKER]s generate
 * corrective tickets that must land before anything else commits, ADR 0006),
 * then structural, then goal (cheap-first fail-fast, gh #107-C2).
 *
 * Returns "fail" when a replay's corrective ticket failed; the caller applies
 * the ordinary failure status (the halt file, when present, is the caller's to
 * check — the corrective pipeline reports a halt the same way).
 */
export async function drainOwedGates(
  state: RunState,
  ledger: string,
  runTicket: RunTicket,
): Promise<"pass" | "fail"> {
  // A soft stop armed while the drain runs cuts it short: the markers stay
  // owed, the frontier's boundary check stops the run at once, and the next
  // resume replays the remainder. Without this the operator's first Ctrl-C on
  // a just-resumed run could wait out a whole checkpoint gate.
  if (isSoftStopRequested()) return "pass";
  const visual = await drainPendingVisualReview(state, ledger, runTicket);
  if (visual === "fail") return "fail";

  const goalModel = state._models?.goal ?? null;
  const structuralCfg = state.config.structural_review;
  const structuralOwed = owedCheckpointGroups(
    state,
    "structural",
    !!structuralCfg && firesMidRun(structuralCfg.mode) && goalModel !== null,
    (state.structural_reviews ?? []).map((r) => r.group),
  );
  if (await drainCheckpoints(state, ledger, "structural", structuralOwed, runTicket)) return "fail";

  const goalCfg = state.config.goal_review;
  const goalOwed = owedCheckpointGroups(
    state,
    "goal",
    !!goalCfg && goalFiresCheckpointsMidRun(goalCfg) && goalModel !== null,
    (state.goal_reviews ?? []).map((r) => r.group),
  );
  if (await drainCheckpoints(state, ledger, "goal", goalOwed, runTicket)) return "fail";

  return "pass";
}

/** Re-run one committed ticket's visual review that a stop left unjoined. The
 * marker is cleared when the gate no longer applies (mode/model changed,
 * ticket not reviewable); the review itself reuses the ordinary kickoff+join
 * so corrective handling is byte-identical to the pipeline's. */
async function drainPendingVisualReview(
  state: RunState,
  ledger: string,
  runTicket: RunTicket,
): Promise<"pass" | "fail"> {
  const file = state.visual_pending;
  if (!file) return "pass";
  const ticket = state.tickets.find((t) => t.file === file);
  const parsed = ticket ? (await loadTickets(state.tickets_dir).catch(() => [])).find((t) => t.file === file) : undefined;
  if (!ticket || ticket.status !== "committed" || !parsed) {
    state.visual_pending = null;
    await writeState(ledger, state);
    return "pass";
  }
  console.log(`\n[${nowClock()}] resume: re-running the per-ticket visual review owed for ${ticket.number} (the prior run stopped before joining it)`);
  const pending = kickoffPerTicketVisualReview(state, ledger, ticket, parsed, { replay: true });
  if (!pending) {
    state.visual_pending = null;
    await writeState(ledger, state);
    return "pass";
  }
  state._pending_visual_review = pending;
  await writeState(ledger, state);
  return joinPendingVisualReview(state, ledger, runTicket);
}

async function drainCheckpoints(
  state: RunState,
  ledger: string,
  gate: CheckpointGate,
  owed: OwedCheckpoints,
  runTicket: RunTicket,
): Promise<boolean> {
  for (const group of owed.drop) clearPendingCheckpoint(state, gate, group);
  if (owed.drop.length > 0) await writeState(ledger, state);
  for (const group of owed.run) {
    if (isSoftStopRequested()) return false;
    console.log(`\n[${nowClock()}] resume: taking the ${gate} checkpoint "${group}" that was owed (the prior run stopped after its tickets committed)`);
    const outcome = gate === "structural"
      ? await runStructuralReview(state, ledger, group, runTicket)
      : await runGoalReview(state, ledger, group, runTicket);
    clearPendingCheckpoint(state, gate, group);
    await writeState(ledger, state);
    if (outcome === "fail") return true;
  }
  return false;
}
