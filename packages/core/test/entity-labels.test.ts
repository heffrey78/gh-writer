import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { entityLabel, entityOfLabel, loadNovel, type Novel } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));
const entity = (id: string) => novel.entities.find((e) => e.id === id)!;

describe("entity labels", () => {
  it("names each entry's label by its type's prefix and its name, in its type's colour, with its ID", () => {
    expect(entityLabel(novel, entity("char_7f3k2q"))).toEqual({ name: "char/ada-varn", color: "1f77b4", description: "Ada Varn · char_7f3k2q" });
    expect(entityLabel(novel, entity("loc_br1dg3")).name).toBe("loc/the-varn-bridge");
    expect(entityLabel(novel, entity("art_p1an5x"))).toMatchObject({ name: "art/the-original-plans", color: "8c564b" });
  });

  it("tells apart two of a type with the same name, and keeps within GitHub's limits", () => {
    const ben = entity("char_b3n0vs");
    const twins: Novel = { ...novel, entities: [...novel.entities, { ...ben, id: "char_b3n2zz" }] };
    expect(entityLabel(twins, ben).name).toBe("char/ben-varn-b3n0vs");
    expect(entityLabel(twins, { ...ben, id: "char_b3n2zz" }).name).toBe("char/ben-varn-b3n2zz");
    const long = { ...ben, name: "A".repeat(30) + " " + "B".repeat(60) };
    const label = entityLabel(novel, long);
    expect(label.name.length).toBeLessThanOrEqual(50);
    expect(label.description.length).toBeLessThanOrEqual(100);
    expect(label.description.endsWith(" · char_b3n0vs")).toBe(true);
  });

  it("finds a label's entry by the ID in its description, even after a rename", () => {
    expect(entityOfLabel(novel, { name: "char/ada", description: "Ada · char_7f3k2q" })?.name).toBe("Ada Varn");
    expect(entityOfLabel(novel, { name: "char/ada-varn" })?.id).toBe("char_7f3k2q");
    expect(entityOfLabel(novel, { name: "kind/research", description: "Something to look up" })).toBeUndefined();
  });
});
