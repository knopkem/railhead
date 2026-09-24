import { CHECKPOINT_START } from "../core/checkpoint.ts";
import type { CheckpointGranularity } from "../config/config.ts";
import { CHARTER_DOC } from "./coherence.ts";
import { LEARNED_MARKER, RETRACTED_MARKER } from "./learnings.ts";
import { visionCapabilityBlock, type VisionCapabilityFact } from "../execute/vision-probe.ts";
import { renderPreamble, renderTask, type PhaseMessages } from "./preamble.ts";

/**
 * The durable-session builder (ADR 0022, issue #84). This module is the
 * pure-logic half of the builder's resume contract: given where the build
 * stands and what a gate just said, it renders the input the railhead sends to
 * the builder's opencode session.
 *
 * The builder runs as ONE session resumed across ticket boundaries. Its
 * prompt must stay THIN (#75): no visual self-check scaffolding, no
 * attempt-history machinery — the session's own compaction is its context
 * manager, and the repo (not the narrative) is the durable state. What the
 * railhead adds between checkpoints is the gate verdict: review findings,
 * verify output, visual/goal blockers land *in context* so corrections never
 * cross a context boundary (the #61/#66/#67 seam-loss class).
 *
 * Every function here is synchronous and pure so the resume contract is unit-
 * testable without a repo: callers that want AGENTS.md/CONTEXT.md/contracts/
 * learnings loaded render them and pass the text in.
 */

/** One ticket handed to a builder invocation. Under `ticket` granularity the
 * array holds a single ticket; `group`/`product` hold the tickets the builder
 * is expected to burn through before (or between) checkpoints. */
export interface BuilderTicket {
  file: string;
  number: string;
  title: string;
  /** The build's one-line goal, when the plan named one. */
  mission?: string;
  /** The ticket body (what to build). */
  body: string;
  criteria: string[];
  /** The ticket's test-phase `$HANDOFF` (issue #5 / #95 stage 1): an
   * independent author wrote failing tests at the named seams before the
   * builder was asked; this tells the builder what they are and where. Rendered
   * with the ticket so it rides into the resume input exactly when the ticket
   * becomes the builder's current work. */
  handoff?: string;
  /** An open-ended craft ticket: no structural acceptance criteria; the
   * builder iterates on screenshots until it judges the artifact meets the
   * goal. Switches the directive to the craft loop and relaxes output
   * discipline for this ticket. */
  openEnded?: boolean;
}

/** Where the build stands when this invocation is composed. */
export interface BuilderSession {
  /** The opencode session id being resumed. Absent on a fresh or reseeded
   * session (the railhead will capture it from this invocation's stream). */
  sessionId?: string | null;
  /** The ticket number the last green gate committed through, or null when no
   * ticket is committed yet (a fresh run or a reseed after a crash). */
  committedThrough?: string | null;
  /** The git commit of the last green gate, or null. The recovery seed point:
   * a fresh session is told the repo is at this commit. */
  lastGreenCommit?: string | null;
}

/** One gate verdict fed back into the builder's session. */
export interface GateFeedback {
  /** Which gate produced it: review / verify / smoke / visual / goal / test. */
  source: string;
  /** The must-fix findings, verbatim. */
  findings: string[];
}

/** The cadence for an open-ended craft ticket (the art agent). It replaces the
 * "checkpoint the moment it is green" instruction with a screenshot-iteration
 * loop, because the deliverable is the rendered artifact and there are no
 * structural criteria to check off. This is the direct-session behaviour the
 * railhead otherwise suppresses: one agent holding the whole visual goal and
 * refining freely. */
