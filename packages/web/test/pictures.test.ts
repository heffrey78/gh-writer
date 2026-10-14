import { describe, expect, it } from "vitest";
import { cropScale, expectedPath, initialCrop, MAX_PICTURE_BYTES, moveCrop, moveFocus, objectPosition, outputSize, pictureAlt, refusal, savedSize, scaledCrop, shapeForType, SHAPES } from "../src/bible/pictures.ts";

const PHOTO = { width: 5472, height: 3648 }; // 20 megapixels, landscape

describe("picture shapes", () => {
  it("gives places a wide picture and everything else a 4:5 portrait", () => {
    expect(shapeForType("location")).toBe(SHAPES.wide);
    for (const type of ["character", "plotline", "theme", "vehicle"]) expect(shapeForType(type)).toBe(SHAPES.portrait);
    expect([SHAPES.portrait, SHAPES.wide, SHAPES.cover].map((s) => [s.width, s.height])).toEqual([[1200, 1500], [1600, 900], [1600, 2560]]);
  });

  it("names the picture for its alternative text and its file", () => {
    expect(pictureAlt(SHAPES.portrait, "Ada Varn")).toBe("Portrait of Ada Varn");
    expect(pictureAlt(SHAPES.wide, "Varn Station")).toBe("Picture of Varn Station");
    expect(pictureAlt(SHAPES.cover, "The Bridge at Varn")).toBe("The cover of The Bridge at Varn");
    expect(expectedPath(SHAPES.portrait, "Ada Varn", false)).toBe("images/ada-varn.jpg");
    expect(expectedPath(SHAPES.portrait, "Zoë O'Hara", true)).toBe("images/zoe-ohara.png");
    expect(expectedPath(SHAPES.cover, "Anything", false)).toBe("images/cover.jpg");
  });
});

describe("refusing a file before it's read", () => {
  it("refuses one over GitHub's 100 MB limit, and one that isn't an image", () => {
    expect(refusal({ size: MAX_PICTURE_BYTES + 1, type: "image/jpeg", name: "huge.jpg" })).toBe("huge.jpg is 100.0 MB: larger than GitHub's 100 MB limit, so it can't be kept in the novel. Try a smaller copy.");
    expect(refusal({ size: 10, type: "application/pdf", name: "notes.pdf" })).toContain("isn't an image");
    expect(refusal({ size: 10_000, type: "image/png" })).toBeUndefined();
  });
});

describe("cropping", () => {
  it("starts with the largest frame of the shape, centred", () => {
    const crop = initialCrop(PHOTO, SHAPES.portrait.aspect);
    expect(crop.height).toBe(3648);
    expect(crop.width).toBeCloseTo(3648 * 0.8);
    expect(crop.x).toBeCloseTo((5472 - 3648 * 0.8) / 2);
    expect(crop.y).toBe(0);
    // A tall image and a wide frame: the full width.
    expect(initialCrop({ width: 1000, height: 3000 }, SHAPES.wide.aspect)).toMatchObject({ x: 0, width: 1000 });
  });

  it("moves the frame, never past the image's edges", () => {
    const crop = initialCrop(PHOTO, SHAPES.portrait.aspect);
    expect(moveCrop(crop, -100_000, 50, PHOTO)).toMatchObject({ x: 0, y: 0 });
    expect(moveCrop(crop, 100_000, 0, PHOTO).x).toBeCloseTo(5472 - crop.width);
  });

  it("resizes it around its middle, from a fifth of the largest to the largest", () => {
    const crop = initialCrop(PHOTO, SHAPES.portrait.aspect);
    const half = scaledCrop(PHOTO, SHAPES.portrait.aspect, 0.5, { x: 2736, y: 1824 });
    expect(half.width / half.height).toBeCloseTo(0.8);
    expect(cropScale(PHOTO, half)).toBeCloseTo(0.5);
    expect(half.x + half.width / 2).toBeCloseTo(2736);
    expect(cropScale(PHOTO, scaledCrop(PHOTO, 0.8, 0.01, { x: 0, y: 0 }))).toBeCloseTo(0.2);
    expect(scaledCrop(PHOTO, 0.8, 5, { x: 2736, y: 1824 })).toEqual(crop);
    // Near an edge, it stays inside.
    expect(scaledCrop(PHOTO, 0.8, 0.5, { x: 0, y: 0 })).toMatchObject({ x: 0, y: 0 });
  });

  it("saves at the shape's size, and never enlarges a small crop", () => {
    expect(outputSize(initialCrop(PHOTO, 0.8), SHAPES.portrait)).toEqual({ width: 1200, height: 1500 });
    expect(outputSize(initialCrop({ width: 400, height: 300 }, 0.8), SHAPES.portrait)).toEqual({ width: 240, height: 300 });
    expect(outputSize(initialCrop(PHOTO, 16 / 9), SHAPES.wide)).toEqual({ width: 1600, height: 900 });
  });
});

describe("the focal point", () => {
  it("moves within the picture, and centres thumbnails", () => {
    expect(moveFocus([0.5, 0.5], 0.02, -0.6)).toEqual([0.52, 0]);
    expect(moveFocus([0.95, 0.5], 0.1, 0)).toEqual([1, 0.5]);
    expect(objectPosition([0.52, 0.3])).toBe("52% 30%");
    expect(objectPosition(undefined)).toBe("50% 50%");
  });
});

describe("a picture in the prose (#203)", () => {
  it("is kept no larger than 1600 px on its longest edge, its shape kept, and never enlarged", () => {
    expect(savedSize(PHOTO)).toEqual({ width: 1600, height: 1067 });
    expect(savedSize({ width: 1000, height: 1400 })).toEqual({ width: 1000, height: 1400 });
    expect(savedSize({ width: 900, height: 3600 })).toEqual({ width: 400, height: 1600 });
    expect(savedSize({ width: 20000, height: 1 })).toEqual({ width: 1600, height: 1 });
  });
});
