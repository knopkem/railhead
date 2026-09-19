/**
 * The operator-initiated stop signal (gh: graceful stop).
 *
 * Ctrl-C is a request, not a kill: the first SIGINT arms a SOFT stop that the
 * run loop honors at the next ticket boundary — the current ticket finishes
 * its whole gate and commits, so a resume continues at the next ticket with
 * nothing re-run and no gate owed. A second SIGINT escalates to the HARD stop
 * (kill the active child, persist `stopped`, exit 130) — the escape hatch for
 * a phase that will not finish. `railhead plan`/`init`/`diagnose` have no ticket
 * boundary to honor, so the executor's own SIGINT handler keeps its immediate
 * kill whenever no run-loop handler is installed.
 *
 * Module-level by design, the same singleton pattern as the executor's
 * `activeChildPid`: the signal handlers, the run loops, and the executor's
 * global handler all consult one state without threading it through every
 * call site. Tests drive it directly (`requestStop`/`clearStop`).
 */

/** What a SIGINT press asked for: the first press arms a soft stop, any press
 * after it demands the immediate kill. */
export type StopRequest = "soft" | "hard";

let softRequested = false;
let hardRequested = false;
let handlerInstalled = false;
// Set on the path to process exit (the executor's global SIGINT/SIGTERM kill,
// or a hard stop): the failure ladder must not start another retry once the
// process is tearing down, or a Ctrl-C logs "retrying identically" and can
// spawn a fresh child in the exit window.
let abortRequested = false;

/**
 * Record one stop request. The FIRST request arms the soft stop; every
 * request after it escalates to hard — pressing Ctrl-C again while the gate
 * winds down must not be swallowed.
 */
export function requestStop(): StopRequest {
  if (softRequested || hardRequested) {
    hardRequested = true;
    return "hard";
  }
  softRequested = true;
  return "soft";
}

/** True while a soft stop is armed and has not escalated — the run loops
 * honor this at ticket boundaries. */
export function isSoftStopRequested(): boolean {
  return softRequested && !hardRequested;
}

/** True once a press escalated the soft stop to an immediate kill. Exposed so
 * the executor's global SIGINT handler keeps out of the way of the run loop's
 * own hard-stop path (which kills, persists, and exits with the state write
 * completed) instead of racing it. */
export function hardStopRequested(): boolean {
  return hardRequested;
}

/** Mark that the process is aborting: the failure ladder stops retrying. Set
 * by the executor's immediate-kill handler (standalone plan/init/diagnose, or
 * a hard stop). Unlike the soft stop there is no graceful path back — the
 * process is ending — but clearStop resets it for tests and a fresh run. */
export function requestAbort(): void {
  abortRequested = true;
}

/** True once an abort was requested: no further retries. */
export function isAbortRequested(): boolean {
  return abortRequested;
}

/** Reset the whole machine. The run loop clears it on entry so a request that
 * arrived between runs (e.g. during planning) cannot leak into the next run. */
export function clearStop(): void {
  softRequested = false;
  hardRequested = false;
  abortRequested = false;
}

/** Mark whether a run loop currently owns SIGINT handling. While installed,
 * the executor's global handler defers the SIGINT branch to it (SIGTERM keeps
 * its immediate kill — memory pressure wants a fast exit, not a gate). */
export function setRunStopHandlerInstalled(installed: boolean): void {
  handlerInstalled = installed;
}

export function runStopHandlerInstalled(): boolean {
  return handlerInstalled;
}
