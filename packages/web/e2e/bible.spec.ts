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

test("adds a character, fills in the details and notes, all saved to its file", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Story bible" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  await page.getByRole("button", { name: "New character" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill("Ilse Varn");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ilse Varn" })).toBeVisible();
  expect(novel.lastCommit()).toBe("Bible: add Ilse Varn");
  const file = "bible/characters/ilse-varn.md";

  // Read first: each empty part behind "+ Add…", edited in place, saved at once; Enter saves and
  // returns to the part.
  await page.getByRole("button", { name: "Add other names" }).click();
  await expect(page.getByRole("textbox", { name: "Other names" })).toBeFocused();
  await page.keyboard.type("Ilse, the Aunt");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Also Ilse, the Aunt")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit other names" })).toBeFocused();
  await page.getByRole("button", { name: "Add a summary" }).click();
  await page.keyboard.type("Ada's aunt, who never left.");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Add a field" }).click();
  await page.getByRole("textbox", { name: "Field name" }).fill("age");
  await page.getByRole("textbox", { name: "Value" }).fill("67");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("definition").filter({ hasText: "67" })).toBeVisible();
  await page.getByRole("button", { name: "Add tags" }).click();
  await page.keyboard.type("family, Varn");
  await page.keyboard.press("Enter");
  await expect.poll(() => novel.read(file)).toMatch(/tags:\n {2}- family\n {2}- Varn\n/);
  expect(novel.read(file)).toContain("summary: Ada's aunt, who never left.");
  expect(novel.read(file)).toMatch(/aliases:\n {2}- Ilse\n {2}- the Aunt\n/);
  expect(novel.read(file)).toMatch(/fields:\n {2}age: "67"\n/);
  expect(novel.read(file)).toMatch(/tags:\n {2}- family\n {2}- Varn\n/);
  expect(novel.lastCommit()).toBe("Bible: edit Ilse Varn");

  // Escape leaves a part as it was.
  await page.getByRole("button", { name: "Edit summary" }).click();
  await page.keyboard.type(" Not this.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Edit summary" })).toBeFocused();
  await expect(page.getByRole("dialog").getByText("Ada's aunt, who never left.", { exact: true })).toBeVisible();

  // A field renamed and changed, another added and removed.
  await page.getByRole("button", { name: "Edit age" }).click();
  await page.getByRole("textbox", { name: "Field name" }).fill("born");
  await page.getByRole("textbox", { name: "Value" }).fill("1958");
  await page.keyboard.press("Enter");
  await expect.poll(() => novel.read(file)).toMatch(/fields:\n {2}born: "1958"\n/);
  await expect(page.getByRole("button", { name: "Edit born" })).toBeFocused();
  await page.getByRole("button", { name: "Add a field" }).click();
  await page.getByRole("textbox", { name: "Field name" }).fill("born");
  await page.keyboard.press("Enter");
  await expect(page.getByText("There's already a field “born”.")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit born" }).click();
  await page.getByRole("button", { name: "Remove the field" }).click();
  await expect.poll(() => novel.read(file)).not.toContain("born");

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
  await page.getByRole("button", { name: "Edit name" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Ada Kost");
  await page.keyboard.press("Enter");
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
  // On the strip, each scene she's in is a link to it.
  const listed = page.getByRole("region", { name: "In the story" }).getByRole("list", { name: "Scenes, in reading order" }).getByRole("link");
  await expect(listed).toHaveCount(naming.length);
  for (const title of naming) await expect(listed.and(page.getByRole("link", { name: new RegExp(`^${title.replace(/[?]/g, "\\?")}: `) }))).toHaveCount(1);
  await expect(page.getByRole("list", { name: "All relationships" })).toContainText("Rivals with Ben Varn, from “The Betrayal”");

  await page.getByRole("button", { name: "Delete", exact: true }).click();
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
  await page.getByRole("button", { name: "Delete", exact: true }).click();
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

test("in the story: a strip of every scene, marking where the entry carries it, is in it or is mentioned", async ({ page, app }) => {
  await open(page, app);
  await page.goto(`${app.url}${new URL(app.launchUrl).pathname.replace(/\/chapter.*$/, "")}/bible/${ADA}`);
  const story = page.getByRole("region", { name: "In the story" });
  const strip = story.getByRole("list", { name: "Scenes, in reading order" });
  // Her point of view in all but The Flood, where she's in the scene.
  await expect(strip.getByRole("listitem")).toHaveCount(8);
  await expect(strip.getByRole("link")).toHaveText(["", "", "", "", "", "", "", ""]);
  await expect(strip.getByRole("link", { name: "The Station: point of view" })).toBeVisible();
  await expect(strip.getByRole("link", { name: "The Flood: in the scene" })).toBeVisible();
  await expect(story.getByRole("list", { name: "Key" }).getByRole("listitem")).toHaveText(["Point of view", "In the scene", "Mentioned", "Not there"]);
  await expect(story).toContainText("In all 8 scenes, from “The Station” to “The Last Rivet”; point of view in 7.");
  await expect(story).toContainText("Off the page: ");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  // A place, with an absence; and a mark opens its scene.
  await page.goto(`${app.url}${new URL(app.launchUrl).pathname.replace(/\/chapter.*$/, "")}/bible/loc_w0rk5p`);
  await expect(story).toContainText("In 2 of 8 scenes, from “Tomas's Workshop” to “Mirela's Offer”.");
  await expect(story).toContainText("Longest absence: 3 scenes, “Ben's Ledger” to “The Flood”.");
  await expect(strip.getByRole("listitem").filter({ hasText: "Ben's Ledger: not there" })).toHaveCount(1);
  await strip.getByRole("link", { name: "Mirela's Offer: set here" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mirela's Offer" })).toBeVisible();
});

test("the bible as a gallery: cards with a summary, facts, a strip and a count; sorted three ways by keyboard", async ({ page, app }) => {
  const novel = await open(page, app);
  await palette(page, "story bible");
  const characters = page.getByRole("main").getByRole("region", { name: /^Characters/ });
  const cards = characters.getByRole("listitem").getByRole("link");
  // By first appearance: Ada at the station, Ben on the span, Tomas in his workshop, Mirela at her offer.
  await expect(cards.locator("span.font-semibold:not([aria-hidden])")).toHaveText(["Ada Varn", "Ben Varn", "Tomas Hale", "Mirela Kost"]);
  const ada = cards.filter({ hasText: "Ada Varn" });
  await expect(ada).toContainText("Bridge engineer who comes home after twelve years");
  await expect(ada).toContainText("31 · Structural engineer");
  // Counts as the backlinks have them: every scene file that names the entry, front matter or prose.
  const naming = (id: string) => readdirSync(join(novel.dir, "manuscript"), { recursive: true }).filter((f) => String(f).endsWith(".md") && novel.read(join("manuscript", String(f))).includes(id)).length;
  for (const [name, id] of [["Ada Varn", ADA], ["Ben Varn", "char_b3n0vs"], ["Tomas Hale", "char_t0ma5h"], ["Mirela Kost", "char_m1re1a"]] as const) {
    const n = naming(id);
    await expect(cards.filter({ hasText: name })).toContainText(`${n} ${n === 1 ? "scene" : "scenes"}`);
  }
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  // Sorted by name, then by most scenes, from the keyboard; the choice is in the address.
  const sort = page.getByRole("combobox", { name: "Sort" });
  await sort.focus();
  await page.keyboard.press("ArrowDown");
  await expect(sort).toHaveValue("name");
  await expect(cards.locator("span.font-semibold:not([aria-hidden])")).toHaveText(["Ada Varn", "Ben Varn", "Mirela Kost", "Tomas Hale"]);
  await page.keyboard.press("ArrowDown");
  await expect(cards.locator("span.font-semibold:not([aria-hidden])")).toHaveText(["Ada Varn", "Ben Varn", "Tomas Hale", "Mirela Kost"]);
  await expect(page).toHaveURL(/sort=most/);

  // Search by another name keeps the sort; an entry no scene uses says so.
  await page.getByRole("searchbox", { name: "Search the bible" }).fill("the plans");
  await expect(page.getByRole("main").getByRole("region", { name: /^Artifacts/ }).getByRole("link")).toContainText("1 scene");
  await page.getByRole("searchbox", { name: "Search the bible" }).fill("");
  await page.getByRole("button", { name: "New character" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill("Ilse Varn");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Ilse Varn" })).toBeVisible();
  await page.goBack();
  await expect(cards.filter({ hasText: "Ilse Varn" })).toContainText("Not in the story yet");
});
