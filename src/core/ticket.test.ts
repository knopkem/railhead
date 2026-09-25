import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { numberTickets, titleSlug, loadTickets, writeTickets, parseTicket, criterionBehavior, criterionProbe, withProbe, type PlanTicket } from "./ticket.ts";

describe("numberTickets", () => {
  it("numbers in emission order with a filename per ticket", () => {
    const tickets = numberTickets([
      { title: "Add greet", what: "export greet", criteria: ["greet works"] },
      { title: "Use greet", what: "export message", criteria: ["message works"] },
    ]);
    expect(tickets.map((t) => t.number)).toEqual(["01", "02"]);
    expect(tickets.map((t) => t.file)).toEqual(["01-add-greet.md", "02-use-greet.md"]);
    expect(tickets.map((t) => t.slug)).toEqual(["add-greet", "use-greet"]);
  });

  it("suffixes colliding title-slugs so file names stay unique", () => {
    const tickets = numberTickets([
      { title: "Same title", what: "one", criteria: ["c"] },
      { title: "Same title", what: "two", criteria: ["c"] },
    ]);
    expect(tickets.map((t) => t.file)).toEqual(["01-same-title.md", "02-same-title-2.md"]);
  });

  it("continues a global sequence for replans", () => {
    const tickets = numberTickets([{ title: "Rebuilt", what: "w", criteria: ["c"] }], 23);
    expect(tickets[0]!.number).toBe("23");
    expect(tickets[0]!.file).toBe("23-rebuilt.md");
  });

  it("carries the optional group and open_ended markers through", () => {
    const [t] = numberTickets([{ title: "Art", what: "craft it", criteria: [], group: "polish", open_ended: true }]);
    expect(t!.group).toBe("polish");
    expect(t!.open_ended).toBe(true);
  });
});

describe("titleSlug", () => {
  it("slugifies a title and falls back for an empty one", () => {
    expect(titleSlug("Add greet!")).toBe("add-greet");
    expect(titleSlug("!!!")).toBe("ticket");
  });
});

describe("write → parse round-trip", () => {
  it("recovers plan tickets written to disk exactly", async () => {
    const plan: PlanTicket[] = [
      {
        title: "Add greet",
        what: "export a greet function",
        criteria: ["exports greet", "greet('x') returns a string"],
        group: "core",
      },
      {
        title: "Use greet",
        what: "export message that calls greet",
        criteria: ["exports message"],
        group: "core",
      },
    ];

    const numbered = numberTickets(plan);
    const dir = await mkdtemp(join(tmpdir(), "tkt-"));
    await writeTickets(dir, numbered);

    expect((await readdir(dir)).sort()).toEqual(["01-add-greet.md", "02-use-greet.md"]);

    const loaded = await loadTickets(dir);
    expect(loaded.map((l) => l.number)).toEqual(["01", "02"]);

    const t1 = loaded.find((l) => l.number === "01")!;
    expect(t1).toMatchObject({
      title: "Add greet",
      what: "export a greet function",
      criteria: ["exports greet", "greet('x') returns a string"],
      group: "core",
    });

    const t2 = loaded.find((l) => l.number === "02")!;
    expect(t2.what).toBe("export message that calls greet");
    expect(t2.criteria).toEqual(["exports message"]);
  });

  it("round-trips the open-ended craft marker", async () => {
    const numbered = numberTickets([
      { title: "Art direction", what: "compose the scene", criteria: [], open_ended: true },
    ]);
    const dir = await mkdtemp(join(tmpdir(), "tkt-"));
    await writeTickets(dir, numbered);
    const loaded = await loadTickets(dir);
    expect(loaded[0]!.open_ended).toBe(true);
  });

  it("round-trips a criterion with an indented probe recipe line", async () => {
    const behavior = "The board shows a 3x3 grid after starting a game";
    const probe = "launch the app; click New game; assert 9 cell elements are visible";
    const numbered = numberTickets([
      { title: "Board grid", what: "render the board", criteria: [withProbe(behavior, probe), "the build command exits 0"] },
    ]);
    const dir = await mkdtemp(join(tmpdir(), "tkt-probe-"));
    await writeTickets(dir, numbered);
    const rendered = await parseTicket(dir, numbered[0]!.file);
    expect(rendered.criteria).toEqual([withProbe(behavior, probe), "the build command exits 0"]);
    expect(criterionBehavior(rendered.criteria[0]!)).toBe(behavior);
    expect(criterionProbe(rendered.criteria[0]!)).toBe(probe);
    expect(criterionProbe(rendered.criteria[1]!)).toBeNull();
  });

  it("parses a legacy '(test)' criterion as a plain behaviour with no probe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tkt-legacy-"));
    const file = "01-legacy.md";
    await writeFile(join(dir, file), `# 01: Legacy

**What to build:** do the thing

- [ ] greet('x') returns a string (test)
`, "utf8");
    const t = await parseTicket(dir, file);
    expect(t.criteria).toEqual(["greet('x') returns a string (test)"]);
    expect(criterionProbe(t.criteria[0]!)).toBeNull();
    expect(criterionBehavior(t.criteria[0]!)).toBe("greet('x') returns a string (test)");
  });

  it("writeTickets removes stale .md files before writing the new plan", async () => {
    const numbered = numberTickets([{ title: "New ticket", what: "w", criteria: ["c"] }]);
    const dir = await mkdtemp(join(tmpdir(), "tkt-"));
    // Seed the dir with a stale ticket from a previous build/fix run on the same
    // .scratch/<slug>/issues path. Without clearing, the next run picks up both
    // the stale and the new file as separate tickets.
    await writeFile(join(dir, "01-stale-from-prior-run.md"), "# stale\n", "utf8");
    await writeFile(join(dir, "02-also-stale.md"), "# stale 2\n", "utf8");
    // Non-markdown files (e.g. a README the user dropped in) must be preserved —
    // clearing applies to ticket files only, not arbitrary content.
    await writeFile(join(dir, "README.txt"), "hands off\n", "utf8");

    await writeTickets(dir, numbered);

    const files = (await readdir(dir)).sort();
    expect(files).toContain("01-new-ticket.md");
    expect(files).not.toContain("01-stale-from-prior-run.md");
    expect(files).not.toContain("02-also-stale.md");
    expect(files).toContain("README.txt");
  });
});

