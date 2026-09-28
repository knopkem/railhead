import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContractEntry } from "../core/contracts.ts";
import { CONTRACTS_FILE, extractContractsBlock, loadContracts, mergeContracts, saveContracts, verifyContractEntries } from "../core/contracts.ts";
import { buildContractExtractFilePrompt } from "../context/prompt.ts";
import { joinPhaseMessages } from "../context/preamble.ts";
import { RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";
import { describeExecFailure, executeFreshPhase, startPersistentWorker, stopPersistentWorker } from "./executor.ts";
import { guardReadOnlyPhase } from "./read-only-guard.ts";
import { extractAssistantText } from "../core/ledger.ts";
import { seatContextBudget } from "../config/config.ts";
import { withFailureLadderOnThrow } from "./failure-ladder.ts";
import { nowClock } from "../cli/overview.ts";
import * as git from "../core/git.ts";
import type { RunState, TicketState } from "../core/state.ts";

export type Language = "typescript" | "rust" | "python" | "go" | "unknown";

export interface ExtractPattern {
  regex: RegExp;
  kindMap: Record<string, string>;
  fromSymbolGroup: number;
  fromKindGroup: number;
}

const TS_PATTERNS: ExtractPattern[] = [
  {
    regex: /^\s*export\s+default\s+(?:async\s+)?(?:function|const|class)\b\s*(\w+)?/,
    kindMap: { function: "function", const: "constant", class: "class" },
    fromSymbolGroup: 1,
    fromKindGroup: 0,
  },
  {
    regex: /^\s*export\s+(async\s+)?(?:function|const|class|interface|type)\b\s*(\w+)/,
    kindMap: { function: "function", const: "constant", class: "class", interface: "type", type: "type" },
    fromSymbolGroup: 2,
    fromKindGroup: 0,
  },
  {
    // Re-export: export { foo, bar } from "./baz"
    regex: /^\s*export\s*\{([^}]+)\}\s*(?:from\s+["'][^"']+["'])?/,
    kindMap: {},
    fromSymbolGroup: 1,
    fromKindGroup: 0,
  },
];

const RUST_PATTERNS: ExtractPattern[] = [
  {
    regex: /^\s*pub(?:\s*\([^)]*\))?\s+(?:const\s+|unsafe\s+|async\s+)*(?:fn|struct|enum|trait|const|type)\b\s*(\w+)/,
    kindMap: { fn: "function", struct: "class", enum: "type", trait: "type", const: "constant", type: "type" },
    fromSymbolGroup: 1,
    fromKindGroup: 0,
  },
];

const PYTHON_PATTERNS: ExtractPattern[] = [
  {
    regex: /^(?:async\s+)?(?:def|class)\b\s+(\w+)/,
    kindMap: { def: "function", class: "class" },
    fromSymbolGroup: 1,
    fromKindGroup: 0,
  },
];

const GO_PATTERNS: ExtractPattern[] = [
  {
    regex: /^\s*func\b(?:\s*\([^)]*\))?\s+(\w+)/,
    kindMap: {},
    fromSymbolGroup: 1,
    fromKindGroup: 0,
  },
  {
    regex: /^\s*type\b\s+(\w+)/,
    kindMap: {},
    fromSymbolGroup: 1,
    fromKindGroup: 0,
  },
];

export function splitFilePath(file: string): [string, string] {
  const dot = file.lastIndexOf(".");
  if (dot < 0 || dot === 0 && file.lastIndexOf("/") > dot) return [file, ""];
  const lastSlash = file.lastIndexOf("/");
  if (dot < lastSlash) return [file, ""];
  return [file.slice(0, dot), file.slice(dot)];
}

function detectLanguage(file: string): Language {
  const [, ext] = splitFilePath(file);
  switch (ext) {
    case ".ts": case ".tsx": case ".js": case ".jsx": case ".mjs": case ".cjs":
      return "typescript";
    case ".rs":
      return "rust";
    case ".py":
      return "python";
    case ".go":
      return "go";
    default:
      return "unknown";
  }
}

function patternsFor(lang: Language): ExtractPattern[] {
  switch (lang) {
    case "typescript": return TS_PATTERNS;
    case "rust": return RUST_PATTERNS;
    case "python": return PYTHON_PATTERNS;
    case "go": return GO_PATTERNS;
    default: return [];
  }
}

const KIND_BY_KEYWORD: Record<string, string> = {
  function: "function",
  const: "constant",
  class: "class",
  interface: "type",
  type: "type",
  fn: "function",
  struct: "class",
  enum: "type",
  trait: "type",
  def: "function",
};

