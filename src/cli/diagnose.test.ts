import { describe, it, expect } from "vitest";
import { parseToolCalls, toolResultContainsImage } from "../gates/evidence.ts";
import { DIAGNOSE_PROMPT } from "./diagnose.ts";

function toolUseLine(tool: string, input: Record<string, unknown>, status = "completed", output?: unknown, attachments?: unknown): string {
  return JSON.stringify({ type: "tool_use", part: { type: "tool", tool, state: { status, input, ...(output !== undefined ? { output } : {}), ...(attachments !== undefined ? { attachments } : {}) } } });
}

function textLine(text: string): string {
  return JSON.stringify({ type: "text", part: { type: "text", text } });
}

/** Build the DiagnoseResult the way runScreenshotDiagnostic does — extracted
 * here so the test doesn't need a real opencode subprocess. The logic mirrors
 * runScreenshotDiagnostic's post-processing of parseToolCalls. */
function diagnoseFromTranscript(jsonlText: string) {
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
  const agentSawImage = readSucceeded && readOfScreenshot
    ? toolResultContainsImage(readOfScreenshot.output, readOfScreenshot.attachments)
    : false;

  const screenshotWasRepoRelative = screenshotPath
    ? !screenshotPath.startsWith("/tmp") && !screenshotPath.startsWith("/private/tmp") && (screenshotPath.includes(".railhead") || screenshotPath.includes("diagnose"))
    : false;

  return {
    tookScreenshot: !!screenshotCall,
    screenshotPath,
    screenshotWasRepoRelative,
    readScreenshot: !!readOfScreenshot,
    readPath,
    readSucceeded,
    agentSawImage,
    toolsAvailable,
    rawCalls: calls,
  };
}

describe("DIAGNOSE_PROMPT", () => {
  it("tells the model to save screenshots to a repo-relative path, not /tmp", () => {
    expect(DIAGNOSE_PROMPT).toContain(".railhead/diagnose/shot.png");
    expect(DIAGNOSE_PROMPT).toMatch(/relative to the current working directory/i);
    expect(DIAGNOSE_PROMPT).toMatch(/reject paths outside the project repo/i);
  });

  it("tells the model to read the saved PNG — not just save it", () => {
    expect(DIAGNOSE_PROMPT).toMatch(/read.*\.png/i);
    expect(DIAGNOSE_PROMPT).toMatch(/vision-capable model receives the image/i);
    expect(DIAGNOSE_PROMPT).toMatch(/without that read step you are judging blind/i);
  });
});

describe("diagnoseFromTranscript — happy path", () => {
  const imageBlock = { content: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] };
  const happy = [
    toolUseLine("chrome-devtools_new_page", { url: "about:blank" }),
    toolUseLine("chrome-devtools_take_screenshot", { filePath: ".railhead/diagnose/shot.png" }),
    toolUseLine("read", { filePath: ".railhead/diagnose/shot.png" }, "completed", imageBlock),
    textLine("DIAGNOSE_DONE"),
  ].join("\n");

  it("detects the screenshot was taken", () => {
    const r = diagnoseFromTranscript(happy);
    expect(r.tookScreenshot).toBe(true);
    expect(r.screenshotPath).toBe(".railhead/diagnose/shot.png");
  });

  it("detects the screenshot path is repo-relative (not /tmp)", () => {
    const r = diagnoseFromTranscript(happy);
    expect(r.screenshotWasRepoRelative).toBe(true);
  });

  it("detects the model read the saved PNG", () => {
    const r = diagnoseFromTranscript(happy);
    expect(r.readScreenshot).toBe(true);
    expect(r.readPath).toBe(".railhead/diagnose/shot.png");
    expect(r.readSucceeded).toBe(true);
  });

  it("reports the tools the model used", () => {
    const r = diagnoseFromTranscript(happy);
    expect(r.toolsAvailable).toContain("chrome-devtools_take_screenshot");
    expect(r.toolsAvailable).toContain("read");
  });

  it("confirms vision only when the read result carries an image content block (#56)", () => {
    const r = diagnoseFromTranscript(happy);
    expect(r.readSucceeded).toBe(true);
    expect(r.agentSawImage).toBe(true);
  });
});

