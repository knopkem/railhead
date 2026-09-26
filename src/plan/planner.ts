import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeExecFailure, executeOpendCode, withPersistentWorker, startPersistentWorker, stopPersistentWorker } from "../execute/executor.ts";
import { loadContracts, summarizeContracts } from "../core/contracts.ts";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_INFRA_BACKOFF_SEC, DEFAULT_MAX_REPLANS } from "../config/config.ts";
import { buildReplanPrompt } from "../gates/replan.ts";
import { readDigest } from "../context/digest.ts";
import { readLearnings } from "../context/learnings.ts";
import { withFailureLadderOnThrow } from "../execute/failure-ladder.ts";
import { planDesignSystemPrompt, planTicketsSystemPrompt, planFeatureDesignSystemPrompt, planFeatureTicketsSystemPrompt, planFixSystemPrompt, planContinuationSystemPrompt, buildProductSessionPrompt, buildProductRevisionPrompt, parseProductReply, buildFeatureStepPrompt, parseFeatureStepReply, buildPlanRevisionPrompt, buildPlanUserFeedbackPrompt, buildPlanMarkdown, buildPlanGatePrompt, parsePlanGateVerdict, parsePlanJson, parseVerifyBlock, parseSmokeBlock, parseDesignBlock, parseArchitectureBlock, parseInterfaceBlock, splitCoherenceContract, type PlanMode, type PlanTicket } from "./plan.ts";
import { touchesVisualSurface } from "../context/surface.ts";
import { isRenderedSurface, type ProjectInterface } from "../config/interface.ts";
import { numberTickets, writeTickets, type Ticket } from "../core/ticket.ts";
import { writePlanOrigin } from "./plan-identity.ts";
import { extractAssistantText, extractPlanText, initLedger, resetPhase, readStderrLines } from "../core/ledger.ts";
import { readProjectDoc, writeProjectDoc, headCommit } from "../core/git.ts";
import { readProductPlan, renderProductBrief, renderProductPlan, PRODUCT_DOC, type ArcStepIdentity, type ProductPlan } from "../core/product.ts";
import { CHARTER_DOC } from "../context/coherence.ts";
import { summarizePermissionRejections } from "../core/permissions.ts";
import {
  appendContextTerms,
  appendInterviewLog,
  buildSharpenRoundPrompt,
  interviewLogPath,
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
}export interface PlanResult {
  outDir: string;
  tickets: Ticket[];
  /** Verify commands parsed from the plan's $VERIFY block (empty if none emitted). */
  verify: string[];
  /** True when this plan established the project's verify suite — railhead.json
   * had no verify list before and the plan's $VERIFY seeded it. A feature run
   * then skips the red-baseline refusal: there was no suite to be green before
   * this plan (the greenfield step-1 case). */
  verifySeeded: boolean;
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
  /** The goal-review seat's model for the plan gate (v2 issue 01). When
   * absent, or when `reviewPlan` is present (the human IS the coverage
   * check), no plan gate runs. */
  goalModel?: string | null;
  /** Cap on plan-gate frontier regenerations. Defaults to
   * `DEFAULT_MAX_REPLANS`. */
  maxReplans?: number | null;
  /** ADR 0051: in feature mode, the roadmap step (1-based) this plan builds.
   * Resolved against the product arc so the plan gate judges the step and the
   * origin records the identity for run-end/resume. */
  arcStepNumber?: number | null;
  /** Override the plan's slug/namespace. A feature run passes a stable
   * step-derived slug so reopening the same step reuses its `.scratch/<slug>/`
   * plan namespace (and its `run/<slug>` branch) instead of fragmenting a new
   * one per attempt. Defaults to a prompt-derived slug. */
  slug?: string;
}): Promise<PlanResult> {
  const { cwd, prompt, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, mode, verbose, maxContextTokens, persistentWorker, infraBackoffSec, reviewPlan, interviewPlan, artDirection, goalModel, maxReplans, arcStepNumber, slug } = options;
  return withPersistentWorker(persistentWorker === true, cwd, async () => {
  return runPlanInner({ cwd, prompt, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, mode, verbose, maxContextTokens, infraBackoffSec, persistentWorker, reviewPlan, interviewPlan, artDirection, goalModel, maxReplans, arcStepNumber, slug });
  });
}

/** Shared subprocess/knobs bundle for every planner-family stage runner. */
interface PlannerStageOptions {
  cwd: string;
  planLedger: string;
  model: string | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
  infraBackoffSec?: number[];
  persistentWorker?: boolean;
}

/** One staged planner-family call: reset the phase file, run the model with
 * the failure ladder (transient provider errors retry), and return the
 * transcript. A non-ok completion is fatal — each stage's output feeds the
 * next, so a partial transcript is never usable. */
