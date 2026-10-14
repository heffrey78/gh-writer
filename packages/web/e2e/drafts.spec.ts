import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, caretAtEnd, expect, test } from "./fixtures.ts";

const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";
const drafts = (page: Page) => page.getByRole("dialog", { name: "Drafts" });
const notice = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });

test("Drafts lists each version with its own checkpoints, warns before bringing another version's in, and keeps discarded ones", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();

  // A checkpoint in the main version, then a version with one of its own.
  await page.getByRole("button", { name: "Drafts: Main version is open" }).click();
  await expect(drafts(page).getByRole("textbox", { name: "New checkpoint" })).toBeFocused();
  await page.keyboard.type("Main draft");
  await page.keyboard.press("Enter");
  await expect(drafts(page).getByRole("group", { name: "Main version" }).getByRole("listitem")).toHaveCount(1);
  await drafts(page).getByRole("textbox", { name: "New version" }).fill("Night ending");
  await drafts(page).getByRole("button", { name: "Start version" }).click();
  await expect(page.getByRole("button", { name: "Drafts: Night ending is open" })).toBeVisible();

  await caretAtEnd(page, text);
  await page.keyboard.type(" It was night.");
  await expect.poll(() => readFileSync(join(dir, BRIDGE), "utf8"), { timeout: 10_000 }).toContain("It was night.");
  await page.getByRole("button", { name: "Drafts: Night ending is open" }).click();
  await drafts(page).getByRole("textbox", { name: "New checkpoint" }).fill("Night draft");
  await drafts(page).getByRole("button", { name: "Make checkpoint" }).click();

  // The open version holds its own; the main version's is under it, among the others.
  const open = drafts(page).getByRole("group", { name: "Night ending" });
  await expect(open.getByRole("listitem")).toHaveCount(1);
  await expect(open.getByRole("listitem")).toContainText("Night draft");
  const main = drafts(page).getByRole("group", { name: "Main version" });
  await main.getByRole("button", { name: "Checkpoints in “Main version” (1)" }).click();
  await expect(main.getByRole("listitem")).toContainText("Main draft");
  await axe(page);

  // Restoring the main version's checkpoint here says what it does first.
  await main.getByRole("button", { name: "Restore the manuscript from “Main draft”" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("This checkpoint is from “Main version”: its text comes into “Night ending”, the version open now.");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  // Discarded: listed apart, and brought back from there.
  await open.getByRole("button", { name: "Discard “Night ending”" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard version" }).click();
  await expect(notice(page)).toContainText("Discarded “Night ending”.");
  await page.getByRole("button", { name: "Drafts: Main version is open" }).click();
  const discarded = drafts(page).getByRole("region", { name: "Discarded versions" });
  await expect(discarded.getByRole("listitem").filter({ hasText: "Discarded version “Night ending”" })).toBeVisible();
  await discarded.getByRole("button", { name: "Bring “Night ending” back as a version" }).click();
  await expect(page.getByRole("button", { name: "Drafts: Night ending is open" })).toBeVisible();
  await expect(text).toContainText("It was night.");
});
