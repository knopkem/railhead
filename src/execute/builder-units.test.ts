import { describe, it, expect } from "vitest";
import { checkpointTarget, nextBuilderUnit } from "./builder-units.ts";
import type { TicketState } from "../core/state.ts";

function ticket(number: string, group?: string): TicketState {
  return {
    file: `${number}-t.md`,
    title: `Ticket ${number}`,
    number,
    status: "ready",
    attempts: 0,
    start_commit: null,
    commit: null,
    verify_ok: null,
    review_ok: null,
    review_attempts: 0,
    duration_ms: 0,
    reviews: [],
    group,
    logs: [],
  };
}

const t01 = ticket("01");
const t02 = ticket("02", "A");
const t03 = ticket("03", "A");
const t04 = ticket("04", "B");

describe("nextBuilderUnit (issue #95 stage 2 routing)", () => {
  it("routes one ticket per unit under ticket granularity, in plan order", () => {
    expect(nextBuilderUnit([t01, t02, t03], "ticket")).toEqual({ tickets: [t01], checkpointAtEnd: false });
    // After t01 commits the remaining slice advances — the unit is live.
    expect(nextBuilderUnit([t02, t03], "ticket")).toEqual({ tickets: [t02], checkpointAtEnd: false });
  });

  it("routes the whole remaining plan as one product unit", () => {
    const u = nextBuilderUnit([t01, t02, t03], "product")!;
    expect(u.tickets.map((t) => t.number)).toEqual(["01", "02", "03"]);
    expect(u.checkpointAtEnd).toBe(false);
    // A product unit shrinks as tickets commit (same session, fewer left to name).
    const shrunk = nextBuilderUnit([t02, t03], "product")!;
    expect(shrunk.tickets.map((t) => t.number)).toEqual(["02", "03"]);
  });

  it("groups by the leader's planner group under group granularity", () => {
    const u = nextBuilderUnit([t02, t03, t04], "group")!;
    expect(u.tickets.map((t) => t.number)).toEqual(["02", "03"]);
    expect(u.checkpointAtEnd).toBe(true);
    // Next unit after group A commits is group B.
    const next = nextBuilderUnit([t04], "group")!;
    expect(next.tickets.map((t) => t.number)).toEqual(["04"]);
    expect(next.checkpointAtEnd).toBe(true);
  });

  it("degenerates group granularity to per-ticket when the plan has no group labels", () => {
    expect(nextBuilderUnit([t01, t04], "group")).toEqual({ tickets: [t01], checkpointAtEnd: false });
  });

  it("returns null when nothing remains", () => {
    expect(nextBuilderUnit([], "ticket")).toBeNull();
    expect(nextBuilderUnit([], "group")).toBeNull();
    expect(nextBuilderUnit([], "product")).toBeNull();
  });
});

describe("checkpointTarget (issue #95 stop semantics)", () => {
  it("names the first ticket for per-ticket units", () => {
    expect(checkpointTarget({ tickets: [t01, t02], checkpointAtEnd: false })).toBe(t01);
  });
  it("names the LAST ticket for an end-of-group unit", () => {
    const unit = nextBuilderUnit([t02, t03], "group")!;
    expect(checkpointTarget(unit)).toBe(t03);
  });
});
