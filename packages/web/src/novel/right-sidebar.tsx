import { BookOpen, FileText, PanelRightClose, PanelRightOpen, StickyNote } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { create } from "zustand";
import { cn } from "../ui/cn.ts";

/*
 * The right sidebar (#149): the scene the caret is in, and a story bible entry, as two tabs beside
 * the text. Ctrl+Shift+\ (⌘⇧\ on a Mac) opens and closes it; closed, it's a strip of icons at the
 * right edge, as the left sidebar is. Open or closed, its tab and its width are remembered in this
 * browser. On a narrow window it's a sheet over the text, shown only when asked for.
 */

export type SidebarTab = "scene" | "notes" | "entry";

const KEY = "ghw.rightSidebar";
export const MIN_WIDTH = 280;
export const MAX_WIDTH = 560;

interface Saved {
  open: boolean;
  tab: SidebarTab;
  width: number;
}

function load(): Saved {
  const fallback: Saved = { open: true, tab: "scene", width: 352 };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    if (!saved) return fallback;
    return {
      open: saved.open ?? fallback.open,
      tab: saved.tab === "entry" || saved.tab === "notes" ? saved.tab : "scene",
      width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(saved.width) || fallback.width)),
    };
  } catch {
    return fallback;
  }
}

const WIDE = "(min-width: 1024px)";
const wide = () => typeof matchMedia === "undefined" || matchMedia(WIDE).matches;

interface SidebarState extends Saved {
  /** On a narrow window: the sheet is showing (not remembered). */
  sheet: boolean;
  set: (change: Partial<Saved>) => void;
  toggle: () => void;
  show: (tab: SidebarTab) => void;
}

export const useRightSidebar = create<SidebarState>((set, get) => {
  const save = (change: Partial<Saved>) => {
    set(change);
    const { open, tab, width } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ open, tab, width }));
    } catch {
      // Not remembered where storage is blocked.
    }
  };
  return {
    ...load(),
    set: save,
    sheet: false,
    toggle: () => (wide() ? save({ open: !get().open }) : set({ sheet: !get().sheet })),
    show: (tab) => {
      if (wide()) save({ open: true, tab });
      else {
        save({ tab });
        set({ sheet: true });
      }
    },
  };
});

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const SIDEBAR_SHORTCUT = MAC ? "⌘⇧\\" : "Ctrl+Shift+\\";
const ARIA_KEYS = MAC ? "Meta+Shift+\\" : "Control+Shift+\\";

const TABS: { key: SidebarTab; label: string; icon: typeof FileText }[] = [
  { key: "scene", label: "Scene", icon: FileText },
  { key: "notes", label: "Notes", icon: StickyNote },
  { key: "entry", label: "Entry", icon: BookOpen },
];

/**
 * The sidebar, open or as its strip. `toText` puts the focus back in the text (Escape, F6);
 * `content` is what each tab shows.
 */
