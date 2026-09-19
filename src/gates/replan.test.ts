import { describe, it, expect } from "vitest";
import {
  classifyFindings,
  buildReplanPrompt,
  meldReplannedTickets,
  normalizeReplanBlockedBy,
  globalizeReplanTickets,
  backfillMission,
  drainFrontier,
  type ReplanClassification,
} from "./replan.ts";
import { orderTickets, TICKET_FIELD_SEMANTICS, type PlanTicket } from "../core/ticket-dag.ts";
import type { TicketState, RunState } from "../core/state.ts";

function ts(file: string, number: string, status: TicketState["status"]): TicketState {
  return {
    file,
    title: `ticket ${number}`,
    number,
    blocked_by: [],
    status,
    attempts: 0,
    start_commit: null,
    commit: null,
    verify_ok: null,
    review_ok: null,
    review_attempts: 0,
    duration_ms: 0,
    reviews: [],
    logs: [],
  };
}

function stateWith(tickets: TicketState[]): RunState {
  return {
    schema_version: 1,
    cwd: "/project",
    branch: "main",
    status: "running",
    tickets_dir: "/project/.scratch/test/issues",
    config: {} as never,

    pause_on_failure: false,
    verbose: false,
    quiet: false,
    tickets,
    started_at: "",
    updated_at: "",
  };
}

