import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readBlockedBy, loadTickets, writeTickets, parseTicket, testPhaseRan } from "./ticket.ts";
import { orderTickets, type PlanTicket } from "../plan/plan.ts";

describe("readBlockedBy", () => {
  it("returns [] when no blocked-by line exists", () => {
    expect(readBlockedBy("# no blockers here")).toEqual([]);
  });

  it("returns [] for an explicit None", () => {
    expect(readBlockedBy("**Blocked by:** None (can start immediately)")).toEqual([]);
  });

  it("normalises a block reference to a ticket file name", () => {
    expect(readBlockedBy("**Blocked by:** 01-favor")).toEqual(["01-favor.md"]);
  });

  it("normalises a bare number ref to a slugless file name", () => {
    expect(readBlockedBy("**Blocked by:** 02")).toEqual(["02.md"]);
  });

  it("parses multiple comma-separated refs in dependency order", () => {
    expect(readBlockedBy("**Blocked by:** 01-greet, 03-parse")).toEqual([
      "01-greet.md",
      "03-parse.md",
    ]);
  });

  it("strips Markdown bold from the reference text", () => {
    expect(readBlockedBy("**Blocked by:** **01-favor**")).toEqual(["01-favor.md"]);
  });
});

describe("write → parse round-trip", () => {
  it("recovers plan tickets written to disk exactly", async () => {
    const plan: PlanTicket[] = [
      {
        title: "Add greet",
        mission: "a greetable CLI",
        what: "export a greet function",
        criteria: ["exports greet", "greet('x') returns a string"],
        blocked_by: [],
        files: ["src/index.js"],
        introduces: ["greet"],
      },
      {
        title: "Use greet",
        mission: "a greetable CLI",
        what: "export message that calls greet",
        criteria: ["exports message"],
        blocked_by: [0],
        files: ["src/index.js"],
        references: ["greet"],
        introduces: ["message"],
      },
    ];

    const ordered = await orderTickets(plan);
    const dir = await mkdtemp(join(tmpdir(), "tkt-"));
    await writeTickets(dir, ordered);

    expect((await readdir(dir)).sort()).toEqual(["01-add-greet.md", "02-use-greet.md"]);

    const loaded = await loadTickets(dir);
    expect(loaded.map((l) => l.number)).toEqual(["01", "02"]);

    const t1 = loaded.find((l) => l.number === "01")!;
    expect(t1).toMatchObject({
      title: "Add greet",
      mission: "a greetable CLI",
      what: "export a greet function",
      files: ["src/index.js"],
      introduces: ["greet"],
      references: [],
    });
    expect(t1.blocked_by).toEqual([]);

    const t2 = loaded.find((l) => l.number === "02")!;
    expect(t2.blocked_by).toEqual(["01-add-greet.md"]);
    expect(t2.references).toEqual(["greet"]);
    expect(t2.criteria).toEqual(["exports message"]);
    expect(t2.mission).toBe("a greetable CLI");
  });

  it("round-trips the open-ended craft marker", async () => {
    const plan: PlanTicket[] = [
      { title: "Art direction", mission: "m", what: "compose the scene", criteria: [], blocked_by: [], open_ended: true, testable: false },
    ];
    const ordered = await orderTickets(plan);
    const dir = await mkdtemp(join(tmpdir(), "tkt-"));
    await writeTickets(dir, ordered);
    const loaded = await loadTickets(dir);
    expect(loaded[0]!.open_ended).toBe(true);
    expect(loaded[0]!.testable).toBe(false);
  });

  it("writeTickets removes stale .md files before writing the new plan", async () => {
    const plan: PlanTicket[] = [
      { title: "New ticket", mission: "m", what: "w", criteria: [], blocked_by: [], files: [], references: [], introduces: [] },
    ];
    const ordered = await orderTickets(plan);
    const dir = await mkdtemp(join(tmpdir(), "tkt-"));
    // Seed the dir with a stale ticket from a previous build/fix run on the same
    // .scratch/<slug>/issues path. Without clearing, the next run picks up both
    // the stale and the new file as separate tickets — the user observed three
    // `01-*` files stacked across three runs.
    await writeFile(join(dir, "01-stale-from-prior-run.md"), "# stale\n", "utf8");
    await writeFile(join(dir, "02-also-stale.md"), "# stale 2\n", "utf8");
    // Non-markdown files (e.g. a README the user dropped in) must be preserved —
    // clearing applies to ticket files only, not arbitrary content.
    await writeFile(join(dir, "README.txt"), "hands off\n", "utf8");

    await writeTickets(dir, ordered);

    const files = (await readdir(dir)).sort();
    expect(files).toContain("01-new-ticket.md");
    expect(files).not.toContain("01-stale-from-prior-run.md");
    expect(files).not.toContain("02-also-stale.md");
    expect(files).toContain("README.txt");
  });
});

