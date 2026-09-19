import { describe, it, expect } from "vitest";
import { buildImplementerPrompt, buildReviewerPrompt, buildReviewerReadModePrompt, buildTestPhasePrompt, buildContractExtractFilePrompt } from "./prompt.ts";
import { LEARNED_MARKER } from "./learnings.ts";
import { HANDOFF_START, HANDOFF_END } from "./handoff.ts";

const tmp = "/tmp";

describe("buildImplementerPrompt", () => {
  it("instructs terse, unattended output without dropping the DONE marker", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
    });
    expect(p).toContain("no human reads your narration");
    expect(p).toContain("DONE");
    expect(p).toContain("Terse output");
  });

  it("instructs build-early discipline (#dependency-burn)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["cargo build"],
      prevFeedback: null,
    });
    expect(p).toContain("Build early, build often");
    expect(p).toMatch(/after writing your first file/i);
  });

  it("warns against reading dependency source caches (#dependency-burn)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    expect(p).toContain("dependency caches");
    expect(p).toContain("step budget");
    expect(p).toContain("examples/");
  });

  it("places the LEARNED: marker instruction BEFORE the DONE terminator (ADR 0013 — push wiring fix)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
    });
    const learnedIdx = p.indexOf(LEARNED_MARKER);
    const doneIdx = p.indexOf("DONE <files touched");
    expect(learnedIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    expect(learnedIdx).toBeLessThan(doneIdx);
  });

  it("on a review retry, includes the prior diff and tells the implementer to PATCH not rewrite", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: "Fix these must-fix issues:\n[MAJOR] edge case",
      priorDiff: "diff --git a/src/main.rs b/src/main.rs\n+pub fn step() {}",
    });
    expect(p).toContain("PATCH, do NOT rewrite");
    expect(p).toContain("Do NOT regenerate files that already work");
    expect(p).toContain("previous attempt's working diff");
    expect(p).toContain("pub fn step");
  });

  it("falls back to the plain-reviewer-feedback block when priorDiff is empty", async () => {
    // A stale or wiped worktree (e.g. after an infra retry where the prior
    // implementer crashed mid-write) yields an empty diff. The prompt must
    // NOT claim the work is "already on disk" in that case — the implementer
    // would believe it is patching when there is nothing to patch.
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: "Fix these must-fix issues:\n[MAJOR] edge case",
      priorDiff: "",
    });
    expect(p).toContain("Reviewer feedback from the previous attempt");
    expect(p).not.toContain("already on disk");
    expect(p).not.toContain("PATCH, do NOT rewrite");
  });

  it("instructs the implementer to emit a $HANDOFF block on failure (#9 — push handoff)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
    });
    expect(p).toContain(HANDOFF_START);
    expect(p).toContain(HANDOFF_END);
    expect(p).toMatch(/what you tried/i);
    expect(p).toMatch(/why it failed/i);
    expect(p).toMatch(/suggested approach for the next attempt/i);
  });

  it("places the $HANDOFF instruction BEFORE the DONE terminator", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
    });
    const handoffIdx = p.indexOf(HANDOFF_START);
    const doneIdx = p.indexOf("DONE <files touched");
    expect(handoffIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    expect(handoffIdx).toBeLessThan(doneIdx);
  });

  it("injects prevHandoff in place of priorDiff when a handoff was captured (#9)", async () => {
    const handoff = "tried adding the Bevy plugin to the app builder\nfailed because the plugin expects a RenderApp that isn't set up yet\ntry setting up the RenderApp phase first, then add the plugin";
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: "[BLOCKER] the plugin panics on init",
      priorDiff: "diff --git a/src/main.rs b/src/main.rs\n+pub fn step() {}",
      prevHandoff: handoff,
    });
    expect(p).toContain("Handoff from the previous attempt");
    expect(p).toContain(handoff);
    // When a handoff is present, the raw priorDiff is NOT injected — the
    // handoff substitutes for it (issue #9: priorDiff is the bloat).
    expect(p).not.toContain("previous attempt's working diff");
    expect(p).not.toContain("pub fn step");
  });

  it("falls back to the raw priorDiff when no prevHandoff was captured (push-failed / review-retry)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: "[MAJOR] edge case",
      priorDiff: "diff --git a/src/main.rs b/src/main.rs\n+pub fn step() {}",
      prevHandoff: null,
    });
    expect(p).toContain("PATCH, do NOT rewrite");
    expect(p).toContain("pub fn step");
    expect(p).not.toContain("Handoff from the previous attempt");
  });

  it("injects prevHandoff as test-phase guidance on the first attempt when prevFeedback is null (#5)", async () => {
    const handoff = "src/greet.test.ts: asserts greet('a') returns 'hello a'; failing because greet is not yet defined";
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["greet returns a greeting"],
      verify: ["npm test"],
      prevFeedback: null,
      prevHandoff: handoff,
    });
    expect(p).toContain("Handoff from the previous test phase");
    expect(p).toContain(handoff);
    expect(p).toContain("The test phase wrote failing tests");
    // No priorDiff on the first attempt, and no "attempt" wording.
    expect(p).not.toContain("Handoff from the previous attempt");
  });

  it("never instructs the implementer to self-check visually — even when the build has visual criteria (#75)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["the paddle moves on screen"],
      verify: ["cargo build", "cargo test"],
      prevFeedback: null,
    });
    expect(p).not.toContain("Visual self-check");
    expect(p).not.toContain("Run the app");
    expect(p).not.toContain("Capture a screenshot");
    expect(p).not.toContain("verify visually");
    expect(p).toContain("DONE");
  });

  it("includes project learnings when provided", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
      learnings: "screencapture -x gives raw PNG\ncargo run panics without TTY",
    });
    expect(p).toContain("Project learnings");
    expect(p).toContain("screencapture -x gives raw PNG");
    expect(p).toContain("cargo run panics without TTY");
  });

  it("warns that learnings are unverified model-claims and capability claims must be tested before deferring", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
      learnings: "this model cannot read image attachments",
    });
    expect(p).toContain("unverified model-claims");
    expect(p).toMatch(/TEST.*before deferring/i);
    expect(p).toContain("this model cannot read image attachments");
  });

  it("omits the learnings block when learnings are null or absent", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
      learnings: null,
    });
    expect(p).not.toContain("Project learnings");
  });

  it("injects the diagnosing-bugs discipline when fixMode is true (#6)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-fix-bug.md",
      mission: "fix the paddle bug",
      ticketBody: "Paddle doesn't move when arrow keys are pressed",
      criteria: ["paddle moves up/down on arrow key press"],
      verify: ["npm test"],
      prevFeedback: null,
      fixMode: true,
    });
    expect(p).toContain("Diagnosing-bugs discipline");
    expect(p).toContain("Phase 1: Build a feedback loop");
    expect(p).toContain("red-capable");
    expect(p).toContain("Phase 2: Minimize");
    expect(p).toContain("3-5 ranked hypotheses");
    expect(p).toContain("falsifiable");
    expect(p).toContain("one variable at a time");
    expect(p).toContain("[DEBUG-");
    expect(p).toContain("regression test BEFORE the fix");
    expect(p).toContain("Phase 6: Cleanup");
  });

  it("omits the diagnosing-bugs discipline when fixMode is false/absent (#6)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "add a greet function",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    expect(p).not.toContain("Diagnosing-bugs discipline");
    expect(p).not.toContain("Phase 1: Build a feedback loop");
  });

  it("includes tool-output scoping discipline (#8)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    expect(p).toMatch(/Tool-output discipline/i);
    expect(p).toContain("tail -30");
    expect(p).toContain("--name-only");
    expect(p).toMatch(/10k-token build log/i);
  });

  it("includes the lazy-ladder discipline block (#32)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    expect(p).toMatch(/Lazy code discipline/i);
    expect(p).toMatch(/YAGNI/);
    expect(p).toMatch(/Already in this codebase/);
    expect(p).toMatch(/stdlib/);
    expect(p).toMatch(/Native platform feature/);
    expect(p).toMatch(/Installed dependency/);
    expect(p).toMatch(/One line/);
    expect(p).toMatch(/minimum that works/);
  });

  it("includes the safety carve-out in the lazy-ladder (#32)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    expect(p).toMatch(/Never simplify away/);
    expect(p).toMatch(/input validation at trust boundaries/);
    expect(p).toMatch(/error handling/);
    expect(p).toMatch(/security/);
  });

  it("places the lazy-ladder AFTER fresh-context block and BEFORE tool-output discipline (#32)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    const freshIdx = p.indexOf("Fresh context, small model");
    const ladderIdx = p.indexOf("Lazy code discipline");
    const toolIdx = p.indexOf("Tool-output discipline");
    expect(freshIdx).toBeGreaterThan(-1);
    expect(ladderIdx).toBeGreaterThan(freshIdx);
    expect(toolIdx).toBeGreaterThan(ladderIdx);
  });

  it("places stable instructions BEFORE volatile per-ticket content (#33 — prefix cache)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "do the work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    const stableTerseIdx = p.indexOf("Terse output");
    const stableAgentsIdx = p.indexOf("Project agent guidance");
    const volatileTicketIdx = p.indexOf("TICKET FILE:");
    const volatileBodyIdx = p.indexOf("do the work");
    const volatileCriteriaIdx = p.indexOf("ACCEPTANCE CRITERIA:");

    expect(stableTerseIdx).toBeGreaterThan(-1);
    expect(stableAgentsIdx).toBeGreaterThan(stableTerseIdx);
    expect(volatileTicketIdx).toBeGreaterThan(stableAgentsIdx);
    expect(volatileBodyIdx).toBeGreaterThan(volatileTicketIdx);
    expect(volatileCriteriaIdx).toBeGreaterThan(volatileBodyIdx);
  });

  it("places retry-only content (feedback, handoff) AFTER all stable and ticket blocks (#33)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "do the work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: "Fix this:\n[MAJOR] edge case",
      priorDiff: "diff --git a/src/main.ts b/src/main.ts\n+pub fn step() {}",
    });
    const ticketCriteriaIdx = p.indexOf("ACCEPTANCE CRITERIA:");
    const feedbackIdx = p.indexOf("Reviewer feedback from the previous attempt");
    expect(feedbackIdx).toBeGreaterThan(ticketCriteriaIdx);
  });

  it("injects an attempt-history block when attemptHistory is provided (#16)", async () => {
    const history = [
      { attempt: 1, findings: ["[BLOCKER] missing null check"] },
      { attempt: 2, findings: ["[BLOCKER] missing null check", "[MAJOR] wrong return type"] },
    ];
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "do the work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: "Fix these must-fix issues:\n[MAJOR] wrong return type",
      prevHandoff: "tried X, failed because Y, try Z",
      attemptHistory: history,
    });
    expect(p).toContain("Attempt history");
    expect(p).toContain("Attempt 1");
    expect(p).toContain("Attempt 2");
    expect(p).toContain("[BLOCKER] missing null check");
    expect(p).toContain("you have fresh context");
  });

  it("omits the attempt-history block when attemptHistory is empty or absent (#16)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "do the work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
    });
    expect(p).not.toContain("Attempt history");
  });

  it("attempt-history block appears after criteria but in the retry-only tail (#16, #33)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "do the work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: "Fix:\n[MAJOR] bug",
      attemptHistory: [{ attempt: 1, findings: ["[MAJOR] bug"] }],
    });
    const criteriaIdx = p.indexOf("ACCEPTANCE CRITERIA:");
    const historyIdx = p.indexOf("Attempt history");
    expect(historyIdx).toBeGreaterThan(criteriaIdx);
  });

  it("attempt-history records the approach summary from the handoff when available (#16)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "do the work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: "Fix:\n[MAJOR] bug",
      prevHandoff: "tried adding a null guard\nfailed because the type system rejects it\ntry using optional chaining",
      attemptHistory: [{ attempt: 1, findings: ["[MAJOR] bug"], approach: "tried adding a null guard" }],
    });
    expect(p).toContain("tried adding a null guard");
  });

  it("escalates reviewer verbosity on attempt 3+ (#16)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "diff",
      attempt: 3,
    });
    expect(p).toContain("attempt 3+");
    expect(p).toContain("explain WHY");
    expect(p).toContain("suggest");
  });

  it("does not escalate reviewer verbosity on attempt 1 or 2 (#16)", async () => {
    const p1 = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "diff",
      attempt: 1,
    });
    expect(p1).not.toContain("attempt 3+");

    const p2 = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "diff",
      attempt: 2,
    });
    expect(p2).not.toContain("attempt 3+");
  });

  it("escalates reviewer verbosity in read-mode too (#16)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
      attempt: 3,
    });
    expect(p).toContain("attempt 3+");
    expect(p).toContain("explain WHY");
  });

  it("places contracts and learnings AFTER stable instructions but BEFORE ticket content (#33)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "do the work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
      learnings: "some learning fact",
      contracts: {
        schema_version: 1,
        entries: [{ symbol: "greet", kind: "function", file: "src/index.js", signature: "greet(name) -> string" }],
      },
    });
    const stableIdx = p.indexOf("Project agent guidance");
    const learningsIdx = p.indexOf("Project learnings");
    const contractsIdx = p.indexOf("Existing public contracts");
    const ticketIdx = p.indexOf("TICKET FILE:");
    expect(learningsIdx).toBeGreaterThan(stableIdx);
    expect(contractsIdx).toBeGreaterThan(stableIdx);
    expect(ticketIdx).toBeGreaterThan(learningsIdx);
    expect(ticketIdx).toBeGreaterThan(contractsIdx);
  });

  it("injects design and architecture docs when provided (#34)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a roguelike",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
      designDoc: "A roguelike with oppressive atmosphere. Visual identity: desaturated palette.",
      architectureDoc: "Modules: engine, renderer, juice. The renderer owns the draw loop.",
    });
    expect(p).toContain("Design intent (planner's vision");
    expect(p).toContain("oppressive atmosphere");
    expect(p).toContain("Architecture intent (planner's structural plan");
    expect(p).toContain("Modules: engine, renderer, juice.");
  });

  it("omits design and architecture blocks when docs are null/absent (#34)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
    });
    expect(p).not.toContain("Design intent (planner's vision");
    expect(p).not.toContain("Architecture intent (planner's structural plan");
  });

  it("requires a RED/GREEN evidence block in the report when testable is true (#45)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
      testable: true,
    });
    expect(p).toMatch(/RED.*evidence/i);
    expect(p).toMatch(/GREEN.*evidence/i);
    expect(p).toMatch(/command.*run/i);
    expect(p).toMatch(/failing output/i);
    expect(p).toMatch(/passing output/i);
    expect(p).toMatch(/why.*failure.*expected/i);
  });

  it("omits the RED/GREEN evidence block when testable is false (#45)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-config.md",
      mission: "a build",
      ticketBody: "tweak a config file",
      criteria: ["config has the new key"],
      verify: ["npm test"],
      prevFeedback: null,
      testable: false,
    });
    expect(p).not.toMatch(/RED.*evidence/i);
    expect(p).not.toMatch(/GREEN.*evidence/i);
  });

  it("omits the RED/GREEN evidence block when testable is absent (#45)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    expect(p).not.toMatch(/RED.*evidence/i);
    expect(p).not.toMatch(/GREEN.*evidence/i);
  });

  it("places the RED/GREEN evidence instruction BEFORE the DONE terminator (#45)", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
      testable: true,
    });
    const evidenceIdx = p.indexOf("RED");
    const doneIdx = p.indexOf("DONE <files touched");
    expect(evidenceIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(-1);
    expect(evidenceIdx).toBeLessThan(doneIdx);
  });
});

