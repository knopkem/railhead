import {
  createRunState,
  frontier,
  isFinished,
  newBuilderState,
  type BuilderState,
  type RunMeta,
  type RunState,
  type TicketState,
} from "../core/state.ts";
import { initLedger, ledgerDir, newRunId, writeState, extractAssistantText, readStderrLines, boundedLog, writeRawLog, appendEvent, eventPath } from "../core/ledger.ts";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { loadTickets, toTicketState, renderTicket, type Ticket } from "../core/ticket.ts";
import { readPlanOrigin, checkPlanOrigin, readPlanWallMs } from "../plan/plan-identity.ts";
import { replanFromCheckpoint } from "../gates/replan.ts";
import type { BlockReport } from "../core/blocked.ts";
import { describeExecFailure, executeOpendCode, executeFreshPhase, killActiveChild, withPersistentWorker, startPersistentWorker, stopPersistentWorker, configureContextGuard } from "./executor.ts";
import { baseSessionId, ensureBaseSession, forkPhase } from "./base-session.ts";
import { setProviderHealth } from "./provider-health.ts";
import { withFailureLadder, withFailureLadderOnThrow, PhaseFailure, evidenceFromResult, SPIRAL_COMPACTION_THRESHOLD, type FailureEvidence } from "./failure-ladder.ts";
import { setDependencySourceDeny } from "./guard.ts";
import { joinPhaseMessages } from "../context/preamble.ts";
import { readVisionCapabilityFor } from "./vision-probe.ts";
import { summarizeIfNeeded, writeRunSummary } from "../context/summary.ts";
import { compressVerifyOutput } from "./output-compress.ts";
import { runVerify, assertGreenBaseline, type VerifyResult } from "./verify.ts";
import { runSmoke, type SmokeResult } from "./smoke.ts";
import { summarizePermissionRejections } from "../core/permissions.ts";
import { nextRunStatus, reconcileCommittedButUnsaved } from "../core/recovery.ts";
import { review, reviewSummary, severityOf, stripCompileClaimsWhenGreen, changedPathsFromDiff, downgradeUnanchoredBlockers, runReviewAgent } from "../gates/reviewer.ts";
import { kickoffPerTicketVisualReview, joinPendingVisualReview, visualReviewLoop } from "../gates/visual-loop.ts";
import { addPendingCheckpoint } from "../core/pending-checkpoints.ts";
import { runCommandFromVerify } from "../gates/visual.ts";
import { buildInteractionSmokePrompt, parseInteractionSmokeVerdict, type InteractionSmokeScope } from "../gates/interaction-smoke.ts";
import { interactionSmokePassGap, parseToolCalls } from "../gates/evidence.ts";
import { touchesVisualSurface } from "../context/surface.ts";
import { goalReviewAtCheckpoint, goalReviewAtRunEnd, goalCheckpointsToFire } from "../gates/goal-loop.ts";
import { structuralReviewAtCheckpoint, structuralCheckpointsToFire, runStructuralReview } from "../gates/structural-loop.ts";
// Re-exported so run.ts's historical surface (and run.test.ts's import) keeps
// working — the function's home is goal-loop.ts.
export { detectGroupCheckpoints } from "../gates/goal-loop.ts";
// Re-exported so run.ts's historical surface (and run.test.ts's import) keeps
// working — the function's home is corrective.ts.
export { nextTicketNumber } from "../gates/corrective.ts";
import { DEFAULT_MAX_REPLANS, DEFAULT_MODEL, codeReviewRunsMidRun, contextBudget, effectiveContextTokens, firesAtRunEnd, firesMidRun, goalFiresCheckpointsMidRun, interactionSmokeEnabled, querySeatContextWindows, resolveModels, seatContextBudget, seatContextCeilings, severityTriggersRetry, visualFiresAtRunEnd, type CheckpointGranularity } from "../config/config.ts";
import { analyzePhase, summarizePhaseFiles } from "../core/telemetry.ts";
import { advanceRetry, INITIAL_COUNTERS, type GateCounters, type GateLimits } from "../gates/gate.ts";
import { ensureProjectGitignore, ensureProjectOpenCodePermissions, frameworkExternalDirsForVerify, detectFramework, frameworkSmokeRun, RAILHEAD_AGENT_NAMES } from "../core/project-assets.ts";
import { nowClock, scopeLabel } from "../cli/overview.ts";
import { haltReason } from "../core/halt.ts";
import {
  clearStop,
  isSoftStopRequested,
  requestAbort,
  requestStop,
  setRunStopHandlerInstalled,
} from "./stop.ts";
import { drainOwedGates } from "../gates/owed-gates.ts";
import {
  CONTRACTS_FILE,
  loadContracts,
  summarizeContracts,
} from "../core/contracts.ts";
import { updateContracts } from "./contract-extract.ts";
import { stripNonSource, estimateTokens, REVIEW_MODE_THRESHOLD_RATIO, DIFF_FILE_THRESHOLD_RATIO } from "./diff-filter.ts";
import * as git from "../core/git.ts";
import {
  mineFailureLearning,
  pushLearnings,
  readLearnings,
} from "../context/learnings.ts";
import { readDigest } from "../context/digest.ts";
import { queryReasoningCapability } from "../core/models.ts";
import { buildBuilderPrompt, buildBuilderFindingsPrompt, type BuilderTicket, type GateFeedback } from "../context/builder.ts";
import { nextBuilderUnit, checkpointTarget, type BuilderUnit } from "./builder-units.ts";
import { CHECKPOINT_RE, readCheckpointTicket } from "../core/checkpoint.ts";
import { builderRecoveryFor } from "./builder-loop.ts";
import { findUnresolvedArtifact, planMentions, describePlanContradiction } from "../plan/plan-contradiction.ts";
import {
  RECONCILE_MAX_STEPS,
  applyReconcileEdits,
  authoredPathsInFailure,
  buildBlamePreamble,
  reconcileFindingsBlock,
  runSpecReconcile,
} from "./reconcile.ts";

export interface RunOptions {
  cwd: string;
  ticketsDir: string;
  branch: string;
  pauseOnFailure: boolean;
  config: RunState["config"];
  /** Print live opencode progress during implement/review. */
  verbose?: boolean;
  /** Suppress the live tool-call stream (heartbeat only). */
  quiet?: boolean;
  /** Issue #19: the original user prompt/goal. Stored on the run state so
   * the goal reviewer can evaluate against it at group checkpoints. */
  originalPrompt?: string;
  /** ADR 0051: true when the plan that produced this run SEEDED the verify
   * suite into a previously-empty railhead.json. There was no suite to be
   * green before this plan, so the feature baseline check is skipped — the
   * greenfield step-1 case; the first ticket establishes the suite. Undefined
   * (a direct `railhead run`) keeps the check. */
  verifySeeded?: boolean;
}

/** Issue #80: the rung-2 restart closure for a run's failure-ladder phases.
 * Restarts the persistent worker when it is on; a no-op otherwise (standalone
 * mode degrades rung 2 to a long backoff). */
function ladderRestart(state: RunState): () => Promise<void> {
  return state.config.persistent_worker === true
    ? async () => { await stopPersistentWorker(); await startPersistentWorker({ cwd: state.cwd }); }
    : async () => {};
}

/** Read the current ticket's raw plan text so a resolver failure can be
 * checked against the plan's own claims. Returns "" when unreadable — the
 * detector then stays silent (never throws). */
async function currentTicketPlanText(state: RunState, ticket: TicketState): Promise<string> {
  try {
    const dir = state.tickets_dir.startsWith("/")
      ? state.tickets_dir
      : join(state.cwd, state.tickets_dir);
    return await readFile(join(dir, ticket.file), "utf8");
  } catch {
    return "";
  }
}

/** Detect a plan contradiction in `text` (a resolver output blob or a phase
 * transcript): an artifact the build could not resolve that the CURRENT
 * ticket's plan text also names. When it fires, the plan asserted an
 * outside-world artifact as fact and the build disproved it — the retry must
 * say so (substitute a real artifact and RECORD the decision) instead of
 * silently working around a stale plan claim. Returns the corrective message,
 * or null when the text shows no contradiction. */
async function planContradictionFor(state: RunState, ticket: TicketState, text: string): Promise<string | null> {
  if (!text?.trim()) return null;
  const artifact = findUnresolvedArtifact(text);
  if (!artifact) return null;
  const planText = await currentTicketPlanText(state, ticket);
  if (!planMentions(planText, artifact)) return null;
  return describePlanContradiction(artifact);
}

/** Log + return-time bookkeeping shared by every seat that detects a plan
 * contradiction: a typed ledger entry so the report explains the reroute. */
function logPlanContradiction(state: RunState, ticket: TicketState, message: string): void {
  const firstLine = message.split("\n")[0];
  console.log(`[${nowClock()}]   ${ticket.number} plan-contradiction: ${firstLine}`);
  ticket.logs.push(boundedLog(`plan-contradiction: ${firstLine}`, message));
}

export function assembleBranch(cwd: string, ticketsDir: string): string {
  const slug = ticketsDir.split("/").filter(Boolean).slice(-2, -1).join("") || "tickets";
  const safe = slug.replace(/[^\w-]+/g, "-") || "tickets";
  return `run/${safe}`;
}

/** The directory this run's plan docs (design.md, architecture.md) live in.
 * Feature runs (ADR 0051) keep their plan beside their ticket store
 * (`.scratch/<slug>/docs`); the feature dir wins when it exists — a run's
 * builder and reviewer seats must never be pointed at a stale project-root
 * plan. Build/fix keep the repo-root `docs/`. */
export async function resolveDocsRoot(cwd: string, ticketsDir: string): Promise<string> {
  const abs = isAbsolute(ticketsDir) ? ticketsDir : join(cwd, ticketsDir);
  const siblingDocs = join(abs, "..", "docs");
  if (existsSync(join(siblingDocs, "design.md"))) {
    const rel = relative(cwd, siblingDocs);
    return rel.startsWith("..") ? siblingDocs : rel;
  }
  return "docs";
}

export async function startRun(options: RunOptions): Promise<{ runId: string; state: RunState; ledger: string }> {
  if (!(await git.isGitRepo(options.cwd))) {
    throw new Error("Not a git repository. The Railhead runs on one branch; init git first.");
  }
  await git.ensureInitialCommit(options.cwd);
  await ensureProjectGitignore(options.cwd);
  // The plan identity is read before the baseline check and before the run
  // state exists: `verify_seeded` exempts a plan's own freshly-seeded suite
  // from the baseline refusal, and `arc_step` rides the state (ADR 0051) so
  // the goal reviewer and run-end finalizer know which roadmap step this run
  // builds. A direct `railhead run` on a legacy plan reads both as absent.
  const origin = await readPlanOrigin(join(options.ticketsDir, ".."));
  // ADR 0051: a feature run extends an existing product — refuse to start on
  // a red verify baseline instead of burning the feature's retry budget on a
  // pre-existing failure. Fresh starts only (resume replays owed gates). A
  // suite this plan just seeded is exempt: there was nothing to be green
  // before the plan, and ticket 01 is what establishes it (greenfield step 1).
  const featureBaseline = options.config.feature_mode === true;
  if (featureBaseline) {
    if (options.verifySeeded === true || origin?.verify_seeded === true) {
      console.log(`[${nowClock()}] feature baseline: this plan seeded the verify suite (railhead.json had none) — baseline check skipped, there was no suite to be green`);
    } else if (options.config.verify.length === 0) {
      console.log(`[${nowClock()}] feature baseline: no verify commands configured — the baseline check is skipped, only this run's gate output can prove greenness`);
    } else {
      console.log(`[${nowClock()}] feature baseline — verifying the project is green before ticket 01`);
      const beforeMs = Date.now();
      const baseline = await assertGreenBaseline(options.cwd, options.config.verify, options.config.verify_timeout_sec);
      if (baseline === null) {
        console.log(`[${nowClock()}] feature baseline: no verify commands configured — skipped`);
      } else {
        console.log(`[${nowClock()}] feature baseline green (${((Date.now() - beforeMs) / 1000).toFixed(1)}s, ${baseline.outputs.length} command(s))`);
      }
    }
  }
  // Same pre-grant as at plan time, but driven by the persisted railhead.json
  // verify list (a resume after a plan-time crash would otherwise start the
  // implementer with no external_directory allowance and trip the same
  // auto-reject loop that killed the original run).
  const implSupportsReasoning = options.config.model.implement && options.config.model.implement !== "default"
    ? await queryReasoningCapability(options.config.model.implement)
    : false;
  await ensureProjectOpenCodePermissions(options.cwd, frameworkExternalDirsForVerify(options.config.verify), { yolo: options.config.yolo_permissions === true, contextTokens: options.config.max_context_tokens, implementModel: options.config.model.implement ?? undefined, clampReasoning: implSupportsReasoning });
  const meta: RunMeta = {
    cwd: options.cwd,
    branch: options.branch,
    tickets_dir: options.ticketsDir,
    docs_dir: await resolveDocsRoot(options.cwd, options.ticketsDir),
    arc_step: origin?.arc_step,
    config: options.config,
    pause_on_failure: options.pauseOnFailure,
    verbose: options.verbose ?? false,
    quiet: options.quiet ?? false,
    original_prompt: options.originalPrompt,
  };
  const state = createRunState(meta);
  console.log(`[${nowClock()}] plan docs: ${state.docs_dir}/`);
  state._models = resolveModels(options.config, []);

  const windows = await querySeatContextWindows(state._models);
  const detected = windows.implement ?? null;
  const { budget: effectiveBudget, source } = effectiveContextTokens(options.config.max_context_tokens, detected);
  state._effectiveContextTokens = effectiveBudget;
  state._seatContextTokens = seatContextCeilings(state._models, windows, options.config.max_context_tokens);
  if (source === "config") {
    console.log(`request ceiling: ${(effectiveBudget / 1000).toFixed(0)}k (from railhead.json)`);
  } else if (source === "model" && options.config.max_context_tokens && detected !== null && options.config.max_context_tokens > detected) {
    console.log(`WARNING: railhead.json request_ceiling_tokens (${options.config.max_context_tokens}) exceeds the model's ${(detected / 1000).toFixed(0)}k window — clamping to ${(effectiveBudget / 1000).toFixed(0)}k. A request ceiling is a request size, not server capacity; set it below the window.`);
  } else if (source === "model") {
    console.log(`request ceiling: ${(effectiveBudget / 1000).toFixed(0)}k — the model's configured limit (lower opencode's model limit.context for server headroom)`);
  } else {
    console.log(`request ceiling: ${(effectiveBudget / 1000).toFixed(0)}k (default — no opencode model limit detected; set a model limit.context or railhead.json request_ceiling_tokens)`);
  }
  const perSeat = Object.entries(state._seatContextTokens)
    .filter(([, budget]) => budget !== effectiveBudget)
    .map(([seat, budget]) => `${seat} ${Math.round(budget! / 1000)}k`);
  if (perSeat.length > 0) console.log(`per-seat request ceilings: ${perSeat.join(", ")}`);

  const runId = newRunId();
  const ledger = ledgerDir(options.cwd, runId);
  await initLedger(ledger);

  const parsed = await loadTickets(options.ticketsDir);
  state.tickets = parsed.map(toTicketState);

  const originWarnings = checkPlanOrigin(origin, parsed.map((t) => t.file));
  for (const w of originWarnings) {
    console.warn(`[plan-origin] ${w}`);
    await appendEvent(ledger, "plan-origin", `[warn] ${w}`);
  }

  // A fresh run on a branch that already has committed tickets (e.g., after a
  // crash, or when resuming via `railhead run` on a branch with prior work)
  // must pre-mark those tickets as committed so the frontier unblocks their
  // dependents. Without this, ticket 02 — blocked by 01 — would never become
  // ready because 01 is loaded as `ready` (then immediately re-implemented)
  // rather than recognized as already done.
  const head = await git.headCommit(options.cwd).catch(() => "");
  if (head) {
    // Scoping matters on long-lived repos: only the plan's own commits (its
    // base_sha..HEAD range) may satisfy a ticket title, never commits that
    // happened to carry the same "NN — Title" years earlier.
    const subjects = new Set(await git.commitSubjectsSince(options.cwd, origin?.base_sha ?? null));
    const commitLockup = new Map<string, string>();
    for (const t of state.tickets) {
      if (subjects.has(`${t.number} — ${t.title}`)) commitLockup.set(t.file, head);
    }
    const reconciled = reconcileCommittedButUnsaved(state, (t) => commitLockup.get(t.file));
    state.tickets = reconciled.tickets;
  }

  await writeState(ledger, state);
  return { runId, state, ledger };
}

