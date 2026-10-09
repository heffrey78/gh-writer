import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const BETRAYAL = "manuscript/02-the-sale/01-night-crossing/01-the-betrayal.md";

async function open(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return { dir, read: (path: string) => readFileSync(join(dir, path), "utf8") };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

async function pick(page: Page, picker: string | RegExp, search: string) {
  await page.getByRole("button", { name: picker }).click();
  await page.keyboard.type(search);
  await page.keyboard.press("Enter");
}

const frontMatter = (text: string) => text.slice(0, text.indexOf("\n---\n", 4) + 5);
const body = (text: string) => text.slice(text.indexOf("\n---\n", 4) + 5);

test("edits every detail of a scene, changing only those lines of its front matter", async ({ page, app }) => {
  const novel = await open(page, app);
  const before = novel.read(BETRAYAL);
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Betrayal,/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "The Betrayal" })).toBeVisible();
  await palette(page, "show scene details");
  const panel = page.getByRole("complementary", { name: "Details of “The Betrayal”" });
  await expect(panel).toBeVisible();
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);

  await panel.getByRole("textbox", { name: "Synopsis" }).fill("Ada finds Ben on the bridge.");
  await page.keyboard.press("Enter");
  await panel.getByRole("combobox", { name: "Status" }).selectOption("drafted");
  await pick(page, /^Point of view/, "ben");
  await expect(panel.getByRole("button", { name: /^Point of view/ })).toHaveAccessibleName("Point of view Ben Varn");
  await pick(page, /^Add to characters/, "kost"); // by alias
  await pick(page, /^Add to locations/, "the station");
  await panel.getByRole("button", { name: "Remove “The Varn Bridge”" }).click();
  await panel.getByRole("textbox", { name: "Beat of “The Sale”" }).fill("Ben has sold the plans");
  await page.keyboard.press("Tab");
  await panel.getByRole("combobox", { name: "Weight of “Ben's Debt”" }).selectOption("minor");
  await panel.getByRole("combobox", { name: "Strength of “Inheritance”" }).selectOption("1");
  await panel.getByRole("textbox", { name: "Day" }).fill("4");
  await page.keyboard.press("Enter");
  // A time that isn't one is not saved, and says why.
  await panel.getByRole("textbox", { name: "Time" }).fill("7pm");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("textbox", { name: "Time" })).toHaveAccessibleDescription("Like 18:30");
  await panel.getByRole("textbox", { name: "Time" }).fill("19:00");
  await page.keyboard.press("Enter");
  await panel.getByRole("textbox", { name: "Duration" }).fill("PT1H");
  await page.keyboard.press("Enter");
  await panel.getByRole("textbox", { name: "Tags" }).fill("turning point, night");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => frontMatter(novel.read(BETRAYAL)), { timeout: 10_000 })
    .toBe(
      [
        "---",
        "id: sc_0d9wm4",
        "title: The Betrayal",
        "synopsis: Ada finds Ben on the bridge.",
        "status: drafted",
        "pov: char_b3n0vs",
        "characters: [char_7f3k2q, char_b3n0vs, char_m1re1a]",
        "locations: [loc_5tat10]",
        "entities: [art_p1an5x]",
        "plotlines:",
        "  - id: plot_h315tz",
        "    beat: Ben has sold the plans",
        "  - id: plot_gr1efa",
        "    beat: Ben confesses the debt",
        "    weight: minor",
        "themes:",
        "  - id: theme_trvst5",
        "    strength: 3",
        "  - id: theme_1nher1",
        "    strength: 1",
        "when:",
        "  day: 4",
        '  time: "19:00"',
        "duration: PT1H",
        "tags:",
        "  - turning point",
        "  - night",
        "---",
        "",
      ].join("\n"),
    );
  expect(body(novel.read(BETRAYAL))).toBe(body(before));
  await expect(panel.getByRole("list").first()).toContainText("Mirela Kost");

  await palette(page, "hide scene details");
  await expect(panel).toHaveCount(0);
});

test("in a chapter, follows the scene the caret is in", async ({ page, app }) => {
  await open(page, app);
  await palette(page, "show scene details");
  await expect(page.getByRole("complementary", { name: "Details of “The Station”" })).toBeVisible();
  await page.getByRole("textbox", { name: "Chapter text" }).getByText(/met her at the toll house/).click();
  await expect(page.getByRole("complementary", { name: "Details of “Walking the Span”" })).toBeVisible();
  // Remembered across a reload.
  await page.reload();
  await expect(page.getByRole("complementary", { name: /^Details of/ })).toBeVisible();
});

test("makes a new entry from a picker, and lists custom types in groups of their own", async ({ page, app }) => {
  const novel = await open(page, app);
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Betrayal,/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "The Betrayal" })).toBeVisible();
  await palette(page, "show scene details");
  const panel = page.getByRole("complementary", { name: "Details of “The Betrayal”" });
  const url = page.url();

  // Someone new, from the characters picker: made, and in the scene at once.
  await panel.getByRole("button", { name: /^Add to characters/ }).click();
  await page.keyboard.type("Lena Dray");
  await expect(page.getByRole("option", { name: "New character “Lena Dray”" })).toBeVisible();
  await expect(page.getByText("Nothing matches")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("group", { name: "Characters" })).toContainText("Lena Dray");
  await expect.poll(() => existsSync(join(novel.dir, "bible/characters/lena-dray.md")), { timeout: 10_000 }).toBe(true);
  const lena = /^id: (char_\w{6})$/m.exec(novel.read("bible/characters/lena-dray.md"))![1]!;
  await expect.poll(() => frontMatter(novel.read(BETRAYAL))).toContain(`characters: [char_7f3k2q, char_b3n0vs, ${lena}]`);
  expect(page.url()).toBe(url);

  // Artifacts: a group of their own, kept in the scene's entities.
  const artifacts = panel.getByRole("group", { name: "Artifacts" });
  await expect(artifacts).toContainText("The Original Plans");
  await artifacts.getByRole("button", { name: "Remove “The Original Plans”" }).click();
  await expect.poll(() => frontMatter(novel.read(BETRAYAL))).toContain("entities: []");
  await pick(page, /^Add to artifacts/, "the plans");
  await expect.poll(() => frontMatter(novel.read(BETRAYAL))).toContain("entities:\n  - art_p1an5x\n");
  await pick(page, /^Add to artifacts/, "The Ledger");
  await expect.poll(() => existsSync(join(novel.dir, "bible/artifacts/the-ledger.md")), { timeout: 10_000 }).toBe(true);
  const ledger = /^id: (art_\w{6})$/m.exec(novel.read("bible/artifacts/the-ledger.md"))![1]!;
  await expect.poll(() => frontMatter(novel.read(BETRAYAL))).toContain(`entities:\n  - art_p1an5x\n  - ${ledger}\n`);
  await expect(artifacts).toContainText("The Ledger");
  // No "New type" here: types are made in the story bible.
  await expect(panel.getByRole("button", { name: /new type/i })).toHaveCount(0);
  await axe(page);
});
