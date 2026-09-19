import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendEvent } from "../core/ledger.ts";

// planner.ts drives the interview through ONE seam: executeOpendCode. Mocking
// that single function (real opencode subprocess runs are integration, not
// unit, tests — see AGENTS.md) lets everything else — the ledger, CONTEXT.md
// writes, ADR numbering, round bookkeeping — run for real, the same
// technique run.test.ts already uses for the implement/verify/review loop.
vi.mock("../execute/executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execute/executor.ts")>();
  return { ...actual, executeOpendCode: vi.fn() };
});

import { executeOpendCode } from "../execute/executor.ts";
import { runSharpenSession, maybeGenerateAgentsMd } from "./planner.ts";
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

/** Build a stage-1 plan transcript (the design stage's output shape). */
function planDoc(opts: { verify?: string; smoke?: string; iface?: string; plan?: string; design?: string; architecture?: string } = {}): string {
  const lines = ["$VERIFY", opts.verify ?? "cargo build"];
  if (opts.iface) lines.push("$INTERFACE", opts.iface);
  lines.push("$SMOKE", opts.smoke ?? "cargo run");
  lines.push("$PLAN", opts.plan ?? "The complete plan.", "$END");
  lines.push("$DESIGN", opts.design ?? "A plan.", "$END");
  lines.push("$ARCHITECTURE", opts.architecture ?? "Modules: engine, renderer.", "$END");
  return lines.join("\n") + "\n";
}

/** Emit the transcript for whichever staged planner phase the mocked executor
 * is on. Planning is staged (design -> coverage audit -> decomposition), so a
 * mock that carries one payload can drive the whole flow: the payload goes to
 * the design stage, the audit passes by default, and the tickets stage reuses
 * the array found after the payload's $TICKETS marker. Any other phase
 * (sharpen, AGENTS.md) receives the payload verbatim. */
async function emitStaged(
  options: { ledgerDir: string; phaseFile: string },
  payload: string | { plan?: string; tickets?: string; check?: string[]; revise?: string; repair?: (round: number) => string },
): Promise<void> {
  const p = typeof payload === "string" ? { plan: payload } : payload;
  const phase = options.phaseFile;
  const DEFAULT_TICKETS = '[{"title":"Shell","mission":"m","what":"shell","criteria":[],"blocked_by":[]}]';
  const ticketsOf = (text: string): string => {
    const idx = text.search(/\$TICKETS\b/i);
    return idx >= 0 ? text.slice(idx + "$TICKETS".length).trim() : "";
  };
  const fallbackTickets = (p.plan ? ticketsOf(p.plan) : "") || DEFAULT_TICKETS;
  if (phase.startsWith("plan-check")) {
    const round = Number(phase.slice("plan-check-".length));
    const seq = p.check ?? ["$COVERAGE_PASS\n$END\n"];
    return emitText(options.ledgerDir, phase, seq[Math.min(round - 1, seq.length - 1)]);
  }
  if (phase.startsWith("plan-revise")) {
    return emitText(options.ledgerDir, phase, p.revise ?? p.plan ?? planDoc());
  }
  if (phase === "plan-tickets") {
    const tickets = p.tickets ?? fallbackTickets;
    return emitText(options.ledgerDir, phase, /^\$TICKETS\b/.test(tickets) ? tickets : `$TICKETS\n${tickets}\n`);
  }
  if (phase.startsWith("plan-repair")) {
    const round = Number(phase.slice("plan-repair-".length));
    if (p.repair) return emitText(options.ledgerDir, phase, p.repair(round));
    const tickets = p.tickets ?? fallbackTickets;
    return emitText(options.ledgerDir, phase, `$TICKETS\n${tickets}\n`);
  }
  return emitText(options.ledgerDir, phase, p.plan ?? planDoc());
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

describe("runPlan fix mode", () => {
  it("threads fix mode into the planner prompt (forbids pre-judging the bug as already fixed)", async () => {
    const cwd = await freshCwd();
    const captured: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      captured.push(prompt);
      await emitStaged(options, "$VERIFY\ncargo test\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Fix the bug\",\"mission\":\"m\",\"what\":\"fix it\",\"criteria\":[],\"blocked_by\":[]}]\n");
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "ball bounces wrong", model: null, mode: "fix" });
    expect(captured.length).toBe(1);
    expect(captured[0]).toMatch(/never.{0,40}decide.{0,40}already/i);
    expect(captured[0]).toMatch(/always emit a real fix ticket/i);
  });

  it("build mode (default) omits the fix-mode forbid-pre-judging language", async () => {
    const cwd = await freshCwd();
    const captured: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      captured.push(prompt);
      await emitStaged(options, "$VERIFY\ncargo test\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Build it\",\"mission\":\"m\",\"what\":\"build\",\"criteria\":[],\"blocked_by\":[]}]\n");
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a snake game", model: null });
    // Staged build planning: design + coverage audit + decomposition.
    expect(captured.length).toBe(3);
    expect(captured[0]).not.toMatch(/never.{0,40}decide.{0,40}already/i);
  });

  it("recovers the plan when the model emits it as a rejected write tool call to /tmp instead of as text", async () => {
    const cwd = await freshCwd();
    const planContent = "$VERIFY\nnode scripts/verify.js\n$SMOKE\nNONE\n$DESIGN\nA shell with rooms.\n$END\n$ARCHITECTURE\nModules: shell, rooms.\n$END\n$TICKETS\n[\n  {\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"the shell\",\"criteria\":[\"opens\"],\"blocked_by\":[],\"introduces\":[\"createWorld\"]},\n  {\"title\":\"Rooms\",\"mission\":\"m\",\"what\":\"rooms\",\"criteria\":[\"renders\"],\"blocked_by\":[0],\"references\":[\"createWorld\"]}\n]\n";
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.startsWith("plan-check")) {
        await emitText(options.ledgerDir, options.phaseFile, "$COVERAGE_PASS\n$END\n");
        return okResult();
      }
      if (options.phaseFile === "plan-tickets") {
        await emitText(options.ledgerDir, options.phaseFile, planContent);
        return okResult();
      }
      await appendEvent(
        options.ledgerDir,
        options.phaseFile,
        JSON.stringify({
          type: "tool_use",
          part: {
            type: "tool",
            tool: "write",
            callID: "call_1",
            state: {
              status: "error",
              input: { filePath: "/tmp/plan.json", content: planContent },
              error: "The user rejected permission to use this specific tool call.",
            },
          },
        }),
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a horror game", model: null });
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].title).toBe("Shell");
    expect(result.tickets[1].title).toBe("Rooms");
    expect(result.verify).toEqual(["node scripts/verify.js"]);
    expect(result.smoke).toEqual([]);
  });
});

