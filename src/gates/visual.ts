import { parseVerdict } from "./reviewer.ts";
import type { Ticket } from "../core/ticket.ts";
import { LEARNED_MARKER, RETRACTED_MARKER } from "../context/learnings.ts";
import { BROWSER_HYGIENE, HALT_CONTRACT, SCRATCH_FILE_DISCIPLINE } from "../context/prompt.ts";
import { buildInteractionGuidance, type ProjectInterface } from "../config/interface.ts";
import { visionCapabilityBlock, type VisionCapabilityFact } from "../execute/vision-probe.ts";
import { renderPreamble, type PhaseMessages } from "../context/preamble.ts";
// The surface gate is defined in the light module surface.ts (executor.ts's
// overview import chain must not drag in reviewer.ts); visual.ts re-exports it
// as the seat the docs name — the ONE predicate per-ticket visual review
// (shouldRunVisualReview) and charter injection share.
import { touchesVisualSurface, VISUAL_CRITERIA_RE } from "../context/surface.ts";
export { touchesVisualSurface, VISUAL_CRITERIA_RE };

export interface VisualVerdict {
  verdict: "pass" | "fail" | "inconclusive";
  findings: string[];
}

/**
 * Issue #96: the recovery note injected into the round AFTER a degraded-target
 * kill. The executor's degraded-target guard kills a round whose interaction
 * target wedged (a run of ~60s request-timeout tool calls); this note is what
 * the visual loop appends to the NEXT round's prompt so the reviewer recovers
 * instead of repeating the same wedge — restart the app in a fresh page, and
 * don't re-create the wedge via an unbounded in-page pixel-readback poll loop
 * (the cheapest observation path in the reported incident, and the one that
 * wedged the very page the tool server needed responsive).
 */
export const DEGRADED_TARGET_RECOVERY_NOTE =
`Your previous attempt was killed because the running app you were interacting with (your tool target) stopped responding — every call against it, even page-level ones, timed out for several minutes in a row. Treat that as WEDGED, not slow: it will not recover in place.

Restart the app cleanly and review it in a FRESH page/tab — do not resume the wedged one (see the browser-hygiene note below about closing stale pages first).

If it wedges again, suspect your observation path: an in-page evaluate_script loop that reads the page's own pixels/canvas back on every tick can keep the page's main thread so busy that the tool server cannot answer it. Prefer discrete input + screenshot primitives. If you must poll in-page, keep the loop BOUNDED — a small fixed number of polls with a settle delay between them, never an unbounded per-frame readback.`;

/**
 * Parse a visual-review verdict from a transcript — thin adapter over the one
 * shared verdict parser (issue #89), parameterized by visual's markers. The
 * parser's defensive defaults are documented there: no marker → inconclusive
 * (ADR 0009's evidence vacuum), FAIL with NONE → inconclusive, both markers →
 * prefer FAIL.
 */
export function parseVisualVerdict(text: string): VisualVerdict {
  return parseVerdict(text, { failMarker: "$VISUAL_FAIL", passMarker: "$VISUAL_PASS" });
}

/**
 * Build the prompt for the visual-review agent (ADR 0009). The agent has bash
 * access and a vision-capable model; it captures what it needs.
 *
 * The prompt deliberately does NOT tell the agent HOW to capture a screenshot.
 * Different project types (terminal, browser, native window) need different
 * capture paths (PTY grab, screencapture, headless browser, offscreen render),
 * and a capable agent will pick the right one for the project in front of it.
 * Telling it "use screencapture" would be macOS-specific; telling it nothing
 * lets it choose based on what it can run.
 */
