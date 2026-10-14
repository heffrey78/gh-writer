import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, launch, test, type App } from "./fixtures.ts";

/** Your name and email for git (#186): offered from the GitHub account at first run, and changed from the ⋯ menu. */

async function signIn(page: Page, app: App) {
  const headers = { origin: app.url };
  expect((await page.request.post(`${app.url}/api/github/device`, { headers })).ok()).toBe(true);
  app.github.approve();
  await expect.poll(async () => ((await (await page.request.post(`${app.url}/api/github/device/poll`, { headers })).json()) as { status: string }).status).toBe("done");
}

const gitconfig = (app: App) => join(app.home, ".gitconfig");

test("at first run, signed in and unknown to git: asked once, with the account's name and noreply address", async ({ page, app }) => {
  writeFileSync(gitconfig(app), "[init]\n\tdefaultBranch = main\n");
  // Signed out when the first page asks, so it has nothing to offer; asked as the sign-in finishes, it could be answered with it.
  const signedOut = page.waitForResponse((r) => r.url().endsWith("/api/identity"));
  await launch(page, app);
  await signedOut;
  await signIn(page, app);
  await page.reload();

  const dialog = page.getByRole("dialog", { name: "Your name and email" });
  await expect(dialog.getByLabel("Name")).toHaveValue("Ada Writer");
  await expect(dialog.getByLabel("Email")).toHaveValue(`4242+ada@users.noreply.${new URL(app.github.url).hostname}`);
  await expect(dialog).toContainText("your own address stays out of the history");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  expect(readFileSync(gitconfig(app), "utf8")).toMatch(/name = Ada Writer[\s\S]*email = 4242\+ada@users\.noreply\./);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Your novels" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test("from the ⋯ menu: the name and email git signs with, changed by keyboard", async ({ page, app }) => {
  await launch(page, app);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Your name and email…" }).click();
  const dialog = page.getByRole("dialog", { name: "Your name and email" });
  await expect(dialog.getByLabel("Name")).toHaveValue("Test Author");
  await expect(dialog.getByLabel("Email")).toHaveValue("author@example.com");
  await dialog.getByLabel("Name").fill("Ada Varn");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(readFileSync(gitconfig(app), "utf8")).toContain("name = Ada Varn");
});
