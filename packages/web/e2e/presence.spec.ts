import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const BETRAYAL = "manuscript/02-the-sale/01-night-crossing/01-the-betrayal.md";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  // The sample's prose names no artifact: one mention of the plans, in The Betrayal.
  appendFileSync(join(dir, BETRAYAL), "\nHe had sold [the plans](#art_p1an5x).\n");
  app.git(dir, "commit", "-qam", "Mention the plans");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Presence" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Presence" })).toBeVisible();
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

const grid = (page: Page, name: string) => page.getByRole("grid", { name });

test("characters, places, themes and other entries against every scene, from the scenes' metadata", async ({ page, app }) => {
  await open(page, app);
  const characters = grid(page, "Characters by scene");
  await expect(characters.getByRole("rowheader")).toHaveText(["Ada Varn", "Ben Varn", "Mirela Kost", "Tomas Hale"]);
  await expect(characters.getByRole("gridcell", { name: "The Betrayal: Ada Varn present, point of view" })).toBeVisible();
  await expect(characters.getByRole("gridcell", { name: "The Flood: Ben Varn present, point of view" })).toBeVisible();
  await expect(characters.getByRole("gridcell", { name: "The Station: Mirela Kost not there" })).toBeVisible();
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  await page.getByRole("combobox", { name: "Rows" }).selectOption({ label: "Themes" });
  const themes = grid(page, "Themes by scene");
  await expect(themes.getByRole("gridcell", { name: "The Betrayal: Trust present, strength 3" })).toBeVisible();
  await expect(page).toHaveURL(/type=theme/);

  // A custom type has no list in a scene: it's there where the prose mentions it.
  await page.getByRole("combobox", { name: "Rows" }).selectOption({ label: "Artifacts" });
  await expect(page.getByText("Artifacts have no list in a scene's details")).toBeVisible();
  await expect(grid(page, "Artifacts by scene").getByRole("gridcell", { name: "The Betrayal: The Original Plans mentioned only" })).toBeVisible();
  await expect(grid(page, "Artifacts by scene").getByRole("gridcell", { name: /mentioned only$/ })).toHaveCount(1);

  // The same grid as the swimlanes: one tab stop, arrows within.
  await page.getByRole("combobox", { name: "Rows" }).selectOption({ label: "Characters" });
  await characters.locator("tbody").getByRole("gridcell").first().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(characters.getByRole("gridcell", { name: /^The Last Rivet: Ben Varn/ })).toBeFocused();
  await expect(characters.locator('[tabindex="0"]')).toHaveCount(1);
});
