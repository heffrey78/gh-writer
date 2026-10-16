import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, caretAtEnd, expect, openView, test, type App } from "./fixtures.ts";

/** Notes, off-page events and entries open as a modal over their gallery (#233), their parts saved on leaving them (#234). */

const ADA = "bible/characters/ada.md";

async function openNovel(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return { dir, read: (path: string) => readFileSync(join(dir, path), "utf8"), files: (folder: string) => readdirSync(join(dir, folder)).sort() };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

const views = (page: Page) => page.getByRole("navigation", { name: "Views" });
/** Underneath a modal: there, but hidden from assistive technology while it's open. */
const under = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name, includeHidden: true });

test("a note: made in its modal over Notes by a title, written, closed by clicking away; Back closes it (#235)", async ({ page, app }) => {
  const novel = await openNovel(page, app);
  await views(page).getByRole("link", { name: "Notes" }).click();
  await page.getByRole("button", { name: "New note" }).click();

  // Just its title, and no Add button.
  const modal = page.getByRole("dialog", { name: "New note" });
  await expect(modal.getByRole("textbox", { name: "Title" })).toBeFocused();
  await expect(modal.getByRole("button", { name: /^Add/ })).toHaveCount(0);
  await expect(under(page, /^Notes/)).toBeAttached();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  // Moving on makes it; the caret goes to its prose.
  await page.keyboard.type("Count the flags");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Note: Count the flags" })).toBeFocused();
  await expect(page).toHaveURL(/\/note\/note_[0-9a-z]{6}$/);
  await page.keyboard.type("Nine flags, one missing.");
  await expect.poll(() => novel.read("notes/count-the-flags.md")).toMatch(/title: Count the flags\n[\s\S]*---\n\n?Nine flags, one missing\.\n$/);
  await axe(page);

  // A tag, saved by clicking elsewhere in the modal (#234).
  await page.getByRole("dialog").getByRole("button", { name: "Add tags" }).click();
  await page.keyboard.type("flags");
  await page.getByRole("heading", { level: 1, name: "Count the flags" }).click();
  await expect.poll(() => novel.read("notes/count-the-flags.md")).toMatch(/tags: \[flags\]\n|tags:\n {2}- flags\n/);
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Tags" })).toHaveCount(0);

  // A click outside closes it, back to the gallery, the note there.
  await page.mouse.click(4, 4);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/notes$/);
  const card = page.getByRole("list", { name: "Notes" }).getByRole("link", { name: /^Count the flags/ });
  await expect(card).toContainText("Nine flags, one missing.");

  // Opened from its card, Escape closes it, the focus back on the card; Back closes it too.
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Count the flags" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card).toBeFocused();
  await card.click();
  await expect(page.getByRole("dialog", { name: "Count the flags" })).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/notes$/);

  // Closed without a title, nothing is made.
  const before = novel.files("notes");
  await page.getByRole("button", { name: "New note" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(novel.files("notes")).toEqual(before);

  // Its address opens it over the gallery, from anywhere.
  const url = new URL(page.url());
  await page.goto(`${url.origin}${url.pathname.replace(/\/notes$/, "/note/note_w1fben")}`);
  await expect(page.getByRole("dialog", { name: "What if Ben never sold the plans?" })).toBeVisible();
  await expect(under(page, /^Notes/)).toBeAttached();
});

