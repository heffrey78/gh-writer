import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test, type App } from "./fixtures.ts";

/**
 * #2's promises, met the way an author would meet them: the real app on real servers, git only read
 * by the tests (never run on the author's behalf), and every check made on disk and in git history.
 */

const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";
const LEDGER = "manuscript/01-return/02-old-debts/02-bens-ledger.md";
const cli = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));

const text = (page: Page) => page.getByRole("textbox", { name: /^(Chapter|Scene) text$/ });
const badge = (page: Page) => page.getByRole("button", { name: /^Sync: / });

/** A remote holding the sample novel, this machine's clone of it, and another machine's. */
function machines(app: App) {
  const remote = app.bareRepo("varn.git");
  const here = join(app.home, "here");
  const other = join(app.home, "other");
  app.git(app.home, "clone", "-q", remote, here);
  app.git(app.home, "clone", "-q", remote, other);
  return { remote, here, other };
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

async function openNovel(page: Page, launchUrl: string) {
  await page.goto(launchUrl);
  await expect(text(page)).toBeFocused({ timeout: 15_000 });
}

/** Type at the end of the open text (the chapter's last scene, or the scene). */
async function typeAtEnd(page: Page, words: string) {
  await text(page).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(words);
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

test("draft, close the tab and quit, reopen: all the work is there and committed", async ({ page, app, context }) => {
  const { here } = machines(app);
  await app.restart(here);
  await openNovel(page, app.launchUrl);
  await typeAtEnd(page, " Drafted just before closing.");
  // Close the tab at once, well inside the autosave interval: it saves on the way out.
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => read(here, BRIDGE), { timeout: 10_000 }).toMatch(/ Drafted just before closing\.\n$/);
  // Quit gh-writer (Ctrl+C): saved work is committed as it stops.
  await app.stop();
  expect(app.git(here, "status", "--porcelain")).toBe("");
  expect(app.git(here, "log", "-1", "--format=%s")).toMatch(/^Draft: Walking the Span \(\+4 words\)/);

  await app.restart(here);
  const reopened = await context.newPage();
  await openNovel(reopened, app.launchUrl);
  await expect(text(reopened)).toContainText("Drafted just before closing.");
});

test("a crash loses at most the text typed within the autosave interval, and the tab brings even that back", async ({ page, app }) => {
  const { here } = machines(app);
  await app.restart(here);
  const port = new URL(app.url).port;
  await openNovel(page, app.launchUrl);

  await typeAtEnd(page, " Saved before the crash.");
  await expect.poll(() => read(here, BRIDGE), { timeout: 10_000 }).toContain("Saved before the crash.");
  const typedAt = Date.now();
  await page.keyboard.type(" Typed in the last moment.");
  await app.kill();
  const window = Date.now() - typedAt;

  // On disk: everything saved before the kill; at most the last moment's typing is missing.
  const onDisk = read(here, BRIDGE);
  expect(onDisk).toContain("Saved before the crash.");
  expect(window, "the unsaved text was typed within the 2 s autosave interval").toBeLessThan(2000);
  const missing = onDisk.includes("Typed in the last moment.") ? "" : " Typed in the last moment.";
  test.info().annotations.push({ type: "resilience", description: `missing after the crash: ${JSON.stringify(missing)}, typed in the last ${window} ms` });

  // Start gh-writer again on the same address and open it in the same tab: the tab still holds the text.
  await app.restart(here, "--port", port);
  await openNovel(page, app.launchUrl);
  await expect.poll(() => read(here, BRIDGE), { timeout: 10_000 }).toMatch(/ Saved before the crash\. Typed in the last moment\.\n$/);
  await expect(text(page)).toContainText("Typed in the last moment.");
});

test("a whole drafting session with the network down syncs by itself once it's back", async ({ page, app }) => {
  test.setTimeout(120_000);
  const { remote, here, other } = machines(app);
  // The network is down: the remote can't be reached.
  app.git(here, "remote", "set-url", "origin", "http://127.0.0.1:1/varn.git");
  await app.restart(here);
  await openNovel(page, app.launchUrl);
  await expect(badge(page)).toHaveAccessibleName("Sync: Offline", { timeout: 15_000 });

  // Writing goes on: one chapter, then a scene in another.
  await typeAtEnd(page, " Written offline, first.");
  await expect.poll(() => read(here, BRIDGE), { timeout: 10_000 }).toContain("Written offline, first.");
  await page.getByRole("link", { name: "Ben's Ledger" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ben's Ledger" })).toBeVisible();
  await typeAtEnd(page, " Written offline, second.");
  await expect.poll(() => read(here, LEDGER), { timeout: 10_000 }).toContain("Written offline, second.");
  await expect(badge(page)).toHaveAccessibleName("Sync: Offline");

  // The network comes back. Nobody presses anything: the retry finds it.
  app.git(here, "remote", "set-url", "origin", remote);
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced", { timeout: 90_000 });

  expect(app.git(remote, "show", `main:${BRIDGE}`)).toContain("Written offline, first.");
  expect(app.git(remote, "show", `main:${LEDGER}`)).toContain("Written offline, second.");
  expect(app.git(remote, "log", "--format=%s", "main")).toMatch(/^Draft: /m);
  expect(app.git(here, "status", "--porcelain")).toBe("");
  // Another machine gets exactly what was written.
  app.git(other, "pull", "-q");
  expect(read(other, BRIDGE)).toBe(read(here, BRIDGE));
  expect(read(other, LEDGER)).toBe(read(here, LEDGER));
});

test("the same scene edited on two machines ends in a resolvable conflict, never a corrupted file", async ({ page, app, context }) => {
  test.setTimeout(90_000);
  const { remote, here, other } = machines(app);
  await app.restart(here);
  const machineB = await app.serveAnother([other], { GH_WRITER_CONFIG_DIR: join(app.home, "config-b") });
  const pageB = await context.newPage();
  await openNovel(page, app.launchUrl);
  await openNovel(pageB, machineB.launchUrl);

  // Both machines rewrite the end of the same scene.
  await typeAtEnd(page, " The ending, as written on A.");
  await typeAtEnd(pageB, " The ending, as written on B.");
  await expect.poll(() => read(here, BRIDGE), { timeout: 10_000 }).toContain("written on A.");
  await expect.poll(() => read(other, BRIDGE), { timeout: 10_000 }).toContain("written on B.");

  // A syncs first; B meets the conflict and settles it in the resolver.
  await palette(page, "sync now");
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced", { timeout: 15_000 });
  await palette(pageB, "sync now");
  await expect(badge(pageB)).toHaveAccessibleName("Sync: Conflict", { timeout: 15_000 });
  await palette(pageB, "resolve sync conflicts");
  const resolver = pageB.getByRole("region", { name: "Resolve conflicts" });
  await expect(resolver).toBeFocused();
  await expect(resolver.getByRole("group", { name: "Mine" })).toContainText("written on B.");
  await expect(resolver.getByRole("group", { name: "Theirs" })).toContainText("written on A.");
  await pageB.keyboard.press("3");
  await pageB.keyboard.press("ControlOrMeta+Enter");
  await expect(badge(pageB)).toHaveAccessibleName("Sync: Synced", { timeout: 15_000 });

  // A brings the resolution in.
  await palette(page, "sync now");
  await expect(badge(page)).toHaveAccessibleName("Sync: Synced", { timeout: 15_000 });
  await expect(text(page)).toContainText("written on B.");

  // One file, the same everywhere, with both endings and no conflict markers, in a novel that validates.
  const final = app.git(remote, "show", `main:${BRIDGE}`);
  expect(read(here, BRIDGE)).toBe(final);
  expect(read(other, BRIDGE)).toBe(final);
  expect(final).toMatch(/ The ending, as written on B\.\n\n.*The ending, as written on A\.\n$/s);
  expect(final).not.toMatch(/^(<{7}|={7}|>{7})/m);
  expect(execFileSync("node", [cli, "validate", here], { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } })).toContain("0 errors");
  expect(app.git(remote, "rev-list", "--merges", "--count", "main").trim()).toBe("1");
});
