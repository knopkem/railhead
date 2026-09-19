/**
 * The declared per-project interaction interface (issue #97): "how this app is
 * operated by a user" is a property of the DELIVERABLE, not of the language it
 * is written in. Recorded explicitly at plan time ($INTERFACE block) and
 * overridable in railhead.json's top-level `interface` field, it parameterizes
 * two things that must never disagree:
 *
 *   1. prompt injection — `buildInteractionGuidance` (which interaction
 *      discipline a whole-app reviewer is told to follow), and
 *   2. the evidence gate — `requiresRealInputEvidence` / `hasRealInteraction
 *      Evidence` in evidence.ts (what counts as real user-level operation in a
 *      PASS's phase ledger).
 *
 * The taxonomy exists to parameterize the evidence INSTANCE first ("what counts
 * as real input"), prompt guidance second. Each value maps to a distinct
 * instance row: `browser-ui` → a real-input tool call in the phase ledger
 * (enforced); `canvas` → synthetic dispatch IS the correct input class (exempt
 * by construction); `none` → exempt by construction (no surface to operate).
 * `native` is deliberately deferred — nothing in the railhead's tool reach
 * distinguishes "drove a native window" from any other bash command — and
 * `terminal`'s driven-stdin instance is similarly not ledger-visible yet (no
 * PTY/stdin event), so its gate row is deferred too: both would carry a value
 * with prompt guidance and no gate behind it, the prompt-only pollution #97
 * argues against, one level down. Adding a value is a row of data here;
 * railhead.json values that match nothing throw rather than silently coerce, so
 * the addition is deliberate.
 */

export type ProjectInterface = "browser-ui" | "canvas" | "terminal" | "none";

export const PROJECT_INTERFACES: readonly ProjectInterface[] = [
  "browser-ui",
  "canvas",
  "terminal",
  "none",
];

const INTERFACE_LIST = PROJECT_INTERFACES.map((v) => `"${v}"`).join(" | ");

/** Parse a railhead.json `interface` value. Null when absent/empty (the project
 * is undeclared — legacy behavior: no injected guidance, no widened gate).
 * Throws on a present value that matches no interface: an unknown token is a
 * deliberate new row, never a silent coercion to today's behavior. */
export function parseProjectInterface(value: unknown): ProjectInterface | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`railhead.json "interface" must be one of ${INTERFACE_LIST} — got a non-string value`);
  }
  const token = value.trim().toLowerCase();
  if (token === "") return null;
  if (!(PROJECT_INTERFACES as readonly string[]).includes(token)) {
    throw new Error(`railhead.json "interface": unknown value "${value}" — expected one of ${INTERFACE_LIST} (issue #97; a new value is a deliberate addition, not a typo to coerce)`);
  }
  return token as ProjectInterface;
}

/**
 * The interaction-discipline block a whole-app reviewer (visual/goal) is told
 * when the project's interface is declared. Returns "" for `terminal`/`none` —
 * zero pollution for the seats where a universal paragraph is dead weight: a
 * CLI reviewer figures out how to drive a TUI on its own, and a library has no
 * user-facing surface to operate. `browser-ui` carries the #97 real-input
 * discipline; `canvas` carries the pointer-lock/evaluate defaults (the former
 * `gameCanvasDefaults` prose, unchanged).
 */
export function buildInteractionGuidance(iface: ProjectInterface): string {
  switch (iface) {
    case "browser-ui":
      return `This is a browser DOM app the user operates by pointing and typing (buttons, fields, menus). Prove a control is operable by operating it FOR REAL: use ${"`"}chrome-devtools_click${"`"}, ${"`"}chrome-devtools_fill${"`"}, ${"`"}chrome-devtools_type_text${"`"}, or ${"`"}chrome-devtools_press_key${"`"} on the actual control, wait for the state to settle, then read the result (screenshot or a11y snapshot). Use ${"`"}evaluate_script${"`"} to READ state or to drive a control with no real-input equivalent — never to prove a clickable control works. Synthetic dispatch (${"`"}el.click()${"`"}, ${"`"}dispatchEvent${"`"}) delivers the event straight to the handler and bypasses browser hit-testing, so a control that is dead to a real cursor looks alive to ${"`"}evaluate_script${"`"}. If a criterion names a control, operate that control with a real input tool before judging it.`;
    case "canvas":
      return `This is a canvas-based game or non-standard UI. The ${"`"}chrome-devtools_*${"`"} tools (click, fill, press_key) target DOM elements, but canvas apps handle input via ${"`"}window.addEventListener('keydown')${"`"}, ${"`"}canvas.requestPointerLock()${"`"}, or ${"`"}requestAnimationFrame${"'"}. There are no DOM buttons to click.\nTo interact with a canvas app, use ${"`"}evaluate_script${"'"}. To send keyboard input: dispatch ${"`"}KeyboardEvent('keydown', {key: 'w'})${"'"}. To simulate mouse-look: override ${"`"}document.pointerLockElement${"'"}. For pointer-lock games, also dispatch ${"`"}pointerlockchange${"'"}. For deterministic testing, stub ${"`"}Math.random${"'"}.`;
    case "terminal":
    case "none":
      return "";
  }
}

/** Whether the whole-app evidence gate requires real user-level operation for
 * this interface. Today only `browser-ui` has a ledger-visible real-input
 * instance (a real chrome-devtools input call; synthetic `evaluate_script`
 * dispatch never counts — the #97 spark). `canvas` and `none` are exempt by
 * construction (synthetic dispatch IS the canvas input class; a library has
 * nothing to operate). `terminal`'s real-input instance — driving the
 * process's stdin — is not yet distinguishable from any bash command in the
 * phase ledger (no PTY/stdin event), so its gate row is DEFERRED, the same
 * argument that defers `native`: a value whose instance isn't ledger-visible
 * would carry a gate with no teeth, one layer down from the prompt-only
 * pollution #97 argues against. Null/undeclared is never enforced — that is
 * today's behavior. */
export function requiresRealInputEvidence(iface: ProjectInterface | null | undefined): boolean {
  return iface === "browser-ui";
}
