import { describe, it, expect, vi } from "vitest";
import { orderTickets, parsePlanJson, parsePlanRegions, parseVerifyBlock, parseSmokeBlock, parseInterfaceBlock, parseDesignBlock, parseArchitectureBlock, parseCoherenceContract, splitCoherenceContract, planDesignSystemPrompt, planTicketsSystemPrompt, planFixSystemPrompt, buildGoalCoveragePrompt, buildPlanRevisionPrompt, buildPlanUserFeedbackPrompt, buildPlanMarkdown, parsePlanBlock, parseCoverageVerdict, extendBlockedBy, scanTicketConflicts, scanOrderedConflicts, placeholderWarnings, tableFindings, outstandingFindings, parseRulings, assessRuntimeExtension, scanPlanConflicts, repairRowText, buildPlanRepairPrompt, impliedBlockedByEdits, sameFileOrderingEdits, withImpliedBlockedBy, collapseRepeatedTickets, extractFilePaths, detectIntegrationPromise, TICKET_FIELD_SEMANTICS, type PlanTicket, type Ruling } from "./plan.ts";

describe("planDesignSystemPrompt — stage 1 (the plan)", () => {
  it("asks for the verify/interface/smoke blocks and both document blocks, and NOT tickets", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toContain("$VERIFY");
    expect(prompt).toContain("$INTERFACE");
    expect(prompt).toContain("$SMOKE");
    expect(prompt).toContain("$DESIGN");
    expect(prompt).toContain("$ARCHITECTURE");
    expect(prompt).toContain("$END");
    // Decomposition is a separate stage: the design call must not emit tickets.
    expect(prompt).not.toContain("$TICKETS");
  });

  it("requires a Goal coverage checklist mapping every demand, including adjectives, to a concrete deliverable", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/Goal coverage/i);
    expect(prompt).toMatch(/concrete deliverable/i);
    expect(prompt).toMatch(/adjective is not a deliverable/i);
    expect(prompt).toMatch(/audit/i);
  });

  it("forbids asserting third-party existence: capability-based criteria, never package names as fact (claim discipline)", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toContain("Claim discipline");
    expect(prompt).toMatch(/never present an unverified outside-world fact/i);
    expect(prompt).toMatch(/express it as a CAPABILITY with a testable acceptance criterion/i);
    expect(prompt).toMatch(/never "use @scope\/name"/);
    expect(prompt).toMatch(/phrased as a RESOLUTION, not an assertion/i);
  });

  it("tells the planner that later tickets and the architecture must not restate a third-party name as fact", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/no later ticket or the \$ARCHITECTURE block may restate the name as fact/i);
    expect(prompt).toMatch(/decision record/i);
  });

  it("instructs the planner to emit a $SMOKE block with a binary-launch command (or NONE for libraries)", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/launches the built binary/i);
    expect(prompt).toMatch(/startup panic/i);
    expect(prompt).toMatch(/same code path the user runs/i);
  });

  it("instructs the planner to emit an $INTERFACE line with the five taxonomy values (#97)", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toContain("<browser-ui | canvas | native | terminal | none>");
    expect(prompt).toMatch(/browser-ui[^\n]*DOM app the user operates/i);
    expect(prompt).toMatch(/canvas[^\n]*full-canvas app running in a browser page/i);
    expect(prompt).toMatch(/native[^\n]*opens its own OS window/i);
    expect(prompt).toMatch(/terminal[^\n]*operates via stdin\/stdout/i);
    expect(prompt).toMatch(/none[^\n]*library or pure backend/i);
    expect(prompt).toMatch(/property of the thing being built, never of the language/i);
    expect(prompt).toMatch(/opens its own desktop window is native/i);
  });

  it("includes the existing CONTEXT.md glossary verbatim when given, and tells the planner to reuse its words", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)", existingGlossary: "**Ticket**: a unit of work." });
    expect(prompt).toContain("**Ticket**: a unit of work.");
    expect(prompt).toMatch(/use these words exactly/i);
  });

  it("omits the glossary block entirely when no glossary is given", () => {
    const withGlossary = planDesignSystemPrompt({ contractsSummary: "(none)", existingGlossary: "**Ticket**: a unit of work." });
    const without = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(without).not.toMatch(/existing domain glossary/i);
    expect(withGlossary).toMatch(/existing domain glossary/i);
  });

  it("includes the deep-module citation (#7)", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/Prefer deep modules/i);
    expect(prompt).toMatch(/small interface, large implementation/i);
    expect(prompt).toContain("docs/codebase-design.md");
  });

  it("includes quality preferences for lean, modular, maintainable code (#34)", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/Quality preferences/i);
    expect(prompt).toMatch(/prefer.*fewer dependencies/i);
    expect(prompt).toMatch(/stdlib.*platform.*over.*third-party/i);
    expect(prompt).toMatch(/small, focused modules/i);
    expect(prompt).toMatch(/premature abstraction/i);
    expect(prompt).toMatch(/strong.*testing/i);
  });

  it("requires the complete $PLAN block and frames $DESIGN/$ARCHITECTURE as its distilled summaries", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toContain("$PLAN");
    expect(prompt).toMatch(/COMPLETE plan — the authoritative document/i);
    expect(prompt).toMatch(/no length cap/i);
    expect(prompt).toMatch(/DISTILLED summaries/i);
    expect(prompt).toMatch(/anything you omit here is scope dropped/i);
  });

  it("plans the whole build with no window/ticket/file sizing rules", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/no page or ticket limit/i);
    expect(prompt).not.toMatch(/40% of the window/i);
    expect(prompt).not.toMatch(/2-3 new files/i);
    expect(prompt).not.toMatch(/ceiling ~12/i);
  });
});

describe("art-direction planning rule (option c)", () => {
  it("design prompt requests concrete Art direction as direction, not a checklist", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toContain("ART DIRECTION requirement");
    expect(prompt).toMatch(/palette roles as hex values/i);
    expect(prompt).toMatch(/attenuation rule/i);
    expect(prompt).toMatch(/## Art direction/);
    expect(prompt).toMatch(/not a checklist/i);
  });

  it("tickets prompt requires exactly one open-ended craft ticket, never a decomposition", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/exactly ONE OPEN-ENDED CRAFT TICKET/i);
    expect(prompt).toMatch(/"open_ended": true/);
    expect(prompt).toMatch(/Do NOT split the visual work/i);
  });

  it("artDirection:false suppresses both request blocks", () => {
    const design = planDesignSystemPrompt({ contractsSummary: "(none)", artDirection: false });
    const tickets = planTicketsSystemPrompt({ contractsSummary: "(none)", artDirection: false });
    expect(design).not.toContain("ART DIRECTION requirement");
    expect(tickets).not.toContain("ART DIRECTION requirement");
  });
});

describe("planTicketsSystemPrompt — stage 3 (decomposition)", () => {
  it("owns the ticket schema and the shared field semantics", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toContain("$TICKETS");
    expect(prompt).toContain(TICKET_FIELD_SEMANTICS);
    expect(prompt).toContain('"testable": true');
    expect(prompt).toContain('"group"');
    expect(prompt).toMatch(/coherent vertical slice/i);
  });

  it("removed every window-sizing rule: tickets are sized by verifiability and seams", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/no ticket-count ceiling/i);
    expect(prompt).toMatch(/no file-count cap/i);
    expect(prompt).not.toMatch(/40% of the window/i);
    expect(prompt).not.toMatch(/2-3 new files/i);
    expect(prompt).not.toMatch(/ceiling ~12/i);
    expect(prompt).not.toMatch(/read more than 3 files/i);
    expect(prompt).not.toMatch(/10% of the working window/i);
    expect(prompt).not.toMatch(/hand-off test/i);
  });

  it("requires covering every plan deliverable and forbids silent scope narrowing", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/COVER THE PLAN/i);
    expect(prompt).toMatch(/Goal coverage checklist/i);
    expect(prompt).toMatch(/never silently drop plan scope/i);
    expect(prompt).toMatch(/each named module, mechanism, effect, screen, artifact/i);
  });

  it("states the single-owner rule for shared files (#101)", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/one owner per file|sole owner|exactly one ticket owns a file/i);
    expect(prompt).toMatch(/reference|consume/i);
    expect(prompt).toMatch(/N feature tickets each claiming/i);
    expect(prompt).toMatch(/files.*complete edit set|always the complete edit set/i);
    expect(prompt).toMatch(/under-declare|NEVER under-declare/i);
  });

  it("build mode's single-owner rule forbids under-declaring edited files (#101)", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/omitting a file you still edit blinds the gate/i);
  });

  it("steers the entry point toward an early minimal-running-shell owner (#115)", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/ONE early shell ticket owns the entry point/i);
    expect(prompt).toMatch(/minimal running shell|mount-contract/i);
    expect(prompt).toMatch(/dock into that seam/i);
    expect(prompt).not.toMatch(/usually a late .*integrate the panels/i);
  });

  it("requires criteria the implementer's seat can verify (no look-good ACs)", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/verifiable by the implementer's seat/i);
  });

  it("scopes criteria to the ticket's own change (no repo-wide searches the reviewer cannot run)", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toMatch(/checkable against the ticket's own change/i);
    expect(prompt).toMatch(/repo-wide search or absence claim/i);
    expect(prompt).toMatch(/scope it to the files this ticket owns/i);
  });
});

