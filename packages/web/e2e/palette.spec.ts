import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test, type App } from "./fixtures.ts";

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const search = (page: Page) => palette(page).getByRole("combobox");
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

async function open(page: Page, app: App) {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
}

async function run(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search(page)).toBeFocused();
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
}

test("runs a writing command from the palette and returns to the text", async ({ page, app }) => {
  await open(page, app);
  await run(page, "focus mode");
  await expect(page.getByRole("navigation", { name: "Manuscript" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("focus mode");
  await expect(palette(page).getByRole("option", { name: /Focus mode/ })).toContainText("On");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Manuscript" })).toBeVisible();
});

test("opens a scene by its title, and lists recent commands first", async ({ page, app }) => {
  await open(page, app);
  await run(page, "ledger");
  await expect(page.getByRole("heading", { level: 1, name: "Ben's Ledger" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page).getByRole("group", { name: "Recent" }).getByRole("option")).toHaveText(["Scene: Ben's Ledger"]);
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();
});

test("reaches sync, checkpoints, the library and the theme", async ({ page, app }) => {
  await open(page, app);
  await run(page, "checkpoints");
  await expect(page.getByRole("dialog", { name: "Checkpoints" })).toBeVisible();
  await page.keyboard.press("Escape");
  await run(page, "theme dark");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await run(page, "your novels");
  await expect(page.getByRole("heading", { level: 1, name: "Your novels" })).toBeVisible();
  // From the library, a novel opens by name.
  await run(page, "bridge at varn");
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();
});

test("says when nothing matches", async ({ page, app }) => {
  await open(page, app);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("zzzzqqq");
  await expect(palette(page)).toContainText("No matching commands");
});

test("lists every shortcut, from the editor and the app", async ({ page, app }) => {
  await open(page, app);
  await page.keyboard.press("ControlOrMeta+/");
  const reference = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  for (const title of ["Command palette", "Italic", "Focus mode", "Find in scene", "Spelling suggestions"]) await expect(reference.getByText(title, { exact: true })).toBeVisible();
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
});
