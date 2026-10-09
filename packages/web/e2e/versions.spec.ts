import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";

const panel = (page: Page) => page.getByRole("dialog", { name: "Versions" });
const notice = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });
const text = (page: Page) => page.getByRole("textbox", { name: "Chapter text" });

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(text(page)).toBeFocused();
  return { dir, read: (path: string) => readFileSync(join(dir, path), "utf8"), git: (...args: string[]) => app.git(dir, ...args) };
}

test("starts a version, writes in it apart from the main one, switches back and forth, discards it and brings it back", async ({ page, app }) => {
  const novel = await open(page, app);
  await expect(page.getByRole("button", { name: "Versions: Main version is open" })).toBeVisible();

  // Keyboard only: the palette opens the panel.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("versions");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole("listitem")).toHaveText([/Main version\s*open/]);
  await axe(page);
  await panel(page).getByRole("textbox", { name: "New version" }).fill("A darker ending");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  await expect(notice(page)).toContainText("Started the version “A darker ending”");
  await expect(page.getByRole("button", { name: "Versions: A darker ending is open" })).toBeVisible();

  await text(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" The bridge fell.");
  await expect.poll(() => novel.read(BRIDGE), { timeout: 10_000 }).toContain("The bridge fell.");

  // Straight to the main version: what was typed is saved into the version first.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Open version: Main");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Versions: Main version is open" })).toBeVisible();
  await expect(text(page)).not.toContainText("The bridge fell.");
  expect(novel.read(BRIDGE)).not.toContain("The bridge fell.");
  expect(novel.git("show", `version/a-darker-ending:${BRIDGE}`)).toContain("The bridge fell.");

  await page.getByRole("button", { name: "Versions: Main version is open" }).click();
  await expect(panel(page).getByRole("listitem")).toHaveText([/Main version\s*open/, /A darker ending.*\+3 vs\. main/]);
  await panel(page).getByRole("button", { name: "Open “A darker ending”" }).click();
  await expect(panel(page)).toBeHidden();
  await expect(text(page)).toContainText("The bridge fell.");

  // Discard it (it was open: the main version opens), then bring it back from the notice.
  await page.getByRole("button", { name: "Versions: A darker ending is open" }).click();
  await panel(page).getByRole("button", { name: "Discard “A darker ending”" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard version" }).click();
  await expect(notice(page)).toContainText("Discarded “A darker ending”.");
  await expect(page.getByRole("button", { name: "Versions: Main version is open" })).toBeVisible();
  await expect(text(page)).not.toContainText("The bridge fell.");
  await notice(page).getByRole("button", { name: "Bring it back" }).click();
  await expect(page.getByRole("button", { name: "Versions: A darker ending is open" })).toBeVisible();
  await expect(text(page)).toContainText("The bridge fell.");
});
