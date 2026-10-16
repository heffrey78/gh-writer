import type { Novel } from "@gh-writer/core";
import { BookOpen, CircleDot, Columns2, Goal, ListTree, Map as MapIcon, Network, PanelLeftClose, PanelLeftOpen, PenLine, StickyNote, type LucideIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { create } from "zustand";
import { plural } from "../bible/types.ts";
import { useCommands } from "../commands.ts";
import { cn } from "../ui/cn.ts";
import { ManuscriptSidebar } from "./manuscript-tree.tsx";
import type { Workspace } from "./workspace.ts";

/*
 * The novel's sidebar (#136): Write (the manuscript), then the views grouped by what the author is
 * doing: Plan (every view of the book and its world, #232) and Revise. It collapses to a strip of icons (Ctrl+\), remembered in this browser.
 */

const KEY = "ghw.sidebar";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === "collapsed";
  } catch {
    return false;
  }
}

export const useSidebar = create<{ collapsed: boolean; toggle: () => void }>((set, get) => ({
  collapsed: load(),
  toggle: () => {
    const collapsed = !get().collapsed;
    try {
      localStorage.setItem(KEY, collapsed ? "collapsed" : "expanded");
    } catch {
      // Not remembered where storage is blocked.
    }
    set({ collapsed });
  },
}));

interface Place {
  path: string;
  label: string;
  icon: LucideIcon;
}

/** The views by group; Issues only for a novel on GitHub. */
function groups(onGitHub: boolean): { label: string; places: Place[] }[] {
  return [
    {
      label: "Plan",
      places: [
        { path: "outline", label: "Outline", icon: ListTree },
        { path: "story-map", label: "Story map", icon: MapIcon },
        { path: "relationships", label: "Relationships", icon: Network },
        { path: "notes", label: "Notes", icon: StickyNote },
        { path: "progress", label: "Progress", icon: Goal },
        { path: "bible", label: "Story bible", icon: BookOpen },
      ],
    },
    {
      label: "Revise",
      places: [{ path: "compare", label: "Compare", icon: Columns2 }, ...(onGitHub ? [{ path: "issues", label: "Issues", icon: CircleDot }] : [])],
    },
  ];
}

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘\\" : "Ctrl+\\";

/** A window too narrow for the sidebar beside the text (a phone, a narrow window): below Tailwind's md. */
const NARROW = "(max-width: 47.99rem)";
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const on = () => setNarrow(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** Collapse or expand with Ctrl+\ (⌘\ on a Mac), anywhere in the novel, and from the palette. */
function useToggleKey(toggle: () => void, collapsed: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || e.key !== "\\") return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle]);
  useCommands(() => [{ id: "app.sidebar", title: collapsed ? "Expand the sidebar" : "Collapse the sidebar", group: "App", keys: "Mod-\\", run: toggle }], [collapsed, toggle]);
}

export function Sidebar({ novelId, novel, workspace, current, onGitHub }: { novelId: string; novel: Novel; workspace: Workspace; current: string | undefined; onGitHub: boolean }) {
  const { collapsed, toggle } = useSidebar();
  // Too narrow for it beside the text: the strip, and the sidebar over the text (a dialog) when it's
  // opened, closed again by going somewhere, Escape or a click beside it.
  const narrow = useNarrow();
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setDrawer(false), [pathname, narrow]);
  useToggleKey(narrow ? () => setDrawer((d) => !d) : toggle, narrow ? !drawer : collapsed);
  if (narrow)
    return (
      <>
        <Strip novelId={novelId} onGitHub={onGitHub} toggle={() => setDrawer(true)} />
        <Dialog.Root open={drawer} onOpenChange={setDrawer}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-30 bg-black/40" />
            <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] flex-col text-ink shadow-xl [&>aside]:flex-1">
              <Dialog.Title className="sr-only">The sidebar</Dialog.Title>
              <Expanded novelId={novelId} novel={novel} workspace={workspace} current={current} onGitHub={onGitHub} toggle={() => setDrawer(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </>
    );
  return collapsed ? (
    <Strip novelId={novelId} onGitHub={onGitHub} toggle={toggle} />
  ) : (
    <Expanded novelId={novelId} novel={novel} workspace={workspace} current={current} onGitHub={onGitHub} toggle={toggle} />
  );
}