const OPEN_ENDED_CADENCE = `You stop when you judge the artifact genuinely meets the goal. This is an OPEN-ENDED CRAFT ticket: there are NO structural acceptance criteria to check off — the rendered artifact IS the deliverable, and you are its judge. Work in a loop:
1. Build and run the app, and capture a screenshot to a named path.
2. READ the screenshot back (you are vision-capable — the railhead verified it). Never judge from code alone.
3. Judge it against this ticket's goal and the design intent. Name, concretely, what is weakest.
4. Improve the weakest thing. Re-run, re-capture, re-read.
Do NOT stop at the first version that builds and runs. Keep iterating until the artifact is genuinely good, then checkpoint. The artifact is the product: token thrift is NOT a concern on this ticket — re-read files and take as many screenshots as the work needs.`;

/** Text shared by every builder message: the boundary-kill discipline that
 * makes a checkpoint detectable. The marker grammar is the S0.2 contract —
 * one line, own line, `$CHECKPOINT ticket=<number>`, nothing after it. */
export function checkpointDirective(
  granularity: CheckpointGranularity,
  tickets: BuilderTicket[],
): string {
  const names = tickets.map((t) => `\`${t.number}\``).join(", ");
  const openEnded = tickets.some((t) => t.openEnded === true);
  let cadence: string;
  let marker: string;
  if (openEnded) {
    const t = tickets[tickets.length - 1];
    cadence = OPEN_ENDED_CADENCE;
    marker = `${CHECKPOINT_START} ticket=${t ? t.number : "<number>"}`;
  } else if (granularity === "ticket") {
    const t = tickets[0];
    cadence = "You stop at the end of THIS ticket. Implement it, then checkpoint once it is green.";
    marker = `${CHECKPOINT_START} ticket=${t ? t.number : "<number>"}`;
  } else if (granularity === "group") {
    const t = tickets[tickets.length - 1];
    cadence = `You stop at the end of the whole group (tickets ${names}). Implement them in order, then checkpoint once every one is green.`;
    marker = `${CHECKPOINT_START} ticket=${t ? t.number : "<number>"}`;
  } else {
    // gh #105: product mode no longer pre-lists the whole remaining queue.
    // The railhead surfaces tickets ONE at a time (the checkpoint-drift
    // incident: a session shown "03…15" before 03 checkpointed "announced" a
    // checkpoint in prose and jumped ahead into 04). Surface only what the
    // railhead has surfaced; a missing terminal marker is then immediately
    // visible — the model stares at the same ticket with no way forward
    // except the marker.
    cadence = `Product mode: the whole build is this one session, but the railhead surfaces tickets ONE AT A TIME. Implement the current ticket above; checkpoint the moment it is individually green. The railhead gates and commits it, then surfaces the next ticket. Never start work the railhead has not surfaced.`;
    marker = `${CHECKPOINT_START} ticket=<number of the ticket just completed>`;
  }
  const doneCondition = openEnded
    ? "When you judge the artifact meets the goal AND the build/tests below pass on disk,"
    : "When the CURRENT ticket's acceptance criteria are met AND the build/tests below pass on disk,";
  const markerGrammar = `## Checkpointing
${cadence}

A checkpoint marker is how the railhead knows a ticket is done and safe to verify and commit. ${doneCondition} end your reply for that ticket by emitting the marker on its own line as the LAST line, naming the ticket exactly:

${marker}

Then produce nothing further for that ticket — the railhead resumes this session after running its gates${granularity === "product" ? " and surfaces the next ticket once this one is committed" : ""}. Never emit the marker for work that is not green: the railhead gates what you checkpoint.

## Giving up honestly (the blocked exit)
If this ticket cannot be completed or its criteria cannot be verified with the tools this session has, do NOT keep retrying the same approach. A live or interactive criterion gets at most 3 attempts, each changing the mechanism or hypothesis; after that, stop. End your reply with exactly one line:

$BLOCKED ticket=<number> kind=<verification-unavailable|implementation-stuck|plan-defect> reason=<the criterion and why it cannot be met, and what you tried>

Kinds:
- verification-unavailable — the work is done to your knowledge and build/tests pass, but THIS seat cannot prove the criterion. Example: a criterion only a viewer can check and you have no working screenshot path (a canvas with no state hook whose pixel-sampling bot cannot finish). The railhead still runs its verify, smoke, and review gates before committing; if they pass it commits, records the criterion as unverified, and routes it to the reviewing seat that can check it. Do not use this kind to avoid work — the gates still decide the commit.
- implementation-stuck — the behaviour does not work and you cannot make it work (failing tests you cannot fix, a bug that resists your attempts).
- plan-defect — the ticket or plan is impossible or self-contradictory as written (a required symbol another ticket owns, an ordering that cannot hold).

A block is neither failure nor a checkpoint: the railhead routes it by kind (verification debt, one corrective attempt, or a replan). Never emit \`$CHECKPOINT\` for a criterion you did not meet — a false checkpoint is a review finding, and the review will see it. Blocking honestly is always cheaper than thrashing.`;
  return `${markerGrammar}

## Reusable tooling facts (push)
The railhead persists non-obvious tooling or environment facts you discover so later phases of this project do not rediscover them. If working the current ticket taught you one — a dependency the ticket names that does not exist in the registry, a command that fails without a TTY, a port that is not the default — add one line per fact to your closing reply, BEFORE the checkpoint marker, in exactly this form:

${LEARNED_MARKER} <one terse, self-contained fact>

Rules:
- Omit it entirely when you discovered nothing reusable; silence is the correct empty signal. Do NOT emit \`${LEARNED_MARKER} NONE\`.
- Each fact must be self-contained — a later phase with no context must understand it. Name the thing; never "the issue" or "the bug".
- If a learning injected into your prompt above is one you personally proved wrong, retract it with a line before the marker:
${RETRACTED_MARKER} <the prior learning text, or enough of it to uniquely identify the line>

The checkpoint (or blocked) marker must remain the LAST line of your reply.`;
}

