import { contributedMenuItems, setAppContextMenu, type ContextMenuGroup } from "@gh-writer/editor";
import { ContextMenu } from "radix-ui";
import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { keyCaps } from "./commands.ts";
import { canInspect, clipboardText, desktop, inspect, shellEdit, type EditAction } from "./desktop.ts";
import { useCanGo } from "./history.tsx";

/*
 * The desktop app's right-click menu (#243): one menu, in the app's theme, wherever the click lands,
 * instead of the webview's. In text: Cut, Copy, Paste and Select all, then Back and Forward;
 * elsewhere, Back and Forward (and Copy, with text selected). What was clicked can add its own items above them (the spelling
 * suggestions, Raise an issue… on a passage); places with a menu of their own (the manuscript tree)
 * keep it. In a browser none of this runs, and the browser's menu shows as a web page's should.
 */

if (desktop) setAppContextMenu(true);

interface Entry {
  label: string;
  /** Shortcut, in TipTap notation ("Mod-x"). */
  keys?: string;
  disabled?: boolean;
  /** Paste: enabled once the clipboard is known to hold text. */
  paste?: boolean;
  run?: () => void;
}

interface Section {
  items: Entry[] | Promise<Entry[]>;
  pending?: string;
}

// Shortcuts read ⌘C on a Mac, Ctrl+C elsewhere.
const MAC = keyCaps("Mod")[0] === "⌘";

const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password"]);

type Field = HTMLInputElement | HTMLTextAreaElement;

/** The text field or editable text the click landed in, if any. */
function editableAt(target: EventTarget | null): Field | HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const field = target.closest("input, textarea");
  if (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && TEXT_INPUTS.has(field.type))) return field;
  // The editable root, from inside it too (a mention in the text is not editable itself).
  const host = target.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]');
  return host instanceof HTMLElement ? host : undefined;
}

const isField = (el: HTMLElement): el is Field => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

function selectedIn(el: HTMLElement): boolean {
  if (isField(el)) return el.selectionStart !== null && el.selectionStart !== el.selectionEnd;
  const selection = getSelection();
  return !!selection && !selection.isCollapsed && el.contains(selection.anchorNode);
}

const pageSelection = () => {
  const selection = getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().trim() !== "";
};

/** Run an editing command on what has the focus: the shell's own, or the page's where it has none. */
async function edit(action: EditAction, el: HTMLElement | undefined): Promise<void> {
  if (await shellEdit(action)) return;
  if (action !== "paste") {
    document.execCommand(action === "select_all" ? "selectAll" : action);
    return;
  }
  const text = await clipboardText();
  if (!text || !el) return;
  if (isField(el)) document.execCommand("insertText", false, text);
  else {
    // The editor pastes it as it pastes anything: through its paste handling.
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }
}

/** Where a menu opened from the keyboard goes: under the caret in text, else at the focused element. */
function anchorOf(el: HTMLElement): { x: number; y: number } {
  const selection = getSelection();
  if (el.isContentEditable && selection?.rangeCount && el.contains(selection.focusNode)) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rect = range.getClientRects()[0];
    // Just inside the caret's line, so the text there (a misspelling) is what the menu is about.
    if (rect && rect.height > 0) return { x: rect.left, y: rect.bottom - 2 };
  }
  const box = el.getBoundingClientRect();
  return { x: box.left + 16, y: Math.min(box.bottom, window.innerHeight - 8) };
}

const fromGroup = (group: ContextMenuGroup): Section => {
  const entries = (items: { label: string; run?: () => void }[]): Entry[] => items.map((i) => ({ label: i.label, disabled: !i.run, ...(i.run ? { run: i.run } : {}) }));
  return { items: Array.isArray(group.items) ? entries(group.items) : group.items.then(entries), ...(group.pending ? { pending: group.pending } : {}) };
};

const itemClass = "flex cursor-pointer items-center justify-between gap-6 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft data-[disabled]:cursor-default data-[disabled]:opacity-50";
const menuClass = "z-50 min-w-52 rounded-md border border-rule bg-raised p-1 text-ink shadow-lg";

/** The app's right-click menu around everything in it: the desktop app only. Mounted once, inside the router. */
export function AppContextMenu({ children }: { children: ReactNode }) {
  if (!desktop) return children;
  return <DesktopContextMenu>{children}</DesktopContextMenu>;
}

