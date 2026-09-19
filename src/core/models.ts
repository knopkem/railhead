import { spawn } from "node:child_process";
import { once } from "node:events";
import { DEFAULT_MODEL } from "../config/config.ts";

/** How long a model-availability probe (`opencode run`) may take before it is judged unavailable. */
const MODEL_AVAILABILITY_TIMEOUT_MS = 300_000;

/**
 * Parse `opencode debug config` JSON output to find the resolved default
 * model. Returns the model string (e.g. "neuralwatt/glm-5.2-short-fast") or
 * null when the model key is absent / the JSON is malformed.
 */
export function parseDefaultModel(configJson: string): string | null {
  if (!configJson.trim()) return null;
  try {
    const cfg = JSON.parse(configJson);
    return typeof cfg.model === "string" ? cfg.model : null;
  } catch {
    return null;
  }
}

export interface ModelTestResult {
  available: boolean;
  error?: string;
}

/**
 * Parse the stdout of `opencode run --format json "reply with just: ok"` to
 * determine if the model is available. A `step_start` event means the model
 * responded; an `error` event means it didn't.
 */
export function parseModelTestResult(stdout: string): ModelTestResult {
  let sawStepStart = false;
  let errorLine: string | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "step_start") sawStepStart = true;
    if (ev.type === "error" && !errorLine) {
      const msg = ev.error?.data?.message ?? ev.error?.name ?? "unknown error";
      errorLine = msg;
    }
  }

  if (sawStepStart) return { available: true };
  if (errorLine) return { available: false, error: errorLine };
  return { available: false, error: "no response from opencode" };
}

/**
 * Query `opencode debug config` for the resolved default model id.
 * Returns null if opencode is not installed or the config has no model.
 */
export async function getDefaultModel(): Promise<string | null> {
  try {
    const stdout = await runCommand("opencode", ["debug", "config"]);
    return parseDefaultModel(stdout);
  } catch {
    return null;
  }
}

/**
 * Test whether a model is available by running a trivial prompt through
 * `opencode run --format json`. Returns { available: true } on success, or
 * { available: false, error: "..." } on failure. When `model` is null,
 * tests the opencode default model (no --model flag).
 */
export async function testModel(model: string | null): Promise<ModelTestResult> {
  const args = ["run", "--format", "json"];
  if (model && model !== DEFAULT_MODEL) args.push("--model", model);
  args.push("reply with just: ok");
  try {
    const stdout = await runCommand("opencode", args, MODEL_AVAILABILITY_TIMEOUT_MS);
    return parseModelTestResult(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, error: msg };
  }
}

/**
 * Parse `opencode models --verbose` JSON output for a single model and
 * determine if it has vision capability. Checks `capabilities.attachment`
 * (the primary signal) and falls back to `capabilities.input.image` (some
 * models declare image input without setting attachment).
 */
export function parseVisionCapability(modelJson: string): boolean {
  if (!modelJson.trim()) return false;
  try {
    const data = JSON.parse(modelJson);
    if (data?.capabilities?.attachment === true) return true;
    if (data?.capabilities?.input?.image === true) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse `opencode models --verbose` JSON output for a single model and
 * determine if it supports reasoning. Checks `capabilities.reasoning`.
 */
export function parseReasoningCapability(modelJson: string): boolean {
  if (!modelJson.trim()) return false;
  try {
    const data = JSON.parse(modelJson);
    return data?.capabilities?.reasoning === true;
  } catch {
    return false;
  }
}

/**
 * Query `opencode models --verbose` and find the reasoning capability for
 * the given model id. Returns true if the model supports reasoning, false
 * if not or if the model can't be found.
 */
export async function queryReasoningCapability(model: string | null): Promise<boolean> {
  if (!model || model === DEFAULT_MODEL) return false;
  try {
    const stdout = await runCommand("opencode", ["models", "--verbose"], 60000);
    return findModelCapability(stdout, model, parseReasoningCapability);
  } catch {
    return false;
  }
}

/**
 * Query `opencode models --verbose` and find the vision capability for the
 * given model id. Returns true if the model supports image attachments,
 * false if not or if the model can't be found.
 */
export async function queryVisionCapability(model: string | null): Promise<boolean> {
  if (!model || model === DEFAULT_MODEL) return false;
  try {
    const stdout = await runCommand("opencode", ["models", "--verbose"], 60000);
    return findModelCapability(stdout, model, parseVisionCapability);
  } catch {
    return false;
  }
}

/**
 * Parse the full `opencode models --verbose` output (a sequence of
 * `model_id\n{...json...}` blocks) and find a capability for the given
 * model id using the provided parser.
 */
export function findModelCapability(output: string, modelId: string, parser: (modelJson: string) => boolean): boolean {
  const lines = output.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith("{")) {
      i++;
      continue;
    }
    // This is a model id line — check if it matches
    if (line === modelId) {
      // Collect the JSON block that follows
      i++;
      const jsonStart = i;
      let braceDepth = 0;
      while (i < lines.length) {
        braceDepth += (lines[i].match(/\{/g) ?? []).length;
        braceDepth -= (lines[i].match(/\}/g) ?? []).length;
        i++;
        if (braceDepth <= 0 && i > jsonStart) break;
      }
      const jsonStr = lines.slice(jsonStart, i).join("\n");
      return parser(jsonStr);
    }
    i++;
  }
  return false;
}

