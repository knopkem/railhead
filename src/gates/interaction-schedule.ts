import type { Ticket } from "../core/ticket.ts";
import type { TicketState } from "../core/state.ts";
import type { ProjectInterface } from "../config/interface.ts";
import { mentionsInteractionClaim, touchesVisualSurface } from "../context/surface.ts";
import { isCorrectiveTitle } from "./corrective.ts";

/**
 * The interaction smoke's firing decision, as pure logic (v2 issue 01 fix).
 * The gate used to fire whenever `!ticket.group` — which conflated "the plan
 * is ungrouped" with "this ticket has no group label". Mechanically generated
 * corrective tickets are ungrouped by construction, so in a grouped plan every
 * favicon/asset corrective closed a phantom boundary, launched a browser-
 * driving agent scoped to itself ("no interactive surface built yet"), and in
 * one case wedged it into a degraded-target kill. The decision has to answer
 * three independent questions:
 *
 *  - boundary: is the ticket at a point the composed artifact can be judged?
 *    A group closes when its last ticket commits; in a grouped plan an
 *    ungrouped ticket is railhead-inserted repair work (corrective/follow-up)
 *    and is judged on its own commit; in an ungrouped plan every ticket is a
 *    boundary (the historical cadence).
 *  - relevance: does the closed scope claim anything a user could operate?
 *    Group boundaries keep the recall-biased surface gate (`touchesVisualSurface`,
 *    the same predicate the goal gate's no-surface skip and per-ticket visual
 *    review use). Correctives use the narrow interaction-claim vocabulary
 *    (`mentionsInteractionClaim`) on their finding body — their criteria are
 *    template boilerplate ("Run the app and confirm…") and would always match.
 *  - scope: what the agent drives is built in run.ts's `interactionSmokeScopeFor`
 *    (the built frontier), not here.
 *
 * `candidate` is reported separately from `run` so a deliberate skip can be
 * logged; without it a missing interact phase reads as "the gate never fired"
 * rather than "the boundary had nothing to drive".
 */

export type InteractionBoundaryKind = "group" | "corrective" | "ungrouped";

export interface InteractionDecision {
  /** The ticket sits at a boundary the gate could judge (group close, or an
   * insertion point for ungrouped/corrective work) — independent of relevance. */
  candidate: boolean;
  /** The interaction smoke should run after this ticket's commit. */
  run: boolean;
  kind: InteractionBoundaryKind;
  /** One-line reason for the console/ticket log. */
  reason: string;
}

export interface InteractionDecisionInput {
  /** From `interactionSmokeEnabled(state.config)`. */
  enabled: boolean;
  /** The declared/derived interface (`state.config.projectInterface`). */
  iface: ProjectInterface | null | undefined;
  parsed: Ticket;
  allParsed: Ticket[];
  tickets: TicketState[];
}

export function decideInteractionSmoke(input: InteractionDecisionInput): InteractionDecision {
  const { enabled, iface, parsed, allParsed, tickets } = input;
  const kind: InteractionBoundaryKind = parsed.group
    ? "group"
    : isCorrectiveTitle(parsed.title)
      ? "corrective"
      : "ungrouped";

  if (!enabled) return { candidate: false, run: false, kind, reason: "interaction smoke disabled" };
  if (iface === "none") return { candidate: false, run: false, kind, reason: "declared interface is none" };

  // Boundary: a group ticket closes a boundary only when every sibling has
  // committed. A ticket with no group only counts in a grouped plan when it is
  // railhead-inserted repair work — the spriteforge bug treated EVERY such
  // ticket as a boundary. In an ungrouped plan every ticket is one.
  let candidate: boolean;
  if (parsed.group) {
    candidate = tickets
      .filter((t) => t.group === parsed.group && t.file !== parsed.file)
      .every((t) => t.status === "committed");
  } else {
    candidate = true;
  }
  if (!candidate) {
    return { candidate: false, run: false, kind, reason: `group "${parsed.group}" not complete yet` };
  }

  // Relevance: the boundary's claims decide whether there is anything to drive.
  if (kind === "group") {
    const groupTickets = allParsed.filter((t) => t.group === parsed.group);
    const surface = groupTickets.length === 0 || groupTickets.some((t) => touchesVisualSurface(t));
    return {
      candidate: true,
      run: surface,
      kind,
      reason: surface
        ? `group "${parsed.group}" claims rendered surface`
        : `no ticket in group "${parsed.group}" claims a rendered/interactive surface`,
    };
  }
  if (kind === "corrective") {
    const interactive = mentionsInteractionClaim(`${parsed.title}\n${parsed.what}`);
    return {
      candidate: true,
      run: interactive,
      kind,
      reason: interactive
        ? "the corrective names an interaction/control to re-check"
        : "no interaction claims in this corrective — the visual/structural gates own the finding",
    };
  }
  const surface = touchesVisualSurface(parsed);
  return {
    candidate: true,
    run: surface,
    kind,
    reason: surface ? "ticket claims rendered surface" : "no rendered/interactive surface claimed",
  };
}
