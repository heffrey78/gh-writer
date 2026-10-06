import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { caretAfter, open, savedContains, textbox } from "./helpers.ts";

const STATION = "scene=manuscript/01-return/01-arrival/01-the-station.md";
const CHAPTER = "chapter=manuscript/01-return/01-arrival";
const listbox = (page: Page) => page.getByRole("listbox", { name: "Mention suggestions" });

test("@ and a few letters suggest from the bible; Enter inserts a mention by keyboard", async ({ page }) => {
  await open(page, STATION);
  await caretAfter(page, "in a wound.");
  await page.keyboard.type(" @ad");
  await expect(listbox(page)).toBeVisible();
  await expect(listbox(page).getByRole("option")).toHaveText(["Ada Varn as “Ada”"]);
  await expect(textbox(page)).toHaveAttribute("aria-activedescendant", (await listbox(page).getByRole("option", { selected: true }).getAttribute("id"))!);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(listbox(page)).toHaveCount(0);
  await page.keyboard.type("nodded.");
  await savedContains(page, "in a wound. [Ada](#char_7f3k2q) nodded.");
});

test("an alias inserts as typed, arrows choose, Tab inserts; Escape leaves the text", async ({ page }) => {
  await open(page, CHAPTER);
  await caretAfter(page, "in a wound.");
  await page.keyboard.type(" @the b");
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveText("The Varn Bridge as “the bridge”");
  await page.keyboard.press("Tab");
  await page.keyboard.type("waited. @varn");
  await expect(listbox(page).getByRole("group")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveText("Ben Varn");
  await page.keyboard.press("Enter");
  await page.keyboard.type("came. @Tom");
  await page.keyboard.press("Escape");
  await expect(listbox(page)).toHaveCount(0);
  await page.keyboard.type("orrow.");
  await savedContains(page, "in a wound. [the bridge](#loc_br1dg3) waited. [Ben Varn](#char_b3n0vs) came. @Tomorrow.", "saved:manuscript/01-return/01-arrival/01-the-station.md");
});
