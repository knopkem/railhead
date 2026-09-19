import { describe, it, expect } from "vitest";
import {
  detectTool,
  compressVerifyOutput,
  compressVitest,
  compressTsc,
  compressGeneric,
  compressCargo,
  compressPytest,
  compressGo,
  compressGradle,
  compressMaven,
  compressDotnet,
  compactPath,
} from "./output-compress.ts";

describe("detectTool", () => {
  it("detects vitest from various invocations", () => {
    expect(detectTool(["npx vitest run"])).toBe("vitest");
    expect(detectTool(["npm test"])).toBe("vitest");
    expect(detectTool(["vitest"])).toBe("vitest");
    expect(detectTool(["npx vitest"])).toBe("vitest");
  });

  it("detects jest", () => {
    expect(detectTool(["npx jest"])).toBe("jest");
    expect(detectTool(["jest --config jest.config.js"])).toBe("jest");
  });

  it("detects pytest", () => {
    expect(detectTool(["pytest"])).toBe("pytest");
    expect(detectTool(["python -m pytest"])).toBe("pytest");
    expect(detectTool(["pytest -x"])).toBe("pytest");
  });

  it("detects cargo test", () => {
    expect(detectTool(["cargo test"])).toBe("cargo");
    expect(detectTool(["cargo nextest run"])).toBe("cargo");
  });

  it("detects go test", () => {
    expect(detectTool(["go test ./..."])).toBe("go");
    expect(detectTool(["go test -v ./pkg/..."])).toBe("go");
  });

  it("detects tsc", () => {
    expect(detectTool(["tsc --noEmit"])).toBe("tsc");
    expect(detectTool(["npm run typecheck"])).toBe("tsc");
    expect(detectTool(["npx tsc"])).toBe("tsc");
  });

  it("detects eslint", () => {
    expect(detectTool(["eslint src/"])).toBe("eslint");
    expect(detectTool(["npm run lint"])).toBe("eslint");
    expect(detectTool(["npx eslint ."])).toBe("eslint");
  });

  it("detects gradle", () => {
    expect(detectTool(["gradle build"])).toBe("gradle");
    expect(detectTool(["./gradlew test"])).toBe("gradle");
    expect(detectTool(["gradlew check"])).toBe("gradle");
  });

  it("detects maven", () => {
    expect(detectTool(["mvn test"])).toBe("maven");
    expect(detectTool(["mvn clean install"])).toBe("maven");
  });

  it("detects dotnet", () => {
    expect(detectTool(["dotnet test"])).toBe("dotnet");
    expect(detectTool(["dotnet build"])).toBe("dotnet");
  });

  it("returns generic for unknown tools", () => {
    expect(detectTool(["echo hello"])).toBe("generic");
    expect(detectTool([])).toBe("generic");
  });
});

describe("compressVitest", () => {
  it("extracts failure details and summary from vitest text output", () => {
    const output = [
      "RUN  v1.2.3 /Users/my/project",
      "",
      " ✓ src/foo.test.ts > bar > works as expected",
      " ✗ src/baz.test.ts > qux > fails badly",
      "   AssertionError: expected 5 to be 3",
      "     at /Users/my/project/src/baz.test.ts:42:7",
      "",
      " Test Files  1 failed (1) | 1 passed (2)",
      "      Tests  1 failed (3) | 2 passed (3)",
      "   Duration  450ms",
    ].join("\n");

    const result = compressVitest(output);
    expect(result).toContain("Tests: 1 failed, 2 passed, 3 total");
    expect(result).toContain("FAIL: src/baz.test.ts > qux > fails badly");
    expect(result).toContain("AssertionError: expected 5 to be 3");
    expect(result).not.toContain("✓ src/foo.test.ts");
    expect(result).not.toContain("Test Files");
    expect(result).not.toContain("Duration");
  });

  it("handles all-pass output (summary only)", () => {
    const output = [
      " ✓ src/foo.test.ts > bar > works",
      " ✓ src/baz.test.ts > qux > also works",
      "",
      " Test Files  2 passed (2)",
      "      Tests  2 passed (2)",
      "   Duration  200ms",
    ].join("\n");

    const result = compressVitest(output);
    expect(result).toContain("Tests: 0 failed, 2 passed, 2 total");
    expect(result).not.toContain("FAIL");
    expect(result).not.toContain("✓");
  });

  it("handles jest FAIL format", () => {
    const output = [
      " FAIL  src/foo.test.js",
      "  ● test name > subtest",
      "",
      "    expect(received).toBe(expected)",
      "    Expected: 5",
      "    Received: 3",
      "",
      "Tests: 1 failed, 2 passed, 3 total",
    ].join("\n");

    const result = compressVitest(output);
    expect(result).toContain("Tests: 1 failed, 2 passed, 3 total");
    expect(result).toContain("FAIL: src/foo.test.js");
    expect(result).toContain("test name > subtest");
    expect(result).toContain("Expected: 5");
    expect(result).toContain("Received: 3");
  });
});

