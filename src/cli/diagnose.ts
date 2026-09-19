/**
 * `railhead diagnose screenshots` — a standalone diagnostic that spawns a real
 * `opencode run` against the configured visual model and checks whether the
 * model can complete the screenshot workflow: navigate to a page, capture a
 * screenshot to a repo-relative path, and `read` the saved PNG back as an
 * image content block.
 *
 * This is NOT a unit test (it requires a real model + a chrome-devtools MCP
 * server). Run it manually to verify a model/agent configuration before
 * trusting it with an unattended visual review run:
 *
 *   railhead diagnose screenshots            (uses model.visual from railhead.json)
 *   railhead diagnose screenshots --model M  (override)
 *
 * The diagnostic writes its JSONL transcript to `.railhead/diagnose/` so you
 * can inspect what the model actually did. It never builds an app — the page
 * is `about:blank`, so the test isolates the tool-usage chain, not rendering.
 */
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { executeOpendCode, type ExecOptions } from "../execute/executor.ts";
import { ledgerDir, initLedger, resetPhase, eventPath } from "../core/ledger.ts";
import { parseToolCalls, toolResultContainsImage, type ToolCall } from "../gates/evidence.ts";
import { nowClock } from "./overview.ts";

export interface DiagnoseOptions {
  cwd: string;
  model: string | null;
  maxContextTokens?: number | null;
  maxSteps?: number | null;
  stallTimeoutSec?: number | null;
}

export interface DiagnoseResult {
  tookScreenshot: boolean;
  screenshotPath: string | null;
  screenshotWasRepoRelative: boolean;
  readScreenshot: boolean;
  readPath: string | null;
  readSucceeded: boolean;
  screenshotFileExists: boolean;
  agentSawImage: boolean;
  toolsAvailable: string[];
  rawCalls: ToolCall[];
  error: string | null;
}

/** The prompt sent to the model. Deliberately bare: no app, no build, just
 * "open a page, screenshot it, read it back." This isolates the tool-usage
 * chain from rendering/build concerns. */
export const DIAGNOSE_PROMPT = `You are being tested. Complete these three steps exactly, then stop:

1. Open a new browser page (navigate to "about:blank" using the chrome-devtools tools available to you).
2. Take a screenshot of that page and save it to the file path .railhead/diagnose/shot.png (relative to the current working directory). Screenshot tools that save via a filePath reject paths outside the project repo — always use a relative path.
3. Read the saved .railhead/diagnose/shot.png file using your file-reading tool (the "read" tool). A vision-capable model receives the image as an image content block when it reads an image file — without that read step you are judging blind.

After completing all three steps, reply with exactly:
DIAGNOSE_DONE

If any step fails, reply with:
DIAGNOSE_FAIL <one line describing what went wrong>

Reply terse, no prose narration beyond the marker.`;

export async function runScreenshotDiagnostic(options: DiagnoseOptions): Promise<DiagnoseResult> {
  const { cwd, model } = options;
  const dir = ledgerDir(cwd, "diagnose");
  const shotDir = join(cwd, ".railhead", "diagnose");

  await mkdir(shotDir, { recursive: true });
  await initLedger(dir);
  const phaseFile = "diagnose-screenshots";
  await resetPhase(dir, phaseFile);

  const execOptions: ExecOptions = {
    cwd,
    ledgerDir: dir,
    phaseFile,
    model,
    agent: null,
    live: true,
    verbose: false,
    heartbeat: true,
    livePrefix: "diagnose",
    maxSteps: options.maxSteps ?? 30,
    stallTimeoutSec: options.stallTimeoutSec ?? 120,
    maxContextTokens: options.maxContextTokens ?? 65000,
  };

  const result = await executeOpendCode(DIAGNOSE_PROMPT, execOptions);

  const jsonlPath = eventPath(dir, phaseFile);
  let jsonlText = "";
  try {
    jsonlText = await readFile(jsonlPath, "utf8");
  } catch {
    // ledger file may not exist if the process was killed very early
  }

  const calls = parseToolCalls(jsonlText);
  const toolsAvailable = [...new Set(calls.map((c) => c.tool))];

  const screenshotCall = calls.find(
    (c) => c.tool === "chrome-devtools_take_screenshot" || c.tool === "browser_take_screenshot" || c.tool === "take_screenshot",
  );
  const screenshotPath = screenshotCall
    ? (screenshotCall.input.filePath as string) ?? (screenshotCall.input.path as string) ?? null
    : null;

  const readCalls = calls.filter((c) => c.tool === "read" || c.tool === "read_file");
  const readOfScreenshot = readCalls.find((c) => {
    const fp = (c.input.filePath as string) ?? (c.input.path as string) ?? "";
    return fp.includes("shot.png") || fp.includes("diagnose");
  });
  const readPath = readOfScreenshot
    ? (readOfScreenshot.input.filePath as string) ?? (readOfScreenshot.input.path as string) ?? null
    : null;
  const readSucceeded = readOfScreenshot?.status === "completed";

  const absShotPath = join(cwd, ".railhead", "diagnose", "shot.png");
  const screenshotFileExists = existsSync(absShotPath);

  const tookScreenshot = !!screenshotCall;
  const readScreenshot = !!readOfScreenshot;

  // Issue #56: a completed `read` on the PNG does NOT prove the model saw the
  // image — the tool succeeds at reading bytes even when the model cannot
  // decode image input (opencode injects "Cannot read image" as a text part).
  // The only signal that the model actually received pixels is an image
  // content block in the read tool's result.
  const agentSawImage = readSucceeded && readOfScreenshot
    ? toolResultContainsImage(readOfScreenshot.output, readOfScreenshot.attachments)
    : false;

  const screenshotWasRepoRelative = screenshotPath
    ? !screenshotPath.startsWith("/tmp") && !screenshotPath.startsWith("/private/tmp") && (screenshotPath.includes(".railhead") || screenshotPath.includes("diagnose"))
    : false;

  let error: string | null = null;
  if (result.status !== "ok") {
    error = `agent ${result.status === "timeout" ? "stalled (no output)" : result.status === "budget_exceeded" ? `exceeded step budget (${result.steps} steps)` : `exited ${result.code}`} — ${result.errorMessage ?? "no error message"}`;
  }

  return {
    tookScreenshot,
    screenshotPath,
    screenshotWasRepoRelative,
    readScreenshot,
    readPath,
    readSucceeded,
    screenshotFileExists,
    agentSawImage,
    toolsAvailable,
    rawCalls: calls,
    error,
  };
}

