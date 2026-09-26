import { describe, it, expect } from "vitest";
import { createRunState, frontier, newBuilderState, type RunMeta, type RunState } from "./state.ts";
import { normalizeState } from "./ledger.ts";
import type { RailheadConfig } from "../config/config.ts";

const cfg: RailheadConfig = {
  verify: [],
  smoke: [],
  max_retries: 3,
  max_review_retries: null,
  infra_backoff_sec: [5, 15, 45, 120],
  model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null },
};

function make(tickets: any[]): RunState {
  return {
    schema_version: 1,
    cwd: "/x",
    branch: "run/x",
    status: "running",
    tickets_dir: "/x/issues",
    docs_dir: "docs",
    config: cfg,

    pause_on_failure: false,
    verbose: false, quiet: false,
    tickets,
    started_at: "s",
    updated_at: "u",
  };
}

const rawStates = [
  { number: "02", title: "Drive the car", status: "in_progress", blocked_by: [], attempts: 2, start_commit: null, commit: null, verify_ok: true, review_ok: null, review_attempts: 0, reviews: [], duration_ms: 0, logs: [] },
];

describe("frontier", () => {
  it("returns ready tickets whose blockers are committed", () => {
    const state = make([
      { ...rawStates[0], number: "01", title: "a", file: "01-a.md", status: "committed", blocked_by: [] },
      { ...rawStates[0], number: "02", title: "b", file: "02-b.md", status: "ready", blocked_by: ["01-a.md"] },
    ]);
    expect(frontier(state).map((t) => t.number)).toEqual(["02"]);
  });
});

describe("docs_dir (ADR 0051)", () => {
  it("createRunState defaults a missing meta docs_dir to the repo-root docs", () => {
    const state = createRunState({ cwd: "/x", branch: "run/x", tickets_dir: "/x/issues", config: cfg, pause_on_failure: false, verbose: false, quiet: false });
    expect(state.docs_dir).toBe("docs");
  });

  it("createRunState carries the caller-resolved docs_dir through", () => {
    const state = createRunState({ cwd: "/x", branch: "run/x", tickets_dir: "/x/.scratch/add-search/issues", docs_dir: ".scratch/add-search/docs", config: cfg, pause_on_failure: false, verbose: false, quiet: false });
    expect(state.docs_dir).toBe(".scratch/add-search/docs");
  });
});

describe("builder state record (ADR 0022 stage 3, #84)", () => {
  it("createRunState always seeds a builder record (the durable session is the only engine)", () => {
    const meta: RunMeta = {
      cwd: "/x",
      branch: "run/x",
      tickets_dir: "/x/issues",
      config: { ...cfg },
      pause_on_failure: false,
      verbose: false,
      quiet: false,
    };
    expect(createRunState(meta).builder).toEqual({ checkpoint_count: 0, restarts: [] });
  });

  it("normalizeState repairs a partial builder record (an older run that predates the counter/restart fields)", () => {
    const state = make([]);
    state.builder = { session_id: "sess_old", last_green_commit: "abc123" } as unknown as RunState["builder"];
    const normalized = normalizeState(state);
    expect(normalized.builder).toEqual({
      session_id: "sess_old",
      last_green_commit: "abc123",
      checkpoint_count: 0,
      restarts: [],
    });
  });
});

describe("graceful-stop resume fields", () => {
  it("normalizeState fills the owed-gate markers for a run that predates them", () => {
    const state = make([]);
    state.pending_checkpoints = undefined;
    state.visual_pending = undefined;
    const normalized = normalizeState(state);
    expect(normalized.visual_pending).toBeNull();
    expect(normalized.pending_checkpoints).toEqual({ goal: [], structural: [] });
  });

  it("normalizeState repairs a partial pending_checkpoints record", () => {
    const state = make([]);
    state.pending_checkpoints = { goal: ["engine"] } as unknown as RunState["pending_checkpoints"];
    const normalized = normalizeState(state);
    expect(normalized.pending_checkpoints).toEqual({ goal: ["engine"], structural: [] });
  });
});