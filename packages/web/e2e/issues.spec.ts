import { passageIssueBody, readAnchor } from "@gh-writer/core";
import type { Page } from "@playwright/test";
import { axe, expect, test, type App } from "./fixtures.ts";

const views = (page: Page) => page.getByRole("navigation", { name: "Views" });
const issueList = (page: Page) => page.getByRole("list", { name: "Issues" });
const notice = (page: Page) => page.getByRole("status").filter({ has: page.getByRole("button", { name: "Dismiss" }) });

/** The sample novel, open in the app, local only. */
async function open(page: Page, app: App) {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  return new URL(page.url()).pathname.split("/")[2]!;
}

/** Signed in to the (fake) GitHub through the device flow, without the dialog. */
async function signIn(page: Page, app: App) {
  const headers = { origin: app.url };
  expect((await page.request.post(`${app.url}/api/github/device`, { headers })).ok()).toBe(true);
  app.github.approve();
  await expect.poll(async () => ((await (await page.request.post(`${app.url}/api/github/device/poll`, { headers })).json()) as { status: string }).status).toBe("done");
}

/** The open novel put on GitHub as ada/varn, signed in. */
async function onGitHub(page: Page, app: App, id: string) {
  await signIn(page, app);
  const r = await page.request.post(`${app.url}/api/novels/${id}/publish`, { data: { name: "varn" }, headers: { origin: app.url } });
  expect(r.ok(), await r.text()).toBe(true);
  return app.github.issues("ada", "varn");
}

