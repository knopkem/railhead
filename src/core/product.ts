import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fenceRanges, isOutsideFences } from "./fences.ts";

/**
 * The product arc — the durable overview a product is built across (`docs/product.md`).
 *
 * A Feature Run builds exactly one Roadmap step; the arc is the thing that
 * persists across runs. Railhead owns the on-disk format (render/parse
 * round-trip, like tickets per ADR 0007) so the doc can be hand-edited:
 * prose survives byte-for-byte, and the machine-readable parts (status, run,
 * feedback lines) are normalized by {@link setStepStatus}. Boundaries parse
 * fence-aware (`fences.ts`), so a fenced snippet inside a step description
 * can never impersonate a heading or a status marker.
 */

export const PRODUCT_DOC = "docs/product.md";

export type StepStatus = "todo" | "built" | "done";

/** The identity of the step a Feature Run builds, persisted with the run
 * (origin.json, RunState) so resume and run-end can finish the arc
 * transaction without the process that derived the prompt. */
export interface ArcStepIdentity {
  number: number;
  title: string;
}

export interface ProductStep {
  number: number;
  title: string;
  status: StepStatus;
  /** The free-prose body of the step block, with marker lines stripped. */
  description: string;
  /** The Feature Run that produced this step, once it is `built`. */
  runId: string | null;
  /** The human's reopen note; travels into the next attempt's prompt. */
  feedback: string | null;
}

export interface ProductPlan {
  name: string;
  vision: string;
  workflows: string;
  traits: string;
  stack: string;
  steps: ProductStep[];
}

export interface ParsedProductPlan {
  plan: ProductPlan;
  warnings: string[];
}

export interface SetStepPatch {
  status: StepStatus;
  /** string = set the line, null = remove the line, undefined = leave as-is. */
  runId?: string | null;
  feedback?: string | null;
}

const STEP_HEADING_RE = /^###\s+(\d+)(?:\s*[—:.)-]+\s*)?(.*)$/gm;
const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/gm;
const MARKER_LINE_RE = /^\*\*(?:Status|Run|Feedback):\*\*/;
const STATUS_RE = /\*\*Status:\*\*[ \t]*([A-Za-z]+)/i;
const RUN_RE = /\*\*Run:\*\*[ \t]*([^\n]+)/i;
const FEEDBACK_RE = /\*\*Feedback:\*\*/i;

const STEP_STATUSES: readonly StepStatus[] = ["todo", "built", "done"];

function normalizeStatus(raw: string, stepNumber: number, warnings: string[]): StepStatus {
  const v = raw.toLowerCase();
  const status = STEP_STATUSES.find((s) => s === v);
  if (status) return status;
  warnings.push(`step ${stepNumber} status "${raw}" is not one of todo|built|done — treated as todo`);
  return "todo";
}

/** Matches of `re` whose span sits outside every fenced region of `text`. */
function outsideMatches(text: string, re: RegExp): RegExpExecArray[] {
  const ranges = fenceRanges(text);
  const global = re.global ? re : new RegExp(re.source, re.flags + "g");
  return [...text.matchAll(global)].filter(
    (m) => m.index !== undefined && isOutsideFences(ranges, m.index, m.index + m[0].length),
  ) as unknown as RegExpExecArray[];
}

interface SectionSpan {
  name: string;
  start: number;
  bodyStart: number;
  end: number;
}

/** The `##` sections of `text` (heading lines included in the span). */
function sectionSpans(text: string): SectionSpan[] {
  const headings = outsideMatches(text, SECTION_HEADING_RE);
  return headings.map((m, i) => {
    const start = m.index;
    const nl = text.indexOf("\n", start);
    const bodyStart = nl < 0 ? text.length : nl + 1;
    const end = i + 1 < headings.length ? headings[i + 1].index! : text.length;
    return { name: m[1].trim(), start, bodyStart, end };
  });
}

function extractSection(text: string, name: string): string {
  const span = sectionSpans(text).find((s) => s.name.toLowerCase() === name.toLowerCase());
  return span ? text.slice(span.bodyStart, span.end).trim() : "";
}

interface StepSpan {
  number: number;
  title: string;
  headingLine: string;
  bodyStart: number;
  start: number;
  end: number;
}

