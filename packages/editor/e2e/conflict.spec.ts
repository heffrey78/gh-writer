import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const resolver = (page: Page) => page.getByRole("region", { name: "Resolve conflicts" });
const status = (page: Page) => resolver(page).getByRole("status");
const resolved = (page: Page) => page.getByTestId("resolved").evaluate((el) => el.textContent);

async function open(page: Page) {
  await page.goto("/?resolve");
  await expect(resolver(page)).toBeFocused();
  await expect(status(page)).toHaveText("Conflict 1 of 2 · 0 resolved");
}

test("resolves two conflicts by keyboard alone", async ({ page }) => {
  await open(page);
  // The status field first: one value each side, no "keep both".
  await expect(resolver(page)).toContainText("The Station: the “status” field");
  await expect(resolver(page).getByRole("group", { name: "Mine" })).toContainText("status: revised");
  await expect(resolver(page).getByRole("group", { name: "Theirs" })).toContainText("status: final");
  await expect(resolver(page).getByRole("button", { name: /Keep both/ })).toHaveCount(0);
  await page.keyboard.press("2");

  // Then the paragraph, as prose: their italics render.
  await expect(status(page)).toHaveText("Conflict 2 of 2 · 1 resolved");
  await expect(resolver(page).getByRole("group", { name: "Mine" })).toContainText("Twelve long years");
  await expect(resolver(page).getByRole("group", { name: "Theirs" }).locator("em")).toHaveText("Twelve years");
  await expect(resolver(page).getByRole("group", { name: "Before" })).toContainText("the only passenger who stood");
  await page.keyboard.press("3");
  await expect(status(page)).toHaveText("Conflict 2 of 2 · 2 resolved");
  await expect(resolver(page).getByRole("button", { name: "Finish" })).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+Enter");

  const text = (await resolved(page))!;
  expect(text).toMatch(/^status: final$/m);
  expect(text).toMatch(/^Twelve long years had not moved the station clock\..*\n\n\*Twelve years\* had not moved/m);
  // Their change to the ending merged without asking.
  expect(text).toContain("Then she picked up her bag.");
});

test("edits a conflict by keyboard, and moves back to change a choice", async ({ page }) => {
  await open(page);
  await page.keyboard.press("1");
  await page.keyboard.press("e");
  const box = page.getByRole("textbox", { name: "Your version" });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(/^Twelve long years/);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Twelve years, and the clock had not moved.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(resolver(page)).toBeFocused();
  await expect(status(page)).toHaveText("Conflict 2 of 2 · 2 resolved");

  await page.keyboard.press("ArrowLeft");
  await expect(status(page)).toHaveText("Conflict 1 of 2 · 2 resolved");
  await page.keyboard.press("2");
  await page.keyboard.press("ControlOrMeta+Enter");
  const text = (await resolved(page))!;
  expect(text).toMatch(/^status: final$/m);
  expect(text).toContain("\n\nTwelve years, and the clock had not moved.\n\n");
});

test("Escape leaves the conflicts for later", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Not now" })).toBeVisible();
});

test("has no accessibility violations, choosing or editing", async ({ page }) => {
  await open(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("1");
  await page.keyboard.press("e");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
