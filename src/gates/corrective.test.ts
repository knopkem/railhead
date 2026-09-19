import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { createRunState, type RunState, type TicketState } from "../core/state.ts";
import { initLedger } from "../core/ledger.ts";
import { toTicketState, writeTickets, type Ticket } from "../core/ticket.ts";
import { DEFAULT_CONFIG } from "../config/config.ts";
import {
  generateCorrectiveTickets,
  nextTicketNumber,
  processCorrectiveFindings,
  type CorrectiveKind,
} from "./corrective.ts";
import type { PlanTicket } from "../core/ticket-dag.ts";

const KINDS: CorrectiveKind[] = ["visual", "goal", "structural"];

function planned(
  file: string,
  over: Partial<Ticket> & { introduces?: string[] } = {},
): Ticket {
  return {
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: `Ticket ${file}`,
    what: "build something",
    mission: "a mission",
    blocked_by: [],
    criteria: ["it works"],
    files: [],
    references: [],
    introduces: [],
    ...over,
  };
}

/** A real state: ticket files on disk (writeCorrectiveTickets appends to the
 *  dir and enforceRuntimePlan re-scans it), a writable ledger, and in-memory
 *  ticket states whose statuses mirror the fixture. */
async function makeRailhead(
  tickets: Ticket[],
  opts?: { committed?: string[]; ready?: string[] },
): Promise<{ state: RunState; ledger: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "corrective-"));
  const ticketsDir = join(cwd, "issues");
  await writeTickets(ticketsDir, tickets);
  const ledger = join(cwd, ".railhead", "run-test");
  await initLedger(ledger);
  const state = createRunState({
    cwd,
    branch: "run/test",
    tickets_dir: ticketsDir,
    config: DEFAULT_CONFIG,
    pause_on_failure: false,
    verbose: false,
    quiet: false,
  });
  const committed = new Set(opts?.committed ?? []);
  const ready = new Set(opts?.ready ?? []);
  state.tickets = tickets.map((t) => {
    const ts = toTicketState(t);
    if (committed.has(t.file)) ts.status = "committed";
    else if (ready.has(t.file)) ts.status = "ready";
    return ts;
  });
  return { state, ledger };
}

/** Two committed + two ready planned tickets in a dependency chain, distinct
 *  introduces so the runtime plan scan never flags a corrective-vs-planned
 *  pair. */
function chainFixture(): Ticket[] {
  return [
    planned("01-scaffold.md", { introduces: ["setup"], files: ["src/index.js"] }),
    planned("02-core.md", { introduces: ["core"], files: ["src/core.js"], blocked_by: ["01-scaffold.md"] }),
    planned("03-player.md", { introduces: ["player"], files: ["src/player.js"], blocked_by: ["02-core.md"] }),
    planned("04-gameplay.md", { introduces: ["game"], files: ["src/game.js"], blocked_by: ["03-player.md"] }),
  ];
}

const stubRunner = (order: string[]) =>
  async (_state: RunState, _ledger: string, ts: TicketState): Promise<"ok" | "failed"> => {
    order.push(ts.file);
    ts.status = "committed";
    return "ok";
  };

