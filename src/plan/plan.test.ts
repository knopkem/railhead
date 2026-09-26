import { describe, it, expect, vi } from "vitest";
import {
  planDesignSystemPrompt,
  planTicketsSystemPrompt,
  planFeatureDesignSystemPrompt,
  planFeatureTicketsSystemPrompt,
  planFixSystemPrompt,
  planContinuationSystemPrompt,
  buildPlanRevisionPrompt,
  buildProductSessionPrompt,
  buildProductRevisionPrompt,
  parseProductReply,
  buildFeatureStepPrompt,
  parseFeatureStepReply,
  buildPlanUserFeedbackPrompt,
  buildPlanMarkdown,
  buildPlanGatePrompt,
  parsePlanGateVerdict,
  parsePlanJson,
  parsePlanRegions,
  parseVerifyBlock,
  parseSmokeBlock,
  parseInterfaceBlock,
  parseDesignBlock,
  parseArchitectureBlock,
  parseCoherenceContract,
  splitCoherenceContract,
  QUALITY_PREFERENCES,
} from "./plan.ts";

// ---------------------------------------------------------------------------
// stage prompts
// ---------------------------------------------------------------------------

describe("planDesignSystemPrompt — stage 1 (the design)", () => {
  const p = () => planDesignSystemPrompt({ contractsSummary: "MODULE_A" });

  it("requires $DESIGN and $ARCHITECTURE and does NOT ask for a $PLAN block", () => {
    const text = p();
    expect(text).toContain("$DESIGN");
    expect(text).toContain("$ARCHITECTURE");
    expect(text).not.toMatch(/\$PLAN\b/);
    expect(text).toMatch(/DESIGN and \$ARCHITECTURE blocks are REQUIRED/);
  });

  it("demands a Goal coverage checklist mapping demands to concrete deliverables", () => {
    const text = p();
    expect(text).toMatch(/Goal coverage/);
    expect(text).toMatch(/an adjective is not a deliverable/i);
  });

  it("carries the verify/interface/smoke rules", () => {
    expect(p()).toMatch(/\$VERIFY/);
    expect(p()).toMatch(/\$INTERFACE/);
    expect(p()).toMatch(/\$SMOKE/);
  });

  it("includes the claim discipline and quality preferences", () => {
    expect(p()).toContain("Claim discipline");
    expect(p()).toContain("Prefer fewer dependencies");
  });

  it("requests art direction for a rendered surface unless disabled", () => {
    expect(planDesignSystemPrompt({ contractsSummary: "" })).toMatch(/ART DIRECTION/);
    expect(planDesignSystemPrompt({ contractsSummary: "", artDirection: false })).not.toMatch(/ART DIRECTION/);
  });

  it("requests the coherence charter", () => {
    expect(p()).toMatch(/COHERENCE CHARTER/);
    expect(p()).toMatch(/Visual tokens/);
    expect(p()).toMatch(/Chrome rules/);
  });

  it("states the spine-first order (early visible slice, not all plumbing first)", () => {
    expect(p()).toMatch(/SPINE-FIRST ORDER/);
    expect(p()).toMatch(/one or two groups must deliver a LAUNCHABLE, VISIBLY CORRECT vertical slice/);
  });
});

describe("planTicketsSystemPrompt — stage 2 (decomposition)", () => {
  const p = () => planTicketsSystemPrompt({ contractsSummary: "(none)" });

  it("asks for the small ticket schema: title/what/criteria/group/open_ended", () => {
    const text = p();
    expect(text).toContain('"title"');
    expect(text).toContain('"what"');
    expect(text).toContain('"criteria"');
    expect(text).toContain('"group"');
    expect(text).toContain('"open_ended"');
  });

  it("does NOT ask for the retired fields (files/references/introduces/blocked_by/mission/testable)", () => {
    const text = p();
    expect(text).not.toMatch(/"files"\s*:/);
    expect(text).not.toMatch(/"references"\s*:/);
    expect(text).not.toMatch(/"introduces"\s*:/);
    expect(text).not.toMatch(/"blocked_by"\s*:/);
    expect(text).not.toMatch(/"mission"\s*:/);
    expect(text).not.toMatch(/"testable"\s*:/);
  });

  it("requires strict emission order and prerequisite-first ordering", () => {
    const text = p();
    expect(text).toMatch(/order you emit them/i);
    expect(text).toMatch(/prerequisite/i);
  });

  it("states the spine-first ordering rule: an early launchable, visible slice", () => {
    const text = p();
    expect(text).toMatch(/SPINE-FIRST ORDER/);
    expect(text).toMatch(/LAUNCHABLE, VISIBLY CORRECT vertical slice/);
    expect(text).toMatch(/deep-logic tickets.*all precede UI composition/i);
  });

  it("asks for observable behaviours with an optional indented probe recipe, never (test) criteria", () => {
    const text = p();
    expect(text).toMatch(/observable behaviour sentence/);
    expect(text).toMatch(/probe:/);
    expect(text).toMatch(/Do NOT write "\(test\)" criteria/);
  });

  it("tells the model to continue with a second $TICKETS array when the first is truncated", () => {
    const text = p();
    expect(text).toMatch(/REMAINING tickets in a second \$TICKETS array/);
    expect(text).toMatch(/never leave a ticket object half-written/);
  });

  it("keeps the single open-ended art ticket rule for rendered surfaces", () => {
    const text = p();
    expect(text).toMatch(/OPEN-ENDED CRAFT TICKET/);
    expect(text).toMatch(/exactly ONE/i);
  });

  it("drops the art rule when art direction is disabled", () => {
    expect(planTicketsSystemPrompt({ contractsSummary: "", artDirection: false })).not.toMatch(/OPEN-ENDED CRAFT TICKET/);
  });
});

