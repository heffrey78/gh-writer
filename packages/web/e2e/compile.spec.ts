import { readFileSync } from "node:fs";
import type { Download, Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { axe, expect, test } from "./fixtures.ts";

const dialog = (page: Page) => page.getByRole("dialog", { name: "Compile the manuscript" });

test("compiles the first two chapters to Word, EPUB and PDF, keyboard only, with what was just typed", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" The tide was turning.");

  // Straight away, before the autosave: compiling saves first.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Compile the manuscript");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await axe(page);

  await dialog(page).getByRole("radio", { name: "Some chapters" }).check();
  await dialog(page).getByRole("combobox", { name: "From" }).selectOption({ label: "Arrival" });
  await dialog(page).getByRole("combobox", { name: "to" }).selectOption({ label: "Arrival" });
  await dialog(page).getByRole("combobox", { name: "From" }).selectOption({ label: "Old Debts" });
  await expect(dialog(page).getByRole("alert")).toHaveText("The range ends before it starts.");
  await expect(dialog(page).getByRole("button", { name: "Compile" })).toBeDisabled();
  await dialog(page).getByRole("combobox", { name: "From" }).selectOption({ label: "Arrival" });
  await dialog(page).getByRole("combobox", { name: "to" }).selectOption({ label: "Old Debts" });

  const downloads: Download[] = [];
  page.on("download", (d) => downloads.push(d));
  await dialog(page).getByRole("button", { name: "Compile" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Compiled the-bridge-at-varn-chapters-1-2.docx, the-bridge-at-varn-chapters-1-2.epub, the-bridge-at-varn-chapters-1-2.pdf." })).toBeVisible();
  await expect(dialog(page)).toBeHidden();
  expect(downloads.map((d) => d.suggestedFilename())).toEqual(["the-bridge-at-varn-chapters-1-2.docx", "the-bridge-at-varn-chapters-1-2.epub", "the-bridge-at-varn-chapters-1-2.pdf"]);
  const bytes = async (d: Download) => new Uint8Array(readFileSync((await d.path())!));

  const docx = strFromU8(unzipSync(await bytes(downloads[0]!))["word/document.xml"]!);
  expect(docx).toContain("Chapter One: Arrival");
  expect(docx).toContain("Chapter Two: Old Debts");
  expect(docx).not.toContain("Night Crossing");
  expect(docx).toContain("The tide was turning.");

  const epub = unzipSync(await bytes(downloads[1]!));
  expect(Object.keys(epub).filter((f) => f.includes("chapter-"))).toEqual(["OEBPS/chapter-001.xhtml", "OEBPS/chapter-002.xhtml"]);
  expect(strFromU8(epub["OEBPS/chapter-001.xhtml"]!)).toContain("The tide was turning.");

  expect(strFromU8((await bytes(downloads[2]!)).subarray(0, 5))).toBe("%PDF-");
});

test("the header's Compile button opens the dialog; Escape closes it", async ({ page, app }) => {
  await app.restart(app.novelRepo("varn"));
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.getByRole("button", { name: "Compile" }).click();
  await expect(dialog(page).getByRole("radio", { name: "The whole book" })).toBeChecked();
  await expect(dialog(page).getByRole("checkbox")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
});
