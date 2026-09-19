import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initGit, ensureInitialCommit } from "../core/git.ts";
import {
  CHARTER_MARKER,
  CHARTER_DOC,
  parseCharterRevisions,
  applyCharterRevisionsToText,
  applyCharterRevisions,
  type CharterRevision,
} from "./coherence.ts";

describe("parseCharterRevisions (issue #99)", () => {
  it("parses a CHARTER: revision naming a fixed section and its replacement content", () => {
    const r = parseCharterRevisions(
      `some prose
${CHARTER_MARKER} Visual tokens: accent is #00FF99; spacing scale is 4px
${CHARTER_MARKER} Chrome rules: keep the single toolbar recipe; no competing style
more prose`,
    );
    expect(r).toEqual([
      { section: "Visual tokens", content: "accent is #00FF99; spacing scale is 4px" },
      { section: "Chrome rules", content: "keep the single toolbar recipe; no competing style" },
    ]);
  });

  it("matches section names case-insensitively and normalizes to the canonical name", () => {
    const r = parseCharterRevisions(`${CHARTER_MARKER} layout model: the toolbar docks top`);
    expect(r).toEqual([{ section: "Layout model", content: "the toolbar docks top" }]);
  });

  it("ignores mid-prose mentions (line-start markers only)", () => {
    const r = parseCharterRevisions(`the goal reviewer said ${CHARTER_MARKER} Visual tokens: x but it was prose`);
    expect(r).toEqual([]);
  });

  it("drops NONE/empty payloads and unknown section names without crashing", () => {
    const r = parseCharterRevisions(
      `${CHARTER_MARKER} NONE
${CHARTER_MARKER} Visual tokens: 
${CHARTER_MARKER} Palette: accent #fff
${CHARTER_MARKER} visual tokens: valid
`,
    );
    expect(r).toEqual([{ section: "Visual tokens", content: "valid" }]);
  });

  it("de-duplicates repeated (section, content) pairs", () => {
    const r = parseCharterRevisions(
      `${CHARTER_MARKER} Chrome rules: one recipe
${CHARTER_MARKER} Chrome rules: one recipe`,
    );
    expect(r).toHaveLength(1);
  });
});

const DOC = `### Visual tokens
old tokens

### Layout model
old layout

### Chrome rules
old chrome
`;

describe("applyCharterRevisionsToText (issue #99)", () => {
  it("replaces a named section's content in place and leaves other sections untouched", () => {
    const out = applyCharterRevisionsToText(DOC, [{ section: "Layout model", content: "canvas center, rails either side" }]);
    expect(out).toContain("### Visual tokens\nold tokens");
    expect(out).toContain("### Layout model\ncanvas center, rails either side");
    expect(out).not.toContain("old layout");
    expect(out).toContain("### Chrome rules\nold chrome");
  });

  it("creates a missing section at the end (append-by-section)", () => {
    const out = applyCharterRevisionsToText(null, [{ section: "Chrome rules", content: "the one toolbar recipe" }]);
    expect(out).toBe("### Chrome rules\nthe one toolbar recipe\n");
  });

  it("appends a newly revised section to a doc that has no sections yet", () => {
    const out = applyCharterRevisionsToText("# Coherence contract\n", [
      { section: "Visual tokens", content: "TOKENS from src/theme" },
      { section: "Layout model", content: "1280x800 no scroll" },
    ]);
    expect(out).toContain("### Visual tokens\nTOKENS from src/theme");
    expect(out).toContain("### Layout model\n1280x800 no scroll");
  });

  it("preserves an H1 title line above the sections", () => {
    const out = applyCharterRevisionsToText("# Coherence contract\n\n### Visual tokens\nold\n", [
      { section: "Visual tokens", content: "new tokens" },
    ]);
    expect(out.startsWith("# Coherence contract")).toBe(true);
    expect(out).toContain("### Visual tokens\nnew tokens");
  });

  it("returns the input unchanged (normalized) when there is nothing to apply", () => {
    const out = applyCharterRevisionsToText(DOC, []);
    expect(out).toBe(DOC.trim() + "\n");
  });

  it("replaces a duplicated section heading at most once — lossy planner output must not double the revision", () => {
    const doc = "### Visual tokens\nold-a\n\n### Visual tokens\nold-b\n\n### Chrome rules\nkeep";
    const out = applyCharterRevisionsToText(doc, [{ section: "Visual tokens", content: "new tokens" }]);
    expect(out.match(/^### Visual tokens$/gm)?.length).toBe(1);
    expect(out).toContain("### Visual tokens\nnew tokens");
    expect(out).not.toContain("old-a");
    expect(out).not.toContain("old-b");
    expect(out).toContain("### Chrome rules\nkeep");
  });
});

describe("applyCharterRevisions (issue #99) — file round-trip", () => {
  it("writes the revision to docs/coherence.md on disk and reports it applied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "charter-"));
    await initGit(cwd);
    await ensureInitialCommit(cwd);
    const wrote = await applyCharterRevisions(cwd, [
      { section: "Visual tokens", content: "accent #00FF99 from src/ui/tokens" },
    ]);
    expect(wrote).toBe(true);
    const onDisk = await readFile(join(cwd, CHARTER_DOC), "utf8");
    expect(onDisk).toContain("### Visual tokens\naccent #00FF99 from src/ui/tokens");
  });

  it("returns false (no write) when no revisions are supplied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "charter-"));
    await initGit(cwd);
    await ensureInitialCommit(cwd);
    const wrote = await applyCharterRevisions(cwd, []);
    expect(wrote).toBe(false);
  });

  it("is idempotent: re-applying the identical revision does not rewrite the file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "charter-"));
    await initGit(cwd);
    await ensureInitialCommit(cwd);
    const rev: CharterRevision[] = [{ section: "Layout model", content: "single rail, top toolbar" }];
    await applyCharterRevisions(cwd, rev);
    const wrote = await applyCharterRevisions(cwd, rev);
    expect(wrote).toBe(false);
  });
});
