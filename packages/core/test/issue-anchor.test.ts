import { describe, expect, it } from "vitest";
import { passageIssueBody, readAnchor, writeAnchor } from "../src/index.ts";

describe("issue anchors", () => {
  it("round-trips through a footer that no quote can break out of", () => {
    for (const quote of [
      "She stood with her bag at her feet.",
      'He said "--> it\'s done <!-- or not -->" and left.',
      "Line one\nLine two\n\nAfter a blank line.",
      "<script>alert(1)</script> & </textarea>",
      "Dashes -- and --- and ----",
      "Ünïcødé “quotes” — and an emoji 🌉",
    ]) {
      const footer = writeAnchor({ scene: "sc_0d9wm4", quote, commit: "abc123" });
      expect(footer).toMatch(/^<!-- gh-writer \{.*\} -->$/s);
      // The comment ends only where it should, and holds no markup.
      expect(footer.slice(4, -3)).not.toMatch(/-->|<|>|--/);
      expect(readAnchor(`Some note.\n\n${footer}`)).toEqual({ scene: "sc_0d9wm4", quote, commit: "abc123" });
    }
  });

  it("finds the footer wherever it ends up, the last one if there are two, and nothing in a plain issue", () => {
    const a = writeAnchor({ scene: "sc_aaaaaa", quote: "first" });
    const b = writeAnchor({ scene: "sc_bbbbbb", quote: "second" });
    expect(readAnchor(`${a}\n\nEdited on github.com: more text after.\n<!-- gh-writer-create: x -->`)).toEqual({ scene: "sc_aaaaaa", quote: "first" });
    expect(readAnchor(`${a}\n${b}`)?.scene).toBe("sc_bbbbbb");
    expect(readAnchor("Just an issue.")).toBeUndefined();
    expect(readAnchor('<!-- gh-writer {"scene":"sc_aaaaaa"} -->')).toBeUndefined();
    expect(readAnchor("<!-- gh-writer {not json} -->")).toBeUndefined();
  });

  it("writes a body that reads well on GitHub: the note, the passage quoted, where it's from", () => {
    const body = passageIssueBody({
      details: "The clock says otherwise in chapter two.\n",
      quote: "Twelve years had not moved the station clock.\n\nIt still ran four minutes fast.",
      sceneTitle: "The Station",
      link: "https://github.com/ada/varn/blob/abc123/manuscript/01-return/01-arrival/01-the-station.md?plain=1#L9",
      anchor: { scene: "sc_5tat1n", quote: "Twelve years had not moved the station clock.\n\nIt still ran four minutes fast.", commit: "abc123" },
    });
    expect(body.split("\n<!--")[0]).toBe(
      [
        "The clock says otherwise in chapter two.",
        "",
        "> Twelve years had not moved the station clock.",
        ">",
        "> It still ran four minutes fast.",
        "",
        "From [*The Station*](https://github.com/ada/varn/blob/abc123/manuscript/01-return/01-arrival/01-the-station.md?plain=1#L9).",
        "",
      ].join("\n"),
    );
    expect(readAnchor(body)).toMatchObject({ scene: "sc_5tat1n", commit: "abc123" });
    expect(passageIssueBody({ details: "", quote: "A line.", sceneTitle: "The Station", anchor: { scene: "sc_5tat1n", quote: "A line." } })).toMatch(/^> A line\.\n\nFrom \*The Station\*\.\n\n<!-- gh-writer /);
  });
});
