import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { regexExtractContracts, filesWithNoEntries, splitFilePath } from "./contract-extract.ts";
import type { ContractEntry } from "../core/contracts.ts";

async function freshCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "contract-extract-"));
}

function readSourceFile(cwd: string, file: string): Promise<ContractEntry[]> {
  return regexExtractContracts(cwd, [file]).then((r) => r.filter((e) => e.file === file));
}

describe("splitFilePath", () => {
  it("splits a file path into name and extension", () => {
    expect(splitFilePath("src/index.ts")).toEqual(["src/index", ".ts"]);
  });

  it("handles paths with dots in directory names", () => {
    expect(splitFilePath("my.app/src/util.tsx")).toEqual(["my.app/src/util", ".tsx"]);
  });

  it("returns the full name when there is no extension", () => {
    expect(splitFilePath("Makefile")).toEqual(["Makefile", ""]);
  });
});

describe("regexExtractContracts — TypeScript/JavaScript", () => {
  it("extracts export function", async () => {
    const cwd = await freshCwd();
    const file = "src/index.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export function greet(name: string): string { return name; }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "greet",
      kind: "function",
      file: "src/index.ts",
      signature: "export function greet(name: string): string { return name; }",
    });
  });

  it("extracts export async function", async () => {
    const cwd = await freshCwd();
    const file = "src/api.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export async function fetchData(url: string): Promise<void> { /* ... */ }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "fetchData",
      kind: "function",
    });
    expect(entries[0].signature).toContain("export async function fetchData(url: string): Promise<void>");
  });

  it("extracts export const", async () => {
    const cwd = await freshCwd();
    const file = "src/config.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), 'export const MAX_RETRIES = 5;\n', "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "MAX_RETRIES",
      kind: "constant",
    });
  });

  it("extracts export class", async () => {
    const cwd = await freshCwd();
    const file = "src/player.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export class Player { constructor(public name: string) {} }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "Player",
      kind: "class",
    });
  });

  it("extracts export interface", async () => {
    const cwd = await freshCwd();
    const file = "src/types.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export interface PlayerStats { health: number; mana: number; }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "PlayerStats",
      kind: "type",
    });
  });

  it("extracts export type", async () => {
    const cwd = await freshCwd();
    const file = "src/types.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export type Status = 'alive' | 'dead';\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "Status",
      kind: "type",
    });
  });

  it("extracts export default function — symbol is 'default'", async () => {
    const cwd = await freshCwd();
    const file = "src/index.tsx";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export default function App() { return null; }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "default",
      kind: "function",
    });
  });

  it("extracts multiple exports in one file", async () => {
    const cwd = await freshCwd();
    const file = "src/utils.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, file),
      [
        'export const PI = 3.14;',
        "export function area(r: number): number { return PI * r * r; }",
        "export class Circle { constructor(public r: number) {} }",
        "export type Shape = 'circle' | 'square';",
      ].join("\n") + "\n",
      "utf8",
    );

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(4);
    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toEqual(["PI", "area", "Circle", "Shape"]);
  });

  it("handles re-exports: export { foo } from './bar' — file is the re-exporting file", async () => {
    const cwd = await freshCwd();
    const file = "src/index.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), 'export { greet, farewell } from "./greet.js";\n', "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toContain("greet");
    expect(symbols).toContain("farewell");
    expect(entries.every((e) => e.file === file)).toBe(true);
  });

  it("handles export * from re-export — no contract entries for wildcard re-exports", async () => {
    const cwd = await freshCwd();
    const file = "src/index.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), 'export * from "./module.js";\n', "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(0);
  });

  it("does not extract non-exported functions", async () => {
    const cwd = await freshCwd();
    const file = "src/internal.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "function helper() { return 42; }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(0);
  });

  it("works with .tsx files", async () => {
    const cwd = await freshCwd();
    const file = "src/App.tsx";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export const App = () => <div />;\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "App", kind: "constant" });
  });

  it("works with .jsx files", async () => {
    const cwd = await freshCwd();
    const file = "src/Button.jsx";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export function Button({ label }) { return null; }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "Button", kind: "function" });
  });

  it("works with .js files", async () => {
    const cwd = await freshCwd();
    const file = "src/index.js";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export function greet(name) { return `hi ${name}`; }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "greet", kind: "function" });
  });

  it("works with .mjs files", async () => {
    const cwd = await freshCwd();
    const file = "src/index.mjs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export const VERSION = '1.0';\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "VERSION", kind: "constant" });
  });
});

