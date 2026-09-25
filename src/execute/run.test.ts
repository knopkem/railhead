import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendEvent, initLedger } from "../core/ledger.ts";
import { writePlanOrigin } from "../plan/plan-identity.ts";
import { createRunState } from "../core/state.ts";
import { writeTickets, toTicketState, type Ticket } from "../core/ticket.ts";
import { DEFAULT_CONFIG, resolveModels, DEFAULT_MODEL, type RailheadConfig } from "../config/config.ts";
import { CONTRACTS_FILE } from "../core/contracts.ts";
import { ensureProjectGitignore } from "../core/project-assets.ts";
import * as git from "../core/git.ts";

// run.ts drives implement/review/contracts-extract through ONE seam:
// executeOpendCode. Mocking that single function (real opencode subprocess
// runs are integration, not unit, tests — see AGENTS.md) lets every other
// piece of the orchestration — git commits, worktree cleanup, the Gate's
// retry wiring, contracts merge, state transitions — run for real against a
// real temp git repo, so these tests exercise the actual code path that
// three past incidents (stale resume state, untracked-file diffs, an
// infra-retry-forever loop — see the comments throughout run.ts) lived in.
vi.mock("./executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./executor.ts")>();
  const executeOpendCode = vi.fn();
  return {
    ...actual,
    executeOpendCode,
    // The real `executeFreshPhase` closes over the module-internal runner, so
    // routing it through the same mock is what keeps every phase invocation
    // in this suite from spawning a real opencode process. A mocked builder
    // phase that exits ok carries no checkpointTicket field; derive it from
    // the phase file (NN-NN-build) so legacy tests that script only work and
    // a DONE marker still reach the checkpoint the run loop asked for. Tests
    // that script a missing/wrong marker set checkpointTicket explicitly.
    executeFreshPhase: vi.fn(async (prompt: string, options: Parameters<typeof executeOpendCode>[1]) => {
      const r = await executeOpendCode(prompt, options);
      if (r && r.status === "ok" && /-build$/.test(options.phaseFile) && r.checkpointTicket === undefined && !r.block) {
        // Legacy tests script only work + DONE; give the mocked builder the
        // checkpoint the run loop asked for and a durable session handle, so
        // the second attempt's gate feedback rides the in-session findings
        // prompt exactly as it does in production.
        return { ...r, checkpointTicket: options.phaseFile.slice(0, 2), sessionId: r.sessionId ?? "sess-mock" };
      }
      return r;
    }),
    startPersistentWorker: vi.fn(),
    stopPersistentWorker: vi.fn(),
  };
});

import { executeOpendCode, startPersistentWorker, stopPersistentWorker } from "./executor.ts";
import { assembleBranch, detectGroupCheckpoints, nextTicketNumber, processTicket, protectedPaths, runLoop, ticketBudgetStop } from "./run.ts";
import { goalCheckpointsToFire } from "../gates/goal-loop.ts";
import { structuralCheckpointsToFire } from "../gates/structural-loop.ts";
import { clearStop, requestStop } from "./stop.ts";
import type { RunState, TicketState } from "../core/state.ts";

const mockExec = vi.mocked(executeOpendCode);
const mockStartWorker = vi.mocked(startPersistentWorker);
const mockStopWorker = vi.mocked(stopPersistentWorker);

/** Ticket store nested under .scratch/, mirroring where a real `runPlan` puts
 * it — real runs rely on that nesting (plus ensureProjectGitignore below) to
 * keep the railhead's own inputs out of the tracked tree; using a bare
 * top-level dir here would leave it untracked-but-not-ignored and make
 * `git status`-based assertions diverge from real behavior. */
async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "run-"));
  await git.initGit(dir);
  await git.ensureInitialCommit(dir);
  await ensureProjectGitignore(dir);
  return dir;
}

function ticketsDirOf(cwd: string): string {
  return join(cwd, ".scratch", "issues");
}

/** Write a single fake `text` event into a phase's ledger so extractAssistantText (called directly by run.ts) reads back the given transcript, mirroring what a real executeOpendCode call archives. */
async function emitText(ledgerDir: string, phaseFile: string, text: string): Promise<void> {
  await appendEvent(ledgerDir, phaseFile, JSON.stringify({ type: "text", part: { type: "text", text } }));
}

/** Write a fake `tool_use` event into a phase's ledger, simulating an agent
 * that called a tool. Needed for visual review tests: the evidence check
 * (checkVisualEvidence) parses the raw ledger for tool calls and downgrades
 * a $VISUAL_PASS to INCONCLUSIVE when the agent didn't run the app. */
async function emitToolUse(ledgerDir: string, phaseFile: string, tool: string, input: Record<string, unknown>): Promise<void> {
  await appendEvent(ledgerDir, phaseFile, JSON.stringify({ type: "tool_use", part: { type: "tool", tool, state: { status: "completed", input } } }));
}

function okResult(steps = 1, toolCalls = 1) {
  return { status: "ok" as const, code: 0, signal: null, errorMessage: null, durationMs: 1, steps, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls };
}

/** Identify which kind of phase a mocked executeOpendCode call represents, purely from the options run.ts passes — mirrors how a human reading the ledger would tell them apart. */
function kindOf(options: { phaseFile: string; agent?: string | null }): "base" | "review" | "contracts" | "implement" | "visual" | "test" | "goal" | "structural" | "replan" | "reconcile" | "interact" {
  // Issue #133: the base-session call is not a ticket phase — classify it so
  // scripted mocks keyed on phase kind never treat it as implement/review.
  if (options.agent === "railhead-base" || options.phaseFile === "base-session") return "base";
  if (options.agent === "railhead-review" || options.agent === "railhead-review-readmode") return "review";
  if (options.phaseFile.includes("-contracts")) return "contracts";
  if (options.phaseFile.endsWith("-visual") || options.phaseFile.startsWith("visual-")) return "visual";
  if (options.phaseFile.endsWith("-test")) return "test";
  if (options.phaseFile.endsWith("-interact")) return "interact";
  if (options.phaseFile.startsWith("goal-")) return "goal";
  if (options.phaseFile.startsWith("structural-")) return "structural";
  if (options.phaseFile.startsWith("replan-")) return "replan";
  if (options.phaseFile.endsWith("-reconcile")) return "reconcile";
  return "implement";
}

function baseConfig(overrides: Partial<RailheadConfig> = {}): RailheadConfig {
  return {
    ...DEFAULT_CONFIG,
    verify: ["true"],
    infra_backoff_sec: [],
    persistent_worker: false,
    // The per-ticket review tests exercise the working-diff gate, so default
    // code review to per-ticket `full` (issue #73); the cadence-specific
    // tests below override code_review.mode explicitly.
    code_review: { mode: "full" },
    ...overrides,
  };
}

async function makeTicket(ticketsDir: string, over: Partial<Ticket> = {}): Promise<{ ticket: Ticket; state: TicketState }> {
  const ticket: Ticket = {
    file: "01-add-greet.md",
    number: "01",
    slug: "add-greet",
    title: "Add greet",
    what: "export a greet function",
    criteria: ["exports greet"],
    ...over};
  await writeTickets(ticketsDir, [ticket]);
  return { ticket, state: toTicketState(ticket) };
}

async function makeState(cwd: string, ticketsDir: string, config: RailheadConfig): Promise<RunState> {
  const state = createRunState({
    cwd,
    branch: "run/test",
    tickets_dir: ticketsDir,
    config,
    pause_on_failure: false,
    verbose: false, quiet: false,
  });
  state._models = resolveModels(config, []);
  return state;
}

async function writeImplementedFile(cwd: string, content = "export function greet(n) { return n; }\n"): Promise<void> {
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "index.js"), content, "utf8");
}

beforeEach(() => {
  mockExec.mockReset();
  mockStartWorker.mockReset();
  mockStopWorker.mockReset();
  // A soft-stop request that landed during one test must never leak into the
  // next — the run loop clears on entry, but direct processTicket tests don't.
  clearStop();
});

describe("assembleBranch", () => {
  it("derives a run branch name from the tickets directory's parent segment", () => {
    expect(assembleBranch("/repo", "/repo/.scratch/rss-cli/issues")).toBe("run/rss-cli");
  });

  it("sanitizes non-word characters in the slug", () => {
    expect(assembleBranch("/repo", "/repo/.scratch/my cool app!/issues")).toBe("run/my-cool-app-");
  });

  it("falls back to 'tickets' when the path has no usable parent segment", () => {
    expect(assembleBranch("/repo", "issues")).toBe("run/tickets");
  });
});

describe("nextTicketNumber", () => {
  const t = (number: string): TicketState => ({ ...toTicketState({
    file: `${number}-x.md`, number, slug: "x", title: "x", what: "x", criteria: []}) });

  it("returns 1 for an empty ticket list", () => {
    expect(nextTicketNumber({ tickets: [] } as unknown as RunState)).toBe(1);
  });

  it("continues the existing numbering sequence", () => {
    const state = { tickets: [t("01"), t("02"), t("05")] } as unknown as RunState;
    expect(nextTicketNumber(state)).toBe(6);
  });
});

describe("protectedPaths", () => {
  it("protects the tickets dir's top segment plus the railhead's own runtime paths", () => {
    const paths = protectedPaths("/repo", "/repo/.scratch/proj/issues");
    expect(paths).toContain(".scratch");
    expect(paths).toContain(".railhead");
    expect(paths).toContain("railhead.json");
    expect(paths).toContain(".gitignore");
  });

  it("protects the top-level opencode.json + opencode.jsonc (untracked project config; cleanWorktree must not delete them between attempts)", () => {
    const paths = protectedPaths("/repo", "/repo/.scratch/proj/issues");
    expect(paths).toContain("opencode.json");
    expect(paths).toContain("opencode.jsonc");
  });

  it("protects AGENTS.md and CONTEXT.md (written by `railhead build`, untracked at run start, needed by every implementer)", () => {
    const paths = protectedPaths("/repo", "/repo/.scratch/proj/issues");
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("CONTEXT.md");
  });

  it("protects a tickets dir that is a direct child of cwd", () => {
    const paths = protectedPaths("/repo", "/repo/tickets");
    expect(paths).toContain("tickets");
  });
});

describe("processTicket", () => {
  it("happy path: verify + review pass first try, ticket commits, contracts update runs", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE src/index.js");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.status).toBe("committed");
    expect(ticketState.verify_ok).toBe(true);
    expect(ticketState.review_ok).toBe(true);
    expect(ticketState.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.lastCommitMessage(cwd)).toBe("01 — Add greet");
  });

  it("contracts: regex extracts greet without calling the model (model fallback skipped)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE src/index.js");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "contracts") {
        throw new Error("model contracts phase should NOT be called — regex handles .js files");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.status).toBe("committed");
    const contractsCalls = mockExec.mock.calls.filter(([, o]) => kindOf(o!) === "contracts");
    expect(contractsCalls).toHaveLength(0);
    expect(ticketState.logs.some((l) => /regex extracted/.test(l))).toBe(true);
  });

  it("contracts: model fallback runs when regex finds nothing (source file with no exports)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", "index.ts"), "const internalHelper = () => 42;\n", "utf8");
        await emitText(ledgerDir, options.phaseFile, "DONE src/index.ts");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    const contractsCalls = mockExec.mock.calls.filter(([, o]) => kindOf(o!) === "contracts");
    expect(contractsCalls).toHaveLength(1);
  });

  it("review: strips non-source files from the diff before sending it to the reviewer", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const reviewPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await writeFile(join(cwd, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewPrompts.push(prompt);
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain("src/index.js");
    expect(reviewPrompts[0]).not.toContain("package-lock.json");
  });

  it("verify failure retries with a clean worktree, then succeeds", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    // verify passes only once a marker file exists — the mock creates it on
    // the 2nd implement call, so the 1st attempt's verify must fail.
    const config = baseConfig({ verify: [`test -f ${join(cwd, "marker.txt")}`] });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let implementCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        implementCalls++;
        await writeImplementedFile(cwd, `export function greet(n){return n;} // attempt ${implementCalls}\n`);
        if (implementCalls >= 2) await writeFile(join(cwd, "marker.txt"), "ready\n", "utf8");
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.attempts).toBe(2);
    expect(ticketState.status).toBe("committed");
    expect(ticketState.logs.some((l) => /verify .*FAILED/.test(l))).toBe(true);
  });

  it("soft-passes at the attempt cap when only a repeating MAJOR finding remains", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    // Large retry/review budgets so only the small attempt cap can end the
    // loop; a repeating (non-distinct) finding never resets that budget.
    const config = baseConfig({ max_retries: 5, max_review_retries: 5, max_attempts: 2 });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[MAJOR] cosmetic gap\n$NITS\nNONE\n$OK\nmeh");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.attempts).toBe(2);
    expect(ticketState.status).toBe("committed");
    expect(ticketState.logs.some((l) => l.startsWith("soft-pass:"))).toBe(true);
  });

  it("hard-fails at the attempt cap when a BLOCKER survives, and cleans the worktree", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ max_retries: 5, max_review_retries: 5, max_attempts: 2 });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[BLOCKER] src/index.js: game crashes on load\n$NITS\nNONE\n$OK\nbroken");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("failed");
    expect(ticketState.status).toBe("failed");
    expect(ticketState.attempts).toBe(2);
    expect(ticketState.logs).toContain("FAILED: retries exhausted");
    // The worktree must be left clean — no uncommitted implementer output
    // lingering after a hard fail. (.gitignore itself legitimately stays
    // untracked here — in a real run it only gets swept into git by the
    // FIRST ticket's commit, which never happens in this scenario — so the
    // precise invariant to check is that cleanWorktree actually removed the
    // implementer's own leftover file, not a repo-wide "nothing untracked".)
    expect(existsSync(join(cwd, "src", "index.js"))).toBe(false);
  });

  it("per-ticket visual: PASS when visual_review.per_ticket is on and the reviewer returns $VISUAL_PASS", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir, { criteria: ["app renders a visible greeting on screen"] });
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\napp renders correctly");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.status).toBe("committed");
    // The per-ticket visual phase uses a `${ticket.number}-visual` ledger file —
    // distinct from end-of-run `visual-NN-review` so the two passes don't collide.
    const visualCalls = mockExec.mock.calls.filter(([, o]) => kindOf(o!) === "visual");
    expect(visualCalls).toHaveLength(1);
    expect((visualCalls[0][1] as { phaseFile: string }).phaseFile).toBe("01-visual");
  });

  it("per-ticket visual: BLOCKER generates a corrective ticket processed inline, ticket then returns ok", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir, { criteria: ["paddle responds to keyboard input"] });
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let visualCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        visualCalls++;
        if (options.phaseFile === "01-visual") {
          // Per-ticket visual on ticket 01 finds a blocker. The corrective
          // ticket 02 (generated at the end-of-run join) is testable:false,
          // so it skips per-ticket visual review (#36) — no recursion.
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_FAIL\n[BLOCKER] paddle does not move\n");
        } else {
          // End-of-run visual review passes (separate phase).
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\npaddle moves");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    // #35: the corrective ticket is generated at the join, which for a
    // single-ticket run happens at end-of-run in `runLoop` (not inside
    // `processTicket` alone). Use runLoop so the final join fires.
    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(ticketState.status).toBe("committed");
    // The corrective ticket was pushed onto state and processed.
    expect(state.tickets.length).toBe(2);
    const corrective = state.tickets[1];
    expect(corrective.status).toBe("committed");
    expect(corrective.number).toBe("02");
    // One per-ticket visual call: ticket 01 (fail). The corrective ticket 02
    // is testable:false so its per-ticket visual review is skipped (#36).
    const perTicketVisualCalls = mockExec.mock.calls.filter(
      ([, o]) => kindOf(o!) === "visual" && o!.phaseFile === "01-visual",
    );
    expect(perTicketVisualCalls).toHaveLength(1);
  });

  it("per-ticket visual: $VISUAL_PASS downgraded to INCONCLUSIVE when agent didn't run the app", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir, { criteria: ["app renders a visible greeting on screen"] });
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo check" });
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo test" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\napp renders correctly");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.status).toBe("committed");
    expect(state.visual_ok).toBe(null);
  });

  it("per-ticket visual: skipped (no visual call) when per_ticket is false even with enabled:true", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    const visualCalls = mockExec.mock.calls.filter(([, o]) => kindOf(o!) === "visual");
    expect(visualCalls).toHaveLength(0);
  });

  it("per-ticket visual: skipped when visual_review.enabled is false even with per_ticket:true", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "off" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    const visualCalls = mockExec.mock.calls.filter(([, o]) => kindOf(o!) === "visual");
    expect(visualCalls).toHaveLength(0);
  });
});

