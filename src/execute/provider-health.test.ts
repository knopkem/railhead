import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import {
  noteProviderHealth,
  probeConfiguredProvider,
  probeProviderHealth,
  resetProviderHealthForTest,
  setProviderHealth,
} from "./provider-health.ts";

/** A throwaway local HTTP server — these tests exercise the real fetch path
 *  against fixtures, never an external provider. */
async function serve(handler: (path: string, res: import("node:http").ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => handler(req.url ?? "/", res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetProviderHealthForTest();
  while (cleanups.length) await cleanups.pop()!();
});

function track<T extends { close: () => Promise<void> }>(server: T): T {
  cleanups.push(server.close);
  return server;
}

describe("probeProviderHealth (#134)", () => {
  it("passes the recorded Splash healthy payload and fails ready:false / memory_pressure critical", async () => {
    const body = (ready: boolean, pressure: string) =>
      JSON.stringify({ ready, memory_pressure: pressure, admission: { waiting: 0, waiting_memory: 0 } });
    const server = track(await serve((path, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(path.includes("critical") ? body(true, "critical") : body(!path.includes("unready"), "nominal"));
    }));

    expect((await probeProviderHealth({ url: "/status", pass: { path: "ready", equals: true } }, server.url)).ok).toBe(true);
    expect((await probeProviderHealth({ url: "/unready", pass: { path: "ready", equals: true } }, server.url)).detail).toContain('field "ready" is false');
    expect((await probeProviderHealth({ url: "/critical", pass: { path: "memory_pressure", not: "critical" } }, server.url)).detail).toContain('field "memory_pressure" is "critical"');
  });

  it("evaluates a non-Splash /v1/models shape with a presence rule", async () => {
    const server = track(await serve((_path, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3.8-27b" }] }));
    }));
    expect((await probeProviderHealth({ url: "/v1/models", pass: { path: "data" } }, server.url)).ok).toBe(true);
  });

  it("fails 5xx and non-JSON bodies", async () => {
    const server = track(await serve((path, res) => {
      if (path === "/boom") {
        res.writeHead(503);
        res.end("down");
        return;
      }
      res.writeHead(200);
      res.end("<html>up</html>");
    }));
    expect(await probeProviderHealth({ url: "/boom" }, server.url)).toEqual({ ok: false, detail: "HTTP 503" });
    expect((await probeProviderHealth({ url: "/html", pass: { path: "ready" } }, server.url)).detail).toContain("not JSON");
  });

  it("fails fast with a timeout detail when the health endpoint never answers", async () => {
    const server = track(await serve((_path, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("{}");
      }, 800);
    }));
    const verdict = await probeProviderHealth({ url: "/status", timeout_sec: 0.1 }, server.url);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("timed out after 0.1s");
  });

  it("surfaces a refused connection with the socket code", async () => {
    const server = await serve((_path, res) => res.end("{}"));
    const url = server.url;
    await server.close();
    const verdict = await probeProviderHealth({ url: "/status" }, url);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/ECONNREFUSED|fetch failed/);
  });

  it("reports a relative URL that has no base to resolve against", async () => {
    const verdict = await probeProviderHealth({ url: "/status" }, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("no provider.base_url");
  });
});

describe("configured provider lifecycle (#134)", () => {
  it("probes only when a config is installed, and reports the fail→ok restart transition once", async () => {
    let healthy = false;
    const server = track(await serve((_path, res) => {
      res.writeHead(healthy ? 200 : 503);
      res.end("{}");
    }));

    expect(await probeConfiguredProvider()).toBeNull();

    setProviderHealth({ base_url: server.url, health: { url: "/status" } });
    const down = await probeConfiguredProvider();
    expect(down?.ok).toBe(false);
    expect(noteProviderHealth(down!.ok)).toBe(false);

    healthy = true;
    const up = await probeConfiguredProvider();
    expect(up?.ok).toBe(true);
    expect(noteProviderHealth(up!.ok)).toBe(true);
    // Steady state: no repeated "restarted" signal.
    expect(noteProviderHealth(true)).toBe(false);

    setProviderHealth(null);
    expect(await probeConfiguredProvider()).toBeNull();
  });
});
