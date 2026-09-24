import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeExecFailure, executeOpendCode, withPersistentWorker, startPersistentWorker, stopPersistentWorker } from "../execute/executor.ts";
import { loadContracts, summarizeContracts, knownContractSymbols } from "../core/contracts.ts";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_INFRA_BACKOFF_SEC } from "../config/config.ts";
import { withFailureLadderOnThrow } from "../execute/failure-ladder.ts";
import { planDesignSystemPrompt, planTicketsSystemPrompt, planFixSystemPrompt, buildGoalCoveragePrompt, buildPlanRevisionPrompt, buildPlanUserFeedbackPrompt, buildPlanMarkdown, parseCoverageVerdict, parsePlanBlock, parsePlanJson, parseVerifyBlock, parseSmokeBlock, parseDesignBlock, parseArchitectureBlock, parseInterfaceBlock, splitCoherenceContract, scanPlanConflicts, tableFindings, outstandingFindings, parseRulings, buildPlanRepairPrompt, impliedBlockedByEdits, sameFileOrderingEdits, withImpliedBlockedBy, collapseRepeatedTickets, extractFilePaths, detectIntegrationPromise, findDroppedTickets, MAX_PLAN_REPAIR_ROUNDS, MAX_PLAN_COVERAGE_ROUNDS, type PlanMode, type Ruling, type ConflictFinding } from "./plan.ts";
import { touchesVisualSurface } from "../context/surface.ts";
import { isRenderedSurface, type ProjectInterface } from "../config/interface.ts";
import { writeTickets, type Ticket } from "../core/ticket.ts";
import { writePlanOrigin, writePlanRulings } from "./plan-identity.ts";
import { extractAssistantText, extractPlanText, initLedger, resetPhase, readStderrLines, appendEvent } from "../core/ledger.ts";
import { readProjectDoc, writeProjectDoc } from "../core/git.ts";
import { summarizePermissionRejections } from "../core/permissions.ts";
import {
  appendContextTerms,
  buildSharpenRoundPrompt,
  sharpenSystemPrompt,
  parseSharpenRound,
  renderQuestionForTerminal,
  renderTranscriptForPlanner,
  writeGrillAdr,
  type SharpenExchange,
  type SharpenQuestion,
  type SharpenMode,
} from "./sharpen.ts";

/** Issue #80: the rung-2 restart closure for the planner's failure-ladder
 * phases. Restarts the persistent worker when it is on; no-op otherwise. */
function plannerRestart(cwd: string, persistentWorker: boolean): () => Promise<void> {
  return persistentWorker === true
    ? async () => { await stopPersistentWorker(); await startPersistentWorker({ cwd }); }
    : async () => {};
}

export interface PlanResult {
  outDir: string;
  tickets: Ticket[];
  /** Verify commands parsed from the plan's $VERIFY block (empty if none emitted). */
  verify: string[];
  /** Smoke (binary-launch) commands parsed from the plan's $SMOKE block
   * (empty when the project has no runnable binary or the planner emitted NONE). */
  smoke: string[];
  /** Issue #34: the planner's design intent (redefined goal, visual identity,
   * quality bar). `null` when the planner did not emit a $DESIGN block — the
   * documents are optional and a run without them is still valid. */
  designDoc: string | null;
  /** Issue #34: the planner's architecture intent (module map, rationale).
   * `null` when absent. */
  architectureDoc: string | null;
  /** ADR 0041: the complete, authoritative plan ($PLAN) — the full-detail
   * document the distilled $DESIGN/$ARCHITECTURE summarize. `null` for fix
   * plans and legacy plans that predate the block. */
  planDoc: string | null;
  /** The written PLAN.md path (build plans only), or null. */
  planPath: string | null;
}

/** ADR 0041 (amended): the interactive plan-review callback. Present only in
 * non-auto CLI runs; the railhead calls it with the written PLAN.md AFTER the
 * plan (and any interview refinement) is final and BEFORE tickets are
 * decomposed, looping on the returned feedback (null/empty = accepted) until
 * the user is content. Acceptance flows straight into decomposition and the
 * build. */
export type PlanReview = (plan: {
  planPath: string | null;
  planDoc: string | null;
}) => Promise<string | null>;

/**
 * The Plan step: seed the planner with the contracts summary, run a fresh
 * opencode subprocess against the lean planner prompt, then parse, order, and
 * write the Tickets. Folded here so the step is reachable by tests instead of
 * being inlined in the CLI.
 */
export async function runPlan(options: {
  cwd: string;
  prompt: string;
  model: string | null;
  contextBudget?: number;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  /** Issue #39: when true, keep a persistent `opencode serve` worker alive
   * for the plan + sharpen phases. The worker's KV cache reuses the
   * system-prompt prefix across phases. Defaults to false (ADR 0001 baseline). */
  persistentWorker?: boolean;
  /** Planner mode: `build` (default) plans a feature; `fix` plans a bug fix.
   * In fix mode the planner is forbidden from pre-judging the bug as "already
   * fixed" — it must emit a real fix ticket carrying the reproduction steps,
   * and the implementer (who can run the code) decides whether it reproduces. */
  mode?: PlanMode;
  /** Echo the exact prompt sent to each model call to the console. */
  verbose?: boolean;
  /** Infra-retry backoff for transient provider errors (0-token steps).
   * Defaults to `DEFAULT_INFRA_BACKOFF_SEC` per the railhead config. */
  infraBackoffSec?: number[];
  /** ADR 0041: interactive plan review. When present (non-auto CLI runs), the
   * goal-coverage audit is SKIPPED — the human verifies the plan — and the
   * railhead loops revisions on the callback's feedback until it returns empty. */
  reviewPlan?: PlanReview;
  /** ADR 0042: the post-plan planning interview. Called with the design-stage
   * text after the plan is generated; a non-empty return is a set of user
   * answers that revises the plan before tickets are decomposed. The CLI owns
   * the session and the prompting; the planner owns the revision. */
  interviewPlan?: (planText: string) => Promise<string | null>;
  /** Whether the planner must plan the look as a checkable target (the
   * art-direction request blocks) and the gate must require the ticket pair.
   * Default true; the CLI passes `config.art_direction`. */
  artDirection?: boolean;
}): Promise<PlanResult> {
  const { cwd, prompt, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, mode, verbose, maxContextTokens, persistentWorker, infraBackoffSec, reviewPlan, interviewPlan, artDirection } = options;
  return withPersistentWorker(persistentWorker === true, cwd, async () => {
  return runPlanInner({ cwd, prompt, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, mode, verbose, maxContextTokens, infraBackoffSec, persistentWorker, reviewPlan, interviewPlan, artDirection });
  });
}

