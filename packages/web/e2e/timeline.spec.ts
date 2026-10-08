import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

async function open(page: Page, app: App, before?: (dir: string) => void) {
  const dir = app.novelRepo("varn");
  if (before) {
    before(dir);
    app.git(dir, "commit", "-qam", "Prepare");
  }
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Timeline" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
}

const table = (page: Page) => page.getByRole("table", { name: "Every scene and event in story-time order" });

test("scenes and events in story time, with the flashback early in time and late in the book", async ({ page, app }) => {
  await open(page, app);
  const flood = page.getByRole("link", { name: "The Flood", exact: true }).first();
  await expect(flood.locator("xpath=..")).toContainText(/#6 in the book\s*· flashback/);
  await expect(page.getByText("11 years later")).toBeVisible();
  await expect(page.getByRole("region", { name: "In two places at once" })).toContainText("Nobody is in two places at once.");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  await page.getByText("As a table").click();
  const rows = table(page).getByRole("row");
  await expect(rows.nth(1)).toContainText("The flood of '09");
  await expect(rows.nth(2)).toContainText("“The Flood” (flashback)");
  await expect(rows.nth(2)).toContainText("6 of 8");
  await expect(rows.nth(2)).toContainText("2 Nov 2009, 23:00");
  await expect(rows.last()).toContainText("The Last Rivet");
});

test("lanes by location put the flood and its scene on the bridge", async ({ page, app }) => {
  await open(page, app);
  await page.getByRole("combobox", { name: "Lanes" }).selectOption({ label: "Location" });
  await expect(page).toHaveURL(/lanes=location/);
  await page.getByText("As a table").click();
  await expect(table(page).getByRole("row").filter({ hasText: "The flood of '09" })).toContainText("The Varn Bridge");
  await expect(table(page).getByRole("columnheader").last()).toHaveText("Location");
});

test("someone in two places at once is named, with both scenes", async ({ page, app }) => {
  // The Station at 17:50 on day 1: Ada is on the bridge then, in Walking the Span.
  await open(page, app, (dir) => {
    const file = join(dir, STATION);
    writeFileSync(file, readFileSync(file, "utf8").replace('time: "09:10"', 'time: "17:50"'));
  });
  const conflicts = page.getByRole("region", { name: "In two places at once" });
  await expect(conflicts.getByRole("listitem")).toHaveCount(1);
  await expect(conflicts).toContainText("Ada Varn is in “Walking the Span” and “The Station” at the same time, in different places.");
  await expect(conflicts.getByRole("link", { name: "“The Station”" })).toHaveAttribute("href", /\/scene\/sc_5tat1n$/);
});
