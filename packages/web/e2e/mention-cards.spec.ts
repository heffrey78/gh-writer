import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

async function open(page: Page, app: App) {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
}

const ada = (page: Page) => page.locator('.ghw-mention[data-mention="char_7f3k2q"]').first();
const card = (page: Page) => page.getByRole("dialog", { name: "Ada Varn" });

/** The caret right after Ada's first mention in the text. */
async function caretAfterAda(page: Page) {
  const box = (await ada(page).boundingBox())!;
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
}

test("hovering a mention shows its entry, with relationships as they stand at that scene", async ({ page, app }) => {
  await open(page, app);
  await ada(page).hover();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText("Bridge engineer who comes home");
  await expect(card(page)).toContainText("age31");
  const at = card(page).getByRole("region", { name: "Relationships at “The Station”" });
  await expect(at).toContainText("Allied with Ben Varn");
  await expect(at).not.toContainText("Rivals");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  // It stays while pointed at, and goes when the pointer leaves it.
  await card(page).hover();
  await page.waitForTimeout(400);
  await expect(card(page)).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);

  // After the betrayal, they're rivals.
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Betrayal,/ }).click();
  await ada(page).hover();
  const later = card(page).getByRole("region", { name: "Relationships at “The Betrayal”" });
  await expect(later).toContainText("Rivals with Ben Varn");
  await expect(later).not.toContainText("Allied");
});

test("Alt+Enter beside a mention opens its card; Escape and the entry panel return to the text", async ({ page, app }) => {
  await open(page, app);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await caretAfterAda(page);
  await page.keyboard.press("Alt+Enter");
  await expect(card(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(text).toBeFocused();
  // The caret is where it was: beside the mention.
  await page.keyboard.press("Alt+Enter");
  await expect(card(page)).toBeFocused();

  await card(page).getByRole("button", { name: "Open entry" }).click();
  const panel = page.getByRole("complementary", { name: "Ada Varn" });
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("form", { name: "Details" })).toBeVisible();
  await axe(page);
  await panel.getByRole("button", { name: "Back to the text" }).click();
  await expect(panel).toHaveCount(0);
  await expect(text).toBeFocused();
  await page.keyboard.press("Alt+Enter");
  await expect(card(page)).toBeVisible();
});
