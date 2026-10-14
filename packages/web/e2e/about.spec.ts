import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, launch, test } from "./fixtures.ts";

/** About gh-writer, and the desktop app's word of a newer release (#169, #192). */

async function audit(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
}

async function openAbout(page: Page) {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "About gh-writer" }).click();
  return page.getByRole("dialog", { name: "About gh-writer" });
}

test("from a terminal: the Node and git it runs on, no update and no licences", async ({ page, app }) => {
  app.github.latestRelease = { tag: "v9.0.0", notes: "Never offered from a terminal." };
  await app.restart();
  await launch(page, app);
  const about = await openAbout(page);
  await expect(about).toContainText("Run from its source");
  await expect(about).toContainText(/git\s*\d+\.\d+\.\d+ \(this computer's\)/);
  await expect(about.getByRole("heading", { name: "Licences" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /is out$/ })).toHaveCount(0);
  await audit(page);
  await page.keyboard.press("Escape");
  await expect(about).toHaveCount(0);
});

test("in the desktop app: a newer release in the top bar, its notes and download in About, and the licences", async ({ page, app }) => {
  const licenses = join(app.home, "licenses");
  mkdirSync(licenses);
  writeFileSync(join(licenses, "gh-writer-LICENSE.md"), "MIT License\n\nCopyright (c) 2026 Jeff Wikstrom");
  writeFileSync(join(licenses, "git-COPYING.txt"), "GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991");
  app.env.GH_WRITER_APP_VERSION = "0.1.0";
  app.env.GH_WRITER_LICENSES = licenses;
  app.github.latestRelease = { tag: "v0.2.0", notes: "**Faster** saves, and recent novels in the menu." };
  await app.restart();
  await launch(page, app);

  await page.getByRole("button", { name: "gh-writer 0.2.0 is out" }).click();
  const about = page.getByRole("dialog", { name: "About gh-writer" });
  await expect(about).toContainText("0.1.0");
  await expect(about.getByRole("heading", { name: "gh-writer 0.2.0 is out" })).toBeVisible();
  await expect(about.locator("strong", { hasText: "Faster" })).toBeVisible();
  await expect(about.getByRole("link", { name: "Download it from GitHub" })).toHaveAttribute("href", `${app.github.url}/heffrey78/gh-writer/releases/tag/v0.2.0`);

  await about.getByText("git-COPYING").click();
  await expect(about).toContainText("Version 2, June 1991");
  await expect(about.getByText("gh-writer-LICENSE")).toBeVisible();
  await audit(page);
});
