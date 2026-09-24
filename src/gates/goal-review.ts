import { parseVerdict } from "./reviewer.ts";
import type { PlanTicket } from "../core/ticket-dag.ts";
import { LEARNED_MARKER, RETRACTED_MARKER } from "../context/learnings.ts";
import { buildDigestInjection, DIGEST_MARKER } from "../context/digest.ts";
import { BROWSER_HYGIENE, HALT_CONTRACT, SCRATCH_FILE_DISCIPLINE } from "../context/prompt.ts";
import { CHARTER_MARKER } from "../context/coherence.ts";
import { buildInteractionGuidance, type ProjectInterface } from "../config/interface.ts";
import { visionCapabilityBlock, type VisionCapabilityFact } from "../execute/vision-probe.ts";
import { buildPlaythroughSection } from "../context/playthrough.ts";
import { renderPreamble, type PhaseMessages } from "../context/preamble.ts";
import { scanJsonObjects } from "../core/json.ts";
import { indexOfOutsideFences } from "../core/fences.ts";
import { isBlocker } from "./reviewer.ts";

export interface GoalVerdict {
  verdict: "pass" | "fail" | "inconclusive";
  findings: string[];
}

/**
 * Parse a goal-review verdict from a transcript (#19) — thin adapter over the
 * one shared verdict parser (issue #89), parameterized by goal's markers. The
 * parser's defensive defaults are documented there: no marker → inconclusive,
 * FAIL with NONE → inconclusive, both markers → prefer FAIL.
 */
export function parseGoalVerdict(text: string): GoalVerdict {
  return parseVerdict(text, { failMarker: "$GOAL_FAIL", passMarker: "$GOAL_PASS" });
}

/**
 * Issue #65: whether the goal reviewer asked for a replan. The reviewer emits
 * an explicit `$REPLAN` marker (after `$GOAL_FAIL`'s findings and `$END`) when
 * the findings indicate the PLAN was structurally wrong — not merely an
 * implementation gap. This is the structured signal that replaces the fragile
 * regex classifier over finding prose. Word-boundary search (like the verdict
 * parsers) — the marker is distinctive enough that a mid-sentence mention is
 * vanishingly rare and a false positive just replans (safe). Fence-aware
 * (#108): a $REPLAN quoted inside a code fence is an example, not a signal. */
export function parseReplanRequested(text: string): boolean {
  return indexOfOutsideFences(text, /\$replan\b/i) >= 0;
}

/**
 * Issue #67: parse the goal reviewer's optional `$CORRECTIVE` block — one JSON
 * object per suggested corrective ticket (title, what, files, references,
 * introduces, testable). The reviewer knows the structural problems deeply and
 * is in the best position to decompose the repair; a structured block beats the
 * mechanical one-ticket-per-finding split (which ships empty files/references,
 * see #66).
 *
 * Returns `null` when no `$CORRECTIVE` block is present (or it parses to
 * nothing) so the caller falls back to the mechanical per-finding split. A
 * `$REPLAN` marker supersedes this block — the caller checks replan first.
 *
 * Fence-aware (#108): the `$CORRECTIVE` gate is on its UNFENCED occurrence (a
 * quoted example inside a code fence is ignored), but the JSON is sliced from
 * the RAW text so a legitimate fence-wrapped JSON object still parses
 * (`scanJsonObjects` already tolerates fence lines).
 */
export function parseCorrectiveTickets(text: string): PlanTicket[] | null {
  const start = indexOfOutsideFences(text, /\$corrective\b/i);
  if (start < 0) return null;
  let slice = text.slice(start + "$CORRECTIVE".length);
  const end = slice.search(/\$end\b/i);
  if (end >= 0) slice = slice.slice(0, end);

  const tickets: PlanTicket[] = [];
  for (const o of scanJsonObjects(slice)) {
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    tickets.push({
      title,
      mission: typeof o.mission === "string" ? o.mission : undefined,
      what: typeof o.what === "string" && o.what.trim() ? o.what.trim() : title,
      criteria: Array.isArray(o.criteria)
        ? (o.criteria as unknown[]).filter((x): x is string => typeof x === "string")
        : ["Run the app and confirm the quality gap is addressed", "Existing verify commands still pass"],
      blocked_by: [],
      files: Array.isArray(o.files) ? (o.files as unknown[]).filter((x): x is string => typeof x === "string") : [],
      references: Array.isArray(o.references) ? (o.references as unknown[]).filter((x): x is string => typeof x === "string") : [],
      introduces: Array.isArray(o.introduces) ? (o.introduces as unknown[]).filter((x): x is string => typeof x === "string") : [],
      testable: typeof o.testable === "boolean" ? o.testable : false,
    });
  }
  return tickets.length > 0 ? tickets : null;
}

