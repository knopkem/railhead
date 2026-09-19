import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { scanJsonObjects } from "../core/json.ts";

/**
 * Ported sharpening + domain-modeling discipline (see
 * `docs/adr/0010-plan-time-sharpening.md`), owned entirely by this repo — no
 * runtime or install-time dependency on an external skill suite (ADR 0007).
 *
 * Mechanically this differs from a live interactive chat interview: each
 * round is one ordinary, stateless `executeOpendCode` phase call (ADR 0001 —
 * a fresh subprocess has no memory of prior rounds), so the railhead itself
 * renders questions, collects answers, and re-supplies the whole exchange
 * history on every round. The model's job is only to emit structured marker
 * blocks; the railhead owns all file writes (CONTEXT.md, docs/adr/), exactly
 * like `$CONTRACTS`/`$TICKETS` elsewhere in this codebase.
 *
 * Deliberately does NOT use the word "frontier" for the question-readiness
 * concept: this repo's own CONTEXT.md already defines Frontier as "Tickets
 * whose Blocked-by Tickets are all Committed" — a different concept. Reusing
 * the word here would create exactly the kind of glossary collision the
 * ported domain-modeling discipline itself is built to catch.
 */

export interface TermEntry {
  term: string;
  definition: string;
  avoid?: string[];
}

export interface AdrEntry {
  title: string;
  body: string;
}

export interface SharpenQuestion {
  title: string;
  body: string;
  recommended: string;
}

/**
 * Interview depth — the user-facing knob on how hard the planning interview
 * pushes, presented as a picker before round 1 (mirrors the `sharpen` skill's
 * depth selector, which the railhead otherwise re-implements ownerless per ADR
 * 0007). Level names map to a soft target question count; `exhaustive` is the
 * one departure from a hard question cap — it raises the backstop instead of
 * serving as one, so the model's own `$DONE` (or the raised backstop) is what
 * finally stops it.
 */
export type SharpenDepth = "light" | "standard" | "deep" | "exhaustive" | "skip";

export interface SharpenDepthOption {
  depth: SharpenDepth;
  /** Short label for the picker, e.g. "Light (Recommended)". */
  label: string;
  /** One-line description shown beside the option, says WHY not just WHAT. */
  description: string;
}

/**
 * The four picker options, in display order. The first is the recommended
 * default — `askPick` callers should pass `0` as the default index so empty
 * input lands here. Wording matches the `sharpen` skill so a user moving
 * between the two sees a consistent mental model.
 */
export const GRILL_DEPTH_OPTIONS: readonly SharpenDepthOption[] = [
  {
    depth: "standard",
    label: "Standard (Recommended)",
    description: "10–15 questions across the main decision tree and its immediate branches. Right for sharpening a rough plan.",
  },
  {
    depth: "light",
    label: "Light",
    description: "3–5 questions on the biggest forks only. A quick sanity check on a plan you mostly trust.",
  },
  {
    depth: "deep",
    label: "Deep",
    description: "20–30 questions. Mines every branch down to edge cases and unspoken assumptions. For high-stakes or high-uncertainty designs.",
  },
  {
    depth: "exhaustive",
    label: "Exhaustive",
    description: "No hard cap — grind until the frontier is genuinely empty. Use when a wrong decision is expensive to reverse.",
  },
  {
    depth: "skip",
    label: "Skip (auto-answer)",
    description: "Runs the interview but auto-answers every question with the model's recommendation, silently — no human prompts. Terms and ADRs still resolve.",
  },
];

/**
 * Soft target question count for a depth. These are the MIDDLE of the band
 * the option descriptions quote (standard = "10–15" → 12); they guide the
 * model's pacing, they are NOT hard caps — `maxRounds` is the railhead's only
 * hard backstop. Exported for tests and so the CLI doesn't second-guess the
 * band-to-number mapping.
 */
export const DEPTH_TARGET_QUESTIONS: Record<SharpenDepth, number> = {
  light: 4,
  standard: 12,
  deep: 25,
  exhaustive: 0,
  skip: 12,
};

/**
 * The backstop `maxRounds` to use for a chosen depth, given the config's
 * existing cap (or the railhead default if none). Exhaustive raises the cap
 * to a large number for this session only (never persisted), per the user's
 * choice — the model's `$DONE` is the primary stop, the raised backstop just
 * prevents a never-stopping model from spinning literally forever. All
 * other depths honor the existing cap unchanged, since `maxRounds` bounds
 * *rounds* not questions, and a round can carry several questions.
 */
