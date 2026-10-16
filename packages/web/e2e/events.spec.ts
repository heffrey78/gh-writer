import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { asFormatV1 } from "../../server/test/fixtures.ts";
import { axe, caretAtEnd, expect, selectionSettled, test, type App } from "./fixtures.ts";

/** Off-page events as pages of their own (#165, #210). */

const FLOOD = "bible/events/the-flood-of-09.md";

async function openNovel(page: Page, app: App, before?: (dir: string) => void) {
  const dir = app.novelRepo("varn");
  if (before) {
    before(dir);
    app.git(dir, "add", "-A");
    app.git(dir, "commit", "-qm", "Prepare");
  }
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return dir;
}

async function openEvent(page: Page, title: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(`off the page: ${title}`);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

test("an event's page: read first, each part edited in place by keyboard, its note as prose", async ({ page, app }) => {
  const dir = await openNovel(page, app);
  const file = () => readFileSync(join(dir, FLOOD), "utf8");
  await openEvent(page, "The flood of '09");

  // In its modal over the Story bible (#236).
  const modal = page.getByRole("dialog", { name: "The flood of '09" });
  await expect(modal.getByText("Story bible · Off the page")).toBeVisible();
  await expect(modal.getByText("2 Nov 2009 · 3 days")).toBeVisible();
  const rows = page.locator("dl[aria-label='Who, where and plotlines']");
  await expect(rows).toContainText("WhoAda Varn, Ben Varn, Tomas Hale");
  await expect(rows).toContainText("WhereThe Varn Bridge");
  await expect(rows).toContainText("PlotlinesNone");
  await expect(page.getByRole("region", { name: "In story time" })).toHaveText(/Before “The Flood”\./);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  // How long, by keyboard: the pencil, the field, Enter, Escape back to the pencil.
  await page.getByRole("button", { name: "Edit when and how long" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "Duration" }).fill("P4D");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Edit when and how long" })).toBeFocused();
  await expect.poll(file).toContain("\nduration: P4D\n");

  // A plotline, and Tomas taken off.
  await page.getByRole("button", { name: "Edit plotlines" }).click();
  await page.getByRole("button", { name: /^Add to plotlines/ }).click();
  await page.keyboard.type("the sale");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit who" }).click();
  await page.getByRole("button", { name: "Remove “Tomas Hale”" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect.poll(file).toMatch(/characters:\n {2}- char_7f3k2q\n {2}- char_b3n0vs\nlocations:\n {2}- loc_br1dg3\n(.*\n)*plotlines:\n {2}- plot_h315tz\n---\n/);
  await expect(rows).toContainText("WhoAda Varn, Ben Varn");

  // The note is prose, written in place.
  const note = page.getByRole("textbox", { name: "Note on The flood of '09" });
  await caretAtEnd(page, note);
  await page.keyboard.type(" Ada was eleven.");
  await expect.poll(file).toMatch(/\n---\n\n?The father holds the seventh pier through the night and dies of pneumonia a week later\. Ada was eleven\.\n$/);
});

test("a new title moves the event's file; deleting one the story mentions asks first", async ({ page, app }) => {
  const dir = await openNovel(page, app, (d) => {
    const scene = join(d, "manuscript/01-return/01-arrival/01-the-station.md");
    writeFileSync(scene, `${readFileSync(scene, "utf8").trimEnd()}\n\nShe thought of [the flood](#evt_9ab3kd).\n`);
  });
  await openEvent(page, "The flood of '09");
  await page.getByRole("button", { name: "Edit title" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("The great flood");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "The great flood" })).toBeVisible();
  await expect.poll(() => existsSync(join(dir, "bible/events/the-great-flood.md"))).toBe(true);
  expect(existsSync(join(dir, FLOOD))).toBe(false);

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const ask = page.getByRole("alertdialog", { name: "Delete “The great flood”? The story still mentions it." });
  await expect(ask).toContainText("Scene “The Station”");
  await axe(page);
  await ask.getByRole("button", { name: "Keep it" }).click();
  expect(existsSync(join(dir, "bible/events/the-great-flood.md"))).toBe(true);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await ask.getByRole("button", { name: "Delete anyway" }).click();
  // Back to the Story bible's off-page events, the modal closed.
  await expect(page.getByRole("heading", { level: 1, name: "Story bible" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(existsSync(join(dir, "bible/events/the-great-flood.md"))).toBe(false);
  await expect.poll(() => app.git(dir, "log", "-1", "--format=%s").trim()).toBe("Bible: remove event “The great flood”");
});

test("in a novel in format v1, the first change asks to move it to the new format; Cancel changes nothing", async ({ page, app }) => {
  const dir = await openNovel(page, app, asFormatV1);
  const head = app.git(dir, "rev-parse", "HEAD");
  await openEvent(page, "The flood of '09");
  await expect(page.getByRole("dialog").getByText("The father holds the seventh pier")).toBeVisible();

  await page.getByRole("button", { name: "Edit when and how long" }).click();
  const ask = page.getByRole("alertdialog", { name: "Move this novel to the new format?" });
  await expect(ask).toContainText("Copies of gh-writer from before this one won't open it afterwards.");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  expect(app.git(dir, "rev-parse", "HEAD")).toBe(head);
  expect(app.git(dir, "status", "--porcelain")).toBe("");

  await page.getByRole("button", { name: "Edit when and how long" }).click();
  await ask.getByRole("button", { name: "Move it" }).click();
  await expect(page.getByRole("textbox", { name: "Duration" })).toBeVisible();
  expect(app.git(dir, "log", "-1", "--format=%s").trim()).toBe("Format v2: off-page events as files");
  expect(existsSync(join(dir, "bible/events.yaml"))).toBe(false);
  await page.getByRole("textbox", { name: "Duration" }).fill("P4D");
  await page.keyboard.press("Enter");
  await expect.poll(() => readFileSync(join(dir, FLOOD), "utf8")).toContain("\nduration: P4D\n");

  // Moved once: another change doesn't ask again.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit who" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Add to characters/ })).toBeVisible();
});

test("the outline in story time places the off-page events among the scenes; reading order shows none", async ({ page, app }) => {
  await openNovel(page, app);
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Outline" }).click();
  await expect(page.getByRole("table", { name: "Every scene in reading order, by chapter" })).toBeVisible();
  await expect(page.getByRole("link", { name: "The flood of '09" })).toHaveCount(0);

  await page.getByRole("radiogroup", { name: "Order" }).getByText("Story time", { exact: true }).click();
  const table = page.getByRole("table", { name: "Every scene and off-page event in story-time order" });
  await expect(table.getByRole("row").locator("td:nth-child(2)")).toHaveText([
    "The flood of '09",
    "The Flood",
    "Ada leaves for the polytechnic",
    "The plans are stolen",
    "The Station",
    "Walking the Span",
    "Tomas's Workshop",
    "Ben's Ledger",
    "The Betrayal",
    "Mirela's Offer",
    "The Last Rivet",
  ]);
  await expect(table.getByRole("row", { name: /The plans are stolen/ })).toContainText("Off the page");
  await expect(page.getByRole("button", { name: /^Move “/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/outline\/table\?order=time$/);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  // The cards too, and the choice is remembered.
  await page.getByRole("radiogroup", { name: "Show the outline as" }).getByText("Cards", { exact: true }).click();
  const cards = page.getByRole("list", { name: "In story time" }).getByRole("listitem");
  await expect(cards).toHaveCount(11);
  await expect(cards.nth(0)).toHaveAccessibleName("The flood of '09, off the page");
  await expect(cards.nth(1)).toHaveAccessibleName("The Flood");
  await axe(page);
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Story map" }).click();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Outline" }).click();
  await expect(page.getByRole("list", { name: "In story time" })).toBeVisible();

  await page.getByRole("radiogroup", { name: "Order" }).getByText("Reading order", { exact: true }).click();
  await expect(page.getByRole("list", { name: "In story time" })).toHaveCount(0);
  await expect(page.getByRole("listitem", { name: "The flood of '09, off the page" })).toHaveCount(0);
});

test("an event written as a scene: the scene made from it opens, and the event kept names it, or goes", async ({ page, app }) => {
  const dir = await openNovel(page, app, (d) => {
    const scene = join(d, "manuscript/01-return/01-arrival/01-the-station.md");
    writeFileSync(scene, `${readFileSync(scene, "utf8").trimEnd()}\n\nShe thought of [the flood](#evt_9ab3kd).\n`);
  });

  // Mentioned in the prose: kept.
  await openEvent(page, "The flood of '09");
  await page.getByRole("button", { name: "Write it as a scene" }).click();
  let dialog = page.getByRole("dialog", { name: "Write “The flood of '09” as a scene" });
  await expect(dialog.getByRole("radio", { name: "Remove it: the scene takes its place" })).toBeDisabled();
  await expect(dialog).toContainText("The story mentions it, so it's kept.");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Kept, naming its scene: in the chapter chosen, with the event's details.
  await openEvent(page, "The plans are stolen");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("write “the plans are stolen” as a scene");
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog", { name: "Write “The plans are stolen” as a scene" });
  await dialog.getByRole("combobox", { name: "Chapter" }).selectOption("ch_01dde6");
  await dialog.getByRole("button", { name: "Write the scene" }).click();
  await expect(page.getByRole("textbox", { name: /Scene text/ })).toBeVisible();
  const event = readFileSync(join(dir, "bible/events/the-plans-are-stolen.md"), "utf8");
  const sceneId = /\nscene: (sc_[0-9a-z]{6})\n/.exec(event)?.[1];
  expect(sceneId).toBeDefined();
  const scene = readFileSync(join(dir, "manuscript/01-return/02-old-debts/03-the-plans-are-stolen.md"), "utf8");
  expect(scene).toBe(`---\nid: ${sceneId}\ntitle: The plans are stolen\nsynopsis: Off page. Ben uses Tomas's key.\nstatus: idea\ncharacters:\n  - char_b3n0vs\nlocations:\n  - loc_w0rk5p\nplotlines:\n  - plot_h315tz\n  - plot_gr1efa\nwhen:\n  day: -5\n---\n`);
  await expect(page.getByText("Dramatizes the off-page event “The plans are stolen”.")).toBeVisible();
  await openEvent(page, "The plans are stolen");
  await expect(page.getByRole("region", { name: "In story time" })).toContainText("Written as the scene “The plans are stolen”.");

  // Removed: the scene takes its place.
  await openEvent(page, "Ada leaves for the polytechnic");
  await page.getByRole("button", { name: "Write it as a scene" }).click();
  dialog = page.getByRole("dialog", { name: "Write “Ada leaves for the polytechnic” as a scene" });
  await dialog.getByRole("radio", { name: "Remove it: the scene takes its place" }).check();
  await dialog.getByRole("button", { name: "Write the scene" }).click();
  await expect(page.getByRole("textbox", { name: /Scene text/ })).toBeVisible();
  expect(existsSync(join(dir, "bible/events/ada-leaves-for-the-polytechnic.md"))).toBe(false);
  expect(app.git(dir, "log", "-1", "--format=%s").trim()).toBe("Manuscript: write “Ada leaves for the polytechnic” as a scene, removing the event");
  expect(app.git(dir, "status", "--porcelain")).toBe("");
});

test("events where the story's facts show: @ mentions and their cards, profiles' Off the page, the scene card's From the story", async ({ page, app }) => {
  const dir = await openNovel(page, app);
  const station = () => readFileSync(join(dir, "manuscript/01-return/01-arrival/01-the-station.md"), "utf8");

  // @ offers events after the entries, under Off the page.
  await page.getByRole("textbox", { name: "Chapter text" }).getByText(/the way you count stitches in a wound\./).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Since @flood");
  const suggestions = page.getByRole("listbox", { name: "Mention suggestions" });
  await expect(suggestions.getByRole("option", { selected: true })).toHaveText(/The flood of '09/);
  await expect(suggestions).toContainText("Off the page");
  await page.keyboard.press("Enter");
  await page.keyboard.type("nothing.");
  await expect.poll(station, { timeout: 10_000 }).toContain("in a wound. Since [The flood of '09](#evt_9ab3kd) nothing.");
  // Not a character or a place: the scene's lists are left alone.
  expect(station()).not.toMatch(/^(characters|locations|entities):.*evt_/m);

  // Its card, by keyboard, and on to the Entry tab.
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < "nothing.".length; i++) await page.keyboard.press("ArrowLeft");
  await selectionSettled(page);
  await page.keyboard.press("Alt+Enter");
  const card = page.getByRole("dialog", { name: "The flood of '09" });
  await expect(card).toBeFocused();
  await expect(card).toContainText("Off the page");
  await expect(card).toContainText("2 Nov 2009 · 3 days");
  await expect(card).toContainText("whoAda Varn, Ben Varn, Tomas Hale");
  await axe(page);
  await card.getByRole("button", { name: "Open event" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "The flood of '09" })).toBeVisible();
  // The tab says what it's showing (#222).
  await expect(page.getByRole("tab", { name: "Event" })).toHaveAttribute("aria-selected", "true");

  // The scene card says where the scene stands against the events around it.
  await page.getByRole("tab", { name: "Scene" }).click();
  await expect(page.getByText("6 days after the off-page event “The plans are stolen”.")).toBeVisible();

  // A profile's Off the page line opens the event.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("character: ben varn");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "The plans are stolen" }).last().click();
  await expect(page.getByRole("heading", { level: 1, name: "The plans are stolen" })).toBeVisible();
});

test("the Story bible shows off-page events as cards, searched and sorted with the entries", async ({ page, app }) => {
  await openNovel(page, app);
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Story bible" }).click();
  const group = page.locator("section#off-the-page");
  await group.scrollIntoViewIfNeeded();
  await expect(group).toHaveAccessibleName(/^Off the page\s*3$/);
  await expect(group).toBeInViewport();
  const cards = group.getByRole("listitem");
  await expect(cards.getByRole("link")).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("2 Nov 2009 · 3 days");
  await expect(cards.nth(0)).toContainText("The flood of '09");
  await expect(cards.nth(0)).toContainText("Ada Varn, Ben Varn, Tomas Hale, The Varn Bridge");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }

  // Sorted by title with the entries; searched by title or note.
  await page.getByRole("combobox", { name: "Sort" }).selectOption("name");
  await expect(cards.getByRole("link").locator("span.font-semibold")).toHaveText(["Ada leaves for the polytechnic", "The flood of '09", "The plans are stolen"]);
  await page.getByRole("searchbox", { name: "Search the bible" }).fill("pneumonia");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("The flood of '09");
  await cards.getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "The flood of '09" })).toBeVisible();
});
