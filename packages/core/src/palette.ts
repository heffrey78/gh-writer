import type { Novel } from "./model.ts";
import type { RelationshipStyle } from "./types.ts";

/*
 * Relationship colours (#148): the eight slots of the validated chart palette, each with a light and
 * a dark step (checked for colour-vision separation and contrast on the app's surfaces with the
 * dataviz validator). Relationships are always drawn with their type's name beside them, which is
 * the relief three light steps' sub-3:1 contrast needs. The status colours (danger, warn, ok) are not
 * among them, so they keep meaning status.
 */

export type SeriesSlot = "series-1" | "series-2" | "series-3" | "series-4" | "series-5" | "series-6" | "series-7" | "series-8";

export interface SeriesColour {
  slot: SeriesSlot;
  /** What it's called beside its swatch. */
  name: string;
  light: string;
  dark: string;
}

/** In the palette's order: the order a novel's new relationship types take them. */
export const SERIES: readonly SeriesColour[] = [
  { slot: "series-1", name: "Blue", light: "#2a78d6", dark: "#3987e5" },
  { slot: "series-2", name: "Orange", light: "#eb6834", dark: "#d95926" },
  { slot: "series-3", name: "Aqua", light: "#1baf7a", dark: "#199e70" },
  { slot: "series-4", name: "Yellow", light: "#eda100", dark: "#c98500" },
  { slot: "series-5", name: "Magenta", light: "#e87ba4", dark: "#d55181" },
  { slot: "series-6", name: "Green", light: "#008300", dark: "#008300" },
  { slot: "series-7", name: "Violet", light: "#6250d6", dark: "#9085e9" },
  { slot: "series-8", name: "Red", light: "#e34948", dark: "#e66767" },
];

/** The colour names novels used before the palette, each read as its nearest slot. */
export const LEGACY_COLOURS: Readonly<Record<string, SeriesSlot>> = {
  accent: "series-1",
  warn: "series-4",
  ok: "series-6",
  danger: "series-8",
  ink: "series-7",
  muted: "series-3",
};

export type RelationshipLine = NonNullable<RelationshipStyle["line"]>;

/** A colour as written in novel.yaml (a slot, or an old name) as its slot, or undefined if it's neither. */
export function seriesSlot(colour: string | undefined): SeriesSlot | undefined {
  if (!colour) return undefined;
  if (SERIES.some((s) => s.slot === colour)) return colour as SeriesSlot;
  return LEGACY_COLOURS[colour];
}

/**
 * How a relationship type is drawn: its colour's slot and its line. A type without a colour takes
 * the slot of its place in the list (until the app saves it one); a type the novel doesn't define,
 * the first.
 */
export function relationshipStyle(novel: Pick<Novel, "relationshipTypes">, typeKey: string): { slot: SeriesSlot; line: RelationshipLine } {
  const index = novel.relationshipTypes.findIndex((t) => t.key === typeKey);
  const type = novel.relationshipTypes[index];
  return {
    slot: seriesSlot(type?.style?.color) ?? SERIES[Math.max(index, 0) % SERIES.length]!.slot,
    line: type?.style?.line ?? "solid",
  };
}

/** The slot a new relationship type takes: the first no type uses yet, or, all in use, the least used. */
export function nextSeriesSlot(novel: Pick<Novel, "relationshipTypes">): SeriesSlot {
  const used = new Map<SeriesSlot, number>(SERIES.map((s) => [s.slot, 0]));
  for (const t of novel.relationshipTypes) {
    const slot = relationshipStyle(novel, t.key).slot;
    used.set(slot, used.get(slot)! + 1);
  }
  return SERIES.reduce((best, s) => (used.get(s.slot)! < used.get(best.slot)! ? s : best)).slot;
}

/** A slot's hex in a theme. */
export function seriesHex(slot: SeriesSlot, theme: "light" | "dark" = "light"): string {
  const s = SERIES.find((c) => c.slot === slot) ?? SERIES[0]!;
  return theme === "dark" ? s.dark : s.light;
}
