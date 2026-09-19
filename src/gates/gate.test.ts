import { describe, it, expect } from "vitest";
import { advanceRetry, INITIAL_COUNTERS, type GateCounters, type GateStep } from "./gate.ts";
import { isBlocker, splitFindings } from "./reviewer.ts";

const LIMITS = { maxRetries: 3, reviewBudget: 3 };

function implementFeedback(step: GateStep): string {
  if (step.next !== "implement") throw new Error(`expected implement, got ${step.next}`);
  return step.feedback;
}

describe("advanceRetry", () => {
  it("a verify failure burns unproductive and re-implements with the output as feedback", () => {
    const { step, counters } = advanceRetry(
      { unproductive: 1, reviewFailures: 0, reviewRounds: 0 },
      { type: "verify_failed", output: "bail" },
      LIMITS,
    );
    expect(step.next).toBe("implement");
    expect(step).toEqual(expect.objectContaining({ feedback: "Verification failed. Output:\nbail" }));
    expect(counters.unproductive).toBe(2);
  });

  it("a review pass commits and leaves counters untouched", () => {
    const { step, counters } = advanceRetry(
      { unproductive: 2, reviewFailures: 1, reviewRounds: 1 },
      { type: "review_passed" },
      LIMITS,
    );
    expect(step.next).toBe("commit");
    expect(counters).toEqual({ unproductive: 2, reviewFailures: 1, reviewRounds: 1 });
  });

  it("all-distinct blocking findings reset unproductive/reviewFailures but not the round floor: the ticket improved", () => {
    const { step, counters } = advanceRetry(
      { unproductive: 2, reviewFailures: 1, reviewRounds: 1 },
      { type: "review_blocking", findings: ["brand new bug"], priorFindings: ["earlier bug one", "earlier bug two"] },
      LIMITS,
    );
    expect(step.next).toBe("implement");
    expect(counters.unproductive).toBe(0);
    expect(counters.reviewFailures).toBe(0);
    expect(counters.reviewRounds).toBe(2);
    expect(implementFeedback(step)).toContain("brand new bug");
  });

  it("a repeated finding regresses: burns unproductive and reviewFailures", () => {
    const { step, counters } = advanceRetry(
      { unproductive: 1, reviewFailures: 0, reviewRounds: 0 },
      { type: "review_blocking", findings: ["same bug"], priorFindings: ["same bug", "other"] },
      LIMITS,
    );
    expect(step.next).toBe("implement");
    expect(counters.unproductive).toBe(2);
    expect(counters.reviewFailures).toBe(1);
  });

  it("partially-distinct findings still count as regression while earlier distinct ones reset it", () => {
    // One NEW finding does not reset when a PRIOR finding also remains.
    const { step, counters } = advanceRetry(
      { unproductive: 1, reviewFailures: 1, reviewRounds: 1 },
      { type: "review_blocking", findings: ["same bug", "another bug"], priorFindings: ["same bug"] },
      LIMITS,
    );
    expect(step.next).toBe("implement");
    expect(counters.unproductive).toBe(2);
    expect(counters.reviewFailures).toBe(2);
  });

  it("issue #70: a chain of ALL-distinct findings can spin at most reviewBudget rounds, then fails", () => {
    // A fresh-context implementer keeps producing "a different bug each time",
    // which the old code treated as progress and reset the budget forever —
    // letting one ticket eat up to maxAttempts (9) rounds. The non-resetting
    // round floor must bound the spin at reviewBudget.
    let counters: GateCounters = { ...INITIAL_COUNTERS };
    for (let round = 1; round <= 3; round++) {
      const { step, counters: next } = advanceRetry(
        counters,
        { type: "review_blocking", findings: [`brand new bug ${round}`], priorFindings: [] },
        LIMITS,
      );
      counters = next;
      expect(step.next).toBe("implement");
    }
    const { step, counters: final } = advanceRetry(
      counters,
      { type: "review_blocking", findings: ["yet another distinct bug"], priorFindings: [] },
      LIMITS,
    );
    expect(step.next).toBe("fail");
    expect(step).toEqual(expect.objectContaining({ reason: "review_budget" }));
    expect(final.reviewRounds).toBe(4);
  });

  it("issue #70: a mixed distinct/duplicate sequence respects the round floor", () => {
    // distinct round 1, regressing round 2, distinct round 3: the 4th blocking
    // round (whatever its content) fails the ticket.
    let counters: GateCounters = { ...INITIAL_COUNTERS };
    const distinctRound = (finding: string) =>
      advanceRetry(counters, { type: "review_blocking", findings: [finding], priorFindings: [] }, LIMITS);
    const regressRound = (finding: string) =>
      advanceRetry(counters, { type: "review_blocking", findings: [finding], priorFindings: [finding] }, LIMITS);

    ({ counters } = distinctRound("bug A"));
    expect(counters.reviewRounds).toBe(1);
    ({ counters } = regressRound("bug B"));
    expect(counters.reviewRounds).toBe(2);
    ({ counters } = distinctRound("bug C"));
    expect(counters.reviewRounds).toBe(3);
    const { step } = distinctRound("bug D");
    expect(step.next).toBe("fail");
  });

  it("regressing review past reviewBudget fails with reason review_budget", () => {
    const { step, counters } = advanceRetry(
      { unproductive: 0, reviewFailures: 3, reviewRounds: 0 },
      { type: "review_blocking", findings: ["repeated"], priorFindings: ["repeated"] },
      { maxRetries: 3, reviewBudget: 3 },
    );
    expect(step.next).toBe("fail");
    expect(step).toEqual(expect.objectContaining({ reason: "review_budget" }));
    expect(counters.reviewFailures).toBe(4);
  });

  it("exhausting maxRetries via repeated regressions fails with reason retries", () => {
    const { step } = advanceRetry(
      { unproductive: 3, reviewFailures: 0, reviewRounds: 0 },
      { type: "review_blocking", findings: ["still broken"], priorFindings: ["still broken"] },
      LIMITS,
    );
    expect(step.next).toBe("fail");
    expect(step).toEqual(expect.objectContaining({ reason: "retries" }));
  });

  it("feedback separates open must-fix items from already-resolved ones", () => {
    const { step } = advanceRetry(
      { unproductive: 0, reviewFailures: 0, reviewRounds: 0 },
      {
        type: "review_blocking",
        findings: ["[BLOCKER] new one", "repeated old"],
        priorFindings: ["old resolved", "repeated old"],
      },
      LIMITS,
    );
    expect(step.next).toBe("implement");
    const fb = implementFeedback(step);
    expect(fb).toContain("[BLOCKER] new one");
    expect(fb).toContain("Fix these must-fix issues:");
    // "old resolved" is prior-only, so it lands in the do-not-reintroduce note.
    expect(fb).toContain("old resolved");
    expect(fb).toContain("already-resolved");
    // "repeated old" is still open, so it is NOT re-listed as resolved.
    const resolvedNote = fb.split("already-resolved")[1];
    expect(resolvedNote).not.toContain("repeated old");
  });

  it("feedback omits the already-resolved note when nothing was resolved", () => {
    const { step } = advanceRetry(
      { unproductive: 0, reviewFailures: 0, reviewRounds: 0 },
      { type: "review_blocking", findings: ["[MAJOR] only"], priorFindings: [] },
      LIMITS,
    );
    expect(implementFeedback(step)).toContain("[MAJOR] only");
    expect(implementFeedback(step)).toContain("Fix these must-fix issues");
    expect(implementFeedback(step)).not.toContain("already-resolved");
  });
});

describe("reviewer finding helpers", () => {
  it("isBlocker only matches [BLOCKER]-prefixed findings", () => {
    expect(isBlocker("[BLOCKER] crashes")).toBe(true);
    expect(isBlocker("  [BLOCKER] broken")).toBe(true);
    expect(isBlocker("[MAJOR] imperfect")).toBe(false);
    expect(isBlocker("no label")).toBe(false);
  });

  it("splitFindings preserves each finding's severity label", () => {
    const items = splitFindings("[BLOCKER] crashes\n[MAJOR] edge case");
    expect(items).toEqual(["[BLOCKER] crashes", "[MAJOR] edge case"]);
  });
});
