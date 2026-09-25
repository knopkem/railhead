import { describe, it, expect } from "vitest";
import { buildReviewerPrompt, buildReviewerReadModePrompt, buildContractExtractFilePrompt } from "./prompt.ts";
import { joinPhaseMessages, type PhaseMessages } from "./preamble.ts";

/** The review-phase assertions cover the effective single-message prompt.
 * Phase builders return the two-part shape (#132); these wrappers join it so
 * the long-standing content assertions keep evaluating exactly what the model
 * receives. The split itself is asserted separately below. */
const promptText = (m: PhaseMessages): string => joinPhaseMessages(m);
const reviewerText = async (o: Parameters<typeof buildReviewerPrompt>[0]) => promptText(await buildReviewerPrompt(o));
const readModeText = async (o: Parameters<typeof buildReviewerReadModePrompt>[0]) => promptText(await buildReviewerReadModePrompt(o));
const fileContractsText = (file: string, content: string) => promptText(buildContractExtractFilePrompt(file, content));

const tmp = "/tmp";

describe("buildReviewerPrompt", () => {
  it("judges repo-wide criteria from the diff alone (the seat has no search or command tools)", async () => {
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["grep finds no hex color literals outside src/ui/theme.rs"],
      diff: "d",
    });
    expect(p).toMatch(/repo-wide check you cannot run/);
    expect(p).toMatch(/judged from the diff alone/);
    expect(p).toMatch(/If the diff is consistent with the criterion, treat it as met/);
    expect(p).toMatch(/no substitute tool family is available/);
  });

  it("treats ACs that name a third-party artifact as unverified plan claims: judge capability, never double-down on the name", async () => {
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toContain("Do NOT raise test quality as a blocking finding");
    expect(p).toContain("test-thoroughness opinions, not correctness issues");
  });

  it("includes the contracts slice so the reviewer can check signatures against real ground truth", async () => {
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toContain("Project learnings");
  });

  it("forbids reporting compile/build/typecheck failures since the railhead runs verify (#1)", async () => {
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/do not report.*compile/i);
    expect(p).toMatch(/railhead runs.*verify/i);
  });

  it("tells the reviewer to ignore tool-generated artifacts and judge only source code", async () => {
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/tool-generated artifacts/i);
    expect(p).toMatch(/source code changes/i);
  });

  it("checks for leftover [DEBUG-...] logs when fixMode is true (#6)", async () => {
    const p = await reviewerText({
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
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toContain("[DEBUG-");
    expect(p).not.toMatch(/debug instrumentation/i);
  });

  it("includes the 7 Fowler code smells as a positive checklist (#10)", async () => {
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).toMatch(/ADVISORY \(\$NITS\)/);
    expect(p).not.toMatch(/NIT: anything that only touches code quality or polish — never report these/);
  });

  it("does not include the 5 deferred smells in the prompt (#10)", async () => {
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
    });
    expect(p).not.toMatch(/pre.*review.*lint|lint.*finding/i);
  });

  it("omits the lint block when lint output is empty string (#41)", async () => {
    const p = await reviewerText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "d",
      lintOutput: "",
    });
    expect(p).not.toMatch(/pre.*review.*lint|lint.*finding/i);
  });

  it("hands the diff as a file path + stat instead of inlining the body when diffFile is set (#46)", async () => {
    const diff = "diff --git a/src/index.ts b/src/index.ts\n+export const x = 1;";
    const p = await reviewerText({
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
    const p = await reviewerText({
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
    const p = await reviewerText({
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

describe("buildReviewerReadModePrompt", () => {
  it("judges repo-wide criteria from the listed files alone (no search or command tools in read-mode either)", async () => {
    const p = await readModeText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["grep finds no hex color literals outside src/ui/theme.rs"],
      stat: "stat",
      files: ["src/ui/theme.rs"],
    });
    expect(p).toMatch(/repo-wide check you cannot run/);
    expect(p).toMatch(/judged from the files this prompt lists/);
    expect(p).toMatch(/If those files are consistent with the criterion, treat it as met/);
  });

  it("instructs the reviewer to read the touched files", async () => {
    const p = await readModeText({
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
    const p = await readModeText({
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
    const p = await readModeText({
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
    const p = await readModeText({
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
    const p = await readModeText({
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
    const p = await readModeText({
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
    const p = await readModeText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
    });
    expect(p).toMatch(/do not report.*compile/i);
  });

  it("lists multiple files for the reviewer to read", async () => {
    const p = await readModeText({
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
    const p = await readModeText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat,
      files: ["src/index.ts"],
    });
    expect(p).toContain("src/index.ts | 3 +++");
  });

  it("checks for [DEBUG-...] logs when fixMode is true", async () => {
    const p = await readModeText({
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
    const p = await readModeText({
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
    const p = await readModeText({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "stat",
      files: ["src/a.ts"],
    });
    expect(p).not.toContain("Design intent (planner's vision");
    expect(p).not.toContain("Architecture intent (planner's structural plan");
  });
});

describe("buildContractExtractFilePrompt", () => {
  it("includes the file name in the prompt", () => {
    const p = fileContractsText("src/shader.wgsl", "fn vertex_shader() {}");
    expect(p).toContain("src/shader.wgsl");
  });

  it("includes the file content as SOURCE", () => {
    const content = "export function createPlayer() { return { x: 0, y: 0 }; }";
    const p = fileContractsText("src/player.ts", content);
    expect(p).toContain("SOURCE:");
    expect(p).toContain(content);
  });

  it("emits the $CONTRACTS block with the file path pre-filled in the example", () => {
    const p = fileContractsText("src/utils.ts", "export const PI = 3.14;");
    expect(p).toContain("$CONTRACTS");
    expect(p).toContain("$END");
    expect(p).toContain('"file":"src/utils.ts"');
  });

  it("does NOT include a DIFF section (per-file, not per-diff #28)", () => {
    const p = fileContractsText("src/a.ts", "export const x = 1;");
    expect(p).not.toContain("DIFF:");
  });
});
describe("coherence-charter injection (issue #99 / ADR 0028)", () => {
  const charter = `### Visual tokens\nNEON palette from src/ui/tokens.ts.\n\n### Layout model\nCanvas 1280x800, rails either side.\n\n### Chrome rules\nOne toolbar recipe; do not introduce a competing style.`;
  const narrative = "A roguelike with oppressive atmosphere. Visual identity: desaturated palette.";

  async function reviewer(opts: Record<string, unknown> = {}) {
    return promptText(await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "diff --git a/src/a.ts b/src/a.ts\n+export const x = 1;",
      ...opts,
    }));
  }
  async function readReviewer(opts: Record<string, unknown> = {}) {
    return promptText(await buildReviewerReadModePrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      stat: "1 file changed",
      files: ["src/a.ts"],
      ...opts,
    }));
  }

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

describe("two-part phase prompts (#132 — canonical preamble + volatile task)", () => {
  it("reviewer: stable docs ride the preamble; diff and findings ride the task", async () => {
    const m = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "diff --git a/src/a.ts b/src/a.ts\n+export const x = 1;",
      priorFindings: ["[MAJOR] missing null guard"],
      designDoc: "Narrative",
      architectureDoc: "Modules: a, b.",
      coherenceDoc: "Visual tokens: NEON.",
      surface: true,
    });
    expect(m.preamble).toContain("Narrative");
    expect(m.preamble).toContain("Modules: a, b.");
    expect(m.preamble).toContain("Visual tokens: NEON.");
    expect(m.preamble).not.toContain("missing null guard");
    expect(m.preamble).not.toContain("x = 1");
    expect(m.task).toContain("missing null guard");
    expect(m.task).toContain("x = 1");
    expect(m.task).toContain("VERIFY CONFORMANCE");
    expect(m.task).not.toContain("Visual tokens: NEON.");
  });

  it("reviewer: a NON-surface ticket's preamble carries neither narrative nor charter", async () => {
    const m = await buildReviewerPrompt({
      ticketFile: "01-a.md",
      ticketBody: "work",
      criteria: ["c1"],
      diff: "diff",
      designDoc: "Narrative",
      coherenceDoc: "Visual tokens: NEON.",
      architectureDoc: "Modules: a, b.",
      surface: false,
    });
    expect(m.preamble).toContain("Modules: a, b.");
    expect(m.preamble).not.toContain("Narrative");
    expect(m.preamble).not.toContain("Visual tokens: NEON.");
    expect(m.task).toContain("not classified as surface-scoped");
  });
});
