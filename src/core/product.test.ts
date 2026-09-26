import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  nextArcAction,
  parseProductPlan,
  renderProductPlan,
  renderProductBrief,
  setStepStatus,
  readProductPlan,
  PRODUCT_DOC,
  type ProductPlan,
} from "./product.ts";

const DOC = `# Trail Tracker

## Vision
A hiking log the family actually opens. It must work with gloves on.

## Workflows
Plan a hike, record it after, browse past hikes on a map.

## Traits
Fast offline; no accounts; photos stay local.

## Stack
Plain HTML+JS, no framework.

## Roadmap

### 1 — Rough MVP shell

**Status:** done

The first demoable slice: one trail, one map.

### 2 — Search and filters

**Status:** built

**Run:** 20260926-abc

Search trails by name and tag.

### 3 — Shared albums

**Status:** todo

Albums shared to a link with comments.
`;

function planFixture(steps: ProductPlan["steps"]): ProductPlan {
  return {
    name: "Trail Tracker",
    vision: "A hiking log the family actually opens. It must work with gloves on.",
    workflows: "Plan a hike, record it after, browse past hikes on a map.",
    traits: "Fast offline; no accounts; photos stay local.",
    stack: "Plain HTML+JS, no framework.",
    steps,
  };
}

describe("parseProductPlan", () => {
  it("reads the arc: name, prose sections, steps in document order", () => {
    const { plan, warnings } = parseProductPlan(DOC);
    expect(warnings).toEqual([]);
    expect(plan.name).toBe("Trail Tracker");
    expect(plan.vision).toBe("A hiking log the family actually opens. It must work with gloves on.");
    expect(plan.workflows).toContain("Plan a hike");
    expect(plan.traits).toContain("no accounts");
    expect(plan.stack).toContain("no framework");
    expect(plan.steps.map((s) => [s.number, s.title, s.status, s.description])).toEqual([
      [1, "Rough MVP shell", "done", "The first demoable slice: one trail, one map."],
      [2, "Search and filters", "built", "Search trails by name and tag."],
      [3, "Shared albums", "todo", "Albums shared to a link with comments."],
    ]);
    expect(plan.steps[1].runId).toBe("20260926-abc");
    expect(plan.steps[0].runId).toBeNull();
  });

  it("round-trips through render with identical typed values", () => {
    const first = parseProductPlan(DOC);
    const second = parseProductPlan(renderProductPlan(first.plan));
    expect(second).toEqual(first);
  });

  it("treats a missing status as todo and warns; unknown statuses fall back with a warning", () => {
    const raw = DOC.replace("**Status:** done\n", "").replace("**Status:** built\n", "**Status:** maybe\n");
    const { plan, warnings } = parseProductPlan(raw);
    expect(plan.steps[0].status).toBe("todo");
    expect(plan.steps[1].status).toBe("todo");
    expect(warnings.join("\n")).toMatch(/step 1/i);
    expect(warnings.join("\n")).toMatch(/step 2.*maybe/i);
  });

  it("ignores step headings and status markers inside fences", () => {
    const raw = `# Fenced arc

## Roadmap

### 1 — Panel

**Status:** todo

The panel is a Markdown table generator:

\`\`\`
### 9 — Ghost
**Status:** done
\`\`\`

Render the table.

### 2 — Real next

**Status:** todo

Follows the panel.
`;
    const { plan, warnings } = parseProductPlan(raw);
    expect(plan.steps.map((s) => s.title)).toEqual(["Panel", "Real next"]);
    expect(plan.steps[0].status).toBe("todo");
    expect(plan.steps[0].description).toContain("### 9 — Ghost");
    expect(plan.steps[0].description).toContain("Render the table.");
    expect(warnings).toEqual([]);
  });

  it("keeps hand-set Run and Feedback values and missing prose sections degrade to empty strings", () => {
    const raw = `# Minimal

## Roadmap

### 2 — Only step

**Status:** built

**Run:** run-42

**Feedback:** The filter resets on reload.\nCheck it after the rebuild.
`;
    const { plan, warnings } = parseProductPlan(raw);
    expect(plan.vision).toBe("");
    expect(plan.steps[0].runId).toBe("run-42");
    expect(plan.steps[0].feedback).toContain("resets on reload");
    expect(plan.steps[0].feedback).toContain("after the rebuild");
    expect(warnings).toEqual([]);
  });
});

