import { describe, it, expect } from "vitest";
import { buildReport, renderStatusTable, elapsedLabel, renderNextActionable } from "./overview.ts";
import type { RunState, TicketState } from "../core/state.ts";

function makeState(ctxPeak: number, budget?: number): RunState {
  return {
    schema_version: 1,
    cwd: "/tmp/x",
    branch: "run/x",
    status: "finished",
    tickets_dir: "/tmp/x/issues",
    config: {
      verify: [],
      smoke: [],
      max_retries: 3,
      max_review_retries: null,
      infra_backoff_sec: [5, 15, 45, 120],
      max_context_tokens: budget,
      model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null },
    },

    pause_on_failure: false,
    verbose: false, quiet: false,
    tickets: [
      {
        file: "01-a.md",
        title: "a",
        number: "01",
        blocked_by: [],
        status: "committed",
        attempts: 1,
        start_commit: null,
        commit: "abc123",
        verify_ok: true,
        review_ok: true,
        review_attempts: 2,
        reviews: [
          { phase: "01-01-review", attempt: 1, blocking: true, findings: ["bug"] },
          { phase: "01-02-review", attempt: 2, blocking: false, findings: [] },
        ],
        duration_ms: 120000,
        context: { compactions: 0, peakInputTokens: ctxPeak, finalInputTokens: ctxPeak, totalInputTokens: ctxPeak, totalOutputTokens: 0, generationMs: 0, outputTokensPerSec: 0 },
        logs: [],
      },
    ],
    started_at: "x",
    updated_at: "x",
  };
}

describe("buildReport context guard-rail", () => {
  it("flags when peak approaches the budget (>=80%)", () => {
    const r = buildReport(makeState(90000, 100000));
    expect(r).toContain("⚠ Context peak near the configured budget");
  });

  it("flags when peak exceeds the budget", () => {
    const r = buildReport(makeState(120000, 100000));
    expect(r).toContain("⚠ Context peak exceeds the configured budget");
  });

  it("stays silent when peak is well under the budget", () => {
    const r = buildReport(makeState(40000, 100000));
    expect(r).not.toContain("⚠");
  });

  it("warns when a ticket compacted (non-zero compaction count)", () => {
    // The whole point of the railhead is to avoid compaction; a non-zero count
    // means the budget was mis-set or the model over-read. Surface it so the
    // run's health is visible without digging into the ledger.
    const s = makeState(30000, 100000);
    s.tickets[0].context = { compactions: 4, peakInputTokens: 30000, finalInputTokens: 30000, totalInputTokens: 30000, totalOutputTokens: 0, generationMs: 0, outputTokensPerSec: 0 };
    const r = buildReport(s);
    expect(r).toContain("⚠ 4 compactions");
    expect(r).toMatch(/budget may be mis-set|over-read/i);
  });

  it("stays silent when compactions is zero (the healthy case)", () => {
    const r = buildReport(makeState(30000, 100000));
    expect(r).not.toMatch(/⚠.*compaction/);
  });

  it("lists the budget in the header", () => {
    expect(buildReport(makeState(1000, 32768))).toContain("Context budget: 33k");
  });

  it("records the agent-initiated halt reason when the run stopped on one (gh #111)", () => {
    const s = makeState(10000, 100000);
    s.status = "stopped";
    s.halt_reason = "the plan assumes a browser, but this is a terminal app";
    expect(buildReport(s)).toContain("- Halt: the plan assumes a browser, but this is a terminal app");
  });

  it("omits the halt line for a run that never halted", () => {
    expect(buildReport(makeState(10000, 100000))).not.toContain("- Halt:");
  });

  it("records the review outcome and attempt on a committed ticket", () => {
    const r = buildReport(makeState(10000, 100000));
    expect(r).toContain("- Review: pass (passed on review 2)");
    expect(r).toContain("01-01-review: blocking (1 must-fix)");
    expect(r).toContain("01-02-review: pass");
  });

  it("adds a review summary aggregating blocking findings", () => {
    const r = buildReport(makeState(10000, 100000));
    expect(r).toContain("## Review summary");
    expect(r).toContain("Total review findings raised: 1");
    expect(r).toContain("bug");
  });
});
describe("buildReport visual review status", () => {
  function makeVisualState(visual_ok: boolean | null, rounds: number): RunState {
    const s = makeState(1000, 100000);
    s.config.visual_review = { mode: "light" };
    s.visual_ok = visual_ok;
    s.visual_rounds = rounds;
    return s;
  }

  it("reports PASS when visual_ok is true", () => {
    expect(buildReport(makeVisualState(true, 1))).toContain("- Visual review: PASS (round 1)");
  });

  it("reports FAIL when visual_ok is false", () => {
    expect(buildReport(makeVisualState(false, 2))).toContain("- Visual review: FAIL (round 2)");
  });

  it("reports 'not run' when visual_ok is null and no round was attempted", () => {
    const r = buildReport(makeVisualState(null, -1));
    expect(r).toContain("- Visual review: not run");
    expect(r).not.toContain("INCONCLUSIVE");
  });

  it("reports INCONCLUSIVE when a round ran but produced no verdict (the soft-pass-before bug)", () => {
    const r = buildReport(makeVisualState(null, 1));
    expect(r).toContain("INCONCLUSIVE");
    expect(r).toContain("manual visual inspection required");
    expect(r).not.toContain("- Visual review: PASS");
  });
});

