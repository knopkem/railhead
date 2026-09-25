import type { RunState, RunStatus, TicketState } from "./state.ts";

/**
 * Resume/recovery for an interrupted Run, co-located with the Ledger it reads
 * and mutates. The state transitions are pure; git side effects stay in the
 * thin orchestration shell. The one safety invariant this encodes — the
 * in-flight checkpoint MUST land before the reset, or resetHard silently
 * destroys uncommitted work — is expressed as a typed, ordered step list, so
 * reordering shows up as a change to the shell's `switch`, not a silent
 * behaviour shift.
 */

export type RecoveryAction =
  | { kind: "checkpoint"; ticket: TicketState }
  | { kind: "reset" }
  | { kind: "rebase" };

/**
 * The ordered steps a resume must apply, checkpoint (if any) before reset.
 * Returns the same step list the shell switches over; nothing side-effecting
 * lives here.
 */
export function planRecovery(inFlight: TicketState | null): RecoveryAction[] {
  const steps: RecoveryAction[] = [];
  if (inFlight) steps.push({ kind: "checkpoint", ticket: inFlight });
  steps.push({ kind: "reset" });
  steps.push({ kind: "rebase" });
  return steps;
}

/**
 * Mark Tickets whose commit already landed in git (their message exists) as
 * `committed`, even though the state write that recorded it was interrupted.
 * `commitFor` returns the commit hash when the ticket's message exists in
 * history, else undefined.
 */
export function reconcileCommittedButUnsaved(
  state: RunState,
  commitFor: (t: TicketState) => string | undefined,
): RunState {
  return {
    ...state,
    tickets: state.tickets.map((t) => {
      if ((t.status === "in_progress" || t.status === "ready") && commitFor(t)) {
        return { ...t, status: "committed", commit: commitFor(t)!, reviews: [] };
      }
      return t;
    }),
  };
}

/** Mark a Ticket committed with a known commit after a checkpoint landed. */
export function markCommitted(state: RunState, file: string, commit: string): RunState {
  return {
    ...state,
    tickets: state.tickets.map((t) =>
      t.file === file ? { ...t, status: "committed", commit, reviews: [] } : t,
    ),
  };
}

/**
 * Demote an interrupted `in_progress` Ticket back to `ready` and reset its
 * per-ticket counters, so the next loop pass re-runs it from a clean slate.
 */
export function rebaseFrontier(state: RunState): RunState {
  return {
    ...state,
    tickets: state.tickets.map((t) =>
      t.status === "in_progress"
        ? {
            ...t,
            status: "ready" as const,
            attempts: 0,
            verify_ok: null,
            review_ok: null,
            review_attempts: 0,
            reviews: [],
          }
        : t,
    ),
  };
}

/**
 * Terminal status for a Run whose frontier is empty (no `ready` ticket to
 * pick up next). Three honest outcomes:
 *   - every ticket committed  -> `finished`
 *   - any ticket failed        -> `stopped` (the run halted on a real failure)
 *   - otherwise                -> `stopped` (interrupted bracket: a ticket is
 *                                    still in_progress / skipped, but the
 *                                    loop can't make progress on it)
 *
 * The third case used to leave the run as `running` on disk forever — the
 * snake-qwen resume tripped it: 02 was stuck `in_progress` (its recovery had
 * been written to disk then clobbered by the stale-state pass), so the loop
 * exited without transitioning it and without ever marking the run stopped.
 * Returning `stopped` here surfaces the interrupt instead of hiding it.
 */
export function nextRunStatus(state: RunState): RunStatus {
  const allCommitted = state.tickets.every((t) => t.status === "committed");
  if (allCommitted) return "finished";
  return "stopped";
}

/**
 * Gate for auto-resume: returns true when a prior run on the same branch
 * was interrupted (status `running` or `stopped`) and should be resumed
 * rather than discarded. A `finished` or `failed` run is left alone.
 */
export function shouldResume(
  branch: string,
  priorState: RunState | null,
): priorState is RunState {
  if (!priorState) return false;
  if (priorState.branch !== branch) return false;
  return priorState.status === "running" || priorState.status === "stopped";
}

export interface DivergedTicket {
  file: string;
  problem: "missing_on_disk" | "missing_in_state" | "title_mismatch";
  stateTitle?: string;
  diskTitle?: string;
}

/**
 * Check that every ticket in `stateTickets` has a matching file on disk and
 * vice versa. Returns a list of divergences; an empty list means the
 * invariant holds.
 *
 * - `missing_on_disk`: state.json references a ticket file that no longer
 *   exists (e.g., purged by a mid-run bug). This is a hard error at the
 *   call site — the run cannot proceed without re-planning.
 * - `missing_in_state`: a ticket file exists on disk that state.json
 *   doesn't list (e.g., added by a re-plan). The call site can add it as
 *   a new `ready` entry.
 * - `title_mismatch`: same file, different title — may indicate a stale
 *   plan vs a re-plan. Warning only.
 */
export function checkTicketInvariants(
  stateTickets: { file: string; title: string }[],
  diskTickets: { file: string; title: string }[],
): DivergedTicket[] {
  const stateMap = new Map(stateTickets.map((t) => [t.file, t.title]));
  const diskMap = new Map(diskTickets.map((t) => [t.file, t.title]));
  const diverged: DivergedTicket[] = [];

  for (const [file, stateTitle] of stateMap) {
    const diskTitle = diskMap.get(file);
    if (diskTitle === undefined) {
      diverged.push({ file, problem: "missing_on_disk", stateTitle });
    } else if (diskTitle !== stateTitle) {
      diverged.push({ file, problem: "title_mismatch", stateTitle, diskTitle });
    }
  }

  for (const [file, diskTitle] of diskMap) {
    if (!stateMap.has(file)) {
      diverged.push({ file, problem: "missing_in_state", diskTitle });
    }
  }

  return diverged;
}