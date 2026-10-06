import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { merge2, merge3, resolveMerge, type MergeChunk } from "../src/index.ts";

const scene = (front: string[], paragraphs: string[]) => `---\n${front.join("\n")}\n---\n\n${paragraphs.join("\n\n")}\n`;
const FRONT = ["id: sc_5tat1n", "title: The Station", "synopsis: Ada arrives.", "status: drafted", "pov: char_7f3k2q"];
const PARAS = ["The train was late.", "Ada stepped down.", "Flags on the bridge.", "She counted them."];
const conflicts = (chunks: MergeChunk[]) => chunks.filter((c) => c.type === "conflict");

describe("properties", () => {
  // Paragraphs as the format writes them: distinct lines of prose, joined by blank lines.
  const paragraph = fc.stringMatching(/^[A-Za-z][A-Za-z ,.'’—]{0,40}[a-z.]$/);
  const text = fc.uniqueArray(paragraph, { minLength: 1, maxLength: 12 }).map((ps) => `${ps.join("\n\n")}\n`);
  const anyText = fc.string({ unit: fc.constantFrom("a", "b", "\n", " ", "-", ":", "x: ", "---\n"), maxLength: 60 });

  it("takes the other side when one side made no edits", () => {
    fc.assert(
      fc.property(anyText, anyText, (base, edit) => {
        expect(merge3(base, base, edit)).toMatchObject({ conflicts: 0, text: edit });
        expect(merge3(base, edit, base)).toMatchObject({ conflicts: 0, text: edit });
      }),
    );
  });

  it("finds no conflict in identical edits", () => {
    fc.assert(fc.property(anyText, anyText, (base, edit) => void expect(merge3(base, edit, edit)).toMatchObject({ conflicts: 0, text: edit })));
  });

  it("applies edits to different paragraphs from both sides", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(paragraph, { minLength: 2, maxLength: 12 }),
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        fc.array(fc.option(fc.constantFrom("edit", "delete"), { nil: undefined }), { minLength: 12, maxLength: 12 }),
        (paras, side, change) => {
          const ours = [...paras];
          const theirs = [...paras];
          paras.forEach((p, i) => {
            if (!change[i]) return;
            const target = side[i] ? ours : theirs;
            target[i] = change[i] === "edit" ? `${p} (edited ${i})` : "";
          });
          const join = (ps: string[]) => `${ps.filter(Boolean).join("\n\n")}\n`;
          const expected = paras.map((p, i) => (ours[i] !== p ? ours[i]! : theirs[i]!));
          const merged = merge3(join(paras), join(ours), join(theirs));
          expect(merged.conflicts).toBe(0);
          // Deleting the first paragraph can leave the blank line that followed it.
          const tidy = (s: string) => s.replace(/^\n+/, "");
          expect(tidy(merged.text!)).toBe(tidy(join(expected)));
        },
      ),
    );
  });

  it("gives back each side exactly when every conflict keeps that side (merge2)", () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const { chunks, conflicts } = merge2(a, b);
        expect(resolveMerge(chunks, Array(conflicts).fill("ours"))).toBe(a);
        expect(resolveMerge(chunks, Array(conflicts).fill("theirs"))).toBe(b);
      }),
    );
  });

  it("loses nothing: keeping our side of every conflict gives ours plus their non-conflicting edits", () => {
    fc.assert(
      fc.property(anyText, anyText, anyText, (base, ours, theirs) => {
        const { chunks, conflicts } = merge3(base, ours, theirs);
        // Every chunk is text from an input, so with no theirs changes in play, ours comes back.
        if (theirs === base) expect(resolveMerge(chunks, Array(conflicts).fill("ours"))).toBe(ours);
        for (const c of chunks) if (c.type === "conflict") expect(c.ours).not.toBe(c.theirs);
      }),
    );
  });
});

