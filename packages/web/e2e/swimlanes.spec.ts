import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

async function open(page: Page, app: App) {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Plotlines" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Plotlines" })).toBeVisible();
}

const grid = (page: Page) => page.getByRole("grid", { name: "Plotlines by scene" });

test("plotlines run as lanes across the scenes, with each beat marked and its note on focus", async ({ page, app }) => {
  await open(page, app);
  await expect(grid(page).getByRole("rowheader")).toHaveText(["The Sale", "Ben's Debt"]);
  await expect(grid(page).getByRole("columnheader", { name: "The Betrayal" })).toBeVisible();
  for (const chapter of ["Arrival", "Old Debts", "Night Crossing", "Varn Holds"]) await expect(grid(page).getByRole("columnheader", { name: chapter })).toBeVisible();
  const betrayalSale = grid(page).getByRole("gridcell", { name: "The Betrayal: major beat in The Sale, “The plans have been sold”" });
  await expect(betrayalSale).toBeVisible();
  await expect(grid(page).getByRole("gridcell", { name: "The Station: doesn't advance Ben's Debt" })).toBeVisible();
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  // A grid by keyboard: one tab stop, arrows within.
  await grid(page).locator("tbody").getByRole("gridcell").first().focus();
  await expect(grid(page).locator("tbody").getByRole("gridcell").first()).toHaveAccessibleName("The Station: minor beat in The Sale, “First sign of the sale”");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(betrayalSale).toBeFocused();
  await expect(betrayalSale.getByText("The plans have been sold")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(grid(page).getByRole("gridcell", { name: /^The Betrayal: major beat in Ben's Debt/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(grid(page).getByRole("gridcell", { name: /^The Last Rivet: .* Ben's Debt/ })).toBeFocused();
  await page.keyboard.press("Control+Home");
  await expect(grid(page).locator("tbody").getByRole("gridcell").first()).toBeFocused();
  await expect(grid(page).locator('[tabindex="0"]')).toHaveCount(1);
});
