import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";

const text = (page: Page) => page.getByRole("textbox", { name: /^(Chapter|Scene) text$/ });
const badge = (page: Page) => page.getByRole("button", { name: /^Sync: / });
const saveStatus = (page: Page) => page.getByRole("banner").getByRole("status");

/** This machine's clone (served), and another machine's, of one remote. */
function machines(app: App) {
  const remote = app.bareRepo("novel.git");
  const here = join(app.home, "here");
  const other = join(app.home, "other");
  app.git(app.home, "clone", "-q", remote, here);
  app.git(app.home, "clone", "-q", remote, other);
  const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
  /** Replace the last paragraph of a scene on the other machine, commit and push. */
  const pushFromOther = (path: string, paragraph: string) => {
    const lines = read(other, path).trimEnd().split("\n");
    lines[lines.length - 1] = paragraph;
    writeFileSync(join(other, path), `${lines.join("\n")}\n`);
    app.git(other, "commit", "-qam", "From the other machine");
    app.git(other, "push", "-q");
  };
  return { remote, here, other, read, pushFromOther };
}

async function open(page: Page, app: App, dir: string) {
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(text(page)).toBeFocused();
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");
}

async function syncNow(page: Page) {
  await badge(page).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sync now" }).click();
  await page.keyboard.press("Escape");
}

test("writes in a chapter: saved to disk, then committed and pushed with Sync now", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  await expect(page.getByRole("heading", { level: 1, name: "Arrival" })).toBeVisible();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Then the rain came.");
  await expect.poll(() => m.read(m.here, BRIDGE), { timeout: 10_000 }).toMatch(/Then the rain came\.\n$/);
  await expect(saveStatus(page)).toHaveText("Saved");

  await syncNow(page);
  await expect.poll(() => app.git(m.remote, "show", `main:${BRIDGE}`)).toMatch(/Then the rain came\.\n$/);
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");
  expect(app.git(m.remote, "log", "-1", "--format=%s", "main")).toMatch(/^Draft: Walking the Span/);
});

test("a change from another machine reaches the open chapter", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  m.pushFromOther(STATION, "Written on the other machine.");
  await syncNow(page);
  await expect(text(page)).toContainText("Written on the other machine.");
  expect(m.read(m.here, STATION)).toContain("Written on the other machine.");
});

test("a conflict with another machine is resolved by keyboard, and the merge reaches GitHub", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  // Both machines rewrite the chapter's last paragraph.
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Mine.");
  await expect.poll(() => m.read(m.here, BRIDGE), { timeout: 10_000 }).toMatch(/ Mine\.\n$/);
  m.pushFromOther(BRIDGE, "The other machine's ending.");

  await syncNow(page);
  await expect(badge(page)).toHaveAccessibleName("Sync: Conflict");
  await badge(page).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Resolve conflicts…" }).focus();
  await page.keyboard.press("Enter");
  const resolver = page.getByRole("region", { name: "Resolve conflicts" });
  await expect(resolver).toBeFocused();
  await expect(resolver).toContainText("Walking the Span");
  await expect(resolver.getByRole("group", { name: "Theirs" })).toContainText("The other machine's ending.");
  await axe(page);
  await page.keyboard.press("3");
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(resolver).toHaveCount(0);
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");
  const merged = app.git(m.remote, "show", `main:${BRIDGE}`);
  expect(merged).toMatch(/ Mine\.\n\nThe other machine's ending\.\n$/);
  await expect(text(page)).toContainText("The other machine's ending.");
});

test("a save that meets newer text on disk in the same paragraph asks, and keeps what the author chooses", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  await page.getByRole("link", { name: "Walking the Span" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Walking the Span" })).toBeVisible();
  await text(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Typed here.");
  // Before the save goes out, another editor rewrites the same paragraph.
  const lines = m.read(m.here, BRIDGE).trimEnd().split("\n");
  lines[lines.length - 1] = "Rewritten in another editor.";
  writeFileSync(join(m.here, BRIDGE), `${lines.join("\n")}\n`);

  const resolver = page.getByRole("region", { name: "Resolve conflicts" });
  await expect(resolver).toBeFocused({ timeout: 10_000 });
  await expect(resolver.getByRole("group", { name: "On disk" })).toContainText("Rewritten in another editor.");
  await page.keyboard.press("1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(resolver).toHaveCount(0);
  await expect.poll(() => m.read(m.here, BRIDGE)).toMatch(/ Typed here\.\n$/);
  await expect(saveStatus(page)).toHaveText("Saved");
});

test("moves around the manuscript by keyboard, and focus mode hides everything but the text", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  const nav = page.getByRole("navigation", { name: "Manuscript" });
  await expect(nav.getByRole("link", { name: /^Arrival/ })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Ben's Ledger" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ben's Ledger" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();

  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(nav).toBeHidden();
  await expect(page.getByRole("banner")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(nav).toBeVisible();
});

test("checks spelling, knowing the story's names, and adds words to dictionary.txt", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Mirela saw the brigde.");
  const wrong = text(page).locator('[aria-invalid="spelling"]');
  await expect(wrong).toHaveText(["brigde"], { timeout: 15_000 });
  await wrong.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add “brigde” to dictionary" }).click();
  await expect(wrong).toHaveCount(0);
  await expect.poll(() => (existsSync(join(m.here, "dictionary.txt")) ? m.read(m.here, "dictionary.txt").split("\n") : [])).toContain("brigde");
});

test("says when gh-writer stops answering", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  await app.stop();
  await expect(page.getByRole("alert")).toContainText("gh-writer isn't answering", { timeout: 10_000 });
});

test("has no accessibility violations: writing, and with the sync details open, light and dark", async ({ page, app }) => {
  const m = machines(app);
  await open(page, app, m.here);
  await axe(page);
  await badge(page).click();
  await expect(page.getByRole("dialog")).toContainText("Everything is on GitHub");
  await axe(page);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});