async function plannerStage(o: PlannerStageOptions, phaseFile: string, prompt: string, livePrefix: string): Promise<string> {
  // Each phase file is owned by its invocation; without truncating, a prior
  // session's events accumulate and leak into this one.
  await resetPhase(o.planLedger, phaseFile);
  const infra = await withFailureLadderOnThrow(
    async () => {
      const r = await executeOpendCode(prompt, {
        cwd: o.cwd,
        ledgerDir: o.planLedger,
        phaseFile,
        model: o.model,
        heartbeat: true,
        live: o.verbose === true,
        verbose: o.verbose,
        livePrefix,
        maxSteps: o.maxSteps,
        stallTimeoutSec: o.stallTimeoutSec,
        maxStepModelSec: o.maxStepModelSec,
        maxContextTokens: o.maxContextTokens,
      });
      if (r.status === "transient") {
        throw new Error(describeExecFailure(r));
      }
      return r;
    },
    {
      backoff: o.infraBackoffSec ?? DEFAULT_INFRA_BACKOFF_SEC,
      budget: o.maxContextTokens ?? DEFAULT_CONTEXT_TOKENS,
      restartWorker: plannerRestart(o.cwd, o.persistentWorker === true),
      onRung: (rung) => {
        console.log(`[${livePrefix}] ${rung.diagnosis}`);
      },
    },
  );
  if (!infra.ok) {
    throw new Error(`planner hit a provider failure (${infra.rung.diagnosis}); re-run the railhead command after the rate limit clears`);
  }
  if (infra.value.status !== "ok") {
    throw new Error(`planner did not complete (${describeExecFailure(infra.value)})`);
  }
  return extractPlanText(o.planLedger, phaseFile);
}

/** Product-session subprocess knobs (ADR 0051): everything planning supports,
 * minus the plan-specific wiring (no ticket stages, no gate). */
interface ProductSessionOptions {
  cwd: string;
  /** The operator's input for this session: the vision (authoring) or the
   * steering text (revision). */
  instruction: string;
  model: string | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
  infraBackoffSec?: number[];
  persistentWorker?: boolean;
  /** ADR 0051: the post-condense arc interview. Called with the parsed arc
   * markdown; a non-empty return is the operator's answers, which revise the
   * arc through one more stage before it is returned. The CLI owns the
   * session and the prompting (mirrors `runPlan`'s `interviewPlan`). */
  refine?: (arcMarkdown: string) => Promise<string | null>;
}

/** The product session's output: the parsed arc plus the parser's warnings
 * (status anomalies, duplicate steps) — the CLI surfaces both before adoption. */
export interface ProductSessionResult {
  plan: ProductPlan;
  warnings: string[];
  /** The arc markdown exactly as the model emitted it (the CLI renders this
   * for explicit adoption; `plan` may normalize marker lines). */
  markdown: string;
}

/**
 * One condense call: the operator's vision or steering text becomes the
 * product arc (a full ProductPlan). Never writes: the CLI shows the operator
 * the parsed arc and adopts it explicitly — silently overwriting
 * docs/product.md would desync the thing the whole process steers against.
 */
export async function runProductSession(options: ProductSessionOptions): Promise<ProductSessionResult> {
  const { cwd, instruction } = options;
  const planLedger = join(cwd, ".railhead", "plan-latest");
  await initLedger(planLedger);
  const stageOpts: PlannerStageOptions = {
    cwd,
    planLedger,
    model: options.model,
    maxSteps: options.maxSteps,
    stallTimeoutSec: options.stallTimeoutSec,
    maxStepModelSec: options.maxStepModelSec,
    maxContextTokens: options.maxContextTokens,
    verbose: options.verbose,
    infraBackoffSec: options.infraBackoffSec,
    persistentWorker: options.persistentWorker,
  };
  const current = await readProductPlan(cwd);
  // ADR 0051: an existing repo's public surface is real even when the index is
  // empty — the existing-repo framing keeps the prompt from telling the arc
  // session "greenfield" and then steering every feature against that lie.
  const contracts = await loadContracts(cwd);
  const system = buildProductSessionPrompt({
    contractsSummary: summarizeContracts(contracts, "existing-repo"),
    existingPlanMarkdown: current ? renderProductPlan(current) : null,
    existingGlossary: (await readProjectDoc(cwd, "CONTEXT.md")) ?? undefined,
  });
  const text = await plannerStage(stageOpts, "product", `${system}\n\nThe operator's input for this session: ${instruction}`, "product");
  const first = parseProductReply(text);
  if (options.refine) {
    // ADR 0051: the arc is sharpened before adoption. A zero-question
    // interview is a valid outcome; the answers only trigger a revision when
    // the operator actually changed something.
    const answers = await options.refine(renderProductPlan(first.plan));
    if (answers?.trim()) {
      return reviseProductStage(stageOpts, instruction, renderProductPlan(first.plan), answers.trim());
    }
  }
  return { plan: first.plan, warnings: first.warnings, markdown: renderProductPlan(first.plan) };
}

/** One revision call: the operator's interview answers change the arc; the
 * session re-emits the complete arc. Shared by the live session (ADR 0051) and
 * the recorded-answer replay (`reviseProductArc`). */
