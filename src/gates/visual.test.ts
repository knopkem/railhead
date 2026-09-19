import { describe, it, expect } from "vitest";
import { parseVisualVerdict, buildVisualReviewPrompt, runCommandFromVerify, shouldRunVisualReview, touchesVisualSurface, DEGRADED_TARGET_RECOVERY_NOTE } from "./visual.ts";
import type { Ticket } from "../core/ticket.ts";

describe("parseVisualVerdict", () => {
  it("parses a PASS verdict with no findings", () => {
    const text = `I ran the app and captured three frames. The snake renders without ghosting, the border is intact, and the score updates.

$VISUAL_PASS
$END`;
    const v = parseVisualVerdict(text);
    expect(v.verdict).toBe("pass");
    expect(v.findings).toEqual([]);
  });

  it("parses a FAIL verdict with findings, splitting on newlines", () => {
    const text = `Captured two frames. Each row drifts upward on the second frame.

$VISUAL_FAIL
[BLOCKER] each row is displaced upward between frames — the terminal scrolls on the last row's newline
[MAJOR] score line leaves stale characters when the score shrinks
$END`;
    const v = parseVisualVerdict(text);
    expect(v.verdict).toBe("fail");
    expect(v.findings).toHaveLength(2);
    expect(v.findings[0]).toContain("[BLOCKER]");
    expect(v.findings[1]).toContain("[MAJOR]");
  });

  it("treats a FAIL block with NONE as inconclusive (agent flagged fail but gave nothing actionable)", () => {
    const text = `$VISUAL_FAIL
NONE
$END`;
    const v = parseVisualVerdict(text);
    expect(v.verdict).toBe("inconclusive");
    expect(v.findings).toEqual([]);
  });

  it("returns inconclusive when no verdict marker is present (agent ran but never structured a verdict — we cannot claim the app works)", () => {
    const v = parseVisualVerdict("the app looks fine, nothing to report");
    expect(v.verdict).toBe("inconclusive");
    expect(v.findings).toEqual([]);
  });

  it("returns pass on an explicit $VISUAL_PASS marker even with leading prose", () => {
    const text = `I ran the app and captured three frames. All clean.
$VISUAL_PASS
$END`;
    const v = parseVisualVerdict(text);
    expect(v.verdict).toBe("pass");
    expect(v.findings).toEqual([]);
  });

  it("matches markers case-insensitively", () => {
    const text = `$visual_fail
[BLOCKER] x
$end`;
    const v = parseVisualVerdict(text);
    expect(v.verdict).toBe("fail");
    expect(v.findings).toEqual(["[BLOCKER] x"]);
  });

  it("strips bullet markers and blank lines from findings", () => {
    const text = `$VISUAL_FAIL
- [BLOCKER] first issue

• [MAJOR] second issue
$END`;
    const v = parseVisualVerdict(text);
    expect(v.findings).toEqual(["[BLOCKER] first issue", "[MAJOR] second issue"]);
  });

  it("prefers FAIL over PASS when both appear (defensive — agent emitted both)", () => {
    const text = `$VISUAL_PASS
$VISUAL_FAIL
[BLOCKER] real issue
$END`;
    const v = parseVisualVerdict(text);
    expect(v.verdict).toBe("fail");
    expect(v.findings).toEqual(["[BLOCKER] real issue"]);
  });
});

