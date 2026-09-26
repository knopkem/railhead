import { describe, it, expect } from "vitest";
import {
  planRecovery,
  reconcileCommittedButUnsaved,
  markCommitted,
  rebaseFrontier,
  nextRunStatus,
  shouldResume,
  checkTicketInvariants,
} from "./recovery.ts";
import type { RunState, TicketState } from "./state.ts";
import type { RailheadConfig } from "../config/config.ts";

const cfg: RailheadConfig = {
  verify: [],
  smoke: [],
  max_retries: 3,
  max_review_retries: null,
  infra_backoff_sec: [],
  model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null },
};

function ticket(over: Partial<TicketState>): TicketState {
  return {
    file: "01-a.md",
    title: "a",
    number: "01",
    status: "ready",
    attempts: 0,
    start_commit: null,
    commit: null,
    verify_ok: null,
    review_ok: null,
    review_attempts: 0,
    reviews: [],
    duration_ms: 0,
    logs: [],
    ...over};
}

function state(tickets: TicketState[]): RunState {
  return {
    schema_version: 1,
    cwd: "/x",
    branch: "run/x",
    status: "stopped",
    tickets_dir: "/x/issues",
    docs_dir: "docs",
    config: cfg,

    pause_on_failure: true,
    verbose: false, quiet: false,
    tickets,
    started_at: "s",
    updated_at: "u",
  };
}

describe("planRecovery", () => {
  it("orders checkpoint before reset when a ticket is in flight", () => {
    const steps = planRecovery(ticket({ status: "in_progress" }));
    expect(steps.map((s) => s.kind)).toEqual(["checkpoint", "reset", "rebase"]);
    expect(steps[0]).toEqual({ kind: "checkpoint", ticket: expect.objectContaining({ file: "01-a.md" }) });
  });

  it("drops the checkpoint when nothing is in flight", () => {
    expect(planRecovery(null).map((s) => s.kind)).toEqual(["reset", "rebase"]);
  });
});

describe("reconcileCommittedButUnsaved", () => {
  it("marks a ready ticket whose commit exists as committed, keeping the head hash", () => {
    const r = reconcileCommittedButUnsaved(
      state([ticket({ file: "01-a.md", status: "ready" })]),
      (t) => (t.file === "01-a.md" ? "abc123" : undefined),
    );
    expect(r.tickets[0].status).toBe("committed");
    expect(r.tickets[0].commit).toBe("abc123");
    expect(r.tickets[0].reviews).toEqual([]);
  });

  it("leaves a ticket with no matching commit untouched", () => {
    const original = state([ticket({ file: "01-a.md", status: "ready", attempts: 2 })]);
    const r = reconcileCommittedButUnsaved(original, () => undefined);
    expect(r.tickets[0].status).toBe("ready");
    expect(r.tickets[0].attempts).toBe(2);
  });

  it("does not reconcile a committed ticket", () => {
    const r = reconcileCommittedButUnsaved(
      state([ticket({ file: "01-a.md", status: "committed", commit: "old" })]),
      () => "abc123",
    );
    expect(r.tickets[0].commit).toBe("old");
  });
});

describe("markCommitted", () => {
  it("marks only the named file and records the chain the shell then resetHard-s from", () => {
    const r = markCommitted(state([
      ticket({ file: "01-a.md", status: "in_progress" }),
      ticket({ file: "02-b.md", status: "ready" }),
    ]), "01-a.md", "deadbeef");
    expect(r.tickets[0]).toMatchObject({ status: "committed", commit: "deadbeef" });
    expect(r.tickets[1].status).toBe("ready");
  });
});

describe("rebaseFrontier", () => {
  it("demotes an in_progress ticket to ready and resets its counters", () => {
    const r = rebaseFrontier(state([
      ticket({ file: "01-a.md", status: "in_progress", attempts: 3, reviews: [{ phase: "x", attempt: 1, blocking: true, findings: ["b"] }] }),
      ticket({ file: "02-b.md", status: "committed", attempts: 2 }),
    ]));
    const t = r.tickets.find((x) => x.file === "01-a.md")!;
    expect(t).toMatchObject({ status: "ready", attempts: 0, verify_ok: null, review_ok: null, review_attempts: 0 });
    expect(t.reviews).toEqual([]);
    // committed tickets are untouched
    expect(r.tickets.find((x) => x.file === "02-b.md")!.attempts).toBe(2);
  });

  it("re-arms a failed ticket (ADR 0003 stop-don't-skip) with a fresh budget and ladder", () => {
    // A hard fail stopped the run for a human; the resume must re-run the
    // un-landed ticket before the frontier can advance past it — a skip would
    // build downstream tickets on a base that never landed.
    const r = rebaseFrontier(state([
      ticket({ file: "01-a.md", status: "failed", attempts: 4, verify_ok: true, review_ok: null, ladder_rung: 2, last_failure_class: "stall" }),
      ticket({ file: "02-b.md", status: "ready" }),
    ]));
    const t = r.tickets.find((x) => x.file === "01-a.md")!;
    expect(t).toMatchObject({
      status: "ready",
      attempts: 0,
      verify_ok: null,
      review_ok: null,
      review_attempts: 0,
      ladder_rung: undefined,
      last_failure_class: undefined,
    });
    expect(t.reviews).toEqual([]);
    // The ready ticket after it is untouched and comes second in the frontier.
    expect(r.tickets.find((x) => x.file === "02-b.md")!.status).toBe("ready");
  });

  it("demotes an in_progress ticket to ready even when a checkpoint was intended (the checkpoint must NOT mark the ticket committed)", () => {
    // Simulate the recovery sequence: an in_progress ticket gets a checkpoint
    // commit (preserving work), then rebaseFrontier runs. The ticket must
    // end up as `ready` — NOT `committed`. A checkpoint is interrupted work;
    // marking it committed silently skips the ticket on resume.
    const inFlight = ticket({ status: "in_progress", attempts: 2 });
    const steps = planRecovery(inFlight);
    expect(steps).toHaveLength(3);
    expect(steps[0].kind).toBe("checkpoint");

    // The checkpoint step in cli.ts previously called markCommitted, which
    // set status to "committed". That was the bug. The fix: do NOT call
    // markCommitted in the checkpoint step — the ticket stays in_progress,
    // and rebaseFrontier demotes it to ready.
    let recovered = state([inFlight]);
    // (checkpoint step: no state change — git commit only)
    // (reset step: no state change — git reset only)
    // rebase step:
    recovered = rebaseFrontier(recovered);

    expect(recovered.tickets[0].status).toBe("ready");
    expect(recovered.tickets[0].attempts).toBe(0);
  });
});

