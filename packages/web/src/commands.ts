import { useEffect, useRef } from "react";
import { create } from "zustand";

/** An action the author can run from the palette. */
export interface Command {
  /** Unique, e.g. "app.syncNow" or "editor.toggleFocusMode". */
  id: string;
  title: string;
  /** Where it's listed, e.g. "Writing", "Sync", "Go to". */
  group: string;
  /** Its shortcut, TipTap style ("Mod-Shift-f"), when it has one. Shown, not bound: the owner binds it. */
  keys?: string;
  /** Extra words the palette's search matches, e.g. a scene's chapter. */
  keywords?: string[];
  run(): void;
  /** For toggles: whether it's on. */
  isActive?(): boolean;
}

interface Registry {
  /** Command lists by owner, in the order they registered. */
  owners: Map<symbol, Command[]>;
  set(owner: symbol, commands: Command[]): void;
  remove(owner: symbol): void;
}

export const useCommandRegistry = create<Registry>((set) => ({
  owners: new Map(),
  set: (owner, commands) => set((s) => ({ owners: new Map(s.owners).set(owner, commands) })),
  remove: (owner) =>
    set((s) => {
      const owners = new Map(s.owners);
      owners.delete(owner);
      return { owners };
    }),
}));

/** Every registered command; a later owner's command replaces an earlier one with the same id. */
export function allCommands(owners: Map<symbol, Command[]>): Command[] {
  const byId = new Map<string, Command>();
  for (const list of owners.values()) for (const c of list) byId.set(c.id, c);
  return [...byId.values()];
}

/**
 * Offer `commands` in the palette while the calling component is mounted. Pass the values the
 * commands depend on in `deps`, as with useMemo.
 */
export function useCommands(make: () => Command[], deps: unknown[]): void {
  const owner = useRef(Symbol("commands")).current;
  const { set, remove } = useCommandRegistry.getState();
  useEffect(() => {
    set(owner, make());
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => remove(owner), [owner, remove]);
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** "Mod-Shift-f" as the keys to press here: ["Ctrl", "Shift", "F"], or ["⌘", "⇧", "F"] on a Mac. */
export function keyCaps(keys: string): string[] {
  return keys.split("-").map((k) => {
    if (k === "Mod") return MAC ? "⌘" : "Ctrl";
    if (k === "Shift") return MAC ? "⇧" : "Shift";
    if (k === "Alt") return MAC ? "⌥" : "Alt";
    if (k === "Ctrl") return MAC ? "⌃" : "Ctrl";
    return k.length === 1 ? k.toUpperCase() : k;
  });
}
