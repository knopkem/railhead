/**
 * Opt-in integration test for the base-session/`--fork` protocol (#133).
 *
 * Skipped by default because it makes real model calls. Run it against a
 * provider that supports prompt-prefix reuse (the Splash fixture measured in
 * #129) to prove the property the protocol exists for: the SECOND fork of a
 * base session restores the shared prefix instead of re-prefilling it.
 *
 *   RAILHEAD_FORK_IT=1 RAILHEAD_FORK_MODEL=<provider/model> \
 *     npx vitest run src/execute/base-session.integration.test.ts
 *
 * The model is the only provider assumption — the base mechanism itself is
 * engine-agnostic, and this test is where a real engine is exercised.
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { ensureBaseSession } from "./base-session.ts";
import { executeOpendCode } from "./executor.ts";
import { firstStepCacheFromEvents } from "../core/telemetry.ts";
import { initLedger } from "../core/ledger.ts";
import { createRunState } from "../core/state.ts";
import { DEFAULT_CONFIG } from "../config/config.ts";
import { RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";

const enabled = process.env.RAILHEAD_FORK_IT === "1";
const model = process.env.RAILHEAD_FORK_MODEL ?? null;

describe.skipIf(!enabled)("base session fork (opt-in integration, #133)", () => {
  it("the second fork restores the shared prefix", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fork-it-"));
    await writeFile(join(cwd, "AGENTS.md"), "Integration fixture agent guidance.", "utf8");
    await writeFile(join(cwd, "CONTEXT.md"), "Integration fixture glossary.", "utf8");
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "docs", "architecture.md"), "Integration fixture architecture.", "utf8");
    const ledger = join(cwd, ".railhead", "run-it");
    await initLedger(ledger);
    const state = createRunState({
      cwd,
      branch: "run/it",
      tickets_dir: join(cwd, ".scratch", "issues"),
      config: DEFAULT_CONFIG,
      pause_on_failure: false,
      verbose: false,
      quiet: true,
      original_prompt: "integration fixture goal",
    });

    const baseId = await ensureBaseSession({ state, ledger, model, contextTokens: null });
    expect(baseId).toBeTruthy();

    const baseCache = firstStepCacheFromEvents(
      await readFile(join(ledger, "events", "base-session.jsonl"), "utf8"),
    );
    expect(baseCache).not.toBeNull();
    const baseTokens = baseCache!.cold + baseCache!.cached;
    expect(baseTokens).toBeGreaterThan(0);

    const fork = (task: string) =>
      executeOpendCode(task, {
        cwd,
        ledgerDir: ledger,
        phaseFile: `fork-${task.replace(/\W+/g, "-")}`,
        model,
        agent: RAILHEAD_AGENT_NAMES.base,
        session: baseId,
        fork: true,
        task,
        maxSteps: 2,
        live: false,
        heartbeat: false,
      });

    const first = await fork("Reply with just: ALPHA");
    expect(first.status).toBe("ok");
    const second = await fork("Reply with just: BETA");
    expect(second.status).toBe("ok");

    expect(second.firstStepCache).not.toBeNull();
    // The fork must restore at least the base request's tokens — up to server
    // template overhead the two counts differ, hence the tolerance.
    expect(second.firstStepCache!.cached).toBeGreaterThanOrEqual(Math.floor(baseTokens * 0.9));
  }, 180_000);
});