async function runPlanInner(options: {
  cwd: string;
  prompt: string;
  model: string | null;
  contextBudget?: number;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  mode?: PlanMode;
  verbose?: boolean;
  infraBackoffSec?: number[];
  persistentWorker?: boolean;
  reviewPlan?: PlanReview;
  interviewPlan?: (planText: string) => Promise<string | null>;
  artDirection?: boolean;
}): Promise<PlanResult> {
  const { cwd, prompt, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, mode, verbose, maxContextTokens, infraBackoffSec, persistentWorker, reviewPlan, interviewPlan, artDirection } = options;
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30) || "project";
  const outDir = join(cwd, ".scratch", slug, "issues");

  const contracts = await loadContracts(cwd);
  const existingGlossary = await readProjectDoc(cwd, "CONTEXT.md");
  const contractsSummary = summarizeContracts(contracts);
  const planLedger = join(cwd, ".railhead", "plan-latest");
  await initLedger(planLedger);
  const backoff = infraBackoffSec ?? DEFAULT_INFRA_BACKOFF_SEC;

  /** One staged planner call: reset the phase file, run the model with the
   * failure ladder (transient provider errors retry), and return the
   * transcript. A non-ok completion is fatal — each stage's output feeds the
   * next, so a partial transcript is never usable. */
  const stage = async (phaseFile: string, prompt: string, livePrefix: string): Promise<string> => {
    // Each phase file is owned by this invocation; without truncating, a
    // prior plan run's events accumulate and leak into this one.
    await resetPhase(planLedger, phaseFile);
    const infra = await withFailureLadderOnThrow(
      async () => {
        const r = await executeOpendCode(prompt, {
          cwd,
          ledgerDir: planLedger,
          phaseFile,
          model,
          heartbeat: true,
          live: verbose === true,
          verbose,
          livePrefix,
          maxSteps,
          stallTimeoutSec,
          maxStepModelSec,
          maxContextTokens,
        });
        if (r.status === "transient") {
          throw new Error(describeExecFailure(r));
        }
        return r;
      },
      {
        backoff,
        budget: maxContextTokens ?? DEFAULT_CONTEXT_TOKENS,
        restartWorker: plannerRestart(cwd, persistentWorker === true),
        onRung: (rung) => {
          console.log(`[${livePrefix}] ${rung.diagnosis}`);
        },
      },
    );
    if (!infra.ok) {
      throw new Error(`planner hit a provider failure (${infra.rung.diagnosis}); re-run \`railhead build\` after the rate limit clears`);
    }
    if (infra.value.status !== "ok") {
      throw new Error(`planner did not complete (${describeExecFailure(infra.value)})`);
    }
    return extractPlanText(planLedger, phaseFile);
  };

  // Planning is staged (ADR 0039): a fix is one call, a build is design →
  // adversarial goal-coverage audit (+ bounded revisions) → decomposition.
  // Splitting the two build outputs is what lets the audit judge the plan
  // against the raw goal before tickets exist, and what keeps ticket-format
  // failures (references/dependencies) out of the design call.
  let designText: string;
  let ticketsText: string;
  if ((mode ?? "build") === "fix") {
    const text = await stage("plan", `${planFixSystemPrompt(contractsSummary, contextBudget, existingGlossary ?? undefined)}\n\nWhat to build: ${prompt}`, "plan");
    designText = text;
    ticketsText = text;
  } else {
    const designSystem = planDesignSystemPrompt({ contractsSummary, existingGlossary: existingGlossary ?? undefined, artDirection });
    designText = await stage("plan", `${designSystem}\n\nWhat to build: ${prompt}`, "plan");
    // ADR 0042: the planning interview now runs AFTER the plan exists, sourced
    // from the prompt + plan, and its answers revise the plan before the audit
    // and the ticket decomposition. The CLI owns the session; an empty return
    // means the interview was skipped or asked nothing.
    if (interviewPlan) {
      const answers = await interviewPlan(designText);
      if (answers?.trim()) {
        console.log("[plan] planning interview — revising the plan with the user's answers");
        designText = await stage(
          "plan-revise-interview-1",
          buildPlanRevisionPrompt({ goal: prompt, priorPlanText: designText, findings: [answers.trim()], source: "planning-interview" }),
          "interview",
        );
      }
    }
    // ADR 0041 (amended): in interactive mode the human reviews the FINAL plan
    // (post-interview) BEFORE tickets exist. PLAN.md is written plan-only at
    // this point; feedback re-emits the plan through the ordinary revision
    // path; acceptance falls through to decomposition. The human replaces the
    // adversarial coverage audit, which only runs on unattended plans.
    if (reviewPlan) {
      let reviewRound = 0;
      for (;;) {
        const planPath = await writePlanOnly({ cwd, prompt, designText });
        const feedback = await reviewPlan({ planPath, planDoc: parsePlanBlock(designText) });
        if (!feedback || !feedback.trim()) break;
        reviewRound++;
        console.log(`[plan] user feedback — revising the plan (round ${reviewRound})`);
        designText = await stage(
          `plan-revise-user-${reviewRound}`,
          buildPlanUserFeedbackPrompt({ goal: prompt, priorPlanText: designText, feedback: feedback.trim() }),
          "revise",
        );
      }
      console.log("[plan] plan accepted — decomposing into tickets");
    } else {
      designText = await ensureGoalCoverage({ goal: prompt, planText: designText, stage });
    }
    const ticketsSystem = planTicketsSystemPrompt({ contractsSummary, existingGlossary: existingGlossary ?? undefined, artDirection });
    ticketsText = await stage(
      "plan-tickets",
      `${ticketsSystem}\n\nThe validated plan to decompose:\n\n${designText}\n\nOriginal goal: ${prompt}`,
      "tickets",
    );
  }

  return finalizePlan({
    cwd,
    prompt,
    designText,
    ticketsText,
    contractsSummary,
    contracts,
    outDir,
    slug,
    model,
    maxSteps,
    stallTimeoutSec,
    maxStepModelSec,
    maxContextTokens,
    verbose,
    planLedger,
    mode: (mode ?? "build") as PlanMode,
    artDirection,
  });
}

