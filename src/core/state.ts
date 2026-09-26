import type { RailheadConfig, ResolvedModels, SeatName } from "../config/config.ts";
import type { PhaseContext } from "./telemetry.ts";
import type { ArcStepIdentity } from "./product.ts";

export const SCHEMA_VERSION = 1;

export type TicketStatus =
  | "ready"
  | "in_progress"
  | "committed"
  | "failed"
  | "skipped";

export type RunStatus = "running" | "finished" | "stopped" | "failed";

export interface ReviewVerdict {
  phase: string;
  attempt: number;
  blocking: boolean;
  findings: string[];
}

/** Issue #19: a record of one goal-review checkpoint. Persisted on the run
 * state so resume does not re-run a completed checkpoint, and later groups
 * see what earlier groups were flagged for. */
export interface GoalReviewRecord {
  /** The group label or synthetic checkpoint name that triggered the review. */
  group: string;
  /** Round within this checkpoint (0-indexed). */
  round: number;
  /** "pass", "fail", or "inconclusive". */
  verdict: string;
  /** Findings emitted by the goal reviewer. */
  findings: string[];
  /** ADR 0029 (#102): true for an advisory-only group checkpoint — findings
   * were recorded and steered, ZERO corrective tickets were generated, and
   * the run-end pass is where correction happens. The report counts these. */
  advisory?: boolean;
}

/** gh #107 (C.2): a record of one structural-review checkpoint. Persisted so
 * the structural gate's "already reviewed at this checkpoint" signal is its
 * own — decoupled from `goal_reviews`, which is goal's dedup record. Sharing
 * one reviewed-set coupled the two gates: a goal pass that recorded the group
 * first silently suppressed the structural gate. */
export interface StructuralReviewRecord {
  /** The group label or synthetic checkpoint name that triggered the review. */
  group: string;
  /** "pass", "fail", or "inconclusive". */
  verdict: string;
  /** Findings emitted by the structural reviewer. */
  findings: string[];
}

/** One builder-session restart (a fresh-session-from-last-commit recovery),
 * recorded so the report can name restarts with their cause (ADR 0022 §5). */
export interface BuilderRestart {
  at: string;
  cause: string;
}

/** ADR 0022 / issue #84 (stage 3): the durable-session builder's own ledger
 * fields on the run state. The session handle is what `railhead resume`
 * re-attaches by id; `last_green_commit` is what a fresh-session recovery
 * seeds from when the session is gone (storage cleared, new machine, drift).
 * Absent in runs that never enabled the session builder. */
export interface BuilderState {
  /** The opencode session id of the current builder session, persisted at the
   * end of every builder invocation (captured from the event stream). */
  session_id?: string;
  /** The git commit the last green gate produced — the recovery seed point. */
  last_green_commit?: string;
  /** The ticket number the last green gate committed through. */
  committed_through?: string;
  /** Checkpoint markers observed so far (each = one interleaved gate cycle). */
  checkpoint_count: number;
  /** Every fresh-session recovery with its cause, oldest first. */
  restarts: BuilderRestart[];
  /** Issue #106-A: whether the session compacted since it was last handed the
   * full context blocks (contracts index / learnings / digest). A warm advance
   * prompt that sees this true must RE-INJECT the full blocks (the session's
   * earlier copy was summarized away by the compaction); a session that has not
   * compacted still holds them, so its advance carries standing pointers
   * instead. RE-DERIVED (not cleared at injection time) at every green ticket
   * commit from that ticket's merged build-phase telemetry: a compaction during
   * the window sets it true, a non-compacting window overwrites it false.
   * Absent (pre-#106 runs) means "not observed yet" → the next advance sends
   * pointers (the seed, which always injects full blocks, already ran on any
   * live session). */
  needs_full_context?: boolean;
}

export function newBuilderState(): BuilderState {
  return { checkpoint_count: 0, restarts: [] };
}

