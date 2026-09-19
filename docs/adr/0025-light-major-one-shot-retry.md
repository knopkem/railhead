# Light code review: MAJOR findings get one corrective attempt

Amends the issue #73 light-mode retry threshold (ADR 0021) and the issue #71
severity rules' teeth. Recorded after a real run shipped a [MAJOR] that should
have been fixed: spriteforge-spark ticket 06's reviewer found that the editor's
pointer handlers sat on `wrapper` and swallowed toolbar clicks (the exact
user-reported symptom: "toolbar not clickable, mouse still in editor mode"),
marked it [MAJOR], and light mode soft-passed it with zero corrective attempts.

## Context

Light is the default mode and is meant to be fast: per-ticket code review that
retries only on [BLOCKER], with [MAJOR]/minor noted and shipped. The gate is
not blind — it flags real issues — but the severity threshold converts a
correct [MAJOR] into a no-op when the model under-severities a genuine defect.

The obvious fix — treat MAJOR like BLOCKER in light — is wrong for the stated
goal. medium/full feed MAJORs to the retry budget machine, and the observed
failure mode there is a mis-severitied near-minor issue burning up to the
retry budget in repeated implement→verify→review rounds. Light exists to avoid
exactly that stall.

## Decision

Light mode gives a [MAJOR] finding **one** corrective attempt per ticket:

- A review round whose highest severity is [MAJOR] triggers one
  implement→verify→review round (instead of zero).
- If the MAJOR (any MAJOR — the same one or a new one) is still standing on
  the re-review, the ticket soft-passes: committed with the residual findings
  named, never hard-failed, no further budget burned.
- The one-shot is counted per **ticket**, never per distinct MAJOR: a fresh
  MAJOR each round must not chain fresh retries. That is the #70 discipline —
  the gate machine's never-reset `reviewRounds` is the existing expression of
  "distinct findings ≠ progress" for a model that cannot remember what it
  tried, and a per-finding retry count would reopen the churn it bounds.
- A [MAJOR] that the retry machine would otherwise hard-fail in light (budget
  already hot from earlier rounds) collapses to a soft-pass: light's contract
  is "never let a MAJOR fail the run", unchanged from before, now explicit.
- [BLOCKER] behavior is unchanged in every mode: full retry budget, hard-fail
  if one survives the cap.

BLOCKER and MAJOR in the same round are unchanged: both are reported to the
implementer; the BLOCKER drives the retry with the full budget (the MAJOR
rides along and does not separately consume the one-shot).

## Consequences

- A real-but-not-blocking gap — the pointer-capture class — gets one bounded
  fix shot in the default mode, then ships with the residual named in the run
  summary instead of shipping silently as a green PASS.
- Worst-case cost in light is one extra implement→verify→review round per
  ticket that ends MAJOR-only, and zero extra rounds when a MAJOR is fixed or
  when the ticket also carries a BLOCKER.
- medium/full and the `severityTriggersRetry` threshold are unchanged; the
  one-shot is orchestration in `run.ts`, deliberately not a config surface —
  `mode` remains the knob.