/** @deprecated Use findModelCapability with parseVisionCapability. */
export function findModelAttachment(output: string, modelId: string): boolean {
  return findModelCapability(output, modelId, parseVisionCapability);
}

export function runCommand(cmd: string, args: string[], timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      if (timer) clearTimeout(timer);
      resolve(stdout);
    });
  });
}

/**
 * Crude parameter-count heuristic from a model string: the largest `<number>B`
 * (case-insensitive) token in the name, or `null` when none is parseable.
 * False positives (a non-parameter number that happens to end in B) are
 * acceptable because the only consumer is an *advisory* startup warning.
 * Exposed as a pure function so the lossy parsing is unit-tested (ADR 0015).
 */
export function modelParameterClass(model: string | null): number | null {
  if (!model) return null;
  const re = /(\d+(?:\.\d+)?)\s*B/gi;
  let best: number | null = null;
  for (let m = re.exec(model); m !== null; m = re.exec(model)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}

// ---------------------------------------------------------------------------
// --free model discovery: parse `opencode models --verbose` and rank models
// ---------------------------------------------------------------------------

export type ModelRole = "plan" | "implement" | "review" | "visual" | "goal" | "extract";

export interface ModelEntry {
  id: string;
  name: string;
  providerID: string;
  family: string;
  cost: { input: number; output: number };
  capabilities: {
    toolcall: boolean;
    attachment: boolean;
    reasoning: boolean;
    input?: { image?: boolean };
  };
  limit: { context: number; output: number };
}

/**
 * Parse the full `opencode models --verbose` output (a sequence of
 * `model_id\n{...json...}` blocks) into typed entries. Entries whose JSON
 * fails to parse are skipped — a corrupt line must not crash the whole list.
 */
export function parseModelList(verboseOutput: string): ModelEntry[] {
  const lines = verboseOutput.split("\n");
  const entries: ModelEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith("{")) {
      i++;
      continue;
    }
    const id = line;
    i++;
    if (i >= lines.length || !lines[i].trim().startsWith("{")) {
      continue;
    }
    const jsonStart = i;
    let braceDepth = 0;
    while (i < lines.length) {
      braceDepth += (lines[i].match(/\{/g) ?? []).length;
      braceDepth -= (lines[i].match(/\}/g) ?? []).length;
      i++;
      if (braceDepth <= 0 && i > jsonStart) break;
    }
    const jsonStr = lines.slice(jsonStart, i).join("\n");
    const entry = parseModelEntry(id, jsonStr);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function parseModelEntry(id: string, jsonStr: string): ModelEntry | null {
  let data: Record<string, any>;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const caps = data?.capabilities;
  const limit = data?.limit;
  return {
    id,
    name: typeof data?.name === "string" ? data.name : id,
    providerID: typeof data?.providerID === "string" ? data.providerID : "",
    family: typeof data?.family === "string" ? data.family : id,
    cost: {
      input: typeof data?.cost?.input === "number" ? data.cost.input : NaN,
      output: typeof data?.cost?.output === "number" ? data.cost.output : NaN,
    },
    capabilities: {
      toolcall: caps?.toolcall === true,
      attachment: caps?.attachment === true,
      reasoning: caps?.reasoning === true,
      input: caps?.input,
    },
    limit: {
      context: typeof limit?.context === "number" ? limit.context : 0,
      output: typeof limit?.output === "number" ? limit.output : 0,
    },
  };
}

/** A model is free when both input and output cost are zero (or NaN — treat unknown as free rather than excluding). */
export function isFree(m: ModelEntry): boolean {
  return m.cost.input === 0 && m.cost.output === 0;
}

/** Exclude meta-routers (not real models) and safety/content-filter models. */
function isRealModel(m: ModelEntry): boolean {
  const lc = m.name.toLowerCase();
  if (lc.includes("router") || lc.includes("fusion") || lc.includes("auto"))
    return false;
  if (lc.includes("content safety") || lc.includes("guard") || lc.includes("safety"))
    return false;
  return true;
}

/** Full pipeline: run `opencode models --verbose`, parse, filter, return free real models. */
export async function queryFreeModels(): Promise<ModelEntry[]> {
  let stdout: string;
  try {
    stdout = await runCommand("opencode", ["models", "--verbose"], 60000);
  } catch {
    return [];
  }
  return filterFreeModels(stdout);
}

/** Pure-function variant: given the verbose output string, return free real models. */
export function filterFreeModels(verboseOutput: string): ModelEntry[] {
  return parseModelList(verboseOutput).filter(m => isFree(m) && isRealModel(m));
}

/** Log-scaled context score: 128k = ~12, 256k = ~14, 1M = ~20. Small enough that parameter class dominates for judgment. */
function contextScore(m: ModelEntry): number {
  if (m.limit.context <= 0) return 0;
  return Math.log2(m.limit.context / 1000);
}

/** Has vision (attachment or image input). */
function hasVision(m: ModelEntry): boolean {
  return m.capabilities.attachment || m.capabilities.input?.image === true;
}

// ---------------------------------------------------------------------------
// init-time capability probe (issue #74)
// ---------------------------------------------------------------------------

/**
 * Capabilities of one model seat, parsed from a single `opencode models
 * --verbose` capture. `found: false` means the model was NOT in the registry —
 * vision/reasoning/contextLimit are then "unknown", not verified absent, so a
 * caller must not claim e.g. "not vision-capable" about a model it never saw.
 */
export interface CapabilityInfo {
  found: boolean;
  vision: boolean;
  reasoning: boolean;
  contextLimit: number | null;
}

const UNKNOWN_CAPABILITIES: CapabilityInfo = { found: false, vision: false, reasoning: false, contextLimit: null };

/** Find a model entry for a user/reference model string. Exact full-id match
 * first (`vllm/proxy`), then a tolerant bare-id match (`proxy`) for references
 * typed without a provider prefix. Returns null when nothing matches. */
export function findModelEntry(models: ModelEntry[], model: string | null): ModelEntry | null {
  if (!model) return null;
  const exact = models.find((m) => m.id === model);
  if (exact) return exact;
  const slash = model.indexOf("/");
  const bare = slash >= 0 ? model.slice(slash + 1) : model;
  return models.find((m) => m.id.slice(m.id.lastIndexOf("/") + 1) === bare) ?? null;
}

/**
 * Parse vision/reasoning/context-limit for a single model from one
 * `opencode models --verbose` capture. An absent/malformed capture or an
 * unlisted model yields `found: false` (the unknown state) rather than
 * verified-false — issue #74 probes all five init seats against one capture
 * instead of one `opencode models` spawn per capability.
 */
export function parseCapabilityInfo(modelsOutput: string, model: string | null): CapabilityInfo {
  if (!model || !modelsOutput.trim()) return UNKNOWN_CAPABILITIES;
  const entry = findModelEntry(parseModelList(modelsOutput), model);
  if (entry === null) return UNKNOWN_CAPABILITIES;
  return {
    found: true,
    vision: hasVision(entry),
    reasoning: entry.capabilities.reasoning,
    contextLimit: entry.limit.context > 0 ? entry.limit.context : null,
  };
}

/** Combined result of probing one init seat: availability (a real `opencode
 * run`) merged with its registry capabilities. Issue #74's "test all 5 models
 * in one pass, probe availability/context/vision/reasoning per model." */
export interface InitProbe {
  available: boolean;
  error?: string;
  capabilities: CapabilityInfo;
}

/**
 * Build a per-seat prober over one shared `opencode models --verbose` capture.
 * Availability (`opencode run`) is deduplicated per availability model and the
 * capability parse per capability reference, so five seats all on the opencode
 * default run ONE availability test, not five. The prober itself is a closure
 * because it carries those two caches across the seats it probes.
 */
export function createInitProber(modelsOutput: string): (model: string | null, capabilityRef: string | null) => Promise<InitProbe> {
  const availabilityCache = new Map<string, ModelTestResult>();
  const capabilityCache = new Map<string, CapabilityInfo>();
  return async (model, capabilityRef): Promise<InitProbe> => {
    const availabilityKey = model ?? "\0default";
    let availability = availabilityCache.get(availabilityKey);
    if (availability === undefined) {
      availability = await testModel(model);
      availabilityCache.set(availabilityKey, availability);
    }
    const capabilityKey = capabilityRef ?? "\0none";
    let capabilities = capabilityCache.get(capabilityKey);
    if (capabilities === undefined) {
      capabilities = parseCapabilityInfo(modelsOutput, capabilityRef);
      capabilityCache.set(capabilityKey, capabilities);
    }
    return { available: availability.available, error: availability.error, capabilities };
  };
}

/** Fetch `opencode models --verbose` once for an init session; "" on failure
 * (an empty capture yields all-unknown capabilities, never a crash). */
export async function fetchModelsVerbose(): Promise<string> {
  try {
    return await runCommand("opencode", ["models", "--verbose"], 60000);
  } catch {
    return "";
  }
}

/**
 * Score a model for a given role. Returns `null` when the model is
 * disqualified for that role (missing a mandatory capability). Otherwise
 * returns a numeric score — higher is better.
 *
 * Mandatory filters:
 *   plan/implement/review/extract require toolcall (file read/write).
 *   visual requires vision (attachment or image input).
 *
 * Scoring (higher = better fit):
 *   plan:      reasoning + large context + toolcall + param class
 *   implement: toolcall + large context + param class
 *   review:    toolcall + reasoning + param class
 *   visual:    vision + context + param class
 *   extract:   toolcall + small param class (cheaper seat — 9B endorsed per ADR 0015, inverse preference)
 */
export function scoreModelForRole(m: ModelEntry, role: ModelRole): number | null {
  const pc = modelParameterClass(m.id) ?? 0;
  const ctx = contextScore(m);
  const reason = m.capabilities.reasoning;

  switch (role) {
    case "plan":
    case "implement":
    case "review": {
      if (!m.capabilities.toolcall) return null;
      let s = pc * 2 + ctx + (role === "plan" || role === "review" ? (reason ? 10 : 0) : 0);
      if (role === "implement") s += ctx * 0.5;
      if (m.providerID === "opencode") s += 5;
      return s;
    }
    case "visual": {
      if (!hasVision(m)) return null;
      let s = pc + ctx + (reason ? 5 : 0);
      if (m.providerID === "opencode") s += 5;
      return s;
    }
    case "goal": {
      if (!m.capabilities.toolcall) return null;
      let s = pc * 2 + ctx + (reason ? 15 : 0);
      if (hasVision(m)) s += 5;
      if (m.providerID === "opencode") s += 5;
      return s;
    }
    case "extract": {
      if (!m.capabilities.toolcall) return null;
      let s = (pc > 0 && pc < 27 ? 10 : 0) + ctx * 0.3;
      if (m.providerID === "opencode") s += 5;
      return s;
    }
  }
}

/**
 * From a list of free models, assign the best-scoring model id to each role.
 * `visual` may be `null` when no free vision-capable model is available.
 * Throws when a mandatory role (plan/implement/review) has zero candidates.
 * Ties broken by lexicographic model id for reproducibility.
 */
export function assignFreeModels(freeModels: ModelEntry[]): Record<ModelRole, string | null> {
  const roles: ModelRole[] = ["plan", "implement", "review", "visual", "goal", "extract"];
  const result = {} as Record<ModelRole, string | null>;
  for (const role of roles) {
    const candidates = freeModels
      .map(m => ({ id: m.id, score: scoreModelForRole(m, role) }))
      .filter(c => c.score !== null) as { id: string; score: number }[];
    if (candidates.length === 0) {
      result[role] = null;
      continue;
    }
    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    result[role] = candidates[0].id;
  }
  if (result.plan === null || result.implement === null || result.review === null) {
    const missing = roles.filter(r => result[r] === null && r !== "visual" && r !== "goal");
    throw new Error(
      `no free models found for required role(s): ${missing.join(", ")}. ` +
      `Check provider credentials or re-run \`railhead init\` without --free.`,
    );
  }
  return result;
}