describe("runPlan — staged coverage audit (ADR 0039)", () => {
  it("revises the plan when the audit reports unmet demands, then decomposes the revised plan", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, {
        plan: planDoc({ design: "Original design missing the art deliverable." }),
        check: [
          "$COVERAGE_FAIL\n[MISSING] art — the plan promises rectangles only\n$END\n",
          "$COVERAGE_PASS\n$END\n",
        ],
        revise: planDoc({ design: "Revised design with a named art deliverable." }),
      });
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlan } = await import("./planner.ts");
    const { readProjectDoc } = await import("../core/git.ts");
    const result = await runPlan({ cwd, prompt: "a beautiful level", model: null });
    // design + audit-1 + revise-1 + audit-2 + tickets
    expect(call).toBe(5);
    expect(await readProjectDoc(cwd, "docs/design.md")).toContain("Revised design");
    expect(result.designDoc).toContain("Revised design");
    expect(existsSync(join(cwd, ".railhead", "plan-latest", "events", "plan-revise-1.jsonl"))).toBe(true);
    expect(warn.mock.calls.join("\n")).toContain("[MISSING] art");
    warn.mockRestore();
  });

  it("rejects a plan whose audit still reports unmet demands after the round cap (never decomposed)", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, {
        plan: planDoc({ design: "Original." }),
        check: ["$COVERAGE_FAIL\n[MISSING] art — nothing drawn\n$END\n"],
        revise: planDoc({ design: "Still no art." }),
      });
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlan } = await import("./planner.ts");
    const err = await runPlan({ cwd, prompt: "a beautiful level", model: null }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/plan rejected/);
    expect(String(err)).toContain("[MISSING] art");
    // design + audit-1 + revise-1 + audit-2 — no tickets stage ran.
    expect(call).toBe(4);
    expect(existsSync(join(cwd, ".railhead", "plan-latest", "events", "plan-tickets.jsonl"))).toBe(false);
    warn.mockRestore();
  });

  it("treats an inconclusive audit (no verdict marker) as a failed round, never an assumed pass", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, {
        plan: planDoc({ design: "Original." }),
        check: ["I reviewed it and it seems fine."],
        revise: planDoc({ design: "Revised." }),
      });
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlan } = await import("./planner.ts");
    const err = await runPlan({ cwd, prompt: "a level", model: null }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/emitted no readable verdict/);
    warn.mockRestore();
  });
});

describe("runPlan — interactive plan review (ADR 0041)", () => {
  it("reviews the FINAL plan before tickets (PLAN.md exists, plan-only), replans on feedback, and decomposes once accepted", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, {
        plan: planDoc({ plan: "Original complete plan.", design: "Original design." }),
        revise: planDoc({ plan: "The revised complete plan.", design: "Revised per user feedback." }),
      });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
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
        // The user sees the FINAL plan, and no tickets exist yet.
        atReview.push((await readProjectDoc(cwd, "PLAN.md")) ?? "");
        return feedbacks[asked++] ?? null;
      },
    });
    // A human reviewer replaces the audit; tickets are decomposed exactly once,
    // AFTER acceptance — not per review round.
    expect(phases.filter((p) => p.startsWith("plan-check"))).toEqual([]);
    expect(phases.filter((p) => p.startsWith("plan-revise-user"))).toHaveLength(1);
    expect(phases.filter((p) => p === "plan-tickets")).toHaveLength(1);
    expect(asked).toBe(2);
    expect(atReview[0]).toContain("Original complete plan.");
    expect(atReview[0]).not.toContain("## Ticket plan");
    expect(atReview[1]).toContain("The revised complete plan.");
    expect(atReview[1]).not.toContain("## Ticket plan");
    expect(result.planDoc).toContain("The revised complete plan.");
    const planMd = await readProjectDoc(cwd, "PLAN.md");
    expect(planMd).toContain("The revised complete plan.");
    expect(planMd).toContain("## Ticket plan");
  });

  it("keeps the adversarial coverage audit when no interactive reviewer is wired", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, { plan: planDoc({ design: "A design." }) });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "an app", model: null });
    expect(phases.some((p) => p.startsWith("plan-check"))).toBe(true);
  });

  it("fix mode ignores the interactive reviewer (one ticket, no plan loop, no PLAN.md)", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, `$VERIFY\ncargo test\n$SMOKE\ncargo run\n$TICKETS\n[{"title":"Fix","mission":"m","what":"fix","criteria":[],"blocked_by":[]}]\n`);
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    let asked = 0;
    const result = await runPlan({ cwd, prompt: "bug", model: null, mode: "fix", reviewPlan: async () => { asked++; return "more"; } });
    expect(asked).toBe(0);
    expect(phases).toEqual(["plan"]);
    expect(result.planPath).toBeNull();
  });

  it("interviewPlan (ADR 0042): answers revise the plan before the audit and the ticket decomposition", async () => {
    const cwd = await freshCwd();
    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      phases.push(options.phaseFile);
      await emitStaged(options, {
        plan: planDoc({ plan: "Original plan.", design: "Original design." }),
        revise: planDoc({ plan: "Interview-revised plan.", design: "Revised design." }),
      });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const { readProjectDoc } = await import("../core/git.ts");
    let seenPlan = "";
    const result = await runPlan({
      cwd,
      prompt: "an app",
      model: null,
      interviewPlan: async (planText) => {
        seenPlan = planText;
        return "The user answered a planning interview about this plan.\n- Q: Art — A: procedural sprites";
      },
    });
    expect(seenPlan).toContain("Original plan.");
    expect(phases.filter((p) => p === "plan-revise-interview-1")).toHaveLength(1);
    // The refined plan is what the audit verifies, then what decomposes.
    const interviewIdx = phases.indexOf("plan-revise-interview-1");
    const auditIdx = phases.findIndex((p) => p.startsWith("plan-check"));
    expect(auditIdx).toBeGreaterThan(interviewIdx);
    expect(result.planDoc).toContain("Interview-revised plan.");
    expect(await readProjectDoc(cwd, "PLAN.md")).toContain("Interview-revised plan.");
  });
});

