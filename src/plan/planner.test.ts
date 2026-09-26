import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendEvent } from "../core/ledger.ts";

// planner.ts drives every model round through ONE seam: executeOpendCode.
// Mocking that single function (real opencode subprocess runs are integration,
// not unit, tests — see AGENTS.md) lets everything else — the ledger,
// CONTEXT.md writes, ADR numbering, round bookkeeping — run for real, the same
// technique run.test.ts already uses for the implement/verify/review loop.
vi.mock("../execute/executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execute/executor.ts")>();
  return { ...actual, executeOpendCode: vi.fn() };
});

import { executeOpendCode } from "../execute/executor.ts";
import { runPlan, runSharpenSession, maybeGenerateAgentsMd, runProductSession, deriveFeaturePrompt } from "./planner.ts";
import { writeProductPlan, renderProductPlan, type ProductPlan } from "../core/product.ts";
import { writeProjectDoc, readProjectDoc } from "../core/git.ts";
import { CHARTER_DOC } from "../context/coherence.ts";
import type { Ticket } from "../core/ticket.ts";
import type { SharpenQuestion } from "./sharpen.ts";

const mockExec = vi.mocked(executeOpendCode);

beforeEach(() => {
  mockExec.mockReset();
});

async function freshCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sharpen-session-"));
}

async function emitText(ledgerDir: string, phaseFile: string, text: string): Promise<void> {
  await appendEvent(ledgerDir, phaseFile, JSON.stringify({ type: "text", part: { type: "text", text } }));
}

/** The design stage's output shape: $VERIFY/$INTERFACE/$SMOKE/$DESIGN/$ARCHITECTURE. */
function planPayload(opts: { verify?: string; smoke?: string; iface?: string; design?: string; architecture?: string } = {}): string {
  const lines = ["$VERIFY", opts.verify ?? "cargo build"];
  if (opts.iface) lines.push("$INTERFACE", opts.iface);
  lines.push("$SMOKE", opts.smoke ?? "cargo run");
  lines.push("$DESIGN", opts.design ?? "A design.", "$END");
  lines.push("$ARCHITECTURE", opts.architecture ?? "Modules: engine, renderer.", "$END");
  return lines.join("\n") + "\n";
}

/** Emit the transcript for whichever planner phase the mocked executor is on.
 * Planning is two calls: the payload's design portion answers the design stage
 * (phase `plan`), and the array after its $TICKETS marker answers the
 * decomposition stage. `tickets`/`revise`/`continuation` override either. */
const DEFAULT_TICKETS = '[{"title":"Shell","what":"stand up the shell","criteria":["the shell builds and runs"],"group":"core"}]';

async function emitStaged(
  options: { ledgerDir: string; phaseFile: string },
  payload: string | { plan?: string; tickets?: string; continuation?: string; revise?: string; gate?: string; replanTickets?: string },
): Promise<void> {
  const p = typeof payload === "string" ? { plan: payload } : payload;
  const phase = options.phaseFile;
  const designOf = (text: string): string => {
    const idx = text.search(/\$TICKETS\b/i);
    return idx >= 0 ? text.slice(0, idx).trimEnd() : text;
  };
  const ticketsOf = (text: string): string => {
    const idx = text.search(/\$TICKETS\b/i);
    return idx >= 0 ? text.slice(idx + "$TICKETS".length).trim() : "";
  };
  if (/^plan-gate/.test(phase)) {
    return emitText(options.ledgerDir, phase, p.gate ?? "$PLAN_PASS\n$END\n");
  }
  if (/^plan-replan/.test(phase)) {
    const tickets = p.replanTickets ?? DEFAULT_TICKETS;
    return emitText(options.ledgerDir, phase, /^\s*\$TICKETS\b/.test(tickets) ? tickets : `$TICKETS\n${tickets}\n`);
  }
  if (phase.startsWith("plan-revise")) {
    return emitText(options.ledgerDir, phase, p.revise ?? p.plan ?? planPayload());
  }
  if (phase === "plan-tickets-continue") {
    return emitText(options.ledgerDir, phase, p.continuation ?? `$TICKETS\n${DEFAULT_TICKETS}\n`);
  }
  if (phase === "plan-tickets") {
    const tickets = p.tickets ?? ((p.plan ? ticketsOf(p.plan) : "") || DEFAULT_TICKETS);
    return emitText(options.ledgerDir, phase, /^\s*\$TICKETS\b/.test(tickets) ? tickets : `$TICKETS\n${tickets}\n`);
  }
  return emitText(options.ledgerDir, phase, p.plan ? designOf(p.plan) : planPayload());
}

function okResult() {
  return { status: "ok" as const, code: 0, signal: null, durationMs: 1, steps: 1, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls: 1, errorMessage: null };
}

function transientResult() {
  return { status: "transient" as const, code: 0, signal: null, durationMs: 1, steps: 0, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls: 0, errorMessage: "model produced 0 tokens (connection or provider failure)" };
}