describe("buildReviewerPrompt", () => {
  it("treats ACs that name a third-party artifact as unverified plan claims: judge capability, never double-down on the name", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toContain("Plan-authority note");
    expect(p).toMatch(/UNVERIFIED PLAN CLAIM, not ground truth/i);
    expect(p).toMatch(/do not block an implementer for not installing or using a named artifact/i);
    expect(p).toMatch(/record the substitution/i);
  });

  it("instructs terse output with the exact markers", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toContain("reply terse, no prose narration");
    expect(p).toContain("$BLOCKING");
    expect(p).toContain("$NITS");
    expect(p).toContain("$OK");
  });

  it("requires every [BLOCKER] to name a diff location and warns an unanchored one is treated as [MAJOR] (#94)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toContain("every [BLOCKER] MUST name the file");
    expect(p).toContain("in this ticket's diff that it is about");
    expect(p).toContain("is treated as [MAJOR]");
  });

  it("asks the reviewer to recheck prior blocking findings", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
      priorFindings: ["car braking not wired"],
    });
    expect(p).toContain("PRIOR BLOCKING FINDINGS");
    expect(p).toContain("car braking not wired");
    expect(p).toContain("re-raise a resolved item");
  });

  it("sorts findings into must-fix vs nits", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toContain("MUST-FIX");
    expect(p).toContain("NIT");
    expect(p).toContain("[BLOCKER]");
    expect(p).toContain("[MAJOR]");
    // Review is about completeness + correctness, not code polish.
    expect(p).toContain("not to police code style or polish");
  });

  it("tells the reviewer not to raise test quality as a blocking finding", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toContain("Do NOT raise test quality as a blocking finding");
    expect(p).toContain("test-thoroughness opinions, not correctness issues");
  });

  it("includes the contracts slice so the reviewer can check signatures against real ground truth", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
      contracts: {
        schema_version: 1,
        entries: [{ symbol: "greet", kind: "function", file: "src/index.js", signature: "greet(name) -> string" }],
      },
    });
    expect(p).toContain("EXISTING PUBLIC CONTRACTS");
    expect(p).toContain("greet(name) -> string");
    // Issue #64: the reviewer gets the FULL index (no per-ticket slice), so the
    // wording names that — it no longer claims "same slice the Implementer was
    // given" (stale since #64, issue #106-G).
    expect(p).toContain("the full contracts index");
  });

  it("omits the contracts block entirely when no contracts are given", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    // Check #4's static wording mentions "EXISTING PUBLIC CONTRACTS" whether
    // or not any are supplied; the block itself (its "reuse or extend" lead-in
    // and the "full contracts index" note) is the part that must actually
    // disappear.
    expect(p).not.toContain("the full contracts index");
    expect(p).not.toContain("this ticket should reuse or extend");
  });

  it("includes project learnings when provided", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
      learnings: "screencapture -x gives raw PNG\nnpm run dev serves on 5173",
    });
    expect(p).toContain("Project learnings");
    expect(p).toContain("screencapture -x gives raw PNG");
    expect(p).toContain("npm run dev serves on 5173");
  });

  it("omits the learnings block when learnings are null or absent", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toContain("Project learnings");
  });

  it("forbids reporting compile/build/typecheck failures since the railhead runs verify (#1)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/do not report.*compile/i);
    expect(p).toMatch(/railhead runs.*verify/i);
  });

  it("tells the reviewer to ignore tool-generated artifacts and judge only source code", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/tool-generated artifacts/i);
    expect(p).toMatch(/source code changes/i);
  });

  it("checks for leftover [DEBUG-...] logs when fixMode is true (#6)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-fix.md",
      ticketBody: "fix the bug",
      criteria: ["c1"],
      diff: "d",
      fixMode: true,
    });
    expect(p).toContain("[DEBUG-");
    expect(p).toMatch(/debug instrumentation/i);
    expect(p).toMatch(/leftover/i);
  });

  it("does not check for debug logs when fixMode is false/absent (#6)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toContain("[DEBUG-");
    expect(p).not.toMatch(/debug instrumentation/i);
  });

  it("includes the 7 Fowler code smells as a positive checklist (#10)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/Code smells/i);
    expect(p).toContain("Mysterious Name");
    expect(p).toContain("Duplicated Code");
    expect(p).toContain("Feature Envy");
    expect(p).toContain("Data Clumps");
    expect(p).toContain("Speculative Generality");
    expect(p).toContain("Shotgun Surgery");
    expect(p).toContain("Divergent Change");
    expect(p).toContain("docs/code-review-smells.md");
  });

  it("issue #71: tells the reviewer smells never block on their own — NITS unless they risk correctness", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/smell NEVER blocks the ticket on its own/i);
    expect(p).toMatch(/\$NITS \(advisory/);
    // The old instruction raised smells as blocking [MAJOR] findings.
    expect(p).not.toMatch(/surface any you find as \[MAJOR\] findings/);
  });

  it("issue #71: NITS bucket is advisory (reported), not 'never report these'", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/ADVISORY \(\$NITS\)/);
    expect(p).not.toMatch(/NIT: anything that only touches code quality or polish — never report these/);
  });

  it("does not include the 5 deferred smells in the prompt (#10)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toContain("Primitive Obsession");
    expect(p).not.toContain("Repeated Switches");
    expect(p).not.toContain("Message Chains");
    expect(p).not.toContain("Middle Man");
    expect(p).not.toContain("Refused Bequest");
  });

  it("includes the necessity review block (does this code need to exist?) (#40)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/Necessity|does this code need to exist/i);
    expect(p).toContain("Reimplementation");
    expect(p).toContain("Premature abstraction");
    expect(p).toContain("Dead code");
    expect(p).toMatch(/do not.*flag.*code.*ticket.*explicitly.*asked/i);
  });

  it("injects pre-review lint findings when provided (#41)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
      lintOutput: "src/index.ts:10:5  error  'unused' is assigned a value but never used  no-unused-vars",
    });
    expect(p).toMatch(/pre.*review.*lint|lint.*finding/i);
    expect(p).toContain("'unused' is assigned a value but never used");
    expect(p).toMatch(/already.*flagged.*do.*not.*re.*report/i);
  });

  it("omits the lint block when no lint output is provided (#41)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toMatch(/pre.*review.*lint|lint.*finding/i);
  });

  it("omits the lint block when lint output is empty string (#41)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
      lintOutput: "",
    });
    expect(p).not.toMatch(/pre.*review.*lint|lint.*finding/i);
  });

  it("instructs the reviewer to treat missing red/green evidence as a finding when testable is true (#45)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
      testable: true,
    });
    expect(p).toMatch(/red.*green.*evidence/i);
    expect(p).toMatch(/missing.*implausible/i);
  });

  it("omits the red/green evidence check when testable is false (#45)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-config.md",
      ticketBody: "tweak a config file",
      criteria: ["config has the new key"],
      diff: "d",
      testable: false,
    });
    expect(p).not.toMatch(/red.*green.*evidence/i);
  });

  it("omits the red/green evidence check when testable is absent (#45)", async () => {
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toMatch(/red.*green.*evidence/i);
  });

  it("hands the diff as a file path + stat instead of inlining the body when diffFile is set (#46)", async () => {
    const diff = "diff --git a/src/index.ts b/src/index.ts\n+export const x = 1;";
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff,
      diffFile: ".railhead/run-abc/events/01-01-review.diff",
      diffStat: " src/index.ts | 1 +\n 1 file changed, 1 insertion(+)",
    });
    expect(p).toContain(".railhead/run-abc/events/01-01-review.diff");
    expect(p).toContain("1 file changed, 1 insertion(+)");
    expect(p).not.toContain(diff);
    expect(p).toMatch(/read it from the file/i);
  });

  it("inlines the diff body when diffFile is absent (#46 — back-compat)", async () => {
    const diff = "diff --git a/src/index.ts b/src/index.ts\n+export const x = 1;";
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff,
    });
    expect(p).toContain(diff);
    expect(p).not.toMatch(/read it from the file/i);
  });

  it("inlines the diff body when diffFile is set but empty (#46 — graceful)", async () => {
    const diff = "diff --git a/src/index.ts b/src/index.ts\n+export const x = 1;";
    const p = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff,
      diffFile: "",
    });
    expect(p).toContain(diff);
    expect(p).not.toMatch(/read it from the file/i);
  });
});

