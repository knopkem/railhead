import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  RAILHEAD_IGNORES,
  ensureProjectGitignore,
  frameworkIgnoreForVerify,
  frameworkExternalDirsForVerify,
  ensureProjectOpenCodePermissions,
  detectFramework,
  detectToolchains,
  frameworkSmokeRun,
  detectGameCanvas,
} from "./project-assets.ts";

async function makeCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pa-"));
}

describe("frameworkIgnoreForVerify", () => {
  it("returns Rust target/ for cargo", () => {
    expect(frameworkIgnoreForVerify(["cargo build", "cargo test"])).toContain("/target");
  });

  it("returns node_modules/, dist/, build/ for npm", () => {
    const out = frameworkIgnoreForVerify(["npm test", "tsc --noEmit"]);
    expect(out).toEqual(expect.arrayContaining(["node_modules/", "dist/", "build/"]));
    expect(out).toContain("*.tsbuildinfo");
  });

  it("detects pnpm and yarn as JS toolchains", () => {
    expect(frameworkIgnoreForVerify(["pnpm test"])).toContain("node_modules/");
    expect(frameworkIgnoreForVerify(["yarn test"])).toContain("node_modules/");
  });

  it("returns __pycache__/, *.pyc, .venv/ for pytest", () => {
    const out = frameworkIgnoreForVerify(["pytest", "ruff check ."]);
    expect(out).toEqual(expect.arrayContaining(["__pycache__/", "*.pyc", ".venv/"]));
  });

  it("returns Go artifacts for go test", () => {
    const out = frameworkIgnoreForVerify(["go test ./...", "go build"]);
    expect(out).toContain("*.exe");
  });

  it("returns bin/, obj/ for dotnet", () => {
    const out = frameworkIgnoreForVerify(["dotnet build", "dotnet test"]);
    expect(out).toEqual(expect.arrayContaining(["bin/", "obj/"]));
  });

  it("returns maven/gradle artifacts", () => {
    expect(frameworkIgnoreForVerify(["mvn test"])).toContain("*.class");
    expect(frameworkIgnoreForVerify(["./gradlew test"])).toContain(".gradle/");
  });

  it("returns [] when no toolchain signal is recognised", () => {
    expect(frameworkIgnoreForVerify(["make", "echo ok"])).toEqual([]);
  });

  it("returns [] for an empty verify list", () => {
    expect(frameworkIgnoreForVerify([])).toEqual([]);
  });

  it("unions ignores when multiple toolchains appear", () => {
    const out = frameworkIgnoreForVerify(["cargo build", "npm test"]);
    expect(out).toContain("/target");
    expect(out).toContain("node_modules/");
  });

  it("does not match the bare word 'cargo' inside longer tokens (word boundary)", () => {
    expect(frameworkIgnoreForVerify(["mercator build"])).toEqual([]);
  });
});