describe("prose", () => {
  const base = scene(FRONT, PARAS);

  it("merges edits to neighbouring paragraphs", () => {
    const ours = scene(FRONT, ["The train was very late.", ...PARAS.slice(1)]);
    const theirs = scene(FRONT, [PARAS[0]!, "Ada stepped down onto the platform.", ...PARAS.slice(2)]);
    expect(merge3(base, ours, theirs)).toMatchObject({
      conflicts: 0,
      text: scene(FRONT, ["The train was very late.", "Ada stepped down onto the platform.", ...PARAS.slice(2)]),
    });
  });

  it("makes one conflict of edits to the same paragraph", () => {
    const ours = scene(FRONT, [PARAS[0]!, "Ada jumped down.", ...PARAS.slice(2)]);
    const theirs = scene(FRONT, [PARAS[0]!, "Ada climbed down.", ...PARAS.slice(2)]);
    const merged = merge3(base, ours, theirs);
    expect(merged.conflicts).toBe(1);
    expect(conflicts(merged.chunks)).toEqual([{ type: "conflict", base: "Ada stepped down.\n", ours: "Ada jumped down.\n", theirs: "Ada climbed down.\n" }]);
    expect(resolveMerge(merged.chunks, ["ours"])).toBe(ours);
    expect(resolveMerge(merged.chunks, ["theirs"])).toBe(theirs);
    expect(resolveMerge(merged.chunks, ["both"])).toBe(scene(FRONT, [PARAS[0]!, "Ada jumped down.", "Ada climbed down.", ...PARAS.slice(2)]));
    expect(resolveMerge(merged.chunks, [{ text: "Ada stepped carefully down.\n" }])).toBe(scene(FRONT, [PARAS[0]!, "Ada stepped carefully down.", ...PARAS.slice(2)]));
  });

  it("keeps neighbouring edits on one side apart, so only the paragraph both changed conflicts", () => {
    const ours = scene(FRONT, [PARAS[0]!, "Ada jumped down.", ...PARAS.slice(2)]);
    const theirs = scene(FRONT, [PARAS[0]!, "Ada climbed down.", "Flags on the bridge, red ones.", PARAS[3]!]);
    const merged = merge3(base, ours, theirs);
    expect(conflicts(merged.chunks)).toEqual([expect.objectContaining({ ours: "Ada jumped down.\n", theirs: "Ada climbed down.\n" })]);
    expect(resolveMerge(merged.chunks, ["ours"])).toBe(scene(FRONT, [PARAS[0]!, "Ada jumped down.", "Flags on the bridge, red ones.", PARAS[3]!]));
  });

  it("keeps both new paragraphs added at the same place, as separate paragraphs", () => {
    const ours = scene(FRONT, [...PARAS, "Mine at the end."]);
    const theirs = scene(FRONT, [...PARAS, "Theirs at the end."]);
    const merged = merge3(base, ours, theirs);
    expect(merged.conflicts).toBe(1);
    expect(resolveMerge(merged.chunks, ["both"])).toBe(scene(FRONT, [...PARAS, "Mine at the end.", "Theirs at the end."]));
  });

  it("conflicts when one side edits a paragraph the other deleted", () => {
    const ours = scene(FRONT, [PARAS[0]!, "Ada stepped down, slowly.", ...PARAS.slice(2)]);
    const theirs = scene(FRONT, [PARAS[0]!, ...PARAS.slice(2)]);
    const [c, ...rest] = conflicts(merge3(base, ours, theirs).chunks);
    expect(rest).toEqual([]);
    // The paragraph's blank line goes with it.
    expect(c).toMatchObject({ base: "\nAda stepped down.\n", ours: "\nAda stepped down, slowly.\n", theirs: "" });
  });

  it("keeps CRLF line endings and a missing final newline", () => {
    const b = "One.\r\n\r\nTwo.\r\n\r\nThree.";
    expect(merge3(b, b.replace("One.", "Uno."), b.replace("Three.", "Tres.")).text).toBe("Uno.\r\n\r\nTwo.\r\n\r\nTres.");
  });
});

