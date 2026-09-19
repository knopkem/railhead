import { describe, it, expect } from "vitest";
import { parseGoalVerdict, buildGoalReviewPrompt, parseReplanRequested, extractFindingFiles, extractFindingReferences, extractScreenshotPaths, splitAnchoredBlockers, parseCorrectiveTickets, normalizeFinding, findingsEchoLastRound, remainingPlanGroups } from "./goal-review.ts";

describe("parseGoalVerdict", () => {
  it("parses $GOAL_PASS", () => {
    const text = "$GOAL_PASS\n$END";
    expect(parseGoalVerdict(text)).toEqual({ verdict: "pass", findings: [] });
  });

  it("parses $GOAL_FAIL with findings", () => {
    const text = "$GOAL_FAIL\n[BLOCKER] flat rectangles, no parallax\n[MAJOR] palette is flat\n$END";
    const v = parseGoalVerdict(text);
    expect(v.verdict).toBe("fail");
    expect(v.findings.length).toBe(2);
    expect(v.findings[0]).toContain("flat rectangles");
    expect(v.findings[1]).toContain("palette is flat");
  });

  it("returns inconclusive when no marker is present", () => {
    expect(parseGoalVerdict("some text without verdict")).toEqual({
      verdict: "inconclusive",
      findings: [],
    });
  });

  it("returns inconclusive when $GOAL_FAIL has NONE", () => {
    expect(parseGoalVerdict("$GOAL_FAIL\nNONE\n$END")).toEqual({
      verdict: "inconclusive",
      findings: [],
    });
  });

  it("returns inconclusive when $GOAL_FAIL block is empty", () => {
    expect(parseGoalVerdict("$GOAL_FAIL\n\n$END")).toEqual({
      verdict: "inconclusive",
      findings: [],
    });
  });

  it("prefers FAIL when both markers are present", () => {
    const text = "$GOAL_FAIL\n[BLOCKER] a gap\n$END\n$GOAL_PASS";
    const v = parseGoalVerdict(text);
    expect(v.verdict).toBe("fail");
    expect(v.findings.length).toBe(1);
  });

  it("tolerates case-insensitive markers", () => {
    expect(parseGoalVerdict("$goal_pass\n$end")).toEqual({ verdict: "pass", findings: [] });
    const v = parseGoalVerdict("$goal_fail\n[BLOCKER] gap\n$end");
    expect(v.verdict).toBe("fail");
  });

  it("handles $GOAL_FAIL without $END (graceful to EOF)", () => {
    const text = "$GOAL_FAIL\n[BLOCKER] a gap at the end";
    const v = parseGoalVerdict(text);
    expect(v.verdict).toBe("fail");
    expect(v.findings.length).toBe(1);
  });
});

