import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, selectionSettled, test, type App } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return { dir, read: (path: string) => readFileSync(join(dir, path), "utf8") };
}
const listbox = (page: Page) => page.getByRole("listbox", { name: "Mention suggestions" });
async function caretInStation(page: Page) {
  await page.getByRole("textbox", { name: "Chapter text" }).getByText(/the way you count stitches in a wound\./).click();
  await selectionSettled(page);
  await page.keyboard.press("End");
}

test("@ + a new name: New character, made in place", async ({ page, app }) => {
  const novel = await open(page, app);
  await caretInStation(page);
  const url = page.url();
  await page.keyboard.type(" @Mira Kostova");
  await expect(listbox(page).getByRole("option")).toContainText(["New character “Mira Kostova”", "New location “Mira Kostova”", "New plotline “Mira Kostova”", "New theme “Mira Kostova”", "New artifact “Mira Kostova”"]);
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveCount(0);
  await axe(page);
  await page.keyboard.press("ArrowDown");
  await expect(listbox(page).getByRole("option", { selected: true })).toHaveText("New character “Mira Kostova”");
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await page.keyboard.type("waved.");
  console.log("typed after create in", Date.now() - t0, "ms");
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toContainText("in a wound. Mira Kostova waved.");
  expect(page.url()).toBe(url);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toMatch(/in a wound\. \[Mira Kostova\]\(#char_[0-9a-z]{6}\) waved\./);
  const id = /\[Mira Kostova\]\(#(char_[0-9a-z]{6})\)/.exec(novel.read(STATION))![1]!;
  await expect.poll(() => existsSync(join(novel.dir, "bible/characters/mira-kostova.md"))).toBe(true);
  expect(novel.read("bible/characters/mira-kostova.md")).toBe(`---\nid: ${id}\nname: Mira Kostova\n---\n`);
  // Mention sync lists the new character in the scene.
  await expect.poll(() => novel.read(STATION).split("\n---")[0]).toContain(id);
  await expect(page.getByRole("status").filter({ hasText: "Added character “Mira Kostova”" })).toBeVisible();
  await page.getByRole("button", { name: "Add details" }).click();
  await expect(page.getByRole("complementary", { name: "Mira Kostova" }).getByRole("heading", { name: "Mira Kostova" })).toBeVisible();
  expect(page.url()).toBe(url);
});

test("@ + a word nobody has: Enter is still Enter", async ({ page, app }) => {
  const novel = await open(page, app);
  await caretInStation(page);
  await page.keyboard.type(" @home");
  await expect(listbox(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Next line.");
  await expect.poll(() => novel.read(STATION), { timeout: 10_000 }).toContain("in a wound. @home\n\nNext line.");
  expect(readdirSync(join(novel.dir, "bible/characters"))).not.toContain("home.md");
});

test("scene details: New character from the picker, and a custom type's group", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Station,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("show scene details");
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Details of “The Station”" });
  await panel.getByRole("button", { name: /^Add to characters/ }).click();
  await page.keyboard.type("Lena Dray");
  await page.getByRole("option", { name: "New character “Lena Dray”" }).click();
  await expect(panel.getByRole("list").first()).toContainText("Lena Dray");
  await expect.poll(() => existsSync(join(novel.dir, "bible/characters/lena-dray.md"))).toBe(true);
  const lena = /^id: (char_\w+)$/m.exec(novel.read("bible/characters/lena-dray.md"))![1]!;
  await expect.poll(() => novel.read(STATION).split("\n---")[0]).toContain(lena);

  // Artifacts: a group of their own.
  await panel.getByRole("button", { name: /^Add to artifacts/ }).click();
  await page.keyboard.type("plans");
  await page.keyboard.press("Enter");
  await expect.poll(() => novel.read(STATION).split("\n---")[0]).toMatch(/\nentities:\n  - art_p1an5x/);
  await panel.getByRole("button", { name: /^Add to artifacts/ }).click();
  await page.keyboard.type("The Ledger");
  await page.getByRole("option", { name: "New artifact “The Ledger”" }).click();
  await expect.poll(() => existsSync(join(novel.dir, "bible/artifacts/the-ledger.md"))).toBe(true);
  await expect(panel).toContainText("The Ledger");
  await axe(page);

  // Presence: the artifact's cell shows it listed, and toggles.
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Presence" }).click();
  await page.getByRole("combobox", { name: "Rows" }).selectOption({ label: "Artifacts" });
  const grid = page.getByRole("grid", { name: "Artifacts by scene" });
  await expect(grid.getByRole("gridcell", { name: /^The Station: The Original Plans present/ })).toBeVisible();
});

test("timing: createEntity round trip (waiting for the server instead)", async ({ page, app }) => {
  await open(page, app);
  const id = (await page.evaluate(() => location.pathname)).split("/")[2];
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    const r = await page.request.post(`${app.url}/api/novels/${id}/bible/entities`, { data: { type: "character", name: `Timing ${i}` }, headers: { origin: app.url } });
    expect(r.status()).toBe(201);
    times.push(Date.now() - t);
  }
  console.log("createEntity ms:", times.join(", "));
});
