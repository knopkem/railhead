import { reviewerAgentConfig } from "../core/project-assets.ts";

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

/**
 * A copy of `base` with the ledger guard AND the reviewer agents injected as
 * inline config — never mutates the input, so a caller's shared `process.env`
 * object is not clobbered. The reviewer agents ride in the same
 * `OPENCODE_CONFIG_CONTENT` so the review subprocess can resolve
 * `opencode run --agent railhead-reviewer` without the railhead ever writing
 * `.opencode/agent/*.md` into the user's project (which would permanently
 * change their opencode behaviour). Both vanish with the subprocess.
 */
export function guardedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const config = { ...JSON.parse(LEDGER_GUARD_CONFIG), ...reviewerAgentConfig() };
  return { ...base, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
