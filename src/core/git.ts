import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";

const exec = promisify(execFile);

const GIT = "git";

// Node's execFile caps captured stdout at 1 MiB by default. Railhead builds
// routinely produce multi-MiB diffs — the snake-qwen run crashed with
// "stdout maxBuffer length exceeded" once the second implement attempt stacked
// enough Rust source for the reviewer's `git diff HEAD` to overflow. Lift the
// cap high enough that a real review diff never trips it while staying well
// below any plausible process-memory ceiling.
const MAX_BUFFER = 64 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(GIT, args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

export function branchExists(cwd: string, branch: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then((out) => out.length > 0)
    .catch(() => false);
}

export function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["branch", "--show-current"]);
}

export function createBranch(cwd: string, branch: string): Promise<void> {
  return git(cwd, ["checkout", "-b", branch]).then(() => undefined);
}

export function checkoutBranch(cwd: string, branch: string): Promise<void> {
  return git(cwd, ["checkout", branch]).then(() => undefined);
}

export function headCommit(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function lastCommitMessage(cwd: string): Promise<string> {
  return git(cwd, ["log", "-1", "--format=%s"]);
}

/** The commit subjects a plan can own: those on top of `baseSha` (the
 * plan-time HEAD recorded in origin.json), or the last `limit` subjects
 * overall when the plan predates the base-sha record (null). */
export async function commitSubjectsSince(cwd: string, baseSha: string | null, limit = 1000): Promise<string[]> {
  const args = ["log", "--format=%s", "-n", String(limit)];
  if (baseSha) args.push(`${baseSha}..HEAD`);
  const out = await git(cwd, args).catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** True when the repo has at least one commit (HEAD resolves). */
export async function hasCommits(cwd: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])
    .then((out) => out.length > 0)
    .catch(() => false);
}

/**
 * Make sure HEAD resolves before a Run starts. A freshly `railhead init`-ed
 * repo has no commits, so the first ticket's start_commit (and the later
 * contract-extract diff range) would have no parent. Create an empty "init"
 * commit so the linear per-ticket commits have a root.
 */
export async function ensureInitialCommit(cwd: string): Promise<void> {
  if (await hasCommits(cwd)) return;
  await git(cwd, ["-c", "user.name=railhead", "-c", "user.email=railhead@local", "commit", "--allow-empty", "-m", "init"]);
}

/** Remove any uncommitted or untracked changes so the next ticket starts clean. */
/** Result of a cleanWorktree call. */
export interface CleanWorktreeResult {
  /** True when uncommitted work was stashed to a file before wiping. The
   *  stash is a unified diff saved under the `.railhead` directory (which is
   *  protected from `git clean -fd`). Callers can pass the stash path to
   *  the next implementer so prior work isn't silently lost. */
  stashed: boolean;
  /** Path to the stash file when `stashed` is true, null otherwise. */
  stashPath: string | null;
  /** Archive directory holding byte-for-byte copies of every unprotected
   *  untracked file, null when there was nothing to archive. A unified diff
   *  cannot carry binary content, so an existing product repo's untracked
   *  assets would otherwise be destroyed by `git clean -fd` with no backup
   *  anywhere. */
  untrackedArchivePath: string | null;
}

/**
 * Restore the worktree to HEAD and remove stray untracked files, so the next
 * Implementer attempt starts clean. Never deletes the Railhead's own inputs:
 * protected paths (ticket store, railhead.json, ledger) are excluded from the
 * clean so a previous --include-untracked nuke can't eat them.
 *
 * Before wiping, the working diff (excluding protected paths) is stashed to
 * `.railhead/stash-<timestamp>.diff` when it is non-empty. This is a safety
 * net: even if a caller sets `patching=false` and the worktree is reset to
 * an empty init commit, the implementer's prior work survives as a diff file
 * the caller can hand back. The pixeledit-night-1 run lost 9 attempts of
 * real work because smoke failure triggered cleanWorktree on an empty init
 * commit — stashing prevents that silent destruction.
 *
 * `git reset --hard HEAD` (needed to discard the implementer's tracked-file
 * changes) also restores any tracked file that the plan phase modified after
 * the scaffold commit — `railhead.json` (plan-time gate modes, yolo,
 * model overrides), `opencode.json`
 * (permission grants), `AGENTS.md`/`CONTEXT.md` (plan-time docs). Snapshot
 * the protected tracked files before the reset and write them back after, so
 * plan-time config survives every implement retry. See ADR 0011.
 */
