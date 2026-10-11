import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, test } from "./fixtures.ts";

test("Progress shows the length against the target, today's words and streak, and keeps the targets in novel.yaml", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Progress" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Progress" })).toBeVisible();

  // The sample was committed today, so its words were all written today; it aims for 80,000 by mid-2027.
  const length = page.getByRole("region", { name: "Length", exact: true });
  await expect(length).toContainText("744of 80,000 words");
  await expect(length).toContainText("79,256 words to go. At your pace of 27 words a day over the last four weeks, you'd finish on");
  await expect(length).toContainText("after your deadline. To finish on June 30, 2027, write");
  const glance = page.getByRole("region", { name: "At a glance" });
  await expect(glance).toContainText("Written today744");
  await expect(glance).toContainText("Streak—set a daily goal");
  await axe(page);

  // Targets, by keyboard.
  await page.getByRole("spinbutton", { name: "Length" }).fill("2000");
  await page.getByRole("textbox", { name: "By" }).fill("2099-12-31");
  await page.getByRole("spinbutton", { name: "Words a day" }).fill("500");
  await page.keyboard.press("Enter");
  await expect(length).toContainText("of 2,000 words");
  await expect(page.getByRole("meter", { name: "Length against the target" })).toHaveAttribute("aria-valuetext", "744 of 2,000 (37%)");
  await expect(length).toContainText("1,256 words to go. At your pace of 27 words a day over the last four weeks, you'd finish on");
  await expect(length).toContainText("before your deadline.");
  await expect(glance).toContainText("of 500 a day · goal met");
  await expect(glance).toContainText("Streak1 daybest 1 day");
  expect(readFileSync(join(dir, "novel.yaml"), "utf8")).toMatch(/target:\n {2}words: 2000\n {2}date: 2099-12-31\n {2}daily: 500\n/);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  // Removed again: no target, no projection.
  await page.getByRole("spinbutton", { name: "Length" }).fill("");
  await page.getByRole("button", { name: "Save targets" }).click();
  await expect(length).toContainText("Set a target length below");
});

test("the charts read by keyboard and as tables, and name the chapters and scenes that stand out", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Progress" }).click();

  const perDay = page.getByRole("region", { name: "Words per day" });
  await expect(perDay).toContainText("744 added and 0 cut over these 30 days");
  const chart = perDay.getByRole("img", { name: /Words added and cut each day/ });
  await chart.focus();
  await page.keyboard.press("End");
  await expect(perDay.getByText(/: 744 added, 0 cut\./)).toBeAttached();
  await perDay.getByText("As a table").click();
  await expect(perDay.getByRole("table").getByRole("row")).toHaveCount(2);
  await expect(perDay.getByRole("table")).toContainText("744");

  // A range of 90 days, from the row above the charts.
  await page.getByRole("radiogroup", { name: "Show" }).getByText("90 days", { exact: true }).click();
  await expect(perDay).toContainText("over these 90 days");

  const length = page.getByRole("region", { name: "Length of the book" });
  await expect(length).toContainText("744 words of 80,000");
  await expect(length).toContainText("the target is far above this scale");

  const chapters = page.getByRole("region", { name: "Chapters and their scenes" });
  // The sample's chapters are even (231, 145, 218 and 150 words): nothing stands out.
  await expect(chapters.getByRole("note")).toContainText("No chapter or scene stands out");
  await chapters.getByRole("img").focus();
  await page.keyboard.press("ArrowRight");
  await expect(chapters.getByText("The Station, in Arrival: 113 words.")).toBeAttached();
  await chapters.getByText("As a table").click();
  await expect(chapters.getByRole("table").getByRole("row")).toHaveCount(9);

  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});

test("Today beside the counts rises as the writing is saved, before it's committed, and opens Progress", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  const todayLink = page.getByRole("link", { name: /^Today: / });
  await expect(todayLink).toHaveAccessibleName("Today: 744 words added. Open Progress.");

  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Five more words were written.");
  await expect(todayLink).toHaveAccessibleName("Today: 749 words added. Open Progress.", { timeout: 15_000 });
  await todayLink.click();
  await expect(page.getByRole("heading", { level: 1, name: "Progress" })).toBeVisible();
  await expect(page.getByRole("region", { name: "At a glance" })).toContainText("Written today749");
});