describe("buildTestPhasePrompt", () => {
  // Issue #5 — TDD as a railhead phase before implement. The test author
  // writes one failing test per acceptance criterion at the seams the ticket
  // names, runs them, confirms they fail for the right reasons, and emits a
  // $HANDOFF block the implementer receives as prevHandoff.

  const baseArgs = {
    cwd: tmp,
    ticketFile: "01-add-greet.md",
    ticketBody: "export a greet function",
    criteria: ["greet(name) returns a greeting", "greet handles empty name"],
    verify: ["npm test"],
    seams: ["src/index.ts:greet", "src/index.ts:greet (empty-input branch)"],
  };

  it("emits the $HANDOFF block instruction the implementer receives as prevHandoff", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).toContain(HANDOFF_START);
    expect(p).toContain(HANDOFF_END);
    expect(p).toMatch(/what the tests assert/i);
  });

  it("writes ONE test per criterion, not an exhaustive spec — anti-horizontal-slicing", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).toMatch(/one test per criterion/i);
  });

  it("forbids the three anti-patterns (implementation-coupled, tautological, horizontal)", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).toMatch(/implementation-coupled/i);
    expect(p).toMatch(/tautological/i);
    expect(p).toMatch(/horizontal/i);
  });

  it("names the seams the tests must target", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).toContain("src/index.ts:greet");
  });

  it("instructs the test author to run the tests and confirm failure for the right reason", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).toMatch(/run.*tests/i);
    expect(p).toMatch(/fail.{0,30}right reason/i);
  });

  it("forbids tautological tests that pass before implementation", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).toMatch(/passes before implementation.*tautological/i);
  });

  it("does NOT inherit the implementer's contracts block or prior-diff scaffolding (narrow prompt)", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).not.toMatch(/PATCH, do NOT rewrite/);
    expect(p).not.toMatch(/previous attempt's working diff/);
  });

  it("instructs the test author to bail out when the seam does not exist yet", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).toMatch(/seam does not exist/i);
    expect(p).toMatch(/\$HANDOFF NONE/);
    expect(p).toMatch(/do not invent types/i);
  });

  it("injects the context budget so the test author self-paces reads (issue: test phase compacted 9x catting whole files)", async () => {
    const p = await buildTestPhasePrompt({ ...baseArgs, contextBudget: 65000 });
    expect(p).toMatch(/65k tokens/);
    expect(p).toMatch(/small-context/i);
  });

  it("instructs targeted reads over whole-file cats — the failure that burned 22 compactions in test phases", async () => {
    const p = await buildTestPhasePrompt({ ...baseArgs, contextBudget: 65000 });
    expect(p).toMatch(/do not read entire large files/i);
    expect(p).toMatch(/targeted reads|grep/);
  });

  it("omits the budget line when contextBudget is not provided (back-compat)", async () => {
    const p = await buildTestPhasePrompt(baseArgs);
    expect(p).not.toMatch(/context window is budgeted/);
  });
});

