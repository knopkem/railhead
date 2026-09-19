# Research: Lazy Ladder for Code Generation + Volatile Field Relocation for Prompt Caching

## 1. Lazy Ladder for Code Generation

### 1.1 What ponytail actually implements

The ponytail ruleset lives in its `AGENTS.md` (the canonical source, auto-loaded by every supported agent). The full text is ~450 words. The core mechanism is a 7-rung ladder the model climbs **after** understanding the problem, stopping at the first rung that holds:

```
1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse, don't rewrite.
3. Does the standard library already do this?
4. Does a native platform feature cover it?
5. Does an already-installed dependency solve it?
6. Can this be one line?
7. Only then: write the minimum code that works.
```

**Key design decisions in the ruleset text:**

- **"Lazy about the solution, never about reading"** — the ladder runs *after* the agent reads the code and traces the real flow. This is the guard against the model skipping investigation and jumping to "one-liner."
- **Explicit safety carve-out**: "Not lazy about: understanding the problem, input validation at trust boundaries, error handling that prevents data loss, security, accessibility."
- **`ponytail:` comment marker** for deliberate simplifications that cut a corner with a known ceiling (e.g. global lock, O(n²) scan). This makes technical debt self-documenting.
- **Test discipline**: "Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks." One test, no frameworks.
- **Bug fix discipline**: "root cause, not symptom — grep every caller of the function you touch and fix the shared function once."
- **No abstractions that weren't explicitly requested. No new dependency if avoidable. Deletion over addition.**

The ruleset also ships as opencode-compatible skills in `skills/ponytail/` with sub-skills: `ponytail-review` (review diff for over-engineering), `ponytail-audit` (whole-repo audit), `ponytail-debt` (harvest deferred `ponytail:` markers into a ledger), `ponytail-gain` (benchmark scoreboard), `ponytail-help`.

### 1.2 Other projects with similar necessity checks

1. **caveman** (github.com/JuliusBrussee/caveman) — terse-prose skill. Shrinks what the agent *says*, not what it *builds*. Complementary, not overlapping. ponytail's benchmark included it as a control.

2. **lean-ctx** (yvgude/lean-ctx) — ships its own compact version of the ladder in `LEAN-CTX.md`:
   ```
   SOLUTION EFFICIENCY: stop at first level that applies:
   skip (YAGNI) → reuse codebase → stdlib → native platform → installed dep → one-line → minimum code.
   Never skip: validation, security, error handling.
   ```
   This is injected as part of the always-on context rules block (the `<!-- lean-ctx-solution -->` block in `LEAN-CTX.md`).