describe("runPlan — design and architecture docs (#34)", () => {
  it("writes docs/design.md and docs/architecture.md when the planner emits $DESIGN and $ARCHITECTURE blocks", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\nA roguelike with oppressive atmosphere.\n$END\n$ARCHITECTURE\nModules: engine, renderer.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a roguelike", model: null });
    expect(result.designDoc).toBe("A roguelike with oppressive atmosphere.");
    expect(result.architectureDoc).toBe("Modules: engine, renderer.");

    const { readProjectDoc } = await import("../core/git.ts");
    expect(await readProjectDoc(cwd, "docs/design.md")).toContain("oppressive atmosphere");
    expect(await readProjectDoc(cwd, "docs/architecture.md")).toContain("Modules: engine, renderer.");
  });

  it("leaves designDoc and architectureDoc null when the planner does not emit them (optional)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a small tool", model: null });
    expect(result.designDoc).toBeNull();
    expect(result.architectureDoc).toBeNull();
  });

  it("writes design.md without architecture.md when only $DESIGN is emitted", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\nA dark game.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a dark game", model: null });
    expect(result.designDoc).toBe("A dark game.");
    expect(result.architectureDoc).toBeNull();

    const { readProjectDoc } = await import("../core/git.ts");
    expect(await readProjectDoc(cwd, "docs/design.md")).toBe("A dark game.\n");
    expect(await readProjectDoc(cwd, "docs/architecture.md")).toBeNull();
  });

  it("includes group in the planner prompt's JSON schema (#19)", async () => {
    const cwd = await freshCwd();
    const captured: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      captured.push(prompt);
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n");
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a game", model: null });
    const ticketsPrompt = captured.find((p) => p.includes("decomposing a VALIDATED plan"))!;
    expect(ticketsPrompt).toContain('"group"');
    expect(ticketsPrompt).toMatch(/coherent vertical slice/i);
  });

  it("includes $DESIGN and $ARCHITECTURE marker instructions in the planner prompt (#34)", async () => {
    const cwd = await freshCwd();
    const captured: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      captured.push(prompt);
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n");
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a game", model: null });
    expect(captured[0]).toContain("$DESIGN");
    expect(captured[0]).toContain("$ARCHITECTURE");
    expect(captured[0]).toContain("$END");
  });
});

describe("runPlan — interface declaration seeding (issue #97)", () => {
  it("seeds the planner's $INTERFACE token into railhead.json seed-if-empty", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$INTERFACE\ncanvas\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a canvas game", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBe("canvas");
  });

  it("seeds a `none` declaration (a library is a deliberate declaration, not an absence)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\nnone\n$SMOKE\nNONE\n$TICKETS\n[{\"title\":\"Lib\",\"mission\":\"m\",\"what\":\"lib\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a parser library", model: null });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBe("none");
  });

  it("does not clobber a human's declared interface on replan (seed-if-empty, like verify/smoke)", async () => {
    const cwd = await freshCwd();
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ interface: "terminal", verify: [] }, null, 2), "utf8");
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$INTERFACE\nbrowser-ui\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a web app", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBe("terminal");
  });

  it("leaves the interface undeclared when the planner emits no $INTERFACE block", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a game", model: null });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interface).toBeUndefined();
  });

  it("accepts a surface plan whose look is owned by one open-ended craft ticket (option c)", async () => {
    const cwd = await freshCwd();
    const artPlan = "$VERIFY\nnpm test\n$INTERFACE\ncanvas\n$SMOKE\nnpm run dev\n$TICKETS\n" +
      "[{\"title\":\"Art direction: compose the scene\",\"mission\":\"m\",\"what\":\"create the composed scene, iterating on screenshots until the goal is met\",\"criteria\":[],\"blocked_by\":[],\"introduces\":[\"composeScene\"],\"testable\":false,\"open_ended\":true}]\n";
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, artPlan);
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a canvas game", model: null });
    expect(result.tickets.map((t) => t.title)).toEqual(["Art direction: compose the scene"]);
    expect(result.tickets[0]!.open_ended).toBe(true);
  });
});