describe("runSharpenSession", () => {
  it("asks one round of questions, records the answer, then stops on $DONE", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      if (call === 1) {
        await emitStaged(options, '$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\n{"title":"Storage","body":"Where does state live?","recommended":"SQLite"}\n',
        );
      } else {
        await emitStaged(options, '$TERMS\n{"term":"Ledger","definition":"the durable run record","avoid":["log"]}\n$ADRS\nNONE\n$QUESTIONS\nNONE\n$DONE\n',
        );
      }
      return okResult();
    });

    const asked: SharpenQuestion[] = [];
    const result = await runSharpenSession({
      cwd,
      topic: "a CLI tool",
      model: null,
      maxRounds: 5,
      ask: async (q) => {
        asked.push(q);
        return "yes, SQLite";
      },
    });

    expect(call).toBe(2);
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toBe("Storage");
    expect(result.rounds).toBe(2);
    expect(result.exchanges).toHaveLength(1);
    expect(result.transcript).toContain("Storage");
    expect(result.transcript).toContain("yes, SQLite");

    const context = await readFile(join(cwd, "CONTEXT.md"), "utf8");
    expect(context).toContain("**Ledger**: the durable run record");
    expect(context).toContain("_Avoid_: log");
  });

  it("stops immediately when the first round is already done, asking nothing", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\nNONE\n$DONE\n");
      return okResult();
    });
    const ask = vi.fn(async () => "unused");
    const result = await runSharpenSession({ cwd, topic: "a small tool", model: null, maxRounds: 5, ask });
    expect(ask).not.toHaveBeenCalled();
    expect(result.rounds).toBe(1);
    expect(result.exchanges).toEqual([]);
    expect(result.transcript).toBe("");
    expect(existsSync(join(cwd, "CONTEXT.md"))).toBe(false);
  });

  it("stops at maxRounds even if the model never emits $DONE", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, '$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\n{"title":"Q","body":"keep going?","recommended":"yes"}\n',
      );
      return okResult();
    });
    const result = await runSharpenSession({
      cwd,
      topic: "t",
      model: null,
      maxRounds: 3,
      ask: async () => "sure",
    });
    expect(result.rounds).toBe(3);
    expect(result.exchanges).toHaveLength(3);
  });

  it("never calls opencode at all when maxRounds is 0", async () => {
    const cwd = await freshCwd();
    const result = await runSharpenSession({ cwd, topic: "t", model: null, maxRounds: 0, ask: async () => "x" });
    expect(mockExec).not.toHaveBeenCalled();
    expect(result.rounds).toBe(0);
    expect(result.transcript).toBe("");
  });

  it("feeds prior answers into later rounds' prompts", async () => {
    const cwd = await freshCwd();
    const prompts: string[] = [];
    let call = 0;
    mockExec.mockImplementation(async (prompt, options) => {
      call++;
      prompts.push(prompt);
      if (call === 1) {
        await emitStaged(options, '$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\n{"title":"Database","body":"which one?","recommended":"sqlite"}\n',
        );
      } else {
        await emitStaged(options, "$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\nNONE\n$DONE\n");
      }
      return okResult();
    });
    await runSharpenSession({ cwd, topic: "t", model: null, maxRounds: 5, ask: async () => "postgres, not sqlite" });
    expect(prompts[1]).toContain("postgres, not sqlite");
    expect(prompts[1]).toContain("Database");
  });

  it("writes a resolved ADR to docs/adr/, continuing the existing numbering", async () => {
    const cwd = await freshCwd();
    await mkdir(join(cwd, "docs", "adr"), { recursive: true });
    await writeFile(join(cwd, "docs", "adr", "0001-existing.md"), "# Existing\n\nAlready here.\n", "utf8");
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, '$TERMS\nNONE\n$ADRS\n{"title":"Use SQLite","body":"Chosen for zero-ops local storage."}\n$QUESTIONS\nNONE\n$DONE\n',
      );
      return okResult();
    });
    await runSharpenSession({ cwd, topic: "t", model: null, maxRounds: 3, ask: async () => "n/a" });
    expect(existsSync(join(cwd, "docs", "adr", "0002-use-sqlite.md"))).toBe(true);
  });

  it("stops gracefully (keeping prior exchanges) when a round's opencode call fails", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      if (call === 1) {
        await emitStaged(options, '$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\n{"title":"Q1","body":"first?","recommended":"a"}\n',
        );
        return okResult();
      }
      return { status: "error" as const, code: 1, signal: null, durationMs: 1, steps: 1, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls: 0, errorMessage: "boom" };
    });
    const result = await runSharpenSession({ cwd, topic: "t", model: null, maxRounds: 5, ask: async () => "answer" });
    expect(result.rounds).toBe(2);
    expect(result.exchanges).toHaveLength(1);
  });

  it("renders each question to onQuestion before its answer is collected, one at a time (so Q2 is rendered only after Q1 is answered)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, '$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\n{"title":"Storage","body":"Where?","recommended":"SQLite"}\n{"title":"Backend","body":"which?","recommended":"none"}\n',
      );
      return okResult();
    });
    // Track interleaving: a render of Q2 must NOT happen before Q1's answer is
    // collected. A whole-round render (all questions at once) would push both
    // rendered strings onto the list before any answer arrives.
    const order: string[] = [];
    const answers: Record<string, string> = { Storage: "sqlite", Backend: "none" };
    await runSharpenSession({
      cwd,
      topic: "t",
      model: null,
      maxRounds: 1,
      ask: async (q) => {
        order.push(`answer:${q.title}`);
        return answers[q.title] ?? "x";
      },
      onQuestion: (q, rendered) => {
        order.push(`render:${q.title}`);
        expect(rendered).toContain(q.title);
        expect(rendered).toContain("❓");
      },
    });
    expect(order).toEqual(["render:Storage", "answer:Storage", "render:Backend", "answer:Backend"]);
  });

  it("skip mode: auto-answers with the model's recommendation when onQuestion is absent (CLI skip depth)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, '$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\n{"title":"Storage","body":"Where?","recommended":"SQLite"}\n{"title":"Backend","body":"which?","recommended":"none"}\n',
      );
      return okResult();
    });
    // Simulate the CLI's skip path: ask returns the recommendation, onQuestion
    // is undefined (no terminal printing).
    const result = await runSharpenSession({
      cwd,
      topic: "t",
      model: null,
      maxRounds: 1,
      ask: (q) => Promise.resolve(q.recommended || ""),
    });
    expect(result.exchanges).toHaveLength(2);
    expect(result.exchanges[0].answer).toBe("SQLite");
    expect(result.exchanges[1].answer).toBe("none");
    expect(result.transcript).toContain("Storage: SQLite");
    expect(result.transcript).toContain("Backend: none");
  });

  it("fix mode passes the mode into sharpenSystemPrompt (the prompt contains reproduction/language, not build-topic)", async () => {
    const cwd = await freshCwd();
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      await emitStaged(options, "$TERMS\nNONE\n$ADRS\nNONE\n$QUESTIONS\nNONE\n$DONE\n");
      return okResult();
    });
    await runSharpenSession({
      cwd,
      topic: "ball bounces off the side walls",
      model: null,
      maxRounds: 1,
      mode: "fix",
      ask: async () => "unused",
    });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("ball bounces off the side walls");
    expect(prompts[0]).toMatch(/reproduction/i);
    expect(prompts[0]).toMatch(/trigger|symptom|expected/i);
  });
});


