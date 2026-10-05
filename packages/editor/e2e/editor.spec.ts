import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { caretAfter, move, open, savedContains, savedText, settled, status, textbox } from "./helpers.ts";

const novel = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const read = (path: string) => readFileSync(novel + path, "utf8");
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

const saved = (page: Page) => page.getByTestId("saved");
const openScene = (page: Page, scene: string) => open(page, `scene=${encodeURIComponent(scene)}`);

test("every sample scene opens and saves byte for byte, even after typing and deleting", async ({ page }) => {
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Open" });
  const scenes = await picker.locator('optgroup[label="Scenes"] option').allTextContents();
  expect(scenes.length).toBeGreaterThanOrEqual(9);
  for (const scene of scenes) {
    await picker.selectOption(`scene:${scene}`);
    await settled(page);
    await move(page, "ControlOrMeta+End");
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    await expect(status(page), scene).toHaveText("Identical to the file on disk");
  }
});

test("typing changes only the edited paragraph's line", async ({ page }) => {
  await openScene(page, STATION);
  await caretAfter(page, "counted them twice");
  await page.keyboard.type(", slowly");
  const original = read(STATION);
  await expect.poll(() => savedText(page)).toBe(original.replace("counted them twice", "counted them twice, slowly"));
  await expect(status(page)).toHaveText("Changed");
});

test("keyboard shortcuts format the selection", async ({ page }) => {
  await openScene(page, STATION);
  await caretAfter(page, "Surveyors' flags");
  for (let i = 0; i < "flags".length; i++) await move(page, "Shift+ArrowLeft");
  await page.keyboard.press("ControlOrMeta+i");
  await savedContains(page, "Surveyors' *flags*.");
  await page.keyboard.press("ControlOrMeta+b");
  await savedContains(page, "Surveyors' ***flags***.");
  await expect(textbox(page).locator("em strong, strong em")).toHaveText("flags");

  await caretAfter(page, "counted them twice");
  await page.keyboard.press("ControlOrMeta+Shift+B");
  await savedContains(page, "> She stood with her bag");

  await caretAfter(page, "the last of its heat");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(status(page)).toHaveText("Identical to the file on disk");
});

test("Markdown typed as you write becomes formatting", async ({ page }) => {
  await openScene(page, STATION);
  await move(page, "ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("It was **not** a *small* thing. ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("*** ");
  await page.keyboard.type("> Dear Ada,");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("come home.");
  await expect(textbox(page).locator("strong")).toHaveText("not");
  await expect(textbox(page).locator("em").last()).toHaveText("small");
  await expect(textbox(page).locator("hr")).toHaveCount(1);
  await expect(textbox(page)).not.toContainText("**");
  await savedContains(page, "wound.\n\nIt was **not** a *small* thing.\n\n***\n\n> Dear Ada,\\\n> come home.\n");
});

test("section breaks by shortcut", async ({ page }) => {
  await openScene(page, STATION);
  await caretAfter(page, "Surveyors' flags.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.type("Later.");
  await savedContains(page, "Surveyors' flags.\n\n***\n\nLater.\n\nShe stood");
});

test("a mention can't be broken by typing", async ({ page }) => {
  await openScene(page, STATION);
  const mention = textbox(page).locator("[data-mention]");
  await expect(mention).toHaveText("Ada");
  await caretAfter(page, "into Varn, and ");
  await move(page, "ArrowRight");
  await page.keyboard.type("!");
  await savedContains(page, "and [Ada](#char_7f3k2q)! was");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(mention).toHaveCount(0);
  await savedContains(page, "into Varn, and  was the only");
  expect(await savedText(page)).not.toContain("[Ada]");
});

test("raw Markdown is shown and kept as written", async ({ page }) => {
  await openScene(page, "scenes/sampler.md");
  await expect(textbox(page).locator("pre[data-raw]")).toContainText("| Kept | as Markdown |");
  await caretAfter(page, "uses ");
  await page.keyboard.type("nearly ");
  await savedContains(page, "uses nearly _every_ kind");
  await savedContains(page, "| `code` | ~~struck~~ |");
});

test("the editor is reachable and usable by keyboard alone", async ({ page }) => {
  await openScene(page, STATION);
  await page.getByRole("combobox", { name: "Open" }).focus();
  await page.keyboard.press("Tab");
  await expect(textbox(page)).toBeFocused();
  await move(page, "ControlOrMeta+End");
  await page.keyboard.type(" The end.");
  await savedContains(page, "in a wound. The end.\n");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`no accessibility violations (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openScene(page, "scenes/sampler.md");
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}
