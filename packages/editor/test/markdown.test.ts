import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import fc from "fast-check";
import type { Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { describe, expect, test } from "vitest";
import { joinSceneFile, parseProse, proseSchema as schema, serializeProse, splitSceneFile } from "../src/index.ts";

const root = join(import.meta.dirname, "../../..");
const roundTrip = (md: string) => serializeProse(parseProse(md));

/** Parse, apply edits as ProseMirror steps (as the editor would), serialize. */
function edit(md: string, change: (tr: Transform) => void): string {
  const tr = new Transform(parseProse(md));
  change(tr);
  return serializeProse(tr.doc);
}

/** Insert plain text at a position, as typing would. */
function type(tr: Transform, text: string, pos: number): Transform {
  return tr.insert(pos, schema.text(text, tr.doc.resolve(pos).marks()));
}

/** Document position of the first occurrence of `text`. */
function at(doc: Node, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    const i = found < 0 && node.isText ? node.text!.indexOf(text) : -1;
    if (i >= 0) found = pos + i;
    return found < 0;
  });
  if (found < 0) throw new Error(`"${text}" not in document`);
  return found;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(root, dir, f));
}

describe("unedited round-trip", () => {
  const files = [...markdownFiles("examples/sample-novel"), ...markdownFiles("templates/novel"), join(root, "docs/format/v1.md")];

  test.each(files.map((f) => [relative(root, f), f]))("%s", (_name, file) => {
    const text = readFileSync(file, "utf8");
    const scene = splitSceneFile(text);
    expect(joinSceneFile({ ...scene, body: roundTrip(scene.body) })).toBe(text);
  });

  // Shapes that hand edits on github.com, other editors and other operating systems produce.
  const fixtures: Record<string, string> = {
    "underscore emphasis": "She said _no_, and __meant__ it.\n",
    "mixed markers": "*one* _two_ **three** __four__ ***five*** _**six**_\n",
    "intraword emphasis": "un*believ*able and snake_case_name\n",
    "hard-wrapped paragraph": "The train gave up the last of its heat\nas it pulled into Varn, and she\nwas the only passenger who stood.\n\nNext.\n",
    "no trailing newline": "Last line",
    "several trailing newlines": "Text.\n\n\n",
    "leading blank lines": "\n\nText.\n",
    "extra blank lines between paragraphs": "One.\n\n\n\nTwo.\n",
    "whitespace-only lines between paragraphs": "One.\n  \n\t\nTwo.\n",
    "trailing spaces": "One.   \n\nTwo. \n",
    "CRLF line endings": "One.\r\n\r\nTwo\\\r\nlines.\r\n",
    "mixed line endings": "One.\r\n\nTwo.\n\r\n",
    "section breaks": "Before.\n\n***\n\nMiddle.\n\n* * *\n\n___\n\n- - -\n\nAfter.\n",
    "rule straight after a paragraph": "Before.\n***\nAfter.\n",
    "backslash and two-space breaks": "Roses are red,\\\nviolets are blue,  \nsugar is sweet.\n",
    "deeper indentation": "  Indented two.\n\n   Indented three.\n",
    "escapes and entities": "5 \\* 3 &amp; \\_x\\_ &mdash; &#39;quoted&#39; \\[not a link\\]\n",
    "unicode punctuation": "“Hello,” she said—quietly… café  nbsp\n",
    mentions: "[Ada](#char_7f3k2q) met [Ben Varn](#char_b3n0vs) at [the bridge](#loc_br1dg3).\n",
    "mention inside emphasis": "*[Ada](#char_7f3k2q) was late.*\n",
    "mention with formatted label": "[*Ada*](#char_7f3k2q)\n",
    "not an ID": "[Ada](#ada) and [x](#char_ILOU00)\n",
    links: '[site](https://example.com "Title") <https://example.com> www.example.com\n',
    "reference links": "See [the plans][plans] and [plans].\n\n[plans]: https://example.com/plans\n",
    footnotes: "A claim.[^1]\n\n[^1]: The source.\n",
    "inline code, images, strikethrough, html": "Run `make`, see ![map](map.png), ~~cut~~, <span>raw</span>.\n",
    "block quote": "> She read the letter twice.\n> Then she burned it.\n\nAfter.\n",
    "lazy quote continuation": "> First line\ncontinues lazily.\n",
    "nested quote": "> Outer.\n>\n> > Inner.\n",
    "quote with a list": "> - one\n> - two\n",
    "quote with a multi-line raw inline": "> a `code\n> span` here\n",
    "empty quote": ">\n",
    lists: "- one\n- two\n\n1. first\n2. second\n",
    heading: "# Chapter One\n\nText.\n\nSetext\n======\n",
    table: "| Day | Event |\n|-----|-------|\n| 1 | Arrival |\n",
    "fenced code": "```\ncode *not em*\n```\n",
    "indented code": "Para.\n\n    indented code\n",
    "html block": "<div align=\"center\">\n\n*centered*\n\n</div>\n",
    "html comment": "<!-- note to self -->\n\nText.\n",
    empty: "",
    "only newlines": "\n\n",
    "only spaces": "   ",
  };

  test.each(Object.entries(fixtures))("%s", (_name, md) => {
    expect(roundTrip(md)).toBe(md);
  });

  test("front matter keeps BOM and CRLF", () => {
    const text = "﻿---\r\nid: sc_5tat1n\r\ntitle: X\r\n---\r\nProse.\r\n";
    const scene = splitSceneFile(text);
    expect(scene.frontMatter).toBe("﻿---\r\nid: sc_5tat1n\r\ntitle: X\r\n---\r\n");
    expect(scene.body).toBe("Prose.\r\n");
    expect(joinSceneFile({ ...scene, body: roundTrip(scene.body) })).toBe(text);
  });

  test("a file without front matter is all body", () => {
    expect(splitSceneFile("Just prose.\n")).toEqual({ frontMatter: "", body: "Just prose.\n" });
    expect(splitSceneFile("---\n---\nBody")).toEqual({ frontMatter: "---\n---\n", body: "Body" });
  });

  test("arbitrary Markdown round-trips unedited", () => {
    const unit = fc.constantFrom(..."ab \n\n\n\t*_[]()#>-+=`~|!<&\\:.1".split(""), "#char_7f3k2q", "\r\n", "    ", "http://x.y");
    fc.assert(fc.property(fc.string({ unit, maxLength: 80 }), (md) => roundTrip(md) === md), { numRuns: Number(process.env.FUZZ_RUNS ?? 3000) });
  }, Number(process.env.FUZZ_TIMEOUT ?? 120_000));
});

