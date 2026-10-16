import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { axe, expect, test, type App } from "./fixtures.ts";
import { dropPicture, makePicture, pastePicture, pictureIn } from "./pictures.ts";

const ADA = "char_7f3k2q";
const ADA_FILE = "bible/characters/ada.md";

async function openEntry(page: Page, app: App, id = ADA) {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const novelPath = new URL(app.launchUrl).pathname;
  await page.goto(app.launchUrl.replace(novelPath, `${novelPath}/bible/${id}`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return {
    dir,
    read: (path: string) => readFileSync(join(dir, path), "utf8"),
    images: () => (existsSync(join(dir, "images")) ? readdirSync(join(dir, "images")).sort() : []),
    lastCommit: () => app.git(dir, "log", "-1", "--format=%s").trim(),
    clean: () => app.git(dir, "status", "--porcelain").trim(),
  };
}

test("a portrait chosen, framed by keyboard and saved resized under images/, shown on the profile", async ({ page, app }) => {
  const novel = await openEntry(page, app);
  const bytes = await makePicture(page, { width: 2400, height: 1800, name: "ada-sketch.jpg" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add a portrait" }).click();
  await (await chooser).setFiles({ name: "ada-sketch.jpg", mimeType: "image/jpeg", buffer: bytes });

  const dialog = page.getByRole("dialog", { name: "Portrait of Ada Varn" });
  await expect(dialog).toContainText(`ada-sketch.jpg · 2400 × 1800 px`);
  await expect(dialog.getByText("images/ada-varn.jpg")).toBeVisible();
  await expect(dialog).toContainText(/Resized to 1200 × 1500 px, about \d+ KB/);

  // The frame, by keyboard: to the left edge, then the focal point up a little.
  const frame = dialog.getByRole("button", { name: /^Crop frame/ });
  await expect(frame).toHaveAccessibleName("Crop frame, 50% across, 50% down");
  await frame.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(frame).toHaveAccessibleName("Crop frame, 30% across, 50% down");
  await expect(dialog.getByRole("status")).toHaveText("Frame 30% across, 50% down.");
  await page.keyboard.press("Tab");
  const dot = dialog.getByRole("button", { name: /^Focal point/ });
  await expect(dot).toBeFocused();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect(dot).toHaveAccessibleName("Focal point, 50% across, 40% down");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  await dialog.getByRole("button", { name: "Use this portrait" }).click();
  await expect(dialog).toBeHidden();
  const portrait = page.getByRole("img", { name: "Portrait of Ada Varn" });
  await expect(portrait).toBeVisible();
  await expect.poll(() => portrait.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
  expect(pictureIn(novel.dir, "images/ada-varn.jpg")).toEqual({ type: "image/jpeg", width: 1200, height: 1500 });
  expect(novel.read(ADA_FILE)).toMatch(/\nimage: images\/ada-varn\.jpg\nimage_focus:\n {2}- 0\.5\n {2}- 0\.4\n/);
  expect(novel.lastCommit()).toBe("Bible: add a picture of Ada Varn");
  expect(novel.clean()).toBe("");
  await axe(page);
});

test("dropped, pasted, recropped and removed: one commit each, and no file left behind", async ({ page, app }) => {
  const novel = await openEntry(page, app);
  const dialog = page.getByRole("dialog", { name: "Portrait of Ada Varn" });

  // Dropped: a PNG with transparency keeps it.
  await makePicture(page, { width: 900, height: 900, type: "image/png", name: "cutout.png", transparent: true });
  const slot = page.getByRole("button", { name: "Add a portrait" });
  await dropPicture(page, slot);
  await expect(dialog).toContainText("cutout.png · 900 × 900 px");
  await expect(dialog.getByText("images/ada-varn.png")).toBeVisible();
  // Smaller than a portrait's size: kept at its own, not enlarged.
  await expect(dialog).toContainText(/At 720 × 900 px, about \d+ KB/);
  await dialog.getByRole("button", { name: "Use this portrait" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(novel.lastCommit).toBe("Bible: add a picture of Ada Varn");
  expect(novel.images()).toEqual(["ada-varn.png"]);
  expect(pictureIn(novel.dir, "images/ada-varn.png")).toMatchObject({ type: "image/png", width: 720 });

  // Pasted while its pencil has the focus: a JPEG now, and the PNG goes.
  await makePicture(page, { width: 1600, height: 2000, name: "photo.jpg" });
  await page.getByRole("button", { name: "Change the portrait" }).focus();
  await pastePicture(page);
  await expect(dialog).toContainText("photo.jpg · 1600 × 2000 px");
  await dialog.getByRole("button", { name: "Use this portrait" }).click();
  // The files change on disk a moment before the commit that records them.
  await expect.poll(novel.lastCommit).toBe("Bible: change the picture of Ada Varn");
  expect(novel.images()).toEqual(["ada-varn.jpg"]);

  // Recropped from the saved picture: closer in.
  await page.getByRole("button", { name: "Change the portrait" }).click();
  await page.getByRole("menuitem", { name: "Recrop…" }).click();
  await expect(dialog).toContainText("ada-varn.jpg · 1200 × 1500 px");
  await dialog.getByRole("slider", { name: "Size" }).fill("50");
  await expect(dialog).toContainText("At 600 × 750 px");
  await dialog.getByRole("button", { name: "Use this portrait" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => pictureIn(novel.dir, "images/ada-varn.jpg")?.width).toBe(600);
  // The image shown is the new one, not the cached old one.
  await expect.poll(() => page.getByRole("img", { name: "Portrait of Ada Varn" }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(600);

  // Removed: the file and the fields.
  await page.getByRole("button", { name: "Change the portrait" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("button", { name: "Add a portrait" })).toBeVisible();
  await expect.poll(novel.lastCommit).toBe("Bible: remove the picture of Ada Varn");
  expect(novel.images()).toEqual([]);
  expect(novel.read(ADA_FILE)).not.toMatch(/image/);
  expect(novel.clean()).toBe("");
});

test("a place takes a wide picture", async ({ page, app }) => {
  const novel = await openEntry(page, app, "loc_br1dg3");
  await makePicture(page, { width: 3000, height: 2000, name: "bridge.jpg" });
  await dropPicture(page, page.getByRole("button", { name: "Add a picture" }));
  const dialog = page.getByRole("dialog", { name: "Picture of The Varn Bridge" });
  await expect(dialog).toContainText(/Resized to 1600 × 900 px/);
  await dialog.getByRole("button", { name: "Use this picture" }).click();
  await expect(page.getByRole("img", { name: "Picture of The Varn Bridge" })).toBeVisible();
  expect(pictureIn(novel.dir, "images/the-varn-bridge.jpg")).toEqual({ type: "image/jpeg", width: 1600, height: 900 });
});

test("refuses an image over GitHub's limit, and a file that isn't an image, before reading them", async ({ page, app }) => {
  const novel = await openEntry(page, app);
  const slot = page.getByRole("button", { name: "Add a portrait" });
  await dropPicture(page, slot, { size: 101 * 1024 * 1024, name: "huge.jpg", type: "image/jpeg" });
  await expect(page.getByRole("alert")).toHaveText("huge.jpg is 101.0 MB: larger than GitHub's 100 MB limit, so it can't be kept in the novel. Try a smaller copy.");
  await expect(page.getByRole("dialog", { name: "Portrait of Ada Varn" })).toHaveCount(0);
  await dropPicture(page, slot, { size: 100, name: "notes.pdf", type: "application/pdf" });
  await expect(page.getByRole("alert")).toContainText("notes.pdf isn't an image");
  expect(novel.images()).toEqual([]);
  expect(novel.clean()).toBe("");
});

test("a portrait on the gallery card, the mention card and the Entry tab; initials and No picture yet without one", async ({ page, app }) => {
  // Ada has a portrait already, committed with the novel.
  const dir = app.novelRepo("varn");
  mkdirSync(join(dir, "images"));
  copyFileSync(new URL("../../export/test/fixtures/cover.jpg", import.meta.url), join(dir, "images/ada-varn.jpg"));
  writeFileSync(join(dir, ADA_FILE), readFileSync(join(dir, ADA_FILE), "utf8").replace("\nname: Ada Varn\n", "\nname: Ada Varn\nimage: images/ada-varn.jpg\nimage_focus: [0.5, 0.3]\n"));
  app.git(dir, "commit", "-qam", "A portrait");
  app.git(dir, "add", "-A");
  app.git(dir, "commit", "-qm", "Its file");
  await app.restart(dir);
  const novelPath = new URL(app.launchUrl).pathname;

  await page.goto(app.launchUrl.replace(novelPath, `${novelPath}/bible`));
  const characters = page.getByRole("region", { name: /^Characters/ });
  const portrait = characters.getByRole("link", { name: /^Portrait of Ada Varn Ada Varn/ }).getByRole("img", { name: "Portrait of Ada Varn" });
  await expect(portrait).toHaveAttribute("loading", "lazy");
  await expect(portrait).toHaveCSS("object-position", "50% 30%");
  await expect.poll(() => portrait.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(400);
  // No portrait: the initials, which say nothing the name doesn't.
  await expect(characters.getByRole("link", { name: /^Ben Varn/ })).toContainText("BV");
  await expect(page.getByRole("region", { name: /^Locations/ }).getByRole("link", { name: /^No picture yet The Varn Bridge/ })).toBeVisible();
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  // Beside the text: the mention card, then the Entry tab.
  await page.goto(app.launchUrl.replace(/\?token=.*/, ""));
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.locator('.ghw-mention[data-mention="char_7f3k2q"]').first().hover();
  const card = page.getByRole("dialog", { name: "Ada Varn" });
  await expect(card.getByRole("img", { name: "Portrait of Ada Varn" })).toBeVisible();
  await axe(page);
  await card.getByRole("button", { name: "Open entry" }).click();
  const tab = page.getByRole("complementary").getByRole("region", { name: "Ada Varn" });
  await expect(tab.getByRole("img", { name: "Portrait of Ada Varn" })).toBeVisible();
  // The tab shows it; changing it is the page's.
  await expect(tab.getByRole("button", { name: "Change the portrait" })).toHaveCount(0);
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
});

test("the book's cover: set from the shelf, shown there and in Compile, in the EPUB, changed and removed from Compile", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  await page.goto(app.launchUrl);
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  const read = (path: string) => readFileSync(join(dir, path), "utf8");
  const lastCommit = () => app.git(dir, "log", "-1", "--format=%s").trim();
  const images = () => (existsSync(join(dir, "images")) ? readdirSync(join(dir, "images")).sort() : []);

  // From the book's menu on the shelf.
  await page.goto(`${app.url}/`);
  const book = page.getByRole("list", { name: "Novels" }).getByRole("link", { name: "The Bridge at Varn, by gh-writer sample" });
  await expect(book).toBeVisible();
  await expect(book.getByRole("img")).toHaveCount(0);
  const bytes = await makePicture(page, { width: 2000, height: 3000, name: "cover-art.jpg" });
  await page.getByRole("button", { name: "More for “The Bridge at Varn”" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Set a cover…" }).click();
  await (await chooser).setFiles({ name: "cover-art.jpg", mimeType: "image/jpeg", buffer: bytes });
  const dialog = page.getByRole("dialog", { name: "The cover of The Bridge at Varn" });
  await expect(dialog).toContainText(/Resized to 1600 × 2560 px/);
  await expect(dialog.getByText("images/cover.jpg")).toBeVisible();
  // A cover is shown whole: no focal point.
  await expect(dialog.getByRole("button", { name: /^Focal point/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use this cover" }).click();
  await expect(book.getByRole("img", { name: "The cover of The Bridge at Varn" })).toBeVisible();
  expect(pictureIn(dir, "images/cover.jpg")).toEqual({ type: "image/jpeg", width: 1600, height: 2560 });
  expect(read("novel.yaml")).toMatch(/\ncover: images\/cover\.jpg\n/);
  expect(lastCommit()).toBe("Add a cover to the book");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });

  // In Compile: the cover, its file and size, and it goes into the EPUB.
  await book.click();
  await expect(page.getByRole("textbox", { name: "Chapter text" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Compile the manuscript");
  await page.keyboard.press("Enter");
  const compile = page.getByRole("dialog", { name: "Compile the manuscript" });
  const row = compile.getByRole("region", { name: "Cover" });
  await expect(row.getByRole("img", { name: "The cover of The Bridge at Varn" })).toBeVisible();
  await expect(row).toContainText("images/cover.jpg");
  await expect(row).toContainText("1600 × 2560 px");
  await expect(row).toContainText("Word manuscripts go out without one");
  await axe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page);
  await page.emulateMedia({ colorScheme: "light" });
  for (const name of [/^Word/, /^PDF/]) await compile.getByRole("checkbox", { name }).uncheck();
  const download = page.waitForEvent("download");
  await compile.getByRole("button", { name: "Compile" }).click();
  const epub = unzipSync(new Uint8Array(readFileSync((await (await download).path())!)));
  expect(Object.keys(epub)).toContain("OEBPS/images/cover.jpg");

  // Changed, then removed, from Compile.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Compile the manuscript");
  await page.keyboard.press("Enter");
  const second = await makePicture(page, { width: 1000, height: 1600, name: "second.jpg" });
  const again = page.waitForEvent("filechooser");
  await row.getByRole("button", { name: "Change…" }).click();
  await (await again).setFiles({ name: "second.jpg", mimeType: "image/jpeg", buffer: second });
  await expect(dialog).toContainText("second.jpg · 1000 × 1600 px");
  await expect(dialog).toContainText("At 1000 × 1600 px");
  await dialog.getByRole("button", { name: "Use this cover" }).click();
  await expect(row).toContainText("1000 × 1600 px");
  await expect.poll(lastCommit).toBe("Change the book's cover");

  await row.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(row.getByRole("button", { name: "Add a cover…" })).toBeVisible();
  await expect.poll(lastCommit).toBe("Remove the book's cover");
  expect(images()).toEqual([]);
  expect(read("novel.yaml")).not.toContain("cover:");

  // The shelf has its generated cover back.
  await page.goto(`${app.url}/`);
  await expect(book).toBeVisible();
  await expect(book.getByRole("img")).toHaveCount(0);
});