describe("nextRunStatus", () => {
  // The snake-qwen resume silently exited the loop with status="running"
  // because 02 was stuck in_progress (recovery was thrown away — see
  // cmdResume fix) but the loop's no-frontier branch only handled
  // "everything committed => finished" and "some failed => stopped". An
  // in-progress ticket that the loop couldn't transition left the run
  // looking still-in-progress on disk forever.
  it("marks the run finished when every ticket is committed", () => {
    const s = state([
      ticket({ file: "01-a.md", status: "committed" }),
      ticket({ file: "02-b.md", status: "committed" }),
    ]);
    expect(nextRunStatus(s)).toBe("finished");
  });

  it("marks the run stopped when any ticket has failed", () => {
    const s = state([
      ticket({ file: "01-a.md", status: "committed" }),
      ticket({ file: "02-b.md", status: "failed" }),
    ]);
    expect(nextRunStatus(s)).toBe("stopped");
  });

  it("marks the run stopped when remaining tickets are neither ready nor committed (interrupted bracket)", () => {
    const s = state([
      ticket({ file: "01-a.md", status: "committed" }),
      ticket({ file: "02-b.md", status: "in_progress", attempts: 5 }),
    ]);
    expect(nextRunStatus(s)).toBe("stopped");
  });

  it("marks the run stopped when a ticket is skipped (user-acknowledged non-completion)", () => {
    const s = state([
      ticket({ file: "01-a.md", status: "committed" }),
      ticket({ file: "02-b.md", status: "skipped" }),
    ]);
    expect(nextRunStatus(s)).toBe("stopped");
  });
});

describe("shouldResume", () => {
  it("returns true for a matching branch with status running", () => {
    const s = state([]);
    s.status = "running";
    expect(shouldResume("run/x", s)).toBe(true);
  });

  it("returns true for a matching branch with status stopped", () => {
    const s = state([]);
    s.status = "stopped";
    expect(shouldResume("run/x", s)).toBe(true);
  });

  it("returns false for a matching branch with status finished", () => {
    const s = state([]);
    s.status = "finished";
    expect(shouldResume("run/x", s)).toBe(false);
  });

  it("returns false for a matching branch with status failed", () => {
    const s = state([]);
    s.status = "failed";
    expect(shouldResume("run/x", s)).toBe(false);
  });

  it("returns false for a mismatched branch", () => {
    const s = state([]);
    s.status = "running";
    s.branch = "run/other";
    expect(shouldResume("run/x", s)).toBe(false);
  });

  it("returns false when priorState is null", () => {
    expect(shouldResume("run/x", null)).toBe(false);
  });
});

describe("checkTicketInvariants", () => {
  const st = (file: string, title: string) => ({ file, title });

  it("returns empty when state and disk match", () => {
    const result = checkTicketInvariants(
      [st("01-a.md", "A"), st("02-b.md", "B")],
      [st("01-a.md", "A"), st("02-b.md", "B")],
    );
    expect(result).toEqual([]);
  });

  it("reports missing_on_disk for tickets in state but not on disk", () => {
    const result = checkTicketInvariants(
      [st("01-a.md", "A"), st("02-b.md", "B")],
      [st("01-a.md", "A")],
    );
    expect(result).toEqual([
      { file: "02-b.md", problem: "missing_on_disk", stateTitle: "B" },
    ]);
  });

  it("reports missing_in_state for tickets on disk but not in state", () => {
    const result = checkTicketInvariants(
      [st("01-a.md", "A")],
      [st("01-a.md", "A"), st("02-b.md", "B")],
    );
    expect(result).toEqual([
      { file: "02-b.md", problem: "missing_in_state", diskTitle: "B" },
    ]);
  });

  it("reports title_mismatch for same file with different title", () => {
    const result = checkTicketInvariants(
      [st("01-a.md", "Alpha")],
      [st("01-a.md", "Beta")],
    );
    expect(result).toEqual([
      { file: "01-a.md", problem: "title_mismatch", stateTitle: "Alpha", diskTitle: "Beta" },
    ]);
  });

  it("reports multiple divergences at once", () => {
    const result = checkTicketInvariants(
      [st("01-a.md", "A"), st("03-c.md", "C")],
      [st("01-a.md", "A"), st("02-b.md", "B"), st("03-c.md", "Changed")],
    );
    expect(result).toHaveLength(2);
    expect(result.find((d) => d.file === "02-b.md")?.problem).toBe("missing_in_state");
    expect(result.find((d) => d.file === "03-c.md")?.problem).toBe("title_mismatch");
  });

  it("returns empty for two empty lists", () => {
    expect(checkTicketInvariants([], [])).toEqual([]);
  });
});