describe("nextArcAction — the strict frontier (ADR 0051)", () => {
  it("a built-but-unverified step blocks the frontier: the action is verify, not the next todo", () => {
    const { plan } = parseProductPlan(DOC);
    const action = nextArcAction(plan);
    expect(action.kind).toBe("verify");
    if (action.kind === "verify") expect(action.step.number).toBe(2);
  });

  it("the first todo is eligible to build once every earlier step is done", () => {
    const { plan } = parseProductPlan(DOC);
    plan.steps[1].status = "done";
    const action = nextArcAction(plan);
    expect(action.kind).toBe("build");
    if (action.kind === "build") expect(action.step.number).toBe(3);
  });

  it("every step done means the arc needs a new step", () => {
    const { plan } = parseProductPlan(DOC);
    plan.steps.forEach((s) => (s.status = "done"));
    expect(nextArcAction(plan)).toEqual({ kind: "extend" });
  });
});

describe("renderProductBrief", () => {
  it("carries the decided prose sections and never the roadmap", () => {
    const { plan } = parseProductPlan(DOC);
    const brief = renderProductBrief(plan);
    expect(brief).toContain("## Vision\nA hiking log");
    expect(brief).toContain("## Stack\nPlain HTML+JS, no framework.");
    expect(brief).not.toContain("Roadmap");
    expect(brief).not.toContain("Shared albums");
  });

  it("drops empty sections instead of leaving skeletal headings", () => {
    const { plan } = parseProductPlan("# Minimal\n\n## Roadmap\n");
    expect(renderProductBrief(plan)).toBe("");
  });
});

describe("setStepStatus", () => {
  async function docDir(doc: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "product-"));
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, PRODUCT_DOC), doc, "utf8");
    return dir;
  }

  it("marks a step built and records the run id", async () => {
    const dir = await docDir(DOC);
    const plan = await setStepStatus(dir, 3, { status: "built", runId: "run-777" });
    expect(plan.steps[2].status).toBe("built");
    expect(plan.steps[2].runId).toBe("run-777");
    expect(plan.steps[1].runId).toBe("20260926-abc");
  });

  it("reopens a step to todo with human feedback and drops the stale run id", async () => {
    const dir = await docDir(DOC);
    const plan = await setStepStatus(dir, 2, { status: "todo", runId: null, feedback: "The search drops trailing spaces.\nFix the query builder." });
    expect(plan.steps[1].status).toBe("todo");
    expect(plan.steps[1].runId).toBeNull();
    expect(plan.steps[1].feedback).toContain("trailing spaces");
    expect(plan.steps[1].feedback).toContain("Fix the query builder.");
  });

  it("keeps prose (including fences) byte-identical when only status lines change", async () => {
    const raw = `# Kept

## Roadmap

### 1 — Crafted step

**Status:** todo

Keep this exact sentence.

\`\`\`
repro: npx pixel --judge
\`\`\`

And this trailing hand note.
`;
    const dir = await docDir(raw);
    await setStepStatus(dir, 1, { status: "done" });
    const after = await readFile(join(dir, PRODUCT_DOC), "utf8");
    expect(after).toContain("Keep this exact sentence.");
    expect(after).toContain("```\nrepro: npx pixel --judge\n```");
    expect(after).toContain("And this trailing hand note.");
    const { plan } = parseProductPlan(after);
    expect(plan.steps[0].status).toBe("done");
  });

  it("throws with the step number when the step does not exist", async () => {
    const dir = await docDir(DOC);
    await expect(setStepStatus(dir, 7, { status: "done" })).rejects.toThrow(/step 7/i);
  });

  it("throws with the doc path when no product arc exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "product-empty-"));
    await expect(setStepStatus(dir, 1, { status: "done" })).rejects.toThrow(PRODUCT_DOC);
  });

  it("readProductPlan returns null for a missing arc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "product-empty2-"));
    expect(await readProductPlan(dir)).toBeNull();
  });
});

