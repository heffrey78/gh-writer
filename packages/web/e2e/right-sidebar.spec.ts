import { axe, expect, test } from "./fixtures.ts";

test("the right sidebar: Scene and Entry tabs, Ctrl+Shift+\\, F6 and Escape, a strip when hidden, resized and remembered", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  const sidebar = page.getByRole("complementary", { name: "Right sidebar" });
  const sceneTab = sidebar.getByRole("tab", { name: "Scene" });
  const entryTab = sidebar.getByRole("tab", { name: "Entry" });

  // Open at first, on the scene the caret is in.
  await expect(sceneTab).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("tabpanel").getByRole("region", { name: "Details of “The Station”" })).toBeVisible();
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  // F6 into the sidebar and back to the text; the tabs by arrow keys; Escape back to the text.
  await page.keyboard.press("F6");
  await expect(sceneTab).toBeFocused();
  // Scene, then the scene's notes (#222), then Entry.
  await page.keyboard.press("ArrowRight");
  await expect(sidebar.getByRole("tab", { name: "Notes" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(entryTab).toBeFocused();
  await expect(entryTab).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("tabpanel")).toContainText("No entry open.");
  await page.keyboard.press("F6");
  await expect(text).toBeFocused();
  await page.keyboard.press("F6");
  await expect(entryTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(sceneTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(text).toBeFocused();

  // Hidden from the keyboard: the text keeps the focus, and a strip stays at the edge.
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  await expect(sceneTab).toHaveCount(0);
  await expect(text).toBeFocused();
  await expect(sidebar.getByRole("button", { name: "Show the right sidebar" })).toBeVisible();
  await axe(page);
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  await expect(sceneTab).toBeVisible();
  await expect(text).toBeFocused();

  // Hidden from its button; the strip's Entry icon opens it on that tab.
  await sidebar.getByRole("button", { name: "Hide the right sidebar" }).click();
  await sidebar.getByRole("button", { name: "Entry" }).click();
  await expect(entryTab).toHaveAttribute("aria-selected", "true");

  // Resized from the keyboard, within bounds.
  const handle = sidebar.getByRole("separator", { name: "Resize the right sidebar" });
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before + 32));
  const width = (await sidebar.boundingBox())!.width;
  expect(Math.round(width)).toBe(before + 32);
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "280");
  for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowLeft");

  // The tab, the width and whether it's open are remembered.
  await page.reload();
  await expect(text).toBeFocused();
  await expect(entryTab).toHaveAttribute("aria-selected", "true");
  await expect(handle).toHaveAttribute("aria-valuenow", "312");
  await sidebar.getByRole("button", { name: "Hide the right sidebar" }).click();
  await page.reload();
  await expect(text).toBeFocused();
  await expect(sidebar.getByRole("button", { name: "Show the right sidebar" })).toBeVisible();

  // The palette opens it on the scene's details.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("show the scene's details");
  await page.keyboard.press("Enter");
  await expect(sceneTab).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("region", { name: /^Details of/ })).toBeVisible();
});

test("on a narrow window the sidebar is a sheet over the text", async ({ page, app }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  const sidebar = page.getByRole("complementary", { name: "Right sidebar" });
  // Not over the text until asked for.
  await expect(sidebar).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  await expect(sidebar.getByRole("tab", { name: "Scene" })).toBeVisible();
  await expect(sidebar).toHaveCSS("position", "fixed");
  await axe(page);
  await expect(sidebar.getByRole("tab", { name: "Scene" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sidebar).toHaveCount(0);
  await expect(text).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+Backslash");
  // A click beside the sheet closes it.
  await page.mouse.click(20, 450);
  await expect(sidebar).toHaveCount(0);
});
