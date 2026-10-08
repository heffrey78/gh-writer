import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, launch, test } from "./fixtures.ts";

/** The books on the shelf (not the + tile). */
const novels = (page: Page) => page.getByRole("list", { name: "Novels" }).getByRole("listitem").filter({ has: page.getByRole("link") });

/** Open a book's menu, where its folder is shown. */
async function bookMenu(page: Page, title: string) {
  await page.getByRole("button", { name: `More for “${title}”` }).click();
  return page.getByRole("menu");
}

/** Add a folder through the Open a folder dialog. */
async function openFolder(page: Page, dir: string) {
  await page.getByRole("button", { name: "Open a folder" }).click();
  await page.getByRole("dialog", { name: "Open a folder" }).getByRole("textbox", { name: "Folder" }).fill(dir);
  await page.getByRole("dialog", { name: "Open a folder" }).getByRole("button", { name: "Open", exact: true }).click();
}

async function cloneFrom(page: Page, repo: string) {
  await page.getByRole("button", { name: "Clone from GitHub" }).click();
  await page.getByRole("dialog", { name: "Clone from GitHub" }).getByRole("textbox", { name: "Repository" }).fill(repo);
  await page.getByRole("dialog", { name: "Clone from GitHub" }).getByRole("button", { name: "Clone", exact: true }).click();
}

test("the launch URL opens the app and trades its token for a session", async ({ page, app }) => {
  await launch(page, app);
  await expect(page).toHaveURL(`${app.url}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Your novels" })).toBeVisible();
  await expect(page.getByText("No novels yet")).toBeVisible();
  await expect(page.getByRole("list", { name: "Novels" }).getByRole("button", { name: "New novel" })).toBeVisible();
  // Without the session, nothing answers.
  const other = await page.context().browser()!.newContext();
  expect((await (await other.newPage()).goto(app.url))!.status()).toBe(403);
  await other.close();
});

test("opens a folder by keyboard alone, then shelves it", async ({ page, app }) => {
  const dir = app.novelRepo("the-bridge");
  await launch(page, app);
  await page.getByRole("button", { name: "Open a folder" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Open a folder" }).getByRole("textbox", { name: "Folder" })).toBeFocused();
  await page.keyboard.type(dir);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/novels\/lib_\w+$/);
  await expect(page).toHaveTitle("The Bridge at Varn · gh-writer");

  await page.getByRole("link", { name: "gh-writer" }).click();
  await expect(novels(page)).toHaveCount(1);
  await expect(novels(page).getByRole("link", { name: "The Bridge at Varn, by gh-writer sample" })).toBeVisible();
  await expect(novels(page)).toContainText("Not on GitHub yet");
  await expect(await bookMenu(page, "The Bridge at Varn")).toContainText(dir);
  await page.keyboard.press("Escape");

  // The cover opens the novel.
  await novels(page).getByRole("link").click();
  await expect(page).toHaveTitle("The Bridge at Varn · gh-writer");
});

test("a novel keeps its cover, and different novels get different ones", async ({ page, app }) => {
  await launch(page, app);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const r = await page.request.post(`${app.url}/api/library/new`, { data: { title: `Book ${n}` }, headers: { origin: app.url } });
    expect(r.status()).toBe(201);
  }
  await page.reload();
  await expect(novels(page)).toHaveCount(6);
  // Each book's title and cover colour, in shelf order.
  const looks = () => novels(page).getByRole("link").evaluateAll((links) => links.map((a) => [a.getAttribute("aria-label"), getComputedStyle(a.firstElementChild!).backgroundColor]));
  const before = await looks();
  expect(new Set(before.map(([, colour]) => colour)).size).toBeGreaterThan(1);
  await page.reload();
  await expect(novels(page)).toHaveCount(6);
  expect(await looks()).toEqual(before);
  await axe(page);
});

test("explains a folder that isn't a novel", async ({ page, app }) => {
  const empty = join(app.home, "empty");
  mkdirSync(empty);
  await launch(page, app);
  await openFolder(page, empty);
  await expect(page.getByRole("alert")).toContainText("Couldn't open that folder");
  await expect(page.getByRole("alert")).toContainText("isn't a git repository");
});

test("clones from a repository and opens the novel", async ({ page, app }) => {
  const bare = app.bareRepo("varn.git");
  await launch(page, app);
  await cloneFrom(page, `file://${bare}`);
  await expect(page).toHaveTitle("The Bridge at Varn · gh-writer");
  await page.goto(app.url);
  await expect(novels(page)).toContainText(bare);
  await expect(await bookMenu(page, "The Bridge at Varn")).toContainText(join(app.home, "gh-writer", "varn"));
});

test("says what to do when GitHub refuses the credentials", async ({ page, app }) => {
  const remote = createHttpServer((_req, res) => res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end());
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  try {
    await app.restart();
    await launch(page, app);
    await cloneFrom(page, `http://127.0.0.1:${(remote.address() as AddressInfo).port}/writer/novel.git`);
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
  await openFolder(page, dir);
  await expect(page).toHaveURL(/\/novels\//);
  await page.goto(app.url);
  await page.getByRole("button", { name: "More for “The Bridge at Varn”" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Remove from library…" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Its folder and files stay where they are");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(novels(page)).toHaveCount(1);
  await (await bookMenu(page, "The Bridge at Varn")).getByRole("menuitem", { name: "Remove from library…" }).click();
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
  await openFolder(page, app.novelRepo());
  await expect(page).toHaveURL(/\/novels\//);
  await axe(page);
  await page.goto(app.url);
  await expect(novels(page)).toHaveCount(1);
  await axe(page);
  await bookMenu(page, "The Bridge at Varn");
  await axe(page);
  await page.keyboard.press("Escape");
  for (const dialog of ["Open a folder", "Clone from GitHub", "New novel"]) {
    await page.getByRole("button", { name: dialog }).first().click();
    await expect(page.getByRole("dialog", { name: dialog })).toBeVisible();
    await axe(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});
