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
  const length = page.getByRole("region", { name: "Length" });
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
