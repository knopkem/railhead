import { readProjectDoc } from "../core/git.ts";
import { renderContracts, type ContractsIndex } from "../core/contracts.ts";
import { LEARNED_MARKER, RETRACTED_MARKER } from "./learnings.ts";
import { visionCapabilityBlock, type VisionCapabilityFact } from "../execute/vision-probe.ts";
import { buildDigestInjection } from "./digest.ts";
import { HANDOFF_START, HANDOFF_END } from "./handoff.ts";
import { CHARTER_DOC } from "./coherence.ts";
import { renderPreamble, renderTask, type PhaseMessages } from "./preamble.ts";

/** Load a project doc for the canonical preamble. A missing file renders an
 *  explicit placeholder so the model can tell "checked and absent" from "not
 *  part of this phase's stable inputs". */
async function readPreambleDoc(cwd: string, name: string): Promise<string> {
  return (await readProjectDoc(cwd, name)) ?? "_(not present in this repo)_";
}

/** One-line design pointer a NON-surface ticket carries instead of the full
 *  visual narrative (ADR 0028): the narrative is surface-scoped pollution for
 *  a model ticket, but the file pointer survives so a ticket that turns out to
 *  render UI is not blind. */
const DESIGN_POINTER_BLOCK = `\nThis build has a visual design narrative (docs/design.md) and possibly a coherence charter (${CHARTER_DOC}); this ticket is not classified as surface-scoped, so they are not injected. Read them only if your work turns out to touch the rendered surface.`;

/** The seat-specific instruction for the canonical preamble's Coherence
 *  contract section. The charter CONTENT lives in message 1 (see
 *  `renderPreamble`); the implementer's honor-frame and the reviewer's
 *  judge-frame stay here in message 2 — one builder so the two seats cannot
 *  drift. */
function coherenceRequestBlock(frame: "honor" | "judge"): string {
  return frame === "honor"
    ? `## Coherence contract (visual design contract — HONOR IT EXACTLY)\nThe Coherence contract section above is the planner's terse, normative visual contract, authored at plan time. This ticket touches the rendered surface, so honor its Visual tokens, Layout model, and Chrome rules EXACTLY: import the shared constants module it names rather than redefining palette/spacing/type/radius values, and do not introduce a competing style or panel/button recipe. Read ${CHARTER_DOC} from the repo if you need more than the sections shown.`
    : `## Coherence contract (visual design contract — VERIFY CONFORMANCE)\nThe Coherence contract section above is the planner's terse, normative visual contract, authored at plan time. This ticket touches the rendered surface, so verify the diff HONORS the shared constants module the charter names and the Chrome rules: a redefined token, a competing style, or a chrome-rule violation in the diff is a review finding. Chrome conformance is visible in a diff — this is the earliest, cheapest detection point, before any goal review fires.`;
}

/** The seat-specific instruction for the canonical preamble's Design intent
 *  section. The narrative itself is message 1; the implementer's "build
 *  toward it" and the reviewer's "judge the diff against it" framing live
 *  here. */
function designRequestBlock(frame: "implement" | "review"): string {
  return frame === "implement"
    ? `## Design intent (planner's vision for this build)\nThe Design intent section above is the planner's captured vision — read it so your implementation matches the envisioned aesthetic, narrative, and quality bar, not just the ticket's acceptance criteria.`
    : `## Design intent (planner's vision)\nThe Design intent section above is the planner's captured vision. Judge whether the diff matches the envisioned aesthetic, narrative, and quality bar — not just whether the ticket ACs are met.`;
}

/** The seat-specific instruction for the canonical preamble's Architecture
 *  intent section. */
function architectureRequestBlock(frame: "implement" | "review"): string {
  return frame === "implement"
    ? `## Architecture intent (planner's structural plan)\nThe Architecture intent section above is the planner's captured module map and cross-cutting concerns — read it so your implementation follows the planned structure.`
    : `## Architecture intent (planner's structural plan)\nThe Architecture intent section above is the planner's structural plan. Judge whether the diff follows the planned module map and cross-cutting concerns.`;
}

/** Issue #72: browser-tab hygiene for phases that may drive a browser. The
 * chrome-devtools / playwright MCP servers share ONE persistent browser across
 * every opencode subprocess AND across sibling projects, so pages opened by a
 * prior phase linger — 20+ orphaned tabs accumulate over a run and a stale
 * page from a sibling project on the same port is mistaken for this project's
 * running app. The railhead cannot drive the MCP itself (ADR 0001: the browser
 * tools live inside the agent's subprocess), so the deterministic seam is the
 * prompt: the model that opens pages is the only party that can close them.
 * Injected into implementer (vision-capable), visual-review, and goal-review
 * prompts. */
export const BROWSER_HYGIENE = `## Browser hygiene
If your environment exposes browser/tab tools (${"`"}chrome-devtools_*${"`"}, ${"`"}playwright_browser_*${"`"}, ${"`"}browser_*${"`"}), stale pages from EARLIER PHASES or SIBLING PROJECTS may still be open in the shared browser — their screenshots and state are not evidence about this project. Before opening any page, list the open pages and close every one that is not this project's app; never judge this project by a page whose URL/port is not the server you started for it. When you finish your screenshots, close the pages you opened so the next phase starts clean.`;

/** Keep scratch files inside the repo so opencode's external_directory permission
 * policy never blocks them. The visual/goal review agents need to redirect
 * dev-server output and read it back; writing to /tmp triggers an auto-reject
 * in non-yolo mode, which makes the review go inconclusive (ADR 0009: no
 * evidence must never be coerced into a pass). */
export const SCRATCH_FILE_DISCIPLINE = `## Scratch files
When you need to redirect command output to a file (e.g. capturing a dev server's startup log), write it under .railhead/ in this repo — never to /tmp or other external paths. The railhead pre-grants /tmp as a fallback, but .railhead/ is always safe and keeps everything self-contained. For example: ${"`"}npx vite &>.railhead/server.log & sleep 2; cat .railhead/server.log${"`"}.

Never remove or modify the .railhead/ directory itself or anything under .railhead/run-* — that is the railhead's own run state (its ledger), not scratch. Clean only the specific scratch files you created (e.g. .railhead/server.log), never with a recursive delete of .railhead/.`;

/** gh #111: the halt-signal contract every judgment seat receives. A phase can
 * write `.railhead/STOP` to stop the whole run and ask for a human. Framed as
 * "only when genuinely warranted" so it is not abused as an escape hatch for a
 * hard ticket or a failing gate — those have their own machinery. */
export const HALT_CONTRACT = `## Halt signal (only when genuinely warranted)
If the plan or environment is FUNDAMENTALLY wrong — continuing would stack bad work on a broken foundation, and a human should look before anything else runs — you may halt the whole run by writing your reason to the file ${"`"}.railhead/STOP${"`"} (create it; its contents are your reason, free-form). The run stops at your next output line and a human decides what to do.

Do NOT use this as an escape from a hard ticket, a failing gate, or retry pressure. Those have their own machinery: review feedback, the retry/failure ladder, corrective tickets. Use the halt signal ONLY for a real "this needs a human" conclusion (the plan is wrong, the environment is broken) — not for "this ticket is hard."`;

export interface Runnable {
  generate: () => Promise<string>;
}

/** Issue #45: the RED/GREEN evidence check item injected into both reviewer
 * prompt variants when the ticket has a test phase. The reviewer never sees
 * the implementer's transcript — it judges evidence from the diff or the
 * touched files alone. `evidenceSource` is the noun phrase for what the
 * reviewer inspects ("the diff" or "the touched files") so the same wording
 * serves both prompt variants without duplication. Returns "" when the
 * ticket is not testable. */
