/**
 * The goal-review "core-loop playthrough" section (#issue: complete-playthrough).
 * The goal reviewer's existing prompt asks it to "interact 2-3 sequences" — a
 * sampling discipline that can PASS a build whose core loop is broken but whose
 * isolated inputs still respond (move the ship, zoom the map — yet never land,
 * never found, never end a turn). This section upgrades that to a COMPLETION
 * discipline: derive the app's core loop, play it end-to-end to a terminal
 * state, and only then judge. A build whose loop does not complete is a FAIL,
 * whatever the individual inputs did.
 *
 * Pure — the caller (buildGoalReviewPrompt) supplies the goal + design doc text;
 * this returns the section string to inject.
 */

/**
 * Heuristic: pull the design doc's stated core loop when it names one, so the
 * playthrough checklist is anchored to the planner's own words rather than
 * re-derived loosely. Handles the two shapes plan.md-style docs use: an inline
 * line ("Core loop: sail → found → win") and a header line ("## Core loop")
 * whose body is the next non-empty line. Returns null when no loop is stated
 * (the reviewer derives it from the goal).
 */
export function extractCoreLoopAnchor(designDoc: string | null | undefined): string | null {
  if (!designDoc) return null;
  const lines = designDoc.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/(core\s+loop|gameplay\s+loop|main\s+loop|play\s+loop|game\s+loop|\bloop\b|\bcycle\b)/i.test(line)) {
      continue;
    }
    const hasSeq = /\u2192|->|=>/.test(line);
    if (hasSeq && line.trim().length <= 400) {
      return line.trim();
    }
    // Header line ("## Core loop"): the loop body is the next non-empty line(s).
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const body = lines[j].trim();
      if (!body) continue;
      if (/\u2192|->|=>/.test(body) && body.length <= 400) return body;
      break; // first non-empty line without a sequence is not a loop body
    }
  }
  return null;
}

/**
 * Build the playthrough-discipline section for the goal-review prompt.
 */
export function buildPlaythroughSection(
  originalPrompt: string,
  designDoc: string | null | undefined,
  opts: {
    /** Whether the committed build actually contains the core loop yet. A goal
     * checkpoint must not demand a full-loop playthrough at a stage that was
     * never asked to deliver the loop (the scaffold/early groups) — that
     * produced out-of-scope [BLOCKER]s. When false, the section scopes the
     * required playthrough to THIS group's deliverables. Defaults to true so
     * run-end callers and existing tests keep the full-loop contract. */
    coreLoopReady?: boolean;
  } = {},
): string {
  const coreLoopReady = opts.coreLoopReady ?? true;
  const anchor = extractCoreLoopAnchor(designDoc);
  const anchorBlock = anchor
    ? `\nThe design doc states the core loop as:\n  ${anchor}\nPlay THAT loop. If its steps are incomplete, fill in the gaps from the goal below — but the terminal state ("win", "found a colony", "survive N turns") is what you must reach.`
    : "\nThe design doc did not state an explicit loop. Derive the minimal core loop from the ORIGINAL GOAL below — the shortest chain of user actions a single session cycles through, ending in a terminal state (a founded colony, a won/lost run, a completed turn).";

  if (!coreLoopReady) {
    return `## Group playthrough (required — do not just sample inputs)

The full core loop does not exist yet: tickets that own its terminal state are still pending (listed above as not yet built). Your job is to prove THIS GROUP's deliverables actually run and integrate — not to test the finished game.

Do this:
1. Write this group's deliverables as a short numbered checklist (one step per deliverable).
2. Drive each step in the running app with real inputs — a real click, a real key press — waiting for the state to settle after each. Take a screenshot (and \`read\` it) at each step.
3. A deliverable of THIS group that cannot be operated, renders wrong, or breaks when the next deliverable runs is a [BLOCKER], named by its broken step with screenshot evidence.
4. Do NOT test or flag steps owned by unbuilt tickets: features from later groups are out of scope at this checkpoint even though the goal names them, and a missing later-group feature is not a blocker here.

The goal you are judging against (for reference):
${originalPrompt}`;
  }

  return `## Core-loop playthrough (required — do not just sample inputs)

Sampling a couple of inputs can PASS a build whose core loop is broken: the map scrolls and the ship moves, yet the player can never land, never found, never end a turn. Your job is to prove the LOOP completes, not that isolated controls respond.${anchorBlock}

The goal you are judging against (for reference):
${originalPrompt}

Do this:
1. Write the loop as a short numbered checklist (4-8 steps).
2. PLAY IT TO COMPLETION. Drive every step in order with real inputs — a real click, a real key press — waiting for the state to settle after each. Take a screenshot (and \`read\` it) at each step.
3. Reach the loop's TERMINAL state. If any step is impossible — a button missing, a command with no UI affordance, a turn that does not advance — STOP there and note the exact broken step.
4. Report the loop COMPLETED only if you reached the terminal state and observed the effect (the turn counter advanced, the colony was founded, the enemy actually moved).

A loop that does not complete is a [BLOCKER], named by its broken step with the screenshot evidence — even if every individual input you tried in isolation responded.`;
}
