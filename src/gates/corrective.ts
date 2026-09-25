import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState, TicketState } from "../core/state.ts";
import { appendEvent, writeState } from "../core/ledger.ts";
import { numberTickets, renderTicket, toTicketState, type PlanTicket } from "../core/ticket.ts";
import { classifySeverity, promoteUnlabelledSeverity, reviewSummary, stripSeverityLabel, truncateFindingBody } from "./reviewer.ts";
import { nowClock } from "../cli/overview.ts";

/**
 * The corrective-ticket pipeline (issue #88). A review gate (visual, goal,
 * structural) that FAILs with [BLOCKER] findings generates corrective tickets,
 * writes them as numbered ticket files continuing the run's sequence,
 * optionally blocks every remaining uncommitted ticket on them, re-scans the
 * extended set under the plan gate's policy, and runs each corrective through
 * the implement→verify→review→commit pipeline inline — stopping on the first
 * failure. This used to be hand-copied at four sites in run.ts, drifting
 * every time a policy landed in one copy (the #63 inter-corrective cycle
 * guard). One copy now lives here.
 *
 * Console phrasing is per-kind; the generated ticket bodies preserve each
 * gate's original wording verbatim (per-kind data below).
 */

export type CorrectiveKind = "visual" | "goal" | "structural";

export type CorrectiveOutcome = "none" | "committed" | "failed" | "halted";

/** The run seam's processTicket, as injected into corrective-driven flows so
 * modules never import run.ts (which would cycle back). */
export type RunTicket = (state: RunState, ledger: string, ticket: TicketState) => Promise<"ok" | "failed" | "halted">;

export interface ProcessCorrectiveOptions {
  kind: CorrectiveKind;
  /** Progress-line label (e.g. "visual review", `goal review (checkpoint "core")`). */
  label: string;
  /** run.ts's processTicket, injected so this module never imports run.ts
   *  (which imports this module) and stays testable through a stub runner. */
  runTicket: RunTicket;
  /** Reviewer-suggested tickets (the goal review's $CORRECTIVE block) used
   *  instead of the mechanical one-ticket-per-finding split. */
  suggested?: PlanTicket[];
  /** Runs after blockers are confirmed but before corrective tickets are
   *  written. Returning true supersedes the corrective tickets entirely (the
   *  caller replanned the frontier) — the pipeline reports "none". */
  beforeCorrectives?: () => Promise<boolean>;
}

const isBlockerFinding = (f: string) => classifySeverity(f) === "blocker";

/** Per-kind corrective ticket templates. The strings are the original
 *  generator wordings verbatim (visual.ts / goal-review.ts / structural-review.ts)
 *  so corrective ticket contents cannot drift between the gates. */
interface CorrectiveSpec {
  noun: "corrective" | "refactor";
  titlePrefix: string;
  intro: string;
  outro: string;
  majorIntro: string;
  screenshots: { re: RegExp; header: string; fallback: string } | null;
  criteria: string[] | ((body: string) => string[]);
  truncate: (body: string) => string;
}

