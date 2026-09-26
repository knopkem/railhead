import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./executor.ts")>();
  return { ...actual, executeOpendCode: vi.fn() };
});

import { executeOpendCode } from "./executor.ts";
import { ensureBaseSession, baseSessionId, forkPhase, preambleHash, BASE_PHASE_FILE } from "./base-session.ts";
import { initLedger, readState } from "../core/ledger.ts";
import { createRunState, type RunState } from "../core/state.ts";
import { DEFAULT_CONFIG, type RailheadConfig } from "../config/config.ts";
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

async function makeRepo(docs: Record<string, string> = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "base-"));
  await writeFile(join(cwd, "AGENTS.md"), docs["AGENTS.md"] ?? "Agent guidance", "utf8");
  await writeFile(join(cwd, "CONTEXT.md"), docs["CONTEXT.md"] ?? "Domain glossary", "utf8");
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, "docs", "architecture.md"), docs["docs/architecture.md"] ?? "Architecture", "utf8");
  return cwd;
}

async function makeState(cwd: string, config: Partial<RailheadConfig> = {}, docsDir?: string): Promise<{ state: RunState; ledger: string }> {
  const ledger = join(cwd, ".railhead", "run-test");
  await initLedger(ledger);
  const state = createRunState({
    cwd,
    branch: "run/test",
    tickets_dir: join(cwd, ".scratch", "issues"),
    docs_dir: docsDir,
    config: { ...DEFAULT_CONFIG, ...config },
    pause_on_failure: false,
    verbose: false,
    quiet: true,
    original_prompt: "build a greetable CLI",
  });
  return { state, ledger };
}

beforeEach(() => {
  mockExec.mockReset();
});

