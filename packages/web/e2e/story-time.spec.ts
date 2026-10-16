import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, openView, test, type App } from "./fixtures.ts";

/** When Day 1 is (#239): days of the story and dates on one timeline. */

/** The sample novel with Day 1 undated: its days and its dates can't be placed together. */
async function openUndated(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  const yaml = join(dir, "novel.yaml");
  writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/\ncalendar:\n {2}start: [\d-]+\n/, "\n"));
  app.git(dir, "commit", "-qam", "No calendar");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return { dir, yaml: () => readFileSync(yaml, "utf8") };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

test("the Timeline says when Day 1 is: a date, the day of a dated scene, or none; until then the days are apart (#241)", async ({ page, app }) => {
  const novel = await openUndated(page, app);
  await openView(page, "Timeline");
  const dayOne = page.getByRole("region", { name: "When Day 1 is" });
  await expect(dayOne).toContainText("Day 1 has no date.");
  await expect(dayOne).toContainText("8 scenes and events are on days of the story, not a date: until Day 1 has one, they can't be placed among the dated ones, and come after them.");
  await page.getByText("As a table").click();
  const what = page.getByRole("table", { name: "Every scene and event in story-time order" }).locator("tbody tr td:nth-child(2)");
  await expect(what.nth(2)).toHaveText("the event “Ada leaves for the polytechnic”");
  await expect(what.nth(3)).toHaveText("the event “The plans are stolen”");

  // A date, by keyboard: the days sit among the dates.
  await dayOne.getByRole("button", { name: "Say when Day 1 is" }).focus();
  await page.keyboard.press("Enter");
  await expect(dayOne.getByRole("textbox", { name: "Day 1 is" })).toBeFocused();
  await page.keyboard.type("2010-06-01");
  await page.keyboard.press("Enter");
  await expect(dayOne).toContainText("Day 1 is 1 Jun 2010");
  await expect(dayOne).not.toContainText("can't be placed");
  expect(novel.yaml()).toMatch(/\ncalendar:\n {2}start: 2010-06-01\n/);
  expect(app.git(novel.dir, "log", "-1", "--format=%s").trim()).toBe("Set when Day 1 is");
  await expect(what.nth(2)).toHaveText("the event “The plans are stolen”");
  await expect(what.last()).toHaveText("the event “Ada leaves for the polytechnic”");
  await expect(page.getByRole("row", { name: /The plans are stolen/ })).toContainText("Day -5 (26 May 2010)");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  // The day of a dated scene: its date, copied.
  await dayOne.getByRole("button", { name: "Edit when Day 1 is" }).click();
  await dayOne.getByRole("button", { name: /^Or the day of a scene/ }).click();
  await page.keyboard.type("the flood");
  await page.keyboard.press("Enter");
  await expect(dayOne).toContainText("Day 1 is 2 Nov 2009");
  expect(novel.yaml()).toMatch(/\ncalendar:\n {2}start: 2009-11-02\n/);

  // None: apart again.
  await dayOne.getByRole("button", { name: "Edit when Day 1 is" }).click();
  await dayOne.getByRole("button", { name: "No date" }).click();
  await expect(dayOne).toContainText("Day 1 has no date.");
  await expect.poll(novel.yaml).not.toContain("calendar");
});

test("a scene moved from a day to a date offers to make that date its day, dating Day 1 (#242)", async ({ page, app }) => {
  const novel = await openUndated(page, app);
  const tree = page.getByRole("tree", { name: "Manuscript" });
  await tree.getByRole("treeitem", { name: /^The Betrayal,/ }).click();
  await palette(page, "show the scene's details");
  const panel = page.getByRole("region", { name: "Details of “The Betrayal”" });
  await panel.getByRole("button", { name: "Edit when" }).click();
  await panel.getByRole("combobox", { name: "When it happens" }).selectOption("date");
  await panel.getByRole("textbox", { name: "Date" }).fill("2026-10-12");
  await page.keyboard.press("Enter");
  const offer = panel.getByRole("group", { name: "Date Day 1 from this" });
  await expect(offer).toContainText("This was Day 3. Make 12 Oct 2026 Day 3, so Day 1 is 10 Oct 2026?");
  await axe(page);
  await offer.getByRole("button", { name: "Make it Day 3" }).click();
  await expect.poll(novel.yaml).toMatch(/\ncalendar:\n {2}start: 2026-10-10\n/);
  await expect(offer).toHaveCount(0);

  // With Day 1 dated, it isn't offered again.
  await panel.getByRole("button", { name: "Done" }).click();
  await tree.getByRole("treeitem", { name: /^Tomas's Workshop,/ }).click();
  const workshop = page.getByRole("region", { name: "Details of “Tomas's Workshop”" });
  await workshop.getByRole("button", { name: "Edit when" }).click();
  await workshop.getByRole("combobox", { name: "When it happens" }).selectOption("date");
  await workshop.getByRole("textbox", { name: "Date" }).fill("2026-10-11");
  await page.keyboard.press("Enter");
  await expect(workshop.getByRole("group", { name: "Date Day 1 from this" })).toHaveCount(0);
});