describe("parseReplanRequested (#65)", () => {
  it("detects the $REPLAN marker after a $GOAL_FAIL block", () => {
    const text = "$GOAL_FAIL\n[BLOCKER] Contract/runtime drift: BootScene is dead code\n$END\n\n$REPLAN\n$END";
    expect(parseReplanRequested(text)).toBe(true);
  });

  it("returns false when the reviewer emitted no $REPLAN marker", () => {
    const text = "$GOAL_FAIL\n[BLOCKER] missing error handling on endpoint X\n$END";
    expect(parseReplanRequested(text)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(parseReplanRequested("$GOAL_FAIL\n[BLOCKER] drift\n$END\n$replan\n$end")).toBe(true);
  });

  it("returns false for empty text", () => {
    expect(parseReplanRequested("")).toBe(false);
  });

  it("does not replan on a $REPLAN quoted inside a code fence (#108)", () => {
    const text = "format:\n```\n$REPLAN\n$END\n```\n$GOAL_FAIL\n[BLOCKER] gap\n$END";
    expect(parseReplanRequested(text)).toBe(false);
  });

  it("still replans on a bare $REPLAN outside any fence (#108)", () => {
    const text = "$GOAL_FAIL\n[BLOCKER] gap\n$END\n$REPLAN\n$END";
    expect(parseReplanRequested(text)).toBe(true);
  });
});

describe("parseCorrectiveTickets (#67)", () => {
  const BLOCK = `$GOAL_FAIL
[BLOCKER] The running product is colored rectangles.
$END

$CORRECTIVE
{"title":"Replace GameScene entity rendering with sprite textures","what":"Replace this.add.rectangle() calls with this.add.sprite() using generated pixel-art textures.","files":["src/scenes/GameScene.ts"],"references":["GameScene","BIOME_1_CONFIG"],"introduces":[],"testable":false}
{"title":"Add parallax depth bands","what":"Add >=3 scroll-factor layers.","files":["src/ui/ParallaxBackground.ts"],"references":["ParallaxBackground"],"introduces":[],"testable":false}
$END`;

  it("parses the $CORRECTIVE block into PlanTickets with files/references", () => {
    const tickets = parseCorrectiveTickets(BLOCK);
    expect(tickets).not.toBeNull();
    expect(tickets!.length).toBe(2);
    expect(tickets![0].title).toContain("sprite textures");
    expect(tickets![0].files).toEqual(["src/scenes/GameScene.ts"]);
    expect(tickets![0].references).toEqual(["GameScene", "BIOME_1_CONFIG"]);
    expect(tickets![0].testable).toBe(false);
    expect(tickets![1].files).toEqual(["src/ui/ParallaxBackground.ts"]);
  });

  it("returns null when no $CORRECTIVE block is present (mechanical fallback)", () => {
    expect(parseCorrectiveTickets("$GOAL_FAIL\n[BLOCKER] gap\n$END")).toBeNull();
    expect(parseCorrectiveTickets("")).toBeNull();
  });

  it("returns null when the block parses to no tickets", () => {
    expect(parseCorrectiveTickets("$CORRECTIVE\nnot json at all\n$END")).toBeNull();
  });

  it("tolerates prose between objects and missing fields", () => {
    const text = "$CORRECTIVE\nHere are my suggestions:\n{\"title\":\"Fix it\"}\n$END";
    const tickets = parseCorrectiveTickets(text);
    expect(tickets).not.toBeNull();
    expect(tickets![0].what).toBe("Fix it"); // falls back to the title
    expect(tickets![0].files).toEqual([]);
  });

  it("ignores a fenced $CORRECTIVE example and still parses a real one (#108)", () => {
    const text = "format:\n```\n$CORRECTIVE\n{\"title\":\"not real\"}\n$END\n```\n\n$CORRECTIVE\n{\"title\":\"the real one\",\"what\":\"do it\"}\n$END";
    const tickets = parseCorrectiveTickets(text);
    expect(tickets).not.toBeNull();
    expect(tickets!.length).toBe(1);
    expect(tickets![0].title).toBe("the real one");
  });

  it("returns null when the only $CORRECTIVE is fenced (#108)", () => {
    expect(parseCorrectiveTickets("```\n$CORRECTIVE\n{\"title\":\"example\"}\n$END\n```")).toBeNull();
  });

  it("still parses a real $CORRECTIVE whose JSON is wrapped in a code fence (raw-slice on the gated occurrence) (#108)", () => {
    const text = "$CORRECTIVE\n```json\n{\"title\":\"fenced json\",\"files\":[\"src/x.ts\"]}\n```\n$END";
    const tickets = parseCorrectiveTickets(text);
    expect(tickets).not.toBeNull();
    expect(tickets![0].title).toBe("fenced json");
    expect(tickets![0].files).toEqual(["src/x.ts"]);
  });
});

describe("splitAnchoredBlockers (ADR 0043)", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);
  it("keeps a blocker anchored by an existing file", () => {
    const r = splitAnchoredBlockers(
      ["[BLOCKER] the HUD overlaps the world (src/ui/hud.ts)"],
      { exists: exists(["src/ui/hud.ts"]), pendingFiles: new Set() },
    );
    expect(r.unanchored).toEqual([]);
    expect(r.findings).toHaveLength(1);
  });

  it("keeps a blocker anchored by an existing screenshot", () => {
    const r = splitAnchoredBlockers(
      ["[BLOCKER] the title screen never appears (.railhead/goal-01-title.png)"],
      { exists: exists([".railhead/goal-01-title.png"]), pendingFiles: new Set() },
    );
    expect(r.unanchored).toEqual([]);
    expect(r.findings).toHaveLength(1);
  });

  it("types a blocker citing no existing artifact as steering-only", () => {
    const r = splitAnchoredBlockers(
      ["[BLOCKER] there is no boss fight yet"],
      { exists: () => false, pendingFiles: new Set() },
    );
    expect(r.findings).toEqual([]);
    expect(r.unanchored).toHaveLength(1);
    expect(r.unanchored[0].reason).toMatch(/no artifact that exists/i);
  });

  it("types a blocker naming only pending-owned files as steering-only (future scope)", () => {
    const r = splitAnchoredBlockers(
      ["[BLOCKER] no sprite atlas is built (src/core/assets.ts)"],
      { exists: exists(["src/core/assets.ts"]), pendingFiles: new Set(["src/core/assets.ts"]) },
    );
    expect(r.findings).toEqual([]);
    expect(r.unanchored[0].reason).toMatch(/unbuilt tickets/i);
  });

  it("passes non-blockers through untouched and keeps multiple anchors per finding", () => {
    const r = splitAnchoredBlockers(
      ["[MAJOR] camera feels stiff", "[BLOCKER] HUD overlaps world (src/ui/hud.ts, .railhead/goal-02.png)"],
      { exists: exists(["src/ui/hud.ts", ".railhead/goal-02.png"]), pendingFiles: new Set(["src/ui/hud.ts"]) },
    );
    expect(r.unanchored).toEqual([]);
    expect(r.findings).toHaveLength(2);
  });
});