/**
 * Register the run loop's SIGINT handler. Ctrl-C is a two-stage request:
 *
 *   first press  → soft stop: the run loop finishes the ticket in flight
 *                  (its whole gate, ending in a commit) and stops there. The
 *                  interruption costs nothing: the next `railhead run` /
 *                  `railhead resume` continues at the next ticket with no gate
 *                  owed.
 *   second press → hard stop: kill the active child and write
 *                  `status: "stopped"`, exactly the pre-graceful-stop behavior
 *                  (the escape hatch when a phase will not finish).
 *
 * Either way the on-disk state is recoverable, so the next `railhead run` sees
 * an interrupted run (not a ghost `running` status) and auto-resumes; SIGKILL
 * cannot be caught, but `shouldResume` treats `running` as "interrupted,
 * resume it". While this handler is installed the executor's global SIGINT
 * handler defers to it (stop.ts); SIGTERM stays immediate there. Returns a
 * cleanup function that removes the handler when the loop finishes normally.
 */
function installSignalHandlers(state: RunState, ledger: string): () => void {
  setRunStopHandlerInstalled(true);
  const handler = () => {
    if (requestStop() === "soft") {
      console.log(`[${nowClock()}] stop requested — the ticket in flight will finish its gate and commit, then the run stops; press Ctrl-C again to stop now (in-flight phase work will be redone on resume)`);
      return;
    }
    requestAbort();
    killActiveChild();
    void stopPersistentWorker();
    state.status = "stopped";
    state.stop_reason = "interrupted (hard Ctrl-C)";
    writeState(ledger, state).catch(() => {}).finally(() => process.exit(130));
  };
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
    setRunStopHandlerInstalled(false);
  };
}

/**
 * gh #111: apply an agent-initiated halt — the same `stopped` state SIGINT
 * writes (ADR 0003's honest-stop semantics), but triggered by a phase dropping
 * `.railhead/STOP` instead of a signal. Re-reads the file for the reason (the
 * executor kills and returns; the file persists until the operator deletes
 * it), records it on the state for report.md, kills any surviving child, and
 * persists. Sticky by construction: `isFinished` treats `stopped` as terminal
 * and `railhead resume` refuses while the file exists.
 */
async function applyHalt(state: RunState, ledger: string): Promise<void> {
  const reason = haltReason(state.cwd);
  state.status = "stopped";
  state.halt_reason = reason;
  killActiveChild();
  console.log(`[${nowClock()}] run halted — an agent wrote .railhead/STOP${reason ? `: ${reason}` : ""}`);
  console.log(`[${nowClock()}] a human must look before more work stacks. Review the reason, then delete .railhead/STOP to acknowledge; \`railhead resume\` refuses while it exists.`);
  await writeState(ledger, state);
}

/**
 * Honor an operator soft stop (first Ctrl-C) at a boundary where nothing is
 * owed. Callers must only invoke this at a ticket boundary — after the ticket
 * in flight has committed and its checkpoint gates returned — never between a
 * commit and those gates, or the stop would skip them. Per-ticket visual
 * reviews complete inside `committedTicket` (ADR 0046), so no gate is ever in
 * flight here.
 */
async function softStopHere(
  state: RunState,
  ledger: string,
  reason: string,
  onUpdate?: () => void,
): Promise<void> {
  if (!isFinished(state.status)) {
    state.status = "stopped";
  }
  state.stop_reason = reason;
  console.log(`[${nowClock()}] ${reason} — stopping; \`railhead resume\` continues at the next ticket`);
  await writeState(ledger, state);
  onUpdate?.();
}

/**
 * Issue #133: the executor arguments a fresh phase uses under the run's base
 * session (see `forkPhase`). Kept as a local alias so the call sites read as
 * "give this phase the base fork".
 */
const baseFork = (state: RunState, messages: { task: string }) => forkPhase(state, messages.task);

export async function runLoop(state: RunState, ledger: string, onUpdate?: () => void): Promise<RunState> {
  // Issue #39: keep one `opencode serve` worker alive for the whole run when
  // persistent_worker is on; each `executeOpendCode` phase attaches to it. The
  // worker is stopped on return / throw / early-exit by withPersistentWorker.
  return withPersistentWorker(state.config.persistent_worker === true, state.cwd, async () => {
    return runLoopInner(state, ledger, onUpdate);
  });
}

async function runLoopInner(state: RunState, ledger: string, onUpdate?: () => void): Promise<RunState> {
  // A stop request must not leak across runs (e.g. Ctrl-C during planning
  // armed the flag before any run loop existed), and a prior stop's reason is
  // superseded the moment this run continues — otherwise a later report would
  // show a stale "Stop:" line on a run that has since progressed.
  clearStop();
  state.stop_reason = null;
  // Arm the project-configured dependency-source deny globs before any phase
  // spawns (the guard composes them into every phase's inline opencode config).
  setDependencySourceDeny(state.config.dependency_source_deny ?? []);
  // Issue #134: install the operator-declared provider health probe (if any)
  // for every phase in this process. The startup timeout warnings are logged
  // once by the CLI, which owns process-startup diagnostics.
  setProviderHealth(state.config.provider);
  // ADR 0014 amendment: install the run's request-ceiling guard mode (the
  // default is telemetry-only; `context_guard: "kill"` opts into the kill).
  configureContextGuard(state.config.context_guard);
  const cleanupSignals = installSignalHandlers(state, ledger);
  // gh: replay the gates a prior stop left owed — a per-ticket visual review
  // the process died before joining, and any post-commit group checkpoint the
  // run never got to.
  // Runs before the frontier so no ticket stacks on a foundation a gate has
  // not cleared (ADR 0006). A failed replay stops the run like any gate
  // failure; the halt file, if present, wins as usual.
  // Issue #133: establish the run's base session before the first phase, so
  // every fresh phase forks the shared `[system][preamble]` prefix. Skipped
  // when there is no work (a finished run pays no model call) and when a halt
  // is already raised; creation failure is fail-open — ensureBaseSession
  // returns null and phases run the joined-prompt path.
  const hasPendingWork =
    state.tickets.some((t) => t.status === "ready" || t.status === "in_progress") ||
    (state.visual_pending ?? null) !== null ||
    (state.pending_checkpoints?.goal.length ?? 0) > 0 ||
    (state.pending_checkpoints?.structural.length ?? 0) > 0;
  if (hasPendingWork && haltReason(state.cwd) === null) {
    await ensureBaseSession({
      state,
      ledger,
      model: state._models?.implement ?? null,
      contextTokens: contextBudget(state),
    });
  }
  const drainOutcome = await drainOwedGates(state, ledger, processTicket);
  if (drainOutcome === "fail" && !isFinished(state.status)) {
    if (haltReason(state.cwd) !== null) {
      await applyHalt(state, ledger);
    } else {
      state.status = state.pause_on_failure ? "stopped" : "failed";
      await writeState(ledger, state);
    }
  }
  // Issue #95 stage 1: `group` granularity drives its own unit loop (the whole
  // group is one builder checkpoint + one gate); `ticket`/`product`
  // granularities keep the per-ticket frontier loop below.
  if ((state.config.checkpoint_granularity ?? "product") === "group") {
    await runBuilderGroupLoop(state, ledger, onUpdate);
  } else {
    while (!isFinished(state.status)) {
      // gh: an operator soft stop is honored between tickets — the previous
      // ticket's gate is fully done, so nothing is owed.
      if (isSoftStopRequested()) {
        await softStopHere(state, ledger, "stop requested before the next ticket began", onUpdate);
        break;
      }
      const next = frontier(state)[0];
      if (!next) {
        state.status = nextRunStatus(state);
        await writeState(ledger, state);
        onUpdate?.();
        break;
      }

      // gh #111: the ticket-boundary backstop. The executor catches a halt
      // file mid-phase (per streamed line); this check catches one raised
      // while no child runs — e.g. dropped by a phase that has since exited,
      // or left over from a prior run. Honest stop, not a failure.
      if (haltReason(state.cwd) !== null) {
        await applyHalt(state, ledger);
        onUpdate?.();
        break;
      }

      const outcome = await processTicket(state, ledger, next);
      if (outcome === "halted") {
        await applyHalt(state, ledger);
        onUpdate?.();
        break;
      }
      if (outcome === "failed") {
        // A halt (already applied as `stopped`) must not be clobbered back to
        // `failed` when a corrective ticket's failure propagates up as "failed".
        if (!isFinished(state.status)) {
          state.status = state.pause_on_failure ? "stopped" : "failed";
        }
        await writeState(ledger, state);
        onUpdate?.();
        break;
      }
      await writeState(ledger, state);
      onUpdate?.();
      // gh: the ticket boundary — gate complete, commit durable. Stop here
      // and resume continues at the next ticket with no work to redo and no
      // gate owed.
      if (isSoftStopRequested()) {
        await softStopHere(state, ledger, `stop requested — ${next.number} committed; stopping before the next ticket`, onUpdate);
        break;
      }
    }
  }

  // Issue #73: run-end passes, gated per gate by `mode`. Each gate fires at
  // run end under `full` or `light`; `medium` (checkpoint-only) and `off`
  // skip its end-of-run pass. A run that did not finish (a ticket failed, or
  // the frontier emptied with incomplete tickets) has nothing integrated to
  // review — skip the entire end-of-run block so a failed run doesn't waste
  // model time on final code review and structural review of an incomplete
  // build.
  if (state.status === "finished") {
    // gh: a soft stop requested during the end-of-run block is honored between
    // passes. All tickets are committed, so nothing is owed; a resume re-enters
    // this block and runs only the passes that did not complete (visual picks
    // up from `visual_rounds`, goal/structural re-run their run-end seats).
    let softStoppedAtRunEnd = false;
    const stopBetweenPasses = async (reason: string): Promise<void> => {
      if (softStoppedAtRunEnd || !isSoftStopRequested()) return;
      // `finished` is a terminal RunStatus, but the run-end gates have not all
      // completed — the run is only finished once this block returns. Flip to
      // `stopped` first so the helper's terminal-state guard does not veto it.
      state.status = "stopped";
      await softStopHere(state, ledger, reason, onUpdate);
      softStoppedAtRunEnd = true;
    };
    await stopBetweenPasses("stop requested after the final ticket's gate");
    const visualMode = state.config.visual_review?.mode ?? "off";
    const goalMode = state.config.goal_review?.mode ?? "off";
    // Issue #97: the end-of-run visual pass and the end-of-run goal review do
    // the SAME whole-app job — judge the fully-integrated build against the
    // original goal. Goal review does it better (goal + design-doc grounding,
    // its own screenshots, $CORRECTIVE decomposition), so when the goal gate
    // is configured to fire at run end (a goal model is set and its mode is
    // `full`/`light`), the visual pass is the weaker duplicate: it only re-
    // checks the per-ticket criteria union and soft-passes prose findings
    // (run-20260907-2146: visual "PASS" with 66 junk findings while goal
    // caught the real layout blocker). Skip visual's run-end pass then; its
    // per-ticket pass (the ticket-scoped runtime regression check) still fires
    // under `full`/`medium` mid-run, where goal review never runs.
    const goalModelResolved = (state._models?.goal ?? null) !== null;
    if (!softStoppedAtRunEnd && visualFiresAtRunEnd(visualMode, goalMode, goalModelResolved)) {
      await visualReviewLoop(state, ledger, processTicket);
    }
    await stopBetweenPasses("stop requested after the end-of-run visual pass");
    // Issue #73: end-of-run goal review runs after the end-of-run visual pass —
    // the visual pass produces screenshot evidence the goal reviewer can
    // reference when judging the integrated build holistically.
    if (!softStoppedAtRunEnd && firesAtRunEnd(goalMode)) {
      const goalRunEndOutcome = await goalReviewAtRunEnd(state, ledger, processTicket);
      // A failing run-end goal review is a real gate failure: status is
      // "finished" here by construction (this block only runs then), and the
      // old `!isFinished` guard silently swallowed the flip, leaving a run
      // whose corrective failed reported as finished. A soft stop mid-pass
      // still wins (status stopped is left alone).
      if (goalRunEndOutcome === "fail" && state.status === "finished") {
        state.status = state.pause_on_failure ? "stopped" : "failed";
        await writeState(ledger, state);
        onUpdate?.();
      }
    }
    await stopBetweenPasses("stop requested after the end-of-run goal review");
    const structuralMode = state.config.structural_review?.mode ?? "off";
    if (!softStoppedAtRunEnd && firesAtRunEnd(structuralMode)) {
      await runStructuralReview(state, ledger, "run-end", processTicket, { runEnd: true });
    }
  }
  await writeState(ledger, state);
  const summaryResult = await withFailureLadderOnThrow(
    () => writeRunSummary(state, ledger),
    { backoff: state.config.infra_backoff_sec, budget: seatContextBudget(state, "extract"), restartWorker: ladderRestart(state) },
  );
  if (!summaryResult.ok) {
    console.log(`[${nowClock()}] run summary: ${summaryResult.rung.diagnosis} — continuing`);
  }
  cleanupSignals();
  return state;
}



type TicketOutcome = "ok" | "failed" | "halted";

/** The implement/build phase's own outcome. The `halted` variant is gh #111's
 * honest stop — it must bypass the failure ladder, so it is discriminated apart
 * from the ordinary `err` failure rather than folded into it. */