describe("compressTsc", () => {
  it("groups errors by file and extracts key info", () => {
    const output = [
      "src/server/api/auth.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/server/api/auth.ts(15,10): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
      "src/components/Button.tsx(8,3): error TS2339: Property 'onClick' does not exist on type 'ButtonProps'.",
      "",
      "Found 3 errors in 2 files.",
    ].join("\n");

    const result = compressTsc(output);
    expect(result).toContain("TypeScript: 3 errors in 2 files");
    expect(result).toContain("src/server/api/auth.ts");
    expect(result).toContain("L12: TS2322");
    expect(result).toContain("not assignable to type 'number'");
    expect(result).toContain("L15: TS2345");
    expect(result).toContain("src/components/Button.tsx");
    expect(result).toContain("L8: TS2339");
    expect(result).not.toContain("Found 3 errors");
  });

  it("handles continuation lines", () => {
    const output = [
      "src/app.tsx(10,3): error TS2322: Type '{ children: Element; }' is not assignable to type 'Props'.",
      "  Property 'children' does not exist on type 'Props'.",
      "",
      "Found 1 error in 1 file.",
    ].join("\n");

    const result = compressTsc(output);
    expect(result).toContain("L10: TS2322");
    expect(result).toContain("Property 'children' does not exist");
  });

  it("handles zero errors", () => {
    const result = compressTsc("Found 0 errors in 0 files.");
    expect(result).toContain("No errors");
  });
});

