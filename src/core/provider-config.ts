import { execFileSync } from "node:child_process";

/**
 * The startup warning for disabled provider timeouts (issue #134).
 *
 * The snake-run incident: a provider configured with `timeout: false`,
 * `headerTimeout: false`, `chunkTimeout: false` let a wedged request run until
 * the railhead's stall guard ended it ~an hour later. opencode resolves the
 * merged provider config (`opencode debug config`), so the railhead can name
 * the offending provider at run start without hardcoding any provider — the
 * scan is over whatever the user declared. Best-effort: no opencode, a bad
 * config dump, or an unrecognized shape silently yields no warnings; this
 * never fails a run.
 */

/** Parse `opencode debug config` output for providers whose request timeouts
 *  are ALL explicitly disabled. Pure; returns one line per offending scope. */
export function parseDisabledTimeoutWarnings(raw: string): string[] {
  const start = raw.indexOf("{");
  if (start < 0) return [];
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw.slice(start));
  } catch {
    return [];
  }
  const providerBlock = (cfg as { provider?: unknown }).provider;
  if (typeof providerBlock !== "object" || providerBlock === null) return [];
  const warnings: string[] = [];
  for (const [id, provider] of Object.entries(providerBlock as Record<string, any>)) {
    const scopes: Array<[string | null, Record<string, unknown> | undefined]> = [
      [null, provider?.options],
      ...Object.entries<Record<string, any>>(provider?.models ?? {}).map(
        ([modelId, model]) => [modelId, model?.options] as [string, Record<string, unknown> | undefined],
      ),
    ];
    const hit = scopes.find(([, options]) =>
      options !== undefined &&
      options.timeout === false &&
      options.headerTimeout === false &&
      options.chunkTimeout === false,
    );
    if (hit) {
      const scope = hit[0] === null ? `provider "${id}"` : `provider "${id}" model "${hit[0]}"`;
      warnings.push(`${scope} disables all request timeouts (timeout/headerTimeout/chunkTimeout = false) — a wedged request can then only end via the railhead stall guard; set finite timeouts for local engines`);
    }
  }
  return warnings;
}

/** Best-effort scan of the resolved opencode config in `cwd`. */
export function disabledTimeoutWarnings(cwd: string): string[] {
  try {
    const raw = execFileSync("opencode", ["debug", "config"], {
      cwd,
      // opencode resolves the project from PWD; execFile's cwd does not set it.
      env: { ...process.env, PWD: cwd },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseDisabledTimeoutWarnings(raw);
  } catch {
    return [];
  }
}
