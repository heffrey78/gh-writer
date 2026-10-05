import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { caretAfter, caretBefore, move, open, savedContains, savedText, status, textbox } from "./helpers.ts";

const CHAPTER = "manuscript/01-return/01-arrival";
const STATION = `${CHAPTER}/01-the-station.md`;
const BRIDGE = `${CHAPTER}/02-the-bridge.md`;
const novel = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const read = (path: string) => readFileSync(novel + path, "utf8");

const openChapter = (page: Page) => open(page, `chapter=${encodeURIComponent(CHAPTER)}`);
const savedFile = (page: Page, path: string) => savedText(page, `saved:${path}`);

/** Put the caret at the start of the nth scene's first paragraph. */
const caretAtSceneStart = (page: Page, n: number) =>
  page.evaluate((n) => {
    const editor = window.editor!;
    let pos = 0;
    for (let i = 0; i < n; i++) pos += editor.state.doc.child(i).nodeSize;
    editor.chain().focus().setTextSelection(pos + 2).run();
  }, n);

test("a chapter opens as one text with labelled scene boundaries", async ({ page }) => {
  await openChapter(page);
  const sections = textbox(page).locator("section[data-scene]");
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toHaveAttribute("aria-label", "Scene: The Station");
  await expect(sections.nth(1)).toHaveAttribute("aria-label", "Scene: Walking the Span");
  await expect(status(page)).toHaveText("Identical to the files on disk");
});

test("an edit is saved only to the scene it is in", async ({ page }) => {
  await openChapter(page);
  await caretAfter(page, "Somebody who knew which ones to check");
  await page.keyboard.type(", and when");
  await savedContains(page, "which ones to check, and when.", `saved:${BRIDGE}`);
  await expect(status(page)).toHaveText("1 changed");
  expect(await savedFile(page, STATION)).toBe(read(STATION));
  expect(await savedFile(page, BRIDGE)).toBe(read(BRIDGE).replace("ones to check.", "ones to check, and when."));
});

test("the caret moves across a scene boundary with the arrow keys", async ({ page }) => {
  await openChapter(page);
  await caretAfter(page, "stitches in a wound.");
  await move(page, "ArrowRight");
  await page.keyboard.type("Then ");
  await savedContains(page, "\nThen [Ben](#char_b3n0vs) met her", `saved:${BRIDGE}`);
  await move(page, "ArrowUp");
  await move(page, "End");
  await page.keyboard.type("!");
  await savedContains(page, "in a wound.!\n", `saved:${STATION}`);
});

test("Backspace and Delete at a boundary don't merge scenes", async ({ page }) => {
  await openChapter(page);
  await caretAtSceneStart(page, 1);
  await page.keyboard.press("Backspace");
  await caretAfter(page, "stitches in a wound.");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  await expect(textbox(page).locator("section[data-scene]")).toHaveCount(2);
  await expect(status(page)).toHaveText("Identical to the files on disk");
});

test("typing over a selection across scenes edits both and keeps them apart", async ({ page }) => {
  await openChapter(page);
  await caretBefore(page, "in a wound.");
  for (let i = 0; i < 12; i++) await move(page, "Shift+ArrowDown");
  await page.keyboard.type("X");
  await expect(textbox(page).locator("section[data-scene]")).toHaveCount(2);
  await expect(status(page)).toHaveText("2 changed");
  await savedContains(page, "count stitches X\n", `saved:${STATION}`);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(status(page)).toHaveText("Identical to the files on disk");
});

test("no accessibility violations in the chapter view", async ({ page }) => {
  await openChapter(page);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});