describe("ensureBaseSession (#133)", () => {
  it("creates the base through the all-deny base agent, persists it, and returns the id", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_base1", firstStepCache: { cold: 5000, cached: 0 } }));

    const id = await ensureBaseSession({ state, ledger, model: "local/model", contextTokens: 60_000 });

    expect(id).toBe("ses_base1");
    expect(state.base_session?.session_id).toBe("ses_base1");
    expect(state.base_session?.preamble_hash).toBeTruthy();
    const persisted = await readState(ledger);
    expect(persisted.base_session?.session_id).toBe("ses_base1");

    expect(mockExec).toHaveBeenCalledTimes(1);
    const [, options] = mockExec.mock.calls[0]!;
    expect(options.phaseFile).toBe(BASE_PHASE_FILE);
    expect(options.agent).toBe("railhead-base");
    expect(options.model).toBe("local/model");
    const prompt = mockExec.mock.calls[0]![0] as string;
    expect(prompt).toContain("MISSION: build a greetable CLI");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("docs/architecture.md");
  });

  // ADR 0051: a feature run's plan docs live in its ticket-store namespace;
  // the canonical preamble reads from there, never the (possibly stale)
  // project-root docs.
  it("a feature run with docs_dir set reads its plan docs from that directory", async () => {
    const cwd = await makeRepo({ "docs/architecture.md": "ROOT_ARCHITECTURE_STALE_TEXT" });
    await mkdir(join(cwd, ".scratch", "f", "docs"), { recursive: true });
    await writeFile(join(cwd, ".scratch", "f", "docs", "design.md"), "FEATURE_DESIGN_FRESH_TEXT", "utf8");
    await writeFile(join(cwd, ".scratch", "f", "docs", "architecture.md"), "FEATURE_ARCHITECTURE_FRESH_TEXT", "utf8");
    const { state, ledger } = await makeState(cwd, {}, ".scratch/f/docs");
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_feat1" }));

    await ensureBaseSession({ state, ledger, model: null, contextTokens: null });

    const prompt = mockExec.mock.calls[0]![0] as string;
    expect(prompt).toContain("FEATURE_DESIGN_FRESH_TEXT");
    expect(prompt).toContain("FEATURE_ARCHITECTURE_FRESH_TEXT");
    expect(prompt).not.toContain("ROOT_ARCHITECTURE_STALE_TEXT");
  });

  it("reuses the base within the process without a second model call", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_base1" }));

    expect(await ensureBaseSession({ state, ledger, model: null, contextTokens: null })).toBe("ses_base1");
    expect(await ensureBaseSession({ state, ledger, model: null, contextTokens: null })).toBe("ses_base1");
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("reuses a persisted base across processes when the session is alive and its inputs are unchanged", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_base1" }));
    await ensureBaseSession({ state, ledger, model: null, contextTokens: null });
    const record = state.base_session!;

    const { state: resumed } = await makeState(cwd);
    resumed.base_session = { ...record };
    mockExec.mockClear();

    const isSessionAlive = vi.fn(async () => true);
    const id = await ensureBaseSession({ state: resumed, ledger, model: null, contextTokens: null, isSessionAlive });
    expect(id).toBe("ses_base1");
    expect(isSessionAlive).toHaveBeenCalledWith("ses_base1");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rebuilds when the canonical preamble inputs change (docs hash mismatch)", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_base1" }));
    await ensureBaseSession({ state, ledger, model: null, contextTokens: null });
    const staleHash = state.base_session!.preamble_hash;

    await writeFile(join(cwd, "AGENTS.md"), "Agent guidance v2", "utf8");
    const { state: resumed } = await makeState(cwd);
    resumed.base_session = { session_id: "ses_base1", preamble_hash: staleHash, created_at: "2026-01-01T00:00:00Z" };
    mockExec.mockClear();
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_base2" }));

    const id = await ensureBaseSession({ state: resumed, ledger, model: null, contextTokens: null, isSessionAlive: async () => true });
    expect(id).toBe("ses_base2");
    expect(resumed.base_session?.session_id).toBe("ses_base2");
    expect(resumed.base_session?.preamble_hash).not.toBe(staleHash);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("recreates a base whose session is gone, even when the hash matches", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_base1" }));
    await ensureBaseSession({ state, ledger, model: null, contextTokens: null });
    const record = state.base_session!;

    const { state: resumed } = await makeState(cwd);
    resumed.base_session = { ...record };
    mockExec.mockClear();
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_new" }));

    const id = await ensureBaseSession({ state: resumed, ledger, model: null, contextTokens: null, isSessionAlive: async () => false });
    expect(id).toBe("ses_new");
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("fails open when creation cannot produce a session, and does not re-attempt per phase", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockResolvedValue(okResult({ sessionId: undefined }));

    expect(await ensureBaseSession({ state, ledger, model: null, contextTokens: null })).toBeNull();
    expect(await ensureBaseSession({ state, ledger, model: null, contextTokens: null })).toBeNull();
    expect(state.base_session).toBeUndefined();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("never throws — a rejected executor call degrades to no base", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockRejectedValue(new Error("spawn opencode ENOENT"));

    expect(await ensureBaseSession({ state, ledger, model: null, contextTokens: null })).toBeNull();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

describe("forkPhase (#133)", () => {
  it("forks when a base is held and sends only the task message", async () => {
    const cwd = await makeRepo();
    const { state } = await makeState(cwd);
    state.base_session = { session_id: "ses_base", preamble_hash: "h", created_at: "now" };

    expect(forkPhase(state, "the task")).toEqual({ session: "ses_base", fork: true, task: "the task" });
    expect(baseSessionId(state)).toBe("ses_base");
  });

  it("returns an unforked invocation when no base is held", async () => {
    const cwd = await makeRepo();
    const { state } = await makeState(cwd);
    expect(forkPhase(state, "the task")).toEqual({ session: null, fork: false, task: null });
  });
});

describe("preambleHash (#133)", () => {
  it("is deterministic and changes with any byte of input", () => {
    expect(preambleHash("a\nb")).toBe(preambleHash("a\nb"));
    expect(preambleHash("a\nb")).not.toBe(preambleHash("a\nc"));
  });
});

describe("base-session ledger hygiene", () => {
  it("keeps the base phase out of the ticket phase namespace", async () => {
    const cwd = await makeRepo();
    const { state, ledger } = await makeState(cwd);
    mockExec.mockResolvedValue(okResult({ sessionId: "ses_base1" }));
    await ensureBaseSession({ state, ledger, model: null, contextTokens: null });
    // The base prompt is the canonical preamble plus the one-token ack — it
    // must carry no ticket, diff, or finding text (the volatile rule, #132).
    const prompt = mockExec.mock.calls[0]![0] as string;
    expect(prompt).not.toContain("## Ticket");
    expect(prompt).not.toContain("$BLOCKING");
    const persisted = JSON.parse(await readFile(join(ledger, "state.json"), "utf8"));
    expect(persisted.tickets).toEqual([]);
  });
});
