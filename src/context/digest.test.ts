import { describe, it, expect } from "vitest";
import {
  digestPath,
  readDigest,
  writeDigest,
  appendDigest,
  wouldExceedDigestBudget,
  DIGEST_CHAR_LIMIT,
  buildDigestInjection,
  readDigestMarkers,
  pushDigest,
  DIGEST_MARKER,
} from "./digest.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("digestPath (#50)", () => {
  it("resolves to .railhead/digest.md under cwd", () => {
    expect(digestPath("/project")).toBe(join("/project", ".railhead", "digest.md"));
  });
});

describe("readDigest (#50)", () => {
  it("returns null when no digest file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      expect(await readDigest(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the content when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      await writeDigest(dir, "Architecture decisions taken:\n- Module A built");
      const content = await readDigest(dir);
      expect(content).toBe("Architecture decisions taken:\n- Module A built");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      await writeDigest(dir, "");
      expect(await readDigest(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeDigest / appendDigest round-trip (#50)", () => {
  it("write then read round-trips content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      await writeDigest(dir, "line one\nline two");
      expect(await readDigest(dir)).toBe("line one\nline two");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("append adds to existing content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      await writeDigest(dir, "original");
      await appendDigest(dir, "appended");
      expect(await readDigest(dir)).toBe("original\nappended");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("append creates the file when it does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      await appendDigest(dir, "first entry");
      expect(await readDigest(dir)).toBe("first entry");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("wouldExceedDigestBudget (#50)", () => {
  it("returns false when content fits within budget", () => {
    expect(wouldExceedDigestBudget("short content", 10)).toBe(false);
  });

  it("returns true when content + new chars exceeds limit", () => {
    const big = "x".repeat(DIGEST_CHAR_LIMIT);
    expect(wouldExceedDigestBudget(big, 1)).toBe(true);
  });

  it("returns false when currentContent is null and new chars fit", () => {
    expect(wouldExceedDigestBudget(null, DIGEST_CHAR_LIMIT)).toBe(false);
  });

  it("returns true when currentContent is null but new chars exceed limit", () => {
    expect(wouldExceedDigestBudget(null, DIGEST_CHAR_LIMIT + 1)).toBe(true);
  });
});

describe("buildDigestInjection (#50)", () => {
  it("returns a digest block with the content when digest is provided", () => {
    const block = buildDigestInjection("Current state: module A built, module B pending");
    expect(block).toMatch(/project digest/i);
    expect(block).toContain("module A built, module B pending");
    expect(block).toMatch(/unverified model-claim/i);
  });

  it("returns empty string when digest is null", () => {
    expect(buildDigestInjection(null)).toBe("");
  });

  it("returns empty string when digest is empty", () => {
    expect(buildDigestInjection("")).toBe("");
  });
});

describe("readDigestMarkers (#50)", () => {
  it("returns null when no DIGEST: markers present", () => {
    expect(readDigestMarkers("some text\nno markers here")).toBeNull();
  });

  it("extracts a single DIGEST: marker", () => {
    const transcript = "Some review output\nDIGEST: Module A built with factory pattern\nMore text";
    expect(readDigestMarkers(transcript)).toBe("Module A built with factory pattern");
  });

  it("extracts multiple DIGEST: markers as newline-joined string", () => {
    const transcript = [
      "Review findings here",
      `${DIGEST_MARKER} First architectural note`,
      "Some other text",
      `${DIGEST_MARKER} Second architectural note`,
    ].join("\n");
    expect(readDigestMarkers(transcript)).toBe("First architectural note\nSecond architectural note");
  });

  it("skips DIGEST: NONE", () => {
    expect(readDigestMarkers(`${DIGEST_MARKER} NONE`)).toBeNull();
  });

  it("skips DIGEST: with empty content", () => {
    expect(readDigestMarkers(`${DIGEST_MARKER} `)).toBeNull();
  });

  it("deduplicates identical DIGEST: lines", () => {
    const transcript = [
      `${DIGEST_MARKER} Same note`,
      `${DIGEST_MARKER} Same note`,
    ].join("\n");
    expect(readDigestMarkers(transcript)).toBe("Same note");
  });

  it("handles markers with leading/trailing whitespace", () => {
    const transcript = `  ${DIGEST_MARKER}   trimmed note  `;
    expect(readDigestMarkers(transcript)).toBe("trimmed note");
  });

  it("handles markers embedded mid-line (not matched)", () => {
    const transcript = `text ${DIGEST_MARKER} not at start of line`;
    expect(readDigestMarkers(transcript)).toBeNull();
  });
});

describe("pushDigest (#50)", () => {
  it("appends new digest markers from transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      const transcript = `Review output\n${DIGEST_MARKER} Module A uses factory pattern`;
      await pushDigest(dir, transcript, "group-1");
      expect(await readDigest(dir)).toBe("Module A uses factory pattern");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends to existing digest content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      await writeDigest(dir, "Original entry");
      const transcript = `${DIGEST_MARKER} New entry`;
      await pushDigest(dir, transcript, "group-2");
      expect(await readDigest(dir)).toBe("Original entry\nNew entry");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing when no DIGEST: markers in transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      await writeDigest(dir, "existing");
      await pushDigest(dir, "no markers here", "group-3");
      expect(await readDigest(dir)).toBe("existing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("truncates to budget when overflow would happen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "digest-"));
    try {
      const big = "x".repeat(DIGEST_CHAR_LIMIT);
      await writeDigest(dir, big);
      const newEntry = "y".repeat(100);
      const transcript = `${DIGEST_MARKER} ${newEntry}`;
      await pushDigest(dir, transcript, "group-4");
      const result = await readDigest(dir);
      expect(result!.length).toBeLessThanOrEqual(DIGEST_CHAR_LIMIT);
      expect(result).toContain(newEntry);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