describe("regexExtractContracts — Rust", () => {
  it("extracts pub fn", async () => {
    const cwd = await freshCwd();
    const file = "src/lib.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub fn greet(name: &str) -> String { format!(\"hi {}\", name) }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "greet",
      kind: "function",
    });
    expect(entries[0].signature).toContain("pub fn greet(name: &str) -> String");
  });

  it("extracts pub async fn", async () => {
    const cwd = await freshCwd();
    const file = "src/api.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub async fn fetch_data(url: &str) -> Result<(), Error> { /* ... */ }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "fetch_data", kind: "function" });
  });

  it("extracts pub struct", async () => {
    const cwd = await freshCwd();
    const file = "src/types.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub struct Player { pub name: String, pub health: i32, }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "Player", kind: "class" });
  });

  it("extracts pub enum", async () => {
    const cwd = await freshCwd();
    const file = "src/types.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub enum Status { Alive, Dead }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "Status", kind: "type" });
  });

  it("extracts pub trait", async () => {
    const cwd = await freshCwd();
    const file = "src/traits.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub trait Greetable { fn greet(&self) -> String; }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "Greetable", kind: "type" });
  });

  it("extracts pub const and pub type", async () => {
    const cwd = await freshCwd();
    const file = "src/constants.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, file),
      [
        "pub const MAX_RETRIES: u32 = 5;",
        "pub type Result<T> = std::result::Result<T, Error>;",
      ].join("\n") + "\n",
      "utf8",
    );

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(2);
    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toEqual(["MAX_RETRIES", "Result"]);
    expect(entries[0]).toMatchObject({ kind: "constant" });
    expect(entries[1]).toMatchObject({ kind: "type" });
  });

  it("extracts pub const fn (const functions, not constants)", async () => {
    const cwd = await freshCwd();
    const file = "src/lib.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub const fn new() -> Self { Self { x: 0 } }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "new", kind: "function" });
  });

  it("extracts pub unsafe fn", async () => {
    const cwd = await freshCwd();
    const file = "src/lib.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub unsafe fn dangerous() -> u32 { 42 }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "dangerous", kind: "function" });
  });

  it("extracts pub(crate) fn (restricted visibility)", async () => {
    const cwd = await freshCwd();
    const file = "src/lib.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "pub(crate) fn internal() -> u32 { 42 }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbol).toBe("internal");
  });

  it("does not extract non-pub items", async () => {
    const cwd = await freshCwd();
    const file = "src/internal.rs";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "fn internal() {}\nstruct Internal {}\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(0);
  });
});

describe("regexExtractContracts — Python", () => {
  it("extracts top-level def", async () => {
    const cwd = await freshCwd();
    const file = "src/app.py";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "def greet(name: str) -> str:\n    return f'hi {name}'\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "greet",
      kind: "function",
    });
    expect(entries[0].signature).toContain("def greet(name: str) -> str:");
  });

  it("extracts top-level class", async () => {
    const cwd = await freshCwd();
    const file = "src/models.py";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "class Player:\n    def __init__(self, name):\n        self.name = name\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "Player", kind: "class" });
  });

  it("does not extract indented (method-level) defs", async () => {
    const cwd = await freshCwd();
    const file = "src/app.py";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, file),
      [
        "def top_level():",
        "    def nested():",
        "        pass",
        "    nested()",
      ].join("\n") + "\n",
      "utf8",
    );

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbol).toBe("top_level");
  });

  it("extracts async def at top level", async () => {
    const cwd = await freshCwd();
    const file = "src/api.py";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "async def fetch(url: str) -> bytes:\n    return b''\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "fetch", kind: "function" });
    expect(entries[0].signature).toContain("async def fetch(url: str) -> bytes:");
  });
});

