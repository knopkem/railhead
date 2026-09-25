import { scanJsonObjects } from "../core/json.ts";
import { indexOfOutsideFences } from "../core/fences.ts";
import { DEFAULT_CONTEXT_TOKENS } from "../config/config.ts";
import { titleSlug, type PlanTicket, type Ticket } from "../core/ticket.ts";
import type { ProjectInterface } from "../config/interface.ts";
import { PROJECT_INTERFACES } from "../config/interface.ts";

export type { PlanTicket } from "../core/ticket.ts";

/** Planner mode: same shape as {@link SharpenMode} in sharpen.ts. `build` (the
 * default) turns a feature description into tickets; `fix` turns a bug report
 * into a real fix ticket — never a "verification" or "already implemented"
 * no-op. Kept as a string-literal type (not imported from sharpen.ts) so plan.ts
 * stays a leaf with no cross-import. */
export type PlanMode = "build" | "fix";

/** The planner stage prompts; their text is pinned by prompt-content
 * assertions in plan.test.ts (ADR 0007 couples it to the ticket format).
 * Planning is two calls — design, then decomposition. The design call decides
 * what the build IS; the decomposition call turns the validated-intent document
 * into the ticket queue. The builder is ONE durable session (ADR 0022): a
 * ticket is a checkpoint, not a context-window budget, so the planner sizes by
 * verifiability and ordering and may emit as many tickets as the work needs.
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

const ART_DIRECTION_DESIGN_REQUEST = `The ART DIRECTION requirement: IF the $INTERFACE you declare is a rendered surface (browser-ui, canvas, or native — not terminal or none), the LOOK is part of the deliverable. Add an \`## Art direction\` section to $DESIGN (after Goal coverage, before any Coherence contract) describing the intended look with CONCRETE direction — palette roles as hex values with a stated value separation, distinguishable value bands, actor detail (outline/shading/highlight), background depth, a lighting model with an attenuation rule, and what moves with an easing rule. This section is DIRECTION for the art agent that will create the look — it is not a checklist the build is scored against, and it must not be turned into per-pixel acceptance criteria. Pure model/library/CLI builds (interface terminal/none): omit the section entirely.`;

const ART_DIRECTION_TICKETS_REQUEST = `The ART DIRECTION requirement: IF the plan declares a rendered surface (browser-ui, canvas, or native), the LOOK must be owned by exactly ONE OPEN-ENDED CRAFT TICKET — never decomposed:
- Emit exactly one ticket with "open_ended": true. Its "what" is a CREATION goal — "make the composed frame as crafted and atmospheric as the art direction describes" — NOT a verification task. It has NO structural acceptance criteria (leave "criteria" empty, or limit it to "the app builds and runs"); its quality is judged by looking at a screenshot, so do NOT turn the art direction into a checklist of pixel properties for it to pass.
- This ONE ticket owns everything the user sees — background, terrain, character, lighting, parallax, and any detail the look needs. Do NOT split the visual work into per-element tickets (no separate background / character / lighting / terrain tickets): each slice would then satisfy only its own criterion, which caps the result at "measurably non-bland" — the failure this rule prevents.
- Infrastructure tickets (scaffold, build/test, a canvas shell) MAY precede it; order the art ticket after them.
- The builder for this ticket iterates: run the app, capture a screenshot, read it, judge it, improve it — until it judges the frame meets the goal. Say so in "what".
- Give it a "group" so its commit is a review checkpoint.
Do not emit an open-ended ticket for a terminal/none interface.`;

function artDirectionDesignBlock(input: PlanStageInput): string {
  return input.artDirection === false ? "" : `\n\n${ART_DIRECTION_DESIGN_REQUEST}`;
}

function artDirectionTicketsBlock(input: PlanStageInput): string {
  return input.artDirection === false ? "" : `\n\n${ART_DIRECTION_TICKETS_REQUEST}`;
}

export const QUALITY_PREFERENCES = `Quality preferences (apply when choosing technologies and structuring the plan — break ties in this direction, not as hard rules):
- Prefer fewer dependencies: the stdlib or platform solution over a third-party package that must be installed, pinned, and learned. Add a dependency only when it saves significant work the stdlib cannot do.
- Prefer small, focused modules with clear interfaces (deep modules: small surface, large impl). Avoid god-objects and catch-all utility files.
- Avoid premature abstraction: do not introduce interfaces, traits, or generics for needs the spec does not have. Concrete first, abstract when a second caller proves the pattern.
- Prefer technologies with a strong testing story and fast feedback loops — a framework where tests are easy to write and run in seconds makes every subsequent ticket safer.
- Prefer technologies you are confident the executing model can handle correctly — a popular, well-documented stack with examples in training data beats a novel one the model will fumble. Judge API STABILITY, not just popularity: the executing model works from training-data memory, so an API with a recent breaking redesign is one it remembers wrong and must rediscover from installed source — burning its context window before writing a line. A boring API whose shape has been stable for years beats a better one that changed last month.`;

const SPINE_FIRST_ORDER = `SPINE-FIRST ORDER: the first one or two groups must deliver a LAUNCHABLE, VISIBLY CORRECT vertical slice of the actual deliverable — for a browser-ui app, a shell that renders the core surface and where one primary action visibly works; for any interface, the smallest end-to-end path a user can see and operate. Do NOT let deep-logic tickets (parsers, engines, data layers, generators) all precede UI composition: each group that follows builds visibly on the running artifact. A plan whose first half is invisible plumbing and whose surface arrives last is the failure this rule prevents — the run reaches its end with an unwired artifact and no time to correct it.`;

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

Then emit an $INTERFACE line: how a USER operates this deliverable — a property of the thing being built, never of the language it is written in. Emit the marker, then EXACTLY ONE token on its own line — one of <browser-ui | canvas | native | terminal | none>:
- browser-ui — a DOM app the user operates by pointing and typing (buttons, fields, menus)
- canvas — a full-canvas app running in a browser page, with no DOM controls to operate (games, pointer-lock)
- native — an app that opens its own OS window (no browser, no DOM)
- terminal — a CLI/TUI the user operates via stdin/stdout
- none — a library or pure backend with no user-facing surface
A browser app that is ONLY a full-canvas game is canvas; a DOM app with chrome around a canvas is browser-ui; an app that opens its own desktop window is native. When in doubt, choose by what a real user points at / types into.

Then emit a $SMOKE block: ONE shell command that launches the built binary. This runs after verify passes, before review — it catches startup panics that a successful build cannot (an app that compiles but panics on the first frame; a server that binds the wrong port). The binary launches exactly as written, with no headless env injected — do NOT write code that skips rendering or the main schedule when a headless env is present, because the smoke phase must exercise the SAME code path the user runs. If the project is a library with no runnable binary, emit the single word NONE here.`;

const DESIGN_BLOCK_SPEC = `$DESIGN
<markdown: the complete design intent. Required sections, in order:
- Goal: a one-sentence restatement of what this build achieves.
- Narrative/theme: the intended experience, 2-4 sentences.
- Identity: what a user sees and feels (for a rendered surface) or how the thing behaves (for a library/service) — concrete enough to judge the result against.
- Quality bar: the bar this build must clear, stated as measurable properties, not adjectives.
- Goal coverage: the audit checklist. One line per distinct demand in the goal — every feature, behaviour, constraint, and quality adjective — written as "- <demand> → <concrete deliverable that satisfies it>", naming the module/artifact/technique and where the architecture defines it. An adjective is not a deliverable: "beautiful" must become what is drawn/generated/animated, "fast" a latency or frame budget, "robust" the failure modes handled. If a demand is genuinely out of scope, say so and why.
Keep the whole block under ~60 lines.>
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
    "what": "the end-to-end behaviour this ticket makes work, naming the files/modules it touches",
    "criteria": ["criterion 1", "criterion 2"],
    "group": "core-engine",
    "open_ended": false
  }
]

Field semantics:
- "title": short and distinct (it names the ticket file).
- "what": the end-to-end behaviour this ticket makes work. Name the files/modules it creates or edits in prose — there is no separate files field.
- "criteria": concrete, checkable acceptance bullets describing what an OBSERVER can verify on the running artifact. A criterion is an observable behaviour sentence — "the board shows a 3x3 grid after starting a game", never a restatement of the code or a call for a test. Name the observable behaviour or the artifact; a claim only a human eye can check ("looks good") is not a criterion. Do NOT write "(test)" criteria, name a test framework, or ask the builder to author tests — the railhead's verify gate is the only test authority during the build, and a final hardening ticket transcribes confirmed behaviours into the project's test stack at the end. Optionally follow the behaviour with an indented probe recipe line inside the same string, in exactly this shape: "behaviour sentence\\n  probe: <launch>; <action>; <assertion>". A probe is a deterministic recipe a cheap judging seat can materialize into a script (a shell command plus an expected predicate), never a test framework name: e.g. "The board shows a 3x3 grid after starting a game\\n  probe: launch the app; click New game; assert 9 cell elements are visible".
- "group": optional label for a coherent vertical slice. Group boundaries are where whole-app reviews run; keep groups to roughly 3-5 tickets once a rendered surface exists. Omit when the plan is too small to benefit.
- "open_ended": optional, default false. True ONLY for the ONE craft ticket that owns the composed look of a rendered surface (no structural criteria; judged by looking at it). Never for tickets with concrete checkable behaviour.

The tickets run STRICTLY in the order you emit them. Order the array so every prerequisite is built before the ticket that needs it.

No placeholders: do NOT use "TBD", "TODO", "FIXME", "implement later", "add appropriate error handling", or "..." in any ticket body or title. Replace every placeholder with concrete detail.

Emit the $TICKETS marker and the JSON array EXACTLY ONCE when the whole plan fits in one message. If the array does not fit (you are running out of output room), finish the current ticket object and stop; emit the REMAINING tickets in a second $TICKETS array in your next message — never re-list a ticket you already emitted, and never leave a ticket object half-written.`;

/** The continuation call after a truncated decomposition: the model ran out of
 * output room mid-array, so ask it to emit ONLY the remaining tickets as a new
 * $TICKETS array (never re-listing what it already emitted). */
