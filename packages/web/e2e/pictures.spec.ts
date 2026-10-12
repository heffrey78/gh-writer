import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
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
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await dropPicture(page, slot, { size: 100, name: "notes.pdf", type: "application/pdf" });
  await expect(page.getByRole("alert")).toContainText("notes.pdf isn't an image");
  expect(novel.images()).toEqual([]);
  expect(novel.clean()).toBe("");
});
