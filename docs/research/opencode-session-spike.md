# Spike: opencode session resume + checkpoint markers (#84 S0.1/S0.2)

Executed 2026-09-03, against the live stack (opencode on MTPLX
`mtplx/mtplx-qwen38-27b-optimized-speed`). Blocking de-risk for ADR 0022's
session builder; both stage-0 questions answered, one load-bearing caveat
recorded, one mechanism landed in `executor.ts`.

## S0.1 — session capture and resume

**Where sessions persist.** opencode stores sessions, messages, parts, and
events in SQLite (`~/.local/share/opencode/opencode.db`; tables `session`,
`message`, `part`, `event`, plus `session_context_epoch` / `session_diff`).
Sessions survive process death by construction — a second `opencode run
--session <id>` reloads the full conversation from the DB.

**Capture is trivial.** Every event line in `run --format json` carries
`sessionID` at the top level (verified on `step_start`, `text`,
`step_finish`). The harness reads it off the first line of the first
builder invocation; `state.builder_session_id` follows.

**Continuity verified.** Session A: "reply with just: ok" (replied `ok`).
Second process, `--session <A>`: "What exact word did I ask you to reply
with?" → answered `ok`. Control holds by construction — the question does
not contain the answer; only the persisted history can supply it.

**Resume cost (the number #84 asked for).**

| Path | Wall | Input tokens | cache.read |
|---|---|---|---|
| Fresh session, first step | ~13.2s | 21,077 | 0 |
| `--session` resume, second process | ~3.5s | 21,125 | 0 |

The ~21k fixed scaffold (opencode's system prompt + tools) prefills cold per
fresh session. The warm resume re-prefills it at effectively ~6× the rate —
**the session bank hits, but the hit is invisible to the API's cache
metrics** (`cache.read: 0` on the warm call). Consequence for the harness:
warm-bank benefit is real but unmeasurable through token telemetry;
latency is the only observable signal. Cold-start accounting (~21k per
fresh phase) stays the honest number for budgeting.

**Missing-session semantics.** `opencode run --session <bad-id>` exits 1
with `Session not found` — loud, typed, exactly the signal ADR 0022's
resume path needs to fall back to "fresh session seeded from last green
commit." No silent new-session behavior.

## S0.2 — checkpoint marker stop

**The model complies with the marker contract.** Live prompt: create a
file, then reply with exactly `$CHECKPOINT ticket=01`. Observed stream:
step 1 — `write` tool completes (`reason: "tool-calls"`); step 2 — the
marker arrives **as its own text part** (`"\n\n$CHECKPOINT ticket=01"`),
turn ends `reason: "stop"`, run exits 0 by itself. No re-invocation in the
compliant case.

**The boundary-kill is now generalized and landed** (`executor.ts`): a new
`stopAfterMarker?: RegExp` option gives any stop marker the identical
`verdictEarlyExit` machinery #60 built for visual verdicts — kill at the
next `step_start` after the marker appears, status `ok`, transcript
archived. `stopAfterVerdict` is unchanged sugar over the default verdict
regex. Verified end-to-end through `executeOpendCode` against the live
server: `status: "ok"`, marker in the ledger phase file.

Two seam details worth their bytes:

- **The `g`-flag footgun is guarded at the seam**: `.test()` on a global
  regex is stateful (`lastIndex` advances), which would make the
  accumulating-text check miss a marker emitted in an earlier part. The
  executor de-globalizes any caller-supplied regex.
- **opencode's workspace resolution is not the spawn cwd.** With spawn
  `cwd` set to an unregistered plain directory, the model's `write` landed
  in the parent process's git repo (nearest registered project). Irrelevant
  to harness usage — every real phase spawns with the repo-under-test as
  cwd — but the builder loop must keep that invariant: **always spawn from
  the repo under test**, never a scratch dir.

## Implications for #84 stage 1

1. Builder loop captures `sessionID` from the first stream line; resume is
   `opencode run --session <id> "<findings | next ticket>"`.
2. Failure shape for a lost session is detectable (`Session not found`,
   exit 1) → seeded fresh session from `last_green_commit` + remaining
   tickets.
3. Cold-start cost (~21k tokens, ~8–13s) is paid once per session birth,
   not per checkpoint — the entire economic case for `checkpoint_granularity:
   group|product` over per-ticket fresh phases.
4. The kill is only needed for the non-compliant case (model re-invoked
   past its marker) — same as #60; the compliant case exits on its own.

Raw probe transcripts: not retained (temp-dir spike; numbers above).