/** Render one ticket's body + criteria as the block the builder implements. */
export function renderBuilderTicket(ticket: BuilderTicket, index: number): string {
  const criteria = ticket.criteria.length
    ? ticket.criteria.map((c) => `- [ ] ${c}`).join("\n")
    : "- (no acceptance criteria listed)";
  const mission = ticket.mission ? `\nMISSION: ${ticket.mission}` : "";
  const handoff = ticket.handoff
    ? `\n\nTESTS FOR THIS TICKET (written by an independent test phase — they already exist in the tree; find them and make them pass as part of the work, do not delete or weaken them):\n${ticket.handoff.trim()}`
    : "";
  const openEnded = ticket.openEnded
    ? `\n\nOPEN-ENDED CRAFT TICKET: this ticket has NO structural acceptance criteria — the rendered artifact IS the deliverable, judged by looking at it. Work the screenshot loop in the Checkpointing section and keep improving until it genuinely meets the goal.`
    : "";
  return `### Ticket ${index}. ${ticket.number} — ${ticket.title}${mission}

TICKET FILE: ${ticket.file}

${ticket.body}

ACCEPTANCE CRITERIA:
${criteria}${handoff}${openEnded}`;
}

function continuityBlock(session: BuilderSession): string {
  if (session.committedThrough) {
    const sha = session.lastGreenCommit ? ` (commit ${session.lastGreenCommit.slice(0, 8)})` : "";
    return `## Where the build stands
You have already committed through ticket ${session.committedThrough}${sha}. The repo is at that commit — your changes up to it are committed and verified, so do NOT re-do or rewrite them. Continue from here.`;
  }
  return `## Where the build stands
No tickets are committed yet — the repo is at its scaffold commit. This is the builder's first (or a post-crash reseeded) invocation.`;
}

function verifyBlock(verify: string[]): string {
  const commands = verify.length
    ? verify.map((c) => `- ${c}`).join("\n")
    : "- (none configured)";
  return `## Build & test (run these before every checkpoint)
The railhead gates whatever you checkpoint, so only the green survives. Run these commands yourself and watch them pass before emitting a checkpoint marker:
${commands}`;
}

