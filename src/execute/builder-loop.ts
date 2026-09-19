import type { FailureClass } from "./failure-ladder.ts";

/**
 * The durable-session builder's session-death router (ADR 0022, issue #84).
 *
 * The builder's gate corrections are IN-SESSION — a gate verdict is re-injected
 * into the same session rather than fed to a fresh implementer (ADR 0022 §2),
 * so the response to a gate FAILURE is not a "fresh attempt" but a session
 * resume with the verdict in context. The run loop bounds that argument loop
 * with the shared Gate retry machine (`advanceRetry` in gate.ts, driven
 * directly by processTicket's per-ticket loop — the same counters, budgets,
 * and #70 "repeated findings burn budget, distinct findings reset progress but
 * never the round total" semantics apply to both the fresh and builder seats).
 *
 * This module owns the ONE axis the gate machine does not cover: session
 * *death*. `builderRecoveryFor` maps a failure class to resume-same-session
 * (an infra blip: the session is disk-durable, resuming is cheap) vs
 * fresh-session-from-last-commit (the session's own content is the problem:
 * capacity, diagnosed drift).
 */

/**
 * What a builder-session failure (exec death, kill, stall — anything that
 * ends a builder invocation WITHOUT a checkpoint) means for the session
 * handle, by the failure-ladder class that produced it:
 *
 *   blip / server-state  → resume-session: infra noise on a disk-durable,
 *                          warm-banked session. Resume by id is the cheap,
 *                          correct recovery (ADR 0022 §5, #80 ladder).
 *   capacity / fatal-config / diagnosed → fresh-session: the session's own
 *                          content is implicated (it thrashed to a capacity
 *                          wall, or drifted past usefulness). Force a fresh
 *                          session seeded from the last green commit instead
 *                          of prompt-shrinking — the session's fill is
 *                          compaction's business, not a shrinking contest.
 */
export function builderRecoveryFor(cls: FailureClass): "resume-session" | "fresh-session" {
  switch (cls) {
    case "blip":
    case "server-state":
      return "resume-session";
    case "capacity":
    case "fatal-config":
    case "diagnosed":
      return "fresh-session";
  }
}