describe("buildVisualReviewPrompt", () => {
  it("includes mission, criteria, verify commands, and the verdict markers", () => {
    const p = buildVisualReviewPrompt({
      mission: "a playable snake game",
      criteria: ["snake renders without ghosting", "arrows steer the snake"],
      verifyCommands: ["cargo build", "cargo test"],
      runCommandHint: "cargo run",
      round: 1,
      priorFindings: [],
    });
    expect(p).toContain("a playable snake game");
    expect(p).toContain("snake renders without ghosting");
    expect(p).toContain("cargo build");
    expect(p).toContain("cargo run");
    expect(p).toContain("$VISUAL_PASS");
    expect(p).toContain("$VISUAL_FAIL");
    expect(p).toContain("Round 1");
  });

  it("lists prior findings so the agent can confirm resolution", () => {
    const p = buildVisualReviewPrompt({
      mission: "m",
      criteria: [],
      verifyCommands: [],
      runCommandHint: "x",
      round: 2,
      priorFindings: ["[BLOCKER] rows drift upward"],
    });
    expect(p).toContain("PRIOR VISUAL FINDINGS");
    expect(p).toContain("rows drift upward");
    expect(p).toContain("Round 2");
  });

  it("requires the agent to INTERACT with the app (send inputs, then screenshot) — not just capture static startup frames", () => {
    const p = buildVisualReviewPrompt({
      mission: "a pong game where paddles move",
      criteria: ["paddles respond to keyboard input"],
      verifyCommands: ["cargo build"],
      runCommandHint: "cargo run",
      round: 1,
      priorFindings: [],
    });
    expect(p).toMatch(/interact/i);
    expect(p).toMatch(/send.*(input|keystroke|key)|press.*(key|arrow)/i);
    expect(p).toMatch(/screenshot.{0,40}(after|resulting|following)/i);
  });

  it("includes project learnings when provided", () => {
    const p = buildVisualReviewPrompt({
      mission: "a pong game",
      criteria: ["paddles move"],
      verifyCommands: ["cargo build"],
      runCommandHint: "cargo run",
      round: 1,
      priorFindings: [],
      learnings: "screencapture -x gives raw PNG\nBevy window needs focus before osascript",
    });
    expect(p).toContain("Project learnings");
    expect(p).toContain("screencapture -x gives raw PNG");
    expect(p).toContain("Bevy window needs focus before osascript");
  });

  it("omits the learnings block when learnings are null or absent", () => {
    const p = buildVisualReviewPrompt({
      mission: "m",
      criteria: [],
      verifyCommands: [],
      runCommandHint: "x",
      round: 1,
      priorFindings: [],
    });
    expect(p).not.toContain("Project learnings");
  });

  it("instructs the agent to read each saved screenshot file so a vision-capable model actually sees the pixels (not just the file path the capture tool returns)", () => {
    const p = buildVisualReviewPrompt({
      mission: "m",
      criteria: ["renders without artifacts"],
      verifyCommands: [],
      runCommandHint: "x",
      round: 1,
      priorFindings: [],
    });
    expect(p).toMatch(/read.*screenshot/i);
    expect(p).toMatch(/vision-capable|see.*image|view.*screenshot/i);
  });

  it("injects project-provided interaction hints verbatim (#20)", () => {
    const hints = "The game uses requestPointerLock + KeyboardEvent on window. To simulate movement: override document.pointerLockElement, dispatch pointerlockchange, then dispatch KeyboardEvent for WASD.";
    const p = buildVisualReviewPrompt({
      mission: "a 3D horror game",
      criteria: ["player can move with WASD"],
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run dev",
      round: 1,
      priorFindings: [],
      interactionHints: hints,
    });
    expect(p).toContain("Interaction hints");
    expect(p).toContain(hints);
  });

  it("omits the interaction hints block when not provided (#20)", () => {
    const p = buildVisualReviewPrompt({
      mission: "m",
      criteria: [],
      verifyCommands: [],
      runCommandHint: "x",
      round: 1,
      priorFindings: [],
    });
    expect(p).not.toContain("Interaction hints");
  });

  it("injects canvas guidance when the projectInterface is canvas (#20/#97)", () => {
    const p = buildVisualReviewPrompt({
      mission: "a 3D game",
      criteria: ["player moves with WASD"],
      verifyCommands: [],
      runCommandHint: "npm run dev",
      round: 1,
      priorFindings: [],
      projectInterface: "canvas",
    });
    expect(p).toContain("canvas");
    expect(p).toContain("KeyboardEvent");
    expect(p).toContain("evaluate_script");
    expect(p).toContain("pointerLock");
  });

  it("does not inject canvas/game hints when the interface is undeclared/absent (#20/#97)", () => {
    const p = buildVisualReviewPrompt({
      mission: "a web app",
      criteria: ["form submits"],
      verifyCommands: [],
      runCommandHint: "npm run dev",
      round: 1,
      priorFindings: [],
    });
    expect(p).not.toContain("KeyboardEvent");
    expect(p).not.toContain("pointerLock");
  });

  it("injects the browser-ui real-input discipline when the interface is browser-ui (#97)", () => {
    const p = buildVisualReviewPrompt({
      mission: "a DOM app",
      criteria: ["the toolbar buttons work"],
      verifyCommands: [],
      runCommandHint: "npm run dev",
      round: 1,
      priorFindings: [],
      projectInterface: "browser-ui",
    });
    expect(p).toContain("Interaction guidance");
    expect(p).toContain("chrome-devtools_click");
    expect(p).toContain("evaluate_script");
    expect(p).toMatch(/real input|for real/i);
  });

  it("injects nothing for terminal/none interfaces (zero pollution for non-browser seats, #97)", () => {
    for (const iface of ["terminal", "none"] as const) {
      const p = buildVisualReviewPrompt({
        mission: "m",
        criteria: [],
        verifyCommands: [],
        runCommandHint: "x",
        round: 1,
        priorFindings: [],
        projectInterface: iface,
      });
      expect(p).not.toContain("Interaction guidance");
      expect(p).not.toContain("This is a browser DOM app");
      expect(p).not.toContain("canvas-based game");
    }
  });

  it("project-provided hints take precedence over declared-interface guidance (#20/#97)", () => {
    const hints = "Custom interaction model: use window.__gameAPI.move('forward').";
    const p = buildVisualReviewPrompt({
      mission: "a game",
      criteria: ["player moves"],
      verifyCommands: [],
      runCommandHint: "npm run dev",
      round: 1,
      priorFindings: [],
      projectInterface: "canvas",
      interactionHints: hints,
    });
    expect(p).toContain(hints);
    expect(p).toContain("Interaction hints");
    expect(p).not.toContain("KeyboardEvent");
  });
});

