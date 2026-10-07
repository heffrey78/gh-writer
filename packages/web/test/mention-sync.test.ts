import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { editFrontMatter, loadNovel, readFrontMatter } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { describe, expect, it } from "vitest";
import { mentionEdits } from "../src/novel/mention-sync.ts";

const root = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const novel = await loadNovel(nodeSource(root));
const file = readFileSync(`${root}${STATION}`, "utf8");
const body = file.slice(file.indexOf("\n---\n", 4) + 5);

describe("keeping a scene's people and places in step with its mentions", () => {
  it("a new mention of someone or somewhere not listed adds them, changing only that list's line", () => {
    const after = `${body}\n[Mirela](#char_m1re1a) watched from [the workshop](#loc_w0rk5p).\n`;
    const edits = mentionEdits(novel, file, body, after);
    const out = editFrontMatter(file, edits);
    expect(readFrontMatter(out)?.characters).toEqual([...(readFrontMatter(file)!.characters as string[]), "char_m1re1a"]);
    expect(readFrontMatter(out)?.locations).toEqual([...(readFrontMatter(file)!.locations as string[]), "loc_w0rk5p"]);
    const changed = out.split("\n").filter((line, i) => line !== file.split("\n")[i]);
    expect(changed.map((l) => l.split(":")[0])).toEqual(["characters", "locations"]);
  });

  it("adds nothing for someone already listed, a plotline or theme, or a mention that was already there", () => {
    expect(mentionEdits(novel, file, body, `${body}\n[Ada](#char_7f3k2q) again.\n`)).toEqual([]);
    expect(mentionEdits(novel, file, body, `${body}\n[The Sale](#plot_h315tz).\n`)).toEqual([]);
    // Ben was taken off the list, but his mention was there before this edit: he stays off.
    const withBen = `${body}\n[Ben](#char_b3n0vs).\n`;
    const offList = editFrontMatter(file, [{ path: ["characters"], value: ["char_7f3k2q"] }]);
    expect(mentionEdits(novel, offList, withBen, `${withBen}More.\n`)).toEqual([]);
    // Removing a mention removes nothing.
    expect(mentionEdits(novel, file, withBen, body)).toEqual([]);
  });

  it("starts a list the scene doesn't have yet", () => {
    const bare = file.replace(/^characters:.*\n/m, "");
    expect(mentionEdits(novel, bare, body, `${body}\n[Ben](#char_b3n0vs).\n`)).toEqual([{ path: ["characters"], value: ["char_b3n0vs"] }]);
  });
});
