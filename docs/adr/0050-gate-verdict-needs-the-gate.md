# A gate verdict is green only if the gate actually ran

## Context

The spriteforge run shipped with `visual_rounds = -1` (the visual gate never
ran) and one review subprocess that exited non-ok — yet the run log recorded
"review ✓ PASS (minor only)". The mechanism: `review()` mapped a non-ok
invocation into a `ReviewOutcome` with a prose `blocking` field and no
findings; the empty finding set classified as `minor`; the minor threshold
logged a green pass. No transcript existed behind that green line. The same
class of lie lives wherever a gate records coverage for work it did not do:
a configured gate that never fires, or a PASS emitted without the evidence the
gate's prompt demanded.

## Decision

1. **A non-ok gate invocation is infra, never a verdict.** `review()` throws
   the executor's detail instead of returning an outcome; the caller's failure
   ladder retries it, and an exhausted ladder fails the ticket. There is no
   path that records a review pass without a review transcript.
2. **A PASS whose evidence is missing downgrades to inconclusive.** The
   browser-ui interaction smoke's `$SMOKE_PASS` requires both a real user input
   and a render observation in the phase ledger; without them the PASS is
   downgraded to INCONCLUSIVE (never a failure, never green). An HTTP 200 or a
   listening port is startup, not operation.
3. **A gate that did not run reports "not run", never PASS.** The run report
   renders a configured visual gate whose `visual_rounds` is still `-1` as
   "not run"; no overview or report line claims visual coverage without a
   completed round.

The invariant is test-enforced at each seam: a run-loop test asserts no green
review line and a failed ticket for a non-ok reviewer; evidence tests pin the
render-observation rule; the report tests iterate every not-run/not-pass
combination and assert no "PASS" claim.

## Consequences

- A "review passed (minor only)" log line is impossible without a transcript.
- An unevidenced interaction-smoke pass is recorded honestly as inconclusive —
  the run may still proceed (inconclusive is not a failure), but the record
  never says the seat saw something it did not.
- A configured gate that never fires is visible in the report instead of
  reading as part of a finished, fully-covered run.
