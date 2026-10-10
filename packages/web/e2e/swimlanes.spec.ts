import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App, openView } from "./fixtures.ts";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await openView(page, "Plotlines");
  await expect(page.getByRole("tab", { name: "Plotlines", selected: true })).toBeVisible();
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

const grid = (page: Page) => page.getByRole("grid", { name: "Plotlines by scene" });

test("plotlines run as lanes across the scenes, with each beat marked and its note on focus", async ({ page, app }) => {
  await open(page, app);
  await expect(grid(page).getByRole("rowheader")).toHaveText(["Ben's Debt", "The Sale"]);
  await expect(grid(page).getByRole("columnheader", { name: /The Betrayal$/ })).toBeVisible();
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
  // The scene opens with its text focused: open the palette after that, or the focus moves out of it.
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("show scene details");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Details of “The Station”" });
  await panel.getByRole("combobox", { name: "Weight of “The Sale”" }).selectOption("major");
  await openView(page, "Plotlines");
  await expect(grid(page).getByRole("gridcell", { name: /^The Station: major beat in The Sale/ })).toBeVisible();
});

const chapters = (read: (path: string) => string) =>
  ["01-return/01-arrival", "01-return/02-old-debts", "02-the-sale/01-night-crossing", "02-the-sale/02-varn-holds"].map((c) => read(`manuscript/${c}/_chapter.yaml`));

test("a column moves by keyboard through the whole book, exactly as the outline moves rows", async ({ page, app }) => {
  // In the swimlanes: The Station two steps right (past Walking the Span, into Old Debts), pressed
  // in quick succession: the second step starts from where the first left it.
  const novel = await open(page, app);
  const handle = page.getByRole("button", { name: "Move “The Station”" });
  await handle.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(() => novel.read("manuscript/01-return/02-old-debts/_chapter.yaml")).toContain("scenes: [sc_5tat1n, sc_w0rk5h, sc_1edger]");
  await expect(handle).toBeFocused();
  const viaSwimlanes = chapters(novel.read);

  // The same in the outline, on a fresh copy: the same order files.
  const other = app.novelRepo("outline-twin");
  await app.restart(other);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Outline" }).click();
  const row = page.getByRole("button", { name: "Move “The Station”" });
  await row.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => chapters((p) => readFileSync(join(other, p), "utf8"))).toEqual(viaSwimlanes);
});

test("dragging a column beside another puts its scene there", async ({ page, app }) => {
  const novel = await open(page, app);
  const target = grid(page).getByRole("columnheader", { name: /The Betrayal$/ });
  const box = (await target.boundingBox())!;
  await page.getByRole("button", { name: "Move “Mirela's Offer”" }).dragTo(target, { targetPosition: { x: 4, y: box.height / 2 } });
  await expect.poll(() => novel.read("manuscript/02-the-sale/01-night-crossing/_chapter.yaml")).toContain("scenes: [sc_0ffer5, sc_0d9wm4, sc_f100d0]");
  await expect(grid(page).getByRole("columnheader").filter({ hasText: /^(The Betrayal|Mirela's Offer)$/ })).toHaveText(["Mirela's Offer", "The Betrayal"]);
  await axe(page);
});

test("quiet stretches show under a lower threshold, in scenes or words, and the novel can keep it", async ({ page, app }) => {
  const novel = await open(page, app);
  const quiet = page.getByRole("region", { name: "Quiet stretches" });
  await expect(quiet).toContainText("No plotline goes quiet for more than 3 scenes.");
  await page.getByRole("spinbutton", { name: "How many" }).fill("0");
  await expect(quiet.getByRole("listitem")).toHaveCount(4);
  await expect(quiet).toContainText("Ben's Debt: quiet for 1 scene");
  await expect(grid(page).getByRole("gridcell", { name: "Tomas's Workshop: doesn't advance Ben's Debt, in a quiet stretch of 1 scene" })).toBeVisible();
  await expect(page).toHaveURL(/gap=0/);
  await axe(page);

  // In words: a high threshold hides them again.
  await page.getByRole("combobox", { name: "Counted in" }).selectOption("words");
  await expect(quiet).toContainText("No plotline goes quiet for more than 5,000 words.");
  await page.getByRole("spinbutton", { name: "How many" }).fill("50");
  await expect(quiet.getByRole("listitem")).toHaveCount(4);

  // Kept as the novel's own.
  await page.getByRole("button", { name: "Make this the novel's default" }).click();
  await expect.poll(() => novel.read("novel.yaml")).toContain("plotline_gap:\n  words: 50\n");
  await page.reload();
  await expect(page.getByRole("spinbutton", { name: "How many" })).toHaveValue("50");
  await expect(page.getByRole("button", { name: "Make this the novel's default" })).toHaveCount(0);
});

test("zooms to one part or chapter, and keeps the zoom in the address", async ({ page, app }) => {
  await open(page, app);
  await page.getByRole("combobox", { name: "Show" }).selectOption({ label: "Part: The Sale" });
  await expect(grid(page).locator("tbody tr").first().getByRole("gridcell")).toHaveCount(4);
  await expect(grid(page).getByRole("columnheader", { name: /The Station$/ })).toHaveCount(0);
  await expect(grid(page).getByRole("columnheader", { name: /The Betrayal$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Show" })).toHaveValue("pt_5a1e00");
  await page.getByRole("combobox", { name: "Show" }).selectOption({ label: "Chapter: Arrival" });
  await expect(grid(page).locator("tbody tr").first().getByRole("gridcell")).toHaveCount(2);
});

test("the grid can be drawn larger or smaller, and its frame closes around it", async ({ page, app }) => {
  await open(page, app);
  const cell = grid(page).locator("tbody").getByRole("gridcell").first();
  const medium = (await cell.boundingBox())!.width;
  await page.getByRole("combobox", { name: "Size" }).selectOption("large");
  await expect.poll(async () => (await cell.boundingBox())!.width).toBeGreaterThan(medium + 6);
  await expect(page).toHaveURL(/size=large/);
  await page.getByRole("combobox", { name: "Size" }).selectOption("small");
  await expect.poll(async () => (await cell.boundingBox())!.width).toBeLessThan(medium);
  // The frame hugs the table: its right edge is the last column's.
  const frame = (await grid(page).locator("xpath=..").boundingBox())!;
  const table = (await grid(page).boundingBox())!;
  expect(Math.abs(frame.x + frame.width - (table.x + table.width))).toBeLessThanOrEqual(2);
  await axe(page);
});
