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
  // By first appearance, each with how many scenes it's in.
  await expect(characters.getByRole("rowheader")).toHaveText(["Ada Varn8", "Ben Varn4", "Tomas Hale3", "Mirela Kost1"]);
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

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

test("a cell puts someone in a scene, or takes them out, through the scene's metadata", async ({ page, app }) => {
  const novel = await open(page, app);
  const before = novel.read(STATION);
  const characters = grid(page, "Characters by scene");
  const mirela = characters.getByRole("gridcell", { name: /^The Station: Mirela Kost/ });
  await mirela.click();
  await expect.poll(() => novel.read(STATION)).toBe(before.replace("characters: [char_7f3k2q]", "characters: [char_7f3k2q, char_m1re1a]"));
  await expect(mirela).toHaveAccessibleName("The Station: Mirela Kost present");

  // Listed: Enter opens its editor; she becomes the point of view, then leaves the scene altogether.
  await mirela.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "Mirela Kost in “The Station”" });
  await axe(page);
  await editor.getByRole("checkbox", { name: "The scene's point of view" }).check();
  await expect.poll(() => novel.read(STATION)).toContain("pov: char_m1re1a\n");
  await editor.getByRole("button", { name: "Remove from this scene" }).click();
  await expect(mirela).toBeFocused();
  // Out of the list and no longer the point of view: back to the file as it was, but for the point of view.
  await expect.poll(() => novel.read(STATION)).toBe(before.replace("pov: char_7f3k2q\n", ""));

  // A theme's strength.
  await page.getByRole("combobox", { name: "Rows" }).selectOption({ label: "Themes" });
  const trust = grid(page, "Themes by scene").getByRole("gridcell", { name: /^The Betrayal: Trust/ });
  await trust.click();
  await page.getByRole("dialog").getByRole("combobox", { name: "Strength" }).selectOption("1");
  await expect.poll(() => novel.read("manuscript/02-the-sale/01-night-crossing/01-the-betrayal.md")).toContain("  - id: theme_trvst5\n    strength: 1\n");
  await page.keyboard.press("Escape");
  await expect(trust).toHaveAccessibleName("The Betrayal: Trust present, strength 1");

  // Custom types are there by mention only: a cell explains rather than toggles.
  await page.getByRole("combobox", { name: "Rows" }).selectOption({ label: "Artifacts" });
  await grid(page, "Artifacts by scene").locator("tbody").getByRole("gridcell").first().click();
  await expect(page.getByRole("status").filter({ hasText: "Artifacts are in a scene where its prose mentions them" })).toBeVisible();
});

test("the matrix and the scene details panel agree after an edit in either", async ({ page, app }) => {
  await open(page, app);
  // A slow disk: the scene opens while the cell's edit is still being saved, and shows it all the same.
  await page.route(
    (url) => decodeURIComponent(url.pathname).endsWith("/01-the-station.md"),
    async (route) => {
      if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    },
  );
  const cell = grid(page, "Characters by scene").getByRole("gridcell", { name: /^The Station: Tomas Hale/ });
  await cell.click();
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Station,/ }).click();
  // The scene opens with its text focused: open the palette after that, or the focus moves out of it.
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("show scene details");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Details of “The Station”" });
  await expect(panel.getByRole("list").first()).toContainText("Tomas Hale");
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Presence" }).click();
  await expect(cell).toHaveAccessibleName("The Station: Tomas Hale present");
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Station,/ }).click();
  await panel.getByRole("button", { name: "Remove “Tomas Hale”" }).click();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Presence" }).click();
  await expect(grid(page, "Characters by scene").getByRole("gridcell", { name: "The Station: Tomas Hale not there" })).toBeVisible();
});

test("rows sort by first appearance, most scenes or name, and long absences are flagged", async ({ page, app }) => {
  await open(page, app);
  const characters = grid(page, "Characters by scene");
  await expect(characters.getByRole("rowheader")).toHaveText(["Ada Varn8", "Ben Varn4", "Tomas Hale3", "Mirela Kost1"]);
  await page.getByRole("combobox", { name: "Sort" }).selectOption({ label: "Name" });
  await expect(characters.getByRole("rowheader")).toHaveText(["Ada Varn8", "Ben Varn4", "Mirela Kost1", "Tomas Hale3"]);
  await page.getByRole("combobox", { name: "Sort" }).selectOption({ label: "Most scenes" });
  await expect(characters.getByRole("rowheader").first()).toHaveText("Ada Varn8");
  await expect(page).toHaveURL(/sort=total/);

  const absences = page.getByRole("region", { name: "Long absences" });
  await expect(absences).toContainText("No characters away for more than 3 scenes.");
  await page.getByRole("spinbutton", { name: "How many" }).fill("0");
  await expect(absences).toContainText("Mirela Kost: away for 1 scene");
  await expect(absences).toContainText("at “The Last Rivet”, and never back.");
  await expect(characters.getByRole("gridcell", { name: "The Last Rivet: Mirela Kost not there, in an absence of 1 scene" })).toBeVisible();
  await axe(page);
});
