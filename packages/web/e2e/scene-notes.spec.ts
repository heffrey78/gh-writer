import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

/** A scene's notes on the right sidebar (#222). */

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

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Right sidebar" });
const cards = (page: Page) => sidebar(page).getByRole("list", { name: "Notes on “The Station”" }).getByRole("listitem");
const titles = (page: Page) => cards(page).locator("button[aria-expanded]");

test("a scene's notes: made beside the text, written at once, pinned on top, taken off", async ({ page, app }) => {
  const dir = await openNovel(page, app);
  const read = (path: string) => readFileSync(join(dir, path), "utf8");
  await sidebar(page).getByRole("tab", { name: "Notes" }).click();
  await expect(sidebar(page)).toContainText("No notes on this scene yet.");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  // + Note: a title, then the caret is in its prose, the text still open.
  await sidebar(page).getByRole("button", { name: "New note on this scene" }).click();
  await page.getByRole("textbox", { name: "Title of the new note" }).fill("Count the flags");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note: Count the flags" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();
  await page.keyboard.type("Nine flags, one missing.");
  await expect.poll(() => read("notes/count-the-flags.md")).toMatch(/scenes:\n {2}- sc_5tat1n\n[\s\S]*---\n\n?Nine flags, one missing\.\n$/);
  await axe(page);

  // From the palette: newest first, and the first is truncated under its title.
  await palette(page, "new note on this scene");
  await page.getByRole("textbox", { name: "Title of the new note" }).fill("Who sold the bell");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Note: Who sold the bell" })).toBeFocused();
  await expect(titles(page)).toHaveText(["Who sold the bell", "Count the flags"]);
  await titles(page).nth(1).click();
  await expect(cards(page).nth(1)).toContainText("Nine flags, one missing.");

  // Pinned on top; pinning another unpins it.
  await cards(page).nth(1).getByRole("button", { name: "Pin to the top" }).click();
  await expect(titles(page)).toHaveText(["Count the flags", "Who sold the bell"]);
  await expect.poll(() => read("notes/count-the-flags.md")).toContain("pinned:\n  - sc_5tat1n\n");
  await titles(page).nth(1).press("Enter");
  await expect(titles(page).nth(1)).toHaveAttribute("aria-expanded", "true");
  await cards(page).nth(1).getByRole("button", { name: "Pin to the top" }).click();
  await expect(titles(page)).toHaveText(["Who sold the bell", "Count the flags"]);
  await expect.poll(() => read("notes/count-the-flags.md")).not.toContain("pinned");

  // Taken off this scene: off the tab, still a note.
  await titles(page).nth(1).click();
  await cards(page).nth(1).getByRole("button", { name: "Take off this scene" }).click();
  await expect(titles(page)).toHaveText(["Who sold the bell"]);
  expect(existsSync(join(dir, "notes/count-the-flags.md"))).toBe(true);
  await expect.poll(() => read("notes/count-the-flags.md")).not.toContain("scenes");
});

test("a note already written is put on the scene from its Notes tab, keeping the scenes it's on (#238)", async ({ page, app }) => {
  const dir = await openNovel(page, app);
  const read = () => readFileSync(join(dir, "notes/what-if-ben-never-sold.md"), "utf8");
  await sidebar(page).getByRole("tab", { name: "Notes" }).click();
  await expect(sidebar(page)).toContainText("or add one already written");

  // Found by typing, on no scene yet; its card opens on the tab.
  await sidebar(page).getByRole("button", { name: /^Add a note already written/ }).click();
  await expect(page.getByRole("group", { name: "On no scene" })).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await page.keyboard.type("ben never");
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["What if Ben never sold the plans?"]);
  await expect(titles(page).first()).toHaveAttribute("aria-expanded", "true");
  await expect.poll(read).toContain("scenes:\n  - sc_5tat1n\n");
  // On the scene, it isn't offered again: nothing else is left to add.
  await expect(sidebar(page).getByRole("button", { name: /^Add a note already written/ })).toHaveCount(0);

  // Another scene: offered as on other scenes, and added there it keeps the first.
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^Walking the Span,/ }).click();
  await expect(sidebar(page).getByRole("heading", { name: "Notes on “Walking the Span”" })).toBeVisible();
  await sidebar(page).getByRole("button", { name: /^Add a note already written/ }).click();
  await expect(page.getByRole("group", { name: "On other scenes" })).toBeVisible();
  await page.keyboard.type("ben never");
  await page.keyboard.press("Enter");
  await expect(sidebar(page).getByRole("list", { name: "Notes on “Walking the Span”" }).getByRole("listitem")).toHaveCount(1);
  await expect.poll(read).toMatch(/scenes:\n {2}- sc_5tat1n\n {2}- sc_br1dg3\n/);
});

test("a note's page puts it on scenes; deleting its only scene asks what becomes of it", async ({ page, app }) => {
  const dir = await openNovel(page, app);
  await palette(page, "note: what if ben");
  await page.getByRole("button", { name: "Put it on a scene" }).click();
  await page.getByRole("button", { name: /^Add to scenes/ }).click();
  await page.keyboard.type("walking the span");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("link", { name: "Walking the Span" }).first()).toBeVisible();
  await expect.poll(() => readFileSync(join(dir, "notes/what-if-ben-never-sold.md"), "utf8")).toContain("scenes:\n  - sc_br1dg3\n");

  // On that scene's Notes tab.
  await page.getByRole("link", { name: "Walking the Span" }).click();
  await sidebar(page).getByRole("tab", { name: "Notes" }).click();
  await expect(sidebar(page).getByRole("list", { name: "Notes on “Walking the Span”" }).getByRole("listitem")).toHaveCount(1);

  // Deleting the scene asks; Don't delete changes nothing; Keep the notes keeps it, on no scene.
  const tree = page.getByRole("tree", { name: "Manuscript" });
  await tree.getByRole("treeitem", { name: /^Walking the Span/ }).focus();
  await page.keyboard.press("Delete");
  const ask = page.getByRole("alertdialog", { name: "Delete the scene “Walking the Span”, and its notes?" });
  await expect(ask).toContainText("“What if Ben never sold the plans?”");
  await axe(page);
  await ask.getByRole("button", { name: "Don't delete" }).click();
  await expect(tree.getByRole("treeitem", { name: /^Walking the Span/ })).toBeVisible();
  await tree.getByRole("treeitem", { name: /^Walking the Span/ }).focus();
  await page.keyboard.press("Delete");
  await ask.getByRole("button", { name: "Keep the notes" }).click();
  await expect(tree.getByRole("treeitem", { name: /^Walking the Span/ })).toHaveCount(0);
  await expect.poll(() => readFileSync(join(dir, "notes/what-if-ben-never-sold.md"), "utf8")).not.toContain("scenes");
});
