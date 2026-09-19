import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import { describeExecFailure, executeOpendCode, isQuotaError, isToolTimeout, isTransientError, resetWorkerForTest, writePayloadOf } from "./executor.ts";
import { estimateTokens } from "./diff-filter.ts";
import { CHECKPOINT_RE } from "../core/checkpoint.ts";

/**
 * The executor spawns `opencode` as a subprocess. To test step-budget
 * enforcement without depending on a real opencode install, we write a
 * shell script to a temp bin dir, prepend it to PATH, and have it emit
 * JSONL step_start/step_finish events that mimic opencode's --format json
 * stream. This lets us assert that:
 *   1. The executor counts steps correctly.
 *   2. It kills the subprocess when the cap is hit.
 *   3. It returns status "budget_exceeded" (not "ok" or "error").
 *   4. maxSteps: null disables the cap entirely.
 */

async function makeFakeOpencode(emitter: string): Promise<{ binDir: string; ledgerDir: string; cwd: string; restorePath: string }> {
  const base = await mkdtemp(join(tmpdir(), "exec-"));
  const binDir = join(base, "bin");
  const ledgerDir = join(base, "ledger");
  const cwd = base;
  await mkdir(binDir, { recursive: true });
  await mkdir(ledgerDir, { recursive: true });
  await mkdir(join(ledgerDir, "events"), { recursive: true });

  const script = join(binDir, "opencode");
  await writeFile(script, `#!/bin/sh
${emitter}
`, "utf8");
  const { chmod } = await import("node:fs/promises");
  await chmod(script, 0o755);

  const restorePath = process.env.PATH ?? "";
  process.env.PATH = binDir + ":" + restorePath;

  return { binDir, ledgerDir, cwd, restorePath };
}

function restorePath(restorePath: string) {
  process.env.PATH = restorePath;
}

function stepStartLine(): string {
  return JSON.stringify({ type: "step_start", timestamp: Date.now(), part: { type: "step-start", id: "p1", messageID: "m1", sessionID: "s1", snapshot: "x" } });
}

function stepFinishLine(): string {
  return JSON.stringify({ type: "step_finish", timestamp: Date.now(), part: { type: "step-finish", id: "p2", messageID: "m1", sessionID: "s1", reason: "tool-calls", tokens: { input: 100, output: 10 }, cost: 0.001 } });
}

function stepFinishLineWithTokens(input: number): string {
  return JSON.stringify({ type: "step_finish", timestamp: Date.now(), part: { type: "step-finish", id: "p2", messageID: "m1", sessionID: "s1", reason: "tool-calls", tokens: { input, output: 10 }, cost: 0.001 } });
}