describe("runPlan — two-call planning (design -> tickets)", () => {
  it("runs the design stage then the decomposition stage, and writes ordered tickets + PLAN.md from the design docs", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\nGoal: a greetable CLI.\n$END\n$ARCHITECTURE\nModules: greet, cli.\n$END\n$TICKETS\n[{\"title\":\"Scaffold\",\"what\":\"scaffold\",\"criteria\":[\"cargo build passes\"],\"group\":\"core\"},{\"title\":\"Greet\",\"what\":\"greet\",\"criteria\":[\"greet returns hello\"],\"group\":\"core\"}]\n");
      return okResult();
    });
    const { readProjectDoc } = await import("../core/git.ts");
    const result = await runPlan({ cwd, prompt: "a greetable CLI", model: null });
    expect(phases).toEqual(["plan", "plan-tickets"]);
    expect(result.tickets.map((t) => t.title)).toEqual(["Scaffold", "Greet"]);
    expect(result.tickets.map((t) => t.file)).toEqual(["01-scaffold.md", "02-greet.md"]);
    expect(result.designDoc).toContain("Goal: a greetable CLI.");
    expect(result.architectureDoc).toContain("Modules: greet, cli.");
    const planMd = await readProjectDoc(cwd, "PLAN.md");
    expect(planMd).toContain("Goal: a greetable CLI.");
    expect(planMd).toContain("## Ticket plan (2 tickets)");
    // No model audit ran.
    expect(phases.some((p) => p.startsWith("plan-check"))).toBe(false);
  });

  it("feature mode: the stage prompts carry the product arc and the held charter, and never the scaffold rule", async () => {
    const cwd = await freshCwd();
    await writeProductPlan(cwd, {
      name: "Trail Tracker",
      vision: "TRAIL_VISION_MARKER — a hiking log.",
      workflows: "plan and record hikes.",
      traits: "offline first.",
      stack: "TRAIL_STACK_MARKER — plain ESM, no framework.",
      steps: [{ number: 1, title: "MVP shell", status: "done", description: "shell", runId: null, feedback: null }],
    });
    await writeProjectDoc(cwd, CHARTER_DOC, "HELD_CHARTER_MARKER: tokens.");
    const prompts: string[] = [];
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      prompts.push(_prompt);
      phases.push(options.phaseFile);
      await emitStaged(options, "$VERIFY\nnpm test\n$SMOKE\n./run\n$DESIGN\nGoal: search.\n$END\n$ARCHITECTURE\nModules: searchbox.\n$END\n$TICKETS\n[{\"title\":\"Search box\",\"what\":\"type to filter\",\"criteria\":[\"results filter as you type\"],\"group\":\"search\"}]\n");
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "add search", model: null, mode: "feature", artDirection: false });
    expect(phases).toEqual(["plan", "plan-tickets"]);
    // A feature plan with a test stack in its verify list also gets the
    // final hardener ticket — the suite grows with each confirmed feature.
    expect(result.tickets.map((t) => t.title)).toEqual(["Search box", "Harden: transcribe confirmed behaviors into the test suite"]);
    // Feature plan docs live in the .scratch namespace (ADR 0051) — the
    // project root docs are untouched.
    expect(result.planPath).toContain(join(".scratch", "add-search", "PLAN.md"));
    expect(await readProjectDoc(cwd, join(".scratch", "add-search", "docs", "design.md"))).toContain("Goal: search.");
    expect(await readProjectDoc(cwd, join(".scratch", "add-search", "docs", "architecture.md"))).toContain("searchbox");
    expect(await readProjectDoc(cwd, "docs/design.md")).toBeNull();
    const [designPrompt, ticketsPrompt] = prompts;
    expect(designPrompt).toContain("TRAIL_VISION_MARKER");
    expect(designPrompt).toContain("TRAIL_STACK_MARKER");
    expect(designPrompt).toContain("HELD_CHARTER_MARKER");
    expect(designPrompt).toMatch(/EXISTING product/);
    expect(designPrompt).toMatch(/not yet indexed/);
    expect(ticketsPrompt).toMatch(/FIRST ticket is an INTEGRATION slice/);
    expect(ticketsPrompt).not.toMatch(/stand up a buildable scaffold/);
  });

  it("asks for the REMAINING tickets once when the decomposition output is truncated", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      if (options.phaseFile === "plan-tickets") {
        // Two complete tickets plus a half-written third (the truncation shape).
        await emitText(options.ledgerDir, options.phaseFile,
          '$TICKETS\n[{"title":"One","what":"one","criteria":["c1"]},{"title":"Two","what":"two","criteria":["c2"]},{"title":"Three","what":"thr');
      } else if (options.phaseFile === "plan-tickets-continue") {
        await emitText(options.ledgerDir, options.phaseFile, '$TICKETS\n[{"title":"Three","what":"three","criteria":["c3"]}]');
      } else {
        await emitStaged(options, planPayload());
      }
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "an app", model: null });
    expect(phases).toContain("plan-tickets-continue");
    expect(result.tickets.map((t) => t.title)).toEqual(["One", "Two", "Three"]);
  });

  // ADR 0051: the guiding process's two sessions — the arc condense and the
  // roadmap-step → feature-prompt derivation.
  const ARC: ProductPlan = {
    name: "Trail Tracker",
    vision: "A hiking log.",
    workflows: "plan, record, browse.",
    traits: "offline.",
    stack: "plain ESM, no framework.",
    steps: [
      { number: 1, title: "MVP shell", status: "done", description: "shell", runId: null, feedback: null },
      { number: 2, title: "Search", status: "todo", description: "Search trails.", runId: null, feedback: null },
    ],
  };

  it("runProductSession condenses the operator's input into a plan and never writes on its own", async () => {
    const cwd = await freshCwd();
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      await emitStaged(options, "$PRODUCT\n# Trail Tracker\n\n## Vision\nA hiking log.\n\n## Roadmap\n\n### 1 — MVP\n\n**Status:** todo\n\nShell + one trail.\n$END\n");
      return okResult();
    });
    const plan = await runProductSession({ cwd, instruction: "a hiking log for the family", model: null });
    expect(plan.name).toBe("Trail Tracker");
    expect(plan.steps[0].title).toBe("MVP");
    expect(plan.steps[0].status).toBe("todo");
    expect(prompts[0]).toContain("a hiking log for the family");
    // The session never persists: adoption is the CLI's explicit act.
    expect(await readProjectDoc(cwd, "docs/product.md")).toBeNull();
  });

  it("runProductSession steers an existing arc — the current arc rides the prompt", async () => {
    const cwd = await freshCwd();
    await writeProductPlan(cwd, ARC);
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      await emitStaged(options, `$PRODUCT\n${renderProductPlan(ARC)}\n$END\n`);
      return okResult();
    });
    await runProductSession({ cwd, instruction: "drop the search step", model: null });
    expect(prompts[0]).toContain("Trail Tracker");
    expect(prompts[0]).toContain("MVP shell");
  });

  it("rejects a product session reply without a $PRODUCT block instead of writing an empty arc", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitText(options.ledgerDir, options.phaseFile, "I thought about it and here is some prose.");
      return okResult();
    });
    await expect(runProductSession({ cwd, instruction: "a thing", model: null })).rejects.toThrow(/no readable \$PRODUCT/);
  });

  it("deriveFeaturePrompt returns the derived prompt with the step, feedback, and roadmap folded in", async () => {
    const cwd = await freshCwd();
    const plan = { ...ARC, steps: [ARC.steps[0], { ...ARC.steps[1], feedback: "Must hit Enter to submit." }] };
    await writeProductPlan(cwd, plan);
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      await emitText(options.ledgerDir, options.phaseFile, "$FEATURE_PROMPT\nImplement search: reuse the app shell, filter as you type.\n$END\n");
      return okResult();
    });
    const derived = await deriveFeaturePrompt({ cwd, step: plan.steps[1], plan, model: null });
    expect(derived).toContain("reuse the app shell");
    expect(prompts[0]).toContain("Search trails.");
    expect(prompts[0]).toContain("Must hit Enter to submit.");
    expect(prompts[0]).toContain("1 — MVP shell [done]");
    expect(prompts[0]).toContain("2 — Search [todo]");
  });

  it("deriveFeaturePrompt falls back to the whole reply when the marker is missing", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitText(options.ledgerDir, options.phaseFile, "Plain prompt without markers.");
      return okResult();
    });
    expect(await deriveFeaturePrompt({ cwd, step: ARC.steps[1], plan: ARC, model: null })).toBe("Plain prompt without markers.");
  });

  it("rejects a decomposition whose ticket carries no acceptance criteria", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, { tickets: '[{"title":"Blank","what":"work without a check"}]' });
      return okResult();
    });
    await expect(runPlan({ cwd, prompt: "an app", model: null })).rejects.toThrow(/acceptance criteria/);
  });

  it("accepts a criterion carrying an indented probe recipe and writes it to disk", async () => {
    const cwd = await freshCwd();
    const criterion = "the board shows a 3x3 grid";
    const probe = "launch the app; click New game; assert 9 cells are visible";
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, {
        tickets: JSON.stringify([{ title: "Board", what: "render the board", criteria: [`${criterion}\n  probe: ${probe}`] }]),
      });
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "a game", model: null, artDirection: false });
    expect(result.tickets[0]!.criteria).toEqual([`${criterion}\n  probe: ${probe}`]);
    const { parseTicket } = await import("../core/ticket.ts");
    const onDisk = await parseTicket(join(cwd, ".scratch", "a-game", "issues"), result.tickets[0]!.file);
    expect(onDisk.criteria).toEqual([`${criterion}\n  probe: ${probe}`]);
  });

  it("accepts a legacy '(test)' criterion as a plain behaviour", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, { tickets: '[{"title":"Lib","what":"export greet","criteria":["greet(\\"x\\") returns a string (test)"]}]' });
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "a library", model: null, artDirection: false });
    expect(result.tickets[0]!.criteria).toEqual(['greet("x") returns a string (test)']);
  });

  it("runs the plan gate after decomposition and returns the plan when the goal seat passes", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, planPayload());
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "an app", model: null, goalModel: null, artDirection: false });
    expect(result.tickets.map((t) => t.title)).toEqual(["Shell"]);
    expect(phases).toEqual(["plan", "plan-tickets"]);
  });

  it("runs the plan gate when a goal seat is configured (no reviewPlan), then passes", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, planPayload());
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "an app", model: null, goalModel: "some/model", artDirection: false });
    expect(phases).toEqual(["plan", "plan-tickets", "plan-gate-0"]);
    expect(result.tickets.map((t) => t.title)).toEqual(["Shell"]);
  });

  it("regenerates the frontier when the plan gate finds a scope gap", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    const revised = '[{"title":"Audio","what":"add the sound engine","criteria":["a tone plays on hit"],"group":"core"}]';
    let gateCalls = 0;
    mockExec.mockImplementation(async (prompt, options) => {
      phases.push(options.phaseFile);
      if (options.phaseFile.startsWith("plan-gate")) {
        gateCalls++;
        await emitText(options.ledgerDir, options.phaseFile,
          gateCalls === 1
            ? "$PLAN_FAIL\n[GAP] sound → no ticket owns audio\n$END\n$REPLAN\n$END\n"
            : "$PLAN_PASS\n$END\n");
        return okResult();
      }
      if (options.phaseFile.startsWith("plan-replan")) {
        expect(prompt).toContain("[GAP] sound");
        await emitStaged(options, { replanTickets: revised });
        return okResult();
      }
      await emitStaged(options, planPayload());
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "an app with sound", model: null, goalModel: "some/model", artDirection: false });
    expect(phases).toEqual(["plan", "plan-tickets", "plan-gate-0", "plan-replan-1", "plan-gate-1"]);
    expect(result.tickets.map((t) => t.title)).toEqual(["Audio"]);
  });

  it("rejects the plan when the gate still finds gaps at the max_replans cap", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.startsWith("plan-gate")) {
        await emitText(options.ledgerDir, options.phaseFile, "$PLAN_FAIL\n[GAP] no owner for the level editor\n$END\n");
        return okResult();
      }
      await emitStaged(options, planPayload());
      return okResult();
    });
    await expect(
      runPlan({ cwd, prompt: "an app", model: null, goalModel: "some/model", maxReplans: 1, artDirection: false }),
    ).rejects.toThrow(/plan gate rejected the plan after 1 revision/);
  });

  it("appends a standard open-ended art ticket when a rendered surface has none", async () => {
    const cwd = await freshCwd();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockExec.mockImplementation(async (_prompt, options) => {
        await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\ncanvas\n$SMOKE\nnpm run dev\n$DESIGN\nGoal: a game.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Engine\",\"what\":\"engine\",\"criteria\":[\"tick advances\"],\"group\":\"core\"}]\n");
        return okResult();
      });
      const result = await runPlan({ cwd, prompt: "a canvas game", model: null });
      const art = result.tickets.find((t) => t.open_ended === true);
      expect(art).toBeDefined();
      expect(art!.title).toMatch(/Craft the rendered look/);
      expect(warn.mock.calls.join("\n")).toContain("open-ended craft ticket");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not append an art ticket when the planner emitted one, or when art direction is disabled", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, { tickets: '[{"title":"Art","what":"craft the look","criteria":[],"open_ended":true,"group":"polish"}]' });
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "a canvas game", model: null, artDirection: false });
    expect(result.tickets.filter((t) => t.open_ended === true)).toHaveLength(1);
  });

  it("fix mode is one call: no decomposition stage, no PLAN.md", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      // Fix mode emits verify/smoke/design/architecture AND the ticket array in
      // the ONE call.
      await emitText(options.ledgerDir, options.phaseFile, "$VERIFY\ncargo test\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Fix crash\",\"what\":\"fix\",\"criteria\":[\"the reported sequence no longer crashes\"]}]\n");
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "bug", model: null, mode: "fix" });
    expect(phases).toEqual(["plan"]);
    expect(result.planPath).toBeNull();
    expect(result.tickets[0]!.title).toBe("Fix crash");
  });

  it("interviewPlan (ADR 0042): answers revise the plan before decomposition", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, {
        plan: planPayload({ design: "Original design." }),
        revise: planPayload({ design: "Interview-revised design." }),
      });
      return okResult();
    });
    const { readProjectDoc } = await import("../core/git.ts");
    let seenPlan = "";
    const result = await runPlan({
      cwd,
      prompt: "an app",
      model: null,
      interviewPlan: async (planText) => {
        seenPlan = planText;
        return "The user answered a planning interview.\n- Q: Art — A: procedural sprites";
      },
    });
    expect(seenPlan).toContain("Original design.");
    expect(phases).toContain("plan-revise-interview-1");
    expect(result.designDoc).toContain("Interview-revised design.");
    expect(await readProjectDoc(cwd, "PLAN.md")).toContain("Interview-revised design.");
  });
});

