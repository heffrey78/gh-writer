import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const NIGHT = "manuscript/02-the-sale/01-night-crossing/_chapter.yaml";
const HOLDS = "manuscript/02-the-sale/02-varn-holds/_chapter.yaml";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Corkboard" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Corkboard" })).toBeVisible();
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

const card = (page: Page, title: string) => page.getByRole("listitem", { name: title, exact: true });

test("shows scenes as cards by chapter, and filters them, keeping the filter in the address", async ({ page, app }) => {
  await open(page, app);
  await expect(page.getByRole("region", { name: "Night Crossing" }).getByRole("listitem")).toHaveCount(2);
  await expect(card(page, "The Station")).toContainText("drafted · Ada Varn");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  await page.getByRole("combobox", { name: "Point of view" }).selectOption({ label: "Ada Varn" });
  await expect(page.getByText("7 of 8 scenes match.")).toBeVisible();
  await expect(card(page, "The Flood")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Status" }).selectOption("idea");
  await expect(page.getByText("2 of 8 scenes match.")).toBeVisible();
  await expect(page).toHaveURL(/pov=char_7f3k2q/);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("idea");
  await expect(page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /^Move “/ }) })).toHaveCount(2);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("8 scenes.")).toBeVisible();
});

test("moves a card past its visible neighbour with the keyboard, in the whole book", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.getByRole("combobox", { name: "Point of view" }).selectOption({ label: "Ada Varn" });
  await page.getByRole("button", { name: "Move “Mirela's Offer”" }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  // Before The Betrayal, the card it passed: the hidden Flood stays where it was.
  await expect.poll(() => novel.read(NIGHT)).toContain("scenes: [sc_0ffer5, sc_0d9wm4, sc_f100d0]");
  expect(novel.read(HOLDS)).toContain("scenes: [sc_r1vet8]");
  await expect(page.getByRole("button", { name: "Move “Mirela's Offer”" })).toBeFocused();
});

test("a card dropped on a filtered board lands next to the card it was dropped on", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  const novel = await open(page, app);
  await page.getByRole("combobox", { name: "Point of view" }).selectOption({ label: "Ada Varn" });
  const betrayal = card(page, "The Betrayal");
  const box = (await betrayal.boundingBox())!;
  await page.getByRole("button", { name: "Move “Mirela's Offer”" }).dragTo(betrayal, { targetPosition: { x: box.width - 8, y: 8 } });
  await expect.poll(() => novel.read(NIGHT)).toContain("scenes: [sc_0d9wm4, sc_0ffer5, sc_f100d0]");
  // The board shows the move before the next drag starts, or it would pick up whatever card is there now.
  await expect(page.getByRole("region", { name: "Night Crossing" }).getByRole("listitem", { name: "Mirela's Offer" })).toBeVisible();
  await page.getByRole("button", { name: "Move “Mirela's Offer”" }).dragTo(card(page, "The Station"), { targetPosition: { x: 8, y: 8 } });
  await expect.poll(() => novel.read("manuscript/01-return/01-arrival/_chapter.yaml")).toContain("scenes: [sc_0ffer5, sc_5tat1n, sc_br1dg3]");
});
