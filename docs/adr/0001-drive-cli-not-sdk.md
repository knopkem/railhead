# Drive the opencode CLI, not the SDK

> Amended by ADR 0047: the Builder is one durable session (ADR 0022), and
> `session_builder: false` — the only remaining fresh-implementer selection — is
> retired. The fresh-subprocess property below still holds for every gate and
> judgment phase.

We invoke `opencode run --format json` as a fresh subprocess for every Implementer and Reviewer invocation rather than embedding the `@opencode-ai/sdk` server. Each ticket runs in a guaranteed-fresh context (protecting the ~100k window of a local model), and a crash kills only that ticket's process, never the Railhead. The `--format json` event lines are captured verbatim into the Ledger. The SDK stays as an escape hatch if we later need typed streaming or a long-lived server.