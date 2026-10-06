import { Command as Cmdk } from "cmdk";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { allCommands, keyCaps, useCommandRegistry, type Command } from "./commands.ts";

/** Which of the two overlays is open. */
export const useOverlay = create<{ open: "palette" | "shortcuts" | undefined; set: (open: "palette" | "shortcuts" | undefined) => void }>((set) => ({
  open: undefined,
  set: (open) => set({ open }),
}));

const RECENT_KEY = "ghw:recent-commands";
const RECENT_MAX = 5;

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((r) => r !== id)].slice(0, RECENT_MAX)));
  } catch {
    // Storage blocked: no recent list.
  }
}

/**
 * How well a command matches what's typed, from its title and keywords (the first keyword is the
 * title): the start of the title, then anywhere in it, then every word somewhere. 0 hides it.
 */
export function rank(_value: string, search: string, keywords: string[] = []): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const title = (keywords[0] ?? "").toLowerCase();
  if (title.startsWith(q)) return 1;
  if (title.includes(q)) return 0.8;
  const haystack = keywords.join(" ").toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word)) ? 0.5 : 0;
}

/** The palette's own shortcuts, and the editor's formatting keys, for the reference. */
export const APP_KEYS: { title: string; keys: string }[] = [
  { title: "Command palette", keys: "Mod-k" },
  { title: "Keyboard shortcuts", keys: "Mod-/" },
];

const EDITING_KEYS: { title: string; keys: string }[] = [
  { title: "Italic", keys: "Mod-i" },
  { title: "Bold", keys: "Mod-b" },
  { title: "Block quote", keys: "Mod-Shift-b" },
  { title: "Section break", keys: "Mod-Enter" },
  { title: "Line break", keys: "Shift-Enter" },
  { title: "Undo", keys: "Mod-z" },
  { title: "Redo", keys: "Mod-Shift-z" },
];

