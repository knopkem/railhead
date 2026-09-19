import { readProjectDoc, writeProjectDoc } from "../core/git.ts";
import { stripFencedRegions } from "../core/fences.ts";

/**
 * The coherence charter (ADR 0028 / issue #99): a terse, normative, cross-
 * ticket visual design contract the planner authors inside the `$DESIGN` block
 * at plan time and the railhead persists as `docs/coherence.md`. This module
 * owns the charter's durable-file mechanics: the fixed section names `CHARTER:`
 * revisions target, the marker grammar, and the read-modify-write that applies
 * a revision.
 */
export const CHARTER_DOC = "docs/coherence.md";

/** Marker the goal reviewer emits to revise a charter section. Colon-marker
 *  family (`LEARNED:`/`RETRACTED:`/`DIGEST:`), NOT a `$MARKER` — a nested
 *  block marker would complicate transcript parsing for zero gain. */
export const CHARTER_MARKER = "CHARTER:";

/** The fixed section names the charter's normative content is organised
 *  under; a `CHARTER:` revision names exactly one. */
export const CHARTER_SECTIONS = ["Visual tokens", "Layout model", "Chrome rules"] as const;

export type CharterSection = (typeof CHARTER_SECTIONS)[number];

/** One parsed charter revision: replace the named section's content in
 *  docs/coherence.md with `content`. */
export interface CharterRevision {
  section: CharterSection;
  content: string;
}

/** Map a marker's section token onto the canonical section name, or null when
 *  it names nothing (a misspelled or invented section is dropped — the gate
 *  stays fixed-name, like DIGEST:'s line budget). Case-insensitive. */
function canonicalSection(name: string): CharterSection | null {
  const n = name.trim().toLowerCase();
  for (const s of CHARTER_SECTIONS) {
    if (s.toLowerCase() === n) return s;
  }
  return null;
}

/** Parse `CHARTER: <Section>: <revised section content>` lines from a goal
 *  review transcript. Lossy like readDigestMarkers/readLearnedMarkers: line-
 *  start markers only (mid-prose mentions ignored), NONE/empty payloads
 *  dropped, unknown section names dropped, duplicate (section, content) pairs
 *  deduped. A revision is one terse line whose payload REPLACES the whole
 *  named section's content in docs/coherence.md. */
export function parseCharterRevisions(transcript: string): CharterRevision[] {
  const text = stripFencedRegions(transcript);
  const out: CharterRevision[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(CHARTER_MARKER)) continue;
    const rest = line.slice(CHARTER_MARKER.length).trim();
    if (!rest || rest.toUpperCase() === "NONE") continue;
    const m = rest.match(/^(.+?):\s*([\s\S]+)$/);
    if (!m) continue;
    const section = canonicalSection(m[1]);
    const content = m[2].trim();
    if (!section || !content) continue;
    const key = `${section}|${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ section, content });
  }
  return out;
}

/** Whether a doc line opens one of the charter's fixed `### <Section>`
 *  headings (case-insensitive). Returns the canonical section, else null. */
function sectionHeading(line: string): CharterSection | null {
  const m = line.match(/^###\s+(.+)$/);
  return m ? canonicalSection(m[1]) : null;
}

/** Apply revisions to the charter doc text: each revision replaces its named
 *  section's content in place; a section that does not exist yet is appended
 *  at the end (canonical order). Sections present but unrevised keep their
 *  content. Non-section lines (an `#` title, stray notes) are preserved in
 *  place. Pure — no I/O — so the replace/create semantics are unit-testable. */
export function applyCharterRevisionsToText(
  doc: string | null,
  revisions: CharterRevision[],
): string {
  const revisionsBySection = new Map<CharterSection, string>();
  for (const r of revisions) revisionsBySection.set(r.section, r.content);
  if (revisionsBySection.size === 0) return (doc ?? "").trim() + "\n";

  const src = (doc ?? "").split("\n");
  const out: string[] = [];
  const applied = new Set<CharterSection>();
  // Streaming: a line that opens a fixed section starts a replaceable block;
  // any other line (title, blank, unknown ###) is ordinary content that flows
  // through untouched.
  let openSection: CharterSection | null = null;
  for (const line of src) {
    const canon = sectionHeading(line);
    if (canon) {
      // A duplicated fixed-heading of a section this pass already replaced
      // is lossy planner output — the revision owns the section now; the
      // stale second heading is dropped (its content falls to the open-
      // section drop below), never re-emitted beside the replacement.
      if (applied.has(canon)) continue;
      const replacement = revisionsBySection.get(canon);
      if (replacement !== undefined) {
        pushSection(out, canon, replacement);
        applied.add(canon);
      } else {
        out.push(line);
      }
      openSection = canon;
      continue;
    }
    if (openSection && revisionsBySection.has(openSection)) {
      // The section's original content is replaced wholesale — drop its old
      // lines so the revision does not double up beneath the new heading.
      continue;
    }
    out.push(line);
  }
  for (const s of CHARTER_SECTIONS) {
    if (applied.has(s) || !revisionsBySection.has(s)) continue;
    pushSection(out, s, revisionsBySection.get(s)!);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function pushSection(out: string[], section: CharterSection, content: string): void {
  if (out.length && out[out.length - 1] !== "") out.push("");
  out.push(`### ${section}`);
  out.push(content);
}

/** Read docs/coherence.md (if any), apply the revisions, and write it back.
 *  Returns true when at least one revision landed on disk. A no-op (empty
 *  revisions, or every section misspelled) leaves the file untouched. */
export async function applyCharterRevisions(
  cwd: string,
  revisions: CharterRevision[],
): Promise<boolean> {
  if (revisions.length === 0) return false;
  const existing = await readProjectDoc(cwd, CHARTER_DOC);
  const updated = applyCharterRevisionsToText(existing, revisions);
  if (existing !== null && existing.trim() === updated.trim()) return false;
  await writeProjectDoc(cwd, CHARTER_DOC, updated);
  return true;
}
