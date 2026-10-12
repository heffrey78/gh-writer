import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, test } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

test("pinned details show under each scene's title, follow edits, are remembered, and never reach the files", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const read = () => readFileSync(join(dir, STATION), "utf8");
  const before = read();
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  const card = page.getByRole("region", { name: "Details of “The Station”" });
  const lines = page.locator(".ghw-pinned");
  await expect(lines).toHaveCount(0);

  // Pinned from the card: a line under every scene's title, in the card's order.
  await card.getByRole("button", { name: "Pin when under the scene titles" }).click();
  await card.getByRole("button", { name: "Pin point of view under the scene titles" }).click();
  await expect(card.getByRole("button", { name: "Pin when under the scene titles" })).toHaveAttribute("aria-pressed", "true");
  await expect(lines).toHaveText(["Ada Varn · Day 1, 09:10 · 20 min", "Ada Varn · Day 1, 17:40 · 40 min"]);
  await expect(card).toContainText("Pinned under each scene's title: point of view, when.");
  await axe(page);

  // An edit to the details shows at once.
  await card.getByRole("button", { name: "Edit when" }).click();
  await card.getByRole("textbox", { name: "Time" }).fill("09:30");
  await page.keyboard.press("Enter");
  await expect(lines.first()).toHaveText("Ada Varn · Day 1, 09:30 · 20 min");
  await page.keyboard.press("Escape");
  await expect.poll(read, { timeout: 10_000 }).toContain('time: "09:30"');
  // The file changed only by that edit: the line is display only.
  expect(read()).toBe(before.replace('time: "09:10"', 'time: "09:30"'));

  // Remembered; shown with the sidebar hidden too.
  await page.reload();
  await expect(text).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  await expect(page.getByRole("tab", { name: "Scene" })).toHaveCount(0);
  await expect(lines).toHaveText(["Ada Varn · Day 1, 09:30 · 20 min", "Ada Varn · Day 1, 17:40 · 40 min"]);

  // A single scene: under its heading.
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^Walking the Span,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();
  await expect(lines).toHaveText(["Ada Varn · Day 1, 17:40 · 40 min"]);

  // Unpinned.
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  const span = page.getByRole("region", { name: "Details of “Walking the Span”" });
  await span.getByRole("button", { name: "Pin when under the scene titles" }).click();
  await expect(lines).toHaveText(["Ada Varn"]);
  await span.getByRole("button", { name: "Pin point of view under the scene titles" }).click();
  await expect(span).not.toContainText("Pinned under each scene's title");
  await expect(lines).toHaveCount(0);
});
