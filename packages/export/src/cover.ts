import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bookImages, type Book, type Novel } from "@gh-writer/core";
import { unzlibSync, zlibSync } from "fflate";

/*
 * The book's cover (#168), from novel.yaml's `cover`: an image the e-book shows first and the PDF
 * prints on its first page. The app saves covers as JPEG; a PNG (one put there by hand) works too.
 */

export interface CoverImage {
  bytes: Uint8Array;
  type: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

/**
 * The novel's cover, read from `root`, or why it can't be used: a missing file, or one that isn't a
 * JPEG or PNG. No cover in novel.yaml: neither.
 */
export async function readCover(root: string, novel: Novel): Promise<{ cover?: CoverImage; problem?: string }> {
  const path = novel.config?.cover;
  if (!path) return {};
  if (/^\/|\\|(^|\/)\.\.?(\/|$)/.test(path)) return { problem: `The cover, ${path}, isn't a path in the novel, so the book goes out without it.` };
  const bytes = await readFile(join(root, path)).catch(() => undefined);
  if (!bytes) return { problem: `The cover, ${path}, isn't there, so the book goes out without it.` };
  const cover = coverImage(new Uint8Array(bytes));
  if (!cover) return { problem: `The cover, ${path}, isn't a JPEG or PNG image, so the book goes out without it.` };
  if (!pdfCover(cover)) return { cover, problem: `The cover, ${path}, is a kind of PNG the PDF can't take (16-bit or interlaced), so the PDF goes out without it. Saved again as a JPEG, it would work everywhere.` };
  return { cover };
}

/**
 * The pictures a book shows in its text (D10), read from `root` by their repository paths: a map for
 * the formats to embed. A picture missing, or not a JPEG or PNG, is left out (its caption stays), and
 * named in `problems`.
 */
export async function readPictures(root: string, book: Book): Promise<{ pictures: Map<string, CoverImage>; problems: string[] }> {
  const pictures = new Map<string, CoverImage>();
  const problems: string[] = [];
  for (const path of bookImages(book)) {
    const bytes = await readFile(join(root, path)).catch(() => undefined);
    const image = bytes && coverImage(new Uint8Array(bytes));
    if (image) pictures.set(path, image);
    else problems.push(bytes ? `The picture ${path} isn't a JPEG or PNG image, so the book goes out without it.` : `The picture ${path} isn't there, so the book goes out without it.`);
  }
  return { pictures, problems };
}

/** Image bytes as a cover, with their size, or undefined if they aren't a JPEG or PNG. */
export function coverImage(bytes: Uint8Array): CoverImage | undefined {
  const size = jpegSize(bytes);
  if (size) return { bytes, type: "image/jpeg", ...size };
  const png = pngHeader(bytes);
  if (png) return { bytes, type: "image/png", width: png.width, height: png.height };
  return undefined;
}

/** A JPEG's pixel size, from its frame header; undefined if it isn't a JPEG. */
function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    // Start of frame: baseline, progressive and the rest, not DHT (c4), JPG (c8) or DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + length;
  }
  return undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface PngHeader {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlaced: boolean;
}

function pngHeader(b: Uint8Array): PngHeader | undefined {
  if (!PNG_SIGNATURE.every((x, i) => b[i] === x) || b.length < 33) return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), depth: b[24]!, colorType: b[25]!, interlaced: b[28] === 1 };
}

/** A PNG's chunks: type and data. */
function* chunks(b: Uint8Array): Generator<{ type: string; data: Uint8Array }> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 8; i + 8 <= b.length; ) {
    const length = view.getUint32(i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    yield { type, data: b.subarray(i + 8, i + 8 + length) };
    i += 12 + length;
  }
}

/**
 * The cover as the PDF embeds it. pdfkit takes a JPEG, and an opaque PNG, as they are, at once. A PNG
 * with transparency (or interlaced) it would decode later and asynchronously, through Node's zlib: the
 * file would no longer be the same bytes everywhere. So such a PNG is flattened onto white here, and
 * encoded again with fflate, as an opaque PNG. Undefined: a PNG this can't read (one of the rarer
 * bit depths); the PDF goes out without a cover.
 */
export function pdfCover(cover: CoverImage): Uint8Array | undefined {
  if (cover.type === "image/jpeg") return cover.bytes;
  const h = pngHeader(cover.bytes)!;
  const list = [...chunks(cover.bytes)];
  const transparent = h.colorType === 4 || h.colorType === 6 || list.some((c) => c.type === "tRNS");
  if (!transparent && !h.interlaced) return cover.bytes;
  if (h.depth !== 8 || h.interlaced) return undefined;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[h.colorType];
  if (!channels) return undefined;
  const palette = list.find((c) => c.type === "PLTE")?.data;
  const trns = list.find((c) => c.type === "tRNS")?.data;
  const raw = unzlibSync(concat(list.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const pixels = unfilter(raw, h.width, h.height, channels);

  const rgb = new Uint8Array(h.height * (1 + h.width * 3));
  for (let y = 0; y < h.height; y++) {
    const out = y * (1 + h.width * 3);
    rgb[out] = 0; // no filter
    for (let x = 0; x < h.width; x++) {
      const p = (y * h.width + x) * channels;
      let r: number, g: number, b: number, a: number;
      if (h.colorType === 3) {
        const index = pixels[p]!;
        [r, g, b] = [palette?.[index * 3] ?? 0, palette?.[index * 3 + 1] ?? 0, palette?.[index * 3 + 2] ?? 0];
        a = trns?.[index] ?? 255;
      } else if (h.colorType === 0 || h.colorType === 4) {
        r = g = b = pixels[p]!;
        a = h.colorType === 4 ? pixels[p + 1]! : trns && ((trns[0]! << 8) | trns[1]!) === r ? 0 : 255;
      } else {
        [r, g, b] = [pixels[p]!, pixels[p + 1]!, pixels[p + 2]!];
        // An RGB PNG's tRNS names one colour (16 bits a channel) that is transparent.
        const keyed = trns !== undefined && trns.length >= 6 && trns[1] === r && trns[3] === g && trns[5] === b;
        a = h.colorType === 6 ? pixels[p + 3]! : keyed ? 0 : 255;
      }
      // Onto white paper.
      const over = (c: number) => Math.round((c * a + 255 * (255 - a)) / 255);
      rgb.set([over(r), over(g), over(b)], out + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, h.width);
  view.setUint32(4, h.height);
  header.set([8, 2, 0, 0, 0], 8);
  return concat([new Uint8Array(PNG_SIGNATURE), chunk("IHDR", header), chunk("IDAT", zlibSync(rgb)), chunk("IEND", new Uint8Array())]);
}

/** Undo PNG's per-row filters: the pixels, `channels` bytes each, row after row. */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[row + x - channels]! : 0;
      const up = y ? out[row - stride + x]! : 0;
      const upLeft = y && x >= channels ? out[row - stride + x - channels]! : 0;
      const predicted = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : 0;
      out[row + x] = (line[x]! + predicted) & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  let c = 0xffffffff;
  for (const byte of out.subarray(4, 8 + data.length)) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
