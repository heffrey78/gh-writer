import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

const listbox = (page: Page) => page.getByRole("listbox", { name: "Mention suggestions" });

/** The caret at the end of the station's paragraph about counting the flags. */
async function caretInStation(page: Page) {
  await page.getByRole("textbox", { name: "Chapter text" }).getByText(/the way you count stitches in a wound\./).click();
  await page.keyboard.press("End");
}

test("@ in the chapter suggests the bible's entries; the mention survives renaming its entry", async ({ page, app }) => {
  const novel = await open(page, app);
  await caretInStation(page);
  await page.keyboard.type(" @tom");
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveText("Tomas Hale as “Tomas”");
  await axe(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("would know.");
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toContain("in a wound. [Tomas](#char_t0ma5h) would know.");

  await palette(page, "character: tomas");
  await page.getByRole("form", { name: "Details" }).getByRole("textbox", { name: "Name", exact: true }).fill("Tomas Brand");
  await page.getByRole("form", { name: "Details" }).getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Tomas Brand" })).toBeVisible();
  // The words written stay; the mention still finds its entry, by ID.
  expect(novel.read(STATION)).toContain("[Tomas](#char_t0ma5h) would know.");
  await expect(page.getByRole("region", { name: "In the story" }).getByRole("link", { name: "The Station" })).toBeVisible();

  // And @ offers the new name.
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^Arrival,/ }).click();
  await caretInStation(page);
  await page.keyboard.type(" @tomas b");
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveText("Tomas Brand");
  await page.keyboard.press("Escape");
  await expect(listbox(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
});
