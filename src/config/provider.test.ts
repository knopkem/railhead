import { describe, it, expect } from "vitest";
import {
  evaluateHealthResponse,
  jsonEquals,
  parseProviderConfig,
  resolveHealthUrl,
} from "./provider.ts";

describe("parseProviderConfig (#134)", () => {
  it("returns null for absent or empty declarations", () => {
    expect(parseProviderConfig(undefined)).toBeNull();
    expect(parseProviderConfig(null)).toBeNull();
    expect(parseProviderConfig({})).toBeNull();
  });

  it("parses a full declaration, normalizing method case", () => {
    expect(parseProviderConfig({
      base_url: "http://127.0.0.1:8080",
      health: {
        url: "/status",
        method: "get",
        timeout_sec: 2,
        pass: { path: "ready", equals: true },
      },
    })).toEqual({
      base_url: "http://127.0.0.1:8080",
      health: { url: "/status", method: "GET", timeout_sec: 2, pass: { path: "ready", equals: true } },
    });
  });

  it("accepts an absolute health URL with no base_url", () => {
    expect(parseProviderConfig({ health: { url: "http://box:8080/health" } })).toEqual({
      health: { url: "http://box:8080/health" },
    });
  });

  it("rejects a relative health URL with no base_url — a typo must fail at load", () => {
    expect(() => parseProviderConfig({ health: { url: "/status" } }))
      .toThrow(/relative path but "provider.base_url" is not set/);
  });

  it("rejects malformed values with descriptive errors", () => {
    expect(() => parseProviderConfig("splash")).toThrow(/"provider" must be an object/);
    expect(() => parseProviderConfig({ health: {} })).toThrow(/"provider.health.url"/);
    expect(() => parseProviderConfig({ health: { url: "  " } })).toThrow(/"provider.health.url"/);
    expect(() => parseProviderConfig({ health: { url: "http://x", method: "PATCH" } })).toThrow(/unknown method "PATCH"/);
    expect(() => parseProviderConfig({ health: { url: "http://x", timeout_sec: 0 } })).toThrow(/positive number/);
    expect(() => parseProviderConfig({ health: { url: "http://x", pass: [] } })).toThrow(/"provider.health.pass" must be an object/);
    expect(() => parseProviderConfig({ health: { url: "http://x", pass: {} } })).toThrow(/"provider.health.pass.path"/);
    expect(() => parseProviderConfig({ health: { url: "http://x", pass: { path: "a", one_of: 3 } } })).toThrow(/"provider.health.pass.one_of" must be an array/);
  });
});

describe("resolveHealthUrl (#134)", () => {
  it("passes absolute URLs through and joins relative ones", () => {
    expect(resolveHealthUrl("http://box:9000/status", "http://other")).toBe("http://box:9000/status");
    expect(resolveHealthUrl("/status", "http://box:9000")).toBe("http://box:9000/status");
    expect(resolveHealthUrl("status", "http://box:9000/")).toBe("http://box:9000/status");
    expect(resolveHealthUrl("/v1/models", "http://box:9000/v1")).toBe("http://box:9000/v1/v1/models");
    expect(resolveHealthUrl("/status", null)).toBeNull();
  });
});

describe("jsonEquals (#134)", () => {
  it("is deep and key-order independent", () => {
    expect(jsonEquals({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals("true", true)).toBe(false);
    expect(jsonEquals(null, undefined)).toBe(false);
    expect(jsonEquals(null, null)).toBe(true);
  });
});

describe("evaluateHealthResponse (#134)", () => {
  const splashReady = JSON.stringify({
    ready: true,
    memory_pressure: "nominal",
    admission: { waiting: 0, waiting_memory: 0 },
  });

  it("fails any non-2xx, even without a pass rule", () => {
    expect(evaluateHealthResponse(500, "boom", undefined)).toEqual({ ok: false, detail: "HTTP 500" });
    expect(evaluateHealthResponse(503, "{}", { path: "ready", equals: true })).toEqual({ ok: false, detail: "HTTP 503" });
  });

  it("passes any 2xx when no pass rule is declared", () => {
    expect(evaluateHealthResponse(200, "anything", undefined)).toEqual({ ok: true, detail: "HTTP 200" });
  });

  it("passes a healthy recorded Splash /status payload", () => {
    expect(evaluateHealthResponse(200, splashReady, { path: "ready", equals: true }).ok).toBe(true);
  });

  it("fails ready:false", () => {
    const body = JSON.stringify({ ready: false, memory_pressure: "nominal" });
    const verdict = evaluateHealthResponse(200, body, { path: "ready", equals: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('field "ready" is false');
  });

  it("fails memory_pressure critical via a not rule, passes other values", () => {
    const critical = JSON.stringify({ ready: true, memory_pressure: "critical" });
    const nominal = JSON.stringify({ ready: true, memory_pressure: "nominal" });
    expect(evaluateHealthResponse(200, critical, { path: "memory_pressure", not: "critical" }).ok).toBe(false);
    expect(evaluateHealthResponse(200, nominal, { path: "memory_pressure", not: "critical" }).ok).toBe(true);
  });

  it("evaluates one_of and nested paths", () => {
    expect(evaluateHealthResponse(200, splashReady, { path: "memory_pressure", one_of: ["nominal", "elevated"] }).ok).toBe(true);
    expect(evaluateHealthResponse(200, splashReady, { path: "admission.waiting", equals: 0 }).ok).toBe(true);
    expect(evaluateHealthResponse(200, splashReady, { path: "admission.waiting", equals: 5 }).ok).toBe(false);
  });

  it("fails a non-JSON body, a missing field, and an empty rule with the field absent", () => {
    expect(evaluateHealthResponse(200, "<html>up</html>", { path: "ready" })).toEqual({ ok: false, detail: "response body is not JSON" });
    expect(evaluateHealthResponse(200, "{}", { path: "ready", equals: true })).toEqual({ ok: false, detail: 'field "ready" is missing' });
    expect(evaluateHealthResponse(200, "{}", { path: "ready" }).ok).toBe(false);
    expect(evaluateHealthResponse(200, '{"ready":1}', { path: "ready" }).ok).toBe(true);
  });

  it("evaluates a non-Splash /v1/models body with a presence rule", () => {
    const models = JSON.stringify({ object: "list", data: [{ id: "qwen3.8-27b" }] });
    expect(evaluateHealthResponse(200, models, { path: "data" }).ok).toBe(true);
    expect(evaluateHealthResponse(200, models, { path: "data.0.id", equals: "qwen3.8-27b" }).ok).toBe(true);
  });
});