describe("runPlan — interactive plan review (ADR 0041)", () => {
  it("reviews PLAN.md before tickets exist, revises on feedback, and decomposes once accepted", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, {
        plan: planPayload({ design: "Original design." }),
        revise: planPayload({ design: "Revised per user feedback." }),
      });
      return okResult();
    });
    const { readProjectDoc } = await import("../core/git.ts");
    const feedbacks = ["Add a settings screen", ""];
    let asked = 0;
    const atReview: string[] = [];
    const result = await runPlan({
      cwd,
      prompt: "an app",
      model: null,
      reviewPlan: async ({ planPath }) => {
        expect(planPath).toContain("PLAN.md");
        atReview.push((await readProjectDoc(cwd, "PLAN.md")) ?? "");
        return feedbacks[asked++] ?? null;
      },
    });
    expect(phases.filter((p) => p.startsWith("plan-revise-user"))).toHaveLength(1);
    expect(phases.filter((p) => p === "plan-tickets")).toHaveLength(1);
    expect(asked).toBe(2);
    expect(atReview[0]).toContain("Original design.");
    expect(atReview[0]).not.toContain("## Ticket plan");
    expect(atReview[1]).toContain("Revised per user feedback.");
    expect(atReview[1]).not.toContain("## Ticket plan");
    expect(result.designDoc).toContain("Revised per user feedback.");
    const planMd = await readProjectDoc(cwd, "PLAN.md");
    expect(planMd).toContain("Revised per user feedback.");
    expect(planMd).toContain("## Ticket plan");
  });
});

