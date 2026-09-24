/**
 * The operator-declared provider surface (issue #134).
 *
 * Railhead must not know any particular model server. Flaky local engines
 * (a wedged llama.cpp, a Splash under memory pressure, an LM Studio that
 * restarted) expose health in engine-specific ways, so the probe is declared
 * in `railhead.json` — an absolute URL, or a path resolved against the
 * declared `base_url` — with a small declarative pass rule over the JSON
 * body. Nothing here detects a vendor; recorded vendor payloads live in
 * tests.
 *
 * Everything in this module is pure: shape validation plus the response
 * evaluator. The network probe and the lifecycle live in
 * `src/execute/provider-health.ts`.
 */

/** One condition over a JSON body value. Dot path selects into the parsed
 *  body ("ready", "admission.waiting", "data.0.id"); at least the path must
 *  match. More than one operator on one rule is an AND. No operator = the
 *  path must exist. */
export interface ProviderHealthPassRule {
  path: string;
  equals?: unknown;
  one_of?: unknown[];
  not?: unknown;
}

export interface ProviderHealthConfig {
  /** Absolute `http(s)://` URL, or a path (e.g. `/status`) resolved against
   *  `ProviderConfig.base_url`. */
  url: string;
  /** HTTP method. Default GET. */
  method?: string;
  /** Request timeout in seconds. Default 5. */
  timeout_sec?: number;
  /** Pass rule over the JSON body; absent = any 2xx passes. */
  pass?: ProviderHealthPassRule;
}

export interface ProviderConfig {
  /** The model server's base URL. Declared, never auto-detected; used to
   *  resolve a relative `health.url`. */
  base_url?: string;
  health?: ProviderHealthConfig;
}

const HEALTH_METHODS = ["GET", "HEAD", "POST"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`railhead.json ${context} must be a non-empty string`);
  }
  return value.trim();
}

/** Parse + validate `provider`. Throws on a malformed declared value (a typo
 *  must fail at load, never silently disable the probe); null/absent = no
 *  provider surface, today's behavior. */
export function parseProviderConfig(value: unknown): ProviderConfig | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new Error('railhead.json "provider" must be an object');
  }
  const baseUrl = value.base_url === undefined
    ? undefined
    : requireNonEmptyString(value.base_url, '"provider.base_url"');

  let health: ProviderHealthConfig | undefined;
  if (value.health !== undefined && value.health !== null) {
    if (!isRecord(value.health)) {
      throw new Error('railhead.json "provider.health" must be an object');
    }
    const url = requireNonEmptyString(value.health.url, '"provider.health.url"');
    if (!/^https?:\/\//i.test(url) && !baseUrl) {
      throw new Error('railhead.json "provider.health.url" is a relative path but "provider.base_url" is not set — declare an absolute URL or the base URL to resolve against');
    }
    const method = value.health.method === undefined
      ? undefined
      : requireNonEmptyString(value.health.method, '"provider.health.method"').toUpperCase();
    if (method !== undefined && !HEALTH_METHODS.includes(method)) {
      throw new Error(`railhead.json "provider.health.method": unknown method "${method}" — expected one of ${HEALTH_METHODS.join(" | ")}`);
    }
    let timeout: number | undefined;
    if (value.health.timeout_sec !== undefined) {
      const t = value.health.timeout_sec;
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
        throw new Error('railhead.json "provider.health.timeout_sec" must be a positive number of seconds');
      }
      timeout = t;
    }
    let pass: ProviderHealthPassRule | undefined;
    if (value.health.pass !== undefined && value.health.pass !== null) {
      if (!isRecord(value.health.pass)) {
        throw new Error('railhead.json "provider.health.pass" must be an object');
      }
      const path = requireNonEmptyString(value.health.pass.path, '"provider.health.pass.path"');
      const rule: ProviderHealthPassRule = { path };
      if (value.health.pass.equals !== undefined) rule.equals = value.health.pass.equals;
      if (value.health.pass.not !== undefined) rule.not = value.health.pass.not;
      if (value.health.pass.one_of !== undefined) {
        if (!Array.isArray(value.health.pass.one_of)) {
          throw new Error('railhead.json "provider.health.pass.one_of" must be an array');
        }
        rule.one_of = value.health.pass.one_of;
      }
      pass = rule;
    }
    health = { url };
    if (method !== undefined) health.method = method;
    if (timeout !== undefined) health.timeout_sec = timeout;
    if (pass !== undefined) health.pass = pass;
  }

  const provider: ProviderConfig = {};
  if (baseUrl !== undefined) provider.base_url = baseUrl;
  if (health !== undefined) provider.health = health;
  return Object.keys(provider).length > 0 ? provider : null;
}

/** Resolve the probe URL. Absolute wins; otherwise join against the declared
 *  base URL. Null only when a relative path has no base (rejected at parse
 *  time, kept as a total function for direct callers). */
export function resolveHealthUrl(url: string, baseUrl: string | null | undefined): string | null {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

/** Structural JSON equality — deep, key-order independent, so a pass rule
 *  cannot flip on JSON property order. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEquals(a[k], b[k]));
  }
  return false;
}

function selectPath(body: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = body;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

/** Evaluate one probe response. Pure: HTTP status + raw body in, verdict out.
 *  Non-2xx fails; with no pass rule any 2xx passes; with a rule the body must
 *  parse as JSON and the rule must hold. */
export function evaluateHealthResponse(
  status: number,
  body: string,
  pass: ProviderHealthPassRule | undefined,
): { ok: boolean; detail: string } {
  if (status < 200 || status >= 300) return { ok: false, detail: `HTTP ${status}` };
  if (!pass) return { ok: true, detail: `HTTP ${status}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, detail: "response body is not JSON" };
  }
  const { found, value } = selectPath(parsed, pass.path);
  if (!found) return { ok: false, detail: `field "${pass.path}" is missing` };
  if (pass.equals !== undefined && !jsonEquals(value, pass.equals)) {
    return { ok: false, detail: `field "${pass.path}" is ${JSON.stringify(value)} (expected ${JSON.stringify(pass.equals)})` };
  }
  if (pass.not !== undefined && jsonEquals(value, pass.not)) {
    return { ok: false, detail: `field "${pass.path}" is ${JSON.stringify(value)} (must not be)` };
  }
  if (pass.one_of !== undefined && !pass.one_of.some((v) => jsonEquals(value, v))) {
    return { ok: false, detail: `field "${pass.path}" is ${JSON.stringify(value)} (not one of ${JSON.stringify(pass.one_of)})` };
  }
  return { ok: true, detail: `${pass.path} ok` };
}
