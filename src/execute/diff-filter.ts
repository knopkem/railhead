import type { ContractEntry } from "../core/contracts.ts";

const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "mix.lock",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns",
  ".bin", ".glb", ".gltf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".webm",
  ".pdf", ".zip", ".tar", ".gz", ".bz2",
]);

const GENERATED_DIRS = [
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".playwright-mcp/",
  ".railhead/",
  ".scratch/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "target/",
  ".gradle/",
  ".pytest_cache/",
];

export function splitFilePath(file: string): [string, string] {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return [file, ""];
  const lastSlash = file.lastIndexOf("/");
  if (dot < lastSlash) return [file, ""];
  return [file.slice(0, dot), file.slice(dot)];
}

export function isNonSourceFile(file: string): boolean {
  const base = file.split("/").pop() ?? file;
  if (LOCK_FILES.has(base)) return true;
  const [, ext] = splitFilePath(file);
  if (ext && BINARY_EXTENSIONS.has(ext)) return true;
  if (GENERATED_DIRS.some((dir) => file.startsWith(dir) || file.includes("/" + dir))) return true;
  return false;
}

const DIFF_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;

export function stripNonSource(diff: string): string {
  if (!diff) return "";
  const lines = diff.split("\n");
  const kept: string[] = [];
  let skipping = false;
  let currentFile: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(DIFF_HEADER_RE);
    if (headerMatch) {
      currentFile = headerMatch[2];
      skipping = isNonSourceFile(currentFile);
      if (!skipping) kept.push(line);
      continue;
    }
    if (!skipping) kept.push(line);
  }
  const result = kept.join("\n");
  return result.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let multiByteCount = 0;
  let totalChars = 0;
  for (const ch of text) {
    totalChars++;
    if (ch.codePointAt(0)! > 0x7f) multiByteCount++;
  }
  const asciiChars = totalChars - multiByteCount;
  return Math.ceil(asciiChars / 4 + multiByteCharsToTokens(multiByteCount));
}

function multiByteCharsToTokens(count: number): number {
  return count;
}

export const NESTED_REVIEW_SUFFIX = "-review";

export function filesWithEntries(entries: ContractEntry[], allFiles: string[]): string[] {
  const handledFiles = new Set(entries.map((e) => e.file));
  return allFiles.filter((f) => !handledFiles.has(f));
}

export const REVIEW_MODE_THRESHOLD_RATIO = 0.4;

/** Issue #46: below this ratio of max_context_tokens, the diff is inlined in
 * the reviewer prompt; at or above, it is written to a ledger file and the
 * reviewer reads it on demand. Deliberately lower than
 * REVIEW_MODE_THRESHOLD_RATIO (0.4) — the file path fills the middle band
 * between "small enough to inline" and "so large it's better to read the
 * source files directly" (read-mode, #30). */
export const DIFF_FILE_THRESHOLD_RATIO = 0.15;
