import {
  buildVisualReviewPrompt,
  parseVisualVerdict,
  runCommandFromVerify,
  shouldRunVisualReview,
  DEGRADED_TARGET_RECOVERY_NOTE,
  type VisualVerdict,
} from "./visual.ts";
import { loadTickets, type Ticket } from "../core/ticket.ts";
import type { RunState, TicketState } from "../core/state.ts";
import { isBlocker, reviewSummary, runReviewAgent } from "./reviewer.ts";
import { baseSessionId } from "../execute/base-session.ts";
import { pushLearnings, readLearnings } from "../context/learnings.ts";
import { eventPath, writeState } from "../core/ledger.ts";
import { hasVisualEvidence, hasInteractionEvidence, parseToolCalls, BUILD_TEST_EXCLUDE_RE } from "./evidence.ts";
import { requiresRealInputEvidence, type ProjectInterface } from "../config/interface.ts";
import { contextBudget, firesAtRunEnd, firesMidRun, DEFAULT_VISUAL_ROUND_WALL_SEC } from "../config/config.ts";
import { detectGameCanvas, RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";
import { nowClock } from "../cli/overview.ts";
import { readVisionCapabilityFor } from "../execute/vision-probe.ts";
import { processCorrectiveFindings, type RunTicket } from "./corrective.ts";
import { withFailureLadderOnThrow } from "../execute/failure-ladder.ts";
import { DEGRADED_TARGET_PREFIX, startPersistentWorker, stopPersistentWorker } from "../execute/executor.ts";
import { readFile } from "node:fs/promises";
import { readProjectDoc } from "../core/git.ts";

/** One visual-review round's outcome. Carries a `degradedTarget` flag when the
 * round was killed by the executor's degraded-target guard (issue #96) — the
 * caller distinguishes "the reviewer couldn't run the app" (plain inconclusive,
 * end honestly) from "the interaction target wedged into a request-timeout
 * spiral" (bounded waste; retry the round with a recovery note). */
export type VisualRoundResult = VisualVerdict & { degradedTarget?: boolean };

/** Run a single visual review round and return its verdict. */
export async function runVisualReview(options: {
  state: RunState;
  ledger: string;
  round: number;
  mission: string;
  criteria: string[];
  verifyCommands: string[];
  runCommandHint: string;
  priorFindings: string[];
  /** Override the default `visual-NN-review` phase-file name. Per-ticket
   * visual review passes `${ticket.number}-visual` so its ledger is distinct
   * from end-of-run rounds; without this, two round-1 passes collide. */
  phaseFileOverride?: string;
  /** Live-stream stage label (e.g. `05 visual`) so the visual review's progress
   * lines carry the same `NN stage` prefix as `NN implement` / `NN review`.
   * Defaults to a bare `visual` for end-of-run rounds. */
  stageLabel?: string;
  /** Per-ticket context: scopes the prompt to only this ticket's deliverables
   * so the reviewer doesn't flag features built by other tickets. */
  perTicket?: { title: string; what: string };
  /** The coherence charter (docs/coherence.md content) for a per-ticket
   * visual review of a surface ticket (ADR 0028): an in-scope charter
   * conformance check. Absent for end-of-run passes (goal review holds that
   * seat). */
  coherenceDoc?: string | null;
  /** Issue #96: set when the PREVIOUS round was killed by the degraded-target
   * guard — the loop retries the round with this recovery note so the
   * reviewer restarts the wedged app in a fresh page instead of repeating the
   * wedge. Null for a normal round. */
  recoveryNote?: string | null;
}): Promise<VisualRoundResult> {
  const { state, ledger, round, mission, criteria, verifyCommands, runCommandHint, priorFindings, phaseFileOverride, stageLabel, perTicket, coherenceDoc, recoveryNote } = options;
  const phaseFile = phaseFileOverride ?? `visual-${String(round).padStart(2, "0")}-review`;
  const interactionHints = state.config.visual_review?.interaction_hints ?? null;
  // Issue #97: the declared interface (railhead.json / planner $INTERFACE) is
  // authoritative; an undeclared project falls back to the canvas-only dep
  // inference so today's canvas projects keep their guidance (preserving
  // behavior). Undeclared non-canvas projects get neither guidance nor the
  // widened gate.
  const projectInterface = state.config.projectInterface ?? ((await detectGameCanvas(state.cwd)) ? "canvas" : null);
  const prompt = buildVisualReviewPrompt({
    mission,
    criteria,
    verifyCommands,
    runCommandHint,
    round,
    priorFindings,
    learnings: await readLearnings(state.cwd),
    interactionHints,
    projectInterface,
    perTicket,
    coherenceDoc,
    recoveryNote,
    visionCapability: await readVisionCapabilityFor(state.cwd, state._models?.visual ?? null),
  });
  // Issue #89: the opencode invocation + transcript extraction + exit
  // classification for every review kind lives in one runner (runReviewAgent);
  // visual's post-verdict policy (evidence downgrade) stays here.
  const agentOutcome = await runReviewAgent({
    label: "visual review",
    prompt,
    cwd: state.cwd,
    ledgerDir: ledger,
    phaseFile,
    model: state._models?.visual ?? null,
    // Visual review needs bash to run the app and capture screenshots, so it
    // runs as the observe seat — the one shared system prompt with the
    // project's ordinary toolset, not the read-only reviewer.
    agent: RAILHEAD_AGENT_NAMES.observe,
    baseSession: baseSessionId(state),
    live: !state.quiet,
    verbose: state.verbose,
    heartbeat: true,
    livePrefix: stageLabel ?? "visual",
    maxSteps: state.config.max_phase_steps,
    stallTimeoutSec: state.config.stall_timeout_sec,
    maxStepModelSec: state.config.max_step_model_sec,
    // Issue #96: a per-round wall-clock budget bounds a whole round in time,
    // not steps — each step of a timeout spiral eats ~60s, so a step budget
    // of hundreds is hours. Absent/null → the one-hour safety net; 0 disables.
    phaseWallSec: state.config.visual_review?.round_wall_sec ?? DEFAULT_VISUAL_ROUND_WALL_SEC,
    maxContextTokens: contextBudget(state),
    // Issue #60: kill the subprocess at the next step boundary once the first
    // complete $VISUAL_PASS/$VISUAL_FAIL ... $END block appears, instead of
    // letting a model that keeps re-emitting its verdict loop until the step
    // budget kills it (which lost the verdict to budget_exceeded → inconclusive).
    stopAfterVerdict: true,
  });
  if (agentOutcome.status !== "ok") {
    // Issue #96: a degraded-target kill (the executor's timeout-burst guard) is
    // a distinguishable failure — the interaction target wedged, it was not a
    // generic "couldn't run the app" incomplete. The loop retries such a round
    // with a recovery note (bounded by max_rounds) instead of ending here.
    if (agentOutcome.detail.startsWith(DEGRADED_TARGET_PREFIX)) {
      console.log(`[${nowClock()}] visual review: agent killed for a degraded tool target (run of request timeouts) — ${agentOutcome.detail}; marking round for retry with a recovery note`);
      return { verdict: "inconclusive", findings: [], degradedTarget: true };
    }
    // A stalled/killed agent produced no verdict, same as a step-budget kill
    // or a crash — none of them is evidence of PASS or FAIL, so all three
    // collapse to inconclusive (ADR 0009's amendment: no evidence must never
    // be coerced into a pass).
    console.log(`[${nowClock()}] visual review: agent ${agentOutcome.detail}; inconclusive — agent produced no verdict`);
    return { verdict: "inconclusive", findings: [] };
  }
  const transcript = agentOutcome.transcript;
  await pushLearnings(state, ledger, phaseFile);
  const verdict = parseVisualVerdict(transcript);
  if (verdict.verdict === "pass") {
    // Issue #97: a whole-app PASS is downgraded to INCONCLUSIVE when the phase
    // ledger shows no real user-level operation for the declared interface —
    // a browser-ui reviewer that drove everything through synthetic
    // `evaluate_script` dispatch has not proven a real user could operate the
    // controls. Per-ticket passes keep the base app-launch check but skip the
    // interface widening (a scaffold ticket's visual criteria may be
    // observation-only; the whole-app seat is the one that claims operate-ability).
    const downgraded = await checkVisualEvidence(ledger, phaseFile, state.cwd, projectInterface, perTicket == null);
    if (downgraded) return { verdict: "inconclusive" as const, findings: [] };
  }
  return verdict;
}

/**
 * Validate that a `$VISUAL_PASS` is backed by evidence the agent actually ran
 * the app — not just `cargo check` + `cargo test`. Parses the phase's raw
 * JSONL ledger for tool calls and checks whether the agent launched the app
 * (a non-build/test bash command that isn't just a server start, a browser
 * MCP tool call, or screenshots saved under .railhead/visual/). When the agent
 * claims pass without producing visual evidence, the verdict is downgraded to
 * inconclusive (ADR 0009: no evidence must never be coerced into a pass).
 *
 * Issue #58: `npm run preview` alone is NOT app-launch evidence — it starts a
 * server, it does not prove the agent opened a browser and looked. It counts
 * only alongside a browser tool call or a saved screenshot.
 *
 * Issue #97: when `enforceInteraction` (a whole-app pass) and the project's
 * declared interface requires real user-level operation, a PASS with no
 * real-input evidence is also downgraded — a browser-ui reviewer whose only
 * interaction tool was synthetic `evaluate_script` dispatch has not proven a
 * real user could operate the controls (ADR 0009 widened to the interaction
 * claim). Returns true when the PASS must downgrade.
 */
async function checkVisualEvidence(
  ledger: string,
  phaseFile: string,
  cwd: string,
  projectInterface: ProjectInterface | null,
  enforceInteraction: boolean,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(eventPath(ledger, phaseFile), "utf8");
  } catch {
    return false;
  }
  const { hasEvidence } = await hasVisualEvidence(raw, cwd, BUILD_TEST_EXCLUDE_RE);
  if (!hasEvidence) {
    console.log(
      `[${nowClock()}] visual review: $VISUAL_PASS downgraded to INCONCLUSIVE — agent did not run the app (only build/test or bare server-start commands detected)`,
    );
    return true;
  }
  if (enforceInteraction && requiresRealInputEvidence(projectInterface)) {
    const calls = parseToolCalls(raw);
    const { ok, missing } = hasInteractionEvidence(calls, projectInterface);
    if (!ok) {
      console.log(
        `[${nowClock()}] visual review: $VISUAL_PASS downgraded to INCONCLUSIVE — ${missing}`,
      );
      return true;
    }
  }
  return false;
}

