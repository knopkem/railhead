# Railhead Roadmap — borrowings from Ticketsystem

Not a spec; a backlog of hardening candidates for this Railhead, each borrowed from a real production system (`andreasknopke/Ticketsystem`) that already solved the same core problem this Railhead exists for: running a small-context LLM through a multi-step build safely and verifiably. Ticketsystem runs it human-gated and per-ticket-to-PR; we run it unattended and per-commit. The tactics below are the parts worth porting.

For each candidate: what it would add, what problem it solves, how it maps to Ticketsystem, and the current behavior it changes.

---

## T1 — Two-pass planner (`candidate_files` → content → plan) — DEFERRED 24 Aug 2026

**Borrow from:** Ticketsystem `AI_PLANNER_TWO_PASS` + `githubContext.js`.

**Problem:** Today the Implementer prompt ships the ticket + docs and tells the model to read files itself. A small model self-navigating a large repo wastes context and often targets the wrong file.

**Change:** Add a planning pre-step before the Implementer. Pass 1: model names `candidate_files` it expects to touch (low context). Railhead resolves+reads those files from the repo. Pass 2: model receives the real file contents and produces the concrete edit plan. This is a new phase between `frontier` and `IMPLEMENT`.

**Priority:** ~~High~~ Deferred — see "Status notes" below.

## T2 — File whitelist / boundary files — DEFERRED 24 Aug 2026

**Borrow from:** Ticketsystem `codeChecks.js` + `REPO_BOUNDARY_FILES`.

**Problem:** The Implementer (a code-writing agent) can edit any file, including unrelated or generated ones; the Reviewer catches drift but only after spend. Unattended hours compound the risk.

**Change:** Let the ticket or `railhead.json` declare an allowlist of file globs the Implementer may touch (defaulting to "anything in the working tree"). Downstream, `verify` + a pre-commit check refuse commits that touch files outside the perimeter. Boundary files (schemas, routes, entity registry) are injected verbatim as authority, like Ticketsystem's `REPO_BOUNDARY_FILES`.

**Priority:** ~~High~~ Deferred — see "Status notes" below.

## T3 — PII/secret redaction before every AI call

**Borrow from:** Ticketsystem `redact.js`.

**Problem:** Runs can be driven by hosted providers (`deepseek`). The repo may contain tokens, keys, IPs, PII that leak into a third-party context window. Each Implementer/Reviewer invocation is a fresh OpenAI-compatible call, so reform is cheap to interpose.

**Change:** A redaction pass over the outgoing prompt, with a configured pattern set (plus the ability to extend via a file), and a note in the transcript that content was redacted.

**Priority:** Medium-High (matters only while providers are hosted; degrade to skip when calling a fully local model).

## T4 — Supersede/rollback recording on re-run

**Borrow from:** Ticketsystem keeps superseded workflow steps visible in history instead of overwriting.

**Problem:** Our retry loop currently rewrites a ticket's attempts, losing a clean record of "what a rejected attempt looked like."

**Change:** Keep every attempt's transcript as its own `events/<NN>-<NN>-implement.jsonl` (already the case) *and* persist a short verdict line per attempt (`implement → verify → review → retry`), so the Ledger reads as a decision history, not just a log chunk. No structural change; mostly a reporting/`report.md` improvement.

**Priority:** Low (nice audit-trail hardening).

---

### Suggested sequencing

Independent enough to keep as a frontier-parallel set, but T1 and T2 touch the same core loop so land them as one combined ticket or back-to-back. Order: **T2 (whitelist) → T1 (two-pass) → T3 (redaction) → T4 (supersede record)**. T2 first: it is the cheapest safety win and de-risks the other three. _(Note: T1 and T2 are currently DEFERRED — see Status notes; the sequencing applies once re-raised.)_

---

## Status notes (24 Aug 2026)

T1 and T2 were demoted and their ticket stubs (`.scratch/harden/`) removed after changes landed that address the symptoms they targeted:

- **T1 (two-pass planner):** The named-files premise is already the planner's job — each ticket's `files:` array points the implementer at exact paths, so a separate "Pass 1: name candidate files" phase would duplicate work the planner already does. The context-waste symptom it targeted is further reduced by the planner-fusion rule (small builds collapse to one ticket, `src/plan/plan.ts`) and the patch-don't-rewrite feedback path (the implementer reuses its prior diff on review-retry, `src/context/prompt.ts`). Re-raise only if a real run shows the implementer misreading files *despite* the ticket naming them.
- **T2 (file whitelist):** The reference-injection half ("boundary files as authority") is subsumed by the contracts index (`src/core/contracts.ts`, ADR 0008): tickets declare `references`/`introduces` and the implementer prompt already receives the relevant slice verbatim. The hard-perimeter half remains speculative — no observed run has shown the implementer editing files outside its ticket's `files:` list. Re-raise as a real ticket only if a large multi-ticket run exhibits file scatter.

T3 and T4 are retained as-is.