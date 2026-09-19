import { estimateTokens } from "./diff-filter.ts";

/**
 * Issue #82: token cost of the conversation content the railhead KNOWS will be
 * re-sent to the model server in the next request, read from one archived
 * `--format json` event line.
 *
 * The railhead's token-budget guards used to key on `peakTokens` — the input
 * tokens a step_finish reports AFTER a request completed. During a long step
 * that thrashes toward an OOM the request never completes, so the number the
 * guards saw was the previous (smaller) request's, stale by however much the
 * current step has already streamed into the conversation (full-file `cat`
 * tool outputs being the dominant term). The kill and the operator's
 * heartbeat both underread the request actually being assembled.
 *
 * This meter counts only what the railhead observes streaming past it, not
 * anything server-side, so it is server-agnostic by construction:
 *
 *   per-line cost = assistant text/reasoning tokens (text events)
 *                 + tool-call tokens                (tool_use input)
 *                 + tool-result tokens              (tool_use output)
 *
 * Image results are the one deliberate undercount-to-fixed-cost: a screenshot
 * tool result is re-sent to the model as an image content part (~constant
 * token cost), not as its base64 text, so estimating the raw bytes would
 * inflate the meter by orders of magnitude and false-kill visual phases.
 */
export function streamedTokenCost(line: string): number {
  if (!line.trim()) return 0;
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return 0;
  }
  if (typeof ev !== "object" || ev === null) return 0;
  const part = ev.part;
  if (!isObject(part)) return 0;
  if (ev.type === "text" || ev.type === "reasoning") {
    if (typeof part.text === "string") return estimateTokens(part.text);
    return 0;
  }
  if (ev.type !== "tool_use") return 0;
  if (part.type !== "tool") return 0;
  const state = part.state;
  if (!isObject(state)) return 0;
  // Only TERMINAL tool events are counted: the same call can surface as a
  // `running` part and then a `completed`/`error` part, and its input/output
  // appear on both — counting every event would double-charge one call.
  if (state.status !== "completed" && state.status !== "error") return 0;
  let cost = 0;
  if (state.input !== undefined) cost += estimateTokens(serialize(state.input));
  const output = state.output ?? state.result ?? (typeof state.error === "string" ? state.error : undefined);
  if (output !== undefined) cost += toolOutputCost(output);
  return cost;
}

/** A fixed token allowance per image result — see the module doc. The exact
 * cost is server-side (dimension-dependent); an order-of-magnitude constant
 * keeps the meter from counting base64 bytes as prompt text. */
const IMAGE_RESULT_TOKENS = 1000;

function toolOutputCost(output: unknown): number {
  const text = serialize(output);
  if (!text) return 0;
  const imageCount = imageCountOf(text);
  if (imageCount > 0) return imageCount * IMAGE_RESULT_TOKENS;
  return estimateTokens(text);
}

function imageCountOf(text: string): number {
  const count = [...text.matchAll(/"type"\s*:\s*"image"/g)].length;
  return count > 0 ? count : /^data:image\//.test(text) ? 1 : 0;
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null;
}
