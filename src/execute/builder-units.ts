import type { CheckpointGranularity } from "../config/config.ts";
import type { TicketState } from "../core/state.ts";

/**
 * ADR 0022 / issue #95 stage 2: which tickets a builder invocation receives,
 * and where its checkpoint marker must land, by `checkpoint_granularity`.
 *
 * The run loop re-computes the CURRENT unit from the not-yet-committed
 * tickets every time it advances, so a unit is a live slice, not a static
 * partition. Pure so the routing — the piece of stage 2 that regresses without
 * a live server — is unit-testable without a repo.
 *
 *   ticket:          one ticket per unit; each checkpoint names that ticket.
 *   product (default): one unit = every remaining ticket; each checkpoint
 *                     names the next uncommitted ticket and the SAME session
 *                     continues across them (gates still fire per ticket —
 *                     only the builder's process lifetime changes, ADR 0022
 *                     §4).
 *   group:            one unit = every remaining ticket sharing the current
 *                     ticket's planner group; ONE checkpoint at the unit's END
 *                     (its marker names the LAST ticket) — the whole group's
 *                     diff is gated and committed together.
 *
 * A ticket with no group label under `group` granularity degenerates to
 * ticket-per-unit (a planner that emits no labels has no group boundaries to
 * honor — falling back to per-ticket keeps checkpoints frequent, the safe
 * default).
 */

/** The live slice of the plan handed to a builder invocation (or invocation
 * series) before the next railhead gate. */
export interface BuilderUnit {
  /** The unit's tickets in DAG order, not yet committed. */
  tickets: TicketState[];
  /** True when the unit expects a SINGLE checkpoint naming the LAST ticket
   * (`group` granularity — one gate + one commit per group). False when every
   * ticket checkpoints individually (`ticket`/`product`). */
  checkpointAtEnd: boolean;
}

/** The next unit to drive, from the not-yet-committed tickets in plan order.
 * Null when nothing remains to build. The first remaining ticket is the unit's
 * leader: under `group` it decides the group, and it is assumed DAG-ready (the
 * plan is dependency-ordered, so earlier tickets commit before it — a failed
 * earlier ticket stops the run before this is ever asked). */
export function nextBuilderUnit(
  remaining: TicketState[],
  granularity: CheckpointGranularity,
): BuilderUnit | null {
  if (remaining.length === 0) return null;
  const first = remaining[0];
  if (granularity === "group" && first.group) {
    return {
      tickets: remaining.filter((t) => t.group === first.group),
      checkpointAtEnd: true,
    };
  }
  if (granularity === "product") {
    return { tickets: [...remaining], checkpointAtEnd: false };
  }
  return { tickets: [first], checkpointAtEnd: false };
}

/** The ticket the CURRENT checkpoint marker must name for this unit's next
 * commit: the last ticket when the unit checkpoints at its end (`group`),
 * otherwise the first uncommitted ticket of the unit. */
export function checkpointTarget(unit: BuilderUnit): TicketState {
  return unit.checkpointAtEnd ? unit.tickets[unit.tickets.length - 1] : unit.tickets[0];
}
