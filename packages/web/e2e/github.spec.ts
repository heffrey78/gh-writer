import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, launch, test, type App } from "./fixtures.ts";

const connectButton = (page: Page) => page.getByRole("banner").getByRole("button", { name: /Connect GitHub/ });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Connect to GitHub" });
const badge = (page: Page) => page.getByRole("button", { name: /^Sync: / });

/** ada/varn on the fake GitHub: the sample novel. */
function githubRepo(app: App): string {
  const seed = app.novelRepo("seed-varn");
  mkdirSync(join(app.home, "github", "ada"), { recursive: true });
  app.git(app.home, "clone", "-q", "--bare", seed, app.github.repoPath("ada", "varn"));
  return `${app.github.url}/ada/varn.git`;
}

/** Sign in with the code, as the author would on github.com. */
async function signInWithCode(page: Page, app: App) {
  await dialog(page).getByRole("button", { name: "Sign in with a code" }).click();
  await expect(dialog(page).getByLabel("Your code")).toHaveText(app.github.userCode);
  app.github.approve();
  await expect(dialog(page)).toHaveCount(0);
}

/** Every file under `dir`, read, for looking for the token. */
const contents = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name)));

test("connects with a code entered on GitHub, shows the account, and signs out", async ({ page, app }) => {
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/")) bodies.push(await r.text().catch(() => ""));
  });
  await launch(page, app);
  await connectButton(page).click();
  await expect(dialog(page)).toContainText("kept in this computer's keychain");
  await axe(page);

  await dialog(page).getByRole("button", { name: "Sign in with a code" }).click();
  await expect(dialog(page).getByLabel("Your code")).toHaveText(app.github.userCode);
  await expect(dialog(page).getByRole("link", { name: /Open .*\/login\/device/ })).toHaveAttribute("href", `${app.github.url}/login/device`);
  await expect(dialog(page)).toContainText("Waiting for you to enter the code");
  await axe(page);
  app.github.approve();
  await expect(dialog(page)).toHaveCount(0);

  const account = page.getByRole("button", { name: "GitHub account: ada" });
  await expect(account).toBeVisible();
  await account.click();
  await expect(page.getByRole("menu")).toContainText("Signed in to GitHub as ada");
  await axe(page);
  await page.getByRole("menuitem", { name: "Sign out of GitHub" }).click();
  await expect(connectButton(page)).toBeVisible();

  // The token never reached the browser.
  expect(bodies.filter((b) => b.includes(app.github.deviceToken))).toEqual([]);
});

