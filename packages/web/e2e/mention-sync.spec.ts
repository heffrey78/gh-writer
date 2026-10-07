import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

test("a new mention lists its character or place in the scene; removing one sticks; unmarked names can be linked", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const read = () => readFileSync(join(dir, STATION), "utf8");
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Station,/ }).click();
  const text = page.getByRole("textbox", { name: "Scene text" });
  await expect(text).toBeFocused();
  expect(read()).toContain("characters: [char_7f3k2q]\n");

  // Mentioning Ben adds him to the scene's characters, on disk.
  await text.getByText(/the way you count stitches in a wound\./).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" @ben");
  await page.keyboard.press("Enter");
  await page.keyboard.type("waved.");
  await expect.poll(read, { timeout: 10_000 }).toContain("characters: [char_7f3k2q, char_b3n0vs]\n");
  expect(read()).toContain("[Ben](#char_b3n0vs) waved.");

  // Taken off in the details panel, he stays off; the mention stays too.
  await palette(page, "show scene details");
  const panel = page.getByRole("complementary", { name: "Details of “The Station”" });
  await panel.getByRole("button", { name: "Remove “Ben Varn”" }).click();
  await expect.poll(read).toContain("characters: [char_7f3k2q]\n");
  await text.getByText(/Ben waved\./).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Later.");
  await expect.poll(read).toContain("[Ben](#char_b3n0vs) waved. Later.");
  expect(read()).toContain("characters: [char_7f3k2q]\n");

  // With link suggestions on, an unmarked name is underlined, and Alt+Enter links it (and lists the place).
  await palette(page, "suggest links");
  await expect(text.locator(".ghw-unlinked", { hasText: "the bridge" })).toBeVisible();
  await axe(page);
  await text.locator(".ghw-unlinked", { hasText: "the bridge" }).click();
  // ProseMirror reads the click's selection on selectionchange, after the click.
  await expect.poll(() => page.evaluate(() => getSelection()?.anchorNode?.parentElement?.classList.contains("ghw-unlinked"))).toBe(true);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.keyboard.press("Alt+Enter");
  await expect.poll(read).toContain("From the platform she could see [the bridge](#loc_br1dg3), the long black spine");
  await expect.poll(read).toContain("locations: [loc_5tat10, loc_br1dg3]\n");
});