/** The builder's charter INSTRUCTION block (ADR 0028): the re-read-after-
 * compaction line that OVERRIDES OUTPUT_DISCIPLINE's "do not re-read files you
 * already hold" rule, plus the honor frame. The charter CONTENT lives in the
 * canonical preamble (message 1); this block tells the session how to use it.
 * Shared by the implement prompt and the findings resume so a gate verdict
 * citing chrome rules never references a contract the session cannot see. */
function charterRequestBlock(): string {
  return `## Coherence contract (visual design contract — HONOR IT EXACTLY)
The Coherence contract section above is the planner's terse, normative visual contract, authored at plan time. This work includes surface tickets, so honor the Visual tokens, Layout model, and Chrome rules EXACTLY — import the shared constants module named there rather than redefining values; do not introduce a competing style.

If you touch surface code AFTER a compaction, re-read ${CHARTER_DOC} first — after a compaction you no longer hold the contract, and this re-read overrides the "do not re-read files you already hold" output rule.`;
}

/** The planner's aesthetic/narrative intent (`docs/design.md`) and structural
 * plan (`docs/architecture.md`). The fresh-context implementer has carried
 * these since issue #34, but the durable-session builder did not — so under
 * `session_builder` the vision that the ticket ACs only gesture at was absent
 * from the seat that writes the surface (the platformer run built structurally
 * conforming blob art because the builder was never handed the "make it look
 * like this" document). The charter (`docs/coherence.md`) is the terse
 * normative subset; design.md is the vision the charter constrains. The
 * documents themselves now ride the canonical preamble; these are the
 * seat-specific instructions that point at them. */
export const DESIGN_DOC = "docs/design.md";
export const ARCHITECTURE_DOC = "docs/architecture.md";

function designRequestBlock(): string {
  return `## Design intent (the planner's vision for this build)
The Design intent section above is the planner's captured vision — the aesthetic, narrative, and quality bar this build is judged against, not only the current ticket's acceptance criteria. Implement toward it; a result that passes the criteria while ignoring it is not done.

If you touch surface code AFTER a compaction, re-read ${DESIGN_DOC} first — after a compaction you no longer hold the vision, and this re-read overrides the "do not re-read files you already hold" output rule.`;
}

function architectureRequestBlock(): string {
  return `## Architecture intent (the planner's structural plan)
The Architecture intent section above is the planner's captured module map and cross-cutting concerns — follow it.`;
}

function contextBlocks(opts: {
  contracts?: string | null;
  learnings?: string | null;
  digest?: string | null;
  /** Whether this invocation carries the coherence charter (i.e. includes a
   * surface ticket). Gates the vision self-check: it only makes sense for
   * surface work. */
  surface?: boolean;
  /** ADR 0036: the railhead-measured vision capability (implement seat). Only
   * injected alongside the charter: the self-check it enables is for surface
   * work. */
  visionCapability?: VisionCapabilityFact | null;
}): string {
  const parts: string[] = [];
  if (opts.contracts) {
    parts.push(`## Existing public contracts (REUSE or EXTEND — do not duplicate)
These are the interfaces already in the repo. Honor their signatures exactly:
${opts.contracts}`);
  }
  if (opts.learnings) {
    parts.push(`## Project learnings (tooling facts from prior phases)
These are tooling/environment facts discovered by prior agents. They are unverified model-claims — trust the safe ones, test any self-assessment about your own capabilities before deferring to it. If a fact here is wrong and you prove it, retract it with a ${RETRACTED_MARKER} line in your closing reply (see Checkpointing).
${opts.learnings.split("\n").map((l) => `- ${l}`).join("\n")}`);
  }
  if (opts.digest) {
    // Issue #106 (E): the digest is a third-party model-claim, not tested
    // fact — every other seat's injection (digest.ts buildDigestInjection)
    // carries that caveat; the builder's must too, or a hallucinated digest
    // line reads as ground truth in the seat that acts on it longest.
    parts.push(`## Project digest (architectural state accumulated from prior checkpoints)
This digest is an unverified model-claim written by prior review checkpoints, not a tested fact. If it contradicts what you observe in the source, trust the source.
${opts.digest.split("\n").map((l) => `- ${l}`).join("\n")}`);
  }
  if (opts.visionCapability && opts.surface) {
    const block = visionCapabilityBlock(opts.visionCapability, "implement");
    if (block) parts.push(block.trimStart());
  }
  return renderTask(parts);
}

