import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const ADA = "char_7f3k2q";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return {
    dir,
    read: (path: string) => readFileSync(join(dir, path), "utf8"),
    lastCommit: () => app.git(dir, "log", "-1", "--format=%s").trim(),
  };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

const details = (page: Page) => page.getByRole("form", { name: "Details" });

test("adds a character, fills in the details and notes, all saved to its file", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.getByRole("navigation", { name: "Story bible" }).getByRole("link", { name: "Story bible" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  await page.getByRole("button", { name: "New character" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill("Ilse Varn");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ilse Varn" })).toBeVisible();
  expect(novel.lastCommit()).toBe("Bible: add Ilse Varn");
  const file = "bible/characters/ilse-varn.md";

  await details(page).getByRole("textbox", { name: "Other names" }).fill("Ilse, the Aunt");
  await details(page).getByRole("textbox", { name: "Summary" }).fill("Ada's aunt, who never left.");
  await details(page).getByRole("button", { name: "Add a field" }).click();
  await details(page).getByRole("textbox", { name: "Field 1 name" }).fill("age");
  await details(page).getByRole("textbox", { name: "age value" }).fill("67");
  await details(page).getByRole("button", { name: "Save details" }).click();
  await expect.poll(() => novel.read(file)).toContain("summary: Ada's aunt, who never left.");
  expect(novel.read(file)).toMatch(/aliases:\n {2}- Ilse\n {2}- the Aunt\n/);
  expect(novel.read(file)).toMatch(/fields:\n {2}age: "67"\n/);
  expect(novel.lastCommit()).toBe("Bible: edit Ilse Varn");

  const notes = page.getByRole("textbox", { name: "Notes on Ilse Varn" });
  await notes.click();
  await page.keyboard.type("Lives above the toll house.");
  await expect.poll(() => novel.read(file), { timeout: 10_000 }).toMatch(/---\nLives above the toll house\.\n$/);
  await axe(page);
});

test("renames an entry by moving its file only; every reference still resolves", async ({ page, app }) => {
  const novel = await open(page, app);
  await palette(page, "character: ada");
  await expect(page.getByRole("heading", { level: 1, name: "Ada Varn" })).toBeVisible();
  await details(page).getByRole("textbox", { name: "Name", exact: true }).fill("Ada Kost");
  await details(page).getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ada Kost" })).toBeVisible();
  expect(novel.lastCommit()).toBe("Bible: rename Ada Varn to Ada Kost");
  expect(app.git(novel.dir, "show", "-M", "--name-status", "--format=", "HEAD").trim()).toMatch(/^R\d+\tbible\/characters\/ada\.md\tbible\/characters\/ada-kost\.md$/);
  // Her scenes still list her, and the backlinks still find them.
  await expect(page.getByRole("region", { name: "In the story" }).getByRole("link", { name: "The Station" })).toBeVisible();
});

test("lists every scene that refers to a character, and asks before deleting one the story uses", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.goto(`${app.url}${new URL(app.launchUrl).pathname.replace(/\/chapter.*$/, "")}/bible/${ADA}`);
  await expect(page.getByRole("heading", { level: 1, name: "Ada Varn" })).toBeVisible();
  // Every scene file that names her, in front matter or prose, is listed.
  const scenes = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scenes(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []));
  const naming = scenes(join(novel.dir, "manuscript"))
    .filter((f) => readFileSync(f, "utf8").includes(ADA))
    .map((f) => /^title: (.*)$/m.exec(readFileSync(f, "utf8"))![1]!);
  const listed = page.getByRole("region", { name: "In the story" }).getByRole("listitem").filter({ has: page.getByRole("link") });
  await expect(listed).toHaveCount(naming.length);
  for (const title of naming) await expect(listed.filter({ hasText: title })).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Relationships" })).toContainText("Rivals with Ben Varn, from “The Betrayal”");

  await page.getByRole("button", { name: "Delete" }).click();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("The story still refers to it");
  await expect(ask).toContainText("The Station");
  await axe(page);
  await ask.getByRole("button", { name: "Keep it" }).click();
  expect(existsSync(join(novel.dir, "bible/characters/ada.md"))).toBe(true);
});

test("deletes an entry nobody refers to", async ({ page, app }) => {
  const novel = await open(page, app);
  await palette(page, "new location");
  await page.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill("The Old Mill");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "The Old Mill" })).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  expect(existsSync(join(novel.dir, "bible/locations/the-old-mill.md"))).toBe(false);
  expect(novel.lastCommit()).toBe("Bible: remove The Old Mill");
});

test("a new type of entry works at once, with no code changes", async ({ page, app }) => {
  const novel = await open(page, app);
  await palette(page, "story bible");
  await page.getByRole("button", { name: "New type" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name, singular" }).fill("Vehicle");
  await page.getByRole("dialog").getByRole("button", { name: "Add type" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Vehicles/ })).toBeVisible();
  expect(novel.read("novel.yaml")).toMatch(/- key: vehicle\n {4}prefix: vehi\n {4}folder: vehicles\n {4}label: Vehicle\n/);
  await page.getByRole("button", { name: "New vehicle" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill("The Night Train");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "The Night Train" })).toBeVisible();
  expect(novel.read("bible/vehicles/the-night-train.md")).toMatch(/^---\nid: vehi_[0-9a-hjkmnp-tv-z]{6}\nname: The Night Train\n---\n$/);
});

test("searches the bible by name and alias", async ({ page, app }) => {
  await open(page, app);
  await palette(page, "story bible");
  await page.getByRole("searchbox", { name: "Search the bible" }).fill("ada");
  await expect(page.getByText(/entr(y|ies) match “ada”/)).toBeVisible();
  const results = page.getByRole("main").getByRole("region", { name: /^Characters/ });
  await expect(results.getByRole("link", { name: /^Ada Varn/ })).toBeVisible();
  await expect(results.getByRole("link", { name: /^Ben/ })).toHaveCount(0);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});