/** Write the plan-only PLAN.md the interactive reviewer reads before any
 * ticket exists. The finalize pass rewrites it with the ticket breakdown once
 * the plan is accepted and decomposed. Returns the written path (build plans
 * only; fix mode has no plan to review). */
async function writePlanOnly(opts: { cwd: string; prompt: string; designText: string }): Promise<string | null> {
  const { cwd, prompt, designText } = opts;
  const designDoc = parseDesignBlock(designText);
  const architectureDoc = parseArchitectureBlock(designText);
  const markdown = buildPlanMarkdown({
    prompt,
    planDoc: parsePlanBlock(designText),
    designDoc: designDoc ? splitCoherenceContract(designDoc).narrative : null,
    architectureDoc,
  });
  await writeProjectDoc(cwd, "PLAN.md", markdown);
  return join(cwd, "PLAN.md");
}

/** The tail of planning, extracted so the interactive review loop can re-run
 * it after a user revision: parse the current plan/ticket transcripts, write
 * the docs (design/architecture/coherence/PLAN.md), gate the tickets, and
 * seed railhead.json. Idempotent — each call overwrites the artifacts of the
 * previous iteration. */
async function finalizePlan(opts: {
  cwd: string;
  prompt: string;
  designText: string;
  ticketsText: string;
  contractsSummary: string;
  contracts: Awaited<ReturnType<typeof loadContracts>>;
  outDir: string;
  slug: string;
  model: string | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
  planLedger: string;
  mode: PlanMode;
  artDirection?: boolean;
}): Promise<PlanResult> {
  const { cwd, prompt, designText, ticketsText, contracts, outDir, slug, model, maxSteps, stallTimeoutSec, maxStepModelSec, maxContextTokens, verbose, planLedger, mode, artDirection } = opts;
    const verify = parseVerifyBlock(designText);
    const smoke = parseSmokeBlock(designText);
    const projectInterface = parseInterfaceBlock(designText);
    // Option (c): a plan that declares a rendered surface must carry the two
    // screenshot-driven art-direction tickets unless the project disabled it.
    // Undeclared (fix mode) or terminal/none never requires them.
    const artDirectionRequired = artDirection !== false && isRenderedSurface(projectInterface);
    // Issue #34: extract the planner's design and architecture intent from
    // $DESIGN / $ARCHITECTURE marker blocks. In build mode the coverage audit
    // already required them; in fix mode they stay optional. When present, the
    // documents are written under docs/ so implementers, reviewers, and the
    // goal reviewer can read the planner's intent instead of reconstructing it
    // from committed code.
    const designDoc = parseDesignBlock(designText);
    const architectureDoc = parseArchitectureBlock(designText);
    const planDoc = parsePlanBlock(designText);
    // Issue #99 (ADR 0028): the `## Coherence contract` subsection (authored
    // inside $DESIGN for surfaced plans) is persisted ONCE, as docs/coherence.md
    // — the file goal reviews amend via CHARTER: revisions. Design.md keeps only
    // the narrative: a second charter copy there would ride into surface prompts
    // twice and drift stale against its amended twin. A plan without the section
    // — or without a $DESIGN at all — writes no charter artifact; the plan-time
    // guard below warns (never fails) when surface tickets exist but no charter
    // was authored.
    const { narrative: designNarrative, charter: coherenceContract } = designDoc
      ? splitCoherenceContract(designDoc)
      : { narrative: null, charter: null };
    if (designNarrative) {
      await writeProjectDoc(cwd, "docs/design.md", designNarrative + "\n");
    }
    if (architectureDoc) {
      await writeProjectDoc(cwd, "docs/architecture.md", architectureDoc + "\n");
    }
    let coherenceAuthored = false;
    if (coherenceContract) {
      await writeProjectDoc(cwd, "docs/coherence.md", coherenceContract + "\n");
      coherenceAuthored = true;
    }
    let tickets: ReturnType<typeof parsePlanJson>;
    const ticketsPhase = (mode ?? "build") === "fix" ? "plan" : "plan-tickets";
    try {
      tickets = parsePlanJson(ticketsText);
    } catch (err) {
      const stderrLines = await readStderrLines(planLedger, ticketsPhase);
      const rejections = summarizePermissionRejections(stderrLines);
      const suffix = rejections.count > 0
        ? ` — ${rejections.summary} (the model may have emitted its plan as a write to a path opencode auto-rejected; check \`.railhead/plan-latest/events/${ticketsPhase}.jsonl\`)`
        : "";
      throw new Error(`${(err as Error).message}${suffix}`);
    }

    // Issue #86: the bounded plan gate. Findings (class A and B) escalate
    // through up to MAX_PLAN_REPAIR_ROUNDS model repair rounds with a per-
    // finding $RULINGS adjudication escape; anything still un-cleared after the
    // cap rejects the plan — a plan the scan already indicted must never run.
    // Issue #103: the contracts index is the existing-symbol universe the gate
    // resolves references against, so a reference to a committed contract is not
    // misread as dangling.
    const gate = await runPlanGate({
      planTickets: tickets,
      model,
      maxSteps,
      stallTimeoutSec,
      maxStepModelSec,
      maxContextTokens,
      verbose,
      planLedger,
      cwd,
      existingSymbols: knownContractSymbols(contracts),
      // Plan-completeness inputs: every file the spec/architecture promises must
      // be owned by some ticket (or already exist), and an architecture that
      // promises a late/terminal integration must wire the shell early instead.
      requiredFiles: [
        ...extractFilePaths(prompt),
        ...extractFilePaths(architectureDoc ?? ""),
      ],
      alreadyExistingFiles: new Set(
        [...extractFilePaths(prompt), ...extractFilePaths(architectureDoc ?? "")].filter((f) => existsSync(join(cwd, f))),
      ),
      promisesIntegration: detectIntegrationPromise(`${architectureDoc ?? ""}\n${prompt}`),
      artDirectionRequired,
    });
    const ordered = gate.ordered;
    const planDir = join(outDir, "..");
    await writeTickets(outDir, ordered);
    await writePlanOrigin(planDir, {
      slug,
      prompt,
      created_at: new Date().toISOString(),
      ticket_files: ordered.map((t) => t.file),
    });
    if (gate.rulings.length > 0) {
      await writePlanRulings(planDir, gate.rulings);
    }
    // The complete, human-facing plan overview. Written for build plans only
    // (fix mode is one ticket — there is nothing to iterate on); the distilled
    // docs/design.md and docs/architecture.md remain the gate/reviewer inputs.
    let planPath: string | null = null;
    if (mode === "build") {
      const markdown = buildPlanMarkdown({
        prompt,
        planDoc,
        designDoc: designNarrative,
        architectureDoc,
        tickets: ordered,
      });
      await writeProjectDoc(cwd, "PLAN.md", markdown);
      planPath = join(cwd, "PLAN.md");
    }

    // Issue #99 (ADR 0028): plan-time guard. A surfaced plan that authored no
    // charter section WARNS (never fails) — the recall-biased gate's observable,
    // and the input for the report.md escalation. If this fires repeatedly in
    // practice, revisit a post-plan distill pass (Decision 1), not now.
    const surfaceTickets = ordered.filter((t) => touchesVisualSurface(t));
    if (surfaceTickets.length > 0 && !coherenceAuthored) {
      console.warn(
        `[plan] warning: ${surfaceTickets.length} ticket(s) appear to touch a visual surface (${surfaceTickets.map((t) => t.number).join(", ")}) but the plan's $DESIGN block has no \`## Coherence contract\` section — surface tickets will build without a coherence charter (ADR 0028). Add the section to $DESIGN or accept the drift.`,
      );
    }

    // Seed the verify commands into railhead.json when the user left it empty, so
    // the very first ticket is gated by a real build/test command rather than
    // running with no gate (the default DEFAULT_CONFIG.verify is []). Never
    // clobber a user-configured verify list — even a single explicit command
    // means the user chose their own gate.
    if (verify.length > 0) {
      await seedVerifyIfEmpty(cwd, verify);
    }
    // Same shape, same rule for smoke: seed a planner-emitted launch command
    // only when the user hasn't already configured one. A user who sets smoke:[]
    // (or NONE) is signalling "no smoke for this project" — don't override that.
    if (smoke.length > 0) {
      await seedSmokeIfEmpty(cwd, smoke);
    }
    // Issue #97: seed the planner-declared interaction interface into railhead.json
    // seed-if-empty exactly like verify/smoke. A human's declared `interface`
    // field always wins (it survives replans); a `none` declaration is deliberate
    // and is seeded like any other token.
    if (projectInterface) {
      const seeded = await seedInterfaceIfEmpty(cwd, projectInterface);
      console.log(seeded
        ? `seeded interaction interface into railhead.json: ${projectInterface} (issue #97)`
        : `declared interaction interface: ${projectInterface} (issue #97)`);
      if (await seedInteractionSmokeIfUnset(cwd, projectInterface)) {
        console.log(`enabled per-ticket interaction smoke for the ${projectInterface} interface`);
      }
    }
    // Issue #106 (H): the smoke list embedded in railhead.json must stay launch
    // commands ONLY. A pre-#106 planner parse carried the $DESIGN/$ARCHITECTURE
    // region into cfg.smoke (its parser stopped only at $TICKETS), and the
    // "refresh" below existed solely to keep that write-only mirror from
    // drifting — nothing ever read it back (docs/*.md are the design authority).
    // parseSmokeBlock now stops at the design/architecture siblings, so seeding
    // writes commands only and there is no mirror left to refresh.
    return { outDir, tickets: ordered, verify, smoke, designDoc: designNarrative, architectureDoc, planDoc, planPath };
}



