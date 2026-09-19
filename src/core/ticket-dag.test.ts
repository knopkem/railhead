import { describe, it, expect } from "vitest";
import type { Ticket } from "./ticket.ts";
import { introducerIndex, findUnsatisfiedReferences, findDanglingReferences, scanTicketConflicts, contractName, findUncoveredRequiredFiles, findUnreOwnedEntryPoint, findMissingArtTicket, findDroppedTickets, collapseRepeatedTickets, titleSlug, type PlanTicket } from "./ticket-dag.ts";

const mk = (
  file: string,
  over: Partial<Ticket> = {},
): Ticket => ({
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

describe("introducerIndex (issue #103)", () => {
  it("maps each introduced symbol to its single owning ticket file", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet", "farewell"] }),
      mk("02-b.md", { introduces: ["depart"], blocked_by: ["01-a.md"] }),
    ];
    const index = introducerIndex(tickets);
    expect(index.get("greet")).toBe("01-a.md");
    expect(index.get("farewell")).toBe("01-a.md");
    expect(index.get("depart")).toBe("02-b.md");
    expect(index.has("missing")).toBe(false);
  });

  it("keeps the first owner when a dirty set slips in (duplicates gate separately)", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { introduces: ["greet"] }),
    ];
    const index = introducerIndex(tickets);
    expect(index.get("greet")).toBe("01-a.md");
  });
});

describe("findUnsatisfiedReferences (issue #103)", () => {
  it("flags a reference to a symbol an unordered ticket introduces as class A", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { references: ["greet"] }),
    ];
    const findings = findUnsatisfiedReferences(tickets);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.kind).toBe("unsatisfied-reference");
    expect(f.cls).toBe("classA");
    expect(f.key).toBe("ref:b:greet"); // slug identity, referencing ticket + symbol
    expect(f.message).toContain("02-b.md");
    expect(f.message).toContain("01-a.md");
    expect(f.message).toContain("greet");
    // Involved tickets are the sorted pair, so the repair table can name both.
    expect(f.tickets).toEqual(["01-a.md", "02-b.md"]);
  });

  it("finds nothing when the introducer is a DIRECT blocked_by predecessor", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { references: ["greet"], blocked_by: ["01-a.md"] }),
    ];
    expect(findUnsatisfiedReferences(tickets)).toEqual([]);
  });

  it("finds nothing when the introducer is a TRANSITIVE blocked_by predecessor", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { blocked_by: ["01-a.md"] }),
      mk("03-c.md", { references: ["greet"], blocked_by: ["02-b.md"] }),
    ];
    expect(findUnsatisfiedReferences(tickets)).toEqual([]);
  });

  it("finds nothing when a ticket references a symbol it introduces itself", () => {
    const tickets = [mk("01-a.md", { introduces: ["greet"], references: ["greet"] })];
    expect(findUnsatisfiedReferences(tickets)).toEqual([]);
  });

  it("skips symbols with ambiguous owners (duplicate introduces gates that case)", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { introduces: ["greet"] }),
      mk("03-c.md", { references: ["greet"] }),
    ];
    expect(findUnsatisfiedReferences(tickets)).toEqual([]);
  });

  it("exempts references to satisfied (committed) introducer files — time already orders them", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { references: ["greet"] }),
    ];
    // 01-a.md is committed; the corrective 02-b.md legitimately carries no
    // blocked_by (issue #63) yet is ordered after it by commit order.
    expect(findUnsatisfiedReferences(tickets, new Set(["01-a.md"]))).toEqual([]);
    // Without the exemption the same set flags.
    expect(findUnsatisfiedReferences(tickets)).toHaveLength(1);
  });

  it("finds one finding per distinct unordered reference", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet", "depart"] }),
      mk("02-b.md", { references: ["greet", "depart"] }),
    ];
    expect(findUnsatisfiedReferences(tickets)).toHaveLength(2);
  });
});

