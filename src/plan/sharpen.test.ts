import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  parseSharpenRound,
  renderQuestionForTerminal,
  renderQuestionsForTerminal,
  buildSharpenRoundPrompt,
  renderTranscriptForPlanner,
  renderPlanInterviewAnswers,
  appendContextTerms,
  nextAdrNumber,
  writeGrillAdr,
  sharpenSystemPrompt,
  depthToMaxRounds,
  DEPTH_TARGET_QUESTIONS,
  GRILL_DEPTH_OPTIONS,
  EXHAUSTIVE_BACKSTOP,
  type SharpenExchange,
  type SharpenQuestion,
  type SharpenDepth,
} from "./sharpen.ts";

describe("sharpenSystemPrompt", () => {
  it("names the topic and the exact marker-block output contract", () => {
    const p = sharpenSystemPrompt("a CLI that parses RSS feeds", "(no known contracts)", "");
    expect(p).toContain("a CLI that parses RSS feeds");
    expect(p).toContain("$TERMS");
    expect(p).toContain("$ADRS");
    expect(p).toContain("$QUESTIONS");
    expect(p).toContain("$DONE");
  });

  it("includes the existing glossary verbatim when given, and tells the model it is already decided", () => {
    const p = sharpenSystemPrompt("topic", "(none)", "**Ticket**: a unit of work.");
    expect(p).toContain("**Ticket**: a unit of work.");
    expect(p).toContain("already decided");
  });

  it("omits the glossary block and says none exists when empty", () => {
    const p = sharpenSystemPrompt("topic", "(none)", "");
    expect(p).toContain("No CONTEXT.md exists yet");
  });

  it("never uses the word 'frontier' — this repo's CONTEXT.md already defines it differently", () => {
    const p = sharpenSystemPrompt("topic", "(none)", "");
    expect(p.toLowerCase()).not.toContain("frontier");
  });

  it("ADR 0042: with a plan attached, the interview refines the existing plan and warns against re-asking decided things", () => {
    const p = sharpenSystemPrompt("a level", "(none)", "", undefined, undefined, "build", "THE PLAN: a single cave level with procedurally drawn rectangles.");
    expect(p).toContain("THE PLAN UNDER REVIEW");
    expect(p).toContain("procedurally drawn rectangles");
    expect(p).toMatch(/REFINES AN EXISTING PLAN/i);
    expect(p).toMatch(/materially CHANGE that plan/i);
    expect(p).toMatch(/Do NOT re-ask what the plan already answers/i);
    // The original goal is still named alongside the plan.
    expect(p).toContain("a level");
  });

  it("ADR 0042: without a plan it stays the pre-plan prompt-only interview", () => {
    const p = sharpenSystemPrompt("a level", "(none)", "");
    expect(p).toContain("BUILD TOPIC");
    expect(p).not.toContain("THE PLAN UNDER REVIEW");
  });
});

describe("sharpenSystemPrompt — product mode (ADR 0051)", () => {
  const ARC = "# Trail Tracker\n\n## Vision\nA hiking log.\n\n## Roadmap\n\n### 1 — MVP\n\n**Status:** todo\n\nShell + one trail.";

  it("asks the operator about the roadmap — the MVP cut, each step's outcome, and how they will test it", () => {
    const p = sharpenSystemPrompt("a hiking log", "(none)", "", undefined, undefined, "product", ARC);
    expect(p).toContain("PRODUCT ARC");
    expect(p).toContain("THE ARC UNDER REVIEW");
    expect(p).toContain("Shell + one trail.");
    expect(p).toMatch(/MVP CUT/);
    expect(p).toMatch(/morning after the run/);
  });

  it("forbids asking the operator about code structure, modules, and libraries", () => {
    const p = sharpenSystemPrompt("a hiking log", "(none)", "", undefined, undefined, "product", ARC);
    expect(p).toMatch(/Do NOT ask about code structure, module design, libraries/);
  });

  it("keeps the $TERMS/$ADRS/$QUESTIONS/$DONE contract", () => {
    const p = sharpenSystemPrompt("a hiking log", "(none)", "", undefined, undefined, "product", ARC);
    expect(p).toContain("$TERMS");
    expect(p).toContain("$ADRS");
    expect(p).toContain("$QUESTIONS");
    expect(p).toContain("$DONE");
  });
});

