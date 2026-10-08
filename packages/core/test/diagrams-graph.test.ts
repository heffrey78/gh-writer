import { fileURLToPath } from "node:url";
import { loadNovel } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { graphAt, layout } from "../src/diagrams.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));
const ADA = "char_7f3k2q";
const BEN = "char_b3n0vs";
const between = (view: ReturnType<typeof graphAt>, a: string, b: string) => view.edges.filter((e) => [e.source, e.target].sort().join() === [a, b].sort().join()).map((e) => e.label).sort();

describe("the relationship graph at a scene", () => {
  it("shows the relationships holding there: allies at The Station, rivals at The Betrayal, allies again after the last rivet", () => {
    expect(between(graphAt(novel, "sc_5tat1n"), ADA, BEN)).toEqual(["Allied with", "Sibling of"]);
    expect(between(graphAt(novel, "sc_0d9wm4"), ADA, BEN)).toEqual(["Rivals with", "Sibling of"]);
    expect(between(graphAt(novel, "sc_r1vet8"), ADA, BEN)).toEqual(["Allied with", "Sibling of"]);
  });

  it("styles edges by their type, arrows only on directed types, and lists them as sentences", () => {
    const view = graphAt(novel, "sc_0d9wm4");
    const rivals = view.edges.find((e) => e.label === "Rivals with")!;
    expect(rivals).toMatchObject({ tone: "danger", line: "dashed", directed: false });
    expect(view.edges.find((e) => e.label === "Mentor of")).toMatchObject({ directed: true });
    expect(view.list.map((l) => l.text)).toContain("Ada Varn: Rivals with Ben Varn, from “The Betrayal”, until “The Last Rivet” (After the bridge betrayal.)");
  });

  it("shows characters by default, with their saved positions; other types on request", () => {
    const view = graphAt(novel, "sc_5tat1n");
    expect(view.nodes.map((n) => n.label)).toEqual(["Ada Varn", "Ben Varn", "Mirela Kost", "Tomas Hale"]);
    expect(view.nodes.find((n) => n.id === ADA)).toMatchObject({ x: 0, y: 0, type: "Character" });
    const withArtifacts = graphAt(novel, "sc_0d9wm4", { types: ["character", "artifact"] });
    expect(withArtifacts.edges.map((e) => e.label)).toContain("Holds");
  });
});

describe("filtering the graph", () => {
  it("by relationship type, by plotline, and by who is present in a range of scenes; filters combine", () => {
    expect(graphAt(novel, "sc_0d9wm4", { relationshipTypes: ["rivals"] }).edges.map((e) => e.label)).toEqual(["Rivals with"]);
    // Ben's Debt runs through five scenes; Mirela is in none of them.
    const debt = graphAt(novel, "sc_0d9wm4", { plotline: "plot_gr1efa" });
    expect(debt.nodes.map((n) => n.label)).toEqual(["Ada Varn", "Ben Varn", "Tomas Hale"]);
    // Only the first chapter: Ada and Ben.
    expect(graphAt(novel, "sc_5tat1n", { from: "sc_5tat1n", to: "sc_br1dg3" }).nodes.map((n) => n.label)).toEqual(["Ada Varn", "Ben Varn"]);
    // A range given backwards is the same range.
    expect(graphAt(novel, "sc_5tat1n", { from: "sc_br1dg3", to: "sc_5tat1n" }).nodes.map((n) => n.label)).toEqual(["Ada Varn", "Ben Varn"]);
    const both = graphAt(novel, "sc_5tat1n", { from: "sc_5tat1n", to: "sc_br1dg3", relationshipTypes: ["sibling"] });
    expect(both.edges.map((e) => e.label)).toEqual(["Sibling of"]);
  });
});

describe("laying out nodes without saved positions", () => {
  it("keeps saved positions, puts the rest apart from each other and from them, the same way every time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), (placedCount, restCount) => {
        const ids = Array.from({ length: placedCount + restCount }, (_, i) => `char_${String(i).padStart(6, "0")}`);
        const saved = Object.fromEntries(ids.slice(0, placedCount).map((id, i) => [id, { x: (i % 5) * 200, y: Math.floor(i / 5) * 150 }]));
        const out = layout(ids, saved);
        expect(out.size).toBe(ids.length);
        for (const id of ids.slice(0, placedCount)) expect(out.get(id)).toEqual(saved[id]);
        const points = [...out.values()];
        const fresh = ids.slice(placedCount).map((id) => out.get(id)!);
        for (const p of fresh) for (const q of points) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(100);
        expect(layout(ids, saved)).toEqual(out);
      }),
    );
  });
});