describe("parseTicket — fail loud on a malformed ticket", () => {
  // The exact failure class ADR 0007 already hit once for `blocked_by` (a
  // missing-colon heading silently defeated dependency ordering with no
  // error). These guard the same class for a ticket that reaches the parser
  // from outside `writeTickets` — a hand-edited file — where the writer's
  // exact heading shape cannot be assumed.
  async function makeTicketFile(body: string): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "tkt-bad-"));
    const file = "01-broken.md";
    await writeFile(join(dir, file), body, "utf8");
    return { dir, file };
  }

  it("throws when the Blocked-by heading is entirely absent", async () => {
    const { dir, file } = await makeTicketFile(`# 01: A ticket

**What to build:** do the thing

- [ ] it works
`);
    await expect(parseTicket(dir, file)).rejects.toThrow(/blocked by/i);
  });

  it("throws when What-to-build content is empty", async () => {
    const { dir, file } = await makeTicketFile(`# 01: A ticket

**What to build:**

**Blocked by:** None

- [ ] it works
`);
    await expect(parseTicket(dir, file)).rejects.toThrow(/what to build/i);
  });

  it("accepts a well-formed ticket with an explicit None blocked-by", async () => {
    const { dir, file } = await makeTicketFile(`# 01: A ticket

**What to build:** do the thing

**Blocked by:** None

- [ ] it works
`);
    const t = await parseTicket(dir, file);
    expect(t.what).toBe("do the thing");
    expect(t.blocked_by).toEqual([]);
  });

  it("error names the offending file so it is actionable", async () => {
    const { dir, file } = await makeTicketFile("# 01: A ticket\n\nno headings at all\n");
    await expect(parseTicket(dir, file)).rejects.toThrow(/01-broken\.md is malformed/);
  });
});

describe("group field round-trip (#19)", () => {
  it("renders and recovers a group label through write → parse", async () => {
    const plan: PlanTicket[] = [
      {
        title: "Core engine",
        mission: "a game",
        what: "stand up the engine",
        criteria: ["engine boots"],
        blocked_by: [],
        group: "core-engine",
      },
      {
        title: "Player movement",
        mission: "a game",
        what: "move the player",
        criteria: ["wasd moves"],
        blocked_by: [0],
        group: "core-engine",
      },
    ];
    const ordered = await orderTickets(plan);
    expect(ordered[0].group).toBe("core-engine");
    expect(ordered[1].group).toBe("core-engine");

    const dir = await mkdtemp(join(tmpdir(), "tkt-grp-"));
    await writeTickets(dir, ordered);
    const loaded = await loadTickets(dir);
    expect(loaded[0].group).toBe("core-engine");
    expect(loaded[1].group).toBe("core-engine");
  });

  it("group is optional — a plan without groups round-trips with undefined group", async () => {
    const plan: PlanTicket[] = [
      { title: "A ticket", mission: "m", what: "w", criteria: ["c"], blocked_by: [] },
    ];
    const ordered = await orderTickets(plan);
    expect(ordered[0].group).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), "tkt-nogrp-"));
    await writeTickets(dir, ordered);
    const loaded = await loadTickets(dir);
    expect(loaded[0].group).toBeUndefined();
  });

  it("different groups on different tickets round-trip independently", async () => {
    const plan: PlanTicket[] = [
      { title: "Engine", mission: "m", what: "w", criteria: [], blocked_by: [], group: "core" },
      { title: "Combat", mission: "m", what: "w", criteria: [], blocked_by: [0], group: "gameplay" },
      { title: "Polish", mission: "m", what: "w", criteria: [], blocked_by: [1], group: "polish" },
    ];
    const ordered = await orderTickets(plan);
    const dir = await mkdtemp(join(tmpdir(), "tkt-multigrp-"));
    await writeTickets(dir, ordered);
    const loaded = await loadTickets(dir);
    expect(loaded.map((l) => l.group)).toEqual(["core", "gameplay", "polish"]);
  });
});

describe("testPhaseRan", () => {
  it("is true when both config and ticket default (undefined) — the common case (#5, #45)", () => {
    expect(testPhaseRan(undefined, undefined)).toBe(true);
  });

  it("is true when the planner set testable: true and config defaults (#5)", () => {
    expect(testPhaseRan(undefined, true)).toBe(true);
  });

  it("is false when the planner marked the ticket testable: false (#5 — pure-config ticket)", () => {
    expect(testPhaseRan(undefined, false)).toBe(false);
  });

  it("is false when the project opted out via test_phase: false, even if the ticket is testable (#5)", () => {
    expect(testPhaseRan(false, true)).toBe(false);
    expect(testPhaseRan(false, undefined)).toBe(false);
  });

  it("stays false when BOTH the project opted out and the ticket is non-testable (#5)", () => {
    expect(testPhaseRan(false, false)).toBe(false);
  });

  it("treats an explicit test_phase: true the same as the default (#5)", () => {
    expect(testPhaseRan(true, undefined)).toBe(true);
    expect(testPhaseRan(true, true)).toBe(true);
    expect(testPhaseRan(true, false)).toBe(false);
  });
});