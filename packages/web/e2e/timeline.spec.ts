import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App, openView } from "./fixtures.ts";

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
  await openView(page, "Timeline");
  await expect(page.getByRole("tab", { name: "Timeline", selected: true })).toBeVisible();
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

test("off-page events are added, edited and deleted from the timeline, and its warnings follow", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const events = () => readFileSync(join(dir, "bible/events.yaml"), "utf8");
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await openView(page, "Timeline");

  await page.getByRole("button", { name: "New off-page event" }).click();
  const dialog = page.getByRole("dialog", { name: "New off-page event" });
  await dialog.getByRole("textbox", { name: "Title" }).fill("Ada at the station again");
  await dialog.getByRole("spinbutton", { name: "Day" }).fill("1");
  await dialog.getByLabel("Time").fill("17:50");
  await dialog.getByRole("checkbox", { name: "Ada Varn" }).check();
  await dialog.getByRole("checkbox", { name: "Varn Station" }).check();
  await axe(page);
  await dialog.getByRole("button", { name: "Add event" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(events).toMatch(/- id: evt_[0-9a-z]{6}\n {4}title: Ada at the station again\n {4}when:\n {6}day: 1\n {6}time: "17:50"\n {4}characters:\n {6}- char_7f3k2q\n {4}locations:\n {6}- loc_5tat10\n$/);
  // On the bridge in Walking the Span at that time: in two places at once.
  const conflicts = page.getByRole("region", { name: "In two places at once" });
  await expect(conflicts).toContainText("Ada Varn is in “Walking the Span” and the event “Ada at the station again” at the same time");

  // Edited from its card: a morning instead, and the warning goes.
  await page.getByRole("button", { name: "Edit the event “Ada at the station again”" }).click();
  await page.getByRole("dialog", { name: "Edit the event" }).getByLabel("Time").fill("08:00");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect.poll(events).toContain('      time: "08:00"\n');
  await expect(conflicts).toContainText("Nobody is in two places at once.");

  // And deleted.
  await page.getByRole("button", { name: "Edit the event “Ada at the station again”" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect.poll(events).not.toContain("Ada at the station again");
  await expect(page.getByRole("button", { name: "Edit the event “Ada at the station again”" })).toHaveCount(0);
  // The file is written a moment before it's committed.
  await expect.poll(() => app.git(dir, "log", "-1", "--format=%s").trim()).toBe("Bible: remove event “Ada at the station again”");
});
