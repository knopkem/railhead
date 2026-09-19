import { writeFile, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ruling } from "../core/ticket-dag.ts";

export interface PlanOrigin {
  slug: string;
  prompt: string;
  created_at: string;
  ticket_files: string[];
}

const ORIGIN_FILE = "origin.json";
/** Issue #86: plan-time adjudications live beside origin.json so every run on
 * this plan directory can load them (a run-time re-scan must be able to see a
 * plan-time ruling, or every legitimately-ruled finding becomes a false
 * "railhead defect" abort). Run-scoped rulings NEVER write back here — they
 * reference corrective tickets that only exist in that run's graph — with one
 * deliberate exception: a corrective auto-ruling accompanies a corrective
 * ticket FILE that is itself appended to the plan directory, so it becomes
 * plan-scoped the moment its file does. `appendPlanRulings` writes exactly
 * that case; every other runtime ruling stays run-scoped. */
const RULINGS_FILE = "rulings.json";

export async function writePlanOrigin(dir: string, origin: PlanOrigin): Promise<void> {
  await writeFile(join(dir, ORIGIN_FILE), JSON.stringify(origin, null, 2) + "\n", "utf8");
}

/** Persist the plan's adjudicated rulings next to its origin marker. */
export async function writePlanRulings(dir: string, rulings: Ruling[]): Promise<void> {
  await writeFile(join(dir, RULINGS_FILE), JSON.stringify(rulings, null, 2) + "\n", "utf8");
}

/** Append corrective auto-rulings to the plan sidecar, deduping by key. A
 * corrective ticket file is persisted to the plan directory, so its ruling
 * must persist beside it — otherwise a fresh `railhead run` re-scans that file
 * and re-fires a class-A pair the prior run already adjudicated (#86). */
export async function appendPlanRulings(dir: string, rulings: Ruling[]): Promise<void> {
  const existing = await readPlanRulings(dir);
  const seen = new Set(existing.map((r) => r.key));
  const merged = [...existing];
  for (const r of rulings) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    merged.push(r);
  }
  await writePlanRulings(dir, merged);
}

/** Read the plan's adjudicated rulings. Returns [] when the file is absent (a
 * plan from before issue #86 has no rulings file). Throws on malformed JSON —
 * mirroring readPlanOrigin: a corrupt plan artifact must be surfaced, not
 * silently treated as empty (which would re-gate a clean plan). */
export async function readPlanRulings(dir: string): Promise<Ruling[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, RULINGS_FILE), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`failed to read plan rulings file at ${join(dir, RULINGS_FILE)}: ${(err as Error).message}`);
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`plan rulings file at ${join(dir, RULINGS_FILE)} is not valid JSON — the plan directory may be corrupted`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`plan rulings file at ${join(dir, RULINGS_FILE)} is not a JSON array — the plan directory may be corrupted`);
  }
  const rulings: Ruling[] = [];
  for (const item of parsed as unknown[]) {
    const r = item as Record<string, unknown>;
    if (
      typeof r?.key !== "string" ||
      typeof r?.reason !== "string" ||
      typeof r?.source !== "string" ||
      !Array.isArray(r?.tickets)
    ) {
      throw new Error(`plan rulings file at ${join(dir, RULINGS_FILE)} contains a malformed ruling — the plan directory may be corrupted`);
    }
    rulings.push({
      key: r.key,
      finding: typeof r.finding === "string" ? r.finding : "",
      reason: r.reason,
      source: r.source as Ruling["source"],
      tickets: (r.tickets as unknown[]).filter((f): f is string => typeof f === "string"),
    });
  }
  return rulings;
}

export async function readPlanOrigin(dir: string): Promise<PlanOrigin | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, ORIGIN_FILE), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`failed to read plan origin file at ${join(dir, ORIGIN_FILE)}: ${(err as Error).message}`);
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`plan origin file at ${join(dir, ORIGIN_FILE)} is not valid JSON — the plan directory may be corrupted`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`plan origin file at ${join(dir, ORIGIN_FILE)} is not a JSON object — the plan directory may be corrupted`);
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.slug !== "string" ||
    typeof obj.created_at !== "string" ||
    !Array.isArray(obj.ticket_files)
  ) {
    throw new Error(`plan origin file at ${join(dir, ORIGIN_FILE)} is missing required fields (slug, created_at, ticket_files) — the plan directory may be corrupted`);
  }
  return {
    slug: obj.slug,
    prompt: typeof obj.prompt === "string" ? obj.prompt : "",
    created_at: obj.created_at,
    ticket_files: (obj.ticket_files as unknown[]).filter((f): f is string => typeof f === "string"),
  };
}

export function checkPlanOrigin(origin: PlanOrigin | null, currentTicketFiles: string[]): string[] {
  if (origin === null) {
    return ["plan directory has no origin.json identity marker — cannot verify ticket set integrity (issue #47)"];
  }
  const expected = new Set(origin.ticket_files);
  const current = new Set(currentTicketFiles);
  const warnings: string[] = [];

  const added = [...current].filter((f) => !expected.has(f));
  for (const f of added) {
    warnings.push(`ticket file "${f}" exists on disk but was not in the original plan — possible cross-plan contamination`);
  }

  const missing = [...expected].filter((f) => !current.has(f));
  for (const f of missing) {
    warnings.push(`ticket file "${f}" was in the original plan but is missing on disk — the plan directory may be stale or corrupted`);
  }

  return warnings;
}

/** ADR 0040: the measured wall time of this project's plan phase(s), read from
 * the plan ledger's event timestamps (design + coverage audit + decomposition,
 * all on the same model and repo). This is the calibration the per-ticket
 * wall budget scales from. Returns null when the ledger is absent, unreadable,
 * or carries no usable timestamps — the caller falls back to a step-derived
 * floor. Tolerant by design: a corrupt file is skipped, never fatal (the
 * budget is a backstop, not a gate). */
export function readPlanWallMs(planDir: string): number | null {
  const eventsDir = join(planDir, "events");
  let files: string[];
  try {
    files = readdirSync(eventsDir).filter((f) => f.startsWith("plan") && f.endsWith(".jsonl") && !f.includes(".stderr"));
  } catch {
    return null;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(join(eventsDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/"timestamp":(\d{10,})/);
      if (!m) continue;
      const t = Number(m[1]);
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return max - min;
}
