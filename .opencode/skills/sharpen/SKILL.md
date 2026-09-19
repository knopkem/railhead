---
name: sharpen
description: Sharpen a plan or design by relentless interview, writing CONTEXT.md and ADRs as decisions land. Use when the user wants to stress-test a plan, design, or idea AND is working in a repo where the decisions should leave a paper trail. Asks one question at a time via the question tool, with a depth picker and a running "question N of ~M" progress marker.
---

# Sharpen

Interview the user relentlessly until you reach a shared understanding, and **write the decisions down as they land** — terms in `CONTEXT.md`, hard-to-reverse trade-offs as ADRs. Map the conversation as a **design tree**: every decision branches into the decisions that hang off it.

This is a stateful skill: every resolved term and decision is captured to disk immediately, not batched at the end. The paper trail is the point — a future agent (or future-you) should be able to reconstruct the shared understanding from `CONTEXT.md` and `docs/adr/` alone.

## Set the depth first

Before the first real question, ask the user how deep the interview should go. Put this to them with the **question tool**:

- **header**: "Interview depth"
- **question**: "How deep should this sharpening go? Pick the depth that fits how settled your plan already is. You can stop early at any point by saying 'done'."
- **options** (first is recommended):
  - "Light (Recommended)" — "Surface decisions only: 3–5 questions on the biggest forks. Quick sanity check on a plan you mostly trust."
  - "Standard" — "10–15 questions. Covers the main decision tree and its immediate branches. Right for sharpening a rough plan."
  - "Deep" — "20–30 questions. Mines every branch down to edge cases and unspoken assumptions. For high-stakes or high-uncertainty designs."
  - "Exhaustive" — "No cap; grind until the frontier is genuinely empty. Use when a wrong decision is expensive to reverse."

The chosen depth sets a soft **question budget**. Track it: every question you ask consumes one from the budget. When ~3 questions remain, begin collapsing the frontier toward the highest-value open decisions and tell the user you're winding down. The user can always override — "go deeper" or "wrap it up" — but the budget gives the session a default shape so it doesn't either peter out or sprawl.

## Show progress on every question

The user should never have to ask "how many more?". Prepend a one-line progress marker to each `question` body, after any context paragraphs:

```
📊 Question N of ~M (depth: <light|standard|deep|exhaustive>) — <remaining> questions left after this one.
```

