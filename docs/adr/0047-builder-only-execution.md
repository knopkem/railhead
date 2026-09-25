# Builder-only execution: the durable session is the only engine

Amends ADR 0001 (fresh subprocess per phase) for the code-writing seat, retires
the ADR 0014 TDD test phase, and removes the `session_builder: false` escape
hatch ADR 0022 left open. Supersedes the ADR 0033 plan-producing diagnosis rung.

## Context

ADR 0022 made the durable session the default builder but kept
`session_builder: false` as the ADR 0001 shape. In practice the flag only ever
selected a worse path:

- The fresh implementer produced incoherent work — each attempt re-derived the
  project from a prompt, losing what earlier attempts had built and fixed.
- The TDD test phase was already inert under the builder (ADR 0022: a test
  author is a fresh phase, and the builder's retries are in-session gate
  feedback), so `test_phase`/`testable` only survived as dead config surface.
- The `$HANDOFF` channel, attempt history, patching/clean-worktree bookkeeping,
  and the capacity prompt-shrink existed to patch the fresh implementer's
  amnesia; under a durable session they were write-only noise at best, and the
  capacity shrink raced the session's compacter at worst.
- The plan-producing diagnosis rung (ADR 0033) was reachable only on the fresh
  path; under the builder a diagnosed failure already routed to
  `builderRecoveryFor` (fresh session from the last green commit).

## Decision

1. `session_builder` and `test_phase` are deleted from `railhead.json`; the
   durable builder session is the only implementer. `createRunState` always
   seeds the builder record.
2. The fresh implementer path is deleted: `buildImplementerPrompt`,
   `runImplement`, the TDD test phase (`buildTestPhasePrompt`, `runTestPhase`),
   `$HANDOFF` parsing, `AttemptRecord`/attempt history, retry-time
   `cleanWorktree`/patching, and the capacity shrink instruction.
3. The plan-producing diagnosis rung and its `TicketState.diagnosis` field are
   deleted. A diagnosed hard failure takes the builder recovery path.
4. The builder's gate feedback always rides the in-session findings prompt
   (`buildBuilderFindingsPrompt`) when a session is held; a fresh seed still
   receives the full seeded prompt with full context blocks.
5. Tickets no longer carry `testable`; the reviewer's red/green evidence
   checklist (issue #45) is deleted with the test phase.

## Consequences

- Every run is one durable conversation per builder checkpoint; corrections
  never cross a context boundary (`$CHECKPOINT` between tickets, findings
  prompts between gate cycles).
- Config surface shrinks: `--tdd`/`--no-tdd`, the TDD prompt, and the
  `test_phase` persistence path are gone.
- The failure ladder still wraps the builder invocation; its terminal classes
  force a fresh session from the last green commit, exactly as ADR 0022 §5
  specified.
- The "reseed after a crash" recovery prompt is the only place a fresh
  implementer-shaped context still exists, and it starts from the repo at the
  last green commit.