async function reviseProductStage(
  stageOpts: PlannerStageOptions,
  instruction: string,
  priorArcMarkdown: string,
  findings: string,
): Promise<ProductSessionResult> {
  const revised = await plannerStage(
    stageOpts,
    "product-revise",
    `${buildProductRevisionPrompt({ instruction, priorArcMarkdown, findings: [findings] })}\n\nEmit the revised arc now.`,
    "product",
  );
  const parsed = parseProductReply(revised);
  return { plan: parsed.plan, warnings: parsed.warnings, markdown: renderProductPlan(parsed.plan) };
}

export interface ProductRevisionOptions {
  cwd: string;
  /** The operator's original/steering input the revision frames the answers against. */
  instruction: string;
  /** Rendered findings (see `renderPlanInterviewAnswers` in sharpen.ts). */
  findings: string;
  model: string | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
  infraBackoffSec?: number[];
  persistentWorker?: boolean;
}

/**
 * Replay a recorded interview's answers against the stored arc — the resume
 * path after a stopped or crashed product session, with no interview and no
 * condense call (the arc under review is already on disk). One revision call;
 * never writes (adoption stays the CLI's).
 */
export async function reviseProductArc(options: ProductRevisionOptions): Promise<ProductSessionResult> {
  const { cwd } = options;
  const planLedger = join(cwd, ".railhead", "plan-latest");
  await initLedger(planLedger);
  const current = await readProductPlan(cwd);
  if (!current) throw new Error(`no product arc at ${PRODUCT_DOC} to revise — author one with \`railhead product\` first`);
  const stageOpts: PlannerStageOptions = {
    cwd,
    planLedger,
    model: options.model,
    maxSteps: options.maxSteps,
    stallTimeoutSec: options.stallTimeoutSec,
    maxStepModelSec: options.maxStepModelSec,
    maxContextTokens: options.maxContextTokens,
    verbose: options.verbose,
    infraBackoffSec: options.infraBackoffSec,
    persistentWorker: options.persistentWorker,
  };
  return reviseProductStage(stageOpts, options.instruction, renderProductPlan(current), options.findings);
}

export interface FeatureStepOptions {
  cwd: string;
  step: { number: number; title: string; description: string; feedback: string | null; runId?: string | null };
  plan: ProductPlan;
  model: string | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
  maxStepModelSec?: number | null;
  maxContextTokens?: number | null;
  verbose?: boolean;
  infraBackoffSec?: number[];
  persistentWorker?: boolean;
}

/** Roadmap summary for the derivation prompt: statuses only — what is DONE
 * frames integration history, what is TODO frames where this step sits. */
function roadmapSummary(plan: ProductPlan): string {
  return plan.steps
    .map((s) => `${s.number} — ${s.title} [${s.status}]`)
    .join("\n");
}

/** ADR 0051: the previous attempt's report, when a step was reopened after a
 * build. Capped — the report is an orientation, not the record (the ledger is).
 * Absent report (never ran, purged) reads as null and the prompt omits it. */
async function readPriorAttempt(cwd: string, runId: string | null | undefined): Promise<string | null> {
  if (!runId) return null;
  try {
    const raw = (await readFile(join(cwd, ".railhead", runId, "report.md"), "utf8")).trim();
    if (!raw) return null;
    const cap = 2500;
    return raw.length > cap ? `${raw.slice(0, cap)}\n… (report truncated)` : raw;
  } catch {
    return null;
  }
}

/**
 * One derivation call: a roadmap step becomes the feature prompt for one
 * unattended feature run — the step that the human will test tomorrow
 * morning. Fails loud when the session cannot produce a prompt beyond the
 * marker.
 */