describe("ensureProjectGitignore", () => {
  it("creates .gitignore with railhead ignores when none exists", async () => {
    const cwd = await makeCwd();
    await ensureProjectGitignore(cwd);
    const after = await readFile(join(cwd, ".gitignore"), "utf8");
    for (const line of RAILHEAD_IGNORES) {
      expect(after.split("\n")).toContain(line);
    }
  });

  it("appends only missing railhead ignores, preserving user lines verbatim", async () => {
    const cwd = await makeCwd();
    const userContent = "# my ignores\nnode_modules/\n.railhead/\n";
    await writeFile(join(cwd, ".gitignore"), userContent, "utf8");
    await ensureProjectGitignore(cwd);
    const after = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(after.startsWith("# my ignores\nnode_modules/\n.railhead/\n")).toBe(true);
    expect(after.split("\n")).toContain(".scratch/");
    expect(after.split("\n")).toContain("railhead.contracts.json");
    expect(after).not.toMatch(/\.railhead\/\n\.railhead\//);
  });

  it("is idempotent", async () => {
    const cwd = await makeCwd();
    await ensureProjectGitignore(cwd);
    const once = await readFile(join(cwd, ".gitignore"), "utf8");
    await ensureProjectGitignore(cwd);
    const twice = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(twice).toBe(once);
  });

  it("never truncates a corrupted/partial .gitignore — appends only", async () => {
    const cwd = await makeCwd();
    const partial = "node_modules"; // no trailing newline, no railhead dirs
    await writeFile(join(cwd, ".gitignore"), partial, "utf8");
    await ensureProjectGitignore(cwd);
    const after = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(after.startsWith("node_modules\n")).toBe(true);
    expect(after).toContain(".railhead/");
  });

  it("appends framework-specific extra lines from verify commands", async () => {
    const cwd = await makeCwd();
    const extra = frameworkIgnoreForVerify(["cargo build", "cargo test"]);
    expect(extra).toContain("/target");
    await ensureProjectGitignore(cwd, extra);
    const after = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(after.split("\n")).toContain("/target");
  });

  it("does not duplicate extra lines already present in the user's .gitignore", async () => {
    const cwd = await makeCwd();
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n/target\n", "utf8");
    await ensureProjectGitignore(cwd, frameworkIgnoreForVerify(["npm test", "cargo build"]));
    const after = await readFile(join(cwd, ".gitignore"), "utf8");
    const nodeCount = after.split("\n").filter((l) => l === "node_modules/").length;
    const targetCount = after.split("\n").filter((l) => l === "/target").length;
    expect(nodeCount).toBe(1);
    expect(targetCount).toBe(1);
  });
});

describe("frameworkExternalDirsForVerify", () => {
  // The snake-qwen run died on opencode's external_directory auto-reject of
  // ~/.cargo/registry/src/.../termion-4.0.6/src/*. The railhead should pre-grant
  // the toolchain's external dep dirs at plan/start time so the implementer
  // can read crate / package / module source without each read tripping an
  // auto-reject. Same shape and signature as frameworkIgnoreForVerify so the
  // verify-driven inference rule is one recognisable pattern.

  it("returns ~/.cargo/** and ~/.rustup/** for cargo", () => {
    const out = frameworkExternalDirsForVerify(["cargo build", "cargo test"]);
    expect(out).toEqual(expect.arrayContaining(["~/.cargo/**", "~/.rustup/**"]));
  });

  it("returns ~/.npm/** for npm", () => {
    const out = frameworkExternalDirsForVerify(["npm test"]);
    expect(out).toContain("~/.npm/**");
  });

  it("detects pnpm and yarn stores", () => {
    expect(frameworkExternalDirsForVerify(["pnpm test"])).toContain("~/.pnpm-store/**");
    expect(frameworkExternalDirsForVerify(["yarn test"])).toContain("~/.yarn/**");
  });

  it("returns Go module cache for go", () => {
    expect(frameworkExternalDirsForVerify(["go test ./..."])).toContain("~/go/pkg/mod/**");
  });

  it("returns ~/.nuget/packages/** for dotnet", () => {
    expect(frameworkExternalDirsForVerify(["dotnet build"])).toContain("~/.nuget/packages/**");
  });

  it("returns ~/.m2/** and ~/.gradle/** for jvm toolchains", () => {
    const out = frameworkExternalDirsForVerify(["mvn test", "./gradlew build"]);
    expect(out).toEqual(expect.arrayContaining(["~/.m2/**", "~/.gradle/**"]));
  });

  it("returns [] when no toolchain signal is recognised", () => {
    expect(frameworkExternalDirsForVerify(["make", "echo ok"])).toEqual([]);
  });

  it("returns [] for an empty verify list", () => {
    expect(frameworkExternalDirsForVerify([])).toEqual([]);
  });

  it("unions dirs when multiple toolchains appear", () => {
    const out = frameworkExternalDirsForVerify(["cargo build", "npm test"]);
    expect(out).toContain("~/.cargo/**");
    expect(out).toContain("~/.npm/**");
  });

  it("does not match the bare word 'cargo' inside longer tokens (word boundary)", () => {
    expect(frameworkExternalDirsForVerify(["mercator build"])).toEqual([]);
  });
});

describe("ensureProjectOpenCodePermissions", () => {
  async function readConfig(cwd: string): Promise<any> {
    const raw = await readFile(join(cwd, "opencode.json"), "utf8");
    return JSON.parse(raw);
  }

  it("creates opencode.json with $schema and the permission block when none exists", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    expect(cfg.permission.external_directory["~/.cargo/**"]).toBe("allow");
  });

  it("is idempotent — running twice yields the same file content", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**", "~/.rustup/**"]);
    const once = await readFile(join(cwd, "opencode.json"), "utf8");
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**", "~/.rustup/**"]);
    const twice = await readFile(join(cwd, "opencode.json"), "utf8");
    expect(twice).toBe(once);
  });

  it("preserves a user-authored opencode.json verbatim — only adds missing external_directory allow rules", async () => {
    const cwd = await makeCwd();
    const user = {
      $schema: "https://opencode.ai/config.json",
      model: "neuralwatt/qwen3.6-35b-fast",
      permission: {
        bash: { "git *": "allow", "*": "ask" },
        external_directory: { "~/.secrets/**": "deny" },
      },
    };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify(user, null, 2), "utf8");
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    // User fields survive.
    expect(cfg.model).toBe("neuralwatt/qwen3.6-35b-fast");
    expect(cfg.permission.bash["git *"]).toBe("allow");
    expect(cfg.permission.external_directory["~/.secrets/**"]).toBe("deny");
    // The new allow rule is added alongside the user's deny.
    expect(cfg.permission.external_directory["~/.cargo/**"]).toBe("allow");
  });

  it("never overwrites a user's existing rule for the same path — explicit intent wins", async () => {
    const cwd = await makeCwd();
    const user = {
      $schema: "https://opencode.ai/config.json",
      permission: { external_directory: { "~/.cargo/**": "deny" } },
    };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify(user, null, 2), "utf8");
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    expect(cfg.permission.external_directory["~/.cargo/**"]).toBe("deny");
  });

  it("grants /tmp and /private/tmp even when no toolchain dirs are requested — never blocks scratch files", async () => {
    const cwd = await makeCwd();
    const user = { $schema: "https://opencode.ai/config.json", model: "x" };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify(user, null, 2), "utf8");
    await ensureProjectOpenCodePermissions(cwd, []);
    const cfg = await readConfig(cwd);
    expect(cfg.permission.external_directory["/tmp/*"]).toBe("allow");
    expect(cfg.permission.external_directory["/private/tmp/*"]).toBe("allow");
  });

  it("does not duplicate allow rules across calls when the path list changes", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**", "~/.rustup/**"]);
    const cfg = await readConfig(cwd);
    expect(Object.keys(cfg.permission.external_directory).filter((k) => k === "~/.cargo/**").length).toBe(1);
    expect(cfg.permission.external_directory["~/.rustup/**"]).toBe("allow");
  });

  it("pre-grants /tmp/* and /private/tmp/* alongside toolchain dirs", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    expect(cfg.permission.external_directory["/tmp/*"]).toBe("allow");
    expect(cfg.permission.external_directory["/private/tmp/*"]).toBe("allow");
    expect(cfg.permission.external_directory["~/.cargo/**"]).toBe("allow");
  });

  it("pre-grants /tmp/* and /private/tmp/* even when no toolchain dirs are detected", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, []);
    const cfg = await readConfig(cwd);
    expect(cfg.permission.external_directory["/tmp/*"]).toBe("allow");
    expect(cfg.permission.external_directory["/private/tmp/*"]).toBe("allow");
  });

  it("respects a user's explicit deny for /tmp — never overwrites intent", async () => {
    const cwd = await makeCwd();
    const user = {
      $schema: "https://opencode.ai/config.json",
      permission: { external_directory: { "/tmp/*": "deny" } },
    };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify(user, null, 2), "utf8");
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    expect(cfg.permission.external_directory["/tmp/*"]).toBe("deny");
  });

  it("yolo: writes accept-all for every tool + a '**' external_directory catch-all, even with no allowDirs", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], { yolo: true });
    const cfg = await readConfig(cwd);
    expect(cfg.permission.bash).toBe("allow");
    expect(cfg.permission.read).toBe("allow");
    expect(cfg.permission.edit).toBe("allow");
    expect(cfg.permission.external_directory["**"]).toBe("allow");
  });

  it("yolo: preserves a user's explicit per-tool rule (only fills ABSENT keys)", async () => {
    const cwd = await makeCwd();
    const user = {
      $schema: "https://opencode.ai/config.json",
      permission: { bash: { "git *": "allow", "*": "ask" } },
    };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify(user, null, 2), "utf8");
    await ensureProjectOpenCodePermissions(cwd, [], { yolo: true });
    const cfg = await readConfig(cwd);
    // The user's bash rule survives (yolo only fills absent keys).
    expect(cfg.permission.bash["*"]).toBe("ask");
    // read/edit were absent — yolo fills them.
    expect(cfg.permission.read).toBe("allow");
    expect(cfg.permission.edit).toBe("allow");
    expect(cfg.permission.external_directory["**"]).toBe("allow");
  });

  it("yolo: is idempotent — second call writes nothing new", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], { yolo: true });
    const once = await readFile(join(cwd, "opencode.json"), "utf8");
    await ensureProjectOpenCodePermissions(cwd, [], { yolo: true });
    const twice = await readFile(join(cwd, "opencode.json"), "utf8");
    expect(twice).toBe(once);
  });

  it("yolo-then-verify-dirs: the planner's two-call sequence (yolo grant before runPlan, verify-derived dirs after) is additive", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], { yolo: true });
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"], { yolo: true });
    const cfg = await readConfig(cwd);
    expect(cfg.permission.external_directory["**"]).toBe("allow");
  });

  it("enables compaction.auto so a mid-run session can free context instead of hitting the hard kill (#54)", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true });
  });

  it("sets compaction.reserved to 10% of the context budget when contextTokens is provided", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"], { contextTokens: 100000 });
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true, reserved: 10000 });
  });

  it("omits reserved when no contextTokens is provided (backward compat)", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true });
    expect(cfg.compaction).not.toHaveProperty("reserved");
  });

  it("floors the reserved value (no fractional tokens)", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"], { contextTokens: 65000 });
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true, reserved: 6500 });
  });

  it("does not overwrite a user's existing compaction setting — explicit intent wins", async () => {
    const cwd = await makeCwd();
    const user = {
      $schema: "https://opencode.ai/config.json",
      compaction: { auto: true, reserved: 20000 },
    };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify(user, null, 2), "utf8");
    await ensureProjectOpenCodePermissions(cwd, ["~/.cargo/**"]);
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true, reserved: 20000 });
  });

  it("enables compaction.auto even when no toolchain dirs are detected (no early-return bypass)", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, []);
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true });
  });

  it("sets compaction.reserved even with no toolchain dirs when contextTokens is provided", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], { contextTokens: 230000 });
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true, reserved: 23000 });
  });

  it("sets reasoningEffort to medium for the implement model", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], { implementModel: "mtplx/mtplx-qwen38-27b-optimized-speed", clampReasoning: true });
    const cfg = await readConfig(cwd);
    expect(cfg.provider.mtplx.models["mtplx-qwen38-27b-optimized-speed"].options.reasoningEffort).toBe("medium");
  });

  it("does not set reasoningEffort when implementModel is 'default'", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], { implementModel: "default", clampReasoning: true });
    const cfg = await readConfig(cwd);
    expect(cfg.provider).toBeUndefined();
  });

  it("does not set reasoningEffort when clampReasoning is not true", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], { implementModel: "mtplx/some-model" });
    const cfg = await readConfig(cwd);
    expect(cfg.provider).toBeUndefined();
  });

  it("does not set reasoningEffort when implementModel is null/undefined", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, []);
    const cfg = await readConfig(cwd);
    expect(cfg.provider).toBeUndefined();
  });

  it("does not overwrite a user's existing reasoningEffort setting", async () => {
    const cwd = await makeCwd();
    const user = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        mtxpl: {
          models: {
            "mtplx-qwen38-27b-optimized-speed": {
              options: { reasoningEffort: "high" },
            },
          },
        },
      },
    };
    await writeFile(join(cwd, "opencode.json"), JSON.stringify(user, null, 2), "utf8");
    await ensureProjectOpenCodePermissions(cwd, [], { implementModel: "mtplx/mtplx-qwen38-27b-optimized-speed", clampReasoning: true });
    const cfg = await readConfig(cwd);
    expect(cfg.provider.mtxpl.models["mtplx-qwen38-27b-optimized-speed"].options.reasoningEffort).toBe("high");
  });

  it("sets reasoningEffort alongside compaction when both options are provided", async () => {
    const cwd = await makeCwd();
    await ensureProjectOpenCodePermissions(cwd, [], {
      contextTokens: 100000,
      implementModel: "mtplx/some-model",
      clampReasoning: true,
    });
    const cfg = await readConfig(cwd);
    expect(cfg.compaction).toEqual({ auto: true, reserved: 10000 });
    expect(cfg.provider.mtplx.models["some-model"].options.reasoningEffort).toBe("medium");
  });
});

describe("detectToolchains", () => {
  it("classifies each supported toolchain from its own trigger tokens", () => {
    expect(detectToolchains(["cargo test", "cargo build"])).toEqual(["rust-bin"]);
    expect(detectToolchains(["npm test"])).toEqual(["node"]);
    expect(detectToolchains(["pnpm test"])).toEqual(["node"]);
    expect(detectToolchains(["pytest", "ruff check ."])).toEqual(["python"]);
    expect(detectToolchains(["go test ./..."])).toEqual(["go"]);
    expect(detectToolchains(["dotnet build", "dotnet test"])).toEqual(["dotnet"]);
    expect(detectToolchains(["mvn test"])).toEqual(["jvm"]);
    expect(detectToolchains(["./gradlew build"])).toEqual(["jvm"]);
  });

  it("unions across toolchains in one verify list (a monorepo)", () => {
    expect(detectToolchains(["cargo build", "npm test"])).toEqual(["rust-bin", "node"]);
  });

  it("returns [] when no toolchain signal is recognised", () => {
    expect(detectToolchains(["make", "echo ok"])).toEqual([]);
    expect(detectToolchains([])).toEqual([]);
  });

  it("does not match the bare word 'cargo' inside longer tokens (word boundary)", () => {
    expect(detectToolchains(["mercator build"])).toEqual([]);
  });
});

describe("detectFramework", () => {
  it("returns 'rust-bin' for cargo with a run command (smokable)", () => {
    expect(detectFramework(["cargo build", "cargo test"], ["cargo run"])).toBe("rust-bin");
  });

  it("returns 'node' for npm/pnpm/yarn run commands", () => {
    expect(detectFramework(["npm test"], ["npm start"])).toBe("node");
    expect(detectFramework(["pnpm test"], ["pnpm dev"])).toBe("node");
  });

  it("returns 'python' for a python project with a launch command", () => {
    expect(detectFramework(["pytest", "ruff check ."], ["python app.py"])).toBe("python");
  });

  it("returns 'dotnet' for a dotnet project with `dotnet run`", () => {
    expect(detectFramework(["dotnet build", "dotnet test"], ["dotnet run"])).toBe("dotnet");
  });

  it("returns 'jvm' for a gradle project with a runnable launch", () => {
    expect(detectFramework(["gradle build"], ["gradle run"])).toBe("jvm");
  });

  it("returns null for go — no launcher token is recognised yet, even with `go run`", () => {
    expect(detectFramework(["go test ./..."], ["go run ./cmd/app"])).toBeNull();
  });

  it("returns null when no binary-looking run command is present (no smoke makes sense)", () => {
    expect(detectFramework(["tsc --noEmit"], [])).toBeNull();
    expect(detectFramework(["pytest"], [])).toBeNull();
  });

  it("returns null for an empty verify list", () => {
    expect(detectFramework([], [])).toBeNull();
  });

  it("does not mis-detect 'cargo' embedded in a longer word", () => {
    expect(detectFramework(["mercator build"], [])).toBeNull();
  });
});

describe("frameworkSmokeRun", () => {
  it("rust-bin: emits the run command with NO env injection — the binary runs exactly as `cargo run` would, so a real startup panic surfaces (an earlier NO_VIDEO=1 version let the implementer skip the panicking code path)", () => {
    const smoke = frameworkSmokeRun("rust-bin", ["cargo run --bin pong"]);
    expect(smoke).not.toBeNull();
    expect(smoke!.command).toBe("cargo run --bin pong");
    expect(smoke!.env).toEqual({});
  });

  it("node: forwards the project's own dev/start script (the package.json already knows how)", () => {
    const smoke = frameworkSmokeRun("node", ["npm start"]);
    expect(smoke).not.toBeNull();
    expect(smoke!.command).toBe("npm start");
    expect(smoke!.env).toEqual({});
  });

  it("returns null when no run command is available to smoke (skip the phase, do not fail)", () => {
    expect(frameworkSmokeRun("rust-bin", [])).toBeNull();
    expect(frameworkSmokeRun("node", [])).toBeNull();
  });
});

describe("detectGameCanvas", () => {
  async function writePkg(cwd: string, pkg: Record<string, unknown>): Promise<void> {
    await writeFile(join(cwd, "package.json"), JSON.stringify(pkg), "utf8");
  }

  it("detects Three.js as a game canvas project (#20)", async () => {
    const cwd = await makeCwd();
    await writePkg(cwd, { dependencies: { three: "^0.160.0" } });
    expect(await detectGameCanvas(cwd)).toBe(true);
  });

  it("detects Phaser as a game canvas project (#20)", async () => {
    const cwd = await makeCwd();
    await writePkg(cwd, { dependencies: { phaser: "^3.70.0" } });
    expect(await detectGameCanvas(cwd)).toBe(true);
  });

  it("detects Babylon.js as a game canvas project (#20)", async () => {
    const cwd = await makeCwd();
    await writePkg(cwd, { dependencies: { "@babylonjs/core": "^6.0.0" } });
    expect(await detectGameCanvas(cwd)).toBe(true);
  });

  it("returns false for a non-game project (#20)", async () => {
    const cwd = await makeCwd();
    await writePkg(cwd, { dependencies: { express: "^4.18.0", react: "^18.0.0" } });
    expect(await detectGameCanvas(cwd)).toBe(false);
  });

  it("returns false when package.json is missing or unreadable (#20)", async () => {
    const cwd = await makeCwd();
    expect(await detectGameCanvas(cwd)).toBe(false);
  });

  it("checks devDependencies too (#20)", async () => {
    const cwd = await makeCwd();
    await writePkg(cwd, { dependencies: {}, devDependencies: { three: "^0.160.0" } });
    expect(await detectGameCanvas(cwd)).toBe(true);
  });

  it("does not false-match on package names containing 'three' as a substring (#20)", async () => {
    const cwd = await makeCwd();
    await writePkg(cwd, { dependencies: { "threebody-force": "^1.0.0" } });
    expect(await detectGameCanvas(cwd)).toBe(false);
  });
});
