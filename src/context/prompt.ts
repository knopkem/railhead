import { readProjectDoc } from "../core/git.ts";
import { renderContracts, type ContractsIndex } from "../core/contracts.ts";
import { LEARNED_MARKER, RETRACTED_MARKER } from "./learnings.ts";
import { visionCapabilityBlock, type VisionCapabilityFact } from "../execute/vision-probe.ts";
import { buildDigestInjection } from "./digest.ts";
import { CHARTER_DOC } from "./coherence.ts";
import { renderPreamble, renderTask, type PhaseMessages } from "./preamble.ts";

/** Load a project doc for the canonical preamble. A missing file renders an
 *  explicit placeholder so the model can tell "checked and absent" from "not
 *  part of this phase's stable inputs". */
export async function readPreambleDoc(cwd: string, name: string): Promise<string> {
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
  const { ticketFile, ticketBody, criteria, diff, priorFindings, contracts, learnings, fixMode, attempt, designDoc, architectureDoc, surface, coherenceDoc, lintOutput, diffFile, diffStat, digest } = options;
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
5. Leftover debug instrumentation: the diff must NOT add any [DEBUG-...] log lines (the fix-mode discipline requires cleanup before DONE — Phase 6). If the diff introduces tagged debug logs, flag each as [MAJOR].` : ""}

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
  /** Issue #50: rolling project digest. See ADR 0018. */
  digest?: string | null;
}): Promise<PhaseMessages> {
  const { ticketFile, ticketBody, criteria, stat, files, priorFindings, contracts, learnings, fixMode, attempt, designDoc, architectureDoc, surface, coherenceDoc, lintOutput, digest } = options;
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
5. Leftover debug instrumentation: the code must NOT add any [DEBUG-...] log lines (the fix-mode discipline requires cleanup before DONE — Phase 6). If the code introduces tagged debug logs, flag each as [MAJOR].` : ""}

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