type ImplementResult =
  | { ok: true; toolCalls?: number }
  | { ok: false; halted: true; reason: string }
  | { ok: false; blocked: BlockReport }
  | { ok: false; err: string; evidence: FailureEvidence | null };

function isHaltedResult(r: ImplementResult): r is { ok: false; halted: true; reason: string } {
  return r.ok === false && "halted" in r && r.halted === true;
}

/** ADR 0040: the builder's terminal blocked exit is discriminated apart from
 * an ordinary `err` failure so it bypasses the retry ladder and reaches the
 * kind-based routing in processTicket. */
function isBlockedResult(r: ImplementResult): r is { ok: false; blocked: BlockReport } {
  return r.ok === false && "blocked" in r;
}

/** ADR 0040: the floor under the derived wall budget. Only ever binds when
 * every invocation so far was shorter than half of it (see the invocation
 * multiple below) — i.e. on fast models, exactly where 30 minutes is sane. */
const MIN_TICKET_WALL_MS = 30 * 60 * 1000;

/** ADR 0040 (amended): the wall budget bounds checkpoint-less THRASH, so it
 * is sized in units of the slowest observed builder invocation: two full
 * invocations with no green verify between them is the thrash signature the
 * budget exists to stop. An absolute bound cannot calibrate — the plan
 * phase's wall is an order of magnitude off build wall, and a fixed floor
 * sized for fast cloud models is smaller than one healthy invocation on a
 * slow local model (the snake-run ticket 01 kill: 35m of green work stopped
 * against a 30m floor). */
const WALL_BUDGET_INVOCATION_MULTIPLE = 2;

/** ADR 0040 (amendment 3): the step budget is sized in invocation windows so
 * the capacity verdict's prescribed remedy can actually run. Two checkpoint-
 * less invocations reach the capacity verdict (one context fill each), and
 * that verdict's fix — a fresh session from the last green commit — is itself
 * one more invocation. The old 2× budget made the recovery unreachable: the
 * spriteforge spine ticket capped twice, compacted once per invocation, and
 * the budget stopped it before the fresh session could run. */
const TICKET_STEP_BUDGET_MULTIPLE = 3;

/** ADR 0040: whether this ticket has exhausted its cumulative builder budget.
 * Steps derive from `max_phase_steps` (itself scaled from the context size) at
 * `TICKET_STEP_BUDGET_MULTIPLE`; the wall derivation is `max(plan-phase wall,
 * 30m floor, 2 × slowest builder invocation)`. Explicit config wins; `0`
 * disables either; returning null means "within budget".
 *
 * Amended: the WALL check reads time since the last green verify (falling
 * back to the cumulative total before any invocation has landed). The budget
 * exists to bound thrash, and thrash produces nothing green — a ticket that
 * keeps passing verify is progressing and must not be stopped for being
 * slow. The STEP budget stays cumulative across checkpoints. */
export function ticketBudgetStop(state: RunState, ticket: TicketState): string | null {
  const cfg = state.config;
  const stepBudget = cfg.ticket_step_budget === 0
    ? null
    : cfg.ticket_step_budget ?? (cfg.max_phase_steps ? cfg.max_phase_steps * TICKET_STEP_BUDGET_MULTIPLE : null);
  const planWallMs = readPlanWallMs(join(state.cwd, ".railhead", "plan-latest"));
  const wallMs = cfg.ticket_wall_sec === 0
    ? null
    : cfg.ticket_wall_sec != null
      ? cfg.ticket_wall_sec * 1000
      : Math.max(planWallMs ?? 0, MIN_TICKET_WALL_MS, WALL_BUDGET_INVOCATION_MULTIPLE * (ticket.build_ms_max_invocation ?? 0));
  const steps = ticket.build_steps_total ?? 0;
  if (stepBudget !== null && steps >= stepBudget) {
    return `ticket step budget exhausted (${steps}/${stepBudget} steps across all builder invocations) — stopping instead of retrying`;
  }
  const sinceCheckpoint = ticket.build_ms_since_checkpoint !== undefined;
  const ms = sinceCheckpoint ? ticket.build_ms_since_checkpoint! : (ticket.build_ms_total ?? 0);
  if (wallMs !== null && ms >= wallMs) {
    const span = sinceCheckpoint
      ? `${Math.round(ms / 60000)}m/${Math.round(wallMs / 60000)}m since the last green verify`
      : `${Math.round(ms / 60000)}m/${Math.round(wallMs / 60000)}m across all builder invocations`;
    return `ticket wall budget exhausted (${span}) — stopping instead of retrying`;
  }
  return null;
}

/**
 * The post-commit sequence shared by both commit sites in `processTicket`:
 * the regular commit (review passed) and the soft-pass (attempt cap hit with
 * only non-blocking findings). Both must: record the commit, mark the ticket
 * committed, persist state, run this ticket's own per-ticket visual review
 * (ADR 0011, serialized — ADR 0046), and update the contract index. The phase
 * ordering here is deliberate:
 *   1. Commit + mark committed + persist: an interrupt in any later sub-pass
 *      can't lose a finished ticket (resume sees `committed` and skips it).
 *   2. Per-ticket visual review: runs to completion (corrective tickets
 *      included) before this ticket returns — no gate overlaps the builder
 *      (ADR 0022) and the reviewer sees the committed worktree (ADR 0046).
 *   3. Group checkpoints, then the contracts update: a best-effort bonus; a
 *      failure here must not lose the already-committed ticket.
 */
async function committedTicket(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  parsed: Ticket,
  msg: string,
  reused: boolean,
  kind: "commit" | "already-implemented" | "soft-pass",
): Promise<TicketOutcome> {
  console.log(
    kind === "soft-pass"
      ? `[${nowClock()}]   ${ticket.number} soft-pass ⚠ ${ticket.commit!.slice(0, 8)} ${msg}${reused ? " (no changes — reuse HEAD)" : ""}`
      : `[${nowClock()}]   ${ticket.number} ${kind} ${ticket.commit!.slice(0, 8)} ${msg}${reused ? " (no changes — reuse HEAD)" : ""}`,
  );
  ticket.status = "committed";
  ticket.logs.push(
    kind === "soft-pass"
      ? `soft-pass: ${msg}`
      : `${kind} ${ticket.commit} ${msg}${reused ? " (no changes)" : ""}`,
  );
  // Issue #95: every green commit advances the durable-builder ledger — the
  // ticket the build has now committed through (the fresh-seed resume point)
  // and the checkpoint counter (report telemetry). The commit hash IS the last
  // green commit; recorded so a fresh-session recovery can seed from it.
  if (state.builder && ticket.commit) {
    state.builder.checkpoint_count += 1;
    state.builder.committed_through = ticket.number;
    state.builder.last_green_commit = ticket.commit;
    // Issue #106 (A): re-derive the full-context flag from this ticket's
    // merged build-phase telemetry. A green commit closes a builder-invocation
    // window: if the session compacted during it, its in-context copy of the
    // contracts/learnings/digest blocks was summarized away, so the NEXT warm
    // advance must re-inject full content (not standing pointers). If it did
    // not compact, the blocks survive and the next advance stays thin. The
    // overwrite (not an accumulate) is deliberate: each committed ticket is
    // the definitive "what happened to the session since its last advance".
    // Guarded on context being present — an already-implemented reuse commit
    // runs no builder phases, so it must not clear a pending re-inject.
    if (ticket.context) {
      state.builder.needs_full_context = ticket.context.compactions > 0;
    }
  }
  // gh: mark the group checkpoints this commit completes as owed in the SAME
  // write that records the commit. The checkpoint gates run only after the
  // pending visual join below (potentially many minutes), and a crash in that
  // window must not leave the groups committed, unrecorded, and never
  // revisited.
  markGroupCheckpointsOwed(state, ticket);
  await writeState(ledger, state);

  // Per-ticket visual review (ADR 0011): post-commit and serialized (ADR 0046).
  // The review — and any corrective tickets it spawns — completes before this
  // ticket returns, so a gate never runs concurrently with the builder (ADR
  // 0022, the single-server contract) and the reviewer sees the committed
  // worktree, never the next ticket's partial edits. The owed marker is
  // persisted before the wait so a crash mid-review replays the gate on resume
  // (ADR 0038). Skipped silently when visual_review is disabled or no vision
  // model is configured.
  state._pending_visual_review = kickoffPerTicketVisualReview(state, ledger, ticket, parsed) ?? undefined;
  await writeState(ledger, state);
  if (state._pending_visual_review) {
    const visualOutcome = await joinPendingVisualReview(state, ledger, processTicket);
    if (visualOutcome === "fail") {
      return "failed";
    }
  }

  // gh #107 (C.2): structural review runs BEFORE goal at the checkpoint.
  // Structural is a cheap code/architecture read; goal is the expensive
  // browser-driving pass (screenshots, navigation, the design/coherence/
  // architecture/contracts prompt). Cheap-first fails fast before paying for a
  // goal pass. With each gate keeping its own reviewed-set this order is a
  // deliberate performance choice, not a correctness dependency: pre-#107
  // structural decided whether to run via detectGroupCheckpoints, which read
  // goal_reviews — so a goal pass that recorded the group first silently
  // suppressed structural. Note the new corrective ordering: structural runs
  // (and may itself replan via beforeCorrectives) before goal, so a structural
  // replan regenerates the frontier the goal pass then judges.
  const structuralOutcome = await structuralReviewAtCheckpoint(state, ledger, ticket, processTicket);
  if (structuralOutcome === "fail") {
    return "failed";
  }

  // Issue #19: goal review at group checkpoint boundaries. After a group's
  // tickets all commit (or at the fallback cadence), run a goal review that
  // evaluates the running build holistically against the original goal and
  // design.md. Gaps become corrective tickets that block all uncommitted
  // tickets, then are processed through the full pipeline inline.
  const goalOutcome = await goalReviewAtCheckpoint(state, ledger, ticket, parsed, processTicket);
  if (goalOutcome === "fail") {
    return "failed";
  }

  try {
    await updateContracts(state, ledger, ticket, parsed);
  } catch (err) {
    ticket.logs.push(`contracts update skipped: ${String(err)}`);
  } finally {
    await writeState(ledger, state);
  }
  return "ok";
}