export function planContinuationSystemPrompt(input: PlanStageInput): string {
  return `You are a software planner whose previous ticket array was cut off before it finished. The plan (design and architecture) and the tickets you already emitted follow; the tail of the previous message was incomplete.

The current known public contracts of the repo (an index that only grows; new tickets should BUILD ON these, not duplicate them):
${input.contractsSummary}
${glossaryBlock(input.existingGlossary)}
Emit ONLY the REMAINING tickets — every ticket from the plan you had not finished emitting when the output was cut off. Do NOT re-list or re-emit any ticket that already appears complete in the previous output. Do NOT emit $VERIFY/$DESIGN/$ARCHITECTURE again.

The tickets run STRICTLY in the order emitted. Continue the ordering exactly where the previous array left off.

${TICKET_ARRAY_SPEC}`;
}

export function planDesignSystemPrompt(input: PlanStageInput): string {
  return `You are a software planner turning one feature description into a PLAN. You do not write tickets yet: a separate pass decomposes the validated plan into tickets. Your job is to decide what the build IS: the experience, the quality bar, and the architecture that delivers it.

The current known public contracts of the repo (an index that only grows; new work should BUILD ON these, not duplicate them):
${input.contractsSummary}
${glossaryBlock(input.existingGlossary)}
DO NOT run shell commands, write files, or explore the filesystem. You already know enough about programming languages, build tools, and test runners from your training data to choose sensible verify/smoke commands and structure the plan. Running experiments in bash wastes time and context for no benefit — later phases run the code; your job is to PLAN it.

Rules:
- The Goal coverage checklist is the plan's contract with the goal: every demand must map to a concrete deliverable, including every quality adjective. A demand you restate but do not deliver WILL be flagged later — name the thing that produces it.
- Write the plan for the whole build, not for a window budget: name every module the architecture needs and where the seams are. There is no page or ticket limit; a plan that omits part of the goal to look smaller is incomplete.
- The module map in $ARCHITECTURE is the completeness checklist: a capability the goal needs must appear as a module or an explicitly named mechanism.
- Do not defer wiring: the entry point is owned once, early, and later modules dock into its seam. Do not plan a terminal "integrate everything" step.

${SPINE_FIRST_ORDER}

- Prefer deep modules (small interface, large implementation) over shallow ones — callers should read the interface, not the impl. See docs/codebase-design.md for the vocabulary (depth, seam, leverage, locality).

${QUALITY_PREFERENCES}

${CLAIM_DISCIPLINE}

${VERIFY_INTERFACE_SMOKE_BLOCKS}

Emit your reply in EXACTLY this shape — $VERIFY block, then an $INTERFACE line, then a $SMOKE block, then the $DESIGN block, then the $ARCHITECTURE block. No prose before $VERIFY, no code fences.

${DESIGN_BLOCK_SPEC}

${ARCHITECTURE_BLOCK_SPEC}

${COHERENCE_CHARTER_REQUEST}${artDirectionDesignBlock(input)}

The $DESIGN and $ARCHITECTURE blocks are REQUIRED — without them there is nothing for the ticket decomposition to derive from, and the plan is rejected.`;
}

