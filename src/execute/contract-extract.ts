import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContractEntry } from "../core/contracts.ts";
import { extractContractsBlock, loadContracts, mergeContracts, saveContracts, verifyContractEntries } from "../core/contracts.ts";
import { buildContractExtractFilePrompt } from "../context/prompt.ts";
import { joinPhaseMessages } from "../context/preamble.ts";
import { describeExecFailure, executeFreshPhase, startPersistentWorker, stopPersistentWorker } from "./executor.ts";
import { forkPhase } from "./base-session.ts";
import { extractAssistantText } from "../core/ledger.ts";
import { seatContextBudget } from "../config/config.ts";
import { withFailureLadderOnThrow } from "./failure-ladder.ts";
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

/** Per-file model fallback for contract extraction (#28). Reads each
 * unhandled file's content and makes a separate model call per file,
 * bounding each call to O(file) instead of O(ticket diff). A 30k-token
 * shader file can't overflow a 64k context when it's the only thing in
 * the prompt. */
async function extractUnhandledFiles(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  unhandled: string[],
): Promise<ContractEntry[]> {
  const entries: ContractEntry[] = [];
  for (const file of unhandled) {
    const content = await readFile(join(state.cwd, file), "utf8").catch(() => "");
    if (!content) continue;
    const phaseFile = `${ticket.number}-contracts-${file.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}`;
    const prompt = buildContractExtractFilePrompt(file, content);
    const fork = forkPhase(state, prompt.task);
    const result = await executeFreshPhase(joinPhaseMessages(prompt), {
      cwd: state.cwd,
      ledgerDir: ledger,
      phaseFile,
      model: state._models?.implement ?? null,
      session: fork.session,
      fork: fork.fork,
      task: fork.task,
      live: !state.quiet, verbose: state.verbose,
      livePrefix: `${ticket.number} contracts ${file}`,
      maxSteps: state.config.max_phase_steps,
      stallTimeoutSec: state.config.stall_timeout_sec,
      maxStepModelSec: state.config.max_step_model_sec,
      maxContextTokens: seatContextBudget(state, "implement"),
    });
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

  if (!(await git.isClean(state.cwd))) {
    await git.commit(state.cwd, `index: update contracts after ${tag}`);
  }
}
