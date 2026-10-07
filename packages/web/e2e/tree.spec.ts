import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, selectionSettled, test, type App } from "./fixtures.ts";

const ARRIVAL = "manuscript/01-return/01-arrival";
const OLD_DEBTS = "manuscript/01-return/02-old-debts";

const tree = (page: Page) => page.getByRole("tree", { name: "Manuscript" });
const item = (page: Page, title: string) => tree(page).getByRole("treeitem", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`) });
const notice = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return {
    dir,
    read: (path: string) => readFileSync(join(dir, path), "utf8"),
    has: (path: string) => existsSync(join(dir, path)),
    lastCommit: () => app.git(dir, "log", "-1", "--format=%s").trim(),
  };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

test("shows parts, chapters and scenes with word counts, as an accessible tree", async ({ page, app }) => {
  await open(page, app);
  await expect(tree(page).getByRole("treeitem")).toHaveCount(14);
  await expect(item(page, "Arrival")).toHaveAttribute("aria-selected", "true");
  await expect(item(page, "Arrival")).toHaveAttribute("aria-level", "2");
  await expect(item(page, "The Station")).toHaveAccessibleName(/^The Station, \d+ words$/);
  // Arrows move, Left collapses and goes up, Enter opens.
  await item(page, "The Station").focus();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "Walking the Span")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item(page, "Arrival")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item(page, "Arrival")).toHaveAttribute("aria-expanded", "false");
  await expect(item(page, "The Station")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("ben");
  await expect(item(page, "Ben's Ledger")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ben's Ledger" })).toBeVisible();
  await axe(page);
});

test("moves scenes by keyboard, within and across chapters", async ({ page, app }) => {
  const novel = await open(page, app);
  await item(page, "The Station").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(notice(page)).toContainText("Moved “The Station” down.");
  await expect.poll(() => novel.read(`${ARRIVAL}/_chapter.yaml`)).toContain("scenes: [sc_br1dg3, sc_5tat1n]");
  await expect(item(page, "The Station")).toBeFocused();
  // At the end of its chapter, down takes it to the start of the next.
  await page.keyboard.press("Alt+ArrowDown");
  await expect(notice(page)).toContainText("into “Old Debts”");
  await expect.poll(() => novel.read(`${OLD_DEBTS}/_chapter.yaml`)).toContain("scenes: [sc_5tat1n, sc_w0rk5h, sc_1edger]");
  expect(novel.has(`${OLD_DEBTS}/01-the-station.md`)).toBe(true);
  expect(novel.lastCommit()).toBe("Manuscript: move scene “The Station”");
});

test("moves a scene by dragging it before another", async ({ page, app }) => {
  const novel = await open(page, app);
  await item(page, "Ben's Ledger").dragTo(item(page, "Tomas's Workshop"), { targetPosition: { x: 20, y: 3 } });
  await expect.poll(() => novel.read(`${OLD_DEBTS}/_chapter.yaml`)).toContain("scenes: [sc_1edger, sc_w0rk5h]");
  await expect(notice(page)).toContainText("Moved “Ben's Ledger”");
  // And onto a chapter: to its end.
  await item(page, "Ben's Ledger").dragTo(item(page, "Arrival"));
  await expect.poll(() => novel.read(`${ARRIVAL}/_chapter.yaml`)).toContain("scenes: [sc_5tat1n, sc_br1dg3, sc_1edger]");
});

test("adds, renames and deletes a scene, and Undo brings it back", async ({ page, app }) => {
  const novel = await open(page, app);
  await tree(page).getByRole("treeitem").first().focus();
  await page.getByRole("toolbar", { name: "Manuscript actions" }).getByRole("button", { name: "Scene" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Title" }).fill("On the Platform");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "On the Platform" })).toBeVisible();
  expect(novel.read(`${ARRIVAL}/_chapter.yaml`)).toMatch(/scenes: \[sc_5tat1n, sc_br1dg3, sc_[0-9a-z]{6}\]/);

  await item(page, "On the Platform").focus();
  await page.keyboard.press("F2");
  await page.getByRole("dialog").getByRole("textbox", { name: "Title" }).fill("The Platform");
  await page.keyboard.press("Enter");
  await expect(item(page, "The Platform")).toBeVisible();
  expect(novel.has(`${ARRIVAL}/03-the-platform.md`)).toBe(true);

  const station = novel.read(`${ARRIVAL}/01-the-station.md`);
  await item(page, "The Station").focus();
  await page.keyboard.press("Delete");
  await expect(notice(page)).toContainText("Deleted the scene “The Station”.");
  await expect(item(page, "The Station")).toHaveCount(0);
  expect(novel.has(`${ARRIVAL}/01-the-station.md`)).toBe(false);
  await notice(page).getByRole("button", { name: "Undo" }).click();
  await expect(item(page, "The Station")).toBeVisible();
  expect(novel.read(`${ARRIVAL}/01-the-station.md`)).toBe(station);
});

test("restores from Recently deleted", async ({ page, app }) => {
  const novel = await open(page, app);
  await item(page, "Walking the Span").focus();
  await page.keyboard.press("Delete");
  await expect(item(page, "Walking the Span")).toHaveCount(0);
  await palette(page, "recently deleted");
  const dialog = page.getByRole("dialog", { name: "Recently deleted" });
  await expect(dialog).toContainText("Walking the Span");
  await axe(page);
  await dialog.getByRole("button", { name: "Restore “Walking the Span”" }).click();
  await expect(item(page, "Walking the Span")).toBeVisible();
  expect(novel.has(`${ARRIVAL}/02-the-bridge.md`)).toBe(true);
});

test("splits a scene at the caret and merges it back from the context menu", async ({ page, app }) => {
  const novel = await open(page, app);
  const original = novel.read(`${ARRIVAL}/01-the-station.md`);
  await item(page, "The Station").click();
  const text = page.getByRole("textbox", { name: "Scene text" });
  await text.getByText(/^From the platform she could see the bridge/).click();
  await selectionSettled(page);
  await palette(page, "split the scene");
  await page.getByRole("dialog").getByRole("textbox", { name: "Title of the new scene" }).fill("The Flags");
  await page.keyboard.press("Enter");
  await expect(item(page, "The Flags")).toBeVisible();
  await expect.poll(() => novel.read(`${ARRIVAL}/02-the-flags.md`)).toMatch(/^---\nid: sc_[0-9a-z]{6}\ntitle: The Flags\n[\s\S]*---\nFrom the platform she could see the bridge/);
  expect(novel.read(`${ARRIVAL}/01-the-station.md`)).not.toContain("From the platform");

  await item(page, "The Station").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
  await axe(page);
  await page.getByRole("menuitem", { name: "Merge with the next scene" }).click();
  await expect(item(page, "The Flags")).toHaveCount(0);
  const paragraphs = (t: string) => t.replace(/^---[\s\S]*?\n---\n/, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  await expect.poll(() => paragraphs(novel.read(`${ARRIVAL}/01-the-station.md`))).toEqual(paragraphs(original));
});
