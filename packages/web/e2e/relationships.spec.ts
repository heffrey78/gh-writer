import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Page } from "@playwright/test";
import { axe, expect, openView, test, type App } from "./fixtures.ts";

const ADA = "char_7f3k2q";
const MIRELA = "char_m1re1a";

async function openEntry(page: Page, app: App, id: string) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const novelPath = new URL(app.launchUrl).pathname;
  await page.goto(app.launchUrl.replace(novelPath, `${novelPath}/bible/${id}`));
  await expect(page.getByRole("region", { name: "Relationships" })).toBeVisible();
  const relationships = () => (parse(readFileSync(join(dir, "bible/relationships.yaml"), "utf8")) as { relationships: Record<string, string>[] }).relationships;
  return { dir, relationships };
}

/** Open a picker, type, and take the best match. */
async function pick(page: Page, scope: ReturnType<Page["getByRole"]>, label: string, query: string) {
  await scope.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

const panel = (page: Page) => page.getByRole("region", { name: "Relationships" });
/** A relationship's bar, by what it says; it opens a menu of changes. */
const bar = (page: Page, said: RegExp) => panel(page).getByRole("button", { name: said });
async function act(page: Page, said: RegExp, action: string) {
  await bar(page, said).click();
  await page.getByRole("menuitem", { name: action }).click();
}
/** Move the marker to a scene, by keyboard. */
async function readAt(page: Page, title: string) {
  const marker = panel(page).getByRole("radiogroup", { name: "Read the relationships at a scene" });
  await marker.getByRole("radio", { checked: true }).focus();
  for (let i = 0; i < 8 && !(await marker.getByRole("radio", { name: title }).isChecked()); i++) await page.keyboard.press("ArrowRight");
  await expect(marker.getByRole("radio", { name: title })).toBeChecked();
}
const dialog = (page: Page) => page.getByRole("dialog");

test("allies until the betrayal, rivals after it: recorded as two spans and shown as of any scene", async ({ page, app }) => {
  const novel = await openEntry(page, app, ADA);
  const before = novel.relationships().length;

  // Ada and Mirela are allies from the start.
  await panel(page).getByRole("button", { name: "Add a relationship" }).click();
  await dialog(page).getByRole("combobox", { name: "Relationship" }).selectOption({ label: "Allied with" });
  await pick(page, dialog(page), "With", "mirela");
  await dialog(page).getByRole("button", { name: "Add relationship" }).click();
  await expect(panel(page).getByRole("list", { name: "All relationships" })).toContainText("Allied with Mirela Kost");
  await axe(page);

  // From "The Betrayal" on, they're rivals.
  await act(page, /^Allied with Mirela Kost/, "Change at…");
  await pick(page, dialog(page), "It changes at", "betrayal");
  await dialog(page).getByRole("combobox", { name: "From then on" }).selectOption({ label: "Rivals with" });
  await axe(page);
  await dialog(page).getByRole("button", { name: "Change it" }).click();
  await expect(panel(page).getByRole("list", { name: "All relationships" })).toContainText("Rivals with Mirela Kost, from “The Betrayal”");

  const records = novel.relationships().slice(before);
  expect(records).toEqual([
    expect.objectContaining({ from: ADA, to: MIRELA, type: "allies", until: "sc_0d9wm4" }),
    expect.objectContaining({ from: ADA, to: MIRELA, type: "rivals", since: "sc_0d9wm4" }),
  ]);
  expect(app.git(novel.dir, "log", "-1", "--format=%s").trim()).toBe("Bible: Ada Varn allies Mirela Kost becomes rivals at “The Betrayal”");

  // Two arcs on Mirela's row, meeting at The Betrayal.
  const mirela = panel(page).getByRole("list", { name: "All relationships" }).getByRole("listitem").filter({ hasText: "Mirela Kost" });
  await expect(mirela.getByRole("button")).toHaveText([/^Allied with/, /^Rivals with/]);
  // Read at an earlier scene they're allies; at a later one, rivals.
  await readAt(page, "Walking the Span");
  const at = () => panel(page).getByRole("region", { name: /^At “/ });
  await expect(at()).toContainText("Allied with Mirela Kost");
  await expect(at()).not.toContainText("Rivals with Mirela Kost");
  await readAt(page, "The Flood");
  await expect(at()).toContainText("Rivals with Mirela Kost");
  await expect(at()).not.toContainText("Allied with Mirela Kost");

  // It ends at the last scene.
  await act(page, /^Rivals with Mirela Kost/, "End at…");
  await pick(page, dialog(page), "It no longer holds from", "last rivet");
  await dialog(page).getByRole("button", { name: "End it" }).click();
  await expect(panel(page)).toContainText("Rivals with Mirela Kost, from “The Betrayal”, until “The Last Rivet”");
});

test("refuses a change before the relationship starts, saying why", async ({ page, app }) => {
  await openEntry(page, app, ADA);
  await act(page, /^Rivals with Ben Varn, from “The Betrayal”/, "Change at…");
  await pick(page, dialog(page), "It changes at", "the station");
  await dialog(page).getByRole("button", { name: "Change it" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("The change must come after the relationship starts.");
});

test("a new kind of relationship, one-way, is used at once from either side", async ({ page, app }) => {
  const novel = await openEntry(page, app, "char_b3n0vs");
  await page.getByRole("link", { name: "Story bible" }).first().click();
  await page.getByRole("button", { name: "New kind" }).click();
  await dialog(page).getByRole("textbox", { name: "Name" }).fill("Owes a favour to");
  await dialog(page).getByRole("checkbox").uncheck();
  await dialog(page).getByRole("textbox", { name: "From the other side" }).fill("Is owed a favour by");
  await dialog(page).getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("region", { name: "Kinds of relationship" })).toContainText("Owes a favour to / Is owed a favour by");
  await axe(page);

  await page.goBack();
  await panel(page).getByRole("button", { name: "Add a relationship" }).click();
  await dialog(page).getByRole("combobox", { name: "Relationship" }).selectOption({ label: "Is owed a favour by" });
  await pick(page, dialog(page), "With", "tomas");
  await dialog(page).getByRole("button", { name: "Add relationship" }).click();
  await expect(panel(page)).toContainText("Is owed a favour by Tomas Hale");
  // Read from Tomas's side, Ben's record reads the other way.
  expect(novel.relationships().at(-1)).toMatchObject({ from: "char_t0ma5h", to: "char_b3n0vs", type: "owes-a-favour-to" });
});

test("a kind of relationship's colour and line are chosen by keyboard, saved in novel.yaml, and drawn in the graph", async ({ page, app }) => {
  const { dir } = await openEntry(page, app, ADA);
  const yaml = () => readFileSync(join(dir, "novel.yaml"), "utf8");
  const before = yaml();
  await page.getByRole("link", { name: "Story bible" }).first().click();
  const kinds = page.getByRole("region", { name: "Kinds of relationship" });
  await kinds.getByRole("button", { name: "Edit “Rivals with”" }).click();
  const colour = dialog(page).getByRole("group", { name: "Colour" });
  await expect(colour.getByRole("radio", { name: "Red" })).toBeChecked();
  await expect(dialog(page).getByRole("group", { name: "Line" }).getByRole("radio", { name: "Dashed" })).toBeChecked();
  await axe(page);
  // Arrow keys move through a radio group.
  await colour.getByRole("radio", { name: "Red" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(colour.getByRole("radio", { name: "Violet" })).toBeChecked();
  await dialog(page).getByRole("group", { name: "Line" }).getByRole("radio", { name: "Dashed" }).focus();
  await page.keyboard.press("ArrowRight");
  await dialog(page).getByRole("button", { name: "Save" }).click();
  await expect(dialog(page)).toHaveCount(0);
  // Only its style's lines changed.
  await expect.poll(yaml).toBe(before.replace("style: { color: series-8, line: dashed }", "style: { color: series-7, line: dotted }"));

  // A new kind takes the first colour no kind uses; the others keep theirs.
  await page.getByRole("button", { name: "New kind" }).click();
  await dialog(page).getByRole("textbox", { name: "Name" }).fill("Loves");
  await expect(dialog(page).getByRole("group", { name: "Colour" }).getByRole("radio", { name: "Orange" })).toBeChecked();
  await dialog(page).getByRole("button", { name: "Add" }).click();
  await expect(kinds).toContainText("Loves");
  expect(yaml()).toContain("  - key: loves\n    label: Loves\n    symmetric: true\n    style:\n      color: series-2\n      line: solid\n");

  // The graph draws Rivals with in violet, dotted.
  await openView(page, "Relationships");
  await page.getByRole("slider", { name: "Story position" }).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  const rivals = page.locator('.react-flow__edge[aria-label="Ada Varn, Rivals with, Ben Varn"] path.react-flow__edge-path');
  await expect.poll(() => rivals.evaluate((p) => [getComputedStyle(p).stroke, getComputedStyle(p).strokeDasharray])).toEqual(["rgb(98, 80, 214)", "2px, 4px"]);
});

test("relationships as arcs over the scenes, in their kinds' colours and lines, read at a scene and removed from their bar", async ({ page, app }) => {
  const novel = await openEntry(page, app, ADA);
  const list = panel(page).getByRole("list", { name: "All relationships" });
  // By who they're with; Ben's row holds sibling throughout, allied until The Betrayal, rivals from it to The Last Rivet, allied again.
  await expect(list.getByRole("listitem").getByRole("link")).toHaveText(["Ben Varn", "Tomas Hale"]);
  const ben = list.getByRole("listitem").filter({ hasText: "Ben Varn" });
  await expect(ben.getByRole("button")).toHaveCount(4);
  const span = async (said: RegExp) =>
    bar(page, said).evaluate((b) => [getComputedStyle(b).gridColumnStart, getComputedStyle(b).gridColumnEnd, getComputedStyle(b).borderTopStyle, getComputedStyle(b).borderTopColor]);
  expect(await span(/^Sibling of Ben Varn/)).toEqual(["1", "9", "solid", "rgb(42, 120, 214)"]);
  expect(await span(/^Allied with Ben Varn, until/)).toEqual(["1", "5", "solid", "rgb(0, 131, 0)"]);
  expect(await span(/^Rivals with Ben Varn/)).toEqual(["5", "8", "dashed", "rgb(227, 73, 72)"]);
  expect(await span(/^Allied with Ben Varn, from/)).toEqual(["8", "9", "solid", "rgb(0, 131, 0)"]);
  // Each bar names its kind and the note: colour is never the only difference.
  await expect(bar(page, /^Rivals with Ben Varn/)).toContainText("Rivals with · After the bridge betrayal.");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  await readAt(page, "The Betrayal");
  await expect(panel(page).getByRole("region", { name: "At “The Betrayal”" }).getByRole("listitem")).toHaveText([
    "Sibling of Ben Varn",
    "Rivals with Ben Varn, from “The Betrayal”, until “The Last Rivet” (After the bridge betrayal.)",
    "Mentee of Tomas Hale",
  ]);

  // Removed from its bar, after asking.
  const before = novel.relationships().length;
  await act(page, /^Mentee of Tomas Hale/, "Remove…");
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(list.getByRole("listitem").getByRole("link")).toHaveText(["Ben Varn"]);
  expect(novel.relationships()).toHaveLength(before - 1);
});
