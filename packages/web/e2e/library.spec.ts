import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, launch, test } from "./fixtures.ts";

const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
const novels = (page: Page) => page.getByRole("region", { name: "Novels" }).getByRole("listitem");

test("the launch URL opens the app and trades its token for a session", async ({ page, app }) => {
  await launch(page, app);
  await expect(page).toHaveURL(`${app.url}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Your novels" })).toBeVisible();
  await expect(page.getByText("No novels yet")).toBeVisible();
  // Without the session, nothing answers.
  const other = await page.context().browser()!.newContext();
  expect((await (await other.newPage()).goto(app.url))!.status()).toBe(403);
  await other.close();
});

test("opens a folder by keyboard alone, then lists it", async ({ page, app }) => {
  const dir = app.novelRepo("the-bridge");
  await launch(page, app);
  await page.getByRole("textbox", { name: "Folder", exact: true }).focus();
  await page.keyboard.type(dir);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/novels\/lib_\w+$/);
  await expect(page).toHaveTitle("The Bridge at Varn · gh-writer");

  await page.getByRole("link", { name: "gh-writer" }).click();
  await expect(novels(page)).toHaveCount(1);
  await expect(novels(page)).toContainText("The Bridge at Varn");
  await expect(novels(page)).toContainText(dir);
  await expect(novels(page)).toContainText("Not on GitHub yet");
});

test("explains a folder that isn't a novel", async ({ page, app }) => {
  const empty = join(app.home, "empty");
  mkdirSync(empty);
  await launch(page, app);
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(empty);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't open that folder");
  await expect(page.getByRole("alert")).toContainText("isn't a git repository");
});

test("clones from a repository and opens the novel", async ({ page, app }) => {
  const bare = app.bareRepo("varn.git");
  await launch(page, app);
  await page.getByRole("textbox", { name: "Repository" }).fill(`file://${bare}`);
  await page.getByRole("button", { name: "Clone" }).click();
  await expect(page).toHaveTitle("The Bridge at Varn · gh-writer");
  await page.goto(app.url);
  await expect(novels(page)).toContainText(join(app.home, "gh-writer", "varn"));
  await expect(novels(page)).toContainText(bare);
});

test("says what to do when GitHub refuses the credentials", async ({ page, app }) => {
  const remote = createHttpServer((_req, res) => res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end());
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  try {
    await app.restart();
    await launch(page, app);
    await page.getByRole("textbox", { name: "Repository" }).fill(`http://127.0.0.1:${(remote.address() as AddressInfo).port}/writer/novel.git`);
    await page.getByRole("button", { name: "Clone" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Couldn't clone that repository");
    await expect(alert).toContainText("gh auth setup-git");
    await alert.getByText("Details").click();
    await expect(alert.locator("pre")).toContainText(/401|Authentication|terminal prompts disabled/);
    await axe(page);
  } finally {
    remote.close();
  }
});

test("shows a notice for a novel whose folder has gone, and can dismiss it", async ({ page, app }) => {
  mkdirSync(join(app.home, "config"), { recursive: true });
  const gone = join(app.home, "novels", "gone");
  writeFileSync(
    join(app.home, "config", "library.json"),
    JSON.stringify({ version: 1, novels: [{ id: "lib_g0n3g0", path: gone, title: "Gone Novel", lastOpened: new Date().toISOString() }] }),
  );
  await app.restart();
  await launch(page, app);
  const notices = page.getByRole("list", { name: "Notices" });
  await expect(notices).toContainText(gone);
  await notices.getByRole("button", { name: /^Dismiss/ }).click();
  await expect(notices).toHaveCount(0);
});

test("removes a novel from the library after confirming, keeping its folder", async ({ page, app }) => {
  const dir = app.novelRepo();
  await launch(page, app);
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(dir);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/novels\//);
  await page.goto(app.url);
  await page.getByRole("button", { name: "Remove “The Bridge at Varn” from the library" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Its folder and files stay where they are");
  await page.keyboard.press("Escape");
  await expect(novels(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Remove “The Bridge at Varn” from the library" }).click();
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No novels yet")).toBeVisible();
  expect(app.git(dir, "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
});

test("follows the OS theme, and remembers a chosen one", async ({ page, app }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await launch(page, app);
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe("rgb(27, 26, 24)");
  await page.getByRole("combobox", { name: "Theme" }).selectOption("light");
  expect(await background()).toBe("rgb(250, 248, 244)");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue("light");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
});

test("unknown pages say so", async ({ page, app }) => {
  await launch(page, app, "/no/such/page");
  await expect(page.getByRole("heading", { name: "Nothing here" })).toBeVisible();
  await page.getByRole("link", { name: "Back to your novels" }).click();
  await expect(page.getByRole("heading", { name: "Your novels" })).toBeVisible();
});

test("has no accessibility violations, empty or with novels, light or dark", async ({ page, app }) => {
  await launch(page, app);
  await axe(page);
  await page.getByRole("textbox", { name: "Folder", exact: true }).fill(app.novelRepo());
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/novels\//);
  await axe(page);
  await page.goto(app.url);
  await expect(novels(page)).toHaveCount(1);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});
