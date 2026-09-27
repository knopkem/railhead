import { describe, it, expect } from "vitest";
import { codeReviewSchedule, type ReviewStressInput } from "./review-schedule.ts";

/** The clean baseline: trigger smart, a single-pass build with no stress. */
function input(over: Partial<ReviewStressInput> = {}): ReviewStressInput {
  return {
    trigger: "smart",
    compactions: 0,
    attempts: 1,
    restarts: 0,
    reconciled: false,
    blocked: false,
    unverified: false,
    replanArmed: false,
    ...over,
  };
}

describe("codeReviewSchedule", () => {
  it("trigger always reviews regardless of the stress signals", () => {
    const s = codeReviewSchedule(input({ trigger: "always" }));
    expect(s.run).toBe(true);
  });

  it("a clean single-pass, zero-compaction ticket skips with the 'no stress' reason", () => {
    const s = codeReviewSchedule(input());
    expect(s.run).toBe(false);
    expect(s.reason).toBe("no stress");
  });

  it("a compaction fires the review and names the count (and pluralizes)", () => {
    const one = codeReviewSchedule(input({ compactions: 1 }));
    expect(one).toMatchObject({ run: true, reason: "1 compaction" });
    const two = codeReviewSchedule(input({ compactions: 2 }));
    expect(two).toMatchObject({ run: true, reason: "2 compactions" });
  });

  it("more than one build attempt fires the review", () => {
    const s = codeReviewSchedule(input({ attempts: 2 }));
    expect(s).toMatchObject({ run: true, reason: "2 build attempts" });
  });

  it("a builder-session restart fired during the ticket fires the review", () => {
    const s = codeReviewSchedule(input({ restarts: 1 }));
    expect(s).toMatchObject({ run: true, reason: "builder session restarted 1x" });
  });

  it("a spent spec reconciliation fires the review", () => {
    const s = codeReviewSchedule(input({ reconciled: true }));
    expect(s).toMatchObject({ run: true, reason: "spec reconciliation ran" });
  });

  it("a $BLOCKED record fires the review", () => {
    const s = codeReviewSchedule(input({ blocked: true }));
    expect(s).toMatchObject({ run: true, reason: "$BLOCKED recorded" });
  });

  it("an unverified criterion fires the review", () => {
    const s = codeReviewSchedule(input({ unverified: true }));
    expect(s).toMatchObject({ run: true, reason: "unverified criteria recorded" });
  });

  it("a replan since the last review fires the review", () => {
    const s = codeReviewSchedule(input({ replanArmed: true }));
    expect(s).toMatchObject({ run: true, reason: "plan re-scoped" });
  });

  it("multiple stress signals compose into one reason naming each", () => {
    const s = codeReviewSchedule(input({ compactions: 2, attempts: 3, replanArmed: true }));
    expect(s.run).toBe(true);
    expect(s.reason).toBe("2 compactions; 3 build attempts; plan re-scoped");
  });
});
