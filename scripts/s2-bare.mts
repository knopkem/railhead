#!/usr/bin/env npx tsx
/**
 * Lane-A runner for the #83 head-to-head protocol (phase 1: premise test).
 *
 * Runs N unattended bare `opencode` sessions against the FROZEN S2 prompt
 * (`docs/research/head-to-head-s2-prompt.md`), sequentially, each in a fresh
 * git repo, with a hard wall-clock cap and per-run telemetry. No lane-A rule
 * lives here beyond what #83 specifies: fresh repo, no intervention, uniform
 * invocation, transcripts on disk. Failures are data, not errors — a run
 * killed at the cap is recorded as such and the next one starts.
 *
 * Incident-hardened 2026-09-03 (first smoke): two failure modes burned a
 * three-run set before this version existed —
 *  1. WORKSPACE ESCAPE: opencode resolves its project from the ambient
 *     environment, not the spawn cwd — inherited `env.PWD` from wherever the
 *     runner was invoked won. Every spawn now pins `PWD` to the run dir, and
 *     a between-runs guard aborts the set if a run dir shows no build
 *     artifacts (an escape would have been caught after run 1, not run 2's
 *     reorganization of the wrong repo).
 *  2. NARRATION EXIT: a one-shot `opencode run` ends the whole session the
 *     first time the model replies with prose and no tool call. The runner
 *     now resumes the same session (`--session <id>`) with a uniform nudge
 *     until COMPLETION.md exists, the cap hits, or an invocation bound trips.
 *     Nudge count is telemetry — it measures exactly the unattended-ness gap
 *     lane A has and lane C does not.
 *
 * Usage:
 *   npx tsx scripts/s2-bare.mts [--runs N] [--timeout-sec S] [--runs-dir PATH]
 *                                [--max-invocations K] [--dry-run]
 *
 * Artifacts per run (under --runs-dir, default ~/projects/s2-bare-runs):
 *   run-NN-<ts>/PROMPT.md     the exact prompt slice delivered (auditable vs the frozen file)
 *   run-NN-<ts>/raw.jsonl     the full opencode event stream across ALL invocations, streamed live
 *   run-NN-<ts>/summary.json   wall time, invocations, steps, tokens, tool census, errors, session id
 *   run-NN-<ts>/              the repo itself (post-run snapshot commit marked [protocol])
 * plus OVERALL.md in the runs dir after the last run.
 *
 * The prompt slice is everything between the freeze header and the trailing
 * auditor note: the spec only, so the lane never learns it is part of an
 * experiment. git init per run is load-bearing — see the workspace note above.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, readFile, appendFile, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

interface RunOptions {
  runs: number;
  timeoutSec: number;
  runsDir: string;
  maxInvocations: number;
  dryRun: boolean;
}

interface StepTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type RunStatus = "completed" | "cap-killed" | "invocation-capped" | "signalled" | "failed" | "no-artifacts";

interface RunSummary {
  run: number;
  dir: string;
  sessionId: string | null;
  status: RunStatus;
  lastExitCode: number | null;
  invocations: number;
  nudges: number;
  startedAt: string;
  endedAt: string;
  wallSec: number;
  streamSpanSec: number | null;
  steps: number;
  toolCalls: number;
  toolCensus: Record<string, number>;
  tokens: StepTokens;
  peakInputTokens: number;
  errorEvents: string[];
  eventTypeCensus: Record<string, number>;
  compactishLines: number;
}

const PROMPT_FILE = new URL("../docs/research/head-to-head-s2-prompt.md", import.meta.url);

const NUDGE_PROMPT =
  "Continue autonomously — do not pause to narrate. Keep building, testing, and documenting until the task is fully complete. When every criterion is met, write COMPLETION.md (one line per section: section, met/partial, notes) and stop. Otherwise, keep working with tool calls.";

const RUNNER_ARTIFACTS = new Set([".git", "PROMPT.md", "raw.jsonl", "raw.jsonl.stderr", "summary.json"]);

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    runs: 3,
    timeoutSec: 16 * 3600,
    runsDir: join(homedir(), "projects", "s2-bare-runs"),
    maxInvocations: 120,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") opts.runs = Number(argv[++i]);
    else if (argv[i] === "--timeout-sec") opts.timeoutSec = Number(argv[++i]);
    else if (argv[i] === "--runs-dir") opts.runsDir = resolve(argv[++i]);
    else if (argv[i] === "--max-invocations") opts.maxInvocations = Number(argv[++i]);
    else if (argv[i] === "--dry-run") opts.dryRun = true;
    else throw new Error(`unknown argument: ${argv[i]} — use --runs, --timeout-sec, --runs-dir, --max-invocations, --dry-run`);
  }
  if (!Number.isFinite(opts.runs) || opts.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec < 60) throw new Error("--timeout-sec must be >= 60");
  if (!Number.isFinite(opts.maxInvocations) || opts.maxInvocations < 1) throw new Error("--max-invocations must be >= 1");
  return opts;
}

/** The frozen spec between the freeze header (`---`) and the trailing
 * auditor note, exclusive — the lane receives the product spec only. */
