import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";

const panel = (page: Page) => page.getByRole("dialog", { name: "Checkpoints" });
const notice = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });
const saved = (page: Page) => expect(page.getByRole("banner").getByRole("status")).toHaveText("Saved", { timeout: 10_000 });

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return { dir, read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

async function makeCheckpoint(page: Page, name: string) {
  await page.getByRole("button", { name: "Checkpoints" }).click();
  await panel(page).getByRole("textbox", { name: "New checkpoint" }).fill(name);
  await panel(page).getByRole("button", { name: "Make checkpoint" }).click();
  await expect(panel(page).getByRole("listitem").filter({ hasText: name })).toContainText(/words/);
}

/** Type at the end of the open text, and wait until it's on disk in `path`. */
async function typeAtEnd(page: Page, text: string, file: () => string) {
  const box = page.getByRole("textbox", { name: /^(Chapter|Scene) text$/ });
  await box.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
  await expect.poll(file, { timeout: 10_000 }).toContain(text.trim());
  await saved(page);
}

test("brings one scene back from a checkpoint, and undoes it", async ({ page, app }) => {
  const novel = await open(page, app);
  const before = novel.read(STATION);
  await makeCheckpoint(page, "Before the big cut");
  await page.keyboard.press("Escape");

  await page.getByRole("treeitem", { name: /^The Station,/ }).click();
  await typeAtEnd(page, " Cut later.", () => novel.read(STATION));

  await page.getByRole("button", { name: "Checkpoints" }).click();
  await panel(page).getByRole("button", { name: "Restore “The Station” from “Before the big cut”" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Only this scene goes back");
  await axe(page);
  await confirm.getByRole("button", { name: "Restore scene" }).click();

  await expect(notice(page)).toContainText("Restored “The Station” from “Before the big cut”.");
  await expect.poll(() => novel.read(STATION)).toBe(before);
  await expect(page.getByRole("textbox", { name: "Scene text" })).not.toContainText("Cut later.");

  await notice(page).getByRole("button", { name: "Undo" }).click();
  await expect(notice(page)).toContainText("Undone");
  await expect.poll(() => novel.read(STATION)).toContain("Cut later.");
  await expect(page.getByRole("textbox", { name: "Scene text" })).toContainText("Cut later.");
});

test("brings the whole manuscript back, with unsaved text kept in the automatic checkpoint", async ({ page, app }) => {
  const novel = await open(page, app);
  const before = { station: novel.read(STATION), bridge: novel.read(BRIDGE) };
  await makeCheckpoint(page, "First draft");
  await page.keyboard.press("Escape");
  await typeAtEnd(page, " A new ending.", () => novel.read(BRIDGE));

  await page.getByRole("button", { name: "Checkpoints" }).click();
  await panel(page).getByRole("button", { name: "Restore the manuscript from “First draft”" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore manuscript" }).click();
  await expect(notice(page)).toContainText("Restored the manuscript from “First draft”.");
  await expect.poll(() => [novel.read(STATION), novel.read(BRIDGE)]).toEqual([before.station, before.bridge]);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).not.toContainText("A new ending.");

  // The automatic checkpoint holds what was there, and is listed when asked for.
  await page.getByRole("button", { name: "Checkpoints" }).click();
  await expect(panel(page).getByText("automatic", { exact: true })).toHaveCount(0);
  await panel(page).getByRole("checkbox", { name: /Show automatic/ }).check();
  await expect(panel(page).getByRole("listitem").first()).toContainText("Before restoring the manuscript from “First draft”");
  await axe(page);
});

test("says why no checkpoint was made", async ({ page, app }) => {
  await open(page, app);
  await page.getByRole("button", { name: "Checkpoints" }).click();
  await expect(panel(page)).toContainText("No checkpoints yet");
  await panel(page).getByRole("textbox", { name: "New checkpoint" }).fill("x".repeat(200));
  await panel(page).getByRole("textbox", { name: "New checkpoint" }).press("Enter");
  await expect(panel(page).getByRole("listitem")).toHaveCount(1);
  // A scene the checkpoint doesn't have can't come back from it.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
});