const CORRECTIVE_SPECS: Record<CorrectiveKind, CorrectiveSpec> = {
  visual: {
    noun: "corrective",
    titlePrefix: "Fix visual review finding: ",
    intro: "The visual reviewer found this BLOCKER when running the integrated app:\n\n",
    outro: "\n\nReproduce it by running the app, then make a targeted fix. The app already builds and passes verify — this is a runtime/visual defect, not a compilation gap.",
    majorIntro: "Also be aware of these non-blocking issues (fix if easy, do not block on them):",
    screenshots: {
      re: /\.railhead\/visual\/[^\s)]+\.png/g,
      header: "\n\nScreenshots showing the defect (read these if your model is vision-capable):",
      fallback: "\n\nAll screenshots from the visual review are under .railhead/visual/ — read them to see exactly what the reviewer saw.",
    },
    criteria: [
      "Run the app and confirm the finding no longer reproduces",
      "Existing verify commands still pass",
    ],
    truncate: (body) => truncateFindingBody(body, 500, "\n\n(full finding is in the run's visual_findings — run `railhead log` to see the complete review transcript)"),
  },
  goal: {
    noun: "corrective",
    titlePrefix: "Goal review fix: ",
    intro: "The goal reviewer found this quality gap when evaluating the build against the original goal at a group checkpoint:\n\n",
    outro: "\n\nThe app already builds and passes verify — this is a quality gap against the goal, not a compilation or correctness bug. Make a targeted fix that closes the gap, then verify the app still builds.\n\nReference: check docs/design.md for the planner's intended vision and docs/coherence.md for the coherence charter (the normative visual contract) if they exist. When a charter revision and this finding conflict, the charter wins — it is the judge's later knowledge, already amended before this ticket was generated.",
    majorIntro: "Also be aware of these non-blocking quality gaps (fix if easy, do not block on them):",
    screenshots: {
      re: /\.railhead\/[^\s)]+\.png/g,
      header: "\n\nScreenshots showing the gap (read these if your model is vision-capable):",
      fallback: "",
    },
    criteria: [
      "Run the app and confirm the quality gap is addressed",
      "Existing verify commands still pass",
    ],
    truncate: (body) => truncateFindingBody(body, 500, "\n\n(full finding is in the run's goal_review findings — run `railhead log` to see the complete review transcript)"),
  },
  structural: {
    noun: "refactor",
    titlePrefix: "Structural refactor: ",
    intro: "The structural reviewer found this architectural drift when evaluating the accumulated source against docs/architecture.md:\n\n",
    outro: "\n\nThis is a structural refactor, not a behavior fix — the app builds and passes verify, but the codebase has drift that will compound if left unfixed. Make a targeted refactor that addresses the structural smell, then verify the app still builds and tests pass.\n\nReference: check docs/architecture.md for the planner's intended structure if it exists.",
    majorIntro: "Also be aware of these non-blocking structural concerns (fix if easy, do not block on them):",
    screenshots: null,
    criteria: (body) => [
      `The structural smell is resolved: ${body.slice(0, 100)}`,
      "Existing verify commands still pass",
      "No new duplicated abstractions introduced",
    ],
    truncate: (body) => truncateFindingBody(body, 300, "…"),
  },
};

/**
 * Generate corrective tickets from a failed review gate's findings. Each
 * [BLOCKER] finding becomes its own ticket so the implementer can target it in
 * isolation; [MAJOR] findings ride along as advisory context, matching the
 * per-ticket soft-pass rule (ADR 0005). Returns [] when there is nothing to
 * fix (no [BLOCKER] findings).
 */
export function generateCorrectiveTickets(
  kind: CorrectiveKind,
  findings: string[],
): PlanTicket[] {
  const spec = CORRECTIVE_SPECS[kind];
  const blockers = findings.filter(isBlockerFinding);
  if (blockers.length === 0) return [];
  const majors = findings.filter((f) => classifySeverity(f) === "major");
  const majorContext = majors.length
    ? `\n\n${spec.majorIntro}\n${majors.join("\n")}`
    : "";
  return blockers.map((finding) => {
    const body = spec.truncate(stripSeverityLabel(finding));
    const screenshotBlock = spec.screenshots
      ? (() => {
          const paths = [...body.matchAll(spec.screenshots.re)].map((m) => m[0]);
          if (paths.length === 0) return spec.screenshots.fallback;
          return `${spec.screenshots.header}\n${paths.map((p) => `- ${p}`).join("\n")}`;
        })()
      : "";
    const criteria = typeof spec.criteria === "function" ? spec.criteria(body) : spec.criteria;
    return {
      title: `${spec.titlePrefix}${body.slice(0, 60)}`,
      what: `${spec.intro}${body}${spec.outro}${screenshotBlock}${majorContext}`,
      criteria,
    };
  });
}

/** Write corrective PlanTickets to disk + return their TicketState entries. */
async function writeCorrectiveTickets(
  state: RunState,
  planTickets: PlanTicket[],
): Promise<TicketState[]> {
  const tickets = numberTickets(planTickets, nextTicketNumber(state));
  // Write corrective ticket files WITHOUT clearing the existing planned
  // tickets — writeTickets would purge the dir (it clears stale .md files
  // before writing, which is correct at plan time but catastrophic mid-run:
  // it would delete the remaining planned tickets). Append-only here.
  await mkdir(state.tickets_dir, { recursive: true });
  for (const t of tickets) {
    await writeFile(join(state.tickets_dir, t.file), renderTicket(t), "utf8");
  }
  return tickets.map((t) => toTicketState(t));
}

