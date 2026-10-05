import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { countWords } from "@gh-writer/core";
import { expect, test, type Page } from "@playwright/test";
import { splitSceneFile } from "../src/index.ts";
import { caretAfter, open, settled, textbox } from "./helpers.ts";

const novel = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const words = (path: string) => countWords(splitSceneFile(readFileSync(novel + path, "utf8")).body);
const CHAPTER = "manuscript/01-return/01-arrival";
const STATION = `${CHAPTER}/01-the-station.md`;
const BRIDGE = `${CHAPTER}/02-the-bridge.md`;
const n = (x: number) => x.toLocaleString("en-US");

const bar = (page: Page) => page.getByRole("group", { name: "Word count" });
const expectCounts = (page: Page, text: string) => expect.poll(() => bar(page).evaluate((el) => el.textContent!.replace(/\s+/g, " "))).toContain(text);

test("scene, chapter and session counts update as you type", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  const scene = words(STATION);
  const chapter = scene + words(BRIDGE);
  await expectCounts(page, `Scene ${n(scene)}`);
  await expectCounts(page, `Chapter ${n(chapter)}`);
  await expectCounts(page, "Session 0");
  await caretAfter(page, "counted them twice");
  await page.keyboard.type(", three more words");
  await expectCounts(page, `Scene ${n(scene + 3)}`);
  await expectCounts(page, `Chapter ${n(chapter + 3)}`);
  await expectCounts(page, "Session +3");
  for (let i = 0; i < ", three more words".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("ControlOrMeta+Backspace");
  await expectCounts(page, "Session −1");
});

test("mention links count as their names, front matter not at all", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await expectCounts(page, `Scene ${n(words(STATION))}`);
  const visible = await textbox(page).evaluate((el) => [...el.querySelectorAll("p")].map((p) => p.textContent).join(" "));
  expect(words(STATION)).toBe(visible.split(/\s+/).filter((w) => /\p{L}|\d/u.test(w)).length);
});

test("the session count survives a reload", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await caretAfter(page, "counted them twice");
  await page.keyboard.type(" and once more");
  await expectCounts(page, "Session +3");
  await page.keyboard.press("Tab"); // blur reports the edit straight away
  await page.reload();
  await settled(page);
  await expectCounts(page, `Scene ${n(words(STATION) + 3)}`);
  await expectCounts(page, "Session +3");
  await page.getByRole("button", { name: "Start a new writing session" }).click();
  await expectCounts(page, "Session 0");
});

test("a session goal shows progress and a quiet notice when reached", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await page.getByRole("button", { name: "Set goal" }).click();
  await page.getByLabel("Session goal").fill("5");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Change goal" })).toBeFocused();
  await expectCounts(page, "Session 0 of 5");
  await expect(bar(page).getByRole("status")).toHaveText("");
  await caretAfter(page, "counted them twice");
  await page.keyboard.type(" one two three");
  await expectCounts(page, "Session +3 of 5");
  await expect(bar(page).getByRole("progressbar")).toHaveAttribute("value", "3");
  await page.keyboard.type(" four five");
  await expect(bar(page).getByRole("status")).toHaveText("Goal reached");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("the count hides in focus mode unless pinned", async ({ page }) => {
  await open(page, `scene=${STATION}`);
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(bar(page)).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.getByRole("button", { name: "Show the word count in focus mode" }).click();
  // The command returns focus to the text on the next frame; the shortcut is the editor's.
  await expect(textbox(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(bar(page)).toBeVisible();
});

test("in the chapter view the scene count follows the caret", async ({ page }) => {
  await open(page, `chapter=${CHAPTER}`);
  const total = words(STATION) + words(BRIDGE);
  await caretAfter(page, "counted them twice");
  await expectCounts(page, `Scene ${n(words(STATION))}`);
  await expectCounts(page, `Chapter ${n(total)}`);
  await caretAfter(page, "which ones to check");
  await expectCounts(page, `Scene ${n(words(BRIDGE))}`);
  await page.keyboard.type(", and when");
  await expectCounts(page, `Scene ${n(words(BRIDGE) + 2)}`);
  await expectCounts(page, `Chapter ${n(total + 2)}`);
  await expectCounts(page, "Session +2");
});