describe("generateCorrectiveTickets — one ticket per [BLOCKER], kind-parameterized", () => {
  for (const kind of KINDS) {
    describe(kind, () => {
      it("creates one ticket per [BLOCKER] finding, skipping [MAJOR]s as blockers", () => {
        const out = generateCorrectiveTickets(
          kind,
          ["[BLOCKER] first defect", "[MAJOR] a nit", "[BLOCKER] second defect"],
          "mission text",
        );
        expect(out).toHaveLength(2);
        expect(out[0].title).toContain("first defect");
        expect(out[1].title).toContain("second defect");
        expect(out[0].mission).toBe("mission text");
        expect(out[0].blocked_by).toEqual([]);
      });

      it("returns no tickets when there are no [BLOCKER] findings (MAJORs alone never block)", () => {
        expect(generateCorrectiveTickets(kind, ["[MAJOR] only a nit"], "m")).toEqual([]);
      });

      it("records [MAJOR] findings as advisory context in the ticket body", () => {
        const out = generateCorrectiveTickets(kind, ["[BLOCKER] the bug", "[MAJOR] the nit"], "m");
        expect(out).toHaveLength(1);
        expect(out[0].what).toContain("the nit");
        expect(out[0].what).toContain("non-blocking");
      });

      it("strips the [BLOCKER] prefix from the title and body", () => {
        const out = generateCorrectiveTickets(kind, ["[BLOCKER] the drift"], "m");
        expect(out[0].title).not.toContain("[BLOCKER]");
        expect(out[0].what).not.toContain("[BLOCKER] the drift");
      });

      it("keeps the finding body intact in `what`", () => {
        const out = generateCorrectiveTickets(kind, ["[BLOCKER] the renderer is flat"], "m");
        expect(out[0].what).toContain("the renderer is flat");
      });

      it("recognizes bare-word/numbered/bolded labels as blockers, majors as advisory (#119)", () => {
        const out = generateCorrectiveTickets(
          kind,
          ["BLOCKER 1 — the toolbar overflows", "MAJOR 3 — onion-skin opacity", "**Blocker:** eraser broken"],
          "m",
        );
        expect(out).toHaveLength(2);
        expect(out[0].what).toContain("toolbar overflows");
        expect(out[0].what).not.toContain("BLOCKER 1");
        expect(out[1].what).toContain("eraser broken");
        expect(out[0].what).toContain("onion-skin opacity");
      });
    });
  }

  it("visual tickets name the screenshot evidence and default to .railhead/visual/", () => {
    const withShot = generateCorrectiveTickets("visual", ["[BLOCKER] rows drift (see .railhead/visual/frame_03.png)"], "pong");
    expect(withShot[0].what).toContain(".railhead/visual/frame_03.png");
    expect(withShot[0].what).toContain("read these if your model is vision-capable");
    const withoutShot = generateCorrectiveTickets("visual", ["[BLOCKER] ball never gains velocity"], "pong");
    expect(withoutShot[0].what).toContain(".railhead/visual/");
    expect(withoutShot[0].what).toContain("read them to see exactly what the reviewer saw");
  });

  it("visual corrective tickets are not unit-testable and truncate with a visual_findings pointer", () => {
    const out = generateCorrectiveTickets("visual", ["[BLOCKER] " + "x".repeat(600)], "m");
    expect(out[0].testable).toBe(false);
    expect(out[0].what).toContain("x".repeat(500));
    expect(out[0].what).toContain("full finding is in the run's visual_findings");
    expect(out[0].what).not.toContain("x".repeat(600));
  });

  it("goal tickets reference docs/design.md and populate files/references from the finding", () => {
    const out = generateCorrectiveTickets("goal", [
      "[BLOCKER] src/scenes/GameScene.ts:100-166 is flat; wire BIOME_2_CONFIG into GameScene",
    ], "a roguelike");
    expect(out[0].what).toContain("docs/design.md");
    expect(out[0].files).toEqual(["src/scenes/GameScene.ts"]);
    expect(out[0].references).toContain("BIOME_2_CONFIG");
    expect(out[0].references).toContain("GameScene");
  });

  it("goal corrective tickets are not unit-testable and truncate with a goal_review pointer", () => {
    const out = generateCorrectiveTickets("goal", ["[BLOCKER] " + "x".repeat(600)], "m");
    expect(out[0].testable).toBe(false);
    expect(out[0].what).toContain("full finding is in the run's goal_review findings");
    expect(out[0].title.length).toBeLessThan(100);
  });

  it("structural refactors are testable and name the smell in acceptance criteria", () => {
    const out = generateCorrectiveTickets("structural", ["[BLOCKER] Duplicated greeting logic in utils.ts and greeter.ts"], "m");
    expect(out[0].testable).toBe(true);
    expect(out[0].criteria[0]).toMatch(/Duplicated greeting/);
    expect(out[0].what).toContain("docs/architecture.md");
  });
});

