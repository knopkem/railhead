# Code Review Smells — Fowler Baseline

Reference for the reviewer's positive checklist. The reviewer prompt includes a condensed 7-smell list; this document holds the full 12-smell baseline from Fowler's _Refactoring_ (ch.3) with the "when to skip" rules. Expand the prompt list from here when real review gaps surface.

## The 7 smells in the reviewer prompt

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change.
- **Feature Envy**: a method that reaches into another object's data more than its own.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born).
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff.
- **Divergent Change**: one file or module is edited for several unrelated reasons in this diff.

## The 5 deferred smells (not in the prompt — lower frequency on vertical-slice tickets)

- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. Risk: small-model reviewers report every primitive parameter as "Primitive Obsession." Add to the prompt only when a real gap surfaces.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. Rare in the small modules the planner produces; common in legacy code the railhead doesn't generate.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. Caught by the contract-check (an undisciplined message chain usually violates a referenced contract).
- **Middle Man**: a class or function that mostly just delegates onward. Rare in the function-oriented modules the planner prefers.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. Hierarchy-specific; the planner's vertical slices rarely produce inheritance.

## Severity: smells never block on their own (issue #71)

A code smell is a maintainability observation, not a correctness failure. Raising it as `[MAJOR]` made the gate force a full implement → verify → review retry on a non-correctness issue — the "Duplicated Code: triggerDownload appears in two places" finding that burned a 5-7 minute cycle. Rules:

- A smell with no correctness impact is **advisory**: report it under `$NITS`. It is recorded for the report but never blocks the ticket or forces a retry.
- Only raise a smell as a `[MAJOR]` must-fix when it **causes or risks** a correctness/completeness failure of an acceptance criterion — and then say what actually breaks (two copies of a function that can drift is a risk *because* the second copy will be edited independently; that consequence must be named).

## When to skip a smell

Skip a smell when the project's documented standards endorse it. For example:
- A repo that documents "we use primitive obsession deliberately for serialization simplicity" — the repo overrides.
- A repo that documents "we accept message chains in test helpers" — the repo overrides.

The reviewer prompt says: "Skip smells the project's documented standards endorse." The AGENTS.md or a project-level doc is the source of truth for what's endorsed.

## Source

Fowler, Martin. _Refactoring: Improving the Design of Existing Code_, Chapter 3 ("Bad Smells in Code"). The smells are well-vetted; the selection (7 vs 12 in the prompt) is the railhead's judgment for small-model reviewer efficacy.
