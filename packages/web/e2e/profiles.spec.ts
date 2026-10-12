import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const SPAN = "manuscript/01-return/01-arrival/02-the-bridge.md";

async function openEntry(page: Page, app: App, id: string) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const novelPath = new URL(app.launchUrl).pathname;
  await page.goto(app.launchUrl.replace(novelPath, `${novelPath}/bible/${id}`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

test("a plotline's profile: its beats in order, a missing one written in place, the scenes it skips, who and where", async ({ page, app }) => {
  const novel = await openEntry(page, app, "plot_h315tz");
  const beats = page.getByRole("region", { name: "Beats" });
  await expect(beats.getByRole("listitem").filter({ has: page.getByRole("link") }).first()).toContainText("The Station, a minor beatFirst sign of the sale");
  await expect(beats.getByRole("button", { name: /^Write the beat/ })).toHaveCount(3);
  await expect(beats).toContainText("Skips 2 scenes between its first beat and its last: Ben's Ledger, The Flood.");
  await expect(beats).toContainText("Ada Varn (6 scenes)");
  await expect(beats).toContainText("The Varn Bridge (3 scenes)");
  await axe(page);

  // Walking the Span lists The Sale as a bare ID: written, it becomes a map holding the beat.
  await beats.getByRole("button", { name: "Write the beat in “Walking the Span”" }).click();
  await expect(page.getByRole("textbox", { name: "Beat in “Walking the Span”" })).toBeFocused();
  await page.keyboard.type("Ada sees the flags up close");
  await page.keyboard.press("Enter");
  await expect.poll(() => novel.read(SPAN), { timeout: 10_000 }).toContain("plotlines:\n  - id: plot_h315tz\n    beat: Ada sees the flags up close\n  - id: plot_gr1efa\n");
  await expect(beats.getByRole("button", { name: /^Write the beat/ })).toHaveCount(2);
  await expect(beats).toContainText("Ada sees the flags up close");
});

test("a location's profile: who comes there and the story time its scenes span", async ({ page, app }) => {
  await openEntry(page, app, "loc_br1dg3");
  const who = page.getByRole("region", { name: "Who comes here" });
  await expect(who.getByRole("listitem")).toHaveText(["Ada Varn (4 scenes)", "Ben Varn (4 scenes)", "Tomas Hale (2 scenes)"]);
  await expect(who).toContainText("Story time: 2 Nov 2009, 23:00 to Day 5, 06:00 (5 Mar 2024).");
  await who.getByRole("link", { name: "Tomas Hale" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Tomas Hale" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Who comes here" })).toHaveCount(0);
});

test("a theme's profile: its strength scene by scene", async ({ page, app }) => {
  await openEntry(page, app, "theme_trvst5");
  const strength = page.getByRole("list", { name: "Strength in each scene, in reading order" });
  await expect(strength.getByRole("listitem")).toHaveText([
    "The Station: not there",
    "Walking the Span: present (2)",
    "Tomas's Workshop: not there",
    "Ben's Ledger: strong (3)",
    "The Betrayal: strong (3)",
    "The Flood: not there",
    "Mirela's Offer: present (2)",
    "The Last Rivet: present (2)",
  ]);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});