describe("document model", () => {
  test("mentions become mention nodes carrying the entity ID", () => {
    const doc = parseProse("[Ada](#char_7f3k2q) and *[Ben Varn](#char_b3n0vs)*\n");
    const mentions: Node[] = [];
    doc.descendants((n) => void (n.type.name === "mention" && mentions.push(n)));
    expect(mentions.map((m) => [m.attrs.id, m.attrs.label, m.marks.map((k) => k.type.name)])).toEqual([
      ["char_7f3k2q", "Ada", []],
      ["char_b3n0vs", "Ben Varn", ["em"]],
    ]);
  });

  test("links that aren't mentions stay links", () => {
    const doc = parseProse("[Ada](#ada) [x](https://example.com)\n");
    const hrefs: string[] = [];
    doc.descendants((n) => void n.marks.forEach((m) => m.type.name === "link" && hrefs.push(m.attrs.href)));
    expect([...new Set(hrefs)]).toEqual(["#ada", "https://example.com"]);
  });

  test("unsupported Markdown is held as raw nodes with its exact source", () => {
    const doc = parseProse("Run `make` now.\n\n- a\n- b\n\n> - quoted list\n");
    expect(doc.child(0).child(1).type.name).toBe("raw_inline");
    expect(doc.child(0).child(1).attrs.text).toBe("`make`");
    expect([doc.child(1).type.name, doc.child(1).textContent]).toEqual(["raw_block", "- a\n- b"]);
    expect([doc.child(2).type.name, doc.child(2).textContent]).toEqual(["raw_block", "> - quoted list"]);
  });

  test("hard-wrapped lines read as one paragraph", () => {
    const doc = parseProse("one\ntwo\n  three\n");
    expect(doc.childCount).toBe(1);
    expect(doc.textContent).toBe("one two three");
  });
});