export async function processTicket(state: RunState, ledger: string, ticket: TicketState): Promise<TicketOutcome> {
  ticket.status = "in_progress";
  ticket.start_commit = await git.headCommit(state.cwd);
  await writeState(ledger, state);

  const allParsed = await loadTickets(state.tickets_dir);
  const parsed = allParsed.find((t) => t.file === ticket.file);
  if (!parsed) {
    throw new Error(`ticket file not found: ${ticket.file} in ${state.tickets_dir} (${allParsed.length} tickets loaded: ${allParsed.map((t) => t.file).join(", ")})`);
  }
  let prevFeedback: string | null = null;
  const priorFindings: string[] = [];
  const limits: GateLimits = {
    maxRetries: state.config.max_retries,
    reviewBudget: state.config.max_review_retries ?? state.config.max_retries,
  };
  const maxAttempts = state.config.max_attempts ?? state.config.max_retries * 3;
  // The Gate's retry machine owns the budget; the shell only reads the counters.
  let counters: GateCounters = { ...INITIAL_COUNTERS };
  let attempt = 0;
  // The most recent round of blocking findings; kept across the loop so the
  // attempt-cap path can decide soft-pass vs fail.
  let lastBlockingFindings: string[] = [];
  // Issue #96: light mode gives a [MAJOR] finding exactly ONE corrective
  // attempt per ticket — a real-but-not-blocking gap (the SpriteForge toolbar
  // pointer-capture bug was exactly this) deserves one fix shot without burning
  // the whole budget. Counted per ticket, never per distinct MAJOR: if a new
  // MAJOR appeared on each re-review, "one per finding" would recreate the
  // medium-mode churn #70 was built to bound. medium/full never touch this —
  // the retry machine owns their MAJOR rounds.
  const reviewMode = state.config.code_review?.mode ?? "light";
  let majorRetriesSpent = 0;

  // Smoke phase recipe: when the config declares a launch command (the planner
  // emitted a $SMOKE block, or the user set one by hand), detect the framework
  // once and pick the headless env. Computed per-ticket because the config
  // could differ between runs of the same project; cheap (pure functions over
  // the verify/smoke lists). null means "skip the smoke phase" — either no
  // launch command was configured (a library project), or no framework recipe
  // matched (the railhead declines rather than risk failing the run for an
  // app whose headless switch we don't know).
  const smokeRecipe = state.config.smoke.length > 0
    ? (() => {
        const fw = detectFramework(state.config.verify, state.config.smoke);
        return fw ? frameworkSmokeRun(fw, state.config.smoke) : null;
      })()
    : null;

  // Context telemetry from each builder attempt — merged at ticket end so the
  // report reflects total work, not just the last (often tiny) fix. Every
  // attempt writes its own phase file (events/<NN>-<attempt>-build), whether it
  // reached a checkpoint or not; the compaction a durable-session builder
  // suffers often lands in a NO-marker attempt, so the ticket's telemetry must
  // merge ALL of them, not only the attempts that returned ok
  // (telemetry.ts summarizePhaseFiles).
  const implementPhaseFiles = new Set<string>();

  while (counters.unproductive <= state.config.max_retries && attempt < maxAttempts) {
    // ADR 0040: the per-ticket cumulative budget. Checked at every attempt
    // boundary, so a ladder rung, a resume, or a compaction can never reset
    // the cap the way the per-process step budget could.
    const budgetStop = ticketBudgetStop(state, ticket);
    if (budgetStop) {
      // ADR 0040 (amended): budget exhaustion with a GREEN tree is not a
      // failure — it is the attempt-cap soft-pass's twin (out of runway,
      // working code). Commit the verified work so the progress is durable,
      // then stop the run for a human: exhaustion means something unusual
      // happened, so the run must not silently continue — but a green tree
      // must not be reported as failed either. A red tree (or a standing
      // blocker) keeps the hard fail below.
      if (ticket.verify_ok === true && severityOf(lastBlockingFindings) !== "blocker") {
        ticket.logs.push(`budget exhausted with a green tree — committing the verified work, then stopping for a human: ${budgetStop}`);
        const msg = `${ticket.number} — ${ticket.title}`;
        ticket.commit = await git.commitOrReuseHead(state.cwd, msg);
        const reused = ticket.commit === ticket.start_commit;
        if (implementPhaseFiles.size > 0) ticket.context = await summarizePhaseFiles(ledger, implementPhaseFiles);
        const commitOutcome = await committedTicket(state, ledger, ticket, parsed, msg, reused, "soft-pass");
        if (commitOutcome === "failed") return "failed";
        state.status = "stopped";
        state.stop_reason = `ticket ${ticket.number}: ${budgetStop} — verified work committed; review the budget, then resume`;
        await writeState(ledger, state);
        console.log(`[${nowClock()}]   ${ticket.number} ${budgetStop} — green work committed; run stopped for a human`);
        // The frontier loop treats "failed" as stop-and-break; the preset
        // terminal `stopped` status survives it (isFinished), same pattern as
        // the halt path.
        return "failed";
      }
      ticket.logs.push(`FAILED: ${budgetStop}`);
      console.log(`[${nowClock()}]   ${ticket.number} ${budgetStop}`);
      state.status = state.pause_on_failure ? "stopped" : "failed";
      state.stop_reason = `ticket ${ticket.number}: ${budgetStop}`;
      await writeState(ledger, state);
      return "failed";
    }
    attempt++;
    ticket.attempts = attempt;
    const phaseFile = `${ticket.number}-${String(attempt).padStart(2, "0")}-build`;
    implementPhaseFiles.add(phaseFile);
    await writeState(ledger, state);

    // Failure ladder around the builder invocation (issue #80): execution
    // failures escalate retry → worker restart → diagnose instead of identical
    // retries. The ladder's rungs retry the durable session (which is
    // disk-durable and warm-banked, so rung 2's worker restart is a bounded
    // no-op on it) and its terminal verdicts drive builderRecoveryFor below —
    // capacity/diagnosed/fatal-config force a FRESH session from the last green
    // commit instead of the classic prompt-shrink (the session's fill is
    // compaction's business).
    const implStart = Date.now();
    const impl = await withFailureLadder(
      async () => {
        const r = await runBuilderStep(state, ledger, ticket, parsed, phaseFile, prevFeedback);
        if (!r.ok && "evidence" in r && r.evidence) throw new PhaseFailure(r.evidence);
        return r;
      },
      {
        backoff: state.config.infra_backoff_sec,
        budget: contextBudget(state),
        startAttempt: ticket.ladder_rung ?? 1,
        restartWorker: state.config.persistent_worker === true
          ? async () => { await stopPersistentWorker(); await startPersistentWorker({ cwd: state.cwd }); }
          : async () => {},
        onRung: (rung) => {
          console.log(`[${nowClock()}]   ${ticket.number} build: ${rung.diagnosis}`);
        },
      },
    );
    ticket.duration_ms += Date.now() - implStart;

    // Push path (ADR 0013): parse any LEARNED: marker the builder emitted.
    // Runs on every attempt — the builder's own comprehension is the cheapest
    // extractor of what was hard.
    await pushLearnings(state, ledger, phaseFile);

    if (!impl.ok) {
      const err = impl.rung.diagnosis;
      ticket.logs.push(err);
      ticket.ladder_rung = impl.rung.rung;
      ticket.last_failure_class = impl.rung.class;
      // Issue #95 / ADR 0022 §5: the builder's response to a terminal infra
      // verdict is NOT the classic prompt-shrink (which races the session's
      // compacter) — it is builderRecoveryFor's split: capacity/diagnosed/
      // fatal-config are terminal classes, and all three force a FRESH
      // session from the last green commit. (blip/server-state never reach
      // here — the ladder retried them on the same id before exhausting to a
      // terminal rung.) The gate machine the shared per-ticket loop branches
      // on (advanceRetry) applies unchanged — the builder shares this loop
      // instead of re-deriving it (issue #106-G: the old `nextBuilderStep`
      // mapping was dead; the loop drives advanceRetry directly).
      const recovery = builderRecoveryFor(impl.rung.class);
      if (recovery === "fresh-session") {
        recordBuilderRestart(state, ticket.number, `${impl.rung.class} (${err})`);
        dropBuilderSession(state);
      }
      prevFeedback = err;
      await writeState(ledger, state);
      continue;
    }
    const implValue = impl.value;
    // gh #111: an agent-initiated halt must bypass the failure ladder's retry
    // machine and the no-DONE handling below — it is an honest stop, not a
    // failed attempt. Propagate it to the run loop, which applies the halt.
    if (isHaltedResult(implValue)) {
      ticket.logs.push(`halted: ${implValue.reason}`);
      await writeState(ledger, state);
      return "halted";
    }
    // ADR 0040: the builder's terminal blocked exit. Route by kind — a block
    // is an intentional stop, not a missed checkpoint, and never a failure to
    // retry identically.
    if (isBlockedResult(implValue)) {
      const report = implValue.blocked;
      console.log(`[${nowClock()}]   ${ticket.number} build ⊘ BLOCKED (${report.kind}): ${report.reason}`);
      if (report.kind === "verification-unavailable") {
        // The work is believed done but this seat cannot prove a criterion.
        // Record the debt, then let the ordinary verify/smoke/review gates
        // decide the commit — only a green gate ships, and the criterion rides
        // into the next goal/visual checkpoint as an explicit must-check item.
        ticket.unverified = [...(ticket.unverified ?? []), report.reason];
        ticket.logs.push(`blocked verification recorded (must-check at the next goal/visual checkpoint): ${report.reason}`);
        await writeState(ledger, state);
        if (state.config.on_block === "pause") {
          state.status = "stopped";
          state.stop_reason = `ticket ${ticket.number} blocked on verification: ${report.reason}`;
          console.log(`[${nowClock()}]   ${ticket.number} on_block=pause — stopping; \`railhead resume\` continues`);
          await writeState(ledger, state);
          return "failed";
        }
        // Fall through to verify/smoke/review with the worktree as-is.
      } else if (report.kind === "implementation-stuck") {
        const stuckBlocks = (ticket.blocks ?? []).filter((b) => b.kind === "implementation-stuck").length;
        if (stuckBlocks >= 2) {
          ticket.logs.push(`FAILED: implementation-stuck blocked twice (${report.reason})`);
          console.log(`[${nowClock()}]   ${ticket.number} implementation-stuck twice — stopping for a human`);
          state.status = state.pause_on_failure ? "stopped" : "failed";
          state.stop_reason = `ticket ${ticket.number} blocked (implementation-stuck): ${report.reason}`;
          await writeState(ledger, state);
          return "failed";
        }
        ticket.logs.push(`implementation-stuck: one corrective attempt (${report.reason})`);
        prevFeedback = `Your previous invocation ended with a $BLOCKED marker (implementation-stuck): ${report.reason}\n\nThe railhead gives this ticket ONE corrective attempt. Change the approach or the hypothesis — do not repeat the same attempt. If you cannot make it work, block again with the same kind and the ticket will be stopped for a human.`;
        await writeState(ledger, state);
        continue;
      } else {
        // plan-defect: bounded auto-replan (ADR 0040 decision 3); otherwise
        // stop and surface. A successful replan replaces this ticket's
        // frontier, and the run loop picks the new tickets up next iteration.
        const maxReplans = state.config.goal_review?.max_replans ?? DEFAULT_MAX_REPLANS;
        const usedReplans = state.replan_count ?? 0;
        if (usedReplans < maxReplans) {
          state.replan_count = usedReplans + 1;
          console.log(`[${nowClock()}]   ${ticket.number} plan-defect block — auto-replan ${usedReplans + 1}/${maxReplans}`);
          const replanned = await replanFromCheckpoint(
            state,
            ledger,
            [report.reason],
            ticket.group ?? "plan-defect",
            "$REPLAN\n$END\n",
          ).catch((e: unknown) => {
            ticket.logs.push(`replan failed: ${e instanceof Error ? e.message : String(e)}`);
            return false;
          });
          if (replanned) {
            ticket.logs.push("plan-defect: frontier regenerated by replan");
            await writeState(ledger, state);
            return "ok";
          }
          ticket.logs.push("plan-defect: replan did not replace the frontier");
        } else {
          ticket.logs.push(`plan-defect: max_replans (${maxReplans}) already spent`);
        }
        state.status = state.pause_on_failure ? "stopped" : "failed";
        state.stop_reason = `ticket ${ticket.number} plan-defect: ${report.reason}`;
        console.log(`[${nowClock()}]   ${ticket.number} plan-defect — stopping for a human: ${report.reason}`);
        await writeState(ledger, state);
        return "failed";
      }
    }
    if (!implValue.ok && "err" in implValue) {
      // The no-checkpoint-marker exit — the builder process ran cleanly (exit 0)
      // but never emitted the expected $CHECKPOINT marker. Its recovery is
      // "resume the session and drive it to the checkpoint", never a gate on
      // half-built work, so the failure feeds straight back into the session.
      //
      // A no-clean-checkpoint exit after a dependency-resolution
      // grind is the signature of a plan-authored artifact claim the build
      // disproved (the builder re-probed a phantom package then stopped).
      // Detect it in the session transcript and reroute the retry from
      // "drive it to the checkpoint" to "the plan text is wrong; substitute
      // a real artifact and record the decision" so the correction is not
      // silent.
      const contradiction = await planContradictionFor(state, ticket, await extractAssistantText(ledger, phaseFile).catch(() => ""));
      if (contradiction) {
        logPlanContradiction(state, ticket, contradiction);
        ticket.logs.push(implValue.err);
        prevFeedback = `${contradiction}\n\n${implValue.err}`;
      } else {
        ticket.logs.push(implValue.err);
        prevFeedback = implValue.err;
      }
      await writeState(ledger, state);
      continue;
    }
    // Phase succeeded: clear any persisted ladder state so a later resume does
    // not re-enter mid-ladder on a fresh failure.
    ticket.ladder_rung = undefined;
    ticket.last_failure_class = undefined;

    // Verify.
    const verifyStart = Date.now();
    const verifyPhase = `${ticket.number}-${String(attempt).padStart(2, "0")}-verify`;
    console.log(`[${nowClock()}]   ${ticket.number} verify: $ ${state.config.verify.join(" && ")}`);
    const v: VerifyResult = await runVerify(state.cwd, state.config.verify, state.config.verify_timeout_sec);
    ticket.duration_ms += Date.now() - verifyStart;
    ticket.verify_ok = v.ok;
    const verifyBlob = v.outputs.join("\n");
    // Verify has no opencode event stream of its own to fall back on (unlike
    // implement/review, archived verbatim by executeOpendCode), so its full
    // output is written to its own sidecar under events/ — state.json (see
    // writeState — rewritten wholesale on nearly every phase transition)
    // keeps only a bounded tail + pointer, not a second unbounded copy.
    await writeRawLog(ledger, verifyPhase, verifyBlob);
    if (v.ok) {
      console.log(`[${nowClock()}]   ${ticket.number} verify ✓ PASS`);
    } else {
      const summary = compressVerifyOutput(verifyBlob, state.config.verify);
      console.log(`[${nowClock()}]   ${ticket.number} verify ✗ FAILED: ${summary.split("\n").slice(0, 5).join(" | ")}`);
    }
    ticket.logs.push(
      v.ok
        ? `verify ${verifyPhase}: ok (${verifyBlob.length} chars)`
        : boundedLog(`verify ${verifyPhase} FAILED`, verifyBlob),
    );
    await writeState(ledger, state);

    if (!v.ok) {
      const summarizeResult = await withFailureLadderOnThrow(
        () => summarizeIfNeeded(state, ledger, `${verifyPhase}-summarize`, compressVerifyOutput(verifyBlob, state.config.verify), "verify"),
        { backoff: state.config.infra_backoff_sec, budget: seatContextBudget(state, "extract"), restartWorker: ladderRestart(state) },
      );
      const summarizedBlob = summarizeResult.ok ? summarizeResult.value : compressVerifyOutput(verifyBlob, state.config.verify);

      // gh #105 / ADR 0032: spec-anchored reconciliation. A verify failure
      // whose (compressed) output names a file THIS phase authored is a
      // candidate TEST bug — the session that wrote the test is exactly the
      // context that cannot see its error (the incident burned the whole step
      // budget on an off-by-one in its own undo/redo test). The only artifact
      // no model phase authored is the human plan origin prompt, so it goes —
      // with the failure output, the attributed files, and the diff — to a
      // FRESH arbiter once per ticket per run (ticket.reconcile is the spent
      // flag; a resume reads it back from writeState). Blame-aware feedback
      // applies on every round with non-empty attribution, whether the arbiter
      // ran, ruled, or failed.
      let reconcileGreened = false;
      let reconcilePrefix: string | null = null;
      let blamePreamble: string | null = null;
      const workingDiffPaths = changedPathsFromDiff(await git.workingDiff(state.cwd).catch(() => ""));
      const authoredFailing = authoredPathsInFailure(summarizedBlob, workingDiffPaths);
      if (authoredFailing.length > 0) {
        blamePreamble = buildBlamePreamble(authoredFailing);
        if (ticket.reconcile === undefined) {
          const origin = await readPlanOrigin(join(state.tickets_dir, ".."));
          const spec = origin?.prompt?.trim();
          if (spec) {
            const reconcilePhase = `${ticket.number}-${String(attempt).padStart(2, "0")}-reconcile`;
            const reconcileDiff = await git.workingDiff(state.cwd).catch(() => "");
            const recRun = await withFailureLadderOnThrow(
              () => runSpecReconcile({
                cwd: state.cwd,
                ledgerDir: ledger,
                phaseFile: reconcilePhase,
                model: state._models?.implement ?? null,
                spec,
                ticketNumber: ticket.number,
                title: parsed.title,
                criteria: parsed.criteria,
                failureOutput: summarizedBlob,
                authoredFailing,
                diff: reconcileDiff,
                live: !state.quiet, verbose: state.verbose,
                maxSteps: Math.min(RECONCILE_MAX_STEPS, state.config.max_phase_steps ?? RECONCILE_MAX_STEPS),
                stallTimeoutSec: state.config.stall_timeout_sec,
                maxStepModelSec: state.config.max_step_model_sec,
                maxContextTokens: contextBudget(state),
              }),
              { backoff: state.config.infra_backoff_sec, budget: contextBudget(state), restartWorker: ladderRestart(state) },
            );
            const rec = recRun.ok ? recRun.value : { ok: false as const, detail: recRun.rung.diagnosis };
            if (rec.ok && rec.verdict === "test") {
              const { applied, dropped } = await applyReconcileEdits(state.cwd, rec.edits, authoredFailing);
              if (dropped.length > 0) {
                ticket.logs.push(`reconcile ${reconcilePhase}: dropped edits outside the attribution perimeter: ${dropped.join(", ")}`);
              }
              ticket.reconcile = { verdict: "test", findings: rec.findings, applied };
              if (applied.length > 0) {
                // The spec ruled the test wrong and the railhead applied its
                // correction — verify once more. Green: this round ends as an
                // ordinary green verify (smoke/review/commit proceed, ADR 0006
                // holds — verify is green at the commit) WITHOUT the
                // verify_failed event reaching the gate machine. Still red:
                // ordinary retry with the arbiter's findings prepended.
                const v2 = await runVerify(state.cwd, state.config.verify, state.config.verify_timeout_sec);
                await writeRawLog(ledger, `${verifyPhase}-reconcile`, v2.outputs.join("\n"));
                if (v2.ok) {
                  reconcileGreened = true;
                  ticket.verify_ok = true;
                  const note = `reconcile ${reconcilePhase}: railhead applied test fixes to ${applied.join(", ")} — the spec ruled the test wrong; re-verify green`;
                  ticket.logs.push(note);
                  console.log(`[${nowClock()}]   ${ticket.number} reconcile ✓ test-fix applied (${applied.join(", ")}) — re-verify green`);
                } else {
                  reconcilePrefix = reconcileFindingsBlock("test", rec.findings);
                  ticket.logs.push(`reconcile ${reconcilePhase}: applied test fixes to ${applied.join(", ")} but verify still red — retrying with the arbiter's findings`);
                  console.log(`[${nowClock()}]   ${ticket.number} reconcile ✗ test-fix applied (${applied.join(", ")}) but verify still red — retrying`);
                }
              } else {
                reconcilePrefix = reconcileFindingsBlock("test", rec.findings);
                ticket.logs.push(`reconcile ${reconcilePhase}: ${rec.edits.length ? "no edits within the attribution perimeter" : "no complete FILE blocks parsed"} — retrying with the arbiter's findings`);
                console.log(`[${nowClock()}]   ${ticket.number} reconcile ✗ test verdict without applicable edits — retrying`);
              }
            } else if (rec.ok && rec.verdict === "impl") {
              reconcilePrefix = reconcileFindingsBlock("impl", rec.findings);
              ticket.reconcile = { verdict: "impl", findings: rec.findings, applied: [] };
              ticket.logs.push(`reconcile ${reconcilePhase}: fresh arbiter ruled the IMPLEMENTATION wrong (${rec.findings.length} finding(s)) — retrying with the findings`);
              console.log(`[${nowClock()}]   ${ticket.number} reconcile ⛔ impl verdict — ${rec.findings.length} finding(s) prepended to the retry`);
            } else {
              const detail = rec.ok ? null : rec.detail;
              ticket.reconcile = { verdict: "inconclusive", findings: rec.ok ? rec.findings : [], applied: [] };
              ticket.logs.push(`reconcile ${reconcilePhase}: ${rec.ok ? "arbiter ruled inconclusive" : `arbiter run failed (${detail ?? "unknown"})`} — one-shot spent, ordinary retry`);
              console.log(`[${nowClock()}]   ${ticket.number} reconcile ~ inconclusive (${detail ?? "no ruling"}) — one-shot spent`);
            }
            await writeState(ledger, state);
          }
        }
      }

      if (!reconcileGreened) {
        const r = advanceRetry(counters, { type: "verify_failed", output: summarizedBlob }, limits);
        counters = r.counters;
        if (r.step.next === "implement") {
          let feedback = (r.step as { feedback: string }).feedback;
          const prefixParts: string[] = [];
          if (blamePreamble) prefixParts.push(blamePreamble);
          if (reconcilePrefix) prefixParts.push(reconcilePrefix);
          if (prefixParts.length) feedback = prefixParts.join("\n\n") + "\n\n" + feedback;
          prevFeedback = feedback;
        }
        // Issue: a verify failure that proves a plan-authored artifact claim
        // false (the AC-mandated dependency does not resolve) is a plan defect,
        // not an ordinary build break — retrying the same resolution burns the
        // budget. Reroute the feedback to substitute a real artifact and record
        // the decision instead of re-running the doomed install.
        const contradiction = await planContradictionFor(state, ticket, verifyBlob);
        if (contradiction) {
          logPlanContradiction(state, ticket, contradiction);
          if (r.step.next === "implement") {
            prevFeedback = `${contradiction}\n\n${prevFeedback ?? ""}`;
          }
        }
        // Mine the verify failure for a correction to learnings.md (#42).
        // The implementer's transcript may or may not have emitted LEARNED:;
        // mineFailureLearning skips silently when it did.
        await mineFailureLearning(state, ledger, phaseFile, { verifyOutput: verifyBlob });
        continue; // next build attempt
      }
    }

    // ADR 0040 (amended): verify-green is the externally validated progress
    // signal that restarts the ticket's wall clock — NOT the bare checkpoint
    // marker (a premature checkpoint whose verify fails would otherwise reset
    // the very budget that exists to bound that thrash). Reaching this line
    // means verify passed, on this round or via a reconcile re-verify. The
    // step budget stays cumulative: total work remains bounded.
    ticket.build_ms_since_checkpoint = 0;

    // Smoke (binary-launch): runs only when the config declared a launch
    // command AND a framework recipe matched. Stronger than verify — a Bevy
    // app whose `cargo build` is green can still panic on frame 1 (the
    // B0001 query-alias case that prompted this phase), and only actually
    // launching the binary surfaces that. Treated exactly like verify on
    // failure: advance the retry counter, drop the carried diff, continue
    // back to implement. Skipped entirely when no recipe — a library-only
    // project has nothing to launch, and the planner's $SMOKE: NONE already
    // left state.config.smoke empty.
    if (smokeRecipe) {
      const smokeStart = Date.now();
      const s: SmokeResult = await runSmoke(
        state.cwd,
        { command: smokeRecipe.command, env: smokeRecipe.env },
        state.config.smoke_timeout_sec,
      );
      ticket.duration_ms += Date.now() - smokeStart;
      const smokePhase = `${ticket.number}-${String(attempt).padStart(2, "0")}-smoke`;
      const smokeBlob = s.outputs.join("\n");
      await writeRawLog(ledger, smokePhase, smokeBlob);
      const failReason = s.panic ? "PANIC" : s.notFound ? "NOT_FOUND" : "FAILED";
      ticket.logs.push(
        s.ok
          ? `smoke ${smokePhase}: ok (${smokeBlob.length} chars)`
          : s.notFound
            ? `smoke ${smokePhase}: skipped (command not found — feature not built yet)`
            : boundedLog(`smoke ${smokePhase} ${failReason}`, smokeBlob),
      );
      await writeState(ledger, state);

      // Smoke outcomes must reach the console, not just ticket.logs — a
      // silent smoke retry once read as "verify PASS, then the run died for
      // no reason" (the snake-run ticket 01 budget kill hid exactly this).
      if (s.ok) {
        console.log(`[${nowClock()}]   ${ticket.number} smoke ✓ PASS${s.timedOut ? " (still running at the timeout — a launched app is the success case)" : ""}`);
      } else if (s.notFound) {
        console.log(`[${nowClock()}]   ${ticket.number} smoke ⊘ skipped (command not found — feature not built yet)`);
      } else {
        const tail = smokeBlob.trim().split("\n").filter((l) => l.trim()).slice(-3).join(" | ");
        console.log(`[${nowClock()}]   ${ticket.number} smoke ✗ ${failReason}: ${tail.slice(0, 300)}`);
      }

      if (!s.ok && !s.notFound) {
        const smokSummarizeResult = await withFailureLadderOnThrow(
          () => summarizeIfNeeded(state, ledger, `${smokePhase}-summarize`, compressVerifyOutput(smokeBlob, state.config.smoke), "smoke"),
          { backoff: state.config.infra_backoff_sec, budget: seatContextBudget(state, "extract"), restartWorker: ladderRestart(state) },
        );
        const summarizedBlob = smokSummarizeResult.ok ? smokSummarizeResult.value : compressVerifyOutput(smokeBlob, state.config.smoke);
        const r = advanceRetry(counters, { type: "verify_failed", output: summarizedBlob }, limits);
        counters = r.counters;
        prevFeedback = r.step.next === "implement" ? (r.step as { feedback: string }).feedback : null;
        const smokeContradiction = await planContradictionFor(state, ticket, smokeBlob);
        if (smokeContradiction) {
          logPlanContradiction(state, ticket, smokeContradiction);
          if (r.step.next === "implement") {
            prevFeedback = `${smokeContradiction}\n\n${prevFeedback ?? ""}`;
          }
        }
        continue; // next build attempt
      }
    }

    // Interaction smoke (v2 issue 01): once per committed group boundary and
    // BLOCKING — a fresh opencode agent launches the running app and drives ONE
    // real user interaction with a render-delta plus zero-console-errors
    // assertion (a curl-style 200 is not evidence). This is the earliest gate
    // that closes the "app launches, request 200, canvas is an unwired rect"
    // failure class. It runs on the ticket that completes a group (or on every
    // ticket when the plan is ungrouped), so it judges the composed group
    // artifact rather than a single ticket's partial work. Fails like smoke:
    // the finding feeds back to the implementer and retries before review.
    // Skipped when the config resolves it off, there is no resolved model, or
    // the declared interface is non-interactive.
    const interactionBoundary = !ticket.group || state.tickets
      .filter((t) => t.group === ticket.group && t.file !== ticket.file)
      .every((t) => t.status === "committed");
    if (interactionSmokeEnabled(state.config) && interactionBoundary) {
      const interactModel = state._models?.visual ?? state._models?.review ?? state._models?.implement ?? null;
      const iface = state.config.projectInterface;
      if (interactModel !== null && iface !== "none") {
        const isPhase = `${ticket.number}-${String(attempt).padStart(2, "0")}-interact`;
        const scopeTag = scopeLabel(state.tickets, ticket);
        const runHint = runCommandFromVerify(state.config.verify, allParsed);
        const hints = state.config.visual_review?.interaction_hints ?? state.config.goal_review?.interaction_hints ?? null;
        const scope = interactionSmokeScopeFor(parsed, allParsed, state);
        const prompt = buildInteractionSmokePrompt({
          runCommandHint: runHint,
          verifyCommands: state.config.verify,
          interactionHints: hints,
          projectInterface: iface,
          scope,
        });
        const smokeRetry = await withFailureLadderOnThrow(
          () => runReviewAgent({
            label: "interaction smoke",
            prompt,
            cwd: state.cwd,
            ledgerDir: ledger,
            phaseFile: isPhase,
            model: interactModel,
            agent: RAILHEAD_AGENT_NAMES.observe,
            baseSession: baseSessionId(state),
            live: !state.quiet,
            verbose: state.verbose,
            heartbeat: true,
            livePrefix: "interact",
            maxSteps: state.config.max_phase_steps,
            stallTimeoutSec: state.config.stall_timeout_sec,
            maxStepModelSec: state.config.max_step_model_sec,
            maxContextTokens: seatContextBudget(state, "visual"),
          }),
          { backoff: state.config.infra_backoff_sec, budget: seatContextBudget(state, "visual"), restartWorker: ladderRestart(state) },
        );
        const agentOutcome = smokeRetry.ok
          ? smokeRetry.value
          : { status: "incomplete" as const, transcript: "", detail: smokeRetry.rung.diagnosis };
        if (agentOutcome.status === "ok") {
          const verdict = parseInteractionSmokeVerdict(agentOutcome.transcript);
          if (verdict.verdict === "pass") {
            // v2 issue 01: a browser-ui PASS must carry real-input + render
            // observation evidence; a startup-only run (a 200, a listening
            // port) is downgraded to inconclusive, never recorded as green.
            let gap: string | null = null;
            if (iface === "browser-ui") {
              const raw = await readFile(eventPath(ledger, isPhase), "utf8").catch(() => "");
              gap = interactionSmokePassGap(parseToolCalls(raw), iface);
            }
            if (gap) {
              ticket.logs.push(`interact ${isPhase}: $SMOKE_PASS downgraded to inconclusive — ${gap}`);
              console.log(`[${nowClock()}] [${scopeTag}] interaction smoke ⚠ inconclusive — ${gap}`);
            } else {
              ticket.logs.push(`interact ${isPhase}: ok — app operated by a real interaction`);
              console.log(`[${nowClock()}] [${scopeTag}] interaction smoke ✓ PASS — app operated by a real interaction`);
            }
          } else if (verdict.verdict === "fail") {
            const findings = verdict.findings;
            ticket.logs.push(`interact ${isPhase}: FAIL — ${findings.length} finding(s)`);
            console.log(`[${nowClock()}] [${scopeTag}] interaction smoke ✗ FAIL: ${findings.slice(0, 3).join(" | ")}`);
            await writeState(ledger, state);
            const r = advanceRetry(counters, { type: "verify_failed", output: findings.join("\n") }, limits);
            counters = r.counters;
            prevFeedback = r.step.next === "implement" ? (r.step as { feedback: string }).feedback : null;
            continue; // next build attempt
          } else {
            const noSurface = agentOutcome.transcript.includes("$SMOKE_INCONCLUSIVE");
            const why = noSurface ? "no interactive surface built yet" : "agent produced no verdict (app could not be driven)";
            ticket.logs.push(`interact ${isPhase}: inconclusive — ${why}; not a failure`);
            console.log(`[${nowClock()}] [${scopeTag}] interaction smoke ⊘ inconclusive — ${why}; not a failure`);
          }
        } else {
          ticket.logs.push(`interact ${isPhase}: ${agentOutcome.detail}`);
          console.log(`[${nowClock()}] [${scopeTag}] interaction smoke ⊘ inconclusive — ${agentOutcome.detail}; not a failure`);
        }
        await writeState(ledger, state);
      }
    }

    // Working-diff review (gated by code_review.mode, issue #73). `full` and
    // `medium` review the working diff per ticket — blocking findings feed the
    // retry loop (ADR 0005). `light`/`off` commit after verify: `light`
    // defers code review to the run-end pass over committed diffs, `off`
    // skips the gate entirely.
    const codeMode = state.config.code_review?.mode ?? "light";
    // An open-ended craft ticket's product is the rendered artifact, not the
    // diff; a diff review adds a gate cycle without judging the thing that
    // matters. The run-end visual/goal gate holds that seat. Skip per-ticket
    // review for it regardless of code_review.mode.
    const openEnded = parsed.open_ended === true;
    if (!codeReviewRunsMidRun(codeMode) || openEnded) {
      // No per-ticket review; commit after verify.
      ticket.review_ok = null;
      ticket.review_attempts = 0;
      if (openEnded && codeReviewRunsMidRun(codeMode)) {
        ticket.logs.push(`review ${ticket.number}: skipped (open-ended craft ticket — the artifact is judged by the run-end visual/goal gate, not a diff review)`);
      }
    } else {
      const rawDiff = await git.workingDiff(state.cwd);
      const diff = stripNonSource(rawDiff);
      const rvPhase = `${ticket.number}-${String(attempt).padStart(2, "0")}-review`;
      const reviewStart = Date.now();
      // Issue #64: full index, not a slice — same rationale as the
      // implementer prompt. The reviewer must see the contracts of files the
      // ticket edits but doesn't declare, or it cannot flag a contract/runtime
      // drift like the BootScene replacement.
      const reviewContracts = await loadContracts(state.cwd);

      // Pre-review lint (issue #41): run the project's deterministic linter
      // after verify passes and before the LLM reviewer. Non-blocking — the
      // output is injected into the reviewer prompt so the LLM can focus on
      // logic and design rather than style or common bug patterns the linter
      // already caught. Skipped silently when no lint commands are configured.
      let lintOutput: string | null = null;
      if (state.config.lint && state.config.lint.length > 0) {
        const lintResult = await runVerify(state.cwd, state.config.lint, state.config.verify_timeout_sec);
        const lintBlob = lintResult.outputs.join("\n");
        const lintPhase = `${ticket.number}-${String(attempt).padStart(2, "0")}-lint`;
        await writeRawLog(ledger, lintPhase, lintBlob);
        if (!lintResult.ok) {
          lintOutput = lintBlob;
          ticket.logs.push(`lint ${lintPhase}: ${lintResult.timedOut ? "TIMEOUT" : "findings"} (${lintBlob.length} chars)`);
        } else {
          ticket.logs.push(`lint ${lintPhase}: clean`);
        }
        await writeState(ledger, state);
      }

      const threshold = seatContextBudget(state, "review") * REVIEW_MODE_THRESHOLD_RATIO;
      const useReadMode = threshold > 0 && estimateTokens(diff) > threshold;
      // Issue #46: middle band — too large to inline, not large enough for
      // read-mode. Write the diff to a ledger file and hand the reviewer a
      // path + stat. The caller owns the threshold decision (mirroring
      // read-mode); review() writes the file and routes to the read agent.
      const fileThreshold = seatContextBudget(state, "review") * DIFF_FILE_THRESHOLD_RATIO;
      const useDiffFile = !useReadMode && fileThreshold > 0 && estimateTokens(diff) > fileThreshold;
      const reviewStat = (useReadMode || useDiffFile) ? await git.diffStat(state.cwd, ticket.start_commit ?? "HEAD~1").catch(() => "") : undefined;
      const diffFilePath = useDiffFile ? join(ledger, "events", `${rvPhase}.diff`) : undefined;
      const sourceFiles = (await git.filesChanged(state.cwd, ticket.start_commit ?? "HEAD~1", "HEAD").catch(() => ""))
        .split("\n").map((f) => f.trim()).filter((f) => f.length > 0);

      // Issue #34: pass the planner's design/architecture intent to the
      // per-ticket reviewer so it judges the diff against the planned vision,
      // not just the ticket ACs. Issue #99: the coherence charter rides along
      // for surface tickets (chrome conformance is this diff seat's earliest
      // check); the narrative is surface-gated inside the prompt builder.
      const surface = touchesVisualSurface(parsed);
      const rvDesignDoc = await git.readProjectDoc(state.cwd, join(state.docs_dir, "design.md"));
      const rvArchitectureDoc = await git.readProjectDoc(state.cwd, join(state.docs_dir, "architecture.md"));
      const rvCoherenceDoc = surface ? await git.readProjectDoc(state.cwd, "docs/coherence.md") : null;

      const reviewResult = await withFailureLadderOnThrow(
        () => review({
          cwd: state.cwd,
          ledgerDir: ledger,
          phaseFile: rvPhase,
      model: state._models?.review ?? null,
          ticketFile: ticket.file,
          ticketBody: parsed.what,
          criteria: parsed.criteria,
          diff,
          contracts: reviewContracts.entries.length ? reviewContracts : undefined,
          priorFindings,
          live: !state.quiet, verbose: state.verbose,
          heartbeat: true,
          livePrefix: `${ticket.number} review`,
          maxSteps: state.config.max_phase_steps,
          stallTimeoutSec: state.config.stall_timeout_sec,
          maxStepModelSec: state.config.max_step_model_sec,
          fixMode: !!state.config.fix_mode,
          maxContextTokens: seatContextBudget(state, "review"),
          readMode: useReadMode,
          inheritTools: state.config.code_review?.inherit_tools ?? true,
          stat: reviewStat,
          files: useReadMode ? sourceFiles : undefined,
          diffFile: diffFilePath,
          diffStat: useDiffFile ? reviewStat : undefined,
          attempt,
          baseSession: baseSessionId(state),
          designDoc: rvDesignDoc,
          architectureDoc: rvArchitectureDoc,
          surface,
          coherenceDoc: rvCoherenceDoc,
          lintOutput,
        }),
        {
          backoff: state.config.infra_backoff_sec,
          budget: seatContextBudget(state, "review"),
          restartWorker: ladderRestart(state),
          onRung: (rung) => {
            console.log(`[${nowClock()}]   ${ticket.number} review: ${rung.diagnosis}`);
          },
        },
      );
      if (!reviewResult.ok) {
        ticket.logs.push(reviewResult.rung.diagnosis);
        await writeState(ledger, state);
        continue;
      }
      const verdict = reviewResult.value;

      // Push path: a text reviewer is diff-based and rarely discovers a
      // tooling fact, but if it does emit a LEARNED: line, capture it here
      // rather than discarding it. The parser returns null cleanly when
      // nothing was emitted — no extra model call, no extraction overhead.
      await pushLearnings(state, ledger, rvPhase);

      ticket.duration_ms += Date.now() - reviewStart;
      const blocking = verdict.blocking;
      // Blocking review with retry loop. Severity decides the action:
      //  - minor: PASS, note the items, never retry (ADR 0005).
      //  - major: in light mode, soft-pass (same as minor); in medium/full,
      //    retry up to the review budget; soft-pass at the cap if no blocker.
      //  - blocker: always retry; fail the ticket if one survives the attempt cap.
      const current = verdict.mustFix.length ? verdict.mustFix : (blocking && blocking !== "NONE" && blocking !== "none" ? [blocking] : []);
      const currentStripped = ticket.verify_ok === true ? stripCompileClaimsWhenGreen(current, true) : current;
      const compileDropped = current.length - currentStripped.length;
      const compileNote = compileDropped > 0 ? `; ${compileDropped} compile-claim(s) dropped (verify green)` : "";
      // Issue #94: a [BLOCKER] that names no path in this ticket's diff is a
      // speculative claim the verify gate cannot refute — the ADR 0014 failure
      // class (hallucinated blockers burned 9 retries). Downgrade it to
      // [MAJOR]; severity, retry, feedback, and priorFindings act on the
      // downgraded set exactly as they act on the compile-stripped set.
      // Read-mode reviewers read whole files and may legitimately anchor on an
      // unchanged call site the change breaks, so their files list joins the
      // anchors. Verify-red rounds never downgrade — a real failure keeps
      // full force.
      const gate = ticket.verify_ok === true
        ? downgradeUnanchoredBlockers(currentStripped, [...changedPathsFromDiff(diff), ...(useReadMode ? sourceFiles : [])])
        : { findings: currentStripped, downgraded: 0 };
      const gated = gate.findings;
      const downgradedCount = gate.downgraded;
      const downgradeNote = downgradedCount > 0 ? `; ${downgradedCount} blocker(s) downgraded (no anchor in this ticket's diff)` : "";
      const sev = severityOf(gated);

      // Issue #96: light mode gives a [MAJOR] finding exactly ONE corrective
      // attempt per ticket (a real-but-not-blocking gap — the SpriteForge
      // toolbar pointer-capture bug — deserves a fix shot without stalling
      // the run). After that shot a MAJOR soft-passes. medium/full feed
      // MAJORs to the retry machine as before; BLOCKERs are unchanged in
      // every mode. The shot is per ticket: a NEW major on the re-review
      // must not chain a fresh retry (#70's never-reset discipline).
      const majorOneShotLeft = codeMode === "light" && sev === "major" && majorRetriesSpent === 0;
      if (!severityTriggersRetry(sev, codeMode) && !majorOneShotLeft) {
        // Findings don't meet the retry threshold for this mode. Two flavours:
        // a minor-only round is an ordinary pass; an exhausted light-mode MAJOR
        // (its one corrective attempt was spent, issue #96) is a SOFT-PASS —
        // the residual must reach the summary as "soft-pass ⚠", not a green
        // PASS, so the known-fragile gap is named rather than hidden.
        const thresholdLabel = sev === "minor" ? "minor only" : `${sev} (light mode — one corrective attempt already spent; soft-pass)`;
        if (codeMode === "light" && sev === "major") {
          ticket.review_ok = true;
          ticket.review_attempts = counters.reviewFailures + 1;
          ticket.reviews.push({ phase: rvPhase, attempt, blocking: false, findings: gated });
          ticket.logs.push(`review ${rvPhase} soft-pass after one MAJOR corrective attempt${compileNote}${downgradeNote}`);
          console.log(`[${nowClock()}]   ${ticket.number} review ⚠ SOFT-PASS (major — one corrective attempt spent, not resolved): ${reviewSummary(gated)}${compileNote}${downgradeNote}`);
          lastBlockingFindings = gated;
          break;
        }
        ticket.review_ok = true;
        ticket.review_attempts = counters.reviewFailures + 1;
        ticket.reviews.push({ phase: rvPhase, attempt, blocking: false, findings: gated });
        ticket.logs.push(`review ${rvPhase} passed (${thresholdLabel}): ${gated.length} item(s) noted${compileNote}${downgradeNote}`);
        console.log(`[${nowClock()}]   ${ticket.number} review ✓ PASS (${thresholdLabel}): ${reviewSummary(gated)} noted, no retry; ${Math.max(0, maxAttempts - attempt)} attempt(s) left${compileNote}${downgradeNote}`);
      } else {
        lastBlockingFindings = gated;
        // Spend the light-mode one-shot before the machine sees the round, so
        // a machine "fail" verdict (budget hot from earlier rounds) collapses
        // to soft-pass below rather than hard-failing a MAJOR in light mode.
        if (majorOneShotLeft) majorRetriesSpent = 1;
        const distinct = gated.every((f) => !priorFindings.includes(f));
        const r = advanceRetry(
          counters,
          { type: "review_blocking", findings: gated, priorFindings },
          limits,
        );
        counters = r.counters;
        for (const f of gated) {
          if (!priorFindings.includes(f)) priorFindings.push(f);
        }
        ticket.review_attempts = counters.reviewFailures;
        ticket.reviews.push({
          phase: rvPhase,
          attempt,
          blocking: true,
          findings: gated,
        });
        ticket.logs.push(`review ${rvPhase} ${sev} (${counters.reviewFailures})${compileNote}${downgradeNote}`);
        await writeState(ledger, state);
        // Mine the review BLOCKER for a correction to learnings.md (#42).
        // Skips silently when the reviewer already emitted its own LEARNED:.
        await mineFailureLearning(state, ledger, rvPhase, { reviewFindings: gated });
        if (r.step.next === "fail") break; // budget exhausted — falls through to the soft-pass/fail decision
        prevFeedback = (r.step as { feedback: string }).feedback;
        const attemptsLeft = Math.max(0, maxAttempts - attempt);
        const sevLabel = sev === "blocker" ? "BLOCKER" : "MAJOR";
        if (distinct) {
          console.log(`[${nowClock()}]   ${ticket.number} review ⛔ ${sevLabel} ${reviewSummary(current)} — code improved, retry budget reset; ${attemptsLeft} attempt(s) left`);
        } else {
          console.log(`[${nowClock()}]   ${ticket.number} review ⛔ ${sevLabel} ${reviewSummary(current)} — review ${counters.reviewFailures}/${limits.reviewBudget}; ${attemptsLeft} attempt(s) left`);
        }
        continue; // re-implement to address findings
      }
    }

    // Committed: record the commit and its ticket state BEFORE the contract
    // extract pass, so an interrupt in that sub-pass can't lose a finished
    // ticket (state written as committed means resume won't redo it).
    const msg = `${ticket.number} — ${ticket.title}`;
    ticket.commit = await git.commitOrReuseHead(state.cwd, msg);
    const reused = ticket.commit === ticket.start_commit;
    if (implementPhaseFiles.size > 0) ticket.context = await summarizePhaseFiles(ledger, implementPhaseFiles);
    return committedTicket(state, ledger, ticket, parsed, msg, reused, reused ? "already-implemented" : "commit");
  }

  // Exhausted the loop. Two reasons: retry budget burned (advanceRetry said
  // "fail") or the attempt cap hit. On the attempt cap, if no [BLOCKER]
  // finding remains — the ticket basically works — soft-pass: commit it with
  // the residual non-blocking findings noted, and let downstream tickets
  // proceed.
  const attemptCapHit = attempt >= maxAttempts;
  // Soft-pass conditions: no [BLOCKER] finding stands AND we've run out of
  // runway. Runway is either the attempt cap, or — issue #96 — light mode
  // reaching a break with only non-blocking findings: a light-mode one-shot
  // MAJOR that the budget machine would have failed is a soft-pass, never a
  // hard fail (light's contract is "don't let a MAJOR stall the run").
  const softPassable =
    lastBlockingFindings.length > 0 &&
    severityOf(lastBlockingFindings) !== "blocker" &&
    (attemptCapHit || reviewMode === "light");

  if (softPassable) {
    const msg = `${ticket.number} — ${ticket.title}`;
    ticket.commit = await git.commitOrReuseHead(state.cwd, msg);
    const reused = ticket.commit === ticket.start_commit;
    const reason = reviewMode === "light" && !attemptCapHit
      ? "light-mode MAJOR not resolved after its one corrective attempt"
      : "at attempt cap";
    ticket.logs.push(`soft-pass (${reason}): ${lastBlockingFindings.length} finding(s) remain`);
    // Surface the residual finding text so `railhead overview` and the
    // end-of-run summary can name what's known-fragile without re-reading
    // the review transcript (issue #12, proposal C).
    for (const f of lastBlockingFindings) {
      ticket.logs.push(`  residual: ${f}`);
    }
    if (implementPhaseFiles.size > 0) ticket.context = await summarizePhaseFiles(ledger, implementPhaseFiles);
    return committedTicket(state, ledger, ticket, parsed, msg, reused, "soft-pass");
  }

  // Hard fail: retry budget exhausted, or a [BLOCKER] finding survived the attempt cap.
  ticket.status = "failed";
  const lastDiff = await git.workingDiff(state.cwd).catch(() => "");
  if (lastDiff) {
    if (ticket.verify_ok === true) {
      // ADR 0006: a verify-green tree is the floor for durable work. A gate
      // verdict (reviewRounds past the budget, a standing BLOCKER) is not a
      // broken build, so preserve the work as a checkpoint commit — the same
      // shape resume gives in-flight work — instead of wiping it. The
      // SpriteForge-06 incident: verify-green UI work with one standing
      // [MAJOR] was wiped from the branch, and the only copy was a stash the
      // operator had to discover. `rebaseFrontier` re-arms this ticket on
      // resume, so the re-run starts from this checkpoint either way.
      const checkpointMsg = `${ticket.number} — ${ticket.title} (checkpoint — gate failed, verify green)`;
      const checkpoint = await git.commitOrReuseHead(state.cwd, checkpointMsg);
      ticket.logs.push(`checkpoint ${checkpoint} preserved on hard fail (verify green — work not wiped)`);
      console.log(`[${nowClock()}]   ${ticket.number} work preserved — checkpointed at ${checkpoint.slice(0, 8)} (verify green, not wiped)`);
    } else {
      const cleaned = await git.cleanWorktree(state.cwd, protectedPaths(state.cwd, state.tickets_dir));
      if (cleaned.untrackedArchivePath) {
        console.log(`[${nowClock()}] untracked work wiped — byte-for-byte copies archived to ${cleaned.untrackedArchivePath}`);
      }
      ticket.logs.push("work wiped (verify red — a failed tree must not become a checkpoint base)");
    }
  }
  if (implementPhaseFiles.size > 0) ticket.context = await summarizePhaseFiles(ledger, implementPhaseFiles);
  ticket.logs.push("FAILED: retries exhausted");
  return "failed";
}