describe("classifyFindings (#51)", () => {
  it("classifies empty findings as no-replan", () => {
    const result = classifyFindings([]);
    expect(result.replan).toBe(false);
  });

  it("classifies implementation-gap findings as no-replan", () => {
    const findings = [
      "[BLOCKER] The foo function crashes on null input",
      "[MAJOR] Missing error handling in bar.ts",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(false);
    expect(result.reason).toMatch(/implementation/i);
  });

  it("classifies plan-level findings as replan", () => {
    const findings = [
      "[BLOCKER] The planned module structure assumes a single data layer but the implementation reveals two divergent repositories — remaining tickets that build on the flat structure must be replanned",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(true);
    expect(result.reason).toMatch(/plan/i);
  });

  it("classifies structural-drift findings as replan when they indicate the plan was wrong", () => {
    const findings = [
      "[BLOCKER] Plan assumed REST endpoints but prior tickets built a GraphQL schema — remaining tickets must be regenerated against the actual architecture",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(true);
  });

  it("does NOT replan for a single missing feature gap", () => {
    const findings = [
      "[BLOCKER] The authentication flow is missing the password reset endpoint",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(false);
  });

  it("replans when findings mention 'plan assumption' or 'planned structure'", () => {
    const findings = [
      "[MAJOR] The plan assumption that all data flows through the central store does not hold — tickets 05-08 should be restructured",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(true);
  });

  it("replans when findings mention 'replan' or 'regenerate'", () => {
    const findings = [
      "[BLOCKER] The contracts diverge from what the remaining tickets expect — replan needed",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(true);
  });

  it("replans when findings mention architecture divergence", () => {
    const findings = [
      "[BLOCKER] The actual architecture has diverged from the planned module map — remaining tickets reference modules that don't exist",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(true);
  });

  it("does not replan for a styling or naming convention gap", () => {
    const findings = [
      "[MAJOR] Inconsistent naming: some files use camelCase, others snake_case",
    ];
    const result = classifyFindings(findings);
    expect(result.replan).toBe(false);
  });
});

describe("buildReplanPrompt (#51)", () => {
  it("includes the original prompt", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build a task tracker app",
      findings: ["[BLOCKER] plan assumption was wrong"],
      contractsSummary: "TaskRepo (interface) @ src/repo.ts :: create, read, update",
      digest: "Module structure: repository pattern established",
      committedTickets: [
        { number: "01", title: "Set up project scaffold", file: "01-scaffold.md" },
        { number: "02", title: "Build data layer", file: "02-data-layer.md" },
      ],
      uncommittedTickets: [
        { number: "03", title: "Build API endpoints", file: "03-api.md" },
        { number: "04", title: "Build UI", file: "04-ui.md" },
      ],
    });
    expect(prompt).toContain("Build a task tracker app");
  });

  it("includes the findings", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] The plan assumption about REST was wrong"],
      contractsSummary: "",
      digest: null,
      committedTickets: [],
      uncommittedTickets: [],
    });
    expect(prompt).toContain("[BLOCKER] The plan assumption about REST was wrong");
  });

  it("includes the contracts summary", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] replan needed"],
      contractsSummary: "TaskRepo (interface) @ src/repo.ts :: create()",
      digest: null,
      committedTickets: [],
      uncommittedTickets: [],
    });
    expect(prompt).toContain("TaskRepo (interface) @ src/repo.ts :: create()");
  });

  it("includes the digest", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] replan needed"],
      contractsSummary: "",
      digest: "Repository pattern established for data layer",
      committedTickets: [],
      uncommittedTickets: [],
    });
    expect(prompt).toContain("Repository pattern established for data layer");
  });

  it("lists committed tickets as fixed context", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] replan"],
      contractsSummary: "",
      digest: null,
      committedTickets: [
        { number: "01", title: "Scaffold", file: "01-scaffold.md" },
      ],
      uncommittedTickets: [],
    });
    expect(prompt).toContain("01-scaffold.md");
    expect(prompt).toContain("Scaffold");
    expect(prompt).toMatch(/committed.*fixed/i);
  });

  it("lists uncommitted tickets to be replaced", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] replan"],
      contractsSummary: "",
      digest: null,
      committedTickets: [],
      uncommittedTickets: [
        { number: "03", title: "Build API", file: "03-api.md" },
      ],
    });
    expect(prompt).toContain("03-api.md");
    expect(prompt).toContain("Build API");
    expect(prompt).toMatch(/replace.*regenerate/i);
  });

  it("instructs to preserve committed work and regenerate uncommitted", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] replan"],
      contractsSummary: "",
      digest: null,
      committedTickets: [
        { number: "01", title: "Scaffold", file: "01-scaffold.md" },
      ],
      uncommittedTickets: [
        { number: "02", title: "Build API", file: "02-api.md" },
      ],
    });
    expect(prompt).toMatch(/preserve.*committed/i);
    expect(prompt).toMatch(/regenerate.*uncommitted/i);
  });

  it("tells the planner to generate ADDITIONAL tickets when there is no uncommitted frontier (run-end)", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] the plan was incomplete"],
      contractsSummary: "",
      digest: null,
      committedTickets: [
        { number: "01", title: "Scaffold", file: "01-scaffold.md" },
      ],
      uncommittedTickets: [],
    });
    expect(prompt).toMatch(/incomplete/i);
    expect(prompt).toMatch(/additional tickets/i);
    expect(prompt).not.toMatch(/Tickets to replace/);
  });

  it("defines blocked_by as 0-based positions in the emitted array, never absolute numbers", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] replan"],
      contractsSummary: "",
      digest: null,
      committedTickets: [
        { number: "05", title: "State store", file: "05-state-store.md" },
      ],
      uncommittedTickets: [],
    });
    expect(prompt).toMatch(/0-based positions/i);
    expect(prompt).not.toMatch(/1-indexed/i);
    expect(prompt).toMatch(/NOT an absolute ticket number/i);
    expect(prompt).toMatch(/Do NOT list committed tickets/i);
  });

  it("interpolates the shared field-semantics block (issue #118)", () => {
    const prompt = buildReplanPrompt({
      originalPrompt: "Build something",
      findings: ["[BLOCKER] replan"],
      contractsSummary: "",
      digest: null,
      committedTickets: [
        { number: "05", title: "State store", file: "05-state-store.md" },
      ],
      uncommittedTickets: [],
    });
    expect(prompt).toContain(TICKET_FIELD_SEMANTICS);
    expect(prompt).not.toMatch(/1-indexed/i);
    expect(prompt).not.toMatch(/committed tickets[^\n]*by position in your emitted array/i);
  });
});