describe("buildGoalReviewPrompt", () => {
  it("includes the original prompt", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "A GOTY-quality roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("A GOTY-quality roguelike");
  });

  it("includes the design doc when provided (#34)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      designDoc: "A roguelike with oppressive atmosphere. Visual identity: desaturated palette.",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("Design intent (the planner's vision");
    expect(p).toContain("oppressive atmosphere");
  });

  it("omits the design doc block when null", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      designDoc: null,
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).not.toContain("Design intent (the planner's vision");
  });

  it("ADR 0040: renders unverified criteria as explicit must-check items", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a level",
      verifyCommands: [],
      runCommandHint: "npm run dev",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
      unverifiedCriteria: ["07 End boss: the player can defeat the boss and trigger victory (needs a live viewer)"],
    });
    expect(p).toContain("Unverified acceptance criteria");
    expect(p).toContain("must-check");
    expect(p).toContain("the player can defeat the boss and trigger victory");
    expect(p).toMatch(/\[BLOCKER\]/);
  });

  it("ADR 0043: scopes the required playthrough to the group when the core loop is not ready", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a platformer",
      verifyCommands: [],
      runCommandHint: "npm run dev",
      group: "scaffold",
      completedGroups: [],
      priorFindings: [],
      coreLoopReady: false,
    });
    expect(p).toContain("Group playthrough");
    expect(p).toContain("Drive every deliverable of THIS group");
    expect(p).not.toContain("Play through the core loop to completion");
  });

  it("ADR 0043: demands the full core-loop playthrough when it is ready", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a platformer",
      verifyCommands: [],
      runCommandHint: "npm run dev",
      group: "roguelike-structure",
      completedGroups: [],
      priorFindings: [],
      coreLoopReady: true,
    });
    expect(p).toContain("Core-loop playthrough");
    expect(p).toContain("Play through the core loop to completion");
  });

  it("ADR 0043: states the enforced blocker evidence rule", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a platformer",
      verifyCommands: [],
      runCommandHint: "npm run dev",
      group: "scaffold",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("Blocker evidence");
    expect(p).toMatch(/screenshot path under the .railhead\/ directory/i);
    expect(p).toMatch(/generates NO corrective ticket/i);
  });

  it("ADR 0040: omits the unverified block when there are no unverified criteria", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a level",
      verifyCommands: [],
      runCommandHint: "npm run dev",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).not.toContain("Unverified acceptance criteria");
  });

  it("includes the architecture doc when provided (#34)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      architectureDoc: "Modules: engine, renderer, juice.",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("Architecture intent (the planner's structural plan");
    expect(p).toContain("Modules: engine, renderer, juice.");
  });

  it("includes the contracts summary when provided", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      contractsSummary: "GameLoop (class) @ src/engine.ts :: class GameLoop",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("Current public contracts");
    expect(p).toContain("GameLoop (class)");
  });

  it("includes the group name and completed groups", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "polish",
      completedGroups: ["core-engine", "gameplay"],
      priorFindings: [],
    });
    expect(p).toContain('"polish" checkpoint');
    expect(p).toContain("core-engine, gameplay");
  });

  it("includes prior findings when present", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "polish",
      completedGroups: ["gameplay"],
      priorFindings: ["[BLOCKER] no parallax background"],
    });
    expect(p).toContain("PRIOR GOAL FINDINGS");
    expect(p).toContain("no parallax background");
  });

  it("includes the $GOAL_PASS/$GOAL_FAIL marker contract", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("$GOAL_PASS");
    expect(p).toContain("$GOAL_FAIL");
    expect(p).toContain("$END");
  });

  it("instructs the reviewer to emit $REPLAN when the PLAN was structurally wrong (#65)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("$REPLAN");
    expect(p).toContain("structurally wrong");
    expect(p).toMatch(/do NOT emit \$REPLAN/i);
  });

  it("instructs the reviewer how to emit $CORRECTIVE decomposition hints (#67)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("$CORRECTIVE");
    expect(p).toContain("files[], references[], introduces[], and testable");
    expect(p).toMatch(/do NOT emit both \$REPLAN and \$CORRECTIVE/i);
  });

  it("includes learnings when provided", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      learnings: "the dev server panics without a TTY",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("Project learnings");
    expect(p).toContain("dev server panics");
  });

  it("includes interaction hints when provided", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      interactionHints: "Override document.pointerLockElement, then dispatch KeyboardEvent.",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("Interaction hints");
    expect(p).toContain("pointerLockElement");
  });

  it("injects the declared interface's guidance — canvas and browser-ui rows reach the goal seat (#97)", () => {
    const base = {
      originalPrompt: "a web app",
      verifyCommands: [],
      runCommandHint: "npm run dev",
      group: "run-end",
      completedGroups: [],
      priorFindings: [],
    };
    const canvas = buildGoalReviewPrompt({ ...base, projectInterface: "canvas" });
    expect(canvas).toContain("Interaction guidance");
    expect(canvas).toContain("evaluate_script");
    expect(canvas).toContain("pointerLock");

    const browser = buildGoalReviewPrompt({ ...base, projectInterface: "browser-ui" });
    expect(browser).toContain("chrome-devtools_click");
    expect(browser).toMatch(/real input/i);
  });

  it("injects no interface guidance for terminal/none/undeclared projects (#97)", () => {
    const base = {
      originalPrompt: "a tool",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "run-end",
      completedGroups: [],
      priorFindings: [],
    };
    expect(buildGoalReviewPrompt(base)).not.toContain("Interaction guidance");
    expect(buildGoalReviewPrompt({ ...base, projectInterface: "terminal" })).not.toContain("Interaction guidance");
    expect(buildGoalReviewPrompt({ ...base, projectInterface: "none" })).not.toContain("Interaction guidance");
  });

  it("instructs the evaluator to judge against the goal, not ticket ACs", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("NOT to check whether a single ticket");
    expect(p).toContain("is this progressing toward the goal");
  });

  it("instructs the evaluator to flag quality gaps, not correctness", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toContain("QUALITY GAPS");
    expect(p).toContain("[BLOCKER]");
    expect(p).toContain("[MAJOR]");
  });

  it("injects this group's deliverables so the reviewer knows what was in scope at this checkpoint", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a retro-neon browser snake with gliding movement",
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run preview",
      group: "scaffold",
      completedGroups: [],
      priorFindings: [],
      groupDeliverables: [
        { title: "Scaffold: Vite+TS build, canvas shell, world constants", what: "A buildable project with a constants module." },
      ],
    });
    expect(p).toContain("Scaffold: Vite+TS build, canvas shell, world constants");
    expect(p).toContain("A buildable project with a constants module.");
    expect(p).toMatch(/what this group delivers|group.*deliverables|in scope at this checkpoint/i);
  });

  it("tells the reviewer that features not in this group's deliverables are out of scope (not yet built)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a retro-neon browser snake",
      verifyCommands: [],
      runCommandHint: "npm run preview",
      group: "core-engine",
      completedGroups: ["scaffold"],
      priorFindings: [],
      groupDeliverables: [
        { title: "Pure game logic", what: "Tick, Input Buffer, collision, Level/Score, Win." },
      ],
    });
    expect(p).toMatch(/out of scope|not yet built|later group|not this group/i);
  });

  it("omits the deliverables block when not provided (backward compat)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).not.toMatch(/what this group delivers|group.*deliverables/i);
  });

  it("injects pending deliverables at synthetic checkpoints so reviewer knows what's out of scope", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a platformer with particle trail and screen shake",
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run preview",
      group: "checkpoint-4",
      completedGroups: [],
      priorFindings: [],
      pendingDeliverables: [
        { title: "Particle trail and landing screen shake", what: "The orb leaves a fading particle trail; landing from a high fall kicks screen shake." },
      ],
    });
    expect(p).toContain("Particle trail and landing screen shake");
    expect(p).toMatch(/not yet built|out of scope/i);
    expect(p).toMatch(/do not.*flag.*as missing/i);
  });

  it("omits pending block when not provided (backward compat)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).not.toMatch(/not yet built.*out of scope/i);
  });

  it("injects the remaining groups ahead with their ticket titles (#117)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a full interactive drawing studio",
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run dev",
      group: "core-engine",
      completedGroups: ["scaffold"],
      priorFindings: [],
      remainingGroups: [
        { group: "state", tickets: [{ title: "State store and app mount wiring", what: "Wire the store and mount the app." }] },
      ],
    });
    expect(p).toContain("Remaining plan");
    expect(p).toContain("state:");
    expect(p).toContain("State store and app mount wiring");
    expect(p).toMatch(/gap.*plan never covers|never covers/i);
  });

  it("tells the reviewer that a deferral to a group not listed is a gap (#117)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a full interactive drawing studio",
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run dev",
      group: "core-engine",
      completedGroups: ["scaffold"],
      priorFindings: [],
      remainingGroups: [
        { group: "state", tickets: [{ title: "State store and app mount wiring", what: "Wire the store and mount the app." }] },
      ],
    });
    expect(p).toMatch(/a gap the plan never covers|never covers/i);
    expect(p).toMatch(/group not listed here|not listed here/i);
  });

  it("omits the remaining-groups block when not provided (backward compat)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).not.toMatch(/Remaining plan/i);
  });

  it("frames the final group as a full-goal review, not a per-group deferral (#117)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a full interactive drawing studio with tools, palette, layers, filmstrip, playback",
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run dev",
      group: "state",
      completedGroups: ["scaffold", "core-engine"],
      priorFindings: [],
      groupDeliverables: [
        { title: "State store and app mount wiring", what: "Wire the store and mount the app." },
      ],
      isFinalGroup: true,
    });
    expect(p).toContain("Final group");
    expect(p).toMatch(/LAST group/i);
    expect(p).toMatch(/nothing is scheduled after it|there is none/i);
    expect(p).toMatch(/FULL goal/i);
    expect(p).toMatch(/never a "not yet built" deferral/i);
    expect(p).not.toMatch(/belong to later groups/i);
  });

  it("omits the final-group block when not final (backward compat)", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a roguelike",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).not.toMatch(/Final group/i);
  });
});

