import { describe, it, expect } from "vitest";
import {
  buildBuilderPrompt,
  buildBuilderFindingsPrompt,
  checkpointDirective,
  type BuilderTicket,
} from "./builder.ts";
import { CHECKPOINT_START } from "../core/checkpoint.ts";
import { LEARNED_MARKER, RETRACTED_MARKER } from "./learnings.ts";
import { joinPhaseMessages, type PhaseMessages } from "./preamble.ts";

/** The existing assertions cover the effective single-message prompt. The
 * builder builders now return the two-part shape (#132); these wrappers join
 * it so the long-standing content assertions keep evaluating exactly what the
 * model receives. The split itself is asserted in prompt.test.ts. */
const promptText = (m: PhaseMessages): string => joinPhaseMessages(m);
const builderPrompt = (o: Parameters<typeof buildBuilderPrompt>[0]) => promptText(buildBuilderPrompt(o));
const builderFindings = (o: Parameters<typeof buildBuilderFindingsPrompt>[0]) => promptText(buildBuilderFindingsPrompt(o));

const ticket01: BuilderTicket = {
  file: "tickets/01-greet.md",
  number: "01",
  title: "Add greet",
  mission: "Build the greeter.",
  body: "Add a greet function that returns a greeting for a name.",
  criteria: ["greet(name) returns `Hello, <name>!`"],
};

const ticket02: BuilderTicket = {
  file: "tickets/02-bye.md",
  number: "02",
  title: "Add bye",
  body: "Add a bye function.",
  criteria: ["bye(name) returns `Goodbye, <name>!`"],
};

const fresh = { session: {}, granularity: "ticket" as const, tickets: [ticket01], verify: ["npm test"] };

describe("two-part builder prompts (#132 — canonical preamble + volatile task)", () => {
  it("stable docs ride the preamble; tickets, contracts and learnings ride the task", () => {
    const m = buildBuilderPrompt({
      session: {},
      granularity: "ticket",
      tickets: [ticket01],
      verify: ["npm test"],
      contracts: "greet(name) -> string",
      learnings: "the dev server needs a TTY",
      designDoc: "Narrative: neon and gliding.",
      architectureDoc: "Modules: grid, snake.",
      charter: "Visual tokens: NEON from src/ui/tokens.ts.",
    });
    expect(m.preamble).toContain("Narrative: neon and gliding.");
    expect(m.preamble).toContain("Modules: grid, snake.");
    expect(m.preamble).toContain("Visual tokens: NEON from src/ui/tokens.ts.");
    expect(m.preamble).not.toContain("Add a greet function");
    expect(m.preamble).not.toContain("greet(name) -> string");
    expect(m.preamble).not.toContain("the dev server needs a TTY");
    expect(m.task).toContain("Add a greet function");
    expect(m.task).toContain("greet(name) -> string");
    expect(m.task).toContain("the dev server needs a TTY");
    expect(m.task).not.toContain("Narrative: neon and gliding.");
  });

  it("findings resume keeps the same split", () => {
    const m = buildBuilderFindingsPrompt({
      session: { sessionId: "sess_abc", committedThrough: "01" },
      granularity: "ticket",
      tickets: [ticket02],
      verify: ["npm test"],
      feedback: { source: "verify", findings: ["Verification failed. Output:\nsrc/index.js:3 boom"] },
      design: "Narrative: neon and gliding.",
      coherence: "Visual tokens: NEON.",
    });
    expect(m.preamble).toContain("Narrative: neon and gliding.");
    expect(m.preamble).toContain("Visual tokens: NEON.");
    expect(m.preamble).not.toContain("boom");
    expect(m.task).toContain("boom");
    expect(m.task).toContain("Add a bye function");
  });

  it("a warm pointer resume carries no stable docs in the preamble (the session already holds them)", () => {
    const m = buildBuilderPrompt({
      session: { sessionId: "ses_x" },
      granularity: "ticket",
      tickets: [ticket01],
      verify: ["npm test"],
      contextPointers: { contracts: "railhead.contracts.json" },
    });
    expect(m.preamble).toBe("");
    expect(m.task).toContain("Shared project state (on disk)");
  });
});

