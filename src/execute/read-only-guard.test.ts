import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureInitialCommit, initGit } from "../core/git.ts";
import { ensureProjectGitignore } from "../core/project-assets.ts";
import { eventPath, initLedger } from "../core/ledger.ts";
import { guardReadOnlyPhase } from "./read-only-guard.ts";

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "guard-"));
  await initGit(dir);
  await ensureInitialCommit(dir);
  return dir;
}

async function freshLedger(cwd: string): Promise<string> {
  const ledger = join(cwd, ".railhead", "run-test");
  await initLedger(ledger);
  return ledger;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guardReadOnlyPhase", () => {
  it("returns the phase value and records nothing when the worktree is untouched", async () => {
    const cwd = await freshRepo();
    const ledger = await freshLedger(cwd);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const value = await guardReadOnlyPhase(cwd, ledger, "01-phase", "test phase", async () => 42);

    expect(value).toBe(42);
    expect(warn).not.toHaveBeenCalled();
    await expect(readFile(eventPath(ledger, "01-phase"), "utf8")).rejects.toThrow();
  });

  it("warns and records a worktree.changed event when a write-denied phase writes anyway", async () => {
    const cwd = await freshRepo();
    const ledger = await freshLedger(cwd);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await guardReadOnlyPhase(cwd, ledger, "01-phase", "test phase", async () => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "rogue.ts"), "const rogue = 1;\n", "utf8");
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("write-denied"));
    const event = JSON.parse((await readFile(eventPath(ledger, "01-phase"), "utf8")).trim()) as {
      type: string;
      label: string;
      paths: string[];
    };
    expect(event.type).toBe("worktree.changed");
    expect(event.label).toBe("test phase");
    expect(event.paths).toContain("src/rogue.ts");
  });

  it("records the change even when the phase throws after mutating the tree", async () => {
    const cwd = await freshRepo();
    const ledger = await freshLedger(cwd);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      guardReadOnlyPhase(cwd, ledger, "02-phase", "throwing phase", async () => {
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", "leak.ts"), "x\n", "utf8");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("write-denied"));
    const event = JSON.parse((await readFile(eventPath(ledger, "02-phase"), "utf8")).trim()) as { paths: string[] };
    expect(event.paths).toContain("src/leak.ts");
  });

  it("sees no change when the phase writes railhead's own ignored .railhead tree (the init vision probe)", async () => {
    const cwd = await freshRepo();
    await ensureProjectGitignore(cwd);
    const ledger = await freshLedger(cwd);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await guardReadOnlyPhase(cwd, ledger, "03-phase", "vision probe", async () => {
      await mkdir(join(cwd, ".railhead", "vision-probe"), { recursive: true });
      await writeFile(join(cwd, ".railhead", "vision-probe", "probe.png"), "png\n", "utf8");
    });

    // Without the ignore in place before the probe, this warned "write-denied
    // but changed the worktree" — the probe's own artifact framed as a
    // violation. cmdInit must install the ignore before it probes.
    expect(warn).not.toHaveBeenCalled();
    await expect(readFile(eventPath(ledger, "03-phase"), "utf8")).rejects.toThrow();
  });
});
