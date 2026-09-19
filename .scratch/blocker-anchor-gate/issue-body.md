## Summary

The railhead drives unattended builds on small-context models, so its gates must be mechanical, not prompt-level. A review gate that trusts an unverifiable claim is not a gate.

Today a hallucinated `[BLOCKER]` that verify cannot refute (a non-compile behavioral claim — the ADR 0014 failure class that burned 9 retries) retries the ticket, and can hard-fail it, even when the finding names nothing in the ticket's own diff. `stripCompileClaimsWhenGreen` only covers the compile-hallucination class. This change closes the broader class: a `[BLOCKER]` that names no file (`path` or `path:line`) belonging to this ticket's diff is presumed speculative and downgraded to `[MAJOR]` — the ADR 0005 severity ladder and all retry semantics stay untouched; only the label is moved down the ladder.

## What to build

Mechanics, in dependency order:

1. `changedPathsFromDiff(diff: string): string[]` in `src/reviewer.ts` — parse the `+++ b/<path>` hunk headers out of the diff string. The full diff is already in hand at the review call site (`run.ts:673`), so no new git call is needed, and it works in read-mode and diff-file mode alike. Returns the stripped set of changed paths.

2. `downgradeUnanchoredBlockers(findings: string[], allowedAnchors: string[]): { findings: string[]; downgraded: number }` in `src/reviewer.ts` — for each finding labelled `[BLOCKER]`: if it references any `path` or `path:line` that is a member of `allowedAnchors`, keep it a blocker; otherwise downgrade it to `[MAJOR]`, preserving the finding's original text (the report and retry feedback must still show the claim). `allowedAnchors = changedPathsFromDiff(diff)` plus, when the review ran in read-mode, the reviewer's `files` list — a read-mode reviewer reads whole files and may legitimately anchor on an unchanged call site the change breaks. Path membership only; line numbers are not validated against file length (cheap, robust to hallucinated line numbers).

3. Wire into `processTicket` immediately after the compile-claim strip (`src/run.ts:780-782`), before `severityOf` decides the round. Severity, retry, feedback, and `priorFindings` all act on the downgraded set, matching how the compile-strip already feeds them. Log the downgrade count in the same shape as the existing compile-strip log line: `N blocker(s) downgraded (no anchor in this ticket's diff)`.

4. Consequence by mode (must not regress): in the default `light` mode a downgraded blocker becomes `[MAJOR]`, which soft-passes and notes instead of burning the retry budget — the ADR 0014 cost class is eliminated. In `medium`/`full` the downgraded `[MAJOR]` still retries (those modes buy retries deliberately). An *anchored* `[BLOCKER]` keeps full force and still fails the ticket at the attempt cap. Verify-red rounds are unaffected: `stripCompileClaimsWhenGreen` and this gate are both about trusting the reviewer, never about hiding a real failure.

5. Prompt contract update in `src/prompt.ts` — both diff-review variants (inline and read-mode output contracts, the `$BLOCKING` format blocks) must state: every `[BLOCKER]` MUST name the file (and where possible the line) in this ticket's diff that it is about; a `[BLOCKER]` that names no location in the diff is treated as `[MAJOR]`. This makes the deterministic gate self-consistent with what the model is told.

6. Do NOT extend this gate to the run-the-app corrective path (`processCorrectiveFindings`, `src/corrective.ts`) in this ticket. Visual/goal findings judge the whole app, not a diff, so their anchor ground-truth is fuzzier — a separate design question.

## Files to read/use

- `src/reviewer.ts`
- `src/run.ts`
- `src/prompt.ts`
- `src/reviewer.test.ts`
- `src/run.test.ts`

## Existing contracts to honor

- `severityOf`, `isBlocker`, `stripCompileClaimsWhenGreen`, `splitFindings` (`src/reviewer.ts`) — the gate composes after the compile-strip, it does not reimplement severity
- `$BLOCKING`/`$NITS`/`$OK` verdict markers and the one-finding-per-line format (ADR 0005)
- The `run.ts` review block already computes `diff` (stripped via `stripNonSource`) before invoking `review()`

## Expected new contracts

- `changedPathsFromDiff(diff: string): string[]`
- `downgradeUnanchoredBlockers(findings: string[], allowedAnchors: string[]): { findings: string[]; downgraded: number }`

## Acceptance criteria

- [ ] `changedPathsFromDiff` extracts exactly the changed source paths from a stripped diff (hunk headers, multiple files, no false positives from `--- a/` lines or index lines)
- [ ] `downgradeUnanchoredBlockers` keeps an anchored `[BLOCKER]` a blocker; downgrades an unanchored one to `[MAJOR]` with the original text preserved; treats a prose-wrapped anchor (`"the bug in src/ui.ts:41..."`) as an anchor; treats any one member-match among several references as anchored
- [ ] read-mode reviews pass the reviewer's `files` list into `allowedAnchors`
- [ ] `run.ts` runs the gate after the compile-strip and before `severityOf`; feedback, `priorFindings`, ticket logs, and the console line all act on the downgraded set and report the downgrade count
- [ ] prompt output contracts (both diff-review variants) tell the reviewer an unanchored `[BLOCKER]` is treated as `[MAJOR]` and require a diff location on every blocker
- [ ] verify-red rounds behave exactly as today (no stripping or downgrading when verify failed)
- [ ] a downgrade-only review round soft-passes in `light` mode without burning a retry; an anchored `[BLOCKER]` still hard-fails at the attempt cap (unit tests on `reviewer.ts`; a `run.test.ts` assertion on the light-mode path)
- [ ] every new function has its test beside it in `src/reviewer.test.ts`; `npm test` and `npm run typecheck` are green at the end of this ticket
