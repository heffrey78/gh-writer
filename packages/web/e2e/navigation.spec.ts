import { expect, test, axe, type App } from "./fixtures.ts";
import type { Page } from "@playwright/test";

/** Back and Forward through the app's pages (#224). */

async function openNovel(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

test("Back and Forward by button and by Alt+Left/Right, but not in text", async ({ page, app }) => {
  await openNovel(page, app);
  const history = page.getByRole("group", { name: "History" });
  const back = history.getByRole("button", { name: "Back" });
  const forward = history.getByRole("button", { name: "Forward" });
  await expect(forward).toBeDisabled();
  await axe(page);

  const views = page.getByRole("navigation", { name: "Views" });
  await views.getByRole("link", { name: "Story bible" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  await views.getByRole("link", { name: "Notes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();

  await back.click();
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  await expect(forward).toBeDisabled();

  // An entry and an event open in modals over the Story bible (#233); the keys walk them too, away from text.
  await palette(page, "character: ada");
  await expect(page.getByRole("dialog", { name: "Ada Varn" })).toBeVisible();
  await palette(page, "off the page: the flood");
  await expect(page.getByRole("dialog", { name: "The flood of '09" })).toBeVisible();
  await page.getByRole("heading", { level: 1, name: "The flood of '09" }).click();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("dialog", { name: "Ada Varn" })).toBeVisible();
  await page.getByRole("heading", { level: 1, name: "Ada Varn" }).click();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  await page.locator("main").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("dialog", { name: "Ada Varn" })).toBeVisible();

  // In text they're the text's: nothing moves.
  await page.getByRole("textbox", { name: "Notes on Ada Varn" }).click();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("dialog", { name: "Ada Varn" })).toBeVisible();

  // Back to the chapter, through the modal again: there, the caret is in its text, where Alt+Right is the text's.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("dialog", { name: "Ada Varn" })).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  await back.click();
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  await back.click();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();

  // A new page clears Forward.
  await expect(forward).toBeEnabled();
  await views.getByRole("link", { name: "Story bible" }).click();
  await expect(forward).toBeDisabled();
});

test("Go back and Go forward are in the palette, and in the shortcuts list", async ({ page, app }) => {
  await openNovel(page, app);
  await palette(page, "character: ada");
  await expect(page.getByRole("heading", { level: 1, name: "Ada Varn" })).toBeVisible();
  await palette(page, "go back");
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();
  await palette(page, "go forward");
  await expect(page.getByRole("heading", { level: 1, name: "Ada Varn" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+/");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toContainText("Go back");
  await expect(shortcuts).toContainText("←");
});