// ---------------------------------------------------------------------------
// feature-mode prompts: ONE feature lands in an EXISTING product
// ---------------------------------------------------------------------------

const FEATURE_BRIEF = "## Stack\nFEATURE_STACK_LOCKED — decided, never re-decided.\n## Vision\nA trail log the family opens.";

describe("planFeatureDesignSystemPrompt — feature mode stage 1", () => {
  const p = () =>
    planFeatureDesignSystemPrompt({
      contractsSummary: "MODULE_A",
      productBrief: FEATURE_BRIEF,
      existingCharter: "Held charter text with CHARTER_VALUABLE_LINE.",
    });

  it("plans a feature INSIDE an existing, running product — the baseline is green", () => {
    const text = p();
    expect(text).toMatch(/EXISTING product/);
    expect(text).toMatch(/already runs/);
    expect(text).toMatch(/green before every run starts/);
  });

  it("carries the decided product brief verbatim and forbids re-deciding the stack", () => {
    const text = p();
    expect(text).toContain(FEATURE_BRIEF);
    expect(text).toMatch(/must not be re-decided/i);
  });

  it("carries the held coherence contract as normative and does NOT request a fresh authoring", () => {
    const text = p();
    expect(text).toContain("CHARTER_VALUABLE_LINE");
    expect(text).toMatch(/normative/i);
    expect(text).not.toMatch(/COHERENCE CHARTER/);
  });

  it("without a held charter it still requests one — a product's first feature may establish it", () => {
    expect(planFeatureDesignSystemPrompt({ contractsSummary: "" })).toMatch(/COHERENCE CHARTER/);
  });

  it("names integration with existing seams as a completeness requirement", () => {
    expect(p()).toMatch(/integration point/);
    expect(p()).toMatch(/docks into|docks into the existing/i);
  });

  it("never plans scaffolding or a second entry point", () => {
    const text = p();
    expect(text).toMatch(/Do not plan scaffolding/);
    expect(text).toMatch(/new capability|RESOLUTION/);
  });

  it("frames verify as guarding the project's existing suite — never weaken, rename, drop, or extend the global gate", () => {
    const text = p();
    expect(text).toMatch(/ALREADY HAS a working verify suite/);
    expect(text).toMatch(/never weaken, rename, or drop/i);
    expect(text).toMatch(/Do NOT add new checks that only pass once the feature is complete/);
    expect(text).toMatch(/the final hardening ticket/);
  });

  it("uses the feature-first spine, not the whole-app launchable spine", () => {
    const text = p();
    expect(text).toMatch(/FEATURE-FIRST ORDER/);
    expect(text).not.toMatch(/SPINE-FIRST ORDER/);
    expect(text).not.toMatch(/LAUNCHABLE, VISIBLY CORRECT/);
  });

  it("keeps design/architecture REQUIRED, contracts summary, and the verify/interface/smoke shape", () => {
    const text = p();
    expect(text).toContain("MODULE_A");
    expect(text).toMatch(/\$VERIFY/);
    expect(text).toMatch(/\$INTERFACE/);
    expect(text).toMatch(/\$SMOKE/);
    expect(text).toMatch(/DESIGN and \$ARCHITECTURE blocks are REQUIRED/);
  });

  it("scopes art direction to the feature's NEW surface and defers to the held charter (ADR 0051)", () => {
    const text = planFeatureDesignSystemPrompt({ contractsSummary: "", existingCharter: "CHARTER_HELD" });
    expect(text).toMatch(/FEATURE ART DIRECTION/);
    expect(text).toMatch(/DECIDED and normative/);
    expect(text).toMatch(/do NOT restate, re-decide, or restyle/);
    // The whole-look greenfield request never rides a feature plan.
    expect(text).not.toMatch(/palette roles as hex values with a stated value separation/);
    expect(planFeatureDesignSystemPrompt({ contractsSummary: "", artDirection: false })).not.toMatch(/ART DIRECTION/);
  });
});