describe("buildReviewerReadModePrompt", () => {
  it("instructs the reviewer to read the touched files", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: " src/index.ts | 3 +++\n 1 file changed, 3 insertions(+)",
      files: ["src/index.ts"],
    });
    expect(p).toContain("read tool");
    expect(p).toContain("src/index.ts");
    expect(p).toContain("diff stat");
  });

  it("includes the same output format markers ($BLOCKING, $NITS, $OK)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
    });
    expect(p).toContain("$BLOCKING");
    expect(p).toContain("$NITS");
    expect(p).toContain("$OK");
  });

  it("requires every [BLOCKER] to name a reviewed file and warns an unanchored one is treated as [MAJOR] (#94)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
    });
    expect(p).toContain("every [BLOCKER] MUST name the file");
    expect(p).toContain("among the files listed above");
    expect(p).toContain("is treated as [MAJOR]");
  });

  it("includes prior findings when provided", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
      priorFindings: ["car braking not wired"],
    });
    expect(p).toContain("PRIOR BLOCKING FINDINGS");
    expect(p).toContain("car braking not wired");
  });

  it("includes contracts slice when provided", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
      contracts: {
        schema_version: 1,
        entries: [{ symbol: "greet", kind: "function", file: "src/index.js", signature: "greet(name) -> string" }],
      },
    });
    expect(p).toContain("EXISTING PUBLIC CONTRACTS");
    expect(p).toContain("greet(name) -> string");
  });

  it("includes learnings when provided", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
      learnings: "screencapture -x gives raw PNG",
    });
    expect(p).toContain("Project learnings");
    expect(p).toContain("screencapture -x gives raw PNG");
  });

  it("tells the reviewer NOT to report compile failures (same as diff mode)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
    });
    expect(p).toMatch(/do not report.*compile/i);
  });

  it("lists multiple files for the reviewer to read", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    expect(p).toContain("- src/a.ts");
    expect(p).toContain("- src/b.ts");
    expect(p).toContain("- src/c.ts");
  });

  it("includes the diff stat overview", async () => {
    const stat = " src/index.ts | 3 +++\n 1 file changed, 3 insertions(+)";
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat,
      files: ["src/index.ts"],
    });
    expect(p).toContain("src/index.ts | 3 +++");
  });

  it("checks for [DEBUG-...] logs when fixMode is true", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
      fixMode: true,
    });
    expect(p).toMatch(/\[DEBUG-/i);
    expect(p).toMatch(/\[MAJOR\]/i);
  });

  it("injects design and architecture docs when provided (#34)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
      designDoc: "A roguelike with oppressive atmosphere.",
      architectureDoc: "Modules: engine, renderer.",
    });
    expect(p).toContain("Design intent (planner's vision");
    expect(p).toContain("oppressive atmosphere");
    expect(p).toContain("Architecture intent (planner's structural plan");
    expect(p).toContain("Modules: engine, renderer.");
  });

  it("omits doc blocks when design/architecture are not provided (#34)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
    });
    expect(p).not.toContain("Design intent (planner's vision");
    expect(p).not.toContain("Architecture intent (planner's structural plan");
  });

  it("instructs the reviewer to treat missing red/green evidence as a finding when testable is true (#45)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
      testable: true,
    });
    expect(p).toMatch(/red.*green.*evidence/i);
    expect(p).toMatch(/missing.*implausible/i);
  });

  it("omits the red/green evidence check when testable is false (#45)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-config.md",
      ticketBody: "tweak a config file",
      criteria: ["config has the new key"],
      stat: "stat",
      files: ["src/config.ts"],
      testable: false,
    });
    expect(p).not.toMatch(/red.*green.*evidence/i);
  });

  it("omits the red/green evidence check when testable is absent (#45)", async () => {
    const p = await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
    });
    expect(p).not.toMatch(/red.*green.*evidence/i);
  });
});

