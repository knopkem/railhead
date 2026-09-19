# Research: techniques for small-local-LLM agent harnesses

Researched 2026-08-26 against primary sources (official docs, arXiv, source code).
For each of seven questions: what was found, with citations; honest about confidence.

Hardware target referenced throughout: ~27B Q4 dense model, 64k working context
budget, 16GB-VRAM PC (per ADR 0014). Findings general to small-local-LLM harnesses
unless noted.

---

## 1. Context summarization between phases

**High-signal findings.** Three distinct, production-grade techniques exist.

### a) Anthropic compaction (server-side, beta)

Anthropic ships a server-side summarization strategy called **compaction** for
long-running conversations. When input tokens cross a configurable trigger
threshold (default 150k, min 50k), the model summarizes the conversation so far
into a `compaction` block; on subsequent requests the API *automatically drops
all content blocks prior to the compaction block*, continuing from the summary.
A custom `instructions` parameter can fully replace the default summarization
prompt (e.g. "preserve code snippets, variable names, technical decisions").

- Docs: https://platform.claude.com/docs/en/build-with-claude/compaction
- Beta header: `compact-2026-01-12`. Strategy type: `compact_20260112`.
- `pause_after_compaction: true` lets the caller inject extra blocks (e.g.
  recent messages) before resuming — closest thing to a phase-handoff seam.

Relevance to this harness: this is *exactly* the "summarize a phase transcript
before handing it to the next phase as context" pattern. It is server-side,
cloud-only, and tied to the Claude API — not directly usable for local models,
but the summarization-prompt pattern is portable.

### b) Anthropic context editing (tool-result / thinking clearing, beta)

Distinct from compaction. `clear_tool_uses_20250919` automatically clears the
oldest tool *results* (file contents, search outputs) from context when a
threshold is crossed, replacing each cleared result with a placeholder. Config
includes `keep`, `clear_at_least`, `exclude_tools`. This is "summarize tool
output before the next step" *without* summarizing — it drops the raw result
entirely once the model has processed it.

- Docs: https://platform.claude.com/docs/en/build-with-claude/context-editing
- Beta header: `context-management-2025-06-27`.
- Note: tool-result clearing *invalidates cached prompt prefixes*. So Anthropic
  explicitly trades cache hits for context budget — confirms the two concerns
  (budget vs. cache) are in tension.
- Anthropic's own measurement: on a 100-turn web-search eval, context editing
  enabled workflows that would otherwise fail and cut token consumption ~84%.
  https://claude.com/blog/context-management

This is the closest documented precedent to the harness's `boundedLog` in
`run.ts` and the "drop raw tool output before re-injection" idea. Worth citing
as authority that the *drop-not-summarize* approach is production-viable.

### c) Client-side SDK compaction

Anthropic's TypeScript and Ruby SDKs expose a `tool_runner` compaction mode
that "generates a summary and replaces full conversation history" client-side.
This is the userland equivalent of (a) — useful as a reference implementation
for local harnesses that must do the same thing manually.

### d) MemGPT / Letta (the OS-memory metaphor)

