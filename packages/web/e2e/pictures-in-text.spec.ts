import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { axe, caretAtEnd, expect, test, type App } from "./fixtures.ts";
import { makePicture, pastePicture, pictureIn } from "./pictures.ts";

/** Pictures between paragraphs (D10, #203): added, changed and removed, checked in the scene's Markdown and images/ on disk. */

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";

async function openChapter(page: Page, app: App) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  const text = page.getByRole("textbox", { name: "Chapter text" });
  await expect(text).toBeFocused();
  return { dir, text, read: (path: string) => readFileSync(join(dir, path), "utf8"), exists: (path: string) => existsSync(join(dir, path)) };
}

async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

test("chosen from the palette, resized, described and captioned; then changed by keyboard, and removed with its file", async ({ page, app }) => {
  const novel = await openChapter(page, app);
  const original = novel.read(BRIDGE);
  await caretAtEnd(page, novel.text);
  const bytes = await makePicture(page, { width: 2400, height: 1200, name: "varn-map.jpg" });

  await palette(page, "Insert a picture");
  const dialog = page.getByRole("dialog", { name: "Insert a picture" });
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose a picture…" }).click();
  await (await chooser).setFiles({ name: "varn-map.jpg", mimeType: "image/jpeg", buffer: bytes });
  await expect(dialog).toContainText("varn-map.jpg · 2400 × 1200 px");
  await dialog.getByLabel("Description").fill("A map of Varn");
  await dialog.getByLabel("Caption (optional)").fill("The valley, as Tomas drew it");
  await expect(dialog).toContainText(/Saved as images\/a-map-of-varn\.jpg, resized to 1600 × 800 px, about \d+ KB\./);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await axe(page);
  }
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(dialog).toBeHidden();

  // In the text, read by its description; written to the scene and saved under images/ at its new size.
  const picture = novel.text.getByRole("img", { name: "A map of Varn" });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1600);
  await expect(novel.text.locator("figcaption")).toHaveText("The valley, as Tomas drew it");
  // The caret is on after it, to write on.
  await page.keyboard.type("After the map.");
  const line = '![A map of Varn](/images/a-map-of-varn.jpg "The valley, as Tomas drew it")';
  await expect.poll(() => novel.read(BRIDGE)).toBe(`${original.trimEnd()}\n\n${line}\n\nAfter the map.\n`);
  expect(pictureIn(novel.dir, "images/a-map-of-varn.jpg")).toEqual({ type: "image/jpeg", width: 1600, height: 800 });
  await axe(page);

  // Changed: ↑ selects it, Enter opens it; only its own line is rewritten.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  const change = page.getByRole("dialog", { name: "Change the picture" });
  await expect(change.getByLabel("Description")).toHaveValue("A map of Varn");
  await change.getByLabel("Description").fill("Tomas's map of Varn");
  await change.getByLabel("Caption (optional)").fill("");
  await axe(page);
  await change.getByRole("button", { name: "Save" }).click();
  await expect(change).toBeHidden();
  await expect(novel.text.getByRole("img", { name: "Tomas's map of Varn" })).toBeVisible();
  await expect.poll(() => novel.read(BRIDGE)).toBe(`${original.trimEnd()}\n\n![Tomas's map of Varn](/images/a-map-of-varn.jpg)\n\nAfter the map.\n`);

  // Removed: still selected, Delete takes it, and its file goes with it.
  await page.keyboard.press("Delete");
  await expect(novel.text.getByRole("img")).toHaveCount(0);
  await expect.poll(() => novel.read(BRIDGE)).toBe(`${original.trimEnd()}\n\nAfter the map.\n`);
  await expect.poll(() => novel.exists("images/a-map-of-varn.jpg")).toBe(false);
  // Undone, it's back, file and all.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => novel.read(BRIDGE)).toContain("![Tomas's map of Varn](/images/a-map-of-varn.jpg)");
  await expect.poll(() => novel.exists("images/a-map-of-varn.jpg")).toBe(true);
});

test("pasted into the text, and dropped between paragraphs, each asks for its description; dragged, one moves", async ({ page, app }) => {
  const novel = await openChapter(page, app);
  const dialog = page.getByRole("dialog", { name: "Insert a picture" });

  // Pasted at the caret: a PNG with transparency keeps it, and a small one keeps its size.
  await caretAtEnd(page, novel.text);
  await makePicture(page, { width: 800, height: 600, type: "image/png", name: "seal.png", transparent: true });
  await pastePicture(page);
  await expect(dialog).toContainText("seal.png · 800 × 600 px");
  await expect(dialog.getByLabel("Description")).toBeFocused();
  // Insert waits for a description.
  await expect(dialog.getByRole("button", { name: "Insert" })).toBeDisabled();
  await page.keyboard.type("The seal");
  await expect(dialog).toContainText(/Saved as images\/the-seal\.png, at 800 × 600 px/);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(() => novel.read(BRIDGE)).toMatch(/\n\n!\[The seal\]\(\/images\/the-seal\.png\)\n$/);
  expect(pictureIn(novel.dir, "images/the-seal.png")).toEqual({ type: "image/png", width: 800, height: 600 });

  // Dropped on the chapter's first paragraph: it goes in after that paragraph.
  await makePicture(page, { width: 1000, height: 1400, name: "letter.jpg" });
  const first = novel.text.locator("p").first();
  const box = (await first.boundingBox())!;
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add((window as unknown as { __picture: File }).__picture);
    return transfer;
  });
  const at = { clientX: box.x + 10, clientY: box.y + box.height / 2 };
  await first.dispatchEvent("dragover", { dataTransfer: data, ...at });
  await first.dispatchEvent("drop", { dataTransfer: data, ...at });
  await expect(dialog).toContainText("letter.jpg · 1000 × 1400 px");
  await dialog.getByLabel("Description").fill("Mirela's letter");
  await dialog.getByRole("button", { name: "Insert" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => novel.read(STATION)).toContain("the only passenger who stood.\n\n![Mirela's letter](/images/mirelas-letter.jpg)\n\nTwelve years");
  expect(novel.exists("images/mirelas-letter.jpg")).toBe(true);

  // Dragged to move it: a mark shows where it will land, and it lands there.
  const letter = novel.text.getByRole("img", { name: "Mirela's letter" });
  const target = novel.text.locator("p", { hasText: "From the platform" });
  // Tall enough for the picture and where it goes, both in view.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await letter.scrollIntoViewIfNeeded();
  const from = (await letter.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + to.height - 4, { steps: 12 });
  await expect(page.locator(".ghw-dropcursor")).toBeVisible();
  await page.mouse.up();
  await expect
    .poll(() => novel.read(STATION))
    .toContain("who stood.\n\nTwelve years had not moved the station clock. It still ran four minutes fast, as it had when her father set it, so that nobody in Varn would ever miss the last crossing.\n\nFrom the platform");
  await expect.poll(() => novel.read(STATION)).toContain("Surveyors' flags.\n\n![Mirela's letter](/images/mirelas-letter.jpg)\n\nShe stood");
});