describe("runPlan — interaction smoke seeding", () => {
  it("enables interaction_smoke for a browser-ui interface", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\nbrowser-ui\n$SMOKE\nnpm run dev\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a web app", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interaction_smoke).toBe(true);
  });

  it("enables interaction_smoke for a canvas interface", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$INTERFACE\ncanvas\n$SMOKE\ncargo run\n$TICKETS\n[{\"title\":\"Game\",\"mission\":\"m\",\"what\":\"game\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a canvas game", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interaction_smoke).toBe(true);
  });

  it("leaves interaction_smoke off for a terminal interface", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\nterminal\n$SMOKE\nNONE\n$TICKETS\n[{\"title\":\"CLI\",\"mission\":\"m\",\"what\":\"cli\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a CLI tool", model: null });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interaction_smoke).toBeUndefined();
  });

  it("does not override a human's explicit interaction_smoke: false", async () => {
    const cwd = await freshCwd();
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ interaction_smoke: false, verify: [] }, null, 2), "utf8");
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm test\n$INTERFACE\nbrowser-ui\n$SMOKE\nnpm run dev\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    await runPlan({ cwd, prompt: "a web app", model: null, artDirection: false });
    const cfg = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(cfg.interaction_smoke).toBe(false);
  });
});

describe("runPlan transient retry", () => {
  it("retries on transient (0-token) error and succeeds on the second attempt", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      if (call === 1) return transientResult();
      await emitStaged(options, "$VERIFY\nnpm test\n$SMOKE\nnpm start\n$TICKETS\n[{\"title\":\"Build\",\"mission\":\"m\",\"what\":\"build\",\"criteria\":[],\"blocked_by\":[]}]\n");
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null, infraBackoffSec: [0] });
    // transient design attempt, its retry, the coverage audit, and tickets.
    expect(call).toBe(4);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].title).toBe("Build");
  });

  it("throws after exhausting all retries on persistent transient errors", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async () => {
      call++;
      return transientResult();
    });
    const { runPlan } = await import("./planner.ts");
    await expect(runPlan({ cwd, prompt: "a game", model: null, infraBackoffSec: [0, 0] })).rejects.toThrow(/provider failure/);
    expect(call).toBe(3);
  });
});

