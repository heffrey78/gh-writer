import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, openView, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const LEDGER = "manuscript/01-return/02-old-debts/02-bens-ledger.md";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await openView(page, "Board");
  await expect(page.getByRole("radio", { name: "Board" })).toBeChecked();
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const card = (page: Page, title: string) => page.getByRole("listitem", { name: title, exact: true });

test("shows every scene in a column for its status, with counts, and filters them", async ({ page, app }) => {
  await open(page, app);
  await expect(page).toHaveURL(/\/outline\/board$/);
  await expect(column(page, "Idea").getByRole("listitem")).toHaveCount(2);
  await expect(column(page, "Outlined").getByRole("listitem")).toHaveCount(2);
  await expect(column(page, "Drafted").getByRole("listitem")).toHaveCount(3);
  await expect(column(page, "Revised").getByRole("listitem")).toHaveCount(1);
  await expect(column(page, "Final")).toContainText("No scenes.");
  await expect(column(page, "Drafted")).toContainText("3 scenes");
  await expect(card(page, "The Station")).toContainText("Arrival · Ada Varn");
  await expect(card(page, "The Station")).toContainText(/\d+ words/);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  await page.getByRole("combobox", { name: "Point of view" }).selectOption({ label: "Ben Varn" });
  await expect(page.getByText(/^1 of 8 scenes match/)).toBeVisible();
  await expect(column(page, "Drafted").getByRole("listitem")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Part" }).selectOption({ label: "Return" });
  await expect(page.getByText(/^0 of 8 scenes match/)).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText(/^8 scenes, /)).toBeVisible();
});

test("moves a card to the next status with the keyboard, changing its file, and keeps the focus", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.getByRole("button", { name: "Move “The Station”, Drafted" }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(() => novel.read(STATION)).toMatch(/^status: revised$/m);
  await expect(column(page, "Revised").getByRole("listitem", { name: "The Station" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move “The Station”, Revised" })).toBeFocused();
  await expect(page.getByText("Moved “The Station” to Revised.")).toBeVisible();
  // Not past the ends.
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(() => novel.read(STATION)).toMatch(/^status: final$/m);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("button", { name: "Move “The Station”, Final" })).toBeFocused();
});

test("a card dropped on another column takes its status", async ({ page, app }) => {
  await page.setViewportSize({ width: 1400, height: 1200 });
  const novel = await open(page, app);
  // Tried again until it lands: a drag in WebKit as the board settles can miss on CI.
  await expect(async () => {
    await page.getByRole("button", { name: "Move “Ben's Ledger”, Idea" }).dragTo(column(page, "Final"));
    await expect.poll(() => novel.read(LEDGER), { timeout: 3_000 }).toMatch(/^status: final$/m);
  }).toPass({ timeout: 20_000 });
  await expect(column(page, "Final").getByRole("listitem", { name: "Ben's Ledger" })).toBeVisible();
});

test("the palette opens the board", async ({ page, app }) => {
  await open(page, app);
  await page.getByRole("radiogroup", { name: "Show the outline as" }).getByText("Table", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("drafting board");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/outline\/board$/);
});