describe("planFeatureTicketsSystemPrompt — feature mode stage 2", () => {
  const p = () => planFeatureTicketsSystemPrompt({ contractsSummary: "MODULE_A" });

  it("never asks for a scaffold-first ticket — the repo already builds", () => {
    const text = p();
    expect(text).not.toMatch(/stand up a buildable scaffold/);
    expect(text).toMatch(/the repo already builds/);
  });

  it("demands the FIRST ticket be an integration slice that leaves the existing suite green", () => {
    expect(p()).toMatch(/FIRST ticket is an INTEGRATION slice/);
    expect(p()).toMatch(/EXISTING verify suite green/);
  });

  it("keeps the shell owned and shared conventions consumed, not re-derived", () => {
    const text = p();
    expect(text).toMatch(/second entry point/);
    expect(text).toMatch(/re-derive or re-package/);
  });

  it("uses the feature-first spine instead of the whole-app launchable spine", () => {
    const text = p();
    expect(text).toMatch(/FEATURE-FIRST ORDER/);
    expect(text).not.toMatch(/LAUNCHABLE, VISIBLY CORRECT/);
  });

  it("keeps the ticket schema, observable criteria, ordering, and quality preferences", () => {
    const text = p();
    expect(text).toContain('"open_ended"');
    expect(text).toMatch(/observable behaviour sentence/);
    expect(text).toMatch(/run STRICTLY in the order/);
    expect(text).toContain("Prefer fewer dependencies");
  });

  it("does not let a feature claim the whole product's look — craft tickets are new-surface only (ADR 0051)", () => {
    const text = p();
    expect(text).toMatch(/open-ended craft ticket scoped to THAT surface/i);
    expect(text).toMatch(/genuinely NEW surface/);
    expect(text).toMatch(/needs NO open-ended ticket/);
    expect(text).not.toMatch(/owns everything the user sees/);
    expect(planFeatureTicketsSystemPrompt({ contractsSummary: "", artDirection: false })).not.toMatch(/open-ended craft ticket/i);
  });
});

describe("planContinuationSystemPrompt", () => {
  it("asks for only the remaining tickets and forbids re-listing", () => {
    const text = planContinuationSystemPrompt({ contractsSummary: "(none)" });
    expect(text).toMatch(/ONLY the REMAINING tickets/);
    expect(text).toMatch(/Do NOT re-list/);
    expect(text).toContain("$TICKETS");
  });
});

describe("buildPlanGatePrompt / parsePlanGateVerdict (v2 issue 01)", () => {
  const prompt = () => buildPlanGatePrompt({
    originalPrompt: "make pong with sound",
    planMarkdown: "# PLAN\n\nGoal: pong.",
    tickets: [
      { number: "01", title: "Shell", what: "scaffold the page", criteria: ["the page renders"] },
      { number: "02", title: "Paddle", what: "move the paddle", criteria: ["a key moves the paddle"] },
    ],
  });

  it("walks the goal demands against ticket ownership and warns about late visible slices", () => {
    const text = prompt();
    expect(text).toMatch(/SCOPE GAPS/);
    expect(text).toContain("make pong with sound");
    expect(text).toContain("01 Shell: scaffold the page");
    expect(text).toMatch(/first one or two groups must deliver a launchable, visibly correct vertical slice/i);
    expect(text).toContain("$PLAN_PASS");
    expect(text).toContain("$PLAN_FAIL");
  });

  it("parses a pass, a fail with findings, and the replan signal", () => {
    expect(parsePlanGateVerdict("$PLAN_PASS\n$END").verdict).toBe("pass");
    const fail = parsePlanGateVerdict("$PLAN_FAIL\n[GAP] sound → no ticket owns audio\n$END\n$REPLAN\n$END");
    expect(fail.verdict).toBe("fail");
    expect(fail.findings).toEqual(["[GAP] sound → no ticket owns audio"]);
    expect(fail.replan).toBe(true);
  });

  it("defaults to pass when the seat emitted no verdict, and prefers fail over a later pass", () => {
    expect(parsePlanGateVerdict("the model rambled and emitted nothing").verdict).toBe("pass");
    expect(parsePlanGateVerdict("$PLAN_FAIL\n[GAP] x\n$END\n$PLAN_PASS").verdict).toBe("fail");
  });

  it("stays product-free for build plans (no feature block)", () => {
    const text = prompt();
    expect(text).not.toMatch(/PRODUCT CONTEXT/);
    expect(text).not.toMatch(/STEP THIS PLAN BUILDS/);
  });

  it("feature mode: carries the arc brief and the exact step, with feedback as hard constraints", () => {
    const text = buildPlanGatePrompt({
      originalPrompt: "add search to the trail log",
      planMarkdown: "# PLAN\n\nGoal: search.",
      productBrief: "## Stack\nplain ESM — decided",
      tickets: [{ number: "01", title: "Search box", what: "type to filter", criteria: ["results filter"] }],
      arcStep: { number: 2, title: "Search", description: "Search trails by name and tag.", feedback: "Must hit Enter to submit." },
    });
    expect(text).toMatch(/PRODUCT CONTEXT/);
    expect(text).toContain("plain ESM — decided");
    expect(text).toContain("2 — Search");
    expect(text).toContain("Search trails by name and tag.");
    expect(text).toContain("Must hit Enter to submit.");
    // The scope rules tell the seat later steps are out of scope and the stack is decided.
    expect(text).toMatch(/LATER roadmap step is out of scope/);
    expect(text).toMatch(/DECIDED/);
  });
});

describe("planFixSystemPrompt — fix mode", () => {
  const p = () => planFixSystemPrompt("MODULE_A");

  it("forbids pre-judging the bug as already fixed", () => {
    expect(p()).toMatch(/NEVER decide for yourself/);
    expect(p()).toMatch(/ALWAYS emit a real fix ticket/);
  });

  it("requires the reproduction path in the criteria", () => {
    expect(p()).toMatch(/reproduction path the user described/);
  });

  it("emits the small ticket schema, not the retired fields", () => {
    expect(p()).not.toMatch(/"blocked_by"\s*:/);
    expect(p()).toContain('"open_ended"');
  });
});

