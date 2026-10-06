// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, test } from "vitest";
import { getMarkdown, loadMarkdown, mentionSuggestKey, MentionSuggestExtension, proseContent, suggestMentions, type MentionEntity } from "../src/index.ts";

Element.prototype.scrollIntoView = () => {};

const entities: MentionEntity[] = [
  { id: "char_7f3k2q", name: "Ada Varn", aliases: ["Ada"], type: "Character" },
  { id: "char_b3n0vs", name: "Ben Varn", aliases: ["Ben"], type: "Character" },
  { id: "char_m1re1a", name: "Mirela Kost", aliases: ["Mirela", "Kost", "M. K."], type: "Character" },
  { id: "loc_br1dg3", name: "The Varn Bridge", aliases: ["the bridge", "the span"], type: "Location" },
];

describe("suggestMentions", () => {
  test("finds names and aliases, best first, grouped by type, labelled with the term matched", () => {
    expect(suggestMentions(entities, "ad").map((s) => [s.entity.id, s.label])).toEqual([["char_7f3k2q", "Ada"]]);
    expect(suggestMentions(entities, "ada v").map((s) => s.label)).toEqual(["Ada Varn"]);
    expect(suggestMentions(entities, "kost").map((s) => [s.entity.name, s.label])).toEqual([["Mirela Kost", "Kost"]]);
    // A word inside a name (Varn) ranks above a match mid-word; characters come before locations.
    expect(suggestMentions(entities, "varn").map((s) => s.entity.name)).toEqual(["Ada Varn", "Ben Varn", "The Varn Bridge"]);
    expect(suggestMentions(entities, "span").map((s) => [s.entity.name, s.label])).toEqual([["The Varn Bridge", "The Varn Bridge"]]);
    expect(suggestMentions(entities, "the s").map((s) => s.label)).toEqual(["the span"]);
    expect(suggestMentions(entities, "")).toHaveLength(4);
    expect(suggestMentions(entities, "zed")).toEqual([]);
  });
});

describe("MentionSuggestExtension", () => {
  let editor: Editor;
  afterEach(() => editor?.destroy());

  function open(markdown: string) {
    editor = new Editor({ element: document.body.appendChild(document.createElement("div")), extensions: [...proseContent, MentionSuggestExtension.configure({ entities: () => entities })] });
    loadMarkdown(editor, markdown);
    editor.commands.focus("end");
    return editor;
  }
  const type = (text: string) => {
    for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch));
  };
  const key = (name: string) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, event));
    return event.defaultPrevented;
  };
  const active = () => mentionSuggestKey.getState(editor.state)?.active;
  const listbox = () => document.querySelector('[role="listbox"]');

  test("@ and letters open a listbox the text box points at; Enter inserts a mention that round-trips", () => {
    open("She looked up at");
    type(" @ad");
    expect(active()?.query).toBe("ad");
    expect(listbox()?.getAttribute("aria-label")).toBe("Mention suggestions");
    expect([...listbox()!.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(["Ada Varn as “Ada”"]);
    expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(listbox()!.querySelector('[aria-selected="true"]')!.id);
    expect(key("Enter")).toBe(true);
    type("and smiled.");
    expect(getMarkdown(editor)).toBe("She looked up at [Ada](#char_7f3k2q) and smiled.\n");
    expect(listbox()).toBeNull();
    expect(editor.view.dom.hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("arrows move through the suggestions and Tab inserts the chosen one", () => {
    open("");
    type("@varn");
    expect(active()?.items.map((i) => i.entity.name)).toEqual(["Ada Varn", "Ben Varn", "The Varn Bridge"]);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowDown"); // wraps
    key("ArrowUp"); // and back
    expect(active()?.index).toBe(2);
    key("Tab");
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, "", (n) => n.attrs.label as string)).toBe("The Varn Bridge ");
    expect(getMarkdown(editor)).toBe("[The Varn Bridge](#loc_br1dg3)\n");
  });

  test("Escape leaves the @ text as typed, until the author leaves it", () => {
    open("");
    type("@Ben");
    expect(key("Escape")).toBe(true);
    expect(active()).toBeNull();
    type("n");
    expect(active()).toBeNull();
    expect(key("Enter")).toBe(false);
    expect(getMarkdown(editor)).toBe("@Benn\n");
    type(" and @mi");
    expect(active()?.items[0]?.label).toBe("Mirela");
  });

  test("no suggestions for an @ inside a word, after the query stops matching, or with nothing to suggest", () => {
    open("");
    type("mail@ada");
    expect(active()).toBeNull();
    type(" @ada went");
    expect(active()).toBeNull();
    editor.destroy();
    editor = new Editor({ element: document.body.appendChild(document.createElement("div")), extensions: [...proseContent, MentionSuggestExtension] });
    editor.commands.focus("end");
    type("@a");
    expect(active()).toBeNull();
  });

  test("keeps no space before punctuation that follows", () => {
    open("Then .");
    editor.commands.setTextSelection(6);
    type("@be");
    key("Enter");
    expect(getMarkdown(editor)).toBe("Then [Ben](#char_b3n0vs).\n");
  });
});