describe("compressCargo", () => {
  const CARGO_FAIL = [
    "$ cargo check",
    "    Checking asteroid v0.1.0 (/Users/macair/projects/asteroid)",
    "warning: unused import: `bevy::prelude::*`",
    " --> src/main.rs:9:5",
    "  |",
    "9 | use bevy::prelude::*;",
    "  |     ^^^^^^^^^^^^^^^^",
    "  |",
    "  = note: `#[warn(unused_imports)]` (part of `#[warn(unused)]`) on by default",
    "",
    "warning: constant `WORLD_BOUNDS_MIN` is never used",
    " --> src/constants.rs:3:11",
    "  |",
    "3 | pub const WORLD_BOUNDS_MIN: f32 = -100.0;",
    "  |           ^^^^^^^^^^^^^^^^",
    "",
    "error[E0594]: cannot assign to `ship_transform.translation`, which is behind a `&` reference",
    "   --> src/asteroid.rs:118:17",
    "    |",
    "103 |     for (mut ship, mut ship_transform) in ship_query.iter_mut() {",
    "    |                                           --------------------- this iterator yields `&` references",
    "...",
    "118 |                 ship_transform.translation = Vec3::ZERO;",
    "    |                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ `ship_transform` is a `&` reference",
    "",
    "warning: `asteroid` (bin \"asteroid\") generated 3 warnings",
    "error: could not compile `asteroid` (bin \"asteroid\") due to 1 previous error; 3 warnings emitted",
    "",
    "$ cargo test",
    "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.10s",
    "     Running unittests src/main.rs (target/debug/deps/asteroid-d35c2af905be31f2)",
    "",
    "running 3 tests",
    "test player_combat::tests::test_player_respawns_at_center ... FAILED",
    "test player_combat::tests::test_player_asteroid_collision_decrements_life ... FAILED",
    "test player_combat::tests::test_player_invulnerability_after_respawn ... FAILED",
    "",
    "failures:",
    "",
    "---- player_combat::tests::test_player_respawns_at_center stdout ----",
    "thread 'player_combat::tests::test_player_respawns_at_center' (10978315) panicked at /Users/macair/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/bevy_ecs-0.13.2/src/system/system_param.rs:252:5:",
    "error[B0001]: Query<(&mut Ship, &mut Transform), ()> in system handle_collisions accesses component(s) Transform in a way that conflicts with a previous system parameter. Consider using `Without<T>` to create disjoint Queries or merging conflicting Queries into a `ParamSet`.",
    "Encountered a panic in system `bevy_app::main_schedule::Main::run_main`!",
    "",
    "---- player_combat::tests::test_player_asteroid_collision_decrements_life stdout ----",
    "thread 'player_combat::tests::test_player_asteroid_collision_decrements_life' (10978313) panicked at /Users/macair/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/bevy_ecs-0.13.2/src/system/system_param.rs:252:5:",
    "error[B0001]: Query<(&mut Ship, &mut Transform), ()> in system handle_collisions accesses component(s) Transform in a way that conflicts with a previous system parameter. Consider using `Without<T>` to create disjoint Queries or merging conflicting Queries into a `ParamSet`.",
    "Encountered a panic in system `bevy_app::main_schedule::Main::run_main`!",
    "",
    "---- player_combat::tests::test_player_invulnerability_after_respawn stdout ----",
    "thread 'player_combat::tests::test_player_invulnerability_after_respawn' (10978314) panicked at /Users/macair/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/bevy_ecs-0.13.2/src/system/system_param.rs:252:5:",
    "error[B0001]: Query<(&mut Ship, &mut Transform), ()> in system handle_collisions accesses component(s) Transform in a way that conflicts with a previous system parameter. Consider using `Without<T>` to create disjoint Queries or merging conflicting Queries into a `ParamSet`.",
    "Encountered a panic in system `bevy_app::main_schedule::Main::run_main`!",
    "",
    "failures:",
    "    player_combat::tests::test_player_asteroid_collision_decrements_life",
    "    player_combat::tests::test_player_invulnerability_after_respawn",
    "    player_combat::tests::test_player_respawns_at_center",
    "",
    "test result: FAILED. 0 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
    "error: test failed, to rerun pass `--bin asteroid`",
  ].join("\n");

  it("drops warnings and keeps errors", () => {
    const result = compressCargo(CARGO_FAIL);
    expect(result).toContain("error[E0594]");
    expect(result).toContain("cannot assign to `ship_transform.translation`");
    expect(result).not.toContain("warning: unused import");
    expect(result).not.toContain("WORLD_BOUNDS_MIN");
  });

  it("keeps failed test names and result summary", () => {
    const result = compressCargo(CARGO_FAIL);
    expect(result).toContain("test_player_respawns_at_center ... FAILED");
    expect(result).toContain("test result: FAILED. 0 passed; 3 failed");
  });

  it("dedups identical panic messages across tests", () => {
    const result = compressCargo(CARGO_FAIL);
    const b0001Count = (result.match(/error\[B0001\]/g) || []).length;
    expect(b0001Count).toBe(1);
  });

  it("compacts cargo registry paths to crate name", () => {
    const result = compressCargo(CARGO_FAIL);
    expect(result).not.toContain("/Users/macair/.cargo/registry/src/");
    expect(result).toContain("bevy_ecs");
  });

  it("drops passing test lines", () => {
    const output = [
      "running 3 tests",
      "test foo::test_passes ... ok",
      "test foo::test_fails ... FAILED",
      "test foo::test_passes2 ... ok",
      "test result: FAILED. 0 passed; 1 failed; 0 ignored",
    ].join("\n");
    const result = compressCargo(output);
    expect(result).toContain("test_fails ... FAILED");
    expect(result).not.toContain("test_passes ... ok");
    expect(result).not.toContain("test_passes2 ... ok");
  });

  it("handles all-pass output", () => {
    const output = [
      "running 2 tests",
      "test foo::test_a ... ok",
      "test foo::test_b ... ok",
      "test result: ok. 2 passed; 0 failed",
    ].join("\n");
    const result = compressCargo(output);
    expect(result).toContain("test result: ok. 2 passed");
    expect(result).not.toContain("test_a");
  });

  it("handles successful compilation with no tests", () => {
    const output = [
      "    Checking asteroid v0.1.0 (/Users/macair/projects/asteroid)",
      "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.42s",
    ].join("\n");
    const result = compressCargo(output);
    expect(result.length).toBeLessThanOrEqual(output.length);
  });

  it("never returns output larger than input", () => {
    const tiny = "cargo check\nok";
    const result = compressCargo(tiny);
    expect(result.length).toBeLessThanOrEqual(tiny.length);
  });
});