describe("runPlan gate (#86) — bounded repair loop", () => {
  // A plan whose tickets both declare the same `introduces` symbol — the
  // pixeledit class-A shape that used to print a warning and run anyway.
  const DUP_PLAN = '[{"title":"One","mission":"m","what":"one","criteria":[],"blocked_by":[],"introduces":["greet"]},{"title":"Two","mission":"m","what":"two","criteria":[],"blocked_by":[0],"introduces":["greet"]}]';
  const REPAIRED_PLAN = '[{"title":"One","mission":"m","what":"one","criteria":[],"blocked_by":[],"introduces":["greet"]},{"title":"Two","mission":"m","what":"two","criteria":[],"blocked_by":[0],"introduces":["farewell"],"references":["greet"]}]';

  it("repairs a duplicate-introduces plan in one round and accepts it", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: DUP_PLAN, repair: () => `$TICKETS\n${REPAIRED_PLAN}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    // design + audit + tickets + one bounded repair round — not run as-is.
    expect(call).toBe(4);
    expect(result.tickets).toHaveLength(2);
    // The repaired plan is what got written.
    expect(result.tickets[1].introduces).toEqual(["farewell"]);
    expect(result.tickets[1].references).toContain("greet");
    // The repair round is persisted as its own ledger phase.
    const eventsDir = join(cwd, ".railhead", "plan-latest", "events");
    expect(existsSync(join(eventsDir, "plan-repair-1.jsonl"))).toBe(true);
  });

  it("rejects a plan whose duplicate-introduces survives all repair rounds (never run as-is)", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: DUP_PLAN, repair: () => `$TICKETS\n${DUP_PLAN}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const err = await runPlan({ cwd, prompt: "a game", model: null }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/plan rejected/);
    expect(String(err)).toContain("greet");
    // design + audit + tickets + N bounded repair rounds (N = MAX_PLAN_REPAIR_ROUNDS).
    expect(call).toBe(5);
  }, 10000);

  it("accepts via a $RULINGS adjudication and persists the ruling to the plan sidecar", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, {
        tickets: DUP_PLAN,
        // Same plan returned from the repair round, but the finding is ruled intentional.
        repair: () => `$TICKETS\n${DUP_PLAN}\n$RULINGS\nA1 intentional — same symbol reused as a local in a separate module; no clobber risk\n$END\n`,
      });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    expect(call).toBe(4);
    expect(result.tickets).toHaveLength(2);
    // The ruling is persisted next to origin.json for runs on this plan dir.
    const rulingsFile = join(cwd, ".scratch", "a-game", "rulings.json");
    expect(existsSync(rulingsFile)).toBe(true);
    const raw = await readFile(rulingsFile, "utf8");
    expect(raw).toContain("dup-introduce:greet:one:two");
    expect(raw).toContain("intentional");
    // The ruling is also mirrored into the plan ledger's `rulings` event file.
    const rulingsLedger = join(cwd, ".railhead", "plan-latest", "events", "rulings.jsonl");
    expect(existsSync(rulingsLedger)).toBe(true);
    expect(await readFile(rulingsLedger, "utf8")).toContain("dup-introduce:greet:one:two");
  });

  it("never hard-fails a class-B finding before the round cap — a ruled no-contracts ticket survives", async () => {
    const cwd = await freshCwd();
    // A two-ticket plan where neither ticket declares references/introduces is
    // class B only (no structural finding), so a ruling must clear it.
    const NO_CONTRACTS = '[{"title":"One","mission":"m","what":"one","criteria":[],"blocked_by":[]},{"title":"Two","mission":"m","what":"two","criteria":[],"blocked_by":[0]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, {
        tickets: NO_CONTRACTS,
        repair: () => `$TICKETS\n${NO_CONTRACTS}\n$RULINGS\nB1 intentional — standalone ticket\nB2 intentional — standalone ticket\n$END\n`,
      });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "big tool", model: null, contextBudget: 64000 });
    // It reached the repair round (not hard-failed at scan time) and accepted.
    expect(call).toBe(4);
    expect(result.tickets).toHaveLength(2);
  });

  // The reported incident: a 13-ticket plan where the model emitted the
  // scaffold ticket twice — ticket 0 and ticket 12 both titled "Scaffold: …",
  // and the plan aborted on duplicate slugs before any gate finding existed.
  const DUP_TITLE_PLAN = '[{"title":"Scaffold","mission":"m","what":"first scaffold","criteria":["c"],"blocked_by":[],"files":["src/a.ts"],"introduces":["a"]},{"title":"Scaffold","mission":"m","what":"stray re-emission","criteria":["d"],"blocked_by":[0],"files":["src/b.ts"],"introduces":["b"]}]';
  const DUP_TITLE_FIXED = '[{"title":"Scaffold","mission":"m","what":"first scaffold","criteria":["c"],"blocked_by":[],"files":["src/a.ts"],"introduces":["a"]},{"title":"Scaffold walker","mission":"m","what":"stray re-emission","criteria":["d"],"blocked_by":[0],"files":["src/b.ts"],"introduces":["b"]}]';

  it("repairs a duplicate-title plan in one round instead of aborting the gate (ADR 0027, amended)", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: DUP_TITLE_PLAN, repair: () => `$TICKETS\n${DUP_TITLE_FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    // design + audit + tickets + one bounded repair round — not aborted as-is.
    expect(call).toBe(4);
    // The retitle cleared the finding: unique files, no -2 suffix left behind.
    expect(result.tickets.map((t) => t.file)).toEqual(["01-scaffold.md", "02-scaffold-walker.md"]);
    expect(existsSync(join(cwd, ".railhead", "plan-latest", "events", "plan-repair-1.jsonl"))).toBe(true);
  });

  it("rejects a duplicate-title plan whose duplicate survives all repair rounds — still never run as-is", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: DUP_TITLE_PLAN, repair: () => `$TICKETS\n${DUP_TITLE_PLAN}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const err = await runPlan({ cwd, prompt: "a game", model: null }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/plan rejected/);
    expect(String(err)).toMatch(/duplicate-slug/);
    expect(call).toBe(5);
  }, 10000);

  // A dependency cycle never surfaced as a finding at all — orderTickets
  // threw before the gate could report anything, bypassing repair rounds.
  const CYCLIC_PLAN = '[{"title":"Alpha","mission":"m","what":"a","criteria":["c"],"blocked_by":[1],"files":["src/a.ts"],"introduces":["a"]},{"title":"Beta","mission":"m","what":"b","criteria":["d"],"blocked_by":[0],"files":["src/b.ts"],"introduces":["b"]}]';
  const CYCLIC_FIXED = '[{"title":"Alpha","mission":"m","what":"a","criteria":["c"],"blocked_by":[],"files":["src/a.ts"],"introduces":["a"]},{"title":"Beta","mission":"m","what":"b","criteria":["d"],"blocked_by":[0],"files":["src/b.ts"],"introduces":["b"]}]';

  it("repairs an unorderable (cyclic) plan through the bounded loop instead of crashing the gate", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: CYCLIC_PLAN, repair: () => `$TICKETS\n${CYCLIC_FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    expect(call).toBe(4);
    expect(result.tickets.map((t) => t.file)).toEqual(["01-alpha.md", "02-beta.md"]);
  });

  it("rejects a cyclic plan that survives all repair rounds, and a $RULINGS attempt cannot clear it", async () => {
    const cwd = await freshCwd();
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, {
        tickets: CYCLIC_PLAN,
        // The model tries to rule the cycle intentional — the gate must drop it.
        repair: () => `$TICKETS\n${CYCLIC_PLAN}\n$RULINGS\nA1 intentional — the cycle is load order, not a dependency\n$END\n`,
      });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const err = await runPlan({ cwd, prompt: "a game", model: null }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/plan rejected/);
    expect(String(err)).toMatch(/unorderable-plan/);
    expect(call).toBe(5);
  }, 10000);
});

describe("runPlan gate (#86) — pixeledit-night-1 regression", () => {
  it("rejects a replay of the incident plan (duplicate introduces + unordered same-file) rather than running it", async () => {
    const cwd = await freshCwd();
    // Fixture distilled from the pixeledit-night-1 plan: FRAME_COUNT introduced
    // by two unordered tickets that also both touch package.json.
    const BAD_PLAN = '[{"title":"Scaffold","mission":"m","what":"scaffold","criteria":[],"blocked_by":[],"introduces":["FRAME_COUNT"],"files":["package.json","vite.config.ts","index.html","src/main.ts","src/config.ts","src/loop.ts","src/input.ts","src/audio.ts","src/assets.ts"]},{"title":"Render frames","mission":"m","what":"render","criteria":[],"blocked_by":[],"introduces":["FRAME_COUNT","render"],"files":["package.json","src/render.ts"]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: BAD_PLAN, repair: () => `$TICKETS\n${BAD_PLAN}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const err = await runPlan({ cwd, prompt: "a game", model: null, contextBudget: 100000 }).catch((e: unknown) => e);
    expect(String(err)).toContain("FRAME_COUNT");
    expect(call).toBe(5); // design + audit + tickets + 2 bounded rounds, then reject — never run as-is
  }, 10000);
});