export function extractSpec(doc: string): string {
  const lines = doc.split("\n");
  const firstRule = lines.findIndex((l) => l.trim() === "---");
  if (firstRule === -1) throw new Error("prompt file has no --- separator after the freeze header");
  const end = lines.findIndex((l) => l.startsWith("*End of build specification"));
  const stop = end === -1 ? lines.length : end;
  let slice = lines.slice(firstRule + 1, stop);
  while (slice.length && (slice[slice.length - 1].trim() === "" || slice[slice.length - 1].trim() === "---")) slice.pop();
  const spec = slice.join("\n").trim();
  if (spec.length < 500) throw new Error(`extracted spec looks truncated (${spec.length} chars) — refusing to run a partial prompt`);
  return spec + "\n";
}

function zeroTokens(): StepTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Post-run parse of the archived event stream. The stream is the telemetry:
 * opencode's own events carry session ids, timestamps, token accounting, and
 * tool results — nothing is inferred from the outside. */
function summarizeStream(raw: string): Pick<RunSummary, "sessionId" | "steps" | "toolCalls" | "toolCensus" | "tokens" | "peakInputTokens" | "errorEvents" | "eventTypeCensus" | "compactishLines" | "streamSpanSec"> {
  let sessionId: string | null = null;
  let steps = 0;
  let toolCalls = 0;
  const toolCensus: Record<string, number> = {};
  const tokens = zeroTokens();
  let peakInputTokens = 0;
  const errorEvents: string[] = [];
  const eventTypeCensus: Record<string, number> = {};
  let compactishLines = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (/compact|summar/i.test(line)) compactishLines++;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    eventTypeCensus[String(ev.type)] = (eventTypeCensus[String(ev.type)] ?? 0) + 1;
    if (typeof ev.sessionID === "string" && sessionId === null) sessionId = ev.sessionID;
    if (typeof ev.timestamp === "number") {
      if (firstTs === null) firstTs = ev.timestamp;
      lastTs = ev.timestamp;
    }
    if (ev.type === "step_start") steps++;
    if (ev.type === "step_finish") {
      const t = ev.part?.tokens;
      if (typeof t?.input === "number") {
        tokens.input += t.input;
        peakInputTokens = Math.max(peakInputTokens, t.input);
        if (typeof t.output === "number") tokens.output += t.output;
        if (typeof t.cache?.read === "number") tokens.cacheRead += t.cache.read;
        if (typeof t.cache?.write === "number") tokens.cacheWrite += t.cache.write;
      }
    }
    if (ev.type === "tool_use") {
      const status = ev.part?.state?.status;
      if (status === "completed" || status === "error") {
        toolCalls++;
        const tool = String(ev.part?.tool ?? "unknown");
        toolCensus[tool] = (toolCensus[tool] ?? 0) + 1;
      }
    }
    if (ev.type === "error" && errorEvents.length < 20) {
      errorEvents.push(String(ev.error?.data?.message ?? ev.error?.name ?? "unknown error").slice(0, 200));
    }
  }
  return {
    sessionId,
    steps,
    toolCalls,
    toolCensus,
    tokens,
    peakInputTokens,
    errorEvents,
    eventTypeCensus,
    compactishLines,
    streamSpanSec: firstTs !== null && lastTs !== null ? Math.round((lastTs - firstTs) / 1000) : null,
  };
}