export function protectedPaths(cwd: string, ticketsDir: string): string[] {
  const rel =
    ticketsDir.startsWith(cwd)
      ? ticketsDir.slice(cwd.length).replace(/^[/\\]/, "").split("/")[0]
      : ticketsDir.split("/").filter(Boolean).pop() ?? "issues";
  return Array.from(
    new Set([
      rel,
      ".scratch",
      ".railhead",
      "railhead.json",
      ".gitignore",
      ".opencode",
      // opencode's project config files live at the repo root (NOT inside
      // .opencode/, which is already protected). They are untracked at plan
      // time — `ensureProjectOpenCodePermissions` writes `opencode.json`
      // AFTER the scaffold commit — so `git clean -fd` in `cleanWorktree`
      // would delete them between implement attempts, silently stripping
      // the implementer's external_directory grants and tripping the exact
      // permission-rejection loop the pre-grant was meant to prevent.
      "opencode.json",
      "opencode.jsonc",
      // Plan-time docs (AGENTS.md, CONTEXT.md) are written by `railhead build`
      // AFTER the scaffold commit but BEFORE `railhead run` starts — so they're
      // untracked at run start, and `git clean -fd` in `cleanWorktree` would
      // delete them on the first implement attempt. Every implementer reads
      // AGENTS.md for conventions and CONTEXT.md for the project glossary, so
      // losing them mid-run silently strips the shared guidance the plan step
      // was supposed to provide across all tickets.
      "AGENTS.md",
      "CONTEXT.md",
      CONTRACTS_FILE,
      // Project learnings (tooling facts from prior phases). Written by the
      // railhead after implement retries and visual review phases; read by
      // every subsequent implementer/reviewer/visual reviewer prompt. Untracked
      // at first-write — `git clean -fd` would delete it between implement
      // attempts, silently losing tooling facts the prior attempt discovered.
      // See ADR 0012.
      ".railhead/learnings.md",
    ]),
  );
}

