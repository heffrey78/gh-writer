import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Plotlines" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Plotlines" })).toBeVisible();
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

const grid = (page: Page) => page.getByRole("grid", { name: "Plotlines by scene" });

test("plotlines run as lanes across the scenes, with each beat marked and its note on focus", async ({ page, app }) => {
  await open(page, app);
  await expect(grid(page).getByRole("rowheader")).toHaveText(["Ben's Debt", "The Sale"]);
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
  await expect(grid(page).locator("tbody").getByRole("gridcell").first()).toHaveAccessibleName("The Station: doesn't advance Ben's Debt");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(grid(page).getByRole("gridcell", { name: /^The Betrayal: major beat in Ben's Debt/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(betrayalSale).toBeFocused();
  await expect(betrayalSale.getByText("The plans have been sold")).toBeVisible();
  await page.keyboard.press("End");
  await expect(grid(page).getByRole("gridcell", { name: /^The Last Rivet: .* The Sale/ })).toBeFocused();
  await page.keyboard.press("Control+Home");
  await expect(grid(page).locator("tbody").getByRole("gridcell").first()).toBeFocused();
  await expect(grid(page).locator('[tabindex="0"]')).toHaveCount(1);
});

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

test("a cell links its scene to the plotline, and edits or removes the link, changing only those lines", async ({ page, app }) => {
  const novel = await open(page, app);
  const before = novel.read(STATION);
  const cell = grid(page).getByRole("gridcell", { name: /^The Station: .*Ben's Debt/ });
  await cell.click();
  await expect.poll(() => novel.read(STATION)).not.toBe(before);
  expect(novel.read(STATION).replace("  - plot_gr1efa\n", "")).toBe(before);
  await expect(cell).toHaveAccessibleName("The Station: major beat in Ben's Debt");

  // By keyboard: Enter on the marked cell opens its editor; Escape returns to the cell.
  await cell.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "“The Station” in Ben's Debt" });
  await expect(editor).toBeVisible();
  await axe(page);
  await editor.getByRole("combobox", { name: "Weight" }).selectOption("minor");
  await editor.getByRole("textbox", { name: "Beat" }).fill("Ben is late to the train");
  await page.keyboard.press("Enter");
  await expect.poll(() => novel.read(STATION)).toContain("    beat: Ben is late to the train");
  expect(novel.read(STATION).replace("  - id: plot_gr1efa\n    weight: minor\n    beat: Ben is late to the train\n", "")).toBe(before);
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(cell).toBeFocused();
  await expect(cell).toHaveAccessibleName("The Station: minor beat in Ben's Debt, “Ben is late to the train”");

  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("button", { name: "Remove from this plotline" }).click();
  await expect.poll(() => novel.read(STATION)).toBe(before);
  await expect(cell).toHaveAccessibleName("The Station: doesn't advance Ben's Debt");
});

test("the swimlanes and the scene details panel agree after an edit in either", async ({ page, app }) => {
  await open(page, app);
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Station,/ }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("show scene details");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Details of “The Station”" });
  await panel.getByRole("combobox", { name: "Weight of “The Sale”" }).selectOption("major");
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Plotlines" }).click();
  await expect(grid(page).getByRole("gridcell", { name: /^The Station: major beat in The Sale/ })).toBeVisible();
});