describe("runLoop", () => {
  it("runs two dependent tickets in frontier order and finishes the run", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();

    const first: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project",
      criteria: ["exists"]};
    const second: Ticket = {
      file: "02-use-greet.md", number: "02", slug: "use-greet", title: "Use greet",
      what: "call greet from main",
      criteria: ["calls greet"]};
    await writeTickets(ticketsDir, [first, second]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(first), toTicketState(second)];

    const startedSecondBeforeFirstCommitted: boolean[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        if (options.phaseFile.startsWith("02-")) {
          startedSecondBeforeFirstCommitted.push(state.tickets[0].status !== "committed");
          await mkdir(join(cwd, "src"), { recursive: true });
          await writeFile(join(cwd, "src", "main.js"), "greet('hi');\n", "utf8");
        } else {
          await writeImplementedFile(cwd);
        }
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "contracts") {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "DONE");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
    expect(startedSecondBeforeFirstCommitted).toEqual([false]);
  });

  it("stops at the ticket boundary when a halt file exists with no child running (gh #111)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(join(cwd, ".railhead", "STOP"), "environment is broken", "utf8");

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("stopped");
    expect(final.halt_reason).toBe("environment is broken");
    expect(final.tickets[0].status).not.toBe("committed");
    // The halt was caught at the boundary before any phase ran.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("stops the loop with status stopped when the implementer halts mid-phase (gh #111)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        // Simulate the agent dropping the halt file mid-phase, then the
        // executor detecting it and returning status "halted" with the reason.
        await mkdir(join(cwd, ".railhead"), { recursive: true });
        await writeFile(join(cwd, ".railhead", "STOP"), "the plan is wrong", "utf8");
        return { ...okResult(), status: "halted", haltReason: "the plan is wrong" };
      }
      await emitText(ledgerDir, options.phaseFile, "DONE");
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("stopped");
    expect(final.halt_reason).toBe("the plan is wrong");
    expect(final.tickets[0].status).not.toBe("committed");
  });

  it("end-of-run visual: inconclusive verdict leaves visual_ok null, not false", async () => {
    // A real rogueformer run had its visual reviewer killed mid-step by a
    // /tmp permission rejection before emitting any $VISUAL_* marker.
    // parseVisualVerdict correctly returns "inconclusive", but run.ts set
    // state.visual_ok = (verdict === "pass") = false BEFORE the inconclusive
    // branch, persisting the false and making the report say FAIL where it
    // should say INCONCLUSIVE. This test pins the contract: inconclusive
    // must leave visual_ok null so overview.ts renders "INCONCLUSIVE".
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        // Reviewer ran the app (evidence check passes) but emitted no
        // $VISUAL_PASS / $VISUAL_FAIL marker — the inconclusive case.
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "The app started but I was interrupted before finishing the review.");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
    expect(final.visual_rounds).toBe(1);
    expect(final.visual_ok).toBe(null);
    expect(final.visual_findings).toEqual([]);
  });

  it("end-of-run visual: $VISUAL_PASS backed only by npm run preview is downgraded to inconclusive (#58)", async () => {
    // The goty_game 02-visual transcript: the reviewer ran `npm run preview`
    // (started the dev server), never opened a browser (it was locked), fell
    // back to unit tests, and emitted $VISUAL_PASS. The evidence check counted
    // `npm run preview` as an app launch and let the verdict stand. It must be
    // downgraded: a server-start alone proves nothing was viewed.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run preview -- --port 4317" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\napp started");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Downgraded: inconclusive, so visual_ok stays null and nothing passes.
    expect(final.visual_rounds).toBe(1);
    expect(final.visual_ok).toBe(null);
    expect(final.visual_findings).toEqual([]);
  });

  it("end-of-run visual (browser-ui): a $VISUAL_PASS driven only by evaluate_script is downgraded to inconclusive (#97)", async () => {
    // The #97 shape at the visual whole-app seat: the reviewer "interacted"
    // through synthetic dispatch only (evaluate_script + screenshots), which
    // the base app-launch evidence accepts but the browser-ui real-input row
    // must not. The pass must downgrade to INCONCLUSIVE.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
      projectInterface: "browser-ui"});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_evaluate_script", { function: "() => { document.querySelector('#save').click(); }" });
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_take_screenshot", { filePath: ".railhead/visual/state.png" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\napp renders");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.visual_rounds).toBe(1);
    expect(final.visual_ok).toBe(null);
    expect(final.visual_findings).toEqual([]);
  });

  it("end-of-run visual (browser-ui): a $VISUAL_PASS backed by a real chrome-devtools input stays a PASS (#97)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
      projectInterface: "browser-ui"});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_click", { uid: "save-btn" });
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_evaluate_script", { function: "() => document.querySelector('#save').disabled" });
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_take_screenshot", { filePath: ".railhead/visual/after.png" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nsave persists state");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.visual_rounds).toBe(1);
    expect(final.visual_ok).toBe(true);
  });

  it("per-ticket visual: an inconclusive review is logged in the ticket's history, not silently passed (#59)", async () => {
    // The goty_game 01-visual review was killed by the step budget and
    // collapsed to inconclusive, but the ticket committed with NO visual
    // review entry in its logs — invisible in state.json. The inconclusive
    // outcome must be recorded.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir, { criteria: ["app renders a visible snake on screen"] });
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        // Agent ran (evidence present) but produced no $VISUAL_* marker.
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "The app started but I was interrupted before finishing the review.");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    const committed = final.tickets[0];
    expect(committed.status).toBe("committed");
    expect(committed.logs.some((l) => l.includes("inconclusive"))).toBe(true);
  });

  it("per-ticket visual: ticket 01's review completes before ticket 02's implement starts (serialized, ADR 0046)", async () => {
    // Serialization: after ticket 01 commits, its visual review runs to
    // completion inside committedTicket before the run may start ticket 02.
    // No gate runs concurrently with the builder (ADR 0022), so the reviewer
    // sees the committed worktree, never ticket 02's partial edits.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const first: Ticket = {
      file: "01-render.md", number: "01", slug: "render", title: "Render",
      what: "render the app",
      criteria: ["app renders a visible snake on screen"]};
    const second: Ticket = {
      file: "02-score.md", number: "02", slug: "score", title: "Score",
      what: "compute score",
      criteria: ["exports a computeScore function that sums points"]};
    await writeTickets(ticketsDir, [first, second]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(first), toTicketState(second)];

    let visual01Started = false;
    let visual01Completed = false;
    let implement02StartedAfterVisual01Completed = false;

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        if (options.phaseFile.startsWith("02-")) {
          // The assertion: visual-01 already completed before implement-02 ran.
          implement02StartedAfterVisual01Completed = visual01Completed;
          await mkdir(join(cwd, "src"), { recursive: true });
          await writeFile(join(cwd, "src", "score.js"), "export function computeScore() {}\n", "utf8");
        } else {
          await writeImplementedFile(cwd);
        }
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        // The per-ticket visual review of ticket 01 completes inline before
        // ticket 02 may start; end-of-run visual reviews also pass here.
        if (options.phaseFile === "01-visual") {
          visual01Started = true;
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\napp renders correctly");
          visual01Completed = true;
        } else {
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\napp renders correctly");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
    // The per-ticket visual review of ticket 01 ran exactly once, and ticket
    // 02's implement started only after it completed. (End-of-run visual
    // reviews also run but are a separate phase.)
    const perTicketVisualCalls = mockExec.mock.calls.filter(
      ([, o]) => kindOf(o!) === "visual" && o!.phaseFile === "01-visual",
    );
    expect(perTicketVisualCalls).toHaveLength(1);
    expect(visual01Started).toBe(true);
    // THE serialization assertion: no implement ran while visual 01 was open.
    expect(implement02StartedAfterVisual01Completed).toBe(true);
  });

  it("per-ticket visual: a BLOCKER on ticket 01 generates and commits its corrective before ticket 02 starts (ADR 0006)", async () => {
    // Ticket 01 commits → its visual review runs inline and finds a BLOCKER.
    // The corrective ticket is generated and committed inside ticket 01's own
    // committedTicket, BEFORE ticket 02 starts — no work stacks on a
    // known-broken visual state (ADR 0006: green at every committed step). The
    // corrective ticket is testable:false so it skips its own per-ticket
    // visual review (#36).
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const first: Ticket = {
      file: "01-render.md", number: "01", slug: "render", title: "Render",
      what: "render the app",
      criteria: ["app renders a visible snake on screen"]};
    const second: Ticket = {
      file: "02-score.md", number: "02", slug: "score", title: "Score",
      what: "compute score",
      criteria: ["exports a computeScore function that sums points"]};
    await writeTickets(ticketsDir, [first, second]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(first), toTicketState(second)];

    let ticket02Committed = false;
    let correctiveCommittedBeforeTicket02 = false;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        if (options.phaseFile.startsWith("02-")) {
          await mkdir(join(cwd, "src"), { recursive: true });
          await writeFile(join(cwd, "src", "score.js"), "export function computeScore() {}\n", "utf8");
        } else if (options.phaseFile.startsWith("03-")) {
          // Corrective ticket 03 (generated at the join).
          await writeImplementedFile(cwd);
        } else {
          await writeImplementedFile(cwd);
        }
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        if (options.phaseFile === "01-visual") {
          // Per-ticket visual on ticket 01 finds a blocker. The join at
          // committedTicket(02) generates the corrective ticket 03.
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_FAIL\n[BLOCKER] snake does not render\n");
        } else {
          // End-of-run visual review passes.
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\napp renders");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    // Track when ticket 02 commits vs when the corrective ticket commits.
    // The corrective ticket (03) must commit BEFORE ticket 02 commits.
    const final = await runLoop(state, ledgerDir);

    // Find ticket 02 and 03 in final state.
    const t02 = final.tickets.find((t) => t.number === "02")!;
    const t03 = final.tickets.find((t) => t.number === "03");
    expect(t02).toBeDefined();
    expect(t02.status).toBe("committed");
    // The corrective ticket 03 was generated and committed.
    expect(t03).toBeDefined();
    expect(t03!.status).toBe("committed");
    expect(t03!.title).toMatch(/Fix visual review finding/);
    // The run finished successfully.
    expect(final.status).toBe("finished");
  });
});

  function ts(file: string, opts: Partial<TicketState> & { group?: string } = {}): TicketState {
    return {
      file,
      title: opts.title ?? file,
      number: opts.number ?? "01",
      status: opts.status ?? "ready",
      attempts: 0,
      start_commit: null,
      commit: null,
      verify_ok: null,
      review_ok: null,
      review_attempts: 0,
      duration_ms: 0,
      reviews: [],
      group: opts.group,
      logs: [],
    };
  }

  function stateWith(tickets: TicketState[], overrides: Partial<RunState> = {}): RunState {
    const s = createRunState({
      cwd: "/tmp",
      branch: "test",
      tickets_dir: "/tmp/tickets",
      config: { ...DEFAULT_CONFIG, goal_review: { mode: "medium", fallback_cadence: 4 } } as RailheadConfig,
      pause_on_failure: false,
      verbose: false,
      quiet: false,
    });
    s.tickets = tickets;
    return { ...s, ...overrides };
  }

  /** The goal gate's view of detectGroupCheckpoints: its own `goal_reviews`
   * dedup set is the reviewed-set, mirroring goalCheckpointsToFire. */
  function fire(state: RunState, ticket: TicketState): string[] {
    return detectGroupCheckpoints(state, ticket, (state.goal_reviews ?? []).map((r) => r.group));
  }

  it("fires when the last ticket in a group commits", () => {
    const t1 = ts("01-a.md", { group: "core", status: "committed" });
    const t2 = ts("02-b.md", { group: "core", status: "committed" });
    const state = stateWith([t1, t2]);
    expect(fire(state, t2)).toEqual(["core"]);
  });

  it("does not fire when some tickets in the group are not yet committed", () => {
    const t1 = ts("01-a.md", { group: "core", status: "committed" });
    const t2 = ts("02-b.md", { group: "core", status: "ready" });
    const state = stateWith([t1, t2]);
    expect(fire(state, t1)).toEqual([]);
  });

  it("does not fire for a group that was already reviewed", () => {
    const t1 = ts("01-a.md", { group: "core", status: "committed" });
    const t2 = ts("02-b.md", { group: "core", status: "committed" });
    const state = stateWith([t1, t2], {
      goal_reviews: [{ group: "core", round: 0, verdict: "pass", findings: [] }],
    });
    expect(fire(state, t2)).toEqual([]);
  });

describe("detectGroupCheckpoints (#19)", () => {

  it("fires for a different unreviewed group when another group was already reviewed", () => {
    const t1 = ts("01-a.md", { group: "core", status: "committed" });
    const t2 = ts("02-b.md", { group: "core", status: "committed" });
    const t3 = ts("03-c.md", { group: "polish", status: "committed" });
    const state = stateWith([t1, t2, t3], {
      goal_reviews: [{ group: "core", round: 0, verdict: "pass", findings: [] }],
    });
    expect(fire(state, t3)).toEqual(["polish"]);
  });

  it("falls back to cadence when ticket has no group label", () => {
    const tickets = [
      ts("01-a.md", { number: "01", status: "committed" }),
      ts("02-b.md", { number: "02", status: "committed" }),
      ts("03-c.md", { number: "03", status: "committed" }),
      ts("04-d.md", { number: "04", status: "committed" }),
    ];
    const state = stateWith(tickets);
    expect(fire(state, tickets[3])).toEqual(["checkpoint-4"]);
  });

  it("does not fire on cadence boundary when already reviewed", () => {
    const tickets = [
      ts("01-a.md", { number: "01", status: "committed" }),
      ts("02-b.md", { number: "02", status: "committed" }),
      ts("03-c.md", { number: "03", status: "committed" }),
      ts("04-d.md", { number: "04", status: "committed" }),
    ];
    const state = stateWith(tickets, {
      goal_reviews: [{ group: "checkpoint-4", round: 0, verdict: "pass", findings: [] }],
    });
    expect(fire(state, tickets[3])).toEqual([]);
  });

  it("does not fire between cadence boundaries", () => {
    const tickets = [
      ts("01-a.md", { number: "01", status: "committed" }),
      ts("02-b.md", { number: "02", status: "committed" }),
      ts("03-c.md", { number: "03", status: "committed" }),
    ];
    const state = stateWith(tickets);
    expect(fire(state, tickets[2])).toEqual([]);
  });

  it("respects custom fallback_cadence", () => {
    const tickets = [
      ts("01-a.md", { number: "01", status: "committed" }),
      ts("02-b.md", { number: "02", status: "committed" }),
    ];
    const state = stateWith(tickets);
    state.config.goal_review = { mode: "medium", fallback_cadence: 2 };
    expect(fire(state, tickets[1])).toEqual(["checkpoint-2"]);
  });

  it("does not mix group-based and cadence-based detection", () => {
    const t1 = ts("01-a.md", { number: "01", group: "core", status: "committed" });
    const t2 = ts("02-b.md", { number: "02", group: "core", status: "committed" });
    const t3 = ts("03-c.md", { number: "03", group: "core", status: "committed" });
    const t4 = ts("04-d.md", { number: "04", group: "core", status: "committed" });
    const state = stateWith([t1, t2, t3, t4], {
      goal_reviews: [{ group: "core", round: 0, verdict: "pass", findings: [] }],
    });
    // core group already reviewed — t2 and t4 don't fire any checkpoint
    expect(fire(state, t2)).toEqual([]);
    expect(fire(state, t4)).toEqual([]);
  });

  it("fallback cadence ignores corrective tickets (no group) when the plan uses groups", () => {
    const t1 = ts("01-a.md", { number: "01", group: "core", status: "committed" });
    const t2 = ts("02-b.md", { number: "02", group: "core", status: "committed" });
    const t3 = ts("03-c.md", { number: "03", group: "core", status: "committed" });
    const t4 = ts("04-d.md", { number: "04", group: "core", status: "committed" });
    const t5 = ts("05-e.md", { number: "05", status: "committed" });
    const t6 = ts("06-f.md", { number: "06", status: "committed" });
    const t7 = ts("07-g.md", { number: "07", status: "committed" });
    const t8 = ts("08-h.md", { number: "08", status: "committed" });
    const state = stateWith([t1, t2, t3, t4, t5, t6, t7, t8], {
      goal_reviews: [{ group: "core", round: 0, verdict: "pass", findings: [] }],
    });
    // 8 committed tickets, but only 4 have groups — cadence should count
    // only the 4 grouped tickets, not the 4 corrective ones. checkpoint-4
    // was already reviewed as "core". Then t5-t8 (no group) should NOT
    // bump the count to 8 → no checkpoint-8.
    expect(fire(state, t8)).toEqual([]);
  });

  it("fallback cadence counts all tickets when no groups exist in the plan", () => {
    const tickets = [
      ts("01-a.md", { number: "01", status: "committed" }),
      ts("02-b.md", { number: "02", status: "committed" }),
      ts("03-c.md", { number: "03", status: "committed" }),
      ts("04-d.md", { number: "04", status: "committed" }),
    ];
    const state = stateWith(tickets);
    expect(fire(state, tickets[3])).toEqual(["checkpoint-4"]);
  });
});

describe("checkpoint dedup is per-gate (#107-C2)", () => {
  it("goal's record no longer suppresses the structural gate", () => {
    const t1 = ts("01-a.md", { group: "core", status: "committed" });
    const t2 = ts("02-b.md", { group: "core", status: "committed" });
    const state = stateWith([t1, t2], {
      goal_reviews: [{ group: "core", round: 0, verdict: "pass", findings: [] }],
    });
    // Goal already reviewed the group, so it won't re-fire…
    expect(goalCheckpointsToFire(state, t2)).toEqual([]);
    // …but structural, whose own record is empty, still fires.
    expect(structuralCheckpointsToFire(state, t2)).toEqual(["core"]);
  });

  it("structural's own record suppresses only the structural gate", () => {
    const t1 = ts("01-a.md", { group: "core", status: "committed" });
    const t2 = ts("02-b.md", { group: "core", status: "committed" });
    const state = stateWith([t1, t2], {
      structural_reviews: [{ group: "core", verdict: "pass", findings: [] }],
    });
    expect(structuralCheckpointsToFire(state, t2)).toEqual([]);
    expect(goalCheckpointsToFire(state, t2)).toEqual(["core"]);
  });

  it("cadence dedup is independent per gate", () => {
    const tickets = [
      ts("01-a.md", { number: "01", status: "committed" }),
      ts("02-b.md", { number: "02", status: "committed" }),
      ts("03-c.md", { number: "03", status: "committed" }),
      ts("04-d.md", { number: "04", status: "committed" }),
    ];
    const state = stateWith(tickets, {
      goal_reviews: [{ group: "checkpoint-4", round: 0, verdict: "pass", findings: [] }],
    });
    expect(goalCheckpointsToFire(state, tickets[3])).toEqual([]);
    expect(structuralCheckpointsToFire(state, tickets[3])).toEqual(["checkpoint-4"]);
  });
});

