# Vision capability is measured, not declared — and a blind seat refuses before the run spends hours

Recorded after the spriteforge run `run-20260915-1449`. Every seat resolved to
the opencode default, a text-only local model. The `--light` preset raised the
visual and goal gates, so for 22 hours the goal reviewer judged the build with
no ability to see it: its transcript says *"image reading is not usable in this
environment"* and *"image reading confirmed NOT usable"*, and its run-end
corrective then misdiagnosed the genuinely broken playback bar — all twelve
controls clipped to zero height by `overflow: hidden` — as a 725px viewport
artifact ("fully visible at 800px"). The bar is broken at any viewport; the
same review wrote "Visual review: not run" and no pixels were ever parsed. The
per-ticket code review passed every ticket, because a diff cannot show a
zero-height container.

## Context

Three separate mechanisms were trusted and all three were insufficient:

- **Declared capability.** `railhead init` probes `opencode models --verbose`
  and only warns (`visionCapabilityWarnings`). spriteforge never re-inited, and
  a declared `modalities.input: ["image"]` is anyway a claim — a provider proxy
  or a swapped local checkpoint can strip image parts behind a
  vision-declaring id. The failure direction that matters is the false
  positive: a seat that *claims* vision and cannot see.
- **A manual diagnostic.** `railhead diagnose screenshots` already tests the
  real chain (about:blank → capture → `read`), but it is manual, browser-only,
  and its pixel check was stale: it greps for `"type": "image"` while current
  opencode attaches the PNG as `{type: "file", mime: "image/png", url:
  "data:..."}` — the spriteforge goal transcript carries exactly that shape,
  so the diagnostic would false-fail a model that did receive pixels.
- **Severity policy.** The goal reviewer did catch the real gap it could see
  through the a11y tree — the canvas toolbar is a non-interactive label, tools
  are keyboard-only — and rated it `[MINOR]`. MINORs never become corrective
  tickets, so it survived a "finished" run.

Failing *after* a plan is its own waste: the plan is the longest single spend
in the railhead (2h in this run). Whatever the answer, it must be known before
the plan starts.

## Decision

### 1. A measured probe, project-agnostic

The railhead generates a PNG at probe time (four side-by-side solid color
blocks in a random order, encoded by hand via `node:zlib` — no dependency a
project's toolchain could lack), writes it under `.railhead/vision-probe/`, and
runs a fresh `opencode run` asking the model to `read` the file and name the
colors left to right. The answer is verified against the generated order, so a
text-only model that guesses fails (four distinct colors: 1/24 by luck); the
prompt never receives the spec, so it cannot leak the answer. This needs no
browser, no app, and no interface declaration — it tests the exact round trip
every reviewing seat depends on, on a terminal, canvas, browser, or no-UI
project alike. The browser capture half stays where it belongs: the existing
`railhead diagnose screenshots` remains the manual, browser-specific check.

### 2. When it runs

- **At init**, for the distinct models behind `implement`, `visual`, and
  `goal` (implement included: a capable implementer should self-check surface
  work with pixels — the spriteforge implementer wrote the invisible playback
  bar blind, and the builder prompt never asked for a visual self-check).
  Init never fails on a probe result: the gates default to `off`, so the
  outcome is recorded and reported, with an explicit warning that a
  vision-dependent gate will be refused later.
- **At every invocation that will use a vision gate** — `build`, `run`, `fix`,
  and `resume` — always re-probed, deduplicated per invocation. A cached "yes"
  is not evidence: the model behind a model id can change (a local server
  restarted with a different checkpoint), so a `railhead.json` fingerprint is
  not sufficient and no TTL is trusted. Cost is one short opencode call
  (~30–60s) against runs measured in hours. In `cmdBuild` the per-gate cadence
  questions (and the TDD question) now resolve *before* the planner call — they
  are static, nothing in them reads plan output — so the refusal precedes the
  plan's multi-hour spend on the interactive path too, not just the
  preset/override path.
- **For the implement seat on a surfaced project** (`browser-ui`/`canvas`), the
  `run`/`resume` start checks only that a current-version record exists,
  probing once when it does not and skipping a model a gate probe already
  covered. The self-check this enables is optional, so it does not pay a
  per-invocation re-probe on every run.

### 3. Refuse, don't degrade

A requested gate (mode ≠ `off`) whose seat model fails the probe throws before
any model work: `vision gate refused: …`. The message names both escapes —
configure a vision-capable model for the seat, or set the gate to `off`.
There is deliberately no silent downgrade and no `--force` override in this
ADR. A seat with no model configured (`null`) and a gate on is the same
refusal.

### 4. The record is a railhead fact, not a learning

Results accumulate in `.railhead/capabilities.json` (keyed by model id + probe
version; corrupt reads as "no record"). The record is injected into the
visual, goal, and implementer prompts as a railhead-authored capability block —
*verified: you receive image pixels; you MUST read every screenshot, and a
blank read is a failure to report* or *measured blind: do not claim visual
verification*. It is deliberately not a `.railhead/learnings.md` line:
learnings are model-authored claims with a retraction channel, and a model
retracting the measurement is precisely the silent opt-out this ADR exists to
stop. A model that contradicts the measurement can only trigger a re-probe at
the next invocation; it cannot change the gate's behaviour.

### 5. The detector is fixed along the way

`toolResultContainsImage` accepts opencode's attachment shape (`type: "file"`
plus an `image/*` mime with payload) in addition to the AI-SDK `type: "image"`
block, and `parseToolCalls` now surfaces `state.attachments`. The probe
verifies the answer, not just the attachment, because an attachment proves the
bytes reached the tool result — not that the model received pixels. Measured
live: `opencode/big-pickle` (text-only) produced an image attachment on the
`read` and self-reported `VISION_PROBE_NOREAD`, while a vision model returned
the colors — an attachment-only check would have passed the blind model.

## Non-goals

- **Auto-degrade or skip.** Chosen against: a run whose goal gate quietly
  turns off is the silent-failure class this railhead rejects.
- **Cache-skip, TTL, config fingerprint.** The probe is cheap relative to a
  run and the model-behind-an-id can change, so re-probing per invocation is
  the honest policy; the record is for reporting and prompt injection only.
- **The screenshot-capture probe in init.** Capture depends on the project's
  interface (`browser-ui`/`canvas`), which is unknown until the planner
  declares `$INTERFACE`; the read probe is the universal half and the capture
  chain stays a manual diagnostic.
- **Implementer visual self-check as a hard requirement.** Probed and
  injected when the seat is verified and the work is surface-scoped (charter
  present / `surface !== false`); a blind implement seat still builds, it just
  cannot claim visual verification.

## Consequences

- A text-only seat can no longer burn a run as the goal or visual reviewer by
  accident: the run refuses in seconds, and the refusal names the fix.
- The spriteforge failure chain — blind goal review → misdiagnosed CSS defect →
  MINOR-severity toolbar gap surviving a "finished" run — has its first link
  cut: the playback bar's pixels would have been read, and the toolbar gap
  would have been judged by a seat that can see it.
- Every `build`/`run`/`resume` invocation with a vision gate pays one probe per
  distinct seat model; resumes included, so a model swapped mid-run is caught.
- `.railhead/capabilities.json` is the first railhead-owned, model-facing
  capability record; later work (retraction-triggers-reprobe, structural
  review seats) can build on the same shape.
