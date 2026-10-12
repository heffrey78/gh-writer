import { expect, test } from "./fixtures.ts";
import { dropPicture, makePicture, pictureIn } from "./pictures.ts";

/**
 * #168: a 20-megapixel photo is read, resized and saved in under 2 seconds: from the drop until the
 * frame is ready, and from "Use this portrait" until the portrait is on the profile. The time spent
 * framing it is the author's, not counted. Runs alone, after the other tests.
 */
test("a 20-megapixel photo is resized and saved in under 2 seconds", async ({ page, app }) => {
  const dir = app.novelRepo("varn");
  await app.restart(dir);
  const novelPath = new URL(app.launchUrl).pathname;
  await page.goto(app.launchUrl.replace(novelPath, `${novelPath}/bible/char_7f3k2q`));
  await expect(page.getByRole("heading", { level: 1, name: "Ada Varn" })).toBeVisible();
  await makePicture(page, { width: 5472, height: 3648, name: "camera.jpg" });

  const dialog = page.getByRole("dialog", { name: "Portrait of Ada Varn" });
  const reading = Date.now();
  await dropPicture(page, page.getByRole("button", { name: "Add a portrait" }));
  await expect(dialog.getByRole("button", { name: /^Crop frame/ })).toBeVisible({ timeout: 10_000 });
  const read = Date.now() - reading;

  const saving = Date.now();
  await dialog.getByRole("button", { name: "Use this portrait" }).click();
  await page.getByRole("img", { name: "Portrait of Ada Varn" }).evaluate((img: HTMLImageElement) => img.decode());
  const saved = Date.now() - saving;

  console.log(`20 MP photo: read in ${read} ms, resized and saved in ${saved} ms`);
  expect(pictureIn(dir, "images/ada-varn.jpg")).toEqual({ type: "image/jpeg", width: 1200, height: 1500 });
  expect(read + saved).toBeLessThan(2000);
});
