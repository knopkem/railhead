/**
 * Tokenise a blob of model output into standalone JSON objects, tolerating
 * prose, truncation, and mid-array corruption: a malformed object is skipped
 * without aborting the scan of the rest. Shared by the lossy, best-effort
 * parsers (plan tickets, contracts blocks) that face raw LLM text.
 */
export function scanJsonObjects(text: string): Record<string, unknown>[] {
  const objs: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = open;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      // Unbalanced braces: either truncation at the tail, or a malformed object
      // whose bad quoting desynced string tracking so depth never returns to 0.
      // Resume at the NEXT `{` rather than aborting the whole scan — a single
      // missing quote must not discard every object after it. This was the
      // spriteforge plan failure: one unquoted array element dropped 9 of 12
      // tickets, and the truncated plan silently built a placeholder.
      i = open + 1;
      continue;
    }
    try {
      objs.push(JSON.parse(text.slice(open, j + 1)) as Record<string, unknown>);
    } catch {
      /* skip this malformed object and keep scanning */
    }
    i = j + 1;
  }
  return objs;
}