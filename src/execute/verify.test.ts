import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { runVerify } from "./verify.ts";

async function freshCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "verify-"));
}

describe("runVerify", () => {
  it("passes when every command exits 0", async () => {
    const result = await runVerify(await freshCwd(), ["true", "echo ok"]);
    expect(result.ok).toBe(true);
    expect(result.outputs.join("\n")).toContain("ok");
  });

  it("fails and stops at the first non-zero command", async () => {
    const cwd = await freshCwd();
    const result = await runVerify(cwd, ["echo first", "false", "echo never"]);
    expect(result.ok).toBe(false);
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs.join("\n")).not.toContain("never");
  });

  it("captures stdout and stderr", async () => {
    const result = await runVerify(await freshCwd(), ["echo out && echo err 1>&2"]);
    expect(result.outputs[0]).toContain("out");
    expect(result.outputs[0]).toContain("err");
  });

  // The core gap this test guards: an unattended run has no human to kill a
  // command that never exits (a hung test runner, a dev server started by
  // mistake). Without a timeout, runVerify would hang the whole railhead
  // process forever.
  it("kills a command that exceeds the timeout and fails verify", async () => {
    const cwd = await freshCwd();
    const result = await runVerify(cwd, ["sleep 30"], 1);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.outputs.join("\n")).toContain("exceeded 1s timeout");
  }, 10000);

  it("kills the whole process group, not just the shell wrapper", async () => {
    // A shell command whose real work happens in a grandchild (like a test
    // runner spawning a server). Killing only the `sh -c` wrapper would leave
    // the sleep running; the timeout must reach the process group.
    const cwd = await freshCwd();
    const start = Date.now();
    const result = await runVerify(cwd, ["sh -c 'sleep 30 &\nwait'"], 1);
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it("does not time out a command that finishes well within the limit", async () => {
    const result = await runVerify(await freshCwd(), ["true"], 5);
    expect(result.ok).toBe(true);
    expect(result.timedOut).toBeUndefined();
  });

  it("falls back to the default timeout for null/undefined/non-positive values", async () => {
    // Regression guard for the fallback branch itself, not a real 600s wait:
    // a fast command must still complete normally under each fallback input.
    for (const t of [null, undefined, 0, -5] as const) {
      const result = await runVerify(await freshCwd(), ["true"], t);
      expect(result.ok).toBe(true);
    }
  });
});