test("a part saves when the focus leaves it, another opens or the modal closes; Escape cancels it, not the modal (#234)", async ({ page, app }) => {
  const novel = await openNovel(page, app);
  await palette(page, "character: ada");
  const modal = page.getByRole("dialog", { name: "Ada Varn" });
  await expect(modal).toBeVisible();
  await expect(under(page, "Story bible")).toBeAttached();

  // Escape puts the part back as it was, and the modal stays.
  await modal.getByRole("button", { name: "Edit summary" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Not this.");
  await page.keyboard.press("Escape");
  await expect(modal.getByRole("button", { name: "Edit summary" })).toBeFocused();
  expect(novel.read(ADA)).not.toContain("Not this.");

  // Clicking elsewhere saves it.
  await modal.getByRole("button", { name: "Edit summary" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" She counts.");
  await modal.getByRole("heading", { level: 1, name: "Ada Varn" }).click();
  await expect.poll(() => novel.read(ADA)).toContain("being sold. She counts.");
  await expect(modal.getByRole("textbox", { name: "Summary" })).toHaveCount(0);

  // Opening another part saves the one that was open.
  await modal.getByRole("button", { name: "Edit tags" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(", engineer");
  await modal.getByRole("button", { name: "Edit other names" }).click();
  await expect(modal.getByRole("textbox", { name: "Other names" })).toBeFocused();
  await expect.poll(() => novel.read(ADA)).toMatch(/tags: \[protagonist, pov, engineer\]\n|tags:\n {2}- protagonist\n {2}- pov\n {2}- engineer\n/);

  // A field, saved by Tab out of it.
  await page.keyboard.press("Escape");
  await modal.getByRole("button", { name: "Edit eyes" }).click();
  await modal.getByRole("textbox", { name: "Value" }).fill("grey-green");
  await modal.getByRole("textbox", { name: "Value" }).press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect.poll(() => novel.read(ADA)).toContain("eyes: grey-green");

  // Closing the modal saves the part that's open.
  await modal.getByRole("button", { name: "Edit summary" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Twice.");
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => novel.read(ADA)).toContain("She counts. Twice.");

  // In its notes, Escape closes the mention suggestions first, then the modal.
  await palette(page, "character: ada");
  const notes = page.getByRole("textbox", { name: "Notes on Ada Varn" });
  await caretAtEnd(page, notes);
  await page.keyboard.type(" @tom");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeHidden();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an off-page event: made in its modal over the Story bible by a title; the Timeline and the palette open it there (#236)", async ({ page, app }) => {
  const novel = await openNovel(page, app);
  await views(page).getByRole("link", { name: "Story bible" }).click();
  await page.getByRole("button", { name: "New off-page event" }).click();
  const modal = page.getByRole("dialog", { name: "New off-page event" });
  await expect(modal.getByRole("textbox", { name: "Title" })).toBeFocused();
  await page.keyboard.type("The bell is sold");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "The bell is sold" }).getByRole("heading", { level: 1, name: "The bell is sold" })).toBeVisible();
  await expect(page).toHaveURL(/\/event\/evt_[0-9a-z]{6}$/);
  await expect.poll(() => (existsSync(join(novel.dir, "bible/events/the-bell-is-sold.md")) ? novel.read("bible/events/the-bell-is-sold.md") : "")).toMatch(/title: The bell is sold\n/);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/bible$/);
  await expect(page.getByRole("region", { name: /^Off the page/ }).getByRole("link", { name: /The bell is sold/ })).toBeVisible();

  // From the Timeline: over the Story bible, and closed, the Story bible's off-page events.
  await openView(page, "Timeline");
  await page.getByRole("tabpanel", { name: "Timeline" }).getByRole("link", { name: /The flood of '09/ }).first().click();
  await expect(page.getByRole("dialog", { name: "The flood of '09" })).toBeVisible();
  await expect(under(page, "Story bible")).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/bible#off-the-page$/);

  // From the palette, the same.
  await palette(page, "off the page: the plans");
  await expect(page.getByRole("dialog", { name: "The plans are stolen" })).toBeVisible();
});

test("an entry: made in its modal by a type and a name, its profile in place; New on a type's group starts with that type (#237)", async ({ page, app }) => {
  const novel = await openNovel(page, app);
  await views(page).getByRole("link", { name: "Story bible" }).click();
  await page.getByRole("button", { name: "New entry" }).click();
  await expect(page.getByRole("dialog", { name: "New character" }).getByRole("textbox", { name: "Name" })).toBeFocused();
  await page.getByRole("dialog").getByRole("combobox", { name: "Type" }).selectOption("location");
  const modal = page.getByRole("dialog", { name: "New location" });
  await expect(modal).toBeVisible();
  await axe(page);

  // Back to the name: choosing the type made nothing; moving on from the name makes it.
  const before = novel.files("bible/locations");
  expect(before).not.toContain("the-mill.md");
  await modal.getByRole("textbox", { name: "Name" }).fill("The Mill");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("dialog", { name: "The Mill" }).getByRole("heading", { level: 1, name: "The Mill" })).toBeVisible();
  await expect(page).toHaveURL(/\/bible\/loc_[0-9a-z]{6}$/);
  await expect.poll(() => novel.files("bible/locations")).toContain("the-mill.md");
  const mill = page.getByRole("dialog", { name: "The Mill" });
  await expect(mill.getByRole("button", { name: "Add a summary" })).toBeVisible();
  await expect(mill.getByRole("region", { name: "In the story" })).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await mill.getByRole("button", { name: "Add a summary" }).click();
  await page.keyboard.type("Where the flour came from.");
  await page.mouse.click(4, 4);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => novel.read("bible/locations/the-mill.md")).toContain("summary: Where the flour came from.");
  await expect(page.getByRole("link", { name: /The Mill/ })).toContainText("Where the flour came from.");

  // New on the characters' group: a character, by its name alone; closed without one, nothing.
  const characters = novel.files("bible/characters");
  await page.getByRole("button", { name: "New character" }).click();
  const character = page.getByRole("dialog", { name: "New character" });
  await expect(character.getByRole("textbox", { name: "Name" })).toBeFocused();
  await expect(character.getByRole("combobox", { name: "Type" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(novel.files("bible/characters")).toEqual(characters);

  // A link to an entry (the palette's) opens it over the gallery.
  await palette(page, "character: ben varn");
  await expect(page.getByRole("dialog", { name: "Ben Varn" })).toBeVisible();
  await expect(under(page, "Story bible")).toBeAttached();
});
