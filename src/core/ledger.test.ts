import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { initLedger, resetPhase, eventPath, readStderrLines, listPhases, boundedLog, writeRawLog, rawLogPath, writeState, readState, findRunForBranch, removeRun, ledgerDir, catHeredocBody, appendEvent } from "./ledger.ts";
import type { RunState } from "./state.ts";
import type { RailheadConfig } from "../config/config.ts";

const cfg: RailheadConfig = {
  verify: [],
  smoke: [],
  max_retries: 3,
  max_review_retries: null,
  infra_backoff_sec: [],
  model: { plan: null, implement: null, review: null, visual: null, goal: null, extract: null },
};

function makeState(branch: string, status: RunState["status"]): RunState {
  return {
    schema_version: 1,
    cwd: "/x",
    branch,
    status,
    tickets_dir: "/x/issues",
    docs_dir: "docs",
    config: cfg,

    pause_on_failure: false,
    verbose: false,
    quiet: false,
    tickets: [],
    started_at: "s",
    updated_at: "u",
  };
}

describe("resetPhase", () => {
  it("clears the phase and its stderr file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    const phase = "plan";
    await writeFile(eventPath(dir, phase), "old events\n", "utf8");
    await writeFile(eventPath(dir, `${phase}.stderr`), "old err\n", "utf8");

    await resetPhase(dir, phase);

    expect(await readFile(eventPath(dir, phase), "utf8")).toBe("");
    expect(await readFile(eventPath(dir, `${phase}.stderr`), "utf8")).toBe("");
  });
});

describe("self-healing ledger writes", () => {
  it("appendEvent recreates a deleted run directory and events dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await rm(dir, { recursive: true, force: true });

    await appendEvent(dir, "goal-scaffold", "line one");

    expect(await readFile(eventPath(dir, "goal-scaffold"), "utf8")).toBe("line one\n");
  });

  it("writeState recreates a deleted run directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await rm(dir, { recursive: true, force: true });

    await writeState(dir, makeState("run/x", "running"));

    expect((await readState(dir)).status).toBe("running");
  });

  it("resetPhase recreates a deleted events dir before truncating", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await rm(join(dir, "events"), { recursive: true, force: true });

    await resetPhase(dir, "plan");

    expect(await readFile(eventPath(dir, "plan"), "utf8")).toBe("");
  });

  it("writeRawLog recreates a deleted events dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await rm(join(dir, "events"), { recursive: true, force: true });

    await writeRawLog(dir, "verify", "full output");

    expect(await readFile(rawLogPath(dir, "verify"), "utf8")).toBe("full output");
  });
});

describe("readStderrLines", () => {
  it("returns [] when the stderr phase file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    expect(await readStderrLines(dir, "missing-phase")).toEqual([]);
  });

  it("reads each non-empty stderr chunk as a line, preserving ANSI escapes verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await mkdir(join(dir, "events"), { recursive: true });
    const ansi = "\u001b[93m\u001b[1m! \u001b[0mpermission requested: external_directory (foo/*); auto-rejecting";
    await writeFile(eventPath(dir, "02-02-implement.stderr"), `${ansi}\n\nsecond\n`, "utf8");
    const lines = await readStderrLines(dir, "02-02-implement");
    expect(lines).toEqual([ansi, "second"]);
  });
});

describe("listPhases", () => {
  it("returns [] when the events dir does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    expect(await listPhases(dir)).toEqual([]);
  });

  it("lists phase names from *.jsonl, dropping the .stderr sidecars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await mkdir(join(dir, "events"), { recursive: true });
    for (const name of [
      "01-01-implement.jsonl",
      "01-01-implement.stderr.jsonl",
      "01-01-review.jsonl",
      "01-contracts.jsonl",
      "02-01-implement.jsonl",
      "02-01-implement.stderr.jsonl",
    ]) {
      await writeFile(join(dir, "events", name), "{}\n", "utf8");
    }
    const phases = await listPhases(dir);
    expect(phases).toEqual(["01-01-implement", "01-01-review", "01-contracts", "02-01-implement"]);
  });

  it("sorts phases in natural numeric order so 02-10 follows 02-02", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await mkdir(join(dir, "events"), { recursive: true });
    for (const name of [
      "02-10-implement.jsonl",
      "02-02-implement.jsonl",
      "01-01-implement.jsonl",
      "02-09-implement.jsonl",
    ]) {
      await writeFile(join(dir, "events", name), "{}\n", "utf8");
    }
    const phases = await listPhases(dir);
    expect(phases).toEqual([
      "01-01-implement",
      "02-02-implement",
      "02-09-implement",
      "02-10-implement",
    ]);
  });

  it("skips files that are not .jsonl (e.g. report.md, state.json)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    await mkdir(join(dir, "events"), { recursive: true });
    await writeFile(join(dir, "events", "01-01-implement.jsonl"), "{}\n", "utf8");
    await writeFile(join(dir, "events", "README.md"), "ignore me\n", "utf8");
    await writeFile(join(dir, "state.json"), "{}\n", "utf8");
    expect(await listPhases(dir)).toEqual(["01-01-implement"]);
  });
});