/** The standing file pointers a warm advance carries INSTEAD of re-injecting
 * full content (issue #106-A). A session holds the blocks it was seeded with
 * until a compaction summarizes them away, so the railhead only re-injects the
 * full content on a fresh seed or after an observed compaction (run.ts's
 * cadence, ADR 0022 §5). Every OTHER advance rides these pointers instead —
 * the file locations are the standing insurance, so the session can re-read
 * the CURRENT contracts/digest when the ticket needs them, without the N-copy
 * duplication a full re-inject per checkpoint would accumulate.
 *
 * The learnings retraction channel is deliberately preserved through the
 * pointer: a session that disproves a learning it holds can re-read
 * `.railhead/learnings.md` to quote the exact line, then emit a
 * ${RETRACTED_MARKER} line — the grammar rides in `checkpointDirective` on
 * every invocation. */
export function standingContextPointers(files: { contracts?: string; learnings?: string; digest?: string; design?: string; architecture?: string }): string {
  const rows = [
    files.contracts ? `- contracts index: ${files.contracts}` : "",
    files.learnings ? `- project learnings: ${files.learnings}` : "",
    files.digest ? `- rolling digest: ${files.digest}` : "",
    files.design ? `- design intent (the vision your surface work is judged against): ${files.design}` : "",
    files.architecture ? `- architecture intent: ${files.architecture}` : "",
  ].filter(Boolean);
  if (rows.length === 0) return "";
  return `## Shared project state (on disk)
The full contracts index, project learnings, rolling digest, design intent, and architecture intent are not re-injected into every resume — your session was handed them when it seeded and holds them until the next compaction (the railhead re-injects after one). They can change between your checkpoints, so when the CURRENT ticket introduces or consumes a public symbol, RE-READ the contracts index file first to honor existing signatures; read the digest only when the module map matters to the work in front of you, and RE-READ the design intent before surface work so the look you are building toward survives the compaction. If you proved a learning in ${files.learnings ?? "the learnings file"} wrong, re-read it to identify the exact line, then retract it with a ${RETRACTED_MARKER} line (see Checkpointing).
${rows.join("\n")}`;
}

const BUILDER_ROLE = `You are the Builder in an unattended, gate-verified build. You run as ONE durable opencode session resumed across checkpoints: the repo is the durable state, your conversation is the working memory, and the railhead runs fresh verification and review gates between your invocations. Compaction inside this session is normal and permitted — it is your context manager, not an error. Do not fight it or pre-shrink your work to avoid it.`;

/** The builder-seat port of the implementer's dependency/tool-output
 * discipline (prompt.ts). The durable session makes thrift MORE load-bearing,
 * not less: every source dump read stays in the window until compaction, so a
 * seat that pre-verifies an API by reading installed dependency source fills
 * its window before writing a line (the ticket-01 scaffold spiral). Rides the
 * seeded/full-context prompt only — a warm pointer resume already holds it. */
const CONTEXT_ECONOMY = `## Context economy (this session persists — every token you read stays until compaction)
Write first, then build to correct. When the ticket needs an external API, write the call from memory NOW and run the build command: a compile error is a ~100-token oracle that names the real API. Reading the dependency's installed source to pre-verify a call is the context bomb this rule exists to prevent — one source dump can cost 5k tokens and answer a question you never had.
When the build proves memory wrong, escalate in order: (1) the dependency's examples/ directory — read ONE example file; (2) the package manifest (features, entry points); (3) a minimal compile probe — a five-line file that imports the API; (4) only after two failed builds on the same symbol, ONE scoped grep (grep -n ... | head -30), never a full file dump.
Scope every command's output before reading it back (\`2>&1 | tail -30\`, \`--stat\`, \`--name-only\`) — a 10k-token log slows every later step of every later ticket.`;

