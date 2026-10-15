import { axe, expect, test } from "./fixtures.ts";

test("the Entry tab: a sheet to read, Back and Forward through names opened, a pin to keep it, the form in place", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const sidebar = page.getByRole("complementary", { name: "Right sidebar" });
  const sceneTab = sidebar.getByRole("tab", { name: "Scene" });
  const entryTab = sidebar.getByRole("tab", { name: "Entry" });
  const station = sidebar.getByRole("region", { name: "Details of “The Station”" });

  // A name on the Scene tab opens its sheet.
  await station.getByRole("button", { name: "Ada Varn" }).first().click();
  const ada = sidebar.getByRole("region", { name: "Ada Varn" });
  await expect(ada).toBeFocused();
  await expect(entryTab).toHaveAttribute("aria-selected", "true");
  await expect(ada.getByText("Character", { exact: true })).toBeVisible();
  await expect(ada.getByRole("region", { name: "At “The Station”" })).toBeVisible();
  // The profile at the sidebar's size: its strip, and its arcs read at the caret's scene.
  const strip = ada.getByRole("region", { name: "In the story" }).getByRole("list", { name: "Scenes, in reading order" });
  await expect(strip.getByRole("link", { name: "The Station: point of view" })).toBeVisible();
  await expect(ada.getByRole("region", { name: "Relationships" }).getByRole("list", { name: "All relationships" })).toBeVisible();
  await expect(ada.getByRole("region", { name: "Notes", exact: true })).toContainText("Voice: short sentences when she is angry");
  await expect(ada.getByRole("link", { name: "Open the full entry" })).toBeVisible();
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  // Another, then Back and Forward.
  await sceneTab.click();
  await station.getByRole("button", { name: "Varn Station" }).click();
  const place = sidebar.getByRole("region", { name: "Varn Station" });
  await expect(place).toBeFocused();
  await place.getByRole("button", { name: "Back" }).click();
  await expect(ada).toBeVisible();
  await expect(ada.getByRole("button", { name: "Back" })).toBeDisabled();
  await ada.getByRole("button", { name: "Forward" }).click();
  await expect(place).toBeVisible();

  // Kept: a name opened elsewhere says so instead of replacing it.
  await place.getByRole("button", { name: "Keep this entry here" }).click();
  await expect(place.getByRole("button", { name: "Keep this entry here" })).toHaveAttribute("aria-pressed", "true");
  await sceneTab.click();
  await station.getByRole("button", { name: "Ada Varn" }).first().click();
  const notice = page.getByRole("status").filter({ hasText: "The Entry tab is pinned to another entry." });
  await expect(notice).toBeVisible();
  await entryTab.click();
  await expect(place).toBeVisible();
  await notice.getByRole("button", { name: "Unpin and open" }).click();
  await expect(ada).toBeFocused();
  await expect(ada.getByRole("button", { name: "Keep this entry here" })).toHaveAttribute("aria-pressed", "false");

  // Edited in place, as on its page.
  await ada.getByRole("button", { name: "Edit occupation" }).click();
  await expect(ada.getByRole("textbox", { name: "Field name" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ada.getByRole("button", { name: "Edit occupation" })).toBeFocused();
  await expect(ada.getByRole("heading", { level: 2, name: "Ada Varn" })).toBeVisible();

  // A scene it's in opens.
  await strip.getByRole("link", { name: "The Betrayal: point of view" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "The Betrayal" })).toBeVisible();
  await expect(ada.getByRole("region", { name: "At “The Betrayal”" })).toContainText("Rivals with Ben Varn");
});
