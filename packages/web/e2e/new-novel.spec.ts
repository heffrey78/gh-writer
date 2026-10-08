import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, launch, test } from "./fixtures.ts";

const dialog = (page: Page) => page.getByRole("dialog", { name: "New novel" });

test("starts a novel from the shelf's + and opens it, ready to write", async ({ page, app }) => {
  await launch(page, app);
  await page.getByRole("list", { name: "Novels" }).getByRole("button", { name: "New novel" }).click();
  await expect(dialog(page).getByRole("textbox", { name: "Title" })).toBeFocused();
  await page.keyboard.type("The Salt Road");
  await expect(dialog(page).getByRole("textbox", { name: "Folder" })).toHaveAttribute("placeholder", "~/gh-writer/the-salt-road");
  await dialog(page).getByRole("textbox", { name: "Author" }).fill("Ada Writer");
  await axe(page);
  await page.keyboard.press("Enter");

  await expect(page).toHaveTitle("The Salt Road · gh-writer");
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  const dir = join(app.home, "gh-writer", "the-salt-road");
  expect(app.git(dir, "log", "--format=%s").trim()).toBe("Start The Salt Road");

  // Typing goes into the opening scene, which is saved and committed.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("The road ran white with salt.");
  const scene = join(dir, "manuscript/01-chapter-one/01-opening.md");
  await expect.poll(() => readFileSync(scene, "utf8"), { timeout: 10_000 }).toContain("The road ran white with salt.");

  await page.getByRole("link", { name: "gh-writer" }).click();
  await expect(page.getByRole("link", { name: "The Salt Road, by Ada Writer" })).toBeVisible();
});

test("asks who's writing when git doesn't know, for this novel only", async ({ page, app }) => {
  writeFileSync(join(app.home, ".gitconfig"), "[init]\n\tdefaultBranch = main\n");
  await launch(page, app);
  await page.getByRole("button", { name: "New novel" }).first().click();
  await dialog(page).getByRole("textbox", { name: "Title" }).fill("Nobody Knows");
  await dialog(page).getByRole("button", { name: "Create" }).click();

  const who = dialog(page).getByRole("group", { name: "Who's writing?" });
  await expect(who).toBeVisible();
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  await expect(who.getByRole("textbox", { name: "Name" })).toBeFocused();
  await page.keyboard.type("Ada Writer");
  await expect(dialog(page).getByRole("button", { name: "Create" })).toBeDisabled();
  await who.getByRole("textbox", { name: "Email" }).fill("ada@example.com");
  await axe(page);
  await dialog(page).getByRole("button", { name: "Create" }).click();

  await expect(page).toHaveTitle("Nobody Knows · gh-writer");
  const dir = join(app.home, "gh-writer", "nobody-knows");
  expect(app.git(dir, "log", "--format=%an <%ae>").trim()).toBe("Ada Writer <ada@example.com>");
  expect(readFileSync(join(app.home, ".gitconfig"), "utf8")).not.toContain("Ada");
});

test("says so when the folder is taken, and from the palette too", async ({ page, app }) => {
  await launch(page, app);
  const r = await page.request.post(`${app.url}/api/library/new`, { data: { title: "Varn" }, headers: { origin: app.url } });
  expect(r.status()).toBe(201);
  await page.reload();

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("new novel");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.type("Varn");
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByRole("alert")).toContainText("already exists and isn't empty");

  // Another folder works.
  await dialog(page).getByRole("textbox", { name: "Folder" }).fill("~/gh-writer/varn-again");
  await dialog(page).getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveTitle("Varn · gh-writer");
  expect(app.git(join(app.home, "gh-writer", "varn-again"), "log", "--format=%s").trim()).toBe("Start Varn");
});
