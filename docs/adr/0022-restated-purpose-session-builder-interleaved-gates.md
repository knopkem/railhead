# Restated purpose: unattended verified builds — durable session builder, interleaved gates

> Amended by ADR 0047 (the durable builder is the only engine; the
> `session_builder` flag and the TDD test phase are removed) and by ADR 0048
> (tickets are ordered checkpoints — no DAG, no file/contract declarations).

Amends ADR 0001 (fresh subprocess per phase) and re-scopes ADR 0014 (context
budget disciplines). Records the evidence that invalidated the original
thesis and the architecture that follows from the restated purpose.

## Context

The Railhead's founding premise (ADR 0001, CONTEXT.md): a ~100k-window local
model cannot hold a whole project, therefore phases run as fresh subprocesses
over dependency-ordered tickets, and tickets are sliced so no phase ever needs
compaction — compaction was assumed to cause drift and garbage.

Three pieces of evidence, all from 2026-09-03:

1. **A bare `opencode` session** on the same sprite-editor prompt that the
   Railhead failed on (pixeledit-night-1) produced a complete working app in
   under 3 hours, compacting several times along the way, watched but not
   steered. It outperformed every Railhead attempt on that prompt — in less
   time.
2. **The pixeledit-night-1 post-mortem** (#75–#82) showed the Railhead's
   observed failures were largely self-inflicted (implementer visual
   self-check prompting, OOM misclassified as transient, stale context
   metering, a planner whose conflict warnings gated nothing), and exposed a
   structural fact: the server's KV pool is shared with retained dead-session
   state that no railhead-side ledger observes.
3. **The mechanism for why compaction survived:** the repo is the durable
   state, not the conversation. A coding agent re-grounds itself from files
   continuously; compaction loses narrative, not work product. Compounding
   summaries over an hours-long session is a real risk, but commit-interval
   checkpoints — not per-phase context amnesia — are the cheap bound on it.
   ADR 0014's own fill-gradient is pro-compaction economics: each compaction
   resets the session to the fast band.

Constraint that shapes everything: the target user runs ONE context-limited
server (~100k tokens, e.g. MTPLX on 16–32GB). There is no headroom for
concurrent inference — gate phases cannot run in parallel with the builder.
(Phases already execute sequentially in the Railhead today; the constraint is
already satisfied. It only rules out designs that would need parallelism.)

## Decision

### 1. The purpose is restated

The Railhead does not exist to avoid compaction. It exists to deliver
**unattended, verified, resumable builds with bounded blast radius**: gates
(test, verify, review, visual, goal), the ledger, per-checkpoint commits, and
the failure ladder. The context strategy is a means; gates are the product.
The bare-session result is not a refutation of that purpose — it is a
demonstration that the *builder* should be a session, and the Railhead's value
must live in the walls around it.

### 2. The builder is a durable session; gates are fresh phases; they interleave

- **Builder**: one opencode session, resumed across invocations
  (`opencode run --session <id>` — verified to exist; sessions persist to
  disk and survive process death). Compaction inside the builder is expected
  and permitted — it is the builder's context manager, not an error.
- **Checkpoints**: ticket boundaries. The builder prompt instructs: when the
  current ticket's criteria are met and the build and tests pass, emit a
  checkpoint marker and stop. The executor already has the machinery to stop
  at a streamed marker (the `stopAfterVerdict` seam, `executor.ts` issue
  #60) — reuse it for checkpoint markers. The builder process exits at the
  checkpoint. Freeing the process loses nothing: the session is durable on
  disk, and on session-bank servers (MTPLX, vLLM prefix caches, llama.cpp
  cache-reuse) the resume re-prefills warm or at worst once, bounded.
- **Gates**: run between builder invocations as fresh, diff-scoped phases —
  exactly the prompts of today. Reviewers see ticket + diff + contracts,
  never the builder's whole session; their prefills are small by design, so
  they fit a small server. Gates never run concurrently with the builder:
  sequential interleaving is the single-server contract.
- **Findings re-injection**: the builder's resume input is the gate's
  verdict — review findings, visual blockers, corrective instructions land
  *in context*. Corrections do not spawn a fresh explorer that re-reads the
  repo; the session that wrote the code receives the feedback. This kills
  the handoff/catastrophic-replacement class of bug (#61, #66, #67) for
  in-session corrections: there is no context boundary to lose findings
  across.

### 3. Git is the durable checkpoint; the session is disposable

At every green gate, commit. If the session drifts, corrupts, or dies at
hour six, the loss is bounded to the narrative since the last commit — the
work, the tickets, and the ledger survive. Resume-recovery: spawn a *fresh*
session seeded with "committed through ticket N; remaining tickets: …" plus
the contracts index. The catastrophic case (bare session drifts with no
checkpoints) and the old catastrophic case (fresh phases with no working
context) are both avoided by this split.

### 4. Granularity is a knob, degenerating to the user's extreme

`checkpoint_granularity: ticket | group | product` (default `product` — the
#83 head-to-head settled the default; see Consequences).
`product` is exactly the "build the whole thing in one session, add the
gates" mode — a valid configuration of this same architecture, not a
separate design. Gates still fire per ticket; only the builder's process
lifetime changes (one resume-free run between commits is the `product`
degenerate when the builder holds up — compaction is its manager).

### 5. What is amended where

- **ADR 0001**: fresh-subprocess-per-phase is *retained for all gate and
  judgment phases* (small, diff-scoped, fresh context is their feature) and
  *relinquished for the builder* (durable session + compaction + commits).
- **ADR 0014 / #81 / #82**: the request ceiling and live in-flight metering
  remain load-bearing for **gate phases** (their prompts must fit a
  possibly-warm pool — the fraction rule stands). For the **builder**, the
  ceiling stops being a kill switch and becomes telemetry: opencode's
  compaction owns fill management; the railhead's kill guards would only
  race the compacter. The #78 throughput floor remains the builder's health
  check (0 tok/s for minutes = thrash, kill and resume).
- **ADR 0018 (digest) / contracts index**: stop being the builder's only
  memory; remain gate-prompt inputs and the fresh-session resume map. Issue
  #106 pins the cadence: the builder's advance prompt carries the FULL
  contracts/learnings/digest content only on a fresh seed/restart or after an
  observed compaction (the session's earlier copy was summarized away);
  otherwise it rides standing file pointers (the learnings pointer plus the
  checkpoint retraction grammar keep the ADR 0013 retraction channel open).
  Per-resume full re-injection is the N-copy duplication a durable
  conversation accumulates until compaction — it is not the intended scope of
  this ADR's "resume map" role.
- **Tickets**: stop being context units. Remain plan units, checkpoint/gate
  boundaries, the resume map, and the audit trail. The DAG, Frontier, and
  ordering survive unchanged.
- **ADR 0016 (resume)**: extends to session handles — resume re-attaches
  the builder session by id, falling back to fresh-session-from-commit when
  the session is gone.

## Consequences

- Per-phase context capacity stops being the Railhead's quality lever — the
  compacting session carries more working state than any sliced phase ever
  will, and that is accepted. Seam-loss between tickets within a session
  disappears; seam quality now matters at exactly two places: gate prompts
  and fresh-session recovery.
- Self-inflicted Railhead failure modes shrink to the gates themselves; the
  builder can no longer be sent into a 4-hour visual loop by railhead prompt
  scaffolding (the #75 class), because the builder prompt is a thin
  "implement these tickets, checkpoint when green" contract.
- The #80 failure ladder re-scopes: for the builder, capacity failure at
  high fill means force-compaction or fresh-session-from-last-commit (not
  prompt-shrinking); the worker-restart rung is a bounded no-op on
  content-keyed session banks and a real fix on session-affinity servers.
  The ladder remains the response machinery for gate phases unchanged.
- Single-server users lose nothing: seats were already sequential; gates
  are small by construction; the builder resume costs at most one re-prefill
  per checkpoint (warm on session-bank servers).
- Risk carried: in-session corrections let the builder *argue with*
  findings; the Gate's bounded retry counters (#70) remain the bound. Very
  long builds compound summaries inside one session; commit checkpoints cap
  the damage. The head-to-head (issue #83) settled the builder as the
  shipped default at `product` granularity (the ADR 0001 shape remains
  available via `session_builder: false`), accepting that long single-session
  builds keep this compounding risk.
- If that head-to-head shows the bare compacting loop also wins unattended
  at multi-session scale, the Railhead's correct final shape is *still* this
  ADR — gates, ledger, and commits around session execution — so the design
  is also the hedge.

## Open questions

- **Session-resume spike (blocking)**: confirm `opencode run --session <id>`
  re-attaches in another process with the full server-side behavior we rely
  on (disk persistence verified; warm-bank resume cost to measure), and that
  the railhead can capture the session id from the builder invocation's
  event stream.
- Whether the TDD test phase stays a pre-ticket fresh phase (findings
  injected into the builder's resume input as today's `$HANDOFF`) or moves
  in-session; lean pre-ticket — the test author should stay an independent
  oracle (ADR 0014's reasoning survives restatement).
