# A clean no-DONE exit with a non-empty worktree is gated, not wiped

> Amended by ADR 0047: the `session_builder` flag is removed; the durable
> builder is the only engine, so its exemption below is the only path.

The DONE marker is a protocol signal, not the quality oracle. The quality
oracle is the Gate — verify, then smoke/review. A no-DONE exit is ambiguous
between two shapes that only the worktree can tell apart, and the reaction
must split on that, not on the marker's presence alone.

## Context

An implementer that exits cleanly (`status ok`, code 0) without ever emitting
the `DONE` marker used to be treated as a single shape: "the model stopped
mid-work" — fed back as an unproductive attempt and retried from a clean tree.
The retry ran `cleanWorktree` (`git reset --hard HEAD` + `git clean -fd`),
stashing the working diff first so a later attempt could read it back as
`priorDiff`.

The SpriteForge-14 run showed that classification is wrong half the time. The
implementer did all the work — typecheck/build/tests green (exit 0), browser
checks done — and closed with a long prose summary whose last word was "Done."
(after "…scope."), not the exact `DONE <files>` sentinel. Step reason was
`stop`; the process exited 0. The railhead read "no DONE" and wiped a complete,
verified ticket. The worktree reset to ticket 13's commit; ticket 14's work
survived only as a stash diff. The model's own verify had passed; the railhead
never ran its own because the no-DONE exit bypassed the Gate entirely.

The pre-existing safeguard — stashing the diff and feeding it back as
`priorDiff` — mitigated the loss (the next attempt did not start blind) but
could not prevent it: a green, gateable tree was still destroyed and a fresh
implementer regenerated it from a text patch instead of the Gate judging the
real tree.

## Decision

On a clean exit without DONE, the run loop inspects the worktree before
deciding:

- **Empty worktree** (no changes outside protected paths) → genuinely stopped
  before producing anything. Keep the old reaction: log, feed back, retry from
  a clean tree.
- **Non-empty worktree** → the implementer did real work but skipped the
  marker. Do NOT wipe. Log the missing marker, then **fall through into the
  normal Gate** (verify → smoke → review → commit) on the existing tree. The
  missing DONE becomes a log note, not a work verdict.

This is safe because every downstream gate still runs unchanged:

- If verify fails, the tree is genuinely broken and the ordinary
  verify-failure path (wipe + stashed-diff feedback) takes over — the fix only
  protects green trees.
- If verify passes but review finds the work incomplete against the ticket's
  acceptance criteria, the ordinary review-retry path preserves the tree
  (`patching = true`) and sends findings back. A green-but-incomplete tree is
  still caught; it just is no longer destroyed first.
- The commit that finally lands is the one the Gate approved, identical to a
  DONE'd ticket's commit.

The durable-session builder (`session_builder`) is exempt: its `ok:false`
shape in this branch is a no-checkpoint-marker exit whose recovery is "resume
the session and drive it to the checkpoint", never a gate on half-built work.

## Consequences

- A complete-but-marker-less ticket (the SpriteForge-14 shape) commits instead
  of being destroyed. No work loss, no wasted regeneration.
- A genuinely empty no-DONE attempt still retries exactly as before.
- A broken no-DONE tree still gets wiped and retried with its stashed diff
  fed back — unchanged behavior for the shape the old workaround was built for.
- The stash/`priorDiff` workaround remains as the safety net for broken trees
  (verify/smoke/review failures), where a clean retry is still the right call.
- The discriminator uses the same protected-path filter as `cleanWorktree`'s
  stash decision, so "what counts as work worth keeping" is consistent between
  the gate and the wipe.
