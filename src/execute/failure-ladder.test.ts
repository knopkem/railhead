import { describe, it, expect } from "vitest";
import { clearStop, requestAbort } from "./stop.ts";
import { classifyFailure, nextRung, evidenceFromResult, withFailureLadder, PhaseFailure, type FailureEvidence } from "./failure-ladder.ts";

const ev = (over: Partial<FailureEvidence> = {}): FailureEvidence => ({
  status: "error",
  errorMessage: null,
  peakTokens: 0,
  steps: 0,
  toolCalls: 0,
  code: null,
  signal: null,
  durationMs: 0,
  ...over,
});

const BUDGET = 100_000;

describe("classifyFailure (#80)", () => {
  it("classifies an invalid-api-key message as fatal-config", () => {
    expect(classifyFailure(ev({ errorMessage: "invalid api key" }), BUDGET)).toBe("fatal-config");
  });

  it("classifies an authentication failure as fatal-config", () => {
    expect(classifyFailure(ev({ errorMessage: "authentication failed" }), BUDGET)).toBe("fatal-config");
  });

  it("classifies model-not-found as fatal-config", () => {
    expect(classifyFailure(ev({ errorMessage: "model not found: foo/bar" }), BUDGET)).toBe("fatal-config");
  });

  it("classifies high peak tokens as capacity regardless of wording", () => {
    expect(classifyFailure(ev({ peakTokens: 95_000 }), BUDGET)).toBe("capacity");
  });

  it("classifies capacity wording alone as capacity (the tiebreaker)", () => {
    expect(classifyFailure(ev({ peakTokens: 89_000, errorMessage: "insufficient memory: GPU" }), BUDGET)).toBe("capacity");
  });

  it("does NOT classify a low-peak, non-capacity OOM as capacity", () => {
    // A small working set with an OOM that is not the context/capacity wording
    // is a misconfigured server, not a bloated request — ladder default.
    expect(classifyFailure(ev({ peakTokens: 20_000, errorMessage: "CUDA error: out of memory" }), BUDGET)).toBe("blip");
  });

  it("defaults empty/unknown evidence to blip", () => {
    expect(classifyFailure(ev(), BUDGET)).toBe("blip");
  });
});

describe("nextRung (#80)", () => {
  it("capacity at high peak skips identical retry and fails the phase, naming the token count", () => {
    const rung = nextRung(ev({ peakTokens: 95_000 }), 1, BUDGET, []);
    expect(rung.action).toBe("capacity-fail");
    expect(rung.rung).toBe(3);
    expect(rung.backoffSec).toBe(0);
    expect(rung.diagnosis).toContain("95000");
  });

  it("auth error hard-fails immediately with zero retries", () => {
    const rung = nextRung(ev({ errorMessage: "invalid api key" }), 1, BUDGET, []);
    expect(rung.action).toBe("hard-fail");
    expect(rung.backoffSec).toBe(0);
  });

  it("unknown blip on attempt 1 → rung 1 identical retry", () => {
    const rung = nextRung(ev({ status: "transient", errorMessage: "503 Service Unavailable" }), 1, BUDGET, []);
    expect(rung.rung).toBe(1);
    expect(rung.action).toBe("retry");
  });

  it("second consecutive blip → rung 2 restart-worker-then-retry", () => {
    const prior = ev({ status: "transient", errorMessage: "503 Service Unavailable" });
    const rung = nextRung(ev({ status: "transient", errorMessage: "503 Service Unavailable" }), 2, BUDGET, [prior]);
    expect(rung.rung).toBe(2);
    expect(rung.action).toBe("restart-worker-then-retry");
  });

  it("third consecutive blip → rung 3 diagnosed with an evidence summary", () => {
    const history = [ev({ status: "transient", peakTokens: 10_000 }), ev({ status: "transient", peakTokens: 10_000 })];
    const rung = nextRung(ev({ status: "transient", peakTokens: 10_000 }), 3, BUDGET, history);
    expect(rung.rung).toBe(3);
    expect(rung.action).toBe("hard-fail");
    expect(rung.diagnosis).toContain("3 attempts");
    expect(rung.diagnosis).toContain("10k");
  });

  it("empty evidence (bare step_start then exit 0) → ladder default, not capacity", () => {
    const rung = nextRung(ev({ status: "transient", code: 0 }), 1, BUDGET, []);
    expect(rung.rung).toBe(1);
    expect(rung.action).toBe("retry");
  });

  it("routes capacity wording as the tiebreaker when peak is just below the gate", () => {
    const rung = nextRung(ev({ peakTokens: 89_000, errorMessage: "context too long" }), 1, BUDGET, []);
    expect(rung.action).toBe("capacity-fail");
  });
});