/** STAGE 2 driver: audit the plan against the raw goal and, when demands are
 * unmet, hand the audit's findings back to the design stage for a bounded
 * number of revisions. The audit is a separate call on purpose — the model
 * that wrote the plan does not get to certify its own coverage. An
 * inconclusive audit (no verdict marker) counts as a failed round with a
 * formatting finding, never as an assumed pass. */
async function ensureGoalCoverage(opts: {
  goal: string;
  planText: string;
  stage: (phaseFile: string, prompt: string, livePrefix: string) => Promise<string>;
}): Promise<string> {
  const { goal, stage } = opts;
  let planText = opts.planText;
  for (let round = 1; round <= MAX_PLAN_COVERAGE_ROUNDS; round++) {
    const auditText = await stage(
      `plan-check-${round}`,
      buildGoalCoveragePrompt({ goal, planText, round, maxRounds: MAX_PLAN_COVERAGE_ROUNDS }),
      "coverage",
    );
    const verdict = parseCoverageVerdict(auditText);
    if (verdict.verdict === "pass") {
      console.log(`[plan] coverage audit ✓ every goal demand is concretely delivered (round ${round})`);
      return planText;
    }
    const findings = verdict.findings.length > 0
      ? verdict.findings
      : ["(the auditor emitted no readable verdict — it must emit $COVERAGE_PASS or $COVERAGE_FAIL with [MISSING]/[THIN] findings)"];
    if (round >= MAX_PLAN_COVERAGE_ROUNDS) {
      throw new Error(
        `plan rejected — the goal coverage audit still reports unmet demands after ${MAX_PLAN_COVERAGE_ROUNDS} round(s):\n${findings.map((f) => `  - ${f}`).join("\n")}`,
      );
    }
    console.warn(`[plan] coverage audit ✗ ${findings.length} unmet goal demand(s) — revising the plan (round ${round}/${MAX_PLAN_COVERAGE_ROUNDS})`);
    for (const f of findings) console.warn(`[plan]   ${f}`);
    planText = await stage(
      `plan-revise-${round}`,
      buildPlanRevisionPrompt({ goal, priorPlanText: planText, findings }),
      "revise",
    );
  }
  return planText;
}

