# ADR 0016: Crash-Resistant Resume

## Status

Proposed

## Context

The Railhead drives `opencode` over dependency-ordered tickets, each running
implement → verify → smoke → review → commit as a fresh subprocess. A run
processes many tickets sequentially; a single run can last hours. Three gaps
in the current resume machinery cause real-world failures:

### Gap 1: `railhead run` does not resume

`railhead run` always calls `startRun`, which mints a fresh `run-<timestamp>`
id and writes a blank `state.json` — even if a prior run on the same branch
was interrupted by a crash, ctrl-c, or OOM kill. The recovery logic in
`cmdResume` (checkpoint in-flight work, reconcile committed-but-unsaved
tickets, rebase the frontier) is never triggered.

The user must know to run `railhead resume` instead of `railhead run`. This is
undiscoverable: after a crash, the natural instinct is to re-run the same
command that was interrupted. The result is a fresh state.json that loses
all ticket progress tracking, even though the git branch still has the
committed tickets from before the crash.

### Gap 2: No SIGINT handler

No signal handler is registered. A ctrl-c leaves `status: "running"` and a
ticket `in_progress` in `state.json` on disk forever. The next invocation
has no signal that the prior run was interrupted — it sees `status:
"running"` and must decide whether to trust it.

### Gap 3: No tickets-dir / state.json invariant check

The tickets directory and `state.json` can diverge. A bug in
`writeCorrectiveTickets` (now fixed) purged all `.md` files from the
tickets directory mid-run. The `state.json` still listed all eight
tickets, but the directory was empty. The next `railhead run` crashed deep
inside `processTicket` with a confusing `ticket file not found` error,
with no recovery path offered.

## Decision

Four changes, each addressing one gap, designed so that **`railhead run`
after any crash always does the right thing**:

### 1. `railhead run` auto-resumes an interrupted run on the same branch

When `railhead run <tickets-dir>` is invoked, before calling `startRun`, it
checks for a prior run on the same branch (`assembleBranch(cwd,
ticketsDir)`). If a prior `state.json` exists for that branch and its
`status` is `"running"` or `"stopped"` (i.e., not `"finished"` or
`"failed"`), the run is resumed via the existing recovery path
(checkpoint → reset → rebase → `runLoop`) instead of starting fresh.

The pure gating function is `shouldResume(branch, priorState)`: returns
`true` when `priorState` is non-null, `priorState.branch === branch`, and
`priorState.status` is `"running"` or `"stopped"`.

A `--fresh` flag on `railhead run` skips the auto-resume and starts a
brand-new run. This is the escape hatch when the user explicitly wants to
discard prior state.

The recovery shell (currently the body of `cmdResume`) is extracted into a
shared `resumeRun` function called by both `cmdRun` (auto-resume path) and
`cmdResume` (explicit resume path). This eliminates the duplicate recovery
code.

### 2. SIGINT handler writes `stopped` to disk

`runLoop` registers a `SIGINT` handler at entry that:

1. Sets `state.status = "stopped"`.
2. Writes state to disk via `writeState` (atomic temp + rename).
3. Calls `process.exit(130)` (standard SIGINT exit code).

The handler is removed when `runLoop` finishes normally (returns a cleanup
function).

The invariant this establishes: **state.json always reflects reality
after a ctrl-c**. If the process is killed with SIGKILL (no handler can
run), state.json retains `status: "running"` — but `shouldResume` treats
`"running"` as "interrupted, resume it" (gap 1 above). Both paths recover.

No heartbeat or lock file is added. A lock file would guard against
concurrent `railhead resume` of the same run, but that's a lesser concern
than the crash-recovery gap. The SIGINT handler plus auto-resume covers the
common failure modes (ctrl-c, OOM, terminal close). Concurrent resumes are
a user error, not a crash.

### 3. Tickets-dir / state.json invariant check

Before `runLoop` begins (in `resumeRun`, after recovery steps), a pure
function `checkTicketInvariants(stateTickets, diskTickets)` checks that
every ticket in `state.json` has a corresponding file on disk and vice
versa. Returns a list of `DivergedTicket` entries.

- **Missing on disk** (state.json lists a ticket that doesn't exist):
  throw a descriptive error naming each missing file, with the hint:
  `"Tickets purged from disk. Re-run \`railhead build\` to regenerate, or restore from git."`
- **Missing in state** (disk has a ticket state.json doesn't): warn to
  console and add the ticket to state as a new `ready` entry. This handles
  re-plans that added tickets.
- **Title mismatch**: warn (may indicate a stale plan vs a re-plan).

### 4. `railhead reset` command

```
railhead reset [--hard]
```

Without `--hard`: removes the latest run's `.railhead/run-<id>/` directory.
The git branch and commits are left intact. The next `railhead run` starts a
fresh run-id on the same branch, reusing commits but rebuilding ticket
progress from `loadTickets`.

With `--hard`: also does `git resetHard` to the branch point (before the
first `run/<slug>` commit), discarding all ticket work. Nuclear option for
when the branch itself is wedged.

This gives the user an explicit escape hatch when a run is wedged beyond
recovery, without requiring manual `rm -rf .railhead/run-*` and git
gymnastics.

## Consequences

- **`railhead run` is now the single entry point.** `railhead resume` still
  works but is no longer necessary — `railhead run` auto-resumes.
- **ctrl-c is safe.** The SIGINT handler ensures state.json is written
  before exit. The next `railhead run` picks up from `status: "stopped"`.
- **Tickets-dir purges are caught early.** The invariant check throws a
  descriptive error before the run loop begins, not deep inside
  `processTicket`.
- **Users can always escape.** `railhead reset` abandons a wedged run
  explicitly.
- **No lock file or heartbeat.** Concurrent `railhead resume` of the same
  run is not guarded against. This is a deliberate trade-off: the
  complexity of lock-file management (stale locks, PID checks, NFS edge
  cases) is not justified for a single-user CLI tool.

## Invariants

1. `state.json` is always atomic (temp + rename, ADR 0004).
2. After a ctrl-c, `state.json` has `status: "stopped"`.
3. `railhead run` on a branch with a prior `running`/`stopped` run resumes
   it; `--fresh` skips.
4. Before `runLoop` enters, tickets on disk match tickets in `state.json`
   (or a descriptive error is thrown).
5. `railhead reset` removes the run ledger; `--hard` also discards git work.