export async function deriveFeaturePrompt(options: FeatureStepOptions): Promise<string> {
  const { cwd, step, plan } = options;
  const planLedger = join(cwd, ".railhead", "plan-latest");
  await initLedger(planLedger);
  const stageOpts: PlannerStageOptions = {
    cwd,
    planLedger,
    model: options.model,
    maxSteps: options.maxSteps,
    stallTimeoutSec: options.stallTimeoutSec,
    maxStepModelSec: options.maxStepModelSec,
    maxContextTokens: options.maxContextTokens,
    verbose: options.verbose,
    infraBackoffSec: options.infraBackoffSec,
    persistentWorker: options.persistentWorker,
  };
  const contracts = await loadContracts(cwd);
  const system = buildFeatureStepPrompt({
    stepNumber: step.number,
    stepTitle: step.title,
    stepDescription: step.description,
    feedback: step.feedback ?? undefined,
    productBrief: renderProductBrief(plan),
    roadmapSummary: roadmapSummary(plan),
    contractsSummary: contracts.entries.length || contracts.schema_version ? summarizeContracts(contracts, "existing-repo") : undefined,
    existingCharter: (await readProjectDoc(cwd, CHARTER_DOC)) ?? undefined,
    existingGlossary: (await readProjectDoc(cwd, "CONTEXT.md")) ?? undefined,
    // Ground truth: the digest/learnings say what the repo actually is now;
    // a reopened step also carries what its previous run did.
    projectDigest: (await readDigest(cwd)) ?? undefined,
    learnings: (await readLearnings(cwd)) ?? undefined,
    priorAttempt: await readPriorAttempt(cwd, step.runId),
  });
  const text = await plannerStage(
    stageOpts,
    "feature-step",
    `${system}\n\nNow emit the $FEATURE_PROMPT block for step ${step.number} — ${step.title}.`,
    "feature",
  );
  const derived = parseFeatureStepReply(text);
  if (!derived.trim()) {
    throw new Error("feature step derivation produced no prompt text — re-run `railhead feature`");
  }
  return derived;
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
  goalModel?: string | null;
  maxReplans?: number | null;
  arcStepNumber?: number | null;
  slug?: string;
}): Promise<PlanResult> {
  const { cwd, prompt, model, contextBudget, maxSteps, stallTimeoutSec, maxStepModelSec, mode, verbose, maxContextTokens, infraBackoffSec, persistentWorker, reviewPlan, interviewPlan, artDirection, goalModel, maxReplans, arcStepNumber, slug: slugOverride } = options;
  const slug = slugOverride?.trim()
    || prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30) || "project";
  const outDir = join(cwd, ".scratch", slug, "issues");

  const contracts = await loadContracts(cwd);
  // Feature mode (ADR 0051): the existing-repo framing keeps an empty
  // contracts index from telling the planner a greenfield lie, and the arc +
  // held charter ride every feature-plan stage.
  const contractsSummary = summarizeContracts(contracts, mode === "feature" ? "existing-repo" : undefined);
  const existingGlossary = await readProjectDoc(cwd, "CONTEXT.md");
  const productPlan = mode === "feature" ? await readProductPlan(cwd) : null;
  const productBrief = productPlan ? renderProductBrief(productPlan) : undefined;
  const existingCharter = mode === "feature" ? await readProjectDoc(cwd, CHARTER_DOC) : null;
  // ADR 0051: the exact roadmap step this feature plan builds. The plan gate
  // judges the step (description + feedback), and the plan's origin records
  // the identity so run-end/resume can finish the arc transaction.
  const arcStep = mode === "feature" && arcStepNumber != null
    ? productPlan?.steps.find((s) => s.number === arcStepNumber) ?? null
    : null;
  if (mode === "feature" && arcStepNumber != null && !arcStep) {
    throw new Error(`step ${arcStepNumber} does not exist in ${PRODUCT_DOC} — re-run \`railhead feature\` to pick an existing step`);
  }
  const planLedger = join(cwd, ".railhead", "plan-latest");
  await initLedger(planLedger);
  const stageOpts: PlannerStageOptions = {
    cwd,
    planLedger,
    model,
    maxSteps,
    stallTimeoutSec,
    maxStepModelSec,
    maxContextTokens,
    verbose,
    infraBackoffSec,
    persistentWorker,
  };
  const stage = (phaseFile: string, prompt: string, livePrefix: string): Promise<string> =>
    plannerStage(stageOpts, phaseFile, prompt, livePrefix);

  // Planning is two calls: a fix is one call, a build is design → ticket
  // decomposition. The design call decides what the build IS; the ticket call
  // turns that document into an ordered queue. No model audit and no model
  // repair rounds — a plan the railhead would reject is a plan the human can
  // re-run cheaply, and the audit/repair loops were the dominant failure mode
  // for weak planners (a truncated or over-demanding audit rejected valid
  // plans; a repair loop that could not re-emit the full array rejected the
  // rest).
  let designText: string;
  let ticketsText: string;
  if ((mode ?? "build") === "fix") {
    const text = await stage("plan", `${planFixSystemPrompt(contractsSummary, contextBudget, existingGlossary ?? undefined)}\n\nWhat to build: ${prompt}`, "plan");
    designText = text;
    ticketsText = text;
  } else {
    const feature = mode === "feature";
    const designSystem = feature
      ? planFeatureDesignSystemPrompt({ contractsSummary, existingGlossary: existingGlossary ?? undefined, artDirection, productBrief, existingCharter: existingCharter ?? undefined })
      : planDesignSystemPrompt({ contractsSummary, existingGlossary: existingGlossary ?? undefined, artDirection });
    designText = await stage("plan", `${designSystem}\n\nWhat to build: ${prompt}`, "plan");
    // ADR 0042: the planning interview now runs AFTER the plan exists, sourced
    // from the prompt + plan, and its answers revise the plan before the
    // ticket decomposition. The CLI owns the session; an empty return means
    // the interview was skipped or asked nothing.
    if (interviewPlan) {
      const answers = await interviewPlan(designText);
      if (answers?.trim()) {
        console.log("[plan] planning interview — revising the plan with the user's answers");
        designText = await stage(
          "plan-revise-interview-1",
          buildPlanRevisionPrompt({ goal: prompt, priorPlanText: designText, findings: [answers.trim()] }),
          "interview",
        );
      }
    }
    // ADR 0041 (amended): in interactive mode the human reviews the FINAL plan
    // (post-interview) BEFORE tickets exist. PLAN.md is written plan-only at
    // this point; feedback re-emits the plan through the ordinary revision
    // path; acceptance falls through to decomposition.
    if (reviewPlan) {
      let reviewRound = 0;
      for (;;) {
        const planPath = await writePlanOnly({ cwd, prompt, designText, mode: (mode ?? "build") as PlanMode, slug });
        const feedback = await reviewPlan({ planPath });
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
    }
    const ticketsSystem = feature
      ? planFeatureTicketsSystemPrompt({ contractsSummary, existingGlossary: existingGlossary ?? undefined, artDirection, existingCharter: existingCharter ?? undefined })
      : planTicketsSystemPrompt({ contractsSummary, existingGlossary: existingGlossary ?? undefined, artDirection });
    ticketsText = await stage(
      "plan-tickets",
      `${ticketsSystem}\n\nThe validated plan to decompose:\n\n${designText}\n\nOriginal goal: ${prompt}`,
      "tickets",
    );
    // Truncation guard: a decomposition that ran out of output room loses the
    // unfinished tail ticket (countTicketObjects sees the "title" keys). Ask
    // ONCE for the remaining tickets, additively — the parser's continuation
    // logic appends a later array whose titles are all new. This is an
    // integrity retry, not a findings repair loop.
    const first = parsePlanJson(ticketsText);
    if (first.unparsed > 0) {
      console.warn(`[plan] decomposition output looks truncated (${first.unparsed} ticket object(s) unparsed) — asking for the remaining tickets`);
      const continuation = await stage(
        "plan-tickets-continue",
        `${planContinuationSystemPrompt({ contractsSummary, existingGlossary: existingGlossary ?? undefined, artDirection })}\n\nThis is what you had emitted (the tail is incomplete):\n\n${ticketsText}`,
        "tickets",
      );
      ticketsText = `${ticketsText}\n\n${continuation}`;
    }
  }

  const finalize = (text: string): Promise<PlanResult> =>
    finalizePlan({
      cwd,
      prompt,
      designText,
      ticketsText: text,
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
      heldCharter: Boolean(existingCharter?.trim()),
      arcStep: arcStep ? { number: arcStep.number, title: arcStep.title } : undefined,
    });

  let plan = await finalize(ticketsText);

  // Plan gate (v2 issue 01): unattended builds get one goal-seat judgment of
  // the finished plan BEFORE any build starts — the same diff PLAN.md against
  // the original goal's coverage checklist that the goal review asks mid-run,
  // moved to the only point where a scope gap is cheap. Interactive runs skip
  // it: the human reviewing PLAN.md IS the coverage check (ADR 0049 §5). A
  // failed gate regenerates the ticket frontier via the mid-run replan prompt,
  // capped by the same `max_replans` budget the run honors; a plan still
  // failing at the cap is rejected before the first commit.
  if (mode === "fix" || reviewPlan || !goalModel) return plan;
  const cap = maxReplans ?? DEFAULT_MAX_REPLANS;
  for (let round = 0; ; round++) {
    const gatePrompt = buildPlanGatePrompt({
      originalPrompt: prompt,
      planMarkdown: buildPlanMarkdown({
        prompt,
        designDoc: plan.designDoc,
        architectureDoc: plan.architectureDoc,
        tickets: plan.tickets,
      }),
      contractsSummary,
      tickets: plan.tickets.map((t) => ({ number: t.number, title: t.title, what: t.what, criteria: t.criteria })),
      productBrief,
      arcStep: arcStep
        ? { number: arcStep.number, title: arcStep.title, description: arcStep.description, feedback: arcStep.feedback }
        : null,
    });
    const gateText = await stage(`plan-gate-${round}`, gatePrompt, "gate");
    const gate = parsePlanGateVerdict(gateText);
    if (gate.verdict === "pass") {
      if (round > 0) console.log(`[plan] plan gate ✓ passed after ${round} revision(s)`);
      return plan;
    }
    console.log(`[plan] plan gate ✗ scope gap(s) in the plan: ${gate.findings.join(" | ") || "(no findings emitted)"}`);
    if (round >= cap) {
      throw new Error(
        `plan gate rejected the plan after ${cap} revision(s): ${gate.findings.join(" | ") || "the goal seat emitted no findings"} — fix the goal or re-run \`railhead build\``,
      );
    }
    const digest = await readDigest(cwd);
    const replanPrompt = buildReplanPrompt({
      originalPrompt: prompt,
      findings: gate.findings,
      contractsSummary,
      digest,
      committedTickets: [],
      uncommittedTickets: plan.tickets.map((t) => ({ number: t.number, title: t.title, file: t.file })),
    });
    ticketsText = await stage(`plan-replan-${round + 1}`, replanPrompt, "replan");
    plan = await finalize(ticketsText);
  }
}

