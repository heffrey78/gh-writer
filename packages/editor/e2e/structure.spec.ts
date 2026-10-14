import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { caretAfter, move, open, savedContains, textbox } from "./helpers.ts";

/** Headings, lists and tables written by keyboard alone (D10, #202). */

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const openScene = (page: Page, scene: string) => open(page, `scene=${encodeURIComponent(scene)}`);

/** Type the steps: text as typed, and the keys named among them pressed. */
async function keys(page: Page, ...steps: string[]) {
  for (const step of steps) {
    if (/^(Enter|Tab|Shift\+Tab|Control\+Alt\+\d)$/.test(step)) await page.keyboard.press(step);
    else await page.keyboard.type(step);
  }
}

test("a heading, then a numbered list with one nested in it, by typing Markdown's own marks", async ({ page }) => {
  await openScene(page, STATION);
  await move(page, "ControlOrMeta+End");
  await keys(page, "Enter", "## A letter", "Enter", "1. Sell", "Enter", "Pay", "Enter", "Tab", "rent", "Enter", "debt", "Enter", "Enter", "Enter", "After.");
  const text = textbox(page);
  await expect(text.getByRole("heading", { level: 3, name: "A letter" })).toBeVisible();
  // Tab nests an item in a list of its own kind.
  await expect(text.locator(":scope > ol > li")).toHaveCount(2);
  await expect(text.locator("ol ol > li")).toHaveText(["rent", "debt"]);
  await savedContains(page, "in a wound.\n\n## A letter\n\n1. Sell\n2. Pay\n   1. rent\n   2. debt\n\nAfter.\n");
  // The heading's level by shortcut, and back to text.
  await caretAfter(page, "A letter");
  await keys(page, "Control+Alt+1");
  await savedContains(page, "\n\n# A letter\n\n");
  await keys(page, "Control+Alt+0");
  await savedContains(page, "\n\nA letter\n\n1. Sell");
});

test("Tab and Shift+Tab move between a table's cells, and Tab in the last adds a row", async ({ page }) => {
  await openScene(page, "scenes/sampler.md");
  await caretAfter(page, "Tuesday");
  await keys(page, "Tab");
  await keys(page, "Tab", "Wednesday", "Tab", "7");
  await savedContains(page, "| Wednesday |     7 |");
  await keys(page, "Shift+Tab");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await savedContains(page, "| Wednesday! |     7 |");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("a bulleted list from a dash, Shift+Tab lifts an item, Enter on an empty item leaves the list", async ({ page }) => {
  await openScene(page, STATION);
  await move(page, "ControlOrMeta+End");
  await keys(page, "Enter", "- bread", "Enter", "Tab", "rye", "Enter", "Shift+Tab", "salt", "Enter", "Enter", "Done.");
  await savedContains(page, "in a wound.\n\n- bread\n  - rye\n- salt\n\nDone.\n");
});
