import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, openView, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const panel = (page: Page) => page.getByRole("region", { name: "Board on GitHub" });
const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** The sample novel on the (fake) GitHub as ada/varn, signed in, open on the board. */
async function open(page: Page, app: App, { project = true } = {}) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const id = new URL(page.url()).pathname.split("/")[2]!;
  const headers = { origin: app.url };
  expect((await page.request.post(`${app.url}/api/github/device`, { headers })).ok()).toBe(true);
  app.github.approve();
  await expect.poll(async () => ((await (await page.request.post(`${app.url}/api/github/device/poll`, { headers })).json()) as { status: string }).status).toBe("done");
  if (!project) {
    const user = app.github.users.get(app.github.deviceToken)!;
    user.scopes = (user.scopes ?? []).filter((s) => s !== "project");
  }
  const r = await page.request.post(`${app.url}/api/novels/${id}/publish`, { data: { name: "varn" }, headers });
  expect(r.ok(), await r.text()).toBe(true);
  await page.reload();
  await openView(page, "Board");
  return { read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

const board = (app: App) => app.github.projects.all.find((p) => p.repositories.includes("ada/varn"))!;
const setOnGitHub = (app: App, scene: string, status: string) => {
  const p = board(app);
  app.github.projects.set(p, app.github.projects.find(p, "Scene ID", scene)!, "Status", status);
};

test("a local novel's board has no GitHub panel", async ({ page, app }) => {
  await app.restart(app.novelRepo("local"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await openView(page, "Board");
  await expect(column(page, "Drafted")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
});

test("puts the board on GitHub, and a card moved there reaches the scene at the next sync", async ({ page, app }) => {
  const novel = await open(page, app);
  await expect(panel(page)).toContainText("Put this board on GitHub as a project");
  await axe(page);
  await panel(page).getByRole("button", { name: "Put this board on GitHub" }).click();
  await expect(panel(page).getByRole("link", { name: /The Bridge at Varn: drafting board/ })).toHaveAttribute("href", /\/users\/ada\/projects\/1$/);
  // The project shows as soon as it's made; its cards come with the first sync.
  await expect(panel(page)).toContainText(/Synced /);
  expect(board(app).items).toHaveLength(8);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  setOnGitHub(app, "sc_5tat1n", "Final");
  await panel(page).getByRole("button", { name: "Sync board now" }).click();
  await expect(panel(page)).toContainText("From GitHub: “The Station” to Final.");
  await expect(column(page, "Final").getByRole("listitem", { name: "The Station" })).toBeVisible();
  expect(novel.read(STATION)).toMatch(/^status: final$/m);
});

test("a status changed both here and on GitHub waits for the author to choose", async ({ page, app }) => {
  const novel = await open(page, app);
  await panel(page).getByRole("button", { name: "Put this board on GitHub" }).click();
  await expect(panel(page)).toContainText(/Synced /);

  await page.getByRole("button", { name: "Move “The Station”, Drafted" }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(() => novel.read(STATION)).toMatch(/^status: revised$/m);
  setOnGitHub(app, "sc_5tat1n", "Idea");
  await panel(page).getByRole("button", { name: "Sync board now" }).click();

  const alert = panel(page).getByRole("alert");
  await expect(alert).toContainText("“The Station” is Revised here and Idea on GitHub.");
  await expect(column(page, "Revised").getByRole("listitem", { name: "The Station" })).toContainText("Idea on GitHub");
  expect(novel.read(STATION)).toMatch(/^status: revised$/m);
  await axe(page);

  await alert.getByRole("button", { name: "Use GitHub's Idea for “The Station”" }).click();
  await expect(alert).toHaveCount(0);
  await expect.poll(() => novel.read(STATION)).toMatch(/^status: idea$/m);
  await expect(column(page, "Idea").getByRole("listitem", { name: "The Station" })).toBeVisible();
});

test("a board deleted on GitHub is said to be, and can be made again", async ({ page, app }) => {
  await open(page, app);
  await panel(page).getByRole("button", { name: "Put this board on GitHub" }).click();
  await expect(panel(page)).toContainText(/Synced /);
  app.github.projects.remove(board(app));
  await panel(page).getByRole("button", { name: "Sync board now" }).click();
  await expect(panel(page)).toContainText("The board on GitHub has been deleted. Nothing in the novel was lost");
  await panel(page).getByRole("button", { name: "Make a new board on GitHub" }).click();
  await expect(panel(page)).toContainText(/Synced /);
  expect(board(app).items).toHaveLength(8);
});

test("a sign-in without Projects is told to reconnect", async ({ page, app }) => {
  await open(page, app, { project: false });
  await panel(page).getByRole("button", { name: "Put this board on GitHub" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("doesn't allow gh-writer to use Projects");
});
