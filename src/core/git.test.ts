import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, expect } from "vitest";
import {
  cleanWorktree,
  commit,
  commitMessageExists,
  commitOrReuseHead,
  ensureInitialCommit,
  initGit,
  rangeDiff,
  workingDiff,
  readProjectDoc,
  writeProjectDoc,
} from "./git.ts";

const dirs: string[] = [];

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-"));
  dirs.push(dir);
  await initGit(dir);
  await ensureInitialCommit(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) dirs.pop();
});

describe("workingDiff", () => {
  it("shows modifications to tracked files", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "tracked.txt"), "v1\n");
    await commit(cwd, "add tracked");
    await writeFile(join(cwd, "tracked.txt"), "v2\n");
    const diff = await workingDiff(cwd);
    expect(diff).toContain("-v1");
    expect(diff).toContain("+v2");
  });

  it("includes newly created (untracked) files — the snake-build bug", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "existing.txt"), "kept\n");
    await commit(cwd, "baseline");
    // [BLOCKER] Diff is empty: implementer wrote a brand-new file via `write`,
    // but `git diff HEAD` only shows tracked changes — the reviewer saw nothing.
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "world.rs"), "pub const WORLD_WIDTH: usize = 40;\n");
    await writeFile(join(cwd, "Cargo.toml"), '[package]\nname = "snake"\n');
    const diff = await workingDiff(cwd);
    expect(diff).toContain("src/world.rs");
    expect(diff).toContain("pub const WORLD_WIDTH");
    expect(diff).toContain("Cargo.toml");
    expect(diff).toContain('"snake"');
  });

  it("leaves the worktree and index intact after reading the diff", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "kept.txt"), "kept\n");
    await commit(cwd, "baseline");
    await writeFile(join(cwd, "new.txt"), "new\n");
    await workingDiff(cwd);
    // `git status --porcelain` must still report new.txt as untracked (?  ?),
    // proving workingDiff did not stage anything.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd });
    expect(stdout.trim()).toBe("?? new.txt");
  });

  it("returns an empty string when nothing changed", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "x.txt"), "x\n");
    await commit(cwd, "x");
    const diff = await workingDiff(cwd);
    expect(diff).toBe("");
  });

  it("does not include gitignored files in the diff (git add -A -N respects .gitignore)", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, ".gitignore"), ".playwright-mcp/\n*.png\n");
    await writeFile(join(cwd, "src.ts"), "export const x = 1;\n");
    await commit(cwd, "baseline");

    await writeFile(join(cwd, "new-source.ts"), "export const y = 2;\n");
    await mkdir(join(cwd, ".playwright-mcp"), { recursive: true }).catch(() => {});
    await writeFile(join(cwd, ".playwright-mcp", "page.yml"), "noise\n");
    await writeFile(join(cwd, "screenshot.png"), "binary noise\n");

    const diff = await workingDiff(cwd);
    expect(diff).toContain("new-source.ts");
    expect(diff).not.toContain("playwright-mcp");
    expect(diff).not.toContain("screenshot.png");
  });
});

// Node's execFile defaults maxBuffer to 1 MiB. A real railhead build produces
// diffs (and full `git diff from..to` ranges) comfortably larger than that —
// the snake-qwen run crashed with "stdout maxBuffer length exceeded" once the
// second implement attempt stacked ~1 MiB of Rust source on disk. Any git
// helper in this module must absorb multi-MiB output without throwing.
describe("maxBuffer — large outputs", () => {
  it("workingDiff returns a diff larger than the 1 MiB execFile default", async () => {
    const cwd = await freshRepo();
    await mkdir(join(cwd, "src"));
    // 64 lines * 64 KiB/line ≈ 4 MiB — well past the legacy 1 MiB ceiling.
    const chunk = "x".repeat(64 * 1024) + "\n";
    for (let i = 0; i < 64; i++) {
      await writeFile(join(cwd, "src", `chunk-${i}.txt`), chunk);
    }
    const diff = await workingDiff(cwd);
    expect(diff.length).toBeGreaterThan(1024 * 1024);
  });

  it("rangeDiff returns a committed range larger than the 1 MiB default", async () => {
    const cwd = await freshRepo();
    const before = await headCommitRaw(cwd);
    await mkdir(join(cwd, "src"));
    const chunk = "y".repeat(64 * 1024) + "\n";
    for (let i = 0; i < 64; i++) {
      await writeFile(join(cwd, "src", `c-${i}.txt`), chunk);
    }
    await commit(cwd, "big");
    const after = await headCommitRaw(cwd);
    const diff = await rangeDiff(cwd, before, after);
    expect(diff.length).toBeGreaterThan(1024 * 1024);
  });
});

