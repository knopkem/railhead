import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkProbeOutput, registerProbes, probesForGroup, materializeProbeScripts, runRegisteredProbes, type ProbeRunner } from "./probes.ts";
import { createRunState, type RunState } from "./state.ts";
import { initLedger, readState, writeState } from "./ledger.ts";
import type { RailheadConfig } from "../config/config.ts";

const cfg: RailheadConfig = {
  verify: [],
  smoke: [],
  max_retries: 3,
  max_review_retries: null,
  infra_backoff_sec: [5, 15, 45, 120],
  model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null },
};

function makeState(cwd: string): RunState {
  return createRunState({
    cwd,
    branch: "run/x",
    tickets_dir: join(cwd, ".scratch", "x", "issues"),
    config: { ...cfg },
    pause_on_failure: false,
    verbose: false,
    quiet: true,
  });
}

describe("checkProbeOutput", () => {
  it("passes when the expected predicate appears in the output, case-insensitively", () => {
    expect(checkProbeOutput("paused=true\n", "PAUSED=TRUE")).toBe(true);
    expect(checkProbeOutput("the grid has 9 cells", "9 cells")).toBe(true);
  });

  it("fails when the predicate is absent, and treats an empty predicate as command-exit-only", () => {
    expect(checkProbeOutput("paused=false", "paused=true")).toBe(false);
    expect(checkProbeOutput("anything", "   ")).toBe(true);
  });
});

describe("registerProbes", () => {
  it("assigns stable sequential ids and groups entries", () => {
    const state = makeState("/x");
    const added = registerProbes(state, "core", [
      { behavior: "the grid renders", command: "node probe.mjs", expect: "9 cells" },
      { behavior: "the pause stops the clock", command: "node pause.mjs", expect: "paused=true" },
    ]);
    expect(added.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(probesForGroup(state, "core").map((p) => p.behavior)).toEqual(["the grid renders", "the pause stops the clock"]);
    expect(probesForGroup(state, "other")).toEqual([]);
  });

  it("is idempotent per (group, behavior, command): a re-emitted probe is not duplicated", () => {
    const state = makeState("/x");
    registerProbes(state, "core", [{ behavior: "b", command: "c", expect: "e" }]);
    const again = registerProbes(state, "core", [
      { behavior: "b", command: "c", expect: "e" },
      { behavior: "b2", command: "c2", expect: "e2" },
    ]);
    expect(again.map((p) => p.id)).toEqual(["p2"]);
    expect(state.probes).toHaveLength(2);
  });

  it("drops recipes missing a behavior or command", () => {
    const state = makeState("/x");
    const added = registerProbes(state, "core", [
      { behavior: "", command: "c", expect: "e" },
      { behavior: "b", command: "   ", expect: "e" },
    ]);
    expect(added).toEqual([]);
    expect(state.probes).toBeUndefined();
  });

  it("survives a ledger round-trip (resume-safe)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "probes-"));
    const ledger = join(cwd, ".railhead", "run-test");
    await initLedger(ledger);
    const state = makeState(cwd);
    registerProbes(state, "core", [{ behavior: "the grid renders", command: "node probe.mjs", expect: "9 cells" }]);
    await writeState(ledger, state);
    const loaded = await readState(ledger);
    expect(loaded?.probes?.[0]?.behavior).toBe("the grid renders");
    expect(probesForGroup(loaded!, "core")[0]!.command).toBe("node probe.mjs");
  });
});

describe("materializeProbeScripts", () => {
  it("writes each command as an executable .railhead/probes/<id>.sh", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "probes-"));
    const state = makeState(cwd);
    const added = registerProbes(state, "core", [{ behavior: "b", command: "node probe.mjs && echo ok", expect: "ok" }]);
    const paths = await materializeProbeScripts(cwd, added);
    expect(paths).toEqual([join(cwd, ".railhead", "probes", "p1.sh")]);
    const body = await readFile(paths[0]!, "utf8");
    expect(body).toContain("node probe.mjs && echo ok");
    expect(body.startsWith("#!/bin/sh")).toBe(true);
  });
});

describe("runRegisteredProbes", () => {
  const entries = [
    { id: "p1", group: "core", behavior: "grid", command: "node grid.mjs", expect: "9 cells", created_at: "t" },
    { id: "p2", group: "core", behavior: "pause", command: "node pause.mjs", expect: "paused=true", created_at: "t" },
  ];

  it("passes a probe whose output contains the predicate and fails one that does not", async () => {
    const runner: ProbeRunner = async (script) =>
      script.endsWith("p1.sh")
        ? { code: 0, output: "the grid has 9 cells", timedOut: false }
        : { code: 0, output: "paused=false", timedOut: false };
    const results = await runRegisteredProbes("/x", entries, { runner });
    expect(results.map((r) => r.status)).toEqual(["pass", "fail"]);
  });

  it("classifies a non-zero exit or timeout as an error (recipe unreliable), never a behavior fail", async () => {
    const runner: ProbeRunner = async (script) =>
      script.endsWith("p1.sh")
        ? { code: 1, output: "boom", timedOut: false }
        : { code: null, output: "hang", timedOut: true };
    const results = await runRegisteredProbes("/x", entries, { runner });
    expect(results.map((r) => r.status)).toEqual(["error", "error"]);
  });

  it("never throws when the runner itself fails", async () => {
    const runner: ProbeRunner = async () => { throw new Error("spawn exploded"); };
    const results = await runRegisteredProbes("/x", entries, { runner });
    expect(results.map((r) => r.status)).toEqual(["error", "error"]);
    expect(results[0]!.output).toContain("spawn exploded");
  });
});
