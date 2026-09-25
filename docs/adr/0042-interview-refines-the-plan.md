# The planning interview refines the plan (post-plan, plan-aware)

> Amended by ADR 0049: the `$PLAN` block is removed; the interview revises the
> `$VERIFY`/`$INTERFACE`/`$SMOKE`/`$DESIGN`/`$ARCHITECTURE` output, and the
> sequence below still holds otherwise.

Amends ADR 0010 (plan-time sharpening). Recorded after ADR 0041 made the plan
reviewable. The interview used to run before the planner, with the raw prompt
as its only source, and its Q&A transcript was folded into the planner's user
message. Two problems surfaced in use:

- The interview could not see the plan, so it asked generic scoping questions
  the planner would have answered anyway, and could not challenge what the
  plan actually decided. The prompt-only transcript then silently shaped the
  plan in ways the user never reviewed.
- Once the plan exists (with `PLAN.md`), the highest-value questions are the
  ones that target the plan's weak spots — an unresolved fork, a vaguely
  treated quality demand, an undecided mechanism. Those are only visible with
  the plan in hand.

A CLI run also made the y/n question confusing: it read as "run this before
planning?" when what the user wanted was "let me refine the plan with your
answers."

## Decision

### 1. Build-mode interviews are post-plan and plan-sourced

`sharpenSystemPrompt` gains an optional `planText`. When present, the prompt
includes the plan as authoritative and reframes the task: refine an EXISTING
plan, ask only questions whose answers would materially change it, never
re-ask what the plan already decides. A plan with no open forks correctly
produces zero questions. `runSharpenSession` threads `planText` through.

### 2. Answers revise the plan through the ordinary revision path

`renderPlanInterviewAnswers` renders the Q&A as decisions the revised plan
must honor; `buildPlanRevisionPrompt` gains a `source` — `"coverage-audit"`
(default) or `"planning-interview"` — that frames the findings correctly. The
interview's output is fed through the same full-re-emit revision, so the
plan's blocks stay the single source of truth. The sequence in build mode is:

    design ($PLAN/$DESIGN/$ARCHITECTURE)
      -> interview (prompt + plan) -> plan revision
      -> coverage audit (auto) | skipped for user review (interactive)
      -> ticket decomposition -> gate -> PLAN.md -> user review loop

### 3. Fix mode keeps the pre-plan interview

A bug report has no plan to refine; the reproduction interview stays exactly
as ADR 0010 defined it, folded into the planner prompt.

### 4. Resolved terms/decisions still land during the interview

`CONTEXT.md` and `docs/adr/` writes are unchanged. `CONTEXT.md` is the
glossary the planner and the implementer/reviewer prompts read; the ADRs are
repo documentation (the railhead never reads them back). The CLI question is
reworded to say what the interview now does.

## Consequences

- Interview questions are materially plan-changing or absent; the revision
  phase is ledgered as `plan-revise-interview-1`.
- Auto runs refine the plan from the model's own recommended answers when the
  preset runs the interview; `--light` still skips it entirely.
- The CLI owns the session and the prompting (`interviewPlan` callback); the
  planner owns the revision, symmetric with the user-review loop (ADR 0041).
- An interactive run that enables the interview answers questions about the
  concrete plan, then reviews `PLAN.md` — the free-text loop remains for
  anything the structured questions missed.