describe("elapsedLabel", () => {
  it("formats h/m/s", () => {
    const t = new Date("2026-08-24T10:00:00Z").toISOString();
    expect(elapsedLabel(t, new Date("2026-08-24T11:12:34Z").toISOString())).toBe("1h 12m 34s");
    expect(elapsedLabel(t, new Date("2026-08-24T10:05:09Z").toISOString())).toBe("5m 9s");
    expect(elapsedLabel(t, new Date("2026-08-24T10:00:45Z").toISOString())).toBe("45s");
  });

  it("returns — for invalid or reversed times", () => {
    expect(elapsedLabel("nope", "also nope")).toBe("—");
    expect(elapsedLabel(new Date("2026-08-24T10:00:00Z").toISOString(), new Date("2026-08-24T09:00:00Z").toISOString())).toBe("—");
  });
});

function ts(file: string, number: string, title: string, overrides: Partial<TicketState> = {}): TicketState {
  return {
    file,
    number,
    title,
    blocked_by: [],
    status: "ready",
    attempts: 0,
    start_commit: null,
    commit: null,
    verify_ok: null,
    review_ok: null,
    review_attempts: 0,
    duration_ms: 0,
    reviews: [],
    logs: [],
    ...overrides,
  };
}

function nextState(tickets: TicketState[], overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: 1,
    cwd: "/tmp/x",
    branch: "run/x",
    status: "running",
    tickets_dir: "/tmp/x/issues",
    config: {
      verify: [],
      smoke: [],
      max_retries: 3,
      max_review_retries: null,
      infra_backoff_sec: [5, 15, 45, 120],
      max_context_tokens: undefined,
      model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null },
    },

    pause_on_failure: false,
    verbose: false,
    quiet: false,
    tickets,
    started_at: "x",
    updated_at: "x",
    ...overrides,
  };
}

describe("renderNextActionable (#43)", () => {
  it("shows a ready ticket when the frontier is non-empty", () => {
    const s = nextState([
      ts("01-add-greet.md", "01", "Add greet function", { status: "committed", commit: "abc123" }),
      ts("02-add-farewell.md", "02", "Add farewell function", { status: "ready", blocked_by: ["01-add-greet.md"] }),
    ]);
    const out = renderNextActionable(s);
    expect(out).toContain("READY TO BUILD:");
    expect(out).toContain("02 Add farewell function");
    expect(out).toContain("02-add-farewell.md");
  });

  it("shows in-progress tickets", () => {
    const s = nextState([
      ts("01-greet.md", "01", "Greet", { status: "in_progress", attempts: 2 }),
    ]);
    const out = renderNextActionable(s);
    expect(out).toContain("IN PROGRESS:");
    expect(out).toContain("01 Greet");
    expect(out).toContain("attempt 2");
  });

  it("shows failed tickets", () => {
    const s = nextState([
      ts("01-greet.md", "01", "Greet", { status: "failed", attempts: 3 }),
    ]);
    const out = renderNextActionable(s);
    expect(out).toContain("FAILED:");
    expect(out).toContain("01 Greet");
  });

  it("shows blocked tickets and what they're waiting on", () => {
    const s = nextState([
      ts("01-setup-db.md", "01", "Set up database", { status: "ready", blocked_by: [] }),
      ts("02-add-models.md", "02", "Add models", { status: "ready", blocked_by: ["01-setup-db.md"] }),
    ]);
    const out = renderNextActionable(s);
    expect(out).toContain("READY TO BUILD:");
    expect(out).toContain("01 Set up database");
    expect(out).toContain("BLOCKED:");
    expect(out).toContain("02 Add models");
    expect(out).toContain("waiting on: 01-setup-db.md (Set up database)");
  });

  it("shows the group label when a ready ticket has one", () => {
    const s = nextState([
      ts("01-core.md", "01", "Core engine", { status: "ready", group: "engine" }),
    ]);
    const out = renderNextActionable(s);
    expect(out).toContain("group: engine");
  });

  it("shows committed/total count in the header", () => {
    const s = nextState([
      ts("01-a.md", "01", "A", { status: "committed", commit: "abc" }),
      ts("02-b.md", "02", "B", { status: "ready" }),
      ts("03-c.md", "03", "C", { status: "ready", blocked_by: ["02-b.md"] }),
    ]);
    const out = renderNextActionable(s);
    expect(out).toMatch(/1\/3 committed/);
  });

  it("says 'All tickets committed' when the frontier is empty and nothing remains", () => {
    const s = nextState([
      ts("01-a.md", "01", "A", { status: "committed", commit: "abc" }),
      ts("02-b.md", "02", "B", { status: "committed", commit: "def" }),
    ], { status: "finished" });
    const out = renderNextActionable(s);
    expect(out).toContain("All tickets committed");
    expect(out).not.toContain("READY TO BUILD:");
  });

  it("shows multiple ready tickets when the frontier has parallel work", () => {
    const s = nextState([
      ts("01-a.md", "01", "A", { status: "ready" }),
      ts("02-b.md", "02", "B", { status: "ready" }),
    ]);
    const out = renderNextActionable(s);
    expect(out).toContain("01 A");
    expect(out).toContain("02 B");
  });

  it("shows the run status in the header", () => {
    const s = nextState([
      ts("01-a.md", "01", "A", { status: "ready" }),
    ], { status: "stopped" });
    const out = renderNextActionable(s);
    expect(out).toMatch(/stopped/);
  });
});