const OUTPUT_DISCIPLINE = `## Output discipline
You run unattended — no human reads your narration, and every prose token you emit stays in the session's context. Be terse. Do not re-read files you already hold; use targeted reads and scoped command output. Only a checkpoint marker (or DONE, in product mode) ends a phase; everything else is work.`;

/** The relaxed discipline for an open-ended craft ticket: the artifact is the
 * product, so the token-thrift rules that protect the code tickets would only
 * suppress the iteration the artifact needs. */
const OPEN_ENDED_OUTPUT_DISCIPLINE = `## Output discipline
This is an open-ended craft ticket: the rendered artifact is the product, so the usual token thrift does NOT apply here. Take the reads and screenshots the work needs. Only a checkpoint marker (or a $BLOCKED line) ends the phase; everything else is work.`;

function outputDisciplineFor(tickets: BuilderTicket[]): string {
  return tickets.some((t) => t.openEnded === true) ? OPEN_ENDED_OUTPUT_DISCIPLINE : OUTPUT_DISCIPLINE;
}

/**
 * The full input for a builder invocation that is being asked to IMPLEMENT
 * work: a fresh session's first message, a reseed after a crash (session id
 * absent, `committedThrough` set), or a green-advance resume (session id set,
 * `committedThrough` advanced). Findings from a failed gate are NOT this
 * message's job — use `buildBuilderFindingsPrompt` so the correction lands in
 * context without the railhead re-narrating the whole session.
 */
export function buildBuilderPrompt(opts: {
  session: BuilderSession;
  granularity: CheckpointGranularity;
  tickets: BuilderTicket[];
  verify: string[];
  contracts?: string | null;
  learnings?: string | null;
  digest?: string | null;
  /** The planner's design narrative (issue #34) — the aesthetic/quality vision
   * this build is judged against. Surface-gated by the caller. */
  designDoc?: string | null;
  /** The planner's structural plan (issue #34). Injected for every ticket. */
  architectureDoc?: string | null;
  /** The coherence charter (ADR 0028), injected when the invocation's tickets
   * include a surface ticket. */
  charter?: string | null;
  /** Issue #106-A: standing file pointers to send INSTEAD of the full
   * contracts/digest content on a warm resume whose session was already told
   * them (seed / post-compaction cadence is the caller's). Mutually exclusive
   * with `contracts`/`digest` content — the caller sends one or the other. */
  contextPointers?: { contracts?: string; learnings?: string; digest?: string; design?: string; architecture?: string };
  contextBudget?: number;
  /** ADR 0036: the railhead-measured vision capability (implement seat),
   * injected with the charter so a capable implementer self-checks surface
   * work with pixels. */
  visionCapability?: VisionCapabilityFact | null;
}): PhaseMessages {
  const { session, granularity, tickets, verify } = opts;
  const budget = opts.contextBudget
    ? `\nYour session's request ceiling is budgeted to roughly ${Math.floor(opts.contextBudget / 1000)}k tokens — keep reads small; the railhead treats crossings as telemetry, compaction manages the rest.`
    : "";
  const ticketBlocks = tickets.map(renderBuilderTicket).join("\n\n");
  // gh #105: under product granularity the caller surfaces the CURRENT ticket
  // only (the whole remaining queue used to be pre-listed, which invited
  // checkpoint-jump-ahead). Name the shape so the session knows later tickets
  // exist but are not its to start. Guarded on a single rendered ticket — a
  // multi-ticket array (only possible in direct unit calls; run.ts slices
  // before composing) keeps the plain forward-plan wording.
  const forwardLine =
    granularity === "product" && tickets.length === 1
      ? `The ticket above is the CURRENT ticket the railhead has surfaced. Later tickets exist and the railhead hands them over only after this ticket's green checkpoint — never start work the railhead has not surfaced.`
      : `The list above is the forward plan this session implements${session.committedThrough ? " from where the build stands" : ""}. Contracts and guidance follow.`;
  const stateBlock = opts.contextPointers
    ? standingContextPointers(opts.contextPointers)
    : contextBlocks({
        contracts: opts.contracts,
        learnings: opts.learnings,
        digest: opts.digest,
        surface: !!opts.charter,
        visionCapability: opts.visionCapability,
      });
  // The stable docs (design/architecture/charter) ride the canonical preamble;
  // the task carries only the seat instructions that point at them.
  const requestBlocks = renderTask([
    opts.designDoc ? designRequestBlock() : "",
    opts.architectureDoc ? architectureRequestBlock() : "",
    opts.charter ? charterRequestBlock() : "",
  ]);
  return {
    preamble: renderPreamble({
      design: opts.designDoc ?? null,
      architecture: opts.architectureDoc ?? null,
      coherence: opts.charter ?? null,
    }),
    task: renderTask([
      BUILDER_ROLE,
      continuityBlock(session),
      `## Work to do
${ticketBlocks}`,
      verifyBlock(verify),
      forwardLine,
      // Full-context sends only: a warm pointer resume already holds the block
      // from its seed (the #106 dedup cadence the content blocks follow).
      opts.contextPointers ? "" : CONTEXT_ECONOMY,
      stateBlock,
      requestBlocks,
      checkpointDirective(granularity, tickets),
      outputDisciplineFor(tickets) + budget,
    ]),
  };
}