3. **"YAGNI + one-liners" prompt** — ponytail's benchmark tested Colin Eberhardt's suggestion (issue #126): *"Follow YAGNI principles, and prefer one-liner solutions."* appended to system prompt. Result: it cut code but was erratic (brilliant on color picker, near-baseline on date picker) and was the *only* arm that dropped a safety guard (95% safe vs 100%).

### 1.3 Measurable impact

From ponytail's agentic benchmark (2026-06-18, full writeup in `benchmarks/results/2026-06-18-agentic.md`):

**Methodology**: Real headless Claude Code sessions (v2.1.177, `claude -p`) editing tiangolo's full-stack-fastapi-template @ cd83fc1. 12 feature tasks + 6 safety tasks. n=4 per (task, arm). Haiku 4.5. LOC = `git diff` added lines.

| Arm | LOC | Tokens | Cost | Time | Safe |
|-----|-----|--------|------|------|------|
| **ponytail** | **-54%** | **-22%** | **-20%** | **-27%** | **100%** |
| caveman (terse-prose control) | -20% | +7% | +3% | +2% | 100% |
| "YAGNI + one-liners" prompt | -33% | -14% | -21% | -30% | 95% |

**Per-task variance**: The -54% mean runs from ~0% (irreducible backend CRUD: search items 44→44, duplicate item 24→23) to -94% (date picker: 404→23, because `<input type="date">` replaces a custom component).

**The safety result**: On 6 surgical tasks (write one function, then execute against adversarial input), the `yagni-oneliner` arm wrote the fewest lines on `safe-path` (6 lines) but went unsafe 1/4 times — a `../../` path traversal escaped. ponytail wrote ~9.5 lines and was safe 4/4. The ~3 extra lines *were the path-traversal check*.

**Key finding**: A bare "write less" prompt cuts code but is inconsistent and drops safety guards. The structured ladder is consistent and safe because it says "never simplify away input validation at trust boundaries" as an explicit rule.

### 1.4 Exact words that work — injection text for the harness

The ponytail ruleset text (from `AGENTS.md`) is ~450 words and designed to be injected as a system/always-on context block. For the harness, the relevant injection point is the Implementer prompt in `src/context/prompt.ts:150`. The minimum effective subset:

```
## Lazy code discipline
Before writing any code, stop at the first rung that holds:
1. Does this need to exist? (YAGNI — skip if not)
2. Already in this codebase? (reuse it, don't rewrite)
3. Does the stdlib do it? (use it)
4. Native platform feature? (use it)
5. Installed dependency? (use it)
6. One line? (one line)
7. Only then: write the minimum that works.

The ladder runs AFTER you understand the problem: read the code the ticket touches, trace the real flow, then climb. Lazy about the solution, never about reading.

Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, accessibility. Non-trivial logic leaves ONE runnable check behind (smallest thing that fails if the logic breaks; no frameworks needed).

No abstractions that weren't requested. No new dependency if avoidable. Deletion over addition. Shortest working diff wins, but only once you understand the problem.
```

**Important**: ponytail's benchmark showed that simply appending "Follow YAGNI principles, and prefer one-liner solutions" is **not sufficient** — it's erratic and drops safety. The structured ladder with the explicit safety carve-out is what makes it consistent and safe.

### 1.5 Failure modes

1. **Over-application on irreducible code**: On backend CRUD endpoints, ponytail trimmed ~0-5%. The ladder correctly identifies there's nothing to cut. Not a failure — but worth noting the impact is near-zero on already-minimal code.

2. **Terse reasoning models can go backwards**: ponytail's README notes: "a terse reasoning model that spends thinking tokens deliberating the rungs can go the other way (on GPT-5.5 it does)." The ladder adds deliberation overhead; on models that spend thinking tokens, this can *increase* cost. This is directly relevant for small-context local models that may not have a separate "thinking" budget — the deliberation happens in-band.

3. **The `yagni-oneliner` failure mode** (the prompt-without-structure version): The model writes the fewest lines and drops the guard. On `safe-path`, it wrote 6 lines (correct happy path, unsafe on `../../`). This is the failure mode the explicit safety carve-out prevents. The harness prompt already has "the acceptance criteria are the contract" — but that doesn't explicitly protect security/validation guards.

4. **`ponytail:` marker accumulation**: If the model defers simplifications with `ponytail:` comments, these accumulate as tech debt. ponytail ships a `ponytail-debt` command to harvest them, but in an unattended harness there's no such review. Deferred debt could pile up across tickets silently.

5. **One-test discipline vs... the harness's test phase**: The harness already has a separate test phase (issue #5, ADR 0014). ponytail's "leave ONE runnable check behind" could conflict with or duplicate the harness's test author phase. The injection should either omit the test instruction or defer to the harness's test phase.

---

## 2. Volatile Field Relocation for Prompt Caching

### 2.1 How prompt caching works (vLLM)

From vLLM's prefix caching design doc (`docs/design/prefix_caching/`):

**Mechanism**: Hash-based automatic prefix caching. Each KV-cache block (typically 16 tokens) is hashed by:
- Parent block hash (chained)
- Block token IDs
- Extra hashes (LoRA IDs, multimodal input hashes, cache salt)

**Key properties**:
- **Automatic**: enabled by default in vLLM v1. No client-side configuration needed. The server hashes incoming prompt tokens and reuses cached KV blocks for matching prefixes.
- **Prefix-matching only**: Cache hits happen at block boundaries from the start of the prompt. If token N differs, all blocks from N onward are cache misses.
- **Only full blocks cached**: Partial blocks are not cached. Block size is typically 16 tokens.
- **LRU eviction**: When KV cache is full, least-recently-used blocks are evicted.
- **Cache isolation**: Optional `cache_salt` field in the request prevents cross-user cache sharing.

**What breaks the cache**: Any token change in the prefix. If the first 1000 tokens of a prompt are byte-identical to a previous request, those 1000 tokens (62 blocks) are cache hits. If token 501 changes (e.g. a date string), only the first 500 tokens (31 blocks) hit — the rest miss.

### 2.2 What makes a prompt cacheable

1. **Stable prefix**: The beginning of the prompt must be byte-for-byte identical across requests. System prompt, tool definitions, static instructions — these are cacheable.
2. **Volatile fields at the END**: Anything that changes per-request (dates, UUIDs, ticket IDs, user input) must come AFTER the stable prefix, not embedded in it.
3. **Block alignment**: The cache boundary is at block size (16 tokens). A volatile field at position 503 breaks blocks from 504 onward; a volatile field at position 512 breaks blocks from 513 onward. The further into the prompt, the more cache survives.

### 2.3 Where the harness injects volatile fields

From `src/context/prompt.ts`, the Implementer prompt structure is:

```
Line 150: "You are the Implementer for one ticket of an unattended build..."
Line 152: "The contracts you list under 'expected new contracts'..."
Line 154: TICKET FILE: ${ticketFile}              ← VOLATILE (changes per ticket)
Line 156-157: TICKET: ${ticketBody}               ← VOLATILE (changes per ticket)
Line 159-160: ACCEPTANCE CRITERIA: ${criteria}    ← VOLATILE (changes per ticket)
Line 96-99: ${contractBlock}                      ← VOLATILE (changes per ticket)
Line 105-107: ${learningsBlock}                   ← SEMI-STABLE (changes per run, not per ticket)
Line 164: "This is a small-context run..."        ← STABLE
Line 164: ${contextBudget} budget line            ← STABLE (same for all tickets)
Line 164: ${feedbackBlock}                        ← VOLATILE (only on retries)
Line 164: ${handoffBlock}                         ← VOLATILE (only on retries)
Line 164: ${fixModeBlock}                         ← STABLE (same for all fix tickets)
Line 167-170: Tool-output discipline             ← STABLE
Line 172-174: File editing                        ← STABLE
Line 175-182: Verify block + visual self-check    ← STABLE (verify commands are per-project)
Line 183-213: Handoff/learnings push instructions ← STABLE
Line 215-218: Terse output                        ← STABLE
Line 219-220: ${agents} (AGENTS.md)               ← STABLE (per-project, not per-ticket)
Line 220: ${context} (CONTEXT.md)                 ← STABLE (per-project, not per-ticket)
```

**Classification of injected fields:**

| Field | Stability | Position in prompt | Cache impact |
|-------|-----------|-------------------|--------------|
| `ticketFile` | Volatile (per-ticket) | EARLY (line 154) | Breaks cache from here |
| `ticketBody` | Volatile (per-ticket) | EARLY (line 157) | Breaks cache |
| `criteria` | Volatile (per-ticket) | EARLY (line 160) | Breaks cache |
| `contracts` | Volatile (per-ticket) | MID (line 96) | Breaks cache from here |
| `learnings` | Semi-stable (per-run) | MID (line 105) | Changes when learnings accumulate |
| `mission` | Stable (per-run) | EARLY (line 150) | Same for all tickets in a run |
| `contextBudget` | Stable (per-config) | MID (line 164) | Same for all tickets |
| `verify` commands | Stable (per-project) | LATE (line 175) | Same for all tickets |
| `fixMode` | Stable (per-config) | MID (line 164) | Same for all fix tickets |
| AGENTS.md | Stable (per-project) | END (line 219) | Same for all tickets |
| CONTEXT.md | Stable (per-project) | END (line 220) | Same for all tickets |
| `prevFeedback` | Volatile (per-retry) | MID (line 164) | Only on retries |
| `priorDiff` | Volatile (per-retry) | MID (line 164) | Only on retries |
| `prevHandoff` | Volatile (per-retry) | MID (line 164) | Only on retries |

**The core problem**: The volatile per-ticket fields (`ticketFile`, `ticketBody`, `criteria`) are placed at lines 154-160 — very early in the prompt. Everything after them (the stable instructions about tool discipline, file editing, verify, terse output, AGENTS.md, CONTEXT.md) cannot be cached because the prefix changed.

### 2.4 Does vLLM / MTPLX support prompt caching?

**vLLM**: Yes, automatic prefix caching is enabled by default in vLLM v1. It's a hash-based KV-cache reuse mechanism that works at the block level (16 tokens). No client-side configuration needed — it's purely server-side. The OpenAI-compatible API server checks incoming prompts against cached blocks automatically.

**Key vLLM details**:
- Enabled by default (no `--enable-prefix-caching` flag needed in v1; it was opt-in in v0)
- Supports `cache_salt` for isolation
- Hash algorithm: `sha256` (default, v0.11+), or `sha256_cbor` for cross-environment reproducibility
- LRU eviction when KV cache is full

**MTPLX server**: MTPLX is built on vLLM (or an OpenAI-compatible server). If it's running vLLM v1, prefix caching is on by default. If it's an older vLLM or a different server, it may need `--enable-prefix-caching` at launch.

**lean-ctx's relevance**: lean-ctx's proxy explicitly claims "prompt-cache-safe" compression and "relocate volatile fields (dates, UUIDs, commit SHAs) out of the cacheable prefix so a stable system prompt finally caches." This confirms the mechanism is real and that volatile fields in the prefix are a known cache-busting problem.

### 2.5 The actual KV-cache reuse mechanism

The mechanism is **automatic** in vLLM v1:

1. vLLM tokenizes the incoming prompt
2. For each block of 16 tokens, it computes `hash(parent_hash, block_tokens, extra_hashes)`
3. It looks up this hash in the cache
4. If found, the KV cache for that block is reused — no recomputation needed
5. If not found, the block is computed and cached

**No configuration needed on the client side.** The harness doesn't need to send special headers or flags. It just needs to structure its prompts so that the stable parts come first and the volatile parts come last.

**The cost saving**: Each cache hit avoids the prefill computation for those tokens. On a 64k token budget where the stable prefix is ~2-4k tokens, proper ordering saves 2-4k tokens of prefill computation per request. For a run of 20 tickets, that's 40-80k tokens of avoided computation. The latency saving is proportional — prefill is the expensive phase.

### 2.6 Concrete fix for the harness

**Current order** (volatile early, stable late):
```
[volatile: ticketFile, ticketBody, criteria] → [semi-stable: contracts, learnings] → [stable: instructions, AGENTS.md, CONTEXT.md]
```

**Proposed order** (stable first, volatile last):
```
[stable: system instructions, tool discipline, file editing, verify, terse output, AGENTS.md, CONTEXT.md, learnings] → [semi-stable: contracts] → [volatile: ticketFile, ticketBody, criteria, prevFeedback, priorDiff, prevHandoff]
```

This means restructuring `buildImplementerPrompt` in `src/context/prompt.ts:22` so that:
1. The stable instruction blocks (tool discipline, file editing, verify, terse output, handoff/learnings push instructions) come FIRST
2. AGENTS.md and CONTEXT.md come NEXT (they're per-project, stable across all tickets in a run)
3. The learnings block comes after AGENTS.md/CONTEXT.md (semi-stable — changes when learnings accumulate, but stable across consecutive tickets within a run phase)
4. The contract block comes after learnings (semi-volatile — changes per ticket)
5. The ticket body, criteria, and ticket file path come LAST (most volatile)
6. Retry-only fields (prevFeedback, priorDiff, prevHandoff) come at the very end (only present on retries, don't pollute the first-attempt cache prefix)

**Important caveat about opencode's prompt assembly**: The harness passes a prompt string to `opencode run`. But opencode itself assembles the final API request, potentially adding its own system prompt, tool definitions, and conversation structure *before* the harness's prompt. The harness's prompt may not be the absolute beginning of what vLLM sees. To verify the cache is actually hitting:
- Check vLLM logs for cache hit rates
- Use vLLM's `--metrics` endpoint to monitor `vllm:prompt_cache_hit_rate`
- The stable prefix the harness controls is whatever opencode puts first + the harness's stable prompt prefix

**What lean-ctx does differently**: lean-ctx's proxy sits between the agent and the model provider, and can rewrite the request to relocate volatile fields. The harness has a simpler opportunity: it controls the prompt text directly and can reorder it at the source. No proxy needed.

### 2.7 Limitations and caveats

1. **opencode's own prompt assembly**: The harness doesn't control the full API request. opencode adds its own system prompt, tool definitions, and conversation structure. The volatile relocation only helps with the portion the harness controls.

2. **Fresh process per phase**: The harness spawns a fresh opencode process per phase (ADR 0006). This means there's no conversation history to cache — each request is a standalone prompt. Prefix caching helps when the *same stable prefix* appears across multiple requests, which it does across tickets in a run (AGENTS.md, CONTEXT.md, instructions are the same for every implement step).

3. **Block alignment**: The stable prefix needs to be a multiple of 16 tokens for maximum cache efficiency. Minor (the cache still hits on the aligned portion), but worth noting.

4. **Learnings growth**: The learnings block grows over a run (new facts are added, old ones may be retracted). Each change to the learnings block shifts the cache boundary. Solution: put learnings *after* the truly stable blocks (AGENTS.md, CONTEXT.md, instructions) so that even if learnings change, the larger stable prefix still caches.

5. **KV cache size**: On a 64k token model, the KV cache may be small. If the server is under memory pressure, cached blocks get evicted (LRU). A long run of 20+ tickets may not all fit in cache. The more stable the prefix, the more likely it stays cached (it's frequently accessed, so LRU keeps it).

---

## Summary for GitHub issues

### Issue: Inject lazy ladder discipline into Implementer prompt

**What**: Add the ponytail-style lazy ladder (~150 words) to the Implementer prompt in `src/context/prompt.ts`. Place it after the "Fresh context, small model" block, before "Tool-output discipline."

**Why**: ponytail's agentic benchmark shows -54% LOC, -22% tokens, -20% cost, -27% time, with 100% safety (no dropped guards). The structured ladder is critical — a bare "write less" prompt is erratic and drops safety. On a 64k token budget, ~54% less code directly extends the context window's useful life.

**How**: Inject the ladder text from section 1.4 above. Omit the "leave ONE runnable check" instruction (the harness has its own test phase). The safety carve-out ("never simplify away input validation at trust boundaries") is load-bearing — it's what prevents the `yagni-oneliner` failure mode.

**Risk**: Terse reasoning models may spend in-band tokens deliberating the rungs. Monitor for increased token usage on models without a separate thinking budget.

**Measurement**: Compare LOC, tokens, cost, and time across a run with and without the ladder. The harness already records `duration_ms` and `peakTokens` per ticket.

### Issue: Reorder prompt for prefix cache stability

**What**: Restructure `buildImplementerPrompt` in `src/context/prompt.ts` so stable content comes first and volatile content comes last.

**Why**: vLLM's automatic prefix caching is enabled by default and works on prefix matching. Currently, volatile per-ticket fields (ticketFile, ticketBody, criteria) are at lines 154-160, very early in the prompt. Everything after them — the stable instructions, AGENTS.md, CONTEXT.md — cannot be cached because the prefix broke.

**How**: Reorder to: [stable instructions] → [AGENTS.md] → [CONTEXT.md] → [learnings] → [contracts] → [ticketFile, ticketBody, criteria] → [retry-only fields]. See section 2.6.

**Risk**: opencode's own prompt assembly may limit how much of the prefix the harness actually controls. Verify with vLLM's `vllm:prompt_cache_hit_rate` metric.

**Measurement**: Monitor cache hit rate before and after reordering. The stable prefix is ~2-4k tokens; at 16 tokens/block that's ~125-250 blocks that could hit cache.
