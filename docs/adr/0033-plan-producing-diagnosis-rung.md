# Plan-producing diagnosis rung for the implement path

> Superseded by ADR 0047: the plan-producing diagnosis rung was reachable only
> on the fresh-implementer path, which is deleted. A diagnosed failure now takes
> the durable builder's fresh-session recovery.

## Context

The failure-response ladder (ADR 0023) classifies an implementer's third consecutive execution failure as `diagnosed` — but rung 3 is terminal: `nextRung` returns a human-readable diagnosis string and the ticket stops. No model is asked *why* the approach failed, and no corrective plan is produced. A systemic (non-review) failure — not capacity, not fatal-config — therefore ends an unattended run with nothing but a summary line, even when a different approach would have landed the ticket.

Siesta borrows the shape of the answer: after a third failure, instead of retrying blindly, run a deep-diagnosis model call whose output is a *plan* fed straight back to the worker (`DIAGNOSE_PROMPT`, `_escalate`). This decision ports that rung to the railhead, narrowed to a plan-producing step before the terminal verdict.

## Decision

Insert one **plan-producing diagnosis rung** between "retry" and "give up" for the **implement** path only:

- **Trigger.** A third consecutive implement failure classified `diagnosed` (rung 3 `hard-fail` — not capacity, not fatal-config; those short-circuit the ladder unchanged and never spend a diagnosis call).
- **One diagnosis call.** A fresh `opencode` subprocess (model = the goal/oversight tier, ADR 0015) is given the ticket, the accumulated `FailureEvidence`, the failed phases' transcript paths, the current diff, contracts, and learnings. It emits a `$DIAGNOSIS` root-cause marker, and may emit a `$PLAN` marker with a concrete step-by-step fix.
- **Two outcomes, exactly.**
  - `$DIAGNOSIS` + `$PLAN` → the plan is fed through the existing `prevFeedback` channel into **one** final implementer attempt. After that attempt, rung 3 is terminal again — no second diagnosis, no extended ladder.
  - `$DIAGNOSIS` alone → the ticket is not recoverable this run; behave exactly as rung 3 does today (stop), with the diagnosis text as the persisted reason.
- **Fail open.** If the diagnosis phase itself fails (timeout, stall, budget), fall through to today's terminal rung with the phase failure logged. The diagnosis is an enhancement, never a new wedging point.
- **Persistence.** The diagnosis (root-cause text + whether its plan was spent) is persisted on the ticket beside `ladder_rung` / `last_failure_class`, so a resume neither re-diagnoses nor re-spends the guided attempt. It surfaces in `report.md`'s failure-ladder section.
- **Scope.** The fresh-subprocess implement path (`runImplement`) only. The durable-session builder's terminal classes keep their existing fresh-session recovery (`builderRecoveryFor`); doubling this onto both paths buys nothing until #83 picks a default.

The markers parse through the fence-aware layer (#108) — a `$DIAGNOSIS`/`$PLAN` quoted inside a code fence is an example, not a signal.

## What is explicitly unchanged

- **ADR 0003 stands.** A diagnosis cannot skip a ticket or advance the Frontier — only rescue or stop the current ticket. A diagnosis that concludes the ticket is unachievable routes to exactly today's stop semantics (`failed`, or `stopped` under `--pause-on-failure`). Continuing on a model-authored "unachievable" verdict would break the ADR 0006 invariant for every downstream ticket Blocked by it.
- **Review findings are out of scope.** This rung handles *execution/infra* failures (`class: "diagnosed"`) that exhaust the ladder without a usable review finding. Review BLOCKERs already feed back through ADR 0005; plan-level wrongness keeps its existing signal — the goal reviewer's `$REPLAN` (ADR 0019).
- **Fatal-config and capacity short-circuits are untouched.** Never spend a diagnosis call on an OOM or a bad API key.

## Consequences

- A third consecutive implement failure now runs at most one diagnosis call and one guided attempt, hard-bounded and persisted across resume (mirroring ADR 0023's "three rungs, hard-bounded, persisted across resume").
- `TicketState` gains a `diagnosis` field (`{ text, plan_spent }`), persisted by `writeState` and rendered in the report.
- The diagnosis is a real phase: its own ledger event file, standard timeout/step guards, a live line, and a report line.
- ADR 0023's ladder table is amended for the implement path's rung 3.
