import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { caretAfter, open, savedText, textbox } from "./helpers.ts";

const STATION = "scene=manuscript/01-return/01-arrival/01-the-station.md";
const misspelled = (page: Page) => textbox(page).locator(".ghw-misspelled");
const menu = (page: Page) => page.getByRole("menu");

/** Type a misspelled sentence at the end of the station's last paragraph. */
async function typeTypos(page: Page) {
  await caretAfter(page, "in a wound.");
  await page.keyboard.type(" The statoin smelled of steamline oil, Mirela's favorite.");
  await expect(misspelled(page)).toHaveText(["statoin", "steamline"]);
}

test("misspellings are underlined; the story's names never are", async ({ page }) => {
  await open(page, STATION);
  // The scene's prose, names and all ("Varn", "Ada"), checks clean.
  await page.waitForTimeout(800);
  await expect(misspelled(page)).toHaveCount(0);
  await typeTypos(page);
  await expect(misspelled(page).first()).toHaveAttribute("aria-invalid", "spelling");
  await expect(textbox(page)).toHaveAttribute("spellcheck", "false");
});

test("Mod+. offers suggestions from the keyboard and replaces the word", async ({ page }) => {
  await open(page, STATION);
  await typeTypos(page);
  await caretAfter(page, "The stat");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(menu(page)).toHaveAccessibleName("Spelling of “statoin”");
  await expect(page.getByRole("menuitem", { name: "station" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeHidden();
  await expect(textbox(page)).toBeFocused();
  await expect(misspelled(page)).toHaveText(["steamline"]);
  await expect.poll(() => savedText(page)).toContain("The station smelled");
});

test("a right-click on a misspelling opens the same menu; Escape returns to the text", async ({ page }) => {
  await open(page, STATION);
  await typeTypos(page);
  await misspelled(page).first().click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(textbox(page)).toBeFocused();
});

test("Add to dictionary saves the word to dictionary.txt and stops flagging it everywhere", async ({ page }) => {
  await open(page, STATION);
  await typeTypos(page);
  await caretAfter(page, "of steam");
  await page.keyboard.press("ControlOrMeta+.");
  await page.getByRole("menuitem", { name: "Add “steamline” to dictionary" }).click();
  await expect(misspelled(page)).toHaveText(["statoin"]);
  await expect.poll(() => savedText(page, "dictionary")).toContain("\nsteamline\n");
  // Known in other scenes too, and after a reload (the playground keeps its dictionary for the session).
  await page.reload();
  await caretAfter(page, "in a wound.");
  await page.keyboard.type(" More steamline.");
  await page.waitForTimeout(900);
  await expect(misspelled(page)).toHaveText(["statoin"]);
});

test("spell check can be turned off", async ({ page }) => {
  await open(page, STATION);
  await typeTypos(page);
  await page.getByRole("button", { name: "Spell check" }).click();
  await expect(page.getByRole("button", { name: "Spell check" })).toHaveAttribute("aria-pressed", "false");
  await expect(misspelled(page)).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(800);
  await expect(misspelled(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Spell check" }).click();
  await expect(misspelled(page)).toHaveText(["statoin", "steamline"]);
});

test("no accessibility violations with misspellings and the menu open", async ({ page }) => {
  await open(page, STATION);
  await typeTypos(page);
  await caretAfter(page, "The stat");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("menuitem", { name: "station" })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

