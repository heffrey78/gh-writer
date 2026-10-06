import type { Novel, Scene } from "@gh-writer/core";

export interface CorkboardFilter {
  pov?: string;
  plotline?: string;
  status?: string;
  character?: string;
}

/** Whether a scene shows on a board with these filters (all must hold). */
export function shows(scene: Scene, f: CorkboardFilter): boolean {
  return (
    (!f.pov || scene.pov === f.pov) &&
    (!f.plotline || scene.plotlines.some((p) => p.id === f.plotline)) &&
    (!f.status || scene.status === f.status) &&
    (!f.character || scene.characters.includes(f.character) || scene.pov === f.character)
  );
}

/** The scenes a board shows, in reading order. */
export function visibleScenes(novel: Novel, f: CorkboardFilter): Scene[] {
  return novel.scenes.filter((s) => shows(s, f));
}

/**
 * A keyboard move on a (possibly filtered) board: one step past the neighbouring visible card,
 * landing immediately before it (left) or after it (right) in the whole book.
 */
export function visibleStep(visible: string[], id: string, direction: -1 | 1): { target: string; after: boolean } | undefined {
  const i = visible.indexOf(id);
  const target = visible[i + direction];
  return i < 0 || target === undefined ? undefined : { target, after: direction > 0 };
}

/** The whole book's order after moving `id` immediately before or after `target` (what the server does). */
export function placed(order: string[], id: string, target: string, after: boolean): string[] {
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