describe("runPlan — design and architecture docs (#34)", () => {
  it("writes docs/design.md and docs/architecture.md when the planner emits the blocks", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, planPayload({ design: "The design narrative.", architecture: "Modules: engine, renderer." }));
      return okResult();
    });
    const { readProjectDoc } = await import("../core/git.ts");
    await runPlan({ cwd, prompt: "an app", model: null });
    expect(await readProjectDoc(cwd, "docs/design.md")).toContain("The design narrative.");
    expect(await readProjectDoc(cwd, "docs/architecture.md")).toContain("Modules: engine, renderer.");
  });
});

describe("runPlan — interface declaration seeding (issue #97)", () => {
  it("seeds the planner's $INTERFACE token into railhead.json seed-if-empty", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$INTERFACE\ncanvas\n$SMOKE\ncargo run\n$DESIGN\nA design.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"what\":\"shell\",\"criteria\":[\"runs\"]}]\n");
      return okResult();
    });
    await runPlan({ cwd, prompt: "a canvas game", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBe("canvas");
  });

  it("seeds a `none` declaration (a library is a deliberate declaration, not an absence)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\nnone\n$SMOKE\nNONE\n$DESIGN\nA lib.\n$END\n$ARCHITECTURE\nModules: parser.\n$END\n$TICKETS\n[{\"title\":\"Lib\",\"what\":\"lib\",\"criteria\":[\"parses\"]}]\n");
      return okResult();
    });
    await runPlan({ cwd, prompt: "a parser library", model: null });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBe("none");
  });

  it("does not clobber a human's declared interface on replan (seed-if-empty, like verify/smoke)", async () => {
    const cwd = await freshCwd();
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ interface: "terminal", verify: [] }, null, 2), "utf8");
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$INTERFACE\nbrowser-ui\n$SMOKE\ncargo run\n$DESIGN\nA design.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"what\":\"shell\",\"criteria\":[\"runs\"]}]\n");
      return okResult();
    });
    await runPlan({ cwd, prompt: "a web app", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBe("terminal");
  });

  it("leaves the interface undeclared when the planner emits no $INTERFACE block", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, planPayload());
      return okResult();
    });
    await runPlan({ cwd, prompt: "a game", model: null });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBeUndefined();
  });

  it("accepts a surface plan whose look is owned by one open-ended craft ticket", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\ncanvas\n$SMOKE\nnpm run dev\n$DESIGN\nGoal: a game.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Art direction: compose the scene\",\"what\":\"create the composed scene, iterating on screenshots until the goal is met\",\"criteria\":[],\"open_ended\":true}]\n");
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "a canvas game", model: null });
    // The craft ticket, then the run's final hardener (the verify stack has a test runner).
    expect(result.tickets.map((t) => t.title)).toEqual([
      "Art direction: compose the scene",
      "Harden: transcribe confirmed behaviors into the test suite",
    ]);
    expect(result.tickets[0]!.open_ended).toBe(true);
  });
});

