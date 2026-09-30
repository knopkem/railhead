import { describe, it, expect } from "vitest";
import { decideInteractionSmoke } from "./interaction-schedule.ts";
import { toTicketState, type Ticket } from "../core/ticket.ts";
import { CORRECTIVE_TITLE_PREFIXES, isCorrectiveTitle, REVIEW_FOLLOWUP_TITLE } from "./corrective.ts";

const ticket = (over: Partial<Ticket>): Ticket => ({
  file: "01-a.md",
  number: "01",
  slug: "a",
  title: "A",
  what: "a",
  criteria: ["renders a"],
  ...over,
});

const state = (t: Ticket, status: "ready" | "committed" | "in_progress" = "committed") => ({
  ...toTicketState(t),
  status,
});

const base = {
  enabled: true,
  iface: "browser-ui" as const,
};

describe("decideInteractionSmoke", () => {
  it("never fires when the gate is disabled or the interface is none", () => {
    const t = ticket({ group: "core" });
    expect(decideInteractionSmoke({ ...base, enabled: false, parsed: t, allParsed: [t], tickets: [state(t)] }).run).toBe(false);
    expect(decideInteractionSmoke({ ...base, iface: "none", parsed: t, allParsed: [t], tickets: [state(t)] }).run).toBe(false);
  });

  it("does not fire mid-group", () => {
    const t1 = ticket({ file: "01-a.md", number: "01", group: "core" });
    const t2 = ticket({ file: "02-b.md", number: "02", group: "core" });
    const d = decideInteractionSmoke({
      ...base,
      parsed: t1,
      allParsed: [t1, t2],
      tickets: [state(t1, "in_progress"), state(t2, "ready")],
    });
    expect(d.candidate).toBe(false);
    expect(d.run).toBe(false);
    expect(d.reason).toContain("not complete");
  });

  it("fires at a group close that claims rendered surface", () => {
    const t1 = ticket({ file: "01-a.md", number: "01", group: "core", criteria: ["renders a"] });
    const t2 = ticket({ file: "02-b.md", number: "02", group: "core", criteria: ["draws b"] });
    const d = decideInteractionSmoke({
      ...base,
      parsed: t2,
      allParsed: [t1, t2],
      tickets: [state(t1), state(t2, "in_progress")],
    });
    expect(d.candidate).toBe(true);
    expect(d.run).toBe(true);
    expect(d.kind).toBe("group");
  });

  it("skips a group close whose tickets claim no rendered/interactive surface", () => {
    const t1 = ticket({ file: "01-a.md", number: "01", group: "core", criteria: ["pure model modules tested"] });
    const t2 = ticket({ file: "02-b.md", number: "02", group: "core", criteria: ["typecheck passes"] });
    const d = decideInteractionSmoke({
      ...base,
      parsed: t2,
      allParsed: [t1, t2],
      tickets: [state(t1), state(t2, "in_progress")],
    });
    expect(d.candidate).toBe(true);
    expect(d.run).toBe(false);
    expect(d.reason).toContain("rendered/interactive");
  });

  it("fires for a corrective whose finding names an interaction", () => {
    const planned = ticket({ file: "01-a.md", number: "01", group: "core" });
    const corrective = ticket({
      file: "02-goal-review-fix-the-pause-button-does-nothing.md",
      number: "02",
      title: "Goal review fix: the pause button does nothing",
      what: "The goal reviewer found this quality gap:\n\n[BLOCKER] the pause button does nothing (src/ui/app.ts)",
      criteria: ["Run the app and confirm the quality gap is addressed", "Existing verify commands still pass"],
    });
    const d = decideInteractionSmoke({
      ...base,
      parsed: corrective,
      allParsed: [planned, corrective],
      tickets: [state(planned), state(corrective, "in_progress")],
    });
    expect(d.kind).toBe("corrective");
    expect(d.candidate).toBe(true);
    expect(d.run).toBe(true);
  });

  it("skips a corrective whose finding is not an interaction claim (favicon)", () => {
    // The spriteforge ticket-17 shape: the corrective criteria are template
    // boilerplate naming "the app", so relevance must read the finding, not
    // the criteria.
    const planned = ticket({ file: "01-a.md", number: "01", group: "core" });
    const corrective = ticket({
      file: "02-goal-review-fix-favicon-404.md",
      number: "02",
      title: "Goal review fix: Prior blocker (favicon 404) is RESOLVED",
      what: "The goal reviewer found this quality gap:\n\n[BLOCKER] index.html has no <link rel=\"icon\"> and no public/ favicon ships\n\nRun the app and confirm the quality gap is addressed.",
      criteria: ["Run the app and confirm the quality gap is addressed", "Existing verify commands still pass"],
    });
    const d = decideInteractionSmoke({
      ...base,
      parsed: corrective,
      allParsed: [planned, corrective],
      tickets: [state(planned), state(corrective, "in_progress")],
    });
    expect(d.kind).toBe("corrective");
    expect(d.candidate).toBe(true);
    expect(d.run).toBe(false);
    expect(d.reason).toContain("no interaction claims");
  });

  it("treats an ungrouped plan's ticket as a boundary, gated by its surface claims", () => {
    const surface = ticket({ file: "01-a.md", number: "01", criteria: ["renders the canvas"] });
    const dSurface = decideInteractionSmoke({ ...base, parsed: surface, allParsed: [surface], tickets: [state(surface, "in_progress")] });
    expect(dSurface.kind).toBe("ungrouped");
    expect(dSurface.run).toBe(true);

    const plain = ticket({ file: "02-b.md", number: "02", criteria: ["model ops are pure"] });
    const dPlain = decideInteractionSmoke({ ...base, parsed: plain, allParsed: [plain], tickets: [state(plain, "in_progress")] });
    expect(dPlain.run).toBe(false);
  });

  it("keeps every corrective title prefix wireable by isCorrectiveTitle", () => {
    for (const prefix of CORRECTIVE_TITLE_PREFIXES) {
      expect(isCorrectiveTitle(`${prefix} something`)).toBe(true);
    }
    expect(CORRECTIVE_TITLE_PREFIXES).toContain(REVIEW_FOLLOWUP_TITLE);
    expect(isCorrectiveTitle("Planned work")).toBe(false);
  });
});