describe("sharpenSystemPrompt — fix mode", () => {
  it("fix mode tells the model to ask ONLY about reproduction, not implementation details", () => {
    const p = sharpenSystemPrompt("ball bounces off side walls instead of scoring", "(none)", "", undefined, undefined, "fix");
    expect(p).toContain("reproduction");
    expect(p).toMatch(/trigger|how to reproduce/i);
    expect(p).toMatch(/expected|actual|symptom/i);
  });

  it("fix mode tells the model to read the code itself, not ask the user about structure", () => {
    const p = sharpenSystemPrompt("a bug", "(none)", "", undefined, undefined, "fix");
    expect(p).toMatch(/read.*code yourself|read the code yourself|code structure yourself/i);
    expect(p).toMatch(/do not ask.*(where|locate|which file|code path|implementation)/i);
  });

  it("fix mode names the bug report as the topic", () => {
    const p = sharpenSystemPrompt("ball bounces off side walls", "(none)", "", undefined, undefined, "fix");
    expect(p).toContain("ball bounces off side walls");
  });

  it("fix mode still emits the $TERMS/$ADRS/$QUESTIONS/$DONE contract", () => {
    const p = sharpenSystemPrompt("a bug", "(none)", "", undefined, undefined, "fix");
    expect(p).toContain("$TERMS");
    expect(p).toContain("$ADRS");
    expect(p).toContain("$QUESTIONS");
    expect(p).toContain("$DONE");
  });

  it("build mode (default, no mode arg) is unchanged — contains the build-topic framing, no fix-mode reproduction language", () => {
    const p = sharpenSystemPrompt("a snake game", "(none)", "");
    expect(p).toContain("a snake game");
    expect(p).not.toMatch(/reproduction/i);
  });

  it("explicit 'build' mode matches the default prompt verbatim", () => {
    const defaultP = sharpenSystemPrompt("a snake game", "(none)", "");
    const buildP = sharpenSystemPrompt("a snake game", "(none)", "", undefined, undefined, "build");
    expect(buildP).toBe(defaultP);
  });
});

