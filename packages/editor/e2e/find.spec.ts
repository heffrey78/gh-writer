import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { caretAfter, move, open, savedText, settled, status, textbox } from "./helpers.ts";

const novel = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const read = (path: string) => readFileSync(novel + path, "utf8");
const ARRIVAL = "manuscript/01-return/01-arrival";
const STATION = `${ARRIVAL}/01-the-station.md`;
const BRIDGE = `${ARRIVAL}/02-the-bridge.md`;
const LEDGER = "manuscript/01-return/02-old-debts/02-bens-ledger.md";

const panel = (page: Page) => page.getByRole("search", { name: "Find and replace" });
const findBox = (page: Page) => panel(page).getByRole("searchbox", { name: "Find" });
const findStatus = (page: Page) => panel(page).getByRole("status");
const selected = (page: Page) => page.evaluate(() => window.editor!.state.doc.textBetween(window.editor!.state.selection.from, window.editor!.state.selection.to));

test("Mod+F searches the scene, seeded with the selection; Enter steps through the matches", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await caretAfter(page, "counted them");
  for (let i = 0; i < "them".length; i++) await move(page, "Shift+ArrowLeft");
  await page.keyboard.press("ControlOrMeta+f");
  await expect(findBox(page)).toBeFocused();
  await expect(findBox(page)).toHaveValue("them");
  await expect(panel(page).getByRole("radio", { name: "Scene" })).toBeChecked();
  await findBox(page).fill("the");
  await expect(findStatus(page)).toHaveText(/^1 of \d+ matches$/);
  const total = Number((await findStatus(page).textContent())!.match(/of (\d+)/)![1]);
  await expect(textbox(page).locator(".ghw-match")).toHaveCount(total);
  await page.keyboard.press("Enter");
  await expect(findStatus(page)).toHaveText(`2 of ${total} matches`);
  await expect(textbox(page).locator(".ghw-match-current")).toHaveCount(1);
  expect((await selected(page)).toLowerCase()).toBe("the");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await expect(findStatus(page)).toHaveText(`${total} of ${total} matches`);
  await expect(findBox(page)).toBeFocused();
});

test("matches run across formatting and mention names; never front matter or mention IDs", async ({ page }) => {
  await open(page, "scene=scenes/sampler.md");
  await page.keyboard.press("ControlOrMeta+f");
  await findBox(page).fill("uses every kind");
  await expect(findStatus(page)).toHaveText("1 of 1 match");
  await findBox(page).fill("Ada wrote this");
  await expect(findStatus(page)).toHaveText("1 of 1 match");
  await findBox(page).fill("char_7f3k2q");
  await expect(findStatus(page)).toHaveText("No matches");
  await findBox(page).fill("Formatting sampler"); // the scene's title, in front matter
  await expect(findStatus(page)).toHaveText("No matches");
});

test("options: case, whole words and regular expressions", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await page.keyboard.press("ControlOrMeta+f");
  await findBox(page).fill("the");
  // The count comes once the search has run: wait for it before reading it.
  const count = async () => {
    await expect(findStatus(page)).toHaveText(/of \d+/);
    return Number((await findStatus(page).textContent())!.match(/of (\d+)/)![1]);
  };
  const any = await count();
  await panel(page).getByRole("button", { name: "Whole words" }).click();
  await expect(findStatus(page)).not.toHaveText(new RegExp(`of ${any} `));
  const whole = await count();
  expect(whole).toBeLessThan(any);
  await panel(page).getByRole("button", { name: "Match case" }).click();
  await expect(findStatus(page)).not.toHaveText(`1 of ${whole} matches`);
  await panel(page).getByRole("button", { name: "Regular expression" }).click();
  await findBox(page).fill("fl(ag");
  await expect(findStatus(page)).toHaveText(/^Invalid search/);
  await expect(findBox(page)).toHaveAttribute("aria-invalid", "true");
  await findBox(page).fill("fl(ag)s");
  await expect(findStatus(page)).toHaveText("1 of 2 matches");
});