describe("diagnoseFromTranscript — the false-positive failure mode (#56)", () => {
  it("reports NOT vision-capable when the read tool returned only text (no image block)", () => {
    // The goty_game failure: the read tool returns "Image read successfully"
    // even when the model cannot decode image input. The old agentSawImage
    // check (file exists + read succeeded) reported PASS — the new check must
    // reject it: the model receives text, not pixels.
    const transcript = [
      toolUseLine("chrome-devtools_take_screenshot", { filePath: ".railhead/diagnose/shot.png" }),
      toolUseLine("read", { filePath: ".railhead/diagnose/shot.png" }, "completed", "Image read successfully (this model does not support image input)"),
      textLine("DIAGNOSE_DONE"),
    ].join("\n");
    const r = diagnoseFromTranscript(transcript);
    expect(r.readSucceeded).toBe(true);
    expect(r.agentSawImage).toBe(false);
  });

  it("reports NOT vision-capable when the read result has no output at all", () => {
    const transcript = [
      toolUseLine("chrome-devtools_take_screenshot", { filePath: ".railhead/diagnose/shot.png" }),
      toolUseLine("read", { filePath: ".railhead/diagnose/shot.png" }),
    ].join("\n");
    const r = diagnoseFromTranscript(transcript);
    expect(r.readSucceeded).toBe(true);
    expect(r.agentSawImage).toBe(false);
  });

  it("detects an image content block nested in a JSON output object", () => {
    expect(toolResultContainsImage({ content: [{ type: "image", data: "x" }] })).toBe(true);
    expect(toolResultContainsImage({ type: "text", text: "Image read successfully" })).toBe(false);
    expect(toolResultContainsImage("Image read successfully")).toBe(false);
    expect(toolResultContainsImage(null)).toBe(false);
  });

  it("detects the modern opencode attachment shape (type=file, image mime) the AI-SDK block check misses", () => {
    // A real spriteforge goal transcript carries the PNG here: state.output is
    // "Image read successfully" while state.attachments holds the pixels. The
    // old check read only output and false-failed a model that DID receive the
    // image.
    expect(toolResultContainsImage("Image read successfully", [{ type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" }])).toBe(true);
    expect(toolResultContainsImage(undefined, [{ type: "file", mime: "image/png", data: "iVBORw0KGgo=" }])).toBe(true);
    expect(toolResultContainsImage("Image read successfully", [{ type: "file", mime: "text/plain", url: "data:text/plain,hi" }])).toBe(false);
    expect(toolResultContainsImage("Image read successfully", [{ type: "file", mime: "image/png", url: "" }])).toBe(false);
    expect(toolResultContainsImage(undefined, "not-an-array")).toBe(false);
  });

  it("sees the attachment shape through a full transcript", () => {
    const transcript = [
      toolUseLine("chrome-devtools_take_screenshot", { filePath: ".railhead/diagnose/shot.png" }),
      toolUseLine("read", { filePath: ".railhead/diagnose/shot.png" }, "completed", "Image read successfully", [
        { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" },
      ]),
      textLine("DIAGNOSE_DONE"),
    ].join("\n");
    const r = diagnoseFromTranscript(transcript);
    expect(r.readSucceeded).toBe(true);
    expect(r.agentSawImage).toBe(true);
  });
});

describe("diagnoseFromTranscript — the platformer failure mode", () => {
  it("detects when the model takes a screenshot but does NOT read it (the visual-review bug)", () => {
    const transcript = [
      toolUseLine("chrome-devtools_new_page", { url: "about:blank" }),
      toolUseLine("chrome-devtools_take_screenshot", { filePath: ".railhead/diagnose/shot.png" }),
      textLine("Here is the screenshot."),
      textLine("DIAGNOSE_DONE"),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.tookScreenshot).toBe(true);
    expect(r.screenshotWasRepoRelative).toBe(true);
    expect(r.readScreenshot).toBe(false);
    expect(r.readPath).toBeNull();
  });

  it("detects when the model saved to /tmp (the MCP path-rejection bug)", () => {
    const transcript = [
      toolUseLine("chrome-devtools_take_screenshot", { filePath: "/tmp/shot.png" }, "error"),
      textLine("DIAGNOSE_FAIL screenshot tool rejected /tmp path"),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.tookScreenshot).toBe(true);
    expect(r.screenshotWasRepoRelative).toBe(false);
    expect(r.screenshotPath).toBe("/tmp/shot.png");
  });

  it("detects /private/tmp rejection (the canonical macOS /tmp path)", () => {
    const transcript = [
      toolUseLine("chrome-devtools_take_screenshot", { filePath: "/private/tmp/shots/cam0.png" }, "error"),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.tookScreenshot).toBe(true);
    expect(r.screenshotWasRepoRelative).toBe(false);
  });

  it("detects when the read tool was never available (no read calls at all)", () => {
    const transcript = [
      toolUseLine("chrome-devtools_new_page", { url: "about:blank" }),
      toolUseLine("chrome-devtools_take_screenshot", { filePath: ".railhead/diagnose/shot.png" }),
      toolUseLine("chrome-devtools_evaluate_script", { function: "() => document.title" }),
      textLine("DIAGNOSE_DONE"),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.tookScreenshot).toBe(true);
    expect(r.readScreenshot).toBe(false);
    expect(r.toolsAvailable).not.toContain("read");
  });
});

describe("diagnoseFromTranscript — edge cases", () => {
  it("detects read with an absolute repo path", () => {
    const transcript = [
      toolUseLine("chrome-devtools_take_screenshot", { filePath: "/Users/test/project/.railhead/diagnose/shot.png" }),
      toolUseLine("read", { filePath: "/Users/test/project/.railhead/diagnose/shot.png" }),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.screenshotWasRepoRelative).toBe(true);
    expect(r.readScreenshot).toBe(true);
  });

  it("does not match read calls on unrelated files", () => {
    const transcript = [
      toolUseLine("read", { filePath: "/Users/test/project/src/main.ts" }),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.readScreenshot).toBe(false);
  });

  it("reports no screenshot when the model didn't call any screenshot tool", () => {
    const transcript = [
      toolUseLine("bash", { command: "echo hello" }),
      textLine("DIAGNOSE_FAIL no screenshot tool"),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.tookScreenshot).toBe(false);
    expect(r.screenshotPath).toBeNull();
  });

  it("handles empty/malformed transcripts gracefully", () => {
    expect(diagnoseFromTranscript("")).toEqual({
      tookScreenshot: false,
      screenshotPath: null,
      screenshotWasRepoRelative: false,
      readScreenshot: false,
      readPath: null,
      readSucceeded: false,
      agentSawImage: false,
      toolsAvailable: [],
      rawCalls: [],
    });
  });

  it("skips malformed JSONL lines without failing", () => {
    const transcript = [
      "not json at all",
      toolUseLine("chrome-devtools_take_screenshot", { filePath: ".railhead/diagnose/shot.png" }),
      "{ broken json",
      toolUseLine("read", { filePath: ".railhead/diagnose/shot.png" }),
    ].join("\n");

    const r = diagnoseFromTranscript(transcript);
    expect(r.tookScreenshot).toBe(true);
    expect(r.readScreenshot).toBe(true);
    expect(r.rawCalls).toHaveLength(2);
  });
});