/**
 * The visual final review loop (ADR 0009, cadence per issue #73). Fires when
 * `visual_review.mode` is `full`/`light` (the caller gates on `firesAtRunEnd`)
 * and a vision-capable `model.visual` is configured. After the run's tickets
 * commit, the reviewer captures the running app via bash and judges it against
 * the acceptance criteria. FAIL with [BLOCKER] findings generates corrective
 * tickets and re-runs them, bounded by `max_rounds`.
 *
 * Issue #97: this end-of-run whole-app pass is SKIPPED when the goal review
 * will take the same seat at run end (goal mode `full`/`light` + a goal model
 * resolved). Goal review judges the integrated build against the original goal
 * and design doc — a stronger frame than the per-ticket criteria union this
 * pass aggregates — and captures its own screenshots, so a visual run-end pass
 * firing beside it is the weaker duplicate (run-20260907-2146: visual "PASS"
 * with 66 prose findings while goal caught the real layout blocker). The
 * per-ticket visual pass, which goal review never provides, is unaffected.
 * The caller (run.ts) enforces that gate.
 *
 * Skip safety: never fires when disabled or when `model.visual` is null — a
 * text-only model cannot see the screen, and silently firing would either
 * error (no model) or produce a verdict the model couldn't actually make.
 */
export async function visualReviewLoop(
  state: RunState,
  ledger: string,
  runTicket: RunTicket,
): Promise<void> {
  const cfg = state.config.visual_review;
  // Issue #73: the end-of-run loop fires under `full`/`light`; the per-ticket
  // pass is a separate cadence handled by kickoffPerTicketVisualReview.
  if (!cfg || !firesAtRunEnd(cfg.mode)) return;
  const visualModel = state._models?.visual ?? null;
  if (visualModel === null) {
    console.log("\nvisual review: skipped (model.visual is null — a text-only model cannot see the screen)");
    return;
  }
  // Don't run if no tickets committed — there is nothing integrated to look at.
  // Also don't run if there are uncommitted/non-committed tickets still pending
  // (e.g. an interrupted corrective ticket being resumed): the main loop should
  // finish those first. On a normal completion this filter is a no-op.
  const committed = state.tickets.filter((t) => t.status === "committed");
  if (committed.length === 0) {
    console.log("\nvisual review: skipped (no committed tickets to review)");
    return;
  }
  const pending = state.tickets.filter((t) => t.status !== "committed" && t.status !== "skipped");
  if (pending.length > 0) {
    console.log(`\nvisual review: skipped (${pending.length} ticket(s) still pending — resume will run visual review after they complete)`);
    return;
  }

  const maxRounds = cfg.max_rounds ?? state.config.max_attempts ?? (state.config.max_retries * 3);
  const allTickets = await loadTickets(state.tickets_dir);
  const mission = state.original_prompt ?? "(no mission declared)";
  const aggregatedCriteria = Array.from(
    new Set(allTickets.flatMap((t) => t.criteria)),
  );
  const runHint = runCommandFromVerify(state.config.verify, allTickets);
  const priorFindings: string[] = [];
  // Issue #96: the recovery note for the round that follows a degraded-target
  // kill. Set once, then cleared once a round returns a real verdict — the
  // note rides only on the ONE retry that recovers a wedged interaction
  // target (restart the app in a fresh page); a second degraded kill after
  // that note means the wedge is environmental and no note can fix it, so the
  // loop ends honestly as inconclusive instead of burning every round.
  let recoveryNote: string | null = null;

  let round = Math.max(0, state.visual_rounds ?? -1) + 1;
  state.visual_ok = null;
  while (round <= maxRounds) {
    console.log(`\nvisual review — round ${round}/${maxRounds}`);
    const visualRetry = await withFailureLadderOnThrow(
      () => runVisualReview({
        state,
        ledger,
        round,
        mission,
        criteria: aggregatedCriteria,
        verifyCommands: state.config.verify,
        runCommandHint: runHint,
        priorFindings,
        recoveryNote,
      }),
      {
        backoff: state.config.infra_backoff_sec,
        budget: contextBudget(state),
        restartWorker: state.config.persistent_worker === true
          ? async () => { await stopPersistentWorker(); await startPersistentWorker({ cwd: state.cwd }); }
          : async () => {},
        onRung: (rung) => {
          console.log(`[${nowClock()}] visual review: ${rung.diagnosis}`);
        },
      },
    );
    if (!visualRetry.ok) throw new Error(visualRetry.rung.diagnosis);
    const verdict = visualRetry.value;
    state.visual_rounds = round;
    state.visual_findings = verdict.findings;
    state.visual_ok = verdict.verdict === "pass";
    await writeState(ledger, state);

    if (verdict.verdict === "pass") {
      console.log(`[${nowClock()}] visual review ✓ PASS (round ${round})`);
      return;
    }

    if (verdict.verdict === "inconclusive") {
      // Issue #96: a degraded-target inconclusive is NOT the generic
      // "couldn't run the app" shape — the round was killed by the executor's
      // timeout-burst guard, so the interaction target wedged mid-review and
      // the reviewer never got to judge. Bounded waste, but recoverable: retry
      // the round once with a targeted note (restart the app in a fresh page)
      // before ending honestly. Bounded by max_rounds like every other round.
      if (verdict.degradedTarget === true && recoveryNote === null && round < maxRounds) {
        state.visual_ok = null;
        await writeState(ledger, state);
        recoveryNote = DEGRADED_TARGET_RECOVERY_NOTE;
        console.log(`[${nowClock()}] visual review: degraded tool target (run of request timeouts) — retrying round ${round + 1} with a recovery note`);
        round++;
        continue;
      }
      if (verdict.degradedTarget === true) {
        // Issue #59's reset contract applies here too: the unconditional
        // assignment above set visual_ok to false (verdict !== "pass"), which
        // would render as FAIL; an inconclusive — however caused — must render
        // as not-verified, never a documented FAIL.
        state.visual_ok = null;
        await writeState(ledger, state);
        console.log(`[${nowClock()}] visual review ⚠ INCONCLUSIVE — interaction target stayed wedged (run of request timeouts); run marked not verified. Manual visual inspection required.`);
        return;
      }
      // The agent ran but produced no verdict — almost always means it never
      // got the app running (e.g. a terminal app that fails without a TTY).
      // Do NOT soft-pass: leave visual_ok null so report/overview surface
      // "INCONCLUSIVE", and generate no corrective tickets (we have nothing
      // concrete to fix). The user must fall back to manual visual inspection
      // — the honest status, not a silent PASS. See ADR 0009.
      // Reset to null: the unconditional assignment above set it to false
      // (verdict !== "pass"), which would render as FAIL in the overview —
      // a regression that let an inconclusive run ship as a documented FAIL.
      state.visual_ok = null;
      await writeState(ledger, state);
      console.log(`[${nowClock()}] visual review ⚠ INCONCLUSIVE — agent produced no verdict; run marked not verified. Manual visual inspection required.`);
      return;
    }

    // Issue #88: the [BLOCKER] filter, corrective-ticket generation, file
    // writing, and inline processing all live in corrective.ts; priorFindings
    // accumulation stays here (it feeds the NEXT round's prompt).
    recoveryNote = null;
    const outcome = await processCorrectiveFindings(state, ledger, verdict.findings, {
      kind: "visual",
      label: "visual review",
      runTicket,
    });
    if (outcome === "none") {
      console.log(`[${nowClock()}] visual review ⚠ FAIL with no [BLOCKER] findings — soft-passing; ${reviewSummary(verdict.findings)} noted`);
      state.visual_ok = true;
      return;
    }
    if (outcome === "halted") {
      console.log(`[${nowClock()}] visual review: halted by an agent-initiated stop signal; stopping visual loop`);
      return;
    }
    if (outcome === "failed") {
      console.log(`[${nowClock()}] visual review: corrective ticket failed; stopping visual loop`);
      return;
    }
    for (const f of verdict.findings) {
      if (!priorFindings.includes(f)) priorFindings.push(f);
    }
    round++;
  }
  console.log(`[${nowClock()}] visual review: max rounds (${maxRounds}) reached; stopping`);
}