MemGPT (arXiv 2310.08560, "MemGPT: Towards LLMs as Operating Systems") introduced
virtual context management: a tiered memory system (main context, archival
memory, recall memory) where the agent itself moves info between tiers via tool
calls (think OS paging). Now commercialized as Letta (https://docs.letta.com).
Letta persists *all* messages and memory blocks in a database so state survives
eviction; "core memories" are pinned to the system prompt and editable by the
agent via memory tools.

- Paper: https://arxiv.org/abs/2310.08560
- Code/docs: https://github.com/letta-ai/letta (landing), https://docs.letta.com
- Concept most portable to this harness: the agent controls its own context
  window via tools (insert/evict), rather than the harness summarizing for it.
  Different control point than compaction.

### e) A-MEM (Agentic Memory, NeurIPS 2025)

arXiv 2502.12110. Zettelkasten-inspired: each new memory becomes a structured
"note" (contextual description, keywords, tags); the system analyzes historical
memories to establish links; new memories can *trigger updates to existing
memories' attributes* (memory evolution). Outperforms baselines on six
foundation models. Code: https://github.com/WujiangXu/A-mem-sys.
Less directly applicable than (a)-(d) for per-phase handoff, but relevant if
the harness's learnings store ever wants cross-attempt linking (cf. ADR 0012).

### f) mem0

Production memory layer (https://github.com/mem0ai/mem0, 64k stars). April-2026
algorithm: single-pass ADD-only extraction, entity linking, multi-signal
retrieval (semantic + BM25 + entity), temporal reasoning. Reports 92.5 on
LoCoMo, 94.4 on LongMemEval. Paper arXiv 2504.19413. Relevant as a
retrieval-over-past-transcripts layer, not as a phase-handoff summarizer.

**Confidence: high.** The compaction and context-editing docs are first-party
and directly on-point. MemGPT/Letta, A-MEM, mem0 all confirmed via arXiv.

---

## 2. Cheap-model-as-judge

**No high-signal findings on the specific Haiku-judging-Sonnet pattern.**

Searched for: small-model (8-13B) as structured-output judge over a stronger
model's work; routed-verifier patterns where the judge emits structured findings;
Claude-Haiku-judging-Sonnet specifically.

What I did find, with honest weaker confidence:

- **Anthropic's "small model judges" pattern is documented as a *quality*
  technique** in their general agent-guidance material (e.g. multi-agent
  research system at https://www.anthropic.com/engineering/multi-agent-research-system
  describes sub-agents doing focused work and returning condensed summaries —
  but those sub-agents are not described as judging a stronger model; they
  *are* the workers). This supports the harness's reviewer-pass shape, not the
  Haiku-judges-Sonnet shape.
- **LLM-as-a-judge literature broadly (e.g. Zheng et al. MT-Bench, arXiv 2306.05685)
  studies GPT-4 judging GPT-4 / weaker models** — not small-local-judging-stronger.
  The failure modes (position bias, verbosity bias, self-enhancement bias) are
  real and would transfer; but the asymmetric "small judge, strong worker"
  direction is not characterized.
- **Eureka (arXiv 2310.12931)** uses GPT-4 as an evolutionary reward-code
  generator where an LLM acts as a gradient-free critic of its own outputs — a
  verifier loop, but not small-judges-large.
- **"LLMs Know More Than They Show" (arXiv 2410.02707)** shows internal
  representations encode truthfulness the model doesn't externalize — relevant
  to *whether a small judge can detect a large model's errors*, but this is
  about probing internals, not a small-model judge.

**No high-signal findings on routed-verifier structured-output judging
specifically at the 8-13B range.** The ADR 0014 position (9B Q4 reserved for
"seats that emit one structured response and exit, no recovery loop, no
multi-step exploration" — not the reviewer seat) is consistent with the
absence of evidence either way. Treat the small-as-judge question as open.

**Confidence on "no high-signal finding": high.** I did not guess at additional
arXiv IDs after the first few searches; more targeted literature search on
"weak-to-strong verification" / "small model as critic" would be a follow-up.

---

## 3. Self-consistency / verifier loops for small local models

**No high-signal findings with real-world experience reports for small local
models specifically.**

Searched for: experience reports (not theory) of sampling N completions from a
small local model and keeping the one passing a verifier. The classic
self-consistency literature (Wang et al. 2022, arXiv 2203.11171) is large-model
+ math-reasoning, and is *theory-of-the-technique* not small-local-model
experience reports. ToolLLM (arXiv 2307.16789) uses DFS over reasoning traces
to expand search space — a verifier-like pattern, but again not a small-model
field report.

The closest direct evidence is in ADR 0014 itself, which records a *negative*
finding: "The Bevy upgrade run on Qwen 35B 4-bit-active surfaced hallucinated
`[BLOCKER]` findings that burned 9 retries" — i.e. a small-model verifier
hallucinated blockers and the self-consistency loop amplified the failure rather
than damping it. That is one real-world data point against the technique at
this model scale.

**Confidence: low (no positive findings, one negative finding in-repo).**
The lack of high-signal external evidence should *not* be read as evidence the
technique fails — only that experience reports at the 8-13B Q4 scale were not
located. Worth its own empirical ticket in this harness.

---

## 4. Structured-output forcing for small models

**High-signal findings. Grammar/constrained decoding is the reliable path;
prompt-only is brittle.**

### a) Constrained decoding (the robust approach)

- **llama.cpp GBNF** (GGML BNF). First-party, in-tree: grammars are supported
  in `llama-cli`, `llama-completion`, `llama-server`. JSON schemas convert to
  GBNF at request time (server `json_schema` body field; CLI `--json` / `-j`).
  Docs: https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md.
  The README explicitly warns: optional repetitions `x? x? x?...` cause
  extremely slow sampling; use `x{0,N}`. Real performance gotcha for the
  harness's structured-output passes.
- **Outlines** (dottxt-ai, 15.7k stars; arXiv 2307.09702 "Efficient Guided
  Generation for LLMs" by Willard & Louf). Reformulates generation as
  finite-state-machine transitions; builds an index over the model's
  vocabulary. Works with transformers and *llama.cpp* directly, plus vLLM and
  Ollama as server backends. Same code across providers. https://github.com/dottxt-ai/outlines
- **llama.cpp server schema constraints:** `--json-schema`/`-j` and the server's
  `json_schema` body field convert JSON Schema to a GBNF grammar server-side
  *without injecting the schema into the prompt*. The grammar README states:
  "JSON schema is only used to constrain output, not injected into the prompt.
  The model has no visibility into the schema, so if you want it to understand
  the expected structure, describe it explicitly in your prompt."

### b) Prompt-only (the brittle approach)

Prompt-only structured output for a ~30B Q4 model is *not* characterized by
high-signal literature I could locate as "reliable." The Outlines/GBNF existence
and adoption is itself the evidence: if prompt-only worked reliably at this
scale, constrained-decoding libraries would not be necessary. Anthropic's own
diff between "describe the schema in the prompt" (for the model's understanding)
and "constrain the output" (for the parser's reliability) makes the two-layer
approach the default.

### Concrete recommendation from findings

For the harness's contract-extraction and review-findings structured outputs:
(1) describe the expected JSON shape in the prompt (model-side understanding),
and (2) pass a GBNF/JSON-schema constraint at the llama.cpp server layer
(output-side guarantee). Both. The harness's current "JSON code block" parser
(`extractContractsBlock`) is the prompt-only path; pairing it with a server-side
schema drops the lossy-parser failure mode entirely.

**Confidence: high** on the constrained-decoding finding (first-party docs +
cited paper + the libraries' adoption as evidence). **Confidence: medium** on
"prompt-only is brittle" — this is a reasonable inference from (a) plus the
documented failure modes the harness already handles in
`extractContractsBlock`, not a direct measurement.

---

## 5. Per-ticket / per-phase prompt caching (KV-cache reuse across runs)

**High-signal findings. Yes — llama.cpp supports this directly.**

llama.cpp's `llama-server` exposes multiple mechanisms relevant to the harness's
"same system prompt + AGENTS.md + CONTEXT.md prefix on every phase" pattern:

### a) Prompt caching (default on)

`--cache-prompt` (env `LLAMA_ARG_CACHE_PROMPT`, default enabled). The server
maintains a per-slot prompt cache; on a request whose prefix matches a cached
prefix, the matching tokens are reused instead of re-evaluated. This is the
local-LLM equivalent of Anthropic's prompt caching.

### b) `--cache-reuse N` (KV-shift reuse)

`--cache-reuse N` (env `LLAMA_ARG_CACHE_REUSE`, default 0 = disabled): "min
chunk size to attempt reusing from the cache via KV shifting, requires prompt
caching to be enabled." KV-shift reuse lets the server reuse a cached prefix
even when the *suffix* differs, by shifting cached KV state. Setting `N` to a
chunk size (e.g. 256) enables this. This is the closest analog to Anthropic's
lookback-walk-backward cache behavior.
- Server request param: `n_cache_reuse` (default 0, disabled). Docs: in
  `tools/server/README.md` lines ~1797.

### c) Slot save/restore (cross-process KV persistence)

`--slot-save-path PATH`: directory to save slot KV cache. Exposes
`POST /slots/{id_slot}?action=save` (writes the slot's prompt cache to a file in
`--slot-save-path`) and `POST /slots/{id_slot}?action=restore` (loads it back).
Docs at lines 2513-2553 of `tools/server/README.md`.

This is the cross-run analog the harness needs: a fresh `opencode` subprocess
per phase *can* reuse the cached KV of the system-prompt prefix if the server
persists it. Save once after the first phase's first prefix evaluation;
restore on each subsequent subprocess's first request.

### d) Slot prompt similarity (slot reuse routing)

`-sps, --slot-prompt-similarity SIMILARITY` (default 0.10): "how much the
prompt of a request must match the prompt of a slot in order to use that slot."
0.0 = disabled. A multi-slot server can route a new request to the slot whose
cached prefix best matches, getting a cache hit automatically.

### e) Lookup caches (static / dynamic)

`-lcs, --lookup-cache-static FNAME` and `-lcd, --lookup-cache-dynamic FNAME`:
lookup-decoding n-gram caches. Static is read-only; dynamic is updated by
generation. Different mechanism from KV-cache reuse (this is a speculative
n-gram lookup), but also reduces per-phase latency.

### f) Context checkpoints (idle-slot caching)

`-ctxcp, --ctx-checkpoints N` (default 32 per slot): "max number of context
checkpoints to create per slot." `-cms, --checkpoint-min-step N` (default 8192):
minimum spacing in tokens. `--cache-idle-slots` / `--no-cache-idle-slots`
(default enabled when `cache-ram` set): "save idle slots to the prompt cache on
new task, and clear them when using unified KV." `-cram, --cache-ram N` (default
8192 MiB): max cache size for these. PR #15293 added context checkpoints.

All citations from `llama.cpp/tools/server/README.md` (raw at
https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

**Confidence: high.** This is first-party documentation of the exact feature
the harness's prefix-repeated-per-phase design could exploit. Relevant caveat:
the harness currently shells out to `opencode` which itself drives the local
model; the question of whether `opencode` exposes or sets these server flags is
a separate investigation.

---

## 6. Tool-output truncation / scoping heuristics in agent harnesses

**Partial findings — Anthropic's heuristics are documented; the open-source
harnesses' named heuristics were not located in this pass.**

### Documented (Anthropic)

- **Tool-result clearing** (see topic 1b): the production heuristic is
  *drop the raw tool result entirely* once the model has processed it, replace
  with a placeholder. Configurable threshold, keep-count, and exclude-tools
  list. https://platform.claude.com/docs/en/build-with-claude/context-editing
- **Anthropic's "just-in-time" retrieval pattern** in Claude Code: rather than
  pre-loading file contents, the agent uses `head` and `tail` to read targeted
  slices of large files, never loading the full data into context.
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  ("The model can write targeted queries, store results, and leverage Bash
  commands like head and tail to analyze large volumes of data without ever
  loading the full data objects into context.")

This *names* the heuristic the harness already uses implicitly
(`boundedLog`, "targeted reads/greps, don't read whole large files" in
`buildImplementerPrompt`, `tail -N`, `--stat` per ADR 0014). Anthropic gives
it a name: **just-in-time** retrieval via targeted-shell reads.

### Not located

Searched for but did not find well-tested truncation heuristics with names
from aider, SWE-agent, OpenHands, or Devin in this pass. A targeted GitHub
code-search pass (e.g. `repo:All-Hands-AI/OpenHands "truncat"` or
`repo:princeton-nlp/SWE-agent "tail"`) is the right next step; guessed file
paths did not resolve. **No high-signal finding for the OSS-harness-specific
named heuristics beyond what ADR 0014 already records.**

The heuristic *concepts* in this harness already (per ADR 0014):
- `boundedLog` in `run.ts`
- `sliceContracts` per-ticket in `run.ts`
- `LEARNINGS_CHAR_LIMIT = 2200` in `learnings.ts`
- "targeted reads/greps, don't read whole large files" in `buildImplementerPrompt`
- `cargo build` stderr is easily 10k tokens; use `tail -N` / `--stat`

These match the Anthropic-documented "just-in-time targeted reads" pattern,
which is the strongest external authority located.

**Confidence: medium.** Anthropic-side high; OSS-harness-side open.

---

## 7. Process-restart vs long-lived context

**High-signal findings — fresh-context (sub-process) per phase is a documented
winning pattern; long-lived-with-summarization is also documented but as the
competing pattern, not a clear winner, and the sub-agent/clean-slate pattern
has the stronger documented case for coherence.**

### Anthropic's direct position

"Effective context engineering for AI agents" (Sep 2025,
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
frames three competing techniques, explicitly as alternatives:

1. **Compaction** (summarize-and-continue in one context) — "maintains
   conversational flow for tasks requiring extensive back-and-forth."
2. **Structured note-taking** (write NOTES.md, read back after reset) —
   "excels for iterative development with clear milestones." Claude Pokémon
   is cited: "After context resets, the agent reads its own notes and continues
   multi-hour training sequences." Clean-state-with-external-notes is
   *demonstrably* sufficient for long-horizon coherence.
3. **Sub-agent architectures** — "specialized sub-agents handle focused tasks
   with clean context windows... Each subagent might explore extensively, using
   tens of thousands of tokens or more, but returns only a condensed, distilled
   summary of its work (often 1,000-2,000 tokens)." Clean context per sub-task
   is documented as a *substantial improvement* over single-agent on complex
   research.

The sub-agent pattern is the cloud analog of the harness's
fresh-subprocess-per-phase: a clean context with a distilled handoff in and a
distilled handoff out. Anthropic's measurement: "showed a substantial
improvement over single-agent systems on complex research tasks."

### Direct evidence the *clean-slate* approach helps small models

ADR 0014 records (already, no new research needed): the slowdown gradient —
small models slow down *intra-phase* as context fills, and a 50-step phase that
hits the slow band at step 30 spends its last 20 steps at 4x lower throughput.
This is a *small-model-specific* reason to restart: long-lived context keeps the
model in the slow band longer; fresh subprocess keeps it in the fast band.
Frontier cloud models with 200k+ windows feel context rot less acutely;
small local models feel it as *throughput collapse*, which is harder.

### The "worse with clean slate" failure mode

The documented risk of clean-slate: information loss across the handoff. The
mitigations are (a) a structured handoff summary (Compaction's pattern) and
(b) an external notes file the agent reads on start (structured note-taking).
ADRs 0001 (fresh subprocess) + 0012 (cross-attempt learnings) + the
per-ticket-contracts design already implement (b). The Lever of
"summarize the prior phase's transcript before handing off" (Compaction's
shape, done client-side for local models) is the technique *not yet* in the
harness — this is the gap.

### Verdict (per the evidence)

**For small local models specifically, the clean-slate-per-phase pattern is
better-supported than long-lived-with-summarization**, because:

1. It dodges the throughput-collapse gradient (ADR 0014) — a small-model-only
   failure mode that large cloud models don't suffer as acutely.
2. The sub-agent-with-clean-context pattern is documented as a substantial
   improvement over single-long-context-agent in Anthropic's research,
   with the explicit handoff-size guidance (1k-2k token distilled summary).
3. The structured-note-taking pattern (NOTES.md read on start) is
   *demonstrably* sufficient for multi-hour coherence (Claude Pokémon).

The harness's current design (ADR 0001 fresh subprocess + ADR 0012 learnings
+ per-ticket contracts slice) already implements the clean-slate pattern with
externalized notes. **The missing piece, if any, is the phase-handoff summary
itself — Condense the prior phase transcript into a compact handoff before the
next phase starts.** That is exactly the topic-1 compaction pattern, ported
to a local-model harness.

**Confidence: high** on the comparative-pattern analysis. **Confidence:
medium** on the "better for small models specifically" claim — it rests on
ADR 0014's throughput-gradient observation plus Anthropic's sub-agent evidence
(which is large-model). No direct external study of "fresh-context vs
long-lived for 27B Q4 models" was located.

---

## Summary of confidence per topic

| # | Topic | Verdict | Confidence |
|---|---|---|---|
| 1 | Phase-summarization | High-signal: compaction, context-editing, MemGPT, A-MEM, mem0 | high |
| 2 | Small-model-as-judge | No high-signal findings on Haiku-judges-Sonnet | low |
| 3 | Self-consistency for small local | No positive external findings; one in-repo negative | low |
| 4 | Structured-output for small models | High-signal: GBNF + Outlines; prompt-only brittle | high |
| 5 | Per-phase prompt/KV-cache reuse | High-signal: llama.cpp cache-reuse + slot save/restore | high |
| 6 | Tool-output truncation heuristics | Anthropic-side high ("just-in-time"); OSS-side open | medium |
| 7 | Process-restart vs long-lived | High-signal: clean-slate + externalized notes wins | high (medium for small-model-specific) |

## Follow-ups that surfaced

- Topic 2: targeted search on "weak-to-strong verification" / "small model as
  critic" literature. May have nothing — be ready to flag as open.
- Topic 6: GitHub code search `repo:All-Hands-AI/OpenHands truncat`,
  `repo:princeton-nlp/SWE-agent tail`, `repo:Aider-AI/aider diff` to name
  concrete OSS heuristics.
- Topic 3: an empirical harness-internal ticket measuring N-sample + verifier
  on the 27B Q4 target. One prior in-repo negative (hallucinated blockers);
  needs more data before declaring the technique dead.
- Topic 5: investigate whether `opencode` (the harness's subprocess driver)
  passes through `--cache-reuse` / `--slot-save-path` or whether the harness
  must boot `llama-server` itself to configure these.
- Topic 1/7: a ticket for a client-side compaction step (summarize phase
  transcript → 1k-2k token handoff → next phase), ADR 0014-aligned.

## Sources

- Anthropic compaction docs — https://platform.claude.com/docs/en/build-with-claude/compaction
- Anthropic context-editing docs — https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic prompt-caching docs — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic context-management announcement — https://claude.com/blog/context-management
- Anthropic "Effective context engineering for AI agents" — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- MemGPT paper — https://arxiv.org/abs/2310.08560
- Letta docs — https://docs.letta.com
- A-MEM paper (arXiv 2502.12110) — https://arxiv.org/abs/2502.12110
- A-MEM code — https://github.com/WujiangXu/A-mem-sys
- mem0 — https://github.com/mem0ai/mem0 (paper arXiv 2504.19413)
- Outlines — https://github.com/dottxt-ai/outlines
- Outlines paper (arXiv 2307.09702) — https://arxiv.org/abs/2307.09702
- llama.cpp GBNF grammars — https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md
- llama.cpp server README — https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Eureka paper (arXiv 2310.12931) — https://arxiv.org/abs/2310.12931
- ToolLLM paper (arXiv 2307.16789) — https://arxiv.org/abs/2307.16789
- "LLMs Know More Than They Show" (arXiv 2410.02707) — https://arxiv.org/abs/2410.02707