describe("normalizeReplanBlockedBy (absolute-numbered replan)", () => {
  const ticket = (title: string, blocked_by: number[]): PlanTicket => ({
    title,
    what: "do the thing",
    criteria: ["it works"],
    blocked_by,
  });

  it("translates absolute ticket numbers to array positions, dropping committed edges", () => {
    // The observed failure: committed 01–05, new tickets numbered 06–15, and
    // blocked_by carrying absolute numbers (05 = committed store, 06 = palette).
    const tickets = [
      ticket("Palette", [2]),
      ticket("History", [2]),
      ticket("Playback", [2]),
      ticket("Store seam", [5, 6, 7, 8]),
      ticket("Canvas", [9]),
      ticket("Palette panel", [9]),
      ticket("Layers", [9]),
      ticket("Filmstrip", [9]),
      ticket("Shell", [10, 11, 12, 13]),
      ticket("Docs", [14]),
    ];
    const normalized = normalizeReplanBlockedBy(tickets, 6, new Set([1, 2, 3, 4, 5]));
    expect(normalized[0].blocked_by).toEqual([]); // committed 02 dropped
    expect(normalized[3].blocked_by).toEqual([0, 1, 2]); // 05 dropped, 06/07/08 → 0/1/2
    expect(normalized[8].blocked_by).toEqual([4, 5, 6, 7]); // 10/11/12/13 → 4/5/6/7
    expect(normalized[9].blocked_by).toEqual([8]); // 14 → 8
  });

  it("produces a set orderTickets accepts", async () => {
    const tickets = [
      ticket("Palette", [2]),
      ticket("History", [2]),
      ticket("Playback", [2]),
      ticket("Store seam", [5, 6, 7, 8]),
      ticket("Canvas", [9]),
      ticket("Palette panel", [9]),
      ticket("Layers", [9]),
      ticket("Filmstrip", [9]),
      ticket("Shell", [10, 11, 12, 13]),
      ticket("Docs", [14]),
    ];
    const normalized = normalizeReplanBlockedBy(tickets, 6, new Set([1, 2, 3, 4, 5]));
    const ordered = await orderTickets(normalized);
    expect(ordered).toHaveLength(10);
    const indexBySlug = new Map(ordered.map((t, i) => [t.slug, i]));
    expect(indexBySlug.get("docs")!).toBeGreaterThan(indexBySlug.get("shell")!);
    expect(indexBySlug.get("shell")!).toBeGreaterThan(indexBySlug.get("canvas")!);
  });

  it("returns the input array unchanged when blocked_by is already 0-based", () => {
    const tickets = [ticket("A", []), ticket("B", [0]), ticket("C", [1])];
    const normalized = normalizeReplanBlockedBy(tickets, 6, new Set());
    expect(normalized).toBe(tickets);
  });
});

describe("globalizeReplanTickets (ADR 0045)", () => {
  it("renumbers the ordered replan into the global range AND remaps blocked_by to the global files", async () => {
    // The platformer failure: orderTickets numbers the replan 01.. and its
    // blocked_by lists those local names; the run's frontier is global (23..),
    // so ticket 24 ended up blocked on a file that did not exist.
    const plan: PlanTicket[] = [
      { title: "Camera", what: "camera", criteria: ["c"], blocked_by: [] },
      { title: "Debug overlay", what: "debug", criteria: ["d"], blocked_by: [0] },
      { title: "Atlas", what: "atlas", criteria: ["a"], blocked_by: [1] },
    ];
    const ordered = await orderTickets(plan);
    expect(ordered[1].blocked_by).toEqual([ordered[0].file]); // local name
    const globalized = globalizeReplanTickets(ordered, 23);
    expect(globalized.map((t) => t.file)).toEqual([
      "23-camera.md",
      "24-debug-overlay.md",
      "25-atlas.md",
    ]);
    expect(globalized[1].blocked_by).toEqual(["23-camera.md"]);
    expect(globalized[2].blocked_by).toEqual(["24-debug-overlay.md"]);
    // Duplicate edges collapse.
    const dup = globalizeReplanTickets(
      [ordered[0], { ...ordered[1], blocked_by: [ordered[0].file, ordered[0].file] }],
      23,
    );
    expect(dup[1].blocked_by).toEqual(["23-camera.md"]);
  });
});