export function planTicketsSystemPrompt(input: PlanStageInput): string {
  return `You are a software planner decomposing a VALIDATED plan into an ordered queue of tickets. The plan (design and architecture) is in the message that follows this prompt and is the source of truth: do not re-scope it. Your job is execution order — which independently verifiable increments, in what order.

The current known public contracts of the repo (an index that only grows; new tickets should BUILD ON these, not duplicate them):
${input.contractsSummary}
${glossaryBlock(input.existingGlossary)}
DO NOT run shell commands, write files, or explore the filesystem. You already know enough about programming languages, build tools, and test runners from your training data to choose sensible commands and structure the tickets. Running experiments in bash wastes time and context for no benefit — the implementer runs the code; your job is to PLAN it.

Rules:
- COVER THE PLAN: every deliverable the plan commits to must be owned by a ticket. Walk the Architecture module map and the Goal coverage checklist; each named module, mechanism, effect, screen, artifact, or quality mechanism gets an owner. Never silently drop plan scope, and never narrow it to look smaller. If the plan under-specifies something a coherent build needs, add the ticket and name it.
- Each ticket is a single VERTICAL slice: a coherent, independently verifiable increment that leaves the build green and demoable when it commits. The builder runs as ONE durable session across all tickets, so size a ticket by verifiability and natural seams, not by a context window: there is no ticket-count ceiling and no file-count cap. Split when a ticket mixes independent concerns or cannot be verified on its own; merge when a slice is not independently meaningful.
- The FIRST ticket must stand up a buildable scaffold (the project manifest, build scripts, and entry-point tooling the verify list runs), so the very first commit passes the configured verify.
- The entry point is owned once, early: one shell ticket mounts a minimal running shell so the app is runnable and demoable from the second ticket on; later tickets extend it instead of waiting for a terminal "integrate everything" step.
- Package shared conventions (coordinate system, scale, units, origins, tokens) into an EARLY ticket's public surface; later tickets build on it rather than re-deriving it inline.
- Express each ticket from the user's perspective (what it makes work), not a layer-by-layer implementation list, with acceptance criteria as concrete, checkable bullets. Criteria must be verifiable by the implementer's seat: a claim only a human eye can check ("looks good") is not a criterion — name the observable behaviour or the artifact instead. Keep each criterion checkable against the ticket's own change: a repo-wide search or absence claim ("grep finds no X outside Y") cannot be confirmed from one ticket's diff — scope it to the files this ticket owns, or to a command the verify list already runs.
- Order the tickets so each one's prerequisites come before it.
- ${SPINE_FIRST_ORDER}

${QUALITY_PREFERENCES}${artDirectionTicketsBlock(input)}

${TICKET_ARRAY_SPEC}`;
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
- DO NOT run shell commands, write files, or explore the filesystem. You already know enough about programming languages, build tools, and test runners from your training data to choose sensible verify/smoke commands and structure the ticket. Running experiments in bash wastes time and context for no benefit — the implementer runs the code; your job is to PLAN the fix. Emit $VERIFY, $SMOKE, $DESIGN, $ARCHITECTURE, and $TICKETS directly from your knowledge.
- The ticket's "what" MUST carry the reproduction steps the user provided in the planning interview (trigger, symptom, expected behaviour). The implementer reproduces the bug first, then fixes it — give it everything it needs to reproduce.
- The implementer decides whether the bug reproduces. If it does not reproduce, the implementer will honestly say so and make no changes (a no-op commit is fine — see the run's "already-implemented" path). That costs little. The expensive failure is the planner silently suppressing a real bug because a static read looked fine.
- Even if you strongly suspect the bug is already fixed, you are wrong to pre-judge it. Emit the fix ticket. The runtime is the only honest arbiter.

Rules:
- The fix ticket is ONE ticket (a single defect, a single fix). Do not split unless there are genuinely independent defects.
- Name the files and existing functions the implementer should read in the ticket's "what". If the bug report names a symptom, name the file most likely responsible — but frame it as "investigate here" not "the bug is here."
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

/** The plan-gate verdict markers (ADR 0039/0049, railhead v2 issue 01). The
 * goal-review seat judges the finished plan against the ORIGINAL goal before
 * any build starts; scope gaps a run would otherwise discover 30 minutes in
 * fail the plan here. */
export const PLAN_GATE_PASS = "$PLAN_PASS";
export const PLAN_GATE_FAIL = "$PLAN_FAIL";

/** The plan-gate call: the goal-review seat compares the finished plan against
 * the original goal's coverage checklist and names any demand with no owner.
 * It runs AFTER decomposition, when the ticket array exists to be walked. */
export function buildPlanGatePrompt(options: {
  originalPrompt: string;
  /** The rendered PLAN.md (design + architecture + ticket breakdown). */
  planMarkdown: string;
  contractsSummary?: string;
  /** The ticket titles/what in plan order, so the seat can walk ownership. */
  tickets: { number: string; title: string; what: string; criteria: string[] }[];
}): string {
  const { originalPrompt, planMarkdown, contractsSummary, tickets } = options;
  const ticketLines = tickets.length
    ? tickets.map((t) => `- ${t.number} ${t.title}: ${t.what}`).join("\n")
    : "(the plan emitted no tickets)";
  return `You are the PLAN GATE in an unattended build. A planner produced the plan below; no code has been written yet. Your one job: walk the ORIGINAL GOAL's demands (every feature, behaviour, constraint, and quality adjective) and decide whether the plan OWNS each of them — a named ticket whose deliverable produces it, or an explicit plan mechanism.

You are not judging wording, style, or ticket size. You are looking for SCOPE GAPS: a demand the goal makes that no ticket or plan mechanism delivers — the class of gap that otherwise surfaces half an hour into a run when a reviewer flags a missing owner. A demand mapped to a vague deliverable ("polish later", "handle it in the UI ticket") is a gap.

ORIGINAL GOAL/PROMPT:
${originalPrompt}

THE PLAN AS THE HUMAN WILL READ IT:
${planMarkdown}

${contractsSummary ? `CURRENT CONTRACTS (what already exists in the repo):\n${contractsSummary}\n\n` : ""}TICKET OWNERSHIP MAP (the walk list — what each ticket produces):
${ticketLines}

Also apply the ordering rule: the first one or two groups must deliver a launchable, visibly correct vertical slice, not only invisible plumbing. A plan whose entire visible surface arrives in its last group is a gap.

Reply terse, no prose narration. Emit EXACTLY one of:

${PLAN_GATE_PASS}
$END

or

${PLAN_GATE_FAIL}
[GAP] <the goal demand> → <what is missing and the smallest owner that would close it>
$END

Every finding must name the demand and the missing deliverable. Do not flag implementation detail you cannot know before the build exists. If the plan covers the goal, pass — silence on a gap is the failure this gate exists to prevent.`;
}

/** Parse the plan-gate verdict. Defensive like the other verdict parsers: no
 * FAIL marker and no PASS marker → pass (a model that emitted nothing usable
 * must not block a plan); FAIL wins when both markers appear; findings are the
 * non-empty lines between `$PLAN_FAIL` and `$END`; a `$REPLAN` marker (anywhere
 * outside fences) asks for a regenerated frontier rather than a hard stop. */
export function parsePlanGateVerdict(text: string): { verdict: "pass" | "fail"; findings: string[]; replan: boolean } {
  const replan = indexOfOutsideFences(text, /\$replan\b/i) >= 0;
  const failIdx = indexOfOutsideFences(text, /\$plan_fail\b/i);
  const passIdx = indexOfOutsideFences(text, /\$plan_pass\b/i);
  if (failIdx < 0) return { verdict: "pass", findings: [], replan };
  if (passIdx >= 0 && failIdx > passIdx) return { verdict: "pass", findings: [], replan };
  const after = text.slice(failIdx + PLAN_GATE_FAIL.length);
  const end = after.search(/\$end\b/i);
  const body = end >= 0 ? after.slice(0, end) : after;
  const findings = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\$/.test(l));
  return { verdict: "fail", findings, replan };
}

/** The revision call after a planning interview: hand the plan back to the
 * design stage with the user's answers and ask for a full re-emit. */export function buildPlanRevisionPrompt(opts: {
  goal: string;
  priorPlanText: string;
  findings: string[];
}): string {
  const { goal, priorPlanText, findings } = opts;
  return `Your plan was refined in a planning interview with the user; their answers below change or add to it.

ORIGINAL GOAL:
${goal}

THE USER'S ANSWERS:
${findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}

YOUR CURRENT PLAN:
${priorPlanText}

Revise the plan so every answer is genuinely honored: name the concrete deliverable (module, technique, artifact, measured property) each answer demands, and make the architecture cover it. Do not argue with the answers in prose.

Re-emit the COMPLETE plan in the same output shape ($VERIFY, $INTERFACE, $SMOKE, $DESIGN, $ARCHITECTURE), each block exactly once, with $END after each markdown block.`;
}

/** The user-driven revision call (interactive plan review): hand the plan
 * back to the design stage with the user's feedback and ask for a full
 * re-emit. */
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

Revise the COMPLETE plan so every requested change is genuinely addressed: update the mechanism and scope in $DESIGN and $ARCHITECTURE. Do not argue with the feedback in prose — change the plan. If a request is impossible or contradicts the goal, say so in the corresponding block and revise around it.

Re-emit the COMPLETE plan in the same output shape ($VERIFY, $INTERFACE, $SMOKE, $DESIGN, $ARCHITECTURE), each block exactly once, with $END after each markdown block.`;
}

/** Compose the human-facing PLAN.md from the planner's output: the distilled
 * design + architecture and, once they exist, the full ticket breakdown.
 * Written twice in interactive runs: plan-only BEFORE the user is asked to
 * accept it (no tickets exist yet), and again after decomposition with the
 * ticket section appended. Pure. */
export function buildPlanMarkdown(opts: {
  prompt: string;
  designDoc: string | null;
  architectureDoc: string | null;
  /** Omitted/empty before decomposition — the ticket section is then omitted. */
  tickets?: Pick<Ticket, "number" | "title" | "what" | "criteria" | "group" | "open_ended">[];
}): string {
  const { prompt, designDoc, architectureDoc, tickets = [] } = opts;
  const body = [designDoc, architectureDoc].filter((d): d is string => Boolean(d)).join("\n\n")
    || "(the planner emitted no design document)";
  const ticketBlocks = tickets.map((t) => {
    const lines = [`### ${t.number} — ${t.title}`, "", t.what];
    if (t.criteria.length) lines.push(...t.criteria.map((c) => `- Criterion: ${c}`));
    if (t.open_ended) lines.push("- Open-ended craft ticket: judged by looking at the rendered artifact");
    if (t.group) lines.push(`- Group: ${t.group}`);
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

/** Find the lowest index of any of the given markers in `text`, or `text.length`
 * when none match. Shared by the verify/smoke block parsers so each can stop at
 * whichever sibling marker comes next — the plan-marker shape must not let one
 * parser swallow another's region. Case-insensitive on the marker token. */
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
  const end = earliestSiblingMarker(text.slice(afterStart), ["$interface", "$smoke", "$tickets"]);
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
 * NOT a launch command. Smoke is launch commands only. */
export function parseSmokeBlock(text: string): string[] {
  const startMatch = text.match(/\$smoke\s*/i);
  if (!startMatch || startMatch.index === undefined) return [];
  const afterStart = startMatch.index + startMatch[0].length;
  const end = earliestSiblingMarker(text.slice(afterStart), ["$design", "$architecture", "$tickets"]);
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
  const end = earliestSiblingMarker(text.slice(afterStart), ["$verify", "$smoke", "$design", "$architecture", "$tickets"]);
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
 *  (`$ARCHITECTURE`, `$VERIFY`, `$SMOKE`, `$TICKETS`) so a missing
 *  `$END` does not swallow the rest of the planner output. */
export function parseDesignBlock(text: string): string | null {
  const startMatch = text.match(/\$design\s*/i);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterStart = startMatch.index + startMatch[0].length;
  const tail = text.slice(afterStart);
  const block = sliceUntilMarker(tail, ["$architecture", "$verify", "$smoke", "$tickets"]);
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
  const block = sliceUntilMarker(tail, ["$design", "$verify", "$smoke", "$tickets"]);
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
        what: typeof t.what === "string" ? t.what : "",
        criteria: Array.isArray(t.criteria) ? (t.criteria as unknown[]).filter((x): x is string => typeof x === "string") : [],
        open_ended: typeof t.open_ended === "boolean" ? t.open_ended : undefined,
        group: typeof t.group === "string" ? t.group.trim() || undefined : undefined,
      });
    }
  }
  return tickets;
}

