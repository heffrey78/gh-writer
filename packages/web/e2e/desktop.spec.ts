import { asDesktop, calls, expect, launch, test } from "./fixtures.ts";

/**
 * The page's side of the desktop app (#191), with a stand-in for the shell: what the page asks it for
 * (a folder, a novel's window, the library) and the commands it runs for it. The shell itself is
 * checked by its own tests and on the built app.
 */

test("a novel opens in its own window, the library comes forward from a novel, and the shell hears of recent novels", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await asDesktop(page);
  await launch(page, app);
  await page.goto(`${app.url}/`);
  await expect(page.getByRole("heading", { name: "Your novels" })).toBeVisible();
  await expect.poll(() => calls(page, "set_recent")).toContainEqual({ novels: [{ id: expect.stringMatching(/^lib_/), title: "The Bridge at Varn" }] });

  await page.getByRole("link", { name: /The Bridge at Varn/ }).click();
  await expect.poll(() => calls(page, "open_novel")).toEqual([{ id: expect.stringMatching(/^lib_/) }]);
  // The library stays: the novel went to a window of its own.
  await expect(page.getByRole("heading", { name: "Your novels" })).toBeVisible();

  const [{ id }] = (await calls(page, "open_novel")) as [{ id: string }];
  await page.goto(`${app.url}/novels/${id}`);
  await page.getByRole("link", { name: "gh-writer: your novels" }).click();
  await expect.poll(() => calls(page, "show_library")).toEqual([{ path: "/" }]);
  await expect(page).toHaveURL(new RegExp(`/novels/${id}`));
});

test("Choose… fills a folder field from the system's dialog", async ({ page, app }) => {
  const folder = app.novelRepo("chosen");
  await asDesktop(page, { folder });
  await launch(page, app);
  await page.getByRole("button", { name: "Open a folder" }).click();
  const dialog = page.getByRole("dialog", { name: "Open a folder" });
  await dialog.getByRole("button", { name: "Choose…" }).click();
  await expect(dialog.getByLabel("Folder")).toHaveValue(folder);
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect.poll(() => calls(page, "open_novel")).toHaveLength(1);
  await expect(dialog).toHaveCount(0);
});

test("a folder from the shell (dropped on the library, or passed to the app) opens at once, or says why it can't", async ({ page, app }) => {
  const folder = app.novelRepo("dropped");
  await asDesktop(page, { pending: [{ name: "go", arg: `/?add=open&path=${encodeURIComponent(folder)}` }] });
  await launch(page, app);
  await expect.poll(() => calls(page, "open_novel")).toHaveLength(1);

  await asDesktop(page, { pending: [{ name: "go", arg: `/?add=open&path=${encodeURIComponent(app.home)}` }] });
  await launch(page, app);
  await expect(page.getByRole("dialog", { name: "Open a folder" }).getByRole("alert")).toContainText("Couldn't open that folder");
});

test("the shell's About opens About gh-writer; in a browser there's no Choose…", async ({ page, app }) => {
  await asDesktop(page, { pending: [{ name: "about" }] });
  await launch(page, app);
  await expect(page.getByRole("dialog", { name: "About gh-writer" })).toBeVisible();

  const browser = await page.context().newPage();
  await launch(browser, app);
  await browser.goto(`${app.url}/?add=open`);
  await expect(browser.getByRole("dialog", { name: "Open a folder" })).toBeVisible();
  await expect(browser.getByRole("button", { name: "Choose…" })).toHaveCount(0);
});

test("in the desktop app, the mouse's back and forward buttons go back and forward (#224)", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await asDesktop(page);
  await launch(page, app);
  await page.goto(`${app.url}/`);
  await page.getByRole("link", { name: /The Bridge at Varn/ }).click();
  const [{ id }] = (await calls(page, "open_novel")) as [{ id: string }];
  await page.goto(`${app.url}/novels/${id}`);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("character: ada");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ada Varn" })).toBeVisible();

  const press = (button: number) => page.evaluate((b) => window.dispatchEvent(new MouseEvent("mouseup", { button: b, cancelable: true })), button);
  await press(3);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeVisible();
  await press(4);
  await expect(page.getByRole("heading", { level: 1, name: "Ada Varn" })).toBeVisible();
});