/** Write the plan-only PLAN.md the interactive reviewer reads before any
 * ticket exists. The finalize pass rewrites it with the ticket breakdown once
 * the plan is accepted and decomposed. Returns the written path (build and
 * feature plans only; fix mode has no plan to review). Feature plans write
 * into their .scratch namespace (ADR 0051). */
async function writePlanOnly(opts: { cwd: string; prompt: string; designText: string; mode: PlanMode; slug: string }): Promise<string | null> {
  const { cwd, prompt, designText, mode, slug } = opts;
  const designDoc = parseDesignBlock(designText);
  const architectureDoc = parseArchitectureBlock(designText);
  const markdown = buildPlanMarkdown({
    prompt,
    designDoc: designDoc ? splitCoherenceContract(designDoc).narrative : null,
    architectureDoc,
  });
  const planDocPath = mode === "feature" ? join(".scratch", slug, "PLAN.md") : "PLAN.md";
  await writeProjectDoc(cwd, planDocPath, markdown);
  return join(cwd, planDocPath);
}

/** Deterministic art-direction ticket: a plan that declares a rendered surface
 * must own the look with ONE open-ended craft ticket. If the planner did not
 * emit one, the railhead appends this standard ticket rather than rejecting
 * the plan — the design doc's \`## Art direction\` section is the direction it
 * executes. */
