import { parseVerdict } from "./reviewer.ts";
import type { ReviewVerdict } from "./reviewer.ts";
import { buildInteractionGuidance, type ProjectInterface } from "../config/interface.ts";
import { BROWSER_HYGIENE, HALT_CONTRACT, SCRATCH_FILE_DISCIPLINE } from "../context/prompt.ts";
import type { PhaseMessages } from "../context/preamble.ts";

/**
 * Parse an interaction-smoke verdict from a transcript — thin adapter over the
 * one shared verdict parser (issue #89), parameterized by the smoke markers.
 * Same defensive defaults: no marker → inconclusive, FAIL with NONE →
 * inconclusive, both markers → prefer FAIL.
 */
export function parseInteractionSmokeVerdict(text: string): ReviewVerdict {
  return parseVerdict(text, { failMarker: "$SMOKE_FAIL", passMarker: "$SMOKE_PASS" });
}

/**
 * Build the prompt for the per-ticket interaction-smoke agent. Its single job:
 * launch the running app and drive ONE real user interaction to prove the app
 * is OPERABLE, not merely startable. A shell smoke proves "starts"; this proves
 * "a real user can operate it" — the exact gap that let this game ship with an
 * unreachable turn loop (endTurn/foundColony had no UI caller, yet build+tests
 * were green).
 *
 * Vision is deliberately NOT required: the agent asserts through DOM text (an
 * a11y snapshot) or readable state, so a text model with browser access can run
 * it. The agent is told to use real input tools on the declared interface, not
 * synthetic dispatch, so a control that is dead to a real cursor fails the
 * smoke the same way it would a real user.
 */
export function buildInteractionSmokePrompt(options: {
  runCommandHint: string;
  verifyCommands: string[];
  interactionHints?: string | null;
  projectInterface?: ProjectInterface | null;
}): PhaseMessages {
  const { runCommandHint, verifyCommands, interactionHints, projectInterface } = options;

  const verifyBlock = verifyCommands.length
    ? verifyCommands.map((c) => `- ${c}`).join("\n")
    : "- (no verify commands configured)";

  const hintsBlock = interactionHints
    ? `\n## Interaction hints (project-provided)\n${interactionHints}`
    : projectInterface && buildInteractionGuidance(projectInterface)
      ? `\n## Interaction guidance (interface: ${projectInterface})\n${buildInteractionGuidance(projectInterface)}`
      : "";

  const task = `You are the Interaction Smoke agent for one ticket in an unattended build. Your ONLY job is to prove the running app is OPERABLE — that a real user can perform the app's single most basic action and see its effect. You are not reviewing quality, style, or completeness; those are other seats' jobs.

A build can compile and pass every test while being unplayable — the turn button might not exist, the "found" command might have no UI caller, a form's submit might be dead. Verify cannot see that (it only builds and runs tests). Your smoke is the first gate that actually RUNS the app and drives it.

HOW TO RUN THE APP (best guess — adapt as needed; try the smoke command or the dev script):
${runCommandHint}${hintsBlock}

VERIFY COMMANDS (context only — these already passed; your test is to RUN and OPERATE the app):
${verifyBlock}

${SCRATCH_FILE_DISCIPLINE}

${BROWSER_HYGIENE}

${HALT_CONTRACT}

## What to do

1. Launch the app and get it to its interactive state (past any title/menu if needed).
2. Identify the app's most basic single user action — the smallest thing that proves it is operable: press the primary button, advance one turn, submit a form, move the player. One real action is enough.
3. Perform that action FOR REAL using the interface's real-input tools (a real click / key press / form fill — never a synthetic el.click()/dispatchEvent unless the declared interface explicitly says synthetic dispatch is the input class).
4. Wait for the state to settle, then CONFIRM the action actually changed observable state — a RENDER DELTA plus clean console:
   a. Capture the rendered output BEFORE the action (a screenshot, a pixel/RGBA sample, or a DOM/a11y text snapshot).
   b. Perform the action, wait for the frame/state to settle.
   c. Capture the SAME output again and assert it CHANGED in the way the action implies (the turn counter advanced, a new element appeared, the canvas pixels differ, a value updated). "No error occurred" is not a delta.
   d. Read the browser/app console and assert ZERO errors after the action. ANY logged error — including a failed request the app needs — is a failure; name it.

## Evidence bar (do not pass on startup alone)

- An HTTP 200, a listening port, or a process that stays up proves only that the app STARTS. It is NOT evidence the app is operable and must never be your basis for a pass.
- The failure this gate exists to catch: the page loads, every request succeeds, and the canvas is an unwired rectangle — nothing the user does changes the render. A pass REQUIRES the render-delta check from step 4c and the zero-console-errors check from step 4d.
- If the declared interface makes a real-input or render-delta check impossible with your tools, do NOT claim a pass: say exactly what you could not do and what you tried.

Reply terse. Emit EXACTLY one of these markers:

$SMOKE_PASS
$END

or

$SMOKE_FAIL
[BLOCKER] <the one action you tried, what you expected, and what actually happened — concrete enough for an implementer to fix>
$END

Do NOT emit both. If you could not launch the app at all, or the declared interface gives you no real-input path, that is a $SMOKE_FAIL naming the launch/input problem.`;

  return { preamble: "", task };
}
