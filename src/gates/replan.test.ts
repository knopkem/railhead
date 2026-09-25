import { describe, it, expect } from "vitest";
import {
  classifyFindings,
  buildReplanPrompt,
  meldReplannedTickets,
  drainFrontier,
  type ReplanClassification,
} from "./replan.ts";
import type { TicketState, RunState } from "../core/state.ts";

function ts(file: string, number: string, status: TicketState["status"]): TicketState {
  return {
    file,
    title: `ticket ${number}`,
    number,
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
  const base = {
    originalPrompt: "Build a task tracker app",
    findings: ["[BLOCKER] plan assumption was wrong"],
    contractsSummary: "TaskRepo (interface) @ src/repo.ts :: create, read, update",
    digest: "Module structure: repository pattern established",
    committedTickets: [{ number: "01", title: "Set up project scaffold", file: "01-scaffold.md" }],
    uncommittedTickets: [{ number: "03", title: "Build API endpoints", file: "03-api.md" }],
  };

  it("includes the original prompt, findings, contracts, and digest", () => {
    const prompt = buildReplanPrompt(base);
    expect(prompt).toContain("Build a task tracker app");
    expect(prompt).toContain("[BLOCKER] plan assumption was wrong");
    expect(prompt).toContain("TaskRepo (interface) @ src/repo.ts :: create, read, update");
    expect(prompt).toContain("Module structure: repository pattern established");
  });

  it("lists committed tickets as fixed context and the uncommitted frontier to replace", () => {
    const prompt = buildReplanPrompt(base);
    expect(prompt).toContain("01-scaffold.md");
    expect(prompt).toContain("Set up project scaffold");
    expect(prompt).toMatch(/committed.*fixed/i);
    expect(prompt).toMatch(/replace.*uncommitted/i);
    expect(prompt).toContain("03-api.md");
  });

  it("tells the planner to generate ADDITIONAL tickets when there is no uncommitted frontier (run-end)", () => {
    const prompt = buildReplanPrompt({ ...base, uncommittedTickets: [] });
    expect(prompt).toMatch(/incomplete/i);
    expect(prompt).toMatch(/additional tickets/i);
    expect(prompt).not.toMatch(/Tickets to replace/);
  });

  it("asks for the small ticket schema and strict emission order, with no retired fields", () => {
    const prompt = buildReplanPrompt(base);
    expect(prompt).toContain('"what"');
    expect(prompt).toContain('"criteria"');
    expect(prompt).toContain('"open_ended"');
    expect(prompt).not.toMatch(/"blocked_by"\s*:/);
    expect(prompt).not.toMatch(/"files"\s*:/);
    expect(prompt).not.toMatch(/"references"\s*:/);
    expect(prompt).toMatch(/order emitted/i);
  });

  it("does not emit verify/design/architecture blocks again", () => {
    const prompt = buildReplanPrompt(base);
    expect(prompt).toMatch(/Do NOT emit \$VERIFY/);
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

