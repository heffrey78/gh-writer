import { countWords, type Novel } from "@gh-writer/core";
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, History } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { useCommands, type Command } from "../commands.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { chapterTitle } from "./navigation.tsx";
import { dropMove, stepMove, useStructure, type ItemKind, type Structure } from "./structure.ts";
import type { Workspace } from "./workspace.ts";
import { MoveToDialog, RecentlyDeletedDialog, TitleDialog } from "./structure-dialogs.tsx";

const number = new Intl.NumberFormat();

interface TreeNode {
  id: string;
  kind: ItemKind;
  title: string;
  level: number;
  parent: string | null;
  /** Position among siblings, 1-based, and how many there are (aria-posinset/setsize). */
  pos: number;
  size: number;
  words: number;
  hasChildren: boolean;
}

type Dialog = { kind: "rename"; id: string; title: string } | { kind: "new-scene"; chapter: string; after?: string | null } | { kind: "new-chapter"; part: string | null; after: string | null } | { kind: "move"; id: string; what: "scene" | "chapter" } | { kind: "deleted" };

/**
 * The manuscript as a tree: parts, chapters and scenes with word counts. Arrows move, Enter opens,
 * F2 renames, Delete deletes (with Undo), Alt+Up/Down moves an item, letters jump; drag and drop
 * reorders; the context menu (right-click, Shift+F10) has the rest.
 */