describe("maybeGenerateAgentsMd", () => {
  function fakeTicket(number: string, title: string): Ticket {
    return {
      file: `${number}-${title.toLowerCase().replace(/\s+/g, "-")}.md`,
      number,
      slug: title,
      title,
      mission: "m",
      what: "w",
      criteria: [],
      blocked_by: [],
      files: [],
      references: [],
      introduces: [],
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

describe("runPlan — coherence charter (issue #99 / ADR 0028)", () => {
  it("writes docs/coherence.md when the planner emits a ## Coherence contract inside $DESIGN for a surfaced plan", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\nGoal: a neon snake.\n## Coherence contract\n### Visual tokens\nNEON palette from src/ui/tokens.ts; 4px scale.\n### Layout model\nCanvas centered 1280x800, no scroll.\n### Chrome rules\nThe one toolbar recipe; do not introduce a competing style.\n$END\n$ARCHITECTURE\nModules: engine, renderer.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[\"render the snake canvas\"],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlan } = await import("./planner.ts");
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
    warn.mockRestore();
  });

  it("writes no empty docs/design.md when the $DESIGN block is charter-only", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\n## Coherence contract\n### Visual tokens\nNEON palette from src/ui/tokens.ts.\n### Layout model\nCanvas centered 1280x800.\n### Chrome rules\nThe one toolbar recipe.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Shell\",\"mission\":\"m\",\"what\":\"shell\",\"criteria\":[\"render the snake canvas\"],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlan } = await import("./planner.ts");
    const { readProjectDoc } = await import("../core/git.ts");
    await runPlan({ cwd, prompt: "a neon snake game", model: null });
    expect(await readProjectDoc(cwd, "docs/design.md")).toBeNull();
    const coherence = await readProjectDoc(cwd, "docs/coherence.md");
    expect(coherence).toContain("### Visual tokens");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes NO docs/coherence.md when a surfaced plan omits the section (absent-robust)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\ncargo build\n$SMOKE\ncargo run\n$DESIGN\nGoal: a neon snake with smooth gliding.\n$END\n$ARCHITECTURE\nModules: engine.\n$END\n$TICKETS\n[{\"title\":\"Render\",\"mission\":\"m\",\"what\":\"render\",\"criteria\":[\"the snake visibly glides on the canvas\"],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlan } = await import("./planner.ts");
    const { readProjectDoc } = await import("../core/git.ts");
    await runPlan({ cwd, prompt: "a neon snake game", model: null });
    expect(await readProjectDoc(cwd, "docs/coherence.md")).toBeNull();
    // The plan-time guard warns (never fails): surface tickets exist but no charter.
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.join("\n")).toContain("Coherence contract");
    warn.mockRestore();
  });

  it("writes NO docs/coherence.md for a pure-model plan (no surface, no section)", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, "$VERIFY\nnpm run typecheck\n$SMOKE\nNONE\n$DESIGN\nA pure math library.\n$END\n$ARCHITECTURE\nModules: adder, multiplier.\n$END\n$TICKETS\n[{\"title\":\"Adder\",\"mission\":\"m\",\"what\":\"add\",\"criteria\":[\"add(2,3) is 5\"],\"blocked_by\":[]}]\n",
      );
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const { readProjectDoc } = await import("../core/git.ts");
    await runPlan({ cwd, prompt: "a math library", model: null });
    expect(await readProjectDoc(cwd, "docs/coherence.md")).toBeNull();
  });
});

describe("runPlan gate (issue #103) — implied edges auto-insert, dangling escalates", () => {
  // Consumer references greet, which Introducer introduces, but the planner
  // omitted the blocked_by edge — the gate must derive and auto-insert it.
  const IMPLIED_PLAN = '[{"title":"Introducer","mission":"m","what":"introduce","criteria":[],"blocked_by":[],"introduces":["greet"]},{"title":"Consumer","mission":"m","what":"consume","criteria":[],"blocked_by":[],"references":["greet"]}]';

  it("accepts an implied-edge-only plan with ZERO model repair calls and writes the inserted edge", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, `$VERIFY\nnpm test\n$SMOKE\nnpm start\n$TICKETS\n${IMPLIED_PLAN}\n`);
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    // design + audit + tickets; the implied edge was auto-inserted, no repair round.
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(existsSync(join(cwd, ".railhead", "plan-latest", "events", "plan-repair-1.jsonl"))).toBe(false);
    expect(result.tickets).toHaveLength(2);
    // The written tickets carry the resolved order: Consumer is blocked by Introducer.
    const consumer = result.tickets.find((t) => t.title === "Consumer")!;
    const introducer = result.tickets.find((t) => t.title === "Introducer")!;
    expect(consumer.blocked_by).toEqual([introducer.file]);
  });

  it("auto-inserts implied edges even when another class-A finding still needs judgement", async () => {
    const cwd = await freshCwd();
    // Consumer references greet (auto-insertable edge); the prompt also names
    // src/main.ts, which no ticket owns — an uncovered-file finding the model
    // must resolve. The implied edge must be inserted for free, NOT bundled into
    // the repair round.
    const MIXED = '[{"title":"Introducer","mission":"m","what":"i","criteria":[],"blocked_by":[],"introduces":["greet"]},{"title":"Consumer","mission":"m","what":"c","criteria":[],"blocked_by":[],"references":["greet"]}]';
    const FIXED = '[{"title":"Introducer","mission":"m","what":"i","criteria":[],"blocked_by":[],"introduces":["greet"],"files":["src/main.ts"]},{"title":"Consumer","mission":"m","what":"c","criteria":[],"blocked_by":[0],"references":["greet"]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: MIXED, repair: () => `$TICKETS\n${FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game with src/main.ts", model: null });
    // design + audit + tickets + one repair round (the uncovered-file alone needed it).
    expect(call).toBe(4);
    const repairPrompt = mockExec.mock.calls.map((c) => String(c[0])).find((p) => p.includes("repairing a ticket plan"))!;
    expect(repairPrompt).toContain("uncovered-file");
    expect(repairPrompt).not.toContain("unsatisfied-reference");
    expect(result.tickets).toHaveLength(2);
    const consumer = result.tickets.find((t) => t.title === "Consumer")!;
    const introducer = result.tickets.find((t) => t.title === "Introducer")!;
    expect(consumer.blocked_by).toContain(introducer.file);
  });

  it("accepts a rulings-only repair reply without re-emitting the plan", async () => {
    const cwd = await freshCwd();
    // A plan with an uncovered-file finding (the prompt names src/main.ts, no
    // ticket owns it). The model's repair reply is $RULINGS only — no $TICKETS.
    const PLAN = '[{"title":"Build","mission":"m","what":"x","criteria":[],"blocked_by":[]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, {
        tickets: PLAN,
        repair: () => "$RULINGS\nA1 intentional — src/main.ts is the scaffold entry already covered\n$END\n",
      });
      return okResult();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a tool with src/main.ts", model: null });
    expect(call).toBe(4); // design + audit + tickets + one repair round, whose ruling cleared the finding
    expect(result.tickets).toHaveLength(1);
    expect(warn.mock.calls.join("\n")).not.toContain("did not parse as tickets");
    warn.mockRestore();
  });

  it("escalates a dangling reference to a model repair round (never auto-inserted)", async () => {
    const cwd = await freshCwd();
    const DANGLING = '[{"title":"Build","mission":"m","what":"x","criteria":[],"blocked_by":[],"introduces":["real"],"references":["ghost"]}]';
    const FIXED = '[{"title":"Build","mission":"m","what":"x","criteria":[],"blocked_by":[],"introduces":["real"],"references":[]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: DANGLING, repair: () => `$TICKETS\n${FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a tool", model: null });
    // design + audit + tickets + one repair round — dangling needed the model's judgement.
    expect(call).toBe(4);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].references).toEqual([]);
  });

  it("escalates a contradictory manual edge to a model round instead of creating a cycle", async () => {
    const cwd = await freshCwd();
    // Introducer is declared blocked_by Consumer while Consumer references
    // Introducer's symbol — the implied edge contradicts the manual one.
    const CONTRADICT = '[{"title":"Introducer","mission":"m","what":"i","criteria":[],"blocked_by":[1],"introduces":["greet"]},{"title":"Consumer","mission":"m","what":"c","criteria":[],"blocked_by":[],"references":["greet"]}]';
    const FIXED = '[{"title":"Introducer","mission":"m","what":"i","criteria":[],"blocked_by":[],"introduces":["greet"]},{"title":"Consumer","mission":"m","what":"c","criteria":[],"blocked_by":[0],"references":["greet"]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: CONTRADICT, repair: () => `$TICKETS\n${FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    expect(call).toBe(4); // auto-insert declined (cycle); the model repaired it
    expect(result.tickets).toHaveLength(2);
    const consumer = result.tickets.find((t) => t.title === "Consumer")!;
    const introducer = result.tickets.find((t) => t.title === "Introducer")!;
    expect(consumer.blocked_by).toContain(introducer.file);
    expect(introducer.blocked_by).not.toContain(consumer.file);
  });
});