test("a local novel has no issues; put on GitHub, they appear in the same session", async ({ page, app }) => {
  const id = await open(page, app);
  await expect(views(page).getByRole("link", { name: "Issues" })).toHaveCount(0);
  await page.goto(`${app.url}/novels/${id}/issues`);
  await expect(page).toHaveURL(/\/chapter\//);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("new issue");
  await expect(page.getByRole("option", { name: /New issue/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Nor a way to raise one from a passage.
  const passage = page.getByRole("textbox", { name: "Chapter text" }).getByText(/the way you count stitches in a wound\./);
  await passage.click({ clickCount: 3 });
  await passage.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Selected text" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("raise an issue");
  await expect(page.getByRole("option", { name: /Raise an issue/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await onGitHub(page, app, id);
  await expect(views(page).getByRole("link", { name: "Issues" })).toBeVisible();
  await views(page).getByRole("link", { name: "Issues" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Issues" })).toBeVisible();
  await expect(page.getByText("No open issues.")).toBeVisible();
});

test("lists, filters, creates, comments on, labels, edits, closes and reopens issues on GitHub", async ({ page, app }) => {
  const id = await open(page, app);
  const repo = await onGitHub(page, app, id);
  repo.milestones.push({ number: 1, title: "Second draft", state: "open" });
  const hole = app.github.addIssue("ada", "varn", { title: "Ada can't be on the bridge and at the station", labels: ["kind/continuity", "second-pass"], milestone: 1, body: "See **chapter two**." });
  app.github.comment(hole, "The clock says otherwise.");
  app.github.addIssue("ada", "varn", { title: "Research 1920s rail timetables", labels: ["kind/research"] });
  const done = app.github.addIssue("ada", "varn", { title: "Rename the ferry" });
  app.github.touch(done, { state: "closed" });

  await views(page).getByRole("link", { name: "Issues" }).click();
  await expect(issueList(page).getByRole("link")).toHaveText(["Research 1920s rail timetables", "Ada can't be on the bridge and at the station"]);
  await axe(page);
  await page.getByRole("searchbox", { name: "Search issues" }).fill("clock");
  await expect(issueList(page).getByRole("link")).toHaveText(["Ada can't be on the bridge and at the station"]);
  await expect(page).toHaveURL(/q=clock/);
  await page.getByRole("searchbox", { name: "Search issues" }).fill("");
  // Kinds, by name.
  await expect(issueList(page)).toContainText("Research");
  await page.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Research" });
  await expect(issueList(page).getByRole("link")).toHaveText(["Research 1920s rail timetables"]);
  await expect(page).toHaveURL(/kind=research/);
  await page.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Any kind" });
  // GitHub's software labels aren't offered (nothing here uses them).
  repo.labels.push({ name: "bug", color: "d73a4a", description: "" });
  await page.getByRole("button", { name: "Refresh from GitHub" }).click();
  await page.getByRole("button", { name: /^Filter by label/ }).click();
  await expect(page.getByRole("option", { name: "bug" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "second-pass" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "State" }).selectOption("closed");
  await expect(issueList(page).getByRole("link")).toHaveText(["Rename the ferry"]);
  await page.getByRole("combobox", { name: "State" }).selectOption("open");
  await page.getByRole("combobox", { name: "Milestone" }).selectOption({ label: "Second draft" });
  await expect(issueList(page).getByRole("link")).toHaveText(["Ada can't be on the bridge and at the station"]);
  await page.getByRole("combobox", { name: "Milestone" }).selectOption({ label: "Any milestone" });

  // A new one, by keyboard.
  await page.getByRole("button", { name: "New issue" }).click();
  const form = page.getByRole("dialog", { name: "New issue" });
  await page.keyboard.type("The ferry's name changes in chapter four");
  await form.getByRole("textbox", { name: "Details" }).fill("It's *Marta* in chapter one.");
  await form.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Continuity" });
  await form.getByRole("button", { name: /^Add to labels/ }).click();
  await page.keyboard.type("second-pass");
  await page.keyboard.press("Enter");
  await axe(page);
  // The list stays open for more; Escape closes it, not the form.
  await page.keyboard.press("Escape");
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Create issue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /The ferry's name changes in chapter four #4/ })).toBeVisible();
  await expect(page).toHaveURL(/\/issues\/4$/);
  expect(repo.issues.find((i) => i.number === 4)).toMatchObject({ title: "The ferry's name changes in chapter four", labels: ["second-pass", "kind/continuity"] });
  await expect(page.locator(".ghw-markdown em")).toHaveText("Marta");

  await page.getByRole("textbox", { name: "Add a comment" }).fill("Fixed in chapter four.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("list").filter({ hasText: "Fixed in chapter four." })).toBeVisible();
  expect(repo.issues.find((i) => i.number === 4)?.comments.map((c) => c.body)).toEqual(["Fixed in chapter four."]);

  const about = page.getByRole("complementary", { name: "About this issue" });
  await about.getByRole("button", { name: /^Add to labels/ }).click();
  await page.keyboard.type("loc/ferry");
  await page.getByRole("option", { name: "New label “loc/ferry”" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.labels).toEqual(["second-pass", "loc/ferry", "kind/continuity"]);
  await about.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Revision" });
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.labels).toEqual(["second-pass", "loc/ferry", "kind/revision"]);
  expect(repo.labels.find((l) => l.name === "kind/revision")?.color).toBe("7057ff");
  // Chosen labels stay in the list, checked: choosing one again takes it off, and its name isn't offered as new.
  await about.getByRole("button", { name: /^Add to labels/ }).click();
  await expect(page.getByRole("option", { name: "second-pass chosen", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "loc/ferry chosen", exact: true })).toBeVisible();
  await page.keyboard.type("second-pass");
  await expect(page.getByRole("option", { name: /New label/ })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.labels).toEqual(["loc/ferry", "kind/revision"]);
  // Still listed, now unchecked, and the list stays open for the next.
  await expect(page.getByRole("option", { name: "second-pass", exact: true })).toBeVisible();
  await page.keyboard.type("second-pass");
  await page.keyboard.press("Enter");
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.labels).toEqual(["loc/ferry", "second-pass", "kind/revision"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option", { name: "second-pass chosen", exact: true })).toHaveCount(0);
  await about.getByRole("combobox", { name: "Milestone" }).selectOption({ label: "Second draft" });
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.milestone).toBe(1);
  // A new milestone, from here.
  await about.getByRole("combobox", { name: "Milestone" }).selectOption({ label: "New milestone…" });
  await page.getByRole("dialog", { name: "New milestone" }).getByRole("textbox", { name: "Name" }).fill("To the editor");
  await page.keyboard.press("Enter");
  await expect.poll(() => repo.milestones.map((m) => m.title)).toEqual(["Second draft", "To the editor"]);
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.milestone).toBe(2);
  await expect(about.getByRole("combobox", { name: "Milestone" })).toHaveValue("2");

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("The ferry is Marta, not Martha");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /The ferry is Marta, not Martha/ })).toBeVisible();

  await page.getByRole("button", { name: "Close issue" }).click();
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.state).toBe("closed");
  await page.getByRole("button", { name: "Reopen issue" }).click();
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.state).toBe("open");
  expect(repo.issues.find((i) => i.number === 4)?.title).toBe("The ferry is Marta, not Martha");
  await expect(about.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", `${app.github.url}/ada/varn/issues/4`);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});

test("a change on github.com shows after a sync", async ({ page, app }) => {
  const id = await open(page, app);
  const repo = await onGitHub(page, app, id);
  const issue = app.github.addIssue("ada", "varn", { title: "Check the tide tables" });
  await views(page).getByRole("link", { name: "Issues" }).click();
  await expect(issueList(page).getByRole("link")).toHaveText(["Check the tide tables"]);
  app.github.touch(issue, { title: "Check the 1912 tide tables" });
  app.github.addIssue("ada", "varn", { title: "Who owns the toll house?" });
  expect(repo.issues).toHaveLength(2);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("sync now");
  await page.keyboard.press("Enter");
  await expect(issueList(page).getByRole("link")).toHaveText(["Who owns the toll house?", "Check the 1912 tide tables"]);
});

test("while GitHub is refusing requests, changes wait and are sent later", async ({ page, app }) => {
  const id = await open(page, app);
  const repo = await onGitHub(page, app, id);
  app.github.addIssue("ada", "varn", { title: "Check the tide tables" });
  await page.goto(`${app.url}/novels/${id}/issues/1`);
  await expect(page.getByRole("heading", { level: 1, name: /Check the tide tables/ })).toBeVisible();
  app.github.rateLimitedUntil = Math.floor(Date.now() / 1000) + 3600;
  await page.getByRole("textbox", { name: "Add a comment" }).fill("High tide at six.");
  await page.getByRole("button", { name: "Comment" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "High tide at six." })).toContainText("not on GitHub yet");
  await expect(page.getByText("Changes not on GitHub yet")).toBeVisible();
  await expect(page.getByText(/request limit is reached until/)).toBeVisible();
  await expect(page.getByText("1 change waiting to be sent.", { exact: false })).toBeVisible();
  expect(repo.issues[0]!.comments).toEqual([]);
  app.github.rateLimitedUntil = undefined;
  await page.getByRole("link", { name: "All issues" }).click();
  await page.getByRole("button", { name: "Refresh from GitHub" }).click();
  await expect.poll(() => repo.issues[0]!.comments.map((c) => c.body)).toEqual(["High tide at six."]);
  await expect(page.getByText(/Up to date with GitHub/)).toBeVisible();
  await expect(page.getByText(/waiting to be sent/)).toHaveCount(0);
});

test("signed out, the issues are still there and a change offers to reconnect", async ({ page, app }) => {
  const id = await open(page, app);
  await onGitHub(page, app, id);
  app.github.addIssue("ada", "varn", { title: "Check the tide tables" });
  await views(page).getByRole("link", { name: "Issues" }).click();
  await expect(issueList(page).getByRole("link")).toHaveText(["Check the tide tables"]);
  app.github.revoke(app.github.deviceToken);
  await issueList(page).getByRole("link", { name: "Check the tide tables" }).click();
  await page.getByRole("button", { name: "Close issue" }).click();
  await expect(notice(page)).toContainText("Connect to GitHub again");
  await expect(notice(page).getByRole("button", { name: "Reconnect GitHub" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "isn't signed in to GitHub" })).toBeVisible();
  await page.getByRole("link", { name: "All issues" }).click();
  await expect(issueList(page).getByRole("link")).toHaveText(["Check the tide tables"]);
});

test("raises an issue about selected text, quoted, linked and anchored, without leaving the text", async ({ page, app }) => {
  const id = await open(page, app);
  const repo = await onGitHub(page, app, id);
  await expect(views(page).getByRole("link", { name: "Issues" })).toBeVisible();
  const text = page.getByRole("textbox", { name: "Chapter text" });
  const passage = text.getByText(/the way you count stitches in a wound\./);
  await passage.click({ clickCount: 3 });
  await passage.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Selected text" });
  await expect(menu.getByRole("menuitem", { name: "Raise an issue…" })).toBeFocused();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Raise an issue" });
  await expect(panel).toContainText("She stood with her bag at her feet and counted them twice");
  await expect(panel).toContainText("in “The Station”");
  await expect(panel.getByRole("textbox", { name: "Title" })).toBeFocused();
  await axe(page);
  await panel.getByText("Continuity").click();
  // Labelled to start with by who and what the scene is about, by name; any can come off.
  await expect(panel.getByRole("list", { name: "Labels" }).getByRole("listitem")).toHaveText(["Ada Varn", "Varn Station", "The Sale", "Inheritance"]);
  await panel.getByRole("button", { name: "Remove label “Inheritance”" }).click();
  await panel.getByRole("textbox", { name: "Title" }).fill("Who counted the flags?");
  await panel.getByRole("textbox", { name: "Note" }).fill("Ben counts them in chapter two.");
  await panel.getByRole("textbox", { name: "Title" }).press("Enter");
  await expect(notice(page)).toContainText("Raised #1 “Who counted the flags?”.");
  await expect(panel).toHaveCount(0);
  await expect(text).toBeFocused();
  const url = page.url();

  const issue = repo.issues[0]!;
  expect(issue).toMatchObject({ title: "Who counted the flags?", labels: ["kind/continuity", "char/ada-varn", "loc/varn-station", "plot/the-sale"] });
  // The entries' labels, made with their type's colour and the entry's name and ID.
  expect(repo.labels.find((l) => l.name === "char/ada-varn")).toEqual({ name: "char/ada-varn", color: "1f77b4", description: "Ada Varn · char_7f3k2q" });
  expect(repo.labels.find((l) => l.name === "loc/varn-station")?.color).toBe("2ca02c");
  expect(issue.body).toContain("Ben counts them in chapter two.\n\n> She stood with her bag at her feet and counted them twice, the way you count stitches in a wound.\n\nFrom [*The Station*](");
  expect(issue.body).toMatch(new RegExp(`\\(${app.github.url}/ada/varn/blob/[0-9a-f]{40}/manuscript/01-return/01-arrival/01-the-station\\.md\\?plain=1#L\\d+\\)`));
  expect(readAnchor(issue.body)).toMatchObject({ scene: "sc_5tat1n", quote: "She stood with her bag at her feet and counted them twice, the way you count stitches in a wound.", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  expect(repo.labels.find((l) => l.name === "kind/continuity")?.color).toBe("fbca04");
  expect(page.url()).toBe(url);

  // From the palette too.
  await text.getByText(/Twelve years had not moved the station clock/).click({ clickCount: 3 });
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("raise an issue");
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Twelve years had not moved the station clock");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(text).toBeFocused();
});

test("open issues sit beside their passages, follow the text, open beside it, and go when closed or orphaned", async ({ page, app }) => {
  const id = await open(page, app);
  await onGitHub(page, app, id);
  await expect(views(page).getByRole("link", { name: "Issues" })).toBeVisible();
  const quote = "She stood with her bag at her feet and counted them twice, the way you count stitches in a wound.";
  const issue = app.github.addIssue("ada", "varn", {
    title: "Who counted the flags?",
    labels: ["kind/continuity"],
    body: passageIssueBody({ details: "Ben counts them in chapter two.", quote, sceneTitle: "The Station", anchor: { scene: "sc_5tat1n", quote } }),
  });
  const refresh = () => page.request.post(`${app.url}/api/novels/${id}/issues/refresh`, { headers: { origin: app.url } });
  await refresh();

  const text = page.getByRole("textbox", { name: "Chapter text" });
  const marker = text.getByRole("button", { name: "Issue #1: Who counted the flags?" });
  await expect(marker).toBeVisible();
  await marker.hover();
  await expect(text.locator('[data-ghw-issue="1"].is-active')).toHaveText(quote);
  await axe(page);

  // Paragraphs written above: the marker follows its passage.
  await text.getByText(/^The train gave up the last of its heat/).click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type("A new first paragraph.");
  await page.keyboard.press("Enter");
  await expect(text.locator('[data-ghw-issue="1"]')).toHaveText(quote);
  await expect(marker).toBeVisible();

  // Opened beside the text, and back.
  const url = page.url();
  await marker.click();
  const panel = page.getByRole("complementary", { name: /Who counted the flags\?/ });
  await expect(panel).toContainText("Ben counts them in chapter two.");
  await panel.getByRole("textbox", { name: "Add a comment" }).fill("Checked: he counts them once.");
  await panel.getByRole("button", { name: "Comment" }).click();
  await expect.poll(() => issue.comments.map((c) => c.body)).toEqual(["Checked: he counts them once."]);
  expect(page.url()).toBe(url);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(text).toBeFocused();

  // By keyboard: the shortcut beside the passage.
  await text.getByText(/the way you count stitches/).click();
  await expect(text).toBeFocused();
  // Under heavy load a key press can arrive before the editor's ready for it: press again if so.
  await expect(async () => {
    if (!(await panel.isVisible())) await page.keyboard.press("ControlOrMeta+Alt+i");
    await expect(panel).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Escape");

  // Closed on github.com: gone after the next refresh.
  app.github.touch(issue, { state: "closed" });
  await refresh();
  await expect(marker).toHaveCount(0);

  // Reopened, then its passage deleted: orphaned, listed so with its quote.
  app.github.touch(issue, { state: "open" });
  await refresh();
  await expect(marker).toBeVisible();
  await text.getByText(/the way you count stitches/).click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await expect(marker).toHaveCount(0);
  await views(page).getByRole("link", { name: "Issues" }).click();
  await expect(issueList(page).getByRole("listitem").filter({ hasText: "Who counted the flags?" })).toContainText(`Orphaned: the passage it's about is gone from “The Station”. It read: “${quote}”`);
});

test("milestones: made, renamed, closed and reopened from the Issues view", async ({ page, app }) => {
  const id = await open(page, app);
  const repo = await onGitHub(page, app, id);
  await views(page).getByRole("link", { name: "Issues" }).click();
  await page.getByRole("button", { name: "Milestones" }).click();
  const dialog = page.getByRole("dialog", { name: "Milestones" });
  await expect(dialog).toContainText("No milestones yet");
  await dialog.getByRole("button", { name: "New milestone…" }).click();
  await page.keyboard.type("First draft");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("list", { name: "Milestones" })).toContainText("First draft");
  await axe(page);
  await dialog.getByRole("button", { name: "Rename “First draft”" }).click();
  await dialog.getByRole("textbox", { name: "New name for “First draft”" }).fill("First full draft");
  await page.keyboard.press("Enter");
  await expect.poll(() => repo.milestones.map((m) => m.title)).toEqual(["First full draft"]);
  await dialog.getByRole("button", { name: "Close “First full draft”" }).click();
  await expect.poll(() => repo.milestones[0]?.state).toBe("closed");
  await dialog.getByRole("button", { name: "Reopen “First full draft”" }).click();
  await expect.poll(() => repo.milestones[0]?.state).toBe("open");
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("combobox", { name: "Milestone" }).selectOption({ label: "First full draft" });
  await expect(page).toHaveURL(/milestone=1/);
  // Labels on a new repository are the writing kinds, not GitHub's software labels.
  expect(repo.labels.map((l) => l.name)).toEqual(["kind/plot-hole", "kind/continuity", "kind/research", "kind/idea", "kind/revision"]);
});

test("bible entries as labels: picked by name, shown by name, filtered by", async ({ page, app }) => {
  const id = await open(page, app);
  const repo = await onGitHub(page, app, id);
  app.github.addIssue("ada", "varn", { title: "Who owns the toll house?" });
  app.github.addIssue("ada", "varn", { title: "The ferry's name" });
  await views(page).getByRole("link", { name: "Issues" }).click();
  await issueList(page).getByRole("link", { name: "Who owns the toll house?" }).click();
  const about = page.getByRole("complementary", { name: "About this issue" });
  await about.getByRole("button", { name: /^Add to labels/ }).click();
  await expect(page.getByRole("group", { name: "Characters" }).getByRole("option")).toContainText(["Ada Varn", "Ben Varn", "Mirela Kost", "Tomas Hale"]);
  await page.keyboard.type("Ben");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect.poll(() => repo.issues.find((i) => i.number === 1)?.labels).toEqual(["char/ben-varn"]);
  await expect(about.getByRole("list", { name: "Labels" })).toHaveText("Ben Varn");
  expect(repo.labels.find((l) => l.name === "char/ben-varn")?.description).toBe("Ben Varn · char_b3n0vs");

  await page.getByRole("link", { name: "All issues" }).click();
  await expect(issueList(page).getByRole("listitem").filter({ hasText: "Who owns the toll house?" })).toContainText("Ben Varn");
  await page.getByRole("button", { name: /^Filter by label/ }).click();
  await page.keyboard.type("Ben Varn");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(issueList(page).getByRole("link")).toHaveText(["Who owns the toll house?"]);
  await expect(page).toHaveURL(/labels=char%2Fben-varn|labels=char\/ben-varn/);
});

test("an entry's open issues on its page, a scene's in its details; renames follow; deleting offers to remove the label", async ({ page, app }) => {
  const id = await open(page, app);
  const repo = await onGitHub(page, app, id);
  await expect(views(page).getByRole("link", { name: "Issues" })).toBeVisible();
  app.github.addIssue("ada", "varn", { title: "Where was Ada at noon?", labels: ["char/ada-varn"] });
  const coat = app.github.addIssue("ada", "varn", { title: "Ada's coat", labels: ["char/ada-varn"] });
  app.github.touch(coat, { state: "closed" });
  app.github.addIssue("ada", "varn", { title: "Ben's debt", labels: ["char/ben-varn"] });
  const quote = "She stood with her bag at her feet and counted them twice, the way you count stitches in a wound.";
  app.github.addIssue("ada", "varn", { title: "Who counted the flags?", body: passageIssueBody({ details: "", quote, sceneTitle: "The Station", anchor: { scene: "sc_5tat1n", quote } }) });
  const headers = { origin: app.url };
  await page.request.post(`${app.url}/api/novels/${id}/issues/refresh`, { headers });

  // Ada's entry: her open issues, as label:char/ada-varn finds them on GitHub.
  await page.goto(`${app.url}/novels/${id}/bible/char_7f3k2q`);
  const openIssues = page.getByRole("region", { name: /^Open issues/ });
  const onGitHubToo = repo.issues.filter((i) => i.state === "open" && i.labels.includes("char/ada-varn")).map((i) => i.title);
  await expect(openIssues.getByRole("listitem")).toHaveText(onGitHubToo.map((t) => new RegExp(`^${t.replace(/[?]/g, "\\?")}`)));
  await expect(openIssues).toContainText("On GitHub it's the label char/ada-varn.");
  await axe(page);

  // Renamed: her label follows on GitHub, her issues with it.
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Ada Kost");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect.poll(() => repo.labels.map((l) => l.name), { timeout: 10_000 }).toContain("char/ada-kost");
  expect(repo.labels.map((l) => l.name)).not.toContain("char/ada-varn");
  expect(repo.issues.find((i) => i.title === "Where was Ada at noon?")?.labels).toEqual(["char/ada-kost"]);
  await expect(openIssues).toContainText("On GitHub it's the label char/ada-kost.");
  await expect(openIssues.getByRole("listitem")).toHaveText([/^Where was Ada at noon\?/]);

  // The Station's details: the issue about its passage, opened beside the text.
  await page.getByRole("tree", { name: "Manuscript" }).getByRole("treeitem", { name: /^The Station,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene text" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("show scene details");
  await page.keyboard.press("Enter");
  const details = page.getByRole("complementary", { name: "Details of “The Station”" });
  await details.getByRole("group", { name: "Open issues" }).getByRole("button", { name: "Who counted the flags?" }).click();
  await expect(page.getByRole("complementary", { name: /Who counted the flags\?/ })).toBeVisible();

  // An entry deleted: its label can go too.
  const made = (await (await page.request.post(`${app.url}/api/novels/${id}/bible/entities`, { data: { type: "character", name: "Lena Dray" }, headers })).json()) as { id: string };
  await page.request.post(`${app.url}/api/novels/${id}/issues/labels`, { data: { name: "char/lena-dray", color: "1f77b4", description: `Lena Dray · ${made.id}` }, headers });
  await page.goto(`${app.url}/novels/${id}/bible/${made.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Lena Dray" })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(notice(page)).toContainText("Deleted “Lena Dray”. Its label char/lena-dray is still on GitHub");
  await notice(page).getByRole("button", { name: "Remove label" }).click();
  await expect.poll(() => repo.labels.map((l) => l.name)).not.toContain("char/lena-dray");
});