describe("runPlan — interaction smoke is derived, not planner-seeded (v2 issue 01)", () => {
  it("leaves interaction_smoke absent for a browser-ui interface (the derived default turns it on at run time)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\nbrowser-ui\n$SMOKE\nnpm run dev\n$DESIGN\nA design.\n$END\n$ARCHITECTURE\nModules: ui.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"what\":\"shell\",\"criteria\":[\"renders\"]}]\n");
      return okResult();
    });
    await runPlan({ cwd, prompt: "a web app", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBe("browser-ui");
    // Derived via config.interactionSmokeEnabled, never written by the planner —
    // so a human's later explicit value always wins.
    expect(cfg.interaction_smoke).toBeUndefined();
  });
});

describe("runPlan — the test hardener (v2 issue 01)", () => {
  it("appends a final harden ticket after the frontier when the verify stack has a test runner", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$SMOKE\nNONE\n$DESIGN\nA design.\n$END\n$ARCHITECTURE\nModules: core.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"what\":\"shell\",\"criteria\":[\"the shell runs\"]}]\n");
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "an app", model: null, artDirection: false });
    const titles = result.tickets.map((t) => t.title);
    expect(titles).toEqual(["Shell", "Harden: transcribe confirmed behaviors into the test suite"]);
    const hardener = result.tickets[result.tickets.length - 1]!;
    expect(hardener.group).toBe("harden");
    expect(hardener.what).toMatch(/\.railhead\/probes\//);
    expect(hardener.what).toMatch(/do not add a new framework/i);
    expect(hardener.what).toMatch(/probe registry is empty/i);
    expect(hardener.criteria.join(" ")).toMatch(/verify commands still pass/i);
  });

  it("does not append a hardener when no verify command runs tests", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, planPayload());
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "an app", model: null, artDirection: false });
    expect(result.tickets.map((t) => t.title)).toEqual(["Shell"]);
  });

  it("does not append a hardener in fix mode (a fix has no plan to grow)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitText(options.ledgerDir, options.phaseFile, "$VERIFY\ncargo test\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Fix crash\",\"what\":\"fix\",\"criteria\":[\"no crash\"]}]\n");
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "bug", model: null, mode: "fix" });
    expect(result.tickets.map((t) => t.title)).toEqual(["Fix crash"]);
  });
});