describe("runPlan gate (issue #103) — mutually-referencing tickets escalate, not crash", () => {
  it("two tickets each referencing the other's introduces auto-insert would cycle — the gate escalates to a repair round", async () => {
    const cwd = await freshCwd();
    // A references B's symbol and B references A's symbol; neither is ordered
    // after the other. Auto-inserting both implied edges would create a cycle,
    // so the gate must NOT crash — it escalates the unchanged plan to the model.
    const MUTUAL = '[{"title":"Alpha","mission":"m","what":"a","criteria":[],"blocked_by":[],"introduces":["greet"],"references":["other"]},{"title":"Beta","mission":"m","what":"b","criteria":[],"blocked_by":[],"introduces":["other"],"references":["greet"]}]';
    // The model breaks the cycle: Beta keeps its reference to Alpha's greet and
    // is ordered after Alpha; Alpha drops the reference to Beta's "other".
    const FIXED = '[{"title":"Alpha","mission":"m","what":"a","criteria":[],"blocked_by":[],"introduces":["greet"]},{"title":"Beta","mission":"m","what":"b","criteria":[],"blocked_by":[0],"introduces":["other"],"references":["greet"]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: MUTUAL, repair: () => `$TICKETS\n${FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    expect(call).toBe(4); // design + audit + tickets + one repair round, no crash
    expect(result.tickets).toHaveLength(2);
    // The model's fix ordered Beta after Alpha (it consumes Alpha's contract).
    const alpha = result.tickets.find((t) => t.title === "Alpha")!;
    const beta = result.tickets.find((t) => t.title === "Beta")!;
    expect(beta.blocked_by).toContain(alpha.file);
  });
});