function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv(opts.cwd), stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }, opts.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal });
    });
  });
}

/** The workspace-escape fix: opencode resolves its project from the ambient
 * environment when the spawn cwd alone doesn't register, and an inherited
 * `PWD` pointing at the invoking repo (wherever the user ran `npx tsx`)
 * won the first smoke's resolution. Pin it. */
function childEnv(cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, PWD: cwd };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

interface InvocationResult {
  code: number | null;
  signal: string | null;
  capKilled: boolean;
  interrupted: boolean;
}

/** One opencode invocation, streaming its stdout to rawPath as it arrives
 * (crash-resilient: the stream survives a killed process — the incident
 * forensics could not read run-02's unread buffer otherwise). SIGINT kills
 * the child group and marks the set aborted. */
async function invokeOpencode(args: string[], dir: string, rawPath: string, capDeadline: number, onInterrupt: () => void): Promise<InvocationResult> {
  return new Promise((done) => {
    const child: ChildProcess = spawn("opencode", ["run", "--auto", "--format", "json", ...args], {
      cwd: dir,
      env: childEnv(dir),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out = createWriteStream(rawPath, { flags: "a" });
    const err = createWriteStream(rawPath + ".stderr", { flags: "a" });
    child.stdout?.pipe(out);
    child.stderr?.pipe(err);
    let capKilled = false;
    let interrupted = false;
    const killGroup = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    };
    const timer = setTimeout(() => {
      capKilled = true;
      killGroup();
    }, Math.max(1000, capDeadline - Date.now()));
    const onInt = () => {
      interrupted = true;
      killGroup();
      onInterrupt();
    };
    process.once("SIGINT", onInt);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInt);
      out.end();
      err.end();
      done({ code, signal, capKilled, interrupted });
    });
  });
}

const hasCompletion = (dir: string) => existsSync(join(dir, "COMPLETION.md"));

/** True when the run dir contains anything beyond the runner's own files —
 * the between-runs escape guard. A run that built nothing has nowhere honest
 * to have written COMPLETION.md, and continuing the set would just repeat
 * whatever went wrong — including reorganizing the wrong repo. */