describe("nextTicketNumber", () => {
  it("counts from the run's existing ticket sequence", async () => {
    const { state } = await awaitRailhead([planned("01-a.md"), planned("02-b.md"), planned("05-c.md")]);
    expect(nextTicketNumber(state)).toBe(6);
  });
});

async function awaitRailhead(tickets: Ticket[]): Promise<{ state: RunState; ledger: string }> {
  return makeRailhead(tickets, { committed: tickets.slice(0, 1).map((t) => t.file), ready: tickets.slice(1).map((t) => t.file) });
}

describe("processCorrectiveFindings — pipeline (stub runTicket)", () => {
  it('returns "none" on majors-only findings and writes nothing / runs nothing', async () => {
    const tickets = chainFixture();
    const { state, ledger } = await makeRailhead(tickets, { committed: ["01-scaffold.md"], ready: ["02-core.md", "03-player.md", "04-gameplay.md"] });
    const order: string[] = [];
    const outcome = await processCorrectiveFindings(state, ledger, ["[MAJOR] cosmetic"], {
      kind: "goal",
      label: "goal review",
      mission: "m",
      blockUncommitted: true,
      runTicket: stubRunner(order),
    });
    expect(outcome).toBe("none");
    expect(order).toEqual([]);
    expect(state.tickets).toHaveLength(4);
  });

  it("numbers corrective tickets continuing the sequence and registers them in order", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    const order: string[] = [];
    const outcome = await processCorrectiveFindings(state, ledger, ["[BLOCKER] no food", "[BLOCKER] no obstacles"], {
      kind: "goal",
      label: "goal review",
      mission: "a snake game",
      blockUncommitted: true,
      runTicket: stubRunner(order),
    });
    expect(outcome).toBe("committed");
    expect(state.tickets).toHaveLength(6);
    const corrective = state.tickets.slice(4);
    expect(corrective.map((t) => t.number)).toEqual(["05", "06"]);
    expect(corrective[0].file).toMatch(/^05-/);
    expect(corrective[1].file).toMatch(/^06-/);
    expect(order).toEqual(corrective.map((t) => t.file));
    for (const c of corrective) {
      expect(c.blocked_by).toEqual([]);
    }
  });

  it("wires uncommitted planned tickets to the corrective tickets when blockUncommitted is true (goal)", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    await processCorrectiveFindings(state, ledger, ["[BLOCKER] the snake has no food"], {
      kind: "goal",
      label: "goal review",
      mission: "m",
      blockUncommitted: true,
      runTicket: stubRunner([]),
    });
    const corrective = state.tickets.find((t) => t.number === "05")!;
    const readyPlanned = state.tickets.filter((t) => ["03-player.md", "04-gameplay.md"].includes(t.file));
    for (const t of readyPlanned) {
      expect(t.blocked_by).toContain(corrective.file);
    }
    const committedPlanned = state.tickets.filter((t) => ["01-scaffold.md", "02-core.md"].includes(t.file));
    for (const t of committedPlanned) {
      expect(t.blocked_by).not.toContain(corrective.file);
    }
  });

  it("leaves uncommitted planned tickets unwired when blockUncommitted is false (visual)", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    await processCorrectiveFindings(state, ledger, ["[BLOCKER] paddle does not move"], {
      kind: "visual",
      label: "visual review",
      mission: "m",
      blockUncommitted: false,
      runTicket: stubRunner([]),
    });
    const corrective = state.tickets.find((t) => t.number === "05")!;
    for (const t of state.tickets.filter((x) => x.status === "ready")) {
      expect(t.blocked_by).not.toContain(corrective.file);
    }
  });

  it("stops on the first failed corrective ticket and does not run the rest", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    const order: string[] = [];
    let calls = 0;
    const failingRunner = async (_s: RunState, _l: string, ts: TicketState): Promise<"ok" | "failed"> => {
      calls++;
      order.push(ts.file);
      if (calls === 2) return "failed";
      ts.status = "committed";
      return "ok";
    };
    const outcome = await processCorrectiveFindings(state, ledger, ["[BLOCKER] one", "[BLOCKER] two", "[BLOCKER] three"], {
      kind: "structural",
      label: "structural review",
      mission: "m",
      blockUncommitted: true,
      runTicket: failingRunner,
    });
    expect(outcome).toBe("failed");
    expect(order).toHaveLength(2);
    expect(state.tickets.find((t) => t.number === "07")!.status).toBe("ready");
  });

  it("uses the reviewer's suggested $CORRECTIVE tickets instead of the mechanical split", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    const suggested: PlanTicket[] = [
      {
        title: "Replace rectangle rendering with sprites",
        what: "swap the renderer",
        criteria: ["run and confirm"],
        blocked_by: [],
        files: ["src/scenes/GameScene.ts"],
        references: ["GameScene"],
        introduces: [],
        testable: false,
      },
      {
        title: "Add parallax depth bands",
        what: "layers",
        criteria: ["run and confirm"],
        blocked_by: [],
        files: [],
        references: [],
        introduces: [],
        testable: false,
      },
    ];
    await processCorrectiveFindings(state, ledger, ["[BLOCKER] colored rectangles"], {
      kind: "goal",
      label: "goal review",
      mission: "m",
      blockUncommitted: true,
      suggested,
      runTicket: stubRunner([]),
    });
    const corrective = state.tickets.slice(4);
    expect(corrective.map((t) => t.title)).toEqual(["Replace rectangle rendering with sprites", "Add parallax depth bands"]);
    expect(corrective.map((t) => t.number)).toEqual(["05", "06"]);
    for (const c of corrective) {
      expect(c.blocked_by).toEqual([]);
    }
  });

  it("reports none when the beforeCorrectives hook supersedes corrective tickets", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    const order: string[] = [];
    const outcome = await processCorrectiveFindings(state, ledger, ["[BLOCKER] plan-level drift"], {
      kind: "goal",
      label: "goal review",
      mission: "m",
      blockUncommitted: true,
      runTicket: stubRunner(order),
      beforeCorrectives: async () => true,
    });
    expect(outcome).toBe("none");
    expect(order).toEqual([]);
    expect(state.tickets).toHaveLength(4);
  });

  it("runs the beforeCorrectives hook even on a blocker-less FAIL (a $REPLAN without a [BLOCKER] must fire)", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    let called = false;
    const outcome = await processCorrectiveFindings(state, ledger, ["[MAJOR] the plan under-scoped the goal"], {
      kind: "goal",
      label: "goal review",
      mission: "m",
      blockUncommitted: true,
      runTicket: stubRunner([]),
      beforeCorrectives: async () => { called = true; return true; },
    });
    expect(called).toBe(true);
    expect(outcome).toBe("none");
    expect(state.tickets).toHaveLength(4);
  });

  it("fail-loud (#119): a FAIL whose finding names a blocker but carries no label generates a corrective ticket instead of soft-passing", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    const order: string[] = [];
    const outcome = await processCorrectiveFindings(state, ledger, ["the toolbar overlap is a blocker for release"], {
      kind: "goal",
      label: "goal review",
      mission: "m",
      blockUncommitted: true,
      runTicket: stubRunner(order),
    });
    expect(outcome).toBe("committed");
    expect(order).toHaveLength(1);
    expect(state.tickets).toHaveLength(5);
    const corrective = state.tickets[4];
    expect(corrective.title).toContain("toolbar overlap");
  });

  it("fail-loud (#119): a blocker-less FAIL with no severity word still soft-passes (honest default unchanged)", async () => {
    const { state, ledger } = await makeRailhead(chainFixture(), { committed: ["01-scaffold.md", "02-core.md"], ready: ["03-player.md", "04-gameplay.md"] });
    const order: string[] = [];
    const outcome = await processCorrectiveFindings(state, ledger, ["[MAJOR] a minor quality gap"], {
      kind: "goal",
      label: "goal review",
      mission: "m",
      blockUncommitted: true,
      runTicket: stubRunner(order),
    });
    expect(outcome).toBe("none");
    expect(order).toEqual([]);
    expect(state.tickets).toHaveLength(4);
  });
});
