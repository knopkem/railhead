/**
 * The two-message shape every phase sends (ADR 0020 amendment, issue #132).
 *
 * The server's prefix cache restores at the last complete shared user message,
 * so the stable project context must be its own message and volatile material
 * must live after it. `renderPreamble` is the canonical message 1: pure, byte-
 * stable for unchanged inputs, and seat-neutral (same inputs → same bytes,
 * whichever seat asks). `renderTask` assembles message 2 from the volatile
 * sections a phase contributes. `joinPhaseMessages` is the transitional
 * single-message wire form until the base-session/`--fork` protocol (#133)
 * sends the two parts as the separate messages this module names.
 */

/** The two user messages of a phase. */
export interface PhaseMessages {
  /** Message 1: the canonical preamble — stable project context only. */
  preamble: string;
  /** Message 2: the volatile task material (role, ticket, contracts, diff, findings, …). */
  task: string;
}

/**
 * The stable inputs the canonical preamble may carry. Everything here is
 * per-run material (mission, repo guidance, planner docs) — never ticket,
 * diff, or finding text, which is what makes the render byte-stable across
 * seats and phases for unchanged inputs.
 */
export interface PreambleInputs {
  mission?: string | null;
  agents?: string | null;
  context?: string | null;
  design?: string | null;
  architecture?: string | null;
  coherence?: string | null;
}

/** The canonical section order. Fixed so two renders of the same inputs are
 *  byte-identical, and so a new seat cannot reorder shared content. */
const PREAMBLE_SECTIONS: { key: keyof PreambleInputs; render: (value: string) => string }[] = [
  { key: "mission", render: (v) => `MISSION: ${v}` },
  { key: "agents", render: (v) => `## Project agent guidance (AGENTS.md)\n\n${v}` },
  { key: "context", render: (v) => `## Domain glossary (CONTEXT.md)\n\n${v}` },
  { key: "design", render: (v) => `## Design intent (docs/design.md)\n\n${v}` },
  { key: "architecture", render: (v) => `## Architecture intent (docs/architecture.md)\n\n${v}` },
  { key: "coherence", render: (v) => `## Coherence contract (docs/coherence.md)\n\n${v}` },
];

/** Render the canonical preamble (message 1). Pure: no I/O, no clock, no
 *  counter, no seat input — the same stable inputs always produce the same
 *  bytes. Absent sections are dropped, so a phase contributes exactly the
 *  stable material it holds. */
export function renderPreamble(inputs: PreambleInputs): string {
  return renderTask(PREAMBLE_SECTIONS.map(({ key, render }) => {
    const value = inputs[key];
    return value ? render(value) : null;
  }));
}

/** Render message 2 from ordered volatile sections. Pure and order-preserving;
 *  empty sections drop so a builder cannot emit a dangling heading. */
export function renderTask(sections: readonly (string | null | undefined)[]): string {
  return sections.filter((s): s is string => typeof s === "string" && s.length > 0).join("\n\n");
}

/** The transitional single-message form of a phase prompt: preamble first,
 *  task after, exactly as the current `opencode run` wire sends them. The
 *  base-session/`--fork` protocol (#133) replaces this join with two real
 *  messages; until then every phase still sends one message. */
export function joinPhaseMessages(messages: PhaseMessages): string {
  return renderTask([messages.preamble, messages.task]);
}
