import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { caretAfter, move, open, savedContains, settled, textbox } from "./helpers.ts";

const STATION = "scene=manuscript/01-return/01-arrival/01-the-station.md";
const BIG = "chapter=generated/10k-words";

/** The caret line's vertical middle, as a fraction of the window height. */
const caretHeight = (page: Page) =>
  page.evaluate(() => {
    const view = window.editor!.view;
    const { top, bottom } = view.coordsAtPos(view.state.selection.head);
    return (top + bottom) / 2 / window.innerHeight;
  });

/** Put the caret in the middle of the document. */
const caretInMiddle = (page: Page) =>
  page.evaluate(() => {
    const editor = window.editor!;
    const middle = editor.state.doc.content.size / 2;
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (pos < 0 && node.isText && at > middle) pos = at + 1;
      return pos < 0;
    });
    editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
  });

test("focus mode hides everything but the text, and keeps the caret where it was", async ({ page }) => {
  await open(page, STATION);
  await caretAfter(page, "counted them");
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(page.getByRole("complementary")).toBeHidden();
  await expect(textbox(page)).toHaveClass(/ghw-focus/);
  await expect(textbox(page)).toBeFocused();
  await page.keyboard.type(" again");
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(page.getByRole("banner")).toBeVisible();
  await savedContains(page, "counted them again twice");
});

test("modes persist across reloads", async ({ page }) => {
  await open(page, STATION);
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await page.reload();
  await settled(page);
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(textbox(page)).toHaveClass(/ghw-typewriter/);
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await page.reload();
  await settled(page);
  await expect(textbox(page)).not.toHaveClass(/ghw-typewriter/);
  await expect(textbox(page)).toHaveClass(/ghw-focus/);
});

test("a mode toggled from a button returns to the text with the selection as it was", async ({ page }) => {
  await open(page, STATION);
  await caretAfter(page, "counted them");
  await page.getByRole("button", { name: "Typewriter scrolling" }).click();
  await expect(page.getByRole("button", { name: "Typewriter scrolling" })).toHaveAttribute("aria-pressed", "true");
  await expect(textbox(page)).toBeFocused();
  await page.keyboard.type(" again");
  await savedContains(page, "counted them again twice");
});

test("typewriter scrolling keeps the caret line at a fixed height while typing and moving", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await open(page, BIG);
  await caretInMiddle(page);
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await expect.poll(() => caretHeight(page)).toBeCloseTo(0.4, 1);

  await page.keyboard.type("A new sentence, typed in typewriter mode, long enough to wrap onto another line of the page. ", { delay: 5 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("And another paragraph.");
  expect(await caretHeight(page)).toBeCloseTo(0.4, 1);

  for (let i = 0; i < 8; i++) await move(page, "ArrowDown");
  expect(await caretHeight(page)).toBeCloseTo(0.4, 1);
  for (let i = 0; i < 15; i++) await move(page, "ArrowUp");
  expect(await caretHeight(page)).toBeCloseTo(0.4, 1);
});

test("typewriter scrolling doesn't move the text under a click", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await open(page, BIG);
  await caretInMiddle(page);
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await expect.poll(() => caretHeight(page)).toBeCloseTo(0.4, 1);
  const scrolled = await page.evaluate(() => window.scrollY);
  // A point in the text a fifth of the way down the window, well away from the caret line.
  const box = (await textbox(page).boundingBox())!;
  const caretBefore = await page.evaluate(() => window.editor!.state.selection.head);
  await page.mouse.click(box.x + 40, 800 * 0.2);
  await expect.poll(() => page.evaluate(() => window.editor!.state.selection.head)).not.toBe(caretBefore);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  expect(Math.abs((await caretHeight(page)) - 0.4)).toBeGreaterThan(0.05);
  // The next keystroke brings the caret back to the typewriter line.
  await page.keyboard.type("x");
  await expect.poll(() => caretHeight(page)).toBeCloseTo(0.4, 1);
});

test("no accessibility violations in focus mode", async ({ page }) => {
  await open(page, STATION);
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(page.getByRole("banner")).toBeHidden();
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});