describe("revision prompts", () => {
  it("interview revision frames the answers and keeps the design/architecture shape", () => {
    const text = buildPlanRevisionPrompt({ goal: "a game", priorPlanText: "old", findings: ["use sprites"] });
    expect(text).toContain("use sprites");
    expect(text).toMatch(/USER'S ANSWERS/);
    expect(text).toMatch(/\$VERIFY, \$INTERFACE, \$SMOKE, \$DESIGN, \$ARCHITECTURE/);
    expect(text).not.toMatch(/\$PLAN/);
  });

  it("user feedback revision keeps the design/architecture shape", () => {
    const text = buildPlanUserFeedbackPrompt({ goal: "a game", priorPlanText: "old", feedback: "add settings" });
    expect(text).toContain("add settings");
    expect(text).toMatch(/\$DESIGN, \$ARCHITECTURE/);
  });
});

describe("buildPlanMarkdown", () => {
  it("composes the design + architecture body and no ticket section before decomposition", () => {
    const md = buildPlanMarkdown({ prompt: "a game", designDoc: "Design narrative.", architectureDoc: "Modules: a." });
    expect(md).toContain("Design narrative.");
    expect(md).toContain("Modules: a.");
    expect(md).not.toContain("## Ticket plan");
  });

  it("appends the ticket breakdown once tickets exist", () => {
    const md = buildPlanMarkdown({
      prompt: "a game",
      designDoc: "Design narrative.",
      architectureDoc: null,
      tickets: [
        { number: "01", title: "Shell", what: "scaffold", criteria: ["builds"], group: "core" },
        { number: "02", title: "Art", what: "craft the look", criteria: [], open_ended: true },
      ],
    });
    expect(md).toContain("## Ticket plan (2 tickets)");
    expect(md).toContain("### 01 — Shell");
    expect(md).toContain("- Criterion: builds");
    expect(md).toContain("- Group: core");
    expect(md).toContain("Open-ended craft ticket");
  });
});

// ---------------------------------------------------------------------------
// marker parsers
// ---------------------------------------------------------------------------

describe("parseVerifyBlock", () => {
  it("extracts commands listed between $VERIFY and $TICKETS markers", () => {
    const text = `$VERIFY
cargo build
cargo test
$TICKETS
[{"title":"x"}]`;
    expect(parseVerifyBlock(text)).toEqual(["cargo build", "cargo test"]);
  });

  it("returns [] when no $VERIFY marker is present", () => {
    expect(parseVerifyBlock('[{"title":"x"}]')).toEqual([]);
  });

  it("returns [] when the $VERIFY block is empty or NONE", () => {
    expect(parseVerifyBlock("$VERIFY\nNONE\n$TICKETS\n[]")).toEqual([]);
    expect(parseVerifyBlock("$VERIFY\n\n$TICKETS\n[]")).toEqual([]);
  });

  it("ignores blank lines and trims whitespace within the block", () => {
    expect(parseVerifyBlock("$VERIFY\n  cargo build  \n\tnpm test\t\n$TICKETS\n[]")).toEqual(["cargo build", "npm test"]);
  });

  it("stops the verify block at an intervening $INTERFACE line (issue #97)", () => {
    const text = `$VERIFY
cargo build
$INTERFACE
browser-ui
$SMOKE
cargo run
$TICKETS
[]`;
    expect(parseVerifyBlock(text)).toEqual(["cargo build"]);
    expect(parseSmokeBlock(text)).toEqual(["cargo run"]);
  });

  it("does not turn a stray $END line into a command", () => {
    expect(parseVerifyBlock("$VERIFY\nnpm run build\n$END\n$SMOKE\nnpm run dev\n$END\n")).toEqual(["npm run build"]);
  });

  it("tolerates markers in any case", () => {
    expect(parseVerifyBlock("$verify\ncargo build\n$tickets\n[]")).toEqual(["cargo build"]);
  });

  it("strips a Markdown fence around the block — fence lines are not commands", () => {
    const text = "$VERIFY\n```\nnpm run typecheck\nnpm run build\nnpm test\n```\n$SMOKE\nNONE\n$TICKETS\n[]";
    expect(parseVerifyBlock(text)).toEqual(["npm run typecheck", "npm run build", "npm test"]);
  });

  it("strips a language-tagged fence and unwraps single-backtick commands", () => {
    const text = "$VERIFY\n```bash\nnpm test\n`npm run build`\n```\n$TICKETS\n[]";
    expect(parseVerifyBlock(text)).toEqual(["npm test", "npm run build"]);
  });

  it("strips a fence and its tokens when they share a line with the command", () => {
    expect(parseVerifyBlock("$VERIFY\n``` npm run build ```\n$TICKETS\n[]")).toEqual(["npm run build"]);
  });

  it("ignores prose around a fenced block — the SpriteForge title line is not a verify command", () => {
    const text = "$VERIFY\n```\nnpm run typecheck && npm run build && npm test\n```\n\nSpriteForge — browser-ui\n\n$SMOKE\n```\nnpx vite preview --port 5173 --open\n```\n$DESIGN\nx\n$END\n";
    expect(parseVerifyBlock(text)).toEqual(["npm run typecheck && npm run build && npm test"]);
  });

  it("ignores prose BEFORE a fenced block too", () => {
    expect(parseVerifyBlock("$VERIFY\nHere are the commands:\n```\nnpm test\n```\n$TICKETS\n[]")).toEqual(["npm test"]);
  });
});

describe("parseSmokeBlock", () => {
  it("extracts the launch command between $SMOKE and $TICKETS", () => {
    const text = `$VERIFY
cargo build
$SMOKE
cargo run
$TICKETS
[]`;
    expect(parseSmokeBlock(text)).toEqual(["cargo run"]);
  });

  it("returns [] when no $SMOKE marker is present, or the block is NONE/empty", () => {
    expect(parseSmokeBlock("$VERIFY\ncargo build\n$TICKETS\n[]")).toEqual([]);
    expect(parseSmokeBlock("$SMOKE\nNONE\n$TICKETS\n[]")).toEqual([]);
    expect(parseSmokeBlock("$SMOKE\n\n$TICKETS\n[]")).toEqual([]);
  });

  it("stops the smoke list at a following $DESIGN block — design prose is not a launch command", () => {
    const text = [
      "$VERIFY", "npm run build",
      "$SMOKE", "npm run preview -- --port 4173 --strictPort",
      "$DESIGN", "Goal: the new plan.", "$END",
      "$ARCHITECTURE", "One runtime dep, resolved in the export ticket.", "$END",
      "$TICKETS", "[]",
    ].join("\n");
    const smoke = parseSmokeBlock(text);
    expect(smoke).toEqual(["npm run preview -- --port 4173 --strictPort"]);
    expect(smoke.join("\n")).not.toContain("the new plan");
    expect(smoke.join("\n")).not.toContain("One runtime dep");
  });

  it("unwraps a single-backtick-wrapped launch command", () => {
    expect(parseSmokeBlock("$SMOKE\n`npx vite --port 5173`\n$TICKETS\n[]")).toEqual(["npx vite --port 5173"]);
  });

  it("strips a fence around the smoke block", () => {
    const text = "$SMOKE\n```\nnpm run dev\n```\n$DESIGN\nA design.\n$END\n$TICKETS\n[]";
    expect(parseSmokeBlock(text)).toEqual(["npm run dev"]);
  });

  it("ignores prose outside the fence — only fenced content is a launch command", () => {
    const text = "$SMOKE\n```\nnpx vite preview --port 5173 --open\n```\nSpriteForge — browser-ui\n$DESIGN\nA design.\n$END\n$TICKETS\n[]";
    expect(parseSmokeBlock(text)).toEqual(["npx vite preview --port 5173 --open"]);
  });
});

describe("parseInterfaceBlock (issue #97)", () => {
  it("extracts the declared token between $INTERFACE and the next sibling marker", () => {
    expect(parseInterfaceBlock("$VERIFY\ncargo build\n$INTERFACE\nbrowser-ui\n$SMOKE\ncargo run\n$TICKETS\n[]")).toBe("browser-ui");
    expect(parseInterfaceBlock("$INTERFACE\ncanvas\n$DESIGN\nA game.\n$END\n$TICKETS\n[]")).toBe("canvas");
    expect(parseInterfaceBlock("$INTERFACE\n  terminal  \n$TICKETS\n[]")).toBe("terminal");
  });

  it("is lossy-tolerant of prose around the token", () => {
    expect(parseInterfaceBlock("$INTERFACE\nThis deliverable is operated as: none (a pure library).\n$SMOKE\nNONE\n$TICKETS\n[]")).toBe("none");
  });

  it("returns null when absent, empty, or holding no recognized token", () => {
    expect(parseInterfaceBlock("$VERIFY\ncargo build\n$SMOKE\ncargo run\n$TICKETS\n[]")).toBeNull();
    expect(parseInterfaceBlock("$INTERFACE\n\n$SMOKE\nNONE\n$TICKETS\n[]")).toBeNull();
    expect(parseInterfaceBlock("$INTERFACE\na-whole-new-kind\n$TICKETS\n[]")).toBeNull();
    expect(parseInterfaceBlock("")).toBeNull();
  });
});

describe("parseDesignBlock / parseArchitectureBlock (#34)", () => {
  it("extracts each body between its marker and $END", () => {
    const text = `$DESIGN
A roguelike with oppressive atmosphere.
$END
$ARCHITECTURE
Module map: engine -> renderer.
$END
$TICKETS
[]`;
    expect(parseDesignBlock(text)).toContain("roguelike with oppressive atmosphere");
    expect(parseArchitectureBlock(text)).toContain("Module map");
  });

  it("returns null when a block is absent or empty", () => {
    expect(parseDesignBlock("$VERIFY\ncargo build\n$TICKETS\n[]")).toBeNull();
    expect(parseDesignBlock("$DESIGN\n\n$END\n$TICKETS\n[]")).toBeNull();
    expect(parseArchitectureBlock("$DESIGN\nA design.\n$END\n$TICKETS\n[]")).toBeNull();
    expect(parseArchitectureBlock("$ARCHITECTURE\n$END\n$TICKETS\n[]")).toBeNull();
  });

  it("handles a missing $END by stopping at the next sibling marker", () => {
    const design = `$DESIGN
A dark atmospheric game.
$ARCHITECTURE
Modules: engine, renderer, juice.
$END
$TICKETS
[]`;
    expect(parseDesignBlock(design)).toContain("dark atmospheric game");
    expect(parseDesignBlock(design)).not.toContain("Modules");
  });

  it("tolerates case-insensitive markers", () => {
    expect(parseDesignBlock("$design\nA design doc.\n$end\n$TICKETS\n[]")).toBe("A design doc.");
    expect(parseArchitectureBlock("$architecture\nStructural decisions.\n$end\n$TICKETS\n[]")).toBe("Structural decisions.");
  });
});

describe("parseCoherenceContract / splitCoherenceContract (issue #99 / ADR 0028)", () => {
  const design = `Goal: a neon snake.
## Coherence contract
### Visual tokens
NEON palette from src/ui/tokens.ts.
### Layout model
Canvas 1280x800.
### Chrome rules
One toolbar recipe.`;

  it("slices the charter out of the design block", () => {
    const charter = parseCoherenceContract(design);
    expect(charter).toContain("### Visual tokens");
    expect(charter).toContain("One toolbar recipe.");
    expect(charter).not.toContain("Goal:");
  });

  it("splits narrative and charter once each", () => {
    const { narrative, charter } = splitCoherenceContract(design);
    expect(narrative).toContain("Goal: a neon snake.");
    expect(narrative).not.toContain("Coherence contract");
    expect(charter).toContain("NEON palette");
  });

  it("a design with no charter yields the narrative unchanged", () => {
    const { narrative, charter } = splitCoherenceContract("Goal: a plain library.");
    expect(narrative).toBe("Goal: a plain library.");
    expect(charter).toBeNull();
  });

  it("a charter-only block yields a null narrative", () => {
    const { narrative, charter } = splitCoherenceContract("## Coherence contract\n### Visual tokens\nNEON.");
    expect(narrative).toBeNull();
    expect(charter).toContain("NEON.");
  });
});

// ---------------------------------------------------------------------------
// $TICKETS parsing
// ---------------------------------------------------------------------------

describe("parsePlanJson", () => {
  it("parses a clean JSON array", () => {
    const { tickets } = parsePlanJson(
      '[{"title":"x","what":"w","criteria":["c"],"group":"core","open_ended":true}]',
    );
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ title: "x", what: "w", criteria: ["c"], group: "core", open_ended: true });
  });

  it("tolerates a prose preamble", () => {
    const { tickets } = parsePlanJson('Here are your tickets:\n[{"title":"x","what":"w","criteria":["c"]}]');
    expect(tickets[0].title).toBe("x");
  });

  it("tolerates a code-fence wrap", () => {
    const { tickets } = parsePlanJson('```json\n[{"title":"x","what":"w","criteria":["c"]}]\n```');
    expect(tickets[0].title).toBe("x");
  });

  it("skips mid-array corruption and keeps the valid tickets", () => {
    const { tickets } = parsePlanJson(
      '[\n{"title":"a","what":"w","criteria":["c"]},\n"garbage":[],\n{"title":"b","what":"w","criteria":["c"]}\n]',
    );
    expect(tickets.map((o) => o.title)).toEqual(["a", "b"]);
  });

  it("recovers tickets after one malformed ticket object instead of dropping the tail", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { tickets } = parsePlanJson(
        '$TICKETS\n[{"title":"a","what":"w","criteria":["c"]},{"title":"b","what":"w","criteria":["c"],"files":["x.ts", y.ts"]},{"title":"c","what":"w","criteria":["c"]}]',
      );
      expect(tickets.map((t) => t.title)).toEqual(["a", "c"]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("could not be parsed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips an unbalanced trailing object and reports the unparsed count (truncation is visible)", () => {
    const { tickets, unparsed } = parsePlanRegions('[{"title":"a","what":"w","criteria":["c"]}, {"title":"b","what":"w"');
    expect(tickets.map((o) => o.title)).toEqual(["a"]);
    expect(unparsed).toBe(1);
  });

  it("throws when no readable ticket survives", () => {
    expect(() => parsePlanJson("totally not json")).toThrow();
    expect(() => parsePlanJson("$TICKETS\nnot json at all")).toThrow(/no readable tickets/);
  });

  it("reads the group field and treats an empty string as undefined (#19)", () => {
    expect(parsePlanJson('[{"title":"x","what":"w","criteria":["c"],"group":"core-engine"}]').tickets[0].group).toBe("core-engine");
    expect(parsePlanJson('[{"title":"x","what":"w","criteria":["c"]}]').tickets[0].group).toBeUndefined();
    expect(parsePlanJson('[{"title":"x","what":"w","criteria":["c"],"group":""}]').tickets[0].group).toBeUndefined();
  });
});

describe("issue #104 — reconcile a doubled $TICKETS array", () => {
  const arr = (ts: { title: string; what: string }[]): string =>
    `[\n${ts.map((t) => JSON.stringify({ title: t.title, what: t.what, criteria: ["c"] })).join(",\n")}\n]`;

  it("a later per-title variant of the earlier array is a revision: last wins, no doubling", () => {
    const draft = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ title: `Ticket ${i}`, what: `draft ${i}` }));
    const revised = draft.map((t) => ({ ...t, what: `revised ${t.what}` }));
    const transcript = [
      "$VERIFY", "npm test", "$TICKETS", arr(draft),
      "$VERIFY", "npm test", "$DESIGN", "revised wording", "$END", "$TICKETS", arr(revised),
    ].join("\n");
    const { tickets } = parsePlanJson(transcript);
    expect(tickets).toHaveLength(8);
    expect(tickets.every((t) => t.what.startsWith("revised"))).toBe(true);
  });

  it("a genuinely continued array (all-new titles) is kept additively", () => {
    const part1 = [{ title: "Scaffold", what: "w1" }, { title: "Core engine", what: "w2" }];
    const part2 = [{ title: "Renderer", what: "w3" }, { title: "Input handling", what: "w4" }];
    const { tickets } = parsePlanJson(`$TICKETS\n${arr(part1)}\n$TICKETS\n${arr(part2)}`);
    expect(tickets.map((t) => t.title)).toEqual(["Scaffold", "Core engine", "Renderer", "Input handling"]);
  });

  it("a partial overlap is kept additively, never collapsed", () => {
    const earlier = [{ title: "A", what: "w" }, { title: "B", what: "w" }, { title: "C", what: "w" }];
    const later = [{ title: "B", what: "w2" }, { title: "D", what: "w" }];
    const { tickets, collapsed } = parsePlanRegions(`$TICKETS\n${arr(earlier)}\n$TICKETS\n${arr(later)}`);
    expect(collapsed).toBe(0);
    expect(tickets.map((t) => t.title)).toEqual(["A", "B", "C", "B", "D"]);
  });

  it("three drafts reconcile to the final one", () => {
    const d1 = [{ title: "A", what: "1" }, { title: "B", what: "1" }];
    const d2 = [{ title: "A", what: "2" }, { title: "B", what: "2" }, { title: "C", what: "2" }];
    const d3 = [{ title: "A", what: "3" }, { title: "B", what: "3" }, { title: "C", what: "3" }, { title: "D", what: "3" }];
    const { tickets, collapsed } = parsePlanRegions(`$TICKETS\n${arr(d1)}\n$TICKETS\n${arr(d2)}\n$TICKETS\n${arr(d3)}`);
    expect(collapsed).toBe(5);
    expect(tickets).toHaveLength(4);
    expect(tickets.every((t) => t.what === "3")).toBe(true);
  });

  it("does not collapse without $TICKETS markers (no trustworthy boundary)", () => {
    const dup = [{ title: "Same", what: "a" }, { title: "Same", what: "b" }];
    expect(parsePlanJson(`${arr(dup)}\n${arr(dup)}`).tickets).toHaveLength(4);
  });

  it("surfaces a revision on the console, never silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const draft = [{ title: "A", what: "w" }, { title: "B", what: "w" }];
      const revised = [{ title: "A", what: "r" }, { title: "B", what: "r" }];
      parsePlanJson(`$TICKETS\n${arr(draft)}\n$TICKETS\n${arr(revised)}`);
      expect(String(warn.mock.calls[0]?.[0])).toContain("2 draft ticket(s) were dropped");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("QUALITY_PREFERENCES", () => {
  it("steers the planner toward stable, model-familiar APIs", () => {
    expect(QUALITY_PREFERENCES).toMatch(/API STABILITY/);
    expect(QUALITY_PREFERENCES).toMatch(/Prefer fewer dependencies/);
  });
});

// ---------------------------------------------------------------------------
// product arc session (ADR 0051)
// ---------------------------------------------------------------------------

describe("buildProductSessionPrompt — the product arc session", () => {
  it("authors a fresh arc: every step todo, terse sections, on-disk shape", () => {
    const p = buildProductSessionPrompt({});
    expect(p).toMatch(/\*\*Status:\*\* todo/);
    expect(p).toMatch(/AUTHORS? one|this session AUTHORS/i);
    expect(p).toMatch(/TERSE/);
    expect(p).toContain("$PRODUCT");
    expect(p).toContain("$END");
  });

  it("steering an existing arc preserves its content verbatim and forbids re-deciding the stack", () => {
    const p = buildProductSessionPrompt({
      existingPlanMarkdown: "# Arc\n\n## Roadmap\n\n### 1 — First\n\n**Status:** done\n\nHUMAN_PROSE_KEEP.",
    });
    expect(p).toContain("HUMAN_PROSE_KEEP.");
    expect(p).toMatch(/REVISES/);
    expect(p).toMatch(/stack is DECIDED/);
  });

  it("carries the domain glossary when present", () => {
    expect(buildProductSessionPrompt({ existingGlossary: "Trail = a hike." })).toContain("Trail = a hike.");
  });
});

describe("buildProductRevisionPrompt (ADR 0051)", () => {
  const p = () => buildProductRevisionPrompt({
    instruction: "a hiking log my family opens",
    priorArcMarkdown: "# Trail Tracker\n\n### 1 — MVP\n\n**Status:** todo\n\nShell.",
    findings: ["1. Keep the MVP to logging one hike."],
  });

  it("carries the operator's input, answers, and current arc, and demands a full re-emit", () => {
    const text = p();
    expect(text).toContain("a hiking log my family opens");
    expect(text).toContain("Keep the MVP to logging one hike.");
    expect(text).toContain("**Status:** todo");
    expect(text).toContain("$PRODUCT");
    expect(text).toContain("$END");
    expect(text).toMatch(/COMPLETE/);
  });

  it("forbids rewriting what the answers did not touch", () => {
    expect(p()).toMatch(/exactly as it is|EXACTLY as it is/);
  });
});

describe("parseProductReply", () => {
  const REPLY = "Sure!\n$PRODUCT\n# Trail\n\n## Vision\nV\n\n## Roadmap\n\n### 1 — One\n\n**Status:** todo\n\ndesc\n$END\ntrailing";

  it("extracts the $PRODUCT block and parses it through the on-disk arc parser", () => {
    const { plan, warnings } = parseProductReply(REPLY);
    expect(plan.name).toBe("Trail");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].status).toBe("todo");
    expect(warnings).toEqual([]);
  });

  it("tolerates a truncated reply (no $END)", () => {
    const { plan } = parseProductReply("$PRODUCT\n# T\n\n## Roadmap\n");
    expect(plan.name).toBe("T");
  });

  it("throws when no $PRODUCT marker exists — a silent empty arc would erase the roadmap", () => {
    expect(() => parseProductReply("no markers here")).toThrow(/no readable \$PRODUCT/);
  });

  it("never reads a $PRODUCT marker inside a fence", () => {
    const fenced = "Example shape:\n```\n$PRODUCT\n# Ghost\n```\nthen the real one\n$PRODUCT\n# Real\n\n## Roadmap\n";
    expect(parseProductReply(fenced).plan.name).toBe("Real");
  });
});

