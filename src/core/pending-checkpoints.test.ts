import { describe, it, expect } from "vitest";
import {
  addPendingCheckpoint,
  clearPendingCheckpoint,
  owedCheckpointGroups,
  pendingCheckpointGroups,
} from "./pending-checkpoints.ts";
import type { RunState } from "./state.ts";

function state(over: Partial<RunState> = {}): RunState {
  return {
    schema_version: 1,
    cwd: "/x",
    branch: "run/x",
    status: "running",
    tickets_dir: "/x/issues",
    config: { verify: [], smoke: [], max_retries: 3, max_review_retries: null, infra_backoff_sec: [], model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null } },
    pause_on_failure: false,
    verbose: false,
    quiet: false,
    tickets: [],
    started_at: "s",
    updated_at: "u",
    pending_checkpoints: { goal: [], structural: [] },
    ...over,
  };
}

describe("add/clear/pendingCheckpointGroups", () => {
  it("records a gate's group without duplicates", () => {
    const s = state();
    addPendingCheckpoint(s, "goal", "engine");
    addPendingCheckpoint(s, "goal", "engine");
    addPendingCheckpoint(s, "structural", "engine");
    expect(pendingCheckpointGroups(s, "goal")).toEqual(["engine"]);
    expect(pendingCheckpointGroups(s, "structural")).toEqual(["engine"]);
  });

  it("keeps the two gates' pending sets independent", () => {
    const s = state();
    addPendingCheckpoint(s, "goal", "engine");
    addPendingCheckpoint(s, "structural", "polish");
    clearPendingCheckpoint(s, "goal", "engine");
    expect(pendingCheckpointGroups(s, "goal")).toEqual([]);
    expect(pendingCheckpointGroups(s, "structural")).toEqual(["polish"]);
  });

  it("repairs a missing pending record rather than throwing", () => {
    const s = state({ pending_checkpoints: undefined });
    addPendingCheckpoint(s, "goal", "engine");
    expect(pendingCheckpointGroups(s, "goal")).toEqual(["engine"]);
    expect(pendingCheckpointGroups(s, "structural")).toEqual([]);
  });

  it("clear is a no-op on a state that never recorded anything", () => {
    const s = state({ pending_checkpoints: undefined });
    clearPendingCheckpoint(s, "goal", "engine");
    expect(s.pending_checkpoints).toBeUndefined();
  });
});

describe("owedCheckpointGroups", () => {
  it("runs pending groups the gate has not recorded", () => {
    const s = state();
    addPendingCheckpoint(s, "goal", "engine");
    addPendingCheckpoint(s, "goal", "polish");
    expect(owedCheckpointGroups(s, "goal", true, ["polish"])).toEqual({
      run: ["engine"],
      drop: ["polish"],
    });
  });

  it("drops every pending group when the gate can no longer fire mid-run", () => {
    const s = state();
    addPendingCheckpoint(s, "goal", "engine");
    expect(owedCheckpointGroups(s, "goal", false, [])).toEqual({
      run: [],
      drop: ["engine"],
    });
  });

  it("drops a recorded group even when the gate can fire — the record is the dedup", () => {
    const s = state();
    addPendingCheckpoint(s, "structural", "engine");
    expect(owedCheckpointGroups(s, "structural", true, ["engine"])).toEqual({
      run: [],
      drop: ["engine"],
    });
  });

  it("returns empty sets when nothing is pending", () => {
    expect(owedCheckpointGroups(state(), "goal", true, [])).toEqual({ run: [], drop: [] });
  });
});