export interface TicketState {
  file: string;
  title: string;
  number: string;
  status: TicketStatus;
  attempts: number;
  start_commit: string | null;
  commit: string | null;
  verify_ok: boolean | null;
  /** Whether the review ultimately passed (null until a review runs). */
  review_ok: boolean | null;
  /** Number of blocking reviews this ticket went through before passing. */
  review_attempts: number;
  /** Total elapsed seconds across this ticket's implement/review phases. */
  duration_ms: number;
  /** Every review verdict for this ticket, in order, for the history. */
  reviews: ReviewVerdict[];
  /** Context-window usage of the last successful implement phase. */
  context?: PhaseContext;
  /** Issue #19: group label for checkpoint-level goal review. Copied from the
   * parsed Ticket at load time so the run loop can detect group boundaries
   * without re-parsing ticket files. */
  group?: string;
  logs: string[];
  /** Issue #80: the failure-ladder rung reached on the last implement attempt
   * (1/2/3). Persisted so a resume starts at that rung instead of replaying
   * rung 1 forever on a deterministic failure. Reset on phase success. */
  ladder_rung?: number;
  /** Issue #80: the ladder class of the last implement failure (fatal-config /
   * capacity / server-state / blip / diagnosed). Persisted for resume + report. */
  last_failure_class?: string;
  /** gh #105 / ADR 0032: the one spec-anchored reconciliation spent on this
   * ticket — the fresh arbiter's verdict, its findings, and the files whose
   * railhead-applied fixes were recorded. Bounded to exactly one reconciliation
   * per ticket per run; persisted by writeState so a resume never re-spends
   * it. `undefined` = not yet spent. */
  reconcile?: {
    verdict: "impl" | "test" | "inconclusive";
    findings: string[];
    applied: string[];
  } | null;
  /** ADR 0040: acceptance criteria the builder could not verify with its own
   * tools (a `$BLOCKED kind=verification-unavailable`). Recorded at commit —
   * the work passed verify/review, but these ride into the next goal/visual
   * checkpoint as explicit must-check items (and the run report) so a run is
   * never reported as fully verified while they stand. */
  unverified?: string[];
  /** ADR 0040: cumulative builder wall-clock/steps across every invocation
   * for this ticket (ladder rungs, resumes, blocks). The per-invocation
   * `max_phase_steps` resets per process; these do not, and are checked
   * against the plan-scaled per-ticket budget. */
  build_ms_total?: number;
  build_steps_total?: number;
  /** ADR 0040 (amended): builder wall-clock since the last green verify. The
   * wall budget exists to bound thrash, and thrash by definition produces
   * nothing green — a verify-passing round is externally validated progress,
   * so it restarts this clock while `build_steps_total` stays cumulative.
   * Undefined until the first invocation lands; the budget check falls back
   * to `build_ms_total`, which is identical up to that point. */
  build_ms_since_checkpoint?: number;
  /** ADR 0040 (amended): the slowest single builder invocation's wall ms.
   * The derived wall budget scales from it (see WALL_BUDGET_INVOCATION_MULTIPLE
   * in run.ts) so a slow model's legitimate work self-calibrates the bound —
   * the plan phase's wall cannot (planning and building differ by an order of
   * magnitude in wall-per-unit-work), and a fixed floor sized for fast cloud
   * models is smaller than one healthy invocation on a slow local model. */
  build_ms_max_invocation?: number;
  /** ADR 0040: every terminal `$BLOCKED` report this ticket produced, in
   * order — the reason is surfaced in the report and a second
   * implementation-stuck block fails the ticket. */
  blocks?: { kind: string; reason: string; at: string }[];
}

/** One materialized behavior probe (v2 issue 01, ADR 0043/0044): the goal
 * review records a finding's deterministic re-check so a later round can run
 * it instead of re-deriving and re-probing the same blocker by hand. The
 * `command` is a shell command (a materialized script under
 * `.railhead/probes/`) whose output contains `expect` IFF the behavior holds. */
export interface ProbeEntry {
  /** Stable id (`p1`, `p2`, …) — also the script file's stem. */
  id: string;
  /** The group/checkpoint label that owns the probe. */
  group: string;
  /** The behavior/finding the probe proves. */
  behavior: string;
  /** The shell command, runnable from the repo root. */
  command: string;
  /** The predicate: this substring appears in the command's output when the
   * behavior holds. */
  expect: string;
  created_at: string;
}