describe("compressGeneric", () => {
  it("keeps lines with error/FAIL/panic and nearby context", () => {
    const output = [
      "Compiling stuff...",
      "Linking things...",
      "error: undefined symbol 'foo'",
      "  in src/main.ts line 42",
      "BUILD FAILED",
      "Done.",
    ].join("\n");

    const result = compressGeneric(output);
    expect(result).toContain("error: undefined symbol 'foo'");
    expect(result).toContain("BUILD FAILED");
    expect(result).not.toContain("Compiling stuff");
    expect(result).not.toContain("Done.");
  });

  it("returns original if no signal lines found (never worse)", () => {
    const output = "everything is fine\nno problems here";
    const result = compressGeneric(output);
    expect(result).toBe(output);
  });
});

describe("compactPath", () => {
  it("strips to src/ prefix", () => {
    expect(compactPath("/Users/macair/projects/myapp/src/foo/bar.ts")).toBe("src/foo/bar.ts");
  });

  it("strips to lib/ prefix", () => {
    expect(compactPath("/home/user/myapp/lib/baz.rs")).toBe("lib/baz.rs");
  });

  it("falls back to filename when no src/ or lib/", () => {
    expect(compactPath("/Users/macair/projects/myapp/test.ts")).toBe("test.ts");
  });

  it("passes through relative paths unchanged", () => {
    expect(compactPath("src/foo.ts")).toBe("src/foo.ts");
  });

  it("passes through bare filenames unchanged", () => {
    expect(compactPath("foo.ts")).toBe("foo.ts");
  });
});

describe("compressVerifyOutput", () => {
  it("dispatches to vitest compressor for vitest commands", () => {
    const output = " ✗ src/test.ts > something > fails\n\n      Tests  1 failed (1) | 0 passed (1)\n";
    const result = compressVerifyOutput(output, ["npx vitest run"]);
    expect(result).toContain("Tests: 1 failed");
    expect(result).toContain("FAIL");
  });

  it("dispatches to tsc compressor for tsc commands", () => {
    const errors: string[] = [];
    for (let i = 1; i <= 10; i++) {
      errors.push(`src/server/api/auth.ts(${i},5): error TS2322: Type 'string' is not assignable to type 'number'.`);
      errors.push(`  The expected type comes from property 'data' on interface 'ApiResponse'.`);
      errors.push(`src/server/api/auth.ts(${i + 10},10): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.`);
      errors.push(`  The expected type comes from the return type of 'getUser'.`);
    }
    errors.push("");
    errors.push("Found 20 errors in 1 file.");
    const output = errors.join("\n");
    const result = compressVerifyOutput(output, ["tsc --noEmit"]);
    expect(result).toContain("TypeScript: 20 errors in 1 file");
    expect(result).toContain("TS2322");
    expect(result.length).toBeLessThan(output.length);
  });

  it("dispatches to generic for unknown commands", () => {
    const output = "error: something broke\nBUILD FAILED\nall good otherwise";
    const result = compressVerifyOutput(output, ["make build"]);
    expect(result).toContain("error: something broke");
    expect(result).toContain("BUILD FAILED");
  });

  it("dispatches to cargo compressor for cargo commands", () => {
    const output = [
      "warning: unused import",
      "error[E0594]: cannot assign",
      "test foo::test_fails ... FAILED",
      "test result: FAILED. 0 passed; 1 failed",
    ].join("\n");
    const result = compressVerifyOutput(output, ["cargo test"]);
    expect(result).toContain("error[E0594]");
    expect(result).toContain("test result: FAILED");
    expect(result).not.toContain("warning: unused import");
  });

  it("never returns output larger than input (never-worse guard)", () => {
    const tiny = "ok";
    const result = compressVerifyOutput(tiny, ["tsc --noEmit"]);
    expect(result.length).toBeLessThanOrEqual(tiny.length);
  });

  it("handles empty input", () => {
    expect(compressVerifyOutput("", ["npm test"])).toBe("");
  });

  it("handles multiple commands (uses first matching)", () => {
    const output = " ✗ src/test.ts > fails\n\n      Tests  1 failed (1) | 0 passed (1)\n";
    const result = compressVerifyOutput(output, ["tsc --noEmit", "npm test"]);
    expect(result).toContain("Tests: 1 failed");
  });
});

