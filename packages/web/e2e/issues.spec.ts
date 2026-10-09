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
  const hole = app.github.addIssue("ada", "varn", { title: "Ada can't be on the bridge and at the station", labels: ["kind/continuity"], milestone: 1, body: "See **chapter two**." });
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
  await page.getByRole("button", { name: /^Filter by label/ }).click();
  await page.keyboard.type("kind/research");
  await page.keyboard.press("Enter");
  await expect(issueList(page).getByRole("link")).toHaveText(["Research 1920s rail timetables"]);
  await page.getByRole("button", { name: "Remove label “kind/research”" }).click();
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
  await form.getByRole("button", { name: /^Add to labels/ }).click();
  await page.keyboard.type("kind/continuity");
  await page.keyboard.press("Enter");
  await axe(page);
  await form.getByRole("button", { name: "Create issue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /The ferry's name changes in chapter four #4/ })).toBeVisible();
  await expect(page).toHaveURL(/\/issues\/4$/);
  expect(repo.issues.find((i) => i.number === 4)).toMatchObject({ title: "The ferry's name changes in chapter four", labels: ["kind/continuity"] });
  await expect(page.locator(".ghw-markdown em")).toHaveText("Marta");

  await page.getByRole("textbox", { name: "Add a comment" }).fill("Fixed in chapter four.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("list").filter({ hasText: "Fixed in chapter four." })).toBeVisible();
  expect(repo.issues.find((i) => i.number === 4)?.comments.map((c) => c.body)).toEqual(["Fixed in chapter four."]);

  const about = page.getByRole("complementary", { name: "About this issue" });
  await about.getByRole("button", { name: /^Add to labels/ }).click();
  await page.keyboard.type("kind/revision");
  await page.getByRole("option", { name: "New label “kind/revision”" }).click();
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.labels).toEqual(["kind/continuity", "kind/revision"]);
  await about.getByRole("combobox", { name: "Milestone" }).selectOption({ label: "Second draft" });
  await expect.poll(() => repo.issues.find((i) => i.number === 4)?.milestone).toBe(1);

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