describe("meldReplannedTickets (#51)", () => {
  it("removes old uncommitted tickets and adds new ones", () => {
    const committed = ts("01-done.md", "01", "committed");
    const oldUncommitted = ts("02-old.md", "02", "ready");
    const oldUncommitted2 = ts("03-old.md", "03", "ready");
    const state = stateWith([committed, oldUncommitted, oldUncommitted2]);

    const newTickets = [
      ts("04-new.md", "04", "ready"),
      ts("05-new.md", "05", "ready"),
    ];

    const result = meldReplannedTickets(state, newTickets);
    expect(result.tickets).toHaveLength(3);
    expect(result.tickets.map((t) => t.file)).toEqual([
      "01-done.md",
      "04-new.md",
      "05-new.md",
    ]);
  });

  it("preserves committed tickets exactly", () => {
    const committed = ts("01-done.md", "01", "committed");
    committed.blocked_by = ["00-base.md"];
    committed.attempts = 3;
    committed.review_ok = true;
    const state = stateWith([committed, ts("02-old.md", "02", "ready")]);

    const result = meldReplannedTickets(state, [ts("03-new.md", "03", "ready")]);
    const preserved = result.tickets.find((t) => t.file === "01-done.md")!;
    expect(preserved).toBe(committed);
  });

  it("preserves skipped tickets (they are part of the audit trail)", () => {
    const skipped = ts("01-skipped.md", "01", "skipped");
    const state = stateWith([skipped, ts("02-old.md", "02", "ready")]);

    const result = meldReplannedTickets(state, [ts("03-new.md", "03", "ready")]);
    expect(result.tickets.find((t) => t.file === "01-skipped.md")).toBeDefined();
  });

  it("preserves failed tickets (audit trail)", () => {
    const failed = ts("01-failed.md", "01", "failed");
    const state = stateWith([failed, ts("02-old.md", "02", "ready")]);

    const result = meldReplannedTickets(state, [ts("03-new.md", "03", "ready")]);
    expect(result.tickets.find((t) => t.file === "01-failed.md")).toBeDefined();
  });

  it("removes only ready/in_progress tickets, keeps terminal statuses", () => {
    const committed = ts("01-c.md", "01", "committed");
    const inProgress = ts("02-ip.md", "02", "in_progress");
    const ready = ts("03-r.md", "03", "ready");

    const state = stateWith([committed, inProgress, ready]);
    const result = meldReplannedTickets(state, [ts("04-new.md", "04", "ready")]);

    expect(result.tickets.map((t) => t.file)).toEqual(["01-c.md", "04-new.md"]);
  });

  it("returns a new state object, does not mutate the input", () => {
    const committed = ts("01-c.md", "01", "committed");
    const ready = ts("02-r.md", "02", "ready");
    const state = stateWith([committed, ready]);
    const originalTickets = [...state.tickets];

    meldReplannedTickets(state, [ts("03-new.md", "03", "ready")]);

    expect(state.tickets).toEqual(originalTickets);
  });

  it("new tickets enter as ready status", () => {
    const state = stateWith([ts("01-c.md", "01", "committed")]);
    const newTicket = ts("02-new.md", "02", "ready");

    const result = meldReplannedTickets(state, [newTicket]);
    expect(result.tickets.find((t) => t.file === "02-new.md")?.status).toBe("ready");
  });
});

describe("drainFrontier (run-end replan)", () => {
  it("drains ready tickets in dependency order", async () => {
    const committed = ts("01-c.md", "01", "committed");
    const t2 = ts("02-a.md", "02", "ready");
    const t3 = ts("03-b.md", "03", "ready");
    t3.blocked_by = ["02-a.md"];
    const state = stateWith([committed, t2, t3]);

    const processed: string[] = [];
    const runTicket = async (_s: RunState, _l: string, t: TicketState) => {
      processed.push(t.file);
      t.status = "committed";
      return "ok" as const;
    };

    expect(await drainFrontier(state, "/ledger", runTicket)).toBe(true);
    expect(processed).toEqual(["02-a.md", "03-b.md"]);
  });

  it("returns false and stops on the first failed ticket", async () => {
    const t2 = ts("02-a.md", "02", "ready");
    const t3 = ts("03-b.md", "03", "ready");
    const state = stateWith([t2, t3]);

    let calls = 0;
    const runTicket = async (_s: RunState, _l: string, t: TicketState) => {
      calls++;
      if (t.file === "02-a.md") {
        t.status = "committed";
        return "ok" as const;
      }
      return "failed" as const;
    };

    expect(await drainFrontier(state, "/ledger", runTicket)).toBe(false);
    expect(calls).toBe(2);
  });

  it("returns true immediately for an empty frontier", async () => {
    const state = stateWith([ts("01-c.md", "01", "committed")]);
    let calls = 0;
    const runTicket = async () => {
      calls++;
      return "ok" as const;
    };
    expect(await drainFrontier(state, "/ledger", runTicket)).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("backfillMission (replan dropped the ticket mission)", () => {
  const ticket = (title: string, mission?: string): PlanTicket => ({
    title,
    mission,
    what: `build ${title}`,
    criteria: [`${title} works`],
    blocked_by: [],
  });

  it("stamps the run mission onto every ticket the replanner left blank", () => {
    const result = backfillMission(
      [ticket("Camera"), ticket("Atlas"), ticket("Lighting")],
      "Ship a polished platformer.",
    );
    expect(result.map((t) => t.mission)).toEqual([
      "Ship a polished platformer.",
      "Ship a polished platformer.",
      "Ship a polished platformer.",
    ]);
  });

  it("preserves a mission the replanner did provide", () => {
    const result = backfillMission(
      [ticket("Camera", "Keep the camera smooth."), ticket("Atlas")],
      "Ship a polished platformer.",
    );
    expect(result[0]!.mission).toBe("Keep the camera smooth.");
    expect(result[1]!.mission).toBe("Ship a polished platformer.");
  });

  it("returns the input untouched when no run mission is known", () => {
    const input = [ticket("Camera"), ticket("Atlas", "")];
    expect(backfillMission(input, "   ")).toBe(input);
    expect(backfillMission(input, "")).toBe(input);
  });
});