describe("RunState goal_review fields (#19)", () => {
  it("createRunState initializes goal_reviews and original_prompt", () => {
    const state = createRunState({
      cwd: "/tmp",
      branch: "test",
      tickets_dir: "/tmp/tickets",
      config: DEFAULT_CONFIG,
      pause_on_failure: false,
      verbose: false,
      quiet: false,
      original_prompt: "build a game"});
    expect(state.goal_reviews).toEqual([]);
    expect(state.original_prompt).toBe("build a game");
  });

  it("createRunState defaults original_prompt to undefined when not provided", () => {
    const state = createRunState({
      cwd: "/tmp",
      branch: "test",
      tickets_dir: "/tmp/tickets",
      config: DEFAULT_CONFIG,
      pause_on_failure: false,
      verbose: false,
      quiet: false});
    expect(state.original_prompt).toBeUndefined();
  });

  it("TicketState carries group from Ticket via toTicketState", () => {
    const ticket: Ticket = {
      file: "01-a.md",
      number: "01",
      slug: "a",
      title: "A",
      what: "do A",
      criteria: [],
      group: "core-engine"};
    const ts = toTicketState(ticket);
    expect(ts.group).toBe("core-engine");
  });

  it("toTicketState leaves group undefined when ticket has no group", () => {
    const ticket: Ticket = {
      file: "01-a.md",
      number: "01",
      slug: "a",
      title: "A",
      what: "do A",
      criteria: []};
    const ts = toTicketState(ticket);
    expect(ts.group).toBeUndefined();
  });
});

describe("goal review prompt scope (#19 — pendingDeliverables at group checkpoints)", () => {
  it("includes pending deliverables at GROUP checkpoints, not just synthetic ones", async () => {
    // The platformer-test-2 run had group-based checkpoints (core-engine,
    // gameplay, polish). The goal reviewer flagged features from the not-
    // yet-started polish group as BLOCKERs because the prompt only injected
    // pendingDeliverables at synthetic (checkpoint-N) checkpoints. This test
    // pins the contract: the "Not yet built" block must appear for group
    // checkpoints too whenever uncommitted tickets remain.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});

    const core1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project skeleton", criteria: ["project exists"], group: "core-engine"};
    const core2: Ticket = {
      file: "02-player.md", number: "02", slug: "player", title: "Player movement",
      what: "implement player movement and jumping", criteria: ["player can move and jump"], group: "core-engine"};
    const polish1: Ticket = {
      file: "03-particles.md", number: "03", slug: "particles", title: "Particle trail",
      what: "add a fading particle trail behind the player", criteria: ["particle trail visible when moving"], group: "polish"};
    await writeTickets(ticketsDir, [core1, core2, polish1]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a platformer with particle trail and screen shake";

    const goalPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        const implFile = options.phaseFile.startsWith("03-")
          ? join(cwd, "src", "particles.js")
          : join(cwd, "src", "index.js");
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(implFile, "export function feature() {}\n", "utf8");
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        goalPrompts.push(prompt);
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nlooking good so far");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    // Pre-commit ticket 01 only. When ticket 02 commits (the last in
    // core-engine), the goal review for "core-engine" fires while ticket 03
    // (polish) is still "ready" but unprocessed. That's the checkpoint where
    // pendingDeliverables must include the polish ticket.
    state.tickets = [
      { ...toTicketState(core1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(core2), status: "ready" },
      { ...toTicketState(polish1), status: "ready" },
    ];

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(goalPrompts.length).toBeGreaterThanOrEqual(1);
    // Find the goal review prompt for the "core-engine" checkpoint (the one
    // that fires when ticket 02 commits, before ticket 03 is processed).
    const coreGoalPrompt = goalPrompts.find((p) =>
      p.includes('group "core-engine"'),
    );
    expect(coreGoalPrompt).toBeDefined();
    // The pending polish ticket must appear in the "Not yet built" block —
    // without the fix, pendingDeliverables is empty for group checkpoints.
    expect(coreGoalPrompt).toContain("Particle trail");
    expect(coreGoalPrompt).toMatch(/not yet built|out of scope/i);
    // ADR 0043: no committed ticket owns a terminal state here, so the
    // required playthrough is scoped to the group — never the full loop.
    expect(coreGoalPrompt).toContain("Group playthrough");
    expect(coreGoalPrompt).not.toContain("Core-loop playthrough");
  });

  it("implementer and reviewer see contracts for files the ticket does not declare (#64)", async () => {
    // The catastrophic-handoff run: ticket 02 declared only PlayerController.ts,
    // but edited main.ts to replace BootScene with GameScene — neither the
    // implementer nor the reviewer knew BootScene existed as a contract because
    // the slice filtered to the declared files/symbols only. The fix hands over
    // the full index, so an undeclared-file contract is never invisible.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    await writeFile(join(cwd, "railhead.contracts.json"), JSON.stringify({
      schema_version: 1,
      entries: [
        { symbol: "BootScene", kind: "class", file: "src/scenes/BootScene.ts", signature: "export class BootScene extends Phaser.Scene", added_by: "01" },
        { symbol: "PlayerController", kind: "class", file: "src/player/PlayerController.ts", signature: "export class PlayerController", added_by: "02" },
      ]}, null, 2), "utf8");
    const config = baseConfig({
      model: { plan: DEFAULT_MODEL, implement: "impl-model", review: "rev-model", visual: null, goal: null, extract: null },
      // This test counts per-ticket review prompts; `medium` = per-ticket only
      // (no run-end final code pass, issue #73) keeps the count at exactly one.
      code_review: { mode: "medium" }});
    const ticket: Ticket = {
      file: "02-wire.md", number: "02", slug: "wire", title: "Wire player",
      what: "wire the player controller into the scene", criteria: ["player moves"]};
    await writeTickets(ticketsDir, [ticket]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(ticket)];

    const implementPrompts: string[] = [];
    const reviewPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement" && options.phaseFile.startsWith("02-")) {
        implementPrompts.push(prompt);
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewPrompts.push(prompt);
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(implementPrompts.length).toBe(1);
    expect(reviewPrompts.length).toBe(1);
    // BootScene is a contract in the index but lives in a file the ticket never
    // declared — the implementer (who may wire through main.ts) and the
    // reviewer (who must flag a contract/runtime drift) must both see it.
    expect(implementPrompts[0]).toContain("BootScene");
    expect(reviewPrompts[0]).toContain("BootScene");
  });

  it("goal review corrective tickets must not block on themselves", async () => {
    // platformer-test-2 ticket 09 had ``
    // — its own file. A self-blocked ticket can never enter the frontier (it
    // needs itself to be committed before it can start). This happens because
    // the dependency-injection loop at runGoalReview adds every corrective
    // file to every uncommitted ticket's blocked_by, including the corrective
    // tickets themselves.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});

    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        // Goal review for "core" group FAILs with a BLOCKER — generates a
        // corrective ticket (03-fix-...). The dependency injection must not
        // add the corrective ticket's own file to its blocked_by.
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // The corrective ticket was generated and committed.
    const corrective = final.tickets.find((t) => t.number === "03");
    expect(corrective).toBeDefined();
    expect(corrective!.status).toBe("committed");
  });

  it("ADR 0043: an unanchored [BLOCKER] generates no corrective ticket (recorded for steering only)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});

    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        // A BLOCKER with no existing artifact: no corrective ticket may be
        // generated, and the finding must still be recorded for steering.
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food and nothing suggests where it would come from\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // No corrective ticket was created from the unanchored blocker.
    expect(final.tickets.some((t) => t.number === "03")).toBe(false);
    // The finding is still recorded (steering + report).
    const recorded = (final.goal_reviews ?? []).flatMap((r) => r.findings).join("\n");
    expect(recorded).toContain("the snake has no food");
  });

  it("multiple corrective tickets from one goal review never block on each other (#63)", async () => {
    // The goty_game run generated 4 corrective tickets at once; the
    // dependency-injection loop added each corrective file to every OTHER
    // corrective ticket's blocked_by, forming a complete mutual cycle
    // (14→15→16, 15→14→16, 16→14→15) that no frontier selection could break.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});
    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n[BLOCKER] the snake has no obstacles (src/index.js)\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    const corrective = final.tickets.filter((t) => t.number === "03" || t.number === "04");
    expect(corrective.length).toBe(2);
    for (const c of corrective) {
      expect(c.status).toBe("committed");
    }
  });

  it("goal review $REPLAN marker triggers a replan, not corrective tickets (#65)", async () => {
    // The regex replan classifier missed the goty_game findings ("drift",
    // "dead code", "not wired" never matched) and the railhead generated
    // mechanical corrective tickets instead of regenerating the frontier.
    // The reviewer's explicit $REPLAN marker is now the authority.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: "plan-model", implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});

    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    let replanCalled = false;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "replan") {
        replanCalled = true;
        await emitText(ledgerDir, options.phaseFile, '$TICKETS\n[{"title":"Replanned frontier","what":"regenerated against the real architecture","criteria":["works"],"blocked_by":[],"files":[],"references":[],"introduces":[],"testable":true}]');
      } else if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        // The reviewer both asks for a replan AND offers corrective hints —
        // $REPLAN must supersede the $CORRECTIVE block.
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] Contract/runtime drift: BootScene is dead code, GameScene replaced it (src/index.js)\n$END\n\n$REPLAN\n$END\n\n$CORRECTIVE\n{\"title\":\"Corrective hint that must be ignored\",\"what\":\"fix it\",\"files\":[],\"references\":[],\"introduces\":[],\"testable\":false}\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(replanCalled).toBe(true);
    // No mechanical corrective ticket — the frontier was regenerated instead.
    expect(final.tickets.some((t) => t.title.startsWith("Goal review fix:"))).toBe(false);
    // $REPLAN superseded the $CORRECTIVE hints too (#67).
    expect(final.tickets.some((t) => t.title === "Corrective hint that must be ignored")).toBe(false);
    expect(final.tickets.some((t) => t.title === "Replanned frontier")).toBe(true);
  });

  it("ADR 0045: a replan's dependency chain is renumbered globally — the frontier is processable and both tickets commit", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: "plan-model", implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});
    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["renders the shell"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the loop", criteria: ["draws the world"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "replan") {
        // Two chained tickets: the second depends on the first.
        await emitText(ledgerDir, options.phaseFile, '$TICKETS\n[{"title":"Rebuilt renderer","what":"rebuild","criteria":["renders"],"blocked_by":[],"files":["src/render.js"],"references":[],"introduces":["render"],"testable":true},{"title":"Rebuilt world","what":"integrate","criteria":["draws"],"blocked_by":[0],"files":["src/world.js"],"references":["render"],"introduces":["world"],"testable":true}]');
      } else if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the architecture drifted (src/index.js)\n$END\n\n$REPLAN\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    const rebuilt = final.tickets.find((t) => t.title === "Rebuilt renderer")!;
    const world = final.tickets.find((t) => t.title === "Rebuilt world")!;
    // Both regenerated tickets commit in the run's global numbering.
    expect(rebuilt.status).toBe("committed");
    expect(world.status).toBe("committed");
    // The on-disk ticket file is rewritten too — its header and blocked_by
    // line carry the global numbers, not the replan-local ones.
    const worldFile = await readFile(join(ticketsDir, world.file), "utf8");
    expect(worldFile).toContain(`# ${world.number}:`);
  });

  it("goal review waits for the pending per-ticket visual review so they never share the browser concurrently (#62)", async () => {
    // Both the per-ticket visual reviewer and the goal reviewer connect to the
    // same Playwright MCP server. When ticket 02 commits (completing the
    // "core" group), the visual review completes inside committedTicket before
    // the goal checkpoint runs — otherwise the two subprocesses
    // navigate/screenshot/read each other's tabs concurrently.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "review-model", visual: "vision-model", goal: "goal-model", extract: null }});
    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake renders and moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    let visualResolve: (() => void) | null = null;
    let visualCompleted = false;
    let goalStartedBeforeVisualCompleted = false;

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual") {
        if (options.phaseFile === "02-visual") {
          // The per-ticket visual review of ticket 02 suspends until released —
          // proving the goal review does not start while it is still running.
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nsnake renders");
          await new Promise<void>((r) => { visualResolve = r; });
          visualCompleted = true;
        } else {
          await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
          await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nok");
        }
      } else if (kind === "goal") {
        goalStartedBeforeVisualCompleted = !visualCompleted;
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nlooking good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const finalPromise = runLoop(state, ledgerDir);
    // Wait until the visual review has started and suspended before releasing.
    await vi.waitFor(() => { expect(visualResolve).not.toBeNull(); });
    visualResolve!();
    const final = await finalPromise;

    expect(final.status).toBe("finished");
    // The goal review must have started only after the visual review completed.
    expect(goalStartedBeforeVisualCompleted).toBe(false);
  });

  it("structural findings WITHOUT a $REPLAN marker still generate corrective tickets and warn (#65)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: "plan-model", implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});

    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "replan") {
        // Must NOT be reached — the model emitted no $REPLAN marker.
        throw new Error("replan should not have been triggered");
      } else if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        // Clearly structural wording, but the model forgot the $REPLAN marker.
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the planned module structure assumes a single data layer but the implementation reveals two divergent repositories (src/index.js)\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Corrective tickets were generated (the fallback), not a replan.
    expect(final.tickets.some((t) => t.title.startsWith("Goal review fix:"))).toBe(true);
    // And a warning surfaced that replan was not triggered despite the
    // structural wording. (Assert before mockRestore — it clears the calls.)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("$REPLAN"));
    warn.mockRestore();
  });

  it("goal review $CORRECTIVE block generates the reviewer's tickets with files/references, not one-per-finding (#67)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});

    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        // One BLOCKER, but the reviewer decomposes it into 2 corrective tickets.
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, `$GOAL_FAIL
[BLOCKER] The running product is colored rectangles. (src/index.js)
$END

$CORRECTIVE
{"title":"Replace rectangle rendering with sprites","what":"Replace this.add.rectangle() with sprites.","files":["src/scenes/GameScene.ts"],"references":["GameScene"],"introduces":[],"testable":false}
{"title":"Add parallax depth bands","what":"Add scroll-factor layers.","files":["src/ui/ParallaxBackground.ts"],"references":["ParallaxBackground"],"introduces":[],"testable":false}
$END`);
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    const corrective = final.tickets.filter((t) => t.number === "03" || t.number === "04");
    // 2 tickets from the $CORRECTIVE block, not 1 (the blocker count).
    expect(corrective.length).toBe(2);
    expect(final.tickets.some((t) => t.title === "Replace rectangle rendering with sprites")).toBe(true);
    expect(final.tickets.some((t) => t.title === "Add parallax depth bands")).toBe(true);
    // The reviewer's corrective suggestions survived into the generated tickets.
    expect(final.tickets.some((t) => t.title === "Replace rectangle rendering with sprites")).toBe(true);
  });
});