describe("buildFeatureStepPrompt / parseFeatureStepReply — roadmap step → feature prompt", () => {
  const p = () =>
    buildFeatureStepPrompt({
      stepNumber: 2,
      stepTitle: "Search",
      stepDescription: "Search trails by tag.",
      feedback: "Must hit Enter to submit.",
      productBrief: "## Stack\nMARK — decided",
      roadmapSummary: "1 — MVP [done]\n2 — Search [todo]",
    });

  it("carries the step, the reopen feedback as hard constraints, the decided context, and the roadmap", () => {
    const text = p();
    expect(text).toContain("Search trails by tag.");
    expect(text).toContain("Must hit Enter to submit.");
    expect(text).toContain("1 — MVP [done]");
    expect(text).toContain("MARK — decided");
  });

  it("frames the reply as exactly one $FEATURE_PROMPT block", () => {
    const text = p();
    expect(text).toContain("$FEATURE_PROMPT");
    expect(text).toContain("$END");
  });

  it("a fresh step (no feedback) says nothing about reopening", () => {
    const text = buildFeatureStepPrompt({ stepNumber: 1, stepTitle: "A", stepDescription: "d", feedback: null, productBrief: "b", roadmapSummary: "1 — A [todo]" });
    expect(text).not.toMatch(/REOPENED/);
  });

  it("requires the structured brief: goal, behaviour + morning check, real integration points, out of scope, verified by", () => {
    const text = p();
    expect(text).toMatch(/these five parts, in order/);
    expect(text).toMatch(/1\. Goal:/);
    expect(text).toMatch(/the literal check the operator will run the morning after/);
    expect(text).toMatch(/Integration points.*named from the contracts and project state/s);
    expect(text).toMatch(/Out of scope/);
    expect(text).toMatch(/5\. Verified by:/);
    expect(text).toMatch(/never invented names/);
  });

  it("carries the project state and a prior attempt when present, and omits both otherwise", () => {
    const withState = buildFeatureStepPrompt({
      stepNumber: 2,
      stepTitle: "Search",
      stepDescription: "Search trails.",
      productBrief: "b",
      roadmapSummary: "2 — Search [todo]",
      projectDigest: "DIGEST_MARKER: board.ts owns the grid.",
      learnings: "LEARNINGS_MARKER: no TTY.",
      priorAttempt: "PRIOR_MARKER: the search box rendered but did not submit.",
    });
    expect(withState).toContain("DIGEST_MARKER");
    expect(withState).toContain("LEARNINGS_MARKER");
    expect(withState).toContain("PRIOR_MARKER");
    const bare = buildFeatureStepPrompt({ stepNumber: 1, stepTitle: "A", stepDescription: "d", productBrief: "b", roadmapSummary: "1 — A [todo]" });
    expect(bare).not.toMatch(/CURRENT STATE|PREVIOUS attempt/);
  });
});

describe("parseFeatureStepReply", () => {
  it("extracts the marker block", () => {
    expect(parseFeatureStepReply("pre\n$FEATURE_PROMPT\nTHE PROMPT\n$END\npost")).toBe("THE PROMPT");
  });

  it("falls back to the whole reply when no marker exists (tolerant)", () => {
    expect(parseFeatureStepReply("just the prompt text")).toBe("just the prompt text");
  });

  it("never reads a marker inside a fence — falls back instead of eating code", () => {
    const text = 'Example:\n```\n$FEATURE_PROMPT\nGHOST\n```\n';
    expect(parseFeatureStepReply(text)).toBe("Example:\n```\n$FEATURE_PROMPT\nGHOST\n```");
  });
});
