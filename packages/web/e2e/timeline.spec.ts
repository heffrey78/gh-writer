import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

test("an off-page event is added from the timeline, made in its modal, and the timeline's warnings follow", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const file = join(dir, "bible/events/ada-at-the-station-again.md");
  const event = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await openView(page, "Timeline");

  await page.getByRole("tabpanel", { name: "Timeline" }).getByRole("button", { name: "New off-page event" }).click();
  const dialog = page.getByRole("dialog", { name: "New off-page event" });
  await dialog.getByRole("textbox", { name: "Title" }).fill("Ada at the station again");
  await axe(page);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ada at the station again" })).toBeVisible();
  await expect.poll(event).toMatch(/^---\nid: evt_[0-9a-z]{6}\ntitle: Ada at the station again\n---\n$/);

  // Day 1 at 17:50, at the station, with Ada.
  await page.getByRole("button", { name: "Add when it happens" }).click();
  await page.getByRole("combobox", { name: "When it happens" }).selectOption("day");
  await page.getByRole("textbox", { name: "Time" }).fill("17:50");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit who" }).click();
  await page.getByRole("button", { name: /^Add to characters/ }).click();
  await page.keyboard.type("ada");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit where" }).click();
  await page.getByRole("button", { name: /^Add to locations/ }).click();
  await page.keyboard.type("station");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Done" }).click();
  await expect.poll(event).toMatch(/\nwhen:\n {2}day: 1\n {2}time: "17:50"\ncharacters:\n {2}- char_7f3k2q\nlocations:\n {2}- loc_5tat10\n---\n$/);

  // On the bridge in Walking the Span at that time: in two places at once.
  await page.keyboard.press("Escape");
  await openView(page, "Timeline");
  const conflicts = page.getByRole("region", { name: "In two places at once" });
  await expect(conflicts).toContainText("Ada Varn is in “Walking the Span” and the event “Ada at the station again” at the same time");

  // Opened from its card and moved to the morning: the warning goes.
  await page.getByRole("link", { name: "Ada at the station again" }).first().click();
  await page.getByRole("button", { name: "Edit when and how long" }).click();
  await page.getByRole("textbox", { name: "Time" }).fill("08:00");
  await page.keyboard.press("Enter");
  await expect.poll(event).toContain('  time: "08:00"\n');
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await openView(page, "Timeline");
  await expect(conflicts).toContainText("Nobody is in two places at once.");
});
