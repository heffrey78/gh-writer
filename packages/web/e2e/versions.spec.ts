import { readFileSync, writeFileSync } from "node:fs";
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

const RIVET = "manuscript/02-the-sale/02-varn-holds/02-the-last-rivet.md";
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

/** Replace a scene's last paragraph on disk, as another editor would. */
function rewriteEnding(dir: string, path: string, text: string) {
  const full = join(dir, path);
  const lines = readFileSync(full, "utf8").trimEnd().split("\n");
  lines[lines.length - 1] = text;
  writeFileSync(full, `${lines.join("\n")}\n`);
}

async function startVersion(page: Page, name: string) {
  await page.getByRole("button", { name: /^Versions: / }).click();
  await panel(page).getByRole("textbox", { name: "New version" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Versions: ${name} is open` })).toBeVisible();
}

async function openVersion(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(`Open version: ${name}`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Versions: ${name === "Main version" ? "Main version" : name} is open` })).toBeVisible();
}

test("an alternate ending is written, compared with the main version and adopted, keeping what changed in the main one", async ({ page, app }) => {
  const novel = await open(page, app);
  await startVersion(page, "A darker ending");
  rewriteEnding(novel.dir, RIVET, "The seventh pier gave way, and the bridge went into the river with Ben on it.");
  await page.getByRole("treeitem", { name: /^Varn Holds,/ }).click();
  await expect(text(page)).toContainText("The seventh pier gave way");

  await openVersion(page, "Main version");
  rewriteEnding(novel.dir, STATION, "She counted them twice.");
  await page.getByRole("treeitem", { name: /^Arrival,/ }).click();
  await expect(text(page)).toContainText("She counted them twice.");

  await page.getByRole("button", { name: "Versions: Main version is open" }).click();
  await panel(page).getByRole("button", { name: "Compare “A darker ending” with the open version" }).click();
  await page.getByRole("region", { name: "Chapter: Varn Holds" }).getByRole("button", { name: /The Last Rivet/ }).click();
  await expect(page.locator("del").filter({ hasText: "seventh pier gave way" })).toBeVisible();

  await page.getByRole("button", { name: "Versions: Main version is open" }).click();
  await panel(page).getByRole("button", { name: "Adopt “A darker ending” into the main version" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Adopt" }).click();
  await expect(notice(page)).toContainText("The main version now has “A darker ending” in it");
  expect(novel.read(RIVET)).toContain("The seventh pier gave way");
  expect(novel.read(STATION)).toContain("She counted them twice.");

  // Undo puts the main version back as it was.
  await notice(page).getByRole("button", { name: "Undo" }).click();
  await expect(notice(page)).toContainText("Undone");
  await expect.poll(() => novel.read(RIVET)).not.toContain("The seventh pier gave way");
});

test("a passage both versions changed is settled in the resolver when adopting, by keyboard", async ({ page, app }) => {
  const novel = await open(page, app);
  await startVersion(page, "A darker ending");
  rewriteEnding(novel.dir, RIVET, "In the version, the rivet sheared.");
  await openVersion(page, "Main version");
  rewriteEnding(novel.dir, RIVET, "In the main version, the rivet held.");
  await expect.poll(() => novel.git("status", "--porcelain")).not.toBe("");

  await page.getByRole("button", { name: "Versions: Main version is open" }).click();
  await panel(page).getByRole("button", { name: "Adopt “A darker ending” into the main version" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Adopt" }).click();
  const resolver = page.getByRole("dialog", { name: /Adopt “A darker ending”: passages both versions changed/ });
  await expect(resolver).toContainText("In the main version, the rivet held.");
  await expect(resolver).toContainText("In the version, the rivet sheared.");
  await expect(resolver.getByText("Main version", { exact: true }).first()).toBeVisible();
  await expect(resolver.getByRole("region", { name: "Resolve conflicts" })).toBeFocused();
  await axe(page);
  await page.keyboard.press("2");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(resolver).toBeHidden();
  await expect(notice(page)).toContainText("The main version now has “A darker ending” in it");
  expect(novel.read(RIVET)).toContain("In the version, the rivet sheared.");
});

test("brings one scene across from another version in the compare view", async ({ page, app }) => {
  const novel = await open(page, app);
  await startVersion(page, "Rework");
  rewriteEnding(novel.dir, STATION, "She did not count the flags at all.");
  rewriteEnding(novel.dir, RIVET, "Not this one.");
  await openVersion(page, "Main version");

  await page.getByRole("button", { name: "Versions: Main version is open" }).click();
  await panel(page).getByRole("button", { name: "Compare “Rework” with the open version" }).click();
  await page.getByRole("region", { name: "Chapter: Arrival" }).getByRole("button", { name: /The Station/ }).click();
  await page.getByRole("button", { name: "Use this scene from “Rework”" }).click();
  await expect(notice(page)).toContainText("“The Station” is now as it is in “Rework”.");
  expect(novel.read(STATION)).toContain("She did not count the flags at all.");
  expect(novel.read(RIVET)).not.toContain("Not this one.");
  // Now the same in both: no longer a difference.
  await expect(page.getByRole("region", { name: "Chapter: Arrival" })).toHaveCount(0);
});
