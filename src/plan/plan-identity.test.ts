import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPlanOrigin, writePlanOrigin, readPlanOrigin, readPlanWallMs, type PlanOrigin } from "./plan-identity.ts";

describe("checkPlanOrigin (#47)", () => {
  const mkOrigin = (over: Partial<PlanOrigin> = {}): PlanOrigin => ({
    slug: "my-plan",
    prompt: "build a thing",
    created_at: "2026-08-31T12:00:00Z",
    ticket_files: ["01-a.md", "02-b.md", "03-c.md"],
    ...over,
  });

  it("returns no warnings when ticket files match the origin exactly", () => {
    const origin = mkOrigin();
    const current = ["01-a.md", "02-b.md", "03-c.md"];
    expect(checkPlanOrigin(origin, current)).toEqual([]);
  });

  it("warns when a ticket file was added since the plan was written", () => {
    const origin = mkOrigin({ ticket_files: ["01-a.md", "02-b.md"] });
    const current = ["01-a.md", "02-b.md", "03-unexpected.md"];
    const warnings = checkPlanOrigin(origin, current);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/unexpected|added|not in.*plan/i);
    expect(warnings[0]).toContain("03-unexpected.md");
  });

  it("warns when a ticket file from the plan is missing on disk", () => {
    const origin = mkOrigin({ ticket_files: ["01-a.md", "02-b.md", "03-c.md"] });
    const current = ["01-a.md", "02-b.md"];
    const warnings = checkPlanOrigin(origin, current);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/missing|gone|not found/i);
    expect(warnings[0]).toContain("03-c.md");
  });

  it("warns for both additions and removals at the same time", () => {
    const origin = mkOrigin({ ticket_files: ["01-a.md", "02-b.md"] });
    const current = ["01-a.md", "03-c.md"];
    const warnings = checkPlanOrigin(origin, current);
    expect(warnings.length).toBe(2);
  });

  it("does not warn when ticket files are reordered", () => {
    const origin = mkOrigin({ ticket_files: ["01-a.md", "02-b.md", "03-c.md"] });
    const current = ["03-c.md", "01-a.md", "02-b.md"];
    expect(checkPlanOrigin(origin, current)).toEqual([]);
  });

  it("returns a 'no origin' warning when origin is null (resume without identity file)", () => {
    const warnings = checkPlanOrigin(null, ["01-a.md"]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/no.*origin|identity.*not found/i);
  });

  it("does not warn on an empty ticket set matching an empty origin", () => {
    const origin = mkOrigin({ ticket_files: [] });
    expect(checkPlanOrigin(origin, [])).toEqual([]);
  });

  it("does not crash on an empty current set when origin expects tickets", () => {
    const origin = mkOrigin({ ticket_files: ["01-a.md"] });
    const warnings = checkPlanOrigin(origin, []);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("01-a.md");
  });
});

describe("writePlanOrigin / readPlanOrigin (#47)", () => {
  it("round-trips the origin file through write → read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "railhead-origin-"));
    try {
      const origin: PlanOrigin = {
        slug: "test-plan",
        prompt: "build something",
        created_at: "2026-08-31T12:00:00Z",
        ticket_files: ["01-a.md", "02-b.md"],
      };
      await writePlanOrigin(dir, origin);
      const written = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "origin.json"), "utf8"));
      expect(written.slug).toBe("test-plan");
      expect(written.ticket_files).toEqual(["01-a.md", "02-b.md"]);

      const readBack = await readPlanOrigin(dir);
      expect(readBack).not.toBeNull();
      expect(readBack!.slug).toBe("test-plan");
      expect(readBack!.ticket_files).toEqual(["01-a.md", "02-b.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("readPlanOrigin returns null when no origin.json exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "railhead-origin-"));
    try {
      const result = await readPlanOrigin(dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("readPlanOrigin throws on a corrupt (non-JSON) origin file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "railhead-origin-"));
    try {
      await writeFile(join(dir, "origin.json"), "not valid json {{{", "utf8");
      await expect(readPlanOrigin(dir)).rejects.toThrow(/not valid JSON/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("readPlanOrigin throws on a JSON file missing required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "railhead-origin-"));
    try {
      await writeFile(join(dir, "origin.json"), JSON.stringify({ slug: "test" }), "utf8");
      await expect(readPlanOrigin(dir)).rejects.toThrow(/missing required fields/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readPlanWallMs (ADR 0040)", () => {
  it("measures the span of plan-phase event timestamps across plan*.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-wall-"));
    try {
      const events = join(dir, "events");
      await mkdtemp(join(tmpdir(), "unused-")); // noop to keep tmp usage symmetrical
      const { mkdir } = await import("node:fs/promises");
      await mkdir(events, { recursive: true });
      await writeFile(join(events, "plan.jsonl"), [
        JSON.stringify({ type: "step_start", timestamp: 1000000000000 }),
        JSON.stringify({ type: "text", timestamp: 1000000000500, part: { text: "x" } }),
      ].join("\n") + "\n", "utf8");
      await writeFile(join(events, "plan-check-1.jsonl"), [
        JSON.stringify({ type: "text", timestamp: 1000000009000, part: { text: "y" } }),
      ].join("\n") + "\n", "utf8");
      // Repair rounds are planner work too; the span includes them.
      await writeFile(join(events, "plan-repair-1.jsonl"), JSON.stringify({ timestamp: 1000000012000 }) + "\n", "utf8");
      expect(readPlanWallMs(dir)).toBe(12000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the ledger is absent or has no parseable timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-wall-empty-"));
    try {
      expect(readPlanWallMs(dir)).toBeNull();
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "events"), { recursive: true });
      await writeFile(join(dir, "events", "plan.jsonl"), "not json\n{}\n", "utf8");
      expect(readPlanWallMs(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