describe("shouldRunVisualReview", () => {
  it("returns false for a scaffold ticket whose criteria are purely structural (no runtime behaviour to observe)", () => {
    const ticket: Ticket = {
      file: "01-scaffold.md",
      number: "01",
      slug: "scaffold",
      title: "Scaffold: build, config, project structure",
      what: "A buildable project with a config module pinning every shared number.",
      mission: "a retro-neon browser snake with smooth gliding movement",
      blocked_by: [],
      criteria: [
        "npm run typecheck, npm run test, and npm run build all pass",
        "tsconfig.json has strict mode enabled",
        "src/constants.ts exports: BOARD_SIZE=24, CELL_SIZE=24, CANVAS_SIZE=576",
        "Origin convention documented in constants.ts: cell (0,0) is top-left",
      ],
      files: [],
      references: [],
      introduces: [],
    };
    expect(shouldRunVisualReview(ticket)).toBe(false);
  });

  it("returns true for a ticket whose criteria mention rendering or visual output", () => {
    const ticket: Ticket = {
      file: "03-render.md",
      number: "03",
      slug: "render",
      title: "Playable render loop: Glide, input, neon snake, HUD",
      what: "The game plays in the browser: an rAF loop feeds keyboard input into the Input Buffer and paints every frame in retro-neon style.",
      mission: "a retro-neon browser snake",
      blocked_by: [],
      criteria: [
        "Arrows and WASD steer the snake on the canvas",
        "the snake visibly glides between cells (no discrete cell-jump visible at 60fps)",
        "HUD inside the canvas shows score and level, both updating live",
        "Neon style: glow via canvas shadowBlur with the NEON palette on #050510 background",
      ],
      files: [],
      references: [],
      introduces: [],
    };
    expect(shouldRunVisualReview(ticket)).toBe(true);
  });

  it("returns true when criteria mention interactive behaviour (respond, move, input)", () => {
    const ticket: Ticket = {
      file: "02-input.md",
      number: "02",
      slug: "input",
      title: "Input handling",
      what: "Wire keyboard input to the game.",
      mission: "a pong game",
      blocked_by: [],
      criteria: [
        "paddles respond to keyboard input",
        "the ball moves at a constant speed",
      ],
      files: [],
      references: [],
      introduces: [],
    };
    expect(shouldRunVisualReview(ticket)).toBe(true);
  });

  it("returns false when criteria are only about build/test/config with no visual language", () => {
    const ticket: Ticket = {
      file: "01-init.md",
      number: "01",
      slug: "init",
      title: "Initialize project",
      what: "Set up the project structure.",
      mission: "a CLI tool",
      blocked_by: [],
      criteria: [
        "npm run build passes",
        "tsconfig.json has strict mode enabled",
        "package.json has the run script defined",
      ],
      files: [],
      references: [],
      introduces: [],
    };
    expect(shouldRunVisualReview(ticket)).toBe(false);
  });

  it("returns true when no criteria are declared (default to reviewing — no criteria is not a signal to skip)", () => {
    const ticket: Ticket = {
      file: "05-gameplay.md",
      number: "05",
      slug: "gameplay",
      title: "Gameplay logic",
      what: "Implement the core gameplay.",
      mission: "a platformer",
      blocked_by: [],
      criteria: [],
      files: [],
      references: [],
      introduces: [],
    };
    expect(shouldRunVisualReview(ticket)).toBe(true);
  });

  it("returns true for a fix ticket whose criteria mention running the app", () => {
    const ticket: Ticket = {
      file: "06-fix.md",
      number: "06",
      slug: "fix",
      title: "Fix visual review finding: no food rendered",
      what: "The visual reviewer found this BLOCKER: no food rendered on the board.",
      mission: "a snake game",
      blocked_by: [],
      criteria: [
        "Run the app and confirm the finding no longer reproduces",
        "Existing verify commands still pass",
      ],
      files: [],
      references: [],
      introduces: [],
    };
    expect(shouldRunVisualReview(ticket)).toBe(true);
  });
});

