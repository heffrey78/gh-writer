import { axe, expect, test } from "./fixtures.ts";

test("the sidebar groups the views, collapses to a strip of icons with Ctrl+\\, and remembers it", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const views = page.getByRole("navigation", { name: "Views" });

  await expect(sidebar.getByRole("heading", { name: "Write" })).toBeVisible();
  await expect(sidebar.getByRole("tree", { name: "Manuscript" })).toBeVisible();
  for (const [group, places] of [
    ["Plan", ["Outline", "Story map"]],
    ["World", ["Story bible", "Relationships"]],
    ["Revise", ["Compare"]],
  ] as const) {
    await expect(views.getByRole("group", { name: group }).getByRole("link")).toHaveText([...places]);
  }
  await axe(page);

  // Collapsed from the keyboard, with the caret in the text: the text keeps the focus.
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(sidebar.getByRole("tree")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await expect(views.getByRole("link")).toHaveText(["", "", "", "", "", ""]);
  await expect(views.getByRole("link", { name: "Relationships" })).toHaveAttribute("title", "Relationships");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  await page.reload();
  await expect(sidebar.getByRole("button", { name: "Expand the sidebar" })).toBeVisible();
  // Every place by keyboard from the strip.
  await sidebar.getByRole("button", { name: "Expand the sidebar" }).focus();
  await page.keyboard.press("Tab");
  await expect(views.getByRole("link", { name: "Manuscript" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(views.getByRole("link", { name: "Story map" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Story map" })).toBeVisible();
  await expect(views.getByRole("link", { name: "Story map" })).toHaveAttribute("aria-current", "page");

  await sidebar.getByRole("button", { name: "Expand the sidebar" }).click();
  await expect(sidebar.getByRole("tree", { name: "Manuscript" })).toBeVisible();
  await expect(views.getByRole("group", { name: "Plan" }).getByRole("link", { name: "Story map" })).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(sidebar.getByRole("button", { name: "Collapse the sidebar" })).toBeVisible();
});
