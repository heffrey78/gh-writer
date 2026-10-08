import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, expect, launch, test, type App } from "./fixtures.ts";

/**
 * #7's promises, walked the way a keyboard user would meet them: every flow mouse-free, focus always
 * visible, no axe violations in either theme, and a layout that works from a 13-inch laptop to a
 * large monitor.
 */

const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";

/** A file's text, or "" while it's missing (a restore replaces files, so for a moment one isn't there). */
const readNow = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** axe in light and dark, leaving the page in light. */
async function audit(page: Page) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Tab `count` times; each element reached must show focus (an outline or a ring), except the writing surface, whose focus is its caret. */
async function tabShowsFocus(page: Page, count: number) {
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    const seen = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { ok: true, what: "body" };
      if (el.classList.contains("ghw-prose")) return { ok: true, what: "the text" };
      const s = getComputedStyle(el);
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const ring = s.boxShadow !== "none";
      return { ok: outline || ring, what: `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? ""}` };
    });
    expect(seen.ok, `focus is visible on ${seen.what}`).toBe(true);
  }
}

async function noSideways(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A remote with the sample novel, and another machine's clone of it. */
function remoteAndOther(app: App) {
  const remote = app.bareRepo("varn.git");
  const other = join(app.home, "other");
  app.git(app.home, "clone", "-q", remote, other);
  return { remote, other };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox")).toBeFocused();
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
}

for (const [name, viewport] of [
  ["a 13-inch laptop", { width: 1280, height: 800 }],
  ["a large monitor", { width: 2560, height: 1440 }],
] as const) {
  test(`every flow by keyboard alone, on ${name}`, async ({ page, app }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const { remote, other } = remoteAndOther(app);

    // The library: skip link first, every control shows focus.
    await launch(page, app);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
    await tabShowsFocus(page, 6);
    await noSideways(page);
    await audit(page);

    // Clone from the remote, by keyboard.
    await page.getByRole("button", { name: "Clone from GitHub" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Repository" })).toBeFocused();
    await page.keyboard.type(`file://${remote}`);
    await page.keyboard.press("Enter");
    const text = page.getByRole("textbox", { name: "Chapter text" });
    await expect(text).toBeFocused({ timeout: 15_000 });
    await noSideways(page);
    await audit(page);
    const here = join(app.home, "gh-writer", "varn");

    // Write, and meet the other machine's change to the same paragraph.
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Written here.");
    await expect.poll(() => readFileSync(join(here, BRIDGE), "utf8"), { timeout: 10_000 }).toContain("Written here.");
    const lines = readFileSync(join(other, BRIDGE), "utf8").trimEnd().split("\n");
    lines[lines.length - 1] = "Written on the other machine.";
    writeFileSync(join(other, BRIDGE), `${lines.join("\n")}\n`);
    app.git(other, "commit", "-qam", "Other");
    app.git(other, "push", "-q");

    // Sync and resolve from the palette.
    await palette(page, "sync now");
    await expect(page.getByRole("button", { name: "Sync: Conflict" })).toBeVisible({ timeout: 15_000 });
    await palette(page, "resolve sync conflicts");
    const resolver = page.getByRole("region", { name: "Resolve conflicts" });
    await expect(resolver).toBeFocused();
    await tabShowsFocus(page, 4);
    await audit(page);
    await resolver.focus();
    await page.keyboard.press("3");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByRole("button", { name: "Sync: Synced" })).toBeVisible({ timeout: 15_000 });
    expect(app.git(remote, "show", `main:${BRIDGE}`)).toMatch(/Written here\.\n\nWritten on the other machine\.\n$/);

    // A checkpoint, a restore and its undo, all by keyboard.
    await text.focus();
    await palette(page, "checkpoints");
    const panel = page.getByRole("dialog", { name: "Checkpoints" });
    await expect(panel.getByRole("textbox", { name: "New checkpoint" })).toBeFocused();
    await page.keyboard.type("Merged");
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("listitem")).toHaveCount(1);
    await audit(page);
    await page.keyboard.press("Escape");
    // Closed, not closing: until it's gone its focus trap would take the keys typed next.
    await expect(panel).toHaveCount(0);
    await text.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Then more.");
    await expect.poll(() => readFileSync(join(here, BRIDGE), "utf8"), { timeout: 10_000 }).toContain("Then more.");
    await palette(page, "checkpoints");
    await panel.getByRole("button", { name: "Restore the manuscript from “Merged”" }).focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirm.getByRole("button", { name: "Restore manuscript" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => readNow(join(here, BRIDGE))).toMatch(/Written on the other machine\.\n$/);
    await expect(page.getByRole("status").filter({ hasText: "Restored the manuscript" })).toBeVisible();
    // Undo is in the notice, and a keystroke away in the palette.
    await palette(page, "undo");
    await expect(page.getByRole("status").filter({ hasText: "Undone" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => readNow(join(here, BRIDGE))).toContain("Then more.");

    // Theme and the shortcut reference.
    await palette(page, "theme dark");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await axe(page);
    await page.keyboard.press("Escape");
    await palette(page, "follow the system");

    // Back to the library, by keyboard.
    await palette(page, "your novels");
    await expect(page.getByRole("heading", { level: 1, name: "Your novels" })).toBeVisible();
    await noSideways(page);
  });
}