`N` is the current question's number across the whole session. `M` is your current best estimate of the total, derived from the chosen depth's range plus what the tree still has open (settled answers may grow or shrink the frontier, so `M` can move — that's fine, the estimate updates each question). `<remaining>` is `M − N`. If the depth is **exhaustive**, write "no cap" instead of a number.

Recompute `M` before each question from the live tree state, not once at the start: answers settle branches (shrinking `M`) and expose new forks (growing it). Updating the estimate every question is what makes it trustworthy.

## Work the tree one question at a time

The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Order the frontier by dependency: the question whose answer unblocks the most other questions goes first. Ask **one** frontier question, get its answer, write the decision down, then recompute the frontier and ask the next. Never batch multiple questions into a single message — a round is one question, one answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. A question whose answer depends on another question still open belongs to a _later_ round, not this one.

## Asking a question

Put each decision to the user with the **question tool**, never as prose they must parse and reply to. The tool gives them multi-select, a recommended option, and a "Type your own answer" escape hatch — which is exactly what an interview needs, since the user's answer often isn't any of your options.

For every question:

- **header**: the short decision title (≤30 chars).
- **question**: the progress marker (above), then any context the user needs — why this fork matters, what hangs off it, the trade-offs between options. Multiple paragraphs are fine.
- **options**: 2–5 concrete choices the user might pick. The first option is your recommended answer, labelled with "(Recommended)" at the end of its `label`. Each option's `description` says _why_ you'd pick it, not just what it is. Keep labels ≤5 words; push detail into the description.
- **multiple**: `true` only when the decision genuinely allows several at once (e.g. "which of these modes should ship?"). Default `false` for forks where the user picks one branch.

Pre-compute your recommendation before writing the options so the recommended one really is the best fit given everything settled so far. If, mid-interview, you can no longer defend the recommendation against the user's last answer, change it — but the recommended label always reflects your current best read, never the user's previous pick.

After the tool returns: record the answer in your working notes (settled decisions, with the user's stated reason), mark that decision settled, recompute the frontier, and ask the next one. If the user typed their own answer rather than picking an option, that's the answer — don't re-litigate, just take it and move on unless something downstream forces a clarification.

## When a fact is needed, don't ask

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't put a fact in `options` and don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

## Doing this without the question tool

If the question tool is unavailable in the current runtime, fall back to plain text — but still ask **one question at a time**, never a batch. Still set depth first (offer the four options as text) and still show the progress marker. Format each question:

```
📊 Question N of ~M (depth: <level>) — <remaining> left.

❓ **Q<n>** - **<question title>**: <question body, including the options>

➡️ Recommended: <your recommendation, with one-line why>

Reply with an option, "rec" to take the recommendation, or your own answer.
```

Number questions across the whole session so the user can refer back ("on Q3, I meant…"). Wait for the user's answer before asking the next.

## Write the decisions down — the domain model lives in CONTEXT.md

`CONTEXT.md` at the repo root is the project's **glossary** and nothing else: the canonical terms and their definitions, with `_Avoid_` lists for synonyms not to use. It is not a spec, a scratch pad, or a place for implementation decisions. Implementation decisions live in ADRs (below).

Structure:

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request
```

Rules:

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what a term IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.

If this repo has a `CONTEXT-MAP.md` at the root, the project has multiple contexts — read the map to find the right `CONTEXT.md` for the topic at hand. If neither `CONTEXT.md` nor `CONTEXT-MAP.md` exists yet, create a root `CONTEXT.md` lazily when the first term is resolved. Don't create it preemptively.

### Challenge, sharpen, cross-reference

During the interview, actively maintain the glossary:

- **Challenge against the glossary.** When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"
- **Sharpen fuzzy language.** When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account': do you mean the Customer or the User? Those are different things."
- **Discuss concrete scenarios.** When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.
- **Cross-reference with code.** When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible. Which is right?"
- **Update CONTEXT.md inline.** When a term is resolved, update `CONTEXT.md` right there. Don't batch these up: capture them as they happen.

## Write the decisions down — hard-to-reverse trade-offs live in ADRs

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc. Create the `docs/adr/` directory lazily: only when the first ADR is needed.

### Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why*, not in filling out sections.

Optional sections (only when they add genuine value — most ADRs won't need them):

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`): useful when decisions are revisited.
- **Considered Options**: only when the rejected alternatives are worth remembering.
- **Consequences**: only when non-obvious downstream effects need to be called out.

Numbering: scan `docs/adr/` for the highest existing number and increment by one.

### Only offer an ADR when all three are true

1. **Hard to reverse**: the cost of changing your mind later is meaningful.
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons.

If any of the three is missing, skip the ADR. Use `CONTEXT.md` for the term, or nothing at all.

#### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library: just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it; otherwise someone will suggest GraphQL again in six months.

## When it ends

The session is done when **either** the frontier is empty (every branch of the design tree visited, nothing left silently assumed) **or** the question budget is exhausted. When you hit the budget with the frontier still open, say so explicitly — name the top 1–2 open decisions you're leaving unasked so the user can choose to extend ("go deeper") or accept the gaps.

Before declaring done, do a final pass: re-read `CONTEXT.md` and the ADRs you wrote this session. Confirm every resolved term has a glossary entry, every qualifying decision has an ADR, and nothing in the files contradicts a decision the user made verbally. Do not act on the plan until the user confirms you have reached a shared understanding.