describe("parseSharpenRound", () => {
  it("parses a full round: terms, adrs, and questions, with no $DONE", () => {
    const text = `$TERMS
{"term":"Ticket","definition":"a unit of work","avoid":["task","story"]}
$ADRS
{"title":"Use SQLite","body":"Chosen for zero-ops local storage."}
$QUESTIONS
{"title":"Storage","body":"Where does state live?","recommended":"SQLite"}
{"title":"Auth","body":"Is login required?","recommended":"no"}
`;
    const round = parseSharpenRound(text);
    expect(round.terms).toEqual([{ term: "Ticket", definition: "a unit of work", avoid: ["task", "story"] }]);
    expect(round.adrs).toEqual([{ title: "Use SQLite", body: "Chosen for zero-ops local storage." }]);
    expect(round.questions).toHaveLength(2);
    expect(round.questions[0]).toEqual({ title: "Storage", body: "Where does state live?", recommended: "SQLite" });
    expect(round.done).toBe(false);
  });

  it("treats a bare $DONE with NONE sections as the finished signal", () => {
    const text = "$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\nNONE\n$DONE\n";
    const round = parseSharpenRound(text);
    expect(round.terms).toEqual([]);
    expect(round.adrs).toEqual([]);
    expect(round.questions).toEqual([]);
    expect(round.done).toBe(true);
  });

  it("treats no markers at all as done (fail-safe, never spins the loop on nothing)", () => {
    const round = parseSharpenRound("the model said something unstructured");
    expect(round.questions).toEqual([]);
    expect(round.done).toBe(true);
  });

  it("treats $QUESTIONS with real entries and no $DONE as NOT done", () => {
    const text = '$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\n{"title":"Q","body":"b","recommended":"r"}\n';
    const round = parseSharpenRound(text);
    expect(round.questions).toHaveLength(1);
    expect(round.done).toBe(false);
  });

  it("skips a malformed entry (missing required fields) without discarding valid ones", () => {
    const text = `$TERMS
{"term":"Good","definition":"fine"}
{"term":"Bad"}
$ADRS
NONE
$QUESTIONS
NONE
$DONE
`;
    const round = parseSharpenRound(text);
    expect(round.terms).toEqual([{ term: "Good", definition: "fine", avoid: undefined }]);
  });

  it("tolerates mid-block corruption (an unparseable object) and keeps the rest", () => {
    const text = `$QUESTIONS
{"title":"a","body":"first","recommended":"x"}
{ BROKEN }
{"title":"b","body":"second","recommended":"y"}
`;
    const round = parseSharpenRound(text);
    expect(round.questions.map((q) => q.title)).toEqual(["a", "b"]);
  });

  it("is order-independent: markers may appear in any order in the text", () => {
    const text = `$QUESTIONS
{"title":"Q","body":"b","recommended":"r"}
$TERMS
NONE
$ADRS
NONE
`;
    const round = parseSharpenRound(text);
    expect(round.questions).toHaveLength(1);
    expect(round.terms).toEqual([]);
  });

  it("defaults a missing 'recommended' field to an empty string rather than throwing", () => {
    const text = '$QUESTIONS\n{"title":"Q","body":"b"}\n';
    const round = parseSharpenRound(text);
    expect(round.questions[0].recommended).toBe("");
  });
});

describe("renderQuestionForTerminal", () => {
  it("numbers from the given 0-based index and renders the question only — the recommendation belongs to the answer prompt", () => {
    const q: SharpenQuestion = { title: "Storage", body: "Where does state live?", recommended: "SQLite" };
    expect(renderQuestionForTerminal(q, 0)).toBe("❓ **Q1** - **Storage**: Where does state live?");
    // The interactive prompt already shows the recommendation; the question
    // block must not repeat it.
    expect(renderQuestionForTerminal(q, 0)).not.toContain("SQLite");
    expect(renderQuestionForTerminal(q, 2)).toContain("**Q3**");
  });

  it("does not add a placeholder recommendation either", () => {
    const out = renderQuestionForTerminal({ title: "A", body: "a?", recommended: "" }, 0);
    expect(out).not.toContain("(no recommendation given)");
  });
});

describe("renderQuestionsForTerminal", () => {
  it("numbers questions and shows the recommended answer", () => {
    const qs: SharpenQuestion[] = [{ title: "Storage", body: "Where does state live?", recommended: "SQLite" }];
    const out = renderQuestionsForTerminal(qs);
    expect(out).toContain("❓ **Q1** - **Storage**: Where does state live?");
    expect(out).toContain("➡️ SQLite");
  });

  it("joins multiple questions with a rule and increments the number", () => {
    const qs: SharpenQuestion[] = [
      { title: "A", body: "a?", recommended: "x" },
      { title: "B", body: "b?", recommended: "y" },
    ];
    const out = renderQuestionsForTerminal(qs);
    expect(out).toContain("**Q1** - **A**");
    expect(out).toContain("**Q2** - **B**");
    expect(out).toContain("\n\n---\n\n");
  });

  it("shows a placeholder when no recommendation was given", () => {
    const out = renderQuestionsForTerminal([{ title: "A", body: "a?", recommended: "" }]);
    expect(out).toContain("(no recommendation given)");
  });
});