describe("compressPytest", () => {
  const PYTEST_FAIL = [
    "============================= test session starts ==============================",
    "collected 3 items",
    "",
    "test_app.py::test_passes PASSED                                           [ 33%]",
    "test_app.py::test_fails FAILED                                             [ 66%]",
    "test_app.py::test_also_passes PASSED                                      [100%]",
    "",
    "=================================== FAILURES ===================================",
    "_______________________________ test_fails _______________________________",
    "",
    "    def test_fails():",
    "        assert 1 + 1 == 3",
    "E       assert 2 == 3",
    "",
    "test_app.py:10: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED test_app.py::test_fails - assert 2 == 3",
    "============================== 1 failed, 2 passed ==============================",
  ].join("\n");

  it("keeps failed test names and tracebacks", () => {
    const result = compressPytest(PYTEST_FAIL);
    expect(result).toContain("test_fails");
    expect(result).toContain("AssertionError");
    expect(result).toContain("assert 2 == 3");
  });

  it("drops passing tests and progress noise", () => {
    const result = compressPytest(PYTEST_FAIL);
    expect(result).not.toContain("test_passes");
    expect(result).not.toContain("test_also_passes");
    expect(result).not.toContain("collected 3 items");
  });

  it("keeps the summary line", () => {
    const result = compressPytest(PYTEST_FAIL);
    expect(result).toContain("1 failed");
  });

  it("handles all-pass output", () => {
    const output = [
      "test_app.py::test_a PASSED",
      "test_app.py::test_b PASSED",
      "============================== 2 passed ==============================",
    ].join("\n");
    const result = compressPytest(output);
    expect(result.length).toBeLessThanOrEqual(output.length);
  });

  it("never returns output larger than input", () => {
    const tiny = "pytest\nok";
    const result = compressPytest(tiny);
    expect(result.length).toBeLessThanOrEqual(tiny.length);
  });
});

describe("compressGo", () => {
  const GO_FAIL = [
    "=== RUN   TestPasses",
    "--- PASS: TestPasses (0.00s)",
    "=== RUN   TestFails",
    "    example_test.go:10: assertion failed: 1 != 2",
    "--- FAIL: TestFails (0.00s)",
    "=== RUN   TestAlsoPasses",
    "--- PASS: TestAlsoPasses (0.00s)",
    "PASS",
    "ok  \tgithub.com/myorg/myproject\t0.002s",
    "",
    "FAIL",
  ].join("\n");

  it("keeps failed test names and panic context", () => {
    const result = compressGo(GO_FAIL);
    expect(result).toContain("--- FAIL: TestFails");
    expect(result).toContain("assertion failed");
    expect(result).toContain("FAIL");
  });

  it("drops passing tests and progress noise", () => {
    const result = compressGo(GO_FAIL);
    expect(result).not.toContain("TestPasses");
    expect(result).not.toContain("TestAlsoPasses");
    expect(result).not.toContain("=== RUN");
  });

  it("dedups identical panic messages", () => {
    const output = [
      "=== RUN   TestA",
      "panic: runtime error: index out of range [5] with length 3",
      "",
      "goroutine 1 [running]:",
      "main.something(...)",
      "--- FAIL: TestA (0.00s)",
      "=== RUN   TestB",
      "panic: runtime error: index out of range [5] with length 3",
      "",
      "goroutine 2 [running]:",
      "main.something(...)",
      "--- FAIL: TestB (0.00s)",
      "FAIL",
    ].join("\n");
    const result = compressGo(output);
    const panicCount = (result.match(/panic: runtime error: index out of range/g) || []).length;
    expect(panicCount).toBe(1);
  });

  it("handles all-pass output", () => {
    const output = [
      "=== RUN   TestA",
      "--- PASS: TestA (0.00s)",
      "PASS",
      "ok  \tgithub.com/myorg/myproject\t0.001s",
    ].join("\n");
    const result = compressGo(output);
    expect(result.length).toBeLessThanOrEqual(output.length);
  });

  it("never returns output larger than input", () => {
    const tiny = "go test\nok";
    const result = compressGo(tiny);
    expect(result.length).toBeLessThanOrEqual(tiny.length);
  });

  it("keeps build errors", () => {
    const output = [
      "# github.com/myorg/myproject/pkg",
      "./pkg/handler.go:10:2: undefined: foo",
      "FAIL    github.com/myorg/myproject/pkg [build failed]",
    ].join("\n");
    const result = compressGo(output);
    expect(result).toContain("undefined: foo");
    expect(result).toContain("build failed");
  });
});