describe("buildContractExtractFilePrompt", () => {
  it("includes the file name in the prompt", () => {
    const p = buildContractExtractFilePrompt("src/shader.wgsl", "fn vertex_shader() {}");
    expect(p).toContain("src/shader.wgsl");
  });

  it("includes the file content as SOURCE", () => {
    const content = "export function createPlayer() { return { x: 0, y: 0 }; }";
    const p = buildContractExtractFilePrompt("src/player.ts", content);
    expect(p).toContain("SOURCE:");
    expect(p).toContain(content);
  });

  it("emits the $CONTRACTS block with the file path pre-filled in the example", () => {
    const p = buildContractExtractFilePrompt("src/utils.ts", "export const PI = 3.14;");
    expect(p).toContain("$CONTRACTS");
    expect(p).toContain("$END");
    expect(p).toContain('"file":"src/utils.ts"');
  });

  it("does NOT include a DIFF section (per-file, not per-diff #28)", () => {
    const p = buildContractExtractFilePrompt("src/a.ts", "export const x = 1;");
    expect(p).not.toContain("DIFF:");
  });
});
describe("browser hygiene in implementer prompts (#72 → #75)", () => {
  it("is NOT injected into the implementer prompt — it belongs to the visual/goal prompts (#75)", async () => {
    // #72 added BROWSER_HYGIENE to the implementer prompt to treat the symptom
    // (implementer screenshots denied outside workspace roots). #75 removes
    // the cause: the implementer never screenshots at all — visual verification
    // is the visual review phase's job (ADR 0011), in its own subprocess with
    // its own context budget. The hygiene/scraft blocks stay exported for
    // visual.ts and goal-review.ts, which still drive browsers.
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a game",
      ticketBody: "work",
      criteria: ["c1"],
      verify: ["npm test"],
      prevFeedback: null,
    });
    expect(p).not.toMatch(/Browser hygiene/);
    expect(p).not.toMatch(/Scratch files/);
  });
});