function ToggleButton({ collapsed, toggle }: { collapsed: boolean; toggle: () => void }) {
  const label = collapsed ? "Expand the sidebar" : "Collapse the sidebar";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button type="button" onClick={toggle} aria-label={label} title={`${label} (${SHORTCUT})`} aria-keyshortcuts="Control+\" className="rounded-md p-1.5 text-muted hover:bg-paper hover:text-ink">
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function Expanded({ novelId, novel, workspace, current, onGitHub, toggle }: { novelId: string; novel: Novel; workspace: Workspace; current: string | undefined; onGitHub: boolean; toggle: () => void }) {
  const writeId = useId();
  return (
    <aside aria-label="Sidebar" className="flex min-h-0 flex-col border-rule bg-panel md:border-r">
      <section aria-labelledby={writeId} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 px-3 pt-3">
          <Heading id={writeId}>Write</Heading>
          <ToggleButton collapsed={false} toggle={toggle} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          <ManuscriptSidebar novelId={novelId} novel={novel} workspace={workspace} current={current} />
        </div>
      </section>
      <nav aria-label="Views" className="grid shrink-0 gap-3 border-t border-rule px-3 py-3 text-sm">
        {groups(onGitHub).map((g) => (
          <Group key={g.label} label={g.label}>
            {g.places.map((p) => (
              <li key={p.path}>
                <NavLink to={`/novels/${novelId}/${p.path}`} className={({ isActive }) => cn("flex items-center gap-2 rounded-md px-2 py-1 hover:bg-paper", isActive && "bg-accent-soft font-medium")}>
                  <p.icon className="size-4 shrink-0 text-muted" aria-hidden />
                  {p.label}
                </NavLink>
                {p.path === "bible" && (
                  <ul aria-label="Story bible types" className="mt-0.5 grid gap-0.5 pl-8 text-xs text-muted">
                    {novel.entityTypes.map((t) => (
                      <li key={t.key} className="flex justify-between pr-2">
                        <span>{plural(t.label)}</span>
                        <span className="tabular-nums">{novel.entities.filter((e) => e.type === t.key).length}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </Group>
        ))}
      </nav>
    </aside>
  );
}

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="px-2 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </h2>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="grid gap-1">
      <Heading id={id}>{label}</Heading>
      <ul className="grid gap-0.5">{children}</ul>
    </div>
  );
}

/** Collapsed: one icon per place, each named (for screen readers, and as a tooltip). */
function Strip({ novelId, onGitHub, toggle }: { novelId: string; onGitHub: boolean; toggle: () => void }) {
  const icon = (to: string, label: string, Icon: LucideIcon, end = false) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      aria-label={label}
      title={label}
      className={({ isActive }) => cn("rounded-md p-2 text-muted hover:bg-paper hover:text-ink", isActive && "bg-accent-soft text-ink")}
    >
      <Icon className="size-4" aria-hidden />
    </NavLink>
  );
  return (
    <aside aria-label="Sidebar" className="flex flex-col items-center gap-1 border-rule bg-panel py-2 md:border-r">
      <ToggleButton collapsed toggle={toggle} />
      <nav aria-label="Views" className="flex flex-col items-center gap-1">
        {icon(`/novels/${novelId}`, "Manuscript", PenLine, true)}
        {groups(onGitHub).map((g) => (
          <div key={g.label} role="group" aria-label={g.label} className="flex flex-col items-center gap-1 border-t border-rule pt-1">
            {g.places.map((p) => icon(`/novels/${novelId}/${p.path}`, p.label, p.icon))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
