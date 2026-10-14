import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, caretAtEnd, expect, test } from "./fixtures.ts";

/** Headings, lists and tables from the command palette, saved to the scene's file (D10, #202). The palette runs its command a frame after it closes, so each step waits for the command's work before typing on. */

const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

test("a heading and a table from the palette, filled in by keyboard, with text and lists below, are written to the scene's Markdown", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  const read = () => readFileSync(join(dir, BRIDGE), "utf8");

  await caretAtEnd(page, text);
  await page.keyboard.press("Enter");
  await page.keyboard.type("At the toll house");
  await palette(page, "Heading 2");
  await expect(text.getByRole("heading", { level: 3, name: "At the toll house" })).toBeVisible();

  await palette(page, "Insert table");
  await expect(text.getByRole("columnheader")).toHaveCount(3);
  await page.keyboard.type("Who");
  for (const cell of ["Paid", "When"]) {
    await page.keyboard.press("Tab");
    await page.keyboard.type(cell);
  }
  // A fourth column, after the one the caret's in; Tab goes on into it, and on along the rows.
  await palette(page, "Table: add a column after");
  await expect(text.getByRole("columnheader")).toHaveCount(4);
  for (const cell of ["Why", "Ben", "nothing", "Monday", "luck"]) {
    await page.keyboard.press("Tab");
    await page.keyboard.type(cell);
  }
  await expect(text.getByRole("columnheader")).toHaveText(["Who", "Paid", "When", "Why"]);
  await expect(text.getByRole("row").nth(1).getByRole("cell")).toHaveText(["Ben", "nothing", "Monday", "luck"]);
  await axe(page);

  // Below the table that ends the scene: a click on the line under it, or ↓ out of its last row.
  await text.locator("table + p").click();
  await page.keyboard.type("Paid in full.");
  await expect(text.locator("table + p")).toHaveText("Paid in full.");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" Ben paid.");
  await expect(text.locator("table + p")).toHaveText("Paid in full. Ben paid.");

  // Lists show their bullets and numbers, past the app's CSS reset.
  await page.keyboard.press("Enter");
  for (const step of ["- bread", "Enter", "salt", "Enter", "Enter", "1. first"]) {
    if (step === "Enter") await page.keyboard.press(step);
    else await page.keyboard.type(step);
  }
  const style = (selector: string) => text.locator(selector).last().evaluate((el) => getComputedStyle(el).listStyleType);
  expect(await style("ul")).toBe("disc");
  expect(await style("ol")).toBe("decimal");
  await axe(page);

  await expect
    .poll(read, { timeout: 10_000 })
    .toContain(
      "## At the toll house\n\n| Who | Paid    | When   | Why  |\n| --- | ------- | ------ | ---- |\n| Ben | nothing | Monday | luck |\n|     |         |        |      |\n\nPaid in full. Ben paid.\n\n- bread\n- salt\n\n1. first\n",
    );
});