export interface RunState {
  schema_version: number;
  cwd: string;
  branch: string;
  status: RunStatus;
  tickets_dir: string;
  /** The directory (relative to `cwd`, or absolute when the tickets dir was)
   * the run's plan docs (design.md, architecture.md) live in. Build/fix runs
   * use the repo-root `docs/`; feature runs (ADR 0051) use their plan namespace
   * under `.scratch/<slug>/docs` — a feature run's builder, reviewers, and
   * gates must never be pointed at a stale project-root plan. Absent on
   * legacy state files: normalization defaults it to `docs`. */
  docs_dir: string;
  /** ADR 0051: the product-arc roadmap step this run builds (feature runs
   * only). Lets run-end/resume mark the step `built` and lets the goal
   * reviewer judge the step; absent on build/fix runs and legacy state. */
  arc_step?: ArcStepIdentity;
  config: RailheadConfig;
  pause_on_failure: boolean;
  verbose: boolean;
  quiet: boolean;
  tickets: TicketState[];
  started_at: string;
  updated_at: string;
  /** ADR 0044: the committed-ticket count at the last goal checkpoint, the
   * baseline the goal gate's cadence ceiling measures from. Persisted so a
   * long group cannot delay feedback past `fallback_cadence` commits, and a
   * resume keeps the same baseline. */
  last_goal_commit_count?: number;
  /** Visual final review (ADR 0009): rounds completed so far; -1 = never run / disabled. */
  visual_rounds?: number;
  /** Findings from the last visual review round; persisted for resume + report. */
  visual_findings?: string[];
  /** True iff the last visual review round passed. Null until a round completes. */
  visual_ok?: boolean | null;
  /** Issue #19: the original user prompt/goal, stored so the goal reviewer
   * can evaluate against it at group checkpoints. Set by `startRun`. */
  original_prompt?: string;
  /** Issue #19: records of goal-review checkpoints completed so far. Prevents
   * re-reviewing an already-reviewed group on resume and lets later groups
   * see what was flagged before. */
  goal_reviews?: GoalReviewRecord[];
  /** gh #107 (C.2): records of structural-review checkpoints completed so far.
   * The structural gate's own dedup signal — never goal's `goal_reviews`. */
  structural_reviews?: StructuralReviewRecord[];
  /** gh #111: the reason an agent-initiated halt (`.railhead/STOP`) carried,
   * recorded when the run stopped on it. Surfaces in report.md and is what
   * `railhead resume` re-reads (via the file itself) before refusing. Absent
   * for runs that never halted. */
  halt_reason?: string | null;
  /** gh: graceful stop — why the run last stopped, when the operator asked
   * (soft stop at a ticket boundary, or a hard Ctrl-C). Surfaced in
   * report.md; absent for crash/SIGKILL stops, which write nothing. */
  stop_reason?: string | null;
  /** gh: resume-owed marker for the per-ticket visual review (ADR 0011). The
   * in-memory promise cannot be persisted, so the ticket file is recorded when
   * the review is kicked off for a committed ticket and cleared when it is
   * joined; if the run stops in between, resume re-runs the review instead of
   * silently skipping that gate. `null`/absent = nothing owed. */
  visual_pending?: string | null;
  /** gh: resume-owed markers for mid-run group checkpoint gates (goal and
   * structural keep their own sets, mirroring their separate records). A group
   * is recorded before its review agent is spawned and cleared when the gate
   * returns; if the run stops in the post-commit window, resume replays the
   * checkpoint instead of skipping it. The gate's own record
   * (`goal_reviews`/`structural_reviews`) stays the authoritative dedup. */
  pending_checkpoints?: { goal: string[]; structural: string[] };
  /** gh #116: how many goal-review replans (`$REPLAN` frontier regenerations)
   * this run has honored so far. Enforced against `goal_review.max_replans`;
   * absent until the first replan fires. */
  replan_count?: number;
  /** v2 issue 01: the persistent probe registry. The goal review materializes
   * one probe per concrete finding (a command + expected predicate) so a later
   * round re-runs it deterministically instead of re-deriving the same
   * blockers. Persisted in `state.json`; the scripts live under
   * `.railhead/probes/`. Absent/empty for runs without goal findings. */
  probes?: ProbeEntry[];
  /** Issue #84 (ADR 0022 stage 3): the durable-session builder's ledger — the
   * session id to re-attach on resume and the commit a fresh-session recovery
   * seeds from. */
  builder?: BuilderState;
  /** Issue #133: the run's base session — the `[system][preamble]` prefix
   * every fresh phase forks (`--session <id> --fork`) so its task message
   * appends to a shared, cacheable prefix instead of re-prefilling one.
   * Persisted so a resume reuses the same conversation; `preamble_hash` is
   * the rebuild trigger (the canonical preamble's inputs changed). Absent or
   * null = no base: creation failed, the provider cannot fork, or the run
   * predates the base protocol — phases run the ADR 0001 joined-prompt path. */
  base_session?: {
    session_id: string;
    preamble_hash: string;
    created_at: string;
  } | null;
  /** Issue #35: a per-ticket visual review kicked off asynchronously after
   * ticket N commits, joined before ticket N+1 commits. Not persisted (a
   * promise is not serializable); the persisted `visual_pending` marker names
   * the same review, so a stop in between makes resume re-run it. Underscored
   * to mark it as a runtime-only field excluded from writeState's JSON. */
  _pending_visual_review?: Promise<unknown>;
  /** Resolved per-phase models (after fallback chains). Runtime-only —
   * not persisted (derived from `config` + flags at startRun). Underscored
   * to mark it as excluded from writeState's JSON. */
  _models?: ResolvedModels;
  /** Effective context-token budget, clamped to the model's actual context
   * window as reported by `opencode models --verbose`. Runtime-only — not
   * persisted (derived at startRun). Underscored to mark it as excluded
   * from writeState's JSON. */
  _effectiveContextTokens?: number;
  /** ADR 0014 amendment: per-seat request ceilings resolved at run start from
   * each seat's own model window (the operator ceiling governs the implement
   * seat). Runtime-only, not persisted; absent means fall back to
   * `_effectiveContextTokens`. */
  _seatContextTokens?: Partial<Record<SeatName, number>>;
}