describe("buildSharpenRoundPrompt", () => {
  it("round 1 (no exchanges) says nothing has been asked yet", () => {
    const p = buildSharpenRoundPrompt("SYSTEM", []);
    expect(p).toContain("SYSTEM");
    expect(p).toContain("round 1");
  });

  it("later rounds include the prior question, its recommendation, and the user's answer verbatim", () => {
    const exchanges: SharpenExchange[] = [
      { question: { title: "Storage", body: "Where does state live?", recommended: "SQLite" }, answer: "Postgres" },
    ];
    const p = buildSharpenRoundPrompt("SYSTEM", exchanges);
    expect(p).toContain("Storage");
    expect(p).toContain("Where does state live?");
    expect(p).toContain("SQLite");
    expect(p).toContain("Postgres");
  });
});

describe("renderTranscriptForPlanner", () => {
  it("is empty when nothing was asked", () => {
    expect(renderTranscriptForPlanner([])).toBe("");
  });

  it("renders each exchange as a bullet of question title + answer", () => {
    const out = renderTranscriptForPlanner([
      { question: { title: "Storage", body: "b", recommended: "r" }, answer: "Postgres" },
    ]);
    expect(out).toContain("Storage: Postgres");
  });
});

describe("renderPlanInterviewAnswers (ADR 0042)", () => {
  it("is empty when nothing was asked", () => {
    expect(renderPlanInterviewAnswers([])).toBe("");
  });

  it("renders each answer as a decision the revised plan must honor, with the question named", () => {
    const out = renderPlanInterviewAnswers([
      { question: { title: "Boss phases", body: "How many phases?", recommended: "2" }, answer: "Two, with a telegraph before each" },
    ]);
        expect(out).toMatch(/treat each answer as a decision/i);
    expect(out).toContain("Boss phases");
    expect(out).toContain("Two, with a telegraph before each");
  });
});

describe("appendContextTerms", () => {
  async function freshCwd(): Promise<string> {
    return mkdtemp(join(tmpdir(), "sharpen-context-"));
  }

  it("is a no-op (does not even create the file) when there are no terms", async () => {
    const cwd = await freshCwd();
    await appendContextTerms(cwd, []);
    expect(existsSync(join(cwd, "CONTEXT.md"))).toBe(false);
  });

  it("lazily creates CONTEXT.md with a Language section on the first term", async () => {
    const cwd = await freshCwd();
    await appendContextTerms(cwd, [{ term: "Ticket", definition: "a unit of work", avoid: ["task"] }]);
    const content = await readFile(join(cwd, "CONTEXT.md"), "utf8");
    expect(content).toContain("## Language");
    expect(content).toContain("**Ticket**: a unit of work");
    expect(content).toContain("_Avoid_: task");
  });

  it("omits the _Avoid_ line when no avoid list is given", async () => {
    const cwd = await freshCwd();
    await appendContextTerms(cwd, [{ term: "Run", definition: "one execution" }]);
    const content = await readFile(join(cwd, "CONTEXT.md"), "utf8");
    expect(content).toContain("**Run**: one execution");
    expect(content).not.toContain("_Avoid_");
  });

  it("appends to an existing CONTEXT.md without clobbering prior content", async () => {
    const cwd = await freshCwd();
    await writeFile(join(cwd, "CONTEXT.md"), "# My Project\n\n## Language\n\n**Existing**: already here.\n", "utf8");
    await appendContextTerms(cwd, [{ term: "New", definition: "just resolved" }]);
    const content = await readFile(join(cwd, "CONTEXT.md"), "utf8");
    expect(content).toContain("**Existing**: already here.");
    expect(content).toContain("**New**: just resolved");
  });

  it("dedups by term name (case-insensitive) and does not duplicate an already-defined term", async () => {
    const cwd = await freshCwd();
    await writeFile(join(cwd, "CONTEXT.md"), "## Language\n\n**Ticket**: a unit of work.\n", "utf8");
    await appendContextTerms(cwd, [{ term: "ticket", definition: "a DIFFERENT definition" }]);
    const content = await readFile(join(cwd, "CONTEXT.md"), "utf8");
    expect(content).toContain("**Ticket**: a unit of work.");
    expect(content).not.toContain("a DIFFERENT definition");
  });

  it("still writes the other fresh terms in a batch that also contains a dup", async () => {
    const cwd = await freshCwd();
    await writeFile(join(cwd, "CONTEXT.md"), "## Language\n\n**Ticket**: a unit of work.\n", "utf8");
    await appendContextTerms(cwd, [
      { term: "Ticket", definition: "dup, should be skipped" },
      { term: "Run", definition: "brand new" },
    ]);
    const content = await readFile(join(cwd, "CONTEXT.md"), "utf8");
    expect(content).not.toContain("dup, should be skipped");
    expect(content).toContain("**Run**: brand new");
  });
});