function kindFromMatch(line: string): string {
  const keywordMatch = line.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const\s+|unsafe\s+)*(function|const|class|interface|type|fn|struct|enum|trait|def)\b/);
  if (keywordMatch) {
    return KIND_BY_KEYWORD[keywordMatch[1]] ?? "function";
  }
  if (line.match(/^\s*type\b/)) return "type";
  if (line.match(/^\s*func\b/)) return "function";
  return "function";
}

function extractEntries(file: string, content: string): ContractEntry[] {
  const lang = detectLanguage(file);
  const patterns = patternsFor(lang);
  if (!patterns.length) return [];

  const entries: ContractEntry[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (!match) continue;

      if (pattern === TS_PATTERNS[2]) {
        const symbols = match[pattern.fromSymbolGroup]
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter((s) => s.length > 0 && s !== "*");
        for (const sym of symbols) {
          entries.push({
            symbol: sym,
            kind: "function",
            file,
            signature: line.trim(),
          });
        }
      } else if (pattern === TS_PATTERNS[0]) {
        entries.push({
          symbol: "default",
          kind: kindFromMatch(line),
          file,
          signature: line.trim(),
        });
      } else {
        const symbol = match[pattern.fromSymbolGroup];
        if (!symbol) continue;
        entries.push({
          symbol,
          kind: kindFromMatch(line),
          file,
          signature: line.trim(),
        });
      }
      break;
    }
  }
  return entries;
}

export async function regexExtractContracts(
  cwd: string,
  files: string[],
): Promise<ContractEntry[]> {
  const all: ContractEntry[] = [];
  for (const file of files) {
    try {
      const content = await readFile(join(cwd, file), "utf8");
      all.push(...extractEntries(file, content));
    } catch {
    }
  }
  return all;
}

export function isSourceFile(file: string): boolean {
  return detectLanguage(file) !== "unknown";
}

export function filesWithNoEntries(files: string[], entries: ContractEntry[]): string[] {
  const handled = new Set(entries.map((e) => e.file));
  return files.filter((f) => isSourceFile(f) && !handled.has(f));
}

/** Whether a source file could plausibly declare a public contract at all.
 * The regexes key on explicit visibility/export markers per language; a file
 * that contains none of them has no public surface to index, so the model
 * fallback is pure waste on it — and an unconstrained model call on a file
 * with nothing to extract is how a "list the contracts" phase turned into an
 * implementation agent (the 01-contracts-vite_config incident). Unknown
 * languages never reach the fallback (not source files). */
export function hasPublicSurface(file: string, content: string): boolean {
  switch (detectLanguage(file)) {
    case "typescript": return /\bexport\b/.test(content);
    case "rust": return /\bpub\b/.test(content);
    case "python": return /\b(?:def|class)\s+\w/.test(content);
    case "go": return /^\s*(?:func|type)\b/m.test(content);
    default: return false;
  }
}

/** Bound on the per-file extraction fallback. The task is one reading + one
 * `$CONTRACTS` block; a few steps tolerate a denied-tool detour without
 * leaving room for an agent loop. */
const EXTRACT_MAX_STEPS = 4;

/** Per-file model fallback for contract extraction (#28). Reads each
 * unhandled file's content and makes a separate model call per file,
 * bounding each call to O(file) instead of O(ticket diff). A 30k-token
 * shader file can't overflow a 64k context when it's the only thing in the
 * prompt.
 *
 * Two bounds keep the fallback honest (the 01-contracts-vite_config incident:
 * a mission-laden fork with write tools implemented the remaining tickets
 * instead of listing contracts):
 *  - `hasPublicSurface` skips files with no export marker — nothing to list.
 *  - The call runs on the tool-denied review seat with a small step cap and
 *    WITHOUT the run's base-session fork. The task prompt already carries the
 *    file text; forking the base conversation would inject the mission and the
 *    design docs into a task that only needs the source. */