function DesktopContextMenu({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const can = useCanGo();
  const [sections, setSections] = useState<Section[]>([]);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [canPaste, setCanPaste] = useState(false);
  const [inspector, setInspector] = useState(false);
  // Where the focus goes back to when the menu closes, and what the chosen item does then.
  const restore = useRef<HTMLElement | null>(null);
  const pending = useRef<(() => void) | undefined>(undefined);

  useEffect(() => void canInspect().then(setInspector), []);

  useEffect(() => {
    // The webview's own menu never shows, even where no menu of the app's opened.
    const never = (e: Event) => e.preventDefault();
    // Shift+F10 and the Menu key, which WebKit doesn't turn into a right-click by itself.
    const onKey = (e: KeyboardEvent) => {
      if (!((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") || e.defaultPrevented) return;
      e.preventDefault();
      const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : document.getElementById("main");
      if (!focused) return;
      const { x, y } = anchorOf(focused);
      focused.dispatchEvent(new globalThis.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    };
    document.addEventListener("contextmenu", never);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("contextmenu", never);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const open = (e: MouseEvent) => {
    // A menu of its own took the click (the tree's).
    if (e.defaultPrevented) return;
    const target = e.target as Element;
    const el = editableAt(target);
    const theirs = contributedMenuItems(e.nativeEvent).map(fromGroup);
    const run = (action: EditAction) => () => void edit(action, el);
    const go: Entry[] = [
      { label: "Back", keys: "Alt-ArrowLeft", disabled: !can.back, run: () => void navigate(-1) },
      { label: "Forward", keys: "Alt-ArrowRight", disabled: !can.forward, run: () => void navigate(1) },
    ];
    let mine: Entry[][];
    if (el) {
      const selected = selectedIn(el);
      const readOnly = isField(el) && (el.readOnly || el.disabled);
      // The editing first, and Back and Forward below it: in the text as anywhere.
      mine = [
        [
          { label: "Cut", keys: "Mod-x", disabled: !selected || readOnly, run: run("cut") },
          { label: "Copy", keys: "Mod-c", disabled: !selected, run: run("copy") },
          { label: "Paste", keys: "Mod-v", disabled: readOnly, paste: true, run: run("paste") },
          { label: "Select all", keys: "Mod-a", run: run("select_all") },
        ],
        go,
      ];
      setCanPaste(false);
      if (!readOnly) void clipboardText().then((text) => setCanPaste(!!text));
    } else {
      mine = [[...go, ...(pageSelection() ? [{ label: "Copy", keys: "Mod-c", run: run("copy") }] : [])]];
    }
    if (inspector) mine.at(-1)!.push({ label: "Inspect", run: inspect });
    setSections([...theirs, ...mine.map((items) => ({ items }))]);
    restore.current = el ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // Inside a dialog when the click was (its focus stays in it), else in the page's main landmark.
    setContainer((target.closest('[role="dialog"], [role="alertdialog"]') as HTMLElement | null) ?? document.getElementById("main") ?? document.body);
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild onContextMenu={open}>
        <div className="contents">{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={container}>
        <ContextMenu.Content
          className={menuClass}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const back = restore.current;
            if (back?.isConnected) back.focus({ preventScroll: true });
            const chosen = pending.current;
            pending.current = undefined;
            chosen?.();
          }}
        >
          {sections.map((section, i) => (
            <Fragment key={i}>
              {i > 0 && <ContextMenu.Separator className="my-1 h-px bg-rule" />}
              <ContextMenu.Group>
                <Items section={section} canPaste={canPaste} choose={(run) => (pending.current = run)} />
              </ContextMenu.Group>
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A section's items, once they've come (spelling suggestions take a moment). */
function Items({ section, canPaste, choose }: { section: Section; canPaste: boolean; choose: (run: () => void) => void }) {
  const [items, setItems] = useState<Entry[] | undefined>(Array.isArray(section.items) ? section.items : undefined);
  useEffect(() => {
    if (Array.isArray(section.items)) return setItems(section.items);
    let current = true;
    setItems(undefined);
    void section.items.then((loaded) => current && setItems(loaded));
    return () => {
      current = false;
    };
  }, [section]);
  if (!items)
    return (
      <ContextMenu.Item className={itemClass} disabled>
        {section.pending ?? "…"}
      </ContextMenu.Item>
    );
  return items.map((item) => {
    const disabled = item.disabled || (item.paste && !canPaste);
    return (
      <ContextMenu.Item key={item.label} className={itemClass} disabled={!!disabled} onSelect={() => item.run && choose(item.run)}>
        {item.label}
        {item.keys && (
          <kbd className="text-xs text-muted" aria-hidden>
            {keyCaps(item.keys).join(MAC ? "" : "+")}
          </kbd>
        )}
      </ContextMenu.Item>
    );
  });
}
