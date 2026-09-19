import { describe, it, expect } from "vitest";
import { parseDefaultModel, parseModelTestResult, parseVisionCapability, parseReasoningCapability, findModelAttachment, findModelCapability, parseModelList, isFree, filterFreeModels, scoreModelForRole, assignFreeModels, modelParameterClass, findModelEntry, parseCapabilityInfo, type ModelEntry, type ModelRole } from "./models.ts";

describe("parseDefaultModel", () => {
  it("extracts the model from a valid debug config JSON", () => {
    const json = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "neuralwatt/glm-5.2-short-fast",
      provider: {},
    });
    expect(parseDefaultModel(json)).toBe("neuralwatt/glm-5.2-short-fast");
  });

  it("returns null when the model key is absent", () => {
    const json = JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: {} });
    expect(parseDefaultModel(json)).toBeNull();
  });

  it("returns null when the JSON is malformed", () => {
    expect(parseDefaultModel("{not json")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseDefaultModel("")).toBeNull();
  });
});

describe("parseModelTestResult", () => {
  it("returns available when a step_start event appears", () => {
    const lines = [
      JSON.stringify({ type: "step_start", timestamp: 0, sessionID: "s", part: { type: "step-start" } }),
      JSON.stringify({ type: "step_finish", timestamp: 1, sessionID: "s", part: { type: "step-finish" } }),
    ].join("\n");
    expect(parseModelTestResult(lines)).toEqual({ available: true });
  });

  it("returns unavailable with the error message when an error event appears", () => {
    const lines = JSON.stringify({
      type: "error",
      timestamp: 0,
      sessionID: "s",
      error: { name: "UnknownError", data: { message: "model not found" } },
    });
    expect(parseModelTestResult(lines)).toEqual({ available: false, error: "model not found" });
  });

  it("returns unavailable with a generic message when no events are present", () => {
    expect(parseModelTestResult("")).toEqual({ available: false, error: "no response from opencode" });
  });

  it("returns available when step_start appears even if an error follows (race)", () => {
    const lines = [
      JSON.stringify({ type: "step_start", timestamp: 0, sessionID: "s", part: { type: "step-start" } }),
      JSON.stringify({ type: "error", timestamp: 1, sessionID: "s", error: { name: "X", data: { message: "late error" } } }),
    ].join("\n");
    expect(parseModelTestResult(lines)).toEqual({ available: true });
  });

  it("ignores malformed JSON lines and still detects step_start", () => {
    const lines = [
      "not json",
      JSON.stringify({ type: "step_start", timestamp: 0, sessionID: "s", part: { type: "step-start" } }),
    ].join("\n");
    expect(parseModelTestResult(lines)).toEqual({ available: true });
  });

  it("extracts error message from nested data.message", () => {
    const lines = JSON.stringify({
      type: "error",
      error: { name: "AuthError", data: { message: "invalid api key" } },
    });
    expect(parseModelTestResult(lines)).toEqual({ available: false, error: "invalid api key" });
  });

  it("falls back to error.name when data.message is absent", () => {
    const lines = JSON.stringify({
      type: "error",
      error: { name: "TimeoutError", data: {} },
    });
    expect(parseModelTestResult(lines)).toEqual({ available: false, error: "TimeoutError" });
  });
});

