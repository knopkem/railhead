import { scanJsonObjects } from "../core/json.ts";
import { DEFAULT_CONTEXT_TOKENS } from "../config/config.ts";
import type { Ticket } from "../core/ticket.ts";
import { orderTickets, scanTicketConflicts, introducerIndex, dependsOn, titleSlug, TICKET_FIELD_SEMANTICS } from "../core/ticket-dag.ts";
import type { ProjectInterface } from "../config/interface.ts";
import { PROJECT_INTERFACES } from "../config/interface.ts";

// The dependency/naming shape (PlanTicket, orderTickets) lives in ticket-dag.ts;
// re-exported here so a producer stays a one-import stop for planning concerns.
import type { PlanTicket, ConflictFinding, ConflictReport, Ruling, FindingClass, PlanFindingKind, ReferenceUniverse } from "../core/ticket-dag.ts";
export { orderTickets, extendBlockedBy, scanTicketConflicts, reportConflicts, assessRuntimeExtension, allConflictFindings, isEmptyConflictReport, introducerIndex, findDroppedTickets, collapseRepeatedTickets, TICKET_FIELD_SEMANTICS, type PlanTicket, type ConflictReport, type ConflictFinding, type Ruling, type FindingClass, type PlanFindingKind, type ReferenceUniverse } from "../core/ticket-dag.ts";

/** Planner mode: same shape as {@link SharpenMode} in sharpen.ts. `build` (the
 * default) turns a feature description into tickets; `fix` turns a bug report
 * into a real fix ticket — never a "verification" or "already implemented"
 * no-op. Kept as a string-literal type (not imported from sharpen.ts) so plan.ts
 * stays a leaf with no cross-import. */
export type PlanMode = "build" | "fix";

/** The planner stage prompts; their text is pinned by prompt-content
 * assertions in plan.test.ts (ADR 0007 couples it to the ticket format).
 * Planning is staged — design, coverage audit, decomposition — each stage a
 * separate model call with its own output shape. The staged flow exists
 * because a single call asked one model to interpret the goal, judge its own
 * interpretation, and decompose it, all in one response: the judgment was
 * skipped (the plan was judged by its own author) and sizing rules written
 * for a fresh-context implementer per ticket biased the decomposition against
 * scope (a GoTY-caliber game shipped without art because no ticket had room).
 *
 * Sizing guidance is deliberately ABSENT from both stages. The builder is ONE
 * durable session (ADR 0022): a ticket is a checkpoint, not a context-window
 * budget, so the planner sizes by verifiability and dependency seams and may
 * emit as many tickets as the work needs.
 */

export interface PlanStageInput {
  contractsSummary: string;
  /** The project's existing domain glossary (CONTEXT.md), injected verbatim
   * when present. */
  existingGlossary?: string;
  /** Whether the planner must plan the look as a checkable target (a rendered
   * surface, art direction not disabled). `false` suppresses the art-direction
   * request blocks; absent/true includes them. */
  artDirection?: boolean;
}

const ART_DIRECTION_DESIGN_REQUEST = `The ART DIRECTION requirement: IF the $INTERFACE you declare is a rendered surface (browser-ui or canvas — not terminal or none), the LOOK is part of the deliverable. Add an \`## Art direction\` section to $DESIGN (after Goal coverage, before any Coherence contract) describing the intended look with CONCRETE direction — palette roles as hex values with a stated value separation, distinguishable value bands, actor detail (outline/shading/highlight), background depth, a lighting model with an attenuation rule, and what moves with an easing rule. This section is DIRECTION for the art agent that will create the look — it is not a checklist the build is scored against, and it must not be turned into per-pixel acceptance criteria. Pure model/library/CLI builds (interface terminal/none): omit the section entirely.`;

const ART_DIRECTION_TICKETS_REQUEST = `The ART DIRECTION requirement: IF the plan declares a rendered surface (browser-ui or canvas), the LOOK must be owned by exactly ONE OPEN-ENDED CRAFT TICKET — never decomposed:
- Emit exactly one ticket with "open_ended": true. Its "what" is a CREATION goal — "make the composed frame as crafted and atmospheric as the art direction describes" — NOT a verification task. It has NO structural acceptance criteria (leave "criteria" empty, or limit it to "the app builds and runs"); its quality is judged by looking at a screenshot, so do NOT turn the art direction into a checklist of pixel properties for it to pass.
- This ONE ticket owns everything the user sees — background, terrain, character, lighting, parallax, and any detail the look needs. Do NOT split the visual work into per-element tickets (no separate background / character / lighting / terrain tickets): each slice would then satisfy only its own criterion, which caps the result at "measurably non-bland" — the failure this rule prevents.
- Infrastructure tickets (scaffold, build/test, a canvas shell) MAY precede it; the art ticket is blocked by them.
- The builder for this ticket iterates: run the app, capture a screenshot, read it, judge it, improve it — until it judges the frame meets the goal. Say so in "what".
- Set "testable": false (there is no unit seam) and give it a "group" so its commit is a review checkpoint.
Do not emit an open-ended ticket for a terminal/none interface.`;

function artDirectionDesignBlock(input: PlanStageInput): string {
  return input.artDirection === false ? "" : `\n\n${ART_DIRECTION_DESIGN_REQUEST}`;
}

function artDirectionTicketsBlock(input: PlanStageInput): string {
  return input.artDirection === false ? "" : `\n\n${ART_DIRECTION_TICKETS_REQUEST}`;
}

const QUALITY_PREFERENCES = `Quality preferences (apply when choosing technologies and structuring the plan — break ties in this direction, not as hard rules):
- Prefer fewer dependencies: the stdlib or platform solution over a third-party package that must be installed, pinned, and learned. Add a dependency only when it saves significant work the stdlib cannot do.
- Prefer small, focused modules with clear interfaces (deep modules: small surface, large impl). Avoid god-objects and catch-all utility files.
- Avoid premature abstraction: do not introduce interfaces, traits, or generics for needs the spec does not have. Concrete first, abstract when a second caller proves the pattern.
- Prefer technologies with a strong testing story and fast feedback loops — a framework where tests are easy to write and run in seconds makes every subsequent ticket safer.
- Prefer technologies you are confident the executing model can handle correctly — a popular, well-documented stack with examples in training data beats a novel one the model will fumble.`;

const CLAIM_DISCIPLINE = `Claim discipline — your DECISIONS vs outside-world ASSERTIONS:
The plan and any ticket must never present an unverified outside-world fact as if it were decided truth. You decide the stack, structure, and ordering; you do NOT get to decide that a specific third-party package exists, what its API is, that a flag behaves a certain way, or that a URL is live. A wrong name you assert once gets repeated into later tickets, acceptance criteria, and the architecture, and the implementer burns hours discovering it is false — or silently works around it while the plan keeps asserting it.
- When you need third-party capability, express it as a CAPABILITY with a testable acceptance criterion, not as a package name: "a pure-JS PNG encoder/decoder that needs no DOM and round-trips RGBA buffers", never "use @scope/name". Acceptance criteria test behaviour, never the provenance of a named package.
- If the spec forces a specific third-party artifact, cite it in exactly ONE place: the ticket that owns choosing it (normally the scaffold ticket), phrased as a RESOLUTION, not an assertion — "add the dependency that provides <capability>; if <named artifact> does not exist or lacks <property>, choose the real one and record why". The scaffold ticket's criteria make the choice real (the build resolves and uses whatever was chosen); no later ticket or the $ARCHITECTURE block may restate the name as fact.
- A decision record (e.g. DECISIONS.md) states what you chose and how it was confirmed ("chose pngjs after confirming the spec's package name 404s"), never a fabricated comparison that assumes a package's existence.`;

function glossaryBlock(existingGlossary?: string): string {
  return existingGlossary?.trim()
    ? `\nThe project's existing domain glossary (CONTEXT.md) — use these words exactly, do not invent synonyms for a concept it already names:\n${existingGlossary.trim()}\n`
    : "";
}

const VERIFY_INTERFACE_SMOKE_BLOCKS = `Emit a $VERIFY block first: the shell commands that prove a ticket works (the project's build and test commands). These run after every implementer attempt across the whole project, so list ONLY commands that should pass once ANY single ticket is correctly implemented — not project-final integration checks. Per-ticket criteria belong inside each ticket, not here. Use the single word NONE if there is genuinely no automated check (very rare; almost every project has at least a build/typecheck command).

Then emit an $INTERFACE line: how a USER operates this deliverable — a property of the thing being built, never of the language it is written in. Emit the marker, then EXACTLY ONE token on its own line — one of <browser-ui | canvas | terminal | none>:
- browser-ui — a DOM app the user operates by pointing and typing (buttons, fields, menus)
- canvas — a full-canvas app with no DOM controls to operate (games, pointer-lock)
- terminal — a CLI/TUI the user operates via stdin/stdout
- none — a library or pure backend with no user-facing surface
A browser app that is ONLY a full-canvas game is canvas; a DOM app with chrome around a canvas is browser-ui. When in doubt, choose by what a real user points at / types into.

Then emit a $SMOKE block: ONE shell command that launches the built binary. This runs after verify passes, before review — it catches startup panics that a successful build cannot (an app that compiles but panics on the first frame; a server that binds the wrong port). The binary launches exactly as written, with no headless env injected — do NOT write code that skips rendering or the main schedule when a headless env is present, because the smoke phase must exercise the SAME code path the user runs. If the project is a library with no runnable binary, emit the single word NONE here.`;