describe("remainingPlanGroups (#117)", () => {
  it("groups pending tickets by group in plan order", () => {
    const groups = remainingPlanGroups([
      { group: "core-engine", title: "Raster drawing tools", what: "draw" },
      { group: "state", title: "State store", what: "store" },
      { group: "core-engine", title: "Alpha compositing", what: "composite" },
    ]);
    expect(groups).toEqual([
      { group: "core-engine", tickets: [{ title: "Raster drawing tools", what: "draw" }, { title: "Alpha compositing", what: "composite" }] },
      { group: "state", tickets: [{ title: "State store", what: "store" }] },
    ]);
  });

  it("skips ungrouped tickets", () => {
    const groups = remainingPlanGroups([
      { title: "ungrouped", what: "x" },
      { group: "state", title: "State store", what: "store" },
    ]);
    expect(groups).toEqual([
      { group: "state", tickets: [{ title: "State store", what: "store" }] },
    ]);
  });

  it("returns an empty list when nothing remains", () => {
    expect(remainingPlanGroups([])).toEqual([]);
    expect(remainingPlanGroups([{ title: "ungrouped", what: "x" }])).toEqual([]);
  });
});

describe("extractFindingFiles / extractFindingReferences (#66)", () => {
  it("extracts source-file paths and strips :line-range suffixes", () => {
    const finding = "[BLOCKER] src/scenes/GameScene.ts:100-166 renders rectangles, src/ui/ParallaxBackground.ts is missing depth bands";
    const files = extractFindingFiles(finding);
    expect(files).toEqual(["src/scenes/GameScene.ts", "src/ui/ParallaxBackground.ts"]);
  });

  it("excludes screenshot paths (evidence to read, not source to edit)", () => {
    const finding = "[BLOCKER] flat render (see .railhead/goal/frame_01.png)";
    expect(extractFindingFiles(finding)).toEqual([]);
  });

  it("excludes URLs and returns nothing when no source path is mentioned", () => {
    expect(extractFindingFiles("[BLOCKER] the whole game is colored rectangles")).toEqual([]);
    expect(extractFindingFiles("[BLOCKER] see https://example.com/bug.png")).toEqual([]);
  });

  it("deduplicates repeated file paths", () => {
    const finding = "src/scenes/GameScene.ts and src/scenes/GameScene.ts both flat";
    expect(extractFindingFiles(finding)).toEqual(["src/scenes/GameScene.ts"]);
  });

  it("extracts SCREAMING_SNAKE constants and PascalCase multi-word identifiers", () => {
    const finding = "wire BIOME_2_CONFIG into GameScene and apply ParallaxBackground's NEAR_FACTOR";
    const refs = extractFindingReferences(finding);
    expect(refs).toContain("BIOME_2_CONFIG");
    expect(refs).toContain("NEAR_FACTOR");
    expect(refs).toContain("GameScene");
    expect(refs).toContain("ParallaxBackground");
  });

  it("extracts backtick-quoted symbols like camelCase functions", () => {
    const finding = "call `applyHazard` from the tick loop";
    expect(extractFindingReferences(finding)).toContain("applyHazard");
  });

  it("does not treat sentence-initial prose words as references", () => {
    const finding = "The renderer draws flat rectangles; the design doc says desaturated palette";
    const refs = extractFindingReferences(finding);
    expect(refs).not.toContain("The");
  });
});