/**
 * Per-ticket visual review (ADR 0011). Runs a single visual review round
 * against ONLY this ticket's criteria (per-ticket catches per-ticket
 * regressions; end-of-run aggregates across the cumulative diff). On [BLOCKER]
 * findings, generates corrective tickets and processes them inline — the
 * ticket is not allowed to return "ok" until its visual blockers are resolved.
 * Matches the end-of-run `visualReviewLoop` semantics.
 *
 * Post-commit and serialized (ADR 0046): the caller kicks off the review,
 * persists the owed marker, then joins immediately, so the review — and any
 * corrective tickets it spawns — completes before the next ticket starts. A
 * gate must never run concurrently with the builder (ADR 0022, the
 * single-server contract), and the reviewer must see the committed worktree,
 * not the next ticket's partial edits. The split into kickoff + join remains
 * because an owed review is replayed through the same pair on resume (ADR
 * 0038).
 *
 * Returns "fail" only when a corrective ticket itself fails; "pass" covers
 * both an outright pass and inconclusive (agent produced no verdict — don't
 * fail a committed ticket because the reviewer couldn't run the app).
 */
export type PendingVisualOutcome = { outcome: "pass"; } | {
  outcome: "blockers";
  ticket: TicketState;
  mission: string;
  findings: string[];
};

