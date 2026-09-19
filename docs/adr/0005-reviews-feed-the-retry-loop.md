# Reviewer findings feed the retry loop

The Reviewer is not a terminal verdict: its blocking findings are fed back as input to the next Implementer attempt of the same Ticket. Review is therefore part of the Ticket's Gate and its engine of iteration. The Reviewer is read-only (`edit: deny`), runs in a fresh context, and defaults to the same model as the Implementer (configurable) so one local model can run an entire unattended Run for hours.

## Iteration is bounded and severity-aware

The retry loop is gated two ways:

- **Budget:** `max_review_retries`/`max_retries` count *unproductive* rounds (regressions + verify failures). Distinct, actually-fixed findings reset it, so a chain of separate bugs each correctly fixed cannot silently exhaust a small model.
- **Absolute cap:** `max_attempts` (default `max_retries * 3`) bounds total attempts regardless of resets, so a ticket cannot loop forever on a steady stream of "improvements".

Each blocking finding is labelled `[BLOCKER]` (the ticket is actively broken, unsafe, or misses a criterion) or `[MAJOR]` (a real gap, but the ticket essentially works). At the attempt cap:

- Any `[BLOCKER]` still present → the ticket **fails**.
- Only `[MAJOR]` findings remain → the ticket **soft-passes**: it commits with the residual findings logged, and downstream tickets proceed.

Feedback to the next Implementer lists only the still-open must-fix items, plus a read-only "already-resolved" note so the implementer does not reintroduce them without being told to re-fix resolved work. NITs are ignored: review exists to confirm the task is complete and works, not to police code style.