/** The next available 2-digit ticket number, continuing the existing sequence. */
export function nextTicketNumber(state: RunState): number {
  const max = state.tickets.reduce((m, t) => {
    const n = parseInt(t.number, 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return max + 1;
}

/**
 * The corrective-ticket seam every review gate funnels through. Given a FAIL
 * verdict's findings, it filters the [BLOCKER]s, generates corrective tickets
 * (or uses the reviewer's $CORRECTIVE suggestions), writes the ticket files
 * INSIDE the remaining frontier (before the first uncommitted planned ticket,
 * so a resume picks them up before continuing the plan), registers them in
 * state, and runs each through the injected runTicket — stopping on the first
 * failure.
 *
 * Returns:
 *   - "none" — the beforeCorrectives hook replanned, OR no [BLOCKER] findings
 *     (the hook runs first, so a blocker-less $REPLAN still fires); the caller
 *     soft-passes.
 *   - "committed" — every corrective ticket ran successfully.
 *   - "failed" — a corrective ticket failed; the caller stops the gate.
 */
export async function processCorrectiveFindings(
  state: RunState,
  ledger: string,
  findings: string[],
  options: ProcessCorrectiveOptions,
): Promise<CorrectiveOutcome> {
  // gh #116: run the beforeCorrectives hook (the $REPLAN seat) BEFORE the
  // blocker short-circuit — a blocker-less FAIL whose findings are all
  // MAJOR/LOW can still carry a plan-level $REPLAN that must fire. The
  // "plan under-scoped the goal, every individual gap is minor" shape is
  // exactly the one that most needs a replan.
  if (options.beforeCorrectives && await options.beforeCorrectives()) return "none";
  // Issue #119: fail-loud, don't fail-silent — a $FAIL that names blocker/major
  // in a shape classifySeverity still can't read must not collapse to a clean
  // "no [BLOCKER]" soft-pass. Promote those findings to [BLOCKER] (logged) so
  // the seat generates corrective tickets instead of soft-passing.
  const effectiveFindings = promoteUnlabelledSeverity(findings);
  if (effectiveFindings !== findings) {
    const promoted = effectiveFindings.filter((f, i) => f !== findings[i]).length;
    console.warn(`[${nowClock()}] ${options.label}: ⚠ FAIL names blocker/major but no finding carries a recognized [BLOCKER]/[MAJOR] label — treating ${promoted} finding(s) as blocking instead of soft-passing`);
  }
  const blockers = effectiveFindings.filter(isBlockerFinding);
  if (blockers.length === 0) return "none";

  const spec = CORRECTIVE_SPECS[options.kind];
  const suggested = options.suggested && options.suggested.length > 0 ? options.suggested : null;
  const plan = suggested ?? generateCorrectiveTickets(options.kind, effectiveFindings);
  if (plan.length === 0) return "none";

  if (suggested) {
    console.log(`[${nowClock()}] ${options.label}: using reviewer's ${plan.length} $CORRECTIVE ticket suggestion(s) instead of the mechanical split`);
  }
  console.log(`[${nowClock()}] ${options.label}: ⛔ FAIL ${reviewSummary(effectiveFindings)} — generating ${plan.length} ${spec.noun} ticket(s)`);

  const written = await writeCorrectiveTickets(state, plan);

  // Correctives run inline immediately, but a crash mid-corrective must not
  // let the run resume past them: insert them BEFORE the remaining planned
  // frontier so the next ready ticket is the corrective.
  const insertAt = state.tickets.findIndex((t) => t.status === "ready" || t.status === "in_progress");
  const at = insertAt === -1 ? state.tickets.length : insertAt;
  state.tickets.splice(at, 0, ...written);
  await writeState(ledger, state);

  for (const ts of written) {
    const outcome = await options.runTicket(state, ledger, ts);
    if (outcome === "halted") {
      console.log(`[${nowClock()}] ${options.label}: halted by an agent-initiated stop signal; stopping`);
      return "halted";
    }
    if (outcome === "failed") {
      console.log(`[${nowClock()}] ${options.label}: ${spec.noun} ticket ${ts.number} failed; stopping`);
      return "failed";
    }
  }
  return "committed";
}