export function renderDiagnoseResult(r: DiagnoseResult): string {
  const lines: string[] = [];
  const check = (ok: boolean, label: string, detail?: string) => {
    const mark = ok ? "✓" : "✗";
    lines.push(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  lines.push(`\n[${nowClock()}] screenshot diagnostic — model tool-usage check`);
  lines.push("");

  if (r.error) {
    lines.push(`  ⚠ agent error: ${r.error}`);
    lines.push("");
  }

  check(r.toolsAvailable.length > 0, "agent used tools", `${r.toolsAvailable.length} tool call(s), tools: ${r.toolsAvailable.join(", ") || "(none)"}`);

  check(r.tookScreenshot, "model called take_screenshot", r.screenshotPath ? `filePath=${r.screenshotPath}` : undefined);

  check(r.screenshotWasRepoRelative, "screenshot saved to a repo-relative path", r.screenshotPath ?? undefined);

  check(r.screenshotFileExists, "screenshot file exists on disk");

  check(r.readScreenshot, "model called read on the saved PNG", r.readPath ?? undefined);

  check(r.readSucceeded, "read call completed without error");

  check(r.agentSawImage, "read result contained an image content block (model receives pixels, not just text)");

  lines.push("");
  const allPassed = r.tookScreenshot && r.screenshotWasRepoRelative && r.screenshotFileExists && r.readScreenshot && r.readSucceeded && r.agentSawImage;
  const partialPass = r.tookScreenshot && r.screenshotFileExists && !r.readScreenshot;
  if (allPassed) {
    lines.push("  ✓ PASS — the model can save screenshots, read them back, and receives image pixels.");
  } else if (r.readSucceeded && !r.agentSawImage) {
    lines.push("  ✗ FAIL — the read call completed but returned NO image content block.");
    lines.push("    The model receives text, not pixels — the tool succeeds at reading bytes,");
    lines.push("    but the model cannot SEE the image. Visual review would be judging blind.");
    lines.push("    Check: is the configured model actually vision-capable?");
    lines.push("    (the 'read' tool returns \"Image read successfully\" even for a text-only model)");
  } else if (partialPass) {
    lines.push("  ⚠ PARTIAL — the model takes screenshots but does NOT read them back.");
    lines.push("    This means visual review is judging blind. Check:");
    lines.push("    a) Is the `read` tool available to the visual-review agent?");
    lines.push("       (agent: null should give it opencode's default toolset)");
    lines.push("    b) Is a prior learning like \"model cannot read screenshots\" suppressing the read attempt?");
    lines.push("       (check .railhead/learnings.md for capability self-assessments)");
  } else if (!r.tookScreenshot) {
    lines.push("  ✗ FAIL — the model did not call take_screenshot at all.");
    lines.push("    Check: is the chrome-devtools MCP server configured and running?");
  } else {
    lines.push("  ✗ FAIL — see details above.");
  }
  lines.push("");
  lines.push(`  transcript: ${join(".railhead", "diagnose", "events", "diagnose-screenshots.jsonl")}`);
  lines.push(`  screenshot: ${join(".railhead", "diagnose", "shot.png")}`);
  lines.push("");
  return lines.join("\n");
}
