import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";
const notice = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });

test("compares a version with the main one, word by word, and a checkpoint with now", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();

  await page.getByRole("button", { name: "Checkpoints" }).click();
  await page.getByRole("textbox", { name: "New checkpoint" }).fill("First draft");
  await page.getByRole("button", { name: "Make checkpoint" }).click();
  await expect(page.getByRole("dialog", { name: "Checkpoints" }).getByRole("listitem").filter({ hasText: "First draft" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Versions: Main version is open" }).click();
  await page.getByRole("textbox", { name: "New version" }).fill("A darker ending");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("Started the version");

  // A sentence typed in the app, and a word changed in another editor.
  await text.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" The bridge fell.");
  await expect.poll(() => readFileSync(join(dir, BRIDGE), "utf8"), { timeout: 10_000 }).toContain("The bridge fell.");
  const station = join(dir, STATION);
  writeFileSync(station, readFileSync(station, "utf8").replace("counted them twice", "counted them three times"));
  await expect(text).toContainText("counted them three times");

  await page.getByRole("button", { name: "Versions: A darker ending is open" }).click();
  await page.getByRole("button", { name: "Compare “A darker ending” with the main version" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Compare" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "From" })).toHaveValue("version:main");
  await expect(page.getByRole("combobox", { name: "To" })).toHaveValue("now");
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText("(+4)");
  await expect(summary).toContainText("2 scenes changed");

  const arrival = page.getByRole("region", { name: "Chapter: Arrival" });
  await arrival.getByRole("button", { name: /The Station/ }).click();
  // The reworded paragraph shows the changed words only.
  const reworded = arrival.locator("p").filter({ has: page.locator("del") }).first();
  await expect(reworded.locator("del")).toHaveText("deleted: twice");
  await expect(reworded.locator("ins")).toHaveText("inserted: three times");
  await expect(reworded).toContainText("She stood with her bag at her feet and counted them");
  await arrival.getByRole("button", { name: /Walking the Span/ }).click();
  await expect(arrival.locator("ins").filter({ hasText: "The bridge fell." })).toBeVisible();
  // Other chapters didn't change: only what changed is listed, unless asked.
  await expect(page.getByRole("region", { name: "Chapter: Old Debts" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Only what changed" }).uncheck();
  await expect(page.getByRole("region", { name: "Chapter: Old Debts" })).toBeVisible();
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  // A checkpoint against now, from the checkpoints panel.
  await page.getByRole("button", { name: "Checkpoints" }).click();
  await page.getByRole("button", { name: "Compare “First draft” with now" }).click();
  await expect(page.getByRole("combobox", { name: "From" })).toHaveValue(/^checkpoint:.*first-draft$/);
  await expect(summary).toContainText("2 scenes changed");
  await page.getByRole("button", { name: "Swap from and to" }).click();
  await expect(page.getByRole("combobox", { name: "To" })).toHaveValue(/^checkpoint:/);
  await expect(summary).toContainText("(−4)");
});
