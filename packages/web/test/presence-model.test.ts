import { fileURLToPath } from "node:url";
import { loadNovel, mentions } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { describe, expect, it } from "vitest";
import { gridKey } from "../src/diagrams/columns.ts";
import { presence, sortRows, totals } from "../src/presence/presence-model.ts";
import { gaps } from "../src/swimlanes/swimlane-model.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));

describe("presence", () => {
  it("matches the scenes' metadata exactly, for every type with a list", () => {
    for (const [type, field] of [["character", "characters"], ["location", "locations"], ["theme", "themes"], ["plotline", "plotlines"]] as const) {
      const m = presence(novel, type);
      for (const scene of novel.scenes) {
        const listed = new Set<string>(
          field === "characters" ? [...(scene.pov ? [scene.pov] : []), ...scene.characters] : field === "locations" ? scene.locations : scene[field].map((x) => x.id),
        );
        for (const row of m.rows) expect(m.marks.get(gridKey(row.id, scene.id))?.listed ?? false, `${type} ${row.name} in ${scene.title}`).toBe(listed.has(row.id));
      }
    }
  });

  it("marks the point of view, theme strengths, and entries only mentioned", () => {
    const characters = presence(novel, "character");
    expect(characters.marks.get(gridKey("char_7f3k2q", "sc_0d9wm4"))).toMatchObject({ listed: true, pov: true, mentioned: true });
    expect(characters.marks.get(gridKey("char_b3n0vs", "sc_0d9wm4"))).toMatchObject({ listed: true, pov: false });
    const themes = presence(novel, "theme");
    expect(themes.marks.get(gridKey("theme_trvst5", "sc_0d9wm4"))).toMatchObject({ listed: true, strength: 3 });
    // Custom types have no list: present where mentioned.
    const artifacts = presence(novel, "artifact");
    for (const [key, mark] of artifacts.marks) {
      expect(mark).toMatchObject({ listed: false, mentioned: true });
      const scene = novel.scenes.find((s) => s.id === key.split("|")[1])!;
      expect(mentions(scene.body).some((x) => x.id === key.split("|")[0])).toBe(true);
    }
  });

  it("counts and sorts rows by first appearance, total, or name", () => {
    const m = presence(novel, "character");
    expect(sortRows(m, "name").map((r) => r.name)).toEqual(["Ada Varn", "Ben Varn", "Mirela Kost", "Tomas Hale"]);
    expect(sortRows(m, "total")[0]!.name).toBe("Ada Varn");
    expect(totals(m).get("char_7f3k2q")).toBe(8);
    expect(sortRows(m, "first")[0]!.name).toBe("Ada Varn");
  });
});

describe("absences", () => {
  it("finds who is away between appearances, and who never comes back", () => {
    const m = presence(novel, "character");
    const away = gaps({ lanes: m.rows, scenes: m.scenes, marks: m.marks, words: m.words }, { scenes: 0 });
    const of = (id: string) => away.filter((g) => g.lane === id).map((g) => [g.from, g.to, g.scenes, g.open]);
    // Mirela: only in Mirela's Offer, then The Last Rivet without her.
    expect(of("char_m1re1a")).toEqual([["sc_r1vet8", "sc_r1vet8", 1, true]]);
    // Tomas: the workshop, the flood, the last rivet.
    expect(of("char_t0ma5h")).toEqual([
      ["sc_1edger", "sc_0d9wm4", 2, false],
      ["sc_0ffer5", "sc_0ffer5", 1, false],
    ]);
    // Over one scene: Ben (The Workshop and Ben's Ledger) and Tomas (Ben's Ledger and The Betrayal).
    expect(gaps({ lanes: m.rows, scenes: m.scenes, marks: m.marks, words: m.words }, { scenes: 1 }).map((g) => g.lane)).toEqual(["char_b3n0vs", "char_t0ma5h"]);
  });
});