test("offers gh's account when the gh CLI is signed in", async ({ page, app }) => {
  const bin = join(app.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\n[ \"$1 $2\" = 'auth token' ] && echo gho_from_gh && exit 0\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  app.github.users.set("gho_from_gh", { login: "ada-cli" });
  app.env.PATH = `${bin}${delimiter}${app.env.PATH}`;
  await app.restart();

  await launch(page, app);
  await connectButton(page).click();
  await dialog(page).getByRole("button", { name: "Use gh's account (ada-cli)" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "GitHub account: ada-cli" })).toBeVisible();
});

test("a clone GitHub refuses offers to connect, then clones and syncs with the connection", async ({ page, app }) => {
  const url = githubRepo(app);
  await launch(page, app);
  await page.getByRole("button", { name: "Clone from GitHub" }).click();
  const clone = page.getByRole("dialog", { name: "Clone from GitHub" });
  await clone.getByRole("textbox", { name: "Repository" }).fill(url);
  await clone.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(clone.getByRole("alert")).toContainText("Connect gh-writer to GitHub");

  await clone.getByRole("button", { name: "Connect GitHub and try again" }).click();
  await signInWithCode(page, app);
  await expect(page).toHaveTitle("The Bridge at Varn · gh-writer");
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");

  // Written here, pushed with the connection.
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await text.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Pushed with the sign-in.");
  await badge(page).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sync now" }).click();
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");
  await expect.poll(() => app.git(app.github.repoPath("ada", "varn"), "log", "-1", "--format=%s")).not.toContain("Start");

  // No token anywhere on disk: not in the novel's git config, not in the library.
  const here = join(app.home, "gh-writer", "varn");
  for (const file of [...contents(join(here, ".git")), ...contents(join(app.home, "config"))]) expect(file.includes(app.github.deviceToken)).toBe(false);
});

test("when GitHub stops accepting the sign-in, sync says so and reconnecting resumes it", async ({ page, app }) => {
  const url = githubRepo(app);
  await launch(page, app);
  await connectButton(page).click();
  await signInWithCode(page, app);
  await page.getByRole("button", { name: "Clone from GitHub" }).click();
  await page.getByRole("dialog", { name: "Clone from GitHub" }).getByRole("textbox", { name: "Repository" }).fill(url);
  await page.getByRole("dialog", { name: "Clone from GitHub" }).getByRole("button", { name: "Clone", exact: true }).click();
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");

  app.github.revoke(app.github.deviceToken);
  await badge(page).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sync now" }).click();
  await expect(badge(page)).toHaveAccessibleName("Sync: Sign-in needed");
  await expect(page.getByRole("dialog")).toContainText("Connect to GitHub again");
  // Once: the account control now offers to reconnect, rather than failing again and again.
  await page.reload();
  await expect(page.getByRole("banner").getByRole("button", { name: "Reconnect GitHub" })).toBeVisible();

  await badge(page).click();
  await page.getByRole("dialog").getByRole("button", { name: "Connect GitHub…" }).click();
  await signInWithCode(page, app);
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");
  await expect(page.getByRole("button", { name: "GitHub account: ada" })).toBeVisible();
  await axe(page);
});

/** Start a novel through the API: local only, no remote. */
async function newNovel(page: Page, app: App, title: string) {
  const r = await page.request.post(`${app.url}/api/library/new`, { data: { title }, headers: { origin: app.url } });
  expect(r.status()).toBe(201);
  return ((await r.json()) as { novel: { id: string; path: string } }).novel;
}

test("signed out, puts a new novel on GitHub from the shelf: connects, creates a private repository, and pushes", async ({ page, app }) => {
  await launch(page, app);
  await newNovel(page, app, "The Salt Road");
  await page.reload();
  await page.getByRole("button", { name: "More for “The Salt Road”" }).click();
  await page.getByRole("menuitem", { name: "Put on GitHub…" }).click();
  const publish = page.getByRole("dialog", { name: "Put on GitHub" });
  await expect(publish).toContainText("Connect gh-writer to GitHub first");
  await publish.getByRole("button", { name: "Connect GitHub" }).click();
  await signInWithCode(page, app);

  // Back to publishing, now signed in.
  await expect(publish.getByRole("textbox", { name: "Repository name" })).toHaveValue("the-salt-road");
  await expect(publish).toContainText("github.com/ada/the-salt-road");
  await expect(publish.getByRole("checkbox", { name: /Private/ })).toBeChecked();
  await axe(page);
  await publish.getByRole("button", { name: "Create and push" }).click();
  await expect(publish).toHaveCount(0);

  expect(app.github.repos.find((r) => r.name === "the-salt-road")?.private).toBe(true);
  expect(app.git(app.github.repoPath("ada", "the-salt-road"), "log", "--format=%s", "main").trim()).toBe("Start The Salt Road");
  await expect(page.getByRole("list", { name: "Novels" })).toContainText(`${app.github.url}/ada/the-salt-road.git`);
});

test("puts a novel on GitHub from its sync badge, then syncs with it", async ({ page, app }) => {
  await launch(page, app);
  await connectButton(page).click();
  await signInWithCode(page, app);
  const novel = await newNovel(page, app, "Night Ferry");
  await page.goto(`${app.url}/novels/${novel.id}`);
  await expect(badge(page)).toHaveAccessibleName("Sync: Local only");
  await badge(page).click();
  await page.getByRole("dialog").getByRole("button", { name: "Put on GitHub…" }).click();
  const publish = page.getByRole("dialog", { name: "Put on GitHub" });
  await publish.getByRole("textbox", { name: "Repository name" }).fill("ferry");
  await publish.getByRole("checkbox", { name: /Private/ }).uncheck();
  await publish.getByRole("button", { name: "Create and push" }).click();
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced");
  expect(app.github.repos.find((r) => r.name === "ferry")?.private).toBe(false);

  // A name that's taken says so, in the dialog.
  const other = await newNovel(page, app, "Second Ferry");
  await page.goto(`${app.url}/novels/${other.id}`);
  await badge(page).click();
  await page.getByRole("dialog").getByRole("button", { name: "Put on GitHub…" }).click();
  await publish.getByRole("textbox", { name: "Repository name" }).fill("ferry");
  await publish.getByRole("button", { name: "Create and push" }).click();
  await expect(publish.getByRole("alert")).toContainText("You already have a repository called “ferry”");
});

test("clones by picking from the author's repositories", async ({ page, app }) => {
  githubRepo(app);
  app.github.repos.push(
    { owner: "ada", name: "varn", private: true, description: "The Bridge at Varn", pushedAt: "2026-10-01T00:00:00Z" },
    { owner: "ada", name: "dotfiles", private: false, pushedAt: "2026-09-01T00:00:00Z" },
  );
  await launch(page, app);
  await page.getByRole("button", { name: "Clone from GitHub" }).click();
  const clone = page.getByRole("dialog", { name: "Clone from GitHub" });
  await expect(clone).toContainText("Connect GitHub to pick from your repositories");
  await clone.getByRole("button", { name: "Connect GitHub" }).click();
  await signInWithCode(page, app);

  const list = clone.getByRole("list", { name: "Your repositories" });
  await expect(list.getByRole("button")).toHaveCount(2);
  await expect(list.getByRole("button").first()).toContainText("ada/varn");
  await clone.getByRole("searchbox", { name: "Filter your repositories" }).fill("bridge");
  await expect(list.getByRole("button")).toHaveCount(1);
  await axe(page);
  await list.getByRole("button", { name: /ada\/varn/ }).click();
  await expect(clone.getByRole("textbox", { name: "Repository" })).toHaveValue(`${app.github.url}/ada/varn.git`);
  await clone.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(page).toHaveTitle("The Bridge at Varn · gh-writer");
});