test("manuscript results are grouped by chapter and scene in reading order, and open other scenes", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await page.keyboard.press("ControlOrMeta+Shift+H");
  await expect(panel(page).getByRole("radio", { name: "Manuscript" })).toBeChecked();
  await findBox(page).fill("Ben");
  await panel(page).getByRole("button", { name: "Whole words" }).click();
  await panel(page).getByRole("button", { name: "Match case" }).click();
  // Five sample-novel scenes and the playground's sampler ("Dear Ben,").
  await expect(findStatus(page)).toHaveText("1 of 7 matches in 6 scenes");
  await expect(panel(page).locator(".ghw-find-results h3")).toHaveText(["Arrival", "Old Debts", "Night Crossing", "Varn Holds", "Playground scenes"]);
  await expect(panel(page).locator(".ghw-find-results h4").first()).toContainText("Walking the Span");

  const result = panel(page).locator(".ghw-find-results section", { hasText: "Old Debts" }).getByRole("button").first();
  const context = await result.textContent();
  await result.click();
  await expect(page.getByRole("combobox", { name: "Open" })).toHaveValue(`scene:${LEDGER}`);
  await settled(page);
  await expect.poll(() => selected(page)).toBe("Ben");
  await expect(panel(page).locator(`button[aria-current="true"]`)).toHaveText(context!);
});

test("replace one, in the open scene, is undoable in the text", async ({ page }) => {
  await open(page, `chapter=${ARRIVAL}`);
  await caretAfter(page, "toll house");
  await page.keyboard.press("ControlOrMeta+f");
  await findBox(page).fill("coffees");
  await panel(page).getByRole("textbox", { name: "Replace" }).fill("teas");
  await panel(page).getByRole("button", { name: "Replace", exact: true }).click();
  await expect.poll(() => savedText(page, `saved:${BRIDGE}`)).toContain("with two teas and");
  await expect(findStatus(page)).toHaveText("No matches");
  await textbox(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(status(page)).toHaveText("Identical to the files on disk");
});

test("replace all across the manuscript changes only scenes with matches, and undoes as one step", async ({ page }) => {
  await open(page, `chapter=${ARRIVAL}`);
  await page.keyboard.press("ControlOrMeta+Shift+H");
  await findBox(page).fill("Ben");
  await panel(page).getByRole("button", { name: "Whole words" }).click();
  await panel(page).getByRole("button", { name: "Match case" }).click();
  await panel(page).getByRole("textbox", { name: "Replace" }).fill("Benedict");
  await panel(page).getByRole("button", { name: "Replace all" }).click();
  await expect(findStatus(page)).toHaveText(/^Replaced 7 in 6 scenes\./);

  // The open chapter: the bridge changed (its mention renamed, still linked), the station didn't.
  await expect.poll(() => savedText(page, `saved:${BRIDGE}`)).toContain("[Benedict](#char_b3n0vs) met her");
  expect(await savedText(page, `saved:${STATION}`)).toBe(read(STATION));
  // A closed chapter changed too.
  await page.getByRole("combobox", { name: "Open" }).selectOption(`chapter:manuscript/01-return/02-old-debts`);
  await settled(page);
  await expect(status(page)).toHaveText("1 changed");
  await expect.poll(() => savedText(page, `saved:${LEDGER}`)).toContain("Benedict");

  // Undo restores every scene, in the editor and on disk.
  await page.keyboard.press("ControlOrMeta+Shift+H");
  await page.getByRole("combobox", { name: "Open" }).selectOption(`chapter:${ARRIVAL}`);
  await settled(page);
  await page.keyboard.press("ControlOrMeta+Shift+H");
  await findBox(page).fill("Benedict");
  await panel(page).getByRole("button", { name: "Replace all" }).click();
  await panel(page).getByRole("button", { name: "Undo" }).click();
  await expect(findStatus(page)).toHaveText(/matches in 6 scenes$/);
});

test("Escape closes the panel and returns to the text", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await caretAfter(page, "counted them");
  await page.keyboard.press("ControlOrMeta+f");
  await findBox(page).fill("bridge");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(textbox(page)).toBeFocused();
  await expect(textbox(page).locator(".ghw-match")).toHaveCount(0);
});

test("no accessibility violations with the panel open", async ({ page }) => {
  await open(page, `chapter=${ARRIVAL}`);
  await page.keyboard.press("ControlOrMeta+Shift+H");
  await findBox(page).fill("the");
  await expect(findStatus(page)).toHaveText(/matches/);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});
