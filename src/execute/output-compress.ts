/**
 * Deterministic verify-output compression — replaces model-call summarizer
 * with regex/state-machine extraction for known tools. Issue #31.
 *
 * Zero model calls: parses the raw build/test output, keeps only failures
 * + summary counts, drops passing tests, progress noise, and successful
 * compilation lines. Runs BEFORE `summarizeIfNeeded` so the model
 * summarizer only sees the residual (if anything).
 *
 * Never-worse guard: if compression makes the output larger (tiny output
 * where metadata exceeds the original), the original is returned verbatim.
 */

export type ToolKind =
  | "vitest"
  | "jest"
  | "pytest"
  | "cargo"
  | "go"
  | "tsc"
  | "eslint"
  | "gradle"
  | "maven"
  | "dotnet"
  | "rake"
  | "cmake"
  | "make"
  | "generic";

/** Detect which tool produced the output from the verify command strings. */
export function detectTool(commands: string[]): ToolKind {
  const joined = commands.join(" ").toLowerCase();
  if (/\bvitest\b/.test(joined) || /\bnpm test\b/.test(joined) || /\bnpm run test\b/.test(joined)) return "vitest";
  if (/\bjest\b/.test(joined)) return "jest";
  if (/\bpytest\b/.test(joined) || /\bpython\s+-m\s+pytest\b/.test(joined)) return "pytest";
  if (/\bcargo\s+(test|nextest)\b/.test(joined)) return "cargo";
  if (/\bgo\s+test\b/.test(joined)) return "go";
  if (/\beslint\b/.test(joined) || /\bnpm\s+run\s+lint\b/.test(joined)) return "eslint";
  if (/\btsc\b/.test(joined) || /\btypecheck\b/.test(joined) || /\bnpm\s+run\s+(typecheck|type-check)\b/.test(joined)) return "tsc";
  if (/\bgradle\b/.test(joined) || /\bgradlew\b/.test(joined)) return "gradle";
  if (/\bmvn\b/.test(joined) || /\bmaven\b/.test(joined)) return "maven";
  if (/\bdotnet\s+(test|build)\b/.test(joined)) return "dotnet";
  if (/\brake\b/.test(joined)) return "rake";
  if (/\bcmake\b/.test(joined)) return "cmake";
  if (/\bmake\b/.test(joined) || /\bmake\b/.test(joined)) return "make";
  return "generic";
}

/** Strip absolute path prefixes to `src/` or `lib/` onward, or just the
 * filename if neither segment is found. Mirrors rtk's `compact_path`. */
export function compactPath(path: string): string {
  if (!path.startsWith("/")) return path;
  const srcIdx = path.lastIndexOf("/src/");
  if (srcIdx >= 0) return path.slice(srcIdx + 1);
  const libIdx = path.lastIndexOf("/lib/");
  if (libIdx >= 0) return path.slice(libIdx + 1);
  const slashIdx = path.lastIndexOf("/");
  return slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
}

const SUMMARY_RE = /Tests\s+(?:(\d+)\s+failed(?:\s*\(\d+\))?\s*\|\s*)?(\d+)\s+passed/;
const JEST_SUMMARY_RE = /Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/;