describe("compressGradle", () => {
  const GRADLE_FAIL = [
    "> Task :compileJava",
    "> Task :processResources",
    "> Task :compileTestJava",
    "> Task :test",
    "MyTest > testSomething() FAILED",
    "    org.opentest4j.AssertionFailedError: expected: <2> but was: <3>",
    "        at org.junit.Assert.assertEquals(Assert.java:115)",
    "1 test completed, 1 failed",
    "> Task :test FAILED",
    "",
    "FAILURE: Build failed with an exception.",
    "",
    "* What went wrong:",
    "Execution failed for task ':test'.",
    "",
    "BUILD FAILED in 3s",
    "10 actionable tasks: 8 executed, 2 up-to-date",
  ].join("\n");

  it("keeps FAILED tasks and error details", () => {
    const result = compressGradle(GRADLE_FAIL);
    expect(result).toContain("FAILED");
    expect(result).toContain("AssertionFailedError");
    expect(result).toContain("BUILD FAILED");
  });

  it("drops successful task lines and noise", () => {
    const result = compressGradle(GRADLE_FAIL);
    expect(result).not.toContain("> Task :compileJava");
    expect(result).not.toContain("> Task :processResources");
    expect(result).not.toContain("10 actionable tasks");
  });

  it("handles BUILD SUCCESSFUL", () => {
    const output = [
      "> Task :compileJava",
      "> Task :test",
      "BUILD SUCCESSFUL in 2s",
    ].join("\n");
    const result = compressGradle(output);
    expect(result.length).toBeLessThanOrEqual(output.length);
    expect(result).not.toContain("BUILD SUCCESSFUL");
  });

  it("never returns output larger than input", () => {
    const tiny = "gradle\nok";
    const result = compressGradle(tiny);
    expect(result.length).toBeLessThanOrEqual(tiny.length);
  });
});

describe("compressMaven", () => {
  const MVN_FAIL = [
    "[INFO] Scanning for projects...",
    "[INFO] Downloading from central: https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.jar",
    "[INFO] Downloaded from central: https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.jar (390 kB at 1.2 MB/s)",
    "[INFO] Compiling 5 source files",
    "[INFO] -------------------------------------------------------------",
    "[INFO]  T E S T S",
    "[INFO] -------------------------------------------------------------",
    "Running com.example.MyTest",
    "Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 sec <<< FAILURE!",
    "  com.example.MyTest.testSomething()  Time elapsed: 0.05 sec  <<< FAILURE!",
    "  org.opentest4j.AssertionFailedError: expected: <2> but was: <3>",
    "        at org.junit.Assert.assertEquals(Assert.java:115)",
    "",
    "[INFO] Results:",
    "[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0",
    "[INFO] BUILD FAILURE",
    "[INFO] Total time:  3.000 s",
    "[INFO] Finished at: 2026-08-28T17:00:00Z",
  ].join("\n");

  it("keeps ERROR lines, test failures, and BUILD FAILURE", () => {
    const result = compressMaven(MVN_FAIL);
    expect(result).toContain("BUILD FAILURE");
    expect(result).toContain("Tests run: 2, Failures: 1");
    expect(result).toContain("<<< FAILURE!");
    expect(result).toContain("AssertionFailedError");
  });

  it("drops [INFO] noise and download progress", () => {
    const result = compressMaven(MVN_FAIL);
    expect(result).not.toContain("Scanning for projects");
    expect(result).not.toContain("Downloading from central");
    expect(result).not.toContain("Downloaded from central");
  });

  it("handles BUILD SUCCESS", () => {
    const output = [
      "[INFO] Compiling 5 source files",
      "[INFO] BUILD SUCCESS",
      "[INFO] Total time: 2.000 s",
    ].join("\n");
    const result = compressMaven(output);
    expect(result.length).toBeLessThanOrEqual(output.length);
    expect(result).not.toContain("BUILD SUCCESS");
  });

  it("never returns output larger than input", () => {
    const tiny = "mvn\nok";
    const result = compressMaven(tiny);
    expect(result.length).toBeLessThanOrEqual(tiny.length);
  });
});