describe("buildVisualReviewPrompt (per-ticket mode)", () => {
  it("scopes the prompt to this ticket only and tells the reviewer not to flag features built by other tickets", () => {
    const p = buildVisualReviewPrompt({
      mission: "a retro-neon browser snake with gliding movement, score/level HUD, and game-over screen",
      criteria: ["Arrows and WASD steer the snake on the canvas", "the snake visibly glides between cells"],
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run preview",
      round: 1,
      priorFindings: [],
      perTicket: {
        title: "Playable render loop: Glide, input, neon snake, HUD",
        what: "The game plays in the browser: an rAF loop feeds keyboard input into the Input Buffer and paints every frame in retro-neon style.",
      },
    });
    expect(p).toContain("Playable render loop");
    expect(p).toMatch(/per-ticket|this ticket/i);
    expect(p).toMatch(/out of scope|other ticket|do not flag.*absen|not yet built/i);
  });

  it("does not include the per-ticket scoping language in end-of-run mode (backward compat)", () => {
    const p = buildVisualReviewPrompt({
      mission: "a snake game",
      criteria: ["snake renders"],
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run preview",
      round: 1,
      priorFindings: [],
    });
    expect(p).not.toMatch(/PER-TICKET review|OUT OF SCOPE|Features built by OTHER tickets/i);
    expect(p).not.toContain("WHAT THIS TICKET BUILDS");
  });

  it("includes the ticket's 'what' as context for what was built", () => {
    const p = buildVisualReviewPrompt({
      mission: "a pong game",
      criteria: ["paddles respond to keyboard input"],
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run preview",
      round: 1,
      priorFindings: [],
      perTicket: {
        title: "Input handling",
        what: "Wire keyboard input to the game's paddle objects.",
      },
    });
    expect(p).toContain("Wire keyboard input to the game's paddle objects.");
  });

  it("still includes the mission as background context in per-ticket mode (so the reviewer understands the app's purpose)", () => {
    const p = buildVisualReviewPrompt({
      mission: "a retro-neon browser snake with gliding movement",
      criteria: ["the snake visibly glides between cells"],
      verifyCommands: ["npm run build"],
      runCommandHint: "npm run preview",
      round: 1,
      priorFindings: [],
      perTicket: {
        title: "Render loop",
        what: "The rAF loop paints every frame.",
      },
    });
    expect(p).toContain("a retro-neon browser snake with gliding movement");
  });
});

describe("runCommandFromVerify", () => {
  const t = (file: string): Ticket => ({
    file,
    number: "01",
    slug: "x",
    title: "x",
    what: "w",
    mission: "m",
    blocked_by: [],
    criteria: [],
    files: [],
    references: [],
    introduces: [],
  });

  it("returns the first verify command as the run hint", () => {
    expect(runCommandFromVerify(["cargo build", "cargo test"], [t("01-x.md")])).toContain("cargo build");
  });

  it("includes the run/launch advisory regardless of language", () => {
    const hint = runCommandFromVerify(["npm test"], [t("01-x.md")]);
    expect(hint).toContain("run/launch command");
  });

  it("falls back to a generic message when verify is empty", () => {
    expect(runCommandFromVerify([], [t("01-x.md")])).toMatch(/no hint available/i);
  });
});

