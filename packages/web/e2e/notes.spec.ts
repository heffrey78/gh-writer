import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, caretAtEnd, expect, test, type App } from "./fixtures.ts";

/** The writer's notes (#205). */

const IDEA = "notes/what-if-ben-never-sold.md";

async function openNovel(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return dir;
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

test("a note's page: its title, tags and prose edited in place, mentions included", async ({ page, app }) => {
  const dir = await openNovel(page, app);
  await palette(page, "note: what if ben");
  await expect(page.getByRole("heading", { level: 1, name: "What if Ben never sold the plans?" })).toBeVisible();
  await expect(page.getByText("Note · Oct 15, 2026")).toBeVisible();
  await expect(page.getByRole("list", { name: "Tags" }).getByRole("listitem")).toHaveText(["ending", "ben"]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  // Tags, by keyboard.
  await page.getByRole("button", { name: "Edit tags" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "Tags" }).fill("ending, ben, bridge");
  await page.keyboard.press("Enter");
  await expect.poll(() => readFileSync(join(dir, IDEA), "utf8")).toContain("\ntags: [ending, ben, bridge]\n");

  // The prose, with a mention.
  const prose = page.getByRole("textbox", { name: "Note: What if Ben never sold the plans?" });
  await caretAtEnd(page, prose);
  await page.keyboard.type(" Ask @tomas");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => readFileSync(join(dir, IDEA), "utf8")).toMatch(/goes back to \[the flood\]\(#evt_9ab3kd\)\. Ask \[Tomas[^\]]*\]\(#char_t0ma5h\)/);

  // A new title moves the file.
  await page.getByRole("button", { name: "Edit title" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Ben keeps the plans");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ben keeps the plans" })).toBeVisible();
  await expect.poll(() => existsSync(join(dir, "notes/ben-keeps-the-plans.md"))).toBe(true);
  expect(existsSync(join(dir, IDEA))).toBe(false);
});

test("notes are made from the palette, made into an event or a scene, and deleted", async ({ page, app }) => {
  const dir = await openNovel(page, app);
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Outline" }).click();
  await palette(page, "new note");
  await page.getByRole("dialog", { name: "New note" }).getByRole("textbox", { name: "Title" }).fill("A toll on the bridge");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "A toll on the bridge" })).toBeVisible();
  expect(existsSync(join(dir, "notes/a-toll-on-the-bridge.md"))).toBe(true);

  // An event, the note kept and pointing at it.
  await palette(page, "note: what if ben");
  await page.getByRole("button", { name: "Make it an event or a scene" }).click();
  const dialog = page.getByRole("dialog", { name: "Make “What if Ben never sold the plans?” part of the story" });
  await axe(page);
  await dialog.getByRole("button", { name: "Make the event" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "What if Ben never sold the plans?" })).toBeVisible();
  await expect(page.getByText("Story bible · Off the page")).toBeVisible();
  await palette(page, "note: what if ben");
  await expect(page.getByText("Became the off-page event “What if Ben never sold the plans?”.")).toBeVisible();

  // A scene, the note removed.
  await palette(page, "note: a toll");
  await page.getByRole("button", { name: "Make it an event or a scene" }).click();
  await page.getByRole("radio", { name: /^A scene at the end of a chapter/ }).check();
  await page.getByRole("combobox", { name: "Chapter" }).selectOption("ch_01dde6");
  await page.getByRole("radio", { name: "Remove it" }).check();
  await page.getByRole("button", { name: "Write the scene" }).click();
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeVisible();
  expect(existsSync(join(dir, "notes/a-toll-on-the-bridge.md"))).toBe(false);
  expect(existsSync(join(dir, "manuscript/01-return/02-old-debts/03-a-toll-on-the-bridge.md"))).toBe(true);

  // Deleted, once confirmed.
  await palette(page, "note: what if ben");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete “What if Ben never sold the plans?”?" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => existsSync(join(dir, IDEA))).toBe(false);
  await expect.poll(() => app.git(dir, "log", "-1", "--format=%s").trim()).toBe("Notes: remove “What if Ben never sold the plans?”");
});