/** Compress vitest/jest text output: keep only failures + summary. */
export function compressVitest(blob: string): string {
  const lines = blob.split("\n");
  const failures: string[] = [];
  const summaryParts = { failed: 0, passed: 0, total: 0 };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (trimmed.startsWith("✗") || trimmed.startsWith("FAIL") || /^\s*●\s/.test(trimmed)) {
      const failLines: string[] = [trimmed];
      if (trimmed.startsWith("FAIL")) {
        failLines[0] = `FAIL: ${trimmed.replace(/^FAIL\s+/, "")}`;
      } else if (trimmed.startsWith("✗")) {
        const testPath = trimmed.replace(/^✗\s+/, "");
        failLines[0] = `FAIL: ${testPath}`;
      } else if (trimmed.startsWith("●")) {
        failLines[0] = `  ${trimmed.replace(/^\s*●\s*/, "")}`;
      }
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j].trimStart();
        if (/^(✗|✓|FAIL|PASS|Test Files|Tests|Tests:|RUN|Duration)/.test(next) || /^\s*●\s/.test(next)) break;
        if (/^\s+/.test(lines[j]) && next !== "") {
          failLines.push(`  ${next}`);
        } else if (next === "" && j + 1 < lines.length && /^\s+/.test(lines[j + 1])) {
          // blank line between jest blocks — keep collecting if next is indented context
          j++;
          continue;
        } else if (next === "") {
          break;
        }
        j++;
      }
      failures.push(failLines.join("\n"));
      i = j;
      continue;
    }

    const summaryMatch = trimmed.match(JEST_SUMMARY_RE) || trimmed.match(SUMMARY_RE);
    if (summaryMatch) {
      if (JEST_SUMMARY_RE.test(trimmed)) {
        summaryParts.failed = parseInt(summaryMatch[1], 10) || 0;
        summaryParts.passed = parseInt(summaryMatch[2], 10) || 0;
        summaryParts.total = parseInt(summaryMatch[3], 10) || 0;
      } else {
        const f = parseInt(summaryMatch[1], 10) || 0;
        const p = parseInt(summaryMatch[2], 10) || 0;
        summaryParts.failed = f;
        summaryParts.passed = p;
        summaryParts.total = summaryParts.failed + summaryParts.passed;
      }
    }

    i++;
  }

  const header = `Tests: ${summaryParts.failed} failed, ${summaryParts.passed} passed, ${summaryParts.total} total`;
  if (failures.length === 0) return header;
  return `${header}\n${failures.join("\n")}`;
}

interface TscError {
  file: string;
  line: number;
  col: number;
  severity: string;
  code: string;
  message: string;
  continuations: string[];
}

const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