describe("evidenceFromResult (#80 stage 2)", () => {
  it("composes evidence from an ExecResult-shaped value", () => {
    const evidence = evidenceFromResult({
      status: "timeout",
      errorMessage: "model-stalled",
      peakTokens: 52_000,
      steps: 20,
      toolCalls: 7,
      code: null,
      signal: "SIGTERM",
      durationMs: 900_000,
    });
    expect(evidence).toEqual({
      status: "timeout",
      errorMessage: "model-stalled",
      peakTokens: 52_000,
      steps: 20,
      toolCalls: 7,
      code: null,
      signal: "SIGTERM",
      durationMs: 900_000,
    });
  });
});

describe("withFailureLadder (#80 stage 3)", () => {
  const opts = (over: Partial<Parameters<typeof withFailureLadder>[1]> = {}) => ({
    backoff: [1, 2, 3],
    budget: BUDGET,
    restartWorker: async () => {},
    sleep: async () => {},
    ...over,
  });

  it("an operator abort suppresses the retry rung entirely — no sleep, no restart, clean terminal diagnosis", async () => {
    requestAbort();
    try {
      const restarts: number[] = [];
      const sleeps: number[] = [];
      let calls = 0;
      const result = await withFailureLadder(async () => {
        calls++;
        throw new PhaseFailure(ev({ status: "transient", errorMessage: "model produced 0 tokens (connection or provider failure)" }));
      }, opts({ restartWorker: async () => { restarts.push(calls); }, sleep: async (ms) => { sleeps.push(ms); } }));
      expect(calls).toBe(1);
      expect(restarts).toEqual([]);
      expect(sleeps).toEqual([]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rung.action).toBe("hard-fail");
        expect(result.rung.rung).toBe(3);
        expect(result.rung.diagnosis).toMatch(/operator stop — not retrying/);
      }
    } finally {
      clearStop();
    }
  });

  it("a soft stop alone still allows retries (the in-flight ticket finishes its gate)", async () => {
    // requestStop's soft state is the run loop's; the ladder must not treat it
    // as an abort.
    let calls = 0;
    const result = await withFailureLadder(async () => {
      calls++;
      if (calls === 1) throw new PhaseFailure(ev({ status: "transient", errorMessage: "503" }));
      return "done";
    }, opts());
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("retries a blip once then succeeds, without restarting the worker", async () => {
    const restarts: number[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withFailureLadder(async () => {
      calls++;
      if (calls === 1) throw new PhaseFailure(ev({ status: "transient", errorMessage: "503 Service Unavailable" }));
      return "done";
    }, opts({ restartWorker: async () => { restarts.push(calls); }, sleep: async (ms) => { sleeps.push(ms); } }));
    expect(result.ok).toBe(true);
    expect(restarts).toEqual([]);
    expect(sleeps).toEqual([1000]);
  });

  it("restarts the worker at rung 2 when a low-peak OOM persists", async () => {
    const restarts: number[] = [];
    let calls = 0;
    const result = await withFailureLadder(async () => {
      calls++;
      if (calls < 3) throw new PhaseFailure(ev({ status: "error", errorMessage: "CUDA error: out of memory", peakTokens: 20_000 }));
      return "done";
    }, opts({ restartWorker: async () => { restarts.push(calls); } }));
    expect(result.ok).toBe(true);
    expect(restarts).toEqual([2]);
  });

  it("stops at rung 3 hard-fail when the failure persists through restart", async () => {
    let restarts = 0;
    const result = await withFailureLadder(async () => {
      throw new PhaseFailure(ev({ status: "error", errorMessage: "connection reset by peer" }));
    }, opts({ restartWorker: async () => { restarts++; } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rung.rung).toBe(3);
      expect(result.rung.action).toBe("hard-fail");
      expect(result.evidence).toHaveLength(3);
    }
    expect(restarts).toBe(1);
  });

  it("fails immediately on a fatal config error with zero retries and zero restarts", async () => {
    let restarts = 0;
    const sleeps: number[] = [];
    const result = await withFailureLadder(async () => {
      throw new PhaseFailure(ev({ errorMessage: "invalid api key" }));
    }, opts({ restartWorker: async () => { restarts++; }, sleep: async (ms) => { sleeps.push(ms); } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rung.action).toBe("hard-fail");
    expect(restarts).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("capacity-fails on a high-peak OOM with a single invocation (no retry)", async () => {
    let calls = 0;
    const result = await withFailureLadder(async () => {
      calls++;
      throw new PhaseFailure(ev({ peakTokens: 95_000, errorMessage: "insufficient memory" }));
    }, opts());
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rung.action).toBe("capacity-fail");
  });

  it("synthesizes evidence from a non-PhaseFailure throw", async () => {
    const result = await withFailureLadder(async () => {
      throw new Error("model not found: foo/bar");
    }, opts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rung.action).toBe("hard-fail");
  });

  it("resumes at a persisted rung via startAttempt (skips rung 1)", async () => {
    let restarts = 0;
    let calls = 0;
    const result = await withFailureLadder(async () => {
      calls++;
      if (calls === 1) throw new PhaseFailure(ev({ status: "error", errorMessage: "connection reset by peer" }));
      return "done";
    }, opts({ startAttempt: 2, restartWorker: async () => { restarts++; } }));
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(restarts).toBe(1);
  });
});
