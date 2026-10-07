import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const LAYOUTS = "diagrams/layouts.yaml";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Graph" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Relationships" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

const list = (page: Page) => page.getByRole("region", { name: /^At “/ });
const edge = (page: Page, name: string) => page.locator(`.react-flow__edge[aria-label="${name}"]`);

test("the slider shows relationships as they stand at each scene, in the graph and as a list", async ({ page, app }) => {
  await open(page, app);
  const slider = page.getByRole("slider", { name: "Story position" });
  await expect(slider).toHaveAttribute("aria-valuetext", "Scene 1 of 8: The Station, in Arrival");
  await expect(list(page)).toContainText("Ada Varn: Allied with Ben Varn");
  await expect(edge(page, "Ada Varn, Allied with, Ben Varn")).toHaveCount(1);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  // Across The Betrayal: allies become rivals.
  await slider.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "Scene 5 of 8: The Betrayal, in Night Crossing");
  await expect(page.getByRole("heading", { name: "At “The Betrayal”" })).toBeVisible();
  await expect(edge(page, "Ada Varn, Rivals with, Ben Varn")).toHaveCount(1);
  await expect(edge(page, "Ada Varn, Allied with, Ben Varn")).toHaveCount(0);
  await expect(list(page)).toContainText("Ada Varn: Rivals with Ben Varn, from “The Betrayal”");
  await expect(page).toHaveURL(/at=sc_0d9wm4/);

  // The address keeps the position; the scene picker jumps.
  await page.reload();
  await expect(page.getByRole("heading", { name: "At “The Betrayal”" })).toBeVisible();
  await page.getByRole("button", { name: "Scene The Betrayal" }).click();
  await page.keyboard.type("last rivet");
  await page.keyboard.press("Enter");
  await expect(edge(page, "Ada Varn, Allied with, Ben Varn")).toHaveCount(1);
});

test("nodes keep where they're put, by dragging or by keyboard, one line of the layout file each", async ({ page, app }) => {
  const novel = await open(page, app);
  const before = novel.read(LAYOUTS);
  const tomas = page.locator('.react-flow__node[aria-label="Tomas Hale, Character"]');
  const box = (await tomas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => novel.read(LAYOUTS)).not.toBe(before);
  const changed = (a: string, b: string) => b.split("\n").filter((l) => !a.split("\n").includes(l));
  expect(changed(before, novel.read(LAYOUTS))).toEqual([expect.stringMatching(/^ {6}char_t0ma5h: \{ x: -?\d+, y: -?\d+ \}$/)]);

  const afterDrag = novel.read(LAYOUTS);
  const mirela = page.locator('.react-flow__node[aria-label="Mirela Kost, Character"]');
  await mirela.focus();
  await page.keyboard.press("Enter");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(() => novel.read(LAYOUTS)).not.toBe(afterDrag);
  expect(changed(afterDrag, novel.read(LAYOUTS))).toEqual([expect.stringMatching(/^ {6}char_m1re1a: \{ x: 460, y: \d+ \}$/)]);

  // Back again, they're where they were left (to the whole pixel saved).
  const at = async () => (await tomas.getAttribute("style"))!.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)!.slice(1).map(Number);
  const placed = await at();
  await page.reload();
  await expect(tomas).toBeVisible();
  const again = await at();
  expect(Math.abs(again[0]! - placed[0]!)).toBeLessThanOrEqual(1);
  expect(Math.abs(again[1]! - placed[1]!)).toBeLessThanOrEqual(1);
});

test("filters narrow the graph by relationship type, plotline and scenes, and survive a reload", async ({ page, app }) => {
  await open(page, app);
  await page.getByText("Filters").click();
  // Only rivals and siblings: no ally edge anywhere.
  await page.getByRole("checkbox", { name: "Allied with" }).uncheck();
  await expect(edge(page, "Ada Varn, Allied with, Ben Varn")).toHaveCount(0);
  await expect(edge(page, "Ada Varn, Sibling of, Ben Varn")).toHaveCount(1);
  // Ben's Debt never involves Mirela.
  await page.getByRole("combobox", { name: "In scenes of the plotline" }).selectOption({ label: "Ben's Debt" });
  await expect(page.locator('.react-flow__node[aria-label="Mirela Kost, Character"]')).toHaveCount(0);
  // The first chapter's scenes: Ada and Ben only.
  await page.getByRole("combobox", { name: "In scenes of the plotline" }).selectOption({ label: "Any" });
  await page.getByRole("button", { name: /^to / }).click();
  await page.keyboard.type("walking the span");
  await page.keyboard.press("Enter");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByRole("checkbox", { name: "Allied with" })).not.toBeChecked();
  // Other entity types on request.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByText("Filters").click();
  await page.getByRole("checkbox", { name: "Artifacts" }).check();
  await expect(page.locator('.react-flow__node[aria-label="The Original Plans, Artifact"]')).toBeVisible();
  await axe(page);
});

test("selecting a character brings out their relationships and lists their scenes", async ({ page, app }) => {
  await open(page, app);
  await page.locator('.react-flow__node[aria-label="Tomas Hale, Character"]').click();
  const panel = page.getByRole("region", { name: "Tomas Hale" });
  await expect(panel.getByRole("list", { name: "Relationships" })).toHaveText(["Tomas Hale: Mentor of Ada Varn"]);
  await expect(panel.getByRole("list", { name: "Scenes with Tomas Hale" }).getByRole("link")).toContainText(["Tomas's Workshop"]);
  await expect(edge(page, "Ada Varn, Allied with, Ben Varn")).toHaveCSS("opacity", "0.2");
  await expect(page).toHaveURL(/sel=char_t0ma5h/);
  await axe(page);
  // By keyboard: focus a node, Enter selects it.
  await page.locator('.react-flow__node[aria-label="Mirela Kost, Character"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Mirela Kost" })).toBeVisible();
  await page.getByRole("button", { name: "Show everyone" }).click();
  await expect(page.getByRole("region", { name: /^At “/ })).toBeVisible();
  await panel.getByRole("link").first().isVisible();
});