const PLAN_BLOCK_SPEC = `$PLAN
<markdown: the COMPLETE plan — the authoritative document. This is not a summary and has no length cap: restate the goal, then the chosen approach and why, every module/artifact the build needs and what each owns, the data/control flow, the shared conventions (coordinate system, scale, units, tokens), the phases of work in order, the risks and trade-offs and the decisions already taken, and what "done" means. $DESIGN and $ARCHITECTURE below are DISTILLED summaries of this document — they must be consistent with it, and the ticket decomposition is derived from it, so anything you omit here is scope dropped from the build.>
$END`;

const DESIGN_BLOCK_SPEC = `$DESIGN
<markdown: the DISTILLED interpretation of the goal (the full detail lives in $PLAN; keep this short). Required sections, in order:
- Goal: a one-sentence restatement of what this build achieves.
- Narrative/theme: the intended experience, 2-4 sentences.
- Identity: what a user sees and feels (for a rendered surface) or how the thing behaves (for a library/service) — concrete enough to judge the result against.
- Quality bar: the bar this build must clear, stated as measurable properties, not adjectives.
- Goal coverage: the audit checklist. One line per distinct demand in the goal — every feature, behaviour, constraint, and quality adjective — written as "- <demand> → <concrete deliverable that satisfies it>", naming the module/artifact/technique and where the architecture defines it. An adjective is not a deliverable: "beautiful" must become what is drawn/generated/animated, "fast" a latency or frame budget, "robust" the failure modes handled. If a demand is genuinely out of scope, say so and why. A separate audit reads the raw goal and rejects the plan when a demand is absent or only promised.
Keep the whole block under ~40 lines.>
$END`;

const ARCHITECTURE_BLOCK_SPEC = `$ARCHITECTURE
<markdown: your technical intent — Spec: back-pointer to the originating issue or feature description. Tech Stack: the language, framework, and build/test tooling. Global Constraints: shared conventions (coordinate system, scale, units, origins, naming) every ticket must honor. Module map: EVERY module the build needs, what each owns, and the seam between them — this map is the completeness checklist the tickets must cover. Data/interaction flow. Rationale for the decomposition and ordering. What pure-logic modules exist, where the seams are, how later work integrates. 3-15 sentences.>
$END`;

const COHERENCE_CHARTER_REQUEST = `The COHERENCE CHARTER (issue #99 / ADR 0028): IF this build has a surface component — a browser/canvas app, a themed CLI/terminal UI, a GUI, or any rendered user interface a user will look at — author a \`## Coherence contract\` subsection INSIDE the $DESIGN block, placed AFTER the Goal coverage section with no further \`##\`-level heading after it (the section runs to the end of the block; its own subsections use \`###\`, which the railhead keeps inside). Make it terse, normative, ~150-250 words, with EXACTLY these three \`###\` subsections:

### Visual tokens
The palette/colour roles, spacing scale, type, radius/shadow — and NAME the shared constants module every surface ticket must import rather than redefine (e.g. \`src/ui/theme.ts\` exporting \`TOKENS\`).

### Layout model
What docks where at the target viewport (the main surface plus any panels, rails, or docks), WHO owns the app shell, and the viewport constraint (e.g. "1280x800, no overlap, no scroll"). For a non-panel surface (a game canvas, a TUI) state the frame/region model instead.

### Chrome rules
The ONE component/chrome recipe every surface ticket reuses (the panel, control, or sprite primitive the surface is built from). Include the explicit rule: do not introduce a competing style.

Pure model/library/CLI builds with NO rendered surface: omit the section entirely — no surface, no charter. Do not leave placeholders; name real modules and constants.`;

const TICKET_ARRAY_SPEC = `Emit your reply in EXACTLY this shape — the $TICKETS marker, then the JSON array. No prose before $TICKETS, no code fences around the array:

$TICKETS
[
  {
    "title": "short title",
    "mission": "the one-line goal of the whole build",
    "what": "the end-to-end behaviour this ticket makes work",
    "criteria": ["criterion 1", "criterion 2"],
    "blocked_by": [0, 3],
    "files": ["path/to/File.ts"],
    "references": ["existingSymbol"],
    "introduces": ["newSymbol"],
    "testable": true,
    "open_ended": false,
    "group": "core-engine"
  }
]
${TICKET_FIELD_SEMANTICS}

No placeholders: do NOT use "TBD", "TODO", "FIXME", "implement later", "add appropriate error handling", or "..." in any ticket body, title, or contract name. Replace every placeholder with concrete detail. Do NOT leave the example values "existingSymbol" or "newSymbol" in a real ticket — name real contracts. If you genuinely cannot name a contract, remove the array element rather than leaving a template placeholder.

Emit the $TICKETS marker and the JSON array EXACTLY ONCE in your whole reply — revise by rewriting that ONE array, never by appending a second one. If you do emit a later array that re-lists every earlier ticket by title, the railhead reads it as a superseding revision and drops the earlier draft; a later array with genuinely new titles reads as more tickets for a plan too large for one message. Never repeat a ticket you already emitted — a repeated ticket is a duplicate, not an extension.`;

export function planDesignSystemPrompt(input: PlanStageInput): string {
  return `You are a software planner turning one feature description into a PLAN. You do not write tickets yet: a separate pass decomposes the validated plan into tickets, and the plan you emit here is audited against the original goal — by a reviewer that did not write it — before that happens. Your job is to decide what the build IS: the experience, the quality bar, and the architecture that delivers it.

The current known public contracts of the repo (an index that only grows; new work should BUILD ON these, not duplicate them):
${input.contractsSummary}
${glossaryBlock(input.existingGlossary)}
DO NOT run shell commands, write files, or explore the filesystem. You already know enough about programming languages, build tools, and test runners from your training data to choose sensible verify/smoke commands and structure the plan. Running experiments in bash wastes time and context for no benefit — later phases run the code; your job is to PLAN it.

Rules:
- The Goal coverage checklist is the plan's contract with the goal: every demand must map to a concrete deliverable, including every quality adjective. A demand you restate but do not deliver WILL be flagged by the audit — name the thing that produces it.
- Write the plan for the whole build, not for a window budget: name every module the architecture needs and where the seams are. There is no page or ticket limit; a plan that omits part of the goal to look smaller fails the audit.
- The module map in $ARCHITECTURE is the completeness checklist: a module you name must be buildable and owned by later tickets; a capability the goal needs must appear as a module or an explicitly named mechanism.
- Do not defer wiring: the entry point is owned once, early, and later modules dock into its seam. Do not plan a terminal "integrate everything" step.
- Prefer deep modules (small interface, large implementation) over shallow ones — callers should read the interface, not the impl. See docs/codebase-design.md for the vocabulary (depth, seam, leverage, locality).

${QUALITY_PREFERENCES}

${CLAIM_DISCIPLINE}

${VERIFY_INTERFACE_SMOKE_BLOCKS}

Emit your reply in EXACTLY this shape — $VERIFY block, then an $INTERFACE line, then a $SMOKE block, then the $PLAN block, then the $DESIGN block, then the $ARCHITECTURE block. No prose before $VERIFY, no code fences.

${PLAN_BLOCK_SPEC}

${DESIGN_BLOCK_SPEC}

${ARCHITECTURE_BLOCK_SPEC}

${COHERENCE_CHARTER_REQUEST}${artDirectionDesignBlock(input)}

The $PLAN, $DESIGN, and $ARCHITECTURE blocks are REQUIRED — without them there is nothing for the coverage audit to check, and the plan is rejected.`;
}

