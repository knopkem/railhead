import { railheadAgentConfig } from "../core/project-assets.ts";

/**
 * The opencode permission snippet injected into every agent phase. The railhead
 * stores its durable run ledger under the project's `.railhead/run-*`, but the
 * scratch-file discipline (prompt.ts) ALSO directs agents to write scratch
 * under `.railhead/` — and an agent "cleaning" its scratch (`rm -rf .railhead`)
 * once deleted the whole ledger mid-run. These deny rules stop the agent from
 * destroying that state while leaving the rest of the unattended-run
 * permission model (bash/edit allow) intact. `.railhead/STOP` (halt) and
 * `.railhead/server.log` (scratch) live OUTSIDE `run-*`, so they stay writable.
 *
 * Injected as inline config via `OPENCODE_CONFIG_CONTENT`, which opencode
 * merges at higher precedence than the project/global config files.
 */
export const LEDGER_GUARD_CONFIG = JSON.stringify({
  permission: {
    bash: {
      "*": "allow",
      "rm -rf .railhead*": "deny",
      "rm -r .railhead*": "deny",
      "rm -rf ./.railhead*": "deny",
      "rm -r ./.railhead*": "deny",
      "rmdir .railhead*": "deny",
      "find .railhead*": "deny",
      "git clean -fdx*": "deny",
    },
    edit: {
      "*": "allow",
      "*.railhead/run-*": "deny",
    },
    write: {
      "*": "allow",
      "*.railhead/run-*": "deny",
    },
  },
});

/** Project-configured dependency-source bash globs (railhead.json's
 * `dependency_source_deny`), set once per run. Process-local by design: one
 * railhead process runs one project at a time, and the run loop re-sets it on
 * entry, so a resumed run never inherits a stale list. */
let dependencyDenyGlobs: string[] = [];

export function setDependencySourceDeny(globs: string[]): void {
  dependencyDenyGlobs = [...globs];
}

/**
 * A copy of `base` with the ledger guard AND every railhead agent injected as
 * inline config — never mutates the input, so a caller's shared `process.env`
 * object is not clobbered. All five seats ride in the same
 * `OPENCODE_CONFIG_CONTENT`, so any phase can resolve
 * `opencode run --agent railhead-*` without the railhead ever writing
 * `.opencode/agent/*.md` into the user's project (which would permanently
 * change their opencode behaviour). All of it vanishes with the subprocess.
 */
export function guardedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const guard = JSON.parse(LEDGER_GUARD_CONFIG) as { permission: { bash: Record<string, string> } };
  for (const glob of dependencyDenyGlobs) guard.permission.bash[glob] = "deny";
  const config = { ...guard, ...railheadAgentConfig() };
  return { ...base, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