function redGreenEvidenceCheckItem(
  testable: boolean | undefined,
  fixMode: boolean | undefined,
  evidenceSource: "diff" | "touched files",
): string {
  if (!testable) return "";
  const num = fixMode ? "6" : "5";
  const testCode = evidenceSource === "diff"
    ? "the diff contains NO test code at all (no new or modified test file exercising the acceptance criteria), OR the diff's tests could not plausibly have gone red→green"
    : "NO test file in the touched-files list exercises the acceptance criteria, OR the tests you read could not plausibly have gone red→green";
  return `
${num}. RED/GREEN evidence: this ticket was marked testable, so the implementer was asked to include a red→green evidence block in its report (a RED run with the failing command + relevant failing output + why the failure was expected, and a GREEN run with the passing command + relevant passing output). The implementer's transcript is NOT in front of you — judge red/green evidence from ${evidenceSource} alone. If ${testCode} against the implementation change (e.g. the assertion recomputes the answer the way the code does, the test mocks the very behaviour it claims to verify, or the test would already pass before this change was applied), treat that as missing or implausible red/green evidence and flag it as [MAJOR]. This is a trust check on whether real tests went red then green — it is distinct from "test quality / thoroughness" opinions, which remain out of scope. Do NOT raise this as [BLOCKER] — the verify gate already confirmed the suite passes now; the finding is about whether the change carries evidence the implementer observed the red→green transition it describes, not about correctness.`;
}

/** One round of prior implement→review on the same ticket (#16). The fresh-
 * context implementer has no memory of what it already tried, so the loop
 * converges on the same fix. This record gives it just enough history to
 * diverge: the finding text (so it can see the pattern) and optionally the
 * approach summary (from the prior attempt's handoff). */
export interface AttemptRound {
  attempt: number;
  findings: string[];
  approach?: string;
}

export async function buildImplementerPrompt(
  options: {
    cwd: string;
    ticketFile: string;
    mission: string;
    ticketBody: string;
    criteria: string[];
    verify: string[];
    prevFeedback: string | null;
    /** Working diff from the previous attempt, carried only on a REVIEW retry
     * (verify-failure retries clean the worktree). When present, the
     * implementer is told to PATCH this diff, not regenerate from scratch. */
    priorDiff?: string | null;
    /** Distilled handoff from the previous failed attempt (issue #9): a 1-2k
     * token "what was tried / why it failed / suggested next" summary parsed
     * from the prior attempt's `$HANDOFF ... $END` block. When present, this
     * SUBSTITUTES for `priorDiff` — the raw diff is the bloat (5-10k tokens at
     * the 64k budget) the handoff was introduced to shed. Falls back to
     * `priorDiff` when null (push failed, or first attempt). */
    prevHandoff?: string | null;
    /** Prior attempt rounds on this ticket (#16): each carries the findings
     * that blocked it and optionally the approach summary. Injected as a compact
     * block so a fresh-context implementer can see "I already tried X and it
     * got rejected for Y" instead of converging on the same fix. */
    attemptHistory?: AttemptRound[];
    contracts?: ContractsIndex;
    /** Model context-window size in tokens; guides the worker to stay within budget. */
    contextBudget?: number;
    /** Project learnings (tooling facts from prior phases). Injected as a
     * `## Project learnings` section so the model sees tooling discoveries
     * made by prior agents on this project. See ADR 0012. */
    learnings?: string | null;
    /** Fix mode (issue #6): when true, inject the diagnosing-bugs discipline
     * (build a reproducer before hypothesizing, minimize, rank 3-5 falsifiable
     * hypotheses, change one variable at a time, write the regression test
     * before the fix, clean up debug logs). The railhead owns the environment,
     * so the interactive skill's "ask the user for access" escape hatch
     * collapses to "mark the ticket inconclusive." */
    fixMode?: boolean;
    /** Issue #34: the planner's design intent (redefined goal, visual identity,
     * quality bar). When present, injected so the implementer reconstructs
     * the planner's aesthetic/narrative vision instead of reverse-engineering
     * intent from a symbol list. */
    designDoc?: string | null;
    /** Issue #34: the planner's architecture intent (module map, rationale).
     * When present, injected so the implementer understands the planned
     * structure and cross-cutting concerns. */
    architectureDoc?: string | null;
    /** Issue #99 (ADR 0028): whether this ticket touches the rendered surface.
     * Gates the visual design NARRATIVE (`designDoc`) — only surface tickets
     * get it in full; a non-surface ticket gets at most a one-line pointer.
     * The architecture doc is NOT surface-gated (the module map is a model
     * ticket's audience too). Undefined behaves as surface (back-compat with
     * callers that pass a narrative and expect it injected). */
    surface?: boolean;
    /** Issue #99 (ADR 0028): the coherence charter (docs/coherence.md content)
     * for a SURFACE ticket. Injected so the implementer honors the plan-time
     * visual contract rather than inventing its own chrome. */
    coherenceDoc?: string | null;
    /** Issue #45: when true, the ticket has a testable seam and the test
      * phase ran — inject a RED/GREEN evidence requirement so the reviewer
      * can audit red→green behaviour from the diff alone. `false` (pure
      * config / manifest / docs tickets, or test phase opted out) omits
      * cleanly. */
    testable?: boolean;
    /** Issue #50: rolling project digest — architectural state summary from
      * prior checkpoints. Injected so the implementer sees structural context
      * accumulated across tickets. See ADR 0018. */
    digest?: string | null;
    /** ADR 0036: the railhead-measured vision capability of this seat's model.
     * Injected for surface tickets so a capable implementer self-checks with
     * pixels, and a blind one does not claim visual verification. */
    visionCapability?: VisionCapabilityFact | null;
  },
): Promise<PhaseMessages> {
  const { cwd, ticketFile, mission, ticketBody, criteria, verify, prevFeedback, priorDiff, prevHandoff, attemptHistory, contracts, contextBudget, learnings, fixMode, designDoc, architectureDoc, surface, coherenceDoc, testable, digest, visionCapability } =
    options;

  const criteriaBlock = criteria.length
    ? criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- (no acceptance criteria listed)";

  const verifyBlock = verify.length
    ? verify.map((c) => `  - ${c}`).join("\n")
    : "  - (none configured)";

  // When the prior attempt emitted a $HANDOFF block (#9, failed attempt) OR
  // the test phase ran (#5, test author's guidance), inject the distilled
  // handoff IN PLACE OF the raw prior diff. For #5, the handoff seeds the
  // FIRST implement attempt even when prevFeedback is null — the test author's
  // "what the tests assert / where to look" is guidance the implementer needs
  // before writing a line. For #9, it substitutes for priorDiff on retries
  // where prevFeedback is already present. When no handoff exists (push
  // failed, or first attempt with no test phase), falls back to priorDiff.
  const handoffBlock = prevHandoff
    ? `\n## Handoff from the previous ${prevFeedback ? "attempt" : "test phase"}\n\n${prevFeedback ? "The previous attempt failed and emitted this handoff summary. Read it before re-reading any diff — it names what was tried and what to try next, so you do not re-derive the prior attempt's reasoning from its raw diff." : "The test phase wrote failing tests for this ticket and emitted this handoff. It names what each test asserts and where to look — read it before writing implementation, so your code targets the tests the railhead will run against you."}\n${prevFeedback ? `\n${prevFeedback}\n` : ""}\n--- handoff ---\n${prevHandoff}`
    : "";
  const feedbackBlock = prevFeedback
    ? prevHandoff
      ? ""
      : priorDiff
        ? `\n## Reviewer feedback from the previous attempt (PATCH, do NOT rewrite)\n\nYour previous attempt is already on disk. It was MOSTLY CORRECT — the review found addressable issues, not a wholesale rewrite mandate. Make TARGETED edits to the specific findings below against your existing code. Do NOT regenerate files that already work; do NOT restructure working modules; edit only what the findings name. Anything you rewrite from scratch is a fresh roll of the dice that can introduce NEW severe bugs.\n\n${prevFeedback}\n\n--- previous attempt's working diff ---\n${priorDiff}`
        : `\n## Reviewer feedback from the previous attempt\n\n${prevFeedback}\n\nFix every "must-fix" item and keep the "already-resolved" ones as they are.`
    : "";

  const historyBlock = attemptHistory?.length
    ? `\n## Attempt history (you have fresh context — read this before editing)\nThis is NOT your first attempt. Previous attempts are summarized below. READ THIS FIRST so you do not repeat an approach that already failed. If a finding appears across multiple attempts, the same fix has already been tried and rejected — try a DIFFERENT approach.\n${attemptHistory.map((r) => {
  const approach = r.approach ? `\n  Approach: ${r.approach}` : "";
  return `\n### Attempt ${r.attempt}\n  Findings: ${r.findings.length ? r.findings.join("; ") : "(verify/smoke failure)"}${approach}`;
}).join("\n")}`
    : "";

  const contractBlock = contracts?.entries.length
    ? `\n## Existing public contracts you must REUSE or EXTEND (do not create duplicates)