describe("code review cadence (issue #73)", () => {
  it("light: per-ticket review runs; MAJOR gets one corrective attempt then soft-passes (#96)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      code_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const reviewPhases: string[] = [];
    let reviewCount = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewPhases.push(options.phaseFile);
        reviewCount++;
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[MAJOR] something minor is off\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Per-ticket review runs twice: the MAJOR triggers ONE corrective attempt,
    // then the still-unsatisfied MAJOR soft-passes (the run must not stall).
    expect(reviewPhases.length).toBe(2);
    expect(reviewPhases[0]).toMatch(/-01-review$/);
    expect(reviewPhases[1]).toMatch(/-02-review$/);
    expect(final.tickets[0].review_ok).toBe(true);
    expect(final.tickets[0].status).toBe("committed");
    // The spent one-shot is visible in the ticket's history as a soft-pass.
    expect(final.tickets[0].reviews[1]).toMatchObject({ blocking: false });
  });

  it("light: a [BLOCKER] naming no file in the ticket's diff is downgraded to [MAJOR] and gets one corrective attempt, never the full BLOCKER budget (#94)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      code_review: { mode: "light" },
      max_attempts: 3,
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let reviewCount = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewCount++;
        // A hallucinated blocker: the only changed path is src/index.js, and
        // this claims nothing there — the verify gate cannot refute it, so it
        // must not be allowed to burn the retry budget (ADR 0014).
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[BLOCKER] the whole approach is wrong and must be redone\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Downgraded to [MAJOR], which light mode retries exactly once then
    // soft-passes — never the whole BLOCKER budget (the claim never anchors).
    expect(reviewCount).toBe(2);
    expect(final.tickets[0].review_ok).toBe(true);
    expect(final.tickets[0].status).toBe("committed");
    // The recorded rounds carry the downgraded label with the claim's text.
    expect(final.tickets[0].reviews[0]).toMatchObject({
      blocking: true,
      findings: ["[MAJOR] the whole approach is wrong and must be redone"],
    });
    expect(final.tickets[0].reviews[1]).toMatchObject({
      blocking: false,
      findings: ["[MAJOR] the whole approach is wrong and must be redone"],
    });
    expect(final.tickets[0].logs.some((l) => /1 blocker\(s\) downgraded \(no anchor in this ticket's diff\)/.test(l))).toBe(true);
  });

  it("light: BLOCKER finding triggers retry in per-ticket review", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      code_review: { mode: "light" },
      max_attempts: 3,
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let reviewCount = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewCount++;
        if (reviewCount === 1) {
          await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[BLOCKER] src/index.js: critical issue\n$NITS\nNONE\n$OK\nok");
        } else {
          await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // BLOCKER triggered a retry; second review passed.
    expect(reviewCount).toBe(2);
    expect(final.tickets[0].review_ok).toBe(true);
  });

  it("medium: MAJOR finding triggers retry (unlike light)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      code_review: { mode: "medium" },
      max_attempts: 3,
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let reviewCount = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewCount++;
        if (reviewCount === 1) {
          await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[MAJOR] something needs fixing\n$NITS\nNONE\n$OK\nok");
        } else {
          await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // MAJOR in medium mode triggers retry (unlike light where it soft-passes).
    expect(reviewCount).toBe(2);
    expect(final.tickets[0].review_ok).toBe(true);
  });

  it("off: no per-ticket review — the gate never fires", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      code_review: { mode: "off" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const reviewPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(reviewPhases).toEqual([]);
    expect(final.tickets[0].review_ok).toBeNull();
  });

  it("light: MAJOR gets exactly ONE corrective attempt, then soft-pass if it persists", async () => {
    // spriteforge-spark ticket 06: a [MAJOR] finding (toolbar swallows pointer
    // events — real, actionable) was soft-passed under light mode with zero
    // attempts, shipping the bug. This pins the one-shot rule: light gives a
    // MAJOR one implement→verify→review round; a MAJOR still standing after
    // that round commits as a soft-pass rather than burning the whole budget.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      code_review: { mode: "light" },
      max_attempts: 8,
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let reviewCount = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewCount++;
        // The MAJOR persists across every review — it is never fixed.
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[MAJOR] toolbar swallows pointer events\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Round 1 flags the MAJOR → one retry. Round 2 still flags it → soft-pass.
    expect(reviewCount).toBe(2);
    expect(final.tickets[0].status).toBe("committed");
    expect(final.tickets[0].review_ok).toBe(true);
    // The residual finding is recorded so the run summary can name it.
    expect(final.tickets[0].logs.some((l) => l.includes("residual:") && l.includes("toolbar swallows pointer events"))).toBe(true);
  });

  it("light: a NEW major on the re-review does not extend the MAJOR retry budget", async () => {
    // #70 guardrail: the one-shot must be counted per TICKET, not per distinct
    // MAJOR. If every re-review surfaces a different MAJOR, each would claim a
    // fresh retry and recreate the medium-mode churn. Only the first MAJOR
    // round retries; the second soft-passes whatever remains.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      code_review: { mode: "light" },
      max_attempts: 8,
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let reviewCount = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewCount++;
        await emitText(ledgerDir, options.phaseFile, `$BLOCKING\n[MAJOR] distinct issue number ${reviewCount}\n$NITS\nNONE\n$OK\nok`);
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Only ONE MAJOR retry even though each round is a genuinely new finding.
    expect(reviewCount).toBe(2);
    expect(final.tickets[0].status).toBe("committed");
  });
});

describe("goal review cadence (issue #73)", () => {
  it("light: no checkpoints mid-run, but a goal review fires once at run end", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nall good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // One goal review, at run end ("goal-run-end") — not per group checkpoint.
    expect(goalPhases).toEqual(["goal-run-end"]);
    expect(final.goal_reviews?.map((r) => r.group)).toEqual(["run-end"]);
  });

  it("ADR 0044: a long group gets a mid-group goal checkpoint at the cadence ceiling", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 2 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const mk = (n: string, file: string): Ticket => ({
      file, number: n, slug: `t${n}`, title: `Ticket ${n}`,
      what: `build part ${n} that draws on the canvas`, criteria: ["renders on the canvas"], group: "big"});
    const tickets = [mk("01", "01-a.md"), mk("02", "02-b.md"), mk("03", "03-c.md"), mk("04", "04-d.md")];
    await writeTickets(ticketsDir, tickets);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a game";
    state.tickets = tickets.map((t) => toTicketState(t));

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Commit 2 hits the ceiling (2 since the last checkpoint) → synthetic
    // mid-group checkpoint; commit 4 completes the group → group checkpoint.
    expect(goalPhases).toEqual(["goal-checkpoint-2", "goal-big"]);
    expect((final.goal_reviews ?? []).map((r) => r.group)).toEqual(["checkpoint-2", "big"]);
  });

  it("ADR 0044: a group with no rendered surface skips the goal pass and is recorded", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const t1: Ticket = {
      file: "01-settings.md", number: "01", slug: "settings", title: "Settings store",
      what: "add a versioned settings store with migration", criteria: ["migrateSettings upgrades any older version"], group: "engine"};
    const t2: Ticket = {
      file: "02-save.md", number: "02", slug: "save", title: "Save store",
      what: "persist save data through the store", criteria: ["loadSave round-trips"], group: "engine"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build an app";
    state.tickets = [toTicketState(t1), { ...toTicketState(t2), status: "ready" }];

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // No goal agent ran; the checkpoint is recorded as a pass so the scheduler
    // dedupes it (and the structural gate can own this group).
    expect(goalPhases).toEqual([]);
    expect((final.goal_reviews ?? []).map((r) => r.group)).toEqual(["engine"]);
    expect((final.goal_reviews ?? [])[0].verdict).toBe("pass");
  });

  // Issue #97: a goal PASS whose only interaction was synthetic dispatch is
  // not a PASS on a declared browser-ui interface — the goal gate absorbs the
  // ADR 0009 downgrade keyed to the declared interface.
  it("browser-ui goal PASS with only evaluate_script dispatch downgrades to INCONCLUSIVE (no corrective tickets)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null },
      projectInterface: "browser-ui"});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        // The #97 reviewer: every interaction was synthetic, screenshots only.
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_evaluate_script", { function: "() => { document.querySelector('#save').click(); }" });
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_take_screenshot", { filePath: ".railhead/visual/state.png" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nall good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    const runEnd = final.goal_reviews?.find((r) => r.group === "run-end");
    expect(runEnd?.verdict).toBe("inconclusive");
    expect(runEnd?.findings[0]).toContain("evidence downgrade");
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
  });

  it("browser-ui goal PASS with a real chrome-devtools input call stays a PASS (#97)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null },
      projectInterface: "browser-ui"});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_click", { uid: "save-btn" });
        await emitToolUse(ledgerDir, options.phaseFile, "chrome-devtools_take_screenshot", { filePath: ".railhead/visual/state.png" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nall good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    const runEnd = final.goal_reviews?.find((r) => r.group === "run-end");
    expect(runEnd?.verdict).toBe("pass");
    expect(runEnd?.findings).toEqual([]);
  });

  // ADR 0029 (#102): under a plain `mode: "light"` goal gate a group boundary
  // fires nothing mid-run even in a grouped plan — the knob is what changes
  // that, so this pins the no-regression boundary before the advisory test.
  it("light WITHOUT checkpoint_action fires a corrective group checkpoint mid-run (v2 issue 01 default)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const engine: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"], group: "engine" },
      { file: "02-b.md", number: "02", slug: "b", title: "Physics", what: "physics", criteria: ["draws the world"], group: "engine" },
      { file: "03-c.md", number: "03", slug: "c", title: "Render", what: "render", criteria: ["shows the HUD"], group: "engine" },
    ];
    await writeTickets(ticketsDir, engine);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = engine.map((t) => toTicketState(t));

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nall good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // v2 issue 01: the group boundary judges and corrects inline, then the
    // run-end pass closes the run.
    expect(goalPhases).toEqual(["goal-engine", "goal-run-end"]);
    expect(final.goal_reviews?.map((r) => r.group)).toEqual(["engine", "run-end"]);
  });

  it("light + checkpoint_action advisory (ADR 0029): group boundary runs an advisory pass — records findings, zero corrective tickets, steering reaches the run-end pass", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light", checkpoint_action: "advisory" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const engine: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"], group: "engine" },
      { file: "02-b.md", number: "02", slug: "b", title: "Physics", what: "physics", criteria: ["draws the world"], group: "engine" },
      { file: "03-c.md", number: "03", slug: "c", title: "Render", what: "render", criteria: ["shows the HUD"], group: "engine" },
    ];
    await writeTickets(ticketsDir, engine);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = engine.map((t) => toTicketState(t));

    const goalPhases: string[] = [];
    const goalPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        goalPrompts.push(prompt);
        if (options.phaseFile === "goal-engine") {
          // The advisory checkpoint finds a real blocker. It must NOT create a
          // corrective ticket mid-run — it records + steers (LEARNED:/DIGEST:/
          // CHARTER: markers ride out as normal), run continues.
          await emitText(ledgerDir, options.phaseFile, [
            "$GOAL_FAIL",
            "[BLOCKER] the snake has no food (src/index.js)",
            "$END",
            "LEARNED: the food spawner timer clamps to 60fps in update",
            "DIGEST: the food spawner lives in src/food.ts",
            "CHARTER: Visual tokens: keep the neon snake palette; no flat UI",
          ].join("\n"));
        } else {
          await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nintegrated build looks right");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Advisory pass at the group boundary, then the run-end corrective pass.
    expect(goalPhases).toEqual(["goal-engine", "goal-run-end"]);
    // The group checkpoint recorded its failure advisory-only…
    const engineRec = final.goal_reviews?.find((r) => r.group === "engine");
    expect(engineRec?.advisory).toBe(true);
    expect(engineRec?.verdict).toBe("fail");
    expect(engineRec?.findings[0]).toContain("snake has no food");
    // …the run-end pass is the corrective seat (not advisory)…
    const runEndRec = final.goal_reviews?.find((r) => r.group === "run-end");
    expect(runEndRec?.advisory).toBeUndefined();
    // …and ZERO corrective tickets were generated anywhere: still exactly the
    // three planned tickets, all committed.
    expect(final.tickets).toHaveLength(3);
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
    expect(final.tickets.some((t) => t.number === "04")).toBe(false);
    // The steering channel: the advisory finding rode into the run-end pass as
    // a prior finding, so the final whole-app judge confirms it was addressed.
    const runEndPrompt = goalPrompts[goalPrompts.length - 1];
    expect(runEndPrompt).toContain("PRIOR GOAL FINDINGS");
    expect(runEndPrompt).toContain("snake has no food");
    // The advisory pass still applied the ADR 0018/0028 steering: the charter
    // amendment, the digest line, and the learning all landed on disk.
    const coherence = await readFile(join(cwd, "docs", "coherence.md"), "utf8");
    expect(coherence).toContain("neon snake palette");
    const digest = await readFile(join(cwd, ".railhead", "digest.md"), "utf8");
    expect(digest).toContain("food spawner lives in src/food.ts");
    const learnings = await readFile(join(cwd, ".railhead", "learnings.md"), "utf8");
    expect(learnings).toContain("spawner timer clamps to 60fps");
  });

  it("light + advisory (ADR 0029): the run-end pass corrects the accumulated advisory findings in ONE batch", async () => {
    // The other side of correct-once: advisory checkpoints see early and steer,
    // but the SINGLE corrective batch happens at run end. The run-end judge
    // re-raises the still-unresolved advisory blocker → one corrective ticket
    // → re-review passes. No corrective ever fired mid-run.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light", checkpoint_action: "advisory" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const engine: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"], group: "engine" },
      { file: "02-b.md", number: "02", slug: "b", title: "Physics", what: "physics", criteria: ["draws the world"], group: "engine" },
      { file: "03-c.md", number: "03", slug: "c", title: "Render", what: "render", criteria: ["shows the HUD"], group: "engine" },
    ];
    await writeTickets(ticketsDir, engine);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = engine.map((t) => toTicketState(t));

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        if (options.phaseFile === "goal-engine") {
          // Advisory checkpoint: sees the gap early, corrects nothing inline.
          await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n$END");
        } else if (options.phaseFile === "goal-run-end") {
          // The run-end corrective pass re-raises the unresolved advisory gap
          // → its corrective batch fires here, once.
          await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n$END");
        } else {
          // Round 1 of run-end: the corrective landed; the judge passes.
          await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nfood system is in");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Exactly ONE corrective ticket, generated at run end (never mid-run).
    const correctives = final.tickets.filter((t) => t.number >= "04");
    expect(correctives).toHaveLength(1);
    expect(correctives[0].status).toBe("committed");
    expect(correctives[0].title).toMatch(/Goal review fix/);
    // The advisory checkpoint never produced a ticket of its own and the
    // run-end corrective batch ran over the accumulated prior finding.
    const engineRec = final.goal_reviews?.find((r) => r.group === "engine");
    expect(engineRec?.advisory).toBe(true);
    expect(final.goal_reviews?.filter((r) => r.group === "run-end").length).toBe(2); // fail round + post-corrective pass round
  });

  it("v2 issue 01: light checkpoints are corrective-anchored by default — an anchored blocker splices a corrective inline", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" }, // no checkpoint_action: the v2 default
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const engine: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"], group: "engine" },
    ];
    await writeTickets(ticketsDir, engine);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = engine.map((t) => toTicketState(t));

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        if (options.phaseFile === "goal-engine") {
          await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n$END");
        } else {
          await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\n$END");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // The mid-run checkpoint ran corrective (not advisory) and spliced a
    // corrective ticket before the frontier; the run-end pass still fired.
    expect(goalPhases).toEqual(["goal-engine", "goal-run-end"]);
    const midRun = final.goal_reviews?.find((r) => r.group === "engine");
    expect(midRun?.advisory).toBeUndefined();
    const corrective = final.tickets.find((t) => t.number === "02");
    expect(corrective).toBeDefined();
    expect(corrective!.status).toBe("committed");
  });

  it("v2 issue 01: a run-end re-review re-runs registered probes deterministically instead of re-deriving the finding", async () => {
    // Round 0 registers a probe for its blocker. Round 1 (after the corrective
    // committed) must receive the probe's deterministic result — a PASS closes
    // the behavior — and the seat must not need to re-derive it.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const engine: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"] },
    ];
    await writeTickets(ticketsDir, engine);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = engine.map((t) => toTicketState(t));

    const goalPrompts: string[] = [];
    let goalRounds = 0;
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalRounds++;
        goalPrompts.push(prompt);
        if (goalRounds === 1) {
          await emitText(ledgerDir, options.phaseFile, [
            "$GOAL_FAIL",
            "[BLOCKER] the snake has no food (src/index.js)",
            "$END",
            "$PROBE",
            '{"behavior":"the snake eats food","command":"echo food=eaten","expect":"food=eaten"}',
            "$END",
          ].join("\n"));
        } else {
          await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\n$END");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // The probe was registered and persisted on the run state.
    expect(final.probes).toHaveLength(1);
    expect(final.probes![0]!.behavior).toBe("the snake eats food");
    expect(final.probes![0]!.group).toBe("run-end");
    // The re-review prompt carried the deterministic result, not a request to
    // re-derive: a PASS closes the behavior.
    const second = goalPrompts[1]!;
    expect(second).toContain("Registered probes");
    expect(second).toContain("[PASS] the snake eats food");
    expect(second).toMatch(/CLOSED/);
    expect(goalRounds).toBe(2);
  });

  it("v2 issue 01: a reviewer invocation that exits non-ok is infra — no green review line, and the ticket fails", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      max_attempts: 2,
      max_retries: 1,
      infra_backoff_sec: [0, 0, 0],
      code_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const t: Ticket = { file: "01-a.md", number: "01", slug: "a", title: "A", what: "a", criteria: ["renders a"] };
    await writeTickets(ticketsDir, [t]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(t)];

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    try {
      mockExec.mockImplementation(async (_prompt, options) => {
        const kind = kindOf(options);
        if (kind === "implement") {
          await writeImplementedFile(cwd);
          await emitText(ledgerDir, options.phaseFile, "DONE");
        } else if (kind === "review") {
          // The reviewer process ran but never completed: non-ok, no verdict.
          return { status: "error" as const, code: 1, signal: null, errorMessage: "step budget exhausted", durationMs: 1, steps: 1, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls: 0 };
        } else {
          await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
        }
        return okResult();
      });

      const final = await runLoop(state, ledgerDir);

      expect(final.status).toBe("failed");
      // The lie this closes: an errored review that logged "review ✓ PASS
      // (minor only)" because an empty finding set classified as minor.
      expect(logs.some((l) => /review (✓|⛔)/.test(l))).toBe(false);
      expect(logs.some((l) => /passed \(minor only\)/.test(l))).toBe(false);
      expect(final.tickets[0]!.review_ok).not.toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("v2 issue 01: interaction smoke defaults on for browser-ui, runs once at the group boundary, and blocks", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      projectInterface: "browser-ui",
      // interaction_smoke intentionally unset: the derived default turns it on.
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: null, extract: null },
    });
    const group: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "A", what: "a", criteria: ["renders a"], group: "core" },
      { file: "02-b.md", number: "02", slug: "b", title: "B", what: "b", criteria: ["renders b"], group: "core" },
    ];
    await writeTickets(ticketsDir, group);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = group.map((t) => toTicketState(t));

    const interactPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "interact") {
        interactPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, interactPhases.length === 1
          ? "$SMOKE_FAIL\n[BLOCKER] the canvas does not change after clicking New game\n$END"
          : "$SMOKE_PASS\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Never on the group's first ticket; on the boundary ticket only — twice,
    // because the blocking FAIL fed back and the retry passed.
    expect(interactPhases).toEqual(["02-01-interact", "02-02-interact"]);
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
    // The retry's $SMOKE_PASS carried no real-input/render evidence (it emitted
    // only text), so it was downgraded to inconclusive — a curl-only 200 never
    // counts as smoke evidence — yet inconclusive never fails the run.
    const ticket02 = final.tickets.find((t) => t.number === "02")!;
    expect(ticket02.logs.join("\n")).toContain("downgraded to inconclusive");
  });

  it("fails the run when a run-end goal review's corrective ticket fails (issue #120)", async () => {
    // The run-end goal review is the strict gate: a [BLOCKER] that survives the
    // corrective cycle must fail the run, not leave it "finished". Planned
    // tickets commit, the run-end judge raises a blocker, the corrective ticket
    // hard-fails its review (a real, anchored [BLOCKER] that survives the
    // attempt cap) — the run must flip to "failed".
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "full" },
      max_retries: 5,
      max_review_retries: 5,
      max_attempts: 2,
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const engine: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"], group: "engine" },
      { file: "02-b.md", number: "02", slug: "b", title: "Physics", what: "physics", criteria: ["draws the world"], group: "engine" },
      { file: "03-c.md", number: "03", slug: "c", title: "Render", what: "render", criteria: ["shows the HUD"], group: "engine" },
    ];
    await writeTickets(ticketsDir, engine);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = engine.map((t) => toTicketState(t));

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        // The corrective ticket (number 04) must produce a REAL diff so its
        // [BLOCKER] stays anchored in the change rather than being downgraded
        // to a soft-passing MAJOR (issue #94); the planned tickets write the
        // standard file.
        await writeImplementedFile(cwd, options.phaseFile.startsWith("04-") ? "// corrective patch attempt\n" : "export function greet(n) { return n; }\n");
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        if (options.phaseFile.startsWith("04-")) {
          await emitText(ledgerDir, options.phaseFile, "$BLOCKING\n[BLOCKER] src/index.js: game crashes on load\n$NITS\nNONE\n$OK\nbroken");
        } else {
          await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
        }
      } else if (kind === "goal") {
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("failed");
    const corrective = final.tickets.find((t) => t.number === "04");
    expect(corrective?.status).toBe("failed");
  });

  it("light + advisory on an unlabeled plan: the fallback_cadence synthetic checkpoint fires advisory", async () => {
    // AC: unlabeled plans fire advisory via the fallback cadence under
    // checkpoint_action: advisory (same trigger the medium/full fallback uses).
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light", checkpoint_action: "advisory", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const tickets: Ticket[] = [1, 2, 3, 4].map((n) => ({
      file: `0${n}-t.md`, number: `0${n}`, slug: `t${n}`, title: `Ticket ${n}`, what: `work ${n}`,
      blocked_by: n > 1 ? [`0${n - 1}-t.md`] : [], criteria: [`c${n}`]}));
    await writeTickets(ticketsDir, tickets);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = tickets.map((t) => toTicketState(t));

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nno drift yet");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // The synthetic checkpoint-4 fired advisory mid-run; run-end still fires.
    expect(goalPhases).toEqual(["goal-checkpoint-4", "goal-run-end"]);
    const ck4 = final.goal_reviews?.find((r) => r.group === "checkpoint-4");
    expect(ck4?.advisory).toBe(true);
    expect(final.tickets).toHaveLength(4); // no corrective tickets anywhere
  });

  it("medium: checkpoint cadence only — no end-of-run pass when no checkpoint fires", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nall good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // A single ungrouped ticket does not reach the fallback cadence (4) and
    // medium suppresses the run-end pass — no goal review should run at all.
    expect(goalPhases).toEqual([]);
  });

  it("gh #107-C2: at a group boundary with goal AND structural enabled, both gates fire — structural first", async () => {
    // Before the fix, goal ran first and recorded the group in `goal_reviews`;
    // structural then read that same record for its dedup and silently never
    // ran. Now each gate keeps its own reviewed-set, and structural (the cheap
    // code/architecture read) is ordered before the expensive browser-driving
    // goal pass.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      structural_review: { mode: "medium" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const engine: Ticket[] = [
      { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"], group: "engine" },
      { file: "02-b.md", number: "02", slug: "b", title: "Physics", what: "physics", criteria: ["draws the world"], group: "engine" },
    ];
    await writeTickets(ticketsDir, engine);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = engine.map((t) => toTicketState(t));

    const phases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        phases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nlooks good");
      } else if (kind === "structural") {
        phases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$STRUCTURAL_PASS\nclean");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(phases).toContain("structural-engine");
    expect(phases).toContain("goal-engine");
    expect(phases.indexOf("structural-engine")).toBeLessThan(phases.indexOf("goal-engine"));
    // Each gate persisted its own record.
    expect(final.goal_reviews?.some((r) => r.group === "engine")).toBe(true);
    expect(final.structural_reviews?.some((r) => r.group === "engine")).toBe(true);
  });

  it("run-end: an identical finding set two rounds in a row stops the loop instead of regenerating the same corrective tickets", async () => {
    // spriteforge run-20260907-1340: a local 27B goal reviewer echoed its own
    // injected prior-findings block verbatim for three consecutive run-end
    // rounds (including the previous round's screenshot paths), and each round
    // regenerated the same corrective $CORRECTIVE tickets — two of the three
    // commits round 2 "made" were literal no-ops reusing HEAD. The convergence
    // stop pins: one corrective cycle per identical finding set, never two.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        // Same blocker every round — the echo case.
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Two reviews: round 0 (fail → corrective 02 committed), round 1 (identical
    // findings → stop, no second corrective batch). Without the guard the loop
    // would churn identical Ticket 03 until maxRounds.
    expect(final.goal_reviews?.length).toBe(2);
    expect(final.tickets.length).toBe(2);
    expect(final.tickets[0].number).toBe("01");
    expect(final.tickets[1].number).toBe("02");
    expect(final.tickets[1].status).toBe("committed");
  });

  it("run-end: a reworded (not echoed) blocker in round 2 still generates a corrective ticket", async () => {
    // The convergence guard compares whole finding SETS after normalizing
    // screenshot paths and whitespace only — a genuinely re-derived gap must
    // still act. Otherwise the guard would mask slow-but-real progress.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light", max_rounds: 3 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let goalCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalCalls += 1;
        const blocker = goalCalls === 1
          ? "[BLOCKER] the snake has no food (src/index.js)"
          : "[BLOCKER] the snake moves but food never respawns (src/index.js)";
        await emitText(ledgerDir, options.phaseFile, `$GOAL_FAIL\n${blocker}\n$END`);
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Two distinct blockers → two corrective batches (tickets 02 and 03).
    // Round 3 (bounded by max_rounds) may or may not fire; what is pinned is
    // that round 2's different finding produced a second corrective ticket.
    expect(final.tickets.length).toBe(3);
    expect(final.tickets[2].number).toBe("03");
    expect(final.tickets[2].status).toBe("committed");
  });

  it("run-end: a blocker-less FAIL soft-passes and does not re-enter the review loop (#116)", async () => {
    // spriteforge run-20260912-1142 burned ~4 full goal-review rounds on a
    // verdict that could not change: rounds 0–2 found only [MAJOR] gaps, so
    // processCorrectiveFindings ran no corrective cycle, yet the run-end loop
    // re-reviewed while the last record was "fail". A soft-pass must end the
    // loop — only a round that committed corrective tickets warrants another.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let goalCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalCalls += 1;
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[MAJOR] cosmetic polish\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(goalCalls).toBe(1);
    expect(final.goal_reviews?.length).toBe(1);
    expect(final.goal_reviews?.[0].verdict).toBe("fail");
    expect(final.tickets).toHaveLength(1);
  });

  it("goal review $REPLAN without a [BLOCKER] still triggers a replan (#116)", async () => {
    // The sanctioned plan-correction signal was dropped when every finding was
    // MAJOR/LOW: processCorrectiveFindings returned "none" before the replan
    // hook ran. A blocker-less FAIL carrying $REPLAN must still re-invoke the
    // planner — "the plan under-scoped the goal, every individual gap is
    // minor" is exactly the shape that most needs a replan.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: "plan-model", implement: DEFAULT_MODEL, review: "review-model", visual: null, goal: "goal-model", extract: null }});

    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", criteria: ["project exists"], group: "core"};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", criteria: ["snake moves"], group: "core"};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [
      { ...toTicketState(t1), status: "committed", commit: "init", start_commit: "init" },
      { ...toTicketState(t2), status: "ready" },
    ];

    let replanCalled = false;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "replan") {
        replanCalled = true;
        await emitText(ledgerDir, options.phaseFile, '$TICKETS\n[{"title":"Replanned frontier","what":"regenerated against the real architecture","criteria":["works"],"blocked_by":[],"files":[],"references":[],"introduces":[],"testable":true}]');
      } else if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "goal") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "npm run dev" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[MAJOR] the plan under-scoped the goal; every remaining gap is minor\n$END\n\n$REPLAN\n$END");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(replanCalled).toBe(true);
    expect(final.replan_count).toBe(1);
    expect(final.tickets.some((t) => t.title.startsWith("Goal review fix:"))).toBe(false);
    expect(final.tickets.some((t) => t.title === "Replanned frontier")).toBe(true);
  });

  it("goal_review.max_replans bounds replans per run — a further $REPLAN is refused (#116)", async () => {
    // Once the plan has been re-scoped max_replans times, another $REPLAN must
    // not re-invoke the planner: the verdict degrades to corrective tickets.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "light", max_replans: 2 },
      model: { plan: "plan-model", implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];
    state.replan_count = 2;

    let replanCalled = false;
    let goalCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "replan") {
        replanCalled = true;
        throw new Error("replan should not be re-invoked past max_replans");
      } else if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        goalCalls += 1;
        if (goalCalls === 1) {
          await emitText(ledgerDir, options.phaseFile, "$GOAL_FAIL\n[BLOCKER] the snake has no food (src/index.js)\n$END\n\n$REPLAN\n$END");
        } else {
          await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nfood system is in");
        }
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(replanCalled).toBe(false);
    // The refused $REPLAN fell back to a corrective ticket, not a replan.
    expect(final.tickets.some((t) => t.title.startsWith("Goal review fix:"))).toBe(true);
    expect(final.replan_count).toBe(2);
  });
});