describe("edits", () => {
  const scene = "The train pulled in.\n\nShe was the _only_ passenger who stood.\n\nThe clock ran fast.\n";

  test("italicising a word changes only that paragraph's line", () => {
    const out = edit(scene, (tr) => {
      const from = at(tr.doc, "clock");
      tr.addMark(from, from + 5, schema.marks.em!.create());
    });
    expect(out).toBe(scene.replace("The clock", "The _clock_"));
  });

  test("an edited paragraph keeps the emphasis markers it used", () => {
    const out = edit(scene, (tr) => type(tr, " alone", at(tr.doc, " who")));
    expect(out).toBe(scene.replace("passenger who", "passenger alone who"));
  });

  test("new emphasis defaults to asterisks", () => {
    const out = edit("Plain words.\n", (tr) => tr.addMark(1, 6, schema.marks.strong!.create()));
    expect(out).toBe("**Plain** words.\n");
  });

  test("inserting a paragraph adds one line and a blank line", () => {
    const out = edit(scene, (tr) => {
      tr.insert(tr.doc.child(0).nodeSize, schema.nodes.paragraph!.create(null, schema.text("A new paragraph.")));
    });
    expect(out).toBe(scene.replace("\n\nShe", "\n\nA new paragraph.\n\nShe"));
  });

  test("splitting a paragraph (which copies its attributes) gives two paragraphs", () => {
    const out = edit(scene, (tr) => tr.split(at(tr.doc, " who")));
    expect(out).toBe(scene.replace("passenger who", "passenger\n\nwho"));
  });

  test("joining two paragraphs", () => {
    const out = edit(scene, (tr) => tr.join(tr.doc.child(0).nodeSize));
    expect(out).toBe(scene.replace("in.\n\nShe", "in.She"));
  });

  test("deleting a paragraph removes it and its gap", () => {
    const out = edit(scene, (tr) => tr.delete(tr.doc.child(0).nodeSize, tr.doc.child(0).nodeSize + tr.doc.child(1).nodeSize));
    expect(out).toBe("The train pulled in.\n\nThe clock ran fast.\n");
  });

  test("empty paragraphs are not written", () => {
    const out = edit(scene, (tr) => tr.insert(tr.doc.child(0).nodeSize, schema.nodes.paragraph!.create()));
    expect(out).toBe(scene);
  });

  test("deleting everything leaves an empty body", () => {
    const out = edit(scene, (tr) => tr.replaceWith(0, tr.doc.content.size, schema.nodes.paragraph!.create()));
    expect(out).toBe("\n");
  });

  test("an edited hard-wrapped paragraph becomes one line", () => {
    const out = edit("one\ntwo\nthree\n\nnext\n", (tr) => type(tr, "!", at(tr.doc, " three") + 6));
    expect(out).toBe("one two three!\n\nnext\n");
  });

  test("a section break straight after an edited paragraph gets a blank line", () => {
    const out = edit("Before.\n***\nAfter.\n", (tr) => type(tr, "!", at(tr.doc, ".")));
    expect(out).toBe("Before!.\n\n***\nAfter.\n");
  });

  test("CRLF files stay CRLF", () => {
    const md = "One.\r\n\r\nTwo.\r\n";
    const out = edit(md, (tr) => tr.insert(tr.doc.content.size, schema.nodes.paragraph!.create(null, schema.text("Three."))));
    expect(out).toBe("One.\r\n\r\nTwo.\r\n\r\nThree.\r\n");
  });

  test("breaks keep their style; edge breaks are dropped", () => {
    const md = "Roses are red,  \nviolets are blue.\n";
    expect(edit(md, (tr) => type(tr, "!", at(tr.doc, ".")))).toBe("Roses are red,  \nviolets are blue!.\n");
    const br = schema.nodes.hard_break!.create();
    expect(edit("a\n", (tr) => tr.insert(2, br).insert(1, br))).toBe("a\n");
  });

  test("text that looks like Markdown is escaped", () => {
    const out = edit("x\n", (tr) => tr.replaceWith(1, 2, schema.text("# 1. *not* [a](link)")));
    expect(parseProse(out).textContent).toBe("# 1. *not* [a](link)");
    expect(parseProse(out).child(0).type.name).toBe("paragraph");
  });

  test("a new mention serializes as a link to the entity ID", () => {
    const mention = schema.nodes.mention!.create({ id: "char_7f3k2q", label: "Ada [the engineer]" });
    expect(edit("Hello .\n", (tr) => tr.insert(7, mention))).toBe("Hello [Ada \\[the engineer\\]](#char_7f3k2q).\n");
  });

  test("edits next to raw content keep it verbatim", () => {
    const md = "Run `make` now.\n\n| a |\n|---|\n";
    expect(edit(md, (tr) => type(tr, "!", at(tr.doc, " now") + 4))).toBe("Run `make` now!.\n\n| a |\n|---|\n");
  });
});

