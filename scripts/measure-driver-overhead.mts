#!/usr/bin/env npx tsx
/**
 * Measure each driver's baseline system-prompt + tool-schema token cost, in an
 * empty directory against the same model, so the only difference between the
 * two numbers is the driver. This is the experiment ADR 0034's premise gate
 * rests on; re-run it when opencode or pi changes version.
 *
 * opencode: `opencode run --format json --model <id> "reply with just: ok"`
 *           — read `step_finish` part.tokens (input + cache.read).
 * pi:       `pi --print --mode json --provider <p> --model <id> --thinking off
 *           --no-session "reply with just: ok"` — read `usage.input` on the
 *           final message.
 *
 * Usage:
 *   npx tsx scripts/measure-driver-overhead.mts [--oc-model ID]
 *       [--pi-provider NAME] [--pi-model ID] [--timeout-ms N]
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function opencodeTokens(stdout: string): { input: number | null; cacheRead: number | null } {
  let input: number | null = null;
  let cacheRead: number | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "step_finish") continue;
    const t = ev.part?.tokens;
    if (t && typeof t.input === "number") input = t.input;
    if (t?.cache && typeof t.cache.read === "number") cacheRead = t.cache.read;
  }
  return { input, cacheRead };
}

function piTokens(stdout: string): number | null {
  let input: number | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "message_end") {
      const u = ev.message?.usage ?? ev.usage;
      if (u && typeof u.input === "number") input = u.input;
    }
  }
  return input;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ocModel = arg("--oc-model", "llama-cpp/qwen3.8-27b-noreason");
const piProvider = arg("--pi-provider", "llama-cpp");
const piModel = arg("--pi-model", "qwen3.8-27b-noreason");
const timeoutMs = Number(arg("--timeout-ms", "120000"));

const dir = await mkdtemp(join(tmpdir(), "driver-probe-"));

try {
  const oc = await run("opencode", ["run", "--format", "json", "--model", ocModel, "reply with just: ok"], dir, timeoutMs);
  const pi = await run("pi", ["--print", "--mode", "json", "--provider", piProvider, "--model", piModel, "--thinking", "off", "--no-session", "reply with just: ok"], dir, timeoutMs);

  const ocT = opencodeTokens(oc.stdout);
  const piT = piTokens(pi.stdout);

  const ocTotal = ocT.input !== null && ocT.cacheRead !== null ? ocT.input + ocT.cacheRead : ocT.input;
  const delta = ocTotal !== null && piT !== null ? ocTotal - piT : null;

  console.log(JSON.stringify({
    opencode: { input: ocT.input, cacheRead: ocT.cacheRead, total: ocTotal, exit: oc.code },
    pi: { input: piT, exit: pi.code },
    deltaTokens: delta,
    ratio: piT && ocTotal ? (ocTotal / piT).toFixed(1) : null,
  }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
}