describe("front matter", () => {
  const base = scene(FRONT, PARAS);

  it("merges different fields even on neighbouring lines", () => {
    const ours = scene(FRONT.map((l) => (l.startsWith("synopsis") ? "synopsis: Ada comes home to Varn." : l)), PARAS);
    const theirs = scene(FRONT.map((l) => (l.startsWith("status") ? "status: revised" : l)), PARAS);
    expect(merge3(base, ours, theirs)).toMatchObject({
      conflicts: 0,
      text: scene(FRONT.map((l) => (l.startsWith("synopsis") ? "synopsis: Ada comes home to Varn." : l.startsWith("status") ? "status: revised" : l)), PARAS),
    });
  });

  it("reports a conflict in one field by its key, alongside a body merge", () => {
    const ours = scene(FRONT.map((l) => (l.startsWith("status") ? "status: revised" : l)), ["The train was very late.", ...PARAS.slice(1)]);
    const theirs = scene(FRONT.map((l) => (l.startsWith("status") ? "status: final" : l)), [...PARAS.slice(0, 3), "She counted them twice."]);
    const merged = merge3(base, ours, theirs);
    expect(conflicts(merged.chunks)).toEqual([{ type: "conflict", base: "status: drafted\n", ours: "status: revised\n", theirs: "status: final\n", field: "status" }]);
    expect(resolveMerge(merged.chunks, ["theirs"])).toBe(
      scene(FRONT.map((l) => (l.startsWith("status") ? "status: final" : l)), ["The train was very late.", ...PARAS.slice(1, 3), "She counted them twice."]),
    );
    expect(() => resolveMerge(merged.chunks, ["both"])).toThrow(/can't keep both/);
  });

  it("treats nested values and lists as part of their field, and adds fields from both sides", () => {
    const withPlot = (beat: string, extra: string[] = []) => [...FRONT, "plotlines:", "  - id: plot_h315tz", `    beat: ${beat}`, "tags:", "- quiet", ...extra];
    const b = scene(withPlot("First sign"), PARAS);
    const ours = scene([...withPlot("First sign of the sale"), "duration: PT20M"], PARAS);
    const theirs = scene(withPlot("First sign", ["- rewrite-candidate"]).toSpliced(1, 0, "when:", "  day: 1"), PARAS);
    const merged = merge3(b, ours, theirs);
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe(scene([...withPlot("First sign of the sale", ["- rewrite-candidate"]).toSpliced(1, 0, "when:", "  day: 1"), "duration: PT20M"], PARAS));
  });

  it("removes a field one side deleted and the other left alone", () => {
    const ours = scene(FRONT.filter((l) => !l.startsWith("pov")), PARAS);
    const theirs = scene(FRONT, ["The train was very late.", ...PARAS.slice(1)]);
    expect(merge3(base, ours, theirs).text).toBe(scene(FRONT.filter((l) => !l.startsWith("pov")), ["The train was very late.", ...PARAS.slice(1)]));
  });

  it("keeps comments with the field they precede", () => {
    const b = "---\nid: sc_a\n# Draft status, see notes\nstatus: idea\ntitle: T\n---\nBody.\n";
    const merged = merge3(b, b.replace("title: T", "title: Tea"), b.replace("status: idea", "status: drafted"));
    expect(merged.text).toBe("---\nid: sc_a\n# Draft status, see notes\nstatus: drafted\ntitle: Tea\n---\nBody.\n");
  });

  it("merges files without front matter line by line", () => {
    const yaml = "id: ch_arr1va\ntitle: Arrival\nscenes: [sc_5tat1n, sc_br1dg3]\n";
    const merged = merge3(yaml, yaml.replace("Arrival", "Arrivals"), yaml.replace("sc_br1dg3]", "sc_br1dg3, sc_n3wn3w]"));
    // Neighbouring lines merge, where git would call it a conflict.
    expect(merged.text).toBe("id: ch_arr1va\ntitle: Arrivals\nscenes: [sc_5tat1n, sc_br1dg3, sc_n3wn3w]\n");
  });
});

describe("merge2", () => {
  it("keeps what both have and makes each difference a conflict", () => {
    const { chunks } = merge2("A.\n\nB.\n\nC.\n", "A.\n\nB2.\n\nC.\n\nD.\n");
    expect(conflicts(chunks).map((c) => [c.type === "conflict" && c.ours, c.type === "conflict" && c.theirs])).toEqual([
      ["B.\n", "B2.\n"],
      ["", "\nD.\n"],
    ]);
  });
});