describe("canonical serialization", () => {
  const text = fc.string({ unit: fc.constantFrom(..."ab  *_[]()#>-+=`~|!<&\\:.1 ".split("")), minLength: 1, maxLength: 12 });
  const markSet = fc.subarray(["em", "strong", "link"] as const);
  const href = fc.constantFrom("https://example.com", "https://example.com/a_b*c", "#not-an-id", "page.md");
  const inline: fc.Arbitrary<Node> = fc.oneof(
    { weight: 6, arbitrary: fc.tuple(text, markSet, href).map(([t, marks, h]) => schema.text(t, marks.map((m) => (m === "link" ? schema.marks.link!.create({ href: h }) : schema.marks[m]!.create())))) },
    { weight: 1, arbitrary: fc.constant(schema.nodes.hard_break!.create()) },
    { weight: 1, arbitrary: fc.tuple(fc.constantFrom("Ada", "Ben *Varn*", "a]b"), fc.subarray(["em", "strong"] as const)).map(([label, marks]) => schema.nodes.mention!.create({ id: "char_7f3k2q", label }, null, marks.map((m) => schema.marks[m]!.create()))) },
  );
  const paragraph = fc.array(inline, { maxLength: 8 }).map((content) => schema.nodes.paragraph!.create(null, content));
  const blockArb: fc.Arbitrary<Node> = fc.oneof(
    { weight: 6, arbitrary: paragraph },
    { weight: 1, arbitrary: fc.array(paragraph, { minLength: 1, maxLength: 3 }).map((ps) => schema.nodes.blockquote!.create(null, ps)) },
    { weight: 1, arbitrary: fc.constant(schema.nodes.horizontal_rule!.create()) },
  );
  const docArb = fc.array(blockArb, { minLength: 1, maxLength: 5 }).map((blocks) => schema.nodes.doc!.create(null, blocks));

  /**
   * What a document means in Markdown: per paragraph, each character with its marks, breaks and
   * mentions, with the whitespace Markdown can't keep (paragraph edges, around breaks) removed
   * and empty paragraphs and quotes dropped. Emphasis on whitespace is invisible and ignored.
   */
  const visible = (marks: readonly import("prosemirror-model").Mark[]) =>
    marks.filter((m) => m.type.name === "link").map((m) => m.type.name + m.attrs.href).join(",");

  function meaning(node: Node): unknown {
    if (node.type.name === "paragraph") {
      const lines: string[][] = [[]];
      node.forEach((child) => {
        const marks = child.marks.map((m) => m.type.name + (m.attrs.href ?? "")).join(",");
        if (child.type.name === "hard_break") lines.push([]);
        else if (child.type.name === "mention") lines.at(-1)!.push(`@${child.attrs.id}:${child.attrs.label}|${marks}`);
        else for (const ch of child.text!) lines.at(-1)!.push(ch === " " ? `${ch}|${visible(child.marks)}` : `${ch}|${marks}`);
      });
      const isSpace = (t: string | undefined) => t?.[0] === " " && t[1] === "|";
      for (const line of lines) {
        while (isSpace(line[0])) line.shift();
        while (isSpace(line.at(-1))) line.pop();
      }
      while (lines.length && !lines[0]!.length) lines.shift();
      while (lines.length && !lines.at(-1)!.length) lines.pop();
      return lines.length ? lines : undefined;
    }
    if (node.type.name === "horizontal_rule") return "***";
    const children: unknown[] = [];
    node.forEach((c) => {
      const m = meaning(c);
      if (m !== undefined) children.push(m);
    });
    return children.length || node.type.name === "doc" ? { [node.type.name]: children } : undefined;
  }

  test("serialized documents parse back to the same content", () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const md = serializeProse(doc);
        expect(meaning(parseProse(md))).toEqual(meaning(doc));
        expect(roundTrip(md)).toBe(md);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 2000), ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}) },
    );
  }, Number(process.env.FUZZ_TIMEOUT ?? 120_000));
});