export function kickoffPerTicketVisualReview(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  parsed: Ticket,
  opts?: { replay?: boolean },
): Promise<PendingVisualOutcome> | null {
  const cfg = state.config.visual_review;
  // Issue #73: the per-ticket cadence fires under `full`/`medium` (per-ticket
  // catches per-ticket runtime regressions before they stack; `light` defers
  // everything to the end-of-run loop, `off` disables the gate).
  if (!cfg || !firesMidRun(cfg.mode)) return null;
  const visualModel = state._models?.visual ?? null;
  if (visualModel === null) return null;

  if (!shouldRunVisualReview(parsed)) {
    console.log(`[${nowClock()}]   ${ticket.number} visual review (per-ticket): skipped (ticket criteria have no visual/runtime behaviour to observe)`);
    return null;
  }

  // gh: persist the owed marker BEFORE the review runs. The promise cannot
  // survive the process; the marker lets a stop in this window make resume
  // re-run the gate instead of silently skipping it. Cleared by
  // joinPendingVisualReview once the review lands.
  state.visual_pending = ticket.file;
  console.log(
    opts?.replay
      ? `[${nowClock()}]   ${ticket.number} visual review (per-ticket) — replaying the review the prior run stopped before joining`
      : `[${nowClock()}]   ${ticket.number} visual review (per-ticket) — kicked off (post-commit, serialized; ADR 0046)`,
  );
  const mission = state.original_prompt ?? "(no mission declared)";
  const criteria = parsed.criteria;
  const runHint = runCommandFromVerify(state.config.verify, [parsed]);
  // Issue #99 (ADR 0028): a per-ticket visual review of a surface ticket
  // carries the coherence charter as an in-scope conformance check. Absent
  // (no charter authored) reads clean to null → no block.
  return withFailureLadderOnThrow(
    () => readProjectDoc(state.cwd, "docs/coherence.md").then((coherenceDoc) => runVisualReview({
      state,
      ledger,
      round: 1,
      mission,
      criteria,
      verifyCommands: state.config.verify,
      runCommandHint: runHint,
      priorFindings: [],
      phaseFileOverride: `${ticket.number}-visual`,
      stageLabel: `${ticket.number} visual`,
      perTicket: { title: parsed.title, what: parsed.what },
      coherenceDoc,
    })),
    {
      backoff: state.config.infra_backoff_sec,
      budget: contextBudget(state),
      restartWorker: state.config.persistent_worker === true
        ? async () => { await stopPersistentWorker(); await startPersistentWorker({ cwd: state.cwd }); }
        : async () => {},
      onRung: (rung) => {
        console.log(`[${nowClock()}]   ${ticket.number} visual review: ${rung.diagnosis}`);
      },
    },
  ).then(async (retry): Promise<PendingVisualOutcome> => {
    if (!retry.ok) throw new Error(retry.rung.diagnosis);
    const verdict = retry.value;
    if (verdict.verdict === "pass") {
      console.log(`[${nowClock()}]   ${ticket.number} visual review ✓ PASS`);
      return { outcome: "pass" };
    }
    if (verdict.verdict === "inconclusive") {
      // Issue #59: an inconclusive per-ticket visual review must leave an
      // audit trail in the ticket's logs — the old code only console.logged,
      // so a ticket committed without visual verification with no record in
      // state.json of why. Surface it honestly; still commit (don't fail a
      // ticket because the reviewer couldn't run the app, per ADR 0011).
      // Issue #96: a degraded-target inconclusive (the round was killed by the
      // timeout-burst guard because the app/tool target wedged) is the same
      // commit-without-verification policy, but names the wedge in the log so
      // the operator can distinguish "reviewer couldn't run the app" from
      // "reviewer's interaction target stopped responding".
      if (verdict.degradedTarget === true) {
        console.log(`[${nowClock()}]   ${ticket.number} visual review ⚠ INCONCLUSIVE — agent's interaction target wedged (run of request timeouts); ticket committed, run marked not verified`);
        ticket.logs.push("visual review: inconclusive — interaction target wedged (timeout-burst guard killed the round); ticket committed without visual verification");
      } else {
        console.log(`[${nowClock()}]   ${ticket.number} visual review ⚠ INCONCLUSIVE — agent produced no verdict; ticket committed, run marked not verified`);
        ticket.logs.push("visual review: inconclusive — agent produced no verdict; ticket committed without visual verification");
      }
      await writeState(ledger, state);
      return { outcome: "pass" };
    }
    const blockers = verdict.findings.filter(isBlocker);
    if (blockers.length === 0) {
      console.log(`[${nowClock()}]   ${ticket.number} visual review ⚠ FAIL with no [BLOCKER] — soft-pass; ${reviewSummary(verdict.findings)} noted`);
      return { outcome: "pass" };
    }
    console.log(`[${nowClock()}]   ${ticket.number} visual review ⛔ FAIL ${reviewSummary(verdict.findings)} — ${blockers.length} blocker(s); will process corrective tickets before next commit`);
    return { outcome: "blockers", ticket, mission, findings: verdict.findings };
  }).catch((err) => {
    // Propagate as a thrown error — the join will surface it. Don't swallow.
    throw err;
  });
}

