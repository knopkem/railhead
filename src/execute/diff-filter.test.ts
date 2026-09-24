import { describe, it, expect } from "vitest";
import { stripNonSource, estimateTokens, isNonSourceFile, NESTED_REVIEW_SUFFIX } from "./diff-filter.ts";
import { RAILHEAD_REVIEW_READMODE_AGENT } from "../core/project-assets.ts";

describe("isNonSourceFile", () => {
  it("flags lock files", () => {
    expect(isNonSourceFile("package-lock.json")).toBe(true);
    expect(isNonSourceFile("yarn.lock")).toBe(true);
    expect(isNonSourceFile("pnpm-lock.yaml")).toBe(true);
    expect(isNonSourceFile("Cargo.lock")).toBe(true);
    expect(isNonSourceFile("go.sum")).toBe(true);
    expect(isNonSourceFile("composer.lock")).toBe(true);
    expect(isNonSourceFile("Gemfile.lock")).toBe(true);
  });

  it("flags binary files", () => {
    expect(isNonSourceFile("assets/player.png")).toBe(true);
    expect(isNonSourceFile("assets/screenshot.jpg")).toBe(true);
    expect(isNonSourceFile("assets/sprite.gif")).toBe(true);
    expect(isNonSourceFile("assets/model.glb")).toBe(true);
    expect(isNonSourceFile("fonts/inter.woff2")).toBe(true);
    expect(isNonSourceFile("fonts/inter.ttf")).toBe(true);
    expect(isNonSourceFile("favicon.ico")).toBe(true);
    expect(isNonSourceFile("data/level.bin")).toBe(true);
  });

  it("flags generated directories", () => {
    expect(isNonSourceFile("node_modules/react/index.js")).toBe(true);
    expect(isNonSourceFile("dist/bundle.js")).toBe(true);
    expect(isNonSourceFile("build/lib.rs")).toBe(true);
    expect(isNonSourceFile(".playwright-mcp/session.json")).toBe(true);
    expect(isNonSourceFile(".railhead/run-01/state.json")).toBe(true);
  });

  it("does NOT flag source files", () => {
    expect(isNonSourceFile("src/index.ts")).toBe(false);
    expect(isNonSourceFile("src/main.rs")).toBe(false);
    expect(isNonSourceFile("src/app.py")).toBe(false);
    expect(isNonSourceFile("main.go")).toBe(false);
    expect(isNonSourceFile("src/utils.jsx")).toBe(false);
    expect(isNonSourceFile("README.md")).toBe(false);
    expect(isNonSourceFile("package.json")).toBe(false);
    expect(isNonSourceFile("Cargo.toml")).toBe(false);
    expect(isNonSourceFile(".gitignore")).toBe(false);
  });

  it("handles paths with dots in directory names", () => {
    expect(isNonSourceFile("my.app/src/index.ts")).toBe(false);
    expect(isNonSourceFile("my.app/assets/icon.png")).toBe(true);
  });
});