async function hasBuildArtifacts(dir: string): Promise<boolean> {
  const entries = await readdir(dir);
  return entries.some((e) => !RUNNER_ARTIFACTS.has(e));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = await readFile(new URL(PROMPT_FILE, import.meta.url), "utf8");
  const spec = extractSpec(doc);
  console.log(`lane-A runner (#83 phase 1, incident-hardened) — ${opts.runs} run(s), cap ${Math.round(opts.timeoutSec / 3600)}h, max ${opts.maxInvocations} invocations/run, runs-dir ${opts.runsDir}`);

  if (opts.dryRun) {
    console.log(`--- dry run: spec slice (${spec.length} chars, ${spec.split("\n").length} lines) ---`);
    console.log(spec.slice(0, 300) + "\n[...]\n" + spec.slice(-200));
    return;
  }

  await mkdir(opts.runsDir, { recursive: true });
  const summaries: RunSummary[] = [];
  let setAborted = false;

  for (let n = 1; n <= opts.runs && !setAborted; n++) {
    const dir = join(opts.runsDir, `run-${String(n).padStart(2, "0")}-${stamp()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), spec, "utf8");
    await run("git", ["init", "-q"], { cwd: dir, timeoutMs: 30_000 });

    const rawPath = join(dir, "raw.jsonl");
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const capDeadline = t0 + opts.timeoutSec * 1000;
    console.log(`[${startedAt}] run ${n}/${opts.runs}: ${dir}`);

    let sessionId: string | null = null;
    let invocations = 0;
    let lastExitCode: number | null = null;
    let status: RunStatus = "failed";
    let interrupted = false;

    while (true) {
      if (hasCompletion(dir)) {
        status = "completed";
        break;
      }
      if (Date.now() >= capDeadline) {
        status = status === "failed" ? "cap-killed" : status;
        break;
      }
      if (invocations >= opts.maxInvocations) {
        status = "invocation-capped";
        break;
      }
      const args = invocations === 0 ? [spec] : sessionId ? ["--session", sessionId, NUDGE_PROMPT] : null;
      if (args === null) {
        // No session id captured from the first invocation's stream — cannot
        // resume; record and stop this run.
        break;
      }
      invocations++;
      const res = await invokeOpencode(args, dir, rawPath, capDeadline, () => {
        interrupted = true;
        setAborted = true;
      });
      lastExitCode = res.code;
      if (res.capKilled) {
        status = "cap-killed";
        break;
      }
      if (res.interrupted) {
        status = "signalled";
        break;
      }
      if (sessionId === null) {
        const partial = await readFile(rawPath, "utf8").catch(() => "");
        sessionId = summarizeStream(partial).sessionId;
      }
      if (!interrupted && invocations < opts.maxInvocations) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    const wallSec = Math.round((Date.now() - t0) / 1000);
    const raw = await readFile(rawPath, "utf8").catch(() => "");
    const stream = summarizeStream(raw);
    let guardStatus: RunStatus = status;
    if (status === "completed" || status === "cap-killed" || status === "invocation-capped" || status === "signalled") {
      if (!(await hasBuildArtifacts(dir)) && status !== "signalled") {
        guardStatus = "no-artifacts";
      }
    }
    const summary: RunSummary = {
      run: n,
      dir,
      ...stream,
      status: guardStatus,
      lastExitCode,
      invocations,
      nudges: Math.max(0, invocations - 1),
      startedAt,
      endedAt: new Date().toISOString(),
      wallSec,
    };
    await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
    await run("git", ["-c", "user.name=s2-protocol", "-c", "user.email=s2@protocol.local", "add", "-A"], { cwd: dir, timeoutMs: 60_000 });
    await run("git", ["-c", "user.name=s2-protocol", "-c", "user.email=s2@protocol.local", "commit", "-q", "--allow-empty", "-m", `protocol post-run snapshot (lane A run ${n}) — status: ${summary.status}, invocations: ${invocations}`], { cwd: dir, timeoutMs: 60_000 });
    summaries.push(summary);
    console.log(`[${summary.endedAt}] run ${n}: ${summary.status} — wall ${Math.round(wallSec / 60)}m, ${invocations} invocation(s), ${summary.steps} steps, in ${Math.round(summary.tokens.input / 1000)}k tok, peak ${Math.round(summary.peakInputTokens / 1000)}k, ${summary.errorEvents.length} error event(s)`);

    if (summary.status === "no-artifacts") {
      console.error(
        `\nSET ABORTED: run ${n} produced no build artifacts in its run dir (status: no-artifacts). ` +
        `The model almost certainly escaped its workspace (see ${rawPath} for its actual file targets). ` +
        `Refusing to burn further runs on a broken setup.`,
      );
      setAborted = true;
    }
  }

  const overall = [
    `# Lane A — bare session runs (#83 phase 1)`,
    ``,
    `Prompt: frozen at docs/research/head-to-head-s2-prompt.md (spec slice in each run's PROMPT.md)`,
    `Cap: ${Math.round(opts.timeoutSec / 3600)}h + ${opts.maxInvocations} invocations per run — sequential, no intervention.`,
    ``,
    `| run | status | wall | invocations | steps | in tok | peak in | tools | errors | session |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...summaries.map(
      (s) =>
        `| ${s.run} | ${s.status} | ${Math.round(s.wallSec / 60)}m | ${s.invocations} (${s.nudges} nudged) | ${s.steps} | ${Math.round(s.tokens.input / 1000)}k | ${Math.round(s.peakInputTokens / 1000)}k | ${s.toolCalls} | ${s.errorEvents.length} | ${s.sessionId ?? "—"} |`,
    ),
    ``,
    ...summaries.map((s) => `- run ${s.run}: ${s.dir}`),
  ].join("\n");
  await writeFile(join(opts.runsDir, "OVERALL.md"), overall + "\n", "utf8");
  console.log(`\nall runs complete — ${join(opts.runsDir, "OVERALL.md")}`);
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
