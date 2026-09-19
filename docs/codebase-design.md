# Codebase Design — Deep Modules

Reference vocabulary for module shape. The planner, AGENTS.md generator, and implementer prompts cite this document; workers consult it when module-design questions arise, not on every ticket.

## Why this exists

ADR 0014 commits to minimizing working context per phase to stay in the GPU's fast-band throughput. A worker calling a **deep module** reads ~3 lines of interface, not ~500 lines of implementation. A **shallow module** forces the worker to read the implementation to understand anything, because the interface is nearly as complex as the impl.

The railhead's `railhead.contracts.json` (ADR 0008) is already a deep-module interface catalog — every entry is "here's the small interface; the implementation is its own concern." This document names that idea explicitly so the planner, AGENTS.md generator, and implementer prompts share a vocabulary.

## Deep vs Shallow — the diagram

```
  DEEP MODULE                    SHALLOW MODULE

  ┌──────────────┐               ┌──────────────┐
  │  Interface   │               │  Interface   │
  │  (small)     │               │  (large)     │
  ├──────────────┤               ├──────────────┤
  │              │               │              │
  │  Implementation│             │  Implementation│
  │  (large)     │               │  (small)     │
  │              │               │              │
  └──────────────┘               └──────────────┘

  Leverage: high                 Leverage: low
  Locality: high                 Locality: low
```

A deep module gives callers a lot of capability per unit of interface they must learn. A shallow module provides little capability relative to the interface surface it demands callers understand.

## Glossary

- **Module**: anything with an interface + implementation. A function, a class, a file, a service — scale-agnostic.
- **Interface**: everything a caller must know to use the module correctly. Not just the type signature — the semantics, the invariants, the ordering rules, the failure modes.
- **Seam**: the location where a module's interface lives (Michael Feathers' term). Where a caller crosses into the module. Tests cross the same seam.
- **Depth**: leverage at the interface — behavior per unit of interface a caller must learn. High depth = much capability, little caller knowledge required.
- **Adapter**: a concrete thing that satisfies an interface at a seam.
- **Leverage**: what callers get from depth. More capability per unit of interface learned.
- **Locality**: what maintainers get from depth. Change concentrates in one place (the implementation), not spread across callers (who only see the interface).

## Principles

- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. A module that is hard to test is often shallow — the test must know as much as the implementation.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it.
- **Accept dependencies, don't create them.** A module that constructs its own deps is harder to test (it cements the environment). Accept deps at the seam; let the caller wire them.
- **Return results, don't produce side effects.** Pure functions over mutation where possible. A function that returns a value can be composed; a function that mutates cannot.

## What depth is NOT

- **Depth is not a ratio.** A module with a 10-line interface and 10,000-line implementation is deep. A module with a 50-line interface and 60-line implementation is shallow, despite being "bigger." Depth is leverage — how much the caller gets per unit of interface learned — not implementation-to-interface ratio.
- **"Interface" includes all caller knowledge.** Not just the TypeScript `interface` keyword. The semantics, the invariants, the ordering, the failure modes — all of it is the interface a caller must learn.
- **Distinguish from DDD's bounded context.** "Boundary" is overloaded. Say "seam" or "interface" when you mean the module-level concept; reserve "boundary" for DDD's bounded context.