describe("browser hygiene in visual review prompts (#72)", () => {
  it("tells the visual reviewer to close stale pages from earlier phases", () => {
    const p = buildVisualReviewPrompt({
      mission: "a game",
      criteria: ["game renders"],
      verifyCommands: ["true"],
      runCommandHint: "npm run dev",
      round: 1,
      priorFindings: [],
    });
    expect(p).toMatch(/Browser hygiene/);
    expect(p).toMatch(/close every one that is not this project's app/);
  });

  it("tells the visual reviewer to keep scratch files in .railhead/ not /tmp", () => {
    const p = buildVisualReviewPrompt({
      mission: "a game",
      criteria: ["game renders"],
      verifyCommands: ["true"],
      runCommandHint: "npm run dev",
      round: 1,
      priorFindings: [],
    });
    expect(p).toMatch(/Scratch files/);
    expect(p).toMatch(/\.railhead\//);
    expect(p).toMatch(/never to \/tmp/);
  });
});

describe("touchesVisualSurface (issue #99 — one shared surface gate)", () => {
  const ticket = (criteria: string[]): Ticket => ({
    file: "01-x.md", number: "01", slug: "x", title: "x", what: "x", mission: "a build",
    blocked_by: [], criteria, files: [], references: [], introduces: [],
  });

  it("is the same gate shouldRunVisualReview uses (they can never disagree)", () => {
    const surface = ticket(["the snake visibly glides on the canvas", "HUD shows score"]);
    const structural = ticket(["npm run build passes", "constants.ts exports BOARD_SIZE"]);
    expect(shouldRunVisualReview(surface)).toBe(touchesVisualSurface(surface));
    expect(shouldRunVisualReview(structural)).toBe(touchesVisualSurface(structural));
  });

  it("is recall-biased: empty criteria default to surface (a false positive costs ~250 words)", () => {
    expect(touchesVisualSurface(ticket([]))).toBe(true);
  });

  it("returns true for rendered-surface and interaction vocabulary", () => {
    expect(touchesVisualSurface(ticket(["render the board", "the paddle responds to input", "Run the app and confirm"]))).toBe(true);
  });

  it("returns false for a pure structural/config ticket", () => {
    expect(touchesVisualSurface(ticket(["npm run typecheck passes", "src/constants.ts exports CELL_SIZE"]))).toBe(false);
  });
});

describe("buildVisualReviewPrompt — coherence charter pointer (issue #99)", () => {
  const charter = "### Chrome rules\nThe single toolbar recipe; do not introduce a competing style.";
  const base = {
    mission: "a pong game",
    criteria: ["paddles respond to keyboard input"],
    verifyCommands: ["npm run build"],
    runCommandHint: "npm run dev",
    round: 1,
    priorFindings: [],
  };

  it("injects the charter as an in-scope conformance check when supplied", () => {
    const p = buildVisualReviewPrompt({ ...base, coherenceDoc: charter });
    expect(p).toContain("Coherence charter (in-scope check)");
    expect(p).toContain("do not introduce a competing style");
    expect(p).toContain("docs/coherence.md");
  });

  it("omits the charter block when no charter was authored", () => {
    const p = buildVisualReviewPrompt(base);
    expect(p).not.toContain("Coherence charter (in-scope check)");
  });
});

describe("buildVisualReviewPrompt — degraded-target recovery note (#96)", () => {
  const base = {
    mission: "a pong game",
    criteria: ["paddles respond to keyboard input"],
    verifyCommands: ["npm run build"],
    runCommandHint: "npm run dev",
    round: 2,
    priorFindings: [],
  };

  it("injects the recovery note only when the retried round carries it", () => {
    const p = buildVisualReviewPrompt({ ...base, recoveryNote: DEGRADED_TARGET_RECOVERY_NOTE });
    expect(p).toContain("Interaction-target recovery note");
    expect(p).toMatch(/restart the app cleanly/i);
    expect(p).toMatch(/FRESH page\/tab/i);
  });

  it("omits the recovery note on a normal round", () => {
    const p = buildVisualReviewPrompt(base);
    expect(p).not.toContain("Interaction-target recovery note");
  });

  it("warns against unbounded in-page pixel-readback poll loops (the self-inflicted wedge)", () => {
    const p = buildVisualReviewPrompt({ ...base, recoveryNote: DEGRADED_TARGET_RECOVERY_NOTE });
    expect(p).toMatch(/pixels\/canvas|canvas/i);
    expect(p).toMatch(/BOUNDED/i);
    expect(p).toMatch(/evaluate_script/i);
  });
});

describe("vision capability injection (ADR 0036)", () => {
  it("names the verified capability so the seat cannot opt out of reading screenshots", () => {
    const p = buildVisualReviewPrompt({
      mission: "m",
      criteria: [],
      verifyCommands: [],
      runCommandHint: "x",
      round: 1,
      priorFindings: [],
      visionCapability: { readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(p).toContain("Vision capability (railhead-verified)");
    expect(p).toContain("not a valid finding");
  });

  it("adds no capability block when the railhead has no measurement", () => {
    const p = buildVisualReviewPrompt({
      mission: "m",
      criteria: [],
      verifyCommands: [],
      runCommandHint: "x",
      round: 1,
      priorFindings: [],
    });
    expect(p).not.toContain("Vision capability (railhead-verified)");
  });
});