/** Whether every `earlier` ticket's title-slug (the same slugify `orderTickets`
 * and the duplicate-slug scan use) appears among `later`'s titles: the later
 * array re-states the whole earlier set, which is the signature of a
 * mid-session REVISION (the model re-emitted its plan in different words)
 * rather than a plan continued across messages. */
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
 * that was dropped, or the half-written tail of a truncated output. It must
 * be surfaced, never silently accepted: a truncated decomposition ships a
 * partial plan. */
export interface PlanParseOutcome {
  tickets: PlanTicket[];
  collapsed: number;
  unparsed: number;
}

/** Count ticket objects a `$TICKETS` region claims to contain — one `"title"`
 * key per ticket in the schema. The integrity baseline `parsePlanRegions`
 * compares parsed tickets against, so a malformed or truncated ticket is
 * visible instead of silently shrinking the plan. */
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
 * (title-slug equivalent), it is a mid-session revision, so it REPLACES the
 * earlier set (LAST wins — the model's final refinement, matching how a human
 * edits a document). Any later array with a genuinely new title is a
 * continuation of a plan too large for one message and is kept ADDITIVELY.
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
export function parsePlanJson(text: string): { tickets: PlanTicket[]; unparsed: number } {
  const { tickets, collapsed, unparsed } = parsePlanRegions(text);
  if (collapsed > 0) {
    console.warn(
      `[plan] the plan transcript contained more than one $TICKETS array — the model revised its plan in a later message; the later array supersedes the earlier one, so ${collapsed} draft ticket(s) were dropped (issue #104)`,
    );
  }
  if (unparsed > 0) {
    console.warn(
      `[plan] ${unparsed} ticket object(s) in the plan output carried a "title" but could not be parsed (malformed or truncated JSON) and were DROPPED — the plan is INCOMPLETE and will build only a partial scope`,
    );
  }
  return { tickets, unparsed };
}