These are the interfaces already in the repo that this ticket should build on. Honor their signatures exactly:
${renderContracts(contracts)}`
    : "";

  // Issue #34: the planner's design and architecture intent are STABLE inputs:
  // they live in the canonical preamble (message 1) so they sit before every
  // volatile byte. Issue #99 (ADR 0028) still gates the design NARRATIVE —
  // a non-surface ticket gets the preamble without it and a one-line pointer
  // in the task instead; the architecture doc stays for ALL tickets (the
  // module map is precisely the model ticket's audience).
  const designDocBlock = surface !== false && designDoc
    ? designRequestBlock("implement")
    : surface === false && designDoc
      ? DESIGN_POINTER_BLOCK
      : "";
  const coherenceBlockText = surface !== false && coherenceDoc
    ? coherenceRequestBlock("honor")
    : "";
  const architectureDocBlock = architectureDoc
    ? architectureRequestBlock("implement")
    : "";

  const learningsBlock = learnings
    ? `\n## Project learnings (tooling facts from prior phases)\nThese are tooling/environment facts discovered by prior agents on this project. They are unverified model-claims, not tested facts. Most are safe to trust (a command that needs a flag, a port that isn't default). But a claim about YOUR OWN capabilities (e.g. "this model cannot read images") is a self-assessment that may be wrong — if such a claim would change your approach, TEST it once before deferring to it. If a learning turns out to be false, retract it with the ${RETRACTED_MARKER} marker below.\n${learnings.split("\n").map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const digestBlock = buildDigestInjection(digest);
  const implementVisionBlock = surface !== false ? visionCapabilityBlock(visionCapability ?? null, "implement") : "";

  // Fix-mode discipline (issue #6): the diagnosing-bugs skill ported for an
  // unattended railhead. The model MUST build a reproducer before hypothesizing
  // — small models fixate on the first plausible idea, never instrument, never
  // minimize. This block is injected only when config.fix_mode is true (set by
  // `railhead fix`). The interactive skill's "ask the user for access" escape
  // hatch collapses to "mark the ticket inconclusive" — the railhead owns the
  // environment (cwd), so there is nothing to ask for.
  const fixModeBlock = fixMode
    ? `
## Diagnosing-bugs discipline (fix mode)
This is a BUG FIX, not a new build. The ticket body contains reproduction steps. Follow these phases IN ORDER — skipping ahead to a hypothesis without a reproducer is the exact failure this discipline prevents.

### Phase 1: Build a feedback loop (THIS IS THE DISCIPLINE)
Before writing ANY fix, build a tight, red-capable reproducer — one command you have ALREADY RUN that goes red on this bug and will go green once fixed. Be aggressive and creative: failing test, curl/HTTP script, CLI invocation with a fixture, headless browser script, replay a captured trace, throwaway railhead, property/fuzz loop, git-bisect railhead, differential loop. Pick the tightest loop that reaches the bug's code path and asserts the USER'S EXACT symptom (not "didn't crash" — it must catch THIS specific bug).

Tighten it: make it fast (seconds, not minutes), deterministic (pin time, seed RNG, isolate the filesystem), and sharp (assert the specific symptom, not a vague "works"). A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is a debugging superpower.

If you genuinely cannot build a loop, say so explicitly in your output — list what you tried, then emit DONE with no changes. Do NOT proceed to hypothesizing without a reproducer. No red-capable command, no fix.

### Phase 2: Minimize
Once red, shrink the repro to the smallest scenario that still goes red. Cut inputs, callers, config, data, and steps ONE AT A TIME, re-running the loop after each cut. Keep only what is load-bearing for the failure. A minimal repro shrinks the hypothesis space and becomes the regression test in Phase 5.

### Phase 3: Hypothesize (3-5 ranked, falsifiable)
Generate 3-5 ranked hypotheses BEFORE testing any. Single-hypothesis generation anchors on the first plausible idea — that is the failure mode this prevents. Each hypothesis must be falsifiable: state the prediction in the form "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse." If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it. Document your ranked list in the output (for human audit), then proceed with your own ranking.

### Phase 4: Instrument (one variable at a time)
Each probe maps to a specific prediction from Phase 3. Change ONE variable at a time. Prefer a debugger/REPL breakpoint over logs; when logs are needed, place them at the boundaries that distinguish hypotheses. NEVER "log everything and grep." Tag every debug log with a unique prefix (e.g. [DEBUG-a4f2]) so cleanup is a single grep at the end.

### Phase 5: Fix + regression test
Write the regression test BEFORE the fix — turn the minimized repro into a failing test at the correct seam (a seam that exercises the real bug pattern at the call site, not a shallow unit test that can't replicate the failure). Watch it fail. Apply the fix. Watch it pass. Re-run the Phase 1 feedback loop against the original un-minimized scenario. If no correct seam exists, that itself is the finding — note it in your output (the codebase architecture is preventing the bug from being locked down).

### Phase 6: Cleanup
Before declaring DONE: (1) re-run the original reproducer — it must no longer reproduce; (2) the regression test passes (or the absence of a correct seam is documented); (3) grep for your [DEBUG-...] prefix and remove every tagged log line; (4) delete any throwaway reproducer scripts (or move them to a clearly-marked debug location); (5) state which hypothesis turned out correct in your output, so the next debugger learns.
`
    : "";

  const [agents, context] = await Promise.all([
    readPreambleDoc(cwd, "AGENTS.md"),
    readPreambleDoc(cwd, "CONTEXT.md"),
  ]);

  const preamble = renderPreamble({
    mission,
    agents,
    context,
    design: surface !== false ? designDoc : null,
    architecture: architectureDoc,
    coherence: surface !== false ? coherenceDoc : null,
  });

  // Issue #45: a small-context implementer may claim DONE on code it never
  // ran the suite against — verify catches that, but the reviewer can only
  // audit red→green if the implementer's report actually carries the
  // transcript. Gate on "test phase ran" so the requirement is omitted for
  // pure-config tickets and when the user opted out of the test phase (no
  // pre-written tests to red→green against).
  const evidenceBlock = testable
    ? `
## RED/GREEN evidence (required in your final report)
This ticket has a testable seam, so your final report MUST include a red→green evidence block BEFORE the DONE marker, in exactly this form:

RED
<the command you ran to see the test fail, before implementation — the project's own test command scoped to the test file this ticket targets>
<the relevant failing output — 5-15 lines pasted from the run, not a paraphrase>
<why the failure was expected at this point — one line: the function/type/behaviour did not exist yet, or the assertion exercised not-yet-implemented logic>

GREEN
<the command you ran to see the test pass, after implementation — the project's actual verify/test command>
<the relevant passing output — 5-15 lines pasted from the run>

Rules:
- The RED run must be a command you ACTUALLY EXECUTED, with output pasted from the run — not a prediction. If you did not run the suite before implementing (e.g. you followed "Build early, build often" and built incrementally), you may reconstruct the red state by reverting your implementation change, running the test, then re-applying it.
- The GREEN run must be the project's actual verify/test command, not a one-off compile check.
- If the test phase wrote tests you are satisfying, the RED evidence is the test-phase failure (re-run it to capture the output if you did not capture it during implement).
- A report that claims DONE without a RED/GREEN evidence block is treated by the reviewer as a missing-evidence finding and may be sent back.
`
    : "";

  const roleBlock = `You are the Implementer for one ticket of an unattended build. Work only within this ticket's scope; the acceptance criteria are the contract.

The contracts you list under "expected new contracts" (introduces) are load-bearing: later tickets in this build will consume them by name. Design their interfaces accordingly, since re-deriving or renaming them later is expensive.

## Fresh context, small model
This is a small-context run. Keep your edits minimal and targeted. The full repo may exceed your window — that is expected. Do not read entire large files; use targeted reads/greps. Do NOT re-derive interfaces that already exist — use the contracts listed above and the specific files the ticket names.${contextBudget ? `\nYour context window is budgeted to roughly ${Math.floor(contextBudget / 1000)}k tokens — keep reads small and edits targeted so you do not run out.` : ""}

## Lazy code discipline
Before writing any code, stop at the first rung that holds:
1. Does this need to exist? (YAGNI — skip if not)
2. Already in this codebase? (reuse it, don't rewrite)
3. Does the stdlib do it? (use it)
4. Native platform feature? (use it)
5. Installed dependency? (use it)
6. One line? (one line)
7. Only then: write the minimum that works.

The ladder runs AFTER you understand the problem: read the code the ticket touches, trace the real flow, then climb. Lazy about the solution, never about reading.

Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, accessibility.

No abstractions that weren't requested. No new dependency if avoidable. Deletion over addition. Shortest working diff wins, but only once you understand the problem.

## Tool-output discipline
When you run a build, test, or diff command, scope its output before reading it back. Use \`command 2>&1 | tail -30\`, \`--stat\`, \`--name-only\`, or \`2>&1 | head -50\` to get the signal at a fraction of the tokens. A 10k-token build log fills your context and slows every subsequent token — read summaries first, expand only the axis that actually failed.

## Build early, build often
After writing your first file, immediately run the project's build command (the first item in the verify list). Do NOT write all files first and then build — a wrong API assumption in the first file will cascade into every file you write after it. Build after each file or pair of files, fix the errors while the context is small, then continue. This costs 2-3 extra builds but saves 20+ steps of reading dependency source to understand an API you already got wrong.

## Dependency APIs
When using an external library, do NOT read its installed source code (dependency caches, vendored directories, lock files) — it is unstructured, massive, and burns your step budget. Instead: (1) look for an \`examples/\` directory in the dependency and read ONE example file, (2) check the package manifest for feature flags or entry points, (3) if no examples exist, write a minimal compile-test (a 5-line program that imports the API) to probe it. If the API doesn't match what the ticket spec says, adapt to the real API — the spec's code sketches are best-effort, not ground truth.

## File editing
Prefer the \`write\` tool (create or overwrite a whole file) for new files and small files. Use \`edit\` (find-and-replace) only for targeted changes to large existing files. When using \`edit\`, always read the file immediately before editing — never rely on memory of a prior read, as the file may have changed. If \`edit\` fails with "oldString not found", re-read the file and retry with the exact content. For new files, always use \`write\` — never \`edit\` on a non-existent file.

## Verify
When done, run these commands and make sure they pass:
${verifyBlock}
If you have not already run the build during implementation (see "Build early, build often" above), run it NOW before declaring DONE. Never declare DONE on unverified code.
## Failed-attempt handoff (push)
If this attempt is failing — verify fails, or review returned blocking findings you cannot address in this attempt — end your run with a handoff block so the next attempt does not have to re-read your whole diff to learn what you already figured out. Emit it on its own lines, BEFORE your final DONE marker, exactly in this form:

${HANDOFF_START}
<what you tried, max 5 lines>
<why it failed, max 3 lines>
<suggested approach for the next attempt, max 3 lines>
${HANDOFF_END}

Rules:
- The block is OPTIONAL when you are succeeding — omit it entirely on a successful attempt. Emit it only when you know you are failing.
- Keep it terse and self-contained: a fresh agent holding only this block (no diff, no transcript) must understand what to try next. Do not reference "the issue" or "the bug"; name the thing.
- One block per attempt. If you start one and get cut off, start a fresh one — the railhead takes the first COMPLETE ${HANDOFF_START}...${HANDOFF_END} pair.
- Tooling facts belong in the ${LEARNED_MARKER} line below, not here. This block is about the attempt's reasoning, not reusable environment facts.

## Reusable tooling facts (push)
While working you may have discovered a non-obvious tooling or environment fact a fresh agent on this project would have to rediscover: how to capture a screenshot, a command that fails without a TTY, a port that's not the default, a runtime quirk. If you discovered such a fact, push it back so the railhead can persist it. Emit it on its own line, exactly in this form, BEFORE your final DONE marker (the railhead treats DONE as a hard stop, so anything after it is never read):

${LEARNED_MARKER} <one terse line, self-contained, no preamble — e.g. "${LEARNED_MARKER} the dev server panics without a TTY on this project; build first, then run the binary directly">

Rules:
- One line, beginning with the exact marker \`${LEARNED_MARKER}\`. Mid-sentence mentions are ignored.
- Omit it entirely if you discovered nothing reusable. Do NOT emit \`${LEARNED_MARKER} NONE\` "just in case"; silence is the correct empty signal.
- Each fact must be self-contained — a future agent with no context must understand it. Do not reference "the issue" or "the bug"; name the thing.
- Tooling facts only. Not code facts (visible in the diff), not reviewer findings, not summaries. If in doubt, omit.

If a prior learning injected into your prompt above is WRONG — you personally verified it does not hold (e.g. it claims "this model cannot read images" but you just successfully read a screenshot file) — emit a retraction on its own line, in this form:

${RETRACTED_MARKER} <the prior learning text, or enough of it to uniquely identify the line>

The railhead removes the matched line from future prompts. Use this only for facts you personally falsified, not for facts you simply did not need this attempt.
${evidenceBlock}
${HALT_CONTRACT}
## Terse output
You run unattended — no human reads your narration, and every prose token you emit stays in your context for the next step. Do not explain what you did. Skip preamble, summaries, and "I will" plans. Do the work, then end with exactly the required marker:

DONE <files touched, comma or newline separated>`;

  const ticketBlock = `TICKET FILE: ${ticketFile}

TICKET:
${ticketBody}

ACCEPTANCE CRITERIA:
${criteriaBlock}`;

  return {
    preamble,
    task: renderTask([
      roleBlock,
      learningsBlock,
      digestBlock,
      implementVisionBlock,
      designDocBlock,
      coherenceBlockText,
      architectureDocBlock,
      contractBlock,
      ticketBlock,
      `${feedbackBlock}${handoffBlock}${historyBlock}${fixModeBlock}`,
    ]),
  };
}