describe("runPlan transient retry", () => {
  it("retries on transient (0-token) error and succeeds on the second attempt", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      if (call === 1) return transientResult();
      await emitStaged(options, planPayload());
      return okResult();
    });
    const result = await runPlan({ cwd, prompt: "a game", model: null, infraBackoffSec: [0] });
    // transient design attempt, its retry, then the tickets stage.
    expect(call).toBe(3);
    expect(result.tickets).toHaveLength(1);
  });

  it("throws after exhausting all retries on persistent transient errors", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async () => {
      call++;
      return transientResult();
    });
    await expect(runPlan({ cwd, prompt: "a game", model: null, infraBackoffSec: [0, 0] })).rejects.toThrow(/provider failure/);
    expect(call).toBe(3);
  });
});

describe("runPlan — coherence charter (issue #99 / ADR 0028)", () => {
  it("writes docs/coherence.md when the planner emits a ## Coherence contract inside $DESIGN for a surfaced plan", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\nGoal: a neon snake.\n## Coherence contract\n### Visual tokens\nNEON palette from src/ui/tokens.ts; 4px scale.\n### Layout model\nCanvas centered 1280x800, no scroll.\n### Chrome rules\nThe one toolbar recipe; do not introduce a competing style.\n$END\n$ARCHITECTURE\nModules: engine, renderer.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"what\":\"shell\",\"criteria\":[\"render the snake canvas\"]}]\n");
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { readProjectDoc } = await import("../core/git.ts");
      await runPlan({ cwd, prompt: "a neon snake game", model: null });
      const coherence = await readProjectDoc(cwd, "docs/coherence.md");
      expect(coherence).not.toBeNull();
      expect(coherence!).toContain("### Visual tokens");
      expect(coherence!).toContain("NEON palette");
      expect(coherence!).toContain("do not introduce a competing style");
      expect(coherence!).not.toContain("Goal:");
      // The charter is persisted ONCE: design.md carries only the narrative —
      // goal reviews amend docs/coherence.md, and a second copy inside
      // design.md would drift stale against its amended twin (ADR 0028).
      const design = await readProjectDoc(cwd, "docs/design.md");
      expect(design).toContain("Goal: a neon snake.");
      expect(design).not.toContain("## Coherence contract");
      expect(design).not.toContain("NEON palette");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("writes no empty docs/design.md when the $DESIGN block is charter-only", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\n## Coherence contract\n### Visual tokens\nNEON palette from src/ui/tokens.ts.\n### Layout model\nCanvas centered 1280x800.\n### Chrome rules\nThe one toolbar recipe.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"what\":\"shell\",\"criteria\":[\"render the snake canvas\"]}]\n");
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { readProjectDoc } = await import("../core/git.ts");
      await runPlan({ cwd, prompt: "a neon snake game", model: null });
      expect(await readProjectDoc(cwd, "docs/design.md")).toBeNull();
      const coherence = await readProjectDoc(cwd, "docs/coherence.md");
      expect(coherence).toContain("### Visual tokens");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("writes NO docs/coherence.md when a surfaced plan omits the section (absent-robust) and warns", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\nGoal: a neon snake with smooth gliding.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Render\",\"what\":\"render\",\"criteria\":[\"the snake visibly glides on the canvas\"]}]\n");
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { readProjectDoc } = await import("../core/git.ts");
      await runPlan({ cwd, prompt: "a neon snake game", model: null });
      expect(await readProjectDoc(cwd, "docs/coherence.md")).toBeNull();
      // The plan-time guard warns (never fails): surface tickets exist but no charter.
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.join("\n")).toContain("Coherence contract");
    } finally {
      warn.mockRestore();
    }
  });

  it("writes NO docs/coherence.md for a pure-model plan (no surface, no section)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm run typecheck\n$SMOKE\nNONE\n$DESIGN\nA pure math library.\n$END\n$ARCHITECTURE\nModules: adder, multiplier.\n$END\n$TICKETS\n[{\"title\":\"Adder\",\"what\":\"add\",\"criteria\":[\"add(2,3) is 5\"]}]\n");
      return okResult();
    });
    const { readProjectDoc } = await import("../core/git.ts");
    await runPlan({ cwd, prompt: "a math library", model: null });
    expect(await readProjectDoc(cwd, "docs/coherence.md")).toBeNull();
  });
});

