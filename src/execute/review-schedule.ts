import type { CodeReviewTrigger } from "../config/config.ts";

/**
 * The smart review trigger (code_review.trigger: "smart"): spend the
 * per-ticket code review where the build showed context stress or an unusual
 * event, instead of on every ticket. Compaction is the primary signal — a
 * durable-session builder that compacts lost the design/contracts context it
 * was holding, so its next diff is exactly the artifact a fresh reader should
 * check — but it is deliberately not the only one: a retried build, a session
 * restart, a spec reconciliation, a `$BLOCKED`/unverified exit, and a replan
 * are all "this diff may not be the clean output it looks like" signals.
 *
 * Pure by design: every signal is persisted telemetry the caller already
 * holds, so the decision is reproducible on resume and unit-testable at each
 * boundary. A skipped review is NEVER a pass (ADR 0050): the run loop records
 * the reason on TicketState and leaves review_ok null.
 */
export interface ReviewStressInput {
  /** The resolved `code_review.trigger`. `always` short-circuits to a run. */
  trigger: CodeReviewTrigger;
  /** Merged compaction count across EVERY build-phase file of this ticket
   * (`summarizePhaseFiles`), not just the final successful attempt — a
   * durable-session compaction usually lands in the attempt that exits
   * without a checkpoint marker. */
  compactions: number;
  /** Build attempts this ticket has needed, including attempts persisted
   * before a resume. */
  attempts: number;
  /** Fresh-session builder restarts recorded during this ticket. */
  restarts: number;
  /** ADR 0032: the ticket's one spec-anchored reconciliation was spent. */
  reconciled: boolean;
  /** ADR 0040: a terminal `$BLOCKED` report was recorded. */
  blocked: boolean;
  /** ADR 0040: criteria the builder could not verify with its own tools. */
  unverified: boolean;
  /** A replan/capacity split regenerated the frontier since the last review
   * decision (armed where `state.replan_count`/`state.capacity_replans`
   * increment). */
  replanArmed: boolean;
}

export interface ReviewSchedule {
  run: boolean;
  /** Why the review fires (the stress reasons), or `"no stress"` when it is
   * skipped. Recorded on the ticket so a skipped gate never reads as green. */
  reason: string;
}

/** Decide whether this ticket's per-ticket code review is due. */
export function codeReviewSchedule(input: ReviewStressInput): ReviewSchedule {
  if (input.trigger === "always") return { run: true, reason: "trigger always" };
  const reasons: string[] = [];
  if (input.compactions > 0) reasons.push(`${input.compactions} compaction${input.compactions === 1 ? "" : "s"}`);
  if (input.attempts > 1) reasons.push(`${input.attempts} build attempts`);
  if (input.restarts > 0) reasons.push(`builder session restarted ${input.restarts}x`);
  if (input.reconciled) reasons.push("spec reconciliation ran");
  if (input.blocked) reasons.push("$BLOCKED recorded");
  if (input.unverified) reasons.push("unverified criteria recorded");
  if (input.replanArmed) reasons.push("plan re-scoped");
  return reasons.length > 0
    ? { run: true, reason: reasons.join("; ") }
    : { run: false, reason: "no stress" };
}