test("a new note, from the palette while writing, opens on its page ready to write", async ({ page, app }) => {
  await openNovel(page, app);
  await palette(page, "new note");
  await page.getByRole("dialog", { name: "New note" }).getByRole("textbox", { name: "Title" }).fill("A toll on the bridge");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "A toll on the bridge" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note: A toll on the bridge" })).toBeFocused();
});

test("an entry's and an event's profiles list the notes that mention them", async ({ page, app }) => {
  await openNovel(page, app);
  await palette(page, "character: ada");
  const section = page.getByRole("region", { name: "In your notes" });
  await expect(section.getByRole("link")).toHaveText(["What if Ben never sold the plans?"]);
  await expect(section).toContainText("ending, ben");
  await axe(page);
  await palette(page, "off the page: the flood");
  await expect(page.getByRole("dialog", { name: "The flood of '09" })).toBeVisible();
  await expect(page.getByRole("region", { name: "In your notes" }).getByRole("link")).toHaveText(["What if Ben never sold the plans?"]);
  await palette(page, "character: ben varn");
  await expect(page.getByRole("heading", { level: 1, name: "Ben Varn" })).toBeVisible();
  await expect(page.getByRole("region", { name: "In your notes" })).toHaveCount(0);
  await palette(page, "character: ada");
  await page.getByRole("region", { name: "In your notes" }).getByRole("link", { name: "What if Ben never sold the plans?" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "What if Ben never sold the plans?" })).toBeVisible();
});

test("the note just written is found by its words in the gallery, and its mentions list it on the profile", async ({ page, app }) => {
  await openNovel(page, app);
  await palette(page, "new note");
  await page.getByRole("dialog", { name: "New note" }).getByRole("textbox", { name: "Title" }).fill("A toll on the bridge");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note: A toll on the bridge" })).toBeFocused();
  await page.keyboard.type("Who collects it? Maybe @mirela");
  await page.keyboard.press("Enter");

  // Closed, the Notes gallery (#235); once saved, the note is found there by its words, the previous note by its own.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const cards = page.getByRole("list", { name: "Notes" }).getByRole("listitem");
  await page.getByRole("searchbox", { name: "Search the notes" }).fill("collects");
  await expect(cards.locator("span.font-semibold")).toHaveText(["A toll on the bridge"], { timeout: 10_000 });
  await page.getByRole("searchbox", { name: "Search the notes" }).fill("flood");
  await expect(cards.locator("span.font-semibold")).toHaveText(["What if Ben never sold the plans?"]);

  // Mirela's profile lists it.
  await palette(page, "character: mirela");
  await expect(page.getByRole("region", { name: "In your notes" }).getByRole("link")).toHaveText(["A toll on the bridge"]);
});

test("the Notes gallery: every note as a card, by tag and words, newest or by title", async ({ page, app }) => {
  await openNovel(page, app);
  await palette(page, "new note");
  await page.getByRole("dialog", { name: "New note" }).getByRole("textbox", { name: "Title" }).fill("A toll on the bridge");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "A toll on the bridge" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 1, name: /^Notes/ })).toBeVisible();
  const cards = page.getByRole("list", { name: "Notes" }).getByRole("listitem");
  await expect(cards.locator("span.font-semibold")).toHaveText(["A toll on the bridge", "What if Ben never sold the plans?"]);
  await expect(cards.nth(1)).toContainText("ending · ben");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await page.getByRole("combobox", { name: "Sort" }).selectOption("title");
  await expect(cards.locator("span.font-semibold")).toHaveText(["A toll on the bridge", "What if Ben never sold the plans?"]);
  await page.getByRole("combobox", { name: "Tag", exact: true }).selectOption("ben");
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "note matches" })).toHaveText("1 note matches");
  await page.getByRole("combobox", { name: "Tag", exact: true }).selectOption("");
  await page.getByRole("searchbox", { name: "Search the notes" }).fill("flood");
  await expect(cards).toHaveCount(1);
  await cards.getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "What if Ben never sold the plans?" })).toBeVisible();

});
