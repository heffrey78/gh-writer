import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { asDesktop, calls, caretAtEnd, expect, launch, test, type App } from "./fixtures.ts";

/**
 * The desktop app's right-click menu (#243), with a stand-in for the shell that can't cut, copy or
 * paste itself (as on macOS and Windows), so the page's own way is what's checked here; on Linux the
 * shell runs the webview's own commands instead, checked in the built app.
 */

const menu = (page: Page) => page.getByRole("menu");
const item = (page: Page, name: string) => menu(page).getByRole("menuitem", { name: new RegExp(`^${name}`) });

/**
 * No axe violations in the open menu, light or dark. Only the menu: it's modal, as the tree's is, so
 * the page behind it is aria-hidden and out of the focus's reach while it's open, which axe counts
 * against the page (it allows that only for an open dialog).
 */
async function axeWithMenu(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
    expect((await new AxeBuilder({ page }).include('[role="menu"]').analyze()).violations).toEqual([]);
  }
}

async function openNovel(page: Page, app: App, clipboard: string | null = null) {
  await app.restart(app.novelRepo("varn"));
  await asDesktop(page, { clipboard });
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  return text;
}

/** Right-click in the middle of what's selected, brought to the middle of the window (clear of the bar under the text). */
async function rightClickSelection(page: Page) {
  const box = await page.evaluate(() => {
    getSelection()!.focusNode!.parentElement!.scrollIntoView({ block: "center" });
    const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y, { button: "right" });
}

test("in the text: Cut, Copy, Paste and Select all, then Back and Forward, in the app's menu, and the focus back in the text", async ({ page, app }) => {
  const text = await openNovel(page, app, "Pasted in.");
  await caretAtEnd(page, text);
  for (let i = 0; i < "to check.".length; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe("to check.");
  await rightClickSelection(page);
  await expect(menu(page).getByRole("menuitem")).toHaveText([/^Cut/, /^Copy/, /^Paste/, /^Select all/, /^Back/, /^Forward/]);
  await expect(menu(page).getByRole("separator")).toHaveCount(1);
  await expect(item(page, "Paste")).not.toHaveAttribute("data-disabled");
  await axeWithMenu(page);
  await item(page, "Cut").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(text).toBeFocused();
  await expect(text).not.toContainText("which ones to check.");
  await expect(text).toContainText("which ones");

  // From the keyboard, at the caret: nothing selected, so nothing to cut or copy.
  await page.keyboard.press("Shift+F10");
  await expect(item(page, "Cut")).toHaveAttribute("data-disabled");
  await expect(item(page, "Copy")).toHaveAttribute("data-disabled");
  await item(page, "Paste").click();
  await expect(text).toContainText("which ones Pasted in.");
  await expect(text).toBeFocused();

  await page.keyboard.press("Shift+F10");
  await expect(item(page, "Select all")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(text).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await item(page, "Select all").click();
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toContain("She stood with her bag at her feet");
});

test("the webview's own menu never shows, and Paste waits for something to paste", async ({ page, app }) => {
  await openNovel(page, app);
  expect(await page.evaluate(() => !document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
  await page.keyboard.press("Shift+F10");
  await expect(item(page, "Paste")).toHaveAttribute("data-disabled");
  await expect.poll(() => calls(page, "clipboard_text")).not.toHaveLength(0);
});

test("on a misspelling, its suggestions first and the editing below, in one menu", async ({ page, app }) => {
  const text = await openNovel(page, app);
  await caretAtEnd(page, text);
  await page.keyboard.type(" Mirela saw the brigde.");
  const wrong = text.locator('[aria-invalid="spelling"]');
  await expect(wrong).toHaveText(["brigde"], { timeout: 15_000 });
  await wrong.click({ button: "right" });
  await expect(item(page, "bridge")).toBeVisible();
  await expect(menu(page).getByRole("menuitem")).toContainText(["bridge", "Add “brigde” to dictionary", "Ignore", "Cut", "Copy", "Paste", "Select all", "Back", "Forward"]);
  await expect(page.locator(".ghw-spell-menu")).toHaveCount(0);
  await item(page, "bridge").first().click();
  await expect(text).toContainText("Mirela saw the bridge.");
  await expect(wrong).toHaveCount(0);
  await expect(text).toBeFocused();
});

test("on a page: Back and Forward, and Copy with text selected", async ({ page, app }) => {
  await openNovel(page, app);
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Outline" }).click();
  const heading = page.getByRole("heading", { level: 1, name: "Outline" });
  await heading.click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText([/^Back/, /^Forward/]);
  await expect(item(page, "Forward")).toHaveAttribute("data-disabled");
  await axeWithMenu(page);
  await item(page, "Back").click();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();

  await page.goForward();
  await heading.click({ clickCount: 3 });
  await heading.click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText([/^Back/, /^Forward/, /^Copy/]);
  await page.keyboard.press("Escape");

  // The tree keeps its own menu.
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^Arrival,/ }).click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Rename…" })).toBeVisible();
  await expect(item(page, "Back")).toHaveCount(0);
});

test("in a dialog's field, the menu opens in the dialog and pastes there", async ({ page, app }) => {
  await openNovel(page, app, "ledger");
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox");
  await expect(search).toBeFocused();
  await search.click({ button: "right" });
  await item(page, "Paste").click();
  await expect(search).toHaveValue("ledger");
  await expect(search).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});

test("in a browser, the browser's menu: no menu of the app's on plain text", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await launch(page, app);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  expect(await text.evaluate((el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
  await page.getByRole("heading", { level: 1 }).click({ button: "right" });
  await expect(menu(page)).toHaveCount(0);
});