/** Issue #86: the bounded plan gate. Scans the parsed ticket plan; while any
 * gate finding remains (class A or B) it runs up to MAX_PLAN_REPAIR_ROUNDS
 * planner-model repair rounds — each persisted as its own `plan-repair-N`
 * ledger phase — handing the model the finding table and asking it to fix the
 * plan or rule a finding intentional via $RULINGS. Adjudicated rulings are
 * keyed (matching by finding key, not text) and carried across rounds. The
 * plan is accepted only when every finding is fixed or ruled; anything still
 * un-cleared after the round cap rejects it, naming the survivors. Class A
 * (structural) findings therefore always gate; class B (quality) findings
 * never hard-fail before the cap is spent. */
async function runPlanGate(opts: {
  planTickets: ReturnType<typeof parsePlanJson>;
  model: string | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
  planLedger: string;
  cwd: string;
  /** Issue #103: contracts-index symbols the plan may reference without
   * introducing (committed/existing code) — keeps them from scanning as
   * dangling references. */
  existingSymbols?: ReadonlySet<string>;
  /** Plan-completeness: files the spec/architecture promise the plan will produce. */
  requiredFiles?: string[];
  alreadyExistingFiles?: ReadonlySet<string>;
  promisesIntegration?: boolean;
  artDirectionRequired?: boolean;
}): Promise<{ ordered: Ticket[]; rulings: Ruling[]; rounds: number }> {
  const { model, planLedger } = opts;
  let current = opts.planTickets;
  const rulings: Ruling[] = [];
  let rounds = 0;
  const universe = {
    existingSymbols: opts.existingSymbols,
    requiredFiles: opts.requiredFiles,
    alreadyExistingFiles: opts.alreadyExistingFiles,
    promisesIntegration: opts.promisesIntegration,
    artDirectionRequired: opts.artDirectionRequired,
  };
  // Repair-loss guard findings (a ticket the last repair round dropped) are
  // computed against the before/after pair of ONE round and stashed here; each
  // iteration re-attaches them to the fresh scan so the finding reaches the
  // repair table exactly once per drop, mirroring the pre-restructure flow.
  let guardFindings: ConflictFinding[] = [];

  for (;;) {
    // ADR 0035: collapse tickets the planner emitted more than once (identical
    // title, files, and introduces — the small-model continuation double-emit)
    // BEFORE scanning. Every duplicate finding the repeats would have produced
    // vanishes with them, at zero model cost. Distinct-content same-title
    // tickets are not repeats and still escalate as duplicate-slug findings.
    const collapsed = collapseRepeatedTickets(current);
    if (collapsed.dropped.length > 0) {
      current = collapsed.tickets;
      console.warn(
        `[gate] dropped ${collapsed.dropped.length} repeated ticket emission(s) (${collapsed.dropped.map((d) => `"${d.title}"`).join(", ")}) — identical title, files, and introduces as an earlier ticket; kept the first emission (ADR 0035)`,
      );
    }
    const { ordered, report } = await scanPlanConflicts(current, universe);
    report.classA.push(...guardFindings);
    guardFindings = [];
    if (report.errors.length > 0) {
      throw new Error(`plan conflict scan failed:\n${report.errors.map((e) => `  - ${e}`).join("\n")}`);
    }
    const outstanding = outstandingFindings(report, rulings);
    if (outstanding.length === 0) {
      // The unorderable-plan finding is never rulable, so reaching zero
      // outstanding without an ordered set is a gate bug, not a plan state.
      if (ordered === undefined) throw new Error("plan gate cleared every finding but holds no ordered ticket set — unreachable for unorderable plans");
      if (rounds > 0) {
        console.log(`[plan] gate: plan accepted after ${rounds} repair round(s)`);
      }
      if (rulings.length > 0) {
        console.log(`[plan] gate: ${rulings.length} finding(s) adjudicated intentional and recorded`);
      }
      return { ordered, rulings, rounds };
    }
    if (rounds >= MAX_PLAN_REPAIR_ROUNDS) {
      const survivors = outstanding.map((f) => `  [${f.id}] (${f.cls === "classA" ? "A" : "B"}/${f.kind}) ${f.message}`).join("\n");
      throw new Error(
        `plan rejected — ${MAX_PLAN_REPAIR_ROUNDS} repair round(s) did not clear every gate finding; fix the plan or add a $RULINGS adjudication for:\n${survivors}`,
      );
    }
    // Issue #103: auto-insert the derivable implied edges (references→introduces)
    // among the remaining unsatisfied-reference findings WITHOUT consuming a
    // repair round — regardless of whether OTHER class-A findings (uncovered-file,
    // dangling-reference, duplicate-introduces, …) still need the model's
    // judgement. The edges are deterministic and the planner prompt already
    // sanctions omitting them, so they never belong in a paid repair round; only
    // the non-derivable remainder escalates below.
    const unsatisfied = outstanding.filter((f) => f.cls === "classA" && f.kind === "unsatisfied-reference");
    if (ordered !== undefined && unsatisfied.length > 0) {
      const edits = impliedBlockedByEdits(ordered, unsatisfied);
      if (edits.length > 0) {
        const withEdits = withImpliedBlockedBy(current, edits);
        const res = await scanPlanConflicts(withEdits, universe);
        // The implied edges form a cycle (e.g. two tickets each reference the
        // other's introduces) — deterministic resolution is impossible, so
        // escalate the unchanged plan to the model instead of crashing.
        if (res.ordered) {
          current = withEdits;
          console.warn(`[gate] auto-inserted ${edits.length} implied blocked_by edge(s) from references→introduces (issue #103) — re-scanning without a repair round`);
          continue;
        }
        console.warn(`[gate] implied references→introduces edges would not order (mutually-referencing tickets?) — escalating to a repair round`);
      }
      // No edit derivable (a contradictory manual edge, or the implied set
      // cycles): fall through to the repair round — that needs the model.
    }
    // ADR 0035: same for unordered same-file editors — chain them in emission
    // order (each later editor blocked_by the earlier one), the remedy the
    // planner prompt itself prescribes. An edge that would cycle against
    // existing manual edges is skipped and escalates with the repair round.
    const sameFile = outstanding.filter((f) => f.cls === "classA" && f.kind === "unordered-same-file");
    if (ordered !== undefined && sameFile.length > 0) {
      const edits = sameFileOrderingEdits(ordered, sameFile);
      if (edits.length > 0) {
        const withEdits = withImpliedBlockedBy(current, edits);
        const res = await scanPlanConflicts(withEdits, universe);
        if (res.ordered) {
          current = withEdits;
          console.warn(`[gate] auto-inserted ${edits.length} ordering edge(s) chaining same-file editors in emission order (ADR 0035) — re-scanning without a repair round`);
          continue;
        }
        console.warn(`[gate] same-file ordering edges would not order — escalating to a repair round`);
      }
    }
    rounds++;
    const aCount = outstanding.filter((f) => f.cls === "classA").length;
    console.warn(`[repair] round ${rounds}/${MAX_PLAN_REPAIR_ROUNDS}: ${outstanding.length} gate finding(s) (${aCount} class A, ${outstanding.length - aCount} class B) — asking the planner to fix or rule them`);
    await appendEvent(
      planLedger,
      "plan-repair",
      JSON.stringify({
        round: rounds,
        findings: outstanding.map((f) => ({ id: f.id, cls: f.cls, kind: f.kind, key: f.key, message: f.message })),
      }),
    );

    const table = tableFindings(report, ordered);
    const phaseFile = `plan-repair-${rounds}`;
    await resetPhase(planLedger, phaseFile);
    const repaired = await runRepairRound({
      cwd: opts.cwd,
      planLedger,
      phaseFile,
      model,
      maxSteps: opts.maxSteps,
      stallTimeoutSec: opts.stallTimeoutSec,
      maxStepModelSec: opts.maxStepModelSec,
      maxContextTokens: opts.maxContextTokens,
      verbose: opts.verbose,
      ticketsJson: JSON.stringify(current, null, 2),
      table,
      rulings,
      round: rounds,
    });
    if (repaired !== null) {
      // Resolve $RULINGS adjudications against the table this round showed,
      // and persist them (keyed) before re-scanning.
      const idToFinding = new Map(table.map((f) => [f.id, f]));
      for (const r of parseRulings(repaired)) {
        const tf = idToFinding.get(r.id);
        if (!tf) continue;
        // A cycle or out-of-range index is never intentional — a ruling cannot
        // clear an unorderable plan (only a repair can), so drop the attempt.
        if (tf.kind === "unorderable-plan") continue;
        rulings.push({ key: tf.key, finding: tf.message, reason: r.reason, source: "plan", tickets: tf.tickets });
        await appendEvent(planLedger, "rulings", JSON.stringify({ key: tf.key, finding: tf.message, reason: r.reason, source: "plan" }));
        console.warn(`[repair] ruled [${tf.id}] ${tf.kind}: ${r.reason}`);
      }
      try {
        const before = current;
        const next = parsePlanJson(repaired);
        current = next;
        // Repair-round loss guard: a title-slug that vanished between the
        // pre-round and post-round plans is a dropped ticket — surface it as a
        // class-A finding so the gate forces a restore-or-rule, never a silent
        // shrink (the spriteforge failure mode where a repair deleted scope).
        // The loop's fresh scan cannot see a between-rounds delta, so the
        // findings ride into the next iteration's report via `guardFindings`.
        guardFindings = findDroppedTickets(before, next);
        continue;
      } catch (err) {
        // A rulings-only reply (no $TICKETS array) is a legitimate cheap path:
        // the model adjudicated every remaining finding without changing a
        // ticket. The rulings above are already recorded; the loop re-runs and
        // re-computes outstanding against them, so no warning is warranted. Any
        // other parse failure is still surfaced — a malformed array must not be
        // swallowed silently.
        const rulingsOnly = /no readable tickets/i.test((err as Error).message);
        if (!rulingsOnly) {
          console.warn(`[repair] round ${rounds}: repair output did not parse as tickets (${(err as Error).message}) — keeping the prior plan`);
        }
      }
    } else {
      console.warn(`[repair] round ${rounds}: repair phase did not complete; a later round may retry`);
    }
    // No usable repair this round: re-scan the unchanged plan on the next pass
    // (or reject once the cap is spent).
  }
}