export function planTicketsSystemPrompt(input: PlanStageInput): string {
  return `You are a software planner decomposing a VALIDATED plan into a queue of dependency-ordered tickets. The plan (design and architecture) is in the message that follows this prompt and is the source of truth: it has already been audited against the original goal, so do not re-scope it. Your job is execution order — which independently verifiable increments, owning which files, in which dependency order.

The current known public contracts of the repo (an index that only grows; new tickets should BUILD ON these, not duplicate them):
${input.contractsSummary}
${glossaryBlock(input.existingGlossary)}
DO NOT run shell commands, write files, or explore the filesystem. You already know enough about programming languages, build tools, and test runners from your training data to choose sensible commands and structure the tickets. Running experiments in bash wastes time and context for no benefit — the implementer runs the code; your job is to PLAN it.

Rules:
- COVER THE PLAN: every deliverable the plan commits to must be owned by a ticket. Walk the Architecture module map and the Goal coverage checklist; each named module, mechanism, effect, screen, artifact, or quality mechanism gets an owner. Never silently drop plan scope, and never narrow it to look smaller. If the plan under-specifies something a coherent build needs to satisfy a named deliverable, add the ticket and name it.
- Each ticket is a single VERTICAL slice: a coherent, independently verifiable increment that leaves the build green and demoable when it commits. The builder runs as ONE durable session across all tickets, so size a ticket by verifiability and dependency seams, not by a context window: there is no ticket-count ceiling and no file-count cap. Split when a ticket mixes independent concerns or cannot be verified on its own; merge when a slice is not independently meaningful.
- For every file or existing symbol the ticket touches, name it exactly (from the contracts above or the plan). Prefer citing existing contracts over re-deriving them.
- ONE OWNER PER FILE: a ticket's "files" are the files it EDITS/OWNS — always the complete edit set — and exactly one ticket owns a file (especially an entry point, wiring module, or shared state file). Later tickets CONSUME that owner's contracts ("references") instead of listing the file themselves. The structurally wrong shape is N feature tickets each claiming the app's entry/wiring file with no ordering between them: ONE early shell ticket owns the entry point and mounts a minimal running shell (a mount-contract seam with empty slots) so the app is runnable and demoable from the second ticket on; later tickets dock into that seam instead of editing the entry point. Do NOT defer the wiring to a late "integrate everything" ticket. If a shared file genuinely must change across the sequence, order its editors as a dependency chain (each later editor "blocked_by" the prior one) — the railhead gate rejects unordered same-file editors. NEVER under-declare to dodge the rule: the gate only sees the files a ticket lists, so omitting a file you still edit blinds the gate to exactly the clobbering risk it exists to catch.
- Package shared conventions (coordinate system, scale, units, origins, tokens) into an EARLY ticket's public contracts and have later tickets reference them rather than re-deriving them inline. The first ticket establishes the shared frame: fix the origin, scale, and any coordinate scheme in its introduces.
- Give EVERY ticket the same one-line "mission" — the goal of the whole build — so the ticket is self-contained.
- The FIRST ticket must also stand up a buildable scaffold (the project manifest, build scripts, and entry-point tooling the verify list runs), so the very first commit passes the configured verify.
- Express each ticket from the user's perspective (what it makes work), not a layer-by-layer implementation list, with acceptance criteria as concrete, checkable bullets. Criteria must be verifiable by the implementer's seat: a claim only a human eye can check ("looks good") is not a criterion — name the observable behaviour or the artifact instead.
- Order the tickets so each one's dependencies come before it (blockers first).

${QUALITY_PREFERENCES}${artDirectionTicketsBlock(input)}

${TICKET_ARRAY_SPEC}`;
}

/** STAGE 2 — the adversarial goal-coverage audit. Receives the raw goal and
 * the plan (design + architecture) and judges whether every goal demand maps
 * to a concrete deliverable. The auditor did not write the plan; it is asked
 * to enumerate the goal's demands itself rather than trust the plan's own
 * Goal coverage checklist. */
export function buildGoalCoveragePrompt(opts: {
  goal: string;
  planText: string;
  round: number;
  maxRounds: number;
}): string {
  const { goal, planText, round, maxRounds } = opts;
  return `You are auditing a PLAN against the GOAL it claims to satisfy, before any tickets are written. You did not write this plan and you are not here to defend it: your job is to find every demand in the goal that the plan does not concretely deliver.

ORIGINAL GOAL:
${goal}

THE PLAN (design and architecture):
${planText}

METHOD:
1. Extract every distinct demand from the goal: each feature, behaviour, constraint, and quality adjective. Enumerate them yourself — do not trust the plan's own Goal coverage checklist to be complete.
2. For each demand, check the plan: does it name a concrete deliverable that produces it — a module, technique, artifact, data structure, or measured property?
3. A quality adjective is not a deliverable. "beautiful", "fast", "polished", "production-ready", "award-winning" must map to something the plan commits to produce (what is rendered/generated/animated, a frame or latency budget, the failure modes handled). A plan that only restates the adjective does not deliver it.
4. Do NOT flag details that belong to ticket-level implementation. The plan's job is to commit to the deliverable; tickets are derived later.
5. No style nits, no praise, no restating what is fine.

Audit round ${round} of ${maxRounds}.

Emit exactly one verdict. If EVERY demand is concretely delivered:
$COVERAGE_PASS
$END

Otherwise:
$COVERAGE_FAIL
[MISSING] <the goal demand> — <what the plan lacks>
[THIN] <the goal demand> — <why the plan's treatment is a promise, not a deliverable>
$END

Use [MISSING] for a demand absent from the plan, [THIN] for one named but not concretely delivered. One finding per line, no prose after $END.`;
}

/** The revision call after a failed coverage audit: hand the plan back to the
 * design stage with the audit's findings and ask for a full re-emit. */
export function buildPlanRevisionPrompt(opts: {
  goal: string;
  priorPlanText: string;
  findings: string[];
  /** ADR 0042: "coverage-audit" (default) frames the findings as unmet goal
   * demands; "planning-interview" frames them as user answers that change the
   * plan. Same revision contract either way. */
  source?: "coverage-audit" | "planning-interview";
}): string {
  const { goal, priorPlanText, findings, source = "coverage-audit" } = opts;
  const opening = source === "planning-interview"
    ? "Your plan was refined in a planning interview with the user; their answers below change or add to it."
    : "Your plan was audited against the original goal and did not pass: the demands below are not concretely delivered yet.";
  const findingsLabel = source === "planning-interview" ? "THE USER'S ANSWERS" : "THE AUDIT'S FINDINGS";
  return `${opening}

ORIGINAL GOAL:
${goal}

${findingsLabel}:
${findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}

YOUR CURRENT PLAN:
${priorPlanText}

Revise the plan so every finding is genuinely resolved: name the concrete deliverable (module, technique, artifact, measured property) that produces each flagged demand, and make the architecture cover it. Do not argue with the findings in prose and do not restate the adjective — change the plan.

Re-emit the COMPLETE plan in the same output shape ($VERIFY, $INTERFACE, $SMOKE, $DESIGN, $ARCHITECTURE), each block exactly once, with $END after each markdown block.`;
}

/** The user-driven revision call (interactive plan review): hand the plan
 * back to the design stage with the user's feedback and ask for a full
 * re-emit. Distinct from the coverage-audit revision: the reviewer here is
 * the human, and the feedback is theirs verbatim. */
export function buildPlanUserFeedbackPrompt(opts: {
  goal: string;
  priorPlanText: string;
  feedback: string;
}): string {
  const { goal, priorPlanText, feedback } = opts;
  return `The user reviewed the plan and asked for changes. Their feedback:

${feedback}

ORIGINAL GOAL:
${goal}

YOUR CURRENT PLAN:
${priorPlanText}

Revise the COMPLETE plan so every requested change is genuinely addressed: update the mechanism and scope in $PLAN, and keep $DESIGN and $ARCHITECTURE consistent distilled summaries of it. Do not argue with the feedback in prose — change the plan. If a request is impossible or contradicts the goal, say so in the corresponding block and revise around it.

Re-emit the COMPLETE plan in the same output shape ($VERIFY, $INTERFACE, $SMOKE, $PLAN, $DESIGN, $ARCHITECTURE), each block exactly once, with $END after each markdown block.`;
}

/** Compose the human-facing PLAN.md from the planner's output: the
 * authoritative $PLAN document (or, for legacy plans that predate it, the
 * distilled design + architecture) and, once they exist, the full ticket
 * breakdown. Written twice in interactive runs: plan-only BEFORE the user is
 * asked to accept it (no tickets exist yet), and again after decomposition
 * with the ticket section appended. Pure. */
export function buildPlanMarkdown(opts: {
  prompt: string;
  planDoc: string | null;
  designDoc: string | null;
  architectureDoc: string | null;
  /** Omitted/empty before decomposition — the ticket section is then omitted. */
  tickets?: Pick<Ticket, "number" | "title" | "what" | "criteria" | "files" | "blocked_by" | "references" | "introduces">[];
}): string {
  const { prompt, planDoc, designDoc, architectureDoc, tickets = [] } = opts;
  const body = planDoc
    ?? ([designDoc, architectureDoc].filter((d): d is string => Boolean(d)).join("\n\n") || "(the planner emitted no detailed plan)");
  const ticketBlocks = tickets.map((t) => {
    const lines = [`### ${t.number} — ${t.title}`, "", t.what];
    if (t.files.length) lines.push("", `- Files: ${t.files.join(", ")}`);
    if (t.criteria.length) lines.push(...t.criteria.map((c) => `- Criterion: ${c}`));
    if (t.blocked_by.length) lines.push(`- Blocked by: ${t.blocked_by.join(", ")}`);
    if (t.references.length) lines.push(`- Consumes: ${t.references.join(", ")}`);
    if (t.introduces.length) lines.push(`- Produces: ${t.introduces.join(", ")}`);
    return lines.join("\n");
  });
  const ticketSection = tickets.length
    ? `\n---\n\n## Ticket plan (${tickets.length} ticket${tickets.length === 1 ? "" : "s"})\n\n${ticketBlocks.join("\n\n")}\n`
    : "";
  return `# PLAN
> Goal: ${prompt.split("\n")[0]}

${body}
${ticketSection}`;
}

export interface CoverageVerdict {
  verdict: "pass" | "fail" | "inconclusive";
  findings: string[];
}

