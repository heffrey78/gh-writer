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

test("the right sidebar: the Scene card with details pinned, and the Entry tab", async ({ page, app }) => {
  await open(page, app);
  const card = page.getByRole("region", { name: "Details of “The Station”" });
  await card.getByRole("button", { name: "Pin point of view under the scene titles" }).click();
  await card.getByRole("button", { name: "Pin when under the scene titles" }).click();
  await expect(page.locator(".ghw-pinned")).toHaveCount(2);
  await card.getByRole("heading", { level: 2 }).click();
  await shoot(page, "scene-card");
  await card.getByRole("button", { name: "Ada Varn" }).first().click();
  await expect(page.getByRole("region", { name: "Ada Varn" })).toBeFocused();
  await page.getByRole("region", { name: "Ada Varn" }).evaluate((e) => (e as HTMLElement).blur());
  await shoot(page, "entry-tab");
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
  await page.waitForTimeout(500);
  await shoot(page, "gallery");
  await page.getByRole("main").getByRole("link", { name: /^Ada Varn/ }).first().click();
  // Tall enough for her strip and arcs.
  await page.setViewportSize({ width: 1440, height: 1500 });
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

test("progress, with three weeks of writing", async ({ page, app }) => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = app.novelRepo("varn");
  const scenes = ["manuscript/02-the-sale/02-varn-holds/02-the-last-rivet.md", "manuscript/02-the-sale/01-night-crossing/02-the-flood.md", "manuscript/01-return/02-old-debts/02-bens-ledger.md"];
  const sentence = "The river kept its own counsel below the bridge, and the rivets held, one by one, through the long grey afternoon while the surveyors argued over their maps.";
  const day = (back: number) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    return `${d.toISOString().slice(0, 10)}T20:00:00`;
  };
  // The sample, started three weeks ago.
  execFileSync("git", ["-C", dir, "commit", "-q", "--amend", "--no-edit", "--date", day(21)], { env: { ...process.env, GIT_COMMITTER_DATE: day(21) } });
  for (let back = 20; back >= 1; back--) {
    if (back % 6 === 0) continue;
    const file = join(dir, scenes[back % scenes.length]!);
    const text = readFileSync(file, "utf8");
    const paragraphs = 1 + ((back * 7) % 5);
    writeFileSync(file, back % 5 === 0 ? text.replace(/\n\n[^\n]+\n$/, "\n") : text + `\n${Array.from({ length: paragraphs }, () => sentence).join("\n\n")}\n`);
    execFileSync("git", ["-C", dir, "commit", "-qam", `Draft ${back}`], { env: { ...process.env, GIT_AUTHOR_DATE: day(back), GIT_COMMITTER_DATE: day(back) } });
  }
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Progress" }).click();
  await page.getByRole("spinbutton", { name: "Words a day" }).fill("250");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "At a glance" })).toContainText("of 250 a day");
  await page.getByRole("heading", { level: 1, name: "Progress" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("progress") });
});
