import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./executor.ts")>();
  return { ...actual, executeOpendCode: vi.fn() };
});

import { executeOpendCode } from "./executor.ts";
import { keepBaseWarm, markBaseWarm, touchDue, BASE_TOUCH_INTERVAL_MS, BASE_TOUCH_PHASE_FILE, type BaseTouchArgs } from "./base-touch.ts";
import { RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";
import { initLedger } from "../core/ledger.ts";
import { createRunState, type RunState } from "../core/state.ts";
import { DEFAULT_CONFIG } from "../config/config.ts";
import type { ExecResult } from "./executor.ts";

const mockExec = vi.mocked(executeOpendCode);

function okResult(over: Partial<ExecResult> = {}): ExecResult {
  return {
    status: "ok",
    code: 0,
    signal: null,
    durationMs: 1,
    steps: 1,
    peakTokens: 0,
    inFlightTokens: 0,
    estimateDriftTokens: 0,
    totalOutputTokens: 0,
    generationMs: 0,
    toolCalls: 0,
    errorMessage: null,
    ...over,
  };
}

async function makeRun(withBase: boolean): Promise<{ state: RunState; args: BaseTouchArgs }> {
  const cwd = await mkdtemp(join(tmpdir(), "base-touch-"));
  const ledger = join(cwd, ".railhead", "run-test");
  await initLedger(ledger);
  const state = createRunState({
    cwd,
    branch: "run/test",
    tickets_dir: join(cwd, ".scratch", "issues"),
    config: DEFAULT_CONFIG,
    pause_on_failure: false,
    verbose: false,
    quiet: true,
    original_prompt: "build a greetable CLI",
  });
  if (withBase) {
    state.base_session = { session_id: "ses_base1", preamble_hash: "h", created_at: new Date(0).toISOString() };
  }
  return { state, args: { state, ledger, model: "local/model", contextTokens: 60_000 } };
}

beforeEach(() => {
  mockExec.mockReset();
});

describe("touchDue", () => {
  it("is due when nothing has touched yet", () => {
    expect(touchDue(null, 1_000)).toBe(true);
  });

  it("is not due inside the interval", () => {
    expect(touchDue(1_000, 1_000 + BASE_TOUCH_INTERVAL_MS - 1)).toBe(false);
  });

  it("is due at exactly the interval", () => {
    expect(touchDue(1_000, 1_000 + BASE_TOUCH_INTERVAL_MS)).toBe(true);
  });

  it("is due again long after the last touch", () => {
    expect(touchDue(1_000, 1_000 + BASE_TOUCH_INTERVAL_MS * 10)).toBe(true);
  });
});

describe("keepBaseWarm", () => {
  it("forks the base with the all-deny base agent and one trivial task", async () => {
    const { args } = await makeRun(true);
    mockExec.mockResolvedValue(okResult({ firstStepCache: { cold: 120, cached: 3_680 } }));

    await keepBaseWarm(args);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const call = mockExec.mock.calls[0][1];
    expect(call.session).toBe("ses_base1");
    expect(call.fork).toBe(true);
    expect(call.agent).toBe(RAILHEAD_AGENT_NAMES.base);
    // Its own ledger stream: the creation record stays readable.
    expect(call.phaseFile).toBe(BASE_TOUCH_PHASE_FILE);
    expect(call.task).toBe("Reply with just: READY");
    // Never a side-effecting seat, and never a step budget a real phase needs.
    expect(call.maxSteps).toBe(3);
  });

  it("is a no-op when the run has no base session", async () => {
    const { args } = await makeRun(false);

    await keepBaseWarm(args);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it("touches at most once per interval", async () => {
    const { args } = await makeRun(true);
    mockExec.mockResolvedValue(okResult());

    await keepBaseWarm(args);
    await keepBaseWarm(args);
    await keepBaseWarm(args);

    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("touches again once the interval has elapsed", async () => {
    const { args } = await makeRun(true);
    mockExec.mockResolvedValue(okResult());

    await keepBaseWarm(args);
    markBaseWarm(args.state, Date.now() - BASE_TOUCH_INTERVAL_MS - 1);
    await keepBaseWarm(args);

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("force bypasses the interval for a resumed run's unknown base", async () => {
    const { args } = await makeRun(true);
    mockExec.mockResolvedValue(okResult());

    await keepBaseWarm(args);
    await keepBaseWarm({ ...args, force: true });

    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("markBaseWarm suppresses the touch a fresh creation already paid for", async () => {
    const { args } = await makeRun(true);
    markBaseWarm(args.state);

    await keepBaseWarm(args);

    expect(mockExec).not.toHaveBeenCalled();
  });

  it("fails open when the touch cannot run", async () => {
    const { args } = await makeRun(true);
    mockExec.mockRejectedValue(new Error("spawn ENOENT"));

    await expect(keepBaseWarm(args)).resolves.toBeUndefined();
  });

  it("fails open on a non-ok touch and still rate-limits the retry", async () => {
    const { args } = await makeRun(true);
    mockExec.mockResolvedValue(okResult({ status: "timeout" }));

    await keepBaseWarm(args);
    await keepBaseWarm(args);

    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("never mutates the base session", async () => {
    const { state, args } = await makeRun(true);
    const before = { ...state.base_session };
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_other" }));

    await keepBaseWarm(args);

    expect(state.base_session).toEqual(before);
  });
});
