import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { coverImage } from "../../export/src/cover.ts";

/*
 * Pictures for the tests (#168), made in the page itself: a photo-like image of any size (a gradient
 * with some noise, so it compresses like a photo), as a file to choose, drop or paste.
 */

/** Make an image in the page, as `window.__picture` (a File), and return its bytes for a file chooser. */
export async function makePicture(page: Page, { width, height, type = "image/jpeg", name = "photo.jpg", transparent = false }: { width: number; height: number; type?: string; name?: string; transparent?: boolean }): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ width, height, type, name, transparent }) => {
      const canvas = new OffscreenCanvas(width, height);
      const c = canvas.getContext("2d")!;
      const g = c.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, "#d8cdbb");
      g.addColorStop(1, "#6f6250");
      if (transparent) c.clearRect(0, 0, width, height);
      c.fillStyle = g;
      if (transparent) {
        c.beginPath();
        c.arc(width / 2, height / 2, Math.min(width, height) / 3, 0, Math.PI * 2);
        c.fill();
      } else {
        c.fillRect(0, 0, width, height);
        // Some grain, like a photo's.
        const noise = c.getImageData(0, 0, Math.min(width, 512), Math.min(height, 512));
        for (let i = 0; i < noise.data.length; i += 4) noise.data[i] = (noise.data[i]! + ((i * 7919) % 31)) & 0xff;
        for (let x = 0; x < width; x += 512) for (let y = 0; y < height; y += 512) c.putImageData(noise, x, y);
      }
      const blob = await canvas.convertToBlob({ type, ...(type === "image/jpeg" ? { quality: 0.92 } : {}) });
      (window as unknown as { __picture: File }).__picture = new File([blob], name, { type });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    },
    { width, height, type, name, transparent },
  );
  return Buffer.from(base64, "base64");
}

/** Drop `window.__picture` (or a file of `size` bytes) on the element `selector` finds. */
export async function dropPicture(page: Page, target: ReturnType<Page["getByRole"]>, fake?: { size: number; name: string; type: string }) {
  const handle = await page.evaluateHandle((fake) => {
    const file = fake ? new File([new Uint8Array(fake.size)], fake.name, { type: fake.type }) : (window as unknown as { __picture: File }).__picture;
    const data = new DataTransfer();
    data.items.add(file);
    return data;
  }, fake);
  await target.dispatchEvent("dragover", { dataTransfer: handle });
  await target.dispatchEvent("drop", { dataTransfer: handle });
}

/** Paste `window.__picture` into the focused element, as Ctrl+V would. */
export async function pastePicture(page: Page) {
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add((window as unknown as { __picture: File }).__picture);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
}

/** The pixel size and type of an image in the novel. */
export function pictureIn(dir: string, path: string) {
  const image = coverImage(new Uint8Array(readFileSync(join(dir, path))));
  return image && { type: image.type, width: image.width, height: image.height };
}
