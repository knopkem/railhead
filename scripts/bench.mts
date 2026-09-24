#!/usr/bin/env tsx
/**
 * The #135 bench harness — measures an engine/model against the same trials
 * every time, so a future engine change (Splash vs llama.cpp vs oMLX vs LM
 * Studio) is evaluated identically. Not part of `npm test`: every mode makes
 * real model calls and takes real wall-clock time.
 *
 *   npm run bench -- --mode plan  --project <dir> --prompt "<goal>" --model <provider/model> [--fresh]
 *   npm run bench -- --mode e2e   --project <dir> --tickets <dir> --model <provider/model>
 *   npm run bench -- --mode fixture --model <provider/model>
 *
 * Results land in `bench-results/` (gitignored): one JSON per trial plus a
 * running `results.md` comparison table.
 */
import { execFile, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runPlan } from "../src/plan/planner.ts";
import { loadTickets } from "../src/core/ticket.ts";
import { collectCacheStats } from "../src/core/telemetry.ts";
import { readState } from "../src/core/ledger.ts";

const here = dirname(fileURLToPath(import.meta.url));
const railheadRoot = resolve(here, "..");
const resultsDir = join(railheadRoot, "bench-results");

type Mode = "plan" | "e2e" | "fixture";

interface Args {
  mode: Mode;
  project: string;
  prompt: string;
  model: string | null;
  tickets: string | null;
  engine: string;
  fresh: boolean;
  contextTokens: number;
  timeoutSec: number;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const mode = (value("mode") ?? "plan") as Mode;
  if (!["plan", "e2e", "fixture"].includes(mode)) throw new Error(`--mode must be plan|e2e|fixture, got "${mode}"`);
  const model = value("model");
  return {
    mode,
    project: resolve(value("project") ?? join(tmpdir(), "railhead-bench", `${mode}-${Date.now()}`)),
    prompt: value("prompt") ?? "a complete snake game in rust in a native window",
    model,
    tickets: value("tickets"),
    engine: value("engine") ?? model ?? "opencode-default",
    fresh: argv.includes("--fresh"),
    contextTokens: Number(value("context-tokens") ?? 60000),
    timeoutSec: Number(value("timeout-sec") ?? 6 * 3600),
  };
}

/** A scratch project inside the railhead tree is contaminated: opencode anchors
 *  the project at the nearest package.json upward, so the model sees railhead's
 *  own sources and AGENTS.md (the first bench runs proved it — the planner read
 *  src/plan/planner.ts). Scratch projects belong in the system temp dir. */
function assertOutsideRailhead(project: string): void {
  if (project === railheadRoot || project.startsWith(railheadRoot + sep)) {
    throw new Error(`bench: --project must live outside the railhead repo (got ${project}) — a nested scratch dir exposes railhead's own sources to the model`);
  }
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
}

/** The CLI entry the user runs, built from the current source. `tsx
 *  src/cli/cli.ts` is NOT it — cli.ts only exports main; bin/railhead calls
 *  it. Building first keeps the trial honest to the working tree. */
const cliPath = join(railheadRoot, "bin", "railhead");

function buildCli(): void {
  run("npm", ["run", "build"], railheadRoot);
}

function cli(args: string[], cwd: string): void {
  run(process.execPath, [cliPath, ...args], cwd);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolvePromise(stdout)));
  });
}

/** A clean scaffold for a plan trial: empty git repo with railhead's own
 *  runtime artifacts ignored, so the planner starts where the original snake
 *  run did — from the prompt, not from prior source. */