/** The `### N` step blocks of the Roadmap section as absolute spans over
 * `raw`. Every boundary is fence-aware, so fenced content can neither split
 * a block nor impersonate a heading. */
function scanStepSpans(raw: string): StepSpan[] {
  const roadmap = sectionSpans(raw).find((s) => s.name.toLowerCase() === "roadmap");
  if (!roadmap) return [];
  const section = raw.slice(roadmap.start, roadmap.end);
  const offset = roadmap.start;
  return outsideMatches(section, STEP_HEADING_RE).map((m, i, all) => {
    const start = offset + m.index!;
    const nl = raw.indexOf("\n", start);
    const bodyStart = nl < 0 ? raw.length : nl + 1;
    const nextStart = i + 1 < all.length ? offset + all[i + 1].index! : roadmap.end;
    return {
      number: Number(m[1]),
      title: m[2].trim(),
      headingLine: m[0],
      bodyStart,
      start,
      end: nextStart,
    };
  });
}

/** Drop the block's marker lines (Status, Run, Feedback), keeping every
 * other byte — fences included — exactly as written. */
function stripMarkerLines(text: string): string {
  const cut = (s: string): string =>
    s.split("\n").filter((l) => !MARKER_LINE_RE.test(l)).join("\n");
  const ranges = fenceRanges(text);
  if (ranges.length === 0) return cut(text);
  let out = "";
  let cursor = 0;
  for (const r of ranges) {
    out += cut(text.slice(cursor, r.start));
    out += text.slice(r.start, r.end);
    cursor = r.end;
  }
  return out + cut(text.slice(cursor));
}

/** The paragraph starting at `from`: everything up to the first blank line
 * that lies outside fences (a blank line inside a fenced block never ends it). */
function paragraphAfter(text: string, from: number, guardEnd: number): string {
  const ranges = fenceRanges(text);
  let lineStart = text.lastIndexOf("\n", from) + 1;
  while (lineStart <= guardEnd) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl < 0 ? Math.min(text.length, guardEnd) : nl;
    const line = text.slice(lineStart, lineEnd);
    if (line.trim() === "" && isOutsideFences(ranges, lineStart, lineEnd)) {
      return text.slice(from, lineStart).trim();
    }
    if (nl < 0 || nl >= guardEnd) break;
    lineStart = nl + 1;
  }
  return text.slice(from, Math.min(text.length, guardEnd)).trim();
}

function parseStep(raw: string, span: StepSpan, warnings: string[]): ProductStep {
  const block = raw.slice(span.start, span.end);
  const statusMatch = outsideMatches(block, STATUS_RE)[0];
  const runMatch = outsideMatches(block, RUN_RE)[0];
  const feedbackMatch = outsideMatches(block, FEEDBACK_RE)[0];
  return {
    number: span.number,
    title: span.title,
    status: statusMatch
      ? normalizeStatus(statusMatch[1], span.number, warnings)
      : (warnings.push(`step ${span.number} has no readable **Status:** line — treated as todo`), "todo"),
    description: stripMarkerLines(block.slice(span.bodyStart - span.start)).trim(),
    runId: runMatch ? runMatch[1].trim() : null,
    feedback: feedbackMatch
      ? paragraphAfter(block, feedbackMatch.index! + feedbackMatch[0].length, feedbackMatch.index! + block.length)
      : null,
  };
}