/** Parse the coverage audit's verdict. `$COVERAGE_FAIL` wins over a pass
 * marker (the safest read on a confused model); findings are the `[...]` lines
 * between the marker and `$END`. Neither marker = inconclusive — the caller
 * treats that as a failed round, never as an assumed pass. */
export function parseCoverageVerdict(text: string): CoverageVerdict {
  const failIdx = text.search(/\$COVERAGE_FAIL\b/i);
  const passIdx = text.search(/\$COVERAGE_PASS\b/i);
  if (failIdx < 0 && passIdx < 0) return { verdict: "inconclusive", findings: [] };
  if (failIdx < 0) return { verdict: "pass", findings: [] };
  const afterMarker = text.slice(failIdx).replace(/^\$COVERAGE_FAIL\b[^\n]*\n?/i, "");
  const endIdx = afterMarker.search(/\$END\b/i);
  const block = endIdx >= 0 ? afterMarker.slice(0, endIdx) : afterMarker;
  const findings = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\[(MISSING|THIN)\]/i.test(l));
  return { verdict: "fail", findings };
}

/** The fix-mode planner prompt: one bug report becomes one fix ticket in a
 * single call (there is no plan to audit — the fix IS the plan). */
export function planFixSystemPrompt(
  contractsSummary: string,
  contextBudget?: number,
  existingGlossary?: string,
): string {
  return `You are a software planner turning one BUG REPORT into a fix ticket. The user has reported a defect; your job is to translate the bug report (and any reproduction steps gathered in the planning interview) into a ticket the implementer can execute.

The current known public contracts of the repo (an index that only grows; the implementer reads these to navigate):
${contractsSummary}
${glossaryBlock(existingGlossary)}
${contextBudget ? `The executing model's context window is roughly ${Math.floor(contextBudget / 1000)}k tokens.` : `The executing model has a small-context window (~${Math.floor(DEFAULT_CONTEXT_TOKENS / 1000)}k tokens).`}

CRITICAL RULES — read these before emitting any ticket:
- NEVER decide for yourself that the bug is "already fixed" or "already implemented." That judgement belongs to the implementer, who runs the code; you cannot run it. Reading the code statically is not sufficient — a function can exist and pass its unit tests while still being wired wrong at the call site (a hardcoded argument, a stale default, a missing integration).
- ALWAYS emit a real fix ticket. Do NOT emit a "verification ticket," an "acceptance ticket," or a "confirm the bug is already fixed" ticket. If the bug report says X is wrong, the ticket's job is to FIX X, not to confirm X is already fine.
- DO NOT run shell commands, write files, or explore the filesystem. You already know enough about programming languages, build tools, and test runners from your training data to choose sensible verify/smoke commands and structure the ticket. Running experiments in bash wastes time and context for no benefit — the implementer will run the code; your job is to PLAN the fix. Emit $VERIFY, $SMOKE, $DESIGN, $ARCHITECTURE, and $TICKETS directly from your knowledge.
- The ticket's "what" MUST carry the reproduction steps the user provided in the planning interview (trigger, symptom, expected behaviour). The implementer reproduces the bug first, then fixes it — give it everything it needs to reproduce.
- The implementer decides whether the bug reproduces. If it does not reproduce, the implementer will honestly say so and make no changes (a no-op commit is fine — see the run's "already-implemented" path). That costs little. The expensive failure is the planner silently suppressing a real bug because a static read looked fine.
- Even if you strongly suspect the bug is already fixed, you are wrong to pre-judge it. Emit the fix ticket. The runtime is the only honest arbiter.

Rules:
- The fix ticket is ONE ticket (a single defect, a single fix). Do not split unless there are genuinely independent defects.
- Name the exact files and existing functions the implementer should read (from the contracts above or a known path). If the bug report names a symptom, name the file most likely responsible — but frame it as "investigate here" not "the bug is here."
- Provide acceptance criteria as concrete, checkable bullets. At least one criterion MUST be the reproduction path the user described (e.g. "running the reported sequence: the incorrect behaviour must no longer occur; instead the expected outcome occurs").
- Do NOT restate the bug report verbatim as the ticket body. Translate it: the ticket's "what" describes the BEHAVIOUR THE FIX PRODUCES, with the reproduction steps folded in so the implementer can verify the fix.

${QUALITY_PREFERENCES}

${CLAIM_DISCIPLINE}

${VERIFY_INTERFACE_SMOKE_BLOCKS}

Emit your reply in EXACTLY this shape — $VERIFY block, then an $INTERFACE line, then a $SMOKE block, then the $DESIGN and $ARCHITECTURE blocks (optional in fix mode), then $TICKETS and the JSON array. No prose before $VERIFY, no code fences around the array.

${DESIGN_BLOCK_SPEC}

${ARCHITECTURE_BLOCK_SPEC}

${TICKET_ARRAY_SPEC}`;
}


/** Find the lowest index of any of the given markers in `text`, or `text.length`
 * when none match. Shared by the verify/smoke block parsers so each can stop at
 * whichever sibling marker comes next — the three-plan-marker shape
 * (`$VERIFY ... $SMOKE ... $TICKETS`) must not let one parser swallow another's
 * region. Case-insensitive on the marker token. */
function earliestSiblingMarker(text: string, markers: string[]): number {
  let earliest = text.length;
  for (const m of markers) {
    const re = new RegExp(`\\${m}\\b`, "i");
    const idx = text.search(re);
    if (idx >= 0 && idx < earliest) earliest = idx;
  }
  return earliest;
}

/** Extract the $VERIFY ... $SMOKE block from planner output as a list of
 * shell commands. Returns [] when absent, empty, or NONE. The verify block is
 * plan-level metadata (one command set for the whole project), distinct from
 * the per-ticket JSON array that follows. Tolerates any-case markers, blank
 * lines, and surrounding whitespace. Stops at the FIRST of `$INTERFACE`,
 * `$SMOKE` or `$TICKETS` (whichever the planner emitted next) so an interface
 * or smoke block isn't swallowed into the verify list. */
export function parseVerifyBlock(text: string): string[] {
  const startMatch = text.match(/\$verify\s*/i);
  if (!startMatch || startMatch.index === undefined) return [];
  const afterStart = startMatch.index + startMatch[0].length;
  const end = earliestSiblingMarker(text.slice(afterStart), ["$interface", "$smoke", "$plan", "$tickets"]);
  const block = text.slice(afterStart, afterStart + end);
  if (!block || /^none$/i.test(block.trim())) return [];
  return block
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // A bare `$END` is model noise between blocks, never a command ("$END"
    // expands to empty in a shell and exits 0, so it would be silent).
    .filter((l) => !/^\$end$/i.test(l));
}

/** Extract the $SMOKE ... (next sibling) block from planner output as a list
 * of launch commands. Returns [] when absent, empty, or NONE — callers skip
 * the smoke phase in that case (library-only project, or planner declined).
 * Mirrors `parseVerifyBlock`'s shape on purpose: same marker discipline, same
 * NONE handling, same trim/filter. A smoke block is plan-level metadata; if
 * the planner emits several launch commands we take them all (the phase runs
 * them in order, first failure fails the phase).
 *
 * Issue #106 (H): the block stops at the NEXT sibling marker, not `$TICKETS`.
 * The $SMOKE region precedes $DESIGN/$ARCHITECTURE in the plan, and those
 * markers' content is design intent with its own consumers (docs/*.md) — it is
 * NOT a launch command. The pre-#106 parser stopped only at `$TICKETS`, so the
 * design/architecture prose rode into railhead.json's `smoke` list as a
 * write-only mirror that nothing read back (a latent detectFramework tripping
 * hazard). Smoke is launch commands only. */
export function parseSmokeBlock(text: string): string[] {
  const startMatch = text.match(/\$smoke\s*/i);
  if (!startMatch || startMatch.index === undefined) return [];
  const afterStart = startMatch.index + startMatch[0].length;
  const end = earliestSiblingMarker(text.slice(afterStart), ["$design", "$architecture", "$plan", "$tickets"]);
  const block = text.slice(afterStart, afterStart + end);
  if (!block || /^none$/i.test(block.trim())) return [];
  return block
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // A bare `$END` is model noise between blocks, never a command ("$END"
    // expands to empty in a shell and exits 0, so it would be silent).
    .filter((l) => !/^\$end$/i.test(l));
}

/** Extract the $INTERFACE ... (next sibling) block from planner output (issue
 * #97): the single declared interaction token for the deliverable. Returns
 * null when absent, empty, or when no recognized token appears in the block —
 * callers leave the project undeclared (legacy behavior, plus a nudge). The
 * block is one token on its own line; scanning is lossy-tolerant of prose
 * around it, mirroring how the sibling marker parses degrade. Longest token
 * first so `browser-ui`'s hyphen never splits into a bare `browser` match. */
export function parseInterfaceBlock(text: string): ProjectInterface | null {
  const startMatch = text.match(/\$interface\s*/i);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterStart = startMatch.index + startMatch[0].length;
  const end = earliestSiblingMarker(text.slice(afterStart), ["$verify", "$smoke", "$plan", "$design", "$architecture", "$tickets"]);
  const block = text.slice(afterStart, afterStart + end);
  if (!block.trim()) return null;
  for (const token of PROJECT_INTERFACES) {
    if (new RegExp(`\\b${token}\\b`, "i").test(block)) return token;
  }
  return null;
}

/** Extract the $DESIGN ... $END block from planner output (#34): the
 *  planner's interpretation of the goal — redefined goal, narrative/theme,
 *  visual identity, quality bar, feel/UX. Returns `null` when absent — the
 *  prompt requests the block but does not abort on its absence (advisory).
 *  Stops at `$END` or, when no `$END` is present, at the next sibling marker
 *  (`$ARCHITECTURE`, `$VERIFY`, `$SMOKE`, `$PLAN`, `$TICKETS`) so a missing
 *  `$END` does not swallow the rest of the planner output. */
export function parseDesignBlock(text: string): string | null {
  const startMatch = text.match(/\$design\s*/i);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterStart = startMatch.index + startMatch[0].length;
  const tail = text.slice(afterStart);
  const block = sliceUntilMarker(tail, ["$architecture", "$verify", "$smoke", "$plan", "$tickets"]);
  const trimmed = block.trim();
  return trimmed || null;
}

/** Extract the $PLAN ... $END block (the authoritative complete plan). Same
 * marker discipline as the sibling doc parsers: stops at `$END` or the next
 * sibling marker, returns null when absent (legacy plans and fix mode). */
export function parsePlanBlock(text: string): string | null {
  const startMatch = text.match(/\$plan\s*/i);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterStart = startMatch.index + startMatch[0].length;
  const tail = text.slice(afterStart);
  const block = sliceUntilMarker(tail, ["$design", "$architecture", "$verify", "$smoke", "$plan", "$tickets"]);
  const trimmed = block.trim();
  return trimmed || null;
}

/** Slice the `## Coherence contract` subsection out of a parsed $DESIGN
 *  block. Heading-anchored: returns everything after the heading line up to
 *  the next `## `-level heading or the block end (a `###` subheading — the
 *  charter's fixed Visual tokens / Layout model / Chrome rules sections —
 *  stays inside the slice). Returns `null` when absent or empty — a malformed
 *  or truncated section must parse clean, never crash. */
export function parseCoherenceContract(designText: string): string | null {
  return splitCoherenceContract(designText).charter;
}

/** Split a $DESIGN block at its `## Coherence contract` section — the
 *  artifact seam (ADR 0028): each part is persisted exactly once, the
 *  narrative to docs/design.md and the charter to docs/coherence.md (the
 *  file goal reviews amend via CHARTER: revisions). A charter copy left
 *  inside the design doc would ride into surface prompts twice and drift
 *  stale against its amended twin. The span logic is shared with
 *  {@link parseCoherenceContract} (one implementation); a section with no
 *  body is inert (narrative unchanged, charter null), and a charter-only
 *  block yields a null narrative so no empty design doc is written. */
export function splitCoherenceContract(designText: string): { narrative: string | null; charter: string | null } {
  const re = /^##\s+Coherence contract\s*$/im;
  const startMatch = designText.match(re);
  if (!startMatch || startMatch.index === undefined) {
    return { narrative: designText || null, charter: null };
  }
  const headingStart = startMatch.index;
  const afterHeading = headingStart + startMatch[0].length;
  const tail = designText.slice(afterHeading);
  // A `## ` heading ends the section; `### ` (the charter's own subsections)
  // does not — /^##\s/ requires literal "#" + "#" + space, so "### X" fails
  // the \s and stays inside.
  const endIdx = tail.search(/^##\s/m);
  const sectionEnd = afterHeading + (endIdx < 0 ? tail.length : endIdx);
  const charter = designText.slice(afterHeading, sectionEnd).trim() || null;
  if (charter === null) return { narrative: designText || null, charter: null };
  const narrative = (designText.slice(0, headingStart) + designText.slice(sectionEnd)).trim() || null;
  return { narrative, charter };
}

/** Extract the $ARCHITECTURE ... $END block from planner output (#34): the
 *  planner's technical intent — Spec back-pointer, Global Constraints, module
 *  map, rationale for decomposition. Returns `null` when absent (advisory;
 *  the prompt requests the block but does not abort). Same marker discipline
 *  as `parseDesignBlock`: stops at `$END` or the next sibling marker. */
export function parseArchitectureBlock(text: string): string | null {
  const startMatch = text.match(/\$architecture\s*/i);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterStart = startMatch.index + startMatch[0].length;
  const tail = text.slice(afterStart);
  const block = sliceUntilMarker(tail, ["$design", "$verify", "$smoke", "$plan", "$tickets"]);
  const trimmed = block.trim();
  return trimmed || null;
}

/** Slice the doc body from `tail` until the FIRST of: `$END`, any sibling
 * marker, or end-of-string. This prevents a design block whose own `$END`
 * is absent from swallowing a subsequent architecture block's `$END`. */
function sliceUntilMarker(tail: string, siblings: string[]): string {
  const endIdx = tail.search(/\$end\b/i);
  const siblingStop = earliestSiblingMarker(tail, siblings);
  return tail.slice(0, Math.min(endIdx >= 0 ? endIdx : tail.length, siblingStop));
}

/** Extract relative source/config/doc file paths from prose (the spec or the
 * architecture module map), feeding the plan-completeness gate's check that
 * every named file has an owning ticket. Deliberately lossy: matches
 * `name.ext` / `dir/name.ext` tokens with a known build/source extension,
 * strips a leading `./`, and dedupes. Never matches prose like "npm install"
 * (no extension) or a save format like `.spriteforge` (unlisted extension). */
const SOURCE_PATH_RE = /(?:^|[\s`"'([,:])((?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|css|scss|html|json|toml|yaml|yml|md|txt))/g;

export function extractFilePaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SOURCE_PATH_RE)) {
    const cleaned = m[1].replace(/^\.\//, "").replace(/[(),;]+$/, "");
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/** Whether plan prose promises a late/terminal integration of the entry point —
 * the signal (issue #115) that wiring is deferred to a terminal ticket and the
 * entry point stays a placeholder shell for the whole run. Matches the
 * planner's own phrasing ("re-owned by the final integration ticket", "a late
 * ticket integrates the panels into the app shell", "defer the wiring to a
 * terminal ticket"). */
export function detectIntegrationPromise(text: string): boolean {
  return /re-?own(?:ed)?|integration ticket|late integration|final (?:integration )?ticket|integrat(?:es?|ing) the panels|defer(?:s|red)? (?:the )?(?:wiring|integration|mount)/i.test(text);
}

/** Slice a transcript into the per-`$TICKETS` candidate arrays it contains: the
 * text after each marker up to the next marker or the end. Mirrors the sibling
 * marker discipline `parseVerifyBlock`/`parseSmokeBlock` already use
 * (`earliestSiblingMarker`) — a planner model that revises its plan mid-session
 * emits a second full `$VERIFY … $TICKETS` block, and each marker bounds
 * exactly one candidate array so a stray abandoned draft cannot leak in.
 * Returns [] when no marker is present (the caller then scans the whole
 * transcript, the pre-marker path existing lossy parses rely on). */
function ticketRegions(text: string): string[] {
  const regions: string[] = [];
  const re = /\$tickets\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tail = text.slice(m.index + m[0].length);
    const next = tail.search(/\$tickets\b/i);
    regions.push(next < 0 ? tail : tail.slice(0, next));
  }
  return regions;
}

/** The lossy object→ticket map the whole plan parse is built on: a candidate
 * string yields every readable `{…}` ticket object in it, skipping prose,
 * fences, and mid-array corruption. Never throws; the caller decides how to
 * treat an empty result. */
function ticketsFromJson(candidate: string): PlanTicket[] {
  const tickets: PlanTicket[] = [];
  for (const o of scanJsonObjects(candidate)) {
    const t = o as Partial<PlanTicket>;
    if (typeof t.title === "string" && t.title.trim()) {
      tickets.push({
        title: t.title,
        mission: typeof t.mission === "string" ? t.mission : "",
        what: typeof t.what === "string" ? t.what : "",
        criteria: Array.isArray(t.criteria) ? (t.criteria as unknown[]).filter((x): x is string => typeof x === "string") : [],
        blocked_by: Array.isArray(t.blocked_by) ? (t.blocked_by as unknown[]).filter((x): x is number => typeof x === "number") : [],
        files: Array.isArray(t.files) ? (t.files as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
        references: Array.isArray(t.references) ? (t.references as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
        introduces: Array.isArray(t.introduces) ? (t.introduces as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
        testable: typeof t.testable === "boolean" ? t.testable : undefined,
        open_ended: typeof t.open_ended === "boolean" ? t.open_ended : undefined,
        group: typeof t.group === "string" ? t.group.trim() || undefined : undefined,
      });
    }
  }
  return tickets;
}

/** Whether every `earlier` ticket's title-slug (ADR 0027 — the same slugify
 * `orderTickets` and the duplicate-slug scan use) appears among `later`'s
 * titles: the later array re-states the whole earlier set, which is the
 * signature of a mid-session REVISION (the model re-emitted its plan in
 * different words) rather than a plan continued across messages. */
function everyEarlierTitleRepeated(earlier: PlanTicket[], later: PlanTicket[]): boolean {
  if (earlier.length === 0 || later.length === 0) return false;
  const laterSlugs = new Set(later.map((t) => titleSlug(t.title)));
  return earlier.every((t) => laterSlugs.has(titleSlug(t.title)));
}

/** Issue #104: the parse result plus the reconciliation it performed.
 * `collapsed` counts the earlier-region tickets dropped because a later
 * $TICKETS array re-planned the whole set; 0 when no doubled emit was
 * reconciled. `unparsed` counts ticket objects the region clearly contained
 * (a `"title"` key) but the scanner could not parse — a malformed-JSON ticket
 * that was dropped. It must be surfaced, never silently accepted: the
 * spriteforge plan shipped a placeholder because one unquoted array element
 * made the scanner discard 9 of 12 tickets. */
export interface PlanParseOutcome {
  tickets: PlanTicket[];
  collapsed: number;
  unparsed: number;
}

/** Count ticket objects a `$TICKETS` region claims to contain — one `"title"`
 * key per ticket in the schema. The integrity baseline `parsePlanRegions`
 * compares parsed tickets against, so a malformed ticket is visible instead of
 * silently shrinking the plan. */
function countTicketObjects(region: string): number {
  return (region.match(/"title"\s*:/g) ?? []).length;
}

/** Extract a JSON array from model output (tolerates stray prose, code fences,
 * and corruption). Bounds each candidate array to ONE `$TICKETS` region
 * (`ticketRegions`) and reconciles a doubled emit — issue #104, the spriteforge
 * failure where the planner's second assistant message re-emitted the whole
 * plan in different words and the railhead ran 16 tickets for an 8-ticket plan.
 *
 * Policy (revision-vs-continuation, chosen over first-wins and over identity
 * dedup): when a later $TICKETS array re-states EVERY earlier ticket's title
 * (title-slug equivalent — ADR 0027), it is a mid-session revision, so it
 * REPLACES the earlier set (LAST wins — the model's final refinement, matching
 * how a human edits a document). Any later array with a genuinely new title is
 * a continuation of a plan too large for one message and is kept ADDITIVELY.
 * Never hard-fails: a lossy or truncated region simply contributes nothing. */
export function parsePlanRegions(text: string): PlanParseOutcome {
  const regions = ticketRegions(text);
  if (regions.length === 0) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const tickets = ticketsFromJson(candidate);
    if (tickets.length === 0) throw new Error("plan output contained no readable tickets");
    return { tickets, collapsed: 0, unparsed: Math.max(0, countTicketObjects(candidate) - tickets.length) };
  }
  let kept = ticketsFromJson(regions[0]);
  let expected = countTicketObjects(regions[0]);
  let collapsed = 0;
  for (let i = 1; i < regions.length; i++) {
    const later = ticketsFromJson(regions[i]);
    const laterCount = countTicketObjects(regions[i]);
    if (everyEarlierTitleRepeated(kept, later)) {
      collapsed += kept.length;
      kept = later;
      expected = laterCount;
    } else {
      kept = [...kept, ...later];
      expected += laterCount;
    }
  }
  if (kept.length === 0) throw new Error("plan output contained no readable tickets");
  return { tickets: kept, collapsed, unparsed: Math.max(0, expected - kept.length) };
}

/** Extract a JSON array from model output (tolerates stray prose, code fences,
 * and corruption). Delegates to `parsePlanRegions`; when the reconciliation
 * drops a superseded earlier draft the drop count is surfaced on the console —
 * never silent — so a human can see the parser absorbed an apparent double-emit
 * (issue #104). */
export function parsePlanJson(text: string): PlanTicket[] {
  const { tickets, collapsed, unparsed } = parsePlanRegions(text);
  if (collapsed > 0) {
    console.warn(
      `[plan] the plan transcript contained more than one $TICKETS array — the model revised its plan in a later message; the later array supersedes the earlier one, so ${collapsed} draft ticket(s) were dropped (issue #104)`,
    );
  }
  if (unparsed > 0) {
    console.warn(
      `[plan] ${unparsed} ticket object(s) in the plan output carried a "title" but could not be parsed (malformed JSON) and were DROPPED — the plan is INCOMPLETE and will build only a partial scope; re-run planning or fix the model output`,
    );
  }
  return tickets;
}

const PLACEHOLDER_PATTERNS = [
  /\bTBD\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /implement later/i,
  /add appropriate error handling/i,
  /\.\.\./i,
];

const TEMPLATE_PLACEHOLDERS = new Set([
  "existingSymbol",
  "newSymbol",
  "existingContract",
  "newContract",
]);

/** Issue #44: model output is lossy — the planner prompt forbids placeholders,
 *  but the scan is the safety net. Returns one warning per ticket per issue. */
export function placeholderWarnings(tickets: PlanTicket[]): string[] {
  const warnings: string[] = [];
  tickets.forEach((t, i) => {
    const tag = `ticket ${i} ("${t.title.slice(0, 50)}")`;
    for (const p of PLACEHOLDER_PATTERNS) {
      if (p.test(t.what)) {
        warnings.push(`${tag} body contains placeholder language ("${t.what.match(p)?.[0]}") — replace with concrete detail`);
      }
      if (p.test(t.title)) {
        warnings.push(`${tag} title contains placeholder language ("${t.title.match(p)?.[0]}")`);
      }
    }
    warnings.push(...findTemplatePlaceholders(t.references ?? [], "references", tag));
    warnings.push(...findTemplatePlaceholders(t.introduces ?? [], "introduces", tag));
    // Issue #86: the no-consumes/produces finding's premise is counterparty
    // existence. A ONE-ticket plan is both first and last — its "consumes:
    // [], produces: []" is the planner prompt's own sanctioned output (the
    // format spec says [] for the first/last ticket), so it is not a defect.
    // Only a plan with >1 ticket can contain a graph-invisible ticket whose
    // declarations the contract machinery cannot see.
    const hasRefs = t.references !== undefined && t.references.length > 0;
    const hasIntroduces = t.introduces !== undefined && t.introduces.length > 0;
    if (!hasRefs && !hasIntroduces && tickets.length > 1) {
      warnings.push(`${tag} has no references (consumes) and no introduces (produces) — every ticket should declare what it consumes from earlier tickets and what it produces`);
    }
  });
  return warnings;
}

function findTemplatePlaceholders(symbols: string[], field: "references" | "introduces", tag: string): string[] {
  return symbols
    .filter((sym) => TEMPLATE_PLACEHOLDERS.has(sym))
    .map((sym) => `${tag} ${field} contains template placeholder "${sym}" — replace with a real contract name or remove the field`);
}

// ---------------------------------------------------------------------------
// Issue #86: the bounded plan gate. A plan's findings escalate through up to
// `MAX_PLAN_REPAIR_ROUNDS` model repair rounds (each persisted as a
// `plan-repair-N` ledger phase), with a per-finding adjudication escape
// ($RULINGS). Any un-adjudicated finding left after the cap rejects the plan.
// Pure logic lives here (beside plan.ts, per AGENTS.md); the model round itself
// is driven from planner.ts.
// ---------------------------------------------------------------------------

/** Bound on plan-repair rounds after the initial scan (issue #86). Each round
 * is exactly one planner-model call; N+1 un-cleared findings reject the plan. */
export const MAX_PLAN_REPAIR_ROUNDS = 2;

/** Bound on goal-coverage audit rounds (one audit + one plan revision per
 * round). A plan whose audit still reports unmet goal demands after the cap is
 * rejected — shipping a plan the audit already indicted is the failure this
 * gate exists to prevent. */
export const MAX_PLAN_COVERAGE_ROUNDS = 2;

/** Class-B quality findings over an ORDERED ticket set (each ticket carries a
 * file name and real fields): both-empty consumes+produces on a >1-ticket
 * plan, and placeholder language. File-count is deliberately NOT a finding:
 * the builder is one durable session, so a ticket's file span is a
 * decomposition choice, never a context-window defect. Keys are
 * slug-identity (ADR 0027 — the `NN-` ordering prefix stripped) and
 * content-derived (field + the placeholder text itself), never a scan
 * position, so a ruling on one survives re-scans even when the ordering
 * renumbers or a sibling placeholder is added or removed. The `message` keeps
 * full file names for the console and the report. */
function qualityClassB(tickets: Ticket[]): ConflictFinding[] {
  const findings: ConflictFinding[] = [];
  tickets.forEach((t) => {
    const tag = `ticket ${t.file}`;
    const hasRefs = t.references.length > 0;
    const hasIntroduces = t.introduces.length > 0;
    if (!hasRefs && !hasIntroduces && tickets.length > 1) {
      findings.push({
        kind: "no-contracts",
        cls: "classB",
        key: `no-contracts:${t.slug}`,
        tickets: [t.file],
        message: `${tag} has no references (consumes) and no introduces (produces) — every ticket should declare what it consumes from earlier tickets and what it produces`,
      });
    }
    const pushPlaceholder = (needle: string, extra: string) => {
      findings.push({
        kind: "placeholder",
        cls: "classB",
        key: `placeholder:${t.slug}:${extra}:${needle}`,
        tickets: [t.file],
        message: `${tag} ${extra} contains placeholder language ("${needle}") — replace with concrete detail`,
      });
    };
    for (const p of PLACEHOLDER_PATTERNS) {
      const m = t.what.match(p);
      if (m) pushPlaceholder(m[0], "body");
      if (p.test(t.title)) pushPlaceholder(t.title.match(p)?.[0] ?? "", "title");
    }
    for (const sym of t.references) if (TEMPLATE_PLACEHOLDERS.has(sym)) pushPlaceholder(sym, `references`);
    for (const sym of t.introduces) if (TEMPLATE_PLACEHOLDERS.has(sym)) pushPlaceholder(sym, `introduces`);
  });
  return findings;
}

/** Gate scan over an ORDERED ticket set: structural class-A findings
 * (duplicate introduces, duplicate slugs, unordered same-file,
 * unsatisfied/dangling references — issue #103) from `scanTicketConflicts`
 * plus class-B quality findings. A single call the plan gate, the run-start
 * gate, and the runtime extension scan all share. `universe` supplies the
 * committed/existing-code context so a reference to a known contract is not
 * misread as dangling and a reference to a committed introducer needs no edge. */
export function scanOrderedConflicts(
  tickets: Ticket[],
  universe?: ReferenceUniverse,
): ConflictReport {
  const structural = scanTicketConflicts(tickets, universe);
  return { errors: structural.errors, classA: structural.classA, classB: qualityClassB(tickets) };
}

/** Order a PlanTicket[] and run the full gate scan over the result — the
 * plan-time seam. Returns the ordered set (the caller writes it on accept).
 * `universe` supplies the committed/existing-code context (issue #103): a
 * ticket referencing a known contract must not scan as a dangling reference.
 *
 * An unorderable plan (a dependency cycle, a blocked_by index outside the
 * array) returns `ordered: undefined` plus a synthesized class-A
 * `unorderable-plan` finding instead of throwing: previously the throw
 * escaped the plan gate before a single finding existed, bypassing the
 * repair loop entirely. The finding is not rulable (the gate drops $RULINGS
 * against it), so it clears only by a successful repair — or rejects at the
 * bounded round cap. */
export async function scanPlanConflicts(
  planTickets: PlanTicket[],
  universe?: ReferenceUniverse,
): Promise<{ ordered?: Ticket[]; report: ConflictReport }> {
  let ordered: Ticket[] | undefined;
  try {
    ordered = await orderTickets(planTickets);
  } catch (err) {
    return { report: unorderablePlanReport(err) };
  }
  return { ordered, report: scanOrderedConflicts(ordered, universe) };
}

/** The synthesized report for a plan `orderTickets` rejected: one not-rulable
 * class-A finding carrying the thrown error verbatim, so the repair model
 * sees the exact edge that broke ordering. */
function unorderablePlanReport(err: unknown): ConflictReport {
  return {
    errors: [],
    classA: [{
      kind: "unorderable-plan",
      cls: "classA",
      key: "unorderable-plan",
      tickets: [],
      message: `the plan could not be ordered — ${err instanceof Error ? err.message : String(err)}; fix the named edges so a dependency order exists`,
    }],
    classB: [],
  };
}

/** A finding with its round-local table id (A1…, B1…), so the repair prompt
 * can reference a finding and $RULINGS lines can name it. */
export interface TabledFinding {
  id: string;
  cls: FindingClass;
  kind: PlanFindingKind;
  key: string;
  message: string;
  tickets: string[];
  /** Per-involved-ticket plan-array coordinates (its 0-based position in the
   * array the model edits, plus its title), aligned with `tickets`. Set only
   * when `tableFindings` was given the ordered ticket set; the repair prompt
   * addresses tickets by these — array coordinate is what `blocked_by`
   * references — never by a re-derived topological `NN`. */
  refs?: { file: string; index: number; title: string }[];
}

/** The full finding table of a report, class A first, each with a stable
 * round-local id. Ids are recomputed per round but deterministic given the
 * same report, so a ruling line maps back to the finding it adjudicates.
 * Pass the ordered ticket set to attach each involved ticket's live array
 * index + title (`refs`) so the repair table can name tickets the way the
 * model edits them (issue #100 / ADR 0027). */
export function tableFindings(report: ConflictReport, tickets?: Ticket[]): TabledFinding[] {
  const indexByFile = tickets ? new Map(tickets.map((t, i) => [t.file, i])) : undefined;
  const byFile = tickets ? new Map(tickets.map((t) => [t.file, t])) : undefined;
  const out: TabledFinding[] = [];
  const push = (cls: "classA" | "classB") => {
    const list = cls === "classA" ? report.classA : report.classB;
    list.forEach((f, i) => {
      const refs = tickets && byFile && indexByFile
        ? f.tickets.flatMap((file) => {
            const t = byFile.get(file);
            const index = indexByFile.get(file);
            return t && index !== undefined ? [{ file, index, title: t.title }] : [];
          })
        : undefined;
      out.push({ id: `${cls === "classA" ? "A" : "B"}${i + 1}`, cls, kind: f.kind, key: f.key, message: f.message, tickets: f.tickets, refs });
    });
  };
  push("classA");
  push("classB");
  return out;
}

/** Render one finding as the row the REPAIR MODEL reads: each involved ticket
 * is named by its live array index + title (the coordinate `blocked_by`
 * actually references), never by a topological `NN`. Rewrites the involved
 * full `NN-slug.md` file tokens inside the human message to
 * `at array index N (Title)` — the human message is the same prose with the
 * file names substituted, so both dialects describe the identical defect.
 * Falls back to the human message when the table was built without a ticket
 * set. */
export function repairRowText(f: TabledFinding): string {
  if (!f.refs || f.refs.length === 0) return f.message;
  let text = f.message;
  // Longest file token first so a file name that prefixes another never
  // swallows it during substitution.
  const ordered = [...f.refs].sort((a, b) => b.file.length - a.file.length);
  for (const ref of ordered) {
    text = text.split(ref.file).join(`at array index ${ref.index} (${ref.title})`);
  }
  return text;
}

/** Findings still needing a repair or a ruling — anything whose structured key
 * no recorded ruling already covers. Keyed, never text-matched, so a ruling on
 * an identical finding survives across rounds and across the plan/runtime seam
 * (issue #86 ruling-lookup resolution). */
export function outstandingFindings(
  report: ConflictReport,
  rulings: Ruling[],
): TabledFinding[] {
  const ruled = new Set(rulings.map((r) => r.key));
  return tableFindings(report).filter((f) => !ruled.has(f.key));
}

/** Issue #103: derive the missing `blocked_by` edges the given (already
 * un-ruled) unsatisfied-reference findings demand, in the plan's array
 * coordinates — each edit appends the introducer's 0-based array index to the
 * referencing ticket's `blocked_by`, the same coordinate the model edits and
 * the repair table speaks (ADR 0027 / #100). `ordered` is `orderTickets`'
 * output, which is index-aligned with the plan array.
 *
 * A finding whose introducer already transitively depends on the referencer
 * (the planner declared a CONTRADICTORY manual edge) yields no edit — adding
 * the implied edge would create a cycle, which is a genuine model bug that must
 * escalate to a repair round, not be auto-resolved.
 */
export function impliedBlockedByEdits(
  ordered: Ticket[],
  unsatisfied: TabledFinding[],
): { from: number; to: number }[] {
  const indexBySlug = new Map(ordered.map((t, i) => [t.slug, i]));
  const indexByFile = new Map(ordered.map((t, i) => [t.file, i]));
  const introducers = introducerIndex(ordered);
  const byFile = new Map(ordered.map((t) => [t.file, t]));
  const edits: { from: number; to: number }[] = [];
  const seen = new Set<string>();
  for (const f of unsatisfied) {
    const m = f.key.match(/^ref:([^:]+):(.+)$/);
    if (!m) continue;
    const referencerIdx = indexBySlug.get(m[1]);
    const introducerFile = introducers.get(m[2]);
    if (referencerIdx === undefined || !introducerFile) continue;
    const introducerIdx = indexByFile.get(introducerFile);
    if (introducerIdx === undefined || introducerIdx === referencerIdx) continue;
    // A declared edge the other way (the introducer already depends on the
    // referencer) contradicts the implied one — adding it would cycle.
    if (dependsOn(introducerFile, ordered[referencerIdx].file, byFile)) continue;
    const key = `${referencerIdx}:${introducerIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edits.push({ from: referencerIdx, to: introducerIdx });
  }
  return edits;
}

/** ADR 0035: derive the ordering edges an `unordered-same-file` finding
 * demands, in the plan's array coordinates — the later-emitted ticket appends
 * the earlier-emitted one's 0-based index to its `blocked_by`. This is the
 * remedy the planner prompt itself prescribes ("order its editors as a
 * dependency chain"), so it is applied deterministically without consuming a
 * repair round, exactly like the references→introduces implied edges above.
 * Emission order is the only defensible direction: the model listed the
 * foundation editor before the tickets that build on it.
 *
 * Cycle guard: edges are committed one at a time against a working graph, and
 * a candidate that would cycle — possible when several new edges interact with
 * backward-pointing manual edges — is SKIPPED, leaving its finding outstanding
 * so the pair still escalates to the repair round. `ordered` is `orderTickets`'
 * output, index-aligned with the plan array. */
export function sameFileOrderingEdits(
  ordered: Ticket[],
  findings: TabledFinding[],
): { from: number; to: number }[] {
  const indexByFile = new Map(ordered.map((t, i) => [t.file, i]));
  const working = ordered.map((t) => ({ ...t, blocked_by: [...t.blocked_by] }));
  const workingByFile = new Map(working.map((t) => [t.file, t]));
  const edits: { from: number; to: number }[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (f.kind !== "unordered-same-file" || f.tickets.length !== 2) continue;
    const ia = indexByFile.get(f.tickets[0]);
    const ib = indexByFile.get(f.tickets[1]);
    if (ia === undefined || ib === undefined) continue;
    const earlier = Math.min(ia, ib);
    const later = Math.max(ia, ib);
    const key = `${later}:${earlier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const earlierFile = ordered[earlier].file;
    const laterFile = ordered[later].file;
    // "later blocked_by earlier" cycles iff earlier already reaches later.
    if (dependsOn(earlierFile, laterFile, workingByFile)) continue;
    workingByFile.get(laterFile)!.blocked_by.push(earlierFile);
    edits.push({ from: later, to: earlier });
  }
  return edits;
}

/** Apply a set of implied-edge edits to the plan array (immutably) — each
 * appends the introducer's index to the referencing ticket's `blocked_by`,
 * deduped against what is already declared. */
export function withImpliedBlockedBy(
  planTickets: PlanTicket[],
  edits: { from: number; to: number }[],
): PlanTicket[] {
  if (edits.length === 0) return planTickets;
  const additions = new Map<number, number[]>();
  for (const e of edits) {
    const list = additions.get(e.from) ?? [];
    list.push(e.to);
    additions.set(e.from, list);
  }
  return planTickets.map((t, i) => {
    const extra = additions.get(i);
    if (!extra) return t;
    return { ...t, blocked_by: Array.from(new Set([...(t.blocked_by ?? []), ...extra])) };
  });
}

/** Parse $RULINGS … $END adjudications from a repair round's text. Each line
 * names a table id and gives the ruling: `<id>: <one-line reason>`. Malformed
 * lines are dropped (a required ruling that never lands simply stays open and
 * gates). Returns id → reason pairs; the caller resolves ids against the table
 * it showed the model. */
export function parseRulings(text: string): { id: string; reason: string }[] {
  const start = text.search(/\$rulings\b/i);
  if (start < 0) return [];
  const tail = text.slice(start);
  const block = tail.slice(0, Math.min(tail.search(/\$end\b/i) >= 0 ? tail.search(/\$end\b/i) : tail.length, tail.search(/\$tickets\b/i) >= 0 ? tail.search(/\$tickets\b/i) : tail.length));
  const rulings: { id: string; reason: string }[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([AB]\d+)(?:\s*:\s*|\s+)(.+)$/);
    if (m && m[2].trim()) rulings.push({ id: m[1], reason: m[2].trim() });
  }
  return rulings;
}

/** The repair round's prompt: hand the model the current tickets plus the full
 * finding table and ask it to fix the plan — or to rule a finding it judges
 * intentional. Rulings already made are listed so the model does not re-litigate
 * them and so they survive into the re-scan as suppressed keys. */
export function buildPlanRepairPrompt(opts: {
  ticketsJson: string;
  table: TabledFinding[];
  existingRulings: Ruling[];
  maxRounds: number;
  round: number;
}): string {
  const { ticketsJson, table, existingRulings, maxRounds, round } = opts;
  const tableBlock = table.length
    ? table.map((f) => `- [${f.id}] (${f.cls === "classA" ? "A" : "B"}/${f.kind}) ${repairRowText(f)}`).join("\n")
    : "(none)";
  const rulingBlock = existingRulings.length
    ? existingRulings.map((r) => `- ${r.key}: ${r.reason}`).join("\n")
    : "(none)";
  return `You are repairing a ticket plan that failed the railhead's pre-flight gate. The findings below are exactly what the gate will re-check; a plan is only accepted when every finding is either FIXED in the tickets or explicitly RULED intentional.

Rounds: repair round ${round} of ${maxRounds} (each round is one attempt; un-cleared findings after round ${maxRounds} reject the plan).

Current findings (the full gate table; [A] findings are structural — they predict an implementer clobbering another ticket's work):
${tableBlock}

Already-ruled findings (do not re-rule these; they are adjudicated):
${rulingBlock}

The current ticket plan (JSON array):
\`\`\`json
${ticketsJson}
\`\`\`

${TICKET_FIELD_SEMANTICS}

Fix the plan by re-emitting the corrected JSON array. Concretely:
- duplicate introduces: rename one ticket's symbol, or merge the two tickets, or move the symbol into the earlier ticket's introduces and the later ticket's references.
- unordered same-file: the gate already chains same-file editors in emission order for free, so you only see this finding when that chain would cycle against a manual edge — break the cycle (drop or reverse the contradicting "blocked_by"), or make ONE ticket the sole owner of the shared file and have the other reference its contracts instead of listing the file, or split the shared file so each ticket owns distinct files.
- unsatisfied reference (issue #103): a ticket references a symbol a later ticket introduces without being ordered after it — add that introducer's array index to the referencing ticket's "blocked_by", or drop the reference if it is not actually needed. (A lone implied edge is auto-inserted by the gate; you only see this finding when a manual edge contradicts it so the implied edge would cycle.)
- dangling reference (issue #103): a referenced symbol is introduced by NO ticket and is not a known contract — fix the typo, declare it in an earlier ticket's "introduces", or remove the reference; if the contract genuinely exists in committed code, name it in a ruling.
- no consumes+produces: declare real "references" and/or "introduces" for the ticket (or [] with a ruling if the ticket is genuinely standalone).
- placeholder language (TBD, "add appropriate error handling", template symbols like existingSymbol/newSymbol, "..."): replace with concrete detail or remove the element.
- duplicate slug (ADR 0027): two or more tickets title-slug identically (the model emitted the same title twice) — retitle one of them to a genuinely distinct title, or remove the duplicated ticket entirely if it re-emits an earlier ticket's work, fixing the array indices it leaves behind in later blocked_by lists. (Identical repeats — same title, files, AND introduces — are already collapsed by the gate before you see them; a surviving duplicate-slug finding always names distinct-content tickets that need a real retitle or merge.)
- uncovered-file (plan completeness): a required file named by the spec or architecture has no owning ticket — add a ticket that owns it (lists it in its "files" and builds it), or rule it intentional if the file is genuinely out of scope, already covered under a different path, or was renamed.
- unre-owned-entry-point (plan completeness): the plan promises a late/terminal integration of the app entry point — restructure so ONE early shell ticket owns the entry point and mounts a minimal running shell (a mount contract with empty panel slots), and later tickets dock into that contract instead of editing the entry point; or rule it if the surface genuinely needs no shell wiring.
- missing-art-ticket (art direction): the plan declares a rendered surface, so its look must be owned by exactly ONE open-ended craft ticket ("open_ended": true) whose "what" is a creation goal (not a verification task) and which owns everything the user sees. If the finding says the look is decomposed across per-element visual tickets, merge them into the single open-ended ticket. Rule it only when the declared interface genuinely has no rendered surface.
- dropped-ticket (repair loss guard): the repaired plan is missing a ticket that was present before this round — restore it (put it back with its files/criteria intact), or, if you deliberately merged it into a surviving ticket, rule it with a one-line reason naming the ticket that absorbed it. Never drop a ticket silently.
- unorderable plan: the gate could not order the array (a dependency cycle, or a blocked_by index outside the array) — fix the edges named in the finding so a dependency order exists. Never rule this: it clears only by a fix, not by a ruling.

Two identity rules bound how you edit (issue #100 / ADR 0027):
- PRESERVE the order of the JSON array you were handed — fix ordering by editing a ticket's "blocked_by" (the field semantics above), never by reordering the tickets themselves.
- Do NOT retitle a ticket you are keeping — a ticket's title is its identity, and renaming it changes the slug rulings were recorded against, orphaning them. The duplicate-slug fix is the one exception: retitling is required there, and only there.

A finding may be LEGITIMATE — e.g. the same symbol name reused as a local in a different module is legal code, or a ticket genuinely needs no contracts. For any finding you judge intentional, do NOT silently leave it; emit a ruling so the gate records the decision:

$RULINGS
A1 intentional — same symbol name reused as a local in a separate module; no clobber risk
$END

Each ruling line must name an id from the table above (A1, B2, ...) followed by ": " and a one-line reason. Only findings you actually leave unchanged need a ruling; findings you fix need none.

If you FIX any finding, emit the corrected JSON array (same schema as before: title, mission, what, criteria, blocked_by, files, references, introduces, testable, group), no prose, no code fences — followed by the $RULINGS block for any finding you left intentional. If you RULE every finding intentional and change no ticket, emit ONLY the $RULINGS block with no $TICKETS array — do not re-emit an unchanged plan.`;
}