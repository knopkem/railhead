import { describe, it, expect } from "vitest";
import { LEDGER_GUARD_CONFIG, guardedEnv, setDependencySourceDeny } from "./guard.ts";

describe("LEDGER_GUARD_CONFIG", () => {
  it("is valid inline opencode config that denies deleting the ledger", () => {
    const cfg = JSON.parse(LEDGER_GUARD_CONFIG) as {
      permission: { bash: Record<string, string>; edit: Record<string, string>; write: Record<string, string> };
    };
    const bash = cfg.permission.bash;
    const edit = cfg.permission.edit;
    const write = cfg.permission.write;

    expect(bash["rm -rf .railhead*"]).toBe("deny");
    expect(bash["rm -r ./.railhead*"]).toBe("deny");
    expect(bash["git clean -fdx*"]).toBe("deny");
    expect(edit["*.railhead/run-*"]).toBe("deny");
    expect(write["*.railhead/run-*"]).toBe("deny");
    // The unattended run still relies on bash/edit/write being allowed otherwise.
    expect(bash["*"]).toBe("allow");
    expect(edit["*"]).toBe("allow");
    expect(write["*"]).toBe("allow");
  });
});

describe("guardedEnv", () => {
  it("sets the guard without mutating the input env", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/home/x" };
    const out = guardedEnv(base);

    const cfg = JSON.parse(out.OPENCODE_CONFIG_CONTENT!) as { permission: Record<string, unknown>; agent: Record<string, unknown> };
    expect(cfg.permission).toBeDefined();
    expect(base.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(out.PATH).toBe("/bin");
  });

  it("injects the reviewer agents alongside the ledger guard", () => {
    const out = guardedEnv({} as NodeJS.ProcessEnv);
    const cfg = JSON.parse(out.OPENCODE_CONFIG_CONTENT!) as {
      agent: Record<string, { mode: string; permission: Record<string, unknown>; prompt: string }>;
    };

    expect(Object.keys(cfg.agent).sort()).toEqual(["railhead-reviewer", "railhead-reviewer-readmode"]);
    // The catch-all deny is the guard: opencode takes the LAST matching rule,
    // so denying `*` hides MCP/custom tools an enumerated denylist cannot name
    // (the chrome-devtools/blender escape the diff reviewer used to read files).
    expect(cfg.agent["railhead-reviewer"].permission["*"]).toBe("deny");
    expect(cfg.agent["railhead-reviewer"].permission.read).toBeUndefined();
    expect(cfg.agent["railhead-reviewer-readmode"].permission["*"]).toBe("deny");
    // read is re-allowed AFTER the catch-all, but only for the filesystem: the
    // pattern map denies the `mcp:*` space opencode gates its MCP-resource
    // tools under (the same `read` permission).
    expect(cfg.agent["railhead-reviewer-readmode"].permission.read).toEqual({ "*": "allow", "mcp:*": "deny" });
  });

  it("overrides a pre-existing inline config with the guard + agents", () => {
    const out = guardedEnv({ OPENCODE_CONFIG_CONTENT: "{}" } as NodeJS.ProcessEnv);
    const cfg = JSON.parse(out.OPENCODE_CONFIG_CONTENT!) as { permission: Record<string, unknown>; agent: Record<string, unknown> };
    expect(cfg.permission).toBeDefined();
    expect(cfg.agent).toBeDefined();
  });
});

describe("setDependencySourceDeny", () => {
  it("merges project-configured dependency-source globs as bash denies alongside the ledger guard", () => {
    // The backstop for the prompt-level rule: a model that greps a dependency
    // cache despite the Context-economy block hits a permission deny instead of
    // pulling a 5k-token source dump into a durable session.
    setDependencySourceDeny(["*/.cargo/registry/src/*", "*cd ~/.cargo*"]);
    const out = guardedEnv({} as NodeJS.ProcessEnv);
    const cfg = JSON.parse(out.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string> } };

    expect(cfg.permission.bash["*/.cargo/registry/src/*"]).toBe("deny");
    expect(cfg.permission.bash["*cd ~/.cargo*"]).toBe("deny");
    expect(cfg.permission.bash["rm -rf .railhead*"]).toBe("deny");
    expect(cfg.permission.bash["*"]).toBe("allow");
    setDependencySourceDeny([]);
  });

  it("clears cleanly — no stale denies leak into the next run in this process", () => {
    setDependencySourceDeny(["*node_modules/*"]);
    setDependencySourceDeny([]);
    const out = guardedEnv({} as NodeJS.ProcessEnv);
    const cfg = JSON.parse(out.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: Record<string, string> } };

    expect(cfg.permission.bash["*node_modules/*"]).toBeUndefined();
  });
});