function artDirectionTicket(): PlanTicket {
  return {
    title: "Craft the rendered look",
    what: "Make the composed experience match the Art direction section of docs/design.md: run the app, capture a screenshot, read it back, judge it against the direction, and keep improving the weakest thing until the whole frame is genuinely crafted and coherent. This is the ONE open-ended craft ticket that owns everything the user sees — background, actors, lighting, chrome, and motion.",
    criteria: [],
    open_ended: true,
    group: "polish",
  };
}

/** v2 issue 01: whether the plan's verify block runs a test runner — the
 * signal that the project HAS a test stack for the hardener ticket to grow.
 * Technology-agnostic: the word "test" in a project-declared command, never a
 * per-language runner list. */
function planHasTestStack(verify: string[]): boolean {
  return verify.some((c) => /\btest\b/i.test(c));
}

/** The final hardening ticket (v2 issue 01): appended after the planned
 * frontier when the project has a test stack. It transcribes the behaviors the
 * run CONFIRMED (the probe registry) into the project's own tests — the suite
 * grows from verified behavior at the end, never from the implementer
 * imagining its own grade mid-build (ADR 0006: verify runs only what exists,
 * so it stays green at every earlier step). */
function hardenerTicket(): PlanTicket {
  return {
    title: "Harden: transcribe confirmed behaviors into the test suite",
    what: "Turn the behaviors this run CONFIRMED into the project's own regression tests, using the test stack already in the project (discover it from the verify commands and the package manifest — do not add a new framework). Sources of confirmed behavior: the registered probes under `.railhead/probes/` (each script is a behavior; the run's state.json `probes` array names its expected predicate), and the committed tickets' acceptance criteria that the gates passed. Rules: one test per confirmed behavior, asserting the probe's predicate or the criterion's observable outcome; do NOT invent coverage for behavior nobody verified and do NOT restate implementation details; do not weaken, delete, or skip existing tests; the project's verify commands must still pass when you are done. If the probe registry is empty, or the project turns out to have no test stack, make no changes and checkpoint with a one-line note saying so.",
    criteria: [
      "Every behavior the run's probe registry confirms has a regression test in the project's existing test stack",
      "The project's verify commands still pass",
    ],
    group: "harden",
  };
}