describe("goal-loop convergence guard (run-20260907-1340)", () => {
  const PRIOR = [
    "[BLOCKER] No visible toolbar exists — tools are switchable only via keyboard shortcuts (.railhead/sf-committed.png)",
    "[MAJOR] Default active color is near-black on a near-black canvas",
  ];

  describe("normalizeFinding", () => {
    it("equalizes findings that differ only in screenshot paths", () => {
      expect(normalizeFinding(PRIOR[0])).toBe(
        normalizeFinding("[BLOCKER]  No visible toolbar exists — tools are switchable only via keyboard shortcuts  (/tmp/other-round.png)"),
      );
    });

    it("ignores case and whitespace", () => {
      expect(normalizeFinding("  [MAJOR] Foo  Bar ")).toBe(normalizeFinding("[major] foo bar"));
    });
  });

  describe("findingsEchoLastRound", () => {
    it("flags two rounds with the same finding set despite order and screenshot paths", () => {
      const curr = [
        "[MAJOR] Default active color is near-black on a near-black canvas (.railhead/round2.png)",
        "[BLOCKER] No visible toolbar exists — tools are switchable only via keyboard shortcuts",
      ];
      expect(findingsEchoLastRound(PRIOR, curr)).toBe(true);
    });

    it("does not flag a round with any genuinely new finding", () => {
      const curr = [...PRIOR, "[MAJOR] playback stutters at 24 fps"];
      expect(findingsEchoLastRound(PRIOR, curr)).toBe(false);
    });

    it("does not flag an empty current round (nothing actionable — nothing to churn)", () => {
      expect(findingsEchoLastRound(PRIOR, [])).toBe(false);
    });
  });
});

