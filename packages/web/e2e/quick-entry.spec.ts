import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, selectionSettled, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const CREATE = (url: URL) => url.pathname.endsWith("/bible/entities");

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const read = (path: string) => readFileSync(join(dir, path), "utf8");
  return { dir, read, frontMatter: (path: string) => read(path).split("\n---")[0]! };
}
const listbox = (page: Page) => page.getByRole("listbox", { name: "Mention suggestions" });
const notice = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });
const saveStatus = (page: Page) => page.getByRole("banner").getByRole("status");

async function caretInStation(page: Page, box = "Chapter text") {
  await page.getByRole("textbox", { name: box }).getByText(/the way you count stitches in a wound\./).click();
  await selectionSettled(page);
  await page.keyboard.press("End");
}

/** @ + name, then New <type> (the nth "New" row). */
async function quickEntry(page: Page, name: string, row = 0) {
  await page.keyboard.type(` @${name}`);
  await expect(listbox(page).getByRole("group", { name: "New entry" })).toBeVisible();
  for (let i = 0; i <= row; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
}

test("@ + a new name makes the character in place: the mention, its file, the scene's list, and details beside the text", async ({ page, app }) => {
  const novel = await open(page, app);
  await caretInStation(page);
  const url = page.url();
  await quickEntry(page, "Mira Kostova");
  await page.keyboard.type("waved.");
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  expect(page.url()).toBe(url);
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toMatch(/in a wound\. \[Mira Kostova\]\(#char_[0-9a-hjkmnp-tv-z]{6}\) waved\./);
  const id = /\[Mira Kostova\]\(#(char_\w{6})\)/.exec(novel.read(STATION))![1]!;
  await expect.poll(() => existsSync(join(novel.dir, "bible/characters/mira-kostova.md"))).toBe(true);
  expect(novel.read("bible/characters/mira-kostova.md")).toBe(`---\nid: ${id}\nname: Mira Kostova\n---\n`);
  await expect.poll(() => novel.frontMatter(STATION)).toContain(id);
  await expect(notice(page)).toContainText("Added character “Mira Kostova” to the story bible.");
  await axe(page);
  await notice(page).getByRole("button", { name: "Add details" }).click();
  const panel = page.getByRole("complementary", { name: "Mira Kostova" });
  await expect(panel.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Mira Kostova");
  expect(page.url()).toBe(url);
  await panel.getByRole("button", { name: "Back to the text" }).click();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await expect(saveStatus(page)).toHaveText("Saved");
});

test("a custom type from the scene's own editor goes in its entities", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Station,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();
  await caretInStation(page, "Scene text");
  await page.keyboard.type(" @The Ledger");
  await page.keyboard.press("ArrowUp"); // the last row: New artifact
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveText("New artifact “The Ledger”");
  await page.keyboard.press("Enter");
  await expect.poll(() => existsSync(join(novel.dir, "bible/artifacts/the-ledger.md")), { timeout: 10_000 }).toBe(true);
  const id = /^id: (art_\w{6})$/m.exec(novel.read("bible/artifacts/the-ledger.md"))![1]!;
  await expect.poll(() => novel.frontMatter(STATION)).toContain(`\nentities:\n  - ${id}`);
  await expect.poll(() => novel.read(STATION)).toContain(`in a wound. [The Ledger](#${id})`);
});

test("a create the server refuses says why: try again, or unlink the mention", async ({ page, app }) => {
  const novel = await open(page, app);
  const before = novel.frontMatter(STATION);
  await page.route(CREATE, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "BLOCKED", error: "Git doesn't know who you are." }) }));
  await caretInStation(page);
  await quickEntry(page, "Mira Kostova");
  await page.keyboard.type("waved.");
  await expect(notice(page)).toContainText("Couldn't add “Mira Kostova” to the story bible: Git doesn't know who you are.");
  await expect(saveStatus(page)).toHaveText("Not saved");
  await axe(page);
  await notice(page).getByRole("button", { name: "Unlink" }).click();
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toContain("in a wound. Mira Kostova waved.");
  await expect.poll(() => novel.frontMatter(STATION)).toBe(before);
  expect(readdirSync(join(novel.dir, "bible/characters"))).not.toContain("mira-kostova.md");
  await expect(saveStatus(page)).toHaveText("Saved");

  // Again, and this time the author fixes it and tries again.
  await caretInStation(page);
  await quickEntry(page, "Lena Dray");
  await expect(notice(page)).toContainText("Couldn't add “Lena Dray”");
  await page.unroute(CREATE);
  await notice(page).getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => existsSync(join(novel.dir, "bible/characters/lena-dray.md")), { timeout: 10_000 }).toBe(true);
  await expect(notice(page)).toContainText("Added character “Lena Dray”");
});

test("a create cut off by a reload is made after it", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.route(CREATE, (route) => route.abort());
  await caretInStation(page);
  await quickEntry(page, "Mira Kostova");
  await page.keyboard.type("waved.");
  await expect(saveStatus(page)).toHaveText("Saving…");
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toContain("[Mira Kostova](#char_");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.unroute(CREATE);
  await expect.poll(() => existsSync(join(novel.dir, "bible/characters/mira-kostova.md")), { timeout: 15_000 }).toBe(true);
  const id = /\[Mira Kostova\]\(#(char_\w{6})\)/.exec(novel.read(STATION))![1]!;
  expect(novel.read("bible/characters/mira-kostova.md")).toContain(`id: ${id}\n`);
  await expect(saveStatus(page)).toHaveText("Saved");
});

test("right after @, New <type>… asks for the name in a dialog, then mentions it where the @ is", async ({ page, app }) => {
  const novel = await open(page, app);
  await caretInStation(page);
  await page.keyboard.type(" @");
  const rows = listbox(page).getByRole("group", { name: "New entry" }).getByRole("option");
  await expect(rows).toHaveText(["New character…", "New location…", "New plotline…", "New theme…", "New artifact…"]);
  await rows.filter({ hasText: "New location…" }).click();
  const dialog = page.getByRole("dialog", { name: "New location" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  await axe(page);
  await page.keyboard.type("The Old Mill");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.keyboard.type("stood empty.");
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toMatch(/in a wound\. \[The Old Mill\]\(#loc_\w{6}\) stood empty\./);
  await expect.poll(() => existsSync(join(novel.dir, "bible/locations/the-old-mill.md"))).toBe(true);

  // Cancelled: the @ stays as typed, and the menu stays closed.
  await page.keyboard.type(" @");
  await page.keyboard.press("ArrowUp");
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveText("New artifact…");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "New artifact" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await expect(listbox(page)).toHaveCount(0);
  await page.keyboard.type("nothing.");
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toContain("stood empty. @nothing.");
});
