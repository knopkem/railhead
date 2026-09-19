## Summary

A **model-authored test can be unsatisfiable**, and when it is, the implementer grinds to the step cap: "fix the impl" can't help, and the model can't see past its own assumption. Observed in product-mode builder (same session authors impl + tests), but the caveat applies to TDD too — an independent test author using the *same weak model* can write an equally unsatisfiable test. The real gap is that there is **no reconciliation path**: nothing re-derives the test (or the AC) from the one artifact the model did not write — the human spec.

Observed cost: ticket 03 burned two attempts / ~2 hours on one indexing bug in a test, ending in a full 80-step budget kill.

## Evidence (run `run-20260909-1501`, spriteforge-lane-c, ticket 03)

- `src/model/history.test.ts` (authored by the builder in-session) had an **off-by-one** in its undo/redo walk: it compared the k-th `undo()` result to `chain[k]`, but undo returns the doc that was current *before* that push (`chain[k-1]`). Every step reported `deep mismatch` no matter how correct `History`/`document.ts` were. The terminal `undo() → null` was also logged as a failure, so the test could never pass even with fixed indexing.
- No production change could satisfy the test. The model then rewrote the **same test file** four times to near-identical content, reverted it via `git checkout`, and degenerated into scratchpad `node -e` re-implementations of a `History` class until the 80-step cap killed the phase and the ladder retried identically.
- The production code was in fact fine — after fixing the test's indexing the full verify list (`typecheck` + `build` + `npm test`) is green. The bug is a bookkeeping error (off-by-one in a loop), not a misreading of the AC, so a separate TDD test author *could equally have written it*.
- **Related drift (checkpoint-protocol skip):** in the same run, a resumed 03 phase ended with the model writing prose *"Ticket 03 is green and checkpointed. Starting ticket 04…"* and, in the SAME turn, writing `src/model/pixels.ts` (ticket 04's first file) — with **no `$CHECKPOINT ticket=03` terminal line at all**. The phase correctly never ended ("03 build" label, ticket still `in_progress`), but the model believed it had checkpointed and jumped ahead into 04 work inside the 03 phase. If it later emits `ticket=04` the gate rejects (`expected ticket=03` → another resume); if it emits `ticket=03` the commit sweeps the premature 04 file into 03.
- Adjacent context: the first attempt at ticket 03 was wasted by the loose `$CHECKPOINT` substring kill (a prose mention of the marker format) — already fixed separately via the terminal-anchored `endsWithCheckpoint` latch.

## Root gap

Three layers:

1. **Product mode hides contradiction.** The same session writes impl and tests to be mutually consistent, so when its own test is wrong there is no visible tension to step back from — the model's first instinct is to "fix" the production code, then to rewrite the test itself (self-approval) rather than question it.
2. **Separation of authorship is not correctness.** Turning TDD on gives the failing test a different author, but that author is the *same weak model* reading the same plan AC. If it misreads the AC, or writes a buggy test (as here), the implementer faces an equally unsatisfiable test and is told not to weaken it.
3. **The checkpoint protocol is conversational, not enforced.** The model can "announce" a checkpoint in prose and keep working into the next ticket; nothing mechanical stops it short of the terminal marker, and the product-mode prompt itself pre-lists all later tickets in "Work to do", which invites the jump-ahead.

The only anchor in the system the model cannot re-derive from its own head is the **human spec** (`prompt.md`). Plan ACs are themselves model paraphrases and can be wrong too. So the crux is: when verify fails on tests, who re-derives ground truth, and from what input?

## Proposed remedies (reweighted; not mutually exclusive)

1. **Spec-anchored test reconciliation (primary, applies to both product and TDD modes).** When verify fails on tests and the implementation looks plausible, run a bounded reconciliation: input = the **spec section verbatim** + the failing test names + the impl diff, with the explicit instruction *"the implementation may be correct and the test wrong (e.g. an off-by-one in a walk loop); reconcile the test against the spec, not against the AC paraphrase."* Same 27B is decent at fixing a specifically-flagged off-by-one when handed the spec; it is hopeless free-grinding against its own assumption. This also catches wrong ACs.
2. **Independent test-author phase (TDD) for testable tickets in product mode.** Its value is **attribution, de-correlation and the do-not-weaken guard**, not a correctness guarantee: a fresh context reading only AC + seams is less likely to share the exact same misunderstanding as the implementer, and a test from a different phase gives the failure an obvious direction ("the test is suspect") instead of a self-authored dead end. It does *not* eliminate remedy 1's need.
3. **Make do-not-weaken mechanical.** Diff the tests authored by another phase (or earlier in the session) at the phase boundary; flag rewrites that change what the test asserts. This closes the self-approval loop (rewriting your own test to pass) that made verify a non-oracle in this incident.
4. **Fail fast, attribute loudly.** An unsatisfiable test should end the ticket at `max_retries` with a clear "test/AC conflicts with spec" signal (and feed remedy 1), not burn the full step budget across multiple near-silent attempts.
5. **Non-convergent-edit detection.** The executor already detects spin loops (3 consecutive *identical errored* tool calls). Extend to successful-but-identical rewrites — N+1 write of the same file with near-identical content within a phase — and raise a distinct "non-convergent edit loop" verdict instead of burning the remaining budget.
6. **Blame-aware verify feedback.** When verify fails, tell the builder which failing test files it authored this phase and that those are candidates for a *test bug* before it rewrites production code.
7. **Product-mode prompt shape: don't pre-list later tickets.** The builder's "Work to do" currently shows the whole remaining queue (`03…15`) before ticket 03 has checkpointed. Surface only the CURRENT ticket's block until its checkpoint fires; the railhead advances the visible queue per checkpoint/resume. Removes the structural invitation to "announce" a checkpoint in prose and jump ahead, and makes a missing terminal marker immediately visible (the model would be staring at the same ticket with no way forward except the marker).

## Severity / scope

Any mode where a weak model authors tests — product, group, or TDD with the same model grade — can produce an unsatisfiable test with no reconciliation path. Remedies 1 and 3–7 are railhead-only; remedy 2 changes run shape but should not be treated as a fix on its own.