describe("parseVisionCapability", () => {
  it("returns true when the model has attachment capability", () => {
    const json = JSON.stringify({
      id: "gemma-4-31b",
      capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true },
    });
    expect(parseVisionCapability(json)).toBe(true);
  });

  it("returns false when attachment is absent", () => {
    const json = JSON.stringify({
      id: "deepseek-v4-flash",
      capabilities: { temperature: true, reasoning: true, toolcall: true },
    });
    expect(parseVisionCapability(json)).toBe(false);
  });

  it("returns false when attachment is explicitly false", () => {
    const json = JSON.stringify({
      id: "text-only",
      capabilities: { attachment: false },
    });
    expect(parseVisionCapability(json)).toBe(false);
  });

  it("returns true when input.image is true even without attachment", () => {
    const json = JSON.stringify({
      id: "image-only",
      capabilities: { attachment: false, input: { text: true, image: true } },
    });
    expect(parseVisionCapability(json)).toBe(true);
  });

  it("returns false when both attachment and input.image are false", () => {
    const json = JSON.stringify({
      id: "text-only",
      capabilities: { attachment: false, input: { text: true, image: false } },
    });
    expect(parseVisionCapability(json)).toBe(false);
  });

  it("returns false when capabilities is absent", () => {
    const json = JSON.stringify({ id: "bare" });
    expect(parseVisionCapability(json)).toBe(false);
  });

  it("returns false for malformed JSON", () => {
    expect(parseVisionCapability("{not json")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(parseVisionCapability("")).toBe(false);
  });
});

describe("findModelAttachment", () => {
  const sampleOutput = [
    "opencode/big-pickle",
    JSON.stringify({ id: "big-pickle", capabilities: { reasoning: true, toolcall: true } }),
    "neuralwatt/gemma-4-31b",
    JSON.stringify({ id: "gemma-4-31b", capabilities: { reasoning: true, attachment: true, toolcall: true } }),
    "deepseek/deepseek-v4-flash",
    JSON.stringify({ id: "deepseek-v4-flash", capabilities: { reasoning: true, toolcall: true } }),
  ].join("\n");

  it("returns true for a model with attachment capability", () => {
    expect(findModelAttachment(sampleOutput, "neuralwatt/gemma-4-31b")).toBe(true);
  });

  it("returns false for a model without attachment capability", () => {
    expect(findModelAttachment(sampleOutput, "deepseek/deepseek-v4-flash")).toBe(false);
  });

  it("returns false for a model not in the output", () => {
    expect(findModelAttachment(sampleOutput, "nonexistent/model")).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(findModelAttachment("", "any/model")).toBe(false);
  });
});

