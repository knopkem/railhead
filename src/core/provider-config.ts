import { execFileSync } from "node:child_process";
import { DEFAULT_MODEL } from "../config/config.ts";

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
 *
 * The scan is intersected with the models the run's seats actually resolved
 * to: a provider configured in opencode for something the railhead never
 * spawns (a local engine kept for another tool, say) must not produce a
 * warning about this run.
 */

/** Whether a resolved seat reference names this provider's `modelId`. A full
 *  `provider/model` must match both halves; a bare reference (opencode itself
 *  tail-matches those across providers) matches the model id alone. */
function refTargets(ref: string, providerId: string, modelId: string): boolean {
  return ref === `${providerId}/${modelId}` || ref === modelId;
}

/** Parse `opencode debug config` output for providers whose request timeouts
 *  are ALL explicitly disabled, restricted to `usedModels` — the run's
 *  resolved seat models (`provider/model` or bare) plus `DEFAULT_MODEL`, which
 *  expands to the config's own `model`. Pure; one line per offending
 *  provider. */
export function parseDisabledTimeoutWarnings(raw: string, usedModels: ReadonlySet<string>): string[] {
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
  const used = new Set(usedModels);
  const opencodeDefault = (cfg as { model?: unknown }).model;
  if (used.has(DEFAULT_MODEL) && typeof opencodeDefault === "string" && opencodeDefault !== "") {
    used.add(opencodeDefault);
  }
  const disabledTriple = (options: Record<string, unknown> | undefined): boolean =>
    options !== undefined &&
    options.timeout === false &&
    options.headerTimeout === false &&
    options.chunkTimeout === false;
  const refs = [...used];
  const warnings: string[] = [];
  for (const [id, provider] of Object.entries(providerBlock as Record<string, any>)) {
    const models = Object.entries<Record<string, any>>(provider?.models ?? {});
    // Provider-level options govern every model of the provider, so they are
    // in scope when any used ref names this provider — at all, or by a bare
    // id one of its declared models carries.
    const providerUsed = refs.some((ref) =>
      ref.startsWith(`${id}/`) || models.some(([modelId]) => ref === modelId),
    );
    const scopes: Array<[string | null, boolean]> = [
      [null, providerUsed && disabledTriple(provider?.options)],
      ...models.map(([modelId, model]) => [
        modelId,
        refs.some((ref) => refTargets(ref, id, modelId)) && disabledTriple(model?.options),
      ] as [string, boolean]),
    ];
    const hit = scopes.find(([, disabled]) => disabled);
    if (hit) {
      const scope = hit[0] === null ? `provider "${id}"` : `provider "${id}" model "${hit[0]}"`;
      warnings.push(`${scope} disables all request timeouts (timeout/headerTimeout/chunkTimeout = false) — a wedged request can then only end via the railhead stall guard; set finite timeouts for local engines`);
    }
  }
  return warnings;
}

/** Best-effort scan of the resolved opencode config in `cwd`, restricted to
 *  the models the run uses. */
export function disabledTimeoutWarnings(cwd: string, usedModels: ReadonlySet<string>): string[] {
  try {
    const raw = execFileSync("opencode", ["debug", "config"], {
      cwd,
      // opencode resolves the project from PWD; execFile's cwd does not set it.
      env: { ...process.env, PWD: cwd },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseDisabledTimeoutWarnings(raw, usedModels);
  } catch {
    return [];
  }
}
