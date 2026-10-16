import { axe, expect, test } from "./fixtures.ts";

test("the sidebar groups the views, collapses to a strip of icons with Ctrl+\\, and remembers it", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const views = page.getByRole("navigation", { name: "Views" });

  await expect(sidebar.getByRole("heading", { name: "Write" })).toBeVisible();
  await expect(sidebar.getByRole("tree", { name: "Manuscript" })).toBeVisible();
  // Write is the manuscript alone (#232): events and notes are in their galleries.
  await expect(sidebar.getByRole("region", { name: /Off the page|Notes/ })).toHaveCount(0);
  await expect(views.getByRole("group")).toHaveCount(2);
  for (const [group, places] of [
    ["Plan", ["Outline", "Story map", "Relationships", "Notes", "Progress", "Story bible"]],
    ["Revise", ["Compare"]],
  ] as const) {
    await expect(views.getByRole("group", { name: group }).getByRole("link")).toHaveText([...places]);
  }
  await axe(page);

  // Collapsed from the keyboard, with the caret in the text: the text keeps the focus.
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(sidebar.getByRole("tree")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await expect(views.getByRole("link")).toHaveText(["", "", "", "", "", "", "", ""]);
  await expect(views.getByRole("link", { name: "Relationships" })).toHaveAttribute("title", "Relationships");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  await page.reload();
  await expect(sidebar.getByRole("button", { name: "Expand the sidebar" })).toBeVisible();
  // The text takes the focus once loaded: wait for it, or it would take it back from the strip.
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
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

test("too narrow for it beside the text, the sidebar is a strip that opens over the text, and the top bar fits", async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();
  const views = page.getByRole("navigation", { name: "Views" });
  // The strip, beside the text: nothing drawn over it.
  await expect(page.getByRole("tree", { name: "Manuscript" })).toHaveCount(0);
  const text = await page.getByRole("textbox", { name: "Chapter text" }).boundingBox();
  const strip = await views.boundingBox();
  expect(strip!.x + strip!.width).toBeLessThanOrEqual(text!.x);
  // The top bar's labels give way; their names stay.
  await expect(page.getByRole("button", { name: "Drafts: Main version is open" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sync: / })).toBeVisible();
  const bar = await page.getByRole("banner").boundingBox();
  expect(bar!.height).toBeLessThan(60);
  await axe(page);

  // Opened, over the text with the focus in it; Escape closes it, and so does going somewhere.
  await page.getByRole("button", { name: "Expand the sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "The sidebar" });
  await expect(drawer.getByRole("tree", { name: "Manuscript" })).toBeVisible();
  await expect(drawer.locator(":focus")).toHaveCount(1);
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tree", { name: "Manuscript" })).toHaveCount(0);
  await page.getByRole("button", { name: "Expand the sidebar" }).click();
  await drawer.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Story bible" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Manuscript" })).toHaveCount(0);
});