/**
 * Goal-loop convergence guard. Repeating a review on the same checkpoint only
 * makes sense when the finding set CHANGED. Two consecutive rounds with the
 * identical finding set mean the corrective cycle produced no observable
 * change — either the reviewer replayed stale state or its fixes landed as
 * no-ops. Observed in a real run (run-20260907-1340): a stale transcript made
 * three run-end rounds produce byte-identical findings, each regenerating the
 * same corrective tickets (three of four round-2 commits were literal no-ops
 * reusing HEAD). Finds equality modulo screenshot paths and whitespace, which
 * legitimately differ between rounds.
 */

/** Echo-robust comparison key: screenshot evidence paths and whitespace
 *  legitimately differ between rounds even when the finding text repeats. */
export function normalizeFinding(text: string): string {
  return text
    .replace(/\([^()]*(?:[/\\]|\.(?:png|jpe?g|webp))[^()]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Whether the current round's entire finding set duplicates the previous
 *  round's. An empty current set is not an echo — it has nothing to churn on. */
export function findingsEchoLastRound(previous: string[], current: string[]): boolean {
  if (current.length === 0) return false;
  const sort = (fs: string[]) => fs.map(normalizeFinding).sort().join("\n");
  return sort(previous) === sort(current);
}

/**
 * Issue #117: one group's worth of the plan still ahead of a checkpoint —
 * the group label plus its not-yet-built tickets (title + what). This is the
 * "remaining plan shape" the checkpoint reviewer needs to falsify "deferred
 * to a later group": a gap deferred to a group absent from the remaining list
 * is a gap the plan never covers.
 */
export interface RemainingPlanGroup {
  group: string;
  tickets: { title: string; what: string }[];
}

/**
 * Issue #117: group the plan's still-pending tickets by their group label,
 * preserving plan order (the caller passes tickets already file-sorted).
 * Pure context assembly — no I/O. Ungrouped tickets are skipped: they have no
 * group boundary a checkpoint reviewer could defer to, and they never fire a
 * group checkpoint themselves.
 */
export function remainingPlanGroups(
  pendingTickets: readonly { group?: string; title: string; what: string }[],
): RemainingPlanGroup[] {
  const byGroup = new Map<string, { title: string; what: string }[]>();
  for (const t of pendingTickets) {
    if (!t.group) continue;
    const list = byGroup.get(t.group) ?? [];
    list.push({ title: t.title, what: t.what });
    byGroup.set(t.group, list);
  }
  return [...byGroup.entries()].map(([group, tickets]) => ({ group, tickets }));
}

/**
 * Build the prompt for the goal-review agent (#19). The agent has bash access
 * (and may be vision-capable); it runs the app, captures screenshots if
 * applicable, and evaluates the build holistically against the ORIGINAL GOAL
 * and the planner's `design.md` (#34) — not against any single ticket's
 * acceptance criteria.
 *
 * This is a generalization of `buildVisualReviewPrompt` (visual.ts): same
 * plumbing (run the app, capture screenshots, interact), different judgment
 * frame (goal + design doc, not per-ticket ACs), different cadence (group
 * checkpoint boundary, not per-ticket or end-of-run).
 *
 * The prompt deliberately does NOT tell the agent HOW to capture a
 * screenshot — same rationale as visual review: different projects need
 * different capture paths.
 */
export function buildGoalReviewPrompt(options: {
  /** The original user prompt / goal the planner was given. */
  originalPrompt: string;
  /** The planner's design intent from `docs/design.md` (#34). When present,
   * the goal reviewer judges against this concrete vision instead of the
   * vague one-line prompt. */
  designDoc?: string | null;
  /** The coherence charter from `docs/coherence.md` (ADR 0028 / issue #99).
   * When present, the goal reviewer judges the whole app's CONFORMANCE to the
   * contract (tokens/layout/chrome), and revises the charter via `CHARTER:`
   * lines instead of flagging code the contract itself got wrong. */
  coherenceDoc?: string | null;
  /** The planner's architecture intent from `docs/architecture.md` (#34). */
  architectureDoc?: string | null;
  /** A one-line-per-entry summary of the cumulative public contracts at this
   * checkpoint — "what the system exposes right now." */
  contractsSummary?: string;
  /** The project's verify commands (build/test gate). */
  verifyCommands: string[];
  /** Best-guess launch command, derived from smoke or verify. */
  runCommandHint: string;
  /** Which group checkpoint this is (e.g. "gameplay" or "checkpoint-4"). */
  group: string;
  /** Groups already reviewed in prior checkpoints, so the reviewer knows what
   * was flagged before. */
  completedGroups: string[];
  /** Prior findings from earlier goal reviews, so the reviewer can confirm
   * earlier gaps were addressed. */
  priorFindings: string[];
  /** Project learnings (tooling facts from prior phases). */
  learnings?: string | null;
  /** Issue #50: rolling project digest. See ADR 0018. */
  digest?: string | null;
  /** Project-provided interaction hints. Same semantics as visual review's. */
  interactionHints?: string | null;
  /** Issue #97: the project's declared interaction interface (railhead.json /
   * planner $INTERFACE). When no human `interactionHints` are set, the
   * interface's `buildInteractionGuidance` row is injected — the goal seat
   * receives the same interaction discipline as the visual seat (fixing the
   * old asymmetry where goal computed and dropped `isGameCanvas`). */
  projectInterface?: ProjectInterface | null;
  /** The tickets in this checkpoint's group — what was supposed to be
   * delivered at this checkpoint. Without this, the reviewer has the original
   * goal but no mapping of which features are this group's responsibility vs
   * a later group's. A scaffold checkpoint evaluating against "retro-neon
   * snake with gliding movement" would flag the missing snake — but the snake
   * is a later group's deliverable, not a quality gap. */
  groupDeliverables?: { title: string; what: string }[];
  /** ADR 0040: acceptance criteria the builder recorded as unverified (it
   * emitted `$BLOCKED: verification-unavailable`; the work passed verify and
   * review, but no seat ever observed the criterion working). The reviewer
   * MUST check each one in its running pass — they are must-check items, not
   * context. */
  unverifiedCriteria?: string[];
  /** ADR 0043: whether the committed build contains the core loop yet. When
   * false (early group checkpoints) the required playthrough is scoped to THIS
   * group's deliverables — never the full loop — so a checkpoint cannot flag
   * features the plan has not built yet. Defaults to true. */
  coreLoopReady?: boolean;
  /** Tickets that have not yet been built — used at synthetic (cadence-based)
   * checkpoints where there's no group to scope to. Without this, the reviewer
   * sees the full original prompt and flags features that belong to unstarted
   * tickets as BLOCKERs. Listing what's still pending tells the reviewer which
   * gaps are "not yet built" (out of scope) vs "built wrong" (in scope). */
  pendingDeliverables?: { title: string; what: string }[];
  /** Issue #117: the groups still ahead after this checkpoint, in plan order,
   * each with its ticket titles. Lets the reviewer falsify "deferred to a
   * later group" — a gap deferred to a group not listed here is a gap the plan
   * never covers. */
  remainingGroups?: RemainingPlanGroup[];
  /** Issue #117: explicit marker when this is the plan's final group — no
   * group remains after it. The reviewer must judge against the FULL goal (the
   * run-end question) instead of passing on a per-group basis. */
  isFinalGroup?: boolean;
  /** ADR 0029 (#102): advisory-only group checkpoint (the light preset's see-
   * early/steer-early identity). Findings are recorded + steer the remaining
   * work (prior-findings channel, charter/digest amendments) and are fixed in
   * ONE corrective batch at run end — NOT inline, and nothing blocks the run.
   * Same concreteness bar: every finding must still be actionable later. The
   * markers/parsing are identical; only the framing, severity semantics, and
   * the dropped $REPLAN/$CORRECTIVE decomposition differ. */
  advisory?: boolean;
  /** ADR 0036: the railhead-measured vision capability of this seat's model.
   * Injected so a model cannot silently decide it "doesn't want" to read
   * screenshots — the measurement overrides any self-assessment. */
  visionCapability?: VisionCapabilityFact | null;
}): PhaseMessages {
  const {
    originalPrompt,
    designDoc,
    coherenceDoc,
    architectureDoc,
    contractsSummary,
    verifyCommands,
    runCommandHint,
    group,
    completedGroups,
    priorFindings,
    learnings,
    digest,
    interactionHints,
    projectInterface,
    groupDeliverables,
    pendingDeliverables,
    remainingGroups,
    isFinalGroup,
    unverifiedCriteria,
    coreLoopReady,
    advisory,
    visionCapability,
  } = options;

  const designBlock = designDoc
    ? `\n## Design intent (the planner's vision — judge against THIS, not just the prompt)\nThe Design intent section above is the planner's captured vision for this build — the concrete quality bar the goal reviewer evaluates against.`
    : "";

  const coherenceBlock = coherenceDoc
    ? `\n## Coherence contract (the visual design contract the build must conform to)\nThe Coherence contract section above is the planner's terse, normative visual contract (docs/coherence.md). Judge the build's CONFORMANCE to it, not vibes: are the charter's shared tokens imported rather than redefined, does the layout honor the model, does the chrome reuse the one recipe? A divergence the surface tickets could have avoided is a quality gap; a divergence that reveals the contract itself is wrong is a reason to revise the charter via a ${CHARTER_MARKER} line (below), not a finding against the code.`
    : "";

  const archBlock = architectureDoc
    ? `\n## Architecture intent (the planner's structural plan)\nThe Architecture intent section above is the planner's structural plan for this build.`
    : "";

  const contractsBlock = contractsSummary
    ? `\n## Current public contracts (what the system exposes right now)\n${contractsSummary}`
    : "";

  const verifyBlock = verifyCommands.length
    ? verifyCommands.map((c) => `- ${c}`).join("\n")
    : "- (no verify commands configured)";

  const priorBlock = priorFindings.length
    ? `\nPRIOR GOAL FINDINGS (from earlier group checkpoints — confirm each is now resolved before re-raising; do not repeat a resolved item):\n${priorFindings.join("\n")}`
    : "";

  const completedBlock = completedGroups.length
    ? `\nGroups already reviewed: ${completedGroups.join(", ")}`
    : "";

  const deliverablesBlock = groupDeliverables && groupDeliverables.length
    ? isFinalGroup
      ? `\n## What this group delivers — the plan's FINAL group\nThese are the tickets in the "${group}" group. They define the last increment of work, but because nothing follows them, the build must meet the FULL goal now: any capability the original goal requires that is absent here is a gap, not something a later group would deliver.\n${groupDeliverables.map((d) => `- ${d.title}: ${d.what}`).join("\n")}`
      : `\n## What this group delivers (scope at this checkpoint)\nThese are the tickets in the "${group}" group. Their deliverables define what was supposed to be built BY this checkpoint. Features not listed here are either built by earlier groups (already reviewed) or belong to later groups (not yet built — out of scope).\n${groupDeliverables.map((d) => `- ${d.title}: ${d.what}`).join("\n")}`
    : "";

  const unverifiedBlock = unverifiedCriteria && unverifiedCriteria.length
    ? `\n## Unverified acceptance criteria (the builder could not prove these)\nThe builder finished these tickets but reported it could not verify the criteria below with its own tools (a $BLOCKED: verification-unavailable exit). The work passed verify and review, but nobody has observed these working. Check EACH of them NOW in your running pass — they are must-check items. If one does not hold, it is a [BLOCKER]; if you genuinely cannot check one, say so explicitly and mark it unverified in your verdict.\n${unverifiedCriteria.map((c) => `- ${c}`).join("\n")}`
    : "";

  const pendingBlock = pendingDeliverables && pendingDeliverables.length
    ? `\n## Not yet built (out of scope at this checkpoint)\nThese tickets have not been started yet. Their features are planned for later — do NOT flag them as missing. Only flag gaps in features that were supposed to be built by now.\n${pendingDeliverables.map((d) => `- ${d.title}: ${d.what}`).join("\n")}`
    : "";

  const remainingGroupsBlock = remainingGroups && remainingGroups.length
    ? `\n## Remaining plan — the groups still ahead\nThis is the COMPLETE remainder of the plan after this checkpoint, in order, each group with its tickets. When you are tempted to defer a gap to a later group, it must be to a group below; a gap you defer to a group not listed here is a gap the plan never covers — flag it as a plan-scope gap.\n${remainingGroups.map((g) => `- ${g.group}:\n${g.tickets.map((t) => `  - ${t.title}: ${t.what}`).join("\n")}`).join("\n")}`
    : "";

  const finalGroupBlock = isFinalGroup
    ? `\n## Final group — judge the FULL goal\nThis is the LAST group in the plan; nothing is scheduled after it. Do NOT defer any gap to a later group — there is none. Evaluate the build against the ORIGINAL GOAL as a whole, the same question a run-end review asks: if a required capability is not present now, it is a real gap (flag it), never a "not yet built" deferral.`
    : "";

  const learningsBlock = learnings
    ? `\n## Project learnings (tooling facts from prior phases)\nThese are tooling/environment facts discovered by prior agents on this project. They are unverified model-claims, not tested facts. Most are safe to trust (a command that needs a flag, a port that isn't default). But a claim about YOUR OWN capabilities (e.g. "this model cannot read images") is a self-assessment that may be wrong — if such a claim would change your approach, TEST it once before deferring to it. If a learning turns out to be false, retract it with the ${RETRACTED_MARKER} marker below.\n${learnings.split("\n").map((l) => `- ${l}`).join("\n")}`
    : "";

  const digestBlock = buildDigestInjection(digest);

  const hintsBlock = interactionHints
    ? `\n## Interaction hints (project-provided)\n${interactionHints}`
    : projectInterface && buildInteractionGuidance(projectInterface)
      ? `\n## Interaction guidance (interface: ${projectInterface})\n${buildInteractionGuidance(projectInterface)}`
      : "";

  const visionBlock = visionCapabilityBlock(visionCapability ?? null, "goal");

  // ADR 0029 (#102): the advisory variant frames the checkpoint as the light
  // preset's see-early seat — findings recorded + steering applied, correction
  // deferred to the single run-end batch. Same markers and concreteness bar.
  const advisoryNote = advisory
    ? `\n\nADVISORY checkpoint (ADR 0029) — see early, steer early, correct ONCE:\nYour findings are RECORDED and STEER the rest of the run: they ride into every later review as prior findings, and your CHARTER:/DIGEST:/LEARNED: amendments (below) redirect later groups. They generate NO corrective tickets and do NOT block the run — the single corrective batch happens at run end, when a final whole-app review fixes what is still flagged. Keep the same concreteness bar as a corrective checkpoint: every finding must be actionable LATER ("the toolbar capture is broken; here is the file and the expected behaviour"), not vented now. Emitting a finding here never stalls the build.`
    : "";

  const severityBlock = advisory
    ? `## Severity (advisory checkpoint — nothing is corrected inline)\n\n- [BLOCKER] — a quality gap that means the build does not meet the goal yet. Recorded, steers the remaining groups, and is what the run-end corrective batch must close.\n- [MAJOR] — a real quality gap worth recording and steering, but the build essentially meets the goal at this checkpoint.\n\nSeverity still matters: the run-end batch and the report use [BLOCKER] to prioritize. Do not soften a real blocker to [MAJOR] because the checkpoint is advisory — the point is to see it early, not to hide it.`
    : `## Severity\n\n- [BLOCKER] — a quality gap that means the build does not meet the goal. Corrective tickets will be generated for these and block all remaining uncommitted tickets.\n- [MAJOR] — a real quality gap, but the build essentially meets the goal at this checkpoint. Advisory; does not block.`;

  // Issue #99: the goal reviewer is the charter's judge ONLY when the charter
  // exists — a pure-model plan has no docs/coherence.md, and telling a
  // reviewer to revise a file that does not exist would make it fabricate a
  // charter. The marker instructions ride with the charter block.
  const charterMarkerBlock = coherenceDoc
    ? `

## Coherence-charter revisions (issue #99 / ADR 0028)
If your whole-app review shows the coherence contract itself needs amending — a token, layout rule, or chrome recipe you now know is wrong — revise docs/coherence.md by emitting a line naming the fixed section and its REVISED content. The railhead applies the revision ${advisory ? "before the run-end corrective batch (no corrective tickets are generated at this advisory checkpoint — the amendment steers every remaining group, and the end-of-run fix targets the amended contract)" : "BEFORE generating corrective tickets from your findings"}:

${CHARTER_MARKER} Visual tokens: <the section's revised normative content — replaces the whole section>
${CHARTER_MARKER} Layout model: <...>
${CHARTER_MARKER} Chrome rules: <...>

Rules:
- One line, own line, beginning with the exact marker \`${CHARTER_MARKER}\`; the payload REPLACES that section's entire content in docs/coherence.md.
- Sequencing/precedence: ${advisory ? "the revision applies before the run-end corrective batch" : "the revision applies before corrective tickets are generated"}, and when a revision and one of your own findings conflict on the same aspect, the revision WINS — rescope or withdraw the finding so ${advisory ? "the eventual corrective targets" : "correctives target"} the amended contract, never the contract you just superseded.
- Omit entirely when the charter is accurate — silence is the correct signal. Do NOT emit \`${CHARTER_MARKER} NONE\`.`
    : "";

  const playthroughBlock = buildPlaythroughSection(originalPrompt, designDoc, { coreLoopReady: coreLoopReady ?? true });

  const roleBlock = `You are the Goal Reviewer at a group checkpoint in an unattended build (#19). You have bash access and may be vision-capable. Your job is NOT to check whether a single ticket's acceptance criteria are met — that is the ticket reviewer's job. Your job is to evaluate the CURRENT BUILD holistically against the ORIGINAL GOAL and the planner's design intent. Ask: "is this progressing toward the goal the user actually stated, or just toward the plan?"

This oversight seat is the intended consumer of the strong-model tier (ADR 0015) — goal review, not the implementer, is where a stronger model catches architectural drift the local model accumulates across tickets.

ORIGINAL GOAL/PROMPT (what the user asked for):
${originalPrompt}
${designBlock}${coherenceBlock}${archBlock}${contractsBlock}${completedBlock}${deliverablesBlock}${unverifiedBlock}${pendingBlock}${remainingGroupsBlock}${finalGroupBlock}

VERIFY COMMANDS (the project's build/test gate; useful to confirm the app builds, but your real test is to RUN it and evaluate it against the goal):
${verifyBlock}

HOW TO RUN THE APP (best guess — you may need to adapt; try the smoke command, the dev script, or run the binary):
${runCommandHint}${learningsBlock}${digestBlock}${hintsBlock}${visionBlock}

${SCRATCH_FILE_DISCIPLINE}

${BROWSER_HYGIENE}

${HALT_CONTRACT}

## Evaluation discipline

This is the group "${group}" checkpoint. All tickets in this group have committed. Evaluate the running build NOW — this is the earliest point the goal can be evaluated against a running system, not a spec.
${advisoryNote}

You MUST:
1. Launch the app and observe its current state. If it has a visual UI, capture screenshots and \`read\` them — a screenshot tool returns a PATH, not pixels; a vision-capable model receives the image only when it reads the file.
2. ${coreLoopReady === false
    ? "Drive every deliverable of THIS group end-to-end in the running app (see the group playthrough section below) — not a couple of isolated sample inputs. The full core loop is out of scope at this checkpoint."
    : "Play through the core loop to completion (see the core-loop playthrough section below) — a full cycle of the app's central mechanic, NOT a couple of isolated sample inputs."}
3. Judge the build against the ORIGINAL GOAL and the design intent above — not against any single ticket's acceptance criteria. The question is "is this the thing we were asked to build?" not "does function X exist."
${priorBlock}

${playthroughBlock}

## What to flag

Flag QUALITY GAPS that ticket-level review cannot catch — these are the exact failure mode the goal review exists to surface:

- The build is technically correct but missing the aesthetic/visual identity the design doc described (flat rectangles where the design called for parallax, no palette cohesion, missing effects).
- The build is functional but not fun / not fast / not usable enough to meet the goal.
- A system was built in isolation but does not integrate coherently with the rest (the renderer draws, the juice system applies, but they do not feel like one product).
- An assumption the plan made turned out wrong (flat rectangles were "acceptable" for the renderer; the goal says otherwise).

Do NOT flag:
- Style preferences or nits (alignment by 1px, naming, formatting) — those belong in per-ticket review.
- Compilation or test failures — verify already gated those.
- Features that are in later tickets not yet built — check the goal's expectation against what THIS group was supposed to deliver.

Each finding must be CONCRETE and ACTIONABLE — vague "it does not feel right" is useless to the implementer. Describe the gap in terms the corrective ticket can turn into acceptance criteria: "The renderer draws flat rectangles; the design doc says 'desaturated palette with parallax backgrounds' — add at least 3 background layers moving at 0.5x camera speed."

## Blocker evidence (enforced at strict checkpoints)

A [BLOCKER] must satisfy both of these:
1. **Evidence in the CURRENT tree** — cite a screenshot path under the .railhead/ directory (one you took this pass) or a file path that exists now. A blocker supported only by reasoning about absent code is not actionable.
2. **In scope for THIS checkpoint** — it must concern a deliverable of this group's tickets, the running build's integration, or a clause of the coherence charter. A finding whose only support is a file owned by an unbuilt ticket is out of scope: record it at most as a [MAJOR] note.

The railhead verifies this: a [BLOCKER] naming no existing artifact, or naming only files owned by unbuilt tickets, is recorded for steering and generates NO corrective ticket.

${severityBlock}

## Reusable tooling facts (push)

You are running the app and sending inputs — if you discovered a non-obvious tooling or environment fact a fresh agent would have to rediscover, emit it on its own line after $END:

${LEARNED_MARKER} <one terse line, self-contained, no preamble>

Rules:
- One line, beginning with the exact marker \`${LEARNED_MARKER}\`. Mid-sentence mentions are ignored.
- Omit it entirely if you discovered nothing reusable. Do NOT emit \`${LEARNED_MARKER} NONE\`.
- Tooling/environment facts only. If in doubt, omit.

If a prior learning injected above is WRONG — you verified it does not hold — emit a retraction:

${RETRACTED_MARKER} <the prior learning text, or enough of it to uniquely identify the line>

## Digest update (architectural state summary)
If you observed a key architectural decision, module shape change, or structural milestone reached at this checkpoint — one a future ticket's implementer would benefit from knowing — emit it as a digest line:

${DIGEST_MARKER} <one terse line: "Module X built using pattern Y" or "Contracts index now includes Z">

Rules:
- One line, beginning with the exact marker \`${DIGEST_MARKER}\`.
- Architectural state only, not tooling facts (those go in \`${LEARNED_MARKER}\`).
- Omit if nothing structurally significant changed.
${charterMarkerBlock}
Reply terse, no prose narration. Emit EXACTLY one of these markers:

$GOAL_PASS
$END

or

$GOAL_FAIL
[BLOCKER] or [MAJOR] — one finding per line, with screenshot path in parentheses if applicable
$END
${advisory ? "" : `
## Replan signal (issue #65)

If the findings indicate the PLAN was structurally wrong — tickets composed in ways the planner didn't anticipate, modular assumptions that diverged from what was actually built, dead code or duplicated systems meaning the remaining tickets build on a broken foundation — ALSO emit, AFTER the $END above:

$REPLAN
$END

If the findings are implementation gaps (missing features, broken integrations, quality shortfalls that can be fixed with targeted patches), do NOT emit $REPLAN — the corrective-ticket mechanism handles those.

## Corrective-ticket decomposition hints (issue #67)

For each [BLOCKER] you emit, you MAY suggest how the repair should be decomposed into corrective tickets — you ran the app and traced the code, so you know the file-level split better than the mechanical one-ticket-per-finding generator. Emit a $CORRECTIVE block AFTER the $END above, one JSON object per suggested ticket, then close with its own $END:

$CORRECTIVE
{"title":"Replace placeholder entity rendering with real sprites","what":"Replace flat shape drawing with generated textured sprites from the project palette.","files":["src/scenes/GameScene.ts"],"references":["GameScene","BIOME_1_CONFIG"],"introduces":[],"testable":false}
{"title":"Add depth bands to the background renderer","what":"Add >=3 scroll-factor layers with distinct color palettes.","files":["src/ui/ParallaxBackground.ts"],"references":["ParallaxBackground","FAR_FACTOR","NEAR_FACTOR"],"introduces":[],"testable":false}
$END

Rules:
- One JSON object per suggested corrective ticket, each on its own line between $CORRECTIVE and $END.
- Each object has title, what, files[], references[], introduces[], and testable.
- Emit this ONLY when it improves on the mechanical split. If you have no decomposition to offer, omit the block entirely.
- Do NOT emit both $REPLAN and $CORRECTIVE — if you emit $REPLAN, the corrective block is ignored.`}`;

  return {
    preamble: renderPreamble({
      design: designDoc ?? null,
      architecture: architectureDoc ?? null,
      coherence: coherenceDoc ?? null,
    }),
    task: roleBlock,
  };
}

/**
 * Issue #66: pull source-file paths out of a goal-review finding so a
 * corrective ticket's `files` list points the implementer at what to read/edit.
 * The mechanical split previously emitted `files: []`, so the implementer
 * started blind — it had to rediscover every file the finding named, burning
 * context budget on reads and greps.
 *
 * Matches relative/absolute source paths with a known source/config extension,
 * stopping at any trailing `:line` or `:line-line` range. Screenshot paths
 * (`.railhead/.../*.png`) are deliberately excluded — they are evidence to
 * read, not source to edit. Pure; no I/O.
 */
const SOURCE_FILE_RE = /(?:\.\.\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.(?:ts|tsx|mjs|js|cjs|jsx|rs|py|go|c|cpp|cc|cxx|h|hpp|hh|java|kt|kts|rb|php|cs|vue|svelte|scss|css|html|json|toml|yaml|yml|md)/gi;

export function extractFindingFiles(text: string): string[] {
  const out: string[] = [];
  const noUrls = text.replace(/https?:\/\/\S+/gi, "");
  for (const m of noUrls.matchAll(SOURCE_FILE_RE)) {
    const cleaned = m[0]
      .replace(/:\d+(?:-\d+)?$/g, "") // drop a trailing :line-range
      .replace(/[(),;.]+$/g, ""); // drop trailing punctuation
    if (cleaned.startsWith(".railhead/")) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/** `.railhead/...png|jpg` evidence paths cited by a finding. Kept separate from
 * SOURCE_FILE_RE, which deliberately excludes .railhead paths because they are
 * evidence, not source to edit. */
export function extractScreenshotPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\.railhead\/[\w@./-]+\.(?:png|jpe?g|webp)/gi)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** ADR 0043: the evidence rule for strict goal checkpoints, as pure logic.
 * Splits a verdict's findings into the corrective-eligible set and the
 * blockers that fail the rule. Non-blockers pass through untouched (the
 * corrective pipeline only acts on blockers; majors/minors are steering). A
 * blocker fails when it cites no artifact that exists in the current tree, or
 * when every existing artifact it names is owned by an unbuilt (pending)
 * ticket — future scope is never a blocker at this checkpoint. `exists` is
 * injected so the rule is testable without a filesystem. */
export function splitAnchoredBlockers(
  findings: string[],
  opts: {
    exists: (path: string) => boolean;
    pendingFiles: ReadonlySet<string>;
  },
): { findings: string[]; unanchored: { finding: string; reason: string }[] } {
  const kept: string[] = [];
  const unanchored: { finding: string; reason: string }[] = [];
  for (const finding of findings) {
    if (!isBlocker(finding)) {
      kept.push(finding);
      continue;
    }
    const files = extractFindingFiles(finding);
    const screenshots = extractScreenshotPaths(finding);
    const existing = files.filter((f) => opts.exists(f));
    const existingShots = screenshots.filter((p) => opts.exists(p));
    if (existing.length === 0 && existingShots.length === 0) {
      unanchored.push({ finding, reason: "cites no artifact that exists in the current tree (needs a screenshot or a file present now)" });
      continue;
    }
    if (existingShots.length === 0 && existing.length > 0 && existing.every((f) => opts.pendingFiles.has(f))) {
      unanchored.push({ finding, reason: "names only files owned by unbuilt tickets (later scope is not a blocker at this checkpoint)" });
      continue;
    }
    kept.push(finding);
  }
  return { findings: kept, unanchored };
}

/**
 * Issue #66: pull likely contract/symbol names out of a finding so a corrective
 * ticket's `references` list tells the implementer which existing contracts to
 * honor. Three unambiguous shapes are extracted:
 *   - SCREAMING_SNAKE constants (TILE_SIZE, BIOME_2_CONFIG, WORLD_GRAVITY)
 *   - PascalCase multi-word identifiers (GameScene, ParallaxBackground) —
 *     requires two fused capitalized words so prose words like "The" don't match
 *   - backtick-quoted identifiers (`applyHazard`) — findings often quote symbols
 *
 * Pure; no I/O. camelCase prose is deliberately not matched (too noisy); the
 * structured $CORRECTIVE path (issue #67) is the higher-fidelity source when
 * the reviewer emits one.
 */
const SCREAMING_CONST_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const PASCAL_MULTIWORD_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const BACKTICK_SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]*)`/g;

export function extractFindingReferences(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (s && !out.includes(s)) out.push(s); };
  for (const m of text.matchAll(SCREAMING_CONST_RE)) add(m[0]);
  for (const m of text.matchAll(PASCAL_MULTIWORD_RE)) add(m[0]);
  for (const m of text.matchAll(BACKTICK_SYMBOL_RE)) add(m[1]);
  return out;
}