describe("findDanglingReferences (issue #103)", () => {
  it("flags a reference to a symbol no ticket introduces as a DISTINCT class-A kind", () => {
    const tickets = [mk("01-a.md", { references: ["ghost"] })];
    const findings = findDanglingReferences(tickets);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.kind).toBe("dangling-reference");
    expect(f.kind).not.toBe(findUnsatisfiedReferences(tickets)[0]?.kind);
    expect(f.cls).toBe("classA");
    expect(f.key).toBe("dangling-ref:a:ghost");
    expect(f.tickets).toEqual(["01-a.md"]);
    expect(f.message).toContain("ghost");
  });

  it("is not dangling when another ticket introduces the symbol", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { references: ["greet"], blocked_by: ["01-a.md"] }),
    ];
    expect(findDanglingReferences(tickets)).toEqual([]);
  });

  it("is not dangling when the symbol is in the existing-symbol universe (committed contracts index)", () => {
    const tickets = [mk("01-a.md", { references: ["GameScene"] })];
    expect(findDanglingReferences(tickets, new Set(["GameScene"]))).toEqual([]);
    expect(findDanglingReferences(tickets)).toHaveLength(1);
  });
});

describe("scanTicketConflicts aggregates the reference findings (issue #103)", () => {
  it("returns a clean report for a set whose references are satisfied", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { references: ["greet"], blocked_by: ["01-a.md"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.errors).toEqual([]);
    expect(report.classA).toEqual([]);
  });

  it("reports an unsatisfied reference as a class-A finding", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-b.md", { references: ["greet"] }),
    ];
    const report = scanTicketConflicts(tickets);
    expect(report.classA).toHaveLength(1);
    expect(report.classA[0].kind).toBe("unsatisfied-reference");
  });

  it("reports a dangling reference as a class-A finding unless the universe knows the symbol", () => {
    const tickets = [mk("01-a.md", { references: ["ghost"] })];
    expect(scanTicketConflicts(tickets).classA).toHaveLength(1);
    expect(
      scanTicketConflicts(tickets, { existingSymbols: new Set(["ghost"]) }).classA,
    ).toEqual([]);
  });

  it("passes the satisfiedFiles exemption through to the reference scan", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["greet"] }),
      mk("02-fix.md", { references: ["greet"] }),
    ];
    expect(scanTicketConflicts(tickets).classA).toHaveLength(1);
    expect(
      scanTicketConflicts(tickets, { satisfiedFiles: new Set(["01-a.md"]) }).classA,
    ).toEqual([]);
  });
});

describe("contractName (value-annotation normalization)", () => {
  it("strips a trailing =value annotation and trims", () => {
    expect(contractName("CANVAS=32")).toBe("CANVAS");
    expect(contractName("MAX_FRAMES=64")).toBe("MAX_FRAMES");
    expect(contractName("  TILE=  ")).toBe("TILE");
    expect(contractName("greet")).toBe("greet");
  });
});

describe("value-annotation identity in the reference scans", () => {
  it("does NOT report a dangling reference when the introducer annotates a value (CANVAS=32 vs CANVAS)", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["CANVAS=32", "MAX_FRAMES=64"] }),
      mk("02-b.md", { references: ["CANVAS", "MAX_FRAMES"], blocked_by: ["01-a.md"] }),
    ];
    expect(findDanglingReferences(tickets)).toEqual([]);
    expect(findUnsatisfiedReferences(tickets)).toEqual([]);
    expect(scanTicketConflicts(tickets).classA).toEqual([]);
  });

  it("reports a duplicate introduces when one owner annotates a value and the other does not", () => {
    const tickets = [
      mk("01-a.md", { introduces: ["CANVAS=32"] }),
      mk("02-b.md", { introduces: ["CANVAS"] }),
    ];
    const findings = scanTicketConflicts(tickets).classA.filter(
      (f) => f.kind === "duplicate-introduces",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toContain("CANVAS");
  });

  it("is still dangling when the value-annotated introducer names a DIFFERENT symbol", () => {
    const tickets = [mk("01-a.md", { references: ["CANVAS"] })];
    expect(findDanglingReferences(tickets)).toHaveLength(1);
  });
});