export function depthToMaxRounds(depth: SharpenDepth, existingCap: number): number {
  if (depth === "exhaustive") return Math.max(existingCap, EXHAUSTIVE_BACKSTOP);
  return existingCap;
}

/** The raised backstop used only when the user picks Exhaustive. Sized so a
 * runaway model that never emits `$DONE` cannot run the railhead literally
 * forever, but a genuine exhaustive pass on a thorny design is not cut
 * short by the railhead's ordinary 6-round default. */
export const EXHAUSTIVE_BACKSTOP = 100;

export interface SharpenRound {
  terms: TermEntry[];
  adrs: AdrEntry[];
  questions: SharpenQuestion[];
  done: boolean;
}

export interface SharpenExchange {
  question: SharpenQuestion;
  answer: string;
}

const MARKERS = ["$TERMS", "$ADRS", "$QUESTIONS", "$DONE"] as const;

function findMarkerPositions(text: string): Array<{ marker: string; index: number }> {
  const found: Array<{ marker: string; index: number }> = [];
  for (const m of MARKERS) {
    const idx = text.search(new RegExp(`\\${m}\\b`, "i"));
    if (idx >= 0) found.push({ marker: m, index: idx });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Slice from just after `marker` to the start of whichever OTHER marker
 * appears next (of any kind), or end of text. Markers are siblings here
 * (unlike the reviewer's nested $BLOCKING/$NITS/$OK, fixed separately), so
 * "next marker of any kind" is always the right boundary. */
function sliceForMarker(
  text: string,
  marker: string,
  positions: Array<{ marker: string; index: number }>,
): string {
  const pos = positions.find((p) => p.marker === marker);
  if (!pos) return "";
  const afterStart = pos.index + marker.length;
  const next = positions.find((p) => p.index > pos.index);
  return text.slice(afterStart, next ? next.index : undefined).trim();
}

/**
 * Parse one round's opencode output into resolved terms/ADRs plus this
 * round's next questions (or a signal that nothing remains to ask).
 *
 * `$DONE`'s presence is the authoritative "interview finished" signal. Its
 * ABSENCE, combined with no parseable questions, is ALSO treated as done —
 * a round that asks nothing must not spin the loop forever waiting on a
 * marker the model forgot to emit. This mirrors this project's existing
 * "don't fabricate false confidence, but never hang either" rule (see ADR
 * 0009's inconclusive-verdict amendment for visual review): the railhead's
 * own `sharpen_max_rounds` cap is the OTHER direction's backstop (a model that
 * never stops asking); this direction just needs to fail safe, silently.
 */
export function parseSharpenRound(text: string): SharpenRound {
  const positions = findMarkerPositions(text);
  const termsBlock = sliceForMarker(text, "$TERMS", positions);
  const adrsBlock = sliceForMarker(text, "$ADRS", positions);
  const questionsBlock = sliceForMarker(text, "$QUESTIONS", positions);
  const doneMarkerPresent = positions.some((p) => p.marker === "$DONE");

  const terms: TermEntry[] = scanJsonObjects(termsBlock)
    .filter(
      (o) =>
        typeof o.term === "string" &&
        (o.term as string).trim() &&
        typeof o.definition === "string" &&
        (o.definition as string).trim(),
    )
    .map((o) => ({
      term: String(o.term).trim(),
      definition: String(o.definition).trim(),
      avoid: Array.isArray(o.avoid)
        ? (o.avoid as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : undefined,
    }));

  const adrs: AdrEntry[] = scanJsonObjects(adrsBlock)
    .filter((o) => typeof o.title === "string" && (o.title as string).trim() && typeof o.body === "string" && (o.body as string).trim())
    .map((o) => ({ title: String(o.title).trim(), body: String(o.body).trim() }));

  const questions: SharpenQuestion[] = scanJsonObjects(questionsBlock)
    .filter((o) => typeof o.title === "string" && (o.title as string).trim() && typeof o.body === "string" && (o.body as string).trim())
    .map((o) => ({
      title: String(o.title).trim(),
      body: String(o.body).trim(),
      recommended: typeof o.recommended === "string" ? o.recommended.trim() : "",
    }));

  return { terms, adrs, questions, done: doneMarkerPresent || questions.length === 0 };
}

/**
 * Render ONE question in the sharpening discipline's presentation: numbered,
 * with the model's recommended answer. Numbering is 1-based within the round
 * — pass the 0-based `indexInRound` from the caller's loop.
 *
 * One-at-a-time rendering keeps the discipline honest: a question that
 * looked independent when the model batched it may actually depend on a
 * sibling's answer, and we only discover that by letting the user answer Q1
 * before showing Q2 (see ADR 0010's "ask only questions whose prerequisites
 * are already settled"). The model still emits a round's questions together
 * to keep the subprocess count down; the railhead splits them at presentation
 * time.
 */
export function renderQuestionForTerminal(question: SharpenQuestion, indexInRound: number): string {
  // No recommendation line here: the interactive answer prompt already shows
  // it (`➡️ answer [<recommended>]`), and printing it twice was noise.
  return `❓ **Q${indexInRound + 1}** - **${question.title}**: ${question.body}`;
}

/** Format a round's questions joined by a rule — kept for callers that want
 * the whole round at once (e.g. a non-interactive log dump). Unlike the
 * interactive per-question render, this includes each recommendation: with no
 * answer prompt following, it is the only place the model's suggestion shows.
 * The interactive CLI path uses {@link renderQuestionForTerminal} instead. */
export function renderQuestionsForTerminal(questions: SharpenQuestion[]): string {
  return questions
    .map((q, i) => `${renderQuestionForTerminal(q, i)}\n\n➡️ ${q.recommended || "(no recommendation given)"}`)
    .join("\n\n---\n\n");
}

/** Interview mode. `build` (the default) sharpens a feature description; `fix`
 * sharpens a bug report. The difference is what the user uniquely knows: in
 * build mode the user holds domain decisions; in fix mode the user holds
 * reproduction steps. Code structure is the planner's job in both — the user
 * is never asked to locate code. */
export type SharpenMode = "build" | "fix";

export function sharpenSystemPrompt(
  topic: string,
  contractsSummary: string,
  existingGlossary: string,
  contextBudget?: number,
  depthTarget?: number,
  mode: SharpenMode = "build",
  planText?: string | null,
): string {
  const glossaryBlock = existingGlossary.trim()
    ? `\nThe project's EXISTING glossary (CONTEXT.md) — these terms are already decided; challenge the user if a later answer conflicts with one instead of silently accepting a conflicting use:\n${existingGlossary.trim()}\n`
    : "\nNo CONTEXT.md exists yet for this project.\n";

  const depthLine = depthTarget === undefined
    ? ""
    : depthTarget > 0
      ? `\nThe user picked a question budget of roughly ${depthTarget} for this interview — pace yourself so the interview winds down around that count once the live frontier is approaching empty. The budget is a target, not a hard cap: ask a sharper question if it resolves a real fork, stop early if nothing remains.`
      : `\nThe user picked "exhaustive" — there is no question cap. Continue questioning until the frontier is genuinely empty, then emit $DONE.`;

  const sharedContract = `Output EXACTLY this shape, in this order, using the single word NONE literally for an empty section (never omit a section):

$TERMS
{"term":"Ticket","definition":"one line, what it IS not what it does","avoid":["task","story"]}
$ADRS
{"title":"short decision title","body":"1-3 sentences: context, decision, why"}
$QUESTIONS
{"title":"short question title","body":"the question itself, can be multiple sentences","recommended":"your recommended answer"}
{"title":"another question title","body":"...","recommended":"..."}

When there is nothing left to ask, emit $QUESTIONS\nNONE followed by a bare $DONE marker on its own line (no questions after it). When there IS more to ask, list this round's questions and do NOT emit $DONE.`;

  const sharedRules = `- Give every question a recommended answer: you bring domain judgement, the user makes the call.
- Stop the moment every real branch has been visited. A short interview (one or two rounds) for a small, well-scoped topic is correct, not a shortcut taken.
- CONTEXT.md is a glossary ONLY: no implementation detail, no spec, no scratch notes.
- An ADR is a paragraph, not a document: context, decision, why. Skip it if any of the three gates (hard to reverse, surprising without context, genuine choice among alternatives) is not met.
- Active domain-modeling: between rounds, re-read the answers you have collected and the terms you have resolved. If a prior answer conflicts with a resolved term or with a later answer, challenge it in your next question — surface the contradiction, do not silently accept it. When the user gives a fuzzy or imprecise answer, propose a precise canonical term in the next round rather than recording the vague one. When a domain boundary is being decided, invent a concrete edge-case scenario that stress-tests the boundary and ask the user to resolve it — do not move to the next independent question until the current concept's edges are sharp.${contextBudget ? `\nThe eventual build runs on a context window of roughly ${Math.floor(contextBudget / 1000)}k tokens — relevant if a question of scope comes up, but it does not change how you interview.` : ""}${depthLine}`;

  if (mode === "fix") {
    return `You are interviewing the user to sharpen a BUG REPORT before it is turned into a fix ticket. The user has reported a defect; your job is to nail down what they uniquely know — REPRODUCTION — not to diagnose the cause. Diagnosing is the planner's job, which it does by reading the code itself after this interview ends.

BUG REPORT: ${topic}

The current known public contracts of the repo (you will read these and the code yourself after the interview; the user is not expected to know them):
${contractsSummary}
${glossaryBlock}

Each round, do BOTH of the following:

1. Resolve vocabulary that has just become precise (a project-specific term for a fault mode, a state, a surface — define what it IS, not what it does). Emit decisions only when a genuinely hard-to-reverse, surprising-without-context trade-off was just made. Most rounds produce zero of either.

2. Ask ONLY about reproduction — the things the user alone knows and the planner cannot derive from reading code:
   - TRIGGER: what exact action or input exposes the bug? (keystroke, command, game state, sequence of steps)
   - SYMPTOM: what does the user observe when the bug fires? (visible behaviour, error text, wrong output)
   - EXPECTED: what did the user expect to happen instead? The gap between SYMPTOM and EXPECTED is the defect.
   - ENVIRONMENT: only if it plausibly matters (browser, OS, model, build config) — skip if irrelevant.
   Do NOT ask about implementation: not where the bug lives in code, not which function is wrong, not which file to edit, not how the system is structured. You read that yourself. Do not ask the user to locate code paths, identify functions, or pinpoint files — those are your homework, not theirs.

${sharedContract}

Rules:
- Ask only questions this round's answers can actually unblock.
- Find facts yourself from what you already have (the topic, the existing glossary, the contracts); never ask the user something you could reason out on your own — and NEVER ask them to locate or describe code.
- If the bug report already states the trigger, symptom, and expected behaviour clearly, ask NOTHING — emit $DONE on round 1. A zero-question interview is correct for a well-written bug report.
${sharedRules}`;
  }

  const planBlock = planText?.trim()
    ? `
THE PLAN UNDER REVIEW (authoritative; the user has seen it or will see it after your answers refine it):
${planText.trim()}

This interview REFINES AN EXISTING PLAN, not a bare idea: the plan above already commits to an approach and scope. Ask only questions whose answers would materially CHANGE that plan — an unresolved fork in scope, an ambiguity that could send the build in the wrong direction, a quality demand the plan treats too vaguely, a mechanism the plan leaves undecided. Do NOT re-ask what the plan already answers, and do NOT turn this into a review of style. A short interview (often zero questions) is the correct outcome for a plan that already decides well.`
    : "";

  return `You are interviewing the user to sharpen a plan before it is turned into build tickets. This is a relentless-but-bounded interview: ask only questions whose prerequisites are already settled (never one that depends on an answer you have not heard yet), work in rounds, and stop the moment nothing further needs asking.

BUILD TOPIC: ${topic}
${planBlock}
The current known public contracts of the repo (only relevant if this is an existing codebase; an index that only grows):
${contractsSummary}
${glossaryBlock}
Known public contracts and the glossary above are DECIDED already — do not re-ask about them.

Each round, do BOTH of the following:

1. Resolve vocabulary and decisions. When a term is now precise (the project's own word for a thing, not a general programming concept) or a genuinely hard-to-reverse, surprising-without-context, real-trade-off decision has just been made, emit it now — do not batch it for later. A term belongs in $TERMS only if it is specific to this project's domain: define what it IS, not what it does. A decision belongs in $ADRS only if it is ALL THREE of: hard to reverse, would surprise a future reader without explanation, and was a genuine choice among real alternatives. Most rounds produce zero of either — that is normal, not a failure.

2. Ask the next batch of questions — the ones answerable right now without guessing at something not yet heard — OR signal the interview is finished.

${sharedContract}

Rules:
- Ask only questions this round's answers can actually unblock — never one whose answer depends on a question not yet asked.
${sharedRules}`;
}

/**
 * Render the accumulated Q&A so the (fresh, stateless) next round's call can
 * see what was already asked and answered — every opencode invocation is a
 * new subprocess with no memory of prior rounds (ADR 0001), so the full
 * exchange history must be re-supplied every round.
 */
export function buildSharpenRoundPrompt(system: string, exchanges: SharpenExchange[]): string {
  if (exchanges.length === 0) {
    return `${system}\n\nThis is round 1. No questions have been asked yet.`;
  }
  const history = exchanges
    .map(
      (e) =>
        `Q: ${e.question.title} — ${e.question.body}\nRecommended: ${e.question.recommended || "(none given)"}\nA: ${e.answer}`,
    )
    .join("\n\n");
  return `${system}\n\nQuestions asked and answered so far:\n${history}\n\nContinue: re-read the answers above and check for conflicts with resolved terms or prior answers — challenge any contradiction in your next question. Resolve any $TERMS/$ADRS the answers above now make clear, then either ask the next round's questions or signal $DONE if nothing remains.`;
}

/**
 * Fold the resolved Q&A into extra context for the ticket-generation prompt
 * — the planner never sees the raw round-by-round marker blocks, just the
 * settled answers. Empty when nothing was asked (sharpening skipped, disabled
 * via `sharpen_max_rounds: 0`, or the very first round already signalled done).
 */
export function renderTranscriptForPlanner(exchanges: SharpenExchange[]): string {
  if (exchanges.length === 0) return "";
  const lines = exchanges.map((e) => `- ${e.question.title}: ${e.answer}`);
  return `Clarified in a planning interview before this plan:\n${lines.join("\n")}`;
}

/** ADR 0042: render the post-plan interview's Q&A as the findings a plan
 * revision consumes. Distinct from `renderTranscriptForPlanner` (which
 * frames answers as pre-plan context): here the answers are user decisions
 * that CHANGE an existing plan, so the question is named alongside the
 * answer. Empty when nothing was asked. */
export function renderPlanInterviewAnswers(exchanges: SharpenExchange[]): string {
  if (exchanges.length === 0) return "";
  const lines = exchanges.map((e) => `- Q: ${e.question.title} — ${e.question.body}\n  A: ${e.answer}`);
  return `The user answered a planning interview about this plan. Treat each answer as a decision the revised plan must honor:\n${lines.join("\n")}`;
}

const CONTEXT_FILE = "CONTEXT.md";

/**
 * Append newly-resolved terms to CONTEXT.md, creating it lazily on the first
 * term (matching domain-modeling's "nothing exists until the first term
 * crystallises" rule). Dedups by term name (case-insensitive): an
 * already-defined term is left untouched rather than duplicated — a later
 * round refining its own understanding of a term it already resolved should
 * not pile up a second entry.
 */
export async function appendContextTerms(cwd: string, terms: TermEntry[]): Promise<void> {
  if (terms.length === 0) return;
  const target = join(cwd, CONTEXT_FILE);
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch {
    /* none yet — seeded below */
  }
  const existingNames = new Set(
    Array.from(current.matchAll(/^\*\*([^*]+)\*\*:/gm)).map((m) => m[1].trim().toLowerCase()),
  );
  const fresh = terms.filter((t) => !existingNames.has(t.term.toLowerCase()));
  if (fresh.length === 0) return;

  const rendered = fresh
    .map((t) => `**${t.term}**: ${t.definition}${t.avoid?.length ? `\n_Avoid_: ${t.avoid.join(", ")}` : ""}`)
    .join("\n\n");

  if (!current.trim()) {
    current = `# Project glossary\n\n_Maintained by \`railhead plan\`'s planning interview — the project's own words, nothing else._\n\n## Language\n\n`;
  }
  const sep = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(target, current + sep + rendered + "\n", "utf8");
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 50) || "decision"
  );
}

/** The next 4-digit ADR number, continuing the sequence in `files` (bare
 * filenames like "0009-visual-final-review.md"). Pure so the numbering rule
 * is directly testable without touching disk. */
export function nextAdrNumber(files: string[]): number {
  const max = files.reduce((m, f) => {
    const n = parseInt(f.slice(0, 4), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return max + 1;
}

/**
 * Write one resolved decision as a new ADR file under docs/adr/, lazily
 * creating the directory on the first one. Numbering continues the existing
 * sequence; the minimal template mirrors this repo's own existing ADRs (and
 * the ported ADR-FORMAT.md rules): a title and 1-3 sentences, nothing more.
 */
export async function writeGrillAdr(cwd: string, adr: AdrEntry): Promise<string> {
  const dir = join(cwd, "docs", "adr");
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir);
  const num = nextAdrNumber(existing);
  const file = `${String(num).padStart(4, "0")}-${slugify(adr.title)}.md`;
  await writeFile(join(dir, file), `# ${adr.title}\n\n${adr.body}\n`, "utf8");
  return file;
}