/** One plan-repair model call. Returns the model's transcript text, or null
 * when the phase did not complete with a usable result. Persisted as its own
 * ledger phase so each round's diff is visible in the plan ledger. */
async function runRepairRound(opts: {
  cwd: string;
  planLedger: string;
  phaseFile: string;
  model: string | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
  /** The current ticket plan (JSON) the model edits. */
  ticketsJson: string;
  table: import("./plan.ts").TabledFinding[];
  rulings: Ruling[];
  round: number;
}): Promise<string | null> {
  const { cwd, planLedger, phaseFile, model, maxSteps, stallTimeoutSec, maxStepModelSec, maxContextTokens, verbose, ticketsJson, table, rulings, round } = opts;
  const prompt = buildPlanRepairPrompt({
    ticketsJson,
    table,
    existingRulings: rulings,
    maxRounds: MAX_PLAN_REPAIR_ROUNDS,
    round,
  });
  const result = await executeOpendCode(prompt, {
    cwd,
    ledgerDir: planLedger,
    phaseFile,
    model,
    heartbeat: true,
    live: verbose === true,
    verbose,
    livePrefix: "repair",
    maxSteps,
    stallTimeoutSec,
    maxStepModelSec,
    maxContextTokens,
  });
  if (result.status !== "ok") return null;
  return extractPlanText(planLedger, phaseFile);
}

/** Write `smoke` into railhead.json only when its current smoke list is empty.
 * Mirrors `seedVerifyIfEmpty` exactly. Returns true when it wrote. */
async function seedSmokeIfEmpty(cwd: string, smoke: string[]): Promise<boolean> {
  const target = join(cwd, "railhead.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(target, "utf8"));
  } catch {
    // railhead.json should exist by plan time (cmdInit), but be defensive.
  }
  const current = Array.isArray(cfg.smoke) ? cfg.smoke : [];
  if (current.length > 0) return false;
  cfg.smoke = smoke;
  await writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return true;
}

/** Write `verify` into railhead.json only when its current verify list is empty.
 * Returns true when it wrote, false when it left the config untouched. */