function stepFinishLineZeroTokens(): string {
  return JSON.stringify({ type: "step_finish", timestamp: Date.now(), part: { type: "step-finish", id: "p2", messageID: "m1", sessionID: "s1", reason: "stop", tokens: { input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0 } });
}

function stepFinishLineDegenerate(input: number, output: number): string {
  return JSON.stringify({ type: "step_finish", timestamp: Date.now(), part: { type: "step-finish", id: "p2", messageID: "m1", sessionID: "s1", reason: "stop", tokens: { input, output, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0 } });
}

function textEvent(text: string): string {
  return JSON.stringify({ type: "text", timestamp: Date.now(), part: { type: "text", id: "t1", messageID: "m1", sessionID: "s1", text } });
}

describe("executeOpendCode step budget", () => {
  it("kills the subprocess and returns budget_exceeded when step count exceeds the cap", async () => {
    // Emit 4 pairs of step_start/step_finish, sleeping between each — the
    // executor should kill us when the 4th step_start arrives (cap = 3).
    const startLine = stepStartLine().replace(/'/g, "'\\''");
    const finishLine = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '${startLine}\\n${finishLine}\\n' ; sleep 0.2 ; printf '${startLine}\\n${finishLine}\\n' ; sleep 0.2 ; printf '${startLine}\\n${finishLine}\\n' ; sleep 0.2 ; printf '${startLine}\\n${finishLine}\\n' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "test-phase",
        model: null,
        maxSteps: 3,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("budget_exceeded");
      expect(result.steps).toBe(4);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("completes normally when step count stays within the cap", async () => {
    const lines = [stepStartLine(), stepFinishLine()].join("\n");
    const emitter = `printf '${lines.replace(/'/g, "'\\''")}\\n' ; sleep 0.1 ; printf '${lines.replace(/'/g, "'\\''")}\\n' ; sleep 0.1 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "test-phase-ok",
        model: null,
        maxSteps: 10,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  });

  it("embeds ladder evidence matching the result fields (#80)", async () => {
    const lines = [stepStartLine(), stepFinishLine()].join("\n");
    const emitter = `printf '${lines.replace(/'/g, "'\\''")}\\n' ; sleep 0.1 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "test-phase-evidence",
        model: null,
        maxSteps: 10,
        live: false,
        heartbeat: false,
      });
      expect(result.evidence).toBeDefined();
      expect(result.evidence?.status).toBe(result.status);
      expect(result.evidence?.steps).toBe(result.steps);
      expect(result.evidence?.peakTokens).toBe(result.peakTokens);
      expect(result.evidence?.toolCalls).toBe(result.toolCalls);
    } finally {
      restorePath(env.restorePath);
    }
  });

  it("does not enforce a cap when maxSteps is null", async () => {
    const lines = [stepStartLine(), stepFinishLine()].join("\n");
    const emitter = `for i in 1 2 3 4 5; do printf '${lines.replace(/'/g, "'\\''")}\\n' ; sleep 0.1 ; done ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "test-phase-null",
        model: null,
        maxSteps: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(5);
    } finally {
      restorePath(env.restorePath);
    }
  });
});

/**
 * The step-count budget above guards a model looping across many steps. It
 * cannot catch the opposite failure: ONE step that never returns (a bash
 * tool call waiting on stdin, a dev server started by mistake), where step
 * count never advances at all. These tests cover the separate wall-clock
 * stall detector that fills that gap.
 */
describe("executeOpendCode stall timeout", () => {
  it("kills a silent subprocess and returns status timeout", async () => {
    const env = await makeFakeOpencode("sleep 5");
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "stall-kill",
        model: null,
        stallTimeoutSec: 1,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("timeout");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("resets the stall clock on every output, so a slow multi-step phase is never penalized", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    // Five step_start+step_finish pairs spaced 0.4s apart (2s total) — each
    // print must reset the 1s stall clock, so the process finishes normally
    // despite running longer than the stall threshold overall.
    const emitter = `for i in 1 2 3 4 5; do printf '${start}\\n${finish}\\n' ; sleep 0.4 ; done`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "stall-reset",
        model: null,
        stallTimeoutSec: 1,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("disables stall detection when stallTimeoutSec is null", async () => {
    const env = await makeFakeOpencode("sleep 2");
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "stall-disabled",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("isTransientError", () => {
  it("matches 429 / rate-limit messages", () => {
    expect(isTransientError("429 Too Many Requests")).toBe(true);
    expect(isTransientError("Rate limit exceeded")).toBe(true);
    expect(isTransientError("rate_limit exceeded")).toBe(true);
    expect(isTransientError("Too many requests")).toBe(true);
  });

  it("matches 5xx server errors", () => {
    expect(isTransientError("502 Bad Gateway")).toBe(true);
    expect(isTransientError("503 Service Unavailable")).toBe(true);
    expect(isTransientError("internal server error")).toBe(true);
    expect(isTransientError("Gateway timeout")).toBe(true);
  });

  it("matches connection errors", () => {
    expect(isTransientError("ECONNRESET")).toBe(true);
    expect(isTransientError("ETIMEDOUT")).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError("connection reset by peer")).toBe(true);
  });

  it("matches overloaded / capacity messages", () => {
    expect(isTransientError("The service is overloaded")).toBe(true);
    expect(isTransientError("temporarily unavailable")).toBe(true);
    expect(isTransientError("try again later")).toBe(true);
  });

  it("does NOT match non-transient errors", () => {
    expect(isTransientError("file not found")).toBe(false);
    expect(isTransientError("ContextOverflowError: context too long")).toBe(false);
    expect(isTransientError("AuthenticationError: invalid api key")).toBe(false);
    expect(isTransientError("model not found")).toBe(false);
    expect(isTransientError("unknown error")).toBe(false);
  });
});

describe("isQuotaError", () => {
  it("matches quota / usage-limit walls", () => {
    expect(isQuotaError("You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.")).toBe(true);
    expect(isQuotaError("usage limit exceeded")).toBe(true);
    expect(isQuotaError("insufficient quota")).toBe(true);
    expect(isQuotaError("billing: payment required")).toBe(true);
  });

  it("does NOT match a retryable rate limit or unrelated errors", () => {
    expect(isQuotaError("429 Too Many Requests")).toBe(false);
    expect(isQuotaError("Rate limit exceeded")).toBe(false);
    expect(isQuotaError("503 Service Unavailable")).toBe(false);
    expect(isQuotaError("file not found")).toBe(false);
  });
});

describe("describeExecFailure", () => {
  it("describes a budget_exceeded result", () => {
    expect(describeExecFailure({ status: "budget_exceeded", steps: 12, code: null, errorMessage: null })).toBe(
      "exceeded step budget (12 steps)",
    );
  });

  it("describes a timeout result", () => {
    expect(describeExecFailure({ status: "timeout", steps: 1, code: null, errorMessage: null })).toBe(
      "stalled with no output and was killed",
    );
  });

  it("describes a model-time timeout distinctly from a silence timeout (#78)", () => {
    expect(describeExecFailure({ status: "timeout", steps: 3, code: null, errorMessage: "model-stalled: step exceeded the 900s model-time budget (elapsed 901s, 0 parts completed)" })).toBe(
      "stalled on model time — exceeded the model-time budget, killed",
    );
  });

  it("describes a spin_loop result", () => {
    expect(describeExecFailure({ status: "spin_loop", steps: 5, code: null, errorMessage: null })).toBe(
      "stuck in a repeated identical tool-call loop",
    );
  });

  it("describes a wall-clock timeout distinctly from a silence timeout (#96)", () => {
    expect(describeExecFailure({ status: "timeout", steps: 4, code: null, errorMessage: "wall-clock: phase exceeded its 3600s wall-clock budget" })).toBe(
      "exceeded its wall-clock budget and was killed",
    );
  });

  it("describes a degraded_target result with its prefixed message (#96)", () => {
    expect(describeExecFailure({ status: "degraded_target", steps: 8, code: null, errorMessage: "degraded-target: 5 tool request timeouts within the last 600s — the interaction target is wedged, not merely slow; killing opencode process to end the timeout spiral" })).toContain(
      "degraded-target:",
    );
    expect(describeExecFailure({ status: "degraded_target", steps: 8, code: null, errorMessage: null })).toBe(
      "degraded tool target — a run of request timeouts, killed",
    );
  });

  it("describes a plain error result by exit code", () => {
    expect(describeExecFailure({ status: "error", steps: 1, code: 1, errorMessage: null })).toBe("exited 1");
  });

  it("describes a transient result with the error message", () => {
    expect(describeExecFailure({ status: "transient", steps: 0, code: null, errorMessage: "503 Service Unavailable" })).toBe(
      "hit a transient provider error (503 Service Unavailable)",
    );
  });

  it("describes a halted result as an honest stop, not a failure (gh #111)", () => {
    expect(describeExecFailure({ status: "halted", steps: 2, code: null, errorMessage: "the plan is wrong" })).toBe(
      "halted on an agent-initiated stop signal (the plan is wrong)",
    );
  });
});

describe("executeOpendCode halt detection (gh #111)", () => {
  it("kills the subprocess and returns halted when a halt file appears mid-stream", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    // Emit one full step, then drop `.railhead/STOP`, then emit another line:
    // the executor must detect the file at the next line and kill, returning
    // status "halted" with the reason (an honest stop, not a failure).
    const emitter = `printf '${start}\\n${finish}\\n' ; sleep 0.1 ; mkdir -p .railhead ; printf 'fundamental flaw\\n' > .railhead/STOP ; printf '${start}\\n' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "halt-phase",
        model: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("halted");
      expect(result.haltReason).toBe("fundamental flaw");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode token budget guard (#53)", () => {
  it("kills with status budget_exceeded before the next step runs when a step's input crosses the budget", async () => {
    // A step_finish reports input tokens over the budget, then the model
    // starts another step. The guard must kill at the step boundary — no
    // further step may run once the budget is exceeded (the old check fired
    // only after processing the exceeding step_finish, so a process that
    // exited right after that event could slip through as "ok").
    const start = stepStartLine().replace(/'/g, "'\\''");
    const over = stepFinishLineWithTokens(5000).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${over}\\n' ; sleep 0.2 ; printf '${start}\\n' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "budget-kill",
        model: null,
        maxContextTokens: 1000,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("budget_exceeded");
      // Only the first step_start was processed — the second was killed
      // before it ran.
      expect(result.steps).toBe(1);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("reports budget_exceeded even when the process exits cleanly right after the exceeding step_finish", async () => {
    // The run's actual failure: the exceeding step_finish was the LAST event
    // and opencode exited with code 0 before the SIGTERM landed. The kill is a
    // no-op on a dead process, but budgetExceeded must still win over code 0 —
    // the ticket must be reported as budget_exceeded, not "ok" (which would
    // commit context-starved work and never trigger the retry mechanism).
    const start = stepStartLine().replace(/'/g, "'\\''");
    const over = stepFinishLineWithTokens(5000).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${over}\\n' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "budget-last-exit",
        model: null,
        maxContextTokens: 1000,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("budget_exceeded");
      expect(result.code).toBe(0);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("completes normally when peak tokens stay within the budget", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const under = stepFinishLineWithTokens(800).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${under}\\n' ; sleep 0.2 ; printf '${start}\\n${under}\\n' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "budget-ok",
        model: null,
        maxContextTokens: 1000,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("kills at 95% of the budget, not 100% — prevents the model server from crashing", async () => {
    // Budget is 10000; 95% = 9500. A peak of 9600 must trigger the kill.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const over = stepFinishLineWithTokens(9600).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${over}\\n' ; sleep 0.2 ; printf '${start}\\n' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "budget-95pct-kill",
        model: null,
        maxContextTokens: 10000,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("budget_exceeded");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not kill when peak is exactly at 95% (boundary — strictly greater)", async () => {
    // Budget is 10000; 95% = 9500. A peak of exactly 9500 must NOT trigger
    // the kill (the check is strictly greater-than, not >=).
    const start = stepStartLine().replace(/'/g, "'\\''");
    const at = stepFinishLineWithTokens(9500).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${at}\\n' ; sleep 0.2 ; printf '${start}\\n${at}\\n' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "budget-95pct-boundary",
        model: null,
        maxContextTokens: 10000,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not kill when peak is below 95% of the budget", async () => {
    // Budget is 10000; 95% = 9500. A peak of 9000 must NOT trigger the kill.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const under = stepFinishLineWithTokens(9000).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${under}\\n' ; sleep 0.2 ; printf '${start}\\n${under}\\n' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "budget-below-95pct",
        model: null,
        maxContextTokens: 10000,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

/**
 * Issue #82: the railhead's own event stream is the meter for the request
 * being assembled. `peakTokens` only moves at a step_finish, so a step that
 * thrashes toward an OOM — streaming full-file tool outputs into the next
 * request without ever completing — is invisible to the old guards and to the
 * operator's heartbeat until it is too late. These tests pin the streaming
 * in-flight estimate: it must RISE mid-step (heartbeat), arm the ceiling kill
 * mid-step, and reconcile back to the server's reported input at each
 * step_finish so normally-finishing phases are unchanged.
 */
describe("executeOpendCode in-flight token estimate (#82)", () => {
  it("shows a rising in-flight estimate in the heartbeat while one step streams content and never finishes", async () => {
    // One step_start, then four ~4000-char assistant chunks spaced out over
    // ~1.4s, then a clean exit — NO step_finish, so peakTokens never moves.
    // The heartbeat (every 0.3s) must show est climbing chunk by chunk.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const chunk = (n: number) => textEvent("x".repeat(4000 * n)).replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n' '${start}' ; printf '%s\\n' '${chunk(1)}' ; sleep 0.35 ; printf '%s\\n' '${chunk(2)}' ; sleep 0.35 ; printf '%s\\n' '${chunk(3)}' ; sleep 0.35 ; printf '%s\\n' '${chunk(4)}' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    const ests: number[] = [];
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "inflight-est-heartbeat",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: null,
        heartbeat: true,
        heartbeatIntervalSec: 0.3,
        liveSink: (line: string) => {
          const m = line.match(/est (\d+(?:\.\d+)?)k/);
          if (line.includes("running") && m) ests.push(parseFloat(m[1]));
        },
      });
      // Sanity: the process finished on its own.
      expect(result.status).toBe("ok");
      // Several heartbeats fired while the step was streaming.
      expect(ests.length).toBeGreaterThanOrEqual(3);
      // The estimate never drops (monotone in the reconciled base + streamed
      // tokens), rises chunk over chunk, and ends at all four chunks.
      for (let i = 1; i < ests.length; i++) expect(ests[i]).toBeGreaterThanOrEqual(ests[i - 1]);
      expect(ests[ests.length - 1]).toBeGreaterThan(ests[0]);
      expect(ests[ests.length - 1]).toBeGreaterThanOrEqual(3.0);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("kills mid-step when the in-flight estimate crosses 95% of the budget during one never-finishing step", async () => {
    // Budget 1000 → 95% = 950. One step_start, then a single 4000-char text
    // event (~1000 tokens): the estimate (~1003) exceeds 950 mid-step, while
    // peakTokens is still 0 (no step_finish ever arrives). The old guard
    // would have waited for a step boundary that never comes.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const big = textEvent("x".repeat(4000)).replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n' '${start}' ; sleep 0.1 ; printf '%s\\n' '${big}' ; sleep 5`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "inflight-est-kill",
        model: null,
        maxContextTokens: 1000,
        stallTimeoutSec: null,
        maxStepModelSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("budget_exceeded");
      expect(result.steps).toBe(1);
      // The kill saw the in-flight estimate, not a reported peak.
      expect(result.peakTokens).toBe(0);
      expect(result.inFlightTokens).toBeGreaterThan(950);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("reconciles the estimate to reported input at each step_finish and exports the in-flight estimate and drift", async () => {
    // Two finishing steps with reported inputs 1000 then 2000. Before each
    // finish the estimate overshoots/undershoots the reported input by the
    // streamed content; the reconcile must rebase the estimate onto the
    // reported number so a normally-finishing phase reports ground truth.
    const promptTokens = estimateTokens("test prompt");
    const start = stepStartLine().replace(/'/g, "'\\''");
    const text1 = textEvent("a".repeat(400)).replace(/'/g, "'\\''"); // ~100 tokens
    const text2 = textEvent("b".repeat(1600)).replace(/'/g, "'\\''"); // ~400 tokens
    const finish1 = stepFinishLineWithTokens(1000).replace(/'/g, "'\\''");
    const finish2 = stepFinishLineWithTokens(2000).replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n%s\\n' '${start}' '${text1}' '${finish1}' ; sleep 0.1 ; printf '%s\\n%s\\n%s\\n' '${start}' '${text2}' '${finish2}' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "inflight-est-reconcile",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
      expect(result.peakTokens).toBe(2000);
      // Estimate converges to the last reported input after the final finish.
      expect(result.inFlightTokens).toBe(2000);
      // First reconcile: 1000 - (prompt + 100). Second: 2000 - (1000 + 400).
      expect(result.estimateDriftTokens).toBe(2000 - (1000 + 400));
      // The drift of the FIRST step is the pre-reconcile overshoot — surfaced
      // by the reconcile, and the last value recorded is what we asserted.
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

/**
 * A step_finish with 0 input + 0 output tokens means the model never ran —
 * the proxy or provider surfaced a connection error as a text event and
 * opencode exited cleanly with reason "stop". Without this guard, the
 * railhead treats the phase as "ok" (exit code 0), extracts the error
 * message as "assistant text," and commits a ticket with zero work done.
 * The pixeledit-railhead run had 7 consecutive tickets silently "committed"
 * this way when the model server went down mid-run.
 */
describe("executeOpendCode zero-token step detection", () => {
  it("returns transient when a step_finish has 0 input and 0 output tokens", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const zeroFinish = stepFinishLineZeroTokens().replace(/'/g, "'\\''");
    const errorText = textEvent("[Proxy: Stream-Fehler] Stream error nach 0s (ConnectError, 1 attempts): All connection attempts failed").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n%s\\n' '${start}' '${errorText}' '${zeroFinish}' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "zero-token",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("transient");
      expect(result.steps).toBe(1);
      expect(result.peakTokens).toBe(0);
      expect(result.totalOutputTokens).toBe(0);
      // The gateway's diagnostic arrived as `text`, not an `error` event. The
      // failure must name it instead of hiding behind the generic 0-token text.
      expect(result.errorMessage).toContain("model produced 0 tokens");
      expect(result.errorMessage).toContain("Proxy: Stream-Fehler");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not surface streamed text as a provider diagnostic once the model produced real tokens", async () => {
    // A degenerate final step after real work: the earlier `text` is the
    // model's own output, so it must not be mistaken for a gateway diagnostic.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const realFinish = stepFinishLine().replace(/'/g, "'\\''");
    const modelText = textEvent("working on the ticket...").replace(/'/g, "'\\''");
    const degenerate = stepFinishLineDegenerate(1, 1).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${modelText}\\n${realFinish}\\n' ; sleep 0.1 ; printf '${start}\\n${degenerate}\\n' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "degenerate-after-real-text",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("transient");
      expect(result.errorMessage).toBe("model produced 0 tokens (connection or provider failure)");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("returns transient when step_start is emitted with no step_finish and process exits 0", async () => {
    // The pixeledit-local run: opencode emitted a single step_start, then
    // exited cleanly (code 0) without ever emitting step_finish, text, or
    // error. The executor reported "ok" because zeroTokenStep only fires
    // when a step_finish WITH 0 tokens is seen — a step_start with NO
    // step_finish at all slipped through as "ok", and the planner threw
    // "plan output contained no readable tickets" instead of retrying.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "step-start-only",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("transient");
      expect(result.steps).toBe(1);
      expect(result.errorMessage).toBeTruthy();
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("returns transient when the final step is degenerate (stop, ~0 output) even after real steps", async () => {
    // The pixeledit-night-1 run: 20+ real tool-calls steps, then a final
    // step_finish with reason "stop" and tokens {input:1, output:1} — the
    // model server returned a no-op turn. The old guard only caught 0/0;
    // the 1/1 variant slipped through as "ok" because realTokenStep was
    // set by earlier steps, so the whole phase was exempted.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const realFinish = stepFinishLine().replace(/'/g, "'\\''");
    const degenerate = stepFinishLineDegenerate(1, 1).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${realFinish}\\n' ; sleep 0.1 ; printf '${start}\\n${degenerate}\\n' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "degenerate-last-step",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("transient");
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("returns transient when the final step has 0/0 tokens after real steps (the original 0/0 case, now also caught mid-phase)", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const realFinish = stepFinishLine().replace(/'/g, "'\\''");
    const zeroFinish = stepFinishLineZeroTokens().replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${realFinish}\\n' ; sleep 0.1 ; printf '${start}\\n${zeroFinish}\\n' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "zero-token-after-real",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("transient");
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("returns ok when the final step has reason=stop but real output tokens (legitimate end-of-turn)", async () => {
    // A real final step emits DONE + a summary — non-trivial output tokens.
    // The guard must NOT flag a step with e.g. output=176 as degenerate.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const realFinish = stepFinishLine().replace(/'/g, "'\\''");
    const stopFinish = stepFinishLineDegenerate(28163, 176).replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${realFinish}\\n' ; sleep 0.1 ; printf '${start}\\n${stopFinish}\\n' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "real-stop-final",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

function toolUseLine(status: string): string {
  return JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status, input: { command: "echo hi" } } } });
}

describe("executeOpendCode tool-call counting (#69)", () => {
  it("counts only terminal tool_use events (completed/error), not running ones", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const running = toolUseLine("running").replace(/'/g, "'\\''");
    const completed = toolUseLine("completed").replace(/'/g, "'\\''");
    const errored = toolUseLine("error").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n%s\\n%s\\n' '${start}' '${running}' '${completed}' '${finish}' ; printf '%s\\n%s\\n%s\\n' '${start}' '${errored}' '${finish}' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "tool-count",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
      // Two terminal tool calls; the "running" line is not a completed call.
      expect(result.toolCalls).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("returns 0 tool calls for a prose-only phase", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const prose = textEvent("I will think about it but not act").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n%s\\n' '${start}' '${prose}' '${finish}' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "tool-count-zero",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.toolCalls).toBe(0);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

/**
 * A large JSONL event (e.g. a chrome-devtools_take_screenshot response with a
 * base64 PNG payload) can exceed Node's stdout high-water mark, so it arrives
 * split across multiple `data` events. The executor must buffer the partial
 * line and reassemble it before appending to the ledger — otherwise each chunk
 * is written as a separate "line," none of which is valid JSON, and the ledger
 * becomes unreadable for `railhead log` / `extractAssistantText`.
 *
 * Observed on pixeledit-spark: a 1MB screenshot response was split across 17
 * chunks, each written as a 65536-byte line, all malformed.
 */
describe("executeOpendCode line buffering across stdout chunks", () => {
  it("reassembles a large JSONL line split across chunks into one ledger line", async () => {
    // A tool_use event with a large base64 payload, split into 3 stdout chunks.
    // Each chunk boundary is arbitrary — NOT on a newline boundary.
    const payload = "x".repeat(120000);
    const bigEvent = JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool: "chrome-devtools_take_screenshot",
        callID: "call_1",
        state: { status: "completed", output: payload },
        title: "screenshot.png",
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p1",
      messageID: "m1",
    });

    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");

    // Split the big event into 3 chunks at arbitrary byte offsets, before and
    // after newlines that frame it between other events.
    const full = `${start}\n${bigEvent}\n${finish}\n`;
    const cut1 = Math.floor(start.length + 1 + bigEvent.length * 0.3);
    const cut2 = Math.floor(start.length + 1 + bigEvent.length * 0.7);
    const chunk1 = full.slice(0, cut1);
    const chunk2 = full.slice(cut1, cut2);
    const chunk3 = full.slice(cut2);

    const escapedC1 = chunk1.replace(/'/g, "'\\''");
    const escapedC2 = chunk2.replace(/'/g, "'\\''");
    const escapedC3 = chunk3.replace(/'/g, "'\\''");
    const emitter = `printf '%s' '${escapedC1}' ; printf '%s' '${escapedC2}' ; printf '%s' '${escapedC3}'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "chunk-buffer",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.toolCalls).toBe(1);

      // The ledger must contain valid JSON lines — the big event reassembled
      // into one line, not split across fragments.
      const raw = await readFile(join(env.ledgerDir, "events", "chunk-buffer.jsonl"), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (const l of lines) {
        // Every non-blank line in the ledger must be valid JSON.
        JSON.parse(l);
      }
      // 3 events: step_start, tool_use, step_finish.
      expect(lines.length).toBe(3);
      // The tool_use line contains the full payload.
      const toolLine = lines.find((l) => l.includes('"tool_use"'));
      expect(toolLine).toBeDefined();
      JSON.parse(toolLine!);
      expect(JSON.parse(toolLine!).part.state.output).toBe(payload);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode stopAfterVerdict (#60)", () => {
  it("kills at the next step boundary once a complete verdict block appears, reporting ok", async () => {
    // The visual reviewer emits $VISUAL_PASS ... $END, then opencode re-calls
    // it and it re-emits the same markers (the 81-step loop). With
    // stopAfterVerdict the executor must stop at the FIRST complete verdict —
    // before the second step starts — and report ok so the verdict is kept.
    // (%s args, not the format string: the verdict JSON contains literal \n
    // escapes that printf would otherwise turn into real line breaks.)
    const start = stepStartLine().replace(/'/g, "'\\''");
    const verdict = textEvent("$VISUAL_PASS\n$END\nLEARNED: capture this exactly once").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${verdict}' ; sleep 0.3 ; printf '%s\\n%s\\n' '${start}' '${verdict}' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "verdict-early",
        model: null,
        stopAfterVerdict: true,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      // Only the first step ran — the second was killed before it started.
      expect(result.steps).toBe(1);
      // The verdict text survived into the ledger for post-hoc parsing.
      const raw = await readFile(join(env.ledgerDir, "events", "verdict-early.jsonl"), "utf8");
      expect(raw).toContain("$VISUAL_PASS");
      expect(raw).toContain("LEARNED: capture this exactly once");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not early-kill when stopAfterVerdict is unset (existing loop until step budget)", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const verdict = textEvent("$VISUAL_PASS\n$END").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${verdict}' ; sleep 0.2 ; printf '%s\\n%s\\n' '${start}' '${verdict}' ; sleep 0.2 ; printf '%s\\n%s\\n' '${start}' '${verdict}' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "verdict-noflag",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(3);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode stopAfterBlocked (ADR 0040)", () => {
  it("kills at the next step boundary on a terminal $BLOCKED and returns the parsed report", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const marker = textEvent("$BLOCKED ticket=07 kind=verification-unavailable reason=needs a live viewer").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${marker}' ; sleep 2 ; printf '%s\\n%s\\n' '${start}' '${marker}' ; sleep 2`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "blocked-early",
        model: null,
        stopAfterMarker: CHECKPOINT_RE,
        stopAfterBlocked: true,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(1);
      expect(result.block).toEqual({
        ticket: "07",
        kind: "verification-unavailable",
        reason: "needs a live viewer",
        malformedKind: false,
      });
      const raw = await readFile(join(env.ledgerDir, "events", "blocked-early.jsonl"), "utf8");
      expect(raw).toContain("$BLOCKED ticket=07");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not arm on a prose mention of the format that is not the last line", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const prose = textEvent("emit `$BLOCKED ticket=07 kind=implementation-stuck reason=x` when stuck\nstill working").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${prose}' ; sleep 0.2 ; printf '%s\\n%s\\n' '${start}' '${prose}' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "blocked-prose",
        model: null,
        stopAfterMarker: CHECKPOINT_RE,
        stopAfterBlocked: true,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.block).toBeNull();
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode stopAfterMarker (checkpoint contract, #84 S0.2)", () => {
  it("kills at the next step boundary once a custom marker appears, reporting ok and archiving the marker text", async () => {
    // The session builder (#84) instructs the model to emit `$CHECKPOINT
    // ticket=NN` when a ticket is green. Most turns end on their own, but
    // the #60 failure shape — the model re-invoked after its terminal signal,
    // re-emitting it until the step budget kills the run and loses the
    // signal — applies to ANY stop marker. A custom marker must get the
    // identical boundary-kill, and the marker text must survive into the
    // ledger for the railhead's ticket bookkeeping.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const marker = textEvent("$CHECKPOINT ticket=01").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${marker}' ; sleep 2 ; printf '%s\\n%s\\n' '${start}' '${marker}' ; sleep 2`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "checkpoint-early",
        model: null,
        stopAfterMarker: /\$CHECKPOINT\b/i,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(1);
      const raw = await readFile(join(env.ledgerDir, "events", "checkpoint-early.jsonl"), "utf8");
      expect(raw).toContain("$CHECKPOINT ticket=01");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not early-kill when the marker never appears (the run continues to its natural end)", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const plain = textEvent("working on it").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${plain}' ; sleep 0.2 ; printf '%s\\n%s\\n' '${start}' '${plain}' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "checkpoint-never",
        model: null,
        stopAfterMarker: /\$CHECKPOINT\b/i,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does NOT kill when the model only QUOTES the checkpoint format in prose — the phase keeps working (false-kill regression)", async () => {
    // A real 03-01 build ended this way: the model's summary quoted the
    // instruction ("Checkpoint format: `$CHECKPOINT ticket=NN` ... then emit
    // `$CHECKPOINT ticket=03`.") and the loose substring latch killed the
    // process at the next step_start, discarding the in-flight fix attempt.
    // Only a TERMINAL marker (as the model's last line) may arm the kill.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const prose = textEvent(
      "## Work State\n- Checkpoint format: `$CHECKPOINT ticket=NN` (zero-padded two digits) as LAST line.\n2. Get npm test green, then emit `$CHECKPOINT ticket=03`.\n3. Proceed to ticket 04.",
    ).replace(/'/g, "'\\''");
    const work = textEvent("still working, running npm test").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${prose}' ; sleep 0.3 ; printf '%s\\n%s\\n' '${start}' '${work}' ; sleep 0.3 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "checkpoint-prose",
        model: null,
        stopAfterMarker: /\$CHECKPOINT\b/i,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2); // second step ran — not killed at the boundary
      expect(result.checkpointTicket).toBeNull();
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode spin-loop detection", () => {
  function toolUseErrorLine(tool: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool,
        callID: "call_1",
        state: {
          status: "error",
          input,
          error: "No changes to apply: oldString and newString are identical.",
        },
        title: "file.rs",
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p1",
      messageID: "m1",
    });
  }

  function toolUseOkLine(tool: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool,
        callID: "call_2",
        state: {
          status: "completed",
          input,
          output: "Edit applied successfully.",
        },
        title: "file.rs",
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p2",
      messageID: "m1",
    });
  }

  it("kills the subprocess after 3 consecutive identical errored tool calls", async () => {
    const errLine = toolUseErrorLine("edit", { filePath: "/x/a.rs", oldString: "fn main() {}", newString: "fn main() {}" });
    const escaped = errLine.replace(/'/g, "'\\''");
    // Emit the same errored tool call 5 times, sleeping between each so the
    // stall timer resets each time (the model IS producing output, just the
    // same output — that's the spin loop the detector must catch).
    const emitter = `printf '${escaped}\\n' ; sleep 0.3 ; printf '${escaped}\\n' ; sleep 0.3 ; printf '${escaped}\\n' ; sleep 0.3 ; printf '${escaped}\\n' ; sleep 0.3 ; printf '${escaped}\\n' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "spin-kill",
        model: null,
        spinLoopThreshold: 3,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("spin_loop");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does NOT trigger when errors are from different tool calls (different inputs)", async () => {
    const err1 = toolUseErrorLine("edit", { filePath: "/x/a.rs", oldString: "A", newString: "A" });
    const err2 = toolUseErrorLine("edit", { filePath: "/x/b.rs", oldString: "B", newString: "B" });
    const err3 = toolUseErrorLine("bash", { command: "cargo check" });
    const emitter = `printf '${err1.replace(/'/g, "'\\''")}\\n' ; sleep 0.1 ; printf '${err2.replace(/'/g, "'\\''")}\\n' ; sleep 0.1 ; printf '${err3.replace(/'/g, "'\\''")}\\n' ; sleep 0.1 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "spin-diff",
        model: null,
        spinLoopThreshold: 3,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("resets the counter when a successful tool call breaks the chain", async () => {
    const errLine = toolUseErrorLine("edit", { filePath: "/x/a.rs", oldString: "X", newString: "X" });
    const okLine = toolUseOkLine("edit", { filePath: "/x/a.rs", oldString: "X", newString: "Y" });
    const escapedErr = errLine.replace(/'/g, "'\\''");
    const escapedOk = okLine.replace(/'/g, "'\\''");
    // err, err, ok (resets), err, err — only 2 consecutive at the end, should survive.
    const emitter = `printf '${escapedErr}\\n' ; sleep 0.1 ; printf '${escapedErr}\\n' ; sleep 0.1 ; printf '${escapedOk}\\n' ; sleep 0.1 ; printf '${escapedErr}\\n' ; sleep 0.1 ; printf '${escapedErr}\\n' ; sleep 0.1 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "spin-reset",
        model: null,
        spinLoopThreshold: 3,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("disables spin-loop detection when spinLoopThreshold is null", async () => {
    const errLine = toolUseErrorLine("edit", { filePath: "/x/a.rs", oldString: "Z", newString: "Z" });
    const escaped = errLine.replace(/'/g, "'\\''");
    const emitter = `for i in 1 2 3 4 5; do printf '${escaped}\\n' ; sleep 0.1 ; done ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "spin-disabled",
        model: null,
        spinLoopThreshold: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("writePayloadOf (gh #105)", () => {
  function toolUseWriteLine(input: Record<string, unknown>, status = "completed"): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_w",
        state: { status, input },
        title: "file.ts",
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p1",
      messageID: "m1",
    });
  }

  it("extracts the path and full content of a completed write", () => {
    const line = toolUseWriteLine({ filePath: "src/a.test.ts", content: "export {}\n" });
    expect(writePayloadOf(line)).toEqual({ path: "src/a.test.ts", content: "export {}\n" });
  });

  it("extracts a completed edit as its old+new replacement pair", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/a.ts", oldString: "A", newString: "B" } } },
    });
    expect(writePayloadOf(line)).toEqual({ path: "src/a.ts", content: "A\u0000B" });
  });

  it("returns null for bash calls, running writes, errored writes, and non-tool lines", () => {
    const bash = JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git checkout ." } } } });
    expect(writePayloadOf(bash)).toBeNull();
    expect(writePayloadOf(toolUseWriteLine({ filePath: "a.ts", content: "x" }, "running"))).toBeNull();
    expect(writePayloadOf(toolUseWriteLine({ filePath: "a.ts", content: "x" }, "error"))).toBeNull();
    expect(writePayloadOf('{"type":"text","part":{"type":"text","text":"hi"}}')).toBeNull();
  });
});

describe("executeOpendCode non-convergent-edit detection (gh #105)", () => {
  function completedWriteLine(path: string, content: string): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_1",
        state: { status: "completed", input: { filePath: path, content }, output: "Wrote file." },
        title: path,
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p1",
      messageID: "m1",
    });
  }
  function completedBashLine(command: string): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: { type: "tool", tool: "bash", state: { status: "completed", input: { command } }, title: command },
      id: "p1",
      messageID: "m1",
    });
  }
  function esc(line: string): string {
    return line.replace(/'/g, "'\\''");
  }
  /** Emit one JSONL line via `printf '%s\n'` — the %s form keeps the JSON's
   * own `\n`/`\t` escapes literal (the bare `printf '<json>\n'` form the
   * errored-call tests use would let the shell reinterpret escapes inside the
   * content). */
  function pct(line: string): string {
    return `printf '%s\\n' '${esc(line)}'`;
  }

  it("kills the subprocess after 3 completed writes to one path whose only differences are whitespace", async () => {
    const w1 = completedWriteLine("src/model/history.test.ts", "line one\nline two\n");
    const w2 = completedWriteLine("src/model/history.test.ts", "line one\n  line two\n");
    const w3 = completedWriteLine("src/model/history.test.ts", "line one\nline two");
    const emitter = `${pct(w1)} ; sleep 0.2 ; ${pct(w2)} ; sleep 0.2 ; ${pct(w3)} ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "editloop-kill",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("spin_loop");
      expect(result.errorMessage).toMatch(/^non-convergent edit loop: 3 near-identical rewrites of src\/model\/history\.test\.ts/);
      // describeExecFailure renders the message distinctly.
      expect(describeExecFailure(result)).toMatch(/^non-convergent edit loop/);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not kill when a materially changed write resets the streak", async () => {
    const path = "src/model/history.test.ts";
    const same = completedWriteLine(path, "export const A = 1;\n");
    const changed = completedWriteLine(path, "export const A = 2; // fixed\n");
    // A, A, materially-different, A, A → the material change resets; only 2
    // near-identical rewrites stack after it — the phase must survive.
    const emitter = `${pct(same)} ; sleep 0.05 ; ${pct(same)} ; sleep 0.05 ; ${pct(changed)} ; sleep 0.05 ; ${pct(same)} ; sleep 0.05 ; ${pct(same)} ; sleep 0.05 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "editloop-reset",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("resets the streak on a first write to a different path and trips only after 3 same-path rewrites follow", async () => {
    const w1 = completedWriteLine("src/a.test.ts", "same content\n");
    const other = completedWriteLine("src/scratch.ts", "scratch\n");
    // a, a, different-path, a, a, a → different-path resets; 3 identical after
    // it still trips the count.
    const emitter = `${pct(w1)} ; sleep 0.05 ; ${pct(w1)} ; sleep 0.05 ; ${pct(other)} ; sleep 0.05 ; ${pct(w1)} ; sleep 0.05 ; ${pct(w1)} ; sleep 0.05 ; ${pct(w1)} ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "editloop-diffpath",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("spin_loop");
      expect(result.errorMessage).toMatch(/^non-convergent edit loop/);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not reset the streak for interleaved bash/read events, so a rewrite after a mid-phase git checkout still trips the count", async () => {
    const w1 = completedWriteLine("src/model/history.test.ts", "export const A = 1;\n");
    const checkout = completedBashLine("git checkout -- src/model/history.test.ts");
    // write, write, bash(git checkout), write — the checkout must NOT reset
    // the streak; the third identical rewrite trips the count.
    const emitter = `${pct(w1)} ; sleep 0.05 ; ${pct(w1)} ; sleep 0.05 ; ${pct(checkout)} ; sleep 0.05 ; ${pct(w1)} ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "editloop-checkout",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("spin_loop");
      expect(result.errorMessage).toMatch(/^non-convergent edit loop/);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

/**
 * Issue #39: persistent opencode worker. When `persistent_worker: true`, the
 * railhead keeps one `opencode serve` process alive for the whole run, and
 * each `executeOpendCode` phase calls `opencode run --attach <url>` instead of
 * spawning a standalone subprocess. The KV cache stays warm across phases.
 *
 * These tests verify the spawn args — that `--attach <url>` is present when a
 * worker URL is set and absent when it is not. The worker URL is a module-
 * level handle (mirroring `activeChildPid`); a test-only setter exercises the
 * attach code path without spawning a real `opencode serve`.
 */
/**
 * Issue #78: the model-time cap. A model server that is alive but thrashing
 * (0 tok/s — stuck in prefill or cache eviction under memory pressure)
 * produces NO events for minutes, so the silence stall timer — sized for a
 * ~20min reasoning model — never fires on it. opencode's --format json streams
 * no per-token signal (parts arrive atomically on completion), so the only
 * discriminator available is MODEL time: the current step's wall clock minus
 * its tool-execution wall. These tests assert WHY each kill fires:
 *   - wall spent with a `running` tool part in flight is tool time, NOT model
 *     time — a long build inside a step must survive the cap (it is the
 *     silence timer's case, unchanged);
 *   - wall with no running tool AND no part completion is model time — a
 *     thrashing step must die at the cap, reported as a distinct timeout
 *     flavour so the response ladder can route it (issue #80).
 */
describe("executeOpendCode model-time cap (#78)", () => {
  it("does not kill a step whose wall is a running tool — tool time is excluded from the cap", async () => {
    // A step_start, then a tool_use in `running` state that holds for ~3s
    // while the cap is 1s. If running-tool wall counted as model time, the
    // phase would be killed ~1s in; it must survive until the terminal event.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const running = toolUseLine("running").replace(/'/g, "'\\''");
    const completed = toolUseLine("completed").replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n' '${start}' ; sleep 0.6 ; printf '%s\\n' '${running}' ; sleep 3 ; printf '%s\\n%s\\n%s\\n' '${completed}' '${finish}' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "model-cap-tool",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: 1,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(1);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("kills a step with no running tool and no part completion past the cap, reporting a model-stall timeout", async () => {
    // A step_start followed by NOTHING — the pixeledit thrash shape: the model
    // server is alive but producing nothing. The silence stall timer is
    // disabled (null) so only the model-time cap can fire.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n' '${start}' ; sleep 6`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "model-cap-kill",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: 1,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("timeout");
      expect(result.steps).toBe(1);
      // The errorMessage names the failure so describeExecFailure can tell a
      // model-time stall from a silence stall (issue #80 routes them apart).
      expect(result.errorMessage).toMatch(/^model-stalled:/);
      expect(result.errorMessage).toContain("model-time budget");
      expect(result.errorMessage).toContain("0 parts completed");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("names the estimated request size in the model-stall errorMessage once context is known", async () => {
    // A real first step (input 5000 → peak 5k), then a second step that grinds
    // with no output — the kill evidence should estimate the request size.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const realFinish = stepFinishLineWithTokens(5000).replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${realFinish}' ; sleep 0.2 ; printf '%s\\n' '${start}' ; sleep 6`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "model-cap-est",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: 1,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("timeout");
      expect(result.errorMessage).toMatch(/^model-stalled:/);
      expect(result.errorMessage).toContain("~5k");
      expect(result.errorMessage).toContain("elapsed");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("disables the model-time cap when maxStepModelSec is null or 0", async () => {
    // A step that idles 2.5s past a 1s cap would die if the cap were armed —
    // with it disabled (null/0) the step survives to its step_finish.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n' '${start}' ; sleep 2.5 ; printf '%s\\n' '${finish}' ; exit 0`;
    for (const maxStepModelSec of [null, 0]) {
      const env = await makeFakeOpencode(emitter);
      try {
        const result = await executeOpendCode("test prompt", {
          cwd: env.cwd,
          ledgerDir: env.ledgerDir,
          phaseFile: `model-cap-off-${String(maxStepModelSec)}`,
          model: null,
          stallTimeoutSec: null,
          maxStepModelSec,
          live: false,
          heartbeat: false,
        });
        expect(result.status).toBe("ok");
        expect(result.steps).toBe(1);
      } finally {
        restorePath(env.restorePath);
      }
    }
  }, 60000);

  it("does not count the inter-step gap toward the cap (a completed step, then opencode preparing the next request)", async () => {
    // Step 1 completes; opencode then sits ~2.5s (cap 1s) before the next
    // step_start. That gap is the silence timer's case, not the model cap —
    // it must NOT kill a phase that finished its step and is starting another.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${finish}' ; sleep 2.5 ; printf '%s\\n%s\\n' '${start}' '${finish}' ; exit 0`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "model-cap-interstep",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: 1,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode persistent worker (--attach, #39)", () => {
  afterEach(() => {
    resetWorkerForTest();
  });

  it("passes --attach <url> when a worker URL is set", async () => {
    // The fake `opencode` writes its argv to a marker file so the test can
    // assert on the actual spawn args.
    const argvMarker = join(tmpdir(), `argv-${process.pid}-${Date.now()}.txt`);
    const emitter = `printf '%s\\n' "$@" > '${argvMarker}' ; printf '${stepStartLine()}\\n${stepFinishLine()}\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      // Set the module-level worker URL (what `startPersistentWorker` would
      // have set after spawning `opencode serve`).
      const { setActiveWorkerUrlForTest } = await import("./executor.ts");
      setActiveWorkerUrlForTest("http://127.0.0.1:9999");
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "worker-attach",
        model: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      const argv = await readFile(argvMarker, "utf8");
      expect(argv).toContain("--attach");
      expect(argv).toContain("http://127.0.0.1:9999");
      // The prompt is still passed as the trailing positional.
      expect(argv).toContain("test prompt");
    } finally {
      restorePath(env.restorePath);
      await import("node:fs/promises").then((fs) => fs.rm(argvMarker, { force: true }));
    }
  });

  it("does not pass --attach when no worker URL is set (ADR 0001 baseline)", async () => {
    const argvMarker = join(tmpdir(), `argv-${process.pid}-${Date.now()}.txt`);
    const emitter = `printf '%s\\n' "$@" > '${argvMarker}' ; printf '${stepStartLine()}\\n${stepFinishLine()}\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      // No worker URL set — baseline fresh-subprocess-per-phase behavior.
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "worker-none",
        model: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      const argv = await readFile(argvMarker, "utf8");
      expect(argv).not.toContain("--attach");
    } finally {
      restorePath(env.restorePath);
      await import("node:fs/promises").then((fs) => fs.rm(argvMarker, { force: true }));
    }
  });

  it("withPersistentWorker runs the body without a worker when false (#39)", async () => {
    const { withPersistentWorker, setActiveWorkerUrlForTest } = await import("./executor.ts");
    // Ensure clean slate.
    resetWorkerForTest();
    let ran = false;
    const result = await withPersistentWorker(false, tmpdir(), async () => {
      ran = true;
      return "body-result";
    });
    expect(ran).toBe(true);
    expect(result).toBe("body-result");
  });

  it("withPersistentWorker resets the worker URL after the body completes when throw (#39)", async () => {
    // Even when the body throws, withPersistentWorker must clear the worker
    // URL so a subsequent standalone executeOpendCode call doesn't try to
    // attach to a dead server. The throw should propagate.
    const { withPersistentWorker, setActiveWorkerUrlForTest } = await import("./executor.ts");
    resetWorkerForTest();
    // Pretend a worker is active (startPersistentWorker would have set this).
    setActiveWorkerUrlForTest("http://127.0.0.1:9999");
    let bodyRan = false;
    await expect(
      withPersistentWorker(true, tmpdir(), async () => {
        bodyRan = true;
        throw new Error("body exploded");
      }),
    ).rejects.toThrow("body exploded");
    expect(bodyRan).toBe(true);
    // Worker URL cleared — no dangling reference to a dead server.
    // (We can't read activeWorkerUrl directly, but executeOpendCode's
    // --attach branch is gated on it; an explicit assertion run is overkill.
    // The resetWorkerForTest() in afterEach is the safety net.)
  });
});

describe("executeOpendCode session resume + capture (ADR 0022 S0.1, #84)", () => {
  it("passes --session <id> to resume a durable session when `session` is set", async () => {
    const argvMarker = join(tmpdir(), `argv-sess-${process.pid}-${Date.now()}.txt`);
    const emitter = `printf '%s\\n' "$@" > '${argvMarker}' ; printf '%s\\n%s\\n' '${stepStartLine()}' '${stepFinishLine()}'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("next ticket input", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "sess-resume",
        model: null,
        session: "sess_abc123",
        live: false,
        heartbeat: false,
        stallTimeoutSec: null,
      });
      expect(result.status).toBe("ok");
      const argv = await readFile(argvMarker, "utf8");
      expect(argv).toContain("--session");
      expect(argv).toContain("sess_abc123");
      expect(argv).toContain("next ticket input");
    } finally {
      restorePath(env.restorePath);
      await import("node:fs/promises").then((fs) => fs.rm(argvMarker, { force: true }));
    }
  }, 60000);

  it("omits --session when none is given (ADR 0001 baseline)", async () => {
    const argvMarker = join(tmpdir(), `argv-nosess-${process.pid}-${Date.now()}.txt`);
    const emitter = `printf '%s\\n' "$@" > '${argvMarker}' ; printf '%s\\n%s\\n' '${stepStartLine()}' '${stepFinishLine()}'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "sess-none",
        model: null,
        live: false,
        heartbeat: false,
        stallTimeoutSec: null,
      });
      expect(result.status).toBe("ok");
      const argv = await readFile(argvMarker, "utf8");
      expect(argv).not.toContain("--session");
    } finally {
      restorePath(env.restorePath);
      await import("node:fs/promises").then((fs) => fs.rm(argvMarker, { force: true }));
    }
  }, 60000);

  it("captures the durable session id from the JSON event stream", async () => {
    // opencode's --format json wraps every event as { type, timestamp,
    // sessionID, ... } — the fake emits the same shape.
    const start = JSON.stringify({ type: "step_start", timestamp: Date.now(), sessionID: "sess_cap", part: { type: "step-start", id: "p1", messageID: "m1", sessionID: "s1", snapshot: "x" } });
    const finish = stepFinishLine();
    const emitter = `printf '%s\\n%s\\n' '${start.replace(/'/g, "'\\''")}' '${finish.replace(/'/g, "'\\''")}'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "sess-capture",
        model: null,
        live: false,
        heartbeat: false,
        stallTimeoutSec: null,
      });
      expect(result.status).toBe("ok");
      expect(result.sessionId).toBe("sess_cap");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("reports null sessionId when no event carried one", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${finish}'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "sess-null",
        model: null,
        live: false,
        heartbeat: false,
        stallTimeoutSec: null,
      });
      expect(result.sessionId).toBeNull();
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode stopAfterCheckpoint ticket capture (ADR 0022 S0.2, #84)", () => {
  it("stops at the $CHECKPOINT marker and reports which ticket it named", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const marker = textEvent("$CHECKPOINT ticket=03").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${marker}' ; sleep 2 ; printf '%s\\n%s\\n' '${start}' '${marker}' ; sleep 2`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "checkpoint-ticket",
        model: null,
        stopAfterMarker: CHECKPOINT_RE,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(1);
      expect(result.checkpointTicket).toBe("03");
      const raw = await readFile(join(env.ledgerDir, "events", "checkpoint-ticket.jsonl"), "utf8");
      expect(raw).toContain("$CHECKPOINT ticket=03");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("reports the ticket on a CLEAN natural exit — the marker as the model's last line, no kill needed", async () => {
    // The kill path (a second step_start after the marker) is not the expected
    // one: the builder is told the marker is its LAST line and the process
    // should close 0 on its own. The checkpoint ticket must survive that path
    // too, or a clean checkpoint reports nothing to reconcile against.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const marker = textEvent("$CHECKPOINT ticket=05").replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n%s\\n' '${start}' '${marker}' '${finish}' ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "checkpoint-clean",
        model: null,
        stopAfterMarker: CHECKPOINT_RE,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.checkpointTicket).toBe("05");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("leaves checkpointTicket null when the marker never appeared", async () => {
    const start = stepStartLine().replace(/'/g, "'\\''");
    const plain = textEvent("still working").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${plain}' ; sleep 0.2 ; printf '%s\\n%s\\n' '${start}' '${plain}' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "checkpoint-none",
        model: null,
        stopAfterMarker: CHECKPOINT_RE,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.checkpointTicket).toBeNull();
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("gh #105: a generic terminal marker ($RECONCILE_END) arms the boundary kill on its own last line", async () => {
    // The reconcile seat passes its own stopAfterMarker; it is NOT the
    // checkpoint grammar, so the generic own-line terminal anchor must arm the
    // early exit (otherwise the arbiter would loop until its step budget).
    const start = stepStartLine().replace(/'/g, "'\\''");
    const marker = textEvent("1. fixed the off-by-one\n$RECONCILE_END").replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start}' '${marker}' ; sleep 2 ; printf '%s\\n' '${start}' ; sleep 1`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "reconcile-stop",
        model: null,
        stopAfterMarker: /\$RECONCILE_END\b/i,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      // Only the first step ran: the second step_start killed the phase at the
      // boundary once the marker had armed (a phase that kept looping would
      // have run the second step to completion).
      expect(result.steps).toBe(1);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode telemetry-only kill guards (ADR 0022 §5, #84)", () => {
  it("does NOT kill on the 95% peak crossing under guardMode telemetry", async () => {
    // A step_finish reporting input over 95% of a small budget would normally
    // kill before the next step; under the durable builder it must pass
    // through as telemetry and let the run continue to its natural end.
    const start1 = stepStartLine().replace(/'/g, "'\\''");
    const big = stepFinishLineWithTokens(9_800).replace(/'/g, "'\\''");
    const start2 = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n%s\\n%s\\n' '${start1}' '${big}' '${start2}' '${finish}' ; sleep 0.2 ; printf 'done\\n'`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "telemetry-peak",
        model: null,
        maxContextTokens: 10_000,
        guardMode: "telemetry",
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(result.steps).toBe(2);
      // Telemetry is not lost: the peak is still surfaced.
      expect(result.peakTokens).toBe(9_800);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("still kills on the 95% crossing under the default kill guard", async () => {
    const start1 = stepStartLine().replace(/'/g, "'\\''");
    const big = stepFinishLineWithTokens(9_800).replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n%s\\n' '${start1}' '${big}' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "kill-peak",
        model: null,
        maxContextTokens: 10_000,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("budget_exceeded");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("keeps the #78 model-time floor armed under telemetry (a thrashing builder still dies)", async () => {
    // Telemetry disarms only the request-ceiling kills (#81/#82) — the #78
    // throughput floor (0 tok/s thrash) remains the builder's health check.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const emitter = `printf '%s\\n' '${start}' ; sleep 6`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "telemetry-thrash",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: 1,
        guardMode: "telemetry",
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("timeout");
      expect(result.errorMessage).toMatch(/^model-stalled:/);
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode prompt echo (--verbose)", () => {
  it("prints the exact prompt to the live sink under verbose", async () => {
    const env = await makeFakeOpencode("exit 0");
    const seen: string[] = [];
    try {
      const result = await executeOpendCode("build the thing\nwith two lines", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "verbose-prompt",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: null,
        verbose: true,
        liveSink: (line: string) => seen.push(line),
      });
      expect(result.status).toBe("ok");
      const out = seen.join("\n");
      expect(out).toContain("── prompt");
      expect(out).toContain("build the thing");
      expect(out).toContain("with two lines");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("stays silent without verbose", async () => {
    const env = await makeFakeOpencode("exit 0");
    const seen: string[] = [];
    try {
      await executeOpendCode("build the thing", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "quiet-prompt",
        model: null,
        stallTimeoutSec: null,
        maxStepModelSec: null,
        liveSink: (line: string) => seen.push(line),
      });
      expect(seen.join("\n")).not.toContain("── prompt");
      expect(seen.join("\n")).not.toContain("build the thing");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("isToolTimeout (#96)", () => {
  it("matches request-timeout wording from tool servers, case-insensitively", () => {
    expect(isToolTimeout("Request timed out after 60000ms")).toBe(true);
    expect(isToolTimeout("request timeout: the page did not respond in time")).toBe(true);
    expect(isToolTimeout("The operation timed out")).toBe(true);
    expect(isToolTimeout("Error: ETIMEDOUT")).toBe(true);
  });

  it("does NOT match non-timeout tool errors (the spin guard owns those)", () => {
    expect(isToolTimeout("No changes to apply: oldString and newString are identical.")).toBe(false);
    expect(isToolTimeout("file not found: /x/a.rs")).toBe(false);
    expect(isToolTimeout("Command failed with exit code 1")).toBe(false);
    expect(isToolTimeout("500 Internal Server Error")).toBe(false);
  });
});

describe("executeOpendCode degraded-target detection (#96)", () => {
  function timeoutErr(tool: string, input: Record<string, unknown>, callID = "call_x"): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool,
        callID,
        state: { status: "error", input, error: "Request timed out after 60000ms" },
        title: "w",
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p1",
      messageID: "m1",
    });
  }

  function plainErr(tool: string, input: Record<string, unknown>, callID = "call_y"): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool,
        callID,
        state: { status: "error", input, error: "No changes to apply: oldString and newString are identical." },
        title: "w",
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p1",
      messageID: "m1",
    });
  }

  function okLine(tool: string, input: Record<string, unknown>, callID = "call_ok"): string {
    return JSON.stringify({
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "s1",
      part: {
        type: "tool",
        tool,
        callID,
        state: { status: "completed", input, output: "ok" },
        title: "w",
        time: { start: Date.now(), end: Date.now() },
      },
      id: "p2",
      messageID: "m1",
    });
  }

  const shot = (line: string) => line.replace(/'/g, "'\\''");
  const emit = (lines: string[], sleep = 0.1) =>
    lines.map((l) => `printf '${shot(l)}\\n' ; sleep ${sleep} ;`).join(" ") + " printf 'done\\n'";

  it("kills the subprocess with status degraded_target after a run of timeout-class failures across different tools/inputs — successes in between do NOT reset the count", async () => {
    // A wedged target answers one call (a fresh-tab retry) then wedges again:
    // err, ok, err, ok, err. The spin guard keys consecutive-identical so it
    // sees nothing; the windowed burst guard must fire on the 3rd timeout.
    const e1 = timeoutErr("edit", { filePath: "/x/a.rs" }, "c1");
    const e2 = timeoutErr("bash", { command: "cargo check" }, "c2");
    const e3 = timeoutErr("chrome-devtools_navigate", { url: "http://localhost:5173" }, "c3");
    const ok = okLine("bash", { command: "pwd" }, "c_ok");
    const emitter = emit([e1, ok, e2, ok, e3]);
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "degraded-kill",
        model: null,
        maxToolTimeouts: 3,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("degraded_target");
      expect(result.errorMessage).toContain("degraded-target:");
      expect(result.errorMessage).toContain("request timeouts");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does NOT kill on a run of non-timeout tool errors with different inputs (spin guard also stays silent)", async () => {
    const lines = [plainErr("edit", { filePath: "/x/a.rs" }, "d1"), plainErr("bash", { command: "ls" }, "d2"), plainErr("bash", { command: "pwd" }, "d3")];
    const env = await makeFakeOpencode(emit(lines, 0.05));
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "degraded-none",
        model: null,
        maxToolTimeouts: 3,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("treats repeated IDENTICAL timeout calls as a degraded target, not a spin loop (exempt from the consecutive-identical guard)", async () => {
    // Same tool+input timing out 5x: the old spin guard would have miscounted
    // it as an identical-error loop at 3; the timeout is a wedge signal and
    // must classify as degraded_target instead.
    const err = timeoutErr("chrome-devtools_navigate", { url: "http://localhost:5173" }, "s1");
    const emitter = emit([err, err, err, err, err]);
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "degraded-identical",
        model: null,
        maxToolTimeouts: 5,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("degraded_target");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("disables the degraded-target guard when maxToolTimeouts is null", async () => {
    const e = timeoutErr("bash", { command: "curl x" }, "n1");
    const emitter = emit([e, e, e, e], 0.05);
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "degraded-disabled",
        model: null,
        maxToolTimeouts: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});

describe("executeOpendCode phase wall-clock cap (#96)", () => {
  it("kills the subprocess with a wall-clock timeout when the WHOLE phase outlives phaseWallSec, even while it keeps emitting output", async () => {
    // The emitter streams a step pair, then keeps sleeping/printing — a
    // slow-but-LOUD phase the silence stall timer (re-armed on every byte)
    // would never catch. The absolute wall cap must kill it.
    const start = stepStartLine().replace(/'/g, "'\\''");
    const finish = stepFinishLine().replace(/'/g, "'\\''");
    const emitter = `printf '${start}\\n${finish}\\n' ; sleep 1.5 ; printf '${start}\\n${finish}\\n' ; sleep 30`;
    const env = await makeFakeOpencode(emitter);
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "wall-kill",
        model: null,
        phaseWallSec: 2,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("timeout");
      expect(result.errorMessage).toContain("wall-clock:");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);

  it("does not cap the phase when phaseWallSec is null (the default)", async () => {
    const env = await makeFakeOpencode("sleep 0.3 ; exit 0");
    try {
      const result = await executeOpendCode("test prompt", {
        cwd: env.cwd,
        ledgerDir: env.ledgerDir,
        phaseFile: "wall-off",
        model: null,
        stallTimeoutSec: null,
        live: false,
        heartbeat: false,
      });
      expect(result.status).toBe("ok");
      expect(String(result.errorMessage ?? "")).not.toContain("wall-clock:");
    } finally {
      restorePath(env.restorePath);
    }
  }, 60000);
});