describe("visual review cadence (issue #73)", () => {
  it("light: no per-ticket visual kickoff, only the end-of-run loop", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const visualPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "visual") {
        visualPhases.push(options.phaseFile);
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Only the end-of-run visual phase (visual-01-review), never a per-ticket
    // (01-visual) kickoff — light defers visual review to run end.
    expect(visualPhases).toEqual(["visual-01-review"]);
    expect(final.visual_ok).toBe(true);
  });

  it("goal at run end supersedes the whole-app visual pass — visual fires nothing end-of-run (issue #97)", async () => {
    // run-20260907-2146: with goal_review light firing at run end, the visual
    // run-end pass soft-passed a build with 66 prose "findings" while the goal
    // review caught the real layout blocker. The two passes judge the same
    // whole app; goal's frame (goal + design doc) is stronger, so when the
    // goal gate fires at run end the visual run-end pass is a weaker duplicate
    // and must not also run.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      goal_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: "vision-model", goal: "goal-model", extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const visualPhases: string[] = [];
    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "visual") {
        visualPhases.push(options.phaseFile);
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nok");
      } else if (kind === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Goal owns the run-end whole-app seat; the visual run-end pass is skipped.
    expect(visualPhases).toEqual([]);
    expect(goalPhases).toEqual(["goal-run-end"]);
    expect(final.visual_ok).toBeNull();
  });

  it("visual is the whole-app seat at run end when goal review is off (issue #97)", async () => {
    // The redundancy is specifically goal-vs-visual-at-run-end. When goal is
    // off (or has no model), the visual run-end pass is the only whole-app
    // check and must still fire.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      goal_review: { mode: "off" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const visualPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "visual") {
        visualPhases.push(options.phaseFile);
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(visualPhases).toEqual(["visual-01-review"]);
    expect(final.visual_ok).toBe(true);
  });

  it("end-of-run visual: a degraded-target round is retried once with a recovery note, then passes (#96)", async () => {
    // Issue #96's incident: the round was not "couldn't run the app" — the
    // interaction target wedged into a run of ~60s request-timeout tool calls
    // and the executor's degraded-target guard killed the phase. The loop must
    // NOT end as a generic inconclusive: it retries the round with a targeted
    // note (restart the app in a fresh page) and the retried round recovers —
    // the reported spiral's actual escape was a fresh tab.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let degraded = 0;
    const retryPrompts: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "visual") {
        if (options.phaseFile === "visual-01-review") {
          degraded++;
          return { status: "degraded_target" as const, code: null, signal: "SIGTERM" as const, errorMessage: "degraded-target: 5 tool request timeouts within the last 600s — the interaction target is wedged, not merely slow; killing opencode process to end the timeout spiral", durationMs: 5, steps: 6, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls: 5 };
        }
        retryPrompts.push(_prompt);
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\npaddle moves");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(degraded).toBe(1);
    // The loop advanced to a second round with the recovery note, which passed.
    expect(final.visual_ok).toBe(true);
    expect(final.visual_rounds).toBe(2);
    expect(retryPrompts).toHaveLength(1);
    expect(retryPrompts[0]).toContain("Interaction-target recovery note");
    expect(retryPrompts[0]).toMatch(/fresh/i);
  });

  it("end-of-run visual: a SECOND degraded-target round after the note ends honestly as inconclusive — no endless retry (#96)", async () => {
    // One recovery note is worth one shot. A wedge that survives a fresh-page
    // restart is environmental (the whole tool server is down), and no further
    // note can fix it — the loop must stop as inconclusive instead of burning
    // every remaining round on the same physical wedge.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let visualCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "visual") {
        visualCalls++;
        return { status: "degraded_target" as const, code: null, signal: "SIGTERM" as const, errorMessage: "degraded-target: 5 tool request timeouts within the last 600s — the interaction target is wedged, not merely slow; killing opencode process to end the timeout spiral", durationMs: 5, steps: 6, peakTokens: 0, inFlightTokens: 0, estimateDriftTokens: 0, totalOutputTokens: 0, generationMs: 0, toolCalls: 5 };
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Exactly two visual rounds: the original + the single recovery round.
    expect(visualCalls).toBe(2);
    expect(final.visual_ok).toBeNull();
  });
});

describe("end-of-run reviews skipped on failed run", () => {
  it("does not run final code review or structural review when a ticket fails", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      max_retries: 1,
      max_attempts: 2,
      code_review: { mode: "light" },
      structural_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null },
    });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const execPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      execPhases.push(options.phaseFile);
      const kind = kindOf(options);
      if (kind === "implement") {
        // The builder exits cleanly but never emits the checkpoint marker the
        // run loop asked for, so the ticket exhausts its ladder and fails.
        await emitText(ledgerDir, options.phaseFile, "I thought about it but did not checkpoint");
        return { ...okResult(), sessionId: "sess-fail", checkpointTicket: null };
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("failed");
    expect(final.tickets[0].status).toBe("failed");
    expect(execPhases.some((p) => p.endsWith("-final-review"))).toBe(false);
    expect(execPhases.some((p) => p.startsWith("structural-"))).toBe(false);
  });
});