describe("parseReasoningCapability", () => {
  it("returns true when capabilities.reasoning is true", () => {
    const json = JSON.stringify({ capabilities: { reasoning: true, toolcall: true } });
    expect(parseReasoningCapability(json)).toBe(true);
  });

  it("returns false when capabilities.reasoning is false", () => {
    const json = JSON.stringify({ capabilities: { reasoning: false, toolcall: true } });
    expect(parseReasoningCapability(json)).toBe(false);
  });

  it("returns false when capabilities.reasoning is absent", () => {
    const json = JSON.stringify({ capabilities: { toolcall: true } });
    expect(parseReasoningCapability(json)).toBe(false);
  });

  it("returns false for malformed JSON", () => {
    expect(parseReasoningCapability("{not json")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(parseReasoningCapability("")).toBe(false);
  });
});

describe("findModelCapability", () => {
  const sampleOutput = [
    "opencode/big-pickle",
    JSON.stringify({ id: "big-pickle", capabilities: { reasoning: true, toolcall: true } }),
    "neuralwatt/gemma-4-31b",
    JSON.stringify({ id: "gemma-4-31b", capabilities: { reasoning: false, attachment: true, toolcall: true } }),
    "deepseek/deepseek-v4-flash",
    JSON.stringify({ id: "deepseek-v4-flash", capabilities: { reasoning: true, toolcall: true } }),
  ].join("\n");

  it("finds reasoning capability via parseReasoningCapability", () => {
    expect(findModelCapability(sampleOutput, "opencode/big-pickle", parseReasoningCapability)).toBe(true);
    expect(findModelCapability(sampleOutput, "neuralwatt/gemma-4-31b", parseReasoningCapability)).toBe(false);
    expect(findModelCapability(sampleOutput, "deepseek/deepseek-v4-flash", parseReasoningCapability)).toBe(true);
  });

  it("finds vision capability via parseVisionCapability", () => {
    expect(findModelCapability(sampleOutput, "neuralwatt/gemma-4-31b", parseVisionCapability)).toBe(true);
    expect(findModelCapability(sampleOutput, "opencode/big-pickle", parseVisionCapability)).toBe(false);
  });

  it("returns false for a model not in the output", () => {
    expect(findModelCapability(sampleOutput, "nonexistent/model", parseReasoningCapability)).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(findModelCapability("", "any/model", parseReasoningCapability)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// modelParameterClass (moved from cli.ts)
// ---------------------------------------------------------------------------

describe("modelParameterClass", () => {
  it("parses a param-B suffix (case-insensitive)", () => {
    expect(modelParameterClass("qwen3-7b")).toBe(7);
    expect(modelParameterClass("Qwen3.6-35B-A3R")).toBe(35);
    expect(modelParameterClass("deepseek-271b")).toBe(271);
  });

  it("returns null when no <number>B pattern is present", () => {
    expect(modelParameterClass("opencode default")).toBeNull();
    expect(modelParameterClass("gpt-4o")).toBeNull();
    expect(modelParameterClass("claude")).toBeNull();
  });

  it("takes the largest match when several <number>B substrings exist", () => {
    expect(modelParameterClass("Qwen3.6-35B-A3R-v2-0B-at-layer-12B")).toBe(35);
  });

  it("returns null for null input", () => {
    expect(modelParameterClass(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseModelList
// ---------------------------------------------------------------------------

function makeModelJson(id: string, overrides: Record<string, any> = {}): string {
  const base = {
    id,
    providerID: "opencode",
    name: id,
    family: id,
    api: { id, url: "https://example.com", npm: "x" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 32000 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

describe("parseModelList", () => {
  it("parses multiple models from verbose output", () => {
    const output = [
      "opencode/big-pickle",
      makeModelJson("big-pickle"),
      "opencode/hy3-free",
      makeModelJson("hy3-free", { cost: { input: 0, output: 0 } }),
      "openrouter/google/gemma-4-31b-it:free",
      makeModelJson("gemma-4-31b-it", { cost: { input: 0, output: 0 } }),
    ].join("\n");

    const entries = parseModelList(output);
    expect(entries).toHaveLength(3);
    expect(entries[0].id).toBe("opencode/big-pickle");
    expect(entries[1].id).toBe("opencode/hy3-free");
    expect(entries[2].id).toBe("openrouter/google/gemma-4-31b-it:free");
  });

  it("extracts cost, capabilities, and limits correctly", () => {
    const output = [
      "neuralwatt/glm-5.2",
      makeModelJson("glm-5.2", {
        cost: { input: 1.19, output: 3.74 },
        limit: { context: 1048576, output: 32000 },
        capabilities: { reasoning: true, attachment: true, toolcall: true },
      }),
    ].join("\n");

    const entries = parseModelList(output);
    expect(entries).toHaveLength(1);
    const m = entries[0];
    expect(m.cost.input).toBe(1.19);
    expect(m.cost.output).toBe(3.74);
    expect(m.capabilities.reasoning).toBe(true);
    expect(m.capabilities.attachment).toBe(true);
    expect(m.capabilities.toolcall).toBe(true);
    expect(m.limit.context).toBe(1048576);
  });

  it("skips entries whose JSON is malformed", () => {
    const output = [
      "opencode/good-model",
      makeModelJson("good-model"),
      "opencode/bad-model",
      "{this is not valid json}",
      "opencode/another-good",
      makeModelJson("another-good"),
    ].join("\n");

    const entries = parseModelList(output);
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.id)).toEqual(["opencode/good-model", "opencode/another-good"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseModelList("")).toEqual([]);
  });

  it("handles a model id line with no JSON following it", () => {
    const output = "opencode/orphan-model\n";
    expect(parseModelList(output)).toEqual([]);
  });

  it("handles nested JSON braces correctly", () => {
    const output = [
      "opencode/nested",
      JSON.stringify({
        id: "nested",
        capabilities: {
          toolcall: true,
          input: { image: { nested: { deep: true } } },
        },
        cost: { input: 0, output: 0 },
        limit: { context: 100000, output: 5000 },
      }),
    ].join("\n");

    const entries = parseModelList(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("opencode/nested");
  });

  it("handles missing cost fields gracefully (NaN)", () => {
    const output = [
      "opencode/no-cost",
      JSON.stringify({ id: "no-cost", capabilities: { toolcall: true }, limit: {} }),
    ].join("\n");

    const entries = parseModelList(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].cost.input).toBeNaN();
    expect(entries[0].cost.output).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// isFree
// ---------------------------------------------------------------------------

describe("isFree", () => {
  it("returns true when both input and output cost are zero", () => {
    const m: ModelEntry = {
      id: "free-model", name: "Free", providerID: "opencode", family: "f",
      cost: { input: 0, output: 0 },
      capabilities: { toolcall: true, attachment: false, reasoning: false },
      limit: { context: 100000, output: 4000 },
    };
    expect(isFree(m)).toBe(true);
  });

  it("returns false when either cost is non-zero", () => {
    const base: ModelEntry = {
      id: "paid", name: "Paid", providerID: "openrouter", family: "f",
      cost: { input: 0, output: 0 },
      capabilities: { toolcall: true, attachment: false, reasoning: false },
      limit: { context: 100000, output: 4000 },
    };
    expect(isFree({ ...base, cost: { input: 0.5, output: 0 } })).toBe(false);
    expect(isFree({ ...base, cost: { input: 0, output: 0.1 } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterFreeModels
// ---------------------------------------------------------------------------

describe("filterFreeModels", () => {
  it("returns only free, real models (excludes paid, routers, safety models)", () => {
    const output = [
      "opencode/free-model",
      makeModelJson("free-model", { cost: { input: 0, output: 0 } }),
      "openrouter/paid-model",
      makeModelJson("paid-model", { cost: { input: 1, output: 2 } }),
      "openrouter/openrouter/free",
      makeModelJson("free", { name: "Free Models Router", cost: { input: 0, output: 0 } }),
      "openrouter/nvidia/nemotron-3.5-content-safety:free",
      makeModelJson("content-safety", { name: "Nemotron 3.5 Content Safety (free)", cost: { input: 0, output: 0 } }),
    ].join("\n");

    const free = filterFreeModels(output);
    expect(free.map(m => m.id)).toEqual(["opencode/free-model"]);
  });

  it("includes zero-cost models that lack the 'free' label (e.g. opencode/big-pickle)", () => {
    const output = [
      "opencode/big-pickle",
      makeModelJson("big-pickle", { cost: { input: 0, output: 0 } }),
    ].join("\n");
    const free = filterFreeModels(output);
    expect(free).toHaveLength(1);
    expect(free[0].id).toBe("opencode/big-pickle");
  });

  it("returns empty for empty input", () => {
    expect(filterFreeModels("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scoreModelForRole
// ---------------------------------------------------------------------------

function makeEntry(id: string, opts: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    name: id,
    providerID: "opencode",
    family: id,
    cost: { input: 0, output: 0 },
    capabilities: { toolcall: true, attachment: false, reasoning: false },
    limit: { context: 200000, output: 32000 },
    ...opts,
  };
}

describe("scoreModelForRole", () => {
  it("returns null for plan/implement/review/extract/goal when toolcall is false", () => {
    const m = makeEntry("no-tools-70b", { capabilities: { toolcall: false, attachment: false, reasoning: true } });
    expect(scoreModelForRole(m, "plan")).toBeNull();
    expect(scoreModelForRole(m, "implement")).toBeNull();
    expect(scoreModelForRole(m, "review")).toBeNull();
    expect(scoreModelForRole(m, "extract")).toBeNull();
    expect(scoreModelForRole(m, "goal")).toBeNull();
  });

  it("returns null for visual when vision is absent", () => {
    const m = makeEntry("text-only-70b");
    expect(scoreModelForRole(m, "visual")).toBeNull();
  });

  it("returns non-null for visual when attachment is true", () => {
    const m = makeEntry("vision-70b", { capabilities: { toolcall: true, attachment: true, reasoning: true } });
    expect(scoreModelForRole(m, "visual")).not.toBeNull();
  });

  it("returns non-null for visual when input.image is true (even without attachment)", () => {
    const m = makeEntry("image-input-70b", { capabilities: { toolcall: true, attachment: false, reasoning: false, input: { image: true } } });
    expect(scoreModelForRole(m, "visual")).not.toBeNull();
  });

  it("scores reasoning models higher for plan than non-reasoning", () => {
    const reasoning = makeEntry("qwen3-70b", { capabilities: { toolcall: true, attachment: false, reasoning: true } });
    const nonReasoning = makeEntry("qwen3-70b", { capabilities: { toolcall: true, attachment: false, reasoning: false } });
    expect(scoreModelForRole(reasoning, "plan")!).toBeGreaterThan(scoreModelForRole(nonReasoning, "plan")!);
  });

  it("scores a larger-parameter model higher for implement", () => {
    const big = makeEntry("model-120b");
    const small = makeEntry("model-9b");
    expect(scoreModelForRole(big, "implement")!).toBeGreaterThan(scoreModelForRole(small, "implement")!);
  });

  it("scores extract higher for small models (9B endorsed, inverse preference)", () => {
    const small = makeEntry("model-9b");
    const large = makeEntry("model-120b");
    expect(scoreModelForRole(small, "extract")!).toBeGreaterThan(scoreModelForRole(large, "extract")!);
  });

  it("gives opencode-provider a bonus over other providers", () => {
    const opencode = makeEntry("opencode/model-70b", { providerID: "opencode" });
    const other = makeEntry("openrouter/model-70b", { providerID: "openrouter" });
    expect(scoreModelForRole(opencode, "plan")!).toBeGreaterThan(scoreModelForRole(other, "plan")!);
  });

  it("scores reasoning models higher for goal than non-reasoning (#19)", () => {
    const reasoning = makeEntry("qwen3-70b", { capabilities: { toolcall: true, attachment: false, reasoning: true } });
    const nonReasoning = makeEntry("qwen3-70b", { capabilities: { toolcall: true, attachment: false, reasoning: false } });
    expect(scoreModelForRole(reasoning, "goal")!).toBeGreaterThan(scoreModelForRole(nonReasoning, "goal")!);
  });

  it("scores goal non-null without vision (vision is a bonus, not a requirement)", () => {
    const m = makeEntry("text-only-reasoner-70b", { capabilities: { toolcall: true, attachment: false, reasoning: true } });
    expect(scoreModelForRole(m, "goal")).not.toBeNull();
  });

  it("scores a vision-capable model higher for goal than a non-vision equivalent (#19)", () => {
    const withVision = makeEntry("model-70b", { capabilities: { toolcall: true, attachment: true, reasoning: true } });
    const withoutVision = makeEntry("model-70b", { capabilities: { toolcall: true, attachment: false, reasoning: true } });
    expect(scoreModelForRole(withVision, "goal")!).toBeGreaterThan(scoreModelForRole(withoutVision, "goal")!);
  });
});

// ---------------------------------------------------------------------------
// assignFreeModels
// ---------------------------------------------------------------------------

describe("assignFreeModels", () => {
  it("assigns the best model to each role from a set of free models", () => {
    const models: ModelEntry[] = [
      makeEntry("opencode/big-reasoning-70b", {
        capabilities: { toolcall: true, attachment: false, reasoning: true },
        limit: { context: 200000, output: 32000 },
        providerID: "opencode",
      }),
      makeEntry("openrouter/vision-31b:free", {
        id: "openrouter/vision-31b:free",
        capabilities: { toolcall: true, attachment: true, reasoning: true },
        providerID: "openrouter",
      }),
    ];
    const assignment = assignFreeModels(models);
    expect(assignment.plan).toBe("opencode/big-reasoning-70b");
    expect(assignment.implement).toBe("opencode/big-reasoning-70b");
    expect(assignment.review).toBe("opencode/big-reasoning-70b");
    expect(assignment.visual).toBe("openrouter/vision-31b:free");
    expect(assignment.goal).toBe("opencode/big-reasoning-70b");
  });

  it("returns goal as null when no tool-capable free model exists (#19)", () => {
    const models: ModelEntry[] = [
      makeEntry("opencode/no-tools-vision", { capabilities: { toolcall: false, attachment: true, reasoning: true } }),
    ];
    expect(() => assignFreeModels(models)).toThrow(/no free models found for required role/);
  });

  it("assigns goal to the strongest reasoner (vision is a bonus, not a requirement) (#19)", () => {
    const models: ModelEntry[] = [
      makeEntry("opencode/reasoning-70b", {
        capabilities: { toolcall: true, attachment: false, reasoning: true },
        providerID: "opencode",
      }),
      makeEntry("opencode/vision-9b", {
        capabilities: { toolcall: true, attachment: true, reasoning: false },
        providerID: "opencode",
      }),
    ];
    const assignment = assignFreeModels(models);
    expect(assignment.goal).toBe("opencode/reasoning-70b");
  });

  it("returns visual as null when no vision-capable free model exists", () => {
    const models: ModelEntry[] = [
      makeEntry("opencode/text-only-70b", { capabilities: { toolcall: true, attachment: false, reasoning: true } }),
    ];
    const assignment = assignFreeModels(models);
    expect(assignment.visual).toBeNull();
  });

  it("throws when no tool-capable free model exists for a mandatory role", () => {
    const models: ModelEntry[] = [
      makeEntry("opencode/no-tools", { capabilities: { toolcall: false, attachment: false, reasoning: false } }),
    ];
    expect(() => assignFreeModels(models)).toThrow(/no free models found for required role/);
  });

  it("throws when the list is empty", () => {
    expect(() => assignFreeModels([])).toThrow(/no free models found for required role/);
  });

  it("assigns extract to a small model when available (prefers 9B for extract seat)", () => {
    const models: ModelEntry[] = [
      makeEntry("opencode/big-120b", {
        capabilities: { toolcall: true, attachment: false, reasoning: true },
        providerID: "opencode",
      }),
      makeEntry("opencode/small-9b", {
        capabilities: { toolcall: true, attachment: false, reasoning: true },
        providerID: "opencode",
      }),
    ];
    const assignment = assignFreeModels(models);
    expect(assignment.extract).toBe("opencode/small-9b");
  });

  it("breaks ties deterministically by lexicographic id", () => {
    const models: ModelEntry[] = [
      makeEntry("openrouter/zzz-9b", { capabilities: { toolcall: true, attachment: false, reasoning: true } }),
      makeEntry("openrouter/aaa-9b", { capabilities: { toolcall: true, attachment: false, reasoning: true } }),
    ];
    const assignment = assignFreeModels(models);
    expect(assignment.plan).toBe("openrouter/aaa-9b");
  });
});

// ---------------------------------------------------------------------------
// findModelEntry + parseCapabilityInfo (issue #74 init capability probe)
// ---------------------------------------------------------------------------

/** A `provider/id\n{json}` capture with three models of differing capabilities. */
function capabilityOutput(): string {
  return [
    "opencode/big-pickle",
    makeModelJson("big-pickle", {
      limit: { context: 200000, output: 32000 },
      capabilities: { reasoning: true, attachment: false, toolcall: true },
    }),
    "neuralwatt/gemma-4-31b",
    makeModelJson("gemma-4-31b", {
      limit: { context: 131072, output: 16000 },
      capabilities: { reasoning: true, attachment: true, toolcall: true },
    }),
    "vllm/proxy",
    makeModelJson("proxy", {
      limit: { context: 230000, output: 30000 },
      capabilities: { reasoning: false, attachment: false, toolcall: true, input: { text: true, image: true } },
    }),
  ].join("\n");
}

describe("findModelEntry", () => {
  it("matches an exact full-id reference", () => {
    const entry = findModelEntry(parseModelList(capabilityOutput()), "vllm/proxy");
    expect(entry?.id).toBe("vllm/proxy");
  });

  it("matches a bare-id reference (no provider prefix) by tail", () => {
    const entry = findModelEntry(parseModelList(capabilityOutput()), "gemma-4-31b");
    expect(entry?.id).toBe("neuralwatt/gemma-4-31b");
  });

  it("does not match a bare-id prefix (proxy must not match proxy-noreason)", () => {
    const entry = findModelEntry(parseModelList(capabilityOutput()), "prox");
    expect(entry).toBeNull();
  });

  it("returns null for an unknown model or null reference", () => {
    expect(findModelEntry(parseModelList(capabilityOutput()), "nonexistent/model")).toBeNull();
    expect(findModelEntry(parseModelList(capabilityOutput()), null)).toBeNull();
  });

  it("returns null on an empty list", () => {
    expect(findModelEntry([], "any/model")).toBeNull();
  });
});

describe("parseCapabilityInfo", () => {
  it("reports vision/reasoning/context for a found model (image input counts as vision)", () => {
    const info = parseCapabilityInfo(capabilityOutput(), "vllm/proxy");
    expect(info).toEqual({ found: true, vision: true, reasoning: false, contextLimit: 230000 });
  });

  it("reports attachment-based vision via a bare-id reference", () => {
    const info = parseCapabilityInfo(capabilityOutput(), "gemma-4-31b");
    expect(info.found).toBe(true);
    expect(info.vision).toBe(true);
    expect(info.reasoning).toBe(true);
    expect(info.contextLimit).toBe(131072);
  });

  it("reports a non-vision model as found with vision: false (verified, not unknown)", () => {
    const info = parseCapabilityInfo(capabilityOutput(), "opencode/big-pickle");
    expect(info).toEqual({ found: true, vision: false, reasoning: true, contextLimit: 200000 });
  });

  it("returns unknown (found: false) for a model absent from the registry", () => {
    expect(parseCapabilityInfo(capabilityOutput(), "unknown/model")).toEqual({
      found: false, vision: false, reasoning: false, contextLimit: null,
    });
  });

  it("returns unknown for a null model, empty output, or malformed output", () => {
    expect(parseCapabilityInfo(capabilityOutput(), null)).toEqual({ found: false, vision: false, reasoning: false, contextLimit: null });
    expect(parseCapabilityInfo("", "opencode/big-pickle")).toEqual({ found: false, vision: false, reasoning: false, contextLimit: null });
    expect(parseCapabilityInfo("{not json", "opencode/big-pickle")).toEqual({ found: false, vision: false, reasoning: false, contextLimit: null });
  });

  it("skips corrupt JSON blocks without crashing and still finds later models", () => {
    const output = [
      "opencode/corrupt",
      "{this is not valid json}",
      "neuralwatt/gemma-4-31b",
      makeModelJson("gemma-4-31b", {
        capabilities: { reasoning: true, attachment: true, toolcall: true },
        limit: { context: 131072, output: 16000 },
      }),
    ].join("\n");
    expect(parseCapabilityInfo(output, "gemma-4-31b").vision).toBe(true);
  });
});
