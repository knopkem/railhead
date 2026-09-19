import { describe, it, expect } from "vitest";
import { summarizePermissionRejections } from "./permissions.ts";

const ANSI_YELLOW = "\x1b[93m\x1b[1m";
const RESET = "\x1b[0m";

describe("summarizePermissionRejections", () => {
  it("returns zero summary on an empty stderr", () => {
    const s = summarizePermissionRejections([]);
    expect(s.count).toBe(0);
    expect(s.summary).toBe("");
  });

  it("returns zero when stderr has unrelated lines", () => {
    const s = summarizePermissionRejections([
      "some model output line",
      "warning: deprecation in foo",
    ]);
    expect(s.count).toBe(0);
    expect(s.summary).toBe("");
  });

  it("parses a single rejection line with ANSI escapes", () => {
    const line = `${ANSI_YELLOW}! ${RESET}permission requested: external_directory (/Users/macair/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/termion-4.0.6/src/*); auto-rejecting`;
    const s = summarizePermissionRejections([line]);
    expect(s.count).toBe(1);
    expect(s.distinct).toEqual([
      { kind: "external_directory", path: "/Users/macair/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/termion-4.0.6/src/*" },
    ]);
    expect(s.summary).toContain("external_directory");
    expect(s.summary).toContain("termion-4.0.6");
  });

  it("dedupes repeated rejections of the same path", () => {
    // The actual snake-qwen ledger had this pattern three times in a row —
    // the implementer kept trying the same path. The summary must report 3
    // rejections but only 1 distinct (kind, path) pair.
    const line = `${ANSI_YELLOW}! ${RESET}permission requested: external_directory (/Users/macair/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/termion-4.0.6/src/*); auto-rejecting`;
    const s = summarizePermissionRejections([line, line, line]);
    expect(s.count).toBe(3);
    expect(s.distinct.length).toBe(1);
    expect(s.summary).toContain("permission rejected");
    expect(s.summary).toContain("termion");
  });

  it("distinguishes multiple distinct (kind, path) pairs", () => {
    const lines = [
      `${ANSI_YELLOW}! ${RESET}permission requested: external_directory (/Users/macair/.cargo/registry/src/*); auto-rejecting`,
      `${ANSI_YELLOW}! ${RESET}permission requested: bash_command (cargo); auto-rejecting`,
      `${ANSI_YELLOW}! ${RESET}permission requested: external_directory (/Users/macair/.cargo/registry/src/*); auto-rejecting`,
    ];
    const s = summarizePermissionRejections(lines);
    expect(s.count).toBe(3);
    expect(s.distinct.length).toBe(2);
    expect(s.summary).toContain("3 permission rejections across 2 distinct");
  });
});