describe("regexExtractContracts — Go", () => {
  it("extracts func", async () => {
    const cwd = await freshCwd();
    const file = "main.go";
    await writeFile(join(cwd, file), "func greet(name string) string { return \"hi \" + name }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "greet",
      kind: "function",
    });
    expect(entries[0].signature).toContain("func greet(name string) string");
  });

  it("extracts exported Go func (capitalized)", async () => {
    const cwd = await freshCwd();
    const file = "api.go";
    await writeFile(join(cwd, file), "func FetchData(url string) ([]byte, error) { return nil, nil }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "FetchData", kind: "function" });
  });

  it("extracts method receiver funcs", async () => {
    const cwd = await freshCwd();
    const file = "player.go";
    await writeFile(join(cwd, file), "func (p *Player) Move(dir Direction) { /* ... */ }\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ symbol: "Move", kind: "function" });
  });

  it("extracts type", async () => {
    const cwd = await freshCwd();
    const file = "types.go";
    await writeFile(join(cwd, file), [
      "type Player struct { Name string }",
      "type Direction int",
    ].join("\n") + "\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(2);
    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toEqual(["Player", "Direction"]);
    expect(entries.every((e) => e.kind === "type")).toBe(true);
  });
});

describe("regexExtractContracts — edge cases", () => {
  it("returns [] for an empty file", async () => {
    const cwd = await freshCwd();
    const file = "src/empty.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toEqual([]);
  });

  it("returns [] for a non-source file (.md)", async () => {
    const cwd = await freshCwd();
    const file = "README.md";
    await writeFile(join(cwd, file), "# My Project\nexport function fake() {}\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toEqual([]);
  });

  it("returns [] for a non-source file (.json)", async () => {
    const cwd = await freshCwd();
    const file = "config.json";
    await writeFile(join(cwd, file), '{"export": "not real code"}\n', "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toEqual([]);
  });

  it("returns [] for a non-existent file (does not throw)", async () => {
    const cwd = await freshCwd();
    const entries = await readSourceFile(cwd, "does-not-exist.ts");
    expect(entries).toEqual([]);
  });

  it("handles multiple files in one call", async () => {
    const cwd = await freshCwd();
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "export function a() {}\n", "utf8");
    await writeFile(join(cwd, "src", "b.ts"), 'export const B = 42;\n', "utf8");

    const entries = await regexExtractContracts(cwd, ["src/a.ts", "src/b.ts"]);
    expect(entries).toHaveLength(2);
    const symbols = entries.map((e) => e.symbol);
    expect(symbols).toContain("a");
    expect(symbols).toContain("B");
  });

  it("description is left empty (unused downstream)", async () => {
    const cwd = await freshCwd();
    const file = "src/index.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "export function greet() {}\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries[0].description).toBeUndefined();
  });

  it("handles files with leading whitespace on export lines", async () => {
    const cwd = await freshCwd();
    const file = "src/indented.ts";
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, file), "  export function indented() {}\n", "utf8");

    const entries = await readSourceFile(cwd, file);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbol).toBe("indented");
  });
});

describe("filesWithNoEntries", () => {
  it("lists source files that produced zero entries", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const entries = [
      { symbol: "a", kind: "function", file: "src/a.ts", signature: "x" },
      { symbol: "c", kind: "constant", file: "src/c.ts", signature: "y" },
    ];
    expect(filesWithNoEntries(files, entries)).toEqual(["src/b.ts"]);
  });

  it("returns all source files when entries is empty", () => {
    expect(filesWithNoEntries(["a.ts", "b.ts"], [])).toEqual(["a.ts", "b.ts"]);
  });

  it("returns nothing when all source files have entries", () => {
    const entries = [
      { symbol: "a", kind: "function", file: "a.ts", signature: "x" },
      { symbol: "b", kind: "function", file: "b.ts", signature: "y" },
    ];
    expect(filesWithNoEntries(["a.ts", "b.ts"], entries)).toEqual([]);
  });

  it("does not list non-source files (.gitignore, .md) as unhandled", () => {
    const files = ["src/a.ts", ".gitignore", "README.md"];
    const entries = [
      { symbol: "a", kind: "function", file: "src/a.ts", signature: "x" },
    ];
    expect(filesWithNoEntries(files, entries)).toEqual([]);
  });

  it("does not list non-source files even when no entries exist", () => {
    expect(filesWithNoEntries([".gitignore", "README.md"], [])).toEqual([]);
  });
});
