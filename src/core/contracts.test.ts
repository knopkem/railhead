import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  EMPTY_INDEX,
  extractContractsBlock,
  mergeContracts,
  renderContracts,
  sliceContracts,
  summarizeContracts,
  verifyContractEntries,
  type ContractEntry,
} from "./contracts.ts";

const greet: ContractEntry = {
  symbol: "greet",
  kind: "function",
  file: "src/index.js",
  signature: "greet(name) -> string",
};

describe("mergeContracts", () => {
  it("adds new entries and tags their origin", () => {
    const merged = mergeContracts(EMPTY_INDEX, [greet], "01");
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]).toMatchObject({ symbol: "greet", added_by: "01" });
  });

  it("updates a signature and records changed_by on re-merge", () => {
    const first = mergeContracts(EMPTY_INDEX, [greet], "01");
    const second = mergeContracts(
      first,
      [{ ...greet, signature: "greet(name) -> GREETING" }],
      "02",
    );
    const entry = second.entries.find((e) => e.symbol === "greet")!;
    expect(entry.signature).toBe("greet(name) -> GREETING");
    expect(entry.changed_by).toContain("02");
    expect(entry.added_by).toBe("01");
  });

  it("dedupes repeated changed_by tags", () => {
    const first = mergeContracts(EMPTY_INDEX, [greet], "01");
    const second = mergeContracts(first, [greet], "02");
    const third = mergeContracts(second, [{ ...greet, signature: "x" }], "02");
    const entry = third.entries.find((e) => e.symbol === "greet")!;
    expect((entry.changed_by ?? []).filter((t) => t === "02")).toHaveLength(1);
  });
});

describe("extractContractsBlock", () => {
  it("parses the $CONTRACTS .. $END block", () => {
    const out = extractContractsBlock(
      "summary\n$CONTRACTS\n{\"symbol\":\"a\",\"kind\":\"function\",\"file\":\"f.js\",\"signature\":\"a()\"}\n$END\ntrailing",
      "fallback.js",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "a", file: "f.js" });
  });

  it("skips a malformed object without aborting the rest", () => {
    const out = extractContractsBlock(
      "$CONTRACTS\n{ BROKEN }\n{\"symbol\":\"ok\",\"file\":\"f.js\"}\n$END",
      "fallback.js",
    );
    expect(out.map((e) => e.symbol)).toEqual(["ok"]);
  });

  it("uses fallback file when file is absent", () => {
    const out = extractContractsBlock(
      "$CONTRACTS\n{\"symbol\":\"b\"}\n$END",
      "fallback.js",
    );
    expect(out[0].file).toBe("fallback.js");
  });

  it("returns [] when no symbols appear", () => {
    expect(extractContractsBlock("no contract here", "f.js")).toEqual([]);
  });
});

describe("sliceContracts", () => {
  const idx = mergeContracts(
    EMPTY_INDEX,
    [
      { ...greet },
      { symbol: "deploy", kind: "function", file: "src/deploy.js", signature: "deploy()" },
    ],
    "01",
  );

  it("filters by file", () => {
    const out = sliceContracts(idx, { files: ["src/deploy.js"] });
    expect(out.entries.map((e) => e.symbol)).toEqual(["deploy"]);
  });

  it("filters by symbol", () => {
    const out = sliceContracts(idx, { symbols: ["greet"] });
    expect(out.entries.map((e) => e.symbol)).toEqual(["greet"]);
  });

  it("returns empty when nothing matches", () => {
    expect(sliceContracts(idx, { symbols: ["nope"] }).entries).toEqual([]);
  });
});

describe("summarizeContracts / renderContracts", () => {
  it("renders an empty index as a greenfield note", () => {
    expect(summarizeContracts(EMPTY_INDEX)).toContain("greenfield");
  });

  it("renders a one-line summary", () => {
    const idx = mergeContracts(EMPTY_INDEX, [greet], "01");
    expect(summarizeContracts(idx)).toContain("greet");
    expect(renderContracts(idx)).toContain("src/index.js");
  });
});

describe("verifyContractEntries", () => {
  async function freshCwd(): Promise<string> {
    return mkdtemp(join(tmpdir(), "contracts-verify-"));
  }

  it("verifies an entry whose symbol actually appears in the claimed file", async () => {
    const cwd = await freshCwd();
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "index.js"), "export function greet(name) { return `hi ${name}`; }\n", "utf8");
    const { verified, rejected } = await verifyContractEntries(cwd, [greet]);
    expect(verified).toEqual([greet]);
    expect(rejected).toEqual([]);
  });

  it("rejects a hallucinated entry whose symbol is not in the claimed file", async () => {
    const cwd = await freshCwd();
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "index.js"), "export function greet(name) { return name; }\n", "utf8");
    const fake: ContractEntry = { symbol: "farewell", kind: "function", file: "src/index.js", signature: "farewell()" };
    const { verified, rejected } = await verifyContractEntries(cwd, [greet, fake]);
    expect(verified).toEqual([greet]);
    expect(rejected).toEqual([fake]);
  });

  it("rejects an entry whose claimed file does not exist", async () => {
    const cwd = await freshCwd();
    const ghost: ContractEntry = { symbol: "ghost", kind: "function", file: "src/does-not-exist.js", signature: "ghost()" };
    const { verified, rejected } = await verifyContractEntries(cwd, [ghost]);
    expect(verified).toEqual([]);
    expect(rejected).toEqual([ghost]);
  });

  it("rejects an entry with an empty symbol rather than matching everything", async () => {
    const cwd = await freshCwd();
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "index.js"), "anything at all\n", "utf8");
    const blank: ContractEntry = { symbol: "", kind: "function", file: "src/index.js", signature: "" };
    const { verified, rejected } = await verifyContractEntries(cwd, [blank]);
    expect(verified).toEqual([]);
    expect(rejected).toEqual([blank]);
  });
});