describe("runPlan gate (ADR 0035) — mechanical defects resolve without a model round", () => {
  // The incident shape: a small planner emitted its whole plan twice inside one
  // $TICKETS array (26 tickets for a 13-ticket plan, every title doubled with
  // identical files/introduces). The pre-0035 gate raised 114 findings and
  // rejected after two repair rounds the model could not win.
  const TOOLCHAIN = '{"title":"Toolchain","mission":"m","what":"toolchain","criteria":[],"blocked_by":[],"files":["package.json"],"introduces":["npm:build","npm:test"]}';
  const WORLD = '{"title":"World constants","mission":"m","what":"world","criteria":[],"blocked_by":[0],"files":["constants.ts"],"references":["npm:build"],"introduces":["CANVAS_W"]}';
  const PIXELS = '{"title":"Pixels","mission":"m","what":"pixels","criteria":[],"blocked_by":[1],"files":["pixels.ts"],"references":["CANVAS_W"],"introduces":["drawLine"]}';
  // The echo's blocked_by values are irrelevant — the collapse drops the copies.
  const WORLD_ECHO = WORLD.replace('"blocked_by":[0]', '"blocked_by":[3]');
  const DOUBLED_PLAN = `[${TOOLCHAIN},${WORLD},${PIXELS},${TOOLCHAIN},${WORLD_ECHO},${PIXELS}]`;

  it("collapses a fully doubled plan and accepts with ZERO repair rounds", async () => {
    const cwd = await freshCwd();
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, `$VERIFY\nnpm test\n$SMOKE\nNONE\n$TICKETS\n${DOUBLED_PLAN}\n`);
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    // design + audit + tickets; no plan-repair-N phase exists.
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(existsSync(join(cwd, ".railhead", "plan-latest", "events", "plan-repair-1.jsonl"))).toBe(false);
    expect(result.tickets.map((t) => t.file)).toEqual([
      "01-toolchain.md",
      "02-world-constants.md",
      "03-pixels.md",
    ]);
    const world = result.tickets.find((t) => t.title === "World constants")!;
    expect(world.blocked_by).toEqual(["01-toolchain.md"]);
  });

  it("does NOT collapse same-title tickets with distinct content — those still get a repair round to retitle or merge", async () => {
    const cwd = await freshCwd();
    const DUP_DISTINCT = '[{"title":"Scaffold","mission":"m","what":"first","criteria":["c"],"blocked_by":[],"files":["src/a.ts"],"introduces":["a"]},{"title":"Scaffold","mission":"m","what":"second","criteria":["d"],"blocked_by":[],"files":["src/b.ts"],"introduces":["b"]}]';
    const FIXED = '[{"title":"Scaffold","mission":"m","what":"first","criteria":["c"],"blocked_by":[],"files":["src/a.ts"],"introduces":["a"]},{"title":"Scaffold walker","mission":"m","what":"second","criteria":["d"],"blocked_by":[],"files":["src/b.ts"],"introduces":["b"]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: DUP_DISTINCT, repair: () => `$TICKETS\n${FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "a game", model: null });
    expect(call).toBe(4); // distinct content escalated; the model retitled
    expect(result.tickets.map((t) => t.file)).toEqual(["01-scaffold.md", "02-scaffold-walker.md"]);
  });

  it("chains same-file editors in emission order with ZERO repair rounds", async () => {
    const cwd = await freshCwd();
    // Shell + two panels all list the app shell file but declare no references
    // (the local-model under-declaration the spriteforge run exhibited) — no
    // implied reference edge exists, so only the same-file chain orders them.
    const SHARED = '[{"title":"Shell","mission":"m","what":"shell","criteria":[],"blocked_by":[],"files":["src/main.ts","src/app.ts"],"introduces":["mountApp"]},{"title":"Canvas panel","mission":"m","what":"canvas","criteria":[],"blocked_by":[],"files":["src/canvas.ts","src/app.ts"],"introduces":["CanvasPanel"]},{"title":"Palette panel","mission":"m","what":"palette","criteria":[],"blocked_by":[],"files":["src/palette.ts","src/app.ts"],"introduces":["PalettePanel"]}]';
    mockExec.mockImplementation(async (_prompt, options) => {
      await emitStaged(options, `$VERIFY\nnpm test\n$SMOKE\nNONE\n$TICKETS\n${SHARED}\n`);
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "an editor", model: null });
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(existsSync(join(cwd, ".railhead", "plan-latest", "events", "plan-repair-1.jsonl"))).toBe(false);
    const shell = result.tickets.find((t) => t.title === "Shell")!;
    const canvas = result.tickets.find((t) => t.title === "Canvas panel")!;
    const palette = result.tickets.find((t) => t.title === "Palette panel")!;
    expect(canvas.blocked_by).toContain(shell.file);
    expect(palette.blocked_by).toEqual(expect.arrayContaining([shell.file, canvas.file]));
  });

  it("auto-resolved same-file edges never appear in the repair table — only genuine judgement calls do", async () => {
    const cwd = await freshCwd();
    // Same-file pair (auto-chained) PLUS a dangling reference (needs the model).
    const MIXED = '[{"title":"Shell","mission":"m","what":"shell","criteria":[],"blocked_by":[],"files":["src/app.ts"],"introduces":["mountApp"]},{"title":"Panel","mission":"m","what":"panel","criteria":[],"blocked_by":[],"files":["src/app.ts","src/panel.ts"],"introduces":["Panel"],"references":["ghost"]}]';
    const FIXED = '[{"title":"Shell","mission":"m","what":"shell","criteria":[],"blocked_by":[],"files":["src/app.ts"],"introduces":["mountApp"]},{"title":"Panel","mission":"m","what":"panel","criteria":[],"blocked_by":[0],"files":["src/app.ts","src/panel.ts"],"introduces":["Panel"],"references":[]}]';
    let call = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      call++;
      await emitStaged(options, { tickets: MIXED, repair: () => `$TICKETS\n${FIXED}\n` });
      return okResult();
    });
    const { runPlan } = await import("./planner.ts");
    const result = await runPlan({ cwd, prompt: "an editor", model: null });
    expect(call).toBe(4); // design + audit + tickets + one repair round for the dangling reference
    const repairPrompt = mockExec.mock.calls.map((c) => String(c[0])).find((p) => p.includes("repairing a ticket plan"))!;
    expect(repairPrompt).toContain("dangling-reference");
    expect(repairPrompt).not.toContain("unordered-same-file");
    expect(result.tickets).toHaveLength(2);
  });
});
