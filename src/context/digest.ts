import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripFencedRegions } from "../core/fences.ts";

export const DIGEST_CHAR_LIMIT = 3000;

export function digestPath(cwd: string): string {
  return join(cwd, ".railhead", "digest.md");
}

export async function readDigest(cwd: string): Promise<string | null> {
  const path = digestPath(cwd);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf8");
  return content.trim() || null;
}

export async function writeDigest(cwd: string, content: string): Promise<void> {
  const path = digestPath(cwd);
  await mkdir(join(cwd, ".railhead"), { recursive: true });
  await writeFile(path, content.trim() + "\n", "utf8");
}

export async function appendDigest(cwd: string, newContent: string): Promise<void> {
  const existing = await readDigest(cwd);
  const merged = existing
    ? existing + "\n" + newContent.trim()
    : newContent.trim();
  await writeDigest(cwd, merged);
}

export function wouldExceedDigestBudget(currentContent: string | null, newChars: number): boolean {
  const currentLen = currentContent?.length ?? 0;
  return currentLen + newChars > DIGEST_CHAR_LIMIT;
}

export function buildDigestInjection(digest: string | null | undefined): string {
  if (!digest || !digest.trim()) return "";
  return `\n## Project digest (rolling architectural state summary)\nThis digest summarises key architectural decisions and the current shape of the codebase. It is written by prior review checkpoints and is an unverified model-claim, not a tested fact. If a statement in the digest contradicts what you observe in the source, trust the source.\n${digest.split("\n").map((l) => `- ${l}`).join("\n")}`;
}

export const DIGEST_MARKER = "DIGEST:";

export function readDigestMarkers(transcript: string): string | null {
  const text = stripFencedRegions(transcript);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(DIGEST_MARKER)) continue;
    const rest = line.slice(DIGEST_MARKER.length).trim();
    if (!rest || rest.toUpperCase() === "NONE") continue;
    if (seen.has(rest)) continue;
    seen.add(rest);
    lines.push(rest);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export async function pushDigest(
  cwd: string,
  transcript: string,
  group: string,
): Promise<void> {
  const newDigest = readDigestMarkers(transcript);
  if (!newDigest) return;
  const existing = await readDigest(cwd);
  if (existing && wouldExceedDigestBudget(existing, newDigest.length)) {
    const trimmed = (existing + "\n" + newDigest).slice(-DIGEST_CHAR_LIMIT);
    await writeDigest(cwd, trimmed);
  } else {
    await appendDigest(cwd, newDigest);
  }
}