describe("boundedLog", () => {
  it("returns the full text with its label when under the max", () => {
    expect(boundedLog("verify ok", "short output", 100)).toBe("verify ok: short output");
  });

  it("keeps only the tail and notes the original size once over the max", () => {
    const text = "a".repeat(50) + "TAIL";
    const out = boundedLog("verify FAILED", text, 4);
    expect(out).toBe("verify FAILED (showing last 4 of 54 chars): TAIL");
  });

  it("never grows unboundedly regardless of input size", () => {
    const huge = "x".repeat(2_000_000);
    const out = boundedLog("implement 01-01-implement ok", huge);
    // Bounded to the max plus a small fixed-size label/header, not O(input).
    expect(out.length).toBeLessThan(4200);
  });
});

describe("writeRawLog / rawLogPath", () => {
  it("writes the full content to a plain-text sidecar under events/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    const content = "$ npm test\nfull test output across many lines\n".repeat(100);
    await writeRawLog(dir, "01-01-verify", content);
    const onDisk = await readFile(rawLogPath(dir, "01-01-verify"), "utf8");
    expect(onDisk).toBe(content);
  });

  it("keeps full fidelity (no truncation) even for large output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "led-"));
    await initLedger(dir);
    const content = "e".repeat(10_000) + "COMPILER ERROR AT END";
    await writeRawLog(dir, "02-01-verify", content);
    const onDisk = await readFile(rawLogPath(dir, "02-01-verify"), "utf8");
    expect(onDisk.length).toBe(content.length);
    expect(onDisk.endsWith("COMPILER ERROR AT END")).toBe(true);
  });
});

describe("catHeredocBody", () => {
  it("recovers a quoted heredoc body (the spriteforge plan-emitted-via-cat shape)", () => {
    expect(catHeredocBody("cat << 'ENDOFPLAN'\n$VERIFY\nnpm test\n$TICKETS\n[]\nENDOFPLAN")).toBe(
      "$VERIFY\nnpm test\n$TICKETS\n[]",
    );
  });

  it("recovers an unquoted heredoc and a /dev/null throwaway", () => {
    expect(catHeredocBody("cat > /dev/null << EOF\nnote\nEOF")).toBe("note");
    expect(catHeredocBody("cat <<EOF\nbody\nEOF")).toBe("body");
  });

  it("skips a heredoc redirected to a real file (content lives on disk)", () => {
    expect(catHeredocBody("cat > src/x.ts << 'EOF'\nfile body\nEOF")).toBeNull();
  });

  it("returns null for a non-cat or non-heredoc command", () => {
    expect(catHeredocBody("ls -la")).toBeNull();
    expect(catHeredocBody("echo hi")).toBeNull();
    expect(catHeredocBody("")).toBeNull();
  });
});

describe("findRunForBranch", () => {
  it("returns the matching run with status running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir = ledgerDir(cwd, "run-20260826-1000");
    await initLedger(dir);
    await writeState(dir, makeState("run/x", "running"));

    const result = await findRunForBranch(cwd, "run/x");
    expect(result?.runId).toBe("run-20260826-1000");
    expect(result?.state.status).toBe("running");
  });

  it("returns the matching run with status stopped", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir = ledgerDir(cwd, "run-20260826-1000");
    await initLedger(dir);
    await writeState(dir, makeState("run/x", "stopped"));

    const result = await findRunForBranch(cwd, "run/x");
    expect(result?.runId).toBe("run-20260826-1000");
  });

  it("returns null for a finished run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir = ledgerDir(cwd, "run-20260826-1000");
    await initLedger(dir);
    await writeState(dir, makeState("run/x", "finished"));

    expect(await findRunForBranch(cwd, "run/x")).toBeNull();
  });

  it("returns null for a failed run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir = ledgerDir(cwd, "run-20260826-1000");
    await initLedger(dir);
    await writeState(dir, makeState("run/x", "failed"));

    expect(await findRunForBranch(cwd, "run/x")).toBeNull();
  });

  it("returns null for a mismatched branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir = ledgerDir(cwd, "run-20260826-1000");
    await initLedger(dir);
    await writeState(dir, makeState("run/x", "running"));

    expect(await findRunForBranch(cwd, "run/other")).toBeNull();
  });

  it("returns the newest matching run when multiple exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir1 = ledgerDir(cwd, "run-20260826-1000");
    const dir2 = ledgerDir(cwd, "run-20260826-2000");
    await initLedger(dir1);
    await initLedger(dir2);
    await writeState(dir1, makeState("run/x", "stopped"));
    await writeState(dir2, makeState("run/x", "running"));

    const result = await findRunForBranch(cwd, "run/x");
    expect(result?.runId).toBe("run-20260826-2000");
  });

  it("returns null when no runs exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    expect(await findRunForBranch(cwd, "run/x")).toBeNull();
  });

  it("skips runs with corrupt state.json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir1 = ledgerDir(cwd, "run-20260826-1000");
    const dir2 = ledgerDir(cwd, "run-20260826-2000");
    await initLedger(dir1);
    await initLedger(dir2);
    await writeFile(join(dir1, "state.json"), "{corrupt", "utf8");
    await writeState(dir2, makeState("run/x", "running"));

    const result = await findRunForBranch(cwd, "run/x");
    expect(result?.runId).toBe("run-20260826-2000");
  });
});

describe("removeRun", () => {
  it("removes the run directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    const dir = ledgerDir(cwd, "run-20260826-1000");
    await initLedger(dir);
    await writeState(dir, makeState("run/x", "stopped"));

    await removeRun(cwd, "run-20260826-1000");

    await expect(readState(dir)).rejects.toThrow();
  });

  it("does not throw when the run does not exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "led-"));
    await expect(removeRun(cwd, "run-nonexistent")).resolves.toBeUndefined();
  });
});