// ---------------------------------------------------------------------------
// Issue #95 (ADR 0022 stages 1–3): the durable-session builder.
//
// processTicket's implement engine is runBuilderStep: each attempt resumes ONE
// durable opencode session (`--session <id>`, compaction permitted) with
// fresh diff-scoped gates interleaved between invocations. Everything else in
// processTicket — verify/smoke/review gates, the retry counters, the commit —
// is shared machinery.
//
// Granularity routing: `ticket` and `product` keep the per-ticket frontier
// loop (they differ only in the builder prompt's framing); `group` runs
// runBuilderGroupLoop, which hands the whole planner group to the session and
// gates it as ONE unit before committing the group in a single checkpoint.
// The COUNTER semantics are shared: every path drives the same `advanceRetry`
// machine (issue #106-G).
// ---------------------------------------------------------------------------

function ensureBuilderState(state: RunState): BuilderState {
  if (!state.builder) state.builder = newBuilderState();
  return state.builder;
}

/** Record a fresh-session recovery with its cause so the report can name
 * restarts (ADR 0022 §5, issue #95 stage 4). Does NOT touch the session
 * handle — the caller decides whether to drop it (fresh-session recovery) or
 * keep it (adopting a replacement session the executor opened). */
function recordBuilderRestart(state: RunState, ticketNumber: string, cause: string): void {
  ensureBuilderState(state).restarts.push({ at: new Date().toISOString(), cause: `${ticketNumber}: ${cause}` });
}