async function prepareFreshProject(project: string): Promise<void> {
  await rm(project, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  await git(project, ["init"]);
  await writeFile(join(project, ".gitignore"), ".railhead/\n.scratch/\nrailhead.contracts.json\n", "utf8");
  await git(project, ["add", "-A"]);
  await git(project, ["-c", "user.email=bench@railhead", "-c", "user.name=bench", "commit", "-m", "bench scaffold"]);
}

interface PlanMetrics {
  mode: "plan";
  engine: string;
  model: string | null;
  project: string;
  wallMs: number;
  ticketCount: number;
  planCheckRounds: number;
  danglingBlockedBy: string[];
  cache: { cold: number; cached: number };
  planDir: string | null;
  error: string | null;
}

async function collectPlanMetrics(args: Args, wallMs: number, error: string | null): Promise<PlanMetrics> {
  const planLedger = join(args.project, ".railhead", "plan-latest", "events");
  let planCheckRounds = 0;
  if (existsSync(planLedger)) {
    planCheckRounds = (await readdir(planLedger)).filter((f) => /^plan-check-\d+\.jsonl$/.test(f)).length;
  }

  const scratch = join(args.project, ".scratch");
  let planDir: string | null = null;
  let tickets: Awaited<ReturnType<typeof loadTickets>> = [];
  if (existsSync(scratch)) {
    for (const slug of await readdir(scratch)) {
      const issues = join(scratch, slug, "issues");
      if (!existsSync(issues)) continue;
      planDir = join(scratch, slug);
      tickets = await loadTickets(issues).catch(() => []);
    }
  }
  const files = new Set(tickets.map((t) => t.file));
  const danglingBlockedBy = tickets.flatMap((t) =>
    t.blocked_by.filter((b) => !files.has(b)).map((b) => `${t.file} -> ${b}`),
  );

  const cache = existsSync(planLedger)
    ? await collectCacheStats(join(args.project, ".railhead", "plan-latest")).catch(() => ({ cold: 0, cached: 0 }))
    : { cold: 0, cached: 0 };

  return {
    mode: "plan",
    engine: args.engine,
    model: args.model,
    project: args.project,
    wallMs,
    ticketCount: tickets.length,
    planCheckRounds,
    danglingBlockedBy,
    cache: { cold: cache.cold, cached: cache.cached },
    planDir,
    error,
  };
}

interface E2EMetrics {
  mode: "e2e";
  engine: string;
  model: string | null;
  project: string;
  wallMs: number;
  committed: number;
  total: number;
  perPhaseCache: Array<{ phaseFile: string; cold: number; cached: number }>;
  goalVerdicts: string[];
  visualOk: boolean | null;
  error: string | null;
  reportPath: string | null;
}

async function collectE2EMetrics(args: Args, wallMs: number, error: string | null): Promise<E2EMetrics> {
  const railheadDir = join(args.project, ".railhead");
  const runs = existsSync(railheadDir)
    ? (await readdir(railheadDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^run-\d/.test(d.name))
        .map((d) => d.name)
        .sort()
    : [];
  const runDir = runs.length ? join(railheadDir, runs[runs.length - 1]) : null;
  let committed = 0;
  let total = 0;
  let goalVerdicts: string[] = [];
  let visualOk: boolean | null = null;
  let perPhaseCache: E2EMetrics["perPhaseCache"] = [];
  if (runDir) {
    const state = await readState(runDir).catch(() => null);
    if (state) {
      total = state.tickets.length;
      committed = state.tickets.filter((t) => t.status === "committed").length;
      goalVerdicts = (state.goal_reviews ?? []).map((r) => `${r.group}:${r.verdict}`);
      visualOk = state.visual_ok ?? null;
    }
    const cache = await collectCacheStats(runDir).catch(() => null);
    perPhaseCache = cache?.perPhase.map((p) => ({ phaseFile: p.phaseFile, cold: p.cache.cold, cached: p.cache.cached })) ?? [];
  }
  return {
    mode: "e2e",
    engine: args.engine,
    model: args.model,
    project: args.project,
    wallMs,
    committed,
    total,
    perPhaseCache,
    goalVerdicts,
    visualOk,
    error,
    reportPath: runDir ? join(runDir, "report.md") : null,
  };
}

/** The fixture trial's assertion: the seeded defect must be named by a gate.
 *  A defect the reviewers miss is the failure this trial exists to catch. */
async function defectCaught(project: string, keywords: string[]): Promise<{ defectCaught: boolean; evidence: string[] }> {
  const railheadDir = join(project, ".railhead");
  const runs = existsSync(railheadDir)
    ? (await readdir(railheadDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^run-\d/.test(d.name))
        .map((d) => d.name)
        .sort()
    : [];
  const evidence: string[] = [];
  for (const run of runs) {
    const reportPath = join(railheadDir, run, "report.md");
    if (!existsSync(reportPath)) continue;
    const report = await readFile(reportPath, "utf8");
    for (const line of report.split("\n")) {
      if (keywords.some((k) => line.toLowerCase().includes(k.toLowerCase()))) {
        evidence.push(`${run}: ${line.trim().slice(0, 300)}`);
      }
    }
  }
  return { defectCaught: evidence.length > 0, evidence };
}
async function runPlanTrial(args: Args): Promise<PlanMetrics> {
  if (args.fresh) await prepareFreshProject(args.project);
  const start = Date.now();
  let error: string | null = null;
  try {
    await runPlan({
      cwd: args.project,
      prompt: args.prompt,
      model: args.model,
      contextBudget: args.contextTokens,
      maxContextTokens: args.contextTokens,
      maxSteps: 120,
      stallTimeoutSec: 3600,
      maxStepModelSec: 3600,
      mode: "build",
      persistentWorker: false,
      infraBackoffSec: [60, 300, 900, 1800],
      artDirection: true,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return await collectPlanMetrics(args, Date.now() - start, error);
}

async function runE2ETrial(args: Args): Promise<E2EMetrics> {
  if (!args.tickets) throw new Error("--mode e2e needs --tickets <dir>");
  const tickets = isAbsolute(args.tickets) ? args.tickets : join(args.project, args.tickets);
  const start = Date.now();
  let error: string | null = null;
  try {
    // `--no-tdd` answers run's interactive TDD question (no TTY in the bench).
    cli(["run", tickets, "-a", "--no-tdd"], args.project);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return await collectE2EMetrics(args, Date.now() - start, error);
}

const SEEDED_DEFECT_KEYWORDS = ["starts at 1", "start at 1", "starts at 0", "start at 0", "initial value", "instead of 1"];

/** The seeded-defect trial: a small app whose observed behaviour violates its
 *  own README contract; a build extends it without touching that behaviour.
 *  The gates must name the discrepancy anyway — that is the judge-quality
 *  assertion (the fixture's "defect" is exactly what a passing run must not
 *  ignore). */
async function runFixtureTrial(args: Args): Promise<E2EMetrics & { defectCaught: boolean; evidence: string[] }> {
  const fixture = join(here, "fixtures", "seeded-defect");
  if (!existsSync(fixture)) throw new Error(`seeded-defect fixture missing at ${fixture}`);
  const project = join(tmpdir(), "railhead-bench", `fixture-${Date.now()}`, "project");
  await mkdir(project, { recursive: true });
  await cp(fixture, project, { recursive: true });
  await git(project, ["init"]);
  await git(project, ["add", "-A"]);
  await git(project, ["-c", "user.email=bench@railhead", "-c", "user.name=bench", "commit", "-m", "seeded defect fixture"]);

  const start = Date.now();
  let error: string | null = null;
  try {
    // The fixture config keeps every seat on the trial model: the `build
    // --model` flag only sets the plan seat, and a half-configured seat would
    // trip the vision-gate refusal before any gate runs.
    if (args.model) {
      const cfgPath = join(project, "railhead.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      cfg.model = { plan: args.model, implement: args.model, review: args.model, visual: args.model, goal: args.model, extract: null };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    }
    // Hand-written ticket + `run` (not `build`): the fixture asserts JUDGE
    // quality on a known defect, and the 35B plan gate rejects even a trivial
    // goal — planning would gate the experiment before any review runs.
    // `--no-tdd` answers run's interactive TDD question (no TTY here).
    cli(["run", "tickets", "-a", "--no-tdd"], project);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const metrics = await collectE2EMetrics({ ...args, project }, Date.now() - start, error);
  const verdict = await defectCaught(project, SEEDED_DEFECT_KEYWORDS);
  return { ...metrics, ...verdict };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertOutsideRailhead(args.project);
  await mkdir(resultsDir, { recursive: true });
  if (args.mode !== "plan") buildCli();

  const startedAt = new Date();
  let result: PlanMetrics | E2EMetrics | (E2EMetrics & { defectCaught: boolean; evidence: string[] });
  if (args.mode === "plan") {
    result = await runPlanTrial(args);
  } else if (args.mode === "e2e") {
    result = await runE2ETrial(args);
  } else {
    result = await runFixtureTrial(args);
  }

  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const resultPath = join(resultsDir, `${stamp}-${args.mode}-${args.engine.replace(/[^\w.-]+/g, "_")}.json`);
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  const hours = (result.wallMs / 3_600_000).toFixed(2);
  console.log(`\nbench ${args.mode} [${args.engine}] — ${hours}h wall`);
  let detail: string;
  if (result.mode === "plan") {
    detail = `${result.ticketCount} tickets · ${result.planCheckRounds} plan-check rounds · ${result.danglingBlockedBy.length} dangling blocked_by · cache ${result.cache.cached}/${result.cache.cold + result.cache.cached}`;
    console.log(`  ${detail}`);
    if (result.error) console.log(`  FAILED: ${result.error}`);
  } else {
    detail = `committed ${result.committed}/${result.total} · goal ${result.goalVerdicts.join(", ") || "(none)"} · visual_ok ${result.visualOk}`;
    console.log(`  ${detail}`);
    if ("defectCaught" in result) console.log(`  seeded defect caught: ${result.defectCaught} (${result.evidence.length} finding line(s))`);
    if (result.error) console.log(`  FAILED: ${result.error}`);
  }
  console.log(`  result: ${resultPath}`);

  const table = join(resultsDir, "results.md");
  if (!existsSync(table)) {
    await writeFile(table, "# Bench results\n\n| when | mode | engine | model | wall | detail |\n|---|---|---|---|---|---|\n", "utf8");
  }
  await writeFile(
    table,
    (await readFile(table, "utf8")).trimEnd() +
      `\n| ${startedAt.toISOString()} | ${args.mode} | ${args.engine} | ${args.model ?? "(opencode default)"} | ${hours}h | ${detail} |\n`,
    "utf8",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