async function headCommitRaw(cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

describe("commitOrReuseHead", () => {
  it("reuses HEAD when nothing changed — the implementer-made-no-changes case", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "x.txt"), "v1\n");
    await commit(cwd, "baseline");
    const before = await headCommitRaw(cwd);

    const hash = await commitOrReuseHead(cwd, "01 — nothing to do");
    const after = await headCommitRaw(cwd);

    expect(hash).toBe(before);
    expect(after).toBe(before);
  });

  it("creates a new commit when there are changes", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "x.txt"), "v1\n");
    await commit(cwd, "baseline");
    const before = await headCommitRaw(cwd);

    await writeFile(join(cwd, "x.txt"), "v2\n");
    const hash = await commitOrReuseHead(cwd, "01 — real change");
    const after = await headCommitRaw(cwd);

    expect(hash).toBe(after);
    expect(after).not.toBe(before);
  });

  it("returns HEAD for an untracked-only worktree only if nothing is staged", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "x.txt"), "v1\n");
    await commit(cwd, "baseline");
    const before = await headCommitRaw(cwd);

    await writeFile(join(cwd, "new.txt"), "untracked content\n");
    const hash = await commitOrReuseHead(cwd, "01 — new file");
    const after = await headCommitRaw(cwd);

    expect(after).not.toBe(before);
    expect(hash).toBe(after);
  });
});

describe("commitMessageExists", () => {
  // Resume reconciliation treats a ticket whose commit message exists as
  // committed. Recovery checkpoints in-flight work under
  // "NN — Title (checkpoint)" — a prefix of the real message. A substring or
  // prefix match would let a checkpoint (work never gated) masquerade as a
  // committed ticket on the next resume, silently skipping its gate.
  it("does not match a checkpoint commit whose message only prefixes the ticket message", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "work.txt"), "wip\n");
    await commit(cwd, "01 — Add greet (checkpoint)");
    expect(await commitMessageExists(cwd, "01 — Add greet")).toBe(false);
  });

  it("matches the exact ticket commit and ignores trailing whitespace", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "work.txt"), "done\n");
    await commit(cwd, "01 — Add greet");
    expect(await commitMessageExists(cwd, "01 — Add greet")).toBe(true);
  });
});