/** Drop the session handle so the NEXT invocation seeds a fresh session from
 * the last green commit (the state.builder continuity fields survive). */
function dropBuilderSession(state: RunState): void {
  ensureBuilderState(state).session_id = undefined;
}

/** Map a parsed ticket onto the builder prompt's thin ticket shape. */
function toBuilderTicket(parsed: Ticket): BuilderTicket {
  return {
    file: parsed.file,
    number: parsed.number,
    title: parsed.title,
    body: parsed.what,
    criteria: parsed.criteria,
    openEnded: parsed.open_ended === true,
  };
}

/** Scope the interaction smoke to the boundary it closes: the closed group's
 * claims plus which tickets exist yet. Without this the fresh judge reads the
 * design intent (the finished app) and fails a correct scaffold group for a
 * canvas a later group owns — the retry then over-implements the next ticket's
 * work. */
function interactionSmokeScopeFor(parsed: Ticket, allParsed: Ticket[], state: RunState): InteractionSmokeScope {
  const committed = new Set(state.tickets.filter((t) => t.status === "committed").map((t) => t.file));
  const group = parsed.group ?? null;
  return {
    group,
    groupTickets: allParsed
      .filter((t) => (group !== null ? t.group === group : t.file === parsed.file))
      .map((t) => ({ number: t.number, title: t.title, what: t.what, criteria: t.criteria })),
    frontier: allParsed.map((t) => ({
      number: t.number,
      title: t.title,
      group: t.group ?? null,
      built: t.file === parsed.file || committed.has(t.file),
    })),
  };
}

/** gh: record the group checkpoints a just-committed ticket completes as owed
 * BEFORE any long post-commit work (the per-ticket visual review) runs. The
 * checkpoint wrappers add the same markers immediately before their review
 * agents; this closes the window between the commit write and that moment,
 * where a crash would leave the group committed, unrecorded, and never
 * revisited. Predicates mirror the wrappers, so a gate that will not fire
 * marks nothing. */
function markGroupCheckpointsOwed(state: RunState, ticket: TicketState): void {
  const goalModel = state._models?.goal ?? null;
  const structuralCfg = state.config.structural_review;
  if (structuralCfg && firesMidRun(structuralCfg.mode) && goalModel !== null) {
    for (const group of structuralCheckpointsToFire(state, ticket)) addPendingCheckpoint(state, "structural", group);
  }
  const goalCfg = state.config.goal_review;
  if (goalCfg && goalFiresCheckpointsMidRun(goalCfg) && goalModel !== null) {
    for (const group of goalCheckpointsToFire(state, ticket)) addPendingCheckpoint(state, "goal", group);
  }
}

/** The gate label for a feedback string, so buildBuilderFindingsPrompt can
 * name the gate that spoke. Cheap prefix match on the strings the gate
 * machine itself emits; anything else reads as a generic railhead nudge.
 * gh #105: the composed feedback may carry the blame/reconcile preamble
 * BEFORE the gate's own text, so the markers are matched anywhere, not only
 * at the start. */
function feedbackSourceOf(feedback: string): string {
  if (feedback.includes("Verification failed")) return "verify";
  if (feedback.includes("Fix these must-fix issues")) return "review";
  return "railhead";
}

/** Which tickets the NEXT builder invocation should receive and which
 * checkpoint it must name, from the current run state + granularity. The unit
 * is re-derived per invocation (a live slice of what remains) so committed
 * tickets shrink the plan without the session needing to re-derive it. */
async function builderInvocationPlan(
  state: RunState,
  current: TicketState,
  granularity: CheckpointGranularity,
): Promise<{ unit: BuilderUnit; allParsed: Ticket[] }> {
  const allParsed = await loadTickets(state.tickets_dir);
  const byFile = new Map(allParsed.map((t) => [t.file, t]));
  // Tickets run strictly in array order; correctives are inserted ahead of the
  // remaining planned frontier. The current ticket leads the unit so the
  // session is always asked to checkpoint the work actually in flight.
  const remaining = state.tickets.filter((t) => t.status === "ready" || t.status === "in_progress");
  const currentInRemaining = remaining.some((t) => t.file === current.file);
  const orderedRemaining = currentInRemaining
    ? remaining
    : [current, ...remaining.filter((t) => t.file !== current.file)];
  let unit: BuilderUnit;
  if (granularity === "product") {
    unit = { tickets: [...orderedRemaining], checkpointAtEnd: false };
  } else {
    unit = nextBuilderUnit(orderedRemaining, granularity) ?? { tickets: [], checkpointAtEnd: false };
  }
  // The current ticket may not be the unit's leader (a corrective generated
  // mid-run, or a ticket reached out of plan order): fall back to a
  // single-ticket unit so the session is always asked to checkpoint the work
  // actually in flight, never a stale leader.
  if (byFile.get(current.file) && !unit.tickets.some((t) => t.file === current.file)) {
    unit = { tickets: [current], checkpointAtEnd: false };
  }
  if (unit.tickets.length === 0) {
    unit = { tickets: [current], checkpointAtEnd: false };
  }
  return { unit, allParsed };
}

/**
 * The durable-session builder engine. Resumes `state.builder.session_id` (or
 * starts fresh when none is held), asks the session to implement the current
 * unit and stop at a `$CHECKPOINT ticket=NN` marker, and returns ok only when
 * the marker names the ticket the run loop asked for.
 *
 * Gate findings arrive via `prevFeedback` and are re-injected IN CONTEXT with
 * buildBuilderFindingsPrompt — the session that wrote the code receives the
 * verdict, no context boundary to lose findings across (#61/#66/#67).
 *
 * Kill guards are telemetry-only (`guardMode: "telemetry"`): the request
 * ceiling is compaction's business, not a railhead kill switch. The #78 model-
 * time floor is NOT relaxed — a thrashing builder still dies (ADR 0022 §5).
 */
