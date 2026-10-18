/*
 * The app's own right-click menu (the desktop app's, #243): when the app draws one menu for every
 * right-click, what was clicked adds its items to the click's event rather than opening a menu of its
 * own (the spelling suggestions, say), and the app's menu shows them above its own.
 */

export interface ContextMenuItem {
  label: string;
  /** What choosing it does, once the menu has closed and the focus is back where it was. None: shown, not chosen. */
  run?: () => void;
}

export interface ContextMenuGroup {
  /** Its items, or the promise of them (spelling suggestions take a moment). */
  items: ContextMenuItem[] | Promise<ContextMenuItem[]>;
  /** Shown while the items are on their way. */
  pending?: string;
}

const contributed = new WeakMap<Event, ContextMenuGroup[]>();
let enabled = false;

/** Whether the app draws the right-click menu, collecting what's contributed to each click. */
export function appContextMenu(): boolean {
  return enabled;
}

/** Turn the app's right-click menu on or off: off, views open their own menus as before. */
export function setAppContextMenu(on: boolean): void {
  enabled = on;
}

/** Add a group of items to a right-click's menu. */
export function contributeMenuItems(event: Event, group: ContextMenuGroup): void {
  contributed.set(event, [...(contributed.get(event) ?? []), group]);
}

/** What was added to a right-click's menu, in the order it was added (innermost first). */
export function contributedMenuItems(event: Event): ContextMenuGroup[] {
  return contributed.get(event) ?? [];
}