describe("buildBuilderPrompt context economy (builder-seat dependency discipline)", () => {
  it("arms the seeded builder with memory-first API use and the compiler-as-oracle escalation ladder", () => {
    // The gap behind a live spiral: a builder seat spent 35 of 54 tool calls
    // grepping a dependency's installed source to pre-verify an API — the
    // implementer prompt forbids this, but the builder prompt never carried
    // the rule. The seeded session must hear it.
    const p = builderPrompt(fresh);
    expect(p).toContain("Context economy");
    expect(p).toContain("from memory");
    expect(p).toContain("compile error is a ~100-token oracle");
    expect(p).toContain("examples/ directory");
    expect(p).toContain("never a full file dump");
  });

  it("does NOT repeat the block on a warm pointer resume (the session holds it from its seed — #106 dedup)", () => {
    const p = builderPrompt({ ...fresh, session: { sessionId: "ses_x" }, contextPointers: { contracts: "railhead.contracts.json" } });
    expect(p).not.toContain("Context economy");
  });
});

describe("buildBuilderPrompt (issue #84)", () => {
  it("carries the ticket body, criteria, file, mission and the verify command into a fresh builder", () => {
    const p = builderPrompt(fresh);
    expect(p).toContain("tickets/01-greet.md");
    expect(p).toContain("Add a greet function that returns a greeting for a name.");
    expect(p).toContain("greet(name) returns `Hello, <name>!`");
    expect(p).toContain("Build the greeter.");
    expect(p).toContain("npm test");
  });

  it("is thin: names the durable-session contract but carries no implementer scaffolding", () => {
    const p = builderPrompt(fresh);
    expect(p).toContain("durable opencode session");
    // #75: the anti-pattern the builder must not grow — visual self-checking,
    // attempt-history, fresh-context warnings.
    expect(p).not.toMatch(/Fresh context/i);
    expect(p).not.toMatch(/attempt history/i);
  });

  it("ends the current-ticket reply with the checkpoint marker grammar naming the ticket", () => {
    const p = builderPrompt(fresh);
    expect(p).toContain(`${CHECKPOINT_START} ticket=01`);
    expect(p).toContain("LAST line");
  });

  it("tells the builder to push reusable tooling facts via LEARNED lines BEFORE the checkpoint marker, and to retract falsified learnings (builder learnings push wiring)", () => {
    const p = builderPrompt(fresh);
    expect(p).toContain("Reusable tooling facts (push)");
    expect(p).toContain(`${LEARNED_MARKER} <one terse, self-contained fact>`);
    expect(p).toContain(`${RETRACTED_MARKER} <the prior learning text`);
    // the fact lines are explicitly placed before the terminal marker, which
    // must stay the last line — so pushLearnings (run.ts) can parse them out
    // of the transcript the same way it parses the classic implementer's.
    expect(p).toMatch(/BEFORE the checkpoint marker/i);
    expect(p).toMatch(/checkpoint \(or blocked\) marker must remain the LAST line/i);
  });

  it("carries the learnings push directive into every granularity (the findings resume gets it too)", () => {
    for (const granularity of ["ticket", "group", "product"] as const) {
      const p = builderPrompt({ session: {}, granularity, tickets: [ticket01, ticket02], verify: ["npm test"] });
      expect(p).toContain(LEARNED_MARKER);
    }
  });

  it("states the commit continuity on a green-advance resume so the session does not redo committed work", () => {
    const p = builderPrompt({
      ...fresh,
      session: { sessionId: "sess_abc", committedThrough: "01", lastGreenCommit: "deadbeef1234" },
    });
    expect(p).toContain("committed through ticket 01");
    expect(p).toContain("deadbeef");
    expect(p).toContain("do NOT re-do or rewrite them");
  });

  it("states that no work is committed on a fresh or reseeded session", () => {
    const p = builderPrompt(fresh);
    expect(p).toContain("No tickets are committed yet");
  });

  it("injects rendered contracts, learnings and digest when supplied", () => {
    const p = builderPrompt({
      ...fresh,
      contracts: "greet(name) -> string",
      learnings: "screencapture -x gives raw PNG on macOS",
      digest: "module map: src/",
    });
    expect(p).toContain("greet(name) -> string");
    expect(p).toContain("screencapture -x gives raw PNG on macOS");
    expect(p).toContain("module map: src/");
  });

  it("learnings injection tells the builder it may retract an injected learning it personally proved wrong", () => {
    const p = builderPrompt({
      ...fresh,
      learnings: "this project's dev server panics without a TTY",
    });
    expect(p).toContain("retract it with a RETRACTED: line in your closing reply");
    expect(p).toContain(RETRACTED_MARKER);
  });

  it("issue #106 (E): the builder's digest block carries the unverified-model-claim caveat every other seat's injection adds", () => {
    const p = builderPrompt({
      ...fresh,
      digest: "module map: src/\nrenderer owns the frame loop",
    });
    expect(p).toContain("unverified model-claim");
    expect(p).toContain("trust the source");
    // The digest content is bulletized like buildDigestInjection's, not raw.
    expect(p).toContain("- module map: src/");
    expect(p).not.toContain("\nmodule map: src/\n");
  });

  it("issue #106 (A): a warm advance given contextPointers sends standing file pointers, not full content — and keeps the retraction grammar", () => {
    const p = builderPrompt({
      ...fresh,
      contextPointers: {
        contracts: "railhead.contracts.json",
        learnings: ".railhead/learnings.md",
        digest: ".railhead/digest.md",
      },
    });
    expect(p).toContain("Shared project state (on disk)");
    expect(p).toContain("- contracts index: railhead.contracts.json");
    expect(p).toContain("- project learnings: .railhead/learnings.md");
    expect(p).toContain("- rolling digest: .railhead/digest.md");
    // No full content re-injected on the warm path.
    expect(p).not.toMatch(/## Existing public contracts \(REUSE or EXTEND/);
    expect(p).not.toMatch(/## Project learnings \(tooling facts from prior phases\)/);
    expect(p).not.toMatch(/## Project digest \(architectural state/);
    // The learnings retraction channel survives: the pointer names the file and
    // the checkpoint grammar (always present) still instructs RETRACTED.
    expect(p).toContain(RETRACTED_MARKER);
    expect(p).toContain(".railhead/learnings.md");
  });

  it("routes checkpoint_granularity into the directive (group + product)", () => {
    const group = checkpointDirective("group", [ticket01, ticket02]);
    expect(group).toContain("end of the whole group");
    expect(group).toContain("`01`");
    const product = builderPrompt({
      session: {},
      granularity: "product",
      tickets: [ticket01, ticket02],
      verify: ["npm test"],
    });
    expect(product).toContain("Product mode");
    expect(product).toContain("surfaces tickets ONE AT A TIME");
  });

  it("ADR 0040: carries the blocked-exit contract with the bounded live-verification rule and the three kinds", () => {
    const d = checkpointDirective("product", [ticket01]);
    expect(d).toContain("$BLOCKED ticket=");
    expect(d).toMatch(/at most 3 attempts/i);
    expect(d).toContain("verification-unavailable");
    expect(d).toContain("implementation-stuck");
    expect(d).toContain("plan-defect");
    // A block is not a checkpoint: the false-checkpoint warning stays explicit.
    expect(d).toMatch(/false checkpoint is a review finding/i);
    // The marker contract stays last-line anchored.
    expect(d).toMatch(/blocked\) marker must remain the LAST line/i);
  });

  it("gh #105: product prompts surface the current ticket only and say tickets arrive one at a time", () => {
    const single = builderPrompt({
      session: {},
      granularity: "product",
      tickets: [ticket01],
      verify: ["npm test"],
    });
    // Exactly one ticket block, framed as the CURRENT ticket.
    expect(single.match(/### Ticket \d/g)).toHaveLength(1);
    expect(single).toContain("CURRENT ticket the railhead has surfaced");
    expect(single).toContain("surfaces tickets ONE AT A TIME");
    expect(single).toContain("Never start work the railhead has not surfaced");
    // The marker grammar tells the session to stop at the ticket, not to jump
    // into later tickets it cannot see (the marker itself stays generic in
    // product cadence — the railhead reconciles the emitted ticket number).
    expect(single).not.toMatch(/WITHOUT stopping between them/);
    expect(single).not.toMatch(/start the next ticket's work in your next message/);

    const findings = builderFindings({
      session: { sessionId: "sess_abc", committedThrough: "01" },
      granularity: "product",
      tickets: [ticket02],
      verify: ["npm test"],
      feedback: { source: "verify", findings: ["Verification failed. Output:\nsrc/index.js:3 boom"] },
    });
    // Findings resume also renders exactly the current ticket, and carries the
    // one-at-a-time directive (the expected-marker reconcile is run.ts's).
    expect(findings.match(/### Ticket \d/g)).toHaveLength(1);
    expect(findings).toContain("tickets/02-bye.md");
    expect(findings).toContain("surfaces tickets ONE AT A TIME");
  });
  it("injects the ticket's test-phase handoff into the prompt that first asks for it (issue #95)", () => {
    const p = builderPrompt({
      ...fresh,
      tickets: [
        {
          ...ticket01,
          handoff: "tests/greet.test.ts expects greet('bo') to return 'Hello, bo!' — it currently fails (module not found).",
        },
      ],
    });
    expect(p).toContain("TESTS FOR THIS TICKET");
    expect(p).toContain("tests/greet.test.ts expects greet('bo')");
    expect(p).toContain("make them pass");
  });

  it("omits the handoff block when the test phase produced none", () => {
    const p = builderPrompt(fresh);
    expect(p).not.toMatch(/TESTS FOR THIS TICKET/);
  });
});

describe("buildBuilderFindingsPrompt (issue #84 — findings re-injection)", () => {
  it("injects the gate's findings verbatim into the resume input with the source named", () => {
    const findings = [
      "[BLOCKER] greet() throws when the name contains leading whitespace",
      "[MAJOR] greet() mutates the input string",
    ];
    const p = builderFindings({
      session: { sessionId: "sess_abc", committedThrough: "01", lastGreenCommit: "deadbeef" },
      granularity: "ticket",
      tickets: [ticket01],
      verify: ["npm test"],
      feedback: { source: "review", findings },
    });
    expect(p).toContain("review gate");
    expect(p).toContain("committed through ticket 01");
    for (const f of findings) expect(p).toContain(f);
  });

  it("carries the learnings push directive, so a gate-fix resume persists discoveries too", () => {
    const p = builderFindings({
      session: { sessionId: "sess_abc", committedThrough: "01" },
      granularity: "ticket",
      tickets: [ticket01],
      verify: ["npm test"],
      feedback: { source: "review", findings: ["[BLOCKER] greet() throws on empty name"] },
    });
    expect(p).toContain(LEARNED_MARKER);
    expect(p).toContain(RETRACTED_MARKER);
    expect(p).toMatch(/BEFORE the checkpoint marker/i);
  });

  it("keeps the CURRENT ticket current — the builder does not advance until its gate is green", () => {
    const p = builderFindings({
      session: { sessionId: "sess_abc", committedThrough: "01" },
      granularity: "ticket",
      tickets: [ticket02],
      verify: ["npm test"],
      feedback: { source: "visual", findings: ["[BLOCKER] the button is off-screen"] },
    });
    expect(p).toContain("tickets/02-bye.md");
    expect(p).toContain("Do NOT proceed to a later ticket while a must-fix stands");
    expect(p).toContain(`${CHECKPOINT_START} ticket=02`);
  });
});

describe("coherence charter in the builder (issue #99 / ADR 0028)", () => {
  const charter = "### Visual tokens\nNEON palette from src/ui/tokens.ts.";
  const feedback = { source: "review", findings: ["[MAJOR] toolbar uses a competing recipe"] };

  it("injects the charter via contextBlocks when the invocation is surface (buildBuilderPrompt)", () => {
    const p = builderPrompt({ ...fresh, charter });
    expect(p).toContain("Coherence contract (visual design contract");
    expect(p).toContain("NEON palette");
    expect(p).toContain("do not introduce a competing style");
  });

  it("the builder charter block carries the re-read-after-compaction line that overrides the no-re-read rule", () => {
    const p = builderPrompt({ ...fresh, charter });
    expect(p).toMatch(/re-read docs\/coherence\.md.*after a compaction/i);
    expect(p).toContain('overrides the "do not re-read files you already hold" output rule');
  });

  it("omits the charter when none is supplied", () => {
    const p = builderPrompt(fresh);
    expect(p).not.toContain("Coherence contract (visual design contract");
  });

  it("buildBuilderFindingsPrompt carries the charter when the corrected ticket is surface", () => {
    const p = builderFindings({ ...fresh, feedback, coherence: charter });
    expect(p).toContain("Coherence contract (visual design contract");
    expect(p).toContain("NEON palette");
    expect(p).toContain("the fix is the argument");
  });

  it("buildBuilderFindingsPrompt omits the charter when the corrected ticket is not surface", () => {
    const p = builderFindings({ ...fresh, feedback });
    expect(p).not.toContain("Coherence contract (visual design contract");
  });
});

describe("design + architecture intent in the builder (issue #34 gap under session_builder)", () => {
  const design = "## Identity\nA crisp pixel-art descent with one palette.";
  const architecture = "## Module map\nsrc/render owns the frame loop.";

  it("injects the planner's design vision and architecture map via contextBlocks on a full seed", () => {
    const p = builderPrompt({ ...fresh, designDoc: design, architectureDoc: architecture });
    expect(p).toContain("Design intent (the planner's vision for this build)");
    expect(p).toContain("A crisp pixel-art descent with one palette.");
    expect(p).toContain("Architecture intent (the planner's structural plan)");
    expect(p).toContain("src/render owns the frame loop.");
    // The vision carries the re-read-after-compaction override, like the charter.
    expect(p).toMatch(/re-read docs\/design\.md.*after a compaction/i);
  });

  it("omits the design narrative when the invocation is not surface, but keeps the architecture map", () => {
    const p = builderPrompt({ ...fresh, architectureDoc: architecture });
    expect(p).not.toContain("Design intent (the planner's vision for this build)");
    expect(p).toContain("Architecture intent (the planner's structural plan)");
  });

  it("carries design + architecture as standing pointers on a warm advance, not full content", () => {
    const p = builderPrompt({
      ...fresh,
      contextPointers: {
        contracts: "railhead.contracts.json",
        design: "docs/design.md",
        architecture: "docs/architecture.md",
      },
    });
    expect(p).toContain("- design intent (the vision your surface work is judged against): docs/design.md");
    expect(p).toContain("- architecture intent: docs/architecture.md");
    expect(p).not.toContain("## Design intent (the planner's vision for this build)");
    expect(p).not.toContain("## Architecture intent (the planner's structural plan)");
    expect(p).toMatch(/RE-READ the design intent before surface work/i);
  });

  it("carries the design vision into the findings resume when the corrected ticket is surface", () => {
    const p = builderFindings({
      ...fresh,
      feedback: { source: "visual", findings: ["[BLOCKER] the scene does not match the intended identity"] },
      design,
    });
    expect(p).toContain("Design intent (the planner's vision for this build)");
    expect(p).toContain("A crisp pixel-art descent with one palette.");
  });

  it("omits the design vision from the findings resume when none is supplied", () => {
    const p = builderFindings({
      ...fresh,
      feedback: { source: "review", findings: ["[MAJOR] duplicated helper"] },
    });
    expect(p).not.toContain("Design intent (the planner's vision for this build)");
  });
});

describe("open-ended craft ticket — the art agent", () => {
  const artTicket: BuilderTicket = {
    file: "tickets/10-art-direction.md",
    number: "10",
    title: "Art direction: compose the scene",
    body: "Create the composed scene, iterating on screenshots until the goal is met.",
    criteria: [],
    openEnded: true,
  };

  it("switches the directive to the screenshot-iteration craft loop, not checkpoint-on-green", () => {
    const p = builderPrompt({ session: {}, granularity: "product", tickets: [artTicket], verify: ["npm test"] });
    expect(p).toContain("OPEN-ENDED CRAFT ticket");
    expect(p).toMatch(/READ the screenshot back/i);
    expect(p).toMatch(/Keep iterating until the artifact is genuinely good/i);
    expect(p).not.toMatch(/checkpoint the moment it is individually green/i);
  });

  it("relaxes the token-thrift output discipline for the craft ticket", () => {
    const p = builderPrompt({ session: {}, granularity: "product", tickets: [artTicket], verify: ["npm test"] });
    expect(p).not.toMatch(/Be terse/i);
    expect(p).toMatch(/token thrift does NOT apply/i);
  });

  it("keeps the ordinary discipline and checkpoint cadence for normal tickets", () => {
    const p = builderPrompt(fresh);
    expect(p).toMatch(/Be terse/i);
    expect(p).not.toContain("OPEN-ENDED CRAFT ticket");
  });

  it("carries the craft loop into the findings resume too", () => {
    const p = builderFindings({
      session: { sessionId: "sess_abc", committedThrough: "09" },
      granularity: "product",
      tickets: [artTicket],
      verify: ["npm test"],
      feedback: { source: "verify", findings: ["build failed"] },
    });
    expect(p).toContain("OPEN-ENDED CRAFT ticket");
    expect(p).not.toMatch(/Be terse/i);
  });
});

describe("builder vision capability injection (ADR 0036)", () => {
  it("carries the implementer self-check when surface work and a verified capability meet", () => {
    const p = builderPrompt({
      ...fresh,
      charter: "### Visual tokens\nUse TOKENS.",
      visionCapability: { readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(p).toContain("Vision capability (railhead-verified)");
    expect(p).toContain("capture a screenshot");
  });

  it("omits the self-check without the charter (non-surface work)", () => {
    const p = builderPrompt({
      ...fresh,
      visionCapability: { readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(p).not.toContain("Vision capability (railhead-verified)");
  });
});