async function seedVerifyIfEmpty(cwd: string, verify: string[]): Promise<boolean> {
  const target = join(cwd, "railhead.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(target, "utf8"));
  } catch {
    // railhead.json should exist by plan time (cmdInit), but be defensive.
  }
  const current = Array.isArray(cfg.verify) ? cfg.verify : [];
  if (current.length > 0) return false;
  cfg.verify = verify;
  await writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return true;
}

/** Write the planner-declared interaction interface (issue #97) into
 * railhead.json's top-level `interface` field only when the project has not
 * already declared one. Mirrors `seedVerifyIfEmpty` exactly: a human's
 * railhead.json override survives replans; absent/empty means undeclared. */
async function seedInterfaceIfEmpty(cwd: string, iface: string): Promise<boolean> {
  const target = join(cwd, "railhead.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(target, "utf8"));
  } catch {
    // railhead.json should exist by plan time (cmdInit), but be defensive.
  }
  const current = cfg["interface"];
  if (typeof current === "string" && current.trim() !== "") return false;
  cfg["interface"] = iface;
  await writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return true;
}

/**
 * Enable the per-ticket interaction smoke for a project whose declared
 * interface is a browser page the seat can drive (`browser-ui` / `canvas` —
 * not `native`: the smoke drives a browser, and a native window has none).
 * The interaction smoke is the earliest gate that proves the app is OPERABLE,
 * not merely startable — the exact failure class a pure-logic verify and a
 * diff-only review cannot
 * see (the spriteforge run shipped a broken toolbar/playback layout and dead
 * eraser/onion controls behind a fully green verify). It defaults OFF in
 * DEFAULT_CONFIG because it costs one full agent run per ticket, so a declared
 * interactive interface is the one case where that cost is clearly warranted:
 * the planner turns it on automatically. Mirrors the seed-if-empty rule — a
 * human's explicit `interaction_smoke` value (true OR false) always wins, and
 * the railhead never overrides user intent.
 */