describe("buildReport Rulings section (#86)", () => {
  it("lists plan and runtime rulings with their source and the tickets involved", () => {
    const s = nextState([
      ts("01-a.md", "01", "A", { status: "committed", commit: "abc" }),
    ], {
      status: "finished",
      plan_rulings: [
        { key: "dup-introduce:greet:a:b", finding: "duplicate introduces: symbol \"greet\" is introduced by tickets 01-a.md and 04-b.md", reason: "intentional — same symbol reused as a local in a separate module", source: "plan", tickets: ["01-a.md", "04-b.md"] },
      ],
      rulings: [
        { key: "same-file:fix:b", finding: "tickets 02-fix.md and 04-b.md both touch src/engine.ts", reason: "defect-fix precedence (extendBlockedBy edge), 04 redefines at run", source: "runtime", tickets: ["02-fix.md", "04-b.md"] },
      ],
    });
    const r = buildReport(s);
    expect(r).toContain("## Rulings");
    expect(r).toContain("[plan]");
    expect(r).toContain("intentional — same symbol reused as a local in a separate module");
    expect(r).toContain("[runtime]");
    expect(r).toContain("defect-fix precedence");
    expect(r).toContain("(01-a.md, 04-b.md)");
  });

  it("omits the Rulings section when no rulings were recorded", () => {
    const r = buildReport(nextState([ts("01-a.md", "01", "A", { status: "ready" })], { status: "running" }));
    expect(r).not.toContain("## Rulings");
  });
});

describe("buildReport — coherence charter & surface classification (issue #99)", () => {
  it("renders the charter-authored line and the surface-ticket set when charterInfo is supplied", () => {
    const r = buildReport(makeState(10000, 100000), { coherenceAuthored: true, surfaceTickets: ["01", "03"], interactionInterface: "browser-ui" });
    expect(r).toContain("Coherence charter (ADR 0028): authored (docs/coherence.md)");
    expect(r).toContain("Surface tickets (coherence/visual gate): 01, 03");
    expect(r).toContain("Interaction interface (#97): browser-ui");
  });

  it("renders the not-authored / none forms", () => {
    const r = buildReport(makeState(10000, 100000), { coherenceAuthored: false, surfaceTickets: [], interactionInterface: "canvas (auto-detected)" });
    expect(r).toContain("Coherence charter (ADR 0028): not authored");
    expect(r).toContain("Surface tickets (coherence/visual gate): none");
    expect(r).toContain("Interaction interface (#97): canvas (auto-detected)");
  });

  it("nudges the operator to declare the interface when undeclared and not canvas-inferred (#97)", () => {
    const r = buildReport(makeState(10000, 100000), { coherenceAuthored: false, surfaceTickets: [], interactionInterface: null });
    expect(r).toContain("Interaction interface (#97): undeclared");
    expect(r).toContain("browser-ui");
  });

  it("omits the lines when no charterInfo was computed (back-compat with direct buildReport callers)", () => {
    const r = buildReport(makeState(10000, 100000));
    expect(r).not.toContain("Coherence charter (ADR 0028)");
  });
});

describe("buildReport — goal review checkpoints (ADR 0029, #102)", () => {
  it("reports advisory count and per-group findings", () => {
    const s = makeState(10000, 100000);
    s.config.goal_review = { mode: "light", checkpoint_action: "advisory" };
    s.goal_reviews = [
      { group: "engine", round: 0, verdict: "fail", findings: ["[BLOCKER] the snake has no food"], advisory: true },
      { group: "run-end", round: 0, verdict: "pass", findings: [] },
    ];
    const r = buildReport(s);
    expect(r).toContain("## Goal review checkpoints (ADR 0029)");
    expect(r).toContain("2 goal checkpoint record(s), 1 advisory");
    expect(r).toContain("- engine [advisory]: fail — 1 finding(s)");
    expect(r).toContain("- run-end [run-end corrective]: pass");
    expect(r).toContain("[BLOCKER] the snake has no food");
  });

  it("omits the section when no goal review ran", () => {
    const r = buildReport(makeState(10000, 100000));
    expect(r).not.toContain("## Goal review checkpoints");
  });
});