/**
 * Build the prompt for the test phase (issue #5 — TDD as a railhead phase).
 * A fresh opencode subprocess runs this BEFORE the implement phase on
 * testable tickets: it writes one failing test per acceptance criterion at
 * the seams the ticket names, runs them, confirms they fail for the right
 * reasons, and emits a `$HANDOFF` block the implementer receives as
 * `prevHandoff`. The test is the external oracle a small-context model
 * cannot provide for itself (ADR 0014) — it substitutes self-judgment with
 * a check the implementer must satisfy.
 *
 * Deliberately NARROW: does not inherit the implementer's contracts block,
 * priorDiff scaffolding, or visual self-check. The test author's job is one
 * thing — write failing tests at the named seams — and the prompt is sized
 * to that job so the phase stays in the fast band (ADR 0014).
 */
export async function buildTestPhasePrompt(options: {
  cwd: string;
  ticketFile: string;
  ticketBody: string;
  criteria: string[];
  verify: string[];
  /** Seams the tests must target — typically the ticket's `files` + the
   * symbols its `references`/`introduces` name. Surfaced as a block so the
   * test author writes tests at the right boundary, not at an imagined one. */
  seams: string[];
  /** Project learnings (tooling facts). Same injection as the implementer. */
  learnings?: string | null;
  /** Model context-window size in tokens; guides the test author to stay
   * within budget. Same signal the implementer gets — without it the test
   * phase cat'd 8 whole files in a real run and compacted 9 times. */
  contextBudget?: number;
}): Promise<PhaseMessages> {
  const { cwd, ticketFile, ticketBody, criteria, verify, seams, learnings, contextBudget } = options;

  const criteriaBlock = criteria.length
    ? criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- (no acceptance criteria listed — emit $HANDOFF NONE and DONE; nothing to test)";

  const verifyBlock = verify.length
    ? verify.map((c) => `- ${c}`).join("\n")
    : "  - (none configured — run whatever the project's test command is)";

  const seamsBlock = seams.length
    ? seams.map((s) => `- \`${s}\``).join("\n")
    : "- (no specific seam named — write tests at the public boundary the criteria describe)";

  const learningsBlock = learnings
    ? `\n## Project learnings (tooling facts from prior phases)\nThese are tooling/environment facts discovered by prior agents on this project. They are unverified model-claims, not tested facts. Most are safe to trust (a command that needs a flag, a port that isn't default). But a claim about YOUR OWN capabilities (e.g. "this model cannot read images") is a self-assessment that may be wrong — if such a claim would change your approach, TEST it once before deferring to it. If a learning turns out to be false, retract it with the ${RETRACTED_MARKER} marker below.\n${learnings.split("\n").map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const [agents, context] = await Promise.all([
    readPreambleDoc(cwd, "AGENTS.md"),
    readPreambleDoc(cwd, "CONTEXT.md"),
  ]);

  const roleBlock = `You are the Test Author for one ticket of an unattended build. Your job: write failing tests at the seams this ticket names, run them, confirm they fail for the right reasons, then end with the $HANDOFF marker describing what the tests assert and where the implementer should look.

This is a small-context run. Keep your reads minimal and targeted. Do not read entire large files (no \`cat src/foo.ts\`); use targeted reads (read a line range, grep for a symbol) to confirm the seam's signature — you only need the type/function shape to write an importing test, not the file's body.${contextBudget ? `\nYour context window is budgeted to roughly ${Math.floor(contextBudget / 1000)}k tokens — keep reads small so you do not run out.` : ""}

TICKET FILE: ${ticketFile}

TICKET:
${ticketBody}

ACCEPTANCE CRITERIA (write ONE test per criterion, not an exhaustive spec):
${criteriaBlock}
${learningsBlock}
## Seams
${seamsBlock}

## Create new files — do NOT edit implementation files
Write tests as NEW files (e.g. \`tests/ball_tests.rs\`, \`src/greet.test.ts\`). Use the \`write\` tool to create them. Do NOT use \`edit\` on implementation files (\`src/main.rs\`, \`src/ball.rs\`, etc.) — you are the test author, not the implementer. If you need to add a test module to an existing file, create a separate test file that imports from it instead.

## Bail out when the seam does not exist
If the types, functions, or modules the tests would import do not exist yet (no module file, no exported symbol, no public API to call), you CANNOT write a meaningful pre-implementation test. Do NOT invent types, stub implementations, or redefine components in the test file to make it compile — a test against your own mock types tests nothing. Instead, emit \`$HANDOFF NONE\` and \`DONE\` with no test files. The implementer will proceed without pre-written tests; the verify gate still catches correctness after implementation. This is the correct response for frameworks where a system can only be tested after it is registered (ECS, event loops, render pipelines) and the registration is the implementer's job.

## Run and verify failure
After writing tests, run them via the verify command (${verifyBlock}). Confirm each test FAILS for the right reason — the function is missing, the type is absent, the behavior is wrong — NOT a syntax error in the test itself. A test that passes before implementation is tautological: rewrite it so its expected value comes from an independent source of truth (a known literal, a worked example), not from recomputing the answer the way the code does.

## Anti-patterns (must avoid)
- Implementation-coupled: mocks internal collaborators, tests private methods, verifies through a side channel. The tell: the test breaks when you refactor but behavior hasn't changed. Test through the PUBLIC seam the criteria name.
- Tautological: the assertion recomputes the expected value the way the code does (expect(add(a, b)).toBe(a + b), a snapshot derived by hand the same way). Expected values must come from a known-good literal or worked example — never from re-deriving the implementation's own logic.
- Horizontal slicing: writing all tests first then implementing. You write tests ONLY; the implement phase writes the impl. But do not write tests for IMAGINED behavior the criteria don't name — one test per criterion, scoped to what the ticket actually asks for.

## End
When done, emit your handoff so the implementer reads intent without re-deriving from your test code:

${HANDOFF_START}
<for each test: file path, what it asserts, why it is failing right now, where the implementer should look>
${HANDOFF_END}

DONE <test files touched, comma or newline separated>`;

  return {
    preamble: renderPreamble({ agents, context }),
    task: roleBlock,
  };
}

export async function buildReviewerPrompt(options: {
  ticketFile: string;
  ticketBody: string;
  criteria: string[];
  diff: string;
  priorFindings?: string[];
  contracts?: ContractsIndex;
  /** Project learnings (tooling facts from prior phases). See ADR 0012. */
  learnings?: string | null;
  /** Fix mode (issue #6): when true, the reviewer also checks for leftover
   * [DEBUG-...] instrumentation the implementer should have cleaned up. */
  fixMode?: boolean;
  /** Which implement→review cycle this is (1-indexed). On attempt 3+, the
   * reviewer escalates: instead of terse findings, it explains WHY each
   * finding exists and suggests a direction to try — giving the fresh-context
   * implementer enough signal to try a different approach, not the same one
   * (#16). */
  attempt?: number;
  /** Issue #34: the planner's design intent. When present, the reviewer
   * judges whether the diff matches the planned aesthetic/quality bar, not
   * just the ticket ACs. */
  designDoc?: string | null;
  /** Issue #34: the planner's architecture intent. When present, the reviewer
   * judges whether the diff follows the planned structure. */
  architectureDoc?: string | null;
  /** Issue #99 (ADR 0028): whether this ticket touches the rendered surface —
   * gates the design narrative exactly as the implementer's does, so both
   * seats agree on what a surface ticket carries. */
  surface?: boolean;
  /** Issue #99 (ADR 0028): the coherence charter for a surface ticket. When
   * present, the reviewer verifies the diff's chrome conformance (shared
   * constants module + Chrome rules) — the earliest detection point. */
  coherenceDoc?: string | null;
  /** Issue #41: output from the project's deterministic linter, run after
   * verify passes but before review. When non-empty, the reviewer sees
   * what the linter flagged so it can focus on logic/design rather than
   * style or common bug patterns the linter already caught. */
  lintOutput?: string | null;
  /** Issue #45: when true, the reviewer treats missing/implausible red/green
   * evidence (no tests in the diff, or tests that could not have gone
   * red→green against this change) as a [MAJOR] finding. Omitted for
   * `testable: false` tickets. */
  testable?: boolean;
  /** Issue #46: when set, the diff was written to this ledger file path and
   * the reviewer should read it itself instead of having it inlined. The
   * prompt substitutes a "read the diff file at <path>" block + stat for the
   * inlined diff body. Empty string falls back to inline (graceful no-op). */
  diffFile?: string;
  /** Issue #46: the `git diff --stat` summary shown alongside `diffFile` so
   * the reviewer sees the shape of the change before reading the full diff. */
  diffStat?: string;
  /** Issue #50: rolling project digest. See ADR 0018. */
  digest?: string | null;
}): Promise<PhaseMessages> {
  const { ticketFile, ticketBody, criteria, diff, priorFindings, contracts, learnings, fixMode, attempt, designDoc, architectureDoc, surface, coherenceDoc, lintOutput, testable, diffFile, diffStat, digest } = options;
  const criteriaBlock = criteria.length
    ? criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- (no acceptance criteria listed)";

  const priorBlock = priorFindings?.length
    ? `\nPRIOR BLOCKING FINDINGS (from earlier reviews of this ticket — confirm each is now resolved before approving; do not re-raise a resolved item as new):\n${priorFindings.join("\n")}`
    : "";

  const contractBlock = contracts?.entries.length
    ? `\nEXISTING PUBLIC CONTRACTS this ticket should reuse or extend, not duplicate (the full contracts index — check the diff's signatures against these exactly):\n${renderContracts(contracts)}\n`
    : "";

  const learningsBlock = learnings
    ? `\n## Project learnings (tooling facts from prior phases)\nThese are tooling/environment facts discovered by prior agents on this project. They are unverified model-claims, not tested facts. Most are safe to trust (a command that needs a flag, a port that isn't default). But a claim about YOUR OWN capabilities (e.g. "this model cannot read images") is a self-assessment that may be wrong — if such a claim would change your approach, TEST it once before deferring to it. If a learning turns out to be false, retract it with the ${RETRACTED_MARKER} marker below.\n${learnings.split("\n").map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const digestBlock = buildDigestInjection(digest);

  // Issue #34/#99: the design narrative, architecture map, and coherence
  // charter are STABLE inputs and live in the canonical preamble (message 1).
  // The task keeps only the judge-frame instructions that tell the reviewer
  // how to use each section above.
  const designDocBlock = surface !== false && designDoc
    ? `\n${designRequestBlock("review")}`
    : surface === false && designDoc
      ? DESIGN_POINTER_BLOCK
      : "";
  const coherenceBlockText = surface !== false && coherenceDoc
    ? `\n${coherenceRequestBlock("judge")}`
    : "";
  const architectureDocBlock = architectureDoc
    ? `\n${architectureRequestBlock("review")}`
    : "";

  const lintBlock = lintOutput && lintOutput.trim()
    ? `\n## Pre-review lint findings (already flagged — do not re-report)\nThe project's deterministic linter produced these findings. They are already known; do not re-report them as your own. Use them as context: if a lint finding points to a deeper correctness issue (e.g. an unused variable that means a feature is not wired), raise THAT — but do not raise the style/lint issue itself.\n${lintOutput.trim()}\n`
    : "";

  // Issue #46: when the diff exceeds the inline threshold, the railhead wrote
  // it to a ledger file. Hand the reviewer the path + a stat summary so it
  // can read the diff on demand instead of carrying it in the prompt — a
  // large diff on a 64k-context model burns a significant share of the
  // window before the reviewer reads a single line. Falls back to inline
  // when diffFile is absent or empty (tiny diffs, back-compat).
  const diffBlock = diffFile
    ? `\n## Diff (read it from the file)\nThe full diff is too large to inline without burning your context window. It has been written to:\n\n${diffFile}\n\nRead that file with the read tool before reviewing. Overview:\n\n${diffStat || "(no stat available)"}\n`
    : `DIFF:\n${diff || "(no diff produced)"}\n`;

  const planAuthorityNote = `## Plan-authority note (external artifacts)
An acceptance criterion that names a concrete third-party package/artifact (or a specific CLI flag, URL, or external API) is an UNVERIFIED PLAN CLAIM, not ground truth — the plan may have fabricated it (a package that does not exist in its registry). Judge such a criterion by its CAPABILITY, never by its name:
- Do NOT block an implementer for not installing or using a named artifact the diff substituted with a real one — the substitution is correct behaviour, not a criterion failure.
- Do NOT block for the named artifact's absence when the diff meets the capability the criterion actually describes.
- If the diff substitutes or drops a plan-named artifact and the project's decision record (DECISIONS.md) does not yet document that choice, raise [MAJOR]: the plan record still asserts the phantom name; it must record the substitution so later tickets and reviews stop fighting it. Name both the plan's claim and what the code actually uses.`;

  const roleBlock = `You are the Reviewer for one ticket of an unattended build. You are read-only: critique the diff, never edit files. You have no read, search, or command tools — every file a review needs is already in this prompt (the ticket body, its acceptance criteria, and the diff), so do not try to explore the repository; answer in the exact format requested below.
The purpose of review is to confirm the acceptance criteria are COMPLETELY met and the change basically works — not to police code style or polish. Ignore minor quality nits; only surface issues that genuinely matter.

TICKET FILE: ${ticketFile}

TICKET:
${ticketBody}

ACCEPTANCE CRITERIA:
${criteriaBlock}${priorBlock}
${planAuthorityNote}
${designDocBlock}${coherenceBlockText}${architectureDocBlock}${contractBlock}${learningsBlock}${digestBlock}${lintBlock}${diffBlock}
Check:
1. Is every acceptance criterion fully met by the diff (not just partially)?
2. Are there bugs, crashes, security issues, or broken wiring that would stop it from working?
3. Does it assemble correctly in context (e.g. geometry/normals, coordinates, imports, runtime behavior), not just read in isolation?
4. Does the change introduce spurious or duplicated contracts rather than reusing existing ones? If EXISTING PUBLIC CONTRACTS were listed above, check the diff's calls/signatures against them exactly — a mismatch (wrong arity, renamed field, re-derived constant) is a MUST-FIX, not a nit.${fixMode ? `
5. Leftover debug instrumentation: the diff must NOT add any [DEBUG-...] log lines (the fix-mode discipline requires cleanup before DONE — Phase 6). If the diff introduces tagged debug logs, flag each as [MAJOR].` : ""}${redGreenEvidenceCheckItem(testable, fixMode, "diff")}

Do NOT report: style preferences, naming, formatting, unused imports, subjective taste, or anything that does not affect whether the ticket works and is complete. The diff may contain tool-generated artifacts (binary files, screenshots, log files, MCP tool directories like .playwright-mcp/) — these are runtime side effects, not the implementer's work. Ignore them; judge only source code changes.

Do NOT raise test quality as a blocking finding. The railhead runs verify (build + tests) before review — if tests pass, they are adequate. Do not flag a test for not calling a specific function, not exercising a particular code path, or re-implementing logic instead of calling production code. These are test-thoroughness opinions, not correctness issues. Only raise a test as [MAJOR] or [BLOCKER] if the test itself is broken (compiles but asserts the wrong thing, tests a different behavior than the criterion names, or silently passes without testing anything).

## Code smells (positive checklist)
 IN ADDITION to the must-fix / nits split below, scan the diff for these code smells (Fowler, _Refactoring_ ch.3):
- Mysterious Name: a function/variable/type whose name doesn't reveal what it does.
- Duplicated Code: same logic shape in two places in this diff.
- Feature Envy: a method that reaches into another object's data more than its own.
- Data Clumps: same few fields/params travelling together (a type wanting to be born).
- Speculative Generality: abstraction/parameters/hooks added for needs the spec doesn't have.
- Shotgun Surgery: one logical change forces scattered edits across many files.
- Divergent Change: one file/module edited for several unrelated reasons in this diff.
Skip smells the project's documented standards endorse. See docs/code-review-smells.md for the full list.
Severity rule (issue #71): a smell NEVER blocks the ticket on its own. List a smell under $NITS (advisory — recorded, never forces a retry) unless the smell CAUSES or RISKS a correctness or completeness failure of an acceptance criterion; only then report it as a [MAJOR] must-fix in $BLOCKING and name what actually breaks.

## Necessity (does this code need to exist?)
Before rating correctness, ask whether each piece of new code in the diff should exist at all. Flag as [MAJOR]:
- Reimplementation: the diff introduces logic that already exists elsewhere in the codebase (a duplicate helper, a parallel implementation of an existing function).
- Premature abstraction: an interface with one implementation, a config system for one config value, a factory for one product — abstraction without the second use case the ticket or its references justify.
- Dead code introduced by this diff: functions defined but never called, exports never imported by any file the ticket names.
Do NOT flag code the ticket explicitly asked for, even if it looks like it could be simpler — that is a correctness/quality judgment, not a necessity judgment.

Do NOT report compilation, build, or typecheck failures. The railhead runs verify (build + tests) for you and only invokes review after it passes — if verify is green, the code compiles by definition. A claim that "X will not compile" or "X fails to typecheck" cannot be true at review time and historically wastes retries on a non-existent failure. Report only correctness, logic, wiring, and completeness issues you can see in the diff itself.

A criterion phrased as a repo-wide check you cannot run ("grep finds no X outside Y", "no other module contains Z") is judged from the diff alone: your tools are diff-only by design, and no substitute tool family is available. If the diff is consistent with the criterion, treat it as met; if the diff itself violates it, report it. Never attempt to gather repo-wide evidence by other means.

Do a COMPLETE, sweeping review in this single pass — catch EVERY real must-fix now. Reread the whole diff and hunt for all correctness gaps and criteria failures. Do not stop at the first problem found; list them all at once. Running many small review rounds is expensive, so prefer surfacing them together.

CRITICAL on prior findings: the PRIOR BLOCKING FINDINGS list above contains things from earlier reviews. Judge each one as either RESOLVED (the current diff addresses it) or STILL PRESENT. You must NOT list a RESOLVED prior finding as a must-fix again — only list genuinely still-present prior findings plus any brand-new ones you discover. This keeps the finding list from re-piling fixed items and lets the build progress.

Sort your findings into three buckets:
- MUST-FIX (BLOCKER): The ticket is actively broken, unsafe, or fails an acceptance criterion without this. If such a finding remains at the attempt limit, the ticket FAILS.
- MUST-FIX (MAJOR): A real correctness or completeness gap, but the ticket essentially works. If such a finding remains at the attempt limit, the ticket passes with a warning.
- ADVISORY ($NITS): anything that touches only code quality, maintainability, or polish — including the code-smell checklist above when it has no correctness impact (issue #71). List each on its own line under $NITS, no [BLOCKER]/[MAJOR] prefix. Advisories never block the ticket or force a retry; they are recorded for the report.
${attempt && attempt >= 3 ? `
## Escalated review (attempt ${attempt}+)
This ticket has already failed review ${attempt - 1} time(s). The implementer runs in a fresh context each attempt and cannot see prior attempts — it will naturally converge on the same fix unless you give it a different direction. For EACH must-fix finding:
- explain WHY the finding exists — the root cause, not just the symptom.
- suggest WHAT direction to try instead — name a specific, different approach the implementer has likely not tried.
- name what the implementer likely got wrong — the misconception that led to the repeat.
A terse "[MAJOR] X is broken" sends the fresh-context implementer back to the same fix. A finding like "[MAJOR] X is broken because the event listener is attached after the element is removed; move the addEventListener call before the DOM update or use event delegation" gives it a different path.` : ""}

You run unattended — reply terse, no prose narration. Do not recap the ticket or restate the diff. Emit only the findings, in exactly this format (use the single word NONE in a section with nothing). List EACH $BLOCKING issue on its own line, each prefixed with either [BLOCKER] or [MAJOR]: every [BLOCKER] MUST name the file (and, where possible, the line) in this ticket's diff that it is about — a [BLOCKER] that names no location in the diff is treated as [MAJOR].

$BLOCKING
[BLOCKER] first is-actively-broken issue
[MAJOR] a works-but-imperfect issue
[BLOCKER] another broken issue
$NITS
NONE
$OK
<one line summary of verdict>

${HALT_CONTRACT}

## Reusable tooling facts (push)
You may have discovered a non-obvious tooling or environment fact a fresh agent on this project would have to rediscover: how to capture a screenshot, a command that fails without a TTY, a port that's not the default, a runtime quirk you observed while running the app or inspecting the diff. If you did, emit it on its own line as the LAST line of your output, exactly in this form:

${LEARNED_MARKER} <one terse line, self-contained, no preamble>

Rules:
- One line, beginning with the exact marker \`${LEARNED_MARKER}\`. Mid-sentence mentions are ignored.
- Omit it entirely if you discovered nothing reusable — silence is the correct empty signal. Do NOT emit \`${LEARNED_MARKER} NONE\`.
- Tooling/environment facts only. Not findings about the ticket (those go in $BLOCKING). Not code-style observations. Not the model's context window size — a ContextOverflowError reports the hard limit, not the working budget; the railhead already injects the configured budget into your prompt. If in doubt, omit.

If a prior learning injected into your prompt above is WRONG — you personally verified it does not hold — emit a retraction on its own line, in this form:

${RETRACTED_MARKER} <the prior learning text, or enough of it to uniquely identify the line>

The railhead removes the matched line from future prompts. Use this only for facts you personally falsified, not for facts you did not need this review.`;

  return {
    preamble: renderPreamble({
      design: surface !== false ? designDoc : null,
      architecture: architectureDoc,
      coherence: surface !== false ? coherenceDoc : null,
    }),
    task: roleBlock,
  };
}

/**
 * Prompt a read-only pass to list the public contracts that exist after a
 * ticket's diff, so the index can grow. Runs over just the diff / touched
 * files — bounded context.
 */
export function buildContractExtractPrompt(options: {
  diff: string;
  touchedFiles: string;
}): PhaseMessages {
  const { diff, touchedFiles } = options;
  const task = `You are extracting the public interface (the "contract") of a codebase change so it can be indexed for later tickets.

Below is the diff (or touched files) from ONE ticket. List the PUBLIC contracts that now exist or changed as a result. A contract is anything another ticket might call or import: exported functions, classes, constants, methods, CLI commands, endpoints, config keys.

Do NOT list internal helpers, private functions, or implementation detail.

Return exactly this block (one JSON object per contract, no prose):

$CONTRACTS
{"symbol":"greet","kind":"function","file":"src/index.mjs","signature":"greet(name) -> string","description":"returns a greeting"}
$END

If the change introduces no reusable public contracts, return exactly:
$CONTRACTS
$END

Touched files: ${touchedFiles}

DIFF:
${diff}`;
  return { preamble: "", task };
}

/** Per-file model fallback for contract extraction (#28). When regex extraction
 * finds nothing in a file (unknown language, macro-heavy code, non-standard
 * exports), the model reads just that one file's content — not the full
 * ticket diff. This bounds each model call to O(file) not O(ticket), so a
 * 30k-token shader file can't overflow the context on a 64k model. */
export function buildContractExtractFilePrompt(file: string, content: string): PhaseMessages {
  const task = `You are extracting the public interface (the "contract") of a source file so it can be indexed for later tickets.

File: ${file}

List the PUBLIC contracts this file exports — anything another ticket might call or import: exported functions, classes, constants, types, methods, CLI commands, endpoints, config keys.

Do NOT list internal helpers, private functions, or implementation detail.

Return exactly this block (one JSON object per contract, no prose):

$CONTRACTS
{"symbol":"greet","kind":"function","file":"${file}","signature":"greet(name) -> string","description":"returns a greeting"}
$END

If the file introduces no reusable public contracts, return exactly:
$CONTRACTS
$END

SOURCE:
${content}`;
  return { preamble: "", task };
}

export async function buildReviewerReadModePrompt(options: {
  ticketFile: string;
  ticketBody: string;
  criteria: string[];
  stat: string;
  files: string[];
  priorFindings?: string[];
  contracts?: ContractsIndex;
  learnings?: string | null;
  fixMode?: boolean;
  /** Which implement→review cycle (1-indexed). Escalates on 3+ (#16). */
  attempt?: number;
  /** Issue #34: the planner's design intent. */
  designDoc?: string | null;
  /** Issue #34: the planner's architecture intent. */
  architectureDoc?: string | null;
  /** Issue #99 (ADR 0028): whether this ticket touches the rendered surface —
   * gates the design narrative exactly as the implementer's does. */
  surface?: boolean;
  /** Issue #99 (ADR 0028): the coherence charter for a surface ticket. The
   * read-mode reviewer verifies the touched files' chrome conformance. */
  coherenceDoc?: string | null;
  /** Issue #41: linter output to inject into the reviewer prompt. */
  lintOutput?: string | null;
  /** Issue #45: when true, the reviewer treats missing/implausible red/green
   * evidence (no test among the touched files, or tests that could not have
   * gone red→green against this change) as a [MAJOR] finding. Omitted for
   * `testable: false` tickets. */
  testable?: boolean;
  /** Issue #50: rolling project digest. See ADR 0018. */
  digest?: string | null;
}): Promise<PhaseMessages> {
  const { ticketFile, ticketBody, criteria, stat, files, priorFindings, contracts, learnings, fixMode, attempt, designDoc, architectureDoc, surface, coherenceDoc, lintOutput, testable, digest } = options;
  const criteriaBlock = criteria.length
    ? criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- (no acceptance criteria listed)";

  const priorBlock = priorFindings?.length
    ? `\nPRIOR BLOCKING FINDINGS (from earlier reviews of this ticket — confirm each is now resolved before approving; do not re-raise a resolved item as new):\n${priorFindings.join("\n")}`
    : "";

  const contractBlock = contracts?.entries.length
    ? `\nEXISTING PUBLIC CONTRACTS this ticket should reuse or extend, not duplicate (the full contracts index — check the diff's signatures against these exactly):\n${renderContracts(contracts)}\n`
    : "";

  const learningsBlock = learnings
    ? `\n## Project learnings (tooling facts from prior phases)\nThese are tooling/environment facts discovered by prior agents on this project. They are unverified model-claims, not tested facts. Most are safe to trust (a command that needs a flag, a port that isn't default). But a claim about YOUR OWN capabilities (e.g. "this model cannot read images") is a self-assessment that may be wrong — if such a claim would change your approach, TEST it once before deferring to it. If a learning turns out to be false, retract it with the ${RETRACTED_MARKER} marker below.\n${learnings.split("\n").map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const digestBlock = buildDigestInjection(digest);

  const designDocBlock = surface !== false && designDoc
    ? `\n${designRequestBlock("review")}`
    : surface === false && designDoc
      ? DESIGN_POINTER_BLOCK
      : "";
  const coherenceBlockText = surface !== false && coherenceDoc
    ? `\n${coherenceRequestBlock("judge")}`
    : "";
  const architectureDocBlock = architectureDoc
    ? `\n${architectureRequestBlock("review")}`
    : "";

  const lintBlock = lintOutput && lintOutput.trim()
    ? `\n## Pre-review lint findings (already flagged — do not re-report)\nThe project's deterministic linter produced these findings. They are already known; do not re-report them as your own. Use them as context: if a lint finding points to a deeper correctness issue, raise THAT — but do not raise the style/lint issue itself.\n${lintOutput.trim()}\n`
    : "";

  const fileList = files.map((f) => `- ${f}`).join("\n");

  const roleBlock = `You are the Reviewer for one ticket of an unattended build. You have read access to the touched source files — use the read tool to examine each one. Do NOT edit, run commands, or explore the repo beyond the files listed below.
The purpose of review is to confirm the acceptance criteria are COMPLETELY met and the change basically works — not to police code style or polish. Ignore minor quality nits; only surface issues that genuinely matter.

TICKET FILE: ${ticketFile}

TICKET:
${ticketBody}

ACCEPTANCE CRITERIA:
${criteriaBlock}${priorBlock}
${designDocBlock}${coherenceBlockText}${architectureDocBlock}${contractBlock}${learningsBlock}${digestBlock}${lintBlock}## Files to review (read each one)

${fileList}

## Change overview (diff stat)

${stat || "(no changes detected)"}

## Instructions

Read each file listed above. For each file, check:
1. Is every acceptance criterion fully met by the code (not just partially)?
2. Are there bugs, crashes, security issues, or broken wiring that would stop it from working?
3. Does it assemble correctly in context (e.g. geometry/normals, coordinates, imports, runtime behavior), not just read in isolation?
4. Does the change introduce spurious or duplicated contracts rather than reusing existing ones? If EXISTING PUBLIC CONTRACTS were listed above, check the code's calls/signatures against them exactly — a mismatch (wrong arity, renamed field, re-derived constant) is a MUST-FIX, not a nit.${fixMode ? `
5. Leftover debug instrumentation: the code must NOT add any [DEBUG-...] log lines (the fix-mode discipline requires cleanup before DONE — Phase 6). If the code introduces tagged debug logs, flag each as [MAJOR].` : ""}${redGreenEvidenceCheckItem(testable, fixMode, "touched files")}

Do NOT report: style preferences, naming, formatting, unused imports, subjective taste, or anything that does not affect whether the ticket works and is complete. Ignore binary files, screenshots, log files, and MCP tool directories — these are runtime side effects, not the implementer's work.

## Code smells (positive checklist)
 IN ADDITION to the must-fix / nits split below, scan the code for these code smells (Fowler, _Refactoring_ ch.3):
- Mysterious Name: a function/variable/type whose name doesn't reveal what it does.
- Duplicated Code: same logic shape in two places in this diff.
- Feature Envy: a method that reaches into another object's data more than its own.
- Data Clumps: same few fields/params travelling together (a type wanting to be born).
- Speculative Generality: abstraction/parameters/hooks added for needs the spec doesn't have.
- Shotgun Surgery: one logical change forces scattered edits across many files.
- Divergent Change: one file/module edited for several unrelated reasons in this diff.
Skip smells the project's documented standards endorse. See docs/code-review-smells.md for the full list.
Severity rule (issue #71): a smell NEVER blocks the ticket on its own. List a smell under $NITS (advisory — recorded, never forces a retry) unless the smell CAUSES or RISKS a correctness or completeness failure of an acceptance criterion; only then report it as a [MAJOR] must-fix in $BLOCKING and name what actually breaks.

Do NOT report compilation, build, or typecheck failures. The railhead runs verify (build + tests) for you and only invokes review after it passes — if verify is green, the code compiles by definition.

A criterion phrased as a repo-wide check you cannot run ("grep finds no X outside Y", "no other module contains Z") is judged from the files this prompt lists: you have no search or command tools, and no substitute tool family is available. If those files are consistent with the criterion, treat it as met; if one of them violates it, report it.

Do a COMPLETE, sweeping review in this single pass — catch EVERY real must-fix now. Read every listed file and hunt for all correctness gaps and criteria failures. Do not stop at the first problem found; list them all at once.

CRITICAL on prior findings: the PRIOR BLOCKING FINDINGS list above contains things from earlier reviews. Judge each one as either RESOLVED (the current code addresses it) or STILL PRESENT. You must NOT list a RESOLVED prior finding as a must-fix again — only list genuinely still-present prior findings plus any brand-new ones you discover.

Sort your findings into three buckets:
- MUST-FIX (BLOCKER): The ticket is actively broken, unsafe, or fails an acceptance criterion without this. If such a finding remains at the attempt limit, the ticket FAILS.
- MUST-FIX (MAJOR): A real correctness or completeness gap, but the ticket essentially works. If such a finding remains at the attempt limit, the ticket passes with a warning.
- ADVISORY ($NITS): anything that touches only code quality, maintainability, or polish — including the code-smell checklist above when it has no correctness impact (issue #71). List each on its own line under $NITS, no [BLOCKER]/[MAJOR] prefix. Advisories never block the ticket or force a retry; they are recorded for the report.
${attempt && attempt >= 3 ? `
## Escalated review (attempt ${attempt}+)
This ticket has already failed review ${attempt - 1} time(s). The implementer runs in a fresh context each attempt and cannot see prior attempts — it will naturally converge on the same fix unless you give it a different direction. For EACH must-fix finding:
- explain WHY the finding exists — the root cause, not just the symptom.
- suggest WHAT direction to try instead — name a specific, different approach the implementer has likely not tried.
- name what the implementer likely got wrong — the misconception that led to the repeat.
A terse "[MAJOR] X is broken" sends the fresh-context implementer back to the same fix. A finding like "[MAJOR] X is broken because the event listener is attached after the element is removed; move the addEventListener call before the DOM update or use event delegation" gives it a different path.` : ""}

You run unattended — reply terse, no prose narration. Do not recap the ticket or restate the code. Emit only the findings, in exactly this format (use the single word NONE in a section with nothing). List EACH $BLOCKING issue on its own line, each prefixed with either [BLOCKER] or [MAJOR]: every [BLOCKER] MUST name the file (and, where possible, the line) it is about among the files listed above — a [BLOCKER] that names no file or line is treated as [MAJOR].

$BLOCKING
[BLOCKER] first is-actively-broken issue
[MAJOR] a works-but-imperfect issue
[BLOCKER] another broken issue
$NITS
NONE
$OK
<one line summary of verdict>

${HALT_CONTRACT}

## Reusable tooling facts (push)
You may have discovered a non-obvious tooling or environment fact a fresh agent on this project would have to rediscover: how to capture a screenshot, a command that fails without a TTY, a port that's not the default, a runtime quirk you observed while running the app or inspecting the diff. If you did, emit it on its own line as the LAST line of your output, exactly in this form:

${LEARNED_MARKER} <one terse line, self-contained, no preamble>

Rules:
- One line, beginning with the exact marker \`${LEARNED_MARKER}\`. Mid-sentence mentions are ignored.
- Omit it entirely if you discovered nothing reusable — silence is the correct empty signal. Do NOT emit \`${LEARNED_MARKER} NONE\`.
- Tooling/environment facts only. Not findings about the ticket (those go in $BLOCKING). Not code-style observations. Not the model's context window size — a ContextOverflowError reports the hard limit, not the working budget; the railhead already injects the configured budget into your prompt. If in doubt, omit.

If a prior learning injected into your prompt above is WRONG — you personally verified it does not hold — emit a retraction on its own line, in this form:

${RETRACTED_MARKER} <the prior learning text, or enough of it to uniquely identify the line>

The railhead removes the matched line from future prompts. Use this only for facts you personally falsified, not for facts you did not need this review.`;

  return {
    preamble: renderPreamble({
      design: surface !== false ? designDoc : null,
      architecture: architectureDoc,
      coherence: surface !== false ? coherenceDoc : null,
    }),
    task: roleBlock,
  };
}
