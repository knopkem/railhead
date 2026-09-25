# A ticket is an ordered checkpoint, not a dependency-graph node

Amends ADR 0007 (ticket format), ADR 0008 (contracts index), ADR 0022
(tickets as plan units), ADR 0027 (slug identity), ADR 0035 (repeat collapse),
and supersedes ADR 0045 (replan numbering globalization).

## Context

The ticket schema grew for the ADR 0001 world — a fresh implementer per ticket
needed a complete edit set (`files`), an explicit contract surface
(`references`/`introduces`), and a dependency graph (`blocked_by`) so ordering
could survive parallel structure. Execution is strictly sequential (one branch,
one commit per checkpoint), so the graph only ever re-validated the emitted
order, and the durable builder session (ADR 0022) already holds everything it
built.

The cost of that shape became the dominant planning failure. The spriteforge
run's decomposition hit the model's output limit mid-array (each ticket
repeated a mission and carried file/reference/introduce lists); the truncated
tail lost a ticket, the coverage gate raised `uncovered-file`, and two repair
rounds could not re-emit the full array — the plan was rejected before any run
started. The DAG machinery (orderTickets, conflict scans, duplicate-introduce /
unsatisfied-reference / same-file / unowned-entry-point findings, implied
edges, dropped-ticket guards, $RULINGS adjudication, runtime corrective
re-scans) is thousands of lines whose only reader was a model repair loop that
weaker models routinely lost.

## Decision

1. The ticket is `{ title, what, criteria, group?, open_ended? }`, rendered as
   `file`/`number`/`slug` plus those fields. `mission`, `blocked_by`, `files`,
   `references`, `introduces`, and `testable` are gone.
2. **Array order is execution order.** The planner emits prerequisites first;
   `numberTickets` numbers in emission order and de-duplicates title-slugs for
   filenames. There is no topological sort, no dependency scan, and no
   plan-time repair gate.
3. `src/core/ticket-dag.ts` is deleted along with the run-start conflict scan,
   the runtime extension scan, and every finding/ruling artifact
   (`rulings.json`, `RunState.plan_rulings`/`rulings`).
4. Corrective tickets are inserted **before** the remaining planned frontier,
   so an inline corrective or a crash-resume runs it before the plan continues.
5. A replan regenerates the uncommitted frontier and numbers it into the run's
   global sequence (`numberTickets(planTickets, nextTicketNumber(state))`);
   there are no edges to remap.
6. The contracts index stays, but only as an auto-extracted artifact of
   committed source (regex + per-file model fallback); the planner no longer
   declares contracts, and gates read the whole index rather than a
   files/references slice.

## Consequences

- A ticketer schema a weak model can hold: short output, no indices, no
  symbols to reconcile. Truncation is caught by a `"title"`-count integrity
  check and answered with one "emit the remaining tickets" continuation call.
- Ordering correctness moves into the planner prompt ("order so every
  prerequisite comes first") and the durable session's judgement. A misordered
  ticket may start before its prerequisite exists; the session can see the
  repo and `$BLOCK` with `kind=plan-defect`, which routes to the existing
  bounded auto-replan — far cheaper than the repair-loop deadlocks this
  removes.
- Duplicate titles no longer gate; `numberTickets` suffixes `-2`, `-3` so file
  names stay unique. Distinct tickets with the same title read strangely but
  run.
- Old runs resume: unknown state fields are ignored, and legacy ticket files
  parse with their removed headings ignored.
