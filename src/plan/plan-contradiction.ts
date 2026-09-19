/**
 * Detect a plan-authored artifact claim the build disproves.
 *
 * The planner (and human specs) can name a specific third-party dependency as
 * if its existence were decided truth. When the build then fails to resolve
 * it — npm's `404 The requested resource '@scope/name@1.0.0' could not be
 * found`, cargo's `no matching package named \`foo\` found`, a bare module
 * that is not on any registry — the worker's instinct is to silently
 * substitute a real package and move on. The plan (ticket text, acceptance
 * criteria, architecture) is then left asserting a phantom name that later
 * tickets and reviewers keep fighting.
 *
 * These parsers are deliberately lossy and technology-agnostic: they pull the
 * one resolvable token out of resolver error prose, then ask the only
 * question the railhead can answer deterministically — "does the CURRENT
 * ticket's plan text also name that token?" If yes, the failure is a plan
 * contradiction, not an ordinary build break, and the retry feedback must say
 * so instead of re-running the same doomed resolution.
 */

/** Pull the missing artifact name out of a resolver/installer failure blob.
 * Looks at lines that signal a failed resolution (404, not found, no matching
 * version, could not find package) and returns the quoted/backticked token on
 * them, with any `@<version>` suffix stripped. Returns null when the output
 * shows no resolvable artifact (a compile error, a test failure, etc.). */
export function findUnresolvedArtifact(output: string): string | null {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!/(404|could not be found|not found|no matching version|no matching package|couldn.t find|does not exist in the registry|failed to resolve)/i.test(line)) {
      continue;
    }
    // A resolver error may span the token and the status on different lines,
    // so once we are on a signal line grab the first quoted/backticked token
    // anywhere on it, or the `name@version` from a registry URL line, or the
    // bare token after "no matching version found for <token>".
    const quoted = line.match(/['"`]([^'"`]+)['"`]/);
    const token = quoted ? quoted[1] : tokenFromUrl(line) ?? tokenAfterPhrase(line);
    if (!token) continue;
    const artifact = normalizeArtifact(token);
    if (!artifact) continue;
    return artifact;
  }
  return null;
}

/** Recover an artifact token from a registry/URL line like
 * `404 Not Found - GET https://registry.npmjs.org/pngjs9` or
 * `https://registry.npmjs.org/%40jsquar%2Fpng`. Skips API surfaces like
 * `/-/v1/search` (they name no artifact). */
function tokenFromUrl(line: string): string | null {
  const m = line.match(/https?:\/\/[^\s/]+\/([^?\s]+)/);
  if (!m) return null;
  const path = m[1];
  if (path.includes("-/")) return null;
  const seg = path.split("/").filter(Boolean).pop();
  if (!seg || /^[0-9v^~<>*.-]+$/.test(seg)) return null;
  return decodeURIComponent(seg).replace(/\.git$/, "");
}

/** Bare token after a phrase like "no matching version found for pngjs@^7". */
function tokenAfterPhrase(line: string): string | null {
  const m = line.match(/(?:no matching version found for|could not find|not found for)\s+(\S+)/i);
  return m ? m[1].replace(/[,;.!]+$/, "") : null;
}

/** Strip a `@<version>` / `@*` suffix, keep scoped names: `@scope/name@1.0.0`
 * -> `@scope/name`, `name@^7` -> `name`. Rejects tokens that are not
 * package-like (paths with several slashes, bare versions, URLs). */
function normalizeArtifact(token: string): string | null {
  let t = token.trim().replace(/[,;.]+$/, "");
  if (!t || t.startsWith("http")) return null;
  if (t.startsWith("/")) return null;
  const slashCount = t.split("/").length - 1;
  if (slashCount > 1) return null;
  const cut = t.match(/^(.*?)@(?=[0-9]|[*^~<>]|v)/);
  if (cut) t = cut[1];
  if (/^\d/.test(t)) return null;
  if (t.length < 2 || t.length > 200) return null;
  return t;
}

/** Whether the current ticket's plan text names the artifact, so the railhead
 * can tell a plan-authored claim from a worker-invented one. Lossy by
 * design: a plain substring match on the token (and on its unscoped form,
 * for a plan that dropped the `@scope/` prefix). */
export function planMentions(planText: string, artifact: string): boolean {
  if (!planText || !artifact) return false;
  const needle = artifact.toLowerCase();
  const hay = planText.toLowerCase();
  return hay.includes(needle) || hay.includes(needle.replace(/^@/, ""));
}

/** The corrective feedback for a plan contradiction. Names the artifact and
 * tells the worker to substitute a real one and record the decision rather
 * than keep retrying the phantom or substitute silently. Technology-agnostic:
 * "the project's decision log (e.g. the DECISIONS.md the spec requires)". */
export function describePlanContradiction(artifact: string): string {
  return `The current ticket's plan text names the dependency/artifact "${artifact}", and the build output proves it does not resolve (404 / not found). That name is a plan claim, not ground truth — the plan may have fabricated it. Do NOT keep retrying it or re-probing registries for it. Choose a real artifact that provides the same capability, put it in the project manifest, and record the substitution in the project's decision log (the DECISIONS.md the spec requires) so the deviation is explicit rather than silent. Treat later tickets and the architecture that restate "${artifact}" as stale plan text to correct, not gospel.`;
}
