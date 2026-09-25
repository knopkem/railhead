# The gate resolves references to introducers and auto-inserts implied ordering edges

> Superseded by ADR 0048: `references`/`introduces` and the `blocked_by`
> ordering edges this ADR resolves no longer exist.

Issue #103. Builds on ADR 0027 (slug identity, array coordinates) and the
single-owner rule (#101). Plan ordering must be *provably consistent with the
contracts it declares*: a ticket that `references` a symbol another ticket
`introduces` must be ordered after it. Today the planner authors `blocked_by`
and `references`/`introduces` as independent facts and nothing checks they
agree, so an inconsistent plan is invisible until an implementer tries to
consume a contract that does not exist yet (the #61/#64 failure class) or
enters a same-file repair cycle.

## Context

The plan gate (issue #86) scans tickets for structural defects (duplicate
introduces, unordered same-file editors) and escalates every finding to a
bounded model repair round. It never looks at what each ticket *references*.
A planner that declares a reference to a later ticket's contract but omits the
`blocked_by` edge produces a plan the gate accepts and the run later pays for.
Conversely the planner is currently forced to hand-author a redundant copy of
an edge the contract map already determines — pure authoring cost and a second
place for the two facts to drift.

## Decision

The references→introduces map becomes a checked input of the same gate, and
implied-missing edges are resolved deterministically — zero model rounds — while
`blocked_by` keeps its role for orderings the contract map cannot express.

1. **Two new class-A findings, over the ticket set.** `unsatisfied-reference`
   fires when a ticket references a symbol another ticket in the set introduces
   but is not already a transitive `blocked_by` predecessor of the introducer.
   `dangling-reference` fires when a referenced symbol is introduced by no
   ticket in the set **and** is not a known existing contract. Both keys are
   slug identity (ADR 0027): `ref:<referencingSlug>:<symbol>` and
   `dangling-ref:<slug>:<symbol>`.
2. **An existing-symbol universe.** A reference is only dangling relative to
   what the railhead can know. Every gate call takes the contracts-index symbols
   (committed/existing code) so a ticket that builds on a committed contract —
   a replanned ticket, a fix ticket, a corrective — is never misread as
   dangling. At run time the committed ticket files are also in the scanned set
   and a corrective's references to their introduces are treated as satisfied
   (commit order, not a `blocked_by` edge, orders them — correctives carry no
   edges, issue #63). The plan gate, run-start gate, replan gate, and runtime
   extension scan all thread this universe, so the same plan scans identically
   everywhere.
3. **Auto-insert before the model round.** When every remaining un-ruled
   class-A finding is an `unsatisfied-reference` — no duplicate introduces, no
   genuinely-missing symbol, no unordered same-file with no contract — the gate
   appends the introducer's array index to the referencing ticket's
   `blocked_by` (the exact coordinate the model edits, ADR 0027), re-scans, and
   continues *without consuming a repair round*. A declared edge that
   *contradicts* the implied one (adding it would cycle) yields no auto-insert;
   that is a genuine model bug and escalates.
4. **Dangling needs judgement.** There is no deterministic edge to insert for a
   symbol that exists nowhere (typo? forgot to declare? genuinely missing?), so
   a dangling reference always escalates to a model repair round — never
   silently auto-inserted.
5. **Authoring relief.** The planner prompt says a `blocked_by` edge may be
   omitted whenever a `references`→`introduces` pairing already implies it, and
   must be authored for orderings the contracts cannot express. Omission is safe
   only because §1's validation is now enforced.
6. **Dangling is inert in the runtime corrective scan.** A corrective ticket's
   references are advisory seams the reviewer names from committed code
   (issue #67) that the plan never modeled as introduces; aborting a run over
   them would false-positive. The plan gate owns the dangling finding; an
   un-ruled dangling reference left in a *plan* is still caught by the
   run-start gate.

## Why not pure derivation

Compute the whole DAG from references→introduces and drop `blocked_by`
authoring, and ordering depends entirely on reference accuracy — under-declared
references would silently weaken ordering. `blocked_by` stays load-bearing for
non-contract orderings (same-file wiring, UX sequencing); this change only ever
makes ordering **stronger** (reference = an additional checked input) and
cheaper to author.

## Why dangling carries its own universe

The pure "no ticket introduces it" reading would reject every replan/fix plan
that references committed work (their introducers are not in the regenerated
ticket set), burning a repair round or a ruling on each. The gate can actually
distinguish "truly missing" from "exists outside this set" because it holds the
contracts index — so it does.

## Consequences

- Ordering can never be weaker than the plan's own contract declarations, and a
  plan whose only defect is an implied-missing edge passes the gate with zero
  model repair calls.
- `blocked_by` authoring for contract-bound orderings is optional; the repair
  table and rulings never see an auto-inserted edge as a leftover (it is
  resolved before the table is built).
- `assessRuntimeExtension` stays consistent: a corrective that *introduces* a
  symbol is a blocked predecessor of every live ticket by `extendBlockedBy`, so
  references to it are satisfied; a reference to a committed introducer is
  exempt by commit order.
- A plan written before this change that references committed contracts with no
  ruling will now be gated (repaired or ruled) — the intended one-time
  tightening, same shape as ADR 0027's ruling re-keying.
