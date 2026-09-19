# The Railhead owns the ticket format and the plan step

The Railhead is both the producer and the consumer of tickets: `railhead build` writes them and `railhead run` parses them, and the format lives in this repo (`src/plan/plan.ts` writes, `src/core/ticket.ts` reads). We deliberately do not depend on an external ticket/planning skill suite (e.g. `to-tickets`). A `build` command runs `opencode` with a built-in lean planner prompt asking for a JSON list of vertical-slice tickets, which the Railhead topologically orders (dependencies first, `NN`-numbered) and writes as `NN-slug.md` files.

Decisions that fall out of this:

- The ticket format is a single source of truth in this repo; producer and consumer cannot drift.
- Planning is intentionally lean (a prompt), not an open-ended interview step. Users who want to shape a plan interactively use `railhead build` without `-a`, which runs the sharpening interview before generating tickets; the plan step remains re-runnable and deterministic.
- The only external dependency is `opencode`, which is on the critical path anyway.

This also fixed a latent bug in the consumer: `readBlockedBy` had never matched the `**Blocked by:**` line (a missing-colon prefix), silently treating every ticket as unblocked and defeating dependency ordering. Owning the format let us make the consumer's normalization exact (references are reduced to `NN-slug.md` file names), and `build`-written tickets respect it.