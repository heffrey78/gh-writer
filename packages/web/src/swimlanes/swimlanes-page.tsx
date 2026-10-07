import { readFrontMatter, type Entity, type Novel, type Scene } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "radix-ui";
import { GripHorizontal } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { api, keys } from "../api.ts";
import { useNotice } from "../novel/notice.tsx";
import { plotlineEdits, type PlotlineChange } from "../novel/plotline-edits.ts";
import { dropMove, useStructure } from "../novel/structure.ts";
import type { Workspace } from "../novel/workspace.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { cellKey, swimlanes, type Mark } from "./swimlane-model.ts";

/** What a screen reader says for a cell. */
function cellLabel(scene: string, plotline: string, mark: Mark | undefined) {
  if (!mark) return `${scene}: doesn't advance ${plotline}`;
  return `${scene}: ${mark.weight} beat in ${plotline}${mark.beat ? `, “${mark.beat}”` : ""}`;
}

/**
 * Plotlines as lanes across the book: one column per scene in reading order, under its chapter and
 * part, and a marker in each lane the scene advances, large for a major beat and small for a minor
 * one, with the beat's note on hover or focus. Gaps show where a thread goes quiet. The cells are a
 * grid: arrow keys move between them, Home and End go to a lane's ends.
 */
export function SwimlanesPage({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const s = useMemo(() => swimlanes(novel), [novel]);
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  // The cell whose link is being edited, and its element, for the popover to sit by.
  // By IDs, not positions: the lanes and columns can change (an edit, a reorder) under them.
  const [editing, setEditing] = useState<{ lane: string; scene: string; el: HTMLElement }>();

  /** One change to a scene's link to a plotline, written to its front matter through the workspace. */
  const change = async (scene: Scene, lane: Entity, what: PlotlineChange, done?: string) => {
    try {
      const open = workspace.store.getState().files[scene.file];
      const text = open ? joinSceneFile(open) : (await api.readFile(novelId, scene.file)).content;
      const edits = plotlineEdits(readFrontMatter(text) ?? {}, lane.id, what);
      if (!edits.length) return;
      await workspace.editFrontMatter(scene.file, edits);
      await workspace.autosave.flush();
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      if (done) show({ message: done });
    } catch (e) {
      show({ message: `Couldn't change “${scene.title}”: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  /** A cell chosen (click, Enter or Space): an empty one links its scene to the plotline; a marked one opens its editor. */
  const choose = (lane: Entity, scene: Scene, el: HTMLElement) => {
    if (s.marks.has(cellKey(lane.id, scene.id))) setEditing({ lane: lane.id, scene: scene.id, el });
    else void change(scene, lane, { link: true }, `“${scene.title}” now advances ${lane.name}.`);
  };
  const [focused, setFocused] = useState<{ lane: string; scene: string }>();
  const table = useRef<HTMLTableElement>(null);
  const rows = s.lanes.length;
  const cols = s.scenes.length;

  // Columns move like the outline's rows: Alt+Left/Right steps a scene through the book, a drag puts
  // it beside the column it's dropped on. A moved column keeps focus, even in another chapter.
  const structure = useStructure(novelId, novel, workspace);
  const dragging = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const refocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = refocus.current;
    if (id && (document.activeElement === document.body || !document.activeElement?.isConnected)) document.querySelector<HTMLElement>(`[data-col-handle="${id}"]`)?.focus();
  }, [novel]);
  const onHandleKey = (e: KeyboardEvent, scene: Scene) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    refocus.current = scene.id;
    void Promise.resolve(structure.step(scene.id, e.key === "ArrowLeft" ? -1 : 1)).then(() =>
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-col-handle="${scene.id}"]`)?.focus()),
    );
  };
  const onDragOver = (e: DragEvent, scene: Scene) => {
    if (!dragging.current || dragging.current === scene.id) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDrop({ id: scene.id, after: e.clientX > rect.left + rect.width / 2 });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const id = dragging.current;
    const target = drop;
    dragging.current = undefined;
    setDrop(undefined);
    const move = id && target ? dropMove(novel, id, target.id, target.after) : undefined;
    if (id && move) void structure.move(id, move.index, move.to);
  };

  const cellEl = (lane: string, scene: string) => table.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(lane, scene)}"]`);
  // The focused cell's place now: where its lane and scene are (the first cell if they're gone).
  const focusRow = Math.max(0, s.lanes.findIndex((l) => l.id === focused?.lane));
  const focusCol = Math.max(0, s.scenes.findIndex((x) => x.id === focused?.scene));
  const moveTo = (r: number, c: number) => {
    const lane = s.lanes[Math.max(0, Math.min(rows - 1, r))]!;
    const scene = s.scenes[Math.max(0, Math.min(cols - 1, c))]!;
    setFocused({ lane: lane.id, scene: scene.id });
    cellEl(lane.id, scene.id)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    // Only the cells' own keys: the column handles above them (Alt+arrows) are in the table too.
    if ((e.target as HTMLElement).getAttribute("role") !== "gridcell" || e.altKey) return;
    const [row, col] = [focusRow, focusCol];
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [row, col - 1],
      ArrowRight: [row, col + 1],
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
      Home: e.ctrlKey ? [0, 0] : [row, 0],
      End: e.ctrlKey ? [rows - 1, cols - 1] : [row, cols - 1],
    };
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const lane = s.lanes[row]!;
      const scene = s.scenes[col]!;
      const el = cellEl(lane.id, scene.id);
      if (el) choose(lane, scene, el);
      return;
    }
    const to = moves[e.key];
    if (!to) return;
    e.preventDefault();
    moveTo(...to);
  };

  const editingLane = editing && s.lanes.find((l) => l.id === editing.lane);
  const editingScene = editing && s.scenes.find((x) => x.id === editing.scene);

  if (!rows || !cols) {
    return (
      <div className="grid gap-3 px-6 py-6">
        <h1 className="text-xl font-semibold">Plotlines</h1>
        <p className="text-muted">{!rows ? "No plotlines yet. Add some in the story bible, then mark the scenes that advance them." : "The manuscript has no scenes yet."}</p>
      </div>
    );
  }

  return (
    <div className="grid content-start gap-3 px-6 py-6">
      <h1 className="text-xl font-semibold">Plotlines</h1>
      <p className="text-sm text-muted">
        Each column is a scene, in reading order. <span className="inline-block size-3 rounded-full bg-accent align-middle" aria-hidden /> a major beat,{" "}
        <span className="inline-block size-2 rounded-full border border-accent bg-accent-soft align-middle" aria-hidden /> a minor one.
      </p>
      <div className="overflow-x-auto rounded-lg border border-rule">
        <table ref={table} role="grid" aria-label="Plotlines by scene" onKeyDown={onKey} className="border-collapse text-sm">
          <thead>
            {s.parts.length > 0 && (
              <tr>
                <td className="sticky left-0 z-10 bg-paper" />
                {s.parts.map(({ part, span }) => (
                  <th key={part.id} scope="colgroup" colSpan={span} className="border-b border-l border-rule px-2 py-1 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                    {part.title}
                  </th>
                ))}
              </tr>
            )}
            <tr>
              <td className="sticky left-0 z-10 bg-paper" />
              {s.chapters.map(({ chapter, title, span }) => (
                <th key={chapter.id} scope="colgroup" colSpan={span} className="border-b border-l border-rule px-2 py-1 text-left font-semibold">
                  <Link to={`/novels/${novelId}/chapter/${chapter.id}`} tabIndex={-1} className="underline-offset-2 hover:underline">
                    {title}
                  </Link>
                </th>
              ))}
            </tr>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-paper px-3 py-1 text-left text-xs font-medium text-muted">
                Plotline
              </th>
              {s.scenes.map((scene) => (
                <th
                  key={scene.id}
                  scope="col"
                  onDragOver={(e) => onDragOver(e, scene)}
                  onDrop={onDrop}
                  className={cn(
                    "h-36 w-10 border-l border-rule align-bottom",
                    drop?.id === scene.id && (drop.after ? "shadow-[inset_-3px_0_0_var(--ghw-accent)]" : "shadow-[inset_3px_0_0_var(--ghw-accent)]"),
                  )}
                >
                  <button
                    type="button"
                    data-col-handle={scene.id}
                    draggable
                    onDragStart={(e) => {
                      dragging.current = scene.id;
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", scene.title);
                    }}
                    onDragEnd={() => {
                      dragging.current = undefined;
                      setDrop(undefined);
                    }}
                    onKeyDown={(e) => onHandleKey(e, scene)}
                    aria-label={`Move “${scene.title}”`}
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    className="mx-auto block cursor-grab rounded p-0.5 text-muted hover:bg-panel"
                  >
                    <GripHorizontal className="size-4" aria-hidden />
                  </button>
                  <Link
                    to={`/novels/${novelId}/scene/${scene.id}`}
                    tabIndex={-1}
                    title={scene.title}
                    className="mx-auto block max-h-32 truncate px-1 py-1 text-xs font-normal underline-offset-2 [writing-mode:vertical-rl] hover:underline"
                  >
                    {scene.title}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.lanes.map((lane, row) => (
              <tr key={lane.id}>
                <th scope="row" className="sticky left-0 z-10 max-w-48 truncate border-t border-rule bg-paper px-3 py-2 text-left font-medium">
                  {lane.name}
                </th>
                {s.scenes.map((scene, col) => {
                  const mark = s.marks.get(cellKey(lane.id, scene.id));
                  const active = row === focusRow && col === focusCol;
                  return (
                    <td
                      key={scene.id}
                      role="gridcell"
                      data-cell={cellKey(lane.id, scene.id)}
                      tabIndex={active ? 0 : -1}
                      onFocus={() => !active && setFocused({ lane: lane.id, scene: scene.id })}
                      onClick={(e) => choose(lane, scene, e.currentTarget)}
                      aria-label={cellLabel(scene.title, lane.name, mark)}
                      aria-haspopup={mark ? "dialog" : undefined}
                      className="group relative h-10 w-10 cursor-pointer border-t border-l border-rule p-0 text-center outline-none hover:bg-panel focus-visible:bg-accent-soft"
                    >
                      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-rule" aria-hidden />
                      {mark && (
                        <>
                          <span
                            aria-hidden
                            className={cn(
                              "relative inline-block rounded-full align-middle",
                              mark.weight === "major" ? "size-3.5 bg-accent" : "size-2.5 border border-accent bg-accent-soft",
                            )}
                          />
                          {mark.beat && (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute top-full left-1/2 z-20 mt-1 hidden w-48 -translate-x-1/2 rounded-md border border-rule bg-raised px-2 py-1 text-left text-xs shadow-md group-hover:block group-focus:block"
                            >
                              {mark.beat}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editingLane && editingScene && editing && (
        <CellEditor
          anchor={editing.el}
          scene={editingScene}
          lane={editingLane}
          mark={s.marks.get(cellKey(editingLane.id, editingScene.id))}
          onChange={(what, done) => change(editingScene, editingLane, what, done)}
          onClose={() => {
            const el = cellEl(editing.lane, editing.scene);
            setEditing(undefined);
            el?.focus();
          }}
        />
      )}
    </div>
  );
}

/** A scene's link to a plotline: its weight, its beat, or taking it away. */
function CellEditor({
  anchor,
  scene,
  lane,
  mark,
  onChange,
  onClose,
}: {
  anchor: HTMLElement;
  scene: Scene;
  lane: Entity;
  mark: Mark | undefined;
  onChange: (what: PlotlineChange, done?: string) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [beat, setBeat] = useState(mark?.beat ?? "");
  const saveBeat = () => beat.trim() !== (mark?.beat ?? "") && void onChange({ beat });
  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor virtualRef={{ current: anchor }} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          sideOffset={4}
          aria-labelledby={`${id}-title`}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-[80] grid w-72 gap-3 rounded-lg border border-rule bg-raised p-4 text-sm text-ink shadow-lg"
        >
          <p id={`${id}-title`} className="font-semibold">
            “{scene.title}” in {lane.name}
          </p>
          <label className="grid gap-1 font-medium">
            Weight
            <select
              value={mark?.weight ?? "major"}
              onChange={(e) => void onChange({ weight: e.target.value as "major" | "minor" })}
              className="h-8 rounded-md border border-rule bg-raised px-2 font-normal"
            >
              <option value="major">Major beat</option>
              <option value="minor">Minor beat</option>
            </select>
          </label>
          <label className="grid gap-1 font-medium">
            Beat
            <input
              value={beat}
              onChange={(e) => setBeat(e.target.value)}
              onBlur={saveBeat}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveBeat();
                }
              }}
              placeholder="What happens to it here"
              className="h-8 rounded-md border border-rule bg-raised px-2 font-normal"
            />
          </label>
          <div className="flex justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void onChange({ remove: true }, `“${scene.title}” no longer advances ${lane.name}.`);
                onClose();
              }}
            >
              Remove from this plotline
            </Button>
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
