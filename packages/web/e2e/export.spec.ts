import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

async function open(page: Page, app: App, view: string) {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: view }).click();
}

async function downloaded(page: Page): Promise<{ name: string; text: string }> {
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Download SVG" }).click()]);
  return { name: file.suggestedFilename(), text: readFileSync((await file.path())!, "utf8") };
}

test("the graph exports as SVG and as Mermaid, as it stands at the page's scene", async ({ page, app, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, app, "Graph");
  const slider = page.getByRole("slider", { name: "Story position" });
  await slider.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "At “The Betrayal”" })).toBeVisible();

  await page.getByRole("button", { name: "Export" }).click();
  await axe(page);
  const svg = await downloaded(page);
  expect(svg.name).toBe("relationships-at-the-betrayal.svg");
  expect(svg.text).toContain("<title>Relationships at “The Betrayal”</title>");
  expect(svg.text).toContain(">Rivals with<");
  expect(svg.text).not.toContain(">Allied with<");

  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Copy Mermaid" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied the diagram as Mermaid" })).toBeVisible();
  const mermaid = await page.evaluate(() => navigator.clipboard.readText());
  expect(mermaid).toMatch(/^flowchart LR\n/);
  expect(mermaid).toContain('char_7f3k2q -.-|"Rivals with"| char_b3n0vs');
});

test("plotlines, presence and the timeline export as SVG; the timeline as Mermaid too", async ({ page, app }) => {
  await open(page, app, "Plotlines");
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy Mermaid" })).toHaveCount(0);
  expect((await downloaded(page)).text).toContain("<title>Plotlines by scene</title>");

  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Presence" }).click();
  await page.getByRole("combobox", { name: "Rows" }).selectOption({ label: "Themes" });
  await page.getByRole("button", { name: "Export" }).click();
  const themes = await downloaded(page);
  expect(themes.name).toBe("presence-themes.svg");
  expect(themes.text).toContain(">Trust<");

  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Timeline" }).click();
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy Mermaid" })).toBeVisible();
  expect((await downloaded(page)).text).toContain("6th · flashback");
});