describe("session builder (issue #95)", () => {
  function builderOk(ticketNumber: string, session = "sess-abc123") {
    return {
      ...okResult(),
      sessionId: session,
      checkpointTicket: ticketNumber,
      inFlightTokens: 0};
  }

  /** A two-ticket linear plan (02 blocked by 01) on the same branch/dir as the
   * rest of the suite; returns state with tickets loaded. */
  async function twoTicketState(cwd: string, ticketsDir: string, config: RailheadConfig): Promise<RunState> {
    const first: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project",
      criteria: ["exists"]};
    const second: Ticket = {
      file: "02-use-greet.md", number: "02", slug: "use-greet", title: "Use greet",
      what: "call greet from main",
      criteria: ["calls greet"]};
    await writeTickets(ticketsDir, [first, second]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(first), toTicketState(second)];
    return state;
  }

  async function writeTicketFile(cwd: string, ticketFile: string): Promise<void> {
    await mkdir(join(cwd, "src"), { recursive: true });
    if (ticketFile.startsWith("01")) await writeFile(join(cwd, "src", "index.js"), "export function greet(n) { return n; }\n", "utf8");
    else await writeFile(join(cwd, "src", "main.js"), "greet('hi');\n", "utf8");
  }

  it("ticket granularity: resumes the SAME durable session across tickets, checkpointing per ticket, and records builder state", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ checkpoint_granularity: "ticket" });
    const state = await twoTicketState(cwd, ticketsDir, config);

    const buildPrompts: { prompt: string; session: string | null | undefined }[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildPrompts.push({ prompt, session: options.session });
        await writeTicketFile(cwd, options.phaseFile.slice(0, 2) === "01" ? "01" : "02");
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=" + options.phaseFile.slice(0, 2));
        return builderOk(options.phaseFile.slice(0, 2));
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.tickets.map((t) => t.number + t.status)).toEqual(["01committed", "02committed"]);
    expect(buildPrompts.map((b) => b.session)).toEqual([null, "sess-abc123"]);
    // Session continuity: the second ticket's build prompt names where the
    // build stands so the warm session does not redo committed work.
    expect(buildPrompts[1].prompt).toContain("committed through ticket 01");
    expect(buildPrompts[1].prompt).toContain("$CHECKPOINT ticket=02");
    expect(final.builder!.session_id).toBe("sess-abc123");
    expect(final.builder!.committed_through).toBe("02");
    expect(final.builder!.checkpoint_count).toBe(2);
    expect(final.builder!.last_green_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("spiral detection: a build that compacts twice without checkpointing is routed to capacity — fresh session, not an in-session resume", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ checkpoint_granularity: "ticket" });
    const state = await twoTicketState(cwd, ticketsDir, config);

    const buildSessions: (string | null | undefined)[] = [];
    const buildPrompts: string[] = [];
    let builds = 0;
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        builds++;
        buildSessions.push(options.session);
        buildPrompts.push(prompt);
        if (builds === 1) {
          // The observed spiral shape: auto-compaction markers in the stream,
          // no checkpoint — the session re-reads after each compaction instead
          // of finishing the ticket.
          await appendEvent(ledgerDir, options.phaseFile, JSON.stringify({ type: "text", part: { type: "text", text: "(compacted)", metadata: { compaction_continue: true } } }));
          await appendEvent(ledgerDir, options.phaseFile, JSON.stringify({ type: "text", part: { type: "text", text: "(compacted again)", metadata: { compaction_continue: true } } }));
          return { ...okResult(), sessionId: "sess-spiral", checkpointTicket: null };
        }
        await writeTicketFile(cwd, options.phaseFile.slice(0, 2) === "01" ? "01" : "02");
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=" + options.phaseFile.slice(0, 2));
        return builderOk(options.phaseFile.slice(0, 2));
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // The second build must be a FRESH session (the capacity verdict dropped
    // the spiraling one), not a resume of sess-spiral.
    expect(buildSessions).toEqual([null, null, "sess-abc123"]);
    expect(final.builder!.restarts.some((r) => r.cause.includes("capacity"))).toBe(true);
    // The re-driven invocation is the seeded advance — a findings prompt would
    // reference work the fresh session never wrote.
    expect(buildPrompts[1]).toContain("## Work to do");
    expect(buildPrompts[1]).not.toContain("gate found problems");
  });

  it("issue #106 (A): the FIRST advance of a fresh builder seeds full context blocks; a warm no-compaction resume sends standing pointers instead of re-injecting them", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    // Real artifacts on disk so the injection decision is observable: without
    // them both prompts are empty and this test pins nothing.
    await writeFile(join(cwd, CONTRACTS_FILE), JSON.stringify({
      schema_version: 1,
      entries: [{ symbol: "greet", kind: "function", file: "src/greet.js", signature: "greet(name) -> string", added_by: "run-x/00" }]}), "utf8");
    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(join(cwd, ".railhead", "learnings.md"), "the dev server needs a TTY on this project\n", "utf8");
    await writeFile(join(cwd, ".railhead", "digest.md"), "module map: src/ owns the world\n", "utf8");
    const config = baseConfig({ checkpoint_granularity: "ticket" });
    const state = await twoTicketState(cwd, ticketsDir, config);

    const buildPrompts: { prompt: string; session: string | null | undefined }[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildPrompts.push({ prompt, session: options.session });
        await writeTicketFile(cwd, options.phaseFile.slice(0, 2) === "01" ? "01" : "02");
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=" + options.phaseFile.slice(0, 2));
        return builderOk(options.phaseFile.slice(0, 2));
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(buildPrompts.length).toBe(2);
    expect(buildPrompts.map((b) => b.session)).toEqual([null, "sess-abc123"]);
    // Fresh seed: the full context blocks ride in.
    expect(buildPrompts[0].prompt).toContain("greet (function) @ src/greet.js");
    expect(buildPrompts[0].prompt).toContain("the dev server needs a TTY on this project");
    expect(buildPrompts[0].prompt).toContain("module map: src/ owns the world");
    // Warm resume with no observed compaction: standing pointers, not the
    // whole re-injected blocks (issue #106-A — ADR 0022 §5 demotion).
    expect(buildPrompts[1].prompt).not.toContain("greet (function) @ src/greet.js");
    expect(buildPrompts[1].prompt).not.toContain("module map: src/ owns the world");
    expect(buildPrompts[1].prompt).toContain("Shared project state (on disk)");
    expect(buildPrompts[1].prompt).toContain(".railhead/learnings.md");
    expect(buildPrompts[1].prompt).toContain(CONTRACTS_FILE);
  });

  it("issue #106 (A): a compaction observed in a committed ticket makes the NEXT warm advance re-inject the full context blocks", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    await writeFile(join(cwd, CONTRACTS_FILE), JSON.stringify({
      schema_version: 1,
      entries: [{ symbol: "greet", kind: "function", file: "src/greet.js", signature: "greet(name) -> string", added_by: "run-x/00" }]}), "utf8");
    const config = baseConfig({ checkpoint_granularity: "ticket" });
    const state = await twoTicketState(cwd, ticketsDir, config);

    const buildPrompts: { prompt: string; session: string | null | undefined }[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildPrompts.push({ prompt, session: options.session });
        await writeTicketFile(cwd, options.phaseFile.slice(0, 2) === "01" ? "01" : "02");
        // Ticket 01's build invocation compacted (the run-20260907-2146 shape:
        // a compaction event rides in the build phase's event stream).
        if (options.phaseFile.startsWith("01-")) {
          await appendEvent(ledgerDir, options.phaseFile, JSON.stringify({ type: "session.compacted", sessionID: "sess-abc123" }));
        }
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=" + options.phaseFile.slice(0, 2));
        return builderOk(options.phaseFile.slice(0, 2));
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(buildPrompts.length).toBe(2);
    // Ticket 01 compacted → needs_full_context set at its commit → ticket 02's
    // warm advance re-injects the full index instead of pointers.
    expect(buildPrompts[1].prompt).toContain("greet (function) @ src/greet.js");
  });

  it("issue #106 (A): learnings retraction still works after the injection change — a RETRACTED line from the builder removes the seeded fact even when a later advance no longer re-injects it", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    await mkdir(join(cwd, ".railhead"), { recursive: true });
    await writeFile(join(cwd, ".railhead", "learnings.md"), "the dev server panics without a TTY\n", "utf8");
    const config = baseConfig({ checkpoint_granularity: "ticket" });
    const state = await twoTicketState(cwd, ticketsDir, config);

    const buildPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildPrompts.push(prompt);
        await writeTicketFile(cwd, options.phaseFile.slice(0, 2) === "01" ? "01" : "02");
        if (options.phaseFile.startsWith("02-")) {
          // The warm session disproved the seeded learning on ticket 02 (which
          // rides the standing-pointer form, not a re-injection) and retracts
          // it — the retraction must still be applied to learnings.md.
          await emitText(ledgerDir, options.phaseFile, "RETRACTED: the dev server panics without a TTY\n$CHECKPOINT ticket=02");
        } else {
          await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=" + options.phaseFile.slice(0, 2));
        }
        return builderOk(options.phaseFile.slice(0, 2));
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    // Ticket 02's warm advance carries the standing pointer, not the content.
    expect(buildPrompts[1]).toContain(".railhead/learnings.md");
    expect(buildPrompts[1]).not.toContain("panics without a TTY");
    // The builder's RETRACTED line (parsed by pushLearnings from the build
    // transcript, unchanged by the injection cadence) removed the fact.
    const learnings = await readFile(join(cwd, ".railhead", "learnings.md"), "utf8");
    expect(learnings).not.toContain("panics without a TTY");
  });

  it("issue #106 (D): a session-lost adoption on a findings resume re-drives as the seeded advance prompt so the fresh session never gets 'your last checkpoint'", async () => {
    // Scenario: a gate fails on ticket 01's first build, so the retry resumes
    // sess-abc123 with a FINDINGS prompt. But the durable session is gone —
    // the resumed id comes back as a different session (sess-lost456). The
    // adopted fresh session must NOT be left seeded with a findings prompt
    // referencing a checkpoint it never had: runBuilderStep re-drives once as
    // the seeded advance prompt against the adopted id.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      verify: ["node -e \"require('node:fs').existsSync('ok.txt') ? process.exit(0) : process.exit(1)\""]});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const buildPrompts: string[] = [];
    let buildCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        buildPrompts.push(_prompt);
        await writeImplementedFile(cwd);
        if (buildCalls === 1) {
          // First attempt: fresh seed, checkpoints, but verify will fail (no ok.txt).
          await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
          return builderOk("01");
        }
        if (buildCalls === 2) {
          // Resume sess-abc123 (findings prompt) → session lost, opencode
          // started fresh sess-lost456. No checkpoint yet.
          return { ...okResult(), sessionId: "sess-lost456", checkpointTicket: null };
        }
        // Third call: the re-drive as a SEEDED advance against the adopted id.
        await writeFile(join(cwd, "ok.txt"), "ok", "utf8");
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return builderOk("01", "sess-lost456");
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.status).toBe("committed");
    // Attempt 1 (seed) + attempt 2 (findings→adoption) + its seeded re-drive.
    expect(buildCalls).toBe(3);
    // The re-drive prompt is a SEEDED ADVANCE (fresh-session framing), not a
    // findings prompt referencing a checkpoint the new session never had.
    expect(buildPrompts[2]).toContain("No tickets are committed yet");
    expect(buildPrompts[2]).toContain("surfaces tickets ONE AT A TIME");
    expect(buildPrompts[2]).not.toContain("gate found problems");
    expect(buildPrompts[2]).not.toContain("your last checkpoint");
    // The adopted session id is what survives for later resumptions.
    expect(state.builder!.session_id).toBe("sess-lost456");
    expect(state.builder!.restarts.some((r) => r.cause.includes("session-lost"))).toBe(true);
  });

  it("gate findings land in the SAME resumed session and drive the bounded argument loop (#70)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    // Verify only passes once ok.txt exists — the builder must be told what
    // failed and fix it IN the same session.
    const config = baseConfig({
      verify: ["node -e \"require('node:fs').existsSync('ok.txt') ? process.exit(0) : process.exit(1)\""]});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let buildCalls = 0;
    const buildSessions: (string | null | undefined)[] = [];
    const buildPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        buildSessions.push(options.session);
        buildPrompts.push(prompt);
        await writeImplementedFile(cwd);
        if (buildCalls === 2) await writeFile(join(cwd, "ok.txt"), "ok", "utf8");
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return builderOk("01");
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(buildCalls).toBe(2);
    // The findings are re-injected IN CONTEXT: the second prompt is a
    // resume input naming the verify gate, on the SAME session the first
    // invocation created.
    expect(buildSessions).toEqual([null, "sess-abc123"]);
    expect(buildPrompts[1]).toContain("verify gate found problems");
    expect(buildPrompts[1]).toContain("Verification failed");
    expect(state.builder!.committed_through).toBe("01");
  });

  it("builder-death/ok-without-checkpoint: reconcile feeds back and the SAME session is pushed to checkpoint (bounded)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ max_retries: 2 });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let buildCalls = 0;
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        prompts.push(prompt);
        await writeImplementedFile(cwd);
        if (buildCalls === 1) {
          // Exited cleanly but never checkpointed — stopped for another reason.
          await emitText(ledgerDir, options.phaseFile, "made a start but need to continue");
          return { ...okResult(), sessionId: "sess-abc123", checkpointTicket: null };
        }
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return builderOk("01");
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(buildCalls).toBe(2);
    expect(prompts[1]).toContain("expected a $CHECKPOINT ticket=01");
    expect(prompts[1]).toContain("drive it to checkpoint 01");
    expect(state.builder!.session_id).toBe("sess-abc123");
  });

  it("v2 issue 01: a hardener ticket with nothing to transcribe commits as a no-op and keeps verify green", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({});
    const hardener: Ticket = {
      file: "01-harden.md",
      number: "01",
      slug: "harden",
      title: "Harden: transcribe confirmed behaviors into the test suite",
      what: "Turn the run's confirmed behaviors into tests; if the registry is empty, make no changes.",
      criteria: ["the project's verify commands still pass"],
      group: "harden",
    };
    await writeTickets(ticketsDir, [hardener]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(hardener)];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        // The builder finds an empty probe registry and honestly makes no changes.
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return builderOk("01");
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.tickets[0]!.status).toBe("committed");
    expect(final.tickets[0]!.verify_ok).toBe(true);
    expect(final.tickets[0]!.commit).toBeTruthy();
  });

  it("v2 issue 01: a marker-less turn after a green verify counts as the checkpoint (no wasted re-invocation)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ max_retries: 2, code_review: { mode: "full" } });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let buildCalls = 0;
    let reviewCalls = 0;
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        prompts.push(prompt);
        await writeImplementedFile(cwd);
        if (buildCalls === 1) {
          await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
          return builderOk("01");
        }
        // The findings turn ends without re-emitting the marker. The ticket was
        // already verify-green, so the railhead must count it, not re-invoke.
        await emitText(ledgerDir, options.phaseFile, "fixed the finding, all green now");
        return { ...okResult(), sessionId: "sess-abc123", checkpointTicket: null };
      }
      if (kind === "review") {
        reviewCalls++;
        await emitText(ledgerDir, options.phaseFile, reviewCalls === 1
          ? "$BLOCKING\n[BLOCKER] the helper is duplicated (src/index.js)\n$NITS\nNONE\n$OK\nfix it"
          : "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(buildCalls).toBe(2);
    expect(buildCalls).toBeLessThan(3);
    expect(ticketState.logs.join("\n")).toContain("counting it as the checkpoint");
    expect(ticketState.status).toBe("committed");
  });

  it("ticket telemetry merges compactions from a no-checkpoint build attempt (run-20260907-2146)", async () => {
    // The durable builder compacts mid-ticket; the compaction usually lands in
    // an attempt that exits WITHOUT a checkpoint marker (ticket 07 of
    // run-20260907-2146: 07-01 peaked ~69.7k then compacted to ~39k, and the
    // marker-bearing 07-02 resumed from the compacted state). Reporting only
    // the successful attempt's phase file hid it as "compactions 0 / peak 39k".
    // The ticket's context must merge EVERY build phase file it wrote.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let buildCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        await writeImplementedFile(cwd);
        if (buildCalls === 1) {
          // Attempt 1: real context growth, then an auto-compaction, then a
          // resume at the lower mark — but it exits without a checkpoint.
          await appendEvent(ledgerDir, options.phaseFile, JSON.stringify({ type: "step_finish", part: { tokens: { input: 69_000, output: 100 } } }));
          await appendEvent(ledgerDir, options.phaseFile, JSON.stringify({ type: "text", timestamp: 1, part: { type: "text", text: "Continue if you have next steps.", metadata: { compaction_continue: true }, synthetic: true } }));
          await appendEvent(ledgerDir, options.phaseFile, JSON.stringify({ type: "step_finish", part: { tokens: { input: 39_000, output: 200 } } }));
          return { ...okResult(2, 2), sessionId: "sess-abc123", checkpointTicket: null };
        }
        // Attempt 2: resumed post-compaction, small context, checkpoint reached.
        await appendEvent(ledgerDir, options.phaseFile, JSON.stringify({ type: "step_finish", part: { tokens: { input: 39_500, output: 150 } } }));
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return builderOk("01");
      }
      if (kindOf(options) === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(buildCalls).toBe(2);
    // The compaction happened in the no-checkpoint attempt; the committed
    // ticket's context must report it and the true 69.7k peak, not the
    // post-compaction 39k resume window alone.
    expect(ticketState.context?.compactions).toBe(1);
    expect(ticketState.context?.peakInputTokens).toBe(69_000);
    expect(ticketState.context?.finalInputTokens).toBe(39_500);
  });

  it("a builder that keeps failing the verify gate fails the ticket — never an infinite resume", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ max_retries: 1, verify: ["false"] });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let buildCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return builderOk("01");
      }
      await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("failed");
    expect(ticketState.status).toBe("failed");
    // max_retries=1 → the loop bounds the argument loop after two verify
    // failures; the session is NOT resumed forever.
    expect(buildCalls).toBe(2);
  });

  it("product granularity: the whole 3-ticket plan in one session, checkpointing each ticket; gates interleave", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ checkpoint_granularity: "product" });
    const third: Ticket = {
      file: "03-bye.md", number: "03", slug: "bye", title: "Add bye",
      what: "add a bye",
      criteria: ["calls bye"]};
    const state = await twoTicketState(cwd, ticketsDir, config);
    state.tickets = [...state.tickets, toTicketState(third)];
    // Rebuild the on-disk ticket set to include the third (writeTickets clears).
    await writeTickets(ticketsDir, [
      { file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold", what: "set up the project", criteria: ["exists"]},
      { file: "02-use-greet.md", number: "02", slug: "use-greet", title: "Use greet", what: "call greet from main", criteria: ["calls greet"]},
      third,
    ]);

    const buildPrompts: { prompt: string; session: string | null | undefined }[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildPrompts.push({ prompt, session: options.session });
        const num = options.phaseFile.slice(0, 2);
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", `${num}.js`), "export {};\n", "utf8");
        await emitText(ledgerDir, options.phaseFile, `$CHECKPOINT ticket=${num}`);
        return builderOk(num);
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
    expect(buildPrompts.length).toBe(3);
    // ONE session across the whole build: the first invocation is fresh (no
    // id yet), every later invocation resumes the captured id; each subsequent
    // prompt is smaller (committed tickets fall out of the product unit).
    expect(buildPrompts.map((b) => b.session)).toEqual([null, "sess-abc123", "sess-abc123"]);
    // gh #105: the product prompt surfaces the CURRENT ticket only — later
    // tickets are handed over after each green checkpoint, never pre-listed
    // (which invited checkpoint jump-ahead in the run-20260909-1501 incident).
    expect(buildPrompts[0].prompt).toContain("Product mode");
    expect(buildPrompts[0].prompt).toContain("surfaces tickets ONE AT A TIME");
    expect(buildPrompts[0].prompt).toContain("01-scaffold.md");
    expect(buildPrompts[0].prompt).not.toContain("02-use-greet.md");
    expect(buildPrompts[0].prompt).not.toContain("03-bye.md");
    expect(buildPrompts[1].prompt).toContain("02-use-greet.md");
    expect(buildPrompts[1].prompt).not.toContain("01-scaffold.md");
    expect(buildPrompts[1].prompt).not.toContain("03-bye.md");
    expect(buildPrompts[2].prompt).toContain("03-bye.md");
    expect(buildPrompts[2].prompt).not.toContain("01-scaffold.md");
    expect(buildPrompts[2].prompt).not.toContain("02-use-greet.md");
    expect(final.builder!.checkpoint_count).toBe(3);
    expect(final.builder!.committed_through).toBe("03");
  });

  it("group granularity: one checkpoint + one commit per planner group, all members recorded with the group commit", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ checkpoint_granularity: "group" });
    const t01: Ticket = {
      file: "01-ui.md", number: "01", slug: "ui", title: "UI shell", group: "core",
      what: "build the shell",
      criteria: ["shell"]};
    const t02: Ticket = {
      file: "02-logic.md", number: "02", slug: "logic", title: "Logic", group: "core",
      what: "wire the logic",
      criteria: ["logic"]};
    await writeTickets(ticketsDir, [t01, t02]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(t01), toTicketState(t02)];

    const buildPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildPrompts.push(prompt);
        // The builder delivers the WHOLE group and checkpoints the LAST member.
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", "ui.js"), "export const ui = 1;\n", "utf8");
        await writeFile(join(cwd, "src", "logic.js"), "export const logic = ui;\n", "utf8");
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=02");
        return builderOk("02");
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(buildPrompts.length).toBe(1);
    expect(buildPrompts[0]).toContain("end of the whole group");
    expect(buildPrompts[0]).toContain("$CHECKPOINT ticket=02");
    const committed01 = final.tickets.find((t) => t.number === "01")!;
    const committed02 = final.tickets.find((t) => t.number === "02")!;
    expect(committed01.status).toBe("committed");
    expect(committed02.status).toBe("committed");
    // One checkpoint commit carried both members; 02's recorded commit is the
    // group commit, not a second re-implementation.
    expect(committed02.commit).toBe(committed01.commit);
    expect(committed02.logs.some((l) => l.includes("whole group was gated as one unit"))).toBe(true);
    expect(final.builder!.checkpoint_count).toBe(1);
    expect(final.builder!.committed_through).toBe("02");
    expect(await git.lastCommitMessage(cwd)).toBe("01 — UI shell");
  });

  it("issue #106 (B): the group-boundary goal review joins the pending first-member per-ticket visual first (#62 parity)", async () => {
    // The group's first member commits while members 2..N are uncommitted, so
    // committedTicket's own #62 serialization sees detectGroupCheckpoints == []
    // and leaves the first member's per-ticket visual review in flight. The
    // group-boundary goal review below drives the SAME shared browser, so it
    // must NOT start until that visual resolves — otherwise the two subprocesses
    // navigate/screenshot/read each other's tabs concurrently.
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      checkpoint_granularity: "group",
      visual_review: { mode: "full" },
      goal_review: { mode: "medium", fallback_cadence: 4 },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "review-model", visual: "vision-model", goal: "goal-model", extract: null }});
    const t1: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project", group: "core", criteria: ["snake renders in a canvas"]};
    const t2: Ticket = {
      file: "02-gameplay.md", number: "02", slug: "gameplay", title: "Gameplay",
      what: "implement the snake", group: "core", criteria: ["snake moves"]};
    await writeTickets(ticketsDir, [t1, t2]);
    const state = await makeState(cwd, ticketsDir, config);
    state.original_prompt = "build a snake game";
    state.tickets = [toTicketState(t1), toTicketState(t2)];

    let visualResolve: (() => void) | null = null;
    let visualCompleted = false;
    let goalStartedBeforeVisualCompleted = false;

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        // The group builder delivers BOTH members in one checkpoint.
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", "index.js"), "export const setup = 1;\n", "utf8");
        await writeFile(join(cwd, "src", "game.js"), "export const game = setup;\n", "utf8");
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=02");
        return builderOk("02");
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else if (kind === "visual" && options.phaseFile === "01-visual") {
        // The first member's per-ticket visual review suspends until released —
        // proving the group-boundary goal review does not start while it runs.
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nsnake renders");
        await new Promise<void>((r) => { visualResolve = r; });
        visualCompleted = true;
      } else if (kind === "visual") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nok");
      } else if (kind === "goal") {
        goalStartedBeforeVisualCompleted = !visualCompleted;
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nlooking good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const finalPromise = runLoop(state, ledgerDir);
    await vi.waitFor(() => { expect(visualResolve).not.toBeNull(); });
    visualResolve!();
    const final = await finalPromise;

    expect(final.status).toBe("finished");
    expect(final.tickets.every((t) => t.status === "committed")).toBe(true);
    // The goal review must have started only after the first member's per-ticket
    // visual review completed (browser serialization, #62 parity at the boundary).
    expect(goalStartedBeforeVisualCompleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gh #105 (ADR 0032): spec-anchored reconciliation. A red verify whose output
// names a file this phase authored triggers a bounded fresh-arbiter phase that
// rules against the human plan origin prompt; the railhead applies a `test`
// verdict's FILE-block edits and re-verifies once. These tests drive the real
// git/verify plumbing (executeOpendCode mocked at the ONE seam) so the wiring —
// attribution, one-shot spending, the re-verify green path, and the blame
// preamble on retry feedback — is exercised end to end.
// ---------------------------------------------------------------------------
describe("spec-anchored reconciliation (gh #105)", () => {
  const SPEC = "A greetable CLI: greet() returns the string GREET_OK for any input name.";
  /** Verify command that fails (naming src/index.js) until the file contains
   * GREET_OK — the classic unsatisfiable-test shape a real verify would model
   * as a failing assertion on a file the phase itself wrote. */
  const greetVerify = (cwd: string): string =>
    `node -e "const fs=require('fs'); const s=fs.readFileSync('src/index.js','utf8'); if(!s.includes('GREET_OK')){ console.error('src/index.js:2:1 Error: deep mismatch — expected GREET_OK in greet()'); process.exit(1);} "`;

  /** Stand-in for the implementer/arbiter emitting its reply as assistant text. */
  function goodImpl(cwd: string): Promise<void> {
    return writeImplementedFile(cwd, "export function greet(){ return 'GREET_OK'; }\n");
  }
  function badImpl(cwd: string): Promise<void> {
    return writeImplementedFile(cwd, "export function greet(){ return 'wrong'; }\n");
  }

  async function writeSpec(cwd: string, ticketsDir: string): Promise<void> {
    await mkdir(join(ticketsDir, ".."), { recursive: true });
    await writePlanOrigin(join(ticketsDir, ".."), {
      slug: "greeter",
      prompt: SPEC,
      created_at: new Date().toISOString(),
      ticket_files: ["01-add-greet.md"],
    });
  }

  it("a test-verdict fix that greens the re-verify proceeds to smoke/review with counters untouched and the fix recorded", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    await writeSpec(cwd, ticketsDir);
    const config = baseConfig({ verify: [greetVerify(cwd)] });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let implementCalls = 0;
    let reconcileCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "reconcile") {
        reconcileCalls++;
        await emitText(
          ledgerDir,
          options.phaseFile,
          [
            "$RECONCILE_TEST",
            "1. the spec says greet() must return GREET_OK — the test asserts it, the impl never will",
            "=== FILE: src/index.js ===",
            "export function greet(){ return 'GREET_OK'; }",
            "=== END FILE ===",
            "$RECONCILE_END",
          ].join("\n"),
        );
        return okResult();
      }
      if (kind === "implement") {
        implementCalls++;
        await badImpl(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
        return okResult();
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
        return okResult();
      }
      await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.status).toBe("committed");
    // The reconcile-green round never reached the gate machine: one implement,
    // one reconcile, no verify_failed retry.
    expect(implementCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
    expect(ticketState.attempts).toBe(1);
    expect(ticketState.reconcile).toEqual({
      verdict: "test",
      findings: ["the spec says greet() must return GREET_OK — the test asserts it, the impl never will"],
      applied: ["src/index.js"],
    });
    expect(ticketState.logs.some((l) => l.includes("railhead applied test fixes to src/index.js") && l.includes("re-verify green"))).toBe(true);
    // The applied fix is on disk (the arbiter's correction, railhead-written).
    expect((await readFile(join(cwd, "src", "index.js"), "utf8")).includes("GREET_OK")).toBe(true);
    // writeState persisted the one-shot record — a resume cannot re-spend it.
    const saved = JSON.parse(await readFile(join(ledgerDir, "state.json"), "utf8"));
    expect(saved.tickets[0].reconcile).toMatchObject({ verdict: "test", applied: ["src/index.js"] });
  });

  it("an impl verdict takes the ordinary retry path with the reconcile findings prepended to the feedback, spending exactly one reconcile", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    await writeSpec(cwd, ticketsDir);
    const config = baseConfig({ verify: [greetVerify(cwd)] });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let implementCalls = 0;
    let reconcileCalls = 0;
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "reconcile") {
        reconcileCalls++;
        await emitText(
          ledgerDir,
          options.phaseFile,
          [
            "$RECONCILE_IMPL",
            "1. the spec says greet() returns GREET_OK — the implementation returns the input name verbatim",
            "$RECONCILE_END",
          ].join("\n"),
        );
        return okResult();
      }
      if (kind === "implement") {
        implementCalls++;
        prompts.push(prompt);
        if (implementCalls >= 2) await goodImpl(cwd);
        else await badImpl(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
        return okResult();
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
        return okResult();
      }
      await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.attempts).toBe(2);
    expect(reconcileCalls).toBe(1);
    expect(ticketState.reconcile).toEqual({
      verdict: "impl",
      findings: ["the spec says greet() returns GREET_OK — the implementation returns the input name verbatim"],
      applied: [],
    });
    // The second implementer's feedback carries the arbiter's ruling and the
    // blame preamble naming the file this phase authored.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("ruled the IMPLEMENTATION wrong");
    expect(prompts[1]).toContain("the implementation returns the input name verbatim");
    expect(prompts[1]).toContain("failing verify output names files this phase authored");
    expect(prompts[1]).toContain("src/index.js");
  });

  it("a test verdict whose applied fix stays red takes the ordinary retry path with the reconcile findings prepended", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    await writeSpec(cwd, ticketsDir);
    const config = baseConfig({ verify: [greetVerify(cwd)] });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let implementCalls = 0;
    let reconcileCalls = 0;
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "reconcile") {
        reconcileCalls++;
        // The arbiter rules the TEST wrong and "corrects" it — but its content
        // is still wrong (no GREET_OK), so the railhead re-verify stays red.
        await emitText(
          ledgerDir,
          options.phaseFile,
          [
            "$RECONCILE_TEST",
            "1. the test compares the k-th undo() to chain[k] but the spec's undo returns the prior doc (chain[k-1])",
            "=== FILE: src/index.js ===",
            "export function greet(){ return 'still wrong'; }",
            "=== END FILE ===",
            "$RECONCILE_END",
          ].join("\n"),
        );
        return okResult();
      }
      if (kind === "implement") {
        implementCalls++;
        prompts.push(prompt);
        if (implementCalls >= 2) await goodImpl(cwd);
        else await badImpl(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
        return okResult();
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
        return okResult();
      }
      await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.attempts).toBe(2);
    expect(reconcileCalls).toBe(1);
    expect(ticketState.reconcile).toMatchObject({ verdict: "test", applied: ["src/index.js"] });
    expect(prompts[1]).toContain("ruled the TEST this phase authored wrong");
    expect(prompts[1]).toContain("chain[k-1]");
    expect(prompts[1]).toContain("failing verify output names files this phase authored");
  });

  it("a run whose plan directory has no origin.json skips the reconciliation silently but still carries the blame preamble", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    // NOTE: no origin.json is written — the spec source is absent.
    const config = baseConfig({ verify: [greetVerify(cwd)] });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let implementCalls = 0;
    let reconcileCalls = 0;
    const prompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (kind === "reconcile") reconcileCalls++;
      if (kind === "implement") {
        implementCalls++;
        prompts.push(prompt);
        if (implementCalls >= 2) await goodImpl(cwd);
        else await badImpl(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
        return okResult();
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
        return okResult();
      }
      await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    // No spec → the reconciliation never ran (no throw), yet the blame-aware
    // preamble still reaches the retrying implementer.
    expect(reconcileCalls).toBe(0);
    expect(ticketState.reconcile).toBeUndefined();
    expect(prompts[1]).toContain("failing verify output names files this phase authored");
    expect(prompts[1]).toContain("src/index.js");
  });

  it("builder GateFeedback composition carries the blame preamble on a verify-failure retry", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ verify: [greetVerify(cwd)] });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    let buildCalls = 0;
    const buildPrompts: string[] = [];
    mockExec.mockImplementation(async (prompt, options) => {
      const kind = kindOf(options);
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        buildPrompts.push(prompt);
        if (buildCalls >= 2) await goodImpl(cwd);
        else await badImpl(cwd);
        await emitText(ledgerDir, options.phaseFile, `$CHECKPOINT ticket=01`);
        return { ...okResult(), sessionId: "sess-r", checkpointTicket: "01", inFlightTokens: 0 };
      }
      if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
        return okResult();
      }
      await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.attempts).toBe(2);
    // The verify-failure feedback flows into buildBuilderFindingsPrompt's
    // GateFeedback — the preamble names the file the builder's own phase wrote.
    expect(buildPrompts[1]).toContain("failing verify output names files this phase authored");
    expect(buildPrompts[1]).toContain("src/index.js");
    expect(buildPrompts[1]).toContain("Verification failed");
  });
});



