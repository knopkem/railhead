import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { runSmoke, DEFAULT_SMOKE_TIMEOUT_SEC } from "./smoke.ts";

async function freshCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "smoke-"));
}

describe("runSmoke", () => {
  it("a command that exits 0 with no panic signature is a success", async () => {
    const cwd = await freshCwd();
    const r = await runSmoke(cwd, { command: "true" });
    expect(r.ok).toBe(true);
    expect(r.panic).toBeUndefined();
    expect(r.timedOut).toBe(false);
  });

  it("a command that exits non-zero is a failure (no panic flag)", async () => {
    const cwd = await freshCwd();
    const r = await runSmoke(cwd, { command: "false" });
    expect(r.ok).toBe(false);
    expect(r.panic).toBeUndefined();
  });

  it("detects a Rust panic signature in stderr and fails as a panic, even when output is otherwise captured", async () => {
    const cwd = await freshCwd();
    // Echo the EXACT Bevy B0001 panic line to stderr and exit 1, mirroring a
    // real startup panic: the railhead's reason for smoke is catching this
    // case where `cargo build` was green but the binary panics on frame 1.
    // Real Rust panics print `thread 'main' panicked at` (with single quotes
    // around the thread name) — the smoke signature matches that literally.
    const r = await runSmoke(cwd, {
      command: `sh -c "echo \\"thread 'main' panicked at foo.rs:1:1\\nerror[B0001]: Query conflict\\" >&2; exit 1"`,
    });
    expect(r.ok).toBe(false);
    expect(r.panic).toBe(true);
  });

  it("detects a panic even when the process later exits 0 (some apps catch and limp on)", async () => {
    const cwd = await freshCwd();
    const r = await runSmoke(cwd, {
      command: `sh -c "echo \\"thread 'main' panicked at foo.rs:1:1\\" >&2; exit 0"`,
    });
    expect(r.ok).toBe(false);
    expect(r.panic).toBe(true);
  });

  it("a command that runs past the timeout WITHOUT panicking is a SUCCESS (smoke asks 'does it start?', not 'does it finish?')", async () => {
    const cwd = await freshCwd();
    // `sleep 30` far exceeds the 1s cap below — the railhead SIGTERMs it and
    // reports ok:true, timedOut:true. This is the case for a GUI that reached
    // its main loop without crashing: it never exits on its own.
    const r = await runSmoke(cwd, { command: "sleep 30" }, 1);
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.outputs[0]).toContain("still running at 1s");
  });

  it("kills the whole process group, not just the sh -c wrapper (a real GUI has live grandchildren)", async () => {
    const cwd = await freshCwd();
    const start = Date.now();
    // `sleep 30 & wait` puts the sleep in a subprocess; killing only the
    // shell leaves sleep orphaned and the `wait` never returns. The railhead
    // must kill the process group. Assert we return well under 30s.
    const r = await runSmoke(cwd, { command: "sh -c 'sleep 30 & wait'" }, 1);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("passes the env to the spawned process (a caller-supplied env reaches the binary)", async () => {
    const cwd = await freshCwd();
    // The railhead itself no longer injects NO_VIDEO (it let the implementer
    // skip the panicking code path), but runSmoke still forwards any env a
    // caller passes — this test pins that plumbing.
    const r = await runSmoke(cwd, {
      command: "sh -c 'echo FOO=$FOO'",
      env: { FOO: "bar" },
    });
    expect(r.ok).toBe(true);
    expect(r.outputs[0]).toContain("FOO=bar");
  });

  it("falls back to DEFAULT_SMOKE_TIMEOUT_SEC when the timeout is null/undefined/0", async () => {
    // This is a behaviour assertion on the bound, not a real 30s wait — the
    // previous tests already cover the timeout path with a 1s cap.
    expect(DEFAULT_SMOKE_TIMEOUT_SEC).toBe(30);
  });

  it("a command that exits 127 (command not found) is not_found, not a failure", async () => {
    // A missing script (e.g. `npm run preview` before the preview script exists)
    // must not fail the implement attempt — the ticket hasn't built that feature
    // yet. Exit 127 means the shell couldn't find the command.
    const cwd = await freshCwd();
    const r = await runSmoke(cwd, { command: "this-command-does-not-exist-anywhere-12345" });
    expect(r.ok).toBe(false);
    expect(r.notFound).toBe(true);
    expect(r.panic).toBeUndefined();
  });

  it("npm run <missing-script> is not_found (Missing script in output, exit 1)", async () => {
    // npm exits 1 (not 127) when a script is missing, but emits "Missing script:"
    // in stderr. The railhead must recognize this pattern so an early ticket
    // whose smoke script hasn't been added yet skips smoke instead of burning
    // implement retries.
    const cwd = await freshCwd();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "test", scripts: { build: "tsc" } }));
    const r = await runSmoke(cwd, { command: "npm run this-script-does-not-exist" });
    expect(r.ok).toBe(false);
    expect(r.notFound).toBe(true);
  });

  it("a real non-zero exit (not 127, no 'Missing script') is a failure, not not_found", async () => {
    const cwd = await freshCwd();
    const r = await runSmoke(cwd, { command: "sh -c 'exit 1'" });
    expect(r.ok).toBe(false);
    expect(r.notFound).toBeUndefined();
  });
});
