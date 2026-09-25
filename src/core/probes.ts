import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbeEntry, RunState } from "./state.ts";

/**
 * The persistent probe registry (v2 issue 01, ADR 0043/0044). The goal review
 * materializes one probe per concrete finding — a shell command plus the
 * substring its output must contain when the behavior holds. Later rounds run
 * the registered probes deterministically first and judge their output, so a
 * repeat review re-checks the SAME blockers instead of re-deriving them (the
 * observed waste: four goal rounds re-probing identical findings for tens of
 * minutes each).
 *
 * Entries persist in `state.probes` (written by the ledger on every state
 * write); the scripts live under `.railhead/probes/` so the registry survives
 * a resume even when the in-memory state is stale. Probes stay
 * language-agnostic by construction: a command and a predicate, never a test
 * framework.
 */

export const PROBES_DIR = join(".railhead", "probes");

export interface ProbeRecipe {
  behavior: string;
  command: string;
  expect: string;
}

export type ProbeStatus = "pass" | "fail" | "error";

export interface ProbeResult {
  entry: ProbeEntry;
  status: ProbeStatus;
  output: string;
}

/** The deterministic predicate: the probe passes iff its output contains the
 * expected substring (case-insensitive). An empty predicate means the command
 * itself is the assertion (exit status only). */
export function checkProbeOutput(output: string, expect: string): boolean {
  const needle = expect.trim().toLowerCase();
  if (!needle) return true;
  return output.toLowerCase().includes(needle);
}

/** The next stable probe id for a run. Ids are sequential across groups. */
function nextProbeId(existing: ProbeEntry[]): string {
  const max = existing.reduce((m, p) => {
    const n = parseInt(p.id.replace(/^p/, ""), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `p${max + 1}`;
}

/**
 * Record a round's probe recipes in the registry. Idempotent per
 * (group, behavior, command): a re-emitted identical probe is skipped, but a
 * genuinely changed command for the same behavior replaces nothing and is
 * added as its own probe (a stale predicate must not silently outlive its
 * recipe). Mutates `state.probes` and returns the newly added entries.
 */
export function registerProbes(state: RunState, group: string, recipes: ProbeRecipe[]): ProbeEntry[] {
  const existing = state.probes ?? [];
  const added: ProbeEntry[] = [];
  for (const r of recipes) {
    const behavior = r.behavior.trim();
    const command = r.command.trim();
    if (!behavior || !command) continue;
    const duplicate = existing.some((p) => p.group === group && p.behavior === behavior && p.command === command);
    if (duplicate) continue;
    added.push({
      id: nextProbeId([...existing, ...added]),
      group,
      behavior,
      command,
      expect: r.expect.trim(),
      created_at: new Date().toISOString(),
    });
  }
  if (added.length > 0) state.probes = [...existing, ...added];
  return added;
}

/** The probes registered for one group, oldest first. */
export function probesForGroup(state: RunState, group: string): ProbeEntry[] {
  return (state.probes ?? []).filter((p) => p.group === group);
}

/** Materialize each entry's command as a runnable script under
 * `.railhead/probes/<id>.sh` (the audit trail and the resume source). Returns
 * the written paths. */
export async function materializeProbeScripts(cwd: string, entries: ProbeEntry[]): Promise<string[]> {
  if (entries.length === 0) return [];
  const dir = join(cwd, PROBES_DIR);
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const e of entries) {
    const path = join(dir, `${e.id}.sh`);
    await writeFile(path, `#!/bin/sh\nset -e\n${e.command}\n`, { encoding: "utf8", mode: 0o755 });
    paths.push(path);
  }
  return paths;
}

export interface ShellProbeResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** The process-boundary runner, injectable so registry logic is unit-testable
 * without spawning shells. Runs the materialized script with the repo root as
 * cwd; never throws — a spawn failure is a probe error, not a run failure. */
export type ProbeRunner = (script: string, cwd: string, timeoutSec: number) => Promise<ShellProbeResult>;

export const shellProbeRunner: ProbeRunner = (script, cwd, timeoutSec) =>
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn("sh", [script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, output: output + `\n(probe timed out after ${timeoutSec}s)`, timedOut: true });
    }, timeoutSec * 1000);
    const collect = (chunk: Buffer) => { output += chunk.toString("utf8"); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, output: output + `\n(probe spawn failed: ${err.message})`, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, timedOut: false });
    });
  });

export interface RunProbesOptions {
  timeoutSec?: number;
  runner?: ProbeRunner;
}

/** Re-run registered probes deterministically. A probe whose process fails to
 * spawn or exits non-zero is a probe ERROR (the recipe is unreliable now), not
 * a behavior failure; only a completed run whose output lacks the predicate is
 * a fail. Never throws. */
export async function runRegisteredProbes(
  cwd: string,
  entries: ProbeEntry[],
  options: RunProbesOptions = {},
): Promise<ProbeResult[]> {
  const runner = options.runner ?? shellProbeRunner;
  const timeoutSec = options.timeoutSec ?? 120;
  const results: ProbeResult[] = [];
  for (const entry of entries) {
    const script = join(cwd, PROBES_DIR, `${entry.id}.sh`);
    let shell: ShellProbeResult;
    try {
      shell = await runner(script, cwd, timeoutSec);
    } catch (err) {
      results.push({ entry, status: "error", output: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (shell.timedOut || shell.code === null) {
      results.push({ entry, status: "error", output: shell.output });
    } else if (shell.code !== 0) {
      results.push({ entry, status: "error", output: `${shell.output}\n(probe exited ${shell.code})` });
    } else {
      results.push({ entry, status: checkProbeOutput(shell.output, entry.expect) ? "pass" : "fail", output: shell.output });
    }
  }
  return results;
}
