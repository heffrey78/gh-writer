import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test, type App } from "./fixtures.ts";

const out = (name: string) => fileURLToPath(new URL(`../../../docs/screenshots/${name}.png`, import.meta.url));

/** Let transitions and fonts settle, then shoot. */
async function shoot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  await page.mouse.move(0, 899);
  await page.screenshot({ path: out(name) });
}

async function open(page: Page, app: App) {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return new URL(page.url()).pathname.split("/")[2]!;
}

test("the writing view, light and dark, with a mention card", async ({ page, app }) => {
  await open(page, app);
  await page.getByRole("textbox", { name: "Chapter text" }).evaluate((e) => (e as HTMLElement).blur());
  await shoot(page, "writing");
  await page.getByRole("textbox", { name: "Chapter text" }).locator("a, [data-mention], .mention").first().hover();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out("mention-card") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.mouse.move(0, 899);
  await page.waitForTimeout(500);
  await shoot(page, "writing-dark");
});

test("planning views", async ({ page, app }) => {
  const id = await open(page, app);
  for (const [path, name] of [
    ["outline/table", "outline"],
    ["outline/cards", "outline-cards"],
    ["story-map/plotlines", "plotlines"],
    ["story-map/presence", "presence"],
    ["story-map/timeline", "timeline"],
    ["relationships", "relationships"],
  ] as const) {
    await page.goto(new URL(`/novels/${id}/${path}`, app.url).href);
    await page.waitForTimeout(1200);
    await shoot(page, name);
  }
});

test("drafts: versions with their checkpoints", async ({ page, app }) => {
  await open(page, app);
  const drafts = page.getByRole("dialog", { name: "Drafts" });
  await page.getByRole("button", { name: "Drafts: Main version is open" }).click();
  await drafts.getByRole("textbox", { name: "New checkpoint" }).fill("First draft");
  await drafts.getByRole("button", { name: "Make checkpoint" }).click();
  await expect(drafts.getByRole("listitem")).toHaveCount(1);
  await drafts.getByRole("textbox", { name: "New version" }).fill("A darker ending");
  await drafts.getByRole("button", { name: "Start version" }).click();
  await expect(page.getByRole("button", { name: "Drafts: A darker ending is open" })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: "Drafts: A darker ending is open" }).click();
  await drafts.getByRole("textbox", { name: "New checkpoint" }).fill("Bridge falls");
  await drafts.getByRole("button", { name: "Make checkpoint" }).click();
  await expect(drafts.getByRole("group", { name: "A darker ending" }).getByRole("listitem")).toHaveCount(1);
  await drafts.getByRole("button", { name: /Checkpoints in “Main version”/ }).click();
  await drafts.getByRole("textbox", { name: "New checkpoint" }).blur();
  await shoot(page, "drafts");
});

test("the story bible", async ({ page, app }) => {
  await open(page, app);
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Story bible" }).click();
  await page.getByRole("main").getByRole("link", { name: "Ada Varn" }).first().click();
  await page.waitForTimeout(800);
  await shoot(page, "bible");
});

test("the command palette and compiling", async ({ page, app }) => {
  await open(page, app);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("new");
  await page.waitForTimeout(300);
  await shoot(page, "palette");
  await page.keyboard.press("Escape");
  await page.getByRole("banner").getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Compile…" }).click();
  await page.getByRole("radio", { name: "Some chapters" }).check();
  await page.getByRole("combobox", { name: "to" }).selectOption({ label: "Old Debts" });
  await shoot(page, "compile");
});

test("issues on GitHub", async ({ page, app }) => {
  const id = await open(page, app);
  const headers = { origin: app.url };
  await page.request.post(`${app.url}/api/github/device`, { headers });
  app.github.approve();
  await expect.poll(async () => ((await (await page.request.post(`${app.url}/api/github/device/poll`, { headers })).json()) as { status: string }).status).toBe("done");
  expect((await page.request.post(`${app.url}/api/novels/${id}/publish`, { data: { name: "varn" }, headers })).ok()).toBe(true);
  const repo = app.github.issues("ada", "varn");
  repo.milestones.push({ number: 1, title: "Second draft", state: "open" });
  const hole = app.github.addIssue("ada", "varn", { title: "Ada can't be on the bridge and at the station", labels: ["kind/continuity", "character/ada-varn"], milestone: 1, body: "The clock in chapter two says otherwise." });
  app.github.comment(hole, "Move the bridge scene to the next morning?");
  app.github.addIssue("ada", "varn", { title: "Research 1912 tide tables for the crossing", labels: ["kind/research", "plotline/the-sale"], milestone: 1 });
  app.github.addIssue("ada", "varn", { title: "Why does Mirela trust Ada so quickly?", labels: ["kind/plot-hole", "character/mirela-kost"] });
  app.github.addIssue("ada", "varn", { title: "Tighten the ledger scene", labels: ["kind/revision"] });
  await page.reload();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Issues" }).click();
  await page.waitForTimeout(1200);
  await shoot(page, "issues");
});

test("comparing a version with the main one", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("button", { name: "Drafts: Main version is open" }).click();
  await page.getByRole("textbox", { name: "New version" }).fill("A darker ending");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Drafts: A darker ending is open" })).toBeVisible();
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const station = join(dir, "manuscript/01-return/01-arrival/01-the-station.md");
  writeFileSync(
    station,
    readFileSync(station, "utf8")
      .replace("counted them twice, the way you count stitches in a wound", "counted them three times, the way her father had counted rivets")
      .replace("Twelve years had not moved the station clock.", "Twelve years had not moved the station clock, and nobody had wound it either."),
  );
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toContainText("counted rivets");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: "Drafts: A darker ending is open" }).click();
  await page.getByRole("button", { name: "Compare “A darker ending” with the main version" }).click();
  await page.getByRole("button", { name: /The Station/ }).click();
  await expect(page.locator("ins").first()).toBeVisible();
  await shoot(page, "compare");
});