export function RightSidebar({ content, toText, labels = {} }: { content: Record<SidebarTab, ReactNode>; toText: () => void; labels?: Partial<Record<SidebarTab, string>> }) {
  // A tab may say what it's showing (the Entry tab an event, as "Event").
  const label = (t: (typeof TABS)[number]) => labels[t.key] ?? t.label;
  const { open: opened, sheet, tab, width, set, toggle, show } = useRightSidebar();
  const isWide = useSyncExternalStore(
    (changed) => {
      const query = matchMedia(WIDE);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    wide,
  );
  const open = isWide ? opened : sheet;
  const aside = useRef<HTMLElement>(null);
  const tabs = useRef<Record<SidebarTab, HTMLButtonElement | null>>({ scene: null, notes: null, entry: null });

  // Ctrl+Shift+\ anywhere in the novel (the key by its place: Shift+\ types "|" on most keyboards);
  // F6 moves between the text and the sidebar.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = MAC ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && !e.altKey && e.code === "Backslash") {
        e.preventDefault();
        toggle();
        return;
      }
      const { open, sheet } = useRightSidebar.getState();
      if (e.key === "F6" && !mod && !e.altKey && (wide() ? open : sheet)) {
        // Handled here only: the text mustn't see the key too, or WebKit hands it focus back.
        e.preventDefault();
        e.stopPropagation();
        if (aside.current?.contains(document.activeElement)) return toText();
        const tab = () => tabs.current[useRightSidebar.getState().tab];
        tab()?.focus();
        requestAnimationFrame(() => document.activeElement !== tab() && tab()?.focus());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle, toText]);

  // A sheet takes the focus as it opens, as a dialog would.
  useEffect(() => {
    if (!isWide && sheet) tabs.current[useRightSidebar.getState().tab]?.focus();
  }, [isWide, sheet]);

  if (!open) {
    if (!isWide) return null;
    return (
      <aside aria-label="Right sidebar" className="flex flex-col items-center gap-1 border-l border-rule bg-panel py-2">
        <button type="button" onClick={toggle} aria-label="Show the right sidebar" title={`Show the right sidebar (${SIDEBAR_SHORTCUT})`} aria-keyshortcuts={ARIA_KEYS} className="rounded-md p-2 text-muted hover:bg-paper hover:text-ink">
          <PanelRightOpen className="size-4" aria-hidden />
        </button>
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => show(t.key)} aria-label={label(t)} title={label(t)} className="rounded-md p-2 text-muted hover:bg-paper hover:text-ink">
            <t.icon className="size-4" aria-hidden />
          </button>
        ))}
      </aside>
    );
  }

  // The tab pattern: arrows, Home and End move between tabs.
  const onTabKey = (e: KeyboardEvent) => {
    const order = TABS.map((t) => t.key);
    const i = order.indexOf(tab);
    const to = { ArrowRight: order[(i + 1) % order.length], ArrowLeft: order[(i + order.length - 1) % order.length], Home: order[0], End: order.at(-1) }[e.key];
    if (!to) return;
    e.preventDefault();
    set({ tab: to });
    tabs.current[to]?.focus();
  };

  const resizeBy = (dx: number) => set({ width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, useRightSidebar.getState().width + dx)) });

  return (
    <>
      {/* On a narrow window, a sheet over the text: the backdrop closes it. */}
      {!isWide && <button type="button" aria-hidden tabIndex={-1} onClick={toggle} className="fixed inset-0 z-30 bg-black/30" />}
      <aside
        ref={aside}
        aria-label="Right sidebar"
        style={{ width }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            if (!isWide) useRightSidebar.setState({ sheet: false });
            toText();
          }
        }}
        className="fixed inset-y-0 right-0 z-40 flex max-w-[90vw] shrink-0 flex-col border-l border-rule bg-raised shadow-xl lg:relative lg:z-auto lg:max-w-none lg:shadow-none"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the right sidebar"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 64 : 16;
            if (e.key === "ArrowLeft") resizeBy(step);
            else if (e.key === "ArrowRight") resizeBy(-step);
            else return;
            e.preventDefault();
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            const start = e.clientX;
            const from = useRightSidebar.getState().width;
            const move = (m: PointerEvent) => set({ width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, from + start - m.clientX)) });
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
          className="absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize focus-visible:bg-accent/40 focus-visible:outline-none lg:block"
        />
        <div className="flex items-center gap-1 border-b border-rule px-2">
          <div role="tablist" aria-label="Right sidebar tabs" className="flex flex-1" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.key}
                ref={(el) => void (tabs.current[t.key] = el)}
                type="button"
                role="tab"
                id={`right-tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls="right-tabpanel"
                tabIndex={tab === t.key ? 0 : -1}
                onClick={() => set({ tab: t.key })}
                className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-accent font-semibold" : "border-transparent text-muted hover:text-ink")}
              >
                {label(t)}
              </button>
            ))}
          </div>
          <button type="button" onClick={toggle} aria-label="Hide the right sidebar" title={`Hide the right sidebar (${SIDEBAR_SHORTCUT})`} aria-keyshortcuts={ARIA_KEYS} className="rounded-md p-1.5 text-muted hover:bg-paper hover:text-ink">
            <PanelRightClose className="size-4" aria-hidden />
          </button>
        </div>
        <div role="tabpanel" id="right-tabpanel" aria-labelledby={`right-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
          {content[tab]}
        </div>
      </aside>
    </>
  );
}
