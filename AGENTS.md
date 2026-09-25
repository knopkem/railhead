# AGENTS.md

Guidance for agents working in this repo. Read `CONTEXT.md` for the domain vocabulary (Railhead, Ticket, Run, Ledger, Gate, Frontier, Committed, Builder, Reviewer) — use those words exactly.

## What this is

A CLI (`railhead`) that drives `opencode` over an ordered queue of **Tickets** (see `CONTEXT.md`). One durable Builder session writes the code across ticket checkpoints; each ticket runs build → verify → smoke → commit, with the judging phases as fresh processes — a plan gate before any build starts, an interaction smoke at group boundaries, and goal/structural reviews at checkpoints and run end. The auto-extracted `railhead.contracts.json` index keeps judging context O(ticket), not O(project).

## Project map

`src/` is split into modules; each has its own `AGENTS.md` with the interfaces and invariants local to it. Read the root file for the rules, then only the module you are about to touch.

- `src/core/` — run/ticket model, ledger, contracts index, ticket parsing, git/model/asset adapters. The foundation; no phase runs here.
- `src/config/` — `railhead.json` shape and defaults, CLI arg parsing, gate-cadence policy.
- `src/plan/` — the two-call planner (design → tickets), plan parsers, sharpen interview, plan identity.
- `src/context/` — model-facing text: prompt builders, builder prompt, learnings, digest, coherence, summaries.
- `src/execute/` — run loop, opencode subprocesses, verify/smoke, failure ladder, builder units, vision probe.
- `src/gates/` — review gates: code/visual/goal/structural, evidence, corrective tickets, replan.
- `src/cli/` — command dispatch and terminal output.

## Standards

- **Modern, typed TypeScript** (ESM, NodeNext). No classes unless a stateful object genuinely needs one; prefer pure functions. `strict` typechecking.
- **Small, deep functions.** One responsibility each; name them for what they do and return, not how. Avoid boolean-parameter APIs.
- **No comments** that restate code. A comment earns its place only for a reasons-choice a reader can't recover (a trade-off, a NON-obvious invariant like *a fresh subprocess per phase exists to keep context O(ticket)*). Read `docs/adr/` — decisions live there, don't duplicate them.
- **Errors are thrown**, not swallowed. Prefer typed, descriptive messages. Guard the edges: a corrupt JSONL line, a missing ticket file, a non-git cwd.
- **Everything is green every step** (ADR 0006): the verify suite runs after every committed ticket, so never add a check that only passes after later tickets.
- **Technology-agnostic.** The railhead drives builds in any language. Never hardcode language-specific advice (Rust crates, npm packages, specific compilers) into prompts or logic. Refer to "the build command," "dependency caches," "the package manifest" — not `cargo build`, `~/.cargo/registry`, or `Cargo.toml`. The only place language-specific knowledge belongs is the project's own `railhead.json` (verify/smoke commands) and the tickets the planner generates.

## Testing — non-negotiable

The pure-logic modules carry the risk (parsing, ordering, merging, extracting); they get unit tests first. Real `opencode` subprocess runs are integration and are not part of `npm test`.

- Put each test beside its module: `src/core/foo.ts` → `src/core/foo.test.ts`.
- Cover the boundaries that actually regress: the lossy parsers (`parsePlanJson`, `extractContractsBlock`), robustness against malformed model output (mid-array garbage, truncation, prose-wrapped), round-trips (`renderTicket` → `parseTicket`), and ordering (`numberTickets`).
- A failing test is a bug report; make it assert **why**, not just that a function returns.

## Commands

```sh
npm test          # vitest — run the suite (this gates every commit)
npm run typecheck # tsc --noEmit
npm run lint      # tsc --noEmit (typecheck is our lint; add eslint only if it earns its load)
npm run build     # esbuild-bundle src/cli/cli.ts -> dist/cli.js (plain JS; run by `prepare`, no loader needed at runtime)
```

## Workflow

- Prefer red-green-refactor: write the failing test for a behaviour, make it pass, then tidy.
- Keep `AGENTS.md` and `CONTEXT.md` lean and accurate; a module's `AGENTS.md` describes its interface and invariants, not its implementation. The ticket parser and the planner prompt are coupled to the ticket format (ADR 0007) — changing one means changing the other.