import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, expect } from "vitest";
import {
  cleanWorktree,
  commit,
  commitPaths,
  commitSubjectsSince,
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

describe("commitSubjectsSince", () => {
  // Ticket pre-marking treats an exact subject match as "already committed".
  // Recovery checkpoints in-flight work under "NN — Title (checkpoint)" — a
  // prefix of the real message. A substring or prefix match would let a
  // checkpoint (work never gated) masquerade as a committed ticket,
  // silently skipping its gate.
  it("exact-match territory: lists full subjects so a checkpoint prefix never satisfies the plain title", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "work.txt"), "wip\n");
    await commit(cwd, "01 — Add greet (checkpoint)");
    const subjects = await commitSubjectsSince(cwd, null);
    expect(subjects).toContain("01 — Add greet (checkpoint)");
    expect(subjects.some((m) => m === "01 — Add greet")).toBe(false);
  });

  it("with a base sha it lists only the commits on top of it (the plan's own commits)", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "a.txt"), "a\n");
    await commit(cwd, "01 — First");
    await writeFile(join(cwd, "b.txt"), "b\n");
    const base = await commit(cwd, "02 — Second");
    await writeFile(join(cwd, "c.txt"), "c\n");
    await commit(cwd, "03 — Third");
    const subjects = await commitSubjectsSince(cwd, base);
    expect(subjects).toEqual(["03 — Third"]);
  });

  it("with a null base it returns the last commits overall", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "a.txt"), "a\n");
    await commit(cwd, "01 — First");
    await writeFile(join(cwd, "b.txt"), "b\n");
    await commit(cwd, "02 — Second");
    const subjects = await commitSubjectsSince(cwd, null);
    expect(subjects).toContain("01 — First");
    expect(subjects).toContain("02 — Second");
  });

  it("returns an empty list on a repo with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "git-empty-"));
    dirs.push(dir);
    await initGit(dir);
    expect(await commitSubjectsSince(dir, null)).toEqual([]);
  });
});

describe("commitPaths", () => {
  it("commits ONLY the named paths, leaving other dirty files untouched", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "base.txt"), "b\n");
    await commit(cwd, "baseline");
    // An in-progress feature file stays dirty; only the arc update commits.
    await writeFile(join(cwd, "wip.txt"), "unfinished\n");
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "docs", "product.md"), "# Arc\n");
    const sha = await commitPaths(cwd, ["docs/product.md"], "railhead: product arc");
    expect(sha).not.toBeNull();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const { stdout: status } = await exec("git", ["status", "--porcelain"], { cwd });
    expect(status.trim()).toBe("?? wip.txt");
  });

  it("returns null when the named paths are clean (nothing committed)", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "base.txt"), "b\n");
    await commit(cwd, "baseline");
    expect(await commitPaths(cwd, ["base.txt"], "no change")).toBeNull();
  });
});

describe("cleanWorktree", () => {  it("preserves plan-time config writes to a protected tracked file (railhead.json) across reset --hard", async () => {
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

  it("archives unprotected untracked files (including binaries) beside the stash, then wipes them from the worktree", async () => {
    // `git apply` can restore a text diff, but a diff carries no binary
    // content: an existing product repo's untracked assets (images,
    // databases) would be destroyed by `git clean -fd` on the hard-fail
    // path with no backup anywhere.
    const cwd = await freshRepo();
    await writeFile(join(cwd, "tracked.txt"), "v1\n");
    await commit(cwd, "baseline");
    await writeFile(join(cwd, "tracked.txt"), "v2\n");
    await mkdir(join(cwd, "assets"));
    await writeFile(join(cwd, "untracked-code.js"), "const kept = 1;\n");
    await writeFile(join(cwd, "assets", "logo.bin"), Buffer.from([0, 1, 2, 0xff]));
    await writeFile(join(cwd, "opencode.json"), "{}\n");

    const result = await cleanWorktree(cwd, ["opencode.json", ".railhead"]);

    expect(result.untrackedArchivePath).toBeTruthy();
    expect(result.untrackedArchivePath).toContain(".railhead");
    expect(await readFile(join(result.untrackedArchivePath!, "untracked-code.js"), "utf8")).toContain("const kept");
    expect(
      await readFile(join(result.untrackedArchivePath!, "assets", "logo.bin")),
    ).toEqual(Buffer.from([0, 1, 2, 0xff]));
    // The worktree is indeed wiped...
    await expect(readFile(join(cwd, "untracked-code.js"), "utf8")).rejects.toThrow();
    await expect(readFile(join(cwd, "assets", "logo.bin"))).rejects.toThrow();
    // ...the protected file survived in place (never archived, never cleaned)...
    expect(await readFile(join(cwd, "opencode.json"), "utf8")).toBe("{}\n");
    // ...and the tracked change went through the normal diff stash.
    expect(result.stashed).toBe(true);
  });

  it("does not create an untracked archive when the tree is clean", async () => {
    const cwd = await freshRepo();
    await writeFile(join(cwd, "baseline.txt"), "v1\n");
    await commit(cwd, "baseline");

    const result = await cleanWorktree(cwd, ["railhead.json"]);

    expect(result.untrackedArchivePath).toBeNull();
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
