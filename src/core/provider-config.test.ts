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
    const warnings = parseDisabledTimeoutWarnings(raw);
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
    const warnings = parseDisabledTimeoutWarnings(raw);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('model "a"');
  });

  it("returns no warnings for a healthy config or a config without providers", () => {
    expect(parseDisabledTimeoutWarnings(JSON.stringify({ provider: { p: { options: { timeout: 60 } } } }))).toEqual([]);
    expect(parseDisabledTimeoutWarnings(JSON.stringify({ model: "x" }))).toEqual([]);
  });

  it("degrades quietly on malformed output, including leading noise", () => {
    expect(parseDisabledTimeoutWarnings("not json at all")).toEqual([]);
    expect(parseDisabledTimeoutWarnings(`warning: something\n${JSON.stringify({
      provider: { p: { options: { timeout: false, headerTimeout: false, chunkTimeout: false } } },
    })}`)).toHaveLength(1);
  });
});
