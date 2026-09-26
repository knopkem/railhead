import { parseVerdict } from "./reviewer.ts";
import type { ReviewVerdict } from "./reviewer.ts";
import { buildInteractionGuidance, type ProjectInterface } from "../config/interface.ts";
import { BROWSER_HYGIENE, HALT_CONTRACT, SCRATCH_FILE_DISCIPLINE } from "../context/prompt.ts";
import type { PhaseMessages } from "../context/preamble.ts";

/**
 * Parse an interaction-smoke verdict from a transcript — thin adapter over the
 * one shared verdict parser (issue #89), parameterized by the smoke markers.
 * Same defensive defaults: no marker → inconclusive, FAIL with NONE →
 * inconclusive, both markers → prefer FAIL. `$SMOKE_INCONCLUSIVE` (the
 * explicit "no interactive surface built yet" verdict) is not a pass/fail
 * marker, so it lands on the same inconclusive default.
 */
export function parseInteractionSmokeVerdict(text: string): ReviewVerdict {
  return parseVerdict(text, { failMarker: "$SMOKE_FAIL", passMarker: "$SMOKE_PASS" });
}

/** One ticket's place in the build when the smoke runs. */
export interface InteractionFrontierEntry {
  number: string;
  title: string;
  group: string | null;
  /** True when the ticket's work is on disk (committed, or the boundary
   * ticket itself — verify-green and about to commit). */
  built: boolean;
}

/** What the boundary gate may judge: the group it closes and the built/pending
 * frontier. A feature owned by a pending ticket is absent by design, so the
 * smoke must not demand it — the spriteforge scaffold boundary failed a
 * correctly-built ticket because the judge reached for the finished app's
 * canvas, which ticket 02 owned, and the retry then over-implemented it into
 * ticket 01. */
export interface InteractionSmokeScope {
  /** The group this boundary closes; null for an ungrouped plan. */
  group: string | null;
  /** The closed group's tickets — the artifact under test. */
  groupTickets: { number: string; title: string; what: string; criteria: string[] }[];
  /** Every run ticket, in execution order, with its build state. */
  frontier: InteractionFrontierEntry[];
}

/** Render the scope block: the frontier map plus the closed group's claims. */
function renderScope(scope: InteractionSmokeScope): string {
  const frontier = scope.frontier
    .map((t) => `- ${t.built ? "[built]" : "[pending]"} ${t.number} ${t.title}${t.group ? ` (group ${t.group})` : ""}`)
    .join("\n");
  const artifact = scope.group ? `group "${scope.group}"` : `ticket ${scope.groupTickets[0]?.number ?? "?"}`;
  const claims = scope.groupTickets
    .map((t) => {
      const criteria = t.criteria.map((c) => `  - ${c}`).join("\n");
      return `- ${t.number} ${t.title} — ${t.what}${criteria ? `\n${criteria}` : ""}`;
    })
    .join("\n");
  return `## Build scope at this boundary

The design intent in your context describes the FINISHED app; this run builds it through an ordered ticket queue and is not there yet. Only tickets marked [built] exist on disk.

${frontier}

This gate closes ${artifact}. Its tickets claim:
${claims}

Pick your action from the [built] surface only. A feature owned by a [pending] ticket is intentionally absent — never try to operate it and never fail for its absence, whatever the finished design describes.`;
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
  scope: InteractionSmokeScope;
}): PhaseMessages {
  const { runCommandHint, verifyCommands, interactionHints, projectInterface, scope } = options;

  const verifyBlock = verifyCommands.length
    ? verifyCommands.map((c) => `- ${c}`).join("\n")
    : "- (no verify commands configured)";

  const hintsBlock = interactionHints
    ? `\n## Interaction hints (project-provided)\n${interactionHints}`
    : projectInterface && buildInteractionGuidance(projectInterface)
      ? `\n## Interaction guidance (interface: ${projectInterface})\n${buildInteractionGuidance(projectInterface)}`
      : "";

  const task = `You are the Interaction Smoke agent for one group in an unattended build. Your ONLY job is to prove the running app is OPERABLE — that a real user can perform the most basic action the current build offers and see its effect. You are not reviewing quality, style, or completeness; those are other seats' jobs.

A build can compile and pass every test while being unplayable — the turn button might not exist, the "found" command might have no UI caller, a form's submit might be dead. Verify cannot see that (it only builds and runs tests). Your smoke is the first gate that actually RUNS the app and drives it.

${renderScope(scope)}

HOW TO RUN THE APP (best guess — adapt as needed; try the smoke command or the dev script):
${runCommandHint}${hintsBlock}

VERIFY COMMANDS (context only — these already passed; your test is to RUN and OPERATE the app):
${verifyBlock}

${SCRATCH_FILE_DISCIPLINE}

${BROWSER_HYGIENE}

${HALT_CONTRACT}

## What to do

1. Launch the app and get it to its interactive state (past any title/menu if needed).
2. Identify the most basic single user action the [built] surface offers — the smallest thing that proves it is operable: press the primary button, advance one turn, submit a form, move the player. One real action is enough. If the [built] surface offers no interactive control at all (a setup/scaffold boundary), do not hunt for one and do not fail: emit $SMOKE_INCONCLUSIVE and stop.
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
- Only a [built] surface can fail this gate. A dead control on a built surface is a $SMOKE_FAIL even if no ticket criterion named it; a control that belongs to a [pending] ticket is not built yet and never a failure.

Reply terse. Emit EXACTLY one of these markers:

$SMOKE_PASS
$END

or

$SMOKE_FAIL
[BLOCKER] <the one action you tried, what you expected, and what actually happened — concrete enough for an implementer to fix>
$END

or, when the [built] tickets deliver no interactive surface to drive yet:

$SMOKE_INCONCLUSIVE
$END

Do NOT emit both $SMOKE_PASS and $SMOKE_FAIL. If you could not launch the app at all, or the declared interface gives you no real-input path, that is a $SMOKE_FAIL naming the launch/input problem. If the build has simply not reached the app's first interactive surface yet, that is $SMOKE_INCONCLUSIVE — the next group boundary runs this gate again.`;

  return { preamble: "", task };
}
