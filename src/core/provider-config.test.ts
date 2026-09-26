import { describe, it, expect } from "vitest";
import { parseDisabledTimeoutWarnings } from "./provider-config.ts";

describe("parseDisabledTimeoutWarnings (#134)", () => {
  it("warns for a provider whose request timeouts are all disabled", () => {
    const raw = JSON.stringify({
      provider: {
        splash: {
          options: { baseURL: "http://box:8080", timeout: false, headerTimeout: false, chunkTimeout: false },
        },
      },
    });
    const warnings = parseDisabledTimeoutWarnings(raw, new Set(["splash/any-model"]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provider "splash"');
    expect(warnings[0]).toContain("disables all request timeouts");
  });

  it("warns per offending model scope and stays quiet when any timeout is finite", () => {
    const raw = JSON.stringify({
      provider: {
        mixed: {
          options: { timeout: 30 },
          models: {
            a: { options: { timeout: false, headerTimeout: false, chunkTimeout: false } },
            b: { options: { timeout: false, headerTimeout: false, chunkTimeout: 5 } },
          },
        },
      },
    });
    const warnings = parseDisabledTimeoutWarnings(raw, new Set(["mixed/a"]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('model "a"');
    expect(parseDisabledTimeoutWarnings(raw, new Set(["mixed/b"]))).toEqual([]);
  });

  it("stays quiet for a disabled provider the run never spawns (the false positive)", () => {
    const raw = JSON.stringify({
      model: "opencode/mimo-v2.6-flash-free",
      provider: {
        spark: {
          options: { baseURL: "http://box:1234", timeout: false, headerTimeout: false, chunkTimeout: false },
          models: { local: {} },
        },
      },
    });
    expect(parseDisabledTimeoutWarnings(raw, new Set(["opencode/mimo-v2.6-flash-free"]))).toEqual([]);
    // The same config does warn once a seat actually lands on the provider.
    expect(parseDisabledTimeoutWarnings(raw, new Set(["spark/local"]))).toHaveLength(1);
  });

  it("expands a default seat to the config's own model", () => {
    const raw = JSON.stringify({
      model: "spark/local",
      provider: { spark: { options: { timeout: false, headerTimeout: false, chunkTimeout: false } } },
    });
    expect(parseDisabledTimeoutWarnings(raw, new Set(["default"]))).toHaveLength(1);
  });

  it("matches a bare model reference by model id", () => {
    const raw = JSON.stringify({
      provider: {
        spark: { models: { local: { options: { timeout: false, headerTimeout: false, chunkTimeout: false } } } },
      },
    });
    expect(parseDisabledTimeoutWarnings(raw, new Set(["local"]))).toHaveLength(1);
    expect(parseDisabledTimeoutWarnings(raw, new Set(["other"]))).toEqual([]);
  });

  it("returns no warnings for a healthy config, a config without providers, or no used models", () => {
    expect(parseDisabledTimeoutWarnings(JSON.stringify({ provider: { p: { options: { timeout: 60 } } } }), new Set(["p/x"]))).toEqual([]);
    expect(parseDisabledTimeoutWarnings(JSON.stringify({ model: "x" }), new Set(["p/x"]))).toEqual([]);
    const disabled = JSON.stringify({
      provider: { p: { options: { timeout: false, headerTimeout: false, chunkTimeout: false } } },
    });
    expect(parseDisabledTimeoutWarnings(disabled, new Set())).toEqual([]);
  });

  it("degrades quietly on malformed output, including leading noise", () => {
    expect(parseDisabledTimeoutWarnings("not json at all", new Set(["p/x"]))).toEqual([]);
    expect(parseDisabledTimeoutWarnings(`warning: something\n${JSON.stringify({
      provider: { p: { options: { timeout: false, headerTimeout: false, chunkTimeout: false } } },
    })}`, new Set(["p/x"]))).toHaveLength(1);
  });
});