function Keys({ keys }: { keys: string }) {
  return (
    <span className="inline-flex gap-1">
      <span className="sr-only">{keyCaps(keys).join(" ")}</span>
      {keyCaps(keys).map((k, i) => (
        <kbd key={i} className="min-w-6 rounded border border-rule bg-panel px-1.5 text-center font-mono text-xs text-muted" aria-hidden>
          {k}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Mod+K: every registered command, searchable, recent ones first. Mod+/: the keyboard shortcuts.
 * Choosing a command closes the palette, returns focus to where it was, then runs the command.
 */
export function CommandPalette() {
  const { open, set } = useOverlay();
  const owners = useCommandRegistry((s) => s.owners);
  const commands = useMemo(() => allCommands(owners), [owners]);
  const [search, setSearch] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const returnTo = useRef<HTMLElement | null>(null);
  /** The text selection when the palette opened: focusing a contenteditable again would put the caret at its start. */
  const returnRange = useRef<Range | null>(null);
  const pending = useRef<Command | undefined>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = navigator.platform.startsWith("Mac") ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      const which = e.key.toLowerCase() === "k" && !e.shiftKey ? "palette" : e.key === "/" ? "shortcuts" : undefined;
      if (!which) return;
      e.preventDefault();
      e.stopPropagation();
      const state = useOverlay.getState();
      if (state.open === which) state.set(undefined);
      else {
        if (!state.open) {
          returnTo.current = document.activeElement as HTMLElement | null;
          const sel = window.getSelection();
          returnRange.current = returnTo.current?.isContentEditable && sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        }
        state.set(which);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (open === "palette") {
      setSearch("");
      setRecent(readRecent());
    }
  }, [open]);

  const groups = useMemo(() => {
    const out = new Map<string, Command[]>();
    for (const c of commands) out.set(c.group, [...(out.get(c.group) ?? []), c]);
    return [...out];
  }, [commands]);
  const recentCommands = recent.map((id) => commands.find((c) => c.id === id)).filter((c): c is Command => c !== undefined);

  const choose = (c: Command) => {
    remember(c.id);
    pending.current = c;
    set(undefined);
  };

  /** Focus back where it was; if that's gone (the view changed) or was nowhere, the text, else the page's main area. */
  const restoreFocus = () => {
    const before = returnTo.current;
    const back = before?.isConnected && before !== document.body;
    const target = back ? before : (document.querySelector<HTMLElement>(".ghw-prose") ?? document.getElementById("main"));
    target?.focus({ preventScroll: true });
    // Put the caret back where it was, in the same frame, before the editor reads the selection.
    const range = returnRange.current;
    if (back && range && target?.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  /** After closing: focus back where it was, then the command (which may move focus itself). */
  const onCloseAutoFocus = (e: Event) => {
    e.preventDefault();
    restoreFocus();
    const c = pending.current;
    pending.current = undefined;
    if (c) requestAnimationFrame(() => c.run());
  };

  const item = (c: Command, value: string) => (
    <Cmdk.Item
      key={value}
      value={value}
      keywords={[c.title, c.group, ...(c.keywords ?? [])]}
      onSelect={() => choose(c)}
      className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm data-[selected=true]:bg-accent-soft"
    >
      <span>
        {c.title}
        {c.isActive && <span className="ml-2 text-xs text-muted">{c.isActive() ? "On" : "Off"}</span>}
      </span>
      {c.keys && <Keys keys={c.keys} />}
    </Cmdk.Item>
  );

  // The palette's and editor's own keys, then every command with a shortcut, one section per group.
  const shortcuts = useMemo(() => {
    const out = new Map<string, Map<string, string>>([
      ["App", new Map(APP_KEYS.map((k) => [k.title, k.keys]))],
      ["Editing", new Map(EDITING_KEYS.map((k) => [k.title, k.keys]))],
    ]);
    for (const [group, list] of groups) for (const c of list) if (c.keys) out.set(group, (out.get(group) ?? new Map()).set(c.title, c.keys));
    return [...out].filter(([, m]) => m.size).map(([group, m]) => ({ group, entries: [...m].map(([title, keys]) => ({ title, keys })) }));
  }, [groups]);

  return (
    <>
      <Dialog.Root open={open === "palette"} onOpenChange={(o) => !o && set(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/30" />
          <Dialog.Content
            onCloseAutoFocus={onCloseAutoFocus}
            aria-describedby={undefined}
            className="fixed top-[12vh] left-1/2 z-[70] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-rule bg-raised text-ink shadow-2xl"
          >
            <Dialog.Title className="sr-only">Command palette</Dialog.Title>
            <Cmdk label="Commands" loop filter={rank}>
              <Cmdk.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Type a command, or a scene to go to…"
                className="h-12 w-full border-b border-rule bg-transparent px-4 text-base outline-none placeholder:text-muted"
              />
              <Cmdk.List className="max-h-[min(60vh,28rem)] overflow-y-auto p-2" label="Commands">
                <Cmdk.Empty className="px-3 py-6 text-center text-sm text-muted">No matching commands</Cmdk.Empty>
                {!search && recentCommands.length > 0 && (
                  <Cmdk.Group heading="Recent" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted">
                    {recentCommands.map((c) => item(c, `${c.title} recent:${c.id}`))}
                  </Cmdk.Group>
                )}
                {groups.map(([group, list]) => (
                  <Cmdk.Group
                    key={group}
                    heading={group}
                    className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted"
                  >
                    {list.map((c) => item(c, `${c.title} ${c.id}`))}
                  </Cmdk.Group>
                ))}
              </Cmdk.List>
            </Cmdk>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={open === "shortcuts"} onOpenChange={(o) => !o && set(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/30" />
          <Dialog.Content
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              restoreFocus();
            }}
            aria-describedby={undefined}
            className="fixed top-1/2 left-1/2 z-[70] max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-rule bg-raised p-5 text-ink shadow-2xl"
          >
            <Dialog.Title className="text-lg font-semibold">Keyboard shortcuts</Dialog.Title>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
              {shortcuts.map(({ group, entries }) => (
                <section key={group} aria-labelledby={`keys-${group}`}>
                  <h3 id={`keys-${group}`} className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                    {group}
                  </h3>
                  <dl className="grid gap-1.5 text-sm">
                    {entries.map((e) => (
                      <div key={e.title} className="flex items-center justify-between gap-3">
                        <dt>{e.title}</dt>
                        <dd>
                          <Keys keys={e.keys} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
            <p className="mt-5 text-sm text-muted">
              Every action is also in the command palette (<Keys keys="Mod-k" />
              ).
            </p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
