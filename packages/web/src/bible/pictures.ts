import { slugify } from "@gh-writer/core";

/*
 * Pictures (#168): what shape each kind of picture is, and the geometry of cropping one. Kept apart
 * from the DOM, so it can be tested on its own; the canvas work is in resize.ts.
 */

export interface PictureShape {
  key: "portrait" | "wide" | "cover";
  /** Width over height. */
  aspect: number;
  /** What it's saved at (smaller only when the crop has fewer pixels than this). */
  width: number;
  height: number;
  /** "4 : 5", shown on the crop frame. */
  ratio: string;
}

export const SHAPES: Record<PictureShape["key"], PictureShape> = {
  portrait: { key: "portrait", aspect: 4 / 5, width: 1200, height: 1500, ratio: "4 : 5" },
  wide: { key: "wide", aspect: 16 / 9, width: 1600, height: 900, ratio: "16 : 9" },
  cover: { key: "cover", aspect: 5 / 8, width: 1600, height: 2560, ratio: "5 : 8" },
};

/** Places take a wide picture; characters and every other type a 4:5 portrait. */
export function shapeForType(type: string): PictureShape {
  return type === "location" ? SHAPES.wide : SHAPES.portrait;
}

/** "Portrait of Ada Varn", "Picture of Varn Station", "The cover of The Bridge at Varn": a picture's alternative text. */
export function pictureAlt(shape: PictureShape, name: string): string {
  return shape.key === "cover" ? `The cover of ${name}` : `${shape.key === "wide" ? "Picture" : "Portrait"} of ${name}`;
}

/**
 * Where the server will save a picture: images/<slug>.jpg (it adds a suffix if another file has the
 * name, which only it can see).
 */
export function expectedPath(shape: PictureShape, name: string, png: boolean): string {
  return `images/${shape.key === "cover" ? "cover" : slugify(name)}.${png ? "png" : "jpg"}`;
}

/** GitHub refuses files over 100 MB; so does the app, before reading them. */
export const MAX_PICTURE_BYTES = 100 * 1024 * 1024;

/** Why a file can't be a picture, before it's read, or undefined if it may be one. */
export function refusal(file: { size: number; type: string; name?: string }): string | undefined {
  if (file.size > MAX_PICTURE_BYTES) return `${file.name ?? "That image"} is ${megabytes(file.size)}: larger than GitHub's 100 MB limit, so it can't be kept in the novel. Try a smaller copy.`;
  if (file.type && !file.type.startsWith("image/")) return `${file.name ?? "That file"} isn't an image. Choose a photo or a picture (JPEG, PNG, WebP…).`;
  return undefined;
}

export function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A crop, in the original's pixels. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

/** The smallest crop allowed, as a share of the largest: closer than this and there's little left to see. */
export const MIN_SCALE = 0.2;

/** The largest crop of `aspect` the image holds, centred. */
export function initialCrop(image: Size, aspect: number): Crop {
  return scaledCrop(image, aspect, 1, { x: image.width / 2, y: image.height / 2 });
}

/** The crop at `scale` of the largest (from MIN_SCALE to 1) around `centre`, kept inside the image. */
export function scaledCrop(image: Size, aspect: number, scale: number, centre: { x: number; y: number }): Crop {
  const s = Math.min(1, Math.max(MIN_SCALE, scale));
  const full = image.width / image.height > aspect ? { width: image.height * aspect, height: image.height } : { width: image.width, height: image.width / aspect };
  const width = full.width * s;
  const height = full.height * s;
  return clampCrop({ x: centre.x - width / 2, y: centre.y - height / 2, width, height }, image);
}

/** How large `crop` is, as a share of the largest crop of its shape. */
export function cropScale(image: Size, crop: Crop): number {
  const aspect = crop.width / crop.height;
  const fullWidth = image.width / image.height > aspect ? image.height * aspect : image.width;
  return crop.width / fullWidth;
}

/** `crop` moved by dx, dy (in the original's pixels), kept inside the image. */
export function moveCrop(crop: Crop, dx: number, dy: number, image: Size): Crop {
  return clampCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }, image);
}

export function clampCrop(crop: Crop, image: Size): Crop {
  const width = Math.min(crop.width, image.width);
  const height = Math.min(crop.height, image.height);
  return { width, height, x: Math.min(Math.max(0, crop.x), image.width - width), y: Math.min(Math.max(0, crop.y), image.height - height) };
}

/** The pixel size to save a crop at: the shape's, or the crop's own when it has fewer pixels (nothing is enlarged). */
export function outputSize(crop: Crop, shape: PictureShape): Size {
  if (crop.width >= shape.width) return { width: shape.width, height: shape.height };
  const width = Math.max(1, Math.round(crop.width));
  return { width, height: Math.max(1, Math.round(width / shape.aspect)) };
}

/** A focal point (fractions of the picture) moved by dx, dy and kept inside it, rounded to three places. */
export function moveFocus(focus: [number, number], dx: number, dy: number): [number, number] {
  const keep = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  return [keep(focus[0] + dx), keep(focus[1] + dy)];
}

/** CSS object-position for a picture shown at another shape: centred on its focal point. */
export function objectPosition(focus: [number, number] | undefined): string {
  const [x, y] = focus ?? [0.5, 0.5];
  return `${Math.round(x * 100)}% ${Math.round(y * 100)}%`;
}

/** A picture in the prose (#203) is kept no larger than this on its longest edge: sharp on a page, quick to sync. */
export const LONGEST_EDGE = 1600;

/** The size a picture in the prose is saved at: its own, or smaller to fit LONGEST_EDGE (nothing is enlarged). */
export function savedSize({ width, height }: { width: number; height: number }): Size {
  const scale = Math.min(1, LONGEST_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
