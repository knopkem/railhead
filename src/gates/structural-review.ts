import { parseVerdict } from "./reviewer.ts";
import { buildDigestInjection, DIGEST_MARKER } from "../context/digest.ts";
import { renderPreamble, type PhaseMessages } from "../context/preamble.ts";

export interface StructuralVerdict {
  verdict: "pass" | "fail" | "inconclusive";
  findings: string[];
}

/** Parse the structural reviewer's verdict from its transcript — thin adapter
 *  over the one shared verdict parser (issue #89), parameterized by
 *  structural's markers. `$STRUCTURAL_FAIL` + findings = fail,
 *  `$STRUCTURAL_PASS` = pass, everything else = inconclusive; a FAIL with no
 *  findings is inconclusive — the parser's defensive defaults, documented at
 *  `parseVerdict`. */
export function parseStructuralVerdict(text: string): StructuralVerdict {
  return parseVerdict(text, { failMarker: "$STRUCTURAL_FAIL", passMarker: "$STRUCTURAL_PASS" });
}

export function buildStructuralReviewPrompt(options: {
  originalPrompt: string;
  architectureDoc?: string | null;
  contractsSummary?: string;
  verifyCommands: string[];
  group: string;
  completedGroups: string[];
  priorFindings: string[];
  learnings?: string | null;
  digest?: string | null;
}): PhaseMessages {
  const {
    originalPrompt,
    architectureDoc,
    contractsSummary,
    verifyCommands,
    group,
    completedGroups,
    priorFindings,
    learnings,
    digest,
  } = options;

  const archBlock = architectureDoc?.trim()
    ? `\n\nThe Architecture intent section above is the structural plan this review judges against.`
    : "";
  const contractsBlock = contractsSummary?.trim()
    ? `\n\nCONTRACTS INDEX (what the system exposes right now — the declared structure):\n${contractsSummary.trim()}\n`
    : "";
  const priorBlock = priorFindings.length > 0
    ? `\n\nPRIOR STRUCTURAL FINDINGS (from earlier checkpoints — confirm these were addressed):\n${priorFindings.map((f) => `- ${f}`).join("\n")}\n`
    : "";
  const completedBlock = completedGroups.length > 0
    ? `\n\nCOMPLETED CHECKPOINTS: ${completedGroups.join(", ")}\n`
    : "";
  const verifyBlock = verifyCommands.length > 0
    ? verifyCommands.join("\n")
    : "(no verify commands configured)";
  const learningsBlock = learnings?.trim()
    ? `\n\nKNOWN TOOLING FACTS (from prior phases — unverified model claims, test before trusting):\n${learnings.trim()}\n`
    : "";
  const digestBlock = buildDigestInjection(digest);

  const roleBlock = `You are the Structural Reviewer at a checkpoint in an unattended build (#49). You have file-read access to the whole project. Your job is to read the accumulated source as a corpus and flag architectural drift that no per-ticket reviewer can see.

This oversight seat is the intended consumer of the strong-model tier (ADR 0015) — structural review, not the implementer, is where a stronger model catches cross-cutting drift a local model accumulates across tickets.

ORIGINAL GOAL/PROMPT:
${originalPrompt}
${archBlock}${contractsBlock}${completedBlock}${priorBlock}

VERIFY COMMANDS (the build/test gate — do NOT report compile failures here; verify owns that. Do NOT report behavior gaps; goal review owns those. You flag STRUCTURAL DRIFT only.):
${verifyBlock}${learningsBlock}${digestBlock}

## Evaluation discipline

This is the "${group}" checkpoint. Read the accumulated source of the project as a corpus — use your file-read access to inspect the modules, their interfaces, and how they connect.

Flag ONLY structural drift — the kind of problem that accumulates across tickets and is invisible to any single ticket reviewer:

- **Duplicated abstractions**: the same concept implemented in two places that should share a single module.
- **Divergent conventions**: naming, error handling, or module structure that drifted from what the architecture intended.
- **Contracts that grew inconsistent**: an interface that changed shape in one ticket but not its callers.
- **Dead code**: remnants of a superseded attempt that no ticket cleaned up.
- **Module shape diverges from architecture.md**: the planner intended a seam here; the source built it somewhere else.

## What NOT to flag

- Compile failures, type errors, or broken builds — verify owns that gate.
- Behavior gaps or missing features — goal review owns those.
- Per-ticket code quality — the per-ticket reviewer owns that.

## Output format

After your analysis, emit your verdict:

$STRUCTURAL_PASS
or
$STRUCTURAL_FAIL
[BLOCKER] <structural smell that must be fixed before proceeding — name the file(s) and the drift>
[MAJOR] <structural concern that should be fixed soon but does not block>
$END

## Digest update (architectural state summary)
If you observed a key architectural change, structural milestone, or convention drift at this checkpoint, emit it:

${DIGEST_MARKER} <one terse line: "Module X now uses pattern Y" or "Convention Z diverging from architecture.md in files A, B">

Omit if nothing structurally significant changed.`;

  return {
    preamble: renderPreamble({ architecture: architectureDoc ?? null }),
    task: roleBlock,
  };
}