describe("nextAdrNumber", () => {
  it("starts at 1 for an empty directory", () => {
    expect(nextAdrNumber([])).toBe(1);
  });

  it("continues the existing sequence", () => {
    expect(nextAdrNumber(["0001-a.md", "0002-b.md", "0009-i.md"])).toBe(10);
  });

  it("ignores non-numeric or unrelated filenames", () => {
    expect(nextAdrNumber(["README.md", "0003-c.md", ".DS_Store"])).toBe(4);
  });
});

describe("writeGrillAdr", () => {
  async function freshCwd(): Promise<string> {
    return mkdtemp(join(tmpdir(), "sharpen-adr-"));
  }

  it("lazily creates docs/adr/ and writes the minimal title+body template", async () => {
    const cwd = await freshCwd();
    const file = await writeGrillAdr(cwd, { title: "Use SQLite", body: "Chosen for zero-ops local storage." });
    expect(file).toBe("0001-use-sqlite.md");
    const content = await readFile(join(cwd, "docs", "adr", file), "utf8");
    expect(content).toBe("# Use SQLite\n\nChosen for zero-ops local storage.\n");
  });

  it("continues numbering from an existing docs/adr/ directory", async () => {
    const cwd = await freshCwd();
    await mkdir(join(cwd, "docs", "adr"), { recursive: true });
    await writeFile(join(cwd, "docs", "adr", "0009-visual-final-review.md"), "# x\n\ny\n", "utf8");
    const file = await writeGrillAdr(cwd, { title: "New decision", body: "Body." });
    expect(file).toBe("0010-new-decision.md");
  });

  it("slugifies the title into the filename", async () => {
    const cwd = await freshCwd();
    const file = await writeGrillAdr(cwd, { title: "A Weird Title! With Punctuation?", body: "b" });
    expect(file).toBe("0001-a-weird-title-with-punctuation.md");
  });
});

describe("depth picker (SharpenDepth)", () => {
  it("exposes exactly five levels with standard first (the recommended default)", () => {
    const depths = GRILL_DEPTH_OPTIONS.map((o) => o.depth);
    expect(depths).toEqual(["standard", "light", "deep", "exhaustive", "skip"]);
    expect(GRILL_DEPTH_OPTIONS[0].label).toContain("Recommended");
  });

  it("every option has a non-empty description that says WHY, not just what", () => {
    for (const o of GRILL_DEPTH_OPTIONS) {
      expect(o.description.trim().length).toBeGreaterThan(20);
    }
  });

  it("skip option is last, labeled 'auto-answer', and mentions silent auto-answering", () => {
    const skip = GRILL_DEPTH_OPTIONS[GRILL_DEPTH_OPTIONS.length - 1];
    expect(skip.depth).toBe("skip");
    expect(skip.label).toContain("auto-answer");
    expect(skip.description).toMatch(/silently/i);
    expect(skip.description).toMatch(/recommendation/i);
  });

  it("DEPTH_TARGET_QUESTIONS: light/standard/deep are positive numbers; exhaustive is 0 (no soft cap); skip matches standard", () => {
    expect(DEPTH_TARGET_QUESTIONS.light).toBeGreaterThan(0);
    expect(DEPTH_TARGET_QUESTIONS.standard).toBeGreaterThan(DEPTH_TARGET_QUESTIONS.light);
    expect(DEPTH_TARGET_QUESTIONS.deep).toBeGreaterThan(DEPTH_TARGET_QUESTIONS.standard);
    expect(DEPTH_TARGET_QUESTIONS.exhaustive).toBe(0);
    expect(DEPTH_TARGET_QUESTIONS.skip).toBe(DEPTH_TARGET_QUESTIONS.standard);
  });

  describe("depthToMaxRounds", () => {
    it("non-exhaustive depths honor the existing cap unchanged (maxRounds bounds rounds, not questions)", () => {
      for (const depth of ["light", "standard", "deep", "skip"] as SharpenDepth[]) {
        expect(depthToMaxRounds(depth, 6)).toBe(6);
        expect(depthToMaxRounds(depth, 12)).toBe(12);
      }
    });

    it("exhaustive raises the cap to the backstop, regardless of the small existing cap", () => {
      expect(depthToMaxRounds("exhaustive", 6)).toBe(EXHAUSTIVE_BACKSTOP);
      expect(depthToMaxRounds("exhaustive", 1)).toBe(EXHAUSTIVE_BACKSTOP);
    });

    it("exhaustive never lowers a cap already above the backstop (operator set a giant one — respect it)", () => {
      const huge = EXHAUSTIVE_BACKSTOP * 10;
      expect(depthToMaxRounds("exhaustive", huge)).toBe(huge);
    });
  });
});

