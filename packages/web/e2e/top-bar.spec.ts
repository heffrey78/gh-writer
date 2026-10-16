import { axe, expect, test } from "./fixtures.ts";

test("the top bar is the title, the open version, save and sync, and a ⋯ menu for the rest, by keyboard", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const bar = page.getByRole("banner");

  await expect(bar).toContainText("The Bridge at Varn");
  await expect(bar.getByRole("link")).toHaveCount(1);
  await expect(bar.getByRole("button")).toHaveText(["", "", "Main version", /Local only/, ""]); // Back and Forward (#224) first
  await expect(bar.getByRole("button", { name: "More" })).toBeVisible();
  await expect(bar.getByRole("status")).toHaveText("Saved");
  // Nothing spills over on a 13-inch laptop.
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  const more = bar.getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Checkpoints…", "Compile…", "Connect GitHub…", "Your name and email…", "Keyboard shortcuts", "About gh-writer"]);
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Like the system", "Light", "Dark"]);
  await expect(menu.getByRole("menuitemradio", { name: "Like the system" })).toBeChecked();
  await axe(page);

  // The theme changes in place; the menu stays open for another choice.
  await menu.getByRole("menuitemradio", { name: "Dark" }).focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitemradio", { name: "Dark" })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();

  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "About gh-writer" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");

  await more.click();
  await page.getByRole("menuitem", { name: "Checkpoints…" }).click();
  await expect(page.getByRole("dialog", { name: "Drafts" })).toBeVisible();
});
