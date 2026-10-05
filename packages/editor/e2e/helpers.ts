import { expect, type Page } from "@playwright/test";

/** The playground's editor: a single scene or a whole chapter. */
export const textbox = (page: Page) => page.getByRole("textbox", { name: /^(Scene|Chapter) text$/ });
export const status = (page: Page) => page.getByTestId("status");

/** Wait for the editor to finish autofocusing, which TipTap does on an animation frame after mount. */
export async function settled(page: Page) {
  await expect(textbox(page)).toBeFocused();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** Open a scene (`scene=…`) or chapter (`chapter=…`) in the playground. */
export async function open(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await settled(page);
}

/**
 * Press a key that moves the caret natively, then wait until ProseMirror has seen the move: it
 * reads the selection on the browser's selectionchange event, which arrives after the key (and
 * may be preceded by one from an earlier focus change), and Playwright types faster than any
 * person would.
 */
export async function move(page: Page, key: string) {
  const before = await page.evaluate(() => window.editor!.state.selection.toJSON());
  await page.keyboard.press(key);
  await page
    .waitForFunction((before) => JSON.stringify(window.editor!.state.selection.toJSON()) !== JSON.stringify(before), before, { timeout: 1000 })
    .catch(() => {}); // a key that couldn't move the caret (e.g. at the end already)
}

/** Put the caret straight after `text`, or straight before it with `before`. */
export async function caretAt(page: Page, text: string, before = false) {
  await page.evaluate(
    ({ text, before }) => {
      const editor = window.editor!;
      let pos = -1;
      editor.state.doc.descendants((node, at) => {
        const i = pos < 0 && node.isText ? node.text!.indexOf(text) : -1;
        if (i >= 0) pos = at + i + (before ? 0 : text.length);
        return pos < 0;
      });
      if (pos < 0) throw new Error(`"${text}" not in document`);
      editor.chain().focus().setTextSelection(pos).run();
    },
    { text, before },
  );
  // TipTap focuses on the next frame; keys pressed before then would go elsewhere.
  await expect(textbox(page)).toBeFocused();
}

export const caretAfter = (page: Page, text: string) => caretAt(page, text);
export const caretBefore = (page: Page, text: string) => caretAt(page, text, true);

/** The saved file's exact text: Playwright's text matchers collapse whitespace, and line breaks matter here. */
export const savedText = (page: Page, testId = "saved") => page.getByTestId(testId).evaluate((el) => el.textContent);

/** Wait until the saved file contains `text` (the editor reports changes after a pause). */
export const savedContains = (page: Page, text: string, testId = "saved") => expect.poll(() => savedText(page, testId)).toContain(text);