describe("goal coverage audit (stage 2)", () => {
  it("asks the auditor to enumerate the goal's demands itself and treat adjectives without deliverables as unmet", () => {
    const p = buildGoalCoveragePrompt({ goal: "a fast beautiful tool", planText: "$DESIGN\nA plan.\n$END", round: 1, maxRounds: 2 });
    expect(p).toContain("a fast beautiful tool");
    expect(p).toContain("A plan.");
    expect(p).toMatch(/do not trust the plan's own Goal coverage checklist/i);
    expect(p).toMatch(/adjective is not a deliverable/i);
    expect(p).toContain("$COVERAGE_PASS");
    expect(p).toContain("$COVERAGE_FAIL");
    expect(p).toContain("[MISSING]");
    expect(p).toContain("[THIN]");
    expect(p).toMatch(/audit round 1 of 2/i);
  });

  it("parseCoverageVerdict reads a pass, a fail with findings, and an absent verdict", () => {
    expect(parseCoverageVerdict("$COVERAGE_PASS\n$END\n")).toEqual({ verdict: "pass", findings: [] });
    expect(parseCoverageVerdict("prose\n$COVERAGE_FAIL\n[MISSING] smooth animation — only a static image is planned\n[THIN] fast — \"responsive\" is restated, no frame budget named\n$END\ntrailing")).toEqual({
      verdict: "fail",
      findings: [
        "[MISSING] smooth animation — only a static image is planned",
        "[THIN] fast — \"responsive\" is restated, no frame budget named",
      ],
    });
    expect(parseCoverageVerdict("I think it is fine, no markers")).toEqual({ verdict: "inconclusive", findings: [] });
  });

  it("a fail marker wins over a pass marker (safest read on a confused auditor)", () => {
    const v = parseCoverageVerdict("$COVERAGE_PASS\n$COVERAGE_FAIL\n[MISSING] x — y\n$END");
    expect(v.verdict).toBe("fail");
    expect(v.findings).toHaveLength(1);
  });

  it("revision prompt carries the findings back to the design stage and demands a full re-emit", () => {
    const p = buildPlanRevisionPrompt({ goal: "g", priorPlanText: "old plan text", findings: ["[MISSING] x — y"] });
    expect(p).toContain("[MISSING] x — y");
    expect(p).toContain("old plan text");
    expect(p).toMatch(/Re-emit the COMPLETE plan/i);
  });
});

describe("parsePlanBlock / PLAN.md (ADR 0041)", () => {
  it("extracts the $PLAN body and stops at the next sibling marker", () => {
    const text = [
      "$VERIFY",
      "npm test",
      "$PLAN",
      "The complete plan.",
      "## Detail",
      "Everything the build needs.",
      "$END",
      "$DESIGN",
      "A distilled design.",
      "$END",
    ].join("\n");
    const plan = parsePlanBlock(text);
    expect(plan).toContain("The complete plan.");
    expect(plan).toContain("Everything the build needs.");
    expect(plan).not.toContain("A distilled design.");
  });

  it("returns null when absent (fix plans and legacy plans)", () => {
    expect(parsePlanBlock("$DESIGN\nA design.\n$END")).toBeNull();
  });

  it("user-feedback revision prompt carries the feedback, the goal, and demands a full re-emit", () => {
    const p = buildPlanUserFeedbackPrompt({ goal: "a level", priorPlanText: "old plan", feedback: "Make the boss a two-phase fight" });
    expect(p).toContain("Make the boss a two-phase fight");
    expect(p).toContain("a level");
    expect(p).toContain("old plan");
    expect(p).toMatch(/Re-emit the COMPLETE plan/i);
    expect(p).toMatch(/do not argue/i);
  });

  const ticket = (n: string, title: string) => ({
    number: n,
    title,
    what: `build ${title}`,
    criteria: [`${title} works`],
    files: [`src/${title.toLowerCase()}.ts`],
    blocked_by: [] as string[],
    references: [] as string[],
    introduces: [`${title}Contract`],
  });

  it("composes PLAN.md from the authoritative $PLAN plus the full ticket breakdown", () => {
    const md = buildPlanMarkdown({
      prompt: "one level of a platformer",
      planDoc: "The complete plan body.",
      designDoc: "distilled design",
      architectureDoc: "distilled architecture",
      tickets: [ticket("01", "Shell"), ticket("02", "Boss")],
    });
    expect(md).toContain("# PLAN");
    expect(md).toContain("one level of a platformer");
    expect(md).toContain("The complete plan body.");
    expect(md).not.toContain("distilled design");
    expect(md).toContain("## Ticket plan (2 tickets)");
    expect(md).toContain("### 01 — Shell");
    expect(md).toContain("- Criterion: Shell works");
    expect(md).toContain("- Produces: BossContract");
  });

  it("omits the ticket section when no tickets exist yet (the pre-acceptance PLAN.md)", () => {
    const md = buildPlanMarkdown({
      prompt: "an app",
      planDoc: "The complete plan body.",
      designDoc: null,
      architectureDoc: null,
    });
    expect(md).toContain("The complete plan body.");
    expect(md).not.toContain("## Ticket plan");
  });

  it("falls back to the distilled docs when a legacy plan has no $PLAN block", () => {
    const md = buildPlanMarkdown({
      prompt: "a tool",
      planDoc: null,
      designDoc: "distilled design",
      architectureDoc: "distilled architecture",
      tickets: [ticket("01", "Shell")],
    });
    expect(md).toContain("distilled design");
    expect(md).toContain("distilled architecture");
    expect(md).toContain("## Ticket plan (1 ticket)");
  });
});

describe("TICKET_FIELD_SEMANTICS — single source of truth (issue #118)", () => {
  it("tickets prompt interpolates the shared block and never restates the bad phrasings", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(prompt).toContain(TICKET_FIELD_SEMANTICS);
    expect(prompt).not.toMatch(/1-indexed/i);
    expect(prompt).not.toMatch(/committed tickets[^\n]*by position in your emitted array/i);
  });

  it("fix-mode planner prompt interpolates the shared block too", () => {
    const prompt = planFixSystemPrompt("(none)");
    expect(prompt).toContain(TICKET_FIELD_SEMANTICS);
    expect(prompt).not.toMatch(/1-indexed/i);
  });

  it("repair prompt interpolates the shared block instead of restating the coordinate contract", () => {
    const prompt = buildPlanRepairPrompt({
      ticketsJson: "[]",
      table: [],
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    expect(prompt).toContain(TICKET_FIELD_SEMANTICS);
    // The old hand-maintained restatement is gone; only the shared block names
    // the coordinate, and it is 0-based.
    expect(prompt).not.toMatch(/"blocked_by" values are 0-based positions/i);
    expect(prompt).not.toMatch(/1-indexed/i);
  });
});

describe("planFixSystemPrompt — fix mode", () => {
  it("tells the planner NEVER to pre-judge whether the bug is already fixed, and ALWAYS emit a real fix ticket", () => {
    const p = planFixSystemPrompt("(none)");
    expect(p).toMatch(/never.{0,40}decide.{0,40}already/i);
    expect(p).toMatch(/always emit a real fix ticket/i);
    expect(p).toMatch(/do not emit.{0,40}verification/i);
  });

  it("requires the ticket to carry reproduction steps so the implementer can reproduce before fixing", () => {
    const p = planFixSystemPrompt("(none)");
    expect(p).toMatch(/must carry the reproduction/i);
  });

  it("fix mode carries the same claim discipline: never assert a third-party name as decided truth", () => {
    const p = planFixSystemPrompt("(none)");
    expect(p).toContain("Claim discipline");
    expect(p).toMatch(/express it as a CAPABILITY with a testable acceptance criterion/i);
  });

  it("says the implementer (not the planner) decides whether the bug reproduces", () => {
    const p = planFixSystemPrompt("(none)");
    expect(p).toMatch(/implementer.{0,40}decides/i);
  });

  it("keeps the $VERIFY/$SMOKE/$TICKETS contract and does not request a coherence charter", () => {
    const p = planFixSystemPrompt("(none)");
    expect(p).toContain("$VERIFY");
    expect(p).toContain("$SMOKE");
    expect(p).toContain("$TICKETS");
    expect(p).not.toContain("## Coherence contract");
  });

  it("includes quality preferences in fix mode too (#34)", () => {
    const p = planFixSystemPrompt("(none)");
    expect(p).toMatch(/Quality preferences/i);
    expect(p).toMatch(/prefer.*fewer dependencies/i);
  });
});

const t = (title: string, blocked_by: number[] = []): PlanTicket => ({
  title,
  what: "work",
  criteria: [],
  blocked_by,
});

describe("orderTickets", () => {
  it("numbers a linear chain in dependency order", async () => {
    const out = await orderTickets([t("a"), t("b", [0]), t("c", [1])]);
    expect(out.map((o) => o.number)).toEqual(["01", "02", "03"]);
    expect(out.map((o) => o.title)).toEqual(["a", "b", "c"]);
  });

  it("topologically numbers a diamond despite input order", async () => {
    // arrangement: b=0, a=1, d=2, c=3
    // a blocks b and c; b and c block d
    const out = await orderTickets([t("b", [1]), t("a"), t("d", [0, 3]), t("c", [1])]);
    const pos = (title: string) => out.find((o) => o.title === title)!;
    // a must precede b, c, d
    expect(pos("b").number > pos("a").number).toBe(true);
    expect(pos("c").number > pos("a").number).toBe(true);
    expect(pos("d").number > pos("b").number).toBe(true);
    expect(pos("d").number > pos("c").number).toBe(true);
  });

  it("throws on a dependency cycle", async () => {
    await expect(orderTickets([t("a", [1]), t("b", [0])])).rejects.toThrow(/cycle/);
  });

  it("throws on an out-of-range blocked_by index", async () => {
    await expect(orderTickets([t("a"), t("b", [5])])).rejects.toThrowError();
  });

  it("drops a self-referencing blocked_by instead of throwing", async () => {
    const out = await orderTickets([t("a"), t("b", [0]), t("c", [1, 2])]);
    expect(out).toHaveLength(3);
    expect(out[2].blocked_by).toEqual([out[1].file]);
    expect(out[2].number).toBe("03");
  });

  it("drops a self-referencing blocked_by on ticket 0", async () => {
    const out = await orderTickets([t("a", [0]), t("b", [0])]);
    expect(out[0].blocked_by).toEqual([]);
    expect(out[1].blocked_by).toEqual([out[0].file]);
  });

  it("dedupes repeated blocked_by entries", async () => {
    const out = await orderTickets([t("a"), t("b", [0, 0])]);
    expect(out[1].blocked_by).toEqual([out[0].file]);
  });

  it("preserves a valid multi-dependency when one entry is a self-reference", async () => {
    const out = await orderTickets([t("a"), t("b", [0]), t("c", [0, 1, 2])]);
    expect(out[2].blocked_by).toEqual([out[0].file, out[1].file]);
  });
});

describe("parsePlanJson", () => {
  it("parses a clean JSON array", () => {
    const out = parsePlanJson(
      '[{"title":"x","mission":"a build","what":"w","criteria":["c"],"blocked_by":[0],"files":["f.ts"],"references":["s"]}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "x", mission: "a build", files: ["f.ts"], references: ["s"] });
  });

  it("tolerates a prose preamble", () => {
    const out = parsePlanJson('Here are your tickets:\n[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]');
    expect(out[0].title).toBe("x");
  });

  it("tolerates a code-fence wrap", () => {
    const out = parsePlanJson('```json\n[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]\n```');
    expect(out[0].title).toBe("x");
  });

  it("skips mid-array corruption and keeps the valid tickets", () => {
    const out = parsePlanJson(
      '[\n{"title":"a","what":"w","criteria":[],"blocked_by":[]},\n"garbage":[],\n{"title":"b","what":"w","criteria":[],"blocked_by":[0]}\n]',
    );
    expect(out.map((o) => o.title)).toEqual(["a", "b"]);
  });

  it("skips an unbalanced trailing object", () => {
    const out = parsePlanJson('[{"title":"a","what":"w","criteria":[],"blocked_by":[]}, {"title":"b","what":"w"');
    expect(out.map((o) => o.title)).toEqual(["a"]);
  });

  it("recovers tickets after one malformed ticket object instead of dropping the tail", () => {
    // The spriteforge failure: ticket 3's files array had an unquoted element
    // (`src/core/history.test.ts`), which desynced the scanner and silently
    // dropped tickets 3-11. Only the malformed ticket may be lost now.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = parsePlanJson(
        '$TICKETS\n[{"title":"a","what":"w","criteria":[],"blocked_by":[]},{"title":"b","what":"w","criteria":[],"blocked_by":[],"files":["x.ts", y.ts"]},{"title":"c","what":"w","criteria":[],"blocked_by":[]}]',
      );
      expect(out.map((t) => t.title)).toEqual(["a", "c"]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("could not be parsed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports the unparsed ticket count of a malformed region (never a silent shrink)", () => {
    const { tickets, unparsed } = parsePlanRegions(
      '$TICKETS\n[{"title":"a"},{"title":"b","files":["x.ts", y.ts"]},{"title":"c"}]',
    );
    expect(tickets.map((t) => t.title)).toEqual(["a", "c"]);
    expect(unparsed).toBe(1);
  });

  it("throws when no readable ticket survives", () => {
    expect(() => parsePlanJson("totally not json")).toThrow();
  });

  it("reads testable from the plan JSON (#5)", () => {
    const out = parsePlanJson(
      '[{"title":"cfg","what":"w","criteria":[],"blocked_by":[],"testable":false},{"title":"impl","what":"w","criteria":[],"blocked_by":[0],"testable":true}]',
    );
    expect(out).toHaveLength(2);
    expect(out[0].testable).toBe(false);
    expect(out[1].testable).toBe(true);
  });

  it("defaults testable to undefined when absent (#5)", () => {
    const out = parsePlanJson('[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]');
    expect(out[0].testable).toBeUndefined();
  });
});

describe("issue #104 — collapse a doubled $TICKETS array (mid-session revision)", () => {
  const arr = (ts: { title: string; what: string }[]): string =>
    `[\n${ts.map((t) => JSON.stringify({ title: t.title, what: t.what, criteria: [], blocked_by: [] })).join(",\n")}\n]`;

  it("parses two $TICKETS arrays where the second is a per-ticket worded variant of the first as ONE plan (last wins)", () => {
    const draft = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ title: `Ticket ${i}`, what: `draft ${i}` }));
    const revised = draft.map((t) => ({ ...t, what: `revised ${t.what}` }));
    // The spriteforge shape: two assistant text events, each a full
    // $VERIFY … $TICKETS block — the second a worded re-emission of the first.
    const transcript = [
      "$VERIFY", "npm test", "$TICKETS", arr(draft),
      "$VERIFY", "npm test", "$DESIGN", "revised wording", "$END", "$TICKETS", arr(revised),
    ].join("\n");
    const out = parsePlanJson(transcript);
    expect(out).toHaveLength(8);
    // The surviving set is the revision, not the draft — no doubling.
    expect(out.every((t) => t.what.startsWith("revised"))).toBe(true);
  });

  it("a $TICKETS array genuinely continued across two messages (no slug-duplicate signature) is NOT collapsed", () => {
    const part1 = [{ title: "Scaffold", what: "w1" }, { title: "Core engine", what: "w2" }];
    const part2 = [{ title: "Renderer", what: "w3" }, { title: "Input handling", what: "w4" }];
    const out = parsePlanJson(`$TICKETS\n${arr(part1)}\n$TICKETS\n${arr(part2)}`);
    expect(out.map((t) => t.title)).toEqual(["Scaffold", "Core engine", "Renderer", "Input handling"]);
  });

  it("a later array that only partially overlaps the earlier is kept additively, never collapsed (don't drop a real ticket)", () => {
    const earlier = [{ title: "A", what: "w" }, { title: "B", what: "w" }, { title: "C", what: "w" }];
    // The later array repeats B and adds D but OMITS C — not a full revision,
    // so both arrays survive and the ambiguous pair is left to the gate.
    const later = [{ title: "B", what: "w2" }, { title: "D", what: "w" }];
    const { tickets, collapsed } = parsePlanRegions(`$TICKETS\n${arr(earlier)}\n$TICKETS\n${arr(later)}`);
    expect(collapsed).toBe(0);
    expect(tickets.map((t) => t.title)).toEqual(["A", "B", "C", "B", "D"]);
  });

  it("a superseding revision that grows the plan reports the dropped draft count", () => {
    const draft = [{ title: "A", what: "w" }, { title: "B", what: "w" }];
    const revised = [{ title: "A", what: "r" }, { title: "B", what: "r" }, { title: "C", what: "r" }];
    const { tickets, collapsed } = parsePlanRegions(`$TICKETS\n${arr(draft)}\n$TICKETS\n${arr(revised)}`);
    expect(collapsed).toBe(2);
    expect(tickets).toHaveLength(3);
  });

  it("three drafts reconcile to the final one (each later region revises the whole prior set)", () => {
    const d1 = [{ title: "A", what: "1" }, { title: "B", what: "1" }];
    const d2 = [{ title: "A", what: "2" }, { title: "B", what: "2" }, { title: "C", what: "2" }];
    const d3 = [{ title: "A", what: "3" }, { title: "B", what: "3" }, { title: "C", what: "3" }, { title: "D", what: "3" }];
    const { tickets, collapsed } = parsePlanRegions(`$TICKETS\n${arr(d1)}\n$TICKETS\n${arr(d2)}\n$TICKETS\n${arr(d3)}`);
    expect(collapsed).toBe(5); // 2 + 3
    expect(tickets).toHaveLength(4);
    expect(tickets.every((t) => t.what === "3")).toBe(true);
  });

  it("collapses only ACROSS $TICKETS regions — a duplicate title inside one array survives for the gate to repair", () => {
    const dup = [{ title: "Same", what: "a" }, { title: "Same", what: "b" }];
    expect(parsePlanJson(`$TICKETS\n${arr(dup)}`)).toHaveLength(2);
  });

  it("does not apply revision collapse without $TICKETS markers (no trustworthy boundary)", () => {
    const dup = [{ title: "Same", what: "a" }, { title: "Same", what: "b" }];
    expect(parsePlanJson(`${arr(dup)}\n${arr(dup)}`)).toHaveLength(4);
  });

  it("still throws when a $TICKETS region yields no readable tickets", () => {
    expect(() => parsePlanJson("$TICKETS\nnot json at all")).toThrow(/no readable tickets/);
  });

  it("surfaces a reconciliation on the console as a warn naming the dropped count (never silent)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const draft = [{ title: "A", what: "w" }, { title: "B", what: "w" }];
      const revised = [{ title: "A", what: "r" }, { title: "B", what: "r" }];
      parsePlanJson(`$TICKETS\n${arr(draft)}\n$TICKETS\n${arr(revised)}`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("2 draft ticket(s) were dropped");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn on a normal single-array plan", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      parsePlanJson('[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("tells the planner to emit ONE $TICKETS array, matching the parser's revision semantics (ADR 0007 lockstep)", () => {
    const p = planTicketsSystemPrompt({ contractsSummary: "(none)" });
    expect(p).toMatch(/\$TICKETS marker and the JSON array EXACTLY ONCE/i);
    expect(p).toMatch(/superseding revision/i);
    expect(p).toMatch(/never repeat a ticket you already emitted/i);
  });
});

describe("parseVerifyBlock", () => {
  it("extracts commands listed between $VERIFY and $TICKETS markers", () => {
    const text = `$VERIFY
cargo build
cargo test
$TICKETS
[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]`;
    expect(parseVerifyBlock(text)).toEqual(["cargo build", "cargo test"]);
  });

  it("returns [] when no $VERIFY marker is present", () => {
    expect(parseVerifyBlock('[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]')).toEqual([]);
  });

  it("returns [] when the $VERIFY block is empty or NONE", () => {
    expect(parseVerifyBlock("$VERIFY\nNONE\n$TICKETS\n[]")).toEqual([]);
    expect(parseVerifyBlock("$VERIFY\n\n$TICKETS\n[]")).toEqual([]);
  });

  it("ignores blank lines and trims whitespace within the block", () => {
    const text = `$VERIFY
  cargo build  
\tnpm test\t
$TICKETS
[]`;
    expect(parseVerifyBlock(text)).toEqual(["cargo build", "npm test"]);
  });

  it("tolerates the markers in any case", () => {
    const text = `$verify
cargo build
$tickets
[]`;
    expect(parseVerifyBlock(text)).toEqual(["cargo build"]);
  });
});

describe("parseSmokeBlock", () => {
  it("extracts the launch command between $SMOKE and $TICKETS", () => {
    const text = `$VERIFY
cargo build
$SMOKE
cargo run
$TICKETS
[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]`;
    expect(parseSmokeBlock(text)).toEqual(["cargo run"]);
  });

  it("returns [] when no $SMOKE marker is present (library project or planner declined)", () => {
    expect(parseSmokeBlock("$VERIFY\ncargo build\n$TICKETS\n[]")).toEqual([]);
  });

  it("returns [] when the $SMOKE block is empty or NONE", () => {
    expect(parseSmokeBlock("$VERIFY\ncargo build\n$SMOKE\nNONE\n$TICKETS\n[]")).toEqual([]);
    expect(parseSmokeBlock("$SMOKE\n\n$TICKETS\n[]")).toEqual([]);
  });

  it("does NOT swallow the $SMOKE block into parseVerifyBlock — the two parsers are siblings, not nested", () => {
    const text = `$VERIFY
cargo build
$SMOKE
cargo run
$TICKETS
[]`;
    expect(parseVerifyBlock(text)).toEqual(["cargo build"]);
    expect(parseSmokeBlock(text)).toEqual(["cargo run"]);
  });

  it("stops the verify block at an intervening $INTERFACE line (issue #97)", () => {
    const text = `$VERIFY
cargo build
cargo test
$INTERFACE
browser-ui
$SMOKE
cargo run
$TICKETS
[]`;
    expect(parseVerifyBlock(text)).toEqual(["cargo build", "cargo test"]);
    expect(parseSmokeBlock(text)).toEqual(["cargo run"]);
  });

  it("tolerates the markers in any case", () => {
    const text = `$verify
cargo build
$smoke
cargo run
$tickets
[]`;
    expect(parseSmokeBlock(text)).toEqual(["cargo run"]);
  });
});

describe("parseVerifyBlock / parseSmokeBlock drop a stray $END line", () => {
  it("does not turn a bare $END into a command", () => {
    expect(parseVerifyBlock("$VERIFY\nnpm run build\n$END\n$SMOKE\nnpm run dev\n$END\n$PLAN\nA plan.\n$END\n")).toEqual(["npm run build"]);
    expect(parseSmokeBlock("$SMOKE\nnpm run dev\n$END\n$PLAN\nA plan.\n$END\n")).toEqual(["npm run dev"]);
  });
});

describe("parseSmokeBlock never swallows the $PLAN block (ADR 0041)", () => {
  it("stops the smoke list at $PLAN — a plan block after $SMOKE is not command text", () => {
    const text = [
      "$VERIFY",
      "npm run build",
      "$SMOKE",
      "npm run dev",
      "$PLAN",
      "# PLAN",
      "The complete plan must not leak into railhead.json's smoke list.",
      "$END",
      "$DESIGN",
      "A design.",
      "$END",
      "$TICKETS",
      "[]",
    ].join("\n");
    expect(parseSmokeBlock(text)).toEqual(["npm run dev"]);
  });
});

describe("parseInterfaceBlock (issue #97)", () => {
  it("extracts the declared token between $INTERFACE and the next sibling marker", () => {
    expect(parseInterfaceBlock("$VERIFY\ncargo build\n$INTERFACE\nbrowser-ui\n$SMOKE\ncargo run\n$TICKETS\n[]")).toBe("browser-ui");
    expect(parseInterfaceBlock("$INTERFACE\ncanvas\n$DESIGN\nA game.\n$END\n$TICKETS\n[]")).toBe("canvas");
    expect(parseInterfaceBlock("$INTERFACE\n  terminal  \n$TICKETS\n[]")).toBe("terminal");
  });

  it("is lossy-tolerant of prose around the token", () => {
    expect(parseInterfaceBlock("$INTERFACE\nThis deliverable is operated as: none (a pure library).\n$SMOKE\nNONE\n$TICKETS\n[]")).toBe("none");
  });

  it("returns null when absent, empty, or holding no recognized token", () => {
    expect(parseInterfaceBlock("$VERIFY\ncargo build\n$SMOKE\ncargo run\n$TICKETS\n[]")).toBeNull();
    expect(parseInterfaceBlock("$INTERFACE\n\n$SMOKE\nNONE\n$TICKETS\n[]")).toBeNull();
    expect(parseInterfaceBlock("$INTERFACE\na-whole-new-kind\n$TICKETS\n[]")).toBeNull();
    expect(parseInterfaceBlock("")).toBeNull();
  });

  it("does not confuse the verify/smoke `NONE` with the none interface when the block is empty", () => {
    expect(parseInterfaceBlock("$VERIFY\ncargo build\n$SMOKE\nNONE\n$TICKETS\n[]")).toBeNull();
  });
});

describe("smoke list round-trip (issue #106-H): smoke is launch commands only", () => {
  const planText = `$VERIFY
npm run typecheck
$SMOKE
npm run preview -- --port 4173 --strictPort
$DESIGN
Goal: the new plan.
## Coherence contract
### Visual tokens
--accent #00ff00
$END
$ARCHITECTURE
One runtime dep, resolved in the export ticket.
$END
$TICKETS
[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]`;

  it("parses only the launch command out of a $SMOKE block that precedes $DESIGN — no design/architecture prose rides into the smoke list", () => {
    // The pre-#106 parser stopped only at $TICKETS, so the $DESIGN/$ARCHITECTURE
    // region (which follows $SMOKE in the plan) was swallowed into railhead.json's
    // smoke list as a write-only mirror. Smoke is launch commands only.
    expect(parseSmokeBlock(planText)).toEqual(["npm run preview -- --port 4173 --strictPort"]);
  });

  it("round-trips: what seeds cfg.smoke is what smoke runs — the launch command only", () => {
    const smoke = parseSmokeBlock(planText);
    // The smoke runtime executes runCommands[0] verbatim and nothing else.
    expect(smoke[0]).toBe("npm run preview -- --port 4173 --strictPort");
    expect(smoke).toHaveLength(1);
    // The design/architecture docs are the runtime authority — they are NOT
    // carried in the smoke list (a third copy that drifts and nothing reads).
    expect(smoke.join("\n")).not.toContain("the new plan");
    expect(smoke.join("\n")).not.toContain("One runtime dep");
  });

  it("returns [] when the plan emitted no $SMOKE block", () => {
    expect(parseSmokeBlock("$VERIFY\ncargo build\n$TICKETS\n[]")).toEqual([]);
  });

  it("returns [] when the $SMOKE block is empty or NONE", () => {
    expect(parseSmokeBlock("$VERIFY\ncargo build\n$SMOKE\nNONE\n$TICKETS\n[]")).toEqual([]);
    expect(parseSmokeBlock("$SMOKE\n\n$TICKETS\n[]")).toEqual([]);
  });
});

describe("parseDesignBlock (#34)", () => {
  it("extracts the body between $DESIGN and $END", () => {
    const text = `$VERIFY
cargo build
$SMOKE
cargo run
$DESIGN
A roguelike with oppressive atmosphere.
Visual identity: desaturated palette, parallax backgrounds.
$END
$TICKETS
[]`;
    const result = parseDesignBlock(text);
    expect(result).toContain("roguelike with oppressive atmosphere");
    expect(result).toContain("desaturated palette");
  });

  it("returns null when no $DESIGN marker is present", () => {
    expect(parseDesignBlock("$VERIFY\ncargo build\n$TICKETS\n[]")).toBeNull();
  });

  it("returns null when $DESIGN block is empty", () => {
    expect(parseDesignBlock("$DESIGN\n\n$END\n$TICKETS\n[]")).toBeNull();
    expect(parseDesignBlock("$DESIGN\n$END\n$TICKETS\n[]")).toBeNull();
  });

  it("handles missing $END by stopping at the next sibling marker", () => {
    const text = `$DESIGN
A dark atmospheric game.
$ARCHITECTURE
Modules: engine, renderer, juice.
$END
$TICKETS
[]`;
    const result = parseDesignBlock(text);
    expect(result).toContain("dark atmospheric game");
    expect(result).not.toContain("Modules");
  });

  it("tolerates case-insensitive markers", () => {
    const text = `$design
A design doc.
$end
$TICKETS
[]`;
    const result = parseDesignBlock(text);
    expect(result).toBe("A design doc.");
  });

  it("works alongside $ARCHITECTURE without swallowing it", () => {
    const text = `$DESIGN
Design intent here.
$END
$ARCHITECTURE
Architecture intent here.
$END
$TICKETS
[]`;
    expect(parseDesignBlock(text)).toBe("Design intent here.");
    expect(parseArchitectureBlock(text)).toBe("Architecture intent here.");
  });
});

describe("parseArchitectureBlock (#34)", () => {
  it("extracts the body between $ARCHITECTURE and $END", () => {
    const text = `$ARCHITECTURE
Module map: engine -> renderer -> juice.
Rationale: split rendering from logic for testability.
$END
$TICKETS
[]`;
    const result = parseArchitectureBlock(text);
    expect(result).toContain("Module map");
    expect(result).toContain("Rationale");
  });

  it("returns null when no $ARCHITECTURE marker is present", () => {
    expect(parseArchitectureBlock("$DESIGN\nA design.\n$END\n$TICKETS\n[]")).toBeNull();
  });

  it("returns null when $ARCHITECTURE block is empty", () => {
    expect(parseArchitectureBlock("$ARCHITECTURE\n$END\n$TICKETS\n[]")).toBeNull();
  });

  it("handles missing $END by stopping at the next sibling marker", () => {
    const text = `$ARCHITECTURE
Architecture intent.
$DESIGN
Design intent.
$END
$TICKETS
[]`;
    const result = parseArchitectureBlock(text);
    expect(result).toBe("Architecture intent.");
  });

  it("tolerates case-insensitive markers", () => {
    const text = `$architecture
Structural decisions.
$end
$TICKETS
[]`;
    expect(parseArchitectureBlock(text)).toBe("Structural decisions.");
  });
});

describe("parsePlanJson — group field (#19)", () => {
  it("reads group from the plan JSON", () => {
    const out = parsePlanJson(
      '[{"title":"x","what":"w","criteria":[],"blocked_by":[],"group":"core-engine"}]',
    );
    expect(out[0].group).toBe("core-engine");
  });

  it("defaults group to undefined when absent", () => {
    const out = parsePlanJson('[{"title":"x","what":"w","criteria":[],"blocked_by":[]}]');
    expect(out[0].group).toBeUndefined();
  });

  it("treats empty group string as undefined", () => {
    const out = parsePlanJson(
      '[{"title":"x","what":"w","criteria":[],"blocked_by":[],"group":""}]',
    );
    expect(out[0].group).toBeUndefined();
  });
});

describe("extendBlockedBy (#19)", () => {
  const mk = (file: string, blocked_by: string[] = []): import("../core/ticket.ts").Ticket => ({
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: file,
    mission: "m",
    what: "w",
    blocked_by,
    criteria: [],
    files: [],
    references: [],
    introduces: [],
  });

  it("appends corrective files to uncommitted tickets' blocked_by", () => {
    const tickets = [
      mk("01-a.md"),
      mk("02-b.md", ["01-a.md"]),
      mk("03-c.md", ["01-a.md"]),
    ];
    const result = extendBlockedBy(tickets, ["99-goal-fix.md"], (f) => f === "01-a.md");
    expect(result[0].blocked_by).toEqual([]);
    expect(result[1].blocked_by).toEqual(["01-a.md", "99-goal-fix.md"]);
    expect(result[2].blocked_by).toEqual(["01-a.md", "99-goal-fix.md"]);
  });

  it("does not modify committed tickets' blocked_by", () => {
    const tickets = [
      mk("01-a.md"),
      mk("02-b.md", ["01-a.md"]),
    ];
    const result = extendBlockedBy(tickets, ["05-fix.md"], (f) => f === "01-a.md" || f === "02-b.md");
    expect(result[0].blocked_by).toEqual([]);
    expect(result[1].blocked_by).toEqual(["01-a.md"]);
  });

  it("deduplicates when a corrective file is already in blocked_by", () => {
    const tickets = [
      mk("01-a.md"),
      mk("02-b.md", ["01-a.md", "99-goal-fix.md"]),
    ];
    const result = extendBlockedBy(tickets, ["99-goal-fix.md"], (f) => f === "01-a.md");
    expect(result[1].blocked_by).toEqual(["01-a.md", "99-goal-fix.md"]);
  });

  it("returns unchanged when correctiveFiles is empty", () => {
    const tickets = [mk("01-a.md"), mk("02-b.md", ["01-a.md"])];
    const result = extendBlockedBy(tickets, [], () => false);
    expect(result).toBe(tickets);
  });

  it("appends multiple corrective files", () => {
    const tickets = [mk("01-a.md"), mk("02-b.md")];
    const result = extendBlockedBy(tickets, ["06-fix-1.md", "07-fix-2.md"], () => false);
    expect(result[0].blocked_by).toEqual(["06-fix-1.md", "07-fix-2.md"]);
    expect(result[1].blocked_by).toEqual(["06-fix-1.md", "07-fix-2.md"]);
  });

  it("does not mutate the input array", () => {
    const tickets = [mk("01-a.md"), mk("02-b.md", ["01-a.md"])];
    const originalBlockedBy = [...tickets[1].blocked_by];
    extendBlockedBy(tickets, ["05-fix.md"], () => false);
    expect(tickets[1].blocked_by).toEqual(originalBlockedBy);
  });

  it("never adds inter-corrective edges — corrective tickets do not block each other (#63)", () => {
    // Three corrective tickets created at once + one planned ticket. Each
    // corrective ticket must NOT get another corrective ticket's file in its
    // blocked_by (they are processed inline in order), or they form a mutual
    // cycle (14→15→16→14) that no frontier selection can ever break.
    const corrective = [mk("14-fix-a.md"), mk("15-fix-b.md"), mk("16-fix-c.md")];
    const planned = mk("05-plan.md");
    const result = extendBlockedBy([planned, ...corrective], ["14-fix-a.md", "15-fix-b.md", "16-fix-c.md"], () => false);
    const plannedOut = result.find((t) => t.file === "05-plan.md")!;
    expect(plannedOut.blocked_by).toEqual(["14-fix-a.md", "15-fix-b.md", "16-fix-c.md"]);
    for (const c of corrective) {
      const out = result.find((t) => t.file === c.file)!;
      for (const f of ["14-fix-a.md", "15-fix-b.md", "16-fix-c.md"]) {
        if (f !== c.file) expect(out.blocked_by).not.toContain(f);
      }
    }
    // And the resulting graph has no cycles.
    expect(scanTicketConflicts(result).errors).toEqual([]);
  });
});

describe("scanTicketConflicts (#48)", () => {
  const mk = (
    file: string,
    over: Partial<import("../core/ticket.ts").Ticket> = {},
  ): import("../core/ticket.ts").Ticket => ({
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: file,
    mission: "m",
    what: "w",
    blocked_by: [],
    criteria: [],
    files: [],
    references: [],
    introduces: [],
    ...over,
  });

  it("returns no findings on a clean, ordered plan", () => {
    const tickets = [
      mk("01-a.md"),
      mk("02-b.md", { blocked_by: ["01-a.md"] }),
      mk("03-c.md", { blocked_by: ["02-b.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors).toEqual([]);
    expect(report.classA).toEqual([]);
    expect(report.classB).toEqual([]);
  });

  it("flags a dangling blocked_by reference as a hard error", () => {
    const tickets = [
      mk("01-a.md"),
      mk("02-b.md", { blocked_by: ["99-does-not-exist.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toMatch(/dangling/i);
    expect(report.errors[0]).toContain("99-does-not-exist.md");
    expect(report.classA).toEqual([]);
  });

  it("flags duplicate introduces symbols across tickets as a class-A finding (#86)", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet", "farewell"] }),
      mk("02-b.md", { introduces: ["greet", "depart"], blocked_by: ["01-a.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors).toEqual([]);
    expect(report.classA.length).toBe(1);
    expect(report.classA[0].kind).toBe("duplicate-introduces");
    expect(report.classA[0].cls).toBe("classA");
    expect(report.classA[0].message).toMatch(/duplicate.*introduces/i);
    expect(report.classA[0].message).toContain("greet");
    // The finding carries a deterministic slug-identity key (ADR 0027) for
    // ruling lookup — the `NN-` ordering prefix never appears in it.
    expect(report.classA[0].key).toBe("dup-introduce:greet:a:b");
    expect(report.classA[0].message).toContain("01-a.md");
  });

  it("does not flag introduces as duplicate when only one ticket declares the symbol", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { introduces: ["farewell"], blocked_by: ["01-a.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.classA).toEqual([]);
  });

  it("flags two unordered tickets that touch the same file as a class-A finding (#86)", () => {
    const tickets = [
      mk("01-a.md", { files: ["src/engine.ts"] }),
      mk("02-b.md", { files: ["src/engine.ts", "src/ui.ts"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors).toEqual([]);
    expect(report.classA.length).toBe(1);
    expect(report.classA[0].kind).toBe("unordered-same-file");
    expect(report.classA[0].cls).toBe("classA");
    expect(report.classA[0].message).toMatch(/touch.*no.*ordering|same.*file/i);
    expect(report.classA[0].message).toContain("src/engine.ts");
    // Human message names the full files; the key carries slug identity only.
    expect(report.classA[0].message).toContain("01-a.md");
    expect(report.classA[0].message).toContain("02-b.md");
    expect(report.classA[0].key).toBe("same-file:a:b");
  });

  it("does not flag same-file tickets when an ordering edge exists between them", () => {
    const tickets = [
      mk("01-a.md", { files: ["src/engine.ts"] }),
      mk("02-b.md", { files: ["src/engine.ts"], blocked_by: ["01-a.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.classA).toEqual([]);
  });

  it("flags a cycle introduced by extendBlockedBy as a hard error", () => {
    // Two tickets that block each other — a cycle orderTickets would have
    // caught at plan time, but extendBlockedBy can introduce one at runtime
    // when corrective tickets mis-extend. The scanner must catch it.
    const tickets = [
      mk("01-a.md", { blocked_by: ["02-b.md"] }),
      mk("02-b.md", { blocked_by: ["01-a.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toMatch(/cycle/i);
  });

  it("returns an empty report for an empty ticket set", () => {
    const report = scanTicketConflicts([]);
    expect(report.errors).toEqual([]);
    expect(report.classA).toEqual([]);
    expect(report.classB).toEqual([]);
  });

  it("does not flag self-blocked_by entries (already dropped by orderTickets)", () => {
    const tickets = [mk("01-a.md", { blocked_by: ["01-a.md"] })];
    const report = scanTicketConflicts(tickets);
    expect(report.errors).toEqual([]);
  });

  it("flags a 3-ticket cycle (a→b→c→a) as a hard error", () => {
    const tickets = [
      mk("01-a.md", { blocked_by: ["03-c.md"] }),
      mk("02-b.md", { blocked_by: ["01-a.md"] }),
      mk("03-c.md", { blocked_by: ["02-b.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toMatch(/cycle/i);
  });

  it("does not flag a cycle when dependencies form a valid diamond", () => {
    const tickets = [
      mk("01-a.md"),
      mk("02-b.md", { blocked_by: ["01-a.md"] }),
      mk("03-c.md", { blocked_by: ["01-a.md"] }),
      mk("04-d.md", { blocked_by: ["02-b.md", "03-c.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors).toEqual([]);
  });

  it("flags same-file overlap across three tickets when none are ordered", () => {
    const tickets = [
      mk("01-a.md", { files: ["src/x.ts"] }),
      mk("02-b.md", { files: ["src/x.ts"] }),
      mk("03-c.md", { files: ["src/x.ts"] }),
    ];
    const report = scanTicketConflicts(tickets);
    const fileWarnings = report.classA.filter((w) => w.message.includes("src/x.ts"));
    expect(fileWarnings.length).toBe(3); // (a,b), (a,c), (b,c)
  });

  it("suppresses same-file warning when one transitively depends on the other", () => {
    const tickets = [
      mk("01-a.md", { files: ["src/x.ts"] }),
      mk("02-b.md", { files: ["src/x.ts"], blocked_by: ["01-a.md"] }),
      mk("03-c.md", { files: ["src/x.ts"], blocked_by: ["02-b.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.classA).toEqual([]);
  });
});

describe("issue #100 — gate findings and rulings identify tickets by slug, not NN", () => {
  const mk = (
    file: string,
    over: Partial<import("../core/ticket.ts").Ticket> = {},
  ): import("../core/ticket.ts").Ticket => ({
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: file,
    mission: "m",
    what: "w",
    blocked_by: [],
    criteria: [],
    files: [],
    references: [],
    introduces: [],
    ...over,
  });

  it("orderTickets disambiguates duplicate (or slug-equivalent) titles instead of aborting — the gate repair loop owns them", async () => {
    const t = (title: string, blocked_by: number[] = []): PlanTicket => ({
      title,
      what: "w",
      criteria: [],
      blocked_by,
      references: [],
      introduces: ["x"],
    });
    // Identical titles: first keeps the base slug, later colliders get -2, -3…
    const dup = await orderTickets([t("Layers system"), t("Layers system"), t("Layers system")]);
    expect(dup.map((x) => x.file)).toEqual(["01-layers-system.md", "02-layers-system-2.md", "03-layers-system-3.md"]);
    // Distinct titles that slugify to the same identity collide too.
    const equiv = await orderTickets([t("Layers system"), t("Layers!system")]);
    expect(equiv.map((x) => x.slug)).toEqual(["layers-system", "layers-system-2"]);
  });

  it("orderTickets still accepts two tickets whose slugs differ but whose titles share words", async () => {
    const out = await orderTickets([
      { title: "Render frames", what: "w", criteria: [], blocked_by: [], references: [], introduces: ["r"] },
      { title: "Render menus", what: "w", criteria: [], blocked_by: [], references: [], introduces: ["m"] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("duplicate titles surface as a class-A duplicate-slug finding (repairable), keyed by the stable base slug", async () => {
    const plan: PlanTicket[] = [
      { title: "Layers system", what: "w", criteria: [], blocked_by: [], references: [], introduces: [] },
      { title: "Layers!system", what: "w", criteria: [], blocked_by: [], references: [], introduces: [] },
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    expect(ordered).toHaveLength(2);
    expect(report.errors).toEqual([]);
    const dup = report.classA.filter((f) => f.kind === "duplicate-slug");
    // One finding per colliding group, naming both disambiguated files.
    expect(dup).toHaveLength(1);
    expect(dup[0].key).toBe("dup-slug:layers-system");
    expect(dup[0].tickets).toEqual(["01-layers-system.md", "02-layers-system-2.md"]);
    expect(dup[0].message).toContain("retitle");
  });

  it("an unorderable plan (dependency cycle) becomes a class-A unorderable-plan finding, not a throw", async () => {
    const plan: PlanTicket[] = [
      { title: "Alpha", what: "w", criteria: [], blocked_by: [1], references: [], introduces: [] },
      { title: "Beta", what: "w", criteria: [], blocked_by: [0], references: [], introduces: [] },
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    expect(ordered).toBeUndefined();
    expect(report.errors).toEqual([]);
    const finding = report.classA.find((f) => f.kind === "unorderable-plan");
    expect(finding).toBeDefined();
    expect(finding!.message).toMatch(/cycle/);
    expect(finding!.message).toMatch(/could not be ordered/);
  });

  it("same physical pair keeps the same-file slug key when an unrelated renumber shifts NN", () => {
    const scan = (alphaFile: string, betaFile: string) =>
      scanTicketConflicts([
        mk("01-root.md", { files: ["src/root.ts"], introduces: ["root"] }),
        mk(betaFile, { files: ["src/x.ts"], introduces: ["beta"] }),
        mk(alphaFile, { files: ["src/x.ts"], introduces: ["alpha"] }),
      ]);
    // Round 1: pair carries NN 02/03; round 2 an unrelated edge renumbered the
    // same physical pair to 05/06. The key must not move with NN.
    const round1 = scan("02-alpha.md", "03-beta.md");
    const round2 = scan("06-alpha.md", "05-beta.md");
    expect(round1.classA).toHaveLength(1);
    expect(round2.classA).toHaveLength(1);
    const k1 = round1.classA[0].key;
    const k2 = round2.classA[0].key;
    expect(k1).toBe("same-file:alpha:beta");
    expect(k2).toBe(k1);
    expect(k1).not.toMatch(/\d/);
    // tickets stays the sorted full-file pair of the scan that produced it.
    expect(round1.classA[0].tickets).toEqual(["02-alpha.md", "03-beta.md"]);
    expect(round2.classA[0].tickets).toEqual(["05-beta.md", "06-alpha.md"]);
    // The human-facing message names the full files, not bare NN numbers.
    expect(round1.classA[0].message).toContain("02-alpha.md");
    expect(round1.classA[0].message).toContain("03-beta.md");
    expect(round1.classA[0].message).not.toMatch(/tickets 0[23] and/);
  });

  it("the duplicate-introduces key is slug-only and survives a renumber", () => {
    const scan = (aFile: string, bFile: string) =>
      scanTicketConflicts([
        mk(aFile, { introduces: ["greet"] }),
        mk(bFile, { introduces: ["greet"], blocked_by: [aFile] }),
      ]);
    const k1 = scan("04-a.md", "07-b.md").classA[0].key;
    const k2 = scan("01-a.md", "09-b.md").classA[0].key;
    expect(k1).toBe("dup-introduce:greet:a:b");
    expect(k2).toBe(k1);
  });

  it("a $RULINGS adjudication from round 1 suppresses the identical finding when round 2's scan shows a different NN", () => {
    const round2 = scanTicketConflicts([
      mk("01-root.md", { files: ["src/root.ts"], introduces: ["root"] }),
      mk("05-beta.md", { files: ["src/x.ts"], introduces: ["beta"] }),
      mk("06-alpha.md", { files: ["src/x.ts"], introduces: ["alpha"] }),
    ]);
    expect(round2.classA).toHaveLength(1);
    const ruling: Ruling = {
      key: "same-file:alpha:beta", // recorded in round 1, when the pair was 02/03
      finding: round2.classA[0].message,
      reason: "intentional — parallel edits to distinct regions",
      source: "plan",
      tickets: round2.classA[0].tickets,
    };
    expect(outstandingFindings(round2, [ruling])).toEqual([]);
  });

  it("a plan-time ruling key still suppresses the same physical pair at runtime via assessRuntimeExtension", () => {
    // Plan file names and run file names disagree on NN for the same pair.
    const tickets = [
      mk("02-a.md", { introduces: ["greet"] }),
      mk("07-b.md", { introduces: ["greet"], blocked_by: ["02-a.md"] }),
    ];
    const ruling: Ruling = {
      key: "dup-introduce:greet:a:b", // recorded at plan time when files were 01-a.md/04-b.md
      finding: "duplicate introduces: symbol \"greet\" ...",
      reason: "intentional — same symbol reused as a local in a separate module",
      source: "plan",
      tickets: ["01-a.md", "04-b.md"],
    };
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: [],
      committedFiles: [],
      planRulings: [ruling],
    });
    expect(fatal).toEqual([]);
    expect(rulings).toEqual([]);
  });
});

describe("issue #100 — the repair table speaks array coordinates, never NN", () => {
  const pt = (over: Partial<PlanTicket> & { title: string }): PlanTicket => ({
    mission: "m",
    what: "w",
    criteria: [],
    blocked_by: [],
    files: [],
    references: [],
    introduces: [`contract-${over.title.toLowerCase()}`],
    ...over,
  });

  it("addresses each involved ticket by its live array index + title when index ≠ NN", async () => {
    // Array order differs from Kahn order on purpose: Alpha sits at array index
    // 1 but is numbered 04 (Beta, at array index 2, is numbered 02), so NN and
    // array index diverge — exactly the spriteforge confusion.
    const plan = [
      pt({ title: "Root", introduces: ["root"] }),
      pt({ title: "Alpha", files: ["src/x.ts"], blocked_by: [0], introduces: ["alpha"] }),
      pt({ title: "Beta", files: ["src/x.ts"], introduces: ["beta"] }),
      pt({ title: "Extra", introduces: ["extra"] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    // These plans are orderable — the gate never returns undefined here.
    expect(ordered).toBeDefined();
    expect(ordered!.map((t) => t.number)).toEqual(["01", "04", "02", "03"]);
    const sameFile = report.classA.filter((f) => f.kind === "unordered-same-file");
    expect(sameFile).toHaveLength(1);

    const table = tableFindings(report, ordered);
    const row = repairRowText(table.find((f) => f.id === "A1")!);
    // The coordinate is the array index the model's blocked_by actually uses,
    // identified by title — Beta at index 2, Alpha at index 1.
    expect(row).toContain("at array index 2 (Beta)");
    expect(row).toContain("at array index 1 (Alpha)");
    expect(row).not.toContain("04-alpha");
    expect(row).not.toContain("02-beta");
    // No ordering-derived number leaked into the row.
    expect(row).not.toMatch(/\b0\d\b/);

    // And the indices are actionable: making Beta (array index 2) depend on
    // Alpha (array index 1) via blocked_by [1] clears the finding.
    const fixed = plan.map((p) => ({ ...p, blocked_by: p.title === "Beta" ? [1] : p.blocked_by }));
    const { report: fixedReport } = await scanPlanConflicts(fixed);
    expect(fixedReport.classA).toEqual([]);
  });

  it("buildPlanRepairPrompt renders the coordinate table and states the identity rules", async () => {
    const plan = [
      pt({ title: "Root", introduces: ["root"] }),
      pt({ title: "Alpha", files: ["src/x.ts"], blocked_by: [0], introduces: ["alpha"] }),
      pt({ title: "Beta", files: ["src/x.ts"], introduces: ["beta"] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    const table = tableFindings(report, ordered);
    const prompt = buildPlanRepairPrompt({
      ticketsJson: JSON.stringify(plan),
      table,
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    // The model-facing table names tickets the way the model edits them.
    expect(prompt).toContain("at array index 2 (Beta)");
    expect(prompt).toContain("at array index 1 (Alpha)");
    expect(prompt).not.toContain("03-alpha");
    // The two identity rules ride with the array-order and retitle instructions.
    expect(prompt).toMatch(/PRESERVE the order of the JSON array/i);
    expect(prompt).toMatch(/blocked_by.*0-based positions/i);
    expect(prompt).toMatch(/Do NOT retitle/i);
    expect(prompt).toMatch(/do NOT retitle a ticket you are keeping/i);
    // The duplicate-slug fix is the recorded exception to the no-retitle rule.
    expect(prompt).toMatch(/duplicate-slug fix is the one exception/i);
  });
});

describe("assessRuntimeExtension (#86) — runtime corrective policy", () => {
  const mk = (
    file: string,
    over: Partial<import("../core/ticket.ts").Ticket> = {},
  ): import("../core/ticket.ts").Ticket => ({
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: file,
    mission: "m",
    what: "w",
    blocked_by: [],
    criteria: [],
    files: [],
    references: [],
    introduces: [],
    ...over,
  });

  it("Case A: a corrective re-introducing a committed ticket's symbol is auto-ruled redefinition, not an abort", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-fix.md", { introduces: ["greet"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: ["02-fix.md"],
      committedFiles: ["01-a.md"],
      planRulings: [],
    });
    expect(fatal).toEqual([]);
    expect(rulings).toHaveLength(1);
    expect(rulings[0].source).toBe("runtime");
    expect(rulings[0].key).toBe("dup-introduce:greet:a:fix");
    expect(rulings[0].reason).toMatch(/redefinition/);
  });

  it("Case B: a corrective vs uncommitted planned ticket is auto-ruled defect-fix precedence, not an abort", () => {
    const tickets = [
      mk("03-plan.md", { introduces: ["greet"] }),
      mk("04-fix.md", { introduces: ["greet"], blocked_by: ["03-plan.md"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: ["04-fix.md"],
      committedFiles: [],
      planRulings: [],
    });
    expect(fatal).toEqual([]);
    expect(rulings).toHaveLength(1);
    expect(rulings[0].reason).toMatch(/defect-fix precedence/);
    expect(rulings[0].reason).toContain("03-plan.md");
  });

  it("Case C: a class-A finding between two NON-corrective tickets is a railhead defect abort", () => {
    const tickets = [
      mk("03-plan.md", { files: ["src/x.ts"] }),
      mk("04-plan2.md", { files: ["src/x.ts"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: [],
      committedFiles: [],
      planRulings: [],
    });
    expect(rulings).toEqual([]);
    expect(fatal.length).toBe(1);
    expect(fatal[0]).toMatch(/plan invariant violated at runtime/);
    expect(fatal[0]).toContain("03-plan.md");
    expect(fatal[0]).toContain("04-plan2.md");
  });

  it("a plan-time ruling suppresses the identical finding at runtime (ruled plan does not re-fire)", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { introduces: ["greet"] }),
    ];
    const ruling: Ruling = {
      key: "dup-introduce:greet:a:b",
      finding: "duplicate introduces: symbol \"greet\" ...",
      reason: "intentional — same symbol reused as a local in a separate module",
      source: "plan",
      tickets: ["01-a.md", "02-b.md"],
    };
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: [],
      committedFiles: [],
      planRulings: [ruling],
    });
    expect(fatal).toEqual([]);
    expect(rulings).toEqual([]);
  });

  it("a committed-vs-committed duplicate-introduce pair is inert (both already done)", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { introduces: ["greet"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: [],
      committedFiles: ["01-a.md", "02-b.md"],
      planRulings: [],
    });
    expect(fatal).toEqual([]);
    expect(rulings).toEqual([]);
  });
});

describe("scanOrderedConflicts — class B quality findings (#86)", () => {
  const mk = (
    file: string,
    over: Partial<import("../core/ticket.ts").Ticket> = {},
  ): import("../core/ticket.ts").Ticket => ({
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: file,
    mission: "m",
    what: "w",
    blocked_by: [],
    criteria: [],
    files: [],
    references: [],
    introduces: [],
    ...over,
  });

  it("flags no consumes/produces on a >1-ticket plan as class B, but not on a 1-ticket plan", () => {
    const alone = scanOrderedConflicts([mk("01-a.md")]);
    expect(alone.classB.filter((f) => f.kind === "no-contracts")).toEqual([]);

    const multi = scanOrderedConflicts(
      [mk("01-a.md"), mk("02-b.md", { blocked_by: ["01-a.md"] })],
    );
    const noContracts = multi.classB.filter((f) => f.kind === "no-contracts");
    expect(noContracts.length).toBe(2);
    expect(noContracts[0].cls).toBe("classB");
    expect(noContracts[0].message).toMatch(/consumes/);
    // Declaring contracts clears it.
    const declared = scanOrderedConflicts(
      [
        mk("01-a.md", { introduces: ["x"] }),
        mk("02-b.md", { references: ["x"], blocked_by: ["01-a.md"] }),
      ],
    );
    expect(declared.classB.filter((f) => f.kind === "no-contracts")).toEqual([]);
  });

  it("never flags file count — the durable builder is not a context window (sizing rules removed)", () => {
    const tickets = [
      mk("01-a.md", { files: ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts", "f6.ts"] }),
    ];
    const report = scanOrderedConflicts(tickets);
    expect(report.classB.map((f) => f.kind as string)).not.toContain("file-count");
  });

  it("flags placeholder language as a class-B finding even on a 1-ticket plan", () => {
    const report = scanOrderedConflicts([
      mk("01-a.md", { what: "wire the db (TBD)", introduces: ["db"] }),
    ]);
    const ph = report.classB.filter((f) => f.kind === "placeholder");
    expect(ph.length).toBeGreaterThan(0);
    expect(ph[0].cls).toBe("classB");
    expect(ph[0].message).toMatch(/TBD/i);
  });

  it("keys placeholder findings by content, not scan position, so a ruling survives re-scans", () => {
    const keyFor = (what: string, needle: string) => {
      const report = scanOrderedConflicts([mk("01-a.md", { what, introduces: ["db"] })]);
      return report.classB
        .filter((f) => f.kind === "placeholder")
        .find((f) => f.message.includes(needle))!.key;
    };
    const tbdAlone = keyFor("wire db (TBD)", "TBD");
    expect(tbdAlone).toBe("placeholder:a:body:TBD");
    // Adding a sibling placeholder must not shift TBD's key.
    const tbdWithSibling = keyFor("wire db (TBD) and cache (TODO)", "TBD");
    expect(tbdWithSibling).toBe(tbdAlone);
  });
});

describe("plan gate table + adjudication (#86)", () => {
  const mk = (
    file: string,
    over: Partial<import("../core/ticket.ts").Ticket> = {},
  ): import("../core/ticket.ts").Ticket => ({
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: file,
    mission: "m",
    what: "w",
    blocked_by: [],
    criteria: [],
    files: [],
    references: [],
    introduces: [],
    ...over,
  });

  it("assigns stable A/B ids and lists class A before class B", () => {
    const report = scanOrderedConflicts(
      [
        mk("01-a.md", { introduces: ["dup"] }),
        mk("02-b.md", { introduces: ["dup"], blocked_by: ["01-a.md"] }),
        mk("03-c.md"),
      ],
    );
    const table = tableFindings(report);
    expect(table[0].id).toBe("A1");
    expect(table[0].kind).toBe("duplicate-introduces");
    expect(table[table.length - 1].id).toMatch(/^B/);
  });

  it("outstandingFindings keeps only findings whose key is not already ruled", () => {
    const report = scanOrderedConflicts([
      mk("01-a.md", { introduces: ["dup"] }),
      mk("02-b.md", { introduces: ["dup"], blocked_by: ["01-a.md"] }),
    ]);
    const a1 = tableFindings(report)[0];
    const none = outstandingFindings(report, [
      { key: a1.key, finding: a1.message, reason: "intentional", source: "plan", tickets: a1.tickets },
    ]);
    expect(none).toEqual([]);
  });

  it("parseRulings reads id: reason lines and tolerates malformed ones", () => {
    const text = `some prose\n$RULINGS\nA1 intentional — same symbol, different module\nBOGUS no colon here\nA2:\nB3 ruled — okay\n$END\nmore`;
    expect(parseRulings(text)).toEqual([
      { id: "A1", reason: "intentional — same symbol, different module" },
      { id: "B3", reason: "ruled — okay" },
    ]);
  });
});

describe("placeholderWarnings (#44)", () => {
  const mk = (title: string, over: Partial<PlanTicket> = {}): PlanTicket => ({
    title,
    mission: "m",
    what: "w",
    criteria: [],
    blocked_by: [],
    ...over,
  });

  it("returns no warnings on a clean ticket set with explicit references and introduces", () => {
    const tickets = [
      mk("Engine core", {
        what: "Build the engine",
        introduces: ["createEngine"],
        references: [],
      }),
      mk("Renderer", {
        what: "Render frames",
        introduces: ["renderFrame"],
        references: ["createEngine"],
        blocked_by: [0],
      }),
    ];
    expect(placeholderWarnings(tickets)).toEqual([]);
  });

  it("warns when a ticket body contains 'TBD'", () => {
    const tickets = [
      mk("A", { what: "implement the database layer (TBD)", introduces: ["createDb"], references: [] }),
    ];
    const w = placeholderWarnings(tickets);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/TBD/i);
  });

  it("warns when a ticket body contains 'implement later'", () => {
    const tickets = [
      mk("A", { what: "build the CLI, implement later", introduces: ["buildCli"], references: [] }),
    ];
    const w = placeholderWarnings(tickets);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/implement later/i);
  });

  it("warns when a ticket body contains 'add appropriate error handling'", () => {
    const tickets = [
      mk("A", { what: "add appropriate error handling to the server", introduces: ["handleErrors"], references: [] }),
    ];
    const w = placeholderWarnings(tickets);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/appropriate error handling/i);
  });

  it("warns when introduces contains a literal template placeholder like newSymbol", () => {
    const tickets = [
      mk("A", { what: "setup", introduces: ["newSymbol"], references: ["realContract"] }),
    ];
    const w = placeholderWarnings(tickets);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/placeholder|template/i);
    expect(w[0]).toContain("newSymbol");
  });

  it("warns when references contains a literal template placeholder like existingSymbol", () => {
    const tickets = [
      mk("A", { what: "setup", introduces: ["realContract"], references: ["existingSymbol"] }),
    ];
    const w = placeholderWarnings(tickets);
    expect(w.length).toBe(1);
    expect(w[0]).toContain("existingSymbol");
  });

  it("warns when a ticket has neither references nor introduces (missing consumes/produces) on a multi-ticket plan", () => {
    // Issue #86: the finding's premise is counterparty existence — a one-ticket
    // plan is both first and last, so both-empty is the prompt-sanctioned
    // answer and must NOT be flagged.
    const alone = [mk("A", { what: "build something", references: undefined, introduces: undefined })];
    expect(placeholderWarnings(alone)).toEqual([]);
    const tickets = [
      mk("A", { what: "build something", references: undefined, introduces: undefined }),
      mk("B", { what: "build more", blocked_by: [0], introduces: ["b"] }),
    ];
    const w = placeholderWarnings(tickets);
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/consumes|produces|references.*introduces|missing/i);
  });

  it("does not warn on the first ticket having empty references (nothing to consume yet)", () => {
    const tickets = [
      mk("Foundation", { what: "establish the world", introduces: ["createWorld"], references: [] }),
    ];
    expect(placeholderWarnings(tickets)).toEqual([]);
  });

  it("returns no warnings on an empty ticket set", () => {
    expect(placeholderWarnings([])).toEqual([]);
  });
});

describe("plan header and consumes/produces (#44)", () => {
  it("requires a Spec back-pointer in the plan header", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/Spec:/i);
  });

  it("requires Global Constraints in the plan header", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/Global Constraints/i);
  });

  it("requires a Goal in the $DESIGN block", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/Goal:/i);
  });

  it("requires a Tech Stack in the $ARCHITECTURE block", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/Tech Stack:/i);
  });

  it("requires $DESIGN and $ARCHITECTURE blocks (not optional)", () => {
    const prompt = planDesignSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/\$DESIGN/);
    expect(prompt).toMatch(/\$ARCHITECTURE/);
    expect(prompt).not.toMatch(/OPTIONAL/i);
  });

  it("requires per-ticket Consumes and Produces (references + introduces must be explicit)", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/consumes|references/i);
    expect(prompt).toMatch(/produces|introduces/i);
  });

  it("includes a no-placeholders rule", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/no.*placeholder/i);
    expect(prompt).toMatch(/TBD/i);
  });
});

describe("round-trip parse of a compliant plan (#44)", () => {
  it("parses a fully compliant plan with header, consumes/produces, and no placeholders", () => {
    const planOutput = [
      "$VERIFY",
      "npm test",
      "$SMOKE",
      "npm start",
      "$DESIGN",
      "Goal: a CLI that greets users by name.",
      "A warm, minimal tool with a friendly tone.",
      "$END",
      "$ARCHITECTURE",
      "Spec: issue #44 — build a greeter CLI.",
      "Tech Stack: TypeScript, Node.js, vitest.",
      "Global Constraints: ANSI-only output, no external deps.",
      "Two modules: arg parsing and greeting formatting.",
      "$END",
      "$TICKETS",
      JSON.stringify([
        {
          title: "Greeting formatter",
          mission: "a CLI that greets users by name",
          what: "Format a personalized greeting from a name string",
          criteria: ["returns 'Hello, Alice!' for input 'Alice'"],
          blocked_by: [],
          files: ["src/greet.ts"],
          references: [],
          introduces: ["formatGreeting"],
          testable: true,
        },
        {
          title: "CLI entry point",
          mission: "a CLI that greets users by name",
          what: "Wire argv to the greeting formatter and print",
          criteria: ["prints greeting for the given name"],
          blocked_by: [0],
          files: ["src/main.ts"],
          references: ["formatGreeting"],
          introduces: ["main"],
          testable: true,
        },
      ]),
    ].join("\n");

    const design = parseDesignBlock(planOutput);
    expect(design).not.toBeNull();
    expect(design).toContain("Goal:");

    const arch = parseArchitectureBlock(planOutput);
    expect(arch).not.toBeNull();
    expect(arch).toContain("Spec:");
    expect(arch).toContain("Tech Stack:");
    expect(arch).toContain("Global Constraints");

    const tickets = parsePlanJson(planOutput);
    expect(tickets.length).toBe(2);
    expect(tickets[0].introduces).toEqual(["formatGreeting"]);
    expect(tickets[1].references).toEqual(["formatGreeting"]);

    expect(placeholderWarnings(tickets)).toEqual([]);
  });
});
describe("parseCoherenceContract (issue #99 / ADR 0028)", () => {
  const designWithCharter = `A retro-neon browser snake. Neon glow on #050510, gliding movement.

## Coherence contract
Terse contract intro.

### Visual tokens
NEON palette from src/ui/tokens.ts; 4px spacing scale; radius 8.

### Layout model
Canvas centered 1280x800; rails either side; no scroll.

### Chrome rules
The single toolbar recipe; do not introduce a competing style.

## Another section after the charter
This must stay outside the slice.`;

  it("slices the section out of a $DESIGN block, stopping at the next ## heading", () => {
    const text = `$DESIGN
${designWithCharter}
$END
$TICKETS
[]`;
    const doc = parseDesignBlock(text)!;
    const c = parseCoherenceContract(doc);
    expect(c).not.toBeNull();
    expect(c!).toContain("### Visual tokens");
    expect(c!).toContain("NEON palette");
    expect(c!).toContain("do not introduce a competing style");
    expect(c!).not.toContain("Another section after the charter");
  });

  it("returns null when the section is absent (a pure-model plan)", () => {
    const text = `$DESIGN
A pure model library. No rendered surface.
$END
$TICKETS
[]`;
    expect(parseCoherenceContract(parseDesignBlock(text)!)).toBeNull();
  });

  it("returns null when no $DESIGN block exists at all", () => {
    expect(parseCoherenceContract("$VERIFY\ncargo build\n$TICKETS\n[]")).toBeNull();
    expect(parseCoherenceContract("")).toBeNull();
  });

  it("tolerates a truncated section (heading with no body → null, no crash)", () => {
    expect(parseCoherenceContract("## Coherence contract\n\n\n## Next")).toBeNull();
  });

  it("ignores a mid-line mention (line-anchored heading) and a wrong-level heading without crashing", () => {
    expect(parseCoherenceContract("prose mentioning ## Coherence contract mid-line\n\nmore")).toBeNull();
    expect(parseCoherenceContract("# Coherence contract (wrong level)\nbody")).toBeNull();
  });

  it("keeps ### subsections inside the slice and ends at the next ## heading", () => {
    const doc = `## Coherence contract
### Visual tokens
x

### Layout model
y
## Layout end`;
    expect(parseCoherenceContract(doc)).toBe("### Visual tokens\nx\n\n### Layout model\ny");
  });
});

describe("splitCoherenceContract (issue #99 / ADR 0028 — persisted once, never a stale twin)", () => {
  const designWithCharter = `A retro-neon browser snake. Neon glow on #050510, gliding movement.

## Coherence contract
Terse contract intro.

### Visual tokens
NEON palette from src/ui/tokens.ts; 4px spacing scale; radius 8.

### Layout model
Canvas centered 1280x800; rails either side; no scroll.

### Chrome rules
The single toolbar recipe; do not introduce a competing style.

## Another section after the charter
This must stay outside the slice.`;

  it("splits the block: the narrative keeps everything except the charter section", () => {
    const { narrative, charter } = splitCoherenceContract(designWithCharter);
    expect(narrative).toContain("A retro-neon browser snake.");
    expect(narrative).toContain("Another section after the charter");
    expect(narrative).toContain("This must stay outside the slice.");
    expect(narrative).not.toContain("Coherence contract");
    expect(narrative).not.toContain("NEON palette");
    expect(charter).toBe(parseCoherenceContract(designWithCharter));
  });

  it("round-trips a charter-last block: narrative + heading + charter reconstructs it", () => {
    const doc = "Narrative intro.\n\n## Coherence contract\n### Visual tokens\nx";
    const { narrative, charter } = splitCoherenceContract(doc);
    expect(`${narrative}\n\n## Coherence contract\n${charter}`).toBe(doc);
  });

  it("an absent section returns the input unchanged as the narrative", () => {
    const doc = "A pure model library. No rendered surface.";
    expect(splitCoherenceContract(doc)).toEqual({ narrative: doc, charter: null });
  });

  it("a charter-only block yields a null narrative — no empty design doc is written", () => {
    const doc = "## Coherence contract\n### Visual tokens\nx";
    const { narrative, charter } = splitCoherenceContract(doc);
    expect(narrative).toBeNull();
    expect(charter).toBe("### Visual tokens\nx");
  });

  it("an empty-section body is inert: no charter, narrative unchanged (mirrors parseCoherenceContract)", () => {
    const doc = "Narrative only.\n\n## Coherence contract\n\n\n## Next heading\nTail.";
    const { narrative, charter } = splitCoherenceContract(doc);
    expect(charter).toBeNull();
    expect(narrative).toBe(doc);
  });
});

describe("coherence charter request (issue #99)", () => {
  it("requests the ## Coherence contract subsection for surfaced builds", () => {
    const p = planDesignSystemPrompt({ contractsSummary: "(none)" });
    expect(p).toContain("## Coherence contract");
    expect(p).toContain("### Visual tokens");
    expect(p).toContain("### Layout model");
    expect(p).toContain("### Chrome rules");
    expect(p).toContain("omit the section entirely");
  });

  it("does not request a charter in fix mode (fix plans never author docs/coherence.md)", () => {
    const p = planFixSystemPrompt("(none)");
    expect(p).not.toContain("## Coherence contract");
  });
});

describe("issue #103 — implied ordering edges auto-resolve without a model round", () => {
  const pt = (title: string, over: Partial<PlanTicket> = {}): PlanTicket => ({
    title,
    what: "w",
    criteria: [],
    blocked_by: [],
    files: [],
    references: [],
    introduces: [`c-${title.toLowerCase()}`],
    ...over,
  });

  it("scanPlanConflicts flags an implied-missing edge as an unsatisfied reference (class A)", async () => {
    const plan = [
      pt("Alpha", { introduces: ["greet"] }),
      pt("Beta", { references: ["greet"] }),
    ];
    const { report } = await scanPlanConflicts(plan);
    const unsat = report.classA.filter((f) => f.kind === "unsatisfied-reference");
    expect(unsat).toHaveLength(1);
    expect(unsat[0].cls).toBe("classA");
    expect(unsat[0].key).toBe("ref:beta:greet"); // slug identity — never an NN
    expect(report.errors).toEqual([]);
  });

  it("impliedBlockedByEdits yields the introducer edge; applying it clears the finding", async () => {
    const plan = [
      pt("Alpha", { introduces: ["greet"] }),
      pt("Beta", { references: ["greet"] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    const unsat = tableFindings(report).filter((f) => f.kind === "unsatisfied-reference");
    const edits = impliedBlockedByEdits(ordered!, unsat);
    // The edit is in plan-array coordinates (the coordinate blocked_by uses).
    expect(edits).toEqual([{ from: 1, to: 0 }]);

    const applied = withImpliedBlockedBy(plan, edits);
    expect(applied[1].blocked_by).toContain(0);
    const { report: after } = await scanPlanConflicts(applied);
    expect(after.classA).toEqual([]);
  });

  it("a manual edge CONTRADICTING the implied one yields no edit (that is a model bug)", async () => {
    const plan = [
      pt("Alpha", { introduces: ["greet"], blocked_by: [1] }),
      pt("Beta", { references: ["greet"] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    const unsat = tableFindings(report).filter((f) => f.kind === "unsatisfied-reference");
    expect(unsat.length).toBeGreaterThan(0); // Beta is not after Alpha
    // Adding Beta→Alpha would cycle (Alpha already depends on Beta) — no edit.
    expect(impliedBlockedByEdits(ordered!, unsat)).toEqual([]);
  });

  it("does not re-insert an edge the ticket already declares directly", async () => {
    const plan = [
      pt("Alpha", { introduces: ["greet"] }),
      pt("Beta", { references: ["greet"], blocked_by: [0] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    const unsat = tableFindings(report).filter((f) => f.kind === "unsatisfied-reference");
    expect(unsat).toEqual([]);
    expect(impliedBlockedByEdits(ordered!, unsat)).toEqual([]);
  });

  it("scanPlanConflicts suppresses dangling references when the symbol is a known existing contract", async () => {
    const plan = [
      pt("Alpha", { introduces: [], references: ["GameScene"] }),
    ];
    const bare = await scanPlanConflicts(plan);
    expect(bare.report.classA.filter((f) => f.kind === "dangling-reference")).toHaveLength(1);
    const withUniverse = await scanPlanConflicts(plan, { existingSymbols: new Set(["GameScene"]) });
    expect(withUniverse.report.classA.filter((f) => f.kind === "dangling-reference")).toEqual([]);
  });
});

describe("ADR 0035 — same-file editors chain in emission order without a model round", () => {
  const titleSlugForTest = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const pt = (title: string, over: Partial<PlanTicket> = {}): PlanTicket => ({
    title,
    what: "w",
    criteria: [],
    blocked_by: [],
    files: [],
    references: [],
    introduces: [`c-${titleSlugForTest(title)}`],
    ...over,
  });

  it("sameFileOrderingEdits yields the later→earlier edge; applying it clears the finding", async () => {
    const plan = [
      pt("Shell", { files: ["src/app.ts", "src/shell.ts"] }),
      pt("Panel", { files: ["src/panel.ts", "src/app.ts"] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    const sameFile = tableFindings(report).filter((f) => f.kind === "unordered-same-file");
    expect(sameFile).toHaveLength(1);
    const edits = sameFileOrderingEdits(ordered!, sameFile);
    // The later array position depends on the earlier one — emission order.
    expect(edits).toEqual([{ from: 1, to: 0 }]);

    const applied = withImpliedBlockedBy(plan, edits);
    const { report: after } = await scanPlanConflicts(applied);
    expect(after.classA).toEqual([]);
  });

  it("chains several editors of one shared file into emission order", async () => {
    const plan = [
      pt("Shell", { files: ["src/app.ts"] }),
      pt("Palette", { files: ["src/app.ts", "src/palette.ts"] }),
      pt("Layers", { files: ["src/app.ts", "src/layers.ts"] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    const sameFile = tableFindings(report).filter((f) => f.kind === "unordered-same-file");
    expect(sameFile).toHaveLength(3); // Shell×Palette, Shell×Layers, Palette×Layers
    const edits = sameFileOrderingEdits(ordered!, sameFile);
    // Palette blocked_by Shell; Layers blocked_by Shell + Palette.
    expect(edits).toContainEqual({ from: 1, to: 0 });
    expect(edits).toContainEqual({ from: 2, to: 0 });
    expect(edits).toContainEqual({ from: 2, to: 1 });
    const applied = withImpliedBlockedBy(plan, edits);
    const { report: after } = await scanPlanConflicts(applied);
    expect(after.classA).toEqual([]);
    expect(after.errors).toEqual([]);
  });

  it("same-file edits never cycle: a batch candidate that would cycle via edges added earlier in the same batch is skipped", async () => {
    // Existing manual edges: A blocked_by C, B blocked_by D. Unordered same-file
    // pairs: A×D (share f1) and B×C (share f2). Emission-order chaining would add
    // D blocked_by A and C blocked_by B — the two together close the cycle
    // D→A→C→B→D. The guard applies the first and SKIPS the second; the skipped
    // pair still clears on the re-scan because the applied chain orders it
    // transitively.
    const plan = [
      pt("A", { files: ["f1.ts"], blocked_by: [2] }),
      pt("B", { files: ["f2.ts"], blocked_by: [3] }),
      pt("C", { files: ["f2.ts"] }),
      pt("D", { files: ["f1.ts"] }),
    ];
    const { ordered, report } = await scanPlanConflicts(plan);
    const sameFile = tableFindings(report).filter((f) => f.kind === "unordered-same-file");
    expect(sameFile).toHaveLength(2);
    const edits = sameFileOrderingEdits(ordered!, sameFile);
    expect(edits).toEqual([{ from: 3, to: 0 }]); // only the non-cycling edge
    const applied = withImpliedBlockedBy(plan, edits);
    const { ordered: afterOrdered, report: after } = await scanPlanConflicts(applied);
    expect(afterOrdered).toBeDefined();
    expect(after.errors).toEqual([]);
    expect(after.classA).toEqual([]); // both pairs ordered through the one edge
  });
});

describe("issue #103 — assessRuntimeExtension stays consistent with introducer edges", () => {
  const mk = (
    file: string,
    over: Partial<import("../core/ticket.ts").Ticket> = {},
  ): import("../core/ticket.ts").Ticket => ({
    file,
    number: file.slice(0, 2),
    slug: file.replace(/\.md$/, "").replace(/^\d{2}-/, ""),
    title: file,
    mission: "m",
    what: "w",
    blocked_by: [],
    criteria: [],
    files: [],
    references: [],
    introduces: [],
    ...over,
  });

  it("a live ticket referencing a corrective-introduced symbol it IS blocked by is clean (no abort, no ruling)", () => {
    // The corrective introduces fixSym; the planned ticket references it and
    // extendBlockedBy already appended the corrective to its blocked_by.
    const tickets = [
      mk("03-fix.md", { introduces: ["fixSym"] }),
      mk("04-plan.md", { references: ["fixSym"], blocked_by: ["03-fix.md"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: ["03-fix.md"],
      committedFiles: [],
      planRulings: [],
      existingSymbols: new Set(),
    });
    expect(fatal).toEqual([]);
    expect(rulings).toEqual([]);
  });

  it("a corrective referencing a planned introducer it is not blocked by is auto-ruled, not fatal", () => {
    const tickets = [
      mk("03-plan.md", { introduces: ["greet"] }),
      mk("04-fix.md", { references: ["greet"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: ["04-fix.md"],
      committedFiles: [],
      planRulings: [],
      existingSymbols: new Set(),
    });
    expect(fatal).toEqual([]);
    expect(rulings).toHaveLength(1);
    expect(rulings[0].key).toBe("ref:fix:greet");
    expect(rulings[0].source).toBe("runtime");
    expect(rulings[0].reason).toMatch(/unsatisfied reference/);
  });

  it("a corrective referencing a committed introducer is inert (commit order satisfies it)", () => {
    const tickets = [
      mk("01-core.md", { introduces: ["greet"] }),
      mk("05-fix.md", { references: ["greet"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: ["05-fix.md"],
      committedFiles: ["01-core.md"],
      planRulings: [],
      existingSymbols: new Set(),
    });
    expect(fatal).toEqual([]);
    expect(rulings).toEqual([]);
  });

  it("a dangling reference on a corrective is inert, never a runtime abort (the plan gate owns it)", () => {
    const tickets = [mk("05-fix.md", { references: ["ghost"] })];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: ["05-fix.md"],
      committedFiles: [],
      planRulings: [],
      existingSymbols: new Set(),
    });
    expect(fatal).toEqual([]);
    expect(rulings).toEqual([]);
  });

  it("an unsatisfied reference between two non-corrective tickets is still a railhead-defect abort", () => {
    const tickets = [
      mk("03-plan.md", { introduces: ["greet"] }),
      mk("04-plan2.md", { references: ["greet"] }),
    ];
    const { fatal, rulings } = assessRuntimeExtension(tickets, {
      correctiveFiles: [],
      committedFiles: [],
      planRulings: [],
      existingSymbols: new Set(),
    });
    expect(rulings).toEqual([]);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatch(/plan invariant violated at runtime/);
    expect(fatal[0]).toContain("03-plan.md");
  });
});

describe("issue #103 — authoring relief is visible in the planner and repair prompts", () => {
  it("tells the planner implied edges may be omitted and which orderings still need blocked_by", () => {
    const prompt = planTicketsSystemPrompt({ contractsSummary: "(no known contracts)" });
    expect(prompt).toMatch(/AUTO-INSERTS a missing "blocked_by" edge/i);
    expect(prompt).toMatch(/MAY omit the edge/i);
    expect(prompt).toMatch(/orderings the contracts cannot express/i);
    expect(prompt).toMatch(/same-file wiring chains/i);
    expect(prompt).toMatch(/ALWAYS author it when a ticket edits a file another ticket also edits/i);
  });

  it("speaks the two new finding kinds in the repair rules so a model knows how to fix them", () => {
    const prompt = buildPlanRepairPrompt({
      ticketsJson: "[]",
      table: [],
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    expect(prompt).toMatch(/- unsatisfied reference \(issue #103\):/i);
    expect(prompt).toMatch(/- dangling reference \(issue #103\):/i);
    expect(prompt).toMatch(/add that introducer's array index/i);
    expect(prompt).toMatch(/fix the typo, declare it in an earlier ticket's "introduces"/i);
  });

  it("tells the model how to fix a duplicate-slug finding, carving out the retitle exception", () => {
    const prompt = buildPlanRepairPrompt({
      ticketsJson: "[]",
      table: [],
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    expect(prompt).toMatch(/- duplicate slug/i);
    expect(prompt).toMatch(/retitle one of them|retitle one ticket/i);
    expect(prompt).toMatch(/remove the duplicated ticket/i);
    // The identity rule forbids retitles; this finding is the recorded exception.
    expect(prompt).toMatch(/duplicate-slug fix above is the one exception|required there, and only there/i);
  });

  it("tells the model how to fix an unorderable-plan finding and that a ruling cannot clear it", () => {
    const prompt = buildPlanRepairPrompt({
      ticketsJson: "[]",
      table: [],
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    expect(prompt).toMatch(/- unorderable plan/i);
    expect(prompt).toMatch(/dependency cycle|blocked_by index outside/i);
    expect(prompt).toMatch(/never rule this|never rule an unorderable/i);
  });

  it("tells the model how to fix the two plan-completeness findings", () => {
    const prompt = buildPlanRepairPrompt({
      ticketsJson: "[]",
      table: [],
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    expect(prompt).toMatch(/- uncovered-file \(plan completeness\):/i);
    expect(prompt).toMatch(/add a ticket that owns it/i);
    expect(prompt).toMatch(/- unre-owned-entry-point \(plan completeness\):/i);
    expect(prompt).toMatch(/wire the shell EARLY|early shell ticket|mount contract/i);
  });

  it("tells the model a dropped ticket must be restored or ruled", () => {
    const prompt = buildPlanRepairPrompt({
      ticketsJson: "[]",
      table: [],
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    expect(prompt).toMatch(/- dropped-ticket \(repair loss guard\):/i);
    expect(prompt).toMatch(/restore it|restore it \(put it back/i);
    expect(prompt).toMatch(/never drop a ticket silently/i);
  });

  it("permits a rulings-only reply: re-emit only when fixing, no unchanged re-emission", () => {
    const prompt = buildPlanRepairPrompt({
      ticketsJson: "[]",
      table: [],
      existingRulings: [],
      maxRounds: 2,
      round: 1,
    });
    expect(prompt).toMatch(/If you FIX any finding, emit the corrected JSON array/i);
    expect(prompt).toMatch(/emit ONLY the \$RULINGS block with no \$TICKETS array/i);
    expect(prompt).toMatch(/do not re-emit an unchanged plan/i);
  });
});

describe("extractFilePaths (plan completeness)", () => {
  it("extracts relative source/config/doc paths from prose", () => {
    const text = "the model tier is `src/model/document.ts`, `src/ui/frames.ts` plus `src/app/app.ts` and the entry `src/main.ts`; docs in README.md";
    const paths = extractFilePaths(text);
    expect(paths).toContain("src/model/document.ts");
    expect(paths).toContain("src/ui/frames.ts");
    expect(paths).toContain("src/app/app.ts");
    expect(paths).toContain("src/main.ts");
    expect(paths).toContain("README.md");
  });

  it("ignores prose that names no file (npm install, save formats)", () => {
    const text = "npm install && npm run build; save as a .spriteforge file";
    expect(extractFilePaths(text)).toEqual([]);
  });

  it("strips a leading ./ and dedupes", () => {
    const text = "./src/main.ts and src/main.ts";
    expect(extractFilePaths(text)).toEqual(["src/main.ts"]);
  });
});

describe("detectIntegrationPromise (plan completeness)", () => {
  it("detects a late/terminal integration promise", () => {
    expect(detectIntegrationPromise("main.ts is re-owned by the final integration ticket")).toBe(true);
    expect(detectIntegrationPromise("a late ticket integrates the panels into the app shell")).toBe(true);
    expect(detectIntegrationPromise("the wiring is deferred to a terminal integration ticket")).toBe(true);
  });

  it("does not fire on a plan that wires the shell early", () => {
    expect(detectIntegrationPromise("the scaffold ticket mounts a minimal running shell and later panels dock into its mount contract")).toBe(false);
  });
});

describe("QUALITY_PREFERENCES — API stability steering for small execute seats", () => {
  // The measured failure behind this steer: the planner (a large cloud model)
  // chose a recently-redesigned windowing API; the 27B implement seat did not
  // know its new shape and burned most of its context window rediscovering it
  // from installed source. Popularity is not the signal — API stability is.
  it("tells every planner stage to weigh API stability, not just popularity", () => {
    for (const prompt of [
      planDesignSystemPrompt({ contractsSummary: "(none)" }),
      planTicketsSystemPrompt({ contractsSummary: "(none)" }),
      planFixSystemPrompt("(none)"),
    ]) {
      expect(prompt).toContain("recent breaking redesign");
      expect(prompt).toContain("stable for years");
    }
  });
});