describe("parseTicket — fail loud on a malformed ticket", () => {
  async function makeTicketFile(body: string): Promise<{ dir: string; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), "tkt-bad-"));
    const file = "01-broken.md";
    await writeFile(join(dir, file), body, "utf8");
    return { dir, file };
  }

  it("throws when What-to-build content is empty", async () => {
    const { dir, file } = await makeTicketFile(`# 01: A ticket

**What to build:**

- [ ] it works
`);
    await expect(parseTicket(dir, file)).rejects.toThrow(/what to build/i);
  });

  it("accepts a well-formed ticket and reads its criteria", async () => {
    const { dir, file } = await makeTicketFile(`# 01: A ticket

**What to build:** do the thing

**Status:** ready-for-agent

- [ ] it works
`);
    const t = await parseTicket(dir, file);
    expect(t.what).toBe("do the thing");
    expect(t.criteria).toEqual(["it works"]);
  });

  it("tolerates legacy headings (mission/files/blocked_by) but ignores them", async () => {
    const { dir, file } = await makeTicketFile(`# 01: A ticket

**Mission:** old mission

**What to build:** do the thing

**Blocked by:** None

**Files to read/use:**
- \`src/a.ts\`

- [ ] it works
`);
    const t = await parseTicket(dir, file);
    expect(t.what).toBe("do the thing");
    expect((t as unknown as Record<string, unknown>).blocked_by).toBeUndefined();
  });

  it("error names the offending file so it is actionable", async () => {
    const { dir, file } = await makeTicketFile("# 01: A ticket\n\nno headings at all\n");
    await expect(parseTicket(dir, file)).rejects.toThrow(/01-broken\.md is malformed/);
  });
});

describe("group field round-trip (#19)", () => {
  it("renders and recovers a group label through write → parse", async () => {
    const numbered = numberTickets([
      { title: "Core engine", what: "stand up the engine", criteria: ["engine boots"], group: "core-engine" },
      { title: "Player movement", what: "move the player", criteria: ["wasd moves"], group: "core-engine" },
    ]);
    expect(numbered[0].group).toBe("core-engine");
    expect(numbered[1].group).toBe("core-engine");

    const dir = await mkdtemp(join(tmpdir(), "tkt-grp-"));
    await writeTickets(dir, numbered);
    const loaded = await loadTickets(dir);
    expect(loaded.map((l) => l.group)).toEqual(["core-engine", "core-engine"]);
  });

  it("group is optional — a plan without groups round-trips with undefined group", async () => {
    const numbered = numberTickets([{ title: "A ticket", what: "w", criteria: ["c"] }]);
    expect(numbered[0].group).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), "tkt-nogrp-"));
    await writeTickets(dir, numbered);
    const loaded = await loadTickets(dir);
    expect(loaded[0].group).toBeUndefined();
  });

  it("different groups on different tickets round-trip independently", async () => {
    const numbered = numberTickets([
      { title: "Engine", what: "w", criteria: ["c"], group: "core" },
      { title: "Combat", what: "w", criteria: ["c"], group: "gameplay" },
      { title: "Polish", what: "w", criteria: ["c"], group: "polish" },
    ]);
    const dir = await mkdtemp(join(tmpdir(), "tkt-multigrp-"));
    await writeTickets(dir, numbered);
    const loaded = await loadTickets(dir);
    expect(loaded.map((l) => l.group)).toEqual(["core", "gameplay", "polish"]);
  });
});