export function parseProductPlan(raw: string): ParsedProductPlan {
  const warnings: string[] = [];
  const titleMatch = outsideMatches(raw, /^#[ \t]+(.+)$/m)[0];
  const plan: ProductPlan = {
    name: titleMatch ? titleMatch[1].trim() : "product",
    vision: extractSection(raw, "Vision"),
    workflows: extractSection(raw, "Workflows"),
    traits: extractSection(raw, "Traits"),
    stack: extractSection(raw, "Stack"),
    steps: [],
  };
  const seenNumbers = new Set<number>();
  for (const span of scanStepSpans(raw)) {
    if (seenNumbers.has(span.number)) {
      warnings.push(`duplicate step number ${span.number} — the first block wins`);
      continue;
    }
    seenNumbers.add(span.number);
    plan.steps.push(parseStep(raw, span, warnings));
  }
  return { plan, warnings };
}

export function renderProductPlan(plan: ProductPlan): string {
  let out = `# ${plan.name.trim()}\n`;
  const sections: Array<[string, string | undefined]> = [
    ["Vision", plan.vision],
    ["Workflows", plan.workflows],
    ["Traits", plan.traits],
    ["Stack", plan.stack],
  ];
  for (const [section, body] of sections) {
    if (body?.trim()) out += `\n## ${section}\n\n${body.trim()}\n`;
  }
  out += "\n## Roadmap\n\n";
  out += plan.steps
    .map((s) => {
      let block = `### ${s.number} — ${s.title.trim()}\n\n**Status:** ${s.status}`;
      if (s.runId) block += `\n**Run:** ${s.runId}`;
      if (s.feedback) block += `\n**Feedback:** ${s.feedback}`;
      if (s.description.trim()) block += `\n\n${s.description.trim()}`;
      return block + "\n";
    })
    .join("\n");
  return out;
}

/** The arc's decided prose for model prompts — never the roadmap. The
 * roadmap is run mechanics; a feature-plan prompt needs the identity and the
 * decided stack, not the step list. */
export function renderProductBrief(plan: ProductPlan): string {
  const sections: Array<[string, string | undefined]> = [
    ["Vision", plan.vision],
    ["Workflows", plan.workflows],
    ["Traits", plan.traits],
    ["Stack", plan.stack],
  ];
  return sections
    .filter(([, body]) => body?.trim())
    .map(([heading, body]) => `## ${heading}\n${body!.trim()}`)
    .join("\n\n");
}

export async function readProductPlan(cwd: string): Promise<ProductPlan | null> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, PRODUCT_DOC), "utf8");
  } catch {
    return null;
  }
  return parseProductPlan(raw).plan;
}

export async function writeProductPlan(cwd: string, plan: ProductPlan): Promise<void> {
  await mkdir(join(cwd, "docs"), { recursive: true });
  await writeFile(join(cwd, PRODUCT_DOC), renderProductPlan(plan), "utf8");
}

/** The arc's next actionable step, with the human gate enforced (ADR 0051):
 * the first step not `done` decides the action. A `todo` step is eligible to
 * build; a `built` step awaits the human's verification and BLOCKS the steps
 * after it (test it, then mark it done or reopen it with feedback); every step
 * done means the arc needs a new step. Document order is the execution order,
 * exactly like tickets. */
export type ArcAction =
  | { kind: "build"; step: ProductStep }
  | { kind: "verify"; step: ProductStep }
  | { kind: "extend" };

export function nextArcAction(plan: ProductPlan): ArcAction {
  const step = plan.steps.find((s) => s.status !== "done");
  if (!step) return { kind: "extend" };
  return step.status === "built" ? { kind: "verify", step } : { kind: "build", step };
}

/** Splice one step's machine-readable lines in a saved arc: the block's prose
 * (including fences) is re-emitted byte-for-byte with its marker lines
 * stripped, so hand edits outside the marker cluster survive. Throws when the
 * arc file or the step is missing — silent no-ops here would desync the
 * roadmap from reality. */
export async function setStepStatus(
  cwd: string,
  stepNumber: number,
  patch: SetStepPatch,
): Promise<ProductPlan> {
  const path = join(cwd, PRODUCT_DOC);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`no product arc at ${PRODUCT_DOC} (looking in ${cwd}) — run \`railhead product\` first`);
  }
  const spans = scanStepSpans(raw);
  const span = spans.find((s) => s.number === stepNumber);
  if (!span) {
    const found = spans.map((s) => s.number).join(", ") || "none";
    throw new Error(`step ${stepNumber} does not exist in ${PRODUCT_DOC} (found steps: ${found})`);
  }
  const headingLine = span.headingLine;
  const description = stripMarkerLines(raw.slice(span.bodyStart, span.end)).trim();
  let block = `${headingLine}\n**Status:** ${patch.status}\n`;
  if (patch.runId) block += `**Run:** ${patch.runId}\n`;
  if (patch.feedback) block += `**Feedback:** ${patch.feedback.trimEnd()}\n`;
  if (description) block += `\n${description}\n`;
  const updated = raw.slice(0, span.start) + block + raw.slice(span.end);
  await writeFile(path, updated, "utf8");
  return parseProductPlan(updated).plan;
}
