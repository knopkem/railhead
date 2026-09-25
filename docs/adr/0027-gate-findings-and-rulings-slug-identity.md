# Gate findings and rulings identify tickets by slug; the repair table speaks array coordinates

> Amended by ADR 0048: the plan-time findings and `$RULINGS` gate this ADR
> identifies are removed. Title-slug identity survives for ticket file names and
> gate finding text.

Amends the plan-repair vocabulary introduced by ADR 0007's `NN-slug.md`
naming and issue #86's bounded plan gate. Recorded after a real run
(spriteforge, a 12-ticket Vite plan) where the repair loop spoke two different
coordinate systems for the same tickets and carried a plan through two repair
rounds to a rejection — the model "fixed" the wrong ticket pair, and a ruling,
had one been recorded, could not have survived round 2.

## Context

`orderTickets` numbers tickets by Kahn pop position and names the files
`NN-slug.md`. Two seams read that `NN` back out as if it were identity:

- **Findings.** The gate's finding messages and keys used the topological file
  number (`findUnorderedSameFile`/`findDuplicateIntroduces` in `ticket-dag.ts`,
  `qualityClassB` in `plan.ts`) — e.g. "tickets 07 and 06 both touch
  `src/main.ts`". But the repair prompt hands the model the raw `PlanTicket[]`
  JSON, whose `blocked_by` are 0-based **array indices**. Array index and
  topological `NN` are different orderings that diverge the moment the graph
  is not a pure chain. In the observed run, railhead-`NN` 07 was Palette while
  array-index 7 was Frames; the repair model read the finding as "Frames vs
  Layers", added an edge between the wrong pair, and the finding never cleared.
- **Rulings.** Keys like `same-file:06-layers-system.md:07-palette-system.md`
  re-derived every repair round, because `orderTickets` renumbers when the
  model adds an edge. A `$RULINGS` adjudication recorded against round 1's key
  stopped matching round 2's scan of the *same physical pair*, so the ruling
  was orphaned and the finding re-litigated. The plan-time ↔ runtime seam
  (`assessRuntimeExtension`) depends on these keys matching too.

## Decision

A ticket's identity for gate findings and rulings is its **title-derived slug**
(content), never its re-derived topological `NN`; and the repair table
communicates in the **array coordinates the model edits**.

1. **Slug-stable finding keys.** `dup-introduce`, `same-file`, `file-count`,
   `no-contracts`, and `placeholder` keys are derived from each involved
   ticket's slug (`NN-` prefix stripped). At plan time the slug comes from the
   title via the same slugify `orderTickets` uses; at runtime it is derived
   from the committed file name — so a plan-time ruling key and a runtime scan
   key for the same pair are byte-identical, with no dependence on what `NN`
   happened to be in any given round. Within a pair key, slugs are sorted
   canonically (not by the `NN` file prefix), so renumbering cannot even flip
   the key's slug order.
2. **Slug uniqueness is a gate finding, not an abort.** Stripping `NN` makes
   the slug alone carry identity, so slugs must be unique within a plan.
   `NN` used to disambiguate file names, making duplicate titles harmless;
   with slug-only keys two same-titled tickets collide and a ruling on one
   pair (e.g. `same-file:panel:panel`) would silently suppress a *different*
   pair's finding. The `NN-slug.md` file-name scheme is unchanged.

   *Amended after a real run (13-ticket Vite plan, ticket 0 and ticket 12 both
   titled "Scaffold: …"):* `orderTickets` originally aborted on duplicate or
   slug-equivalent titles, which crashed the gate before a single finding
   existed — the bounded repair loop (issue #86) never ran. Now
   `orderTickets` deterministically suffixes colliding slugs (`-2`, `-3`, …,
   assigned in array order) so ordering, file names, and every other
   finding's keys stay collision-free, and `scanTicketConflicts` raises a
   class-A `duplicate-slug` finding (keyed by the stable **base** slug,
   `dup-slug:<base>`): the repair model retitles one ticket or removes the
   duplicate, and only an unrepaired plan rejects at the round cap.
   Ordering failures in general (a dependency cycle, an out-of-range
   `blocked_by` index) take the same route as a synthesized, non-rulable
   class-A `unorderable-plan` finding reached via `scanPlanConflicts`
   returning `ordered: undefined`.
3. **Repair-table messages in array coordinates.** The findings the repair
   model reads name each ticket the way the model edits it: the table carries
   each involved ticket's 0-based array index and title, and the repair prompt
   prints e.g. "tickets at array index 5 (Palette system) and array index 6
   (Layers system)" — never a topological `NN`. This works with no new mapping
   machinery: `orderTickets` maps over its input, so the ordered ticket at
   position `k` *is* array element `k`. Human/runtime-facing messages keep the
   full `NN-slug.md` file names (the report, `reportConflicts` logs, and
   auto-ruling reasons).
4. **Two repair-prompt instructions bound identity.** (a) Preserve the array
   order — `blocked_by` are positions in the array being edited; (b) do not
   retitle a ticket during repair (merging aside).

## Why not keep `NN` as identity

`NN` is a topological position: it is re-derived whenever the graph changes and
it diverges from the array coordinate the model actually edits. Identity that
moves between scans cannot anchor a ruling or a message. The slug is content:
it is produced once from the title, persists across renumbering, and is the
same string on both sides of the plan/runtime seam.

## Consequences

- The two bug classes share one root — messages/keys derived from a re-derived
  numbering — and both are now grounded in slug identity; a regression test
  asserts that for any pair of scans separated by an added edge the same
  physical pair keeps the same key, and that the repair message's array indices
  point at the tickets whose titles match.
- Key stability covers **renumbering by construction**, not retitles: a model
  that renames a ticket during repair re-slugs it, orphaning any ruling
  recorded against the old slug. That is excluded by prompt instruction and
  recorded here as the boundary of the guarantee.
- Rulings written before this change (keys embedding `NN` file names) no longer
  match a current scan's slug keys — an old `rulings.json` stops suppressing its
  findings. This is the intended one-time correction of the identity scheme,
  not a per-round instability.
- The topological ordering itself, the Kahn numbering, the file-name scheme,
  and the runtime corrective policy are all untouched.
- Duplicate-slug findings CAN be ruled intentional (the suffixed file names
  keep identity collision-free), but `unorderable-plan` findings cannot —
  the gate drops `$RULINGS` against them, because no plan is made intentional
  by adjudication; only a repair clears it.
