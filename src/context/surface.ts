import type { Ticket } from "../core/ticket.ts";

/**
 * The recall-biased surface gate (ADR 0028 / issue #99), isolated in a LIGHT
 * module (no prompt/reviewer imports) so any consumer can classify tickets
 * without pulling the heavy review-graph onto the executor's import chain —
 * overview.ts (which executor.ts imports) must be able to render the report's
 * surface classification without dragging in reviewer.ts.
 *
 * The gate is defined once here and re-exported from `visual.ts` (the seat
 * module the docs name), so per-ticket visual review (`shouldRunVisualReview`)
 * and charter injection can never disagree about what a surface ticket is.
 */

/**
 * Criteria vocabulary the gate scans for: visual/runtime words that imply
 * observable surface behaviour (rendering, interaction, layout, chrome). A
 * scaffold ticket whose criteria are purely structural (build passes, config
 * exports, file conventions) has no runtime behaviour to observe — running a
 * visual reviewer against it guarantees false BLOCKERs: the reviewer sees a
 * blank canvas and flags "expected surface absent" when those features are
 * later tickets' deliverables, not this ticket's. The vocabulary stays
 * domain-neutral: behaviour words, not the nouns of any one kind of app.
 */
export const VISUAL_CRITERIA_RE =
  /\b(?:render\w*|display\w*|show\w*|draw\w*|paint\w*|appear\w*|visibl\w*|animat\w*|glide|mov\w*|respond\w*|react\w*|interact\w*|steer|sprite|colour|color|glow|neon|overlay|screen|canvas|frame|flicker|scroll\w*|cursor|click\w*|key|input|button|menu|score|level|restart|pause|pixel|font|text|layout|border|background|foreground)\b|reproduc|\brun the app\b/i;

/**
 * The recall-biased gate for "is this a surface ticket?" (ADR 0028 / issue
 * #99). ONE predicate powers BOTH per-ticket visual review
 * (`shouldRunVisualReview`) and coherence-charter injection, so the two can
 * never disagree about what a surface ticket is.
 *
 * Recall over precision: a false positive costs ~250 words of charter context;
 * a false negative recreates the exact cross-ticket drift the charter exists
 * to prevent. When in doubt, inject. No stacked fallbacks — no group sniffing,
 * no `testable === false` heuristics; the classification is observable via
 * report.md, and a planner-declared `surface` ticket field is the escalation
 * if it misclassifies (an ADR 0007 format bump), not more heuristics here.
 */
export function touchesVisualSurface(ticket: { criteria: string[] }): boolean {
  if (ticket.criteria.length === 0) return true;
  return ticket.criteria.some((c) => VISUAL_CRITERIA_RE.test(c));
}

/** Structural sub-type helper for the handful of seats that hold only a
 * parsed on-disk Ticket (kept for a stable, typed public shape). */
export type SurfaceClassifiable = Pick<Ticket, "criteria">;
