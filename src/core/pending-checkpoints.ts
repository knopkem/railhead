import type { RunState } from "./state.ts";

/**
 * The pending-checkpoint markers (gh: graceful stop). Pure state arithmetic —
 * kept out of owed-gates.ts so the checkpoint gates (goal-loop,
 * structural-loop) can import it without a module cycle back through the
 * replay orchestration.
 *
 * A ticket is marked committed before its group checkpoint gates run; the
 * marker is set in the commit's own state write (and again before the gate's
 * review agent is spawned) and cleared once the gate returns, so a stop in
 * that window lets resume replay the checkpoint instead of skipping it.
 */

export type CheckpointGate = "goal" | "structural";

/** The pending group set for one checkpoint gate (never undefined — state
 * normalization guarantees the arrays exist). */
export function pendingCheckpointGroups(state: RunState, gate: CheckpointGate): string[] {
  return [...(state.pending_checkpoints?.[gate] ?? [])];
}

/** Record a group's checkpoint as owed. */
export function addPendingCheckpoint(state: RunState, gate: CheckpointGate, group: string): void {
  if (!state.pending_checkpoints) state.pending_checkpoints = { goal: [], structural: [] };
  if (!state.pending_checkpoints[gate].includes(group)) state.pending_checkpoints[gate].push(group);
}

/** Drop a group's checkpoint marker once its gate returned (pass or fail —
 * the gate's record, when it recorded, is the dedup from then on). */
export function clearPendingCheckpoint(state: RunState, gate: CheckpointGate, group: string): void {
  if (!state.pending_checkpoints) return;
  state.pending_checkpoints[gate] = state.pending_checkpoints[gate].filter((g) => g !== group);
}

export interface OwedCheckpoints {
  /** Groups whose gate must still run. */
  run: string[];
  /** Pending groups the resume drops: the gate already recorded them, or the
   * gate can no longer fire mid-run (mode/model changed since the stop). */
  drop: string[];
}

/** Split a gate's pending groups into "run now" and "drop". Pure: the recorded
 * set is the gate's own review records — a recorded group is done even if its
 * marker survived a crash between record and clear. */
export function owedCheckpointGroups(
  state: RunState,
  gate: CheckpointGate,
  gateCanFire: boolean,
  recordedGroups: Iterable<string>,
): OwedCheckpoints {
  const recorded = new Set(recordedGroups);
  const pending = pendingCheckpointGroups(state, gate);
  const run: string[] = [];
  const drop: string[] = [];
  for (const group of pending) {
    if (gateCanFire && !recorded.has(group)) run.push(group);
    else drop.push(group);
  }
  return { run, drop };
}
