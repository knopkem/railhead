# Goal-checkpoint scheduling: worth-based groups, a cadence ceiling, surface routing

Recorded after enabling `goal_review.mode: "medium"` on the platformer run.
The goal gate's schedule had three problems:

- `fallback_cadence` was widely misread as the trigger. It only applies to
  **ungrouped** plans; when tickets carry a `group`, the checkpoint fires when
  every ticket in the group commits and the cadence is ignored. The planner
  was therefore already the scheduler — but nothing told it what made a
  checkpoint worth its cost.
- A long group delayed feedback until its last ticket. Nothing bounded the
  commits between checkpoints.
- Early groups (`scaffold`, pure engine work) got the full browser-driving
  goal pass even though there was nothing observable for it to judge, while
  the cheap structural gate — the right seat for architecture-only increments
  — fired independently.

## Decision

### 1. The planner is told what group boundaries cost

`TICKET_FIELD_SEMANTICS` (shared by the planner prompts and the repair loop)
now states that group boundaries ARE the review schedule. Place the FIRST
boundary at the first runnable, demoable slice; a pure-tooling scaffold has
nothing to judge, so leave it ungrouped or extend it into the first playable
group. Once a rendered/interactive surface exists, keep groups to roughly 3-5
tickets. No numeric schedule is emitted — groups remain the single source of
truth, and the railhead never trusts a second one.

### 2. A cadence ceiling inside long groups

Run state gains `last_goal_commit_count`, set at every goal checkpoint
(whatever its verdict). `detectGroupCheckpoints` takes a `cadenceCeiling`
option (goal gate only): when a group boundary does not fire and
`fallback_cadence` commits have passed since the last goal checkpoint, a
synthetic `checkpoint-N` fires mid-group. The structural gate keeps the
boundary-only schedule; its own reviewed set already bounds it.

The ceiling measures commits *since the last checkpoint*, not a modulo, so a
skipped or failed review is caught at the next commit instead of waiting for
another full cadence. Ungrouped plans keep their legacy `% cadence` behavior.

### 3. A group with no rendered surface skips the goal pass

`runGoalReview` checks the group's parsed tickets: when none touches the
visual surface, it records the checkpoint as a pass (so the scheduler dedupes
it and the cadence baseline advances) and returns without spawning the agent.
The structural review owns that boundary — it is the cheap code/architecture
read that can actually judge it. Run-end goal review is exempt (everything is
committed and integrated there).

Side fix found while testing this: `VISUAL_CRITERIA_RE` matched `render`,
`draw`, `show` but not their `-s`/`-ing` forms, so `"the app renders…"` — the
most common criteria phrasing — classified as non-surface. The verb list now
uses `\w*` suffixes (`render\w*|draw\w*|show\w*|…`), consistent with the
gate's recall bias.

## Non-goals

- No planner-emitted review schedule (fragile, unverifiable, duplicate source
  of truth).
- No hard-coded "skip the first N tickets" — the signal is the deliverable,
  not a count.
- Not changing structural-review scheduling.

## Consequences

- Feedback latency is bounded by `fallback_cadence` commits regardless of how
  the planner grouped the plan.
- Early architectural boundaries consume the cheap seat; the expensive
  whole-app pass is spent where there is something to see.
- The planner's groups now read as a review plan, so a plan that defers the
  first boundary too long is visible in the plan itself.
- Tests pin the ceiling (mid-group synthetic checkpoint), the skip (no agent,
  recorded pass), and the planner guidance.