describe("graceful stop — soft Ctrl-C", () => {
  it("finishes the ticket in flight's whole gate, then stops before the next ticket", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();

    const first: Ticket = {
      file: "01-scaffold.md", number: "01", slug: "scaffold", title: "Scaffold",
      what: "set up the project",
      criteria: ["exists"]};
    const second: Ticket = {
      file: "02-use-greet.md", number: "02", slug: "use-greet", title: "Use greet",
      what: "call greet from main",
      criteria: ["calls greet"]};
    await writeTickets(ticketsDir, [first, second]);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [toTicketState(first), toTicketState(second)];

    const reviewPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        // The operator presses Ctrl-C once while ticket 01 is being built.
        if (options.phaseFile.startsWith("01-")) requestStop();
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        reviewPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    // The first ticket's gate completed despite the request — verify + review
    // + commit all ran — and only then did the run stop.
    expect(final.status).toBe("stopped");
    expect(final.stop_reason).toContain("01");
    expect(final.tickets[0].status).toBe("committed");
    expect(reviewPhases).toEqual(["01-01-review"]);
    // The next ticket was never touched: resume starts there.
    expect(final.tickets[1].status).toBe("ready");
    const secondPhases = mockExec.mock.calls.filter(([, o]) => o!.phaseFile.startsWith("02-"));
    expect(secondPhases).toHaveLength(0);
  });

  it("clears a stale request armed before the loop starts (it must not stop the new run)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    // A request that arrived between two runs in the same process (e.g. during
    // planning before an auto-started run) must not stop the next run.
    requestStop();

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.stop_reason).toBeNull();
    expect(final.tickets[0].status).toBe("committed");
  });

  it("completes the per-ticket visual review before stopping (nothing owed)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "full" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir, { criteria: ["app renders a visible greeting on screen"] });
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        requestStop();
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "visual") {
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nrenders");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("stopped");
    // The per-ticket visual review runs before the boundary stop — nothing is
    // left owed.
    const visualCalls = mockExec.mock.calls.filter(([, o]) => kindOf(o!) === "visual" && o!.phaseFile === "01-visual");
    expect(visualCalls).toHaveLength(1);
    expect(final.visual_pending).toBeNull();
  });

  it("stops between end-of-run passes when a soft stop lands during one", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "light" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "vision-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const { state: ticketState } = await makeTicket(ticketsDir, { criteria: ["app renders a visible greeting on screen"] });
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    const visualPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "visual") {
        visualPhases.push(options.phaseFile);
        // The request arrives while the end-of-run visual pass is running.
        requestStop();
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nrenders");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(visualPhases).toEqual(["visual-01-review"]);
    expect(final.status).toBe("stopped");
    expect(final.stop_reason).toContain("end-of-run visual pass");
    expect(final.visual_rounds).toBe(1);
    expect(final.tickets[0].status).toBe("committed");
  });
});

describe("owed-gate replay on resume", () => {
  const engineTickets = (): Ticket[] => [
    { file: "01-a.md", number: "01", slug: "a", title: "Scaffold", what: "scaffold", criteria: ["renders the scene"], group: "engine" },
    { file: "02-b.md", number: "02", slug: "b", title: "Physics", what: "physics", criteria: ["draws the world"], group: "engine" },
  ];

  async function committedState(cwd: string, ticketsDir: string, config: RailheadConfig): Promise<RunState> {
    const parsed = engineTickets();
    await writeTickets(ticketsDir, parsed);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = parsed.map(toTicketState);
    for (const t of state.tickets) {
      t.status = "committed";
      t.commit = "abc123";
      t.verify_ok = true;
      t.review_ok = true;
    }
    return state;
  }

  it("replays a goal checkpoint the run committed past but never ran", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const state = await committedState(cwd, ticketsDir, config);
    // The prior process stopped after the group's last commit but before the
    // checkpoint gate could record.
    state.pending_checkpoints = { goal: ["engine"], structural: [] };

    const goalPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      if (kindOf(options) === "goal") {
        goalPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nall good");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(goalPhases).toEqual(["goal-engine"]);
    expect(final.goal_reviews?.map((r) => r.group)).toEqual(["engine"]);
    expect(final.pending_checkpoints?.goal).toEqual([]);
    expect(final.status).toBe("finished");
  });

  it("replays a structural checkpoint the run committed past but never ran", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      structural_review: { mode: "medium" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const state = await committedState(cwd, ticketsDir, config);
    state.pending_checkpoints = { goal: [], structural: ["engine"] };

    const structuralPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      if (kindOf(options) === "structural") {
        structuralPhases.push(options.phaseFile);
        await emitText(ledgerDir, options.phaseFile, "$STRUCTURAL_PASS\nclean");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(structuralPhases).toEqual(["structural-engine"]);
    expect(final.structural_reviews?.map((r) => r.group)).toEqual(["engine"]);
    expect(final.pending_checkpoints?.structural).toEqual([]);
    expect(final.status).toBe("finished");
  });

  it("leaves no pending markers behind when the checkpoint gate runs to completion", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});

    // This time the run actually processes the group: the commit marks the
    // checkpoint owed, the gate runs, and the marker is cleared.
    const parsed = engineTickets();
    await writeTickets(ticketsDir, parsed);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = parsed.map(toTicketState);

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else if (kind === "goal") {
        await emitText(ledgerDir, options.phaseFile, "$GOAL_PASS\nall good");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(final.status).toBe("finished");
    expect(final.goal_reviews?.map((r) => r.group)).toEqual(["engine"]);
    expect(final.pending_checkpoints).toEqual({ goal: [], structural: [] });
  });

  it("drops a pending checkpoint the gate already recorded (crash between record and clear)", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      goal_review: { mode: "medium" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: null, goal: "goal-model", extract: null }});
    const state = await committedState(cwd, ticketsDir, config);
    state.pending_checkpoints = { goal: ["engine"], structural: [] };
    state.goal_reviews = [{ group: "engine", round: 0, verdict: "pass", findings: [] }];

    let goalCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (kindOf(options) === "goal") goalCalls++;
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    // The record is the dedup — the marker is dropped without re-reviewing.
    expect(goalCalls).toBe(0);
    expect(final.pending_checkpoints?.goal).toEqual([]);
  });

  it("replays a per-ticket visual review the run committed past but never joined", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({
      visual_review: { mode: "medium" },
      model: { plan: DEFAULT_MODEL, implement: DEFAULT_MODEL, review: "rev-model", visual: DEFAULT_MODEL, goal: null, extract: null }});
    const { ticket, state: ticketState } = await makeTicket(ticketsDir, { criteria: ["app renders a visible greeting on screen"] });
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];
    ticketState.status = "committed";
    ticketState.commit = "abc123";
    ticketState.verify_ok = true;
    ticketState.review_ok = true;
    state.visual_pending = ticket.file;

    const visualPhases: string[] = [];
    mockExec.mockImplementation(async (_prompt, options) => {
      if (kindOf(options) === "visual") {
        visualPhases.push(options.phaseFile);
        await emitToolUse(ledgerDir, options.phaseFile, "bash", { command: "cargo run" });
        await emitText(ledgerDir, options.phaseFile, "$VISUAL_PASS\nrenders");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);

    expect(visualPhases).toEqual(["01-visual"]);
    expect(final.visual_pending).toBeNull();
    expect(final.status).toBe("finished");
  });
});

