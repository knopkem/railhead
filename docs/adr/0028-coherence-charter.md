# Coherence charter

## Context

Cross-ticket coherence is currently enforced only by corrective churn at the
end of a run. The planner's `docs/design.md` (`$DESIGN`, #34) carries the
visual narrative, but it is not normative: each fresh implementer interprets
narrative ("utilitarian dark studio chrome") differently, the narrative is
injected into *every* implementer regardless of whether the ticket touches the
surface (a pure-model ticket gets the full visual narrative), and nothing
reconciles "the worker diverged from the charter" against "the charter was
wrong". #98 rejected the durable-coordinator design; this ADR records the
accepted alternative (#99): a **plan-time coherence charter** — a terse,
normative, cross-cutting visual design contract surface tickets honor from the
start.

## Decision

1. **Authoring.** The planner prompt requests a `## Coherence contract`
   subsection inside the `$DESIGN` block whenever the plan has a surface
   component (browser/canvas app, themed CLI, GUI — any rendered UI). Terse
   (~150-250 words), three fixed `###` sections: **Visual tokens** (naming the
   shared constants module surface tickets import rather than redefine),
   **Layout model** (who owns the shell, what docks where, the target-viewport
   constraint), and **Chrome rules** (the one panel/button/toolbar recipe every
   surface ticket reuses, with an explicit "do not introduce a competing
   style"). No surface → the planner omits the section, and no
   `docs/coherence.md` is written — zero artifact, zero pollution.

2. **Artifact.** The section is persisted as `docs/coherence.md`, a distinct
   read target from `docs/design.md`, so the two keep distinct injection
   policies (charter → surface seats; design narrative → pointer).
   `docs/design.md` persists the narrative *with the section sliced out*
   (`splitCoherenceContract`): each part is written exactly once, and goal
   reviews amend only `docs/coherence.md` — a second charter copy inside the
   design doc would ride into surface prompts twice and drift stale against
   its amended twin. Parsing is
   absent-robust: `parseCoherenceContract` returns null on an absent,
   malformed, or truncated section; a plan without a `$DESIGN` at all behaves
   exactly as before. The ticket JSON format is untouched (ADR 0007).

3. **Gate.** One recall-biased predicate, `touchesVisualSurface` (criteria
   vocabulary = the existing `VISUAL_CRITERIA_RE`), powers both per-ticket
   visual review (`shouldRunVisualReview`) and charter injection so the two can
   never disagree about what a surface ticket is. Empty criteria default to
   true. A false positive costs ~250 words; a false negative recreates the
   drift the charter exists to prevent. `railhead build` **warns** (never fails)
   when surface tickets exist but the planner emitted no charter section.

4. **Injection.** Surface tickets carry the charter content + a file pointer in
   the implementer, reviewer, read-mode reviewer, and durable-builder prompts.
   The design *narrative* is gated to surface tickets too — non-surface tickets
   get at most a one-line pointer; `architectureDocBlock` (the module map, the
   model ticket's audience) stays for ALL tickets. The builder's charter block
   adds a re-read-after-compaction line that `OUTPUT_DISCIPLINE`'s "do not
   re-read files you already hold" must not suppress.

5. **Drift has two exits.** The worker never adjudicates drift mid-ticket — it
   honors the charter by default and voices divergence via `$HANDOFF` (the
   author/judge split, ADR 0005). The goal reviewer judges the whole app
   against the charter and revises it via `CHARTER:` markers (the colon-marker
   family: `LEARNED:`/`RETRACTED:`/`DIGEST:`; not `$CHARTER`). Each line names a
   fixed section and carries that section's revised content; the railhead
   replaces the named section in `docs/coherence.md` (creating it when absent)
   — ADR 0018's digest-push shape. Two rules make the exits safe:
   - **Sequencing:** the charter update applies *before* corrective tickets are
     generated, so correctives are authored against the amended contract.
   - **Precedence:** when a finding and a charter update conflict, the update
     wins — the judge's later knowledge supersedes the earlier contract. The
     goal reviewer is told to rescope or withdraw any finding its own revision
     contradicts.

## Why not a durable coordinator

#98's rejected alternative kept a coordinator seat alive across tickets to
reconcile drift late. The charter prevents drift at the source (each surface
implementer starts coherent), costs ~250 words per surface ticket instead of a
durable process, and keeps the goal reviewer as the judge of whether a
divergence is the code's fault or the contract's.

## Consequences

- One new plan-time artifact (`docs/coherence.md`), read by surface seats and
  the goal reviewer; the report names whether it was authored and which tickets
  the gate classified as surface.
- `CHARTER:` revisions mutate a durable project doc — a deliberate, recorded
  mutation (like learnings/digest), not a hidden one.
- `fix` plans never author a charter (the fix planner cannot inspect the repo,
  so re-authoring could clobber an existing contract); the charter a surfaced
  repo already holds governs its corrective flow.
- The criteria-regex gate is heuristic; if `report.md` shows real
  misclassification, the escalation is a planner-declared `surface` ticket
  field (an ADR 0007 format bump), not more stacked heuristics.

## Validation (pending — recorded, not gating)

The charter's effect is measured against the observed failure corpus: re-run
the spriteforge-spark plan of `run-20260907-2146` with the charter authored,
and compare the `[BLOCKER]` classes at goal review — the expectation is fewer
coherence-class blockers (panel chrome drift, layout incoherence) at the
run-end pass, with the report's surface-ticket classification matching the
tickets that visually changed. The same corpus backs #102's light-preset A/B
(bare vs current light vs light-with-advisory-checkpoints), so one set of runs
feeds both measurements.