/** The tail of planning: parse the current plan/ticket transcripts, write the
 * docs (design/architecture/coherence/PLAN.md), validate the tickets, number
 * them, and seed railhead.json. Idempotent — each call overwrites the
 * artifacts of the previous iteration. */async function finalizePlan(opts: {
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
  /** ADR 0051: a feature plan into a product whose coherence charter already
   * exists. The charter is the visual authority — the plan neither re-authors
   * it nor gets the deterministic whole-look craft ticket, and the missing-
   * charter warning stays silent. */
  heldCharter?: boolean;
  /** ADR 0051: the roadmap step this feature plan builds, persisted into the
   * plan's origin.json so run-end/resume can mark it `built`. */
  arcStep?: ArcStepIdentity;
}): Promise<PlanResult> {
  const { cwd, prompt, designText, ticketsText, outDir, slug, mode, artDirection, planLedger, arcStep } = opts;
  const verify = parseVerifyBlock(designText);
  const smoke = parseSmokeBlock(designText);
  const projectInterface = parseInterfaceBlock(designText);
  // A plan that declares a rendered surface must own the look with an
  // open-ended craft ticket unless the project disabled art direction.
  // Undeclared (fix mode) or terminal/none never requires one. A feature plan
  // with a held charter is the exception: the look is already owned by
  // docs/coherence.md, and only a genuinely NEW surface warrants a craft
  // ticket — a decision the planner makes, not a deterministic append.
  const featureWithHeldCharter = mode === "feature" && opts.heldCharter === true;
  const artDirectionRequired = artDirection !== false && isRenderedSurface(projectInterface) && !featureWithHeldCharter;
  // Issue #34: extract the planner's design and architecture intent from
  // $DESIGN / $ARCHITECTURE marker blocks. In fix mode they stay optional.
  // When present, the documents are written under docs/ so implementers,
  // reviewers, and the goal reviewer can read the planner's intent instead of
  // reconstructing it from committed code.
  const designDoc = parseDesignBlock(designText);
  const architectureDoc = parseArchitectureBlock(designText);
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
  // ADR 0051: a feature plan's docs live beside its ticket store under
  // .scratch/<slug>/ — the project root's docs (a real product's plan, or the
  // user's own) are never overwritten; startRun resolves this same location
  // into state.docs_dir so every seat reads it back.
  const feature = mode === "feature";
  const designDocPath = feature ? join(".scratch", slug, "docs", "design.md") : "docs/design.md";
  const architectureDocPath = feature ? join(".scratch", slug, "docs", "architecture.md") : "docs/architecture.md";
  if (designNarrative) {
    await writeProjectDoc(cwd, designDocPath, designNarrative + "\n");
  }
  if (architectureDoc) {
    await writeProjectDoc(cwd, architectureDocPath, architectureDoc + "\n");
  }
  let coherenceAuthored = false;
  if (coherenceContract) {
    await writeProjectDoc(cwd, "docs/coherence.md", coherenceContract + "\n");
    coherenceAuthored = true;
  }
  let tickets: PlanTicket[];
  const ticketsPhase = (mode ?? "build") === "fix" ? "plan" : "plan-tickets";
  try {
    tickets = parsePlanJson(ticketsText).tickets;
  } catch (err) {
    const stderrLines = await readStderrLines(planLedger, ticketsPhase);
    const rejections = summarizePermissionRejections(stderrLines);
    const suffix = rejections.count > 0
      ? ` — ${rejections.summary} (the model may have emitted its plan as a write to a path opencode auto-rejected; check \`.railhead/plan-latest/events/${ticketsPhase}.jsonl\`)`
      : "";
    throw new Error(`${(err as Error).message}${suffix}`);
  }
  assertTicketsUsable(tickets);
  // A rendered surface's look must be owned by exactly ONE open-ended craft
  // ticket. The planner is asked to emit it; when it does not, the railhead
  // appends the standard art ticket deterministically instead of failing a
  // plan over a missing ticket.
  if (artDirectionRequired && !tickets.some((t) => t.open_ended === true)) {
    console.warn(
      `[plan] the plan declares a rendered surface but emitted no open-ended craft ticket — appending a standard one that executes docs/design.md's Art direction section`,
    );
    tickets = [...tickets, artDirectionTicket()];
  }
  // v2 issue 01: a project with a test stack gets ONE final hardening ticket
  // after the whole frontier; it transcribes the run's confirmed behaviors
  // into the project's own tests. Build and feature plans (a fix has no plan
  // to grow).
  if ((mode === "build" || mode === "feature") && planHasTestStack(verify)) {
    tickets = [...tickets, hardenerTicket()];
  }
  const ordered = numberTickets(tickets);
  const planDir = join(outDir, "..");
  await writeTickets(outDir, ordered);
  // Seed the verify commands BEFORE the origin is written: the run start reads
  // the origin to learn whether THIS plan established the suite (railhead.json
  // was empty), in which case a feature run skips the red-baseline refusal —
  // there was nothing to be green before this plan.
  let verifySeeded = false;
  if (verify.length > 0) {
    verifySeeded = await seedVerifyIfEmpty(cwd, verify);
  }
  await writePlanOrigin(planDir, {
    slug,
    prompt,
    created_at: new Date().toISOString(),
    ticket_files: ordered.map((t) => t.file),
    base_sha: await headCommit(cwd).catch(() => null),
    ...(arcStep ? { arc_step: arcStep } : {}),
    ...(verifySeeded ? { verify_seeded: true } : {}),
  });
  // The human-facing plan overview. Written for build plans only (fix mode is
  // one ticket — there is nothing to iterate on); the distilled
  // docs/design.md and docs/architecture.md remain the reviewer inputs. A
  // feature plan writes its overview into the same .scratch namespace.
  let planPath: string | null = null;
  if (mode === "build" || mode === "feature") {
    const markdown = buildPlanMarkdown({
      prompt,
      designDoc: designNarrative,
      architectureDoc,
      tickets: ordered,
    });
    const planDocPath = feature ? join(".scratch", slug, "PLAN.md") : "PLAN.md";
    await writeProjectDoc(cwd, planDocPath, markdown);
    planPath = join(cwd, planDocPath);
  }

  // Issue #99 (ADR 0028): plan-time guard. A surfaced plan that authored no
  // charter section WARNS (never fails) — the recall-biased gate's observable,
  // and the input for the report.md escalation. If this fires repeatedly in
  // practice, revisit a post-plan distill pass (Decision 1), not now.
  const surfaceTickets = ordered.filter((t) => touchesVisualSurface(t));
  if (surfaceTickets.length > 0 && !coherenceAuthored && !featureWithHeldCharter) {
    console.warn(
      `[plan] warning: ${surfaceTickets.length} ticket(s) appear to touch a visual surface (${surfaceTickets.map((t) => t.number).join(", ")}) but the plan's $DESIGN block has no \`## Coherence contract\` section — surface tickets will build without a coherence charter (ADR 0028). Add the section to $DESIGN or accept the drift.`,
    );
  }

  // Seed a planner-emitted launch command into railhead.json only when the
  // user hasn't already configured one (same seed-if-empty rule as verify,
  // which was seeded above, before the origin was written). A user who sets
  // smoke:[] (or NONE) is signalling "no smoke for this project" — don't
  // override that.
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
  }
  return { outDir, tickets: ordered, verify, verifySeeded, smoke, designDoc: designNarrative, architectureDoc, planPath };
}

