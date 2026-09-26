import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scanJsonObjects } from "./json.ts";

export const CONTRACTS_FILE = "railhead.contracts.json";

export interface ContractEntry {
  symbol: string;
  kind: string; // function | class | constant | type | endpoint | ...
  file: string;
  signature: string;
  added_by?: string; // ticket tag (e.g. run-xxx/01)
  changed_by?: string[];
  description?: string;
}

export interface ContractsIndex {
  schema_version: number;
  entries: ContractEntry[];
}

export const EMPTY_INDEX: ContractsIndex = {
  schema_version: 1,
  entries: [],
};

export async function loadContracts(cwd: string): Promise<ContractsIndex> {
  try {
    const raw = await readFile(join(cwd, CONTRACTS_FILE), "utf8");
    const j = JSON.parse(raw) as Partial<ContractsIndex>;
    return {
      schema_version: j.schema_version ?? 1,
      entries: Array.isArray(j.entries) ? j.entries : [],
    };
  } catch {
    return { ...EMPTY_INDEX };
  }
}

export async function saveContracts(
  cwd: string,
  index: ContractsIndex,
): Promise<void> {
  await writeFile(
    join(cwd, CONTRACTS_FILE),
    JSON.stringify(index, null, 2) + "\n",
    "utf8",
  );
}

export interface ContractVerification {
  verified: ContractEntry[];
  /** Entries dropped because the symbol wasn't found in the claimed file (or the file doesn't exist). */
  rejected: ContractEntry[];
}

/**
 * Guard the index's core invariant (ADR 0008: later tickets trust these
 * entries as ground truth) against a model self-reporting a contract that was
 * never actually written. `extractContractsBlock` is lossy-but-honest parsing
 * of what the model SAID; this checks it against what is actually on disk
 * before it is allowed to poison every downstream ticket that reads the index.
 *
 * Deliberately cheap — a substring check, not a parser or a symbol table.
 * A false accept (the symbol string appears but isn't really the declared
 * contract, e.g. it's a comment or an unrelated match) is low-severity: the
 * index gets a slightly-too-generous entry, no worse than today's unchecked
 * baseline. A false reject (the entry is real but this check misses it, e.g.
 * behind a macro or generated code) only means the index doesn't grow that
 * entry — the pre-ADR-0008 status quo of "the executor explores" — not
 * silent corruption. Both failure modes are safer than trusting every claim.
 */
export async function verifyContractEntries(
  cwd: string,
  entries: ContractEntry[],
): Promise<ContractVerification> {
  const verified: ContractEntry[] = [];
  const rejected: ContractEntry[] = [];
  for (const e of entries) {
    try {
      const content = await readFile(join(cwd, e.file), "utf8");
      if (e.symbol && content.includes(e.symbol)) {
        verified.push(e);
      } else {
        rejected.push(e);
      }
    } catch {
      rejected.push(e);
    }
  }
  return { verified, rejected };
}

/** Merge a batch of new/changed contract entries into the index, tagging origin. */
export function mergeContracts(
  index: ContractsIndex,
  incoming: ContractEntry[],
  tag: string,
): ContractsIndex {
  const byKey = new Map<string, ContractEntry>();
  for (const e of index.entries) byKey.set(keyOf(e), e);

  for (const inc of incoming) {
    const existing = byKey.get(keyOf(inc));
    const addDec = tag && !existing;
    const clean: ContractEntry = {
      ...inc,
      added_by: existing?.added_by ?? (tag || undefined),
      changed_by: existing?.changed_by ?? [],
    };
    if (existing) {
      clean.symbol = existing.symbol;
      clean.changed_by = Array.from(new Set([...(existing.changed_by ?? []), pad(tag)]));
      if (tag) clean.added_by = existing.added_by;
    }
    byKey.set(keyOf(clean), clean);
  }
  return {
    schema_version: index.schema_version ?? 1,
    entries: Array.from(byKey.values()),
  };
}

function pad(tag: string): string {
  return tag;
}

function keyOf(e: ContractEntry): string {
  return `${e.file}#${e.symbol}`;
}

/** One-line summaries for the planner to keep context tiny. `framing`
 * changes only the empty-index line: a greenfield repo has no public surface
 * yet; an existing repo (feature mode) has real, unindexed surface — the one
 * place the index's silence would otherwise tell the planner a destructive
 * lie ("likely a greenfield repo"). */
export function summarizeContracts(index: ContractsIndex, framing?: "greenfield" | "existing-repo"): string {
  if (!index.entries.length) {
    return framing === "existing-repo"
      ? "(the contracts index is empty — this is an existing codebase whose public surface is not yet indexed; the feature description, the product arc, and the glossary are the authority on what exists; reuse what you find rather than scaffolding)"
      : "(no known contracts yet — this is likely a greenfield repo)";
  }
  const lines = index.entries.map(
    (e) => `${e.symbol} (${e.kind}) @ ${e.file} :: ${e.signature || "?"}`,
  );
  return lines.join("\n");
}

export function renderContracts(index: ContractsIndex): string {
  if (!index.entries.length) return "(none)";
  return index.entries
    .map((e) => `${e.symbol} (${e.kind}) @ ${e.file}: ${e.signature || "?"}`)
    .join("\n");
}

/**
 * Parse a `$CONTRACTS ... $END` block from model output. Tolerates prose:
 * find the block, take the JSON objects inside it.
 */
export function extractContractsBlock(
  text: string,
  fallbackFile: string,
): ContractEntry[] {
  const start = text.lastIndexOf("$CONTRACTS");
  let slice = start >= 0 ? text.slice(start + "$CONTRACTS".length) : text;
  const end = slice.indexOf("$END");
  if (end >= 0) slice = slice.slice(0, end);

  return scanJsonObjects(slice)
    .filter((o) => typeof o.symbol === "string" && (o.symbol as string).trim())
    .map((o) => ({
      symbol: String(o.symbol).trim(),
      kind: String(o.kind ?? "symbol").trim(),
      file: String(o.file ?? fallbackFile).trim(),
      signature: String(o.signature ?? "").trim(),
      description: typeof o.description === "string" ? o.description : undefined,
    }));
}