export function ManuscriptTree({ novelId, novel, structure, current }: { novelId: string; novel: Novel; structure: Structure; current: string | undefined }) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const [drop, setDrop] = useState<{ id: string; at: "before" | "after" | "inside" }>();
  const dragging = useRef<string | undefined>(undefined);
  const typed = useRef({ text: "", at: 0 });
  /** An item moved from the keyboard: re-rendered elsewhere, it loses focus, so it gets it back. */
  const refocus = useRef<string | undefined>(undefined);
  const tree = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const out: TreeNode[] = [];
    const words = new Map(novel.allScenes.map((s) => [s.id, countWords(s.body)]));
    const chapterNodes = (chapterIds: string[], level: number, parent: string | null) => {
      const chapters = chapterIds.map((id) => novel.allChapters.find((c) => c.id === id)).filter((c) => c !== undefined);
      chapters.forEach((c, i) => {
        const scenes = c.sceneIds.map((id) => novel.allScenes.find((s) => s.id === id)).filter((s) => s !== undefined);
        out.push({ id: c.id, kind: "chapter", title: chapterTitle(novel, c), level, parent, pos: i + 1, size: chapters.length, words: scenes.reduce((n, s) => n + (words.get(s.id) ?? 0), 0), hasChildren: scenes.length > 0 });
        scenes.forEach((s, j) => out.push({ id: s.id, kind: "scene", title: s.title, level: level + 1, parent: c.id, pos: j + 1, size: scenes.length, words: words.get(s.id) ?? 0, hasChildren: false }));
      });
    };
    if (novel.topLevel === "parts") {
      novel.parts.forEach((p, i) => {
        const at = out.length;
        out.push({ id: p.id, kind: "part", title: p.title, level: 1, parent: null, pos: i + 1, size: novel.parts.length, words: 0, hasChildren: p.chapterIds.length > 0 });
        chapterNodes(p.chapterIds, 2, p.id);
        out[at]!.words = out.slice(at + 1).filter((n) => n.kind === "chapter").reduce((n, c) => n + c.words, 0);
      });
    } else chapterNodes(novel.chapters.map((c) => c.id), 1, null);
    return out;
  }, [novel]);

  // Visible: everything whose ancestors are all expanded.
  const visible = useMemo(() => {
    const hidden = new Set<string>();
    return all.filter((n) => {
      if (n.parent && (collapsed.has(n.parent) || hidden.has(n.parent))) {
        hidden.add(n.id);
        return false;
      }
      return true;
    });
  }, [all, collapsed]);

  const active = focused && visible.some((n) => n.id === focused) ? focused : (current ?? visible[0]?.id);
  const focusNode = (id: string | undefined) => {
    if (!id) return;
    setFocused(id);
    requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus());
  };
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    const el = tree.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (el && document.activeElement !== el) el.focus();
  }, [all]);

  const open = (n: TreeNode) => {
    if (n.kind === "part") return toggle(n.id);
    void navigate(`/novels/${novelId}/${n.kind}/${n.id}`);
  };
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onKey = (e: KeyboardEvent) => {
    const i = visible.findIndex((n) => n.id === active);
    const n = visible[i];
    if (!n) return;
    const go = (target: TreeNode | undefined) => {
      e.preventDefault();
      focusNode(target?.id);
    };
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      refocus.current = n.id;
      void Promise.resolve(structure.step(n.id, e.key === "ArrowUp" ? -1 : 1)).finally(() => setTimeout(() => (refocus.current = undefined), 1000));
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        return go(visible[i + 1]);
      case "ArrowUp":
        return go(visible[i - 1]);
      case "Home":
        return go(visible[0]);
      case "End":
        return go(visible.at(-1));
      case "ArrowRight":
        e.preventDefault();
        if (n.hasChildren && collapsed.has(n.id)) toggle(n.id);
        else if (n.hasChildren) focusNode(visible[i + 1]?.id);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (n.hasChildren && !collapsed.has(n.id)) toggle(n.id);
        else focusNode(n.parent ?? undefined);
        return;
      case "Enter":
        e.preventDefault();
        return open(n);
      case "F2":
        e.preventDefault();
        return setDialog({ kind: "rename", id: n.id, title: n.kind === "chapter" ? (novel.allChapters.find((c) => c.id === n.id)?.title ?? "") : n.title });
      case "Delete":
        e.preventDefault();
        focusNode(visible[i + 1]?.id ?? visible[i - 1]?.id);
        void structure.remove(n.id);
        return;
    }
    // Typeahead: the next item whose title starts with what's been typed.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
      const now = Date.now();
      typed.current = { text: now - typed.current.at < 700 ? typed.current.text + e.key.toLowerCase() : e.key.toLowerCase(), at: now };
      const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
      const match = order.find((x) => x.title.toLowerCase().startsWith(typed.current.text));
      if (match) go(match);
    }
  };

  // ——— Drag and drop ———
  const canDrop = (target: TreeNode, at: "before" | "after" | "inside") => {
    const kind = all.find((x) => x.id === dragging.current)?.kind;
    if (!kind || target.id === dragging.current) return false;
    if (at === "inside") return (kind === "scene" && target.kind === "chapter") || (kind === "chapter" && target.kind === "part");
    return kind === target.kind;
  };
  const onDragOver = (e: DragEvent, target: TreeNode) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const draggedKind = all.find((x) => x.id === dragging.current)?.kind;
    const at = draggedKind !== target.kind ? "inside" : y < 0.5 ? "before" : "after";
    if (!canDrop(target, at)) return setDrop(undefined);
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDrop({ id: target.id, at });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const id = dragging.current;
    const target = drop;
    setDrop(undefined);
    dragging.current = undefined;
    if (!id || !target) return;
    if (target.at === "inside") {
      // Into a chapter (a scene) or a part (a chapter): at its end.
      const list = novel.allChapters.find((c) => c.id === target.id)?.sceneIds ?? novel.allParts.find((p) => p.id === target.id)?.chapterIds ?? [];
      void structure.move(id, list.filter((x) => x !== id).length, target.id);
      return;
    }
    const move = dropMove(novel, id, target.id, target.at === "after");
    if (move) void structure.move(id, move.index, move.to);
  };

  const menu = (n: TreeNode) => {
    const item = "flex cursor-pointer items-center justify-between gap-6 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft data-[disabled]:opacity-50";
    const up = stepMove(novel, n.id, -1);
    const down = stepMove(novel, n.id, 1);
    const chapterOf = n.kind === "scene" ? n.parent : n.kind === "chapter" ? n.id : null;
    return (
      // Inside the page's main area, so the menu sits within a landmark.
      <ContextMenu.Portal container={document.getElementById("main")}>
        <ContextMenu.Content className="z-50 min-w-52 rounded-md border border-rule bg-raised p-1 text-ink shadow-lg">
          {n.kind !== "part" && (
            <ContextMenu.Item className={item} onSelect={() => open(n)}>
              Open
            </ContextMenu.Item>
          )}
          <ContextMenu.Item className={item} onSelect={() => setDialog({ kind: "rename", id: n.id, title: n.kind === "chapter" ? (novel.allChapters.find((c) => c.id === n.id)?.title ?? "") : n.title })}>
            Rename… <kbd className="text-xs text-muted">F2</kbd>
          </ContextMenu.Item>
          {chapterOf && (
            <ContextMenu.Item className={item} onSelect={() => setDialog({ kind: "new-scene", chapter: chapterOf, after: n.kind === "scene" ? n.id : null })}>
              New scene {n.kind === "scene" ? "after this" : "at the start"}
            </ContextMenu.Item>
          )}
          {n.kind !== "scene" && (
            <ContextMenu.Item
              className={item}
              onSelect={() => setDialog(n.kind === "part" ? { kind: "new-chapter", part: n.id, after: null } : { kind: "new-chapter", part: n.parent, after: n.id })}
            >
              New chapter {n.kind === "part" ? "at the start" : "after this"}
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-rule" />
          <ContextMenu.Item className={item} disabled={!up} onSelect={() => void structure.step(n.id, -1)}>
            Move up <kbd className="text-xs text-muted">Alt+↑</kbd>
          </ContextMenu.Item>
          <ContextMenu.Item className={item} disabled={!down} onSelect={() => void structure.step(n.id, 1)}>
            Move down <kbd className="text-xs text-muted">Alt+↓</kbd>
          </ContextMenu.Item>
          {(n.kind === "scene" || (n.kind === "chapter" && novel.topLevel === "parts")) && (
            <ContextMenu.Item className={item} onSelect={() => setDialog({ kind: "move", id: n.id, what: n.kind === "scene" ? "scene" : "chapter" })}>
              {n.kind === "scene" ? "Move to chapter…" : "Move to part…"}
            </ContextMenu.Item>
          )}
          {n.kind === "scene" && n.pos < n.size && (
            <ContextMenu.Item className={item} onSelect={() => void structure.merge(n.id)}>
              Merge with the next scene
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-rule" />
          <ContextMenu.Item className={cn(item, "text-danger")} onSelect={() => void structure.remove(n.id)}>
            Delete <kbd className="text-xs text-muted">Del</kbd>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    );
  };

  const currentChapter = novel.allScenes.find((s) => s.id === current)?.chapterId ?? (novel.allChapters.some((c) => c.id === current) ? current : novel.chapters[0]?.id);
  const currentNode = all.find((n) => n.id === current);
  useCommands((): Command[] => {
    const here = currentNode;
    return [
      ...(currentChapter ? [{ id: "tree.newScene", title: "New scene", group: "Manuscript", run: () => setDialog({ kind: "new-scene", chapter: currentChapter, ...(here?.kind === "scene" ? { after: here.id } : {}) }) }] : []),
      { id: "tree.newChapter", title: "New chapter", group: "Manuscript", run: () => setDialog({ kind: "new-chapter", part: novel.topLevel === "parts" ? (novel.allChapters.find((c) => c.id === currentChapter)?.partId ?? novel.parts[0]?.id ?? null) : null, after: currentChapter ?? null }) },
      { id: "tree.deleted", title: "Recently deleted", group: "Manuscript", run: () => setDialog({ kind: "deleted" }) },
      ...(here
        ? [
            { id: "tree.rename", title: `Rename ${here.kind}…`, group: "Manuscript", keys: "F2", run: () => setDialog({ kind: "rename", id: here.id, title: here.kind === "chapter" ? (novel.allChapters.find((c) => c.id === here.id)?.title ?? "") : here.title }) },
            { id: "tree.up", title: `Move ${here.kind} up`, group: "Manuscript", keys: "Alt-ArrowUp", run: () => void structure.step(here.id, -1) },
            { id: "tree.down", title: `Move ${here.kind} down`, group: "Manuscript", keys: "Alt-ArrowDown", run: () => void structure.step(here.id, 1) },
            ...(here.kind === "scene" ? [{ id: "tree.moveTo", title: "Move scene to chapter…", group: "Manuscript", run: () => setDialog({ kind: "move", id: here.id, what: "scene" }) }] : []),
            ...(here.kind === "scene" && here.pos < here.size ? [{ id: "tree.merge", title: "Merge scene with the next", group: "Manuscript", run: () => void structure.merge(here.id) }] : []),
            { id: "tree.delete", title: `Delete ${here.kind}`, group: "Manuscript", keys: "Delete", run: () => void structure.remove(here.id) },
          ]
        : []),
    ];
  }, [currentNode, currentChapter, novel, structure]);

  return (
    <div className="grid gap-2">
      <div className="flex gap-1" role="toolbar" aria-label="Manuscript actions">
        <Button size="sm" variant="ghost" disabled={!currentChapter} onClick={() => currentChapter && setDialog({ kind: "new-scene", chapter: currentChapter, ...(current && novel.allScenes.some((s) => s.id === current) ? { after: current } : {}) })}>
          <FilePlus className="size-4" aria-hidden /> Scene
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDialog({ kind: "new-chapter", part: novel.topLevel === "parts" ? (novel.allChapters.find((c) => c.id === currentChapter)?.partId ?? novel.parts[0]?.id ?? null) : null, after: currentChapter ?? null })}
          disabled={novel.topLevel === "parts" && !novel.parts.length}
        >
          <FolderPlus className="size-4" aria-hidden /> Chapter
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "deleted" })} aria-label="Recently deleted">
          <History className="size-4" aria-hidden />
        </Button>
      </div>
      <div role="tree" aria-label="Manuscript" ref={tree} onKeyDown={onKey} className="grid gap-px text-sm" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(undefined)}>
        {visible.map((n) => (
          <ContextMenu.Root key={n.id} modal={false}>
            <ContextMenu.Trigger asChild>
              <div
                role="treeitem"
                data-id={n.id}
                aria-level={n.level}
                aria-posinset={n.pos}
                aria-setsize={n.size}
                aria-expanded={n.hasChildren ? !collapsed.has(n.id) : undefined}
                aria-selected={n.id === current}
                aria-label={`${n.title}, ${number.format(n.words)} words`}
                tabIndex={n.id === active ? 0 : -1}
                draggable
                onDragStart={(e) => {
                  dragging.current = n.id;
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", n.title);
                }}
                onDragOver={(e) => onDragOver(e, n)}
                onDrop={onDrop}
                onDragEnd={() => {
                  dragging.current = undefined;
                  setDrop(undefined);
                }}
                onFocus={() => setFocused(n.id)}
                onClick={() => open(n)}
                style={{ paddingLeft: `${(n.level - 1) * 0.875 + 0.25}rem` }}
                className={cn(
                  "relative flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 outline-none hover:bg-paper focus-visible:outline-2 focus-visible:outline-accent",
                  n.id === current && "bg-accent-soft font-medium",
                  n.kind === "part" && "mt-2 text-xs font-semibold tracking-wide text-muted uppercase",
                  n.kind === "scene" && "text-muted",
                  n.id === current && n.kind === "scene" && "text-ink",
                  drop?.id === n.id && drop.at === "inside" && "ring-2 ring-accent",
                  drop?.id === n.id && drop.at === "before" && "before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:bg-accent",
                  drop?.id === n.id && drop.at === "after" && "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent",
                )}
              >
                {n.hasChildren ? (
                  <span
                    aria-hidden
                    className="flex size-4 shrink-0 items-center justify-center text-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(n.id);
                    }}
                  >
                    {collapsed.has(n.id) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  </span>
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{n.title}</span>
                {n.kind !== "part" && (
                  <span className="text-xs text-muted tabular-nums" aria-hidden>
                    {number.format(n.words)}
                  </span>
                )}
              </div>
            </ContextMenu.Trigger>
            {menu(n)}
          </ContextMenu.Root>
        ))}
      </div>

      {dialog?.kind === "rename" && (
        <TitleDialog
          title={`Rename ${itemKind(novel, dialog.id)}`}
          initial={dialog.title}
          required={itemKind(novel, dialog.id) !== "chapter"}
          action="Rename"
          submit={(title) => structure.rename(dialog.id, title)}
          onClose={() => {
            setDialog(undefined);
            focusNode(dialog.id);
          }}
        />
      )}
      {dialog?.kind === "new-scene" && <TitleDialog title="New scene" action="Add scene" submit={(title) => structure.createScene(dialog.chapter, title, dialog.after)} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "new-chapter" && (
        <TitleDialog title="New chapter" label="Title (optional)" required={false} action="Add chapter" submit={(title) => structure.createChapter(dialog.part, title || undefined, dialog.after)} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === "move" && <MoveToDialog novel={novel} id={dialog.id} kind={dialog.what} structure={structure} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "deleted" && <RecentlyDeletedDialog novelId={novelId} structure={structure} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

function itemKind(novel: Novel, id: string): ItemKind {
  return novel.allScenes.some((s) => s.id === id) ? "scene" : novel.allChapters.some((c) => c.id === id) ? "chapter" : "part";
}

/**
 * The tree with its structural actions, for the workspace's sidebar. `current` is the open chapter
 * or scene. Memoised, and given that rather than reading the address itself, so a change to a
 * view's query (a filter, a threshold) doesn't re-render a long book's tree.
 */
export const ManuscriptSidebar = memo(function ManuscriptSidebar({
  novelId,
  novel,
  workspace,
  current,
}: {
  novelId: string;
  novel: Novel;
  workspace: Workspace;
  current: string | undefined;
}) {
  const structure = useStructure(novelId, novel, workspace);
  return <ManuscriptTree novelId={novelId} novel={novel} structure={structure} current={current} />;
});
