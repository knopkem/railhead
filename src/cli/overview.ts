import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONTEXT_TOKENS } from "../config/config.ts";
import { frontier } from "../core/state.ts";
import type { RunState, TicketState } from "../core/state.ts";
import { loadTickets } from "../core/ticket.ts";
import { touchesVisualSurface } from "../context/surface.ts";
import { detectGameCanvas } from "../core/project-assets.ts";
import { collectCacheStats, type RunCacheStats } from "../core/telemetry.ts";

const STATUS_SYM: Record<string, string> = {
  ready: "○",
  in_progress: "▶",
  committed: "✓",
  failed: "✗",
  skipped: "·",
};

export function renderStatusTable(state: RunState): string {
  const header = `${state.status.toUpperCase()} — ${state.tickets.filter((t) => t.status === "committed").length}/${state.tickets.length} committed`;
  const body = state.tickets
    .map((t) => {
      const att = t.attempts ? ` (${t.attempts})` : "";
      const v = t.verify_ok === null ? "" : t.verify_ok ? " ✓" : " ✗";
      const commit = t.commit ? `  ${t.commit.slice(0, 8)}` : "";
      const dur = t.duration_ms ? `  ${(t.duration_ms / 1000).toFixed(0)}s` : "";
      return `  ${STATUS_SYM[t.status] ?? "?"} ${t.number} ${t.title}${att}${v}${commit}${dur}`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

/** Issue #99 (ADR 0028): the report's per-run charter facts — whether a
 * coherence charter was authored at plan time and which tickets the recall-
 * biased surface gate classified as surface (the gate's observability, and
 * the input for the Decisions-3 escalation if it misclassifies). */
export interface CharterReportInfo {
  /** True when docs/coherence.md exists in the project. */
  coherenceAuthored: boolean;
  /** Ticket numbers the gate classified as surface, in load order. */
  surfaceTickets: string[];
  /** Issue #97: the run's interaction-interface fact for the report — the
   * declared value, the canvas auto-detect fallback (for undeclared canvas
   * projects, which keep today's behavior), or null when undeclared and not
   * canvas-inferred (the undeclared case gets a one-line declare nudge). */
  interactionInterface: string | null;
}

export function buildReport(state: RunState, charterInfo?: CharterReportInfo, cacheStats?: RunCacheStats): string {
  const lines: string[] = [];
  lines.push(`# Railhead Run Report`);
  lines.push(``);
  lines.push(`- Run: \`${state.branch}\``);
  lines.push(`- Status: ${state.status}`);
  // gh #111: surface the agent-initiated halt reason — the honest-stop record
  // that a human must see before resuming (the file itself is the resume gate).
  if (state.halt_reason) {
    lines.push(`- Halt: ${state.halt_reason}`);
  }
  // gh: graceful stop — name why an operator-initiated stop landed where it
  // did; a hard Ctrl-C and a soft ticket-boundary stop read very differently
  // when deciding whether a resume can proceed safely.
  if (state.stop_reason) {
    lines.push(`- Stop: ${state.stop_reason}`);
  }
  lines.push(`- Started: ${state.started_at}`);
  lines.push(`- Updated: ${state.updated_at}`);
  lines.push(`- Total time: ${elapsedLabel(state.started_at, state.updated_at)}`);
  lines.push(`- Context budget: ${state.config.max_context_tokens ? `${(state.config.max_context_tokens / 1000).toFixed(0)}k` : `unset (fallback ~${Math.floor(DEFAULT_CONTEXT_TOKENS / 1000)}k)`}`);
  lines.push(`- Committed: ${state.tickets.filter((t) => t.status === "committed").length}/${state.tickets.length}`);
  const ticketsWithCtx = state.tickets.filter((t) => t.context);
  if (ticketsWithCtx.length) {
    const totalOutput = ticketsWithCtx.reduce((s, t) => s + (t.context!.totalOutputTokens ?? 0), 0);
    const decodeOutput = ticketsWithCtx.reduce((s, t) => s + (t.context!.decodeOutputTokens ?? 0), 0);
    const totalGenMs = ticketsWithCtx.reduce((s, t) => s + (t.context!.generationMs ?? 0), 0);
    const totalWallMs = ticketsWithCtx.reduce((s, t) => s + (t.context!.wallMs ?? 0), 0);
    if (decodeOutput > 0 && totalGenMs > 0) {
      const e2eBit = totalOutput > 0 && totalWallMs > 0 ? ` · e2e ${((totalOutput / totalWallMs) * 1000).toFixed(1)} tok/s incl. prefill` : "";
      lines.push(`- Avg decode: ${Math.round((decodeOutput / totalGenMs) * 1000)} tok/s across ${ticketsWithCtx.length} ticket${ticketsWithCtx.length > 1 ? "s" : ""} (${k(decodeOutput)} output tokens in ${(totalGenMs / 1000).toFixed(0)}s decode)${e2eBit}`);
    }
  }
  // Issue #130: the run's prompt-cache hit ratio over first steps. This is the
  // signal that separates "the model is slow" from "the prompt prefix is not
  // being restored" — the snake run prefilled 8–33k tokens per fresh phase at
  // cache=0 while every report looked throughput-normal.
  if (cacheStats && cacheStats.cold + cacheStats.cached > 0) {
    const promptTotal = cacheStats.cold + cacheStats.cached;
    const pct = Math.round((cacheStats.cached / promptTotal) * 100);
    lines.push(`- Prompt cache (#130): ${kc(cacheStats.cached)}/${kc(promptTotal)} first-step input tokens reused (${pct}%)`);
  }
  const codeMode = state.config.code_review?.mode ?? "light";
  const visualMode = state.config.visual_review?.mode ?? "off";
  const goalMode = state.config.goal_review?.mode ?? "off";
  const structuralMode = state.config.structural_review?.mode ?? "off";
  lines.push(`- Gate modes (issue #73): code=${codeMode} visual=${visualMode} goal=${goalMode} structural=${structuralMode}`);
  if (charterInfo) {
    lines.push(`- Coherence charter (ADR 0028): ${charterInfo.coherenceAuthored ? "authored (docs/coherence.md)" : "not authored"}`);
    lines.push(`- Surface tickets (coherence/visual gate): ${charterInfo.surfaceTickets.length ? charterInfo.surfaceTickets.join(", ") : "none"}`);
    // Issue #97: declared interface is the lever that widens the whole-app
    // evidence gate. When undeclared AND not canvas-inferred, the run gets a
    // one-line nudge instead of silently shipping the #97 hole.
    lines.push(`- Interaction interface (#97): ${charterInfo.interactionInterface ?? "undeclared — add \"interface\": \"browser-ui\" | \"canvas\" | \"terminal\" | \"none\" to railhead.json to enforce real-input review evidence"}`);
  }
  // Issue #95 stage 4: the durable-session builder's own telemetry — how many
  // checkpoints the session produced, where it stands, and every fresh-session
  // restart with its cause (ADR 0022 §5). Present only when the run opted in.
  if (state.builder) {
    lines.push(`- Session builder (ADR 0022): granularity=${state.config.checkpoint_granularity ?? "product"} checkpoints=${state.builder.checkpoint_count} committed_through=${state.builder.committed_through ?? "—"} session=${state.builder.session_id ? state.builder.session_id.slice(0, 12) : "—"} restarts=${state.builder.restarts.length}`);
  }
  const allRulings = [...(state.plan_rulings ?? []), ...(state.rulings ?? [])];
  if (allRulings.length > 0) {
    lines.push(`- Rulings (issue #86): ${allRulings.length} (${(state.plan_rulings ?? []).length} plan, ${(state.rulings ?? []).length} runtime)`);
  }
  if (visualMode !== "off") {
    const rounds = state.visual_rounds ?? -1;
    const verdict = state.visual_ok === null
      ? (rounds >= 0 ? "INCONCLUSIVE (agent ran but produced no verdict — manual visual inspection required)" : "not run")
      : state.visual_ok ? "PASS" : "FAIL";
    lines.push(`- Visual review: ${verdict}${rounds >= 0 ? ` (round ${rounds})` : ""}`);
    if (state.visual_findings && state.visual_findings.length > 0) {
      lines.push(`- Visual findings: ${state.visual_findings.length}`);
    }
  }
  lines.push(``);

  const unresolved = state.tickets
    .filter((t) => t.reviews.some((rv) => rv.blocking && t.status !== "committed"))
    .length;
  const totalFindings = state.tickets.reduce(
    (sum, t) => sum + t.reviews.reduce((s, rv) => s + rv.findings.length, 0),
    0,
  );
  if (totalFindings > 0) {
    lines.push(`## Review summary`);
    lines.push(``);
    lines.push(`- Total review findings raised: ${totalFindings}`);
    lines.push(`- Tickets with open (uncommitted) blocking findings: ${unresolved}`);
    lines.push(``);
    for (const t of state.tickets) {
      const blockingRvs = t.reviews.filter((rv) => rv.blocking);
      if (!blockingRvs.length) continue;
      lines.push(`### ${t.number} ${t.title} — ${blockingRvs.length} blocking review(s)`);
      for (const rv of blockingRvs) {
        for (const f of rv.findings) lines.push(`- ${f}`);
      }
      lines.push(``);
    }
    lines.push(`## Tickets`);
    lines.push(``);
  } else {
    lines.push(`## Tickets`);
    lines.push(``);
  }
  for (const t of state.tickets) {
    const att = t.attempts ? ` (${t.attempts} attempts)` : "";
    const commit = t.commit ?? "—";
    lines.push(`### ${t.number} ${t.title} — ${t.status}${att}`);
    lines.push(``);
    lines.push(`- Commit: ${commit}`);
    lines.push(`- Time: ${t.duration_ms ? `${(t.duration_ms / 1000).toFixed(0)}s` : "—"}`);
    lines.push(`- Verify: ${t.verify_ok === null ? "n/a" : t.verify_ok ? "pass" : "fail"}`);
    lines.push(
      `- Review: ${t.review_ok === null ? "n/a" : t.review_ok ? "pass" : "blocking"}${t.review_attempts ? ` (passed on review ${t.review_attempts})` : ""}`,
    );
    if (t.last_failure_class) {
      lines.push(`- Failure ladder: ${t.last_failure_class}${t.ladder_rung ? ` (rung ${t.ladder_rung})` : ""}`);
    }
    if (t.diagnosis) {
      lines.push(`- Diagnosis: ${t.diagnosis.text}${t.diagnosis.plan_spent ? " (plan spent on a guided attempt)" : ""}`);
    }
    if (t.reviews.length) {
      for (const rv of t.reviews) {
        const verdict = rv.blocking ? `blocking (${rv.findings.length} must-fix)` : "pass";
        lines.push(`  - ${rv.phase}: ${verdict}`);
      }
    }
    if (t.context) {
      lines.push(
        `- Context: peak ${k(t.context.peakInputTokens)} | final ${k(t.context.finalInputTokens)} | compactions ${t.context.compactions}`,
      );
      if (t.context.compactions > 0) {
        const builder = state.config.session_builder === true;
        lines.push(
          builder
            ? `- Compactions: ${t.context.compactions} (expected — the durable-session builder's context manager; see ADR 0022)`
            : `- ⚠ ${t.context.compactions} compaction${t.context.compactions > 1 ? "s" : ""} — the budget may be mis-set or the model over-read; check the per-model context window in opencode.json and the max_context_tokens in railhead.json.`,
        );
      }
      if (t.context.outputTokensPerSec > 0) {
        const e2e = t.context.endToEndTokensPerSec > 0 ? ` · e2e ${t.context.endToEndTokensPerSec} tok/s incl. prefill` : "";
        lines.push(`- Throughput: ${t.context.outputTokensPerSec} tok/s decode (${k(t.context.decodeOutputTokens ?? t.context.totalOutputTokens)} output in ${(t.context.generationMs / 1000).toFixed(0)}s)${e2e}`);
      } else if (t.context.endToEndTokensPerSec > 0) {
        lines.push(`- Throughput: e2e ${t.context.endToEndTokensPerSec} tok/s incl. prefill (decode rate unmeasurable — no streamed text/reasoning)`);
      }
      const budget = state.config.max_context_tokens;
      if (budget && t.context.peakInputTokens > 0) {
        const near = t.context.peakInputTokens / budget;
        if (near >= 0.8) {
          lines.push(
            `- ⚠ Context peak ${near >= 1 ? "exceeds" : "near"} the configured budget — check opencode.json's per-model window and compaction.`,
          );
        }
      } else if (budget && t.context.peakInputTokens === 0) {
        lines.push(`- ⚠ Context peak unavailable (no step_finish tokens in the phase stream).`);
      }
    }
    if (t.logs.length) {
      lines.push(`- Log files:`);
      for (const l of t.logs) lines.push(`  - ${l}`);
    }
    lines.push(``);
  }
  // Issue #130: per-phase first-step cache accounting from the ledger. Every
  // model phase gets a line; review/goal/contract phases flagged when they
  // re-prefilled a non-trivial prompt with zero reuse.
  if (cacheStats && cacheStats.perPhase.length > 0) {
    lines.push(`## Prompt cache (first step per phase, #130)`);
    lines.push(``);
    const misses = cacheStats.perPhase.filter(
      (p) => expectsSharedPrefix(p.phaseFile) && p.cache.cached === 0 && p.cache.cold >= PREFIX_MISS_MIN_COLD,
    );
    if (misses.length > 0) {
      lines.push(`- ⚠ ${misses.length} phase(s) that should share a prefix reported zero cache reuse — their prompts were prefilled from scratch.`);
    }
    for (const p of cacheStats.perPhase) {
      const total = p.cache.cold + p.cache.cached;
      const miss = expectsSharedPrefix(p.phaseFile) && p.cache.cached === 0 && p.cache.cold >= PREFIX_MISS_MIN_COLD;
      lines.push(`- ${p.phaseFile}: ${p.cache.cached ? kc(p.cache.cached) : "0"}/${total ? kc(total) : "0"} first-step tokens reused${miss ? " ⚠" : ""}`);
    }
    lines.push(``);
  }
  if (state.visual_findings && state.visual_findings.length > 0) {
    lines.push(`## Visual review findings`);
    lines.push(``);
    for (const f of state.visual_findings) lines.push(`- ${f}`);
    lines.push(``);
  }
  const goalReviews = state.goal_reviews ?? [];
  if (goalReviews.length > 0) {
    // ADR 0029 (#102): the report counts advisory (see-early/steer-early)
    // goal checkpoints — the ones that judged + steered but deferred the fix
    // to the run-end batch — and lists every checkpoint's findings so the
    // whole-app gaps that were seen early are visible without digging into
    // the ledger.
    const advisoryCount = goalReviews.filter((r) => r.advisory).length;
    lines.push(`## Goal review checkpoints (ADR 0029)`);
    lines.push(``);
    lines.push(`- ${goalReviews.length} goal checkpoint record(s), ${advisoryCount} advisory (judged + steered; zero corrective tickets — corrected in the run-end batch)`);
    lines.push(``);
    for (const r of goalReviews) {
      const tag = r.advisory ? "advisory" : r.group === "run-end" ? "run-end corrective" : "corrective";
      lines.push(`- ${r.group} [${tag}]: ${r.verdict}${r.findings.length ? ` — ${r.findings.length} finding(s)` : ""}`);
      for (const f of r.findings) {
        lines.push(`  - ${f}`);
      }
    }
    lines.push(``);
  }
  if (allRulings.length > 0) {
    lines.push(`## Rulings`);
    lines.push(``);
    lines.push(`Decisions the railhead took on the operator's behalf (plan-time adjudications and runtime corrective auto-rulings), each with its source and the tickets it involved. A ruling that dies with the workspace was a decision made in secret — this section is where an unattended run shows them.`);
    lines.push(``);
    for (const r of allRulings) {
      const src = r.source === "plan" ? "plan" : "runtime";
      const tickets = r.tickets.length ? ` (${r.tickets.join(", ")})` : "";
      lines.push(`- [${src}] ${r.finding}${tickets} — ruled: ${r.reason}`);
    }
    lines.push(``);
  }
  const ladderTickets = state.tickets.filter(
    (t) => t.last_failure_class || t.logs.some((l) => l.includes("capacity_limited")),
  );
  if (ladderTickets.length > 0) {
    const classes = new Map<string, number>();
    for (const t of ladderTickets) {
      const cls = t.logs.some((l) => l.includes("capacity_limited")) ? "capacity" : (t.last_failure_class ?? "unknown");
      classes.set(cls, (classes.get(cls) ?? 0) + 1);
    }
    lines.push(`## Failure ladder (issue #80)`);
    lines.push(``);
    for (const [cls, n] of [...classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`- ${n} ticket(s): ${cls}`);
    }
    const capacityCount = classes.get("capacity") ?? 0;
    if (capacityCount > 0) {
      lines.push(`- ${capacityCount} capacity failure(s) — consider smaller tickets (docs/adr/0014) or a larger context budget`);
    }
    // gh #110 / ADR 0033: surface each diagnosis the plan-producing rung spent
    // — the root cause and whether its plan drove a guided attempt (or, with no
    // plan, the run stopped at the terminal rung exactly as before).
    for (const t of ladderTickets) {
      if (!t.diagnosis) continue;
      lines.push(`- ${t.number} diagnosis: ${t.diagnosis.text}${t.diagnosis.plan_spent ? " (plan spent)" : " (no plan — terminal)"}`);
    }
    lines.push(``);
  }
  // Issue #95 stage 4: the durable-session builder's full telemetry section.
  // Compaction events come from the per-ticket phase contexts (analyzePhase
  // counts step_finish token drops); argument-loop rounds are the blocking
  // reviews each ticket survived; restarts name their cause.
  if (state.builder) {
    const compactions = state.tickets.reduce((sum, t) => sum + (t.context?.compactions ?? 0), 0);
    const reviewRounds = state.tickets.reduce((sum, t) => sum + t.reviews.filter((rv) => rv.blocking).length, 0);
    lines.push(`## Session builder (ADR 0022)`);
    lines.push(``);
    lines.push(`- Granularity: ${state.config.checkpoint_granularity ?? "product"}`);
    lines.push(`- Checkpoints: ${state.builder.checkpoint_count}`);
    lines.push(`- Committed through: ${state.builder.committed_through ?? "—"} at ${state.builder.last_green_commit ? state.builder.last_green_commit.slice(0, 8) : "—"}`);
    lines.push(`- Session: ${state.builder.session_id ?? "(none — run ended without one)"}`);
    lines.push(`- Compaction events observed: ${compactions}${compactions > 0 ? " (expected under the durable session — compaction is the builder's context manager, not an error)" : ""}`);
    lines.push(`- Arguments-with-findings rounds (bounded per #70): ${reviewRounds}`);
    if (state.builder.restarts.length) {
      lines.push(`- Session restarts: ${state.builder.restarts.length}`);
      for (const r of state.builder.restarts) {
        lines.push(`  - ${r.at}: ${r.cause}`);
      }
    } else {
      lines.push(`- Session restarts: 0`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

function k(tokens: number): string {
  return tokens ? `${(tokens / 1000).toFixed(1)}k` : "—";
}

/** Issue #130: exact for small token counts (a 32-token prefix restored reads
 * as "32", not a misleading "0.0k"), one-decimal k above 1000. */
function kc(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

/** Issue #130: the smallest first-step prompt that could plausibly carry a
 * shared project prefix. Below this a zero-reuse step is just a small prompt,
 * not a cache miss worth flagging. */
const PREFIX_MISS_MIN_COLD = 4000;

/** Issue #130: phases that run a fresh session against the same project
 * context as earlier phases (review/goal/contract extraction). A zero-reuse
 * first step here means the shared prefix was not restored. */
function expectsSharedPrefix(phaseFile: string): boolean {
  return /review|goal|contract/i.test(phaseFile);
}

/** Human-readable duration between two ISO timestamps, e.g. "1h 12m 34s". */
export function elapsedLabel(startIso: string, endIso: string): string {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return "—";
  const total = Math.floor((e - s) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

/** Compact local clock time, e.g. "14:32:07", from the current instant. */
export function nowClock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function writeReport(cwd: string, runId: string, state: RunState): Promise<void> {
  const cacheStats = await collectCacheStats(join(cwd, ".railhead", runId));
  await writeFile(join(cwd, ".railhead", runId, "report.md"), buildReport(state, await collectCharterReportInfo(state), cacheStats), "utf8");
}

/** Read the report's charter facts from disk at report time: whether the
 * planner-authored charter exists and which ticket files the surface gate
 * classifies. Best-effort — a run dir mid-cleanup or a missing tickets dir
 * yields undefined (the report then omits the lines) rather than failing the
 * whole report. */
async function collectCharterReportInfo(state: RunState): Promise<CharterReportInfo | undefined> {
  try {
    const coherenceAuthored = existsSync(join(state.cwd, "docs", "coherence.md"));
    const tickets = await loadTickets(state.tickets_dir);
    const declared = state.config.projectInterface ?? null;
    const interactionInterface = declared ?? ((await detectGameCanvas(state.cwd)) ? "canvas (auto-detected)" : null);
    return {
      coherenceAuthored,
      surfaceTickets: tickets.filter((t) => touchesVisualSurface(t)).map((t) => t.number),
      interactionInterface,
    };
  } catch {
    return undefined;
  }
}

const STATUS_LABEL: Record<string, string> = {
  ready: "READY",
  in_progress: "IN PROGRESS",
  committed: "COMMITTED",
  failed: "FAILED",
  skipped: "SKIPPED",
};

function ticketNumber(t: TicketState): string {
  return t.number;
}

function titleFinder(state: RunState, file: string): string {
  return state.tickets.find((t) => t.file === file)?.title ?? file;
}

/**
 * Render the next actionable ticket(s) from a run state, plus any blocked
 * tickets waiting on them. Pure function — no I/O — so it's unit-testable.
 *
 * When the frontier is non-empty: shows the ready ticket(s) and what they'll
 * build, then any tickets still blocked.
 * When the frontier is empty: shows what's left (in-progress, failed, or
 * blocked on something that isn't committed).
 */
export function renderNextActionable(state: RunState): string {
  const committed = new Set(
    state.tickets.filter((t) => t.status === "committed").map((t) => t.file),
  );

  const ready = frontier(state);
  const inProgress = state.tickets.filter((t) => t.status === "in_progress");
  const failed = state.tickets.filter((t) => t.status === "failed");
  const blocked = state.tickets.filter(
    (t) => t.status === "ready" && !t.blocked_by.every((b) => committed.has(b)),
  );

  const lines: string[] = [];

  const total = state.tickets.length;
  const done = state.tickets.filter((t) => t.status === "committed").length;
  lines.push(`run: ${state.branch}  (${done}/${total} committed, ${state.status})`);
  lines.push("");

  if (inProgress.length > 0) {
    lines.push("IN PROGRESS:");
    for (const t of inProgress) {
      const att = t.attempts ? ` (attempt ${t.attempts})` : "";
      lines.push(`  ▶ ${ticketNumber(t)} ${t.title}${att}`);
    }
    lines.push("");
  }

  if (ready.length > 0) {
    lines.push("READY TO BUILD:");
    for (const t of ready) {
      lines.push(`  ○ ${ticketNumber(t)} ${t.title}`);
      lines.push(`    ${t.file}`);
      if (t.group) lines.push(`    group: ${t.group}`);
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("FAILED:");
    for (const t of failed) {
      const att = t.attempts ? ` (attempt ${t.attempts})` : "";
      lines.push(`  ✗ ${ticketNumber(t)} ${t.title}${att}`);
    }
    lines.push("");
  }

  if (blocked.length > 0) {
    lines.push("BLOCKED:");
    for (const t of blocked) {
      const uncommittedBlockers = t.blocked_by
        .filter((b) => !committed.has(b))
        .map((b) => `${b} (${titleFinder(state, b)})`);
      lines.push(`  · ${ticketNumber(t)} ${t.title}`);
      for (const b of uncommittedBlockers) {
        lines.push(`    waiting on: ${b}`);
      }
    }
    lines.push("");
  }

  if (ready.length === 0 && inProgress.length === 0 && failed.length === 0 && blocked.length === 0) {
    lines.push("All tickets committed. Nothing to do next.");
  }

  return lines.join("\n").trimEnd();
}