describe("compressDotnet", () => {
  const DOTNET_FAIL = [
    "Determining projects to restore...",
    "Restored /Users/myorg/MyProject/MyProject.csproj (in 1.2 sec).",
    "  MyProject -> /Users/myorg/MyProject/bin/Debug/net8.0/MyProject.dll",
    "Test run for /Users/myorg/MyProject/bin/Debug/net8.0/MyProject.dll",
    "  Passed!  TestSomething [100ms]",
    "  Failed!  TestThatFails [50ms]",
    "    Assert.AreEqual(2, 3)",
    "    Expected: 2",
    "    Actual:   3",
    "  Passed!  TestOtherThing [20ms]",
    "",
    "Test summary: total=3, failed=1, succeeded=2",
    "error: test failed, see logs above",
  ].join("\n");

  it("keeps failed tests and error details", () => {
    const result = compressDotnet(DOTNET_FAIL);
    expect(result).toContain("Failed!");
    expect(result).toContain("Assert.AreEqual");
    expect(result).toContain("Expected: 2");
    expect(result).toContain("error: test failed");
  });

  it("drops passed tests and restore noise", () => {
    const result = compressDotnet(DOTNET_FAIL);
    expect(result).not.toContain("TestSomething");
    expect(result).not.toContain("TestOtherThing");
    expect(result).not.toContain("Determining projects");
    expect(result).not.toContain("Restored");
  });

  it("handles all-pass output", () => {
    const output = [
      "  Passed!  TestA [100ms]",
      "  Passed!  TestB [50ms]",
      "Test summary: total=2, failed=0, succeeded=2",
    ].join("\n");
    const result = compressDotnet(output);
    expect(result.length).toBeLessThanOrEqual(output.length);
  });

  it("never returns output larger than input", () => {
    const tiny = "dotnet test\nok";
    const result = compressDotnet(tiny);
    expect(result.length).toBeLessThanOrEqual(tiny.length);
  });
});

describe("compressVerifyOutput dispatcher — new tools", () => {
  it("dispatches pytest compressor for pytest commands", () => {
    const output = "test_fails FAILED\nAssertionError: 2 == 3\n1 failed, 0 passed";
    const result = compressVerifyOutput(output, ["pytest"]);
    expect(result).toContain("test_fails");
    expect(result).toContain("AssertionError");
  });

  it("dispatches go compressor for go test commands", () => {
    const output = "--- FAIL: TestA\n    assert failed\nFAIL";
    const result = compressVerifyOutput(output, ["go test ./..."]);
    expect(result).toContain("FAIL: TestA");
  });

  it("dispatches gradle compressor for gradle commands", () => {
    const output = "> Task :test FAILED\nBUILD FAILED";
    const result = compressVerifyOutput(output, ["./gradlew test"]);
    expect(result).toContain("FAILED");
    expect(result).not.toContain("> Task :compileJava");
  });

  it("dispatches maven compressor for mvn commands", () => {
    const output = "[ERROR] Something broke\nBUILD FAILURE";
    const result = compressVerifyOutput(output, ["mvn test"]);
    expect(result).toContain("[ERROR]");
    expect(result).toContain("BUILD FAILURE");
  });

  it("dispatches dotnet compressor for dotnet commands", () => {
    const output = "  Failed!  TestA\n    Assert.AreEqual(1, 2)\nerror: test failed";
    const result = compressVerifyOutput(output, ["dotnet test"]);
    expect(result).toContain("Failed!");
    expect(result).toContain("Assert.AreEqual");
  });
});
