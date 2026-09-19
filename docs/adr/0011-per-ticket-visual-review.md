# Per-ticket visual review (in addition to end-of-run)

> Superseded in part by ADR 0021 (issue #73): the `visual_review.per_ticket`
> boolean and the `enabled` opt-in became a single cadence `mode`. Per-ticket
> firing is `mode: "full"` (or `"medium"`), end-of-run-only is `"light"`, and
> `"off"` disables the gate. The rationale recorded below for *why* per-ticket
> review exists (and when to skip it) still stands.

## Context

ADR 0009 established visual review as a *single* gate at end-of-run, and was explicit about why not per-ticket: "visual checks are expensive (model + capture) and a per-ticket visual gate would either need a partially-integrated app (which doesn't exist mid-run) or risk blocking early tickets on visuals that only make sense once the whole app is integrated" (¶23).

The pong run (Aug 2026) surfaced the cost of that deferral. The actual bug — `paddle_y = 0.0` hardcoded in `move_ball` at `pong/src/main.rs:257` — was invisible to diff-based review: the line was a literal assignment, the unit tests passed `0.0` explicitly so they didn't catch it, and the function reading correctly in source is not the same as the paddle actually moving at runtime. The end-of-run visual review *did* catch it — but only after every ticket had already committed. A defect that exists purely at runtime, encoded in a single ticket's slice, stacked silently through N downstream tickets before anything noticed.

The structural gap: end-of-run visual review is an integration check across the cumulative diff, but a per-ticket runtime regression is invisible to every downstream ticket's implementer (they see a broken app and may "fix" it in ways that mask rather than address the root cause). Catching it at end-of-run is late; catching it never is worse (ADR 0006's "everything green every step" property is violated the moment a ticket commits a runtime-only defect).

## Decision

Add a **per-ticket visual review** pass, gated on a new `visual_review.per_ticket` config field. When true, a visual review round runs *after each ticket commits* (in addition to, not instead of, the end-of-run pass). It is opt-in at plan time: `railhead plan` asks the user whether to enable it (default No — per-ticket visual is significantly slower, and most builds only need the integration check at end-of-run).

In `railhead fix` mode, the question is omitted and `per_ticket` is forced `true` whenever `visual_review.enabled` is on and a vision-capable `model.review` is configured. A bug fix's whole point is observable runtime behaviour; visual verification is never optional in fix mode. The user cannot disable it short of disabling visual review entirely.

### Why both per-ticket AND end-of-run

The two passes catch different classes of defect:

- **Per-ticket** catches per-ticket runtime regressions — the ticket's own criteria, judged in isolation, before downstream tickets stack on top of a broken foundation. Uses the ticket's own `criteria` (not aggregated).
- **End-of-run** catches integration issues — criteria that only manifest when the whole app is assembled (e.g. "the menu opens on click" only makes sense once the menu and the click handler both exist). Uses aggregated criteria across all tickets.

Removing either weakens the gate: per-ticket-only would miss integration regressions; end-of-run-only (today) misses per-ticket regressions until they've already propagated. Keeping both is the cost of ADR 0006's "everything green every step" applied to runtime, not just source.

### Shape

- **When:** inside `committedTicket`, between the commit and the contracts-index update. The ticket is already committed (state persisted as `committed` so an interrupt can't lose it); per-ticket visual runs against the just-committed state.
- **Phase file:** `${ticket.number}-visual` — distinct from end-of-run's `visual-NN-review` so the two passes' ledgers don't collide.
- **Criteria:** the ticket's own `parsed.criteria`, not the aggregated set across all tickets.
- **On `$VISUAL_PASS`:** the ticket proceeds to contracts update and returns `"ok"`.
- **On `inconclusive`:** the ticket is left committed (don't fail a ticket because the reviewer couldn't run the app — matches end-of-run behavior from ADR 0009's amendment). The run is marked not-verified.
- **On `$VISUAL_FAIL` with `[BLOCKER]`s:** corrective tickets are generated and processed *inline* (via `processTicket`) before the original ticket is allowed to return `"ok"`. This matches the end-of-run `visualReviewLoop` semantics at L270-279. The ticket's `processTicket` call does not return until all its visual blockers are resolved.

### Why corrective tickets process inline (not deferred to the main loop)

The alternative — push corrective tickets onto `state.tickets` and let `runLoop`'s `frontier` pick them up on the next iteration — would let the run advance to the next ticket against a known-broken visual state. The next ticket's implementer would see the broken behavior in the running app, which may confuse it (it may "fix" the prior ticket's bug as a side effect of its own work, masking rather than addressing the root cause). Processing inline blocks the ticket — and therefore the run — until the visual blocker is resolved, preserving ADR 0006's property that the run is green at every committed step.

## Consequences

- One new config field (`visual_review.per_ticket: boolean`, default `false`); one new helper (`runPerTicketVisualReview`); one extracted helper (`committedTicket`) consolidating the post-commit sequence shared by the regular commit and soft-pass paths. No new subprocess shape — reuses `runVisualReview` with a `phaseFileOverride`.
- Per-ticket visual is skipped silently when `!enabled || !per_ticket || model.review === null`. Today's behavior is preserved for users who don't opt in.
- `railhead fix` forces `per_ticket: true`. The user cannot disable it short of disabling visual review entirely — this is intentional: fix mode is about observable behaviour, so visual verification is never optional there.
- The end-of-run `visualReviewLoop` is unchanged. Per-ticket is *additional*, not a replacement.
- Cost: per-ticket visual roughly doubles-to-N× the visual model invocations (one per ticket + one aggregated at end). This is the explicit cost of catching per-ticket runtime regressions early; the user opts in knowingly, and fix mode's forcing is justified by the bug-fix semantics.
