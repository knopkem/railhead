import { evaluateHealthResponse, resolveHealthUrl, type ProviderConfig, type ProviderHealthConfig } from "../config/provider.ts";
import { disabledTimeoutWarnings } from "../core/provider-config.ts";
import { nowClock } from "../cli/overview.ts";

/**
 * The provider health probe (issue #134): before every phase, when the
 * operator has declared one, check the provider's health URL and fast-fail a
 * wedged engine instead of letting it eat the stall guard's hour. The probe
 * is pure HTTP against an operator-declared endpoint — the railhead knows no
 * vendor, and an undeclared probe changes nothing (today's behavior).
 *
 * Restart detection rides the same signal: a probe that failed and then
 * succeeds means the server went away and came back, so its prefix cache is
 * cold. The base session itself stays valid (opencode sessions persist); only
 * the cache is cold, and the next phase re-warms it.
 */

export const DEFAULT_HEALTH_TIMEOUT_SEC = 5;

export interface ProviderHealthResult {
  ok: boolean;
  detail: string;
}

/** Probe one declared provider health endpoint. Never throws: a refused
 *  connection, a DNS failure, a timeout, a non-2xx, and an unparseable body
 *  are all `{ ok: false }` with a human-readable detail. */
export async function probeProviderHealth(
  health: ProviderHealthConfig,
  baseUrl: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderHealthResult> {
  const url = resolveHealthUrl(health.url, baseUrl);
  if (url === null) {
    return { ok: false, detail: `health url "${health.url}" is relative and no provider.base_url is configured` };
  }
  const timeoutSec = health.timeout_sec ?? DEFAULT_HEALTH_TIMEOUT_SEC;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const response = await fetchImpl(url, { method: health.method ?? "GET", signal: controller.signal });
    const body = await response.text();
    return evaluateHealthResponse(response.status, body, health.pass);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, detail: `timed out after ${timeoutSec}s` };
    }
    const message = err instanceof Error ? err.message : String(err);
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
    return { ok: false, detail: `${message}${code}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The provider surface the run declared, plus the last probe verdict (used
 *  to detect a restart). Null before any run/plan configures it. */
let active: { health: ProviderHealthConfig; baseUrl: string | null } | null = null;
let providerWasHealthy: boolean | null = null;

/** Install (or clear) the operator's provider config for every phase in this
 *  process. Called at the start of a run/plan; `null` clears the probe, so a
 *  test or command without a declared provider behaves exactly as before. */
export function setProviderHealth(provider: ProviderConfig | null | undefined): void {
  active = provider?.health ? { health: provider.health, baseUrl: provider.base_url ?? null } : null;
  if (active === null) providerWasHealthy = null;
}

/** Probe the configured provider, or null when none is declared. */
export async function probeConfiguredProvider(fetchImpl?: typeof fetch): Promise<ProviderHealthResult | null> {
  if (active === null) return null;
  return probeProviderHealth(active.health, active.baseUrl, fetchImpl);
}

/** Record a probe verdict; returns true on the fail→ok transition — the
 *  provider went away and came back, so the prefix cache is cold. */
export function noteProviderHealth(ok: boolean): boolean {
  const recovered = ok && providerWasHealthy === false;
  providerWasHealthy = ok;
  return recovered;
}

export function resetProviderHealthForTest(): void {
  active = null;
  providerWasHealthy = null;
  warnedProjects.clear();
}

/** Install a run/plan's provider config and warn once per project per process
 *  about providers whose request timeouts are all disabled — the
 *  configuration that let the snake run's wedged request reach the stall
 *  guard. Best-effort; the same process can enter plan and run, so the scan
 *  runs once. */
const warnedProjects = new Set<string>();

export function configureProvider(provider: ProviderConfig | null | undefined, cwd: string): void {
  setProviderHealth(provider);
  if (warnedProjects.has(cwd)) return;
  warnedProjects.add(cwd);
  for (const warning of disabledTimeoutWarnings(cwd)) {
    console.log(`[${nowClock()}] ${warning}`);
  }
}