async function seedInteractionSmokeIfUnset(cwd: string, iface: ProjectInterface): Promise<boolean> {
  if (iface !== "browser-ui" && iface !== "canvas") return false;
  const target = join(cwd, "railhead.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(target, "utf8"));
  } catch {
    // railhead.json should exist by plan time (cmdInit), but be defensive.
  }
  if (cfg["interaction_smoke"] !== undefined) return false;
  cfg["interaction_smoke"] = true;
  await writeFile(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return true;
}

/**
 * Generate a terse, plan-derived conventions file at the project root for a
 * greenfield build — but only when none exists (never clobber an existing one).
 * Returns the path written, or null when skipped because an AGENTS.md already
 * exists or the model produced nothing usable.
 */
export async function maybeGenerateAgentsMd(options: {
  cwd: string;
  prompt: string;
  model: string | null;
  tickets: Ticket[];
  contextBudget?: number;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
}): Promise<string | null> {
  const { cwd, prompt, model, tickets, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, maxContextTokens, verbose } = options;
  const target = join(cwd, "AGENTS.md");
  if (existsSync(target)) return null;

  const sizeHint = contextBudget ? ` The build runs on a ~${Math.floor(contextBudget / 1000)}k context window, so keep every rule terse.` : "";
  const ticketsList = tickets
    .map((t) => `- ${t.number}: ${t.title}`)
    .join("\n");
  const g = `You are writing the minimal AGENTS.md for a fresh, unattended build. None exists yet; create it in the root.

Project to build: ${prompt}

Planned tickets:
${ticketsList}
${sizeHint}

Write a MINIMAL conventions file in plain Markdown at AGENTS.md, containing ONLY cross-ticket conventions a later implementer cannot infer from a single ticket's files + contracts. Do NOT restate the mission, the ticket list, acceptance criteria, or verify commands — those already go into each implementer's prompt.

Include (in terse form, ideally 6-8 lines):
- Language/runtime and obvious toolchain from the plan
- Code layout: prefer many small cohesive modules over a single large file. Each file should be small enough that a worker operating under a ~${contextBudget ? Math.floor(contextBudget / 1000) : Math.floor(DEFAULT_CONTEXT_TOKENS / 1000)}k context can hold the relevant portions in working memory alongside the rest of the ticket's files and contracts. Avoid god-files that collect unrelated concerns; split along module boundaries. Each module should be *deep* — small interface, large implementation — so callers read the interface, not the impl (see docs/codebase-design.md).
- Naming conventions
- Where tests live and how to run them
- One line: keep changes minimal and context-friendly

Return exactly this marker line when done:
DONE AGENTS.md
`;

  const genLedger = join(cwd, ".railhead", "plan-latest");
  await initLedger(genLedger);
  await resetPhase(genLedger, "agents");
  const result = await executeOpendCode(g, {
    cwd,
    ledgerDir: genLedger,
    phaseFile: "agents",
    model,
    heartbeat: true,
    live: verbose === true,
    verbose,
    livePrefix: "agents",
    maxSteps,
    stallTimeoutSec,
    maxStepModelSec,
    maxContextTokens,
  });
  if (result.status === "transient") throw new Error(`agents-md: ${describeExecFailure(result)}`);
  if (result.status !== "ok") return null;
  const text = await extractAssistantText(genLedger, "agents");
  if (!/DONE/.test(text)) return null;
  if (!existsSync(target)) return null;
  return target;
}

export interface SharpenSessionResult {
  /** Extra context to fold into the ticket-generation prompt; "" when nothing was asked. */
  transcript: string;
  /** Rounds actually run (<= maxRounds; can end earlier on the model's own $DONE). */
  rounds: number;
  exchanges: SharpenExchange[];
}

/**
 * The plan-time interview (ADR 0010), ported from the sharpen discipline /
 * domain-modeling discipline as railhead-owned prompts and parsing — no
 * runtime dependency on an external skill suite (ADR 0007).
 *
 * Railhead-driven rounds, not a live interactive session: each round is one
 * ordinary `executeOpendCode` phase call (ADR 0001 — fresh subprocess, no
 * memory of prior rounds), ledgered under the same `.railhead/plan-latest`
 * directory `runPlan` uses. The railhead parses the model's structured
 * marker-block output, applies resolved terms/ADRs to disk immediately (the
 * moment they resolve, not batched), renders the round's questions, and
 * collects answers via the injected `ask` callback — real callers wire this
 * to a readline prompt; tests supply a canned one.
 *
 * Bounded by `maxRounds`: the model's own `$DONE` marker usually ends the
 * loop first, but a model that never emits one cannot spin this forever.
 */
export async function runSharpenSession(options: {
  cwd: string;
  topic: string;
  model: string | null;
  contextBudget?: number;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  maxRounds: number;
  /** Soft target question count for the model's pacing (0 = exhaustive, no
   * soft cap; the hard `maxRounds` backstop still applies). From the user's
   * depth picker — see `DEPTH_TARGET_QUESTIONS` in sharpen.ts. */
  depthTarget?: number;
  /** Interview mode: `build` (default) sharpens a feature description;
   * `fix` sharpens a bug report — the interview asks only about
   * reproduction (trigger, symptom, expected), never about code structure. */
  mode?: SharpenMode;
  /** ADR 0042: the plan to refine. When present (build mode), the interview
   * is post-plan: the plan is the source, and its answers are meant to change
   * it. Null/absent keeps the pre-plan prompt-only interview (fix mode). */
  planText?: string | null;
  /** Issue #39: when true, keep a persistent `opencode serve` worker alive
   * across sharpen rounds. Defaults to false (ADR 0001 baseline per-round
   * subprocess — ADR 0010 explicitly chose stateless per-round calls). */
  persistentWorker?: boolean;
  /** Echo the exact prompt sent to each model call to the console. */
  verbose?: boolean;
  ask: (question: SharpenQuestion) => Promise<string>;
  /**
   * Called once PER question, immediately before that question's answer is
   * collected via `ask` — real callers print the rendered string so the user
   * sees Q1, answers it, then sees Q2 (one at a time, per ADR 0010's
   * "prerequisites already settled" rule; a batched render would risk showing
   * a question whose answer depends on a sibling still pending). Tests can
   * omit it. Receives the 0-based index within the round for numbering.
   */
  onQuestion?: (question: SharpenQuestion, rendered: string, indexInRound: number) => void;
  infraBackoffSec?: number[];
}): Promise<SharpenSessionResult> {
  const { cwd, topic, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, maxRounds, depthTarget, mode, planText, verbose, ask, onQuestion, maxContextTokens, persistentWorker, infraBackoffSec } = options;
  return withPersistentWorker(persistentWorker === true, cwd, async () => {
  return runSharpenSessionInner({ cwd, topic, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, maxRounds, depthTarget, mode, planText, verbose, ask, onQuestion, maxContextTokens, infraBackoffSec, persistentWorker });
  });
}

async function runSharpenSessionInner(options: {
  cwd: string;
  topic: string;
  model: string | null;
  contextBudget?: number;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  maxRounds: number;
  depthTarget?: number;
  mode?: SharpenMode;
  planText?: string | null;
  verbose?: boolean;
  ask: (question: SharpenQuestion) => Promise<string>;
  onQuestion?: (question: SharpenQuestion, rendered: string, indexInRound: number) => void;
  infraBackoffSec?: number[];
  persistentWorker?: boolean;
}): Promise<SharpenSessionResult> {
  const { cwd, topic, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, maxRounds, depthTarget, mode, planText, verbose, ask, onQuestion, maxContextTokens, infraBackoffSec, persistentWorker } = options;

  const contracts = await loadContracts(cwd);
  const existingGlossary = (await readProjectDoc(cwd, "CONTEXT.md")) ?? "";
  const system = sharpenSystemPrompt(topic, summarizeContracts(contracts), existingGlossary, contextBudget, depthTarget, mode ?? "build", planText);

  const sharpenLedger = join(cwd, ".railhead", "plan-latest");
  await initLedger(sharpenLedger);

  const exchanges: SharpenExchange[] = [];
  let round = 0;
  while (round < maxRounds) {
    round++;
    const phaseFile = `sharpen-${String(round).padStart(2, "0")}`;
    // Each session owns this phase file; without truncating, a prior plan
    // invocation's round output would leak into this one, mirroring the
    // exact reason runPlan resets its own "plan" phase file.
    await resetPhase(sharpenLedger, phaseFile);
    const prompt = buildSharpenRoundPrompt(system, exchanges);
    const sharpenBackoff = infraBackoffSec ?? DEFAULT_INFRA_BACKOFF_SEC;
    const sharpenInfra = await withFailureLadderOnThrow(
      async () => {
        const r = await executeOpendCode(prompt, {
          cwd,
          ledgerDir: sharpenLedger,
          phaseFile,
          model,
          heartbeat: true,
          live: verbose === true,
          verbose,
          livePrefix: "sharpen",
          maxSteps,
          stallTimeoutSec,
          maxStepModelSec,
          maxContextTokens,
        });
        if (r.status === "transient") throw new Error(describeExecFailure(r));
        return r;
      },
      {
        backoff: sharpenBackoff,
        budget: maxContextTokens ?? DEFAULT_CONTEXT_TOKENS,
        restartWorker: plannerRestart(cwd, persistentWorker === true),
        onRung: (rung) => {
          console.log(`[sharpen] round ${round}: ${rung.diagnosis}`);
        },
      },
    );
    if (!sharpenInfra.ok) throw new Error(`sharpen round ${round}: ${sharpenInfra.rung.diagnosis}`);
    const result = sharpenInfra.value;
    if (result.status !== "ok") break; // can't continue the interview; keep whatever was already resolved

    const text = await extractAssistantText(sharpenLedger, phaseFile);
    const parsed = parseSharpenRound(text);

    if (parsed.terms.length) await appendContextTerms(cwd, parsed.terms);
    for (const adr of parsed.adrs) await writeGrillAdr(cwd, adr);

    if (parsed.done) break;

    for (let i = 0; i < parsed.questions.length; i++) {
      const q = parsed.questions[i];
      onQuestion?.(q, renderQuestionForTerminal(q, i), i);
      const answer = await ask(q);
      exchanges.push({ question: q, answer });
    }
  }

  return { transcript: renderTranscriptForPlanner(exchanges), rounds: round, exchanges };
}