describe("cleanWorktree", () => {
  it("preserves plan-time config writes to a protected tracked file (railhead.json) across reset --hard", async () => {
    const cwd = await freshRepo();
    // Simulate: railhead.json is committed at scaffold time with mode:off,
    // then `railhead build` writes mode:full to disk (persistPolicy).
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ visual_review: { mode: "off" } }) + "\n");
    await commit(cwd, "scaffold with railhead.json");

    // The plan-time write:
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ visual_review: { mode: "full" } }) + "\n");

    // cleanWorktree must reset tracked files to HEAD BUT preserve railhead.json.
    await cleanWorktree(cwd, ["railhead.json"]);

    const after = JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8"));
    expect(after.visual_review.mode).toBe("full");
  });

  it("resets implementer changes to UNprotected tracked files", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "src.txt"), "v1\n");
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ enabled: false }) + "\n");
    await commit(cwd, "scaffold");

    // Implementer modifies src.txt; plan-time modifies railhead.json.
    await writeFile(join(cwd, "src.txt"), "implementer changed this\n");
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ enabled: true }) + "\n");

    await cleanWorktree(cwd, ["railhead.json"]);

    // src.txt reset to HEAD (implementer's changes discarded)...
    expect(await readFile(join(cwd, "src.txt"), "utf8")).toBe("v1\n");
    // ...but railhead.json preserved (plan-time config survives).
    expect(JSON.parse(await readFile(join(cwd, "railhead.json"), "utf8")).enabled).toBe(true);
  });

  it("stashes uncommitted work to .railhead/stash.diff before wiping when the diff is non-trivial", async () => {
    // The pixeledit-night-1 failure: implementer built the entire scaffold
    // (package.json, src/, tests), verify passed, smoke failed on a missing
    // script. cleanWorktree wiped everything back to the empty init commit.
    // The work was never recoverable. The stash is a safety net: even if the
    // caller sets patching=false incorrectly, the diff survives.
    const cwd = await freshRepo();
    // Empty init commit — no tracked files at all.
    await writeFile(join(cwd, "package.json"), '{"name":"test","scripts":{"build":"tsc"}}\n');
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "main.ts"), "console.log('hello');\n");

    const result = await cleanWorktree(cwd, [".railhead"]);

    expect(result.stashed).toBe(true);
    expect(result.stashPath).toBeTruthy();
    const stash = await readFile(result.stashPath!, "utf8");
    expect(stash).toContain("package.json");
    expect(stash).toContain("src/main.ts");
    // The worktree is still wiped (cleanWorktree did its job)...
    expect(() => readFile(join(cwd, "package.json"), "utf8")).rejects.toThrow();
    // ...but the stash file is under .railhead (protected):
    expect(result.stashPath).toContain(".railhead");
  });

  it("does not stash when the working tree is clean (nothing to lose)", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "baseline.txt"), "v1\n");
    await commit(cwd, "baseline");

    const result = await cleanWorktree(cwd, ["railhead.json"]);

    expect(result.stashed).toBe(false);
    expect(result.stashPath).toBeNull();
  });

  it("does not stash when only protected paths have changes", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ mode: "off" }) + "\n");
    await commit(cwd, "scaffold");

    // Only railhead.json changed (a protected path) — no real work to stash.
    await writeFile(join(cwd, "railhead.json"), JSON.stringify({ mode: "full" }) + "\n");

    const result = await cleanWorktree(cwd, ["railhead.json"]);

    expect(result.stashed).toBe(false);
  });
});

describe("initGit — ancestor repo guard", () => {
  // Reproduces the snake-goal-1 failure: the project directory has no .git of
  // its own, but a parent directory does. Without a guard, `isGitRepo` answers
  // true (the ancestor's .git resolves), `initGit` is a no-op, and the run
  // proceeds against the *ancestor* repo — whose working tree contains sibling
  // embedded repos with no commits. `git diff HEAD` then dies with
  // "fatal: cannot hash <path>". initGit must scope the repo to cwd.
  it("inits a local repo when cwd is inside an ancestor repo but has no .git itself", async () => {
    const ancestor = await mkdtemp(join(tmpdir(), "anc-"));
    dirs.push(ancestor);
    await initGit(ancestor);
    await ensureInitialCommit(ancestor);

    const child = join(ancestor, "snake-goal-1");
    await mkdir(child, { recursive: true });
    dirs.push(child);

    const fresh = await initGit(child);
    expect(fresh).toBe(true);

    // The child is now its own repo root, not resolved to the ancestor.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { realpath } = await import("node:fs/promises");
    const { stdout: root } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: child });
    expect(await realpath(root.trim())).toBe(await realpath(child));
  });

  it("is a no-op when cwd already has its own .git", async () => {
    const cwd = await freshRepo();
    expect(await initGit(cwd)).toBe(false);
  });
});

describe("writeProjectDoc + readProjectDoc (#34)", () => {
  it("writes a doc under a nested path and reads it back", async () => {
    const cwd = await freshRepo();
    await writeProjectDoc(cwd, "docs/design.md", "# Design\nA roguelike.\n");
    const content = await readProjectDoc(cwd, "docs/design.md");
    expect(content).toBe("# Design\nA roguelike.\n");
  });

  it("readProjectDoc returns null for a non-existent doc", async () => {
    const cwd = await freshRepo();
    expect(await readProjectDoc(cwd, "docs/missing.md")).toBeNull();
  });

  it("writeProjectDoc creates parent directories as needed", async () => {
    const cwd = await freshRepo();
    await writeProjectDoc(cwd, "docs/adr/0009-goal-review.md", "content\n");
    const content = await readProjectDoc(cwd, "docs/adr/0009-goal-review.md");
    expect(content).toBe("content\n");
  });
});