describe("findUncoveredRequiredFiles (plan completeness)", () => {
  it("flags a required file no ticket owns", () => {
    const tickets = [
      mk("01-a.md", { files: ["src/main.ts"] }),
      mk("02-b.md", { files: ["src/ui/panel.ts"] }),
    ];
    const findings = findUncoveredRequiredFiles(tickets, ["src/app/shell.ts"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("uncovered-file");
    expect(findings[0].key).toBe("uncovered-file:src/app/shell.ts");
    expect(findings[0].message).toContain("src/app/shell.ts");
  });

  it("does not flag a required file that some ticket owns", () => {
    const tickets = [mk("01-a.md", { files: ["src/app/shell.ts"] })];
    expect(findUncoveredRequiredFiles(tickets, ["src/app/shell.ts"])).toEqual([]);
  });

  it("exempts a required file that already exists on disk", () => {
    const tickets = [mk("01-a.md", { files: ["src/main.ts"] })];
    expect(
      findUncoveredRequiredFiles(tickets, ["prompt.md"], new Set(["prompt.md"])),
    ).toEqual([]);
    // Without the exemption it is a gap.
    expect(findUncoveredRequiredFiles(tickets, ["prompt.md"])).toHaveLength(1);
  });

  it("matches a bare module name from the spec/architecture to the ticket's full path", () => {
    // The architecture's module map says `tokens.ts`; the ticket owns
    // `src/art/tokens.ts`. Same promise — must not be a false positive.
    const tickets = [mk("01-a.md", { files: ["src/art/tokens.ts"] })];
    expect(findUncoveredRequiredFiles(tickets, ["tokens.ts"])).toEqual([]);
    expect(findUncoveredRequiredFiles(tickets, ["src/art/tokens.ts"])).toEqual([]);
    // A different file is still a genuine gap.
    expect(findUncoveredRequiredFiles(tickets, ["src/art/lighting.ts"])).toHaveLength(1);
  });

  it("does not match a bare name to a path that merely ends with the same characters", () => {
    const tickets = [mk("01-a.md", { files: ["src/art/mytokens.ts"] })];
    expect(findUncoveredRequiredFiles(tickets, ["tokens.ts"])).toHaveLength(1);
  });
});

describe("findMissingArtTicket (art direction)", () => {
  it("is a no-op when art direction is not required", () => {
    expect(findMissingArtTicket([mk("01-a.md", {})], false)).toEqual([]);
  });

  it("flags a surface plan whose look has no open-ended craft ticket", () => {
    const findings = findMissingArtTicket([mk("01-a.md", { criteria: ["npm run build succeeds"] })], true);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing-art-ticket");
    expect(findings[0].key).toBe("missing-art-ticket:open-ended");
    expect(findings[0].message).toContain("open-ended");
  });

  it("passes when exactly one open-ended ticket owns the look", () => {
    expect(findMissingArtTicket([mk("01-a.md", { open_ended: true })], true)).toEqual([]);
  });

  it("flags more than one open-ended ticket — the look must be one agent", () => {
    const tickets = [mk("01-a.md", { open_ended: true }), mk("02-b.md", { open_ended: true })];
    expect(findMissingArtTicket(tickets, true)[0].key).toBe("missing-art-ticket:multiple");
  });

  it("surfaces as class A through scanTicketConflicts when the universe requires art direction", () => {
    const tickets = [mk("01-a.md", {})];
    const report = scanTicketConflicts(tickets, { artDirectionRequired: true });
    expect(report.classA.some((f) => f.kind === "missing-art-ticket")).toBe(true);
    expect(scanTicketConflicts(tickets, { artDirectionRequired: false }).classA).toEqual([]);
  });
});

describe("findUnreOwnedEntryPoint (plan completeness)", () => {
  it("flags an entry point when the plan promises a terminal integration", () => {
    const tickets = [
      mk("01-a.md", { files: ["package.json", "src/main.ts"] }),
      mk("02-b.md", { files: ["src/ui/panel.ts"], blocked_by: ["01-a.md"] }),
    ];
    const findings = findUnreOwnedEntryPoint(tickets, true);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("unre-owned-entry-point");
    expect(findings[0].key).toBe("unre-owned-entry:src/main.ts");
    expect(findings[0].message).toContain("src/main.ts");
  });

  it("flags regardless of owner count — the smell is the terminal integration itself", () => {
    const tickets = [
      mk("01-a.md", { files: ["package.json", "src/main.ts"] }),
      mk("02-b.md", { files: ["src/main.ts"], blocked_by: ["01-a.md"] }),
    ];
    const findings = findUnreOwnedEntryPoint(tickets, true);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("unre-owned-entry:src/main.ts");
  });

  it("does not flag when the shell is wired early (no integration promise)", () => {
    const tickets = [
      mk("01-a.md", { files: ["package.json", "src/main.ts"] }),
      mk("02-b.md", { files: ["src/ui/panel.ts"] }),
    ];
    expect(findUnreOwnedEntryPoint(tickets, false)).toEqual([]);
    expect(findUnreOwnedEntryPoint([mk("01-a.md", { files: ["src/main.ts"] })], true)).toEqual([]);
  });

  it("ignores non-script entry files like index.html", () => {
    const tickets = [
      mk("01-a.md", { files: ["index.html", "src/main.ts"] }),
      mk("02-b.md", { files: ["src/ui/panel.ts"] }),
    ];
    const findings = findUnreOwnedEntryPoint(tickets, true);
    // Only src/main.ts is an entry point; index.html is ignored.
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("unre-owned-entry:src/main.ts");
  });
});

describe("findDroppedTickets (repair loss guard)", () => {
  const pt = (title: string): PlanTicket => ({
    title,
    what: "w",
    criteria: [],
    blocked_by: [],
  });

  it("flags a title-slug present before a repair round but absent after", () => {
    const before = [pt("Layer compositing and onion-skin pixels"), pt("Layers and palette panels")];
    const after = [pt("Layer compositing and onion-skin pixels")];
    const findings = findDroppedTickets(before, after);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("dropped-ticket");
    expect(findings[0].key).toBe("dropped-ticket:layers-and-palette-panels");
    expect(findings[0].message).toContain("Layers and palette panels");
  });

  it("finds nothing when every pre-round slug survives", () => {
    const before = [pt("Layer compositing"), pt("Layers and palette panels")];
    const after = [pt("Layer compositing"), pt("Layers and palette panels")];
    expect(findDroppedTickets(before, after)).toEqual([]);
  });

  it("flags each dropped slug independently", () => {
    const before = [pt("Import downscale and palette quantize"), pt("Layers and palette panels")];
    const after: PlanTicket[] = [];
    expect(findDroppedTickets(before, after)).toHaveLength(2);
  });
});

describe("collapseRepeatedTickets (ADR 0035)", () => {
  const pt = (
    title: string,
    over: Partial<PlanTicket> = {},
  ): PlanTicket => ({
    title,
    what: "w",
    criteria: [],
    blocked_by: [],
    ...over,
  });

  it("returns the input untouched when no ticket repeats", () => {
    const plan = [pt("Alpha", { files: ["a.ts"], introduces: ["a"] }), pt("Beta", { files: ["b.ts"], introduces: ["b"] })];
    const { tickets, dropped } = collapseRepeatedTickets(plan);
    expect(tickets).toBe(plan);
    expect(dropped).toEqual([]);
  });

  it("drops a verbatim re-emission and keeps the first copy", () => {
    const plan = [
      pt("Scaffold", { files: ["package.json"], introduces: ["npm:build"] }),
      pt("Engine", { files: ["engine.ts"], introduces: ["createEngine"], blocked_by: [0] }),
      pt("Scaffold", { files: ["package.json"], introduces: ["npm:build"] }),
    ];
    const { tickets, dropped } = collapseRepeatedTickets(plan);
    expect(dropped).toEqual([{ index: 2, title: "Scaffold" }]);
    expect(tickets.map((t) => t.title)).toEqual(["Scaffold", "Engine"]);
    expect(tickets[1].blocked_by).toEqual([0]);
  });

  it("remaps a blocked_by pointer aimed at the dropped copy to the kept twin", () => {
    // The model re-emitted ticket 0 at index 1, then pointed ticket 2 at the
    // COPY — the copy names the same work, so the edge resolves to the twin.
    const plan = [
      pt("Scaffold", { files: ["package.json"], introduces: ["npm:build"] }),
      pt("Scaffold", { files: ["package.json"], introduces: ["npm:build"] }),
      pt("Engine", { files: ["engine.ts"], introduces: ["createEngine"], blocked_by: [1] }),
    ];
    const { tickets } = collapseRepeatedTickets(plan);
    expect(tickets.map((t) => t.title)).toEqual(["Scaffold", "Engine"]);
    expect(tickets[1].blocked_by).toEqual([0]);
  });

  it("drops a self-edge the remap creates and dedupes repeated edges", () => {
    const plan = [
      pt("Base", { files: ["a.ts"], introduces: ["a"] }),
      pt("Mid", { files: ["b.ts"], introduces: ["b"], blocked_by: [0] }),
      pt("Mid", { files: ["b.ts"], introduces: ["b"], blocked_by: [0] }),
      pt("Leaf", { files: ["c.ts"], introduces: ["c"], blocked_by: [1, 2, 0] }),
    ];
    const { tickets } = collapseRepeatedTickets(plan);
    expect(tickets.map((t) => t.title)).toEqual(["Base", "Mid", "Leaf"]);
    // Both 1 and 2 map to the kept Mid (new index 1); the duplicate is dropped,
    // and no self-edge survives.
    expect(tickets[2].blocked_by).toEqual([1, 0]);
  });

  it("matches on slug + files + introduces, not on prose — a rephrased repeat is still a repeat", () => {
    const plan = [
      pt("Scaffold the app", { what: "first wording", criteria: ["c1"], files: ["src/main.ts"], introduces: ["CANVAS_W=32"] }),
      pt("Scaffold the app!", { what: "rephrased wording", criteria: ["c2"], files: ["src/main.ts"], introduces: ["CANVAS_W"] }),
    ];
    const { tickets, dropped } = collapseRepeatedTickets(plan);
    expect(dropped).toHaveLength(1);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].what).toBe("first wording");
  });

  it("does NOT collapse same-title tickets with distinct content — dropping one could delete scope (they escalate as duplicate-slug)", () => {
    const plan = [
      pt("Scaffold", { files: ["src/a.ts"], introduces: ["a"] }),
      pt("Scaffold", { files: ["src/b.ts"], introduces: ["b"] }),
    ];
    const { tickets, dropped } = collapseRepeatedTickets(plan);
    expect(dropped).toEqual([]);
    expect(tickets).toHaveLength(2);
  });

  it("collapses a fully doubled plan back to the intended set (the spriteforge double-emit)", () => {
    const half = [
      pt("Toolchain", { files: ["package.json"], introduces: ["npm:build", "npm:test"] }),
      pt("World constants", { files: ["constants.ts"], introduces: ["CANVAS_W"], blocked_by: [0] }),
      pt("Pixels", { files: ["pixels.ts"], introduces: ["drawLine"], blocked_by: [1] }),
    ];
    const echoed = half.map((t) => ({ ...t, blocked_by: [...(t.blocked_by ?? [])] }));
    const { tickets, dropped } = collapseRepeatedTickets([...half, ...echoed]);
    expect(dropped).toHaveLength(3);
    expect(tickets.map((t) => titleSlug(t.title))).toEqual(half.map((t) => titleSlug(t.title)));
    expect(tickets[2].blocked_by).toEqual([1]);
  });
});
