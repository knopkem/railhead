import { writeFile, readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArcStepIdentity } from "../core/product.ts";

export interface PlanOrigin {
  slug: string;
  prompt: string;
  created_at: string;
  ticket_files: string[];
  /** HEAD at plan time (null when the repo had no commits yet). A plan only
   * owns the commits on top of this base, so ticket pre-marking scans
   * base_sha..HEAD — a long-lived repo's older "N — title" commits can never
   * satisfy a fresh plan's ticket titles. Legacy origin.json files without
   * the field read as null (scan everything, the old behavior). */
  base_sha: string | null;
  /** ADR 0051: the product-arc roadmap step this plan builds (feature runs
   * only). Persisting the identity here lets resume/run-end finish the arc
   * transaction (mark the step `built`) without the deriving CLI process,
   * and lets the goal reviewer judge the step, not just the derived prompt.
   * Legacy origin.json files read as undefined. */
  arc_step?: ArcStepIdentity;
}

const ORIGIN_FILE = "origin.json";

export async function writePlanOrigin(dir: string, origin: PlanOrigin): Promise<void> {
  await writeFile(join(dir, ORIGIN_FILE), JSON.stringify(origin, null, 2) + "\n", "utf8");
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
  const arcStep = readArcStep(obj.arc_step);
  return {
    slug: obj.slug,
    prompt: typeof obj.prompt === "string" ? obj.prompt : "",
    created_at: obj.created_at,
    ticket_files: (obj.ticket_files as unknown[]).filter((f): f is string => typeof f === "string"),
    base_sha: typeof obj.base_sha === "string" && obj.base_sha ? obj.base_sha : null,
    ...(arcStep ? { arc_step: arcStep } : {}),
  };
}

/** Tolerant read of the optional arc-step identity: a malformed value is
 * ignored (legacy/corrupt origin files keep working), never fatal. */
function readArcStep(raw: unknown): ArcStepIdentity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.number !== "number" || !Number.isFinite(o.number)) return null;
  return { number: o.number, title: typeof o.title === "string" ? o.title : "" };
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
