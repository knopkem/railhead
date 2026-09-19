# Output Compression Patterns for LLM Token Cost

Research into deterministic approaches for compressing build/test/lint command output.
All patterns below are extracted from actual source code of [rtk-ai/rtk](https://github.com/rtk-ai/rtk)
and [yvgude/lean-ctx](https://github.com/yvgude/lean-ctx), plus the native output formats of each tool.

---

## 1. Test Runner Output Compression

### Vitest

**Output format (default reporter):**
```
 ✓ src/foo.test.ts > bar > works as expected
 ✗ src/baz.test.ts > qux > fails badly
  AssertionError: expected 5 to be 3
    at /path/src/baz.test.ts:42:7

 Test Files  1 failed (1) | 1 passed (2)
      Tests  1 failed (3) | 2 passed (3)
   Duration  450ms
```

**rtk's approach (the best pattern):** Force `--reporter=json` behind the scenes, parse
the structured JSON, and emit only failures + summary counts. This is a **three-tier**
strategy:

1. **Tier 1 (full JSON parse):** Inject `--reporter=json` into the vitest args (unless the
   user explicitly passed `--reporter`). Parse `numTotalTests`, `numPassedTests`,
   `numFailedTests`, `numPendingTests` from the JSON root. Walk `testResults[].assertionResults[]`
   and keep only entries where `status == "failed"`, extracting `fullName` and `failureMessages`.

2. **Tier 2 (regex fallback):** If JSON parse fails (user overrode the reporter, output is
   prefixed by pnpm/dotenv noise), fall back to regex:
   ```regex
   Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed
   ```
   For failures, scan for lines containing `[x]` or `FAIL`, then collect subsequent
   indented lines as error context:
   ```
   if line.contains("[x]") || line.contains("FAIL") {
       // collect subsequent lines starting with "  " as error detail
   }
   ```

3. **Tier 3 (passthrough):** If both fail, truncate the raw output to a max char limit
   and emit with a `[RTK:PASSTHROUGH]` warning + a tee file path for recovery.

**Critical detail:** vitest JSON can be preceded by pnpm scope warnings or dotenv output.
rtk handles this with an `extract_json_object()` helper that finds the first `{` and tries
to parse from there.

**Compressed output format:**
```
Tests: 3 total, 2 passed, 1 failed
FAIL: src/baz.test.ts > qux > fails badly
  AssertionError: expected 5 to be 3
```

### Jest

**Output format (default):**
```
 FAIL  src/foo.test.js
  ● test name › subtest

    expect(received).toBe(expected)
    Expected: 5
    Received: 3

      at Object.<anonymous> (src/foo.test.js:42:3)

Tests: 1 failed, 2 passed, 3 total
```

**rtk's approach:** Force `--json` and `--no-watch` flags. Jest's JSON output structure
is nearly identical to vitest's (vitest borrowed it). The same `VitestParser` handles both
— the JSON schema is:
```json
{
  "numTotalTests": 3,
  "numPassedTests": 2,
  "numFailedTests": 1,
  "numPendingTests": 0,
  "testResults": [{
    "name": "src/foo.test.js",
    "assertionResults": [{
      "fullName": "test name > subtest",
      "status": "failed",
      "failureMessages": ["expect(received).toBe(expected)...\n      at Object.<anonymous>..."]
    }]
  }]
}
```

**Regex fallback for jest text output (from lean-ctx's pattern — covers both):**
Jest and vitest share the `Tests: N failed, N passed, N total` summary line, so the
same regex works:
```regex
Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed
```
For failure detection from text output:
```regex
FAIL\s+(\S+)
```
Then collect `●` lines and indented `expect(...)` / `at Object` lines as context.

### pytest

**Output format (with `--tb=short -q`):**
```
============================= test session starts ==============================
platform darwin -- Python 3.11.0
collected 5 items

tests/test_foo.py ..F..                                            [100%]

=================================== FAILURES ===================================
_________________________________ test_something _________________________________

    def test_something():
>       assert False
E       assert False

tests/test_foo.py:10: AssertionError

=========================== short test summary info ============================
FAILED tests/test_foo.py::test_something - assert False
============================== 4 passed, 1 failed in 0.50s ===============================
```

**rtk's approach (state machine parser):** rtk injects `--tb=short`, `-q`, and `-rxX`
(surfaces xfail/xpass) flags. It uses a **state machine** with four states:

```
Header → TestProgress → Failures → Summary
```

State transitions:
- `===...test session starts...===` → `Header`
- `collected N items` → `TestProgress`
- `===...FAILURES...===` → `Failures`
- `===...short test summary...===` → `Summary`

**What gets kept per state:**
- **Header:** Nothing (skip everything until `collected`)
- **TestProgress:** Nothing (the `..F..` dots are noise)
- **Failures:** Lines starting with `___` (test name), lines starting with `>` or `E`
  (assertion context), lines containing `.py:` (file location). Max 3 relevant lines per failure.
- **Summary:** Lines starting with `FAILED` or `ERROR`. Lines starting with `XFAIL` or `XPASS`
  (expected failure info — XPASS is especially important as it signals a behavior change).

**Summary line parsing (regex-free, split-based):**
```
"=== 4 passed, 1 failed, 2 xfailed, 1 xpassed in 0.50s ==="
```
Split by `,`, then for each part split by whitespace: the number precedes the keyword.
**Order matters:** check `xpassed`/`xfailed` before `passed`/`failed` (substring match).

**Quiet mode (`-q`) quirk:** The summary line has no `===` wrapper — it's just
`5 failed, 1698 passed, 2 skipped in 108.89s`. The parser must detect this by checking
for ` passed` / ` failed` / ` skipped` + ` in ` without the `===` prefix.

**Compressed output format:**
```
Pytest: 4 passed, 1 failed
Failures:
1. [FAIL] test_something
     assert False
     tests/test_foo.py:10: AssertionError
```

**lean-ctx's approach (verbose mode):** Also a state machine, but handles `pytest -v` output
where each test result is on its own line:
```
tests/test_auth.py::test_login PASSED                                    [ 25%]
tests/test_auth.py::test_expired_token FAILED                            [ 75%]
```
Regex to extract status from verbose lines:
```regex
# Strip trailing [ NN%] then check for status keyword
PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR
```
Test name extraction: strip the status keyword, take the part after the last `::`.

### cargo test

**Output format:**
```
    Compiling my_crate v0.1.0
    Finished dev [unoptimized + debuginfo] target(s) in 0.5s
     Running unittests src/lib.rs

running 15 tests
test utils::test_parse ... ok
test utils::test_format ... ok
test utils::test_edge_case ... FAILED

failures:

---- utils::test_edge_case stdout ----
thread 'utils::test_edge_case' panicked at 'assertion failed: `(left == right)`
  left: 5,
 right: 3', src/utils.rs:18:5

test result: FAILED. 14 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

**rtk's approach (streaming block handler):**

Skip lines matching:
```regex
^(Compiling|Downloading|Downloaded|Finished|running )
```
Skip individual passing tests: `^test .+\.\.\. ok$`

The `"failures:"` line is a **section toggle**:
- First `failures:` → enter failure section
- Second `failures:` (if present) → enter failure name listing (skip those lines)

**Block detection for failure details:**
- Block start: `^---- .+ stdout ----` (the failure header)
- Block continuation: any line while in failure section that doesn't start a new `---- `

**Summary line parsing:**
```regex
test result: (\w+)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out(?:;\s+finished in ([\d.]+)s)?
```
Only aggregate `ok` status lines (all-passed) into a compact summary. If any line has
status != `ok`, skip aggregation and show raw summary lines.

**Compressed output (all pass):**
```
cargo test: 15 passed (1 suite, 0.01s)
```

**Compressed output (with failures):**
```
FAILURES (1):
1. ---- utils::test_edge_case stdout ----
   thread 'utils::test_edge_case' panicked at 'assertion failed...
   src/utils.rs:18:5
test result: FAILED. 14 passed; 1 failed; 0 ignored
```

**lean-ctx's approach:** Uses regex instead of a state machine:
```regex
^test (.+) \.\.\. FAILED$          # failed test name
^---- (.+) stdout ----$             # failure header
test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored   # summary
```
Groups: keeps first 5 failed test names, shows passed test names when <= 5 total.

**JSON message format (cargo build/test with `--message-format=json`):**
rtk also supports parsing the JSON lines that cargo emits. Each line has:
```json
{"reason": "compiler-message", "message": {"level": "error", "message": "...", "rendered": "..."}}
```
Filter: keep only `reason == "compiler-message"`, skip `aborting due to` / `could not compile` /
`generated N warnings` summary lines.

### go test

**Output format (with `-json` flag):** NDJSON stream — one JSON object per line:
```json
{"Time":"2024-01-01T10:00:00Z","Action":"run","Package":"example.com/foo","Test":"TestBar"}
{"Time":"2024-01-01T10:00:01Z","Action":"output","Package":"example.com/foo","Test":"TestBar","Output":"=== RUN   TestBar\n"}
{"Time":"2024-01-01T10:00:02Z","Action":"pass","Package":"example.com/foo","Test":"TestBar","Elapsed":0.5}
{"Time":"2024-01-01T10:00:02Z","Action":"pass","Package":"example.com/foo","Elapsed":0.5}
```

**rtk's approach (NDJSON streaming):** Inject `-json` flag (unless user passes `-bench`).
Parse each line as JSON, track per-package `PackageResult`:

Actions handled:
- `pass` + `test` present → `pass += 1`
- `fail` + `test` present → `fail += 1`, collect output lines for this test
- `fail` + `failed_build` present → build failure, collect `build-output` events
- `fail` + no test + no failed_build → package-level failure (timeout, signal kill)
- `skip` + `test` present → `skip += 1`
- `output` → collect as test output (buffered by `(package, test)` key)
- `build-output` + `import_path` → buffer build error lines

**Critical detail — no double-counting:** `go test -json` **always** emits a package-level
`{"action":"fail"}` after each test-level failure. This is a cascade, not an additional
failure. The summary must show "1 failed", not "2 failed". The filter: only count
`package_failed` when `fail == 0 && !build_failed`.

**Failure line selection from test output:** From the collected output lines for a failed
test, keep lines that match:
```regex
# file location lines (e.g. "foo_test.go:42:")
.+\.go:\d+

# failure indicator keywords (case-insensitive)
panic:|error:|expected|got|want|actual|assert|mismatch|unexpected|fatal
```
Keep the line after a file location line (context). Max 5 relevant lines per failure.

**Compressed output (all pass):**
```
Go test: 15 passed in 3 packages
```

**Compressed output (with failures):**
```
Go test: 14 passed, 1 failed in 3 packages

foo (14 passed, 1 failed)
  [FAIL] TestEdgeCase
     foo_test.go:42:
     expected 5, got 3
```

**lean-ctx's approach (simpler, text-based):** Does NOT use `-json`. Parses the
human-readable output:
```regex
^(ok|FAIL)\s+(\S+)\s+(\S+)    # package result line: "ok\tpkg\t0.5s" or "FAIL\tpkg\t0.5s"
```
Extracts `--- FAIL: TestName` lines for failure names. Shows failed test names
(up to 5) and passed test names (up to 5).

---

## 2. Compiler/Linter Output Compression

### tsc (TypeScript compiler)

**Output format:**
```
src/server/api/auth.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/server/api/auth.ts(15,10): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
src/components/Button.tsx(8,3): error TS2339: Property 'onClick' does not exist on type 'ButtonProps'.

Found 4 errors in 2 files.
```

Each error can have **continuation lines** (indented with 2 spaces or a tab):
```
src/app.tsx(10,3): error TS2322: Type '{ children: Element; }' is not assignable to type 'Props'.
  Property 'children' does not exist on type 'Props'.
```

**Error line regex (rtk):**
```regex
^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$
```
Capture groups: `file`, `line`, `col`, `severity`, `code`, `message`.

**rtk's approach (streaming block handler):**
- Skip lines starting with `Found ` (the "Found N errors" summary)
- Block start: matches the error regex
- Block continuation: line starts with `  ` (2 spaces) or `\t`, and is NOT itself an error line

**Grouping strategy:** Group errors by file, sort files by error count (most errors first).
Within each file, show every error (no limits):
```
TypeScript: 4 errors in 2 files
Top codes: TS2322 (2x), TS2339 (1x), TS2345 (1x)

src/server/api/auth.ts (2 errors)
  L12: TS2322 Type 'string' is not assignable to type 'number'.
  L15: TS2345 Argument of type 'number' is not assignable to parameter of type 'string'.

src/components/Button.tsx (1 error)
  L8: TS2339 Property 'onClick' does not exist on type 'ButtonProps'.
```

**lean-ctx's approach (simpler regex):**
```regex
(\S+)\((\d+),\d+\): error (TS\d+): (.+)
```
Keeps a flat list (no file grouping), truncates messages to 40 chars + `...`.

**No errors detection:** Check for `Found 0 errors` in output → emit "No errors found".

### eslint

**Output format (default stylish):**
```
/Users/test/project/src/utils.ts
  10:5  error    Use const instead of let  prefer-const
  15:5  warning  Use const instead of let  prefer-const

/Users/test/project/src/api.ts
  20:10  error  Variable x is unused  @typescript-eslint/no-unused-vars

✖ 2 errors, 2 warnings (0 errors, 2 warnings fixed)
```

**rtk's approach:** Force `-f json` flag. ESLint JSON output:
```json
[{
  "filePath": "/Users/test/project/src/utils.ts",
  "messages": [{
    "ruleId": "prefer-const",
    "severity": 2,
    "message": "Use const instead of let",
    "line": 10,
    "column": 5
  }],
  "errorCount": 1,
  "warningCount": 1
}]
```

**Grouping strategy:**
1. Summary line: `{total_errors} errors, {total_warnings} warnings in {total_files} files`
2. Top rules (sorted by count, max 10): `  {rule_id} ({count}x)`
3. Top files (sorted by issue count, max CAP_WARNINGS files): `  {short_path} ({count} issues)`
   - Under each file, top 3 rules in that file

**Path compaction:** Strip `/Users/.../` or `/home/.../` prefixes, keep from `src/` or
`lib/` onward, or just the filename if neither is found:
```rust
fn compact_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    if let Some(pos) = path.rfind("/src/") { format!("src/{}", &path[pos + 5..]) }
    else if let Some(pos) = path.rfind("/lib/") { format!("lib/{}", &path[pos + 5..]) }
    else if let Some(pos) = path.rfind('/') { path[pos + 1..].to_string() }
    else { path }
}
```

**lean-ctx's approach (text-based, no JSON injection):**
```regex
^(/\S+|[A-Z]:\\\S+|\S+\.\w+)$           # file path line
^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)$  # violation line
(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)  # summary
```
Note the `\s{2,}` (2+ spaces) between message and rule — this is the eslint stylish
format separator.

### cargo clippy

**Output format:**
```
warning: unused variable: `x`
  --> src/main.rs:10:5
   |
10 |     let x = 5;
   |         ^

warning[clippy::needless_borrow]: needless borrow
  --> src/utils.rs:20:9
   |
20 |     foo(&x);
   |          ^^^

error[E0308]: mismatched types
  --> src/main.rs:15:5

error: could not compile `my_crate` due to 2 previous errors
```

**rtk's approach:**

Skip lines:
```regex
^(Compiling|Checking|Downloading|Downloaded|Finished)
```
Skip summary lines: contains `generated` + `warning`, or contains `aborting due to`,
or contains `could not compile`.

**Error/warning detection:**
- `^error:` or `^error[` → error (collect full block including `-->` location and code context)
- `^warning:` or `^warning[` → warning (extract rule from `[clippy::rule]` brackets, track `-->` location)

**Warning grouping:** Group by clippy rule name, sorted by frequency:
```
  needless_borrow (3x)
    src/utils.rs:20:9
    src/utils.rs:35:9
    src/main.rs:50:5
    … +0 more
```

**Error blocks (full output):** Error blocks are shown in full (not grouped), because
developers need the complete context to fix them. A block ends at a blank line. Max
15 lines per block to prevent runaway.

**lean-ctx's approach (regex-based):**
```regex
error\[E(\d+)\]: (.+)                           # error code + message
warning(?:\[clippy::([^\]]+)\])?: (.+)           # warning with optional clippy rule
generated (\d+) warnings?                         # generated count
clippy::([A-Za-z0-9_-]+)                          # clippy rule extraction
```
Groups warnings by rule, shows top 5 with counts. Normalizes rule names (strips backticks,
replaces `-` with `_`).

---

## 3. Build Output Compression

### npm run build / vite build

**Noise lines (drop):**
- Vite progress: `transforming (45) ...`, `rendering chunks (12)...`
- Module resolution: `modules transformed (123)`
- Webpack progress: `<s> [webpack.Progress] 10% building`
- npm lifecycle noise: `> my-app@1.0.0 build`, `> vite build`
- Deps compilation: anything from the bundler's internal progress

**Signal lines (keep):**
- Errors: lines containing `error` (case-insensitive), `Error:`,
  `Build failed`, `SyntaxError`, `Cannot resolve`
- Warnings: lines containing `warning` (case-insensitive), `WARN`
- Summary: `built in Xs`, `✓ built in Xs`

**rtk generic pattern (from `filter_generic_lint`):**
```
for line in output.lines():
    if line.to_lowercase().contains("warning"):
        warnings += 1
        issues.push(line)
    if line.to_lowercase().contains("error") and !line.contains("0 error"):
        errors += 1
        issues.push(line)
```

### cargo build

**Noise lines (drop):**
```
Compiling crate_name v0.1.0
Downloading crate_name v0.1.0
Downloaded crate_name v0.1.0
Finished dev profile in 0.5s
Locking 2 packages
Updating crates.io index
Blocking waiting for file lock
```

**Signal lines (keep):**
```
error[E0308]: mismatched types
warning: unused variable: `x`
```

**rtk's approach:** The `should_skip()` function drops all `Compiling`, `Checking`,
`Downloading`, `Downloaded`, `Finished` lines. The `is_block_start()` function detects
`error[` or `error:` (and `warning:` / `warning[`). Block continuation: any line until a
blank line (with a max of ~3 blank lines to terminate).

**JSON diagnostics (when `--message-format=json` is passed):** Parse each line as JSON:
```rust
struct CargoJsonLine {
    reason: String,           // "compiler-message"
    message: Option<CargoDiagnostic>,
}
struct CargoDiagnostic {
    level: String,             // "error" | "warning"
    message: String,
    rendered: Option<String>,  // the rendered diagnostic text
}
```

**Compressed output (success):**
```
cargo build (42 crates compiled)
Finished `dev` profile [unoptimized + debuginfo] target(s) in 30.5s
```

**Compressed output (with errors):**
```
cargo build: 2 errors, 1 warning (42 crates compiled)
error[E0308]: mismatched types
  --> src/main.rs:15:5
warning: unused variable: `x`
```

### go build

**Noise lines (drop):**
```
go: downloading github.com/pkg/errors v0.9.1
go: finding module for package example.com/foo
go: extracting github.com/pkg/errors v0.9.1
# example.com/foo      (package header — context, not an error)
```

**Signal lines (keep — error detection heuristics from rtk):**
1. Lines containing `.go:` (canonical compiler error location: `file.go:line:col: ...`)
2. Lines containing `go.mod:` or `go.work:` or `go.sum:` (config file errors)
3. Non-file error prefixes: `undefined:`, `cannot use`, `cannot find package`,
   `no required module provides package`, `missing go.sum entry`, `found packages`,
   `go: go.mod file not found`, `go: cannot load module`, `go: build failed`,
   `error:`, `pattern`, `import cycle not allowed`,
   `build constraints exclude all go files`,
   `function main is undeclared in the main package`

**Explicitly NOT errors:**
- `go: downloading ...` (package download progress; often contains "error" in
  package names like `go-errors` or `multierror`)
- `# package_name` (package header context line)
- `go: finding module for package ...`
- `go: extracting ...`

---

## 4. Git Diff Compression

### `git diff --stat` + per-hunk trimming

**lean-ctx's approach (the cleanest pattern):**

For diffs <= 500 lines, apply **context line trimming** — keep all `+`/`-` lines,
cap unchanged context lines to 3 per hunk:
```rust
for line in output.lines() {
    if line.starts_with("diff --git") || line.starts_with("@@") {
        context_run = 0;
        result.push(line);             // always keep headers
    } else if line.starts_with("index ") {
        // skip index lines (git blob hashes — pure noise)
    } else if line.starts_with("--- ") || line.starts_with("+++ ") {
        result.push(line);             // keep file paths
    } else if line.starts_with('+') || line.starts_with('-') {
        context_run = 0;
        result.push(line);             // keep ALL diff content
    } else {
        context_run += 1;
        if context_run <= 3 {
            result.push(line);         // keep up to 3 context lines
        }
    }
}
```

For diffs > 500 lines, apply **per-file truncation**:
- Split into file ranges (delimited by `diff --git`)
- For each file: if <= 250 lines, keep in full. If > 250 lines, keep first 200 +
  last 50, with a `[WARNING: diff truncated (N lines hidden)]` marker.

**For stat-only output** (e.g. `git diff --stat`), pass through unchanged — it's
already compact.

**rtk's approach (condensed unified diff):** Strip all metadata headers
(`diff --git`, `---`, `+++`, `@@` hunk headers). Keep only `+`/`-` lines. Group by file:
```
[file] src/main.rs (+5 -2)
  +added line
  -removed line
  ... +10 more
```
Cap at 10 change lines per file with `... +N more` overflow.

---

## 5. How rtk and lean-ctx Implement Compression

### rtk (rtk-ai/rtk)

**Architecture:** Rust binary, 42 command modules organized by ecosystem
(`src/cmds/rust/`, `src/cmds/js/`, `src/cmds/python/`, `src/cmds/go/`).
Each module follows a shared lifecycle: PARSE → ROUTE → EXECUTE → FILTER → PRINT → TRACK.

**12 filtering strategies (from ARCHITECTURE.md):**

| Strategy | Technique | Reduction | Used by |
|---|---|---|---|
| Stats Extraction | Count/aggregate, drop details | 90-99% | git status, git log, git diff |
| Error Only | stderr only, drop stdout | 60-80% | err mode, test failures |
| Grouping by Pattern | Group by rule/file, count | 80-90% | lint, tsc, grep |
| Deduplication | Unique + count | 70-85% | log_cmd |
| Structure Only | Keys + types, strip values | 80-95% | json_cmd |
| Code Filtering | Strip comments/bodies by level | 20-90% | read, smart |
| Failure Focus | Failures only, hide passing | 94-99% | vitest, pytest, cargo test |
| Tree Compression | Tree hierarchy, aggregate dirs | 50-70% | ls |
| Progress Filtering | Strip ANSI bars, final result | 85-95% | wget, pnpm install |
| JSON/Text Dual Mode | JSON when available, text fallback | 80%+ | ruff, pytest, golangci-lint |
| State Machine Parsing | Track test state transitions | 90%+ | pytest |
| NDJSON Streaming | Line-by-line JSON parse | 90%+ | go test |

**Format strategy decision tree:**
```
Tool provides JSON flag? → Use JSON API (ruff, golangci-lint, eslint, vitest, jest)
  ├─ Streaming events (NDJSON)? → Line-by-line JSON parse (go test)
  └─ Structured data needed?
      └─ Yes → Parse JSON, extract fields, group by rule/file
      └─ No → Use text mode (ruff format)

Plain text only?
  ├─ Stateful parsing needed? → State machine (pytest)
  └─ Simple filtering? → Text filters (go vet, go build)
```

**Key implementation patterns:**

1. **JSON injection:** When a tool supports JSON output, rtk injects the flag
   (`--reporter=json`, `-f json`, `--output-format=json`, `--message-format=json`)
   unless the user explicitly passed one. This swaps a lossy text parser for a
   deterministic JSON parse.

2. **Three-tier degradation:**
   - Tier 1: Full JSON parse (preferred)
   - Tier 2: Regex extraction (fallback)
   - Tier 3: Truncated passthrough (last resort)

3. **Streaming block handler:** For line-oriented output (tsc, cargo build),
   a `BlockHandler` trait with:
   - `should_skip(line)` → true for noise lines
   - `is_block_start(line)` → true for the first line of a multi-line error/warning
   - `is_block_continuation(line, block)` → true for subsequent lines
   - `format_summary()` → final compressed summary

4. **Cap + tee overflow:** When output exceeds a cap (CAP_ERRORS, CAP_WARNINGS),
   show the cap count + `… +N more` + write the full output to a tee file and emit
   a `[full output: /path/to/file]` hint so the LLM can retrieve it if needed.

5. **Exit code preservation:** Always propagate the underlying tool's exit code
   for CI/CD reliability. rtk itself exits 1 only for internal errors.

6. **Never-worse guard:** If the compressed output is larger than the raw output
   (e.g. a tiny `cargo test` run), use the raw output instead. Prevents the
   compression from making things worse.

7. **Path compaction:** Strip absolute path prefixes to `src/` or `lib/` onward,
   or just the filename.

### lean-ctx (yvgude/lean-ctx)

**Architecture:** Also Rust. Shell output compression lives in `rust/src/core/patterns/`,
with one file per tool ecosystem (`cargo.rs`, `golang.rs`, `pytest.rs`, `eslint.rs`,
`typescript.rs`, etc.). A central dispatcher routes based on command string matching.

**Key differences from rtk:**

1. **No JSON injection:** lean-ctx operates on the **output as given** — it doesn't
   modify the command to add `--json` flags. This means its parsers must handle the
   human-readable text output format, which is more fragile.

2. **Regex-heavy, not state-machine:** lean-ctx prefers static compiled regexes
   (`static_regex!` macro with `OnceLock`) applied line-by-line. rtk uses state machines
   for complex formats (pytest) and streaming block handlers.

3. **Simpler grouping:** lean-ctx groups by rule and shows `rule ×count`, sorted by
   frequency. Less granular than rtk (no per-file breakdown with individual error lines).

4. **`compact_output()` fallback:** A shared utility that keeps the first N non-empty
   lines + `... (M more lines)` when no specific pattern matches. Used as a catch-all
   for unrecognized output.

5. **No tee/recovery:** lean-ctx's shell compression is lossy — if it truncates, there's
   no tee file to recover the full output. (It relies on its MCP `ctx_expand` tool for
   recovery of file reads, but not for shell output.)

6. **Command-string dispatch:** lean-ctx routes by matching substrings in the command
   string (`command.contains("pytest")`, `command.contains("cargo ")`). This is simpler
   but less precise than rtk's clap-based CLI dispatch.

---

## Summary: The Pattern That Works

The winning pattern, extracted from both tools, is:

1. **Prefer structured output.** If the tool supports JSON/NDJSON, inject that flag
   and parse structured data. This is the single highest-leverage optimization.

2. **If only text output is available, use a state machine or line-by-line regex.**
   State machines handle multi-line blocks (pytest FAILURES sections, cargo error
   blocks). Simple regex matches work for single-line formats (tsc, eslint stylish).

3. **Keep only the signal:**
   - Test runners: failures + summary counts (hide all passing tests)
   - Compilers: errors grouped by file, with error codes counted
   - Linters: violations grouped by rule, sorted by frequency
   - Build tools: errors + warnings, drop all progress/compilation noise
   - Git diffs: `+`/`-` lines in full, cap context lines to 3 per hunk

4. **Cap + overflow indicator:** When output exceeds a cap, show the first N items,
   then `… +M more`, and optionally tee the full output to a file with a recovery hint.

5. **Three-tier degradation:** JSON parse → regex extraction → truncated passthrough.

6. **Preserve exit codes** for CI/CD reliability.

7. **Never make it worse:** If compressed > raw, use raw.
