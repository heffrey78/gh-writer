import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, test } from "./fixtures.ts";

/** A novel saved in a newer format than this copy reads is never shown as an empty book to write in (D11, #208). */

test("a novel in a newer format says to update gh-writer, and nothing in it can be changed", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  const config = join(dir, "novel.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^schema_version: \d+/m, "schema_version: 99"));
  app.git(dir, "commit", "-qam", "From a newer gh-writer");
  await app.restart(dir);
  await page.goto(app.launchUrl);

  await expect(page.getByRole("heading", { level: 1, name: "This novel needs a newer gh-writer" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Get the latest gh-writer" })).toHaveAttribute("href", "https://github.com/heffrey78/gh-writer/releases/latest");
  await expect(page.getByRole("tree", { name: "Manuscript" })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  await page.getByRole("link", { name: "Back to your novels" }).click();
  await expect(page.getByRole("heading", { name: "Your novels" })).toBeVisible();
  expect(app.git(dir, "status", "--porcelain")).toBe("");
});