describe("coherence-charter injection (issue #99 / ADR 0028)", () => {
  const charter = `### Visual tokens\nNEON palette from src/ui/tokens.ts.\n\n### Layout model\nCanvas 1280x800, rails either side.\n\n### Chrome rules\nOne toolbar recipe; do not introduce a competing style.`;
  const narrative = "A roguelike with oppressive atmosphere. Visual identity: desaturated palette.";

  async function implementer(opts: Record<string, unknown> = {}) {
    return buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a roguelike",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
      ...opts,
    });
  }
  async function reviewer(opts: Record<string, unknown> = {}) {
    return buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "diff --git a/src/a.ts b/src/a.ts\n+export const x = 1;",
      ...opts,
    });
  }
  async function readReviewer(opts: Record<string, unknown> = {}) {
    return buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "1 file changed",
      files: ["src/a.ts"],
      ...opts,
    });
  }

  it("implementer: a SURFACE ticket gets the charter content + pointer; the design narrative stays available", async () => {
    const p = await implementer({ designDoc: narrative, surface: true, coherenceDoc: charter });
    expect(p).toContain("Coherence contract (visual design contract");
    expect(p).toContain("HONOR IT EXACTLY");
    expect(p).toContain("do not introduce a competing style");
    expect(p).toContain("docs/coherence.md");
    expect(p).toContain("Design intent (planner's vision");
  });

  it("implementer: a NON-surface ticket carries NO charter and NO design narrative (one-line pointer at most)", async () => {
    const p = await implementer({ designDoc: narrative, surface: false, coherenceDoc: charter });
    expect(p).not.toContain("Coherence contract (visual design contract");
    expect(p).not.toContain("oppressive atmosphere");
    expect(p).not.toContain("do not introduce a competing style");
    expect(p).toContain("not classified as surface-scoped");
  });

  it("implementer: the architecture doc is NOT surface-gated (model tickets still get the module map)", async () => {
    const p = await implementer({ designDoc: narrative, architectureDoc: "Modules: engine, renderer.", surface: false });
    expect(p).toContain("Architecture intent (planner's structural plan");
    expect(p).toContain("Modules: engine, renderer.");
    expect(p).not.toContain("Design intent (planner's vision");
  });

  it("implementer: omitting the surface flag keeps the legacy behavior (narrative injected)", async () => {
    const p = await implementer({ designDoc: narrative });
    expect(p).toContain("oppressive atmosphere");
    expect(p).toContain("Design intent (planner's vision");
  });

  it("implementer: no charter content when coherenceDoc is absent", async () => {
    const p = await implementer({ surface: true, designDoc: narrative });
    expect(p).not.toContain("Coherence contract (visual design contract");
  });

  it("reviewer: a SURFACE ticket's diff is judged for chrome conformance (judge frame + content)", async () => {
    const p = await reviewer({ designDoc: narrative, surface: true, coherenceDoc: charter });
    expect(p).toContain("VERIFY CONFORMANCE");
    expect(p).toContain("do not introduce a competing style");
    expect(p).toContain("Design intent (planner's vision");
  });

  it("reviewer: a NON-surface ticket carries no charter and hides the visual narrative", async () => {
    const p = await reviewer({ designDoc: narrative, surface: false, coherenceDoc: charter });
    expect(p).not.toContain("VERIFY CONFORMANCE");
    expect(p).not.toContain("oppressive atmosphere");
    expect(p).toContain("not classified as surface-scoped");
  });

  it("read-mode reviewer: same charter + surface gating as the diff reviewer", async () => {
    const surface = await readReviewer({ designDoc: narrative, surface: true, coherenceDoc: charter });
    expect(surface).toContain("VERIFY CONFORMANCE");
    expect(surface).toContain("do not introduce a competing style");
    const nonSurface = await readReviewer({ designDoc: narrative, surface: false });
    expect(nonSurface).not.toContain("VERIFY CONFORMANCE");
    expect(nonSurface).not.toContain("oppressive atmosphere");
    expect(nonSurface).toContain("not classified as surface-scoped");
  });
});

describe("implementer vision capability injection (ADR 0036)", () => {
  it("gives a verified surface implementer the screenshot self-check", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
      surface: true,
      visionCapability: { readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(p).toContain("Vision capability (railhead-verified)");
    expect(p).toContain("capture a screenshot");
  });

  it("omits the vision block on a non-surface ticket even when measured", async () => {
    const p = await buildImplementerPrompt({
      cwd: tmp,
      ticketFile: "01-a.md",
      mission: "a build",
      ticketBody: "work",
      criteria: ["c1"],
      verify: [],
      prevFeedback: null,
      surface: false,
      visionCapability: { readsImages: true, verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(p).not.toContain("Vision capability (railhead-verified)");
  });
});