/**
 * The resume input when a GATE found problems in work the builder just
 * produced: verify failed, review returned blocking findings, or a
 * visual/goal/structural gate emitted blockers. Findings are injected verbatim
 * so the session that wrote the code — not a fresh explorer that re-reads the
 * repo — receives them (ADR 0022 §2: corrections do not cross a context
 * boundary). The same ticket stays current; the builder does not advance until
 * its gate is green.
 */
export function buildBuilderFindingsPrompt(opts: {
  session: BuilderSession;
  granularity: CheckpointGranularity;
  tickets: BuilderTicket[];
  verify: string[];
  feedback: GateFeedback;
  /** The planner's design narrative (issue #34), carried when the corrected
   * ticket is surface. A gate verdict that cites the design intent (a visual
   * or goal finding) must never reference a document the session cannot see. */
  design?: string | null;
  /** The coherence charter (ADR 0028), carried when the corrected ticket is
   * surface. This seat otherwise carries NO contextBlocks — a gate verdict
   * citing chrome rules must never reference a contract the session cannot
   * see, so the charter rides the canonical preamble and its re-read line
   * rides this task explicitly. */
  coherence?: string | null;
}): PhaseMessages {
  const { session, granularity, tickets, verify, feedback, design, coherence } = opts;
  const findingsBlock = feedback.findings.length
    ? feedback.findings.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "(no findings listed)";
  return {
    preamble: renderPreamble({ design: design ?? null, coherence: coherence ?? null }),
    task: renderTask([
      BUILDER_ROLE,
      continuityBlock(session),
      `## The ${feedback.source} gate found problems in your last checkpoint
A fresh ${feedback.source} gate ran against the diff you just produced and it did not pass. The session that wrote the code receives the verdict directly — fix every item below IN the current ticket's work, then re-run the build/test commands, then checkpoint again. Do NOT proceed to a later ticket while a must-fix stands, and do not argue in prose — the fix is the argument.`,
      `### Must-fix findings
${findingsBlock}`,
      tickets.map(renderBuilderTicket).join("\n\n"),
      verifyBlock(verify),
      design ? designRequestBlock() : "",
      coherence ? charterRequestBlock() : "",
      checkpointDirective(granularity, tickets),
      outputDisciplineFor(tickets),
    ]),
  };
}