/**
 * Await the pending per-ticket visual review set by
 * `kickoffPerTicketVisualReview` and, if it found [BLOCKER]s, generate
 * corrective tickets and process them inline. `committedTicket` calls this
 * immediately after the kickoff, so the review completes within the ticket's
 * own boundary (ADR 0046); the owed-gate replay calls the same pair on resume.
 * Clears `state._pending_visual_review` before processing corrective tickets
 * so their own `committedTicket` does not re-join.
 */
export async function joinPendingVisualReview(
  state: RunState,
  ledger: string,
  runTicket: RunTicket,
): Promise<"pass" | "fail"> {
  const pending = state._pending_visual_review;
  if (!pending) return "pass";
  state._pending_visual_review = undefined;
  // gh: the review is landing — the owed marker must not outlive the join, or
  // resume would re-run a gate that already reported.
  state.visual_pending = null;
  const result = await pending as PendingVisualOutcome;
  if (result.outcome !== "blockers") return "pass";

  const { ticket, findings } = result;
  const outcome = await processCorrectiveFindings(state, ledger, findings, {
    kind: "visual",
    label: `${ticket.number} visual review`,
    runTicket,
  });
  if (outcome === "halted") {
    console.log(`[${nowClock()}] ${ticket.number} visual review: halted by an agent-initiated stop signal; stopping per-ticket visual`);
    return "fail";
  }
  if (outcome === "failed") {
    console.log(`[${nowClock()}] ${ticket.number} visual review: corrective ticket failed; stopping per-ticket visual`);
    return "fail";
  }
  if (outcome === "none") {
    console.log(`[${nowClock()}]   ${ticket.number} visual review: no corrective tickets generated; soft-passing`);
    return "pass";
  }
  console.log(`[${nowClock()}]   ${ticket.number} visual review: corrective ticket(s) committed; PASS`);
  return "pass";
}