describe("maybeGenerateAgentsMd", () => {
  function fakeTicket(number: string, title: string): Ticket {
    return {
      file: `${number}-${title.toLowerCase().replace(/\s+/g, "-")}.md`,
      number,
      slug: title,
      title,
      what: "w",
      criteria: [],
    };
  }

  it("includes the small-module preference in the AGENTS.md generator prompt (#4)", async () => {
    const cwd = await freshCwd();
    let capturedPrompt = "";
    mockExec.mockImplementation(async (prompt, options) => {
      capturedPrompt = prompt;
      await emitStaged(options, "DONE AGENTS.md");
      return okResult();
    });
    await maybeGenerateAgentsMd({
      cwd,
      prompt: "a snake game",
      model: null,
      tickets: [fakeTicket("01", "Build it")],
      contextBudget: 64000,
      maxSteps: 50,
      stallTimeoutSec: null,
    });
    expect(capturedPrompt).toContain("prefer many small cohesive modules");
    expect(capturedPrompt).toContain("god-files");
    expect(capturedPrompt).toContain("~64k context");
  });

  it("uses the provided contextBudget in the small-module wording (#4)", async () => {
    const cwd = await freshCwd();
    let capturedPrompt = "";
    mockExec.mockImplementation(async (prompt, options) => {
      capturedPrompt = prompt;
      await emitStaged(options, "DONE AGENTS.md");
      return okResult();
    });
    await maybeGenerateAgentsMd({
      cwd,
      prompt: "a snake game",
      model: null,
      tickets: [fakeTicket("01", "Build it")],
      contextBudget: 32768,
      maxSteps: 50,
      stallTimeoutSec: null,
    });
    expect(capturedPrompt).toContain("~32k context");
  });

  it("includes the deep-module citation in the AGENTS.md generator prompt (#7)", async () => {
    const cwd = await freshCwd();
    let capturedPrompt = "";
    mockExec.mockImplementation(async (prompt, options) => {
      capturedPrompt = prompt;
      await emitStaged(options, "DONE AGENTS.md");
      return okResult();
    });
    await maybeGenerateAgentsMd({
      cwd,
      prompt: "a snake game",
      model: null,
      tickets: [fakeTicket("01", "Build it")],
      contextBudget: 64000,
      maxSteps: 50,
      stallTimeoutSec: null,
    });
    expect(capturedPrompt).toContain("deep");
    expect(capturedPrompt).toContain("small interface, large implementation");
    expect(capturedPrompt).toContain("docs/codebase-design.md");
  });
});