describe("browser hygiene in goal review prompts (#72)", () => {
  it("tells the goal reviewer to close stale pages before evaluating the build", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "build a game",
      verifyCommands: ["true"],
      runCommandHint: "npm run dev",
      group: "core",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toMatch(/Browser hygiene/);
    expect(p).toMatch(/close the pages you opened/);
  });

  it("tells the goal reviewer to keep scratch files in .railhead/ not /tmp", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "build a game",
      verifyCommands: ["true"],
      runCommandHint: "npm run dev",
      group: "core",
      completedGroups: [],
      priorFindings: [],
    });
    expect(p).toMatch(/Scratch files/);
    expect(p).toMatch(/\.railhead\//);
    expect(p).toMatch(/never to \/tmp/);
  });
});

describe("buildGoalReviewPrompt — advisory variant (ADR 0029, #102)", () => {
  const base = {
    originalPrompt: "a roguelike",
    verifyCommands: ["npm run build"],
    runCommandHint: "npm run dev",
    group: "gameplay",
    completedGroups: [],
    priorFindings: [],
  };

  it("frames the checkpoint as advisory see-early/steer-early, zero corrective tickets", () => {
    const p = buildGoalReviewPrompt({ ...base, advisory: true });
    expect(p).toContain("ADVISORY checkpoint");
    expect(p).toMatch(/no corrective tickets/i);
    expect(p).toMatch(/run end|run-end batch/i);
    expect(p).toContain("actionable LATER");
  });

  it("does not promise inline corrective tickets or teach $REPLAN/$CORRECTIVE at an advisory checkpoint", () => {
    const p = buildGoalReviewPrompt({ ...base, advisory: true });
    expect(p).not.toContain("Corrective tickets will be generated for these");
    expect(p).not.toContain("## Replan signal");
    expect(p).not.toContain("$REPLAN");
    expect(p).not.toContain("$CORRECTIVE");
    // Markers and the run-the-app discipline stay identical.
    expect(p).toContain("$GOAL_PASS");
    expect(p).toContain("$GOAL_FAIL");
    expect(p).toContain("[BLOCKER]");
  });

  it("tells the advisory judge not to soften real blockers despite nothing being fixed now", () => {
    const p = buildGoalReviewPrompt({ ...base, advisory: true });
    expect(p).toMatch(/do not soften a real blocker/i);
    expect(p).toMatch(/see it early/i);
  });

  it("default (non-advisory) keeps the corrective framing untouched", () => {
    const p = buildGoalReviewPrompt(base);
    expect(p).toContain("Corrective tickets will be generated for these");
    expect(p).toContain("## Replan signal");
    expect(p).toContain("$CORRECTIVE");
  });
});

