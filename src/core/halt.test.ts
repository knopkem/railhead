import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { haltFilePath, haltReason, resumeRefusal, HALT_DIR, HALT_FILE_NAME } from "./halt.ts";
import { RAILHEAD_IGNORES } from "./project-assets.ts";

describe("haltFilePath", () => {
  it("resolves .railhead/STOP under the project cwd", () => {
    expect(haltFilePath("/repo")).toBe(join("/repo", HALT_DIR, HALT_FILE_NAME));
  });

  it("lives under .railhead/, which RAILHEAD_IGNORES already covers (git-ignored, never committed)", () => {
    expect(RAILHEAD_IGNORES).toContain(".railhead/");
    expect(haltFilePath("/repo").startsWith(join("/repo", HALT_DIR) + "/")).toBe(true);
  });
});

describe("haltReason", () => {
  it("returns null when no halt file exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "halt-"));
    expect(haltReason(cwd)).toBeNull();
  });

  it("returns the trimmed file contents when present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "halt-"));
    await mkdir(join(cwd, HALT_DIR), { recursive: true });
    await writeFile(haltFilePath(cwd), "  the plan is wrong\n", "utf8");
    expect(haltReason(cwd)).toBe("the plan is wrong");
  });

  it("substitutes a placeholder for an empty halt file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "halt-"));
    await mkdir(join(cwd, HALT_DIR), { recursive: true });
    await writeFile(haltFilePath(cwd), "   \n", "utf8");
    expect(haltReason(cwd)).toBe("(no reason given)");
  });

  it("never throws when the file vanishes mid-read (a clean 'no halt')", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "halt-"));
    await mkdir(join(cwd, HALT_DIR), { recursive: true });
    await writeFile(haltFilePath(cwd), "x", "utf8");
    await rm(haltFilePath(cwd), { force: true });
    expect(() => haltReason(cwd)).not.toThrow();
    expect(haltReason(cwd)).toBeNull();
  });
});

describe("resumeRefusal", () => {
  it("returns null when there is no halt file to acknowledge", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "halt-"));
    expect(resumeRefusal(cwd)).toBeNull();
  });

  it("returns the path + reason when the halt file is present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "halt-"));
    await mkdir(join(cwd, HALT_DIR), { recursive: true });
    await writeFile(haltFilePath(cwd), "needs a human", "utf8");
    expect(resumeRefusal(cwd)).toEqual({ path: haltFilePath(cwd), reason: "needs a human" });
  });
});