/** Deterministic ticket validation, replacing the model repair gate: every
 * ticket must name work and carry checkable criteria (an open-ended craft
 * ticket is the one legitimate exception — its artifact is judged by looking
 * at it). Throws with the offending titles so a weak decomposition fails
 * loudly at plan time with an actionable message rather than silently
 * shipping a blank ticket. */
function assertTicketsUsable(tickets: PlanTicket[]): void {
  if (tickets.length === 0) {
    throw new Error("plan produced no tickets — the planner emitted no readable $TICKETS array");
  }
  const blank = tickets.filter((t) => !t.what?.trim());
  if (blank.length > 0) {
    throw new Error(`plan tickets missing a "what" body: ${blank.map((t) => `"${t.title}"`).join(", ")}`);
  }
  const uncriteried = tickets.filter((t) => t.open_ended !== true && !((t.criteria?.length ?? 0) > 0));
  if (uncriteried.length > 0) {
    throw new Error(`plan tickets missing acceptance criteria: ${uncriteried.map((t) => `"${t.title}"`).join(", ")}`);
  }
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
  /** Rounds actually run (<= maxRounds; can end earlier on the model's own $DONE or a stop). */
  rounds: number;
  exchanges: SharpenExchange[];
  /** True when the human ended the interview early (the asker returned null / a stop token).
   * Answers collected up to that point are kept and still feed the revision. */
  stopped: boolean;
  /** The append-only interview answer log, relative to cwd — written after every
   * answer so a provider failure or Ctrl-C cannot lose the Q&A. Null when the
   * interview never ran (`maxRounds <= 0`). */
  answersPath: string | null;
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
  /**
   * Collect the human's answer to one question. Return `null` to end the
   * interview NOW: the pending question is dropped, every earlier answer is
   * kept, and the session returns `stopped: true` so the caller still applies
   * the answers collected so far (a zero-answer stop skips like a zero-question
   * interview). The CLI maps its `:done` token / Ctrl-D to null; auto-answering
   * callers always return a string.
   */
  ask: (question: SharpenQuestion) => Promise<string | null>;
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
  ask: (question: SharpenQuestion) => Promise<string | null>;
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
  const answersPath = maxRounds > 0 ? interviewLogPath() : null;
  let round = 0;
  let stopped = false;
  let endReason: "done" | "stopped" | "max_rounds" | "incomplete" = "max_rounds";
  if (answersPath) {
    await appendInterviewLog(cwd, [{
      type: "session_start",
      at: new Date().toISOString(),
      mode: mode ?? "build",
      topic,
      maxRounds,
      target: depthTarget ?? null,
    }]);
  }
  try {
    while (round < maxRounds) {
      round++;
      console.log(`[sharpen] round ${round} of up to ${maxRounds} — ${exchanges.length} question(s) answered so far`);
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
      if (result.status !== "ok") {
        endReason = "incomplete"; // can't continue the interview; keep whatever was already resolved
        break;
      }

      const text = await extractAssistantText(sharpenLedger, phaseFile);
      const parsed = parseSharpenRound(text);

      if (parsed.terms.length) await appendContextTerms(cwd, parsed.terms);
      for (const adr of parsed.adrs) await writeGrillAdr(cwd, adr);

      if (parsed.done) {
        endReason = "done";
        break;
      }

      for (let i = 0; i < parsed.questions.length; i++) {
        const q = parsed.questions[i];
        onQuestion?.(q, renderQuestionForTerminal(q, i), i);
        const answer = await ask(q);
        if (answer === null) {
          stopped = true;
          endReason = "stopped";
          break;
        }
        exchanges.push({ question: q, answer });
        // Persist BEFORE the next model call: a provider failure mid-interview
        // must never cost an answer that was already given.
        if (answersPath) {
          await appendInterviewLog(cwd, [{ type: "answer", at: new Date().toISOString(), round, title: q.title, body: q.body, recommended: q.recommended, answer }]);
        }
      }
      if (stopped) break;
    }
  } catch (err) {
    if (answersPath) {
      // Best-effort: the phase failure is the error the caller must see, so a
      // failed log write here must not replace it.
      await appendInterviewLog(cwd, [{
        type: "session_end",
        at: new Date().toISOString(),
        reason: "failed",
        rounds: round,
        answers: exchanges.length,
        error: err instanceof Error ? err.message : String(err),
      }]).catch(() => {});
    }
    if (answersPath && err instanceof Error) {
      throw new Error(`${err.message} — interview answers so far are saved at ${answersPath}`, { cause: err });
    }
    throw err;
  }
  if (answersPath) {
    await appendInterviewLog(cwd, [{ type: "session_end", at: new Date().toISOString(), reason: endReason, rounds: round, answers: exchanges.length }]);
  }

  return { transcript: renderTranscriptForPlanner(exchanges), rounds: round, exchanges, stopped, answersPath };
}