describe("buildGoalReviewPrompt — coherence charter (issue #99)", () => {
  const charter = "### Chrome rules\nThe one toolbar recipe; do not introduce a competing style.";
  const base = {
    originalPrompt: "a snake game",
    verifyCommands: ["npm run build"],
    runCommandHint: "npm run dev",
    group: "core",
    completedGroups: [],
    priorFindings: [],
  };

  it("injects the coherence charter so the whole-app judge checks contract conformance", () => {
    const p = buildGoalReviewPrompt({ ...base, coherenceDoc: charter });
    expect(p).toContain("Coherence contract (the visual design contract the build must conform to)");
    expect(p).toContain("do not introduce a competing style");
    expect(p).toContain("docs/coherence.md");
  });

  it("instructs the reviewer to revise the charter via CHARTER: markers (with sequencing/precedence)", () => {
    const p = buildGoalReviewPrompt({ ...base, coherenceDoc: charter });
    expect(p).toContain("CHARTER:");
    expect(p).toContain("applies before corrective tickets are generated");
    expect(p).toContain("revision WINS");
  });

  it("omits both when the charter doc is absent", () => {
    const p = buildGoalReviewPrompt(base);
    expect(p).not.toContain("Coherence contract (the visual design contract");
  });
});

describe("goal vision capability injection (ADR 0036)", () => {
  it("names the verified capability so the seat cannot opt out of reading screenshots", () => {
    const p = buildGoalReviewPrompt({
      originalPrompt: "a game",
      verifyCommands: [],
      runCommandHint: "cargo run",
      group: "gameplay",
      completedGroups: [],
      priorFindings: [],
      visionCapability: { readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(p).toContain("Vision capability (railhead-verified)");
    expect(p).toContain("not a valid finding");
  });
});