export interface RunMeta {
  cwd: string;
  branch: string;
  tickets_dir: string;
  /** The run's plan-docs directory; resolved by startRun (feature runs point
   * at their ticket store's sibling docs). Optional — defaults to `docs`. */
  docs_dir?: string;
  /** ADR 0051: the arc step this run builds; read from the plan's origin.json
   * by startRun. Optional — build/fix runs have none. */
  arc_step?: ArcStepIdentity;
  config: RailheadConfig;
  pause_on_failure: boolean;
  verbose: boolean;
  quiet: boolean;
  /** Issue #19: the original user prompt/goal, so the goal reviewer can
   * evaluate against it at group checkpoints. Set by `startRun`. */
  original_prompt?: string;
}

export function createRunState(meta: RunMeta): RunState {
  return {
    schema_version: SCHEMA_VERSION,
    cwd: meta.cwd,
    branch: meta.branch,
    status: "running",
    tickets_dir: meta.tickets_dir,
    docs_dir: meta.docs_dir ?? "docs",
    arc_step: meta.arc_step,
    config: meta.config,
    pause_on_failure: meta.pause_on_failure,
    verbose: meta.verbose,
    quiet: meta.quiet,
    tickets: [],
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    visual_rounds: -1,
    visual_findings: [],
    visual_ok: null,
    goal_reviews: [],
    structural_reviews: [],
    visual_pending: null,
    pending_checkpoints: { goal: [], structural: [] },
    original_prompt: meta.original_prompt,
    builder: newBuilderState(),
  };
}

export function findTicket(
  state: RunState,
  file: string,
): TicketState | undefined {
  return state.tickets.find((t) => t.file === file);
}

/** The next ticket to run: the first `ready` ticket in plan order. Execution
 * is strictly sequential — array order IS the execution order, and correctives
 * are inserted immediately before the remaining planned frontier. Returns an
 * empty array only when nothing is ready (the run loop then terminates). */
export function frontier(state: RunState): TicketState[] {
  const next = state.tickets.find((t) => t.status === "ready");
  return next ? [next] : [];
}

export const isFinished = (s: RunStatus) =>
  s === "finished" || s === "stopped" || s === "failed";