/** Untracked files are archived one-by-one into a directory beside the stash
 * diff. The limits keep a sloppy .gitignore (megabytes of unignored build
 * output) from stalling the hard-fail path; over-limit files are skipped, the
 * diff stash still covers them as "binary files differ" hunks. */
const UNTRACKED_ARCHIVE_FILE_LIMIT = 2000;
const UNTRACKED_ARCHIVE_BYTE_LIMIT = 512 * 1024 * 1024;

async function archiveUntracked(
  cwd: string,
  protectedNames: Set<string>,
  archiveDir: string,
): Promise<string | null> {
  const out = await git(cwd, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
  const files = out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !isProtectedFile(f, protectedNames));
  if (files.length === 0) return null;
  let bytes = 0;
  let copied = 0;
  for (const rel of files) {
    if (copied >= UNTRACKED_ARCHIVE_FILE_LIMIT || bytes > UNTRACKED_ARCHIVE_BYTE_LIMIT) break;
    let size = 0;
    try {
      size = (await stat(join(cwd, rel))).size;
    } catch {
      continue;
    }
    try {
      await mkdir(join(archiveDir, rel, ".."), { recursive: true });
      await copyFile(join(cwd, rel), join(archiveDir, rel));
    } catch {
      continue;
    }
    bytes += size;
    copied++;
  }
  return archiveDir;
}

export async function cleanWorktree(
  cwd: string,
  protectedPaths: string[],
): Promise<CleanWorktreeResult> {
  const diff = await workingDiff(cwd).catch(() => "");
  const realWork = diffExcludesProtected(diff, protectedPaths);
  let stashPath: string | null = null;
  let untrackedArchivePath: string | null = null;
  if (realWork.trim()) {
    const railheadDir = join(cwd, ".railhead");
    try {
      await import("node:fs/promises").then((fs) => fs.mkdir(railheadDir, { recursive: true }));
    } catch { /* may already exist */ }
    stashPath = join(railheadDir, `stash-${Date.now()}.diff`);
    await writeFile(stashPath, diff, "utf8");
    const protectedNames = new Set(protectedPaths.map((p) => p.replace(/^[/\\]/, "")));
    untrackedArchivePath = await archiveUntracked(
      cwd,
      protectedNames,
      stashPath.replace(/\.diff$/, "-untracked"),
    );
  }
  const snapshots = await snapshotProtectedTracked(cwd, protectedPaths);
  await git(cwd, ["reset", "--hard", "HEAD"]);
  const excludes = protectedPaths.map((p) => ["-e", p]).flat();
  await git(cwd, ["clean", "-fd", ...excludes]);
  await restoreProtectedTracked(cwd, snapshots);
  return { stashed: stashPath !== null, stashPath, untrackedArchivePath };
}

/** Check whether a working diff contains changes to any file that is NOT
 * a protected path. Returns the non-protected diff lines (or "" when every
 * change is to a protected file). Used by cleanWorktree to decide whether
 * stashing is warranted — protected-path-only changes are plan-time config
 * writes, not implementer work worth stashing. */
