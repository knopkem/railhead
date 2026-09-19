# The plan gate resolves mechanical findings deterministically — repeats collapse, same-file editors chain

Extends ADR 0030 (the gate auto-inserts implied references→introduces edges).
Recorded after a spriteforge plan (pixel-art editor, local planner model) in
which the planner emitted its entire 13-ticket plan **twice inside one
`$TICKETS` array** — 26 tickets, every title doubled with identical files and
introduces. The gate raised 114 findings (66 duplicate-introduces, 13
duplicate-slug, 35 unordered-same-file), handed them to the bounded repair
loop (issue #86), and the small model could not win: each repair round had to
re-emit the whole plan while surgically fixing a table longer than its own
reliable working memory. Two rounds, zero progress, plan rejected — and the
rejected plan was *already correct* under one mechanical transformation.

## Context

ADR 0030 established the principle: a finding whose resolution is
deterministic is resolved by the gate itself, at zero model cost, and only
genuine judgement calls (dangling references, duplicate introduces between
distinct tickets) consume a repair round. Two finding classes still violated
that principle:

- **Repeated tickets.** A small planner continuing a plan across a long output
  loses track and re-emits a ticket it already emitted. Issue #104 handled the
  two-arrays case (a later `$TICKETS` array that re-states every earlier title
  is a revision; last wins). The within-one-array case fell through: the
  parser kept both copies, `orderTickets` suffixed their slugs apart (ADR
  0027), and the gate escalated a same-physical-pair finding per duplicated
  symbol — pure noise with one obvious resolution.
- **Unordered same-file editors.** The planner prompt already prescribes the
  remedy ("order its editors as a dependency chain, each later editor
  blocked_by the prior one") and the prompt already *sanctions omitting* an
  edge that a reference implies — but a local model that under-declares
  `references` produces same-file pairs with no contract link, and each pair
  became a repair-round finding. With N tickets docking into one app-shell
  file the finding count grows as N²; the spriteforge plan owed 35 of them to
  the shell file alone.

## Decision

Two mechanical finding classes are resolved by the gate itself, before any
model round, mirroring ADR 0030's implied-edge insertion (apply → trial-scan →
only commit if the plan still orders → otherwise escalate unchanged).

1. **Identical repeats collapse.** Two plan tickets with the same
   title-slug, the same `files` set, and the same `introduces` set (both
   normalized as the gate normalizes: slugified titles, `contractName`
   symbols) are one ticket emitted twice. `collapseRepeatedTickets` keeps the
   FIRST emission, drops the later copies, and remaps `blocked_by` (a pointer
   at a dropped copy resolves to the kept twin — it names the same work;
   self-edges the remap creates are dropped). The gate runs the collapse
   before every scan, logs each drop loudly (never silent — same discipline as
   issue #104's `collapsed` warning), and the repeat's duplicate-slug,
   duplicate-introduces, and same-file findings never come into existence.
   Prose fields (`what`, `criteria`) are excluded from the identity: a
   small-model echo typically rephrases prose while the structural content the
   findings are computed from stays identical.

2. **Same-file editors chain in emission order.** For each outstanding
   `unordered-same-file` finding the gate derives the edge the prompt
   prescribes — the later-emitted ticket appends the earlier-emitted one's
   array index to its `blocked_by` — and applies the batch without consuming a
   repair round. Emission order is the only defensible direction: the model
   listed the foundation editor before the tickets that build on it.

3. **Cycle guard.** A same-file chaining edge cycles iff the earlier ticket
   already transitively reaches the later one through `blocked_by`. That never
   holds for a freshly-scanned single pair (the finding requires the pair
   unordered), but it can hold once a sibling edge from the same batch is
   applied (A←C, B←D by hand plus batch edges D←A and C←B closes a loop).
   `sameFileOrderingEdits` therefore commits edges one at a time against a
   working graph and SKIPS a candidate that would cycle; the skipped pair
   stays outstanding and escalates with the repair round. In practice the
   applied edges often still order the skipped pair transitively, and it
   clears on the re-scan.

## What still escalates

Identity is structural and total: same title but **different files or
introduces** is not a repeat — dropping one could silently delete scope
(ADR 0027's amended example: two "Scaffold" tickets owning different modules).
Those still raise `duplicate-slug` and go to the model to retitle or merge,
and the `dropped-ticket` loss guard still watches repair rounds. Duplicate
introduces between genuinely distinct tickets (rename? merge? who owns it?) is
a judgement call and still escalates. Dangling references still escalate —
ADR 0030: no deterministic edge exists for a symbol that exists nowhere.

## Consequences

- The spriteforge 114-finding plan passes the gate with **zero** model repair
  calls: the collapse removes all 79 duplicate findings, the same-file chain
  removes the remaining 35, and the surviving 13-ticket plan is exactly the
  plan the model intended.
- Small planners no longer need to re-emit correct plans under a findings
  table — the failure mode that made planning "constantly fail" for local
  models. Repair rounds are now reserved for findings that carry actual
  ambiguity, which is what a small model can sometimes do.
- The loop's invariants simplified as a consequence: every iteration now
  begins with collapse → scan, so auto-resolutions never need their own
  rescan-and-continue bookkeeping. The repair loss guard's findings are
  computed against the pre/post pair of one round and re-attached to the next
  iteration's fresh scan — per-round semantics unchanged.
- Runtime gates are untouched: the collapse operates on the pre-ordering
  `PlanTicket[]` (array-coordinate world), which exists only at plan time;
  `assessRuntimeExtension` and the run-start gate work on persisted tickets.
- A repair round that re-introduces repeated tickets gets them collapsed on
  the next iteration before the scan — the gate converges on repeats no matter
  which round produced them.