describe("stripNonSource", () => {
  const TS_DIFF = `diff --git a/src/index.ts b/src/index.ts
new file mode 100644
index 0000000..deadbeef
--- /dev/null
+++ b/src/index.ts
@@ -0,0 +1,3 @@
+export function greet(name: string): string {
+  return \`hi \${name}\`;
+}`;

  const LOCK_DIFF = `diff --git a/package-lock.json b/package-lock.json
new file mode 100644
index 0000000..cafebabe
--- /dev/null
+++ b/package-lock.json
@@ -0,0 +1,5 @@
+{
+  "name": "test",
+  "lockfileVersion": 3,
+  "packages": {}
+}`;

  const BINARY_DIFF = `diff --git a/assets/player.png b/assets/player.png
new file mode 100644
index 0000000..feedface
Binary files differ`;

  it("removes lock file diffs, keeps source diffs", () => {
    const diff = `${LOCK_DIFF}\n${TS_DIFF}`;
    const filtered = stripNonSource(diff);
    expect(filtered).toContain("src/index.ts");
    expect(filtered).not.toContain("package-lock.json");
  });

  it("removes binary file diffs, keeps source diffs", () => {
    const diff = `${BINARY_DIFF}\n${TS_DIFF}`;
    const filtered = stripNonSource(diff);
    expect(filtered).toContain("src/index.ts");
    expect(filtered).not.toContain("player.png");
  });

  it("removes generated directory diffs", () => {
    const nodeModulesDiff = `diff --git a/node_modules/react/index.js b/node_modules/react/index.js
new file mode 100644
index 0000000..abcdef
--- /dev/null
+++ b/node_modules/react/index.js
@@ -0,0 +1 @@
+module.exports = {};`;
    const diff = `${nodeModulesDiff}\n${TS_DIFF}`;
    const filtered = stripNonSource(diff);
    expect(filtered).toContain("src/index.ts");
    expect(filtered).not.toContain("node_modules/react/index.js");
  });

  it("returns the diff unchanged when it is all source files", () => {
    expect(stripNonSource(TS_DIFF)).toBe(TS_DIFF);
  });

  it("returns the diff unchanged when there are no non-source files", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+export const x = 1;`;
    expect(stripNonSource(diff)).toBe(diff);
  });

  it("returns empty string when the diff is entirely non-source", () => {
    expect(stripNonSource(LOCK_DIFF)).toBe("");
  });

  it("returns empty string for an empty diff", () => {
    expect(stripNonSource("")).toBe("");
  });

  it("handles a diff with only non-source files", () => {
    const diff = `${LOCK_DIFF}\n${BINARY_DIFF}`;
    expect(stripNonSource(diff)).toBe("");
  });

  it("preserves diff content for a file whose path contains 'png' but is not a png file", () => {
    const diff = `diff --git a/src/png-decoder.ts b/src/png-decoder.ts
new file mode 100644
--- /dev/null
+++ b/src/png-decoder.ts
@@ -0,0 +1 @@
+export function decodePng() {}`;
    const filtered = stripNonSource(diff);
    expect(filtered).toContain("png-decoder.ts");
  });

  it("handles multi-hunk diffs for a single non-source file", () => {
    const multiHunkLock = `diff --git a/Cargo.lock b/Cargo.lock
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1,3 +1,3 @@
-version = 3
+version = 4
@@ -10,1 +10,1 @@
-name = "serde"
+name = "serde_json"`;
    const filtered = stripNonSource(multiHunkLock);
    expect(filtered).toBe("");
  });
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token for ASCII text", () => {
    const text = "a".repeat(4000);
    const tokens = estimateTokens(text);
    expect(tokens).toBe(1000);
  });

  it("estimates ~1 char per token for CJK/multi-byte text", () => {
    const text = "你".repeat(1000);
    const tokens = estimateTokens(text);
    expect(tokens).toBe(1000);
  });

  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is monotonic — longer text estimates more tokens", () => {
    const short = "hello world";
    const long = "hello world".repeat(100);
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });

  it("handles mixed ASCII and multi-byte content", () => {
    const mixed = "hello 你好 world 世界".repeat(100);
    const tokens = estimateTokens(mixed);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("RAILHEAD_REVIEW_READMODE_AGENT", () => {
  it("allows read but denies all other tools", () => {
    const permission = RAILHEAD_REVIEW_READMODE_AGENT.permission!;
    // One catch-all deny covers every other tool family (built-in and MCP);
    // read is re-allowed after it because opencode's last matching rule wins.
    expect(permission["*"]).toBe("deny");
    expect(permission.read).toEqual({ "*": "allow", "mcp:*": "deny" });
    expect(permission.edit).toBeUndefined();
    expect(permission.write).toBeUndefined();
    expect(permission.bash).toBeUndefined();
    expect(permission.glob).toBeUndefined();
    expect(permission.grep).toBeUndefined();
    expect(permission.task).toBeUndefined();
    expect(permission.skill).toBeUndefined();
  });

  it("describes read-only file access (not zero-tool like diff mode)", () => {
    expect(RAILHEAD_REVIEW_READMODE_AGENT.description).toMatch(/read.*file/i);
  });
});

describe("NESTED_REVIEW_SUFFIX", () => {
  it("is the review-phase suffix for nested read-mode reviews", () => {
    expect(NESTED_REVIEW_SUFFIX).toBe("-review");
  });
});
