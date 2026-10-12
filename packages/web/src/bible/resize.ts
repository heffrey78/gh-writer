import type { Crop } from "./pictures.ts";

/*
 * Cropping and resizing a picture in the browser, before it's sent (#168): the server keeps only
 * the result, and needs no image library of its own.
 */

/** The image, decoded the right way up (a phone photo's orientation applied). Throws if it can't be read. */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Couldn't read that image. Try a JPEG, PNG or WebP file.");
  }
}

export interface Rendered {
  blob: Blob;
  png: boolean;
}

/**
 * The crop of `image` at `width` × `height`: a JPEG, or a PNG when `keepTransparency` and the result
 * has transparent pixels. Otherwise transparency is laid on white (a cover goes on paper).
 */
export async function renderCrop(image: ImageBitmap, crop: Crop, width: number, height: number, { keepTransparency }: { keepTransparency: boolean }): Promise<Rendered> {
  // The browser's own high-quality resampling: much better than one drawImage step from a large photo.
  const scaled = await createImageBitmap(image, Math.round(crop.x), Math.round(crop.y), Math.round(crop.width), Math.round(crop.height), {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: keepTransparency })!;
  context.drawImage(scaled, 0, 0);
  scaled.close();
  if (keepTransparency && hasTransparency(context.getImageData(0, 0, width, height).data)) {
    return { blob: await canvas.convertToBlob({ type: "image/png" }), png: true };
  }
  // On white: JPEG has no transparency, and a transparent pixel would otherwise turn black.
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }), png: false };
}

function hasTransparency(pixels: Uint8ClampedArray): boolean {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! < 255) return true;
  return false;
}
