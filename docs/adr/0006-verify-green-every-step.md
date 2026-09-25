# Verification must be green at every committed step

The Railhead runs the same `verify` commands after every Ticket, and each committed Ticket is one git commit on the shared branch. So `railhead.json` must contain checks that pass after *every* committed Ticket, not only after the final one. A suite that asserts a future feature will fail on the intermediate commits that legitimately lack it. Acceptable-criteria specifics belong to the Reviewer; `verify` should stay a baseline (loads, lints, typechecks, existing tests) that each vertical slice keeps green.

> Amended by v2 issue 01: verify runs only the tests that already exist during
> the build. The planner writes criteria as observable behaviours (never
> "(test)" asks), so the builder is not asked to author tests mid-run and
> every committed step stays green by construction. A final hardener ticket
> appended after the planned frontier transcribes the run's CONFIRMED probe
> behaviours into the project's own test stack at the end; from then on verify
> covers them like any other existing test.