async function extractUnhandledFiles(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  unhandled: string[],
): Promise<ContractEntry[]> {
  const entries: ContractEntry[] = [];
  const model = state._models?.extract ?? state._models?.implement ?? null;
  for (const file of unhandled) {
    const content = await readFile(join(state.cwd, file), "utf8").catch(() => "");
    if (!content) continue;
    if (!hasPublicSurface(file, content)) continue;
    const phaseFile = `${ticket.number}-contracts-${file.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}`;
    const prompt = buildContractExtractFilePrompt(file, content);
    const result = await guardReadOnlyPhase(state.cwd, ledger, phaseFile, "contract extract", () =>
      executeFreshPhase(joinPhaseMessages(prompt), {
        cwd: state.cwd,
        ledgerDir: ledger,
        phaseFile,
        model,
        agent: RAILHEAD_AGENT_NAMES.review,
        live: !state.quiet, verbose: state.verbose,
        livePrefix: `${ticket.number} contracts ${file}`,
        maxSteps: EXTRACT_MAX_STEPS,
        stallTimeoutSec: state.config.stall_timeout_sec,
        maxStepModelSec: state.config.max_step_model_sec,
        maxContextTokens: seatContextBudget(state, "extract"),
      }),
    );
    if (result.status === "transient") throw new Error(`contract extract ${file}: ${describeExecFailure(result)}`);
    if (result.status === "ok") {
      const text = await extractAssistantText(ledger, phaseFile);
      entries.push(...extractContractsBlock(text, file));
    }
  }
  return entries;
}

/**
 * After a ticket commits, extract the public contracts it introduced, merge
 * them into railhead.contracts.json (tagged with the ticket), and commit the
 * index update as a follow-up commit on the same branch.
 *
 * Regex extraction runs first — no model call. For files where regex found
 * nothing (unknown language, macro-heavy code, non-standard exports), fall
 * back to a per-file model call (#28): each unhandled file gets its own
 * model call with just that file's content, not the full ticket diff. This
 * bounds each call to O(file) not O(ticket), so a 30k-token shader file
 * can't overflow a 64k context.
 */
export async function updateContracts(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  parsed: { what: string; criteria: string[] },
): Promise<void> {
  const tag = `${ticket.number}`;
  const from = ticket.start_commit ?? "HEAD~1";
  const changedFilesRaw = await git.filesChanged(state.cwd, from, "HEAD").catch(() => "");
  const changedFiles = changedFilesRaw.split("\n").map((f) => f.trim()).filter((f) => f.length > 0);
  if (!changedFiles.length) return;

  const regexEntries = await regexExtractContracts(state.cwd, changedFiles);
  const unhandled = filesWithNoEntries(changedFiles, regexEntries);

  let incoming: ContractEntry[] = regexEntries;

  if (unhandled.length) {
    const extractResult = await withFailureLadderOnThrow(
      () => extractUnhandledFiles(state, ledger, ticket, unhandled),
      {
        backoff: state.config.infra_backoff_sec,
        budget: seatContextBudget(state, "implement"),
        restartWorker: state.config.persistent_worker === true
          ? async () => { await stopPersistentWorker(); await startPersistentWorker({ cwd: state.cwd }); }
          : async () => {},
      },
    );
    const modelEntries = extractResult.ok ? extractResult.value : [];
    incoming = [...regexEntries, ...modelEntries];
  }

  if (!incoming.length) return;

  const { verified, rejected } = await verifyContractEntries(state.cwd, incoming);
  if (rejected.length) {
    const names = rejected.map((r) => `${r.symbol}@${r.file}`).join(", ");
    ticket.logs.push(`contracts: dropped ${rejected.length} unverifiable entr${rejected.length === 1 ? "y" : "ies"} (symbol not found in claimed file): ${names}`);
  }
  if (!verified.length) return;

  if (regexEntries.length) {
    ticket.logs.push(`contracts: regex extracted ${regexEntries.length} from ${changedFiles.length} file(s)${unhandled.length ? `, model fallback for ${unhandled.length}` : ""}`);
  }

  const index = await loadContracts(state.cwd);
  const merged = mergeContracts(index, verified, tag);
  await saveContracts(state.cwd, merged);

  // Commit ONLY the index. A tooling commit must never claim project code:
  // the 01-contracts-vite_config incident saw a runaway extraction phase's
  // writes swept into `index: update contracts after 01`, after which the next
  // builder read them as a pre-seeded reference implementation and the plan
  // was replanned around that false premise. Anything else dirty is surfaced,
  // never committed here.
  const dirty = await git.dirtyPaths(state.cwd).catch(() => [] as string[]);
  const outOfScope = dirty.filter((p) => p !== CONTRACTS_FILE);
  if (outOfScope.length) {
    const shown = outOfScope.slice(0, 5).join(", ");
    const more = outOfScope.length > 5 ? ` (+${outOfScope.length - 5} more)` : "";
    const notice = `contracts: ${outOfScope.length} out-of-scope worktree change(s) left uncommitted: ${shown}${more}`;
    ticket.logs.push(notice);
    console.log(`[${nowClock()}]   ${ticket.number} ${notice}`);
  }
  await git.commitPaths(state.cwd, [CONTRACTS_FILE], `index: update contracts after ${tag}`, true);
}
