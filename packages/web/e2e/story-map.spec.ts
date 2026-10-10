import { axe, expect, test } from "./fixtures.ts";

test("the story map's views are tabs, each at its own address, moved between with the arrow keys", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const novel = new URL(page.url()).pathname.split("/")[2];

  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Story map" }).click();
  await expect(page).toHaveURL(new RegExp(`/novels/${novel}/story-map/plotlines$`));
  await expect(page.getByRole("heading", { level: 1, name: "Story map" })).toBeVisible();
  const plotlines = page.getByRole("tab", { name: "Plotlines" });
  await expect(plotlines).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Plotlines" }).getByRole("heading", { name: "Plotlines" })).toBeAttached();
  await axe(page);

  await plotlines.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Presence" })).toBeFocused();
  await expect(page).toHaveURL(/\/story-map\/presence$/);
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Timeline" })).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Timeline" })).toContainText("The Station");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Plotlines" })).toBeFocused();

  // Straight to a tab by its address.
  await page.goto(page.url().replace(/plotlines$/, "presence"));
  await expect(page.getByRole("tab", { name: "Presence" })).toHaveAttribute("aria-selected", "true");
  await page.goto(page.url().replace(/presence$/, "nonsense"));
  await expect(page).toHaveURL(/\/story-map\/plotlines$/);
});