describe("sharpenSystemPrompt depth wiring", () => {
  it("with a positive depthTarget, surfaces the question budget to the model", () => {
    const p = sharpenSystemPrompt("t", "(none)", "", undefined, 12);
    expect(p).toContain("roughly 12");
    expect(p).toContain("winds down");
  });

  it("with depthTarget 0 (exhaustive), says there is no question cap", () => {
    const p = sharpenSystemPrompt("t", "(none)", "", undefined, 0);
    expect(p).toContain("exhaustive");
    expect(p).toContain("no question cap");
  });

  it("with depthTarget undefined, emits no depth line at all (back-compat for callers not yet passing it)", () => {
    const p = sharpenSystemPrompt("t", "(none)", "", undefined, undefined);
    expect(p).not.toContain("question budget");
    expect(p).not.toContain("exhaustive");
  });
});

describe("sharpenSystemPrompt — active domain-modeling (#18)", () => {
  it("instructs the model to challenge prior answers that conflict with resolved terms", () => {
    const p = sharpenSystemPrompt("t", "(none)", "");
    expect(p).toMatch(/conflict/i);
    expect(p).toMatch(/challenge.*prior.*answer|prior.*answer.*conflict/i);
  });

  it("instructs the model to sharpen fuzzy answers by proposing a precise canonical term", () => {
    const p = sharpenSystemPrompt("t", "(none)", "");
    expect(p).toMatch(/fuzzy|vague|imprecise/i);
    expect(p).toMatch(/propose.*precise|precise.*canonical.*term|sharpen.*answer/i);
  });

  it("instructs the model to invent concrete edge-case scenarios to stress-test answers", () => {
    const p = sharpenSystemPrompt("t", "(none)", "");
    expect(p).toMatch(/concrete.*scenario|edge.case/i);
    expect(p).toMatch(/stress.test|probe.*boundar/i);
  });

  it("includes active domain-modeling instructions in fix mode too", () => {
    const p = sharpenSystemPrompt("a bug", "(none)", "", undefined, undefined, "fix");
    expect(p).toMatch(/conflict/i);
    expect(p).toMatch(/fuzzy|vague|imprecise/i);
    expect(p).toMatch(/concrete.*scenario|edge.case/i);
  });
});

describe("buildSharpenRoundPrompt — active domain-modeling continuation (#18)", () => {
  it("reminds the model to check prior answers against resolved terms between rounds", () => {
    const system = sharpenSystemPrompt("t", "(none)", "");
    const exchanges: SharpenExchange[] = [
      {
        question: { title: "Storage", body: "Where?", recommended: "SQLite" },
        answer: "use a database",
      },
    ];
    const prompt = buildSharpenRoundPrompt(system, exchanges);
    expect(prompt).toMatch(/conflict|contradict|consistent/i);
  });
});
