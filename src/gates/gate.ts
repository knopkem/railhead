/**
 * The Gate's retry-budget machine (pure). Given what just happened to a Ticket
 * — a verify failure, a blocking review's findings, or a review pass — it
 * decides the next Gate step and the new counters, and returns the feedback the
 * next Implementer should hear. Everything the orchestration shell must do
 * follows from the returned `GateStep`; nothing is decided outside here.
 *
 * The invariant this holds: a blocking review whose findings are all NEW (none
 * of them repeats a prior round) means the ticket genuinely improved, so the
 * retry budget is reset — a chain of distinct, actually-fixed findings must not
 * exhaust a small model's budget. Only a REGRESSING review (a repeated finding)
 * or a verify failure burns the budget.
 *
 * Issue #70: that reset is bounded. A fresh-context implementer cannot
 * remember what it already tried, so "a different bug each attempt" is the
 * normal small-model failure mode — not proof of progress. `reviewRounds`
 * counts every blocking-review round and NEVER resets, so a chain of distinct
 * findings can spin at most `reviewBudget` rounds before the ticket fails
 * instead of running to the hard attempt cap.
 */
export interface GateCounters {
  /** Verify failures + regressing reviews since the last genuine improvement. */
  unproductive: number;
  /** Consecutive regressing blocking reviews against this ticket. */
  reviewFailures: number;
  /** Total blocking-review rounds against this ticket, never reset (issue #70). */
  reviewRounds: number;
}

/** What just happened to the Ticket — produced by the orchestration shell. */
export type GateEvent =
  | { type: "verify_failed"; output: string }
  | { type: "review_blocking"; findings: string[]; priorFindings: string[] }
  | { type: "review_passed" };

export type GateStep =
  | { next: "implement"; feedback: string }
  | { next: "commit" }
  | { next: "fail"; reason: "retries" | "review_budget"; feedback: string };

export interface GateLimits {
  maxRetries: number;
  reviewBudget: number;
}

export const INITIAL_COUNTERS: GateCounters = { unproductive: 0, reviewFailures: 0, reviewRounds: 0 };

export function advanceRetry(
  counters: GateCounters,
  event: GateEvent,
  limits: GateLimits,
): { step: GateStep; counters: GateCounters } {
  switch (event.type) {
    case "verify_failed":
      return {
        step: {
          next: "implement",
          feedback: `Verification failed. Output:\n${event.output}`,
        },
        counters: { ...counters, unproductive: counters.unproductive + 1 },
      };

    case "review_passed":
      return { step: { next: "commit" }, counters };

    case "review_blocking":
      return onBlockingReview(counters, event, limits);
  }
}

function onBlockingReview(
  counters: GateCounters,
  event: Extract<GateEvent, { type: "review_blocking" }>,
  limits: GateLimits,
): { step: GateStep; counters: GateCounters } {
  const distinct = event.findings.every((f) => !event.priorFindings.includes(f));
  // Issue #70: `reviewRounds` never resets — a distinct-finding chain can only
  // spin for `reviewBudget` rounds before the ticket fails, even though each
  // round "improved" (a fresh-context implementer re-converges on new bugs).
  const reviewRounds = counters.reviewRounds + 1;
  const next: GateCounters = distinct
    ? { unproductive: 0, reviewFailures: 0, reviewRounds }
    : {
        unproductive: counters.unproductive + 1,
        reviewFailures: counters.reviewFailures + 1,
        reviewRounds,
      };
  const feedback = buildFeedback(event.priorFindings, event.findings);

  if (next.reviewRounds > limits.reviewBudget) {
    return { step: { next: "fail", reason: "review_budget", feedback }, counters: next };
  }
  if (next.reviewFailures > limits.reviewBudget) {
    return { step: { next: "fail", reason: "review_budget", feedback }, counters: next };
  }
  if (next.unproductive > limits.maxRetries) {
    return { step: { next: "fail", reason: "retries", feedback }, counters: next };
  }
  return { step: { next: "implement", feedback }, counters: next };
}

/**
 * Feedback the next Implementer hears: the still-open must-fix items up front,
 * plus a read-only reminder of prior items now resolved so the Implementer does
 * not reintroduce them. The resolved list is bounded to what actually changed.
 */
function buildFeedback(prior: string[], current: string[]): string {
  const resolved = prior.filter((f) => !current.includes(f));
  const parts = [`Fix these must-fix issues:\n${current.join("\n")}`];
  if (resolved.length) {
    parts.push(`Do not reintroduce these already-resolved issues:\n${resolved.join("\n")}`);
  }
  return parts.join("\n\n");
}