/** Compress tsc output: group errors by file, drop continuation noise. */
export function compressTsc(blob: string): string {
  if (/Found 0 errors/.test(blob)) return "TypeScript: No errors.";

  const lines = blob.split("\n");
  const errors: TscError[] = [];
  let current: TscError | null = null;

  for (const line of lines) {
    const match = line.match(TSC_ERROR_RE);
    if (match) {
      if (current) errors.push(current);
      current = {
        file: compactPath(match[1]),
        line: parseInt(match[2], 10),
        col: parseInt(match[3], 10),
        severity: match[4],
        code: match[5],
        message: match[6],
        continuations: [],
      };
    } else if (current && /^\s{2,}/.test(line) && !line.match(TSC_ERROR_RE)) {
      current.continuations.push(line.trim());
    } else if (line.trim() === "" && current) {
      errors.push(current);
      current = null;
    } else if (/^Found\s+\d+\s+errors?/.test(line)) {
      if (current) { errors.push(current); current = null; }
    }
  }
  if (current) errors.push(current);

  if (errors.length === 0) {
    if (blob.length < 200) return blob;
    return compressGeneric(blob);
  }

  const byFile = new Map<string, TscError[]>();
  for (const e of errors) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }

  const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

  const codeCounts = new Map<string, number>();
  for (const e of errors) {
    codeCounts.set(e.code, (codeCounts.get(e.code) ?? 0) + 1);
  }
  const topCodes = [...codeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code} (${count}x)`)
    .join(", ");

  const header = `TypeScript: ${errors.length} errors in ${byFile.size} files${topCodes ? `\nTop codes: ${topCodes}` : ""}`;

  const body = sortedFiles.map(([file, errs]) => {
    const errLines = errs.map(e =>
      `  L${e.line}: ${e.code} ${e.message}${e.continuations.length ? "\n  " + e.continuations.join("\n  ") : ""}`
    );
    return `\n${file} (${errs.length} error${errs.length > 1 ? "s" : ""})\n${errLines.join("\n")}`;
  });

  return `${header}\n${body.join("\n")}`;
}

const CARGO_REGISTRY_RE = /\/[^ ]*\/\.cargo\/registry\/src\/[^/]+\/([a-zA-Z0-9_-]+)-[\d.]+\//g;

/** Compress cargo (Rust) output: drop warnings, dedup identical panics,
 * compact registry paths, keep errors + failed tests + result summary. */
export function compressCargo(blob: string): string {
  const lines = blob.split("\n");
  const kept: string[] = [];
  let skippingWarning = false;
  const seenErrorBlocks = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^warning:/.test(trimmed)) {
      skippingWarning = true;
      continue;
    }
    if (skippingWarning) {
      if (/^(error|test |running |failures:|test result:|---- |thread '|Encountered)/.test(trimmed)) {
        skippingWarning = false;
      } else {
        continue;
      }
    }

    if (/^Checking /.test(trimmed) || /^Finished /.test(trimmed) || /^Running unittests /.test(trimmed)) continue;
    if (/^warning: `.+` generated \d+ warnings?/.test(trimmed)) continue;
    if (/^test .+ \.\.\. ok$/.test(trimmed)) continue;

    const compacted = line.replace(CARGO_REGISTRY_RE, "$1/");

    if (/^(error\[|error:|thread '.*panicked|Encountered a panic)/.test(trimmed)) {
      const block: string[] = [compacted];
      let j = i + 1;
      while (j < lines.length) {
        const nextTrim = lines[j].trim();
        if (nextTrim === "") break;
        if (/^(error|warning|test |running |failures:|test result:|---- |thread ')/.test(nextTrim)) break;
        if (/^Compiling /.test(nextTrim) || /^Finished /.test(nextTrim)) break;
        block.push(lines[j].replace(CARGO_REGISTRY_RE, "$1/"));
        j++;
      }
      const blockText = block.join("\n");
      const dedupKey = block.find((bl) => /^error\[/.test(bl.trim())) ?? null;
      if (dedupKey) {
        if (seenErrorBlocks.has(dedupKey)) {
          i = j - 1;
          continue;
        }
        seenErrorBlocks.add(dedupKey);
      }
      kept.push(blockText);
      i = j - 1;
      continue;
    }

    if (/^test .+ \.\.\. FAILED/.test(trimmed)) { kept.push(compacted); continue; }
    if (/^test result:/.test(trimmed)) { kept.push(compacted); continue; }
    if (/^failures:/.test(trimmed)) { kept.push(compacted); continue; }
    if (/^    [a-zA-Z_:]/.test(line) && kept.length > 0 && /failures:/.test(kept[kept.length - 1])) {
      kept.push(compacted);
      continue;
    }
  }

  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!result) return blob;
  return result.length >= blob.length ? blob : result;
}

const SIGNAL_PATTERNS = /error|Error|ERROR|FAIL|fail|panic|PANIC|✖|✗|broken|crash|fatal|FATAL|unreachable|undefined|Cannot|cannot|not found|denied|Exception|Traceback/;

/** Compress pytest output: keep failed test names + tracebacks, drop passing
 * test dots, `=`/`-` separators, and pytest's verbose progress lines. */
export function compressPytest(blob: string): string {
  const lines = blob.split("\n");
  const kept: string[] = [];
  let inFailure = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^=+\s*$/.test(trimmed)) continue;
    if (/^-+\s*$/.test(trimmed)) continue;
    if (/^PASSED$/.test(trimmed) && !inFailure) continue;
    if (/^\s*\.+\s*$/.test(line)) continue;
    if (/^collected \d+ items?/.test(trimmed)) continue;
    if (/^test session starts/.test(trimmed)) continue;
    if (/^plugins:/.test(trimmed)) continue;
    if (/^rootdir:/.test(trimmed)) continue;

    if (/^_____.*_____/.test(trimmed)) {
      inFailure = true;
      kept.push(trimmed);
      continue;
    }

    if (/^FAILED /.test(trimmed) || /^SHORT TEST SUMMARY/.test(trimmed) || /^\d+ failed/.test(trimmed) || /^=+ .*short test summary/.test(trimmed)) {
      kept.push(trimmed.replace(/^=+/, "").replace(/=+$/, "").trim());
      continue;
    }

    if (/^=+ .*failed.* =+$/.test(trimmed)) {
      kept.push(trimmed.replace(/^=+/, "").replace(/=+$/, "").trim());
      continue;
    }

    if (/^FAILED\b/.test(trimmed) && !inFailure) {
      kept.push(trimmed);
      continue;
    }

    if (/FAILED/.test(trimmed) && !inFailure && !/^=+/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }

    if (inFailure) {
      if (trimmed === "") {
        inFailure = false;
        kept.push("");
        continue;
      }
      kept.push(line);
      continue;
    }

    if (/AssertionError|assert\b|Error:|Exception/.test(trimmed)) {
      kept.push(line);
    }
  }

  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!result) return blob;
  return result.length >= blob.length ? blob : result;
}

/** Compress `go test` output: keep failed test names + panics + build errors,
 * drop passing test lines, `ok`/`PASS` summaries, and progress markers. */
export function compressGo(blob: string): string {
  const lines = blob.split("\n");
  const kept: string[] = [];
  let inFailure = false;
  const seenPanics = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^=== RUN/.test(trimmed) || /^=== PAUSE/.test(trimmed) || /^=== CONT/.test(trimmed)) continue;
    if (/^--- PASS:/.test(trimmed)) continue;
    if (/^PASS$/.test(trimmed)) continue;
    if (/^ok\s+/.test(trimmed) || /^ok\t/.test(line)) continue;
    if (/^\.{1,}$/.test(trimmed) || /^--- SKIP:/.test(trimmed)) continue;

    if (/^--- FAIL:/.test(trimmed)) {
      inFailure = true;
      kept.push(trimmed);
      continue;
    }

    if (/^FAIL$/.test(trimmed) || /^FAIL\s+/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }

    if (/^panic:/.test(trimmed)) {
      const panicText = trimmed;
      if (seenPanics.has(panicText)) continue;
      seenPanics.add(panicText);
      kept.push(line);
      inFailure = true;
      continue;
    }

    if (/^#.*\berror\b/.test(trimmed) || /\.go:\d+.*:\s.*(error|undefined)\b/.test(trimmed) || /^\.\/.*:.*error/.test(trimmed) || /^\.\/.*:.*undefined/.test(trimmed)) {
      kept.push(line);
      inFailure = true;
      continue;
    }

    if (inFailure && trimmed !== "" && !/^=== RUN/.test(trimmed) && !/^--- PASS:/.test(trimmed) && !/^ok\s/.test(trimmed) && !/^PASS$/.test(trimmed)) {
      kept.push(line);
      continue;
    }

    if (trimmed === "" && inFailure) {
      inFailure = false;
      continue;
    }

    if (/assertion failed|Error|error:|panic/i.test(trimmed) && !/^=== RUN/.test(trimmed)) {
      kept.push(line);
    }
  }

  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!result) return blob;
  return result.length >= blob.length ? blob : result;
}

/** Compress Gradle output: keep FAILED tasks + error lines, drop successful
 * task execution lines, `> Task :xxx` noise, and BUILD SUCCESSFUL. */
export function compressGradle(blob: string): string {
  const lines = blob.split("\n");
  const kept: string[] = [];
  let inError = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^BUILD SUCCESSFUL/.test(trimmed)) continue;
    if (/^> Task :/.test(trimmed) && !/FAILED/.test(trimmed)) continue;
    if (/^> Configure project/.test(trimmed)) continue;
    if (/Deprecated feature used/.test(trimmed)) continue;
    if (/^\d+ actionable task/.test(trimmed)) continue;
    if (/^Gradle 8/.test(trimmed) || /^Welcome to Gradle/.test(trimmed)) continue;

    if (/FAILED/.test(trimmed) || /^BUILD FAILED/.test(trimmed) || /^FAILURE:/.test(trimmed)) {
      inError = true;
      kept.push(line);
      continue;
    }
    if (/^(error:|Error:|Exception|Caused by:)/.test(trimmed)) {
      inError = true;
      kept.push(line);
      continue;
    }
    if (inError && trimmed !== "" && (/^\s/.test(line) || /^>/.test(trimmed) || /^\*/.test(trimmed))) {
      kept.push(line);
      continue;
    }
    if (trimmed === "" && inError) {
      inError = false;
      continue;
    }
  }

  if (kept.length === 0) return "";
  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result.length >= blob.length ? blob : result;
}

/** Compress Maven (mvn) output: keep ERROR lines + test failures, drop
 * `[INFO]` noise, `BUILD SUCCESS`, and download progress. */
export function compressMaven(blob: string): string {
  const lines = blob.split("\n");
  const kept: string[] = [];
  let inError = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\[INFO\] Download(?:ing|ed)\b/.test(trimmed)) continue;
    if (/^\[INFO\] Scanning for projects/.test(trimmed)) continue;
    if (/^\[INFO\] Compiling/.test(trimmed)) continue;
    if (/^\[INFO\] Building/.test(trimmed) && !/FAILURE/.test(trimmed)) continue;
    if (/BUILD SUCCESS/.test(trimmed) && !/FAILURE/.test(trimmed)) continue;
    if (/^\[INFO\] Total time/.test(trimmed)) continue;
    if (/^\[INFO\] Finished at/.test(trimmed)) continue;
    if (/^\[INFO\] -+/.test(trimmed) || /^\[INFO\] =+/.test(trimmed)) continue;
    if (/^\[INFO\]  T E S T S/.test(trimmed)) continue;
    if (/^\[INFO\] Running /.test(trimmed)) continue;
    if (/^\[INFO\] Results:/.test(trimmed)) continue;

    if (/^\[ERROR\]/.test(trimmed)) {
      inError = true;
      kept.push(line);
      continue;
    }
    if (/BUILD FAILURE/.test(trimmed)) {
      inError = true;
      kept.push(line);
      continue;
    }
    if (/^Tests run:.*Failures.*[1-9]/.test(trimmed) || /^Tests run:.*Errors.*[1-9]/.test(trimmed)) {
      inError = true;
      kept.push(line);
      continue;
    }
    if (/<<<\s*FAILURE/.test(trimmed) || /^Failed tests:/.test(trimmed)) {
      kept.push(line);
      continue;
    }
    if (inError && trimmed !== "" && (/^\s/.test(line) || /^\[ERROR\]/.test(trimmed) || /^Caused by:/.test(trimmed) || /^at\s/.test(trimmed))) {
      kept.push(line);
      continue;
    }
    if (trimmed === "" && inError) {
      inError = false;
      continue;
    }
  }

  if (kept.length === 0) return "";
  const result = kept.join("\n").replace(/\n{3,}$/g, "\n\n").trim();
  return result.length >= blob.length ? blob : result;
}

/** Compress `dotnet test`/`dotnet build` output: keep failed tests + errors,
 * drop passed test lines and restore/build noise. */
export function compressDotnet(blob: string): string {
  const lines = blob.split("\n");
  const kept: string[] = [];
  let inFailure = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^Restore complete/.test(trimmed) || /^Determining projects to restore/.test(trimmed)) continue;
    if (/^Restored /.test(trimmed)) continue;
    if (/^Building\/Building the project/.test(trimmed)) continue;
    if (/->\s/.test(trimmed) && /\/bin\//.test(trimmed)) continue;
    if (/^Test run for/.test(trimmed)) continue;
    if (/^Passed!\s/.test(trimmed) || /^[✓✔]\s/.test(trimmed)) continue;

    if (/^Failed!\s/.test(trimmed) || /^[✗✘]\s/.test(trimmed) || /^\s+Failed\s/.test(line)) {
      inFailure = true;
      kept.push(line);
      continue;
    }
    if (/^Error:/.test(trimmed) || /^error[:\s]/.test(trimmed) || /:\s+error\s/.test(line) || /^Test summary:.*failed=[1-9]/.test(trimmed) || /^error:/i.test(trimmed)) {
      kept.push(line);
      inFailure = true;
      continue;
    }
    if (inFailure && trimmed !== "" && /^\s/.test(line)) {
      kept.push(line);
      continue;
    }
    if (trimmed === "" && inFailure) {
      inFailure = false;
      continue;
    }
  }

  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!result) return blob;
  return result.length >= blob.length ? blob : result;
}

/** Generic compressor: keep signal lines + indented context after each. */
export function compressGeneric(blob: string): string {
  const lines = blob.split("\n");
  const kept: string[] = [];
  let contextRemaining = 0;

  for (const line of lines) {
    if (SIGNAL_PATTERNS.test(line)) {
      kept.push(line);
      contextRemaining = 2;
    } else if (contextRemaining > 0 && /^\s+/.test(line)) {
      kept.push(line);
      contextRemaining--;
    } else if (contextRemaining > 0) {
      contextRemaining = 0;
    }
  }

  if (kept.length === 0) return blob;
  return kept.join("\n");
}

/** Dispatcher: detect tool, compress, apply never-worse guard. */
export function compressVerifyOutput(blob: string, commands: string[]): string {
  if (!blob) return blob;
  const tool = detectTool(commands);

  let compressed: string;
  switch (tool) {
    case "vitest":
    case "jest":
      compressed = compressVitest(blob);
      break;
    case "tsc":
      compressed = compressTsc(blob);
      break;
    case "cargo":
      compressed = compressCargo(blob);
      break;
    case "pytest":
      compressed = compressPytest(blob);
      break;
    case "go":
      compressed = compressGo(blob);
      break;
    case "gradle":
      compressed = compressGradle(blob);
      break;
    case "maven":
      compressed = compressMaven(blob);
      break;
    case "dotnet":
      compressed = compressDotnet(blob);
      break;
    case "generic":
    default:
      compressed = compressGeneric(blob);
  }

  if (compressed.length >= blob.length) return blob;
  return compressed;
}