async function runBuilderStep(
  state: RunState,
  ledger: string,
  ticket: TicketState,
  parsed: Ticket,
  phaseFile: string,
  prevFeedback: string | null,
): Promise<ImplementResult> {
  const granularity = state.config.checkpoint_granularity ?? "product";
  const { unit, allParsed } = await builderInvocationPlan(state, ticket, granularity);
  const byFile = new Map(allParsed.map((t) => [t.file, t]));
  const expectedTicket = checkpointTarget(unit).number;
  // The directive grammar follows the UNIT's shape, not the raw config: a
  // group unit checkpoints at its end, an unlabeled ticket degenerates to a
  // per-ticket directive, product keeps its whole-build framing.
  const directiveGranularity: CheckpointGranularity =
    granularity === "product" ? "product" : unit.checkpointAtEnd ? "group" : "ticket";

  const builder = ensureBuilderState(state);
  const sessionId = builder.session_id ?? null;
  const promptTicketsAll = unit.tickets.map((ts) => {
    const p = byFile.get(ts.file);
    if (!p) throw new Error(`builder prompt: ticket file missing for ${ts.file} in ${state.tickets_dir}`);
    return toBuilderTicket(p);
  });
  // gh #105: under product granularity the prompt surfaces the CURRENT ticket
  // ONLY — pre-listing the whole remaining queue invited a session to
  // "announce" a checkpoint in prose and jump ahead into a later ticket (the
  // run-20260909-1501 drift: 03's phase wrote 04's first file). The unit still
  // derives the expected checkpoint marker below; only what the session SEES
  // is narrowed. `ticket`/`group` prompts are byte-identical to before.
  const promptTickets =
    directiveGranularity === "product" && promptTicketsAll.length > 1
      ? promptTicketsAll.filter((t) => t.file === ticket.file)
      : promptTicketsAll;
  const session = { sessionId, committedThrough: builder.committed_through ?? null, lastGreenCommit: builder.last_green_commit ?? null };
  const contracts = await loadContracts(state.cwd);
  const contractsBlock = contracts.entries.length ? summarizeContracts(contracts) : null;
  const learningsBlock = (await readLearnings(state.cwd)) || null;
  const digestBlock = (await readDigest(state.cwd)) || null;
  // Issue #99 (ADR 0028): the charter rides into the builder when the
  // invocation includes a surface ticket (at `ticket` granularity that is the
  // one ticket; group gates on ANY surface ticket in the batch). With product
  // sliced to the current ticket the charter tracks what the session actually
  // sees — a non-surface ticket does not carry a charter it cannot act on.
  const surface = promptTickets.some((t) => touchesVisualSurface(t));
  const charter = surface ? await git.readProjectDoc(state.cwd, "docs/coherence.md") : null;
  // Issue #34: the builder seat carried no design/architecture intent at all —
  // the fresh implementer has always had it, but under `session_builder` the
  // durable session was never handed the planner's aesthetic vision, so it
  // implemented the ticket ACs (structural predicates) with no target for the
  // look. The design narrative is surface-gated like the implementer's; the
  // architecture map is for every ticket.
  const designDoc = await git.readProjectDoc(state.cwd, join(state.docs_dir, "design.md"));
  const architectureDoc = await git.readProjectDoc(state.cwd, join(state.docs_dir, "architecture.md"));
  const designPath = designDoc ? join(state.docs_dir, "design.md") : undefined;
  const architecturePath = architectureDoc ? join(state.docs_dir, "architecture.md") : undefined;

  // Issue #106 (A): context blocks ride into the builder ONLY on a fresh seed
  // (sessionId null) or after an observed compaction — a warm session already
  // holds them from its seed (or the last re-inject) until compaction
  // summarizes them away, so re-injecting per resume is N-copy duplication in
  // one durable conversation. `builder.needs_full_context` is set at the
  // ticket commit whose merged build-phase telemetry showed a compaction; a
  // warm advance that sees it re-injects the FULL content. This is ADR 0022
  // §5's demotion realized: contracts/digest are gate-prompt inputs and the
  // fresh-session resume map, not per-resume builder memory. The flag is NOT
  // cleared here — it is re-derived from merged telemetry at the next green
  // commit (a successful full-context advance then reports compactions === 0
  // and overwrites it false).
  const feedback: GateFeedback | null = prevFeedback
    ? { source: feedbackSourceOf(prevFeedback), findings: [prevFeedback] }
    : null;

  /** Issue #106 (D): compose + execute ONE builder invocation for a given
   * target session and gate feedback. Isolated so a session-lost adoption can
   * re-drive once as a SEEDED advance (a fresh session must not receive a
   * findings prompt that references a "last checkpoint" it never had). */
  const visionCapability = await readVisionCapabilityFor(state.cwd, state._models?.implement ?? null);
  const driveOnce = async (opts: { sessionIdForPrompt: string | null; feedbackForPrompt: GateFeedback | null; fullContextOverride?: boolean }): Promise<{
    result: Awaited<ReturnType<typeof executeOpendCode>>;
  }> => {
    const targetSession = { ...session, sessionId: opts.sessionIdForPrompt };
    const useFull = opts.fullContextOverride ?? (opts.sessionIdForPrompt === null || builder.needs_full_context === true);
    // A findings prompt only makes sense for a session that already holds the
    // work being corrected. A fresh/reseeded invocation (no session id — first
    // run, or an infra recovery just dropped it) must get the seeded advance
    // prompt: the new session has no memory of the "last checkpoint" a gate
    // verdict would reference.
    const prompt = opts.feedbackForPrompt && opts.sessionIdForPrompt
      ? buildBuilderFindingsPrompt({
          session: targetSession,
          granularity: directiveGranularity,
          tickets: promptTickets,
          verify: state.config.verify,
          feedback: opts.feedbackForPrompt,
          design: surface ? designDoc : null,
          coherence: charter,
          visionCapability,
        })
      : buildBuilderPrompt({
          session: targetSession,
          granularity: directiveGranularity,
          tickets: promptTickets,
          verify: state.config.verify,
          // Full content on seed/post-compaction; standing pointers on a warm
          // resume whose session already holds them. The learnings RETRACTED
          // channel survives the pointer path (checkpointDirective's grammar +
          // the pointer's re-read-to-retract instruction — builder.ts).
          contracts: useFull ? contractsBlock : null,
          learnings: useFull ? learningsBlock : null,
          digest: useFull ? digestBlock : null,
          // v2 issue 01: a surface invocation gets the design intent on EVERY
          // prompt — the preamble on a fresh seed, a verbatim task re-injection
          // on a warm resume whose cheap model will not re-read it.
          designDoc: surface ? designDoc : null,
          designPath,
          reinjectDesign: !useFull,
          architectureDoc: useFull ? architectureDoc : null,
          contextPointers: useFull
            ? undefined
            : {
                contracts: contractsBlock ? CONTRACTS_FILE : undefined,
                learnings: learningsBlock ? ".railhead/learnings.md" : undefined,
                digest: digestBlock ? ".railhead/digest.md" : undefined,
          design: designPath,
          architecture: architecturePath,
          },
          charter,
          contextBudget: contextBudget(state),
          visionCapability,
        });
    // Issue #133: a fresh seed (first run, or after a session-lost recovery
    // dropped the handle) branches off the base session with the builder's
    // first task — the durable session's history then starts from the shared
    // `[system][preamble]` prefix. A resume keeps its stored session and
    // appends as before.
    const fork = opts.sessionIdForPrompt === null
      ? baseFork(state, prompt)
      : { session: opts.sessionIdForPrompt, fork: false, task: null };
    const result = await executeFreshPhase(joinPhaseMessages(prompt), {
      cwd: state.cwd,
      ledgerDir: ledger,
      phaseFile,
      model: state._models?.implement ?? null,
      agent: RAILHEAD_AGENT_NAMES.build,
      session: fork.session,
      fork: fork.fork,
      task: fork.task,
      guardMode: "telemetry",
      live: !state.quiet, verbose: state.verbose,
      heartbeat: true,
      livePrefix: `${ticket.number} build`,
      maxSteps: state.config.max_phase_steps,
      stallTimeoutSec: state.config.stall_timeout_sec,
      maxStepModelSec: state.config.max_step_model_sec,
      maxContextTokens: contextBudget(state),
      stopAfterMarker: CHECKPOINT_RE,
      stopAfterBlocked: true,
    });
    // The builder is ONE durable session resumed across invocations. When a
    // fresh or reseeded invocation succeeds, this capture is the handle every
    // later invocation resumes.
    if (result.sessionId) builder.session_id = result.sessionId;
    // Persist the session handle the moment it is known, so a SIGINT mid-run
    // can never lose the resume pointer even if the phase later dies.
    await writeState(ledger, state);
    return { result };
  };

  // Issue #95 stage 3 (resume fallback): a resumed id that comes back as a
  // DIFFERENT session means the durable session is gone (storage cleared, new
  // machine) and opencode started a fresh one. The repo IS at the last green
  // commit, so adopting the new session from here is correct. Issue #106 (D):
  // the invocation that just ran was composed for the OLD session's warm
  // state — a findings prompt referencing a "last checkpoint" the fresh
  // session never had, or an advance that (per #106-A) carried only standing
  // pointers a brand-new session does not hold. Either way the adopted
  // session's real seed must be the SEEDED ADVANCE with FULL context blocks,
  // so re-drive once against the adopted id. The cost is bounded: adoption is
  // a rare recovery, and a correctly-seeded session is worth one extra run.
  const resumed = sessionId;
  let first = await driveOnce({ sessionIdForPrompt: sessionId, feedbackForPrompt: feedback });
  if (resumed && first.result.status === "ok" && first.result.sessionId && first.result.sessionId !== resumed) {
    recordBuilderRestart(state, ticket.number, "session-lost (resumed id no longer attached — opencode started a fresh session from the last green commit)");
    const reseeded = await driveOnce({ sessionIdForPrompt: first.result.sessionId!, feedbackForPrompt: null, fullContextOverride: true });
    first = reseeded;
  }
  const { result } = first;

  // ADR 0040: every builder invocation counts against the ticket's cumulative
  // budget — ladder rungs and resumes included. The per-invocation
  // max_phase_steps resets with each process; these totals do not, and the
  // loop's budget check is what makes the cap real per ticket.
  ticket.build_ms_total = (ticket.build_ms_total ?? 0) + result.durationMs;
  ticket.build_steps_total = (ticket.build_steps_total ?? 0) + result.steps;
  // ADR 0040 (amended): the wall clock the budget actually checks — time
  // since the last green verify (the verify-green path in processTicket
  // restarts it; a bare checkpoint marker must not, because a premature
  // checkpoint that fails verify would otherwise reset the very budget that
  // exists to bound that thrash). The cumulative totals above stay telemetry.
  ticket.build_ms_since_checkpoint = (ticket.build_ms_since_checkpoint ?? 0) + result.durationMs;
  // The slowest invocation sizes the derived wall budget (two checkpoint-less
  // invocations of the slowest observed length = thrash), so the bound
  // self-calibrates to the model's actual speed instead of a fixed floor.
  ticket.build_ms_max_invocation = Math.max(ticket.build_ms_max_invocation ?? 0, result.durationMs);

  // gh #111: a halt mid-build is an honest stop, not a failure — propagate it
  // out of the builder engine so the run loop applies the halt directly.
  if (result.status === "halted") {
    return { ok: false, halted: true, reason: result.haltReason ?? result.errorMessage ?? "halt file present" };
  }

  if (result.status !== "ok") {
    const err = `build ${phaseFile} ${describeExecFailure(result)}`;
    const { compactions } = await analyzePhase(ledger, phaseFile);
    return { ok: false, err, evidence: { ...(result.evidence ?? evidenceFromResult(result)), compactions } };
  }

  // ADR 0040: a terminal `$BLOCKED` ends the invocation. Record it durably
  // here; the routing decision (verification debt / one corrective attempt /
  // bounded replan) belongs to the run loop, which sees the ticket's state.
  if (result.block) {
    ticket.blocks = [...(ticket.blocks ?? []), { kind: result.block.kind, reason: result.block.reason, at: new Date().toISOString() }];
    ticket.logs.push(`build ${phaseFile}: $BLOCKED (${result.block.kind}) — ${result.block.reason}`);
    if (result.block.ticket !== expectedTicket) {
      ticket.logs.push(`build ${phaseFile}: block named ticket ${result.block.ticket} but the railhead asked for ${expectedTicket} — routing against ${expectedTicket}`);
    }
    return { ok: false, blocked: result.block };
  }

  // Reconcile the checkpoint marker: the session was asked to checkpoint the
  // expected ticket and stop. An ok exit without that marker (or naming a
  // different ticket) means it stopped for another reason — resume it and
  // drive it to the checkpoint rather than gating half-done work.
  const markerTicket = result.checkpointTicket ?? readCheckpointTicket(await extractAssistantText(ledger, phaseFile));
  if (markerTicket !== expectedTicket) {
    // v2 issue 01 fallback: a turn that ended with NO marker but whose ticket
    // was already verified green counts as the checkpoint. Re-invoking only to
    // see the marker again wastes a whole builder invocation (five observed in
    // one run: 01, 07, 10, 12 twice); the marker stays primary, and this never
    // covers unverified work — the verify gate below still runs before commit.
    if (!markerTicket && ticket.verify_ok === true) {
      ticket.logs.push(`build ${phaseFile}: ended without a marker, but ticket ${expectedTicket} was already verify-green — counting it as the checkpoint (v2 issue 01 fallback)`);
      console.log(`[${nowClock()}]   ${ticket.number} build ⊘ no marker, already verify-green — counting it as the checkpoint`);
      ticket.context = await analyzePhase(ledger, phaseFile);
      return { ok: true, toolCalls: result.toolCalls };
    }
    const err =
      `build ${phaseFile}: exited ok but ${markerTicket ? `checkpointed ticket ${markerTicket}` : "emitted no checkpoint marker"} — expected a $CHECKPOINT ticket=${expectedTicket} (${granularity} granularity). The session stopped for a reason other than a clean checkpoint; continue in this session and drive it to checkpoint ${expectedTicket}.`;
    ticket.logs.push(err);
    // Spiral detection: a session that already compacted past the threshold
    // without producing its checkpoint does not fit the window — carrying the
    // compaction count as ladder evidence routes this to capacity (fresh
    // session from the last green commit) instead of the in-session "keep
    // driving" retry, which would re-enter the same compaction spiral.
    const { compactions } = await analyzePhase(ledger, phaseFile);
    const evidence = compactions >= SPIRAL_COMPACTION_THRESHOLD
      ? { ...evidenceFromResult(result), errorMessage: err, compactions }
      : null;
    return { ok: false, err, evidence };
  }

  ticket.context = await analyzePhase(ledger, phaseFile);
  const sessionBit = result.sessionId ? ` · session ${result.sessionId.slice(0, 8)}` : "";
  ticket.logs.push(`build ${phaseFile}: checkpoint ${markerTicket} (${result.steps} steps, ${result.totalOutputTokens} output tokens${sessionBit})`);
  console.log(
    `[${nowClock()}]   ${ticket.number} build ✓ checkpoint ${markerTicket} — ${result.steps} steps · ctx ${(result.inFlightTokens / 1000).toFixed(1)}k${sessionBit} · ${builder.checkpoint_count + 1} checkpoints`,
  );
  return { ok: true, toolCalls: result.toolCalls };
}

/**
 * Issue #95 stage 2 (`group` granularity): the whole planner group is handed
 * to the builder as ONE checkpoint; when its gate is green the group commits
 * as a single checkpoint commit. The FIRST member is driven through
 * processTicket (whose builder engine already receives the whole remaining
 * group and expects the LAST member's marker) — commitOrReuseHead stages the
 * entire tree, so the first member's commit contains every member's work. The
 * remaining members are then recorded as committed with that same commit and
 * the group-boundary gates (goal/structural) fire once the group is complete.
 *
 * Independent test phases for members 2..N are NOT run (they are authored by
 * the session itself inside the group invocation); the group diff is gated as
 * one unit by the railhead. Group-mode nuances are e2e territory (#83) — the
 * shipped default is `product` (whole build, per-ticket gates), and `group`
 * stays an explicit opt-in.
 */
async function processBuilderGroupUnit(
  state: RunState,
  ledger: string,
  unit: BuilderUnit,
): Promise<TicketOutcome> {
  const first = unit.tickets[0];
  const outcome = await processTicket(state, ledger, first);
  if (outcome === "failed") return "failed";
  if (outcome === "halted") return "halted";
  const groupCommit = first.commit;
  if (!groupCommit) throw new Error(`builder group ${first.number}: first member committed without a commit hash`);

  for (const member of unit.tickets.slice(1)) {
    if (member.status === "committed") continue;
    member.status = "committed";
    member.commit = groupCommit;
    member.verify_ok = true;
    member.review_ok = true;
    member.logs.push(`bulk: landed in ${first.number}'s group checkpoint commit ${groupCommit} — the whole group was gated as one unit`);
    if (state.builder) state.builder.committed_through = member.number;
  }
  // Group-boundary gates now that every member shows committed. Mark them owed
  // in this same write — the #62 visual join and the ticket lookup below are
  // awaits a crash could land in.
  const last = unit.tickets[unit.tickets.length - 1];
  markGroupCheckpointsOwed(state, last);
  await writeState(ledger, state);

  const parsedLast = (await loadTickets(state.tickets_dir)).find((t) => t.file === last.file);
  if (!parsedLast) throw new Error(`ticket file not found: ${last.file} in ${state.tickets_dir}`);

  // Issue #106 (B): #62 parity at the GROUP boundary. The first member's
  // committedTicket ran while members 2..N were uncommitted, so its own #62
  // serialization saw detectGroupCheckpoints == [] and skipped the join — the
  // first member's per-ticket visual review is still in flight here. The
  // group-boundary goal review below drives the SAME shared browser, so join
  // the pending visual first (mirrors committedTicket's #62 block exactly).
  if (state._pending_visual_review && goalFiresCheckpointsMidRun(state.config.goal_review) && (state._models?.goal ?? null) !== null) {
    const checkpoints = goalCheckpointsToFire(state, last);
    if (checkpoints.length > 0) {
      const serialized = await joinPendingVisualReview(state, ledger, processTicket);
      if (serialized === "fail") {
        return "failed";
      }
    }
  }

  // gh #107 (C.2): structural before goal here too (same fail-fast rationale as
  // committedTicket). Structural does not drive the shared browser, so it may
  // sit between the #106-B join above and the goal pass below without affecting
  // that collision guard.
  const structuralOutcome = await structuralReviewAtCheckpoint(state, ledger, last, processTicket);
  if (structuralOutcome === "fail") return "failed";
  const goalOutcome = await goalReviewAtCheckpoint(state, ledger, last, parsedLast, processTicket);
  if (goalOutcome === "fail") return "failed";
  return "ok";
}

/** The group-granularity run driver (issue #95 stage 2): loop over group units
 * (a labeled group = one unit; an unlabeled ticket degenerates to a per-ticket
 * processTicket pass) until the plan is exhausted or a unit fails. */
async function runBuilderGroupLoop(state: RunState, ledger: string, onUpdate?: () => void): Promise<void> {
  while (!isFinished(state.status)) {
    // gh: the soft stop's unit boundary (mirrors the frontier loop).
    if (isSoftStopRequested()) {
      await softStopHere(state, ledger, "stop requested before the next unit began", onUpdate);
      break;
    }
    const remaining = state.tickets.filter((t) => t.status === "ready");
    const unit = nextBuilderUnit(remaining, "group");
    if (!unit) {
      state.status = nextRunStatus(state);
      await writeState(ledger, state);
      onUpdate?.();
      break;
    }
    // gh #111: the boundary backstop for the group loop too.
    if (haltReason(state.cwd) !== null) {
      await applyHalt(state, ledger);
      onUpdate?.();
      break;
    }
    const outcome = unit.checkpointAtEnd
      ? await processBuilderGroupUnit(state, ledger, unit)
      : await processTicket(state, ledger, unit.tickets[0]);
    if (outcome === "halted") {
      await applyHalt(state, ledger);
      onUpdate?.();
      break;
    }
    if (outcome === "failed") {
      if (!isFinished(state.status)) {
        state.status = state.pause_on_failure ? "stopped" : "failed";
      }
      await writeState(ledger, state);
      onUpdate?.();
      break;
    }
    await writeState(ledger, state);
    onUpdate?.();
    if (isSoftStopRequested()) {
      const last = unit.tickets[unit.tickets.length - 1];
      await softStopHere(state, ledger, `stop requested — ${last.number} committed; stopping before the next unit`, onUpdate);
      break;
    }
  }
}