export function buildVisualReviewPrompt(options: {
  mission: string;
  criteria: string[];
  verifyCommands: string[];
  runCommandHint: string;
  round: number;
  priorFindings: string[];
  /** Project learnings (tooling facts from prior phases). Injected so the
   * visual reviewer benefits from tooling discoveries made by prior
   * implementers/reviewers — e.g. "the dev server panics without a TTY"
   * or "port 5173 is not the default". See ADR 0012. */
  learnings?: string | null;
  /** Project-provided interaction hints (#20). Injected verbatim so the
   * model doesn't have to discover the interaction model from scratch —
   * e.g. "The game uses requestPointerLock + KeyboardEvent on window.
   * Override document.pointerLockElement, then dispatch KeyboardEvent
   * for WASD." Saves ~15-20 explore steps per visual review. Takes
   * precedence over the declared-interface guidance. */
  interactionHints?: string | null;
  /** Issue #97: the project's declared interaction interface (railhead.json /
   * planner $INTERFACE). When no human `interactionHints` are set, the
   * interface's row of `buildInteractionGuidance` is injected — browser-ui
   * real-input discipline, canvas evaluate/pointer-lock defaults. Undeclared
   * projects pass null (canvas-only inference may have resolved at the seat;
   * the caller maps detectGameCanvas → "canvas"). */
  projectInterface?: ProjectInterface | null;
  /** Per-ticket visual review (ADR 0011). When set, the prompt is scoped to
   * only what THIS ticket was supposed to build — the reviewer is told not to
   * flag features built (or not yet built) by other tickets. Without this,
   * the reviewer judges the app against the full mission, which produces
   * false BLOCKERs on scaffold/early tickets whose features live in later
   * tickets (e.g. a scaffold ticket with a blank canvas flagged for "no
   * snake rendered" when the snake is ticket 03's deliverable). */
  perTicket?: { title: string; what: string };
  /** The coherence charter (docs/coherence.md content) when it exists (ADR
   * 0028). Injected as an in-scope check for PER-TICKET reviews of a surface
   * ticket: charter conformance (does this ticket's rendered surface honor
   * the Chrome rules / shared tokens?) is this ticket's responsibility — a
   * genuine fix for chrome drift, not the ADR 0011 cross-ticket BLOCKER
   * class. End-of-run passes omit it (goal review holds that seat). */
  coherenceDoc?: string | null;
  /** Issue #96: when set, the previous round of this review was killed by the
   * degraded-target guard (its interaction target wedged into a run of
   * request-timeout tool calls). Injected as an explicit recovery note so the
   * retried round restarts the app in a fresh page and does not re-create the
   * wedge. Absent for a normal (first or finding-driven) round. */
  recoveryNote?: string | null;
  /** ADR 0036: the railhead-measured vision capability of this seat's model.
   * Injected so a model cannot silently decide it "doesn't want" to read
   * screenshots — the measurement overrides any self-assessment. */
  visionCapability?: VisionCapabilityFact | null;
}): PhaseMessages {
  const { mission, criteria, verifyCommands, runCommandHint, round, priorFindings, learnings, interactionHints, projectInterface, perTicket, coherenceDoc, recoveryNote, visionCapability } = options;
  const criteriaBlock = criteria.length
    ? criteria.map((c) => `- ${c}`).join("\n")
    : "- (no acceptance criteria were declared; judge whether the app visibly works, renders without artifacts, and matches the mission)";
  const verifyBlock = verifyCommands.length
    ? verifyCommands.map((c) => `- ${c}`).join("\n")
    : "- (no verify commands configured)";
  const priorBlock = priorFindings.length
    ? `\nPRIOR VISUAL FINDINGS (from earlier rounds — confirm each is now resolved before approving; do not re-raise a resolved item):\n${priorFindings.join("\n")}`
    : "";
  const learningsBlock = learnings
    ? `\n## Project learnings (tooling facts from prior phases)\nThese are tooling/environment facts discovered by prior agents on this project. They are unverified model-claims, not tested facts. Most are safe to trust (a command that needs a flag, a port that isn't default). But a claim about YOUR OWN capabilities (e.g. "this model cannot read images") is a self-assessment that may be wrong — if such a claim would change your approach, TEST it once before deferring to it. If a learning turns out to be false, retract it with the ${RETRACTED_MARKER} marker below.\n${learnings.split("\n").map((l) => `- ${l}`).join("\n")}`
    : "";

  const hintsBlock = interactionHints
    ? `\n## Interaction hints (project-provided)\n${interactionHints}`
    : projectInterface && buildInteractionGuidance(projectInterface)
      ? `\n## Interaction guidance (interface: ${projectInterface})\n${buildInteractionGuidance(projectInterface)}`
      : "";

  const perTicketHeader = perTicket
    ? `You are the Visual Reviewer for a per-ticket review of ONE ticket in an unattended build. You have bash access and a vision-capable model. This is a PER-TICKET review: judge ONLY what THIS ticket was supposed to build, not the whole app.

THIS TICKET: ${perTicket.title}
WHAT THIS TICKET BUILDS: ${perTicket.what}

BUILD MISSION (for context — do NOT judge against the whole mission, only this ticket's criteria below): ${mission}

IMPORTANT — SCOPE: Features built by OTHER tickets (past or future) are OUT OF SCOPE. Do NOT flag the absence of a feature this ticket was not responsible for. For example, if this ticket builds the render loop, a missing game-over screen (built by a later ticket) is not a defect. Judge ONLY the acceptance criteria below — if a criterion is met, the ticket passes, even if the broader app is incomplete.`
    : `You are the Visual Reviewer at the end of an unattended build. You have bash access and a vision-capable model. Your job: run the built app, INTERACT with it (send inputs the user would send — keystrokes, arrow keys, mouse clicks), and judge each resulting state against the acceptance and visual criteria below.

BUILD MISSION: ${mission}`;

  const charterBlock = coherenceDoc
    ? `\n## Coherence charter (in-scope check)\nThe Coherence contract section above is the plan-time charter (docs/coherence.md) — the terse, normative visual design contract surface tickets must honor. THIS ticket touches the rendered surface, so charter conformance is THIS ticket's responsibility, like any other criterion: does the rendered surface below honor the Visual tokens and Chrome rules? The shared constants module the charter names is authoritative — redefining a token or introducing a competing style/panel recipe here is a finding.`
    : "";

  // Issue #96: a degraded-target recovery note rides on the retried round's
  // prompt only — never on a normal round — so a wedged interaction target
  // gets explicit recovery guidance instead of a silent repeat.
  const recoveryBlock = recoveryNote
    ? `\n## Interaction-target recovery note\n${recoveryNote}`
    : "";

  const visionBlock = visionCapabilityBlock(visionCapability ?? null, "visual");

  const roleBlock = `${perTicketHeader}

ACCEPTANCE / VISUAL CRITERIA (judge every one):
${criteriaBlock}

VERIFY COMMANDS (the project's build/test gate; useful to confirm the app at least builds, but your real test is to RUN it, interact, and look):
${verifyBlock}

HOW TO RUN THE APP (best guess from the plan; you may need to adjust — try the smoke command, the dev script, or run the binary that verify built):
${runCommandHint}${learningsBlock}${hintsBlock}${visionBlock}${charterBlock}${recoveryBlock}

Round ${round} of visual review. A startup screenshot alone is NOT enough — most runtime bugs only surface once you interact with the app. You MUST:
1. Launch the app and screenshot the initial state.
2. Send the inputs a real user would send for each criterion (arrow keys to steer, click buttons, type into fields). Wait a moment for the state to settle, then screenshot the resulting state. Send inputs that exercise the criteria: don't just tap one key; if the criterion is "paddle responds," move it and confirm the visible paddle moved AND the rest of the game (ball collision, scoring) still behaves.
3. Capture at least 2-3 INTERACTION sequences (not just static frames), so transient bugs (ghosting, drift, flicker, stale-state-after-input, ghost-collisions-off-moved-objects) become visible. Save screenshots under .railhead/visual/ so a human can audit what you saw and what you did before each frame.${priorBlock}

${SCRATCH_FILE_DISCIPLINE}

${BROWSER_HYGIENE}

${HALT_CONTRACT}

IMPORTANT — SEEING YOUR SCREENSHOTS: a screenshot tool saves the image to a file and returns the file PATH as text — it does NOT show you the pixels. To actually see a screenshot you saved, you MUST \`read\` the saved .png file. A vision-capable model receives the image as an image content block when it reads an image file; without that read step you are judging blind. Read every screenshot you capture before judging it against the criteria.

Judge honestly. A defect you can SEE after interacting (ball bounces when it should leave the screen, paddle moves but ball ignores it, score doesn't update after a goal, app hangs after a click) is a [BLOCKER] — runtime defects that need interaction to surface cannot be caught any other way, so do not let them slide. A minor cosmetic issue (alignment off by one px, slightly wrong colour) is [MAJOR]. Style/polish you would not even mention in a code review is NONE.

When you emit findings, INCLUDE THE SCREENSHOT PATHS that show the defect. A vision-capable implementer will read these screenshots to see exactly what you saw, rather than guessing from text. Format each finding as:
[BLOCKER] <description> (see .railhead/visual/<filename>.png)

Reply terse, no prose narration. Emit EXACTLY one of these markers:

$VISUAL_PASS
$END

or

$VISUAL_FAIL
[BLOCKER] or [MAJOR] — one finding per line, with screenshot path in parentheses
$END

## Reusable tooling facts (push)
You are running the app, capturing screenshots, and sending inputs — exactly the kind of work where reusable tooling facts hide (how to capture a frame without the cursor, what command actually starts the app, what window focus requires). If you discovered such a fact, emit it on its own line after $END, exactly in this form:

${LEARNED_MARKER} <one terse line, self-contained, no preamble>

Rules:
- One line, beginning with the exact marker \`${LEARNED_MARKER}\`. Mid-sentence mentions are ignored.
- Omit it entirely if you discovered nothing reusable — silence is the correct empty signal. Do NOT emit \`${LEARNED_MARKER} NONE\`.
- Tooling/environment facts only (how to capture, how to run, what fails without a TTY, etc.). Not findings about this ticket (those are in $VISUAL_FAIL above). If in doubt, omit.

If a prior learning injected above is WRONG — you verified it does not hold (e.g. it claims "this model cannot read images" but you just successfully read a screenshot) — emit a retraction on its own line after $END, in this form:

${RETRACTED_MARKER} <the prior learning text, or enough of it to uniquely identify the line>

The railhead removes the matched line from future prompts. Use this only for facts you personally falsified; do not retract a learning merely because you did not need it this phase.`;

  return {
    preamble: renderPreamble({ coherence: coherenceDoc ?? null }),
    task: roleBlock,
  };
}

/** Whether per-ticket visual review fires for a ticket — the surface gate
 *  (ADR 0028): one predicate shared with coherence-charter injection so the
 *  two can never disagree about what a surface ticket is. */
export function shouldRunVisualReview(ticket: Ticket): boolean {
  return touchesVisualSurface(ticket);
}

/** The run command hint the visual reviewer gets. Derives from the
 * project's own smoke command (if configured) or the first verify
 * command, rather than guessing a language-specific launcher. The
 * hint is advisory — the reviewer still adapts based on what works. */
export function runCommandFromVerify(verify: string[], _tickets: Ticket[]): string {
  if (verify.length) return `${verify[0]} — or the project's run/launch command`;
  return "no hint available — find the run command from the project files";
}