describe("ADR 0040 — blocked exit and per-ticket budget", () => {
  async function blockedRepo(configOverrides: Partial<RailheadConfig> = {}) {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({ ...configOverrides });
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];
    const buildPrompts: string[] = [];
    const blockResult = (kind: string, reason: string) => ({
      ...okResult(),
      sessionId: "sess-abc123",
      block: { ticket: "01", kind, reason, malformedKind: false },
    });
    const checkpointOk = () => {
      // Emit the marker text so extractAssistantText-backed bookkeeping sees a
      // clean checkpoint; the mocked result carries it directly.
      return { ...okResult(), sessionId: "sess-abc123", checkpointTicket: "01" };
    };
    return { cwd, ticketsDir, ledgerDir, ticketState, state, buildPrompts, blockResult, checkpointOk };
  }

  it("verification-unavailable: records the criterion as unverified, still runs the gates, and commits green", async () => {
    const t = await blockedRepo();
    let buildCalls = 0;
    mockExec.mockImplementation(async (prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        t.buildPrompts.push(prompt);
        await writeImplementedFile(t.cwd);
        await emitText(t.ledgerDir, options.phaseFile, "$BLOCKED ticket=01 kind=verification-unavailable reason=AC 2 needs a live viewer");
        return t.blockResult("verification-unavailable", "AC 2 needs a live viewer");
      }
      if (kindOf(options) === "review") {
        await emitText(t.ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(t.ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);

    expect(outcome).toBe("ok");
    expect(buildCalls).toBe(1);
    expect(t.ticketState.status).toBe("committed");
    expect(t.ticketState.unverified).toEqual(["AC 2 needs a live viewer"]);
    expect(t.ticketState.blocks).toHaveLength(1);
    expect(t.ticketState.logs.some((l) => l.includes("blocked verification recorded"))).toBe(true);
  });

  it("implementation-stuck: gets ONE corrective attempt with the block reason, and a recovered attempt commits", async () => {
    const t = await blockedRepo();
    let buildCalls = 0;
    mockExec.mockImplementation(async (prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        t.buildPrompts.push(prompt);
        await writeImplementedFile(t.cwd);
        if (buildCalls === 1) {
          await emitText(t.ledgerDir, options.phaseFile, "$BLOCKED ticket=01 kind=implementation-stuck reason=the parser test cannot pass");
          return t.blockResult("implementation-stuck", "the parser test cannot pass");
        }
        await emitText(t.ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return t.checkpointOk();
      }
      if (kindOf(options) === "review") {
        await emitText(t.ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(t.ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);

    expect(outcome).toBe("ok");
    expect(buildCalls).toBe(2);
    expect(t.ticketState.status).toBe("committed");
    expect(t.buildPrompts[1]).toContain("the parser test cannot pass");
    expect(t.buildPrompts[1]).toMatch(/ONE corrective attempt/i);
  });

  it("implementation-stuck twice: fails the ticket and stops instead of looping", async () => {
    const t = await blockedRepo();
    let buildCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        await emitText(t.ledgerDir, options.phaseFile, "$BLOCKED ticket=01 kind=implementation-stuck reason=still stuck");
        return t.blockResult("implementation-stuck", "still stuck");
      }
      return okResult();
    });

    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);

    expect(outcome).toBe("failed");
    expect(buildCalls).toBe(2);
    expect(t.state.status).toBe("failed");
    expect(t.state.stop_reason).toContain("implementation-stuck");
  });

  it("per-ticket step budget: a ticket over its cumulative budget stops before another builder call", async () => {
    const t = await blockedRepo({ ticket_step_budget: 5 });
    t.ticketState.build_steps_total = 5;
    let execCalls = 0;
    mockExec.mockImplementation(async () => {
      execCalls++;
      return okResult();
    });

    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);

    expect(outcome).toBe("failed");
    expect(execCalls).toBe(0);
    expect(t.ticketState.logs.join("\n")).toContain("step budget exhausted");
    expect(t.state.stop_reason).toContain("step budget exhausted");
  });

  it("per-ticket wall budget: an explicit tiny wall budget stops a ticket already over it", async () => {
    const t = await blockedRepo({ ticket_wall_sec: 60 });
    t.ticketState.build_ms_total = 60_000;
    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);
    expect(outcome).toBe("failed");
    expect(t.ticketState.logs.join("\n")).toContain("wall budget exhausted");
  });

  it("per-ticket wall budget: a green checkpoint restarts the wall clock — a slow but progressing ticket is not stopped", async () => {
    // The snake-run-20260923 shape: cumulative builder wall far over budget,
    // but the last invocation checkpointed green. The retry the smoke failure
    // asked for must be allowed — the budget bounds thrash, and thrash by
    // definition produces no checkpoints.
    const t = await blockedRepo({ ticket_wall_sec: 60 });
    t.ticketState.build_ms_total = 600_000; // 10m cumulative — far over the 60s budget
    t.ticketState.build_ms_since_checkpoint = 0; // green checkpoint just landed
    let buildCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        await writeImplementedFile(t.cwd);
        await emitText(t.ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return t.checkpointOk();
      }
      if (kindOf(options) === "review") {
        await emitText(t.ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nlooks good");
      } else {
        await emitText(t.ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);

    expect(buildCalls).toBe(1);
    expect(outcome).toBe("ok");
    expect(t.ticketState.status).toBe("committed");
  });

  it("per-ticket wall budget: a checkpoint whose verify FAILS does not restart the wall clock — premature-checkpoint thrash stays bounded", async () => {
    // The reset lives on the verify-green path, not the checkpoint marker:
    // a model emitting $CHECKPOINT for work verify rejects must not clear
    // the budget that exists to bound exactly that thrash.
    const t = await blockedRepo({ ticket_wall_sec: 60, verify: ["false"] });
    let buildCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        await writeImplementedFile(t.cwd);
        await emitText(t.ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return { ...t.checkpointOk(), durationMs: 70_000 };
      }
      return okResult();
    });

    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);

    expect(outcome).toBe("failed");
    expect(buildCalls).toBe(1);
    expect(t.ticketState.verify_ok).toBe(false);
    expect(t.ticketState.logs.join("\n")).toContain("wall budget exhausted");
  });

  it("per-ticket budget exhausted with a GREEN tree: commits the verified work as a soft-pass and stops the run for a human", async () => {
    // The attempt-cap path soft-passes working code when out of runway; the
    // budget path must land the same way — a green tree is not a failure.
    // Here: a light-mode MAJOR spends its one corrective attempt, and the
    // retry boundary finds the cumulative step budget spent.
    const t = await blockedRepo({ ticket_step_budget: 5, code_review: { mode: "light" } });
    let buildCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        await writeImplementedFile(t.cwd);
        await emitText(t.ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return { ...t.checkpointOk(), steps: 5 };
      }
      if (kindOf(options) === "review") {
        await emitText(t.ledgerDir, options.phaseFile, "$BLOCKING\n[MAJOR] cosmetic gap\n$NITS\nNONE\n$OK\nmeh");
      } else {
        await emitText(t.ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const outcome = await processTicket(t.state, t.ledgerDir, t.ticketState);

    // "failed" is how the frontier loop hears stop-and-break; the preset
    // terminal "stopped" status survives it (isFinished), as with a halt.
    expect(outcome).toBe("failed");
    expect(buildCalls).toBe(1);
    expect(t.ticketState.status).toBe("committed");
    expect(t.ticketState.commit).toBeTruthy();
    expect(t.state.status).toBe("stopped");
    expect(t.state.stop_reason).toContain("step budget exhausted");
    expect(t.ticketState.logs.join("\n")).toContain("green tree");
  });

  it("ticketBudgetStop: the wall clock restarts at a green verify — cumulative wall no longer stops a progressing ticket", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const state = await makeState(cwd, ticketsDir, baseConfig({ ticket_wall_sec: 60, ticket_step_budget: 0 }));
    const { state: ticketState } = await makeTicket(ticketsDir);
    ticketState.build_ms_total = 3_600_000; // an hour cumulative
    // A green verify just landed: 30s on the fresh clock — within budget.
    ticketState.build_ms_since_checkpoint = 30_000;
    expect(ticketBudgetStop(state, ticketState)).toBeNull();
    // The fresh clock over budget stops, naming the verify-green span.
    ticketState.build_ms_since_checkpoint = 60_000;
    expect(ticketBudgetStop(state, ticketState)).toContain("wall budget exhausted");
    expect(ticketBudgetStop(state, ticketState)).toContain("since the last green verify");
    // No green round yet: the cumulative total governs, with the original wording.
    ticketState.build_ms_since_checkpoint = undefined;
    expect(ticketBudgetStop(state, ticketState)).toContain("across all builder invocations");
  });

  it("ticketBudgetStop: the derived wall budget self-calibrates from the slowest observed invocation", async () => {
    // The snake-run ticket 01 shape: no usable plan ledger, a 35m healthy
    // invocation on an 11 tok/s model. The old fixed 30m floor killed it;
    // the derived budget is max(plan wall, 30m floor, 2 × slowest invocation).
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const state = await makeState(cwd, ticketsDir, baseConfig({ ticket_step_budget: 0, ticket_wall_sec: null }));
    const { state: ticketState } = await makeTicket(ticketsDir);
    // No invocation measured yet: the 30m floor alone governs.
    ticketState.build_ms_total = 31 * 60_000;
    expect(ticketBudgetStop(state, ticketState)).toContain("wall budget exhausted");
    // One 35m invocation observed: the budget rises to 70m — a second
    // checkpoint-less attempt of the same length is allowed.
    ticketState.build_ms_max_invocation = 35 * 60_000;
    ticketState.build_ms_total = 35 * 60_000;
    expect(ticketBudgetStop(state, ticketState)).toBeNull();
    // Two full checkpoint-less invocations of that length IS the thrash
    // signature the budget exists to stop.
    ticketState.build_ms_total = 71 * 60_000;
    expect(ticketBudgetStop(state, ticketState)).toContain("wall budget exhausted");
    // An explicit config still wins over the derivation.
    const explicit = await makeState(cwd, ticketsDir, baseConfig({ ticket_step_budget: 0, ticket_wall_sec: 60 }));
    ticketState.build_ms_total = 61_000;
    expect(ticketBudgetStop(explicit, ticketState)).toContain("wall budget exhausted");
  });

  it("ticketBudgetStop: defaults scale from the plan — steps 2x max_phase_steps, wall measured from the plan ledger", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const state = await makeState(cwd, ticketsDir, baseConfig({ max_phase_steps: 10, ticket_step_budget: null, ticket_wall_sec: null }));
    const { state: ticketState } = await makeTicket(ticketsDir);
    // No plan ledger yet: the wall floor (30 min) applies; steps default 20.
    expect(ticketBudgetStop(state, ticketState)).toBeNull();
    ticketState.build_steps_total = 20;
    expect(ticketBudgetStop(state, ticketState)).toContain("step budget exhausted");
    ticketState.build_steps_total = 0;
    // A measured plan span tighter than the floor is honored once it exceeds.
    const events = join(cwd, ".railhead", "plan-latest", "events");
    await mkdir(events, { recursive: true });
    await writeFile(join(events, "plan.jsonl"), JSON.stringify({ timestamp: 1_000_000_000_000 }) + "\n" + JSON.stringify({ timestamp: 1_000_003_600_000 }) + "\n", "utf8");
    ticketState.build_ms_total = 3_600_000;
    expect(ticketBudgetStop(state, ticketState)).toContain("wall budget exhausted");
    // Explicit 0 disables either budget.
    const off = await makeState(cwd, ticketsDir, baseConfig({ ticket_step_budget: 0, ticket_wall_sec: 0 }));
    expect(ticketBudgetStop(off, ticketState)).toBeNull();
  });
});

describe("ADR 0040 — plan-defect auto-replan", () => {
  it("plan-defect: runs the bounded replan and continues with the regenerated frontier", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKED ticket=01 kind=plan-defect reason=ticket 01 lists a file ticket 02 owns");
        return { ...okResult(), sessionId: "sess-abc123", block: { ticket: "01", kind: "plan-defect", reason: "ticket 01 lists a file ticket 02 owns", malformedKind: false } };
      }
      if (options.phaseFile.startsWith("replan-")) {
        await emitText(ledgerDir, options.phaseFile, '$TICKETS\n[{"title":"Replanned","mission":"m","what":"redo it correctly","criteria":["c"],"blocked_by":[],"files":["src/index.js"],"introduces":["greet"]}]\n');
        return okResult();
      }
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(state.replan_count).toBe(1);
    expect(state.tickets.some((t) => t.title === "Replanned")).toBe(true);
    expect(state.tickets.some((t) => t.file === ticketState.file)).toBe(false);
  });

  it("plan-defect with max_replans spent: stops and surfaces instead of replanning again", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];
    state.replan_count = config.goal_review?.max_replans ?? 2;

    let replanCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKED ticket=01 kind=plan-defect reason=impossible");
        return { ...okResult(), sessionId: "sess-abc123", block: { ticket: "01", kind: "plan-defect", reason: "impossible", malformedKind: false } };
      }
      if (options.phaseFile.startsWith("replan-")) replanCalls++;
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("failed");
    expect(replanCalls).toBe(0);
    expect(state.stop_reason).toContain("plan-defect");
  });
});

describe("base session + phase fork (#133)", () => {
  it("creates one base per run and forks it for every fresh phase", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "base") return { ...okResult(), sessionId: "ses_base" };
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);
    expect(final.status).toBe("finished");

    const baseCalls = mockExec.mock.calls.filter(([, o]) => kindOf(o!) === "base");
    expect(baseCalls).toHaveLength(1);
    expect(final.base_session?.session_id).toBe("ses_base");

    const fresh = mockExec.mock.calls.filter(([, o]) => kindOf(o!) !== "base");
    expect(fresh.length).toBeGreaterThan(0);
    for (const [, options] of fresh) {
      expect(options!.session).toBe("ses_base");
      expect(options!.fork).toBe(true);
      expect((options!.task ?? "").length).toBeGreaterThan(0);
    }
  });

  it("falls back to the joined prompt for every phase when no base can be created", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig();
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];

    // The base call completes without a session id — the fail-open shape a
    // missing model or an exhausted provider produces.
    mockExec.mockImplementation(async (_prompt, options) => {
      const kind = kindOf(options);
      if (kind === "base") return okResult();
      if (kind === "implement") {
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "DONE");
      } else if (kind === "review") {
        await emitText(ledgerDir, options.phaseFile, "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
      } else {
        await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      }
      return okResult();
    });

    const final = await runLoop(state, ledgerDir);
    expect(final.status).toBe("finished");
    expect(final.base_session ?? null).toBeNull();

    const fresh = mockExec.mock.calls.filter(([, o]) => kindOf(o!) !== "base");
    expect(fresh.length).toBeGreaterThan(0);
    for (const [, options] of fresh) {
      expect(options!.session ?? null).toBeNull();
      expect(options!.fork ?? false).toBe(false);
    }
  });
});

describe("builder seed forks the base (#133)", () => {
  it("forks the base with the first builder task and resumes the forked session after that", async () => {
    const cwd = await freshRepo();
    const ticketsDir = ticketsDirOf(cwd);
    const ledgerDir = join(cwd, ".railhead", "run-test");
    await initLedger(ledgerDir);
    const config = baseConfig({});
    const { state: ticketState } = await makeTicket(ticketsDir);
    const state = await makeState(cwd, ticketsDir, config);
    state.tickets = [ticketState];
    // A ready base (as runLoop's ensureBaseSession would have persisted).
    state.base_session = { session_id: "ses_base", preamble_hash: "docs-hash", created_at: "2026-09-24T00:00:00Z" };

    let buildCalls = 0;
    let reviewCalls = 0;
    mockExec.mockImplementation(async (_prompt, options) => {
      if (options.phaseFile.endsWith("-build")) {
        buildCalls++;
        await writeImplementedFile(cwd);
        await emitText(ledgerDir, options.phaseFile, "$CHECKPOINT ticket=01");
        return { ...okResult(), sessionId: "ses_builder1", checkpointTicket: "01" };
      }
      if (kindOf(options) === "review") {
        reviewCalls++;
        await emitText(ledgerDir, options.phaseFile, reviewCalls === 1
          ? "$BLOCKING\n[BLOCKER] must fix\n$NITS\nNONE\n$OK\nno"
          : "$BLOCKING\nNONE\n$NITS\nNONE\n$OK\nok");
        return okResult();
      }
      await emitText(ledgerDir, options.phaseFile, "$CONTRACTS\n$END");
      return okResult();
    });

    const outcome = await processTicket(state, ledgerDir, ticketState);

    expect(outcome).toBe("ok");
    expect(ticketState.status).toBe("committed");
    expect(buildCalls).toBe(2);
    const builds = mockExec.mock.calls.filter(([, o]) => o!.phaseFile.endsWith("-build"));
    // Seed: fork the base, send only the builder task.
    expect(builds[0]![1]!.session).toBe("ses_base");
    expect(builds[0]![1]!.fork).toBe(true);
    expect((builds[0]![1]!.task ?? "").length).toBeGreaterThan(0);
    // Findings retry: the forked durable session, no fork.
    expect(builds[1]![1]!.session).toBe("ses_builder1");
    expect(builds[1]![1]!.fork ?? false).toBe(false);
  });
});
