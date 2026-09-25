# A tracked contracts index keeps per-ticket context O(ticket)

> Amended by ADR 0048: the index is now built solely from committed source
> (regex + per-file model fallback). The planner no longer declares
> `references`/`introduces`, and gates read the whole index.

The core invariant is that executing a ticket costs context proportional to the ticket, not to the accumulated project. To hold that as a repo grows, we maintain a tracked `railhead.contracts.json` at the repo root, grown at every commit.

Planning and runtime use the same index, splitting the work the way the user wanted:

- **Planning-time (richer, once).** `railhead build` seeds the planner with a one-line summary of the index. Tickets are written to name exact files and existing symbols (contracts) they must honor, so the executor never has to "explore the codebase."
- **Runtime (dynamic, cheap).** Each Implementer prompt receives only the slice of the index relevant to its ticket (by its `files` and `references`). After a ticket commits, a diff-only contract-extract pass asks the model to list the public contracts the change introduced, merges them into the index tagged with the ticket, and commits the update.

This composes the user's two instincts: good contracts baked into tickets at plan time (A), plus a live index that keeps later prompts cheap and pointers exact (B). The index is ordinary tracked JSON — greppable, human-reviewable, and versioned with the branch — so a future planner or a human can read "what surface exists now" without rescanning the tree.