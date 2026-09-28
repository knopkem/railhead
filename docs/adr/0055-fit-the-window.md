# Tickets must fit the window: plan to a working budget, split on capacity, gates own acceptance

## Context

The durable builder (ADR 0022) made compaction the context manager and told the
planner to size tickets by verifiability and seams, "not by a context window"
(`planTicketsSystemPrompt`). The capacity verdict exists because that premise
has a hard boundary: a unit whose work needs more than one window does not just
compact — it compacts, re-reads, and compacts again, burning its step budget
without ever checkpointing. SpriteForge ticket 05 (`canvas-pencil-vertical`,
2026-09-27) is the worked example: 6 files plus wiring plus 6 acceptance
probes; 377 cumulative steps and ~1h45m across attempts; the resumed
invocation hit the 320-step cap after two compactions (three in the phase
record) at ~85k of a 100k budget. The remedy then — a fresh session on the
same ticket (`builderRecoveryFor`: capacity → fresh-session) — re-tried the
identical unit and filled a new window.

Three gaps made the failure worse than the rule:

1. The planner had no size ceiling to plan against, so a ticket could
   legitimately be planned to need the whole window.
2. Capacity dropped the session and kept the unit: the expensive part (working
   memory) was lost, the oversized part kept.
3. The builder burned steps on a self-written browser probe harness for the
   ticket's `probe:` criteria — acceptance infrastructure the railhead's own
   gates (interaction smoke, goal/visual review) already own.

## Decision

1. **Plan to a working budget.** The ticket-decomposition prompts (build and
   feature) carry a concrete working budget: `WORKING_BUDGET_RATIO` (0.6) of
   the implement seat's context window — ~60k of a 100k window. A ticket must
   complete within that budget; the remainder is reading, tool output, and
   compaction headroom. Split a vertical slice that would exceed it into
   successive slices that each leave the build green; never merge slices to
   look smaller or pad the queue to look finer.
2. **Capacity splits the frontier, not the session.** On a terminal capacity
   verdict, `processTicket` attempts a split replan before the fresh-session
   fallback: the interrupted session writes a handoff note (best effort, one
   bounded invocation), the planner regenerates the uncommitted frontier —
   including the interrupted ticket — into smaller tickets, with the capacity
   evidence, the worktree state, and the handoff as inputs, and the frontier
   continues on a fresh seed. Bounded by the existing `max_replans`; on any
   planner failure the behaviour is exactly today's fresh-session recovery.
3. **Verify-green work is preserved before the split** (ADR 0006): if the
   interrupted ticket's tree is known verify-green, it is committed as a
   checkpoint first; the split frontier builds on it and the new tickets get
   fresh budgets by construction.
4. **Gates own acceptance.** The builder prompt states it plainly: the
   project's declared verify suite is the builder's test surface; the
   railhead's gates drive the running app and own acceptance. The builder must
   not add bespoke probe/test harnesses to the project, and a criterion's
   `probe:` line describes how the gates will check the behaviour — it is not
   work for the builder to script. The existing 3-attempt rule and
   `$BLOCKED kind=verification-unavailable` exit are the honest stop; growing a
   harness is not.

## Consequences

- A too-big ticket is re-scoped mid-run instead of re-tried identically; the
  split planner sees the capacity numbers, the worktree, and the session's own
  handoff, so the smaller tickets do not redo finished work.
- Costs one handoff invocation plus one planner call per capacity event,
  bounded by `max_replans`. If a split still does not fit, its next capacity
  verdict consumes another replan, then falls back to the fresh-session path.
- The interrupted ticket's TicketState counters die with it; the ledger and
  `builder.restarts` keep the record, and the report names the split.
- The step cap stays per-invocation and non-fatal: a step-budget kill with
  fewer than two compactions still retries the same session as a `blip`.
  Capacity — not raw step exhaustion — is the split trigger.
- ADR 0040's ticket budget stop is unchanged: it is the thrash bound, not the
  fit signal. A split resets nothing it owns; new tickets are new Tickets.
- Planner prompt coupling (ADR 0007): the working-budget wording is pinned by
  the plan prompt tests.

## Relationship to other ADRs

- Amends ADR 0022 §5: capacity no longer means "fresh session on the same unit"
  first; it means "re-scope the unit, then a fresh session", with the old path
  as the bounded fallback.
- Extends ADR 0019 / ADR 0045: a capacity verdict joins the reviewer's
  `$REPLAN` as a replan trigger; the same frontier regeneration and global
  numbering apply.
- ADR 0040 stands: cumulative ticket budgets remain the stop, and the split is
  a new plan, not a budget reset in disguise.

## Amendment: compaction is normal — capacity needs no worktree progress (Sep 2026)

The compaction count alone was too eager a fit signal. With a durable session
(ADR 0022), local models, and a 100k window, compacting two or three times
inside one invocation is ordinary fill management while the session keeps
building. The worked failure: SpriteForge ticket 24 (`palette module green`)
wrote and committed its module across 190 steps and three compactions, then
stopped without the `$CHECKPOINT` marker — the railhead re-scoped the unit out
from under finished work because compaction, not lack of progress, was read as
"does not fit".

- `FailureEvidence` now carries `worktreeChanged`: whether the invocation
  moved HEAD or `status --porcelain` since it started (a cheap fingerprint,
  `git.worktreeFingerprint`). Undefined means unmeasured.
- `classifyFailure` routes `compactions >= SPIRAL_COMPACTION_THRESHOLD` to
  capacity only when `worktreeChanged === false`. With progress — or with the
  signal unmeasured — compaction is normal and the phase is a `blip` (retry /
  keep driving the durable session).
- The no-marker recovery keeps its shape: a marker-less invocation that moved
  the worktree resumes the session; only a no-progress spiral carries capacity
  evidence into the ladder and may split.
- The peak-token gate and capacity wording are unchanged: they remain hard
  evidence of an oversized request.
- Consequence: a genuinely unfit unit may now consume its retry rungs before
  the ticket budget stops it; the ticket budget (ADR 0040) remains the backstop,
  and the no-progress spiral is still caught on the first ladder rung.

