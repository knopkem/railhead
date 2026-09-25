# src/cli — process boundary and terminal surface

The command entry point and everything that renders to a human.

## Seams

- `cli.ts` — `main` dispatch (`init`/`build`/`fix`/`run`/`resume`/`status`/`next`/`log`/`reset`/`diagnose`), interactive prompts, usage text, wiring of config/policy/recovery/run. Bundled by esbuild to `dist/cli.js`.
- `overview.ts` — status table, run report (`buildReport`, `writeReport`), `renderNextActionable` (the next ready ticket in order), and `nowClock`.
- `live.ts` — one-line live event rendering during a run.
- `transcript.ts` — full phase transcript for `railhead log`.
- `diagnose.ts` — `railhead diagnose screenshots` probe.

## Invariants

- Keep `cli.ts` thin: decisions belong in `src/config/run-policy.ts`, resume planning in `src/core/recovery.ts`, and the run itself in `src/execute/run.ts`.
- `nowClock` is imported by the executor and gate loops, so `overview.ts` is not a leaf of this directory — moving it rewrites many imports.
- Rendering functions are pure where possible; tests cross the same seam.