function diffExcludesProtected(diff: string, protectedPaths: string[]): string {
  if (!diff.trim()) return "";
  const protectedNames = new Set(protectedPaths.map((p) => p.replace(/^[/\\]/, "")));
  const lines = diff.split("\n");
  const result: string[] = [];
  let currentFile = "";
  let keep = false;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.+?) b\//);
      currentFile = match ? match[1] : "";
      keep = !isProtectedFile(currentFile, protectedNames);
    }
    if (keep) result.push(line);
  }
  return result.join("\n");
}

function isProtectedFile(path: string, protectedNames: Set<string>): boolean {
  const top = path.split("/")[0];
  return protectedNames.has(path) || protectedNames.has(top);
}

/** True when the worktree holds changes to any file outside the protected
 * set — real implementer work rather than plan-time config writes. Uses the
 * same protected-path filter as cleanWorktree's stash decision, so the
 * no-DONE gate and the wipe decision agree on what counts as work. */
export async function hasRealWorkingChanges(cwd: string, protectedPaths: string[]): Promise<boolean> {
  const diff = await workingDiff(cwd).catch(() => "");
  return diffExcludesProtected(diff, protectedPaths).trim().length > 0;
}

/** Read the current working-tree content of every protected path that exists
 * and is tracked (a file, not a directory). Returns path→content pairs to
 * restore after `reset --hard`. Untracked protected files (e.g. AGENTS.md
 * before the first commit) are handled by `git clean -fd -e` excludes — they
 * never reach this snapshot because `existsSync` catches them but
 * `git ls-files` won't list them as tracked. */
async function snapshotProtectedTracked(
  cwd: string,
  protectedPaths: string[],
): Promise<Map<string, string>> {
  const snapshots = new Map<string, string>();
  const tracked = new Set(
    (await git(cwd, ["ls-files"]))
      .split("\n")
      .filter(Boolean)
      .map((f) => f.trim()),
  );
  for (const rel of protectedPaths) {
    const abs = isAbsolute(rel) ? rel : join(cwd, rel);
    if (!existsSync(abs)) continue;
    // Only snapshot files (directories are protected by `git clean -fd -e`).
    let isFile = false;
    try {
      isFile = (await stat(abs)).isFile();
    } catch { /* not found or inaccessible */ }
    if (!isFile) continue;
    // Only snapshot tracked files — untracked protected files are preserved by
    // the `git clean -fd -e` excludes, not by this snapshot/restore.
    const relFromCwd = isAbsolute(rel) ? rel.slice(cwd.length).replace(/^[/\\]/, "") : rel;
    if (!tracked.has(relFromCwd)) continue;
    try {
      snapshots.set(relFromCwd, await readFile(abs, "utf8"));
    } catch { /* unreadable — skip */ }
  }
  return snapshots;
}

async function restoreProtectedTracked(cwd: string, snapshots: Map<string, string>): Promise<void> {
  for (const [rel, content] of snapshots) {
    await writeFile(join(cwd, rel), content, "utf8").catch(() => {});
  }
}

/** Hard reset to a given commit, discarding any in-progress ticket work. */
export function resetHard(cwd: string, ref: string): Promise<void> {
  return git(cwd, ["reset", "--hard", ref]).then(() => undefined);
}

export function stageAll(cwd: string): Promise<void> {
  return git(cwd, ["add", "-A"]).then(() => undefined);
}

export function isClean(cwd: string): Promise<boolean> {
  return git(cwd, ["status", "--porcelain"]).then((s) => s.length === 0);
}

export async function commit(
  cwd: string,
  message: string,
): Promise<string> {
  await stageAll(cwd);
  await git(cwd, ["commit", "-m", message]);
  return headCommit(cwd);
}

/**
 * Like {@link commit}, but reuses HEAD instead of failing when the worktree
 * has no changes to commit. The implementer can correctly decide a ticket is
 * already done (a bug fixed in a prior ticket, work already landed) and make
 * no changes — `git commit` would crash with "nothing to commit" and lose the
 * ticket. This stages everything, checks the staged diff against HEAD, and:
 *  - non-empty: commits and returns the new hash (same as {@link commit})
 *  - empty:    returns HEAD unchanged, caller marks the ticket committed
 *
 * Detection runs AFTER `stageAll`, so untracked-new-file work (the normal
 * greenfield case) is staged and detected as a real change — the test pinning
 * this ("returns HEAD ... only if nothing is staged") covers that path.
 */
export async function commitOrReuseHead(
  cwd: string,
  message: string,
): Promise<string> {
  await stageAll(cwd);
  // `git diff --cached --quiet HEAD` exits 0 iff the index matches HEAD (no
  // staged changes), 1 iff there are staged changes. Catch the non-zero to
  // read the 1; the resolved-true path means "no changes, reuse HEAD."
  const hasChanges = await exec(GIT, ["diff", "--cached", "--quiet", "HEAD"], {
    cwd,
    maxBuffer: MAX_BUFFER,
  }).then(
    () => false,
    (err: { code?: number }) => err.code === 1,
  );
  if (!hasChanges) {
    return headCommit(cwd);
  }
  await git(cwd, ["commit", "-m", message]);
  return headCommit(cwd);
}

export function diffStat(cwd: string, from: string): Promise<string> {
  return git(cwd, ["diff", "--stat", from, "HEAD"]);
}

export function rangeDiff(cwd: string, from: string, to: string): Promise<string> {
  return git(cwd, ["diff", from, to]);
}

export function filesChanged(cwd: string, from: string, to: string): Promise<string> {
  return git(cwd, ["diff", "--name-only", from, to]);
}

/**
 * The diff the Reviewer sees: every change since HEAD, tracked AND untracked.
 *
 * `git diff HEAD` alone shows only tracked changes, so an Implementer that
 * creates brand-new files (the normal greenfield case — the `write` tool leaves
 * them untracked) produces an EMPTY diff. The Reviewer then correctly reports
 * "Diff is empty: no Cargo.toml" and that ticket can never pass — the bug that
 * stalled the snake build. Marking untracked files as intent-to-add (`-N`)
 * makes `git diff HEAD` surface them as "new file" entries without staging
 * their content; the cleanup `git reset` drops those markers and leaves both
 * the worktree and any real index entries untouched.
 */
export async function workingDiff(cwd: string): Promise<string> {
  await git(cwd, ["add", "-A", "-N"]);
  try {
    // Deliberately NOT the trimmed `git()` helper: the trailing newline is
    // load-bearing here. A stash written from this output must stay
    // `git apply`-able (the SpriteForge-14 recovery hit a corrupt-patch error
    // purely because .trim() had stripped the final newline), so the raw
    // stdout is returned verbatim.
    const { stdout } = await exec(GIT, ["diff", "HEAD"], { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } finally {
    await git(cwd, ["reset", "-q"]);
  }
}

export function repoRoot(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export function isGitRepo(cwd: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--git-dir"])
    .then(() => true)
    .catch(() => false);
}

/** Initialize a git repo if the directory is not already one. Returns true when freshly initialized. */
export async function initGit(cwd: string): Promise<boolean> {
  if (await isGitRepo(cwd)) {
    const root = await repoRoot(cwd);
    // repoRoot resolves symlinks (git canonicalizes the path); cwd passed in
    // may not be. Compare both via realpath to avoid a false "not local" on
    // macOS where /var -> /private/var.
    if (await realpath(root) === await realpath(cwd)) return false;
  }
  await git(cwd, ["init"]);
  return true;
}

export async function readProjectDoc(cwd: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, name), "utf8");
  } catch {
    return null;
  }
}

/** Issue #34: write a project doc (design.md, architecture.md) under the
 * repo cwd, creating parent dirs as needed. Sibling of `readProjectDoc`
 * for the planner's persistent design/architecture artifacts. */
export async function writeProjectDoc(cwd: string, name: string, content: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const fullPath = join(